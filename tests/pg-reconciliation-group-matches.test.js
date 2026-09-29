// Dopasowanie wiele-do-jednego w uzgodnieniu rachunku (#127, część 2; migracja 0105).
// Wyłącznie dane syntetyczne. Jedna instancja PGlite, osobny schemat na test.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { request, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-127g';
const OTHER = 'y-127g-inny';
const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
let shared = null;
let schemaSeq = 0;
let keySeq = 0;
const key = (prefix = 'k') => `${prefix}-127g-${String(++keySeq).padStart(6, '0')}`;
after(async () => { await shared?.close(); });

async function freshDb({ upTo = null } = {}) {
  shared ??= new PGlite();
  const schema = `group_match_test_${++schemaSeq}`;
  await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  const migrations = await loadMigrations(migrationsDirectory);
  for (const migration of migrations) {
    if (upTo && migration.name >= upTo) break;
    await shared.exec(migration.sql);
  }
  const db = { query: (...args) => shared.query(...args), exec: (...args) => shared.exec(...args),
    transaction: (fn) => shared.transaction(fn), close: async () => {} };
  db.applyRest = async () => {
    for (const migration of migrations) if (upTo && migration.name >= upTo) await shared.exec(migration.sql);
  };
  return db;
}

async function setup(options = {}) {
  const db = await freshDb(options);
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, OTHER, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  // h-a i h-b: rodzeństwo przyrodnie w dwóch gospodarstwach; h-c: trzecia rodzina z przelewu zbiorczego.
  for (const householdId of ['h-a', 'h-b', 'h-c']) await seedEnrolledHousehold(db, householdId, [YEAR]);
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-treasurer', mfa: false }),
    otherYear: await seedUserSession(db, { userId: 'u-other', roles: [{ role: 'treasurer', schoolYearId: OTHER }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true,
    }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer'),
    ('cat-fees', $1, 'expense', 'Opłaty bankowe', 'u-treasurer')`, [YEAR]);
  const call = async (path, { cookie, body, idempotencyKey, origin } = {}) => {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const response = await handlePgRequest(request(path, {
      cookie, headers, origin, method: body === undefined ? 'GET' : 'POST', body,
    }), { db });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return { db, cookies, call };
}

async function createPayment(call, cookie, { amountCents, householdId = null, method = 'bank' }) {
  const res = await call('/api/payments', {
    cookie, idempotencyKey: key('pay'),
    body: { schoolYearId: YEAR, householdId, amountCents, receivedOn: '2026-10-01', method, reference: 'Przelew syntetyczny' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.payment.id;
}

// Szkic z saldem wyciągu równym saldu księgi (0 — brak wpisów), więc zatwierdzenie nie wymaga wyjaśnienia.
async function createDraft(call, cookie, statementBalanceCents = 0) {
  const res = await call('/api/reconciliations', {
    cookie, idempotencyKey: key('rec'),
    body: { schoolYearId: YEAR, statementDate: '2026-10-31', statementBalanceCents },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.reconciliation.id;
}

async function importLines(call, cookie, reconciliationId, amounts) {
  const res = await call(`/api/reconciliations/${reconciliationId}/lines`, {
    cookie, idempotencyKey: key('imp'),
    body: { lines: amounts.map((amountCents) => ({ bookedOn: '2026-10-02', amountCents })) },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // Pozycje tego importu w kolejności kwot (line_no); SQL, żeby działało też przed migracją 0105.
  const { rows } = await shared.query(
    'SELECT id FROM bank_statement_lines WHERE import_id = $1 ORDER BY line_no', [res.body.import.id],
  );
  return rows.map((row) => row.id);
}

const groupMatch = (call, cookie, reconciliationId, statementLineId, items, idempotencyKey = key('grp')) =>
  call(`/api/reconciliations/${reconciliationId}/group-matches`, {
    cookie, idempotencyKey, body: { statementLineId, items },
  });

const revokeGroup = (call, cookie, reconciliationId, groupId, reason = 'Błędne dopasowanie — syntetyczne') =>
  call(`/api/reconciliations/${reconciliationId}/group-matches/${groupId}/revocation`, { cookie, body: { reason } });

const payments = (...ids) => ids.map((paymentEntryId) => ({ paymentEntryId }));

async function detail(call, cookie, reconciliationId) {
  const res = await call(`/api/reconciliations/${reconciliationId}`, { cookie });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function auditEvents(db, action) {
  const { rows } = await db.query(
    'SELECT entity_id, actor_id, metadata_json FROM audit_events WHERE action = $1 ORDER BY occurred_at', [action],
  );
  return rows.map((row) => ({ ...row, metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json }));
}

test('przelew zbiorczy 75 EUR za trzy rodziny: jedno dopasowanie, zatwierdzenie bez wyjaśnienia różnicy', async () => {
  const { db, cookies, call } = await setup();
  const [pa, pb, pc] = [
    await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' }),
    await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-b' }),
    await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-c' }),
  ];
  const rec = await createDraft(call, cookies.treasurer);
  const [line] = await importLines(call, cookies.treasurer, rec, [7500]);

  const idem = key('grp');
  const created = await groupMatch(call, cookies.treasurer, rec, line, payments(pa, pb, pc), idem);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.headers.get('Idempotency-Replayed'), 'false');
  const group = created.body.groupMatch;
  assert.equal(group.statementLineId, line);
  assert.deepEqual(group.items.map((item) => item.amountCents), [2500, 2500, 2500]);
  assert.equal(group.revokedAt, null);
  assert.equal(group.idempotencyKey, undefined);

  // Ponowienie z tym samym kluczem i treścią (kolejność pozycji bez znaczenia) → replay.
  const replay = await groupMatch(call, cookies.treasurer, rec, line, payments(pc, pa, pb), idem);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
  assert.equal(replay.body.groupMatch.id, group.id);
  const conflict = await groupMatch(call, cookies.treasurer, rec, line, payments(pa, pb), idem);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'idempotency_conflict');

  const view = await detail(call, cookies.treasurer, rec);
  assert.deepEqual(view.lines[0].groupMatch, { id: group.id, itemCount: 3 });
  assert.equal(view.lines[0].match, null);
  assert.equal(view.summary.lineCount, 1);
  assert.equal(view.summary.matchedLineCount, 1);
  assert.equal(view.summary.unmatchedLineCount, 0);
  assert.equal(view.summary.unmatchedLineTotalCents, 0);
  assert.equal(view.summary.groupMatchedLineCount, 1);
  assert.equal(view.summary.inconsistentGroupMatchCount, 0);
  assert.equal(view.groupMatches.length, 1);

  // Propozycje nie pokazują już tej pozycji.
  const suggestions = await call(`/api/reconciliations/${rec}/suggestions`, { cookie: cookies.treasurer });
  assert.equal(suggestions.body.suggestions.length, 0);

  // Zasada czterech oczu i brak confirmationNote (różnica 0).
  const confirmed = await call(`/api/reconciliations/${rec}/confirm`, { cookie: cookies.board, body: {} });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.reconciliation.confirmationNote, null);
  assert.equal(confirmed.body.reconciliation.status, 'confirmed');

  // Po zatwierdzeniu: bez cofnięcia i bez nowych dopasowań.
  const late = await revokeGroup(call, cookies.treasurer, rec, group.id);
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'reconciliation_confirmed');

  // Dziennik: w transakcji, schoolYearId, bez kwot i bez identyfikatorów gospodarstw.
  const [event] = await auditEvents(db, 'reconciliation.group_match.confirmed');
  assert.equal(event.entity_id, group.id);
  assert.equal(event.actor_id, 'u-treasurer');
  assert.equal(event.metadata.schoolYearId, YEAR);
  assert.equal(event.metadata.itemCount, 3);
  assert.deepEqual(event.metadata.paymentEntryIds, [pa, pb, pc].sort());
  const text = JSON.stringify(event.metadata);
  assert.doesNotMatch(text, /h-a|h-b|h-c|2500|7500|amount/i);

  // Raport KR: pozycja nie jest niedopasowana, kontrola powiązań zgodna.
  const report = await call(`/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
  assert.equal(report.status, 200);
  assert.equal(report.body.report.reconciliations.items[0].unmatchedLineCount, 0);
  const check = report.body.report.checks.items.find((item) => item.id === 'reconciliation_matches');
  assert.equal(check.ok, true);
  assert.equal(check.groupAmountMismatchCount, 0);
});

test('rodzeństwo w dwóch gospodarstwach: wpłata podzielona + osobna wpłata jedną pozycją; sumy gospodarstw bez zmian', async () => {
  const { db, cookies, call } = await setup();
  const split = await createPayment(call, cookies.treasurer, { amountCents: 5000 });
  for (const [householdId, amountCents] of [['h-a', 2500], ['h-b', 2500]]) {
    const res = await call(`/api/payments/${split}/allocations`, {
      cookie: cookies.treasurer, idempotencyKey: key('alloc'), body: { householdId, amountCents },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const single = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-c' });
  const totals = async () => (await db.query(
    `SELECT household_id, net_amount_cents::int AS net FROM household_payment_totals
      WHERE school_year_id = $1 ORDER BY household_id`, [YEAR])).rows;
  const before = await totals();
  assert.deepEqual(before.map((row) => row.net), [2500, 2500, 2500]);

  const rec = await createDraft(call, cookies.treasurer);
  const [line] = await importLines(call, cookies.treasurer, rec, [7500]);
  const created = await groupMatch(call, cookies.treasurer, rec, line, payments(split, single));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.groupMatch.items.map((item) => item.amountCents).sort((a, b) => a - b), [2500, 5000]);
  assert.deepEqual(await totals(), before, 'dopasowanie nie zmienia sum gospodarstw');

  // Część podzielonej wpłaty nie jest osobnym celem: wpłata jest już w dopasowaniu.
  const [otherLine] = await importLines(call, cookies.treasurer, rec, [5000]);
  const again = await call(`/api/reconciliations/${rec}/matches`, {
    cookie: cookies.treasurer, idempotencyKey: key('m'), body: { statementLineId: otherLine, paymentEntryId: split },
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_matched');
});

test('suma pozycji ≠ kwota pozycji wyciągu: odrzucenie w API i w bazie (także dopisanie pozycji później)', async () => {
  const { db, cookies, call } = await setup();
  const pa = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const pb = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-b' });
  const pc = await createPayment(call, cookies.treasurer, { amountCents: 2000, householdId: 'h-c' });
  const rec = await createDraft(call, cookies.treasurer);
  const [line, line2] = await importLines(call, cookies.treasurer, rec, [7500, 5000]);

  const short = await groupMatch(call, cookies.treasurer, rec, line, payments(pa, pb, pc));
  assert.equal(short.status, 409);
  assert.equal(short.body.error, 'group_match_sum_mismatch');
  assert.equal(short.body.lineAmountCents, 7500);
  assert.equal(short.body.itemsTotalCents, 7000);

  const one = await groupMatch(call, cookies.treasurer, rec, line, payments(pa));
  assert.equal(one.status, 400);
  assert.equal(one.body.error, 'invalid_request');
  const duplicate = await groupMatch(call, cookies.treasurer, rec, line, payments(pa, pa, pb));
  assert.equal(duplicate.status, 400);
  const amountGiven = await groupMatch(call, cookies.treasurer, rec, line, [{ paymentEntryId: pa, amountCents: 5000 }, { paymentEntryId: pb }]);
  assert.equal(amountGiven.status, 400, 'klient nie podaje kwot pozycji');
  const { rows: none } = await db.query('SELECT count(*)::int AS n FROM bank_reconciliation_group_matches');
  assert.equal(none[0].n, 0);

  // Bezpośredni zapis z pominięciem API: suma sprawdzana przy COMMIT.
  await assert.rejects(db.transaction(async (tx) => {
    await tx.query(`INSERT INTO bank_reconciliation_group_matches (id, reconciliation_id, school_year_id, statement_line_id,
      created_by, idempotency_key) VALUES ('g-sql', $1, $2, $3, 'u-treasurer', 'g-sql-key-0001')`, [rec, YEAR, line]);
    await tx.query(`INSERT INTO bank_reconciliation_group_match_items (id, group_match_id, reconciliation_id, school_year_id,
      payment_entry_id, amount_cents) VALUES ('gi-1', 'g-sql', $1, $2, $3, 2500), ('gi-2', 'g-sql', $1, $2, $4, 2500)`,
    [rec, YEAR, pa, pb]);
  }), /bank_group_match_sum_mismatch/);
  await assert.rejects(db.transaction(async (tx) => {
    await tx.query(`INSERT INTO bank_reconciliation_group_matches (id, reconciliation_id, school_year_id, statement_line_id,
      created_by, idempotency_key) VALUES ('g-sql1', $1, $2, $3, 'u-treasurer', 'g-sql-key-0002')`, [rec, YEAR, line2]);
    await tx.query(`INSERT INTO bank_reconciliation_group_match_items (id, group_match_id, reconciliation_id, school_year_id,
      payment_entry_id, amount_cents) VALUES ('gi-3', 'g-sql1', $1, $2, $3, 2500)`, [rec, YEAR, pa]);
  }), /bank_group_match_too_few_items/);
  // Kwota pozycji inna niż netto celu.
  await assert.rejects(db.transaction(async (tx) => {
    await tx.query(`INSERT INTO bank_reconciliation_group_matches (id, reconciliation_id, school_year_id, statement_line_id,
      created_by, idempotency_key) VALUES ('g-sql2', $1, $2, $3, 'u-treasurer', 'g-sql-key-0003')`, [rec, YEAR, line2]);
    await tx.query(`INSERT INTO bank_reconciliation_group_match_items (id, group_match_id, reconciliation_id, school_year_id,
      payment_entry_id, amount_cents) VALUES ('gi-4', 'g-sql2', $1, $2, $3, 3000), ('gi-5', 'g-sql2', $1, $2, $4, 2000)`,
    [rec, YEAR, pa, pc]);
  }), /bank_match_amount_mismatch/);

  // Poprawne dopasowanie, potem próba dopisania pozycji do istniejącego dopasowania.
  const ok = await groupMatch(call, cookies.treasurer, rec, line2, payments(pa, pb));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const extra = await createPayment(call, cookies.treasurer, { amountCents: 100, householdId: 'h-c' });
  await assert.rejects(db.query(`INSERT INTO bank_reconciliation_group_match_items (id, group_match_id, reconciliation_id,
    school_year_id, payment_entry_id, amount_cents) VALUES ('gi-6', $1, $2, $3, $4, 100)`,
  [ok.body.groupMatch.id, rec, YEAR, extra]), /bank_group_match_sum_mismatch/);
  // Nagłówka i pozycji nie da się zmienić ani usunąć.
  await assert.rejects(db.query('UPDATE bank_reconciliation_group_match_items SET amount_cents = 1'));
  await assert.rejects(db.query('DELETE FROM bank_reconciliation_group_matches'));
  for (const table of ['bank_reconciliation_group_matches', 'bank_reconciliation_group_match_items',
    'bank_reconciliation_group_match_revocations']) {
    await assert.rejects(db.query(`TRUNCATE ${table} CASCADE`), /truncate_not_allowed/);
  }
});

test('podwójne kliknięcie i równoległe dopasowania: jedno przyjęte, reszta odrzucona', async () => {
  const { db, cookies, call } = await setup();
  const pa = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const pb = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-b' });
  const pc = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-c' });
  const rec = await createDraft(call, cookies.treasurer);
  const [line, line2] = await importLines(call, cookies.treasurer, rec, [5000, 5000]);

  // Ten sam klucz dwa razy naraz.
  const idem = key('grp');
  const same = await Promise.all([
    groupMatch(call, cookies.treasurer, rec, line, payments(pa, pb), idem),
    groupMatch(call, cookies.treasurer, rec, line, payments(pa, pb), idem),
  ]);
  assert.deepEqual(same.map((res) => res.status).sort(), [200, 201]);

  // Nowy klucz, ta sama pozycja (podwójne kliknięcie po odświeżeniu).
  const retry = await groupMatch(call, cookies.treasurer, rec, line, payments(pb, pc));
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, 'already_matched');

  // Dwa równoległe dopasowania dzielące wpłatę pc na różnych pozycjach — jedno odrzucone.
  const pd = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const [line3] = await importLines(call, cookies.treasurer, rec, [5000]);
  const racing = await Promise.all([
    groupMatch(call, cookies.treasurer, rec, line2, payments(pc, pd)),
    groupMatch(call, cookies.treasurer, rec, line3, payments(pd, pc)),
  ]);
  assert.deepEqual(racing.map((res) => res.status).sort(), [201, 409]);

  // Dopasowanie 1:1 wpłaty z dopasowania zbiorczego i pozycji zbiorczej — odrzucone w API i w bazie.
  const [line4] = await importLines(call, cookies.treasurer, rec, [2500]);
  const oneToOne = await call(`/api/reconciliations/${rec}/matches`, {
    cookie: cookies.treasurer, idempotencyKey: key('m'), body: { statementLineId: line4, paymentEntryId: pa },
  });
  assert.equal(oneToOne.status, 409);
  assert.equal(oneToOne.body.error, 'already_matched');
  const big = await createPayment(call, cookies.treasurer, { amountCents: 5000, householdId: 'h-b' });
  await assert.rejects(db.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id,
    payment_entry_id, created_by, idempotency_key) VALUES ('m-sql', $1, $2, $3, 'u-treasurer', 'm-sql-key-0001')`,
  [rec, line, big]), /bank_group_match_line_taken/);
  await assert.rejects(db.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id,
    payment_entry_id, created_by, idempotency_key) VALUES ('m-sql2', $1, $2, $3, 'u-treasurer', 'm-sql-key-0002')`,
  [rec, line4, pa]), /bank_group_match_target_taken/);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM bank_reconciliation_group_matches');
  assert.equal(rows[0].n, 2);
});

test('cofnięcie jest nowym zapisem; ponowne dopasowanie i dopasowanie 1:1 po cofnięciu', async () => {
  const { db, cookies, call } = await setup();
  const pa = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const pb = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-b' });
  const pc = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-c' });
  const rec = await createDraft(call, cookies.treasurer);
  const [line] = await importLines(call, cookies.treasurer, rec, [5000]);
  const first = (await groupMatch(call, cookies.treasurer, rec, line, payments(pa, pb))).body.groupMatch;

  const noReason = await call(`/api/reconciliations/${rec}/group-matches/${first.id}/revocation`, {
    cookie: cookies.treasurer, body: {},
  });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error, 'invalid_reason');

  const revoked = await revokeGroup(call, cookies.treasurer, rec, first.id, 'Zła rodzina — syntetyczne');
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.groupMatch.revokedBy, 'u-treasurer');
  assert.equal(revoked.body.groupMatch.revokeReason, 'Zła rodzina — syntetyczne');
  const replay = await revokeGroup(call, cookies.treasurer, rec, first.id, 'Zła rodzina — syntetyczne');
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
  const second = await revokeGroup(call, cookies.board, rec, first.id, 'Inny powód — syntetyczne');
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'match_already_revoked');
  const missing = await revokeGroup(call, cookies.treasurer, rec, 'nie-ma-takiego');
  assert.equal(missing.status, 404);

  // Wiersze dopasowania zostają, cofnięcie to osobny zapis; nie da się go zmienić.
  const { rows } = await db.query(`SELECT (SELECT count(*)::int FROM bank_reconciliation_group_matches) AS g,
    (SELECT count(*)::int FROM bank_reconciliation_group_match_items) AS i,
    (SELECT count(*)::int FROM bank_reconciliation_group_match_revocations) AS r`);
  assert.deepEqual(rows[0], { g: 1, i: 2, r: 1 });
  await assert.rejects(db.query("UPDATE bank_reconciliation_group_match_revocations SET reason = 'zmiana'"));
  await assert.rejects(db.query('DELETE FROM bank_reconciliation_group_match_revocations'));
  const [event] = await auditEvents(db, 'reconciliation.group_match.revoked');
  assert.equal(event.entity_id, first.id);
  assert.equal(event.metadata.schoolYearId, YEAR);

  let view = await detail(call, cookies.treasurer, rec);
  assert.equal(view.lines[0].groupMatch, null);
  assert.equal(view.summary.unmatchedLineCount, 1);
  assert.equal(view.groupMatches[0].revokedAt !== null, true);

  // Ponowne dopasowanie z inną rodziną.
  const rematch = await groupMatch(call, cookies.treasurer, rec, line, payments(pa, pc));
  assert.equal(rematch.status, 201, JSON.stringify(rematch.body));
  view = await detail(call, cookies.treasurer, rec);
  assert.equal(view.lines[0].groupMatch.id, rematch.body.groupMatch.id);
  assert.equal(view.summary.matchedLineCount, 1);

  // Zwolniona wpłata pb może być dopasowana 1:1 do innej pozycji.
  const [line2] = await importLines(call, cookies.treasurer, rec, [2500]);
  const oneToOne = await call(`/api/reconciliations/${rec}/matches`, {
    cookie: cookies.treasurer, idempotencyKey: key('m'), body: { statementLineId: line2, paymentEntryId: pb },
  });
  assert.equal(oneToOne.status, 201, JSON.stringify(oneToOne.body));
});

