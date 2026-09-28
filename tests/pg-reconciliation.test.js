import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { parseStatementCsv } from '../src/pg/routes/reconciliation.js';
import { escapeHtml, formatEur, REPORT_CSS } from '../src/pg/audit-report.js';
import {
  createMeeting, createResolution, determineQuorum, recordAttendance, updateMeeting,
} from '../src/pg/meetings.js';
import { request, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

// Wyłącznie dane syntetyczne. Rok 'y-test': 2026-09-01 – 2027-08-31.
const YEAR = 'y-test';
let keySeq = 0;
const key = (prefix = 'rec') => `${prefix}-key-${++keySeq}-${Date.now()}`;

// Jedna instancja PGlite na plik; każdy test dostaje własny, świeżo zmigrowany
// schemat (search_path). Mniej pamięci niż osobna instancja WASM na test.
const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
let shared = null;
let schemaSeq = 0;
after(async () => { await shared?.close(); });

async function freshDb() {
  shared ??= new PGlite();
  const schema = `reconciliation_test_${++schemaSeq}`;
  await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  for (const migration of await loadMigrations(migrationsDirectory)) await shared.exec(migration.sql);
  // Testy nie zamykają bazy — robi to hook after().
  return { query: (...args) => shared.query(...args), exec: (...args) => shared.exec(...args),
    transaction: (fn) => shared.transaction(fn), close: async () => {} };
}

async function setup() {
  const db = await freshDb();
  await seedSchoolYear(db, YEAR);
  const year = [{ role: 'treasurer', schoolYearId: YEAR }];
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: year, mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    auditNoMfa: await seedUserSession(db, { userId: 'u-audit', mfa: false }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-treasurer', mfa: false }),
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
    rep: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true,
    }),
  };
  await seedLedger(db);
  const call = (path, options = {}) => handlePgRequest(request(path, options), { db });
  return { db, cookies, call };
}

async function seedLedger(db) {
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer'),
    ('cat-trips', $1, 'expense', 'Wycieczki', 'u-treasurer'),
    ('cat-equipment', $1, 'expense', 'Wyposażenie', 'u-treasurer')`, [YEAR]);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, created_by, idempotency_key)
    VALUES ('ob-1', $1, 100000, 'u-treasurer', 'ob-key-0001')`, [YEAR]);
  await db.query(`INSERT INTO ledger_opening_balance_adjustments (id, opening_balance_id, amount_cents, reason, created_by, idempotency_key)
    VALUES ('oba-1', 'ob-1', 1000, 'Syntetyczna korekta bilansu', 'u-treasurer', 'oba-key-0001')`);
  const entry = (id, direction, cents, category, date, method, ref = null, description = `Wpis syntetyczny ${id}`) =>
    db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
      occurred_on, method, resolution_reference, created_by, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'u-treasurer', $10)`,
    [id, YEAR, direction, cents, category, description, date, method, ref, `le-key-${id}`]);
  await entry('le-in', 'income', 50000, 'cat-dues', '2026-09-10', 'bank');
  await entry('le-cash', 'income', 3000, 'cat-dues', '2026-09-12', 'cash');
  await entry('le-out', 'expense', 20000, 'cat-trips', '2026-09-20', 'bank');
  await entry('le-late', 'income', 7000, 'cat-dues', '2026-10-15', 'bank');
  await db.query(`INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
    VALUES ('lc-1', 'le-in', 5000, 'Błędna kwota — syntetyczne', 'u-treasurer', 'lc-key-0001')`);
  // Ledger balance on 2026-09-30: 100000 + 1000 + (50000 - 5000) + 3000 - 20000 = 129000.
  return entry;
}

async function createDraft(call, cookie, body = {}) {
  const response = await call('/api/reconciliations', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key() },
    body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 126000, ...body },
  });
  return response;
}

test('draft reconciliation computes the ledger balance and the difference on the server', async () => {
  const { db, cookies, call } = await setup();
  try {
    // A client-supplied ledger balance is ignored.
    const created = await createDraft(call, cookies.treasurer, { ledgerBalanceCents: 1 });
    assert.equal(created.status, 201);
    const { reconciliation } = await created.json();
    assert.equal(reconciliation.status, 'draft');
    assert.equal(reconciliation.ledgerBalanceCents, 129000);
    assert.equal(reconciliation.ledgerNonBankCents, 3000);
    assert.equal(reconciliation.differenceCents, 126000 - 129000);
    assert.equal(reconciliation.createdBy, 'u-treasurer');

    const outside = await createDraft(call, cookies.treasurer, { statementDate: '2027-09-01' });
    assert.equal(outside.status, 400);
    assert.equal((await outside.json()).error, 'statement_date_outside_school_year');

    const imported = await call(`/api/reconciliations/${reconciliation.id}/lines`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('imp') },
      body: { lines: [
        { bookedOn: '2026-09-11', amountCents: 45000, reference: 'Składka Rodzina Testowa 1A' },
        { bookedOn: '2026-09-21', amountCents: -20000, reference: 'Autokar' },
        { bookedOn: '2026-09-29', amountCents: -30, reference: 'Opłata bankowa' },
      ] },
    });
    assert.equal(imported.status, 201);
    assert.equal((await imported.json()).import.lineCount, 3);

    const lineAfterDate = await call(`/api/reconciliations/${reconciliation.id}/lines`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('imp') },
      body: { lines: [{ bookedOn: '2026-10-01', amountCents: 100 }] },
    });
    assert.equal(lineAfterDate.status, 400);

    // Reference text is never stored or returned.
    const { rows: stored } = await db.query('SELECT reference_hash FROM bank_statement_lines');
    assert.equal(stored.length, 3, 'wszystkie 3 zaimportowane pozycje mają wiersz w bank_statement_lines');
    // #214: kontrola pozytywna — inaczej hashowanie zepsute na NULL przechodziłoby test „poprawny format”.
    assert.ok(stored.some((row) => row.reference_hash !== null), 'przynajmniej jedna pozycja z referencją ma ustawiony hash');
    assert.ok(stored.every((row) => row.reference_hash === null || /^[0-9a-f]{64}$/.test(row.reference_hash)));
    const detailResponse = await call(`/api/reconciliations/${reconciliation.id}`, { cookie: cookies.treasurer });
    const detailText = await detailResponse.text();
    assert.doesNotMatch(detailText, /Rodzina Testowa|Autokar/);
    const detail = JSON.parse(detailText);
    assert.equal(detail.summary.unmatchedLineCount, 3);
    assert.deepEqual(detail.unmatchedLedgerEntries.map((e) => e.id), ['le-in', 'le-out']);

    // Suggestions by amount and date only; nothing is confirmed automatically.
    const suggestions = await (await call(`/api/reconciliations/${reconciliation.id}/suggestions`, { cookie: cookies.treasurer })).json();
    const byAmount = Object.fromEntries(suggestions.suggestions.map((s) => [s.amountCents, s]));
    assert.deepEqual(byAmount[45000].candidates.map((c) => c.id), ['le-in']);
    assert.deepEqual(byAmount[-20000].candidates.map((c) => c.id), ['le-out']);
    assert.deepEqual(byAmount[-30].candidates, []);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_reconciliation_matches')).rows[0].n, 0);

    const lineId = byAmount[45000].statementLineId;
    const wrongAmount = await call(`/api/reconciliations/${reconciliation.id}/matches`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('m') },
      body: { statementLineId: lineId, ledgerEntryId: 'le-out' },
    });
    assert.equal(wrongAmount.status, 409);
    assert.equal((await wrongAmount.json()).error, 'match_amount_mismatch');

    // Double click: the same key twice creates one match.
    const matchKey = key('m');
    const matchRequest = () => call(`/api/reconciliations/${reconciliation.id}/matches`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': matchKey },
      body: { statementLineId: lineId, ledgerEntryId: 'le-in' },
    });
    const [first, second] = await Promise.all([matchRequest(), matchRequest()]);
    assert.deepEqual([first.status, second.status].sort(), [200, 201]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_reconciliation_matches')).rows[0].n, 1);

    const again = await call(`/api/reconciliations/${reconciliation.id}/matches`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('m') },
      body: { statementLineId: lineId, ledgerEntryId: 'le-in' },
    });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, 'already_matched');

    // Revocation keeps the match with a reason; the line becomes unmatched again.
    const matchId = (await first.json().catch(() => null))?.match?.id
      ?? (await db.query('SELECT id FROM bank_reconciliation_matches')).rows[0].id;
    const revoked = await call(`/api/reconciliations/${reconciliation.id}/matches/${matchId}/revocation`, {
      method: 'POST', cookie: cookies.board, body: { reason: 'Pomyłka przy dopasowaniu' },
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).match.revokedBy, 'u-board');
    const rematch = await call(`/api/reconciliations/${reconciliation.id}/matches`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('m') },
      body: { statementLineId: lineId, ledgerEntryId: 'le-in' },
    });
    assert.equal(rematch.status, 201);
    const matches = (await db.query('SELECT revoked_at FROM bank_reconciliation_matches ORDER BY created_at')).rows;
    assert.equal(matches.length, 2);

    const { rows: audit } = await db.query(
      "SELECT action, metadata_json FROM audit_events WHERE action LIKE 'reconciliation.%' ORDER BY occurred_at");
    assert.ok(audit.some((row) => row.action === 'reconciliation.lines.imported'));
    assert.doesNotMatch(JSON.stringify(audit), /Rodzina|Autokar|45000/);
  } finally {
    await db.close();
  }
});

test('confirmation needs a second person, an explanation of a difference, and freezes the record', async () => {
  const { db, cookies, call } = await setup();
  try {
    const { reconciliation } = await (await createDraft(call, cookies.treasurer)).json();
    const confirm = (cookie, body = {}) => call(`/api/reconciliations/${reconciliation.id}/confirm`, {
      method: 'POST', cookie, body,
    });

    const self = await confirm(cookies.treasurer, { confirmationNote: 'Sprawdzone' });
    assert.equal(self.status, 403);
    assert.equal((await self.json()).error, 'four_eyes_required');
    await assert.rejects(db.query(
      "UPDATE bank_reconciliations SET status = 'confirmed', confirmed_by = created_by, confirmed_at = now(), confirmation_note = 'x x x' WHERE id = $1",
      [reconciliation.id]));

    const noNote = await confirm(cookies.board);
    assert.equal(noNote.status, 400);
    assert.equal((await noNote.json()).error, 'difference_requires_note');

    const confirmed = await confirm(cookies.board, { confirmationNote: 'Różnica: gotówka w kasie i opłata bankowa' });
    assert.equal(confirmed.status, 200);
    const body = (await confirmed.json()).reconciliation;
    assert.equal(body.status, 'confirmed');
    assert.equal(body.confirmedBy, 'u-board');
    assert.equal(body.ledgerBalanceCents, 129000);
    assert.equal(body.differenceCents, -3000);

    const replay = await confirm(cookies.board, {});
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');

    // A new, back-dated ledger entry no longer changes the confirmed snapshot.
    await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
      occurred_on, method, created_by, idempotency_key)
      VALUES ('le-backdated', $1, 'income', 1234, 'cat-dues', 'Wpis syntetyczny wsteczny', '2026-09-15', 'bank', 'u-treasurer', 'le-key-backdated')`, [YEAR]);
    const detail = await (await call(`/api/reconciliations/${reconciliation.id}`, { cookie: cookies.treasurer })).json();
    assert.equal(detail.reconciliation.ledgerBalanceCents, 129000);

    const lines = await call(`/api/reconciliations/${reconciliation.id}/lines`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('imp') },
      body: { lines: [{ bookedOn: '2026-09-15', amountCents: 1234 }] },
    });
    assert.equal(lines.status, 409);
    assert.equal((await lines.json()).error, 'reconciliation_confirmed');

    await assert.rejects(db.query('UPDATE bank_reconciliations SET statement_balance_cents = 1 WHERE id = $1', [reconciliation.id]),
      /bank_reconciliation_confirmed_immutable/);
    await assert.rejects(db.query('DELETE FROM bank_reconciliations WHERE id = $1', [reconciliation.id]),
      /cannot_be_deleted/);
    await assert.rejects(db.query(`INSERT INTO bank_statement_imports (id, reconciliation_id, source, line_count, request_hash, created_by, idempotency_key)
      VALUES ('x', $1, 'manual', 1, $2, 'u-treasurer', 'direct-import-1')`, [reconciliation.id, 'a'.repeat(64)]),
    /bank_reconciliation_confirmed_immutable/);

    // A balanced draft can be confirmed without a note.
    const balanced = await (await createDraft(call, cookies.board, { statementBalanceCents: 129000 + 1234 })).json();
    const ok = await call(`/api/reconciliations/${balanced.reconciliation.id}/confirm`, {
      method: 'POST', cookie: cookies.treasurer, body: {},
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).reconciliation.differenceCents, 0);
  } finally {
    await db.close();
  }
});

