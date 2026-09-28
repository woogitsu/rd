// Porzucenie szkicu uzgodnienia i ponowny import tego samego pliku (0107,
// przegląd #344, #105). Wyłącznie dane syntetyczne.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-test';
const Y_CLOSED = 'y-abandon-closed';
const Y_NEXT = 'y-abandon-next';
const CODA_FIXTURE = readFileSync(new URL('./fixtures/coda-synthetic.cod', import.meta.url), 'utf8');
const CONFIG = { BANK_TRANSACTION_HASH_KEY: 'test-only-hmac-key-0123456789abcdef', RECONCILIATION_BANK_ACCOUNT_IBAN: 'BE68 5390 0754 7034' };
const REASON = 'Saldo pliku niezgodne z wyciągiem (syntetyczne)';
let keySeq = 0;
const key = (prefix = 'abn') => `${prefix}-key-${++keySeq}-${Date.now()}`;

const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
let shared = null;
let schemaSeq = 0;
after(async () => { await shared?.close(); });

async function freshDb({ before } = {}) {
  shared ??= new PGlite();
  const schema = `rec_abandon_test_${++schemaSeq}`;
  await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  const migrations = await loadMigrations(migrationsDirectory);
  const pending = [];
  for (const migration of migrations) {
    if (before && migration.name >= before) pending.push(migration);
    else await shared.exec(migration.sql);
  }
  const db = { query: (...args) => shared.query(...args), exec: (...args) => shared.exec(...args),
    transaction: (fn) => shared.transaction(fn), close: async () => {} };
  db.applyPending = async () => { for (const migration of pending) await shared.exec(migration.sql); };
  return db;
}

async function setup() {
  const db = await freshDb();
  await seedSchoolYear(db, YEAR);
  await seedSchoolYear(db, 'y-other', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin', schoolYearId: YEAR }], mfa: true }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-treasurer', mfa: false }),
    otherYear: await seedUserSession(db, { userId: 'u-other', roles: [{ role: 'treasurer', schoolYearId: 'y-other' }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true,
    }),
  };
  const call = (path, options = {}) => handlePgRequest(request(path, options), { db, ...CONFIG });
  return { db, cookies, call };
}

async function draft(call, cookie, { schoolYearId = YEAR, statementDate = '2026-09-30', statementBalanceCents = 103750 } = {}) {
  const response = await call('/api/reconciliations', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key('rec') },
    body: { schoolYearId, statementDate, statementBalanceCents },
  });
  assert.equal(response.status, 201);
  return (await response.json()).reconciliation.id;
}

const importFile = (call, cookie, id, body) => call(`/api/reconciliations/${id}/lines`, {
  method: 'POST', cookie, headers: { 'Idempotency-Key': key('imp') }, body,
});
const abandon = (call, cookie, id, reason = REASON, options = {}) => call(`/api/reconciliations/${id}/abandon`, {
  method: 'POST', cookie, body: { reason }, ...options,
});