test('granice ról: przedstawiciel, audit, dyrekcja, brak MFA, inny rok i obcy Origin nie tworzą ani nie cofają dopasowań', async () => {
  const { db, cookies, call } = await setup();
  const pa = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const pb = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-b' });
  const rec = await createDraft(call, cookies.treasurer);
  const [line, line2] = await importLines(call, cookies.treasurer, rec, [5000, 5000]);
  for (const cookie of [cookies.rep, cookies.audit, cookies.principal, cookies.treasurerNoMfa, cookies.otherYear]) {
    const res = await groupMatch(call, cookie, rec, line, payments(pa, pb));
    assert.equal(res.status, 403, JSON.stringify(res.body));
  }
  assert.equal((await groupMatch(call, undefined, rec, line, payments(pa, pb))).status, 401);
  const foreign = await call(`/api/reconciliations/${rec}/group-matches`, {
    cookie: cookies.treasurer, idempotencyKey: key('grp'), origin: 'https://evil.example.invalid',
    body: { statementLineId: line, items: payments(pa, pb) },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error, 'invalid_origin');

  // Zarząd (board) z MFA może.
  const group = await groupMatch(call, cookies.board, rec, line, payments(pa, pb));
  assert.equal(group.status, 201);
  for (const cookie of [cookies.rep, cookies.audit, cookies.principal, cookies.treasurerNoMfa, cookies.otherYear]) {
    const res = await revokeGroup(call, cookie, rec, group.body.groupMatch.id);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    const read = await call(`/api/reconciliations/${rec}`, { cookie });
    assert.equal(read.status, 403);
  }
  const get = await call(`/api/reconciliations/${rec}/group-matches`, { cookie: cookies.treasurer });
  assert.equal(get.status, 405);
  assert.ok(line2);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM bank_reconciliation_group_match_revocations');
  assert.equal(rows[0].n, 0);
});

test('korekta celu w szkicu jest blokowana; zwrot po dopasowaniu blokuje zatwierdzenie (inconsistent_matches)', async () => {
  const { db, cookies, call } = await setup();
  const pa = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const pb = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-b' });
  const rec = await createDraft(call, cookies.treasurer);
  const [line] = await importLines(call, cookies.treasurer, rec, [5000]);
  const group = (await groupMatch(call, cookies.treasurer, rec, line, payments(pa, pb))).body.groupMatch;

  const correction = await call(`/api/payments/${pa}/corrections`, {
    cookie: cookies.treasurer, idempotencyKey: key('cor'), body: { amountCents: 500, reason: 'Błędna kwota — syntetyczne' },
  });
  assert.equal(correction.status, 409, JSON.stringify(correction.body));
  assert.equal(correction.body.error, 'active_bank_match');
  assert.equal(correction.body.reconciliationId, rec);
  await assert.rejects(db.query(`INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by,
    idempotency_key) VALUES ('pc-sql', $1, 500, 'Bezpośrednio — syntetyczne', 'u-treasurer', 'pc-sql-key-0001')`, [pa]),
  /active_bank_match/);

  // Zwrot (jak dla 1:1) nie jest blokowany; niezgodność wychodzi przy zatwierdzeniu.
  const refund = await call(`/api/payments/${pb}/refunds`, {
    cookie: cookies.treasurer, idempotencyKey: key('ref'),
    body: { amountCents: 500, refundedOn: '2026-10-05', method: 'bank', reason: 'Nadpłata — syntetyczne' },
  });
  assert.equal(refund.status, 201, JSON.stringify(refund.body));
  const view = await detail(call, cookies.treasurer, rec);
  assert.equal(view.summary.inconsistentGroupMatchCount, 1);
  // #379: niespójne dopasowanie zbiorcze nie jest liczone jako dopasowane; suma liczników = lineCount.
  assert.equal(view.summary.matchedLineCount, 0);
  assert.equal(view.summary.unmatchedLineCount, 0);
  assert.equal(view.summary.lineCount, view.summary.matchedLineCount + view.summary.inconsistentMatchCount
    + view.summary.inconsistentGroupMatchCount + view.summary.unmatchedLineCount);
  assert.deepEqual(view.inconsistentGroupMatches[0].reasons, ['amount_mismatch', 'target_changed']);

  const confirm = await call(`/api/reconciliations/${rec}/confirm`, { cookie: cookies.board, body: { confirmationNote: 'Syntetyczne' } });
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.error, 'inconsistent_matches');
  assert.equal(confirm.body.groupMatches[0].groupMatchId, group.id);
  assert.deepEqual(confirm.body.matches, []);
  // Trigger bazy odrzuca to samo przy bezpośrednim UPDATE.
  await assert.rejects(db.query(`UPDATE bank_reconciliations SET status = 'confirmed', confirmed_by = 'u-board',
    confirmed_at = now(), confirmation_note = 'Syntetyczne' WHERE id = $1`, [rec]), /bank_reconciliation_inconsistent_matches/);

  const report = await call(`/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
  const check = report.body.report.checks.items.find((item) => item.id === 'reconciliation_matches');
  assert.equal(check.ok, false);
  assert.equal(check.groupAmountMismatchCount, 1);
  assert.equal(check.groupAmountMismatchConfirmedCount, 0);

  // Po cofnięciu korekta jest dozwolona.
  assert.equal((await revokeGroup(call, cookies.treasurer, rec, group.id)).status, 200);
  const after = await call(`/api/payments/${pa}/corrections`, {
    cookie: cookies.treasurer, idempotencyKey: key('cor'), body: { amountCents: 500, reason: 'Błędna kwota — syntetyczne' },
  });
  assert.equal(after.status, 201, JSON.stringify(after.body));
});

test('wpisy księgi: wypływ zbiorczy, kierunek, podwójne ujęcie wpłaty i jej wpisu, liczniki i niedopasowane wpisy', async () => {
  const { db, cookies, call } = await setup();
  const entry = (id, direction, cents, category, paymentId = null) => db.query(`INSERT INTO ledger_entries (id, school_year_id,
    direction, amount_cents, category_id, description, occurred_on, method, payment_entry_id, created_by, idempotency_key)
    VALUES ($1, $2, $3, $4, $5, $6, '2026-10-01', 'bank', $7, 'u-treasurer', $8)`,
  [id, YEAR, direction, cents, category, `Wpis syntetyczny ${id}`, paymentId, `le-key-${id}`]);
  await entry('le-fee1', 'expense', 300, 'cat-fees');
  await entry('le-fee2', 'expense', 200, 'cat-fees');
  await entry('le-in', 'income', 1000, 'cat-dues');
  const pa = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const pb = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-b' });
  await entry('le-pa', 'income', 2500, 'cat-dues', pa);
  const rec = await createDraft(call, cookies.treasurer, 1000 - 500 + 2500);
  const [out, bulk, rest] = await importLines(call, cookies.treasurer, rec, [-500, 5000, 1000]);

  const wrongDirection = await groupMatch(call, cookies.treasurer, rec, out, [{ ledgerEntryId: 'le-fee1' }, { ledgerEntryId: 'le-in' }]);
  assert.equal(wrongDirection.status, 409);
  assert.equal(wrongDirection.body.error, 'group_match_direction_mismatch');
  const fees = await groupMatch(call, cookies.treasurer, rec, out, [{ ledgerEntryId: 'le-fee1' }, { ledgerEntryId: 'le-fee2' }]);
  assert.equal(fees.status, 201, JSON.stringify(fees.body));
  assert.deepEqual(fees.body.groupMatch.items.map((item) => item.amountCents).sort((a, b) => a - b), [-300, -200]);

  // Wpłata pa i jej wpis le-pa w jednym dopasowaniu — te same pieniądze dwa razy.
  const doubled = await groupMatch(call, cookies.treasurer, rec, bulk, [{ paymentEntryId: pa }, { ledgerEntryId: 'le-pa' }]);
  assert.equal(doubled.status, 409);
  assert.equal(doubled.body.error, 'already_matched_via_ledger');
  const ok = await groupMatch(call, cookies.treasurer, rec, bulk, [{ ledgerEntryId: 'le-pa' }, { paymentEntryId: pb }]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // Wpłata pa jest już ujęta przez swój wpis (pozycją dopasowania zbiorczego) — 1:1 i baza odrzucają.
  const viaLedger = await call(`/api/reconciliations/${rec}/matches`, {
    cookie: cookies.treasurer, idempotencyKey: key('m'), body: { statementLineId: rest, paymentEntryId: pa },
  });
  assert.equal(viaLedger.status, 409);
  await assert.rejects(db.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id,
    payment_entry_id, created_by, idempotency_key) VALUES ('m-sql', $1, $2, $3, 'u-treasurer', 'm-sql-key-0003')`,
  [rec, rest, pa]), /bank_match_already_matched_via_ledger|bank_match_amount_mismatch/);

  // Liczniki: 2 pozycje zbiorcze, 1 dopasowana 1:1, potem 0 niedopasowanych.
  let view = await detail(call, cookies.treasurer, rec);
  assert.equal(view.summary.lineCount, 3);
  assert.equal(view.summary.matchedLineCount, 2);
  assert.equal(view.summary.groupMatchedLineCount, 2);
  assert.equal(view.summary.unmatchedLineCount, 1);
  assert.equal(view.summary.unmatchedLineTotalCents, 1000);
  assert.deepEqual(view.unmatchedLedgerEntries.map((item) => item.id), ['le-in']);
  const suggestions = await call(`/api/reconciliations/${rec}/suggestions`, { cookie: cookies.treasurer });
  assert.deepEqual(suggestions.body.suggestions.map((item) => item.statementLineId), [rest]);
  assert.deepEqual(suggestions.body.suggestions[0].candidates.map((item) => item.id), ['le-in']);
  const single = await call(`/api/reconciliations/${rec}/matches`, {
    cookie: cookies.treasurer, idempotencyKey: key('m'), body: { statementLineId: rest, ledgerEntryId: 'le-in' },
  });
  assert.equal(single.status, 201);
  view = await detail(call, cookies.treasurer, rec);
  assert.equal(view.summary.matchedLineCount, 3);
  assert.equal(view.summary.unmatchedLineCount, 0);
  assert.equal(view.summary.lineCount, view.summary.matchedLineCount + view.summary.unmatchedLineCount);
  assert.equal(view.reconciliation.differenceCents, 0);

  // Korekta wpisu księgi z aktywnego dopasowania zbiorczego — blokowana (API i baza).
  const correction = await call('/api/ledger/le-fee1/corrections', {
    cookie: cookies.treasurer, idempotencyKey: key('lc'), body: { amountCents: 100, reason: 'Błędna kwota — syntetyczne' },
  });
  assert.equal(correction.status, 409, JSON.stringify(correction.body));
  assert.equal(correction.body.error, 'active_bank_match');
  await assert.rejects(db.query(`INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by,
    idempotency_key) VALUES ('lc-sql', 'le-fee1', 100, 'Bezpośrednio — syntetyczne', 'u-treasurer', 'lc-sql-key-0001')`),
  /active_bank_match/);

  const confirmed = await call(`/api/reconciliations/${rec}/confirm`, { cookie: cookies.board, body: {} });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.reconciliation.confirmationNote, null);
});