test('reconciliation routes refuse representatives, auditors, missing MFA and anonymous users', async () => {
  const { db, cookies, call } = await setup();
  try {
    assert.equal((await createDraft(call, undefined)).status, 401);
    for (const cookie of [cookies.rep, cookies.treasurerNoMfa, cookies.audit]) {
      const response = await createDraft(call, cookie);
      assert.equal(response.status, 403);
    }
    const { reconciliation } = await (await createDraft(call, cookies.treasurer)).json();
    for (const cookie of [cookies.rep, cookies.treasurerNoMfa]) {
      assert.equal((await call(`/api/reconciliations/${reconciliation.id}`, { cookie })).status, 403);
      assert.equal((await call(`/api/reconciliations?schoolYearId=${YEAR}`, { cookie })).status, 403);
      const confirm = await call(`/api/reconciliations/${reconciliation.id}/confirm`, {
        method: 'POST', cookie, body: { confirmationNote: 'Próba bez uprawnień' },
      });
      assert.equal(confirm.status, 403);
    }
    const crossOrigin = await call(`/api/reconciliations/${reconciliation.id}/confirm`, {
      method: 'POST', cookie: cookies.board, origin: 'https://evil.example', body: {},
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await db.query("SELECT status FROM bank_reconciliations")).rows[0].status, 'draft');

    // Treasurer of another year cannot see this year's reconciliation.
    await seedSchoolYear(db, 'y-other', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
    const otherYear = await seedUserSession(db, { userId: 'u-other', roles: [{ role: 'treasurer', schoolYearId: 'y-other' }], mfa: true });
    assert.equal((await call(`/api/reconciliations/${reconciliation.id}`, { cookie: otherYear })).status, 403);
  } finally {
    await db.close();
  }
});

async function adoptResolution(db, number) {
  await seedUser(db, { userId: 'u-voter-1' });
  await seedUser(db, { userId: 'u-voter-2' });
  const board = {
    userId: 'u-board', mfaVerified: true,
    grants: [{ role: 'board', classId: null, schoolYearId: YEAR, expiresAt: null }],
  };
  const { meeting } = await createMeeting(db, board, {
    idempotencyKey: key('meet'), schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie syntetyczne',
    scheduledAt: '2026-09-25T17:00:00Z', location: 'Sala 1', status: 'scheduled',
    quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true,
    votingBodySize: 2, quorumRuleSource: 'Założenie testowe',
  });
  await updateMeeting(db, board, { meetingId: meeting.id, status: 'held' });
  for (const userId of ['u-voter-1', 'u-voter-2']) {
    await recordAttendance(db, board, { meetingId: meeting.id, userId, capacity: 'representative', votingEligible: true, present: true });
  }
  const { quorumCheck } = await determineQuorum(db, board, { idempotencyKey: key('q'), meetingId: meeting.id });
  await createResolution(db, board, {
    idempotencyKey: key('res'), meetingId: meeting.id, number, title: 'Zakup wyposażenia',
    body: 'Treść syntetyczna.', status: 'adopted', votesFor: 2, votesAgainst: 0, votesAbstain: 0,
    quorumCheckId: quorumCheck.id,
  });
}

async function seedReportData(db) {
  await adoptResolution(db, 'UCH/2026/1');
  const insert = (id, cents, ref, description = `Wydatek syntetyczny ${id}`) => db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
      occurred_on, method, resolution_reference, created_by, idempotency_key)
      VALUES ($1, $2, 'expense', $3, 'cat-equipment', $4, '2026-10-05', 'bank', $5, 'u-treasurer', $6)`,
    [id, YEAR, cents, description, ref, `le-key-${id}`]);
  await insert('le-exact', 300000, null);
  await insert('le-approved', 350000, 'UCH/2026/1');
  await insert('le-unapproved', 400000, 'UCH/2026/99', 'Zakup <script>alert("x")</script> & "sprzęt"');
}

test('audit report totals match the ledger and flag large expenses without an adopted resolution', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedReportData(db);
    const { reconciliation } = await (await createDraft(call, cookies.treasurer)).json();
    await call(`/api/reconciliations/${reconciliation.id}/confirm`, {
      method: 'POST', cookie: cookies.board, body: { confirmationNote: 'Różnica wyjaśniona' },
    });

    const response = await call(`/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
    assert.equal(response.status, 200);
    const { report } = await response.json();
    const { rows: [summary] } = await db.query('SELECT * FROM ledger_year_summary WHERE school_year_id = $1', [YEAR]);
    assert.equal(report.balance.openingBalanceCents, Number(summary.opening_balance_cents));
    assert.equal(report.balance.incomeCents, Number(summary.income_cents));
    assert.equal(report.balance.expenseCents, Number(summary.expense_cents));
    assert.equal(report.balance.closingBalanceCents, Number(summary.closing_balance_cents));
    assert.equal(report.balance.openingBalanceCents, 101000);
    assert.equal(report.balance.incomeCents, 45000 + 3000 + 7000);
    assert.equal(report.balance.expenseCents, 20000 + 300000 + 350000 + 400000);
    const net = (direction) => report.categories.filter((c) => c.direction === direction).reduce((s, c) => s + c.netCents, 0);
    assert.equal(net('income'), report.balance.incomeCents);
    assert.equal(net('expense'), report.balance.expenseCents);
    // Kontrole krzyżowe (#169): niezależne źródła, a nie widok sam ze sobą.
    const checks = Object.fromEntries(report.checks.items.map((item) => [item.id, item]));
    assert.equal(checks.year_end_balance.ok, true);
    assert.equal(checks.year_end_balance.balanceAtYearEndCents, report.balance.closingBalanceCents);
    assert.equal(checks.dates_within_school_year.ok, true);
    assert.equal(checks.latest_confirmed_reconciliation.differenceCents, -3000);
    assert.equal(checks.latest_confirmed_reconciliation.ok, false);
    const dues = report.categories.find((c) => c.id === 'cat-dues');
    assert.deepEqual([dues.grossCents, dues.correctedCents, dues.netCents, dues.entryCount], [60000, 5000, 55000, 3]);

    // Exactly 3000 EUR is not listed; above 3000 EUR is checked against adopted resolutions.
    assert.deepEqual(report.largeExpenses.map((e) => [e.id, e.matchesAdoptedResolution, e.flagged]), [
      ['le-approved', true, false],
      ['le-unapproved', false, true],
    ]);
    assert.equal(report.checks.largeExpensesWithoutAdoptedResolution, 1);
    assert.deepEqual(report.corrections.map((c) => [c.id, c.amountCents]), [['lc-1', 5000]]);
    assert.deepEqual(report.openingAdjustments.map((a) => a.amountCents), [1000]);
    assert.equal(report.reconciliations.confirmedCount, 1);
    assert.equal(report.reconciliations.latestConfirmed.differenceCents, -3000);

    for (const cookie of [cookies.board, cookies.treasurer]) {
      assert.equal((await call(`/api/reports/audit?schoolYearId=${YEAR}`, { cookie })).status, 200);
    }
    for (const cookie of [cookies.rep, cookies.admin]) {
      const response = await call(`/api/reports/audit?schoolYearId=${YEAR}`, { cookie });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'forbidden' }, 'rola spoza audit/board/treasurer');
    }
    // #161: rola i rok pasują, jedyną przeszkodą jest brak zapisanego czynnika.
    const auditNoMfaResponse = await call(`/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.auditNoMfa });
    assert.equal(auditNoMfaResponse.status, 403);
    assert.deepEqual(await auditNoMfaResponse.json(), { error: 'mfa_enrollment_required' });
    assert.equal((await call(`/api/reports/audit?schoolYearId=${YEAR}`)).status, 401);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'report.audit.generated'");
    assert.equal(rows[0].n, 3);
  } finally {
    await db.close();
  }
});

test('printable HTML report escapes ledger text and is served with a strict CSP', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedReportData(db);
    const response = await call(`/api/reports/audit?schoolYearId=${YEAR}&format=html`, { cookie: cookies.audit });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type'), /^text\/html; charset=utf-8/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const csp = response.headers.get('Content-Security-Policy');
    const hash = createHash('sha256').update(REPORT_CSS).digest('base64');
    assert.equal(csp, `default-src 'none'; style-src 'sha256-${hash}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    assert.doesNotMatch(csp, /unsafe/);
    const html = await response.text();
    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /Zakup &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &quot;sprzęt&quot;/);
    assert.match(html, /brak zgodnej przyjętej uchwały/);
    assert.match(html, /@page \{ size: A4/);
    assert.match(html, /<html lang="pl">/);
    assert.ok(html.includes(formatEur(400000)));
    assert.equal(formatEur(123456), '1 234,56 EUR');
    assert.equal(formatEur(-5), '−0,05 EUR');
    assert.equal(escapeHtml(`<a href='x'>&</a>`), '&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;');

    const bad = await call(`/api/reports/audit?schoolYearId=${YEAR}&format=pdf`, { cookie: cookies.audit });
    assert.equal(bad.status, 400);
    // Year-scoped role: another year is forbidden before existence is revealed.
    assert.equal((await call('/api/reports/audit?schoolYearId=y-missing', { cookie: cookies.board })).status, 403);
    const globalAudit = await seedUserSession(db, { userId: 'u-audit-global', roles: [{ role: 'audit' }], mfa: true });
    const missing = await call('/api/reports/audit?schoolYearId=y-missing', { cookie: globalAudit });
    assert.equal(missing.status, 404);
  } finally {
    await db.close();
  }
});