async function seedIncome(db, id, cents, date) {
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
    VALUES ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer') ON CONFLICT (id) DO NOTHING`, [YEAR]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
    occurred_on, method, created_by, idempotency_key)
    VALUES ($1, $2, 'income', $3, 'cat-dues', 'Wpis syntetyczny', $4, 'bank', 'u-treasurer', $5)`,
  [id, YEAR, cents, date, `le-key-${id}`]);
}

test('porzucenie szkicu i ponowny import tego samego pliku do nowego szkicu', async () => {
  const { db, cookies, call } = await setup();
  const first = await draft(call, cookies.treasurer, { statementBalanceCents: 999 });
  const imported = await importFile(call, cookies.treasurer, first, { coda: CODA_FIXTURE });
  assert.equal(imported.status, 201);
  const firstImportId = (await imported.json()).import.id;

  const second = await draft(call, cookies.treasurer);
  const blocked = await importFile(call, cookies.treasurer, second, { coda: CODA_FIXTURE });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'statement_already_imported');

  // Autor szkicu może go porzucić (bez zasady czterech oczu); powód wymagany.
  const noReason = await abandon(call, cookies.treasurer, first, '');
  assert.equal(noReason.status, 400);
  assert.equal((await noReason.json()).error, 'invalid_reason');
  const done = await abandon(call, cookies.treasurer, first);
  assert.equal(done.status, 200);
  assert.equal(done.headers.get('Idempotency-Replayed'), 'false');
  const body = (await done.json()).reconciliation;
  assert.equal(body.status, 'abandoned');
  assert.equal(body.abandonedBy, 'u-treasurer');
  assert.equal(body.abandonReason, REASON);
  assert.ok(body.abandonedAt);

  const again = await importFile(call, cookies.treasurer, second, { coda: CODA_FIXTURE });
  const againBody = await again.json();
  assert.equal(again.status, 201, JSON.stringify(againBody));
  assert.equal(againBody.import.lineCount, 3);
  assert.equal(againBody.skippedDuplicateCount, 0);
  // Porzucony szkic nie jest poprzednikiem w kontroli ciągłości sald.
  assert.ok(!againBody.warnings.includes('opening_balance_discontinuity'));

  // Historia zostaje: import i pozycje porzuconego szkicu nadal istnieją.
  const { rows } = await db.query(`SELECT r.status, count(l.id)::int AS n FROM bank_reconciliations r
    LEFT JOIN bank_statement_lines l ON l.reconciliation_id = r.id GROUP BY r.id, r.status ORDER BY r.status`);
  assert.deepEqual(rows, [{ status: 'abandoned', n: 3 }, { status: 'draft', n: 3 }]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_statement_imports WHERE id = $1', [firstImportId])).rows[0].n, 1);

  // Trzeci szkic: plik jest już w nieporzuconym szkicu -> 409 z odnośnikiem do niego.
  const third = await draft(call, cookies.treasurer);
  const third409 = await importFile(call, cookies.treasurer, third, { coda: CODA_FIXTURE });
  assert.equal(third409.status, 409);
  assert.equal((await third409.json()).reconciliationId, second);

  // Porzucony szkic: brak zapisów, brak zatwierdzenia, brak powrotu do szkicu.
  const toAbandoned = await importFile(call, cookies.treasurer, first, { lines: [{ bookedOn: '2026-09-10', amountCents: 100 }] });
  assert.equal(toAbandoned.status, 409);
  assert.equal((await toAbandoned.json()).error, 'reconciliation_abandoned');
  const confirm = await call(`/api/reconciliations/${first}/confirm`, {
    method: 'POST', cookie: cookies.board, body: { confirmationNote: 'Próba syntetyczna' },
  });
  assert.equal(confirm.status, 409);
  assert.equal((await confirm.json()).error, 'reconciliation_abandoned');
  // Wpłata wprost z pozycji porzuconego szkicu (#115) też jest odrzucona.
  const abandonedLine = (await db.query(
    "SELECT id FROM bank_statement_lines WHERE reconciliation_id = $1 AND amount_cents > 0 ORDER BY id LIMIT 1", [first])).rows[0];
  assert.ok(abandonedLine);
  const fromLine = await call(`/api/reconciliations/${first}/lines/${abandonedLine.id}/payment`, {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('pay') }, body: { householdId: null },
  });
  assert.equal(fromLine.status, 409);
  assert.equal((await fromLine.json()).error, 'reconciliation_abandoned');
  // Dopasowanie zbiorcze (#127 cz. 2, 0105) w porzuconym szkicu — ten sam kod.
  const grouped = await call(`/api/reconciliations/${first}/group-matches`, {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('grp') },
    body: { statementLineId: abandonedLine.id, items: [{ paymentEntryId: 'p-brak-1' }, { paymentEntryId: 'p-brak-2' }] },
  });
  assert.equal(grouped.status, 409);
  assert.equal((await grouped.json()).error, 'reconciliation_abandoned');
  await assert.rejects(db.query("UPDATE bank_reconciliations SET status = 'draft', abandoned_by = NULL, abandoned_at = NULL, abandon_reason = NULL WHERE id = $1", [first]),
    /bank_reconciliation_abandoned/);
  await assert.rejects(db.query('DELETE FROM bank_reconciliations WHERE id = $1', [first]), /cannot_be_deleted/);

  // Lista i raport KR pokazują porzucony szkic osobno.
  const list = await (await call(`/api/reconciliations?schoolYearId=${YEAR}`, { cookie: cookies.treasurer })).json();
  assert.equal(list.reconciliations.find((item) => item.id === first).status, 'abandoned');
  const { report } = await (await call(`/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit })).json();
  assert.equal(report.reconciliations.abandonedCount, 1);
  assert.equal(report.reconciliations.draftCount, 2);

  const events = await db.query("SELECT actor_id, entity_id, metadata_json AS metadata FROM audit_events WHERE action = 'reconciliation.abandoned'");
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0].actor_id, 'u-treasurer');
  assert.equal(events.rows[0].entity_id, first);
  const metadata = typeof events.rows[0].metadata === 'string' ? JSON.parse(events.rows[0].metadata) : events.rows[0].metadata;
  assert.equal(metadata.schoolYearId, YEAR);
  assert.doesNotMatch(JSON.stringify(events.rows[0]), /niezgodne/);
});