test('rok zamknięty: dopasowanie zbiorcze i cofnięcie są odrzucane (409 school_year_closed)', async () => {
  const { db, cookies, call } = await setup();
  const pa = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const pb = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-b' });
  const pc = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-c' });
  const pd = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const rec = await createDraft(call, cookies.treasurer);
  const [line, line2] = await importLines(call, cookies.treasurer, rec, [5000, 5000]);
  const group = (await groupMatch(call, cookies.treasurer, rec, line, payments(pa, pb))).body.groupMatch;
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-127g', '${YEAR}', '${OTHER}', 'closed', 'u-treasurer', 'u-board', now(), 0, 0, 0, 0, 'ob-next', 0);
    SET session_replication_role = origin;
  `);
  const created = await groupMatch(call, cookies.treasurer, rec, line2, payments(pc, pd));
  assert.equal(created.status, 409);
  assert.equal(created.body.error, 'school_year_closed');
  const revoked = await revokeGroup(call, cookies.treasurer, rec, group.id);
  assert.equal(revoked.status, 409);
  assert.equal(revoked.body.error, 'school_year_closed');
  await assert.rejects(db.query(`INSERT INTO bank_reconciliation_group_match_revocations (id, group_match_id,
    reconciliation_id, school_year_id, reason, created_by) VALUES ('rv-sql', $1, $2, $3, 'Bezpośrednio', 'u-treasurer')`,
  [group.id, rec, YEAR]), /school_year_closed/);
});

test('migracja 0105 na bazie z danymi: istniejące dopasowania 1:1 i zatwierdzone uzgodnienia bez zmian', async () => {
  // Dane sprzed 0105 zapisane SQL-em (kod tras już korzysta z nowych tabel).
  const { db, cookies, call } = await setup({ upTo: '0105' });
  await db.query(`INSERT INTO payment_entries (id, school_year_id, household_id, amount_cents, received_on, method,
    reference, status, created_by, idempotency_key) VALUES
    ('p-old-1', $1, 'h-a', 2500, '2026-10-01', 'bank', 'Syntetyczne', 'recorded', 'u-treasurer', 'p-old-key-0001'),
    ('p-old-2', $1, 'h-b', 4000, '2026-10-01', 'bank', 'Syntetyczne', 'recorded', 'u-treasurer', 'p-old-key-0002')`, [YEAR]);
  for (const [rec, line, payment, balance] of [['r-old-c', 'l-old-1', 'p-old-1', 2500], ['r-old-d', 'l-old-2', 'p-old-2', 0]]) {
    await db.query(`INSERT INTO bank_reconciliations (id, school_year_id, statement_date, statement_balance_cents,
      ledger_balance_cents, ledger_non_bank_cents, reference_salt, created_by, idempotency_key)
      VALUES ($1, $2, '2026-10-31', $3, 0, 0, 'abcdefabcdefabcdefabcdefabcdefab', 'u-treasurer', $4)`,
    [rec, YEAR, balance, `${rec}-key-0001`]);
    await db.query(`INSERT INTO bank_statement_imports (id, reconciliation_id, source, line_count, request_hash, created_by,
      idempotency_key) VALUES ($1, $2, 'manual', 1, $3, 'u-treasurer', $4)`, [`i-${rec}`, rec, 'a'.repeat(64), `i-${rec}-key-01`]);
    await db.query(`INSERT INTO bank_statement_lines (id, reconciliation_id, import_id, line_no, booked_on, amount_cents, created_by)
      SELECT $1, $2, $3, 1, '2026-10-02', amount_cents, 'u-treasurer' FROM payment_entries WHERE id = $4`,
    [line, rec, `i-${rec}`, payment]);
    await db.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id, payment_entry_id,
      created_by, idempotency_key) VALUES ($1, $2, $3, $4, 'u-treasurer', $5)`, [`m-${rec}`, rec, line, payment, `m-${rec}-key-01`]);
  }
  await db.query(`UPDATE bank_reconciliations SET status = 'confirmed', confirmed_by = 'u-board', confirmed_at = now(),
    confirmation_note = 'Syntetyczne' WHERE id = 'r-old-c'`);

  const snapshot = async () => ({
    matches: (await db.query(`SELECT m.id, m.statement_line_id, m.payment_entry_id, m.revoked_at, r.status,
      r.ledger_balance_cents, r.difference_cents FROM bank_reconciliation_matches m
      JOIN bank_reconciliations r ON r.id = m.reconciliation_id ORDER BY m.id`)).rows,
    totals: (await db.query(`SELECT household_id, net_amount_cents::int AS net FROM household_payment_totals
      ORDER BY household_id`)).rows,
  });
  const before = await snapshot();
  await db.applyRest();
  assert.deepEqual(await snapshot(), before);

  const view = await detail(call, cookies.treasurer, 'r-old-d');
  assert.deepEqual(view.summary, {
    lineCount: 1, matchedLineCount: 1, unmatchedLineCount: 0, unmatchedLineTotalCents: 0,
    inconsistentMatchCount: 0, groupMatchedLineCount: 0, inconsistentGroupMatchCount: 0,
  });
  assert.deepEqual(view.lines[0].match, { id: 'm-r-old-d', ledgerEntryId: null, paymentEntryId: 'p-old-2' });
  assert.equal(view.lines[0].groupMatch, null);
  assert.deepEqual(view.groupMatches, []);
  const report = (await call(`/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit })).body.report;
  assert.deepEqual(report.reconciliations.items.map((item) => [item.id, item.status, item.unmatchedLineCount]),
    [['r-old-c', 'confirmed', 0], ['r-old-d', 'draft', 0]]);
  const check = report.checks.items.find((item) => item.id === 'reconciliation_matches');
  assert.equal(check.ok, true);

  // Istniejące 1:1 dalej działa: cofnięcie i ponowne dopasowanie w szkicu; zatwierdzone nadal niezmienne.
  assert.equal((await call('/api/reconciliations/r-old-d/matches/m-r-old-d/revocation', {
    cookie: cookies.treasurer, body: { reason: 'Test po migracji — syntetyczne' },
  })).status, 200);
  assert.equal((await call('/api/reconciliations/r-old-d/matches', {
    cookie: cookies.treasurer, idempotencyKey: key('m'), body: { statementLineId: 'l-old-2', paymentEntryId: 'p-old-2' },
  })).status, 201);
  const confirmedRevoke = await call('/api/reconciliations/r-old-c/matches/m-r-old-c/revocation', {
    cookie: cookies.treasurer, body: { reason: 'Test po migracji — syntetyczne' },
  });
  assert.equal(confirmedRevoke.status, 409);
});

test('jedno aktywne dopasowanie celu w roku (#105): zbiorcze ↔ 1:1 i zbiorcze ↔ zbiorcze w dwóch uzgodnieniach, także para wpłata–wpis', async () => {
  const { db, cookies, call } = await setup();
  const pa = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const pb = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-b' });
  const pc = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-c' });
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
      occurred_on, method, payment_entry_id, created_by, idempotency_key)
    VALUES ('le-pc', $1, 'income', 2500, 'cat-dues', 'Wpis syntetyczny le-pc', '2026-10-01', 'bank', $2, 'u-treasurer', 'le-key-le-pc')`,
  [YEAR, pc]);
  const match1 = (rec, statementLineId, target) => call(`/api/reconciliations/${rec}/matches`, {
    cookie: cookies.treasurer, idempotencyKey: key('m'), body: { statementLineId, ...target },
  });

  // Uzgodnienie A: pa dopasowana 1:1, pb + wpis le-pc (wpłata pc) zbiorczo.
  const recA = await createDraft(call, cookies.treasurer);
  const [a1, a2] = await importLines(call, cookies.treasurer, recA, [2500, 5000]);
  assert.equal((await match1(recA, a1, { paymentEntryId: pa })).status, 201);
  const groupA = await groupMatch(call, cookies.treasurer, recA, a2, [{ paymentEntryId: pb }, { ledgerEntryId: 'le-pc' }]);
  assert.equal(groupA.status, 201, JSON.stringify(groupA.body));

  // Uzgodnienie B tego roku: żadna z tych wpłat nie może zostać dopasowana drugi raz.
  const recB = await createDraft(call, cookies.treasurer);
  const [b1, b2, b3] = await importLines(call, cookies.treasurer, recB, [5000, 2500, 2500]);
  const viaSimple = await groupMatch(call, cookies.treasurer, recB, b1, payments(pa, pb));
  assert.equal(viaSimple.status, 409, JSON.stringify(viaSimple.body));
  assert.equal(viaSimple.body.error, 'matched_in_other_reconciliation');
  assert.equal(viaSimple.body.reconciliationId, recA);
  const viaGroup = await match1(recB, b2, { paymentEntryId: pb });
  assert.equal(viaGroup.status, 409, JSON.stringify(viaGroup.body));
  assert.equal(viaGroup.body.error, 'matched_in_other_reconciliation');
  // Para wpłata–wpis: wpłata pc, której wpis le-pc jest w dopasowaniu zbiorczym A.
  const viaPair = await match1(recB, b3, { paymentEntryId: pc });
  assert.equal(viaPair.status, 409, JSON.stringify(viaPair.body));
  assert.equal(viaPair.body.error, 'matched_in_other_reconciliation');
  // Bezpośredni INSERT z pominięciem API: trigger odrzuca to samo.
  await assert.rejects(db.transaction(async (tx) => {
    await tx.query(`INSERT INTO bank_reconciliation_group_matches (id, reconciliation_id, school_year_id, statement_line_id,
      created_by, idempotency_key) VALUES ('g-direct', $1, $2, $3, 'u-treasurer', 'g-direct-key-1')`, [recB, YEAR, b1]);
    await tx.query(`INSERT INTO bank_reconciliation_group_match_items (id, group_match_id, reconciliation_id, school_year_id,
      payment_entry_id, amount_cents) VALUES ('gi-1', 'g-direct', $1, $2, $3, 2500), ('gi-2', 'g-direct', $1, $2, $4, 2500)`,
    [recB, YEAR, pa, pb]);
  }), /bank_match_in_other_reconciliation/);

  // Po cofnięciu dopasowania zbiorczego w A cele są wolne w B.
  const revoked = await revokeGroup(call, cookies.treasurer, recA, groupA.body.groupMatch.id);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal((await match1(recB, b2, { paymentEntryId: pb })).status, 201);
  assert.equal((await match1(recB, b3, { paymentEntryId: pc })).status, 201);
});