test('generic CSV statement import: separators, decimals, replay and conflicts', async () => {
  assert.deepEqual(parseStatementCsv('data;kwota;tytuł\n11.09.2026;"1 234,50";"Opis; z średnikiem"\n2026-09-12;-0,3;\n'), [
    { bookedOn: '2026-09-11', amountCents: 123450, reference: 'Opis; z średnikiem' },
    { bookedOn: '2026-09-12', amountCents: -30, reference: '' },
  ]);
  assert.deepEqual(parseStatementCsv('﻿date,amount\r\n2026-09-01,12.5\r\n'), [
    { bookedOn: '2026-09-01', amountCents: 1250, reference: null },
  ]);
  assert.throws(() => parseStatementCsv('date,amount\n2026-02-30,1.00\n'), { code: 'invalid_statement_line' });
  assert.throws(() => parseStatementCsv('foo,bar\n1,2\n'), { code: 'invalid_csv_header' });

  const { db, cookies, call } = await setup();
  try {
    const { reconciliation } = await (await createDraft(call, cookies.treasurer)).json();
    const importKey = key('csv');
    const csv = 'date,amount,reference\n2026-09-11,450.00,Składka syntetyczna\n2026-09-21,-200.00,Autokar\n';
    const send = (body, cookie = cookies.treasurer, idempotencyKey = importKey) => call(
      `/api/reconciliations/${reconciliation.id}/lines`,
      { method: 'POST', cookie, headers: { 'Idempotency-Key': idempotencyKey }, body },
    );
    const first = await send({ csv });
    assert.equal(first.status, 201);
    const replay = await send({ csv });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await send({ csv: `${csv}2026-09-22,1.00,x\n` })).status, 409);
    assert.equal((await send({ csv }, cookies.board)).status, 409);
    const invalid = await send({ csv: 'date,amount\n2026-09-11,abc\n' }, cookies.treasurer, key('csv'));
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'invalid_statement_line', line: 1 });

    // Re-importing the same lines under a new key is reported as possible duplicates.
    const duplicate = await send({ csv }, cookies.treasurer, key('csv'));
    assert.equal(duplicate.status, 201);
    assert.equal((await duplicate.json()).possibleDuplicateCount, 2);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM bank_statement_lines');
    assert.equal(rows[0].n, 4);
    await assert.rejects(db.query('DELETE FROM bank_statement_lines'), /cannot_be_changed/);
  } finally {
    await db.close();
  }
});