test('szkic z aktywnym dopasowaniem nie może być porzucony; po cofnięciu — tak, historia zostaje', async () => {
  const { db, cookies, call } = await setup();
  await seedIncome(db, 'le-a', 2500, '2026-09-14');
  const id = await draft(call, cookies.treasurer);
  assert.equal((await importFile(call, cookies.treasurer, id, { coda: CODA_FIXTURE })).status, 201);
  const detail = await (await call(`/api/reconciliations/${id}`, { cookie: cookies.treasurer })).json();
  const line = detail.lines.find((item) => item.amountCents === 2500);
  const matched = await call(`/api/reconciliations/${id}/matches`, {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('match') },
    body: { statementLineId: line.id, ledgerEntryId: 'le-a' },
  });
  assert.equal(matched.status, 201);
  const matchId = (await matched.json()).match.id;

  const refused = await abandon(call, cookies.treasurer, id);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'reconciliation_has_active_matches', activeMatchCount: 1 });
  // Bezpośredni UPDATE też odrzucony przez bazę.
  await assert.rejects(db.query(`UPDATE bank_reconciliations SET status = 'abandoned', abandoned_by = 'u-treasurer',
    abandoned_at = now(), abandon_reason = 'Próba syntetyczna' WHERE id = $1`, [id]), /bank_reconciliation_has_active_matches/);

  const revoked = await call(`/api/reconciliations/${id}/matches/${matchId}/revocation`, {
    method: 'POST', cookie: cookies.treasurer, body: { reason: 'Pomyłka syntetyczna' },
  });
  assert.equal(revoked.status, 200);
  const ok = await abandon(call, cookies.treasurer, id);
  assert.equal(ok.status, 200);
  const { rows } = await db.query('SELECT revoked_at IS NOT NULL AS revoked FROM bank_reconciliation_matches WHERE id = $1', [matchId]);
  assert.deepEqual(rows, [{ revoked: true }]);
  // Po porzuceniu nie można już wiązać pozycji.
  const late = await call(`/api/reconciliations/${id}/matches`, {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('match') },
    body: { statementLineId: line.id, ledgerEntryId: 'le-a' },
  });
  assert.equal(late.status, 409);
  assert.equal((await late.json()).error, 'reconciliation_abandoned');
});

test('aktywne dopasowanie zbiorcze (widok z #390) blokuje porzucenie w bazie', async () => {
  const { db, cookies, call } = await setup();
  const id = await draft(call, cookies.treasurer);
  const exists = (await db.query("SELECT to_regclass('bank_reconciliation_group_matches_current') IS NOT NULL AS e")).rows[0].e;
  if (exists) {
    // #390 scalony: wystarczy sprawdzić, że funkcja widzi widok (bez dopasowań -> false).
    assert.equal((await db.query('SELECT bank_reconciliation_has_active_matches($1) AS v', [id])).rows[0].v, false);
    return;
  }
  // Symulacja widoku z 0105 (#390) na potrzeby testu.
  await db.exec(`CREATE TABLE test_group_matches (reconciliation_id TEXT);
    CREATE VIEW bank_reconciliation_group_matches_current AS SELECT reconciliation_id FROM test_group_matches;`);
  await db.query('INSERT INTO test_group_matches VALUES ($1)', [id]);
  const refused = await abandon(call, cookies.treasurer, id);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, 'reconciliation_has_active_matches');
  await db.query('DELETE FROM test_group_matches');
  assert.equal((await abandon(call, cookies.treasurer, id)).status, 200);
});

