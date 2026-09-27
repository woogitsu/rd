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
    assert.equal(report.checks.categoryIncomeMatchesSummary, true);
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
    for (const cookie of [cookies.rep, cookies.auditNoMfa, cookies.admin]) {
      assert.equal((await call(`/api/reports/audit?schoolYearId=${YEAR}`, { cookie })).status, 403);
    }
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