test('suggestions include unbooked payments and flag a matching reference hash', async () => {
  const { db, cookies, call } = await setup();
  try {
    await db.query("INSERT INTO households (id) VALUES ('h-1')");
    await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method,
      reference, status, created_by, idempotency_key)
      VALUES ('p-1', 'h-1', $1, 2500, '2026-09-14', 'bank', 'SKŁADKA  RD-0001', 'recorded', 'u-treasurer', 'pay-key-0001'),
             ('p-2', 'h-1', $1, 2500, '2026-09-13', 'bank', 'inny tytuł', 'recorded', 'u-treasurer', 'pay-key-0002')`, [YEAR]);
    const { reconciliation } = await (await createDraft(call, cookies.treasurer)).json();
    await call(`/api/reconciliations/${reconciliation.id}/lines`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('imp') },
      body: { lines: [{ bookedOn: '2026-09-14', amountCents: 2500, reference: 'składka rd-0001' }] },
    });
    const { suggestions } = await (await call(`/api/reconciliations/${reconciliation.id}/suggestions`, { cookie: cookies.treasurer })).json();
    assert.deepEqual(suggestions[0].candidates.map((c) => [c.type, c.id, c.referenceMatch]), [
      ['payment_entry', 'p-1', true],
      ['payment_entry', 'p-2', false],
    ]);
    const matched = await call(`/api/reconciliations/${reconciliation.id}/matches`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('m') },
      body: { statementLineId: suggestions[0].statementLineId, paymentEntryId: 'p-1' },
    });
    assert.equal(matched.status, 201);
  } finally {
    await db.close();
  }
});

// Regresja #115: wpłata gotówkowa nie może być proponowana ani powiązana z pozycją wyciągu bankowego.
async function seedPayments(db, rows) {
  await db.query("INSERT INTO households (id) VALUES ('h-1'), ('h-2') ON CONFLICT DO NOTHING");
  for (const [id, household, cents, date, method] of rows) {
    await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method,
      reference, status, created_by, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, NULL, 'recorded', 'u-treasurer', $7)`,
    [id, household, YEAR, cents, date, method, `pay-key-${id}`]);
  }
}

async function importLines(call, cookie, reconciliationId, lines) {
  const response = await call(`/api/reconciliations/${reconciliationId}/lines`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key('imp') }, body: { lines },
  });
  assert.equal(response.status, 201);
}

async function paymentSuggestions(call, cookie, reconciliationId) {
  const { suggestions } = await (await call(`/api/reconciliations/${reconciliationId}/suggestions`, { cookie })).json();
  return Object.fromEntries(suggestions.map((s) => [s.amountCents, s]));
}

test('suggestions offer only bank payments; a cash payment of the same amount and date is not proposed', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedPayments(db, [
      ['p-cash', 'h-1', 2500, '2026-09-14', 'cash'],
      ['p-other', 'h-2', 2500, '2026-09-14', 'other'],
      ['p-bank', 'h-2', 2500, '2026-09-14', 'bank'],
    ]);
    const { reconciliation } = await (await createDraft(call, cookies.treasurer)).json();
    await importLines(call, cookies.treasurer, reconciliation.id, [{ bookedOn: '2026-09-14', amountCents: 2500 }]);
    const byAmount = await paymentSuggestions(call, cookies.treasurer, reconciliation.id);
    assert.deepEqual(byAmount[2500].candidates.map((c) => [c.type, c.id, c.method]), [
      ['payment_entry', 'p-bank', 'bank'],
    ]);

    // Ręczne powiązanie z wpłatą gotówkową jest odrzucane na serwerze, także przy ponowieniu tym samym kluczem.
    const lineId = byAmount[2500].statementLineId;
    const cashKey = key('m');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await call(`/api/reconciliations/${reconciliation.id}/matches`, {
        method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': cashKey },
        body: { statementLineId: lineId, paymentEntryId: 'p-cash' },
      });
      assert.equal(refused.status, 409);
      assert.equal((await refused.json()).error, 'match_method_mismatch');
    }
    const other = await call(`/api/reconciliations/${reconciliation.id}/matches`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('m') },
      body: { statementLineId: lineId, paymentEntryId: 'p-other' },
    });
    assert.equal(other.status, 409);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_reconciliation_matches')).rows[0].n, 0);
    assert.equal((await db.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'reconciliation.match.confirmed'",
    )).rows[0].n, 0);

    const matched = await call(`/api/reconciliations/${reconciliation.id}/matches`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': cashKey.replace('m-', 'm2-') },
      body: { statementLineId: lineId, paymentEntryId: 'p-bank' },
    });
    assert.equal(matched.status, 201);
  } finally {
    await db.close();
  }
});

test('partial payments by two guardians are proposed separately and cash partials are skipped', async () => {
  const { db, cookies, call } = await setup();
  try {
    // Jedno gospodarstwo (rodzeństwo), dwoje opiekunów wpłaca częściami: 10 EUR przelewem, 15 EUR przelewem,
    // a 10 EUR gotówką w tym samym dniu co pierwszy przelew.
    await seedPayments(db, [
      ['p-part-1', 'h-1', 1000, '2026-09-10', 'bank'],
      ['p-part-cash', 'h-1', 1000, '2026-09-10', 'cash'],
      ['p-part-2', 'h-1', 1500, '2026-09-18', 'bank'],
    ]);
    const { reconciliation } = await (await createDraft(call, cookies.treasurer)).json();
    await importLines(call, cookies.treasurer, reconciliation.id, [
      { bookedOn: '2026-09-10', amountCents: 1000 },
      { bookedOn: '2026-09-18', amountCents: 1500 },
    ]);
    const byAmount = await paymentSuggestions(call, cookies.treasurer, reconciliation.id);
    assert.deepEqual(byAmount[1000].candidates.map((c) => [c.id, c.method, c.amountCents]), [['p-part-1', 'bank', 1000]]);
    assert.deepEqual(byAmount[1500].candidates.map((c) => [c.id, c.method, c.amountCents]), [['p-part-2', 'bank', 1500]]);
  } finally {
    await db.close();
  }
});