test('podwójne kliknięcie: jedno porzucenie, ponowienie zwraca 200 Replayed; inna osoba lub powód -> 409', async () => {
  const { db, cookies, call } = await setup();
  const id = await draft(call, cookies.treasurer);
  const results = await Promise.all([abandon(call, cookies.treasurer, id), abandon(call, cookies.treasurer, id)]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.deepEqual(results.map((r) => r.headers.get('Idempotency-Replayed')).sort(), ['false', 'true']);
  const events = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'reconciliation.abandoned'");
  assert.equal(events.rows[0].n, 1);
  const otherReason = await abandon(call, cookies.treasurer, id, 'Inny powód syntetyczny');
  assert.equal(otherReason.status, 409);
  assert.equal((await otherReason.json()).error, 'reconciliation_abandoned');
  const otherPerson = await abandon(call, cookies.board, id);
  assert.equal(otherPerson.status, 409);

  // Zatwierdzone uzgodnienie nie może być porzucone.
  const confirmedId = await draft(call, cookies.treasurer, { statementBalanceCents: 0 });
  const confirm = await call(`/api/reconciliations/${confirmedId}/confirm`, {
    method: 'POST', cookie: cookies.board, body: { confirmationNote: 'Różnica syntetyczna do testu' },
  });
  assert.equal(confirm.status, 200);
  const refused = await abandon(call, cookies.treasurer, confirmedId);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, 'reconciliation_confirmed');
  assert.equal((await abandon(call, cookies.treasurer, 'missing-id')).status, 404);
});

test('granice ról: przedstawiciel, KR, dyrekcja, brak MFA, inny rok, obcy Origin, brak sesji', async () => {
  const { db, cookies, call } = await setup();
  const id = await draft(call, cookies.treasurer);
  for (const cookie of [cookies.rep, cookies.audit, cookies.principal, cookies.treasurerNoMfa, cookies.otherYear]) {
    const denied = await abandon(call, cookie, id);
    assert.equal(denied.status, 403);
  }
  assert.equal((await abandon(call, undefined, id)).status, 401);
  const crossOrigin = await abandon(call, cookies.treasurer, id, REASON, { origin: 'https://evil.invalid' });
  assert.equal(crossOrigin.status, 403);
  const get = await call(`/api/reconciliations/${id}/abandon`, { cookie: cookies.treasurer });
  assert.equal(get.status, 405);
  assert.equal((await db.query("SELECT status FROM bank_reconciliations WHERE id = $1", [id])).rows[0].status, 'draft');
  // Zarząd i admin roku mogą porzucić.
  assert.equal((await abandon(call, cookies.admin, id)).status, 200);
  const other = await draft(call, cookies.treasurer);
  assert.equal((await abandon(call, cookies.board, other)).status, 200);
});