test('wpłata wprost z pozycji (#115) odrzucona, gdy pozycja jest dopasowana zbiorczo; po cofnięciu działa', async () => {
  const { db, cookies, call } = await setup();
  const p1 = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-a' });
  const p2 = await createPayment(call, cookies.treasurer, { amountCents: 2500, householdId: 'h-b' });
  const rec = await createDraft(call, cookies.treasurer);
  const [lineId] = await importLines(call, cookies.treasurer, rec, [5000]);
  const grouped = await groupMatch(call, cookies.treasurer, rec, lineId, payments(p1, p2));
  assert.equal(grouped.status, 201, JSON.stringify(grouped.body));
  const before = (await db.query('SELECT count(*)::int AS n FROM payment_entries')).rows[0].n;
  const refused = await call(`/api/reconciliations/${rec}/lines/${lineId}/payment`, {
    cookie: cookies.treasurer, idempotencyKey: key('fromline'), body: { householdId: null },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'already_matched');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_entries')).rows[0].n, before, 'bez nowej wpłaty');
  const revoked = await revokeGroup(call, cookies.treasurer, rec, grouped.body.groupMatch.id);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const created = await call(`/api/reconciliations/${rec}/lines/${lineId}/payment`, {
    cookie: cookies.treasurer, idempotencyKey: key('fromline'), body: { householdId: null },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
});