test('corrected payments are proposed by net amount only when the payment is a bank transfer', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedPayments(db, [
      ['p-corr-bank', 'h-1', 3000, '2026-09-15', 'bank'],
      ['p-corr-cash', 'h-2', 3000, '2026-09-15', 'cash'],
    ]);
    await db.query(`INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
      VALUES ('pc-1', 'p-corr-bank', 500, 'Błędna kwota — syntetyczne', 'u-treasurer', 'pc-key-0001'),
             ('pc-2', 'p-corr-cash', 500, 'Błędna kwota — syntetyczne', 'u-treasurer', 'pc-key-0002')`);
    const { reconciliation } = await (await createDraft(call, cookies.treasurer)).json();
    await importLines(call, cookies.treasurer, reconciliation.id, [
      { bookedOn: '2026-09-15', amountCents: 2500 },
      { bookedOn: '2026-09-16', amountCents: 3000 },
    ]);
    const byAmount = await paymentSuggestions(call, cookies.treasurer, reconciliation.id);
    assert.deepEqual(byAmount[2500].candidates.map((c) => [c.id, c.method, c.amountCents]), [['p-corr-bank', 'bank', 2500]]);
    // Kwota sprzed korekty nie jest już proponowana jako wpłata.
    assert.deepEqual(byAmount[3000].candidates.filter((c) => c.type === 'payment_entry'), []);

    const refused = await call(`/api/reconciliations/${reconciliation.id}/matches`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('m') },
      body: { statementLineId: byAmount[2500].statementLineId, paymentEntryId: 'p-corr-cash' },
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, 'match_method_mismatch');
  } finally {
    await db.close();
  }
});