test('rok zamknięty blokuje porzucenie szkicu', async () => {
  const { db, call } = await setup();
  await seedSchoolYear(db, Y_CLOSED, { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, Y_NEXT, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  const cookie = await seedUserSession(db, { userId: 'u-closed', roles: [{ role: 'treasurer', schoolYearId: Y_CLOSED }], mfa: true });
  const id = await draft(call, cookie, { schoolYearId: Y_CLOSED, statementDate: '2026-06-30', statementBalanceCents: 0 });
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-abandon-1', '${Y_CLOSED}', '${Y_NEXT}', 'closed', 'u-a', 'u-b', now(), 0, 0, 0, 0, 'ob-next-abandon', 0);
    SET session_replication_role = origin;
  `);
  const refused = await abandon(call, cookie, id);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, 'school_year_closed');
  assert.equal((await db.query('SELECT status FROM bank_reconciliations WHERE id = $1', [id])).rows[0].status, 'draft');
});

test('migracja 0107 na bazie z danymi: wiersze bez zmian, unikalność tylko wśród nieporzuconych', async () => {
  const db = await freshDb({ before: '0107' });
  await seedSchoolYear(db, YEAR);
  await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true });
  await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
  const fileHash = 'a'.repeat(64);
  const txHash = 'b'.repeat(64);
  const insertReconciliation = (id, balance = 0) => db.query(`INSERT INTO bank_reconciliations (id, school_year_id,
    statement_date, statement_balance_cents, ledger_balance_cents, ledger_non_bank_cents, reference_salt, created_by, idempotency_key)
    VALUES ($1, $2, '2026-09-30', $3, 0, 0, $4, 'u-treasurer', $5)`, [id, YEAR, balance, 'c'.repeat(32), `rec-key-${id}`]);
  const insertImport = (id, reconciliationId, hash) => db.query(`INSERT INTO bank_statement_imports (id, reconciliation_id,
    source, line_count, request_hash, created_by, idempotency_key, file_hash, opening_balance_cents, closing_balance_cents)
    VALUES ($1, $2, 'coda', 1, $3, 'u-treasurer', $4, $5, 0, 100)`, [id, reconciliationId, 'd'.repeat(64), `imp-key-${id}`, hash]);
  const insertLine = (id, reconciliationId, importId, hash) => db.query(`INSERT INTO bank_statement_lines (id,
    reconciliation_id, import_id, line_no, booked_on, amount_cents, bank_transaction_hash, created_by)
    VALUES ($1, $2, $3, 1, '2026-09-10', 100, $4, 'u-treasurer')`, [id, reconciliationId, importId, hash]);
  await insertReconciliation('rec-old');
  await insertImport('imp-old', 'rec-old', fileHash);
  await insertLine('line-old', 'rec-old', 'imp-old', txHash);
  await insertReconciliation('rec-confirmed');
  await db.query(`UPDATE bank_reconciliations SET status = 'confirmed', confirmed_by = 'u-board', confirmed_at = now(),
    confirmation_note = 'Syntetyczne' WHERE id = 'rec-confirmed'`);
  const before = (await db.query('SELECT * FROM bank_reconciliations ORDER BY id')).rows;

  await db.applyPending();

  const afterRows = (await db.query('SELECT * FROM bank_reconciliations ORDER BY id')).rows;
  assert.deepEqual(afterRows.map(({ abandoned_by, abandoned_at, abandon_reason, ...rest }) => {
    assert.equal(abandoned_by, null); assert.equal(abandoned_at, null); assert.equal(abandon_reason, null);
    return rest;
  }), before);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM bank_statement_lines')).rows[0].n, 1);

  // Nowy szkic: ten sam plik i ten sam ruch są odrzucane, dopóki stary szkic nie jest porzucony.
  await insertReconciliation('rec-new');
  await assert.rejects(insertImport('imp-new', 'rec-new', fileHash), /bank_statement_file_already_imported/);
  await insertImport('imp-other', 'rec-new', 'e'.repeat(64));
  await assert.rejects(insertLine('line-new', 'rec-new', 'imp-other', txHash), /bank_statement_transaction_already_imported/);
  await db.query(`UPDATE bank_reconciliations SET status = 'abandoned', abandoned_by = 'u-treasurer', abandoned_at = now(),
    abandon_reason = 'Syntetyczne porzucenie' WHERE id = 'rec-old'`);
  await insertImport('imp-new', 'rec-new', fileHash);
  await insertLine('line-new', 'rec-new', 'imp-new', txHash);
  // Zatwierdzonego nie można porzucić; porzucenie wymaga pól (CHECK).
  await assert.rejects(db.query(`UPDATE bank_reconciliations SET status = 'abandoned', abandoned_by = 'u-treasurer',
    abandoned_at = now(), abandon_reason = 'Syntetyczne' WHERE id = 'rec-confirmed'`), /confirmed_immutable/);
  await insertReconciliation('rec-bare');
  await assert.rejects(db.query("UPDATE bank_reconciliations SET status = 'abandoned' WHERE id = 'rec-bare'"),
    /bank_reconciliation_abandonment/);
  // Porzucony szkic nie przyjmuje importu.
  await assert.rejects(insertImport('imp-late', 'rec-old', 'f'.repeat(64)), /bank_reconciliation_abandoned/);
});