// Regresja #162 i #165: spójność powiązań w uzgodnieniu (0024_reconciliation_match_integrity.sql).
async function bookPayment(db, ledgerId, paymentId, cents, date) {
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
    occurred_on, method, payment_entry_id, created_by, idempotency_key)
    VALUES ($1, $2, 'income', $3, 'cat-dues', 'Składka syntetyczna z wpłaty', $4, 'bank', $5, 'u-treasurer', $6)`,
  [ledgerId, YEAR, cents, date, paymentId, `le-key-${ledgerId}`]);
}

async function draftWithLines(call, cookies, amounts, body = {}) {
  const { reconciliation } = await (await createDraft(call, cookies.treasurer, body)).json();
  await importLines(call, cookies.treasurer, reconciliation.id,
    amounts.map((amountCents, index) => ({ bookedOn: `2026-09-${String(14 + index).padStart(2, '0')}`, amountCents })));
  const detail = await (await call(`/api/reconciliations/${reconciliation.id}`, { cookie: cookies.treasurer })).json();
  return { id: reconciliation.id, lineIds: detail.lines.map((line) => line.id) };
}

function matchCall(call, cookie, reconciliationId, body, idempotencyKey = key('m')) {
  return call(`/api/reconciliations/${reconciliationId}/matches`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': idempotencyKey }, body,
  });
}

test('a payment and the ledger entry that books it cannot both be matched in one reconciliation', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedPayments(db, [['p-dup', 'h-1', 2500, '2026-09-14', 'bank']]);
    await bookPayment(db, 'le-dup', 'p-dup', 2500, '2026-09-14');

    // Odtworzenie z #162: dwie pozycje po 25 EUR, jedna wpłata ujęta w księdze.
    const first = await draftWithLines(call, cookies, [2500, 2500]);
    assert.equal((await matchCall(call, cookies.treasurer, first.id, { statementLineId: first.lineIds[0], paymentEntryId: 'p-dup' })).status, 201);
    const viaPayment = await matchCall(call, cookies.treasurer, first.id, { statementLineId: first.lineIds[1], ledgerEntryId: 'le-dup' });
    assert.equal(viaPayment.status, 409);
    assert.equal((await viaPayment.json()).error, 'already_matched_via_payment');
    let detail = await (await call(`/api/reconciliations/${first.id}`, { cookie: cookies.treasurer })).json();
    assert.equal(detail.summary.unmatchedLineCount, 1);
    assert.equal(detail.summary.inconsistentMatchCount, 0);
    // Wpis wyjaśniony przez powiązaną wpłatę nie jest „do zrobienia”.
    assert.ok(!detail.unmatchedLedgerEntries.some((entry) => entry.id === 'le-dup'));

    // Bezpośredni INSERT z pominięciem API też jest odrzucany.
    await assert.rejects(db.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id,
      ledger_entry_id, created_by, idempotency_key) VALUES ('m-direct', $1, $2, 'le-dup', 'u-treasurer', 'direct-match-1')`,
    [first.id, first.lineIds[1]]), /bank_match_already_matched_via_payment/);

    // Odwrotna kolejność: najpierw wpis księgi, potem wpłata.
    const second = await draftWithLines(call, cookies, [2500, 2500]);
    assert.equal((await matchCall(call, cookies.treasurer, second.id, { statementLineId: second.lineIds[0], ledgerEntryId: 'le-dup' })).status, 201);
    const retryKey = key('m');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const viaLedger = await matchCall(call, cookies.treasurer, second.id,
        { statementLineId: second.lineIds[1], paymentEntryId: 'p-dup' }, retryKey);
      assert.equal(viaLedger.status, 409);
      assert.equal((await viaLedger.json()).error, 'already_matched_via_ledger');
    }
    await assert.rejects(db.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id,
      payment_entry_id, created_by, idempotency_key) VALUES ('m-direct-2', $1, $2, 'p-dup', 'u-treasurer', 'direct-match-2')`,
    [second.id, second.lineIds[1]]), /bank_match_already_matched_via_ledger/);

    // Cofnięcie powiązania wpisu zwalnia wpłatę.
    const matchId = (await db.query(
      'SELECT id FROM bank_reconciliation_matches WHERE reconciliation_id = $1 AND revoked_at IS NULL', [second.id])).rows[0].id;
    const revoked = await call(`/api/reconciliations/${second.id}/matches/${matchId}/revocation`, {
      method: 'POST', cookie: cookies.treasurer, body: { reason: 'Powiązanie przez wpłatę' },
    });
    assert.equal(revoked.status, 200);
    assert.equal((await matchCall(call, cookies.treasurer, second.id, { statementLineId: second.lineIds[1], paymentEntryId: 'p-dup' })).status, 201);

    // Dwa równoległe żądania (wpłata i jej wpis) — jedno 201, drugie 409.
    const third = await draftWithLines(call, cookies, [2500, 2500]);
    const raced = await Promise.all([
      matchCall(call, cookies.treasurer, third.id, { statementLineId: third.lineIds[0], paymentEntryId: 'p-dup' }),
      matchCall(call, cookies.treasurer, third.id, { statementLineId: third.lineIds[1], ledgerEntryId: 'le-dup' }),
    ]);
    assert.deepEqual(raced.map((response) => response.status).sort(), [201, 409]);
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM bank_reconciliation_matches WHERE reconciliation_id = $1 AND revoked_at IS NULL',
      [third.id])).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test('two guardians of one child and one sibling transfer: each line matches exactly one payment/entry pair', async () => {
  const { db, cookies, call } = await setup();
  try {
    // Dwoje opiekunów tego samego dziecka po 25 EUR tego samego dnia; rodzeństwo jednym przelewem 50 EUR.
    await seedPayments(db, [
      ['p-g1', 'h-1', 2500, '2026-09-14', 'bank'],
      ['p-g2', 'h-1', 2500, '2026-09-14', 'bank'],
      ['p-sib', 'h-2', 5000, '2026-09-15', 'bank'],
    ]);
    await bookPayment(db, 'le-g1', 'p-g1', 2500, '2026-09-14');
    await bookPayment(db, 'le-g2', 'p-g2', 2500, '2026-09-14');
    await bookPayment(db, 'le-sib', 'p-sib', 5000, '2026-09-15');
    const draft = await draftWithLines(call, cookies, [2500, 2500, 5000]);
    const statuses = [];
    statuses.push((await matchCall(call, cookies.treasurer, draft.id, { statementLineId: draft.lineIds[0], ledgerEntryId: 'le-g1' })).status);
    statuses.push((await matchCall(call, cookies.treasurer, draft.id, { statementLineId: draft.lineIds[1], paymentEntryId: 'p-g2' })).status);
    statuses.push((await matchCall(call, cookies.treasurer, draft.id, { statementLineId: draft.lineIds[2], ledgerEntryId: 'le-sib' })).status);
    assert.deepEqual(statuses, [201, 201, 201]);
    // Drugi opiekun: jego wpis nie może już objąć innej pozycji, a wpis pierwszego nie czeka na powiązanie.
    const detail = await (await call(`/api/reconciliations/${draft.id}`, { cookie: cookies.treasurer })).json();
    assert.equal(detail.summary.unmatchedLineCount, 0);
    assert.equal(detail.summary.inconsistentMatchCount, 0);
    assert.ok(!detail.unmatchedLedgerEntries.some((entry) => ['le-g1', 'le-g2', 'le-sib'].includes(entry.id)));
  } finally {
    await db.close();
  }
});

test('a correction after matching blocks confirmation with a list of inconsistent matches', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedPayments(db, [['p-part', 'h-1', 4000, '2026-09-14', 'bank']]);
    await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
      occurred_on, method, created_by, idempotency_key)
      VALUES ('le-bus', $1, 'expense', 10000, 'cat-trips', 'Autokar syntetyczny', '2026-09-15', 'bank', 'u-treasurer', 'le-key-bus'),
             ('le-zero', $1, 'income', 1200, 'cat-dues', 'Wpis syntetyczny do zera', '2026-09-16', 'bank', 'u-treasurer', 'le-key-zero')`, [YEAR]);
    const draft = await draftWithLines(call, cookies, [4000, -10000, 1200]);
    const matchIds = [];
    for (const body of [
      { statementLineId: draft.lineIds[0], paymentEntryId: 'p-part' },
      { statementLineId: draft.lineIds[1], ledgerEntryId: 'le-bus' },
      { statementLineId: draft.lineIds[2], ledgerEntryId: 'le-zero' },
    ]) {
      const response = await matchCall(call, cookies.treasurer, draft.id, body);
      assert.equal(response.status, 201);
      matchIds.push((await response.json()).match.id);
    }
    const correct = (path, amountCents) => call(path, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('corr') },
      body: { amountCents, reason: 'Korekta syntetyczna' },
    });
    // #165 (reszta): korekta z aktywnym powiązaniem w SZKICU jest teraz zachowawczo
    // zablokowana (409 active_bank_match) — skarbnik musiałby najpierw cofnąć
    // powiązanie. Ten test sprawdza inny mechanizm (kontrolę przy ZATWIERDZENIU,
    // #228/#165 wcześniejsza część) jako niezależny backstop — dla stanu, który
    // powstał inaczej niż przez API korekty (np. dane sprzed tej migracji albo
    // bezpośredni zapis z pominięciem triggerów). Odtwarzamy go tu wprost w bazie
    // (session_replication_role = replica, jak w innych testach tego pliku).
    const blocked = await correct('/api/payments/p-part/corrections', 1500);
    assert.equal(blocked.status, 409);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.error, 'active_bank_match');
    assert.equal(blockedBody.reconciliationId, draft.id);

    // Wpłata częściowa: korekta 15 EUR z 40 EUR; wpis 100 EUR skorygowany o 30 EUR; wpis 12 EUR do zera.
    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
        VALUES ('corr-p-part', 'p-part', 1500, 'Korekta syntetyczna', 'u-treasurer', 'corr-p-part-key');
      INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
        VALUES ('corr-le-bus', 'le-bus', 3000, 'Korekta syntetyczna', 'u-treasurer', 'corr-le-bus-key'),
               ('corr-le-zero', 'le-zero', 1200, 'Korekta syntetyczna', 'u-treasurer', 'corr-le-zero-key');
      SET session_replication_role = origin;
    `);

    const detail = await (await call(`/api/reconciliations/${draft.id}`, { cookie: cookies.treasurer })).json();
    assert.equal(detail.summary.inconsistentMatchCount, 3);
    // #165 pkt 4: wszystkie 3 pary są teraz niezgodne kwotowo — żadna nie liczy
    // się jako poprawnie dopasowana, choć żadna pozycja nie jest "bez pary".
    assert.equal(detail.summary.matchedLineCount, 0);
    assert.equal(detail.summary.unmatchedLineCount, 0);

    const confirm = (cookie, body = { confirmationNote: 'Sprawdzone z wyciągiem' }) =>
      call(`/api/reconciliations/${draft.id}/confirm`, { method: 'POST', cookie, body });
    // Zasada czterech oczu nadal obowiązuje przed kontrolą kwot.
    const self = await confirm(cookies.treasurer);
    assert.equal(self.status, 403);
    assert.equal((await self.json()).error, 'four_eyes_required');

    const refused = await confirm(cookies.board);
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.error, 'inconsistent_matches');
    const byMatch = Object.fromEntries(body.matches.map((m) => [m.matchId, m]));
    assert.deepEqual([byMatch[matchIds[0]].lineAmountCents, byMatch[matchIds[0]].targetNetCents], [4000, 2500]);
    assert.deepEqual([byMatch[matchIds[1]].lineAmountCents, byMatch[matchIds[1]].targetNetCents], [-10000, -7000]);
    assert.deepEqual([byMatch[matchIds[2]].lineAmountCents, byMatch[matchIds[2]].targetNetCents], [1200, 0]);
    assert.ok(body.matches.every((m) => m.reasons.includes('amount_mismatch')));
    assert.doesNotMatch(JSON.stringify(body), /Autokar|syntetyczn/);

    // Bezpośredni UPDATE w bazie też jest odrzucany.
    await assert.rejects(db.query(
      `UPDATE bank_reconciliations SET status = 'confirmed', confirmed_by = 'u-board', confirmed_at = now(),
         confirmation_note = 'Sprawdzone' WHERE id = $1`, [draft.id]), /bank_reconciliation_inconsistent_matches/);
    assert.equal((await db.query('SELECT status FROM bank_reconciliations WHERE id = $1', [draft.id])).rows[0].status, 'draft');

    // Po cofnięciu niezgodnych powiązań (historia zostaje) zatwierdzenie przechodzi; podwójne kliknięcie = replay.
    for (const matchId of matchIds) {
      const revoked = await call(`/api/reconciliations/${draft.id}/matches/${matchId}/revocation`, {
        method: 'POST', cookie: cookies.treasurer, body: { reason: 'Kwota zmieniona korektą' },
      });
      assert.equal(revoked.status, 200);
    }
    assert.equal((await matchCall(call, cookies.treasurer, draft.id, { statementLineId: draft.lineIds[0], paymentEntryId: 'p-part' })).status, 409);
    const [a, b] = await Promise.all([confirm(cookies.board), confirm(cookies.board)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual([a.headers.get('Idempotency-Replayed'), b.headers.get('Idempotency-Replayed')].sort(), ['false', 'true']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_reconciliation_matches WHERE reconciliation_id = $1',
      [draft.id])).rows[0].n, 3);
    assert.equal((await db.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'reconciliation.confirmed' AND entity_id = $1",
      [draft.id])).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test('pre-existing double-counted matches are reported and block confirmation without being changed', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedPayments(db, [['p-old', 'h-1', 2500, '2026-09-14', 'bank']]);
    await bookPayment(db, 'le-old', 'p-old', 2500, '2026-09-14');
    const draft = await draftWithLines(call, cookies, [2500, 2500]);
    // Stan sprzed 0024: wiersze wstawione z pominięciem triggerów (jak odtworzenie kopii).
    await db.transaction(async (tx) => {
      await tx.query("SET LOCAL session_replication_role = 'replica'");
      await tx.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id,
        payment_entry_id, ledger_entry_id, created_by, idempotency_key) VALUES
        ('m-old-1', $1, $2, 'p-old', NULL, 'u-treasurer', 'legacy-match-1'),
        ('m-old-2', $1, $3, NULL, 'le-old', 'u-treasurer', 'legacy-match-2')`, [draft.id, draft.lineIds[0], draft.lineIds[1]]);
    });
    const detail = await (await call(`/api/reconciliations/${draft.id}`, { cookie: cookies.treasurer })).json();
    assert.equal(detail.summary.inconsistentMatchCount, 2);
    // #165 pkt 4: powiązania niespójne (tu: podwójne ujęcie) nie liczą się jako
    // poprawnie dopasowane — mają własną kategorię, nie wchodzą do matchedLineCount.
    assert.equal(detail.summary.matchedLineCount, 0);
    assert.equal(detail.summary.unmatchedLineCount, 0);
    assert.ok(detail.inconsistentMatches.every((m) => m.reasons.includes('double_counted') && !m.reasons.includes('amount_mismatch')));
    const refused = await call(`/api/reconciliations/${draft.id}/confirm`, {
      method: 'POST', cookie: cookies.board, body: { confirmationNote: 'Sprawdzone z wyciągiem' },
    });
    assert.equal(refused.status, 409);
    assert.deepEqual((await refused.json()).matches.map((m) => m.matchId).sort(), ['m-old-1', 'm-old-2']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_reconciliation_matches WHERE revoked_at IS NULL')).rows[0].n, 2);
  } finally {
    await db.close();
  }
});

// #165 pkt 4: matchedLineCount/unmatchedLineCount/inconsistentMatchCount muszą się
// sumować do lineCount, także przy mieszance wszystkich trzech kategorii naraz.
test('summary counts split matched, unmatched and inconsistent lines into three disjoint categories', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedPayments(db, [
      ['p-good', 'h-1', 1000, '2026-09-14', 'bank'],
      ['p-stale', 'h-2', 2000, '2026-09-15', 'bank'],
    ]);
    const draft = await draftWithLines(call, cookies, [1000, 2000, 3000]);
    const okMatch = await matchCall(call, cookies.treasurer, draft.id, { statementLineId: draft.lineIds[0], paymentEntryId: 'p-good' });
    assert.equal(okMatch.status, 201);
    const staleMatch = await matchCall(call, cookies.treasurer, draft.id, { statementLineId: draft.lineIds[1], paymentEntryId: 'p-stale' });
    assert.equal(staleMatch.status, 201);
    // draft.lineIds[2] (3000) zostaje bez żadnej pary.

    // Stan, który normalny przepływ korekty dziś blokuje (409 active_bank_match,
    // patrz test wyżej) — odtworzony bezpośrednio w bazie, jak w innych testach
    // tego pliku (dane sprzed blokady albo zapis z pominięciem triggerów).
    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
        VALUES ('corr-p-stale', 'p-stale', 500, 'Korekta syntetyczna', 'u-treasurer', 'corr-p-stale-key');
      SET session_replication_role = origin;
    `);

    const detail = await (await call(`/api/reconciliations/${draft.id}`, { cookie: cookies.treasurer })).json();
    assert.equal(detail.summary.lineCount, 3);
    assert.equal(detail.summary.matchedLineCount, 1);
    assert.equal(detail.summary.inconsistentMatchCount, 1);
    assert.equal(detail.summary.unmatchedLineCount, 1);
    assert.equal(
      detail.summary.matchedLineCount + detail.summary.inconsistentMatchCount + detail.summary.unmatchedLineCount,
      detail.summary.lineCount,
    );
  } finally {
    await db.close();
  }
});

// #218: import wielu pozycji wyciągu wykonuje stałą liczbę zapytań SQL,
// niezależną od liczby pozycji (jeden INSERT … SELECT FROM unnest(...)
// zamiast pętli 1 INSERT na pozycję).
function countingCall(db) {
  let calls = 0;
  const countQuery = (fn) => (...args) => { calls += 1; return fn(...args); };
  const wrapped = {
    query: countQuery(db.query.bind(db)),
    exec: db.exec.bind(db),
    close: db.close.bind(db),
    transaction: (fn) => db.transaction((tx) => fn({ query: countQuery(tx.query.bind(tx)) })),
  };
  return { call: (path, options = {}) => handlePgRequest(request(path, options), { db: wrapped }), getCalls: () => calls, resetCalls: () => { calls = 0; } };
}

test('importing statement lines runs a constant number of queries regardless of line count', async () => {
  const { db, cookies } = await setup();
  const counting = countingCall(db);
  try {
    const draftSmall = await (await counting.call('/api/reconciliations', {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key() },
      body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 0 },
    })).json();
    counting.resetCalls();
    const smallLines = Array.from({ length: 5 }, (_, i) => ({ bookedOn: '2026-09-14', amountCents: 100 + i }));
    const smallResponse = await counting.call(`/api/reconciliations/${draftSmall.reconciliation.id}/lines`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('imp') }, body: { lines: smallLines },
    });
    assert.equal(smallResponse.status, 201);
    const smallCalls = counting.getCalls();

    const draftLarge = await (await counting.call('/api/reconciliations', {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key() },
      body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 0 },
    })).json();
    counting.resetCalls();
    const largeLines = Array.from({ length: 80 }, (_, i) => ({ bookedOn: '2026-09-14', amountCents: 100 + i }));
    const largeResponse = await counting.call(`/api/reconciliations/${draftLarge.reconciliation.id}/lines`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('imp') }, body: { lines: largeLines },
    });
    assert.equal(largeResponse.status, 201);
    const largeCalls = counting.getCalls();

    // Ta sama liczba zapytań SQL niezależnie od liczby pozycji (5 kontra 80).
    assert.equal(smallCalls, largeCalls);
    assert.ok(largeCalls <= 10, `spodziewano się stałej, małej liczby zapytań, otrzymano ${largeCalls}`);
  } finally {
    await db.close();
  }
});

// #158: skrót SHA-256 tytułu liczony co najwyżej raz na różną wpłatę-kandydata
// w jednym żądaniu, nawet gdy ta sama wpłata jest kandydatem dla wielu pozycji
// wyciągu (ta sama kwota i data, okno wystarczająco szerokie).
test('suggestions hash a candidate payment reference at most once per request even when it matches several lines', async () => {
  const { db, cookies, call } = await setup();
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  let digestCalls = 0;
  try {
    await db.query("INSERT INTO households (id) VALUES ('h-1')");
    await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method,
      reference, status, created_by, idempotency_key)
      VALUES ('p-1', 'h-1', $1, 2500, '2026-09-14', 'bank', 'SKŁADKA  RD-0001', 'recorded', 'u-treasurer', 'pay-key-0001'),
             ('p-2', 'h-1', $1, 2500, '2026-09-14', 'bank', 'Składka RD-0001 ', 'recorded', 'u-treasurer', 'pay-key-0002')`, [YEAR]);
    const { reconciliation } = await (await createDraft(call, cookies.treasurer)).json();
    // Bazowa liczba wywołań digest tej samej trasy zanim istnieją jakiekolwiek
    // pozycje wyciągu (brak kandydatów z dopasowaniem tytułu): uwierzytelnienie
    // sesji też liczy SHA-256, #158 mierzy tylko przyrost od dopasowywania tytułu.
    crypto.subtle.digest = async (...args) => { digestCalls += 1; return originalDigest(...args); };
    await (await call(`/api/reconciliations/${reconciliation.id}/suggestions`, { cookie: cookies.treasurer })).json();
    const baseline = digestCalls;
    digestCalls = 0;
    // Dwie pozycje wyciągu tej samej kwoty i daty, z tytułem — obie widzą oba
    // wpłaty jako kandydatów (2 pozycje x 2 wpłaty = 4 pary, ale tylko 2 różne
    // teksty tytułu do policzenia).
    await call(`/api/reconciliations/${reconciliation.id}/lines`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('imp') },
      body: { lines: [
        { bookedOn: '2026-09-14', amountCents: 2500, reference: 'składka rd-0001' },
        { bookedOn: '2026-09-14', amountCents: 2500, reference: 'składka rd-0001' },
      ] },
    });
    digestCalls = 0;
    const { suggestions } = await (await call(`/api/reconciliations/${reconciliation.id}/suggestions`, { cookie: cookies.treasurer })).json();
    assert.equal(suggestions.length, 2);
    for (const suggestion of suggestions) {
      assert.deepEqual(suggestion.candidates.map((c) => [c.id, c.referenceMatch]).sort(), [['p-1', true], ['p-2', true]]);
    }
    // 2 różne wpłaty-kandydaci (tekst tytułu), niezależnie od liczby pozycji, które je widzą,
    // ponad bazową liczbę wywołań (uwierzytelnienie sesji) tej samej trasy.
    assert.equal(digestCalls - baseline, 2);
  } finally {
    crypto.subtle.digest = originalDigest;
    await db.close();
  }
});

// #218: karta uzgodnienia nie zwraca już `unmatchedLines` jako duplikatu
// obiektów z `lines` — pole `match` w każdej pozycji wystarcza.
test('reconciliation detail does not duplicate line objects in a separate unmatchedLines field', async () => {
  const { db, cookies, call } = await setup();
  try {
    await seedPayments(db, [['p-1', 'h-1', 2500, '2026-09-14', 'bank']]);
    const draft = await draftWithLines(call, cookies, [2500]);
    const detail = await (await call(`/api/reconciliations/${draft.id}`, { cookie: cookies.treasurer })).json();
    assert.equal(detail.unmatchedLines, undefined);
    assert.equal(detail.lines.length, 1);
    assert.equal(detail.lines[0].match, null);
    assert.equal(detail.summary.unmatchedLineCount, 1);
  } finally {
    await db.close();
  }
});

// #218: stronicowanie pozycji wyciągu — remis booked_on rozstrzygany po id,
// bez duplikatów i luk między stronami; summary liczy wszystkie pozycje,
// niezależnie od rozmiaru strony.
test('reconciliation detail paginates lines with a stable cursor and full summary counts', async () => {
  const { db, cookies, call } = await setup();
  try {
    const draft = await (await createDraft(call, cookies.treasurer)).json();
    const lines = Array.from({ length: 7 }, (_, i) => ({ bookedOn: '2026-09-14', amountCents: 100 + i }));
    await importLines(call, cookies.treasurer, draft.reconciliation.id, lines);

    const page1 = await (await call(`/api/reconciliations/${draft.reconciliation.id}?limit=3`, { cookie: cookies.treasurer })).json();
    assert.equal(page1.lines.length, 3);
    assert.ok(page1.nextCursor);
    assert.equal(page1.summary.lineCount, 7);
    assert.equal(page1.summary.unmatchedLineCount, 7);

    const page2 = await (await call(`/api/reconciliations/${draft.reconciliation.id}?limit=3&cursor=${encodeURIComponent(page1.nextCursor)}`, { cookie: cookies.treasurer })).json();
    assert.equal(page2.lines.length, 3);
    assert.ok(page2.nextCursor);

    const page3 = await (await call(`/api/reconciliations/${draft.reconciliation.id}?limit=3&cursor=${encodeURIComponent(page2.nextCursor)}`, { cookie: cookies.treasurer })).json();
    assert.equal(page3.lines.length, 1);
    assert.equal(page3.nextCursor, null);

    const allIds = [...page1.lines, ...page2.lines, ...page3.lines].map((line) => line.id);
    assert.equal(new Set(allIds).size, 7);
    assert.equal(allIds.length, 7);
  } finally {
    await db.close();
  }
});

// #158: SQL ogranicza liczbę kandydatów na pozycję z zapasem (MAX_CANDIDATES * 4),
// a dopasowanie po tytule nadal może wypchnąć dalszego dniowo kandydata na górę.
test('suggestions still rank a reference match to the top even with many same-day candidates', async () => {
  const { db, cookies, call } = await setup();
  try {
    await db.query("INSERT INTO households (id) VALUES ('h-1')");
    // 15 wpłat tej samej kwoty i daty bez zgodnego tytułu (poniżej zapasu SQL
    // MAX_CANDIDATES*4=20), plus jedna dalsza dniowo (ale w oknie) ze zgodnym
    // tytułem — bez zapasu w SQL (samo LIMIT MAX_CANDIDATES po day_distance)
    // dopasowanie po tytule zostałoby odrzucone przed sortowaniem w JS.
    const rows = [];
    for (let i = 0; i < 15; i += 1) {
      const paymentId = `p-noise-${i}`;
      rows.push(`('${paymentId}', 'h-1', $1, 2500, '2026-09-14', 'bank', 'inny tytuł', 'recorded', 'u-treasurer', 'pay-key-noise-${i}')`);
    }
    rows.push("('p-match', 'h-1', $1, 2500, '2026-09-12', 'bank', 'składka rd-0001', 'recorded', 'u-treasurer', 'pay-key-match')");
    await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method,
      reference, status, created_by, idempotency_key) VALUES ${rows.join(', ')}`, [YEAR]);
    const { reconciliation } = await (await createDraft(call, cookies.treasurer)).json();
    await call(`/api/reconciliations/${reconciliation.id}/lines`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('imp') },
      body: { lines: [{ bookedOn: '2026-09-14', amountCents: 2500, reference: 'składka rd-0001' }] },
    });
    const { suggestions } = await (await call(`/api/reconciliations/${reconciliation.id}/suggestions?windowDays=7`, { cookie: cookies.treasurer })).json();
    assert.equal(suggestions[0].candidates.length, 5);
    assert.equal(suggestions[0].candidates[0].id, 'p-match');
    assert.equal(suggestions[0].candidates[0].referenceMatch, true);
  } finally {
    await db.close();
  }
});
