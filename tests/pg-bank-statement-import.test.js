// Import wyciągu CODA i CAMT.053 (#105). Wyłącznie dane syntetyczne: rachunki to
// przykładowe IBAN z dokumentacji standardów, kontrahenci „Testowi”.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { parseCoda } from '../src/pg/bank/coda.js';
import { parseCamt053 } from '../src/pg/bank/camt053.js';
import { StatementFileError, normalizeIban } from '../src/pg/bank/common.js';
import { request, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { OTHER_IBAN, RADA_IBAN, camtFile, codaFile } from './helpers/bank-statements.js';
import { assertEvery } from './helpers/assertions.js';

const YEAR = 'y-test';
const CODA_FIXTURE = readFileSync(new URL('./fixtures/coda-synthetic.cod', import.meta.url), 'utf8');
const CAMT_FIXTURE = readFileSync(new URL('./fixtures/camt053-synthetic.xml', import.meta.url), 'utf8');
const CONFIG = { BANK_TRANSACTION_HASH_KEY: 'test-only-hmac-key-0123456789abcdef', RECONCILIATION_BANK_ACCOUNT_IBAN: 'BE68 5390 0754 7034' };
let keySeq = 0;
const key = (prefix = 'bank') => `${prefix}-key-${++keySeq}-${Date.now()}`;

const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
let shared = null;
let schemaSeq = 0;
after(async () => { await shared?.close(); });

async function freshDb() {
  shared ??= new PGlite();
  const schema = `bank_import_test_${++schemaSeq}`;
  await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  for (const migration of await loadMigrations(migrationsDirectory)) await shared.exec(migration.sql);
  return { query: (...args) => shared.query(...args), exec: (...args) => shared.exec(...args),
    transaction: (fn) => shared.transaction(fn), close: async () => {} };
}

async function setup(env = CONFIG) {
  const db = await freshDb();
  await seedSchoolYear(db, YEAR);
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-treasurer', mfa: false }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true,
    }),
  };
  const call = (path, options = {}) => handlePgRequest(request(path, options), { db, ...env });
  return { db, cookies, call };
}

async function draft(call, cookie, { statementDate = '2026-09-30', statementBalanceCents = 103750 } = {}) {
  const response = await call('/api/reconciliations', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key('rec') },
    body: { schoolYearId: YEAR, statementDate, statementBalanceCents },
  });
  assert.equal(response.status, 201);
  return (await response.json()).reconciliation.id;
}

function importFile(call, cookie, reconciliationId, body, idempotencyKey = key('imp'), options = {}) {
  return call(`/api/reconciliations/${reconciliationId}/lines`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': idempotencyKey }, body, ...options,
  });
}

// ---------- parsery (czyste funkcje) ----------

test('CODA fixture: account, balances, movements with bank transaction id and structured communication', () => {
  const statement = parseCoda(CODA_FIXTURE.replace(/\r\n/g, '\n'));
  assert.equal(statement.accountIban, RADA_IBAN);
  assert.equal(statement.openingBalanceCents, 100000);
  assert.equal(statement.closingBalanceCents, 103750);
  assert.deepEqual(statement.movements.map((m) => [m.bookedOn, m.amountCents]),
    [['2026-09-14', 2500], ['2026-09-14', 2500], ['2026-09-20', -1250]]);
  assert.equal(new Set(statement.movements.map((m) => m.transactionId)).size, 3);
  assert.equal(statement.movements[0].reference, '+++090/9337/55493+++');
  // Rachunek kontrahenta z rekordu 23 nie trafia do wyniku.
  assert.doesNotMatch(JSON.stringify(statement), new RegExp(OTHER_IBAN));
});

test('CODA: globalised detail records are not counted twice; a debit balance is negative', () => {
  const text = codaFile({
    openingCents: -500,
    closingCents: 4500,
    movements: [
      { seq: 1, bankRef: 'SYNTGLOB000000000001', cents: 5000, bookedOn: '2026-09-10', communication: 'Zbiorczo' },
      { seq: 1, detail: 1, bankRef: 'SYNTGLOB000000000001', cents: 2500, bookedOn: '2026-09-10', communication: 'Szczegół 1' },
      { seq: 1, detail: 2, bankRef: 'SYNTGLOB000000000001', cents: 2500, bookedOn: '2026-09-10', communication: 'Szczegół 2' },
    ],
  });
  const statement = parseCoda(text);
  assert.equal(statement.openingBalanceCents, -500);
  assert.deepEqual(statement.movements.map((m) => m.amountCents), [5000]);
});

test('CAMT bez AcctSvcrRef: ten sam NtryRef w dwóch wyciągach to dwa różne ruchy (#105)', () => {
  // NtryRef bywa numerem kolejnym w wyciągu — nie może zderzyć się między wyciągami.
  const first = parseCamt053(camtFile({ sequence: '7', movements: [{ ntryRefOnly: '1', cents: 2500, bookedOn: '2026-09-10' }] }));
  const second = parseCamt053(camtFile({ sequence: '8', movements: [{ ntryRefOnly: '1', cents: 2500, bookedOn: '2026-09-11' }] }));
  assert.notEqual(first.movements[0].transactionId, second.movements[0].transactionId);
  // Ten sam wyciąg (to samo Stmt/Id) daje ten sam identyfikator — ponowny import dalej jest wykrywany.
  const again = parseCamt053(camtFile({ sequence: '7', movements: [{ ntryRefOnly: '1', cents: 2500, bookedOn: '2026-09-10' }] }));
  assert.equal(again.movements[0].transactionId, first.movements[0].transactionId);
  // AcctSvcrRef ma pierwszeństwo i nie zależy od wyciągu.
  const a = parseCamt053(camtFile({ sequence: '7', movements: [{ ref: 'BANKREF-1', cents: 2500, bookedOn: '2026-09-10' }] }));
  const b = parseCamt053(camtFile({ sequence: '8', movements: [{ ref: 'BANKREF-1', cents: 2500, bookedOn: '2026-09-10' }] }));
  assert.equal(a.movements[0].transactionId, b.movements[0].transactionId);
});

test('API: kolejny wyciąg CAMT z tym samym NtryRef (bez AcctSvcrRef) importuje ruch, nie pomija go', async () => {
  const { cookies, call } = await setup();
  const september = await draft(call, cookies.treasurer, { statementDate: '2026-09-30', statementBalanceCents: 102500 });
  const first = await importFile(call, cookies.treasurer, september, { camt053: camtFile({
    sequence: '7', closingDate: '2026-09-30', movements: [{ ntryRefOnly: '1', cents: 2500, bookedOn: '2026-09-10' }] }) });
  assert.equal(first.status, 201);
  const october = await draft(call, cookies.treasurer, { statementDate: '2026-10-31', statementBalanceCents: 105000 });
  const second = await importFile(call, cookies.treasurer, october, { camt053: camtFile({
    sequence: '8', openingCents: 102500, openingDate: '2026-10-01', closingDate: '2026-10-31',
    movements: [{ ntryRefOnly: '1', cents: 2500, bookedOn: '2026-10-10' }] }) });
  const body = await second.json();
  assert.equal(second.status, 201, JSON.stringify(body));
  assert.equal(body.import.lineCount, 1);
  assert.equal(body.skippedDuplicateCount, 0);
});

test('CODA and CAMT errors carry only a record number, never file content', () => {
  const broken = CODA_FIXTURE.split('\r\n');
  broken[2] = `${broken[2]}NADMIAR-Rodzina-Testowa`;
  assert.throws(() => parseCoda(broken.join('\n')), (error) => error instanceof StatementFileError
    && error.code === 'invalid_statement_file' && error.record === 3 && !/Rodzina/.test(error.message));
  assert.throws(() => parseCoda('garbage'), (error) => error.code === 'invalid_statement_file' && error.record === 1);
  const doctype = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${CAMT_FIXTURE.replace(/^<\?xml[^>]*>/, '')}`;
  assert.throws(() => parseCamt053(doctype), (error) => error.code === 'invalid_statement_file');
  const noId = camtFile({ movements: [{ ref: null, cents: 100, bookedOn: '2026-09-10' }] });
  assert.throws(() => parseCamt053(noId), (error) => error.code === 'statement_transaction_id_missing' && error.record === 1);
  const usd = CAMT_FIXTURE.replace('<Amt Ccy="EUR">25.00</Amt>', '<Amt Ccy="USD">25.00</Amt>');
  assert.throws(() => parseCamt053(usd), (error) => error.code === 'statement_currency_unsupported');
  const twoStatements = CAMT_FIXTURE.replace('</BkToCstmrStmt>', '<Stmt><Id>X</Id></Stmt></BkToCstmrStmt>');
  assert.throws(() => parseCamt053(twoStatements), (error) => error.code === 'statement_multiple_not_supported');
});

test('CAMT.053 fixture: only booked entries, entities decoded, IBAN checksum validated', () => {
  const statement = parseCamt053(CAMT_FIXTURE);
  assert.equal(statement.accountIban, RADA_IBAN);
  assert.equal(statement.movements.length, 3, 'wpis PDNG jest pominięty');
  assert.equal(statement.movements[1].reference, 'Skladka Rodzina Testowa & klasa 1A');
  assert.equal(normalizeIban('BE68 5390 0754 7035'), null);
  assert.equal(normalizeIban('be68 5390 0754 7034'), RADA_IBAN);
});

// ---------- API ----------

test('CODA import: two equal payments on one day stay two lines; no reference, account or counterparty stored', async () => {
  const { db, cookies, call } = await setup();
  const reconciliationId = await draft(call, cookies.treasurer);
  const response = await importFile(call, cookies.treasurer, reconciliationId, { coda: CODA_FIXTURE });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.import.source, 'coda');
  assert.equal(body.import.lineCount, 3);
  assert.equal(body.skippedDuplicateCount, 0);
  assert.deepEqual(body.warnings, []);
  assert.deepEqual(body.fileBalances, {
    statementNumber: '001', openingBalanceCents: 100000, openingDate: '2026-09-01',
    closingBalanceCents: 103750, closingDate: '2026-09-30',
  });

  const { rows: lines } = await db.query(
    'SELECT amount_cents, bank_transaction_hash, reference_hash FROM bank_statement_lines ORDER BY line_no');
  assert.equal(lines.length, 3);
  assertEvery(lines, (line) => /^[0-9a-f]{64}$/.test(line.bank_transaction_hash));
  assert.equal(new Set(lines.map((line) => line.bank_transaction_hash)).size, 3);
  // Dump tabel uzgodnienia i dziennika: brak rachunków, nazw i tytułów.
  const dump = JSON.stringify([
    (await db.query('SELECT * FROM bank_statement_imports')).rows,
    (await db.query('SELECT * FROM bank_statement_lines')).rows,
    (await db.query('SELECT * FROM audit_events')).rows,
  ]);
  for (const secret of [RADA_IBAN, OTHER_IBAN, '539007547034', 'KONTRAHENT', 'Rodzina', 'RADA TEST', 'SYNTREF']) {
    assert.ok(!dump.includes(secret), `w bazie nie ma: ${secret}`);
  }

  // Dwie wpłaty dwojga opiekunów (dwa gospodarstwa) tego samego dnia i na tę samą kwotę.
  await db.query("INSERT INTO households (id) VALUES ('h-1'), ('h-2') ON CONFLICT DO NOTHING");
  for (const [id, household] of [['p-a', 'h-1'], ['p-b', 'h-2']]) {
    await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method,
      status, created_by, idempotency_key) VALUES ($1, $2, $3, 2500, '2026-09-14', 'bank', 'recorded', 'u-treasurer', $4)`,
    [id, household, YEAR, `pay-key-${id}`]);
  }
  const detail = await (await call(`/api/reconciliations/${reconciliationId}`, { cookie: cookies.treasurer })).json();
  const incoming = detail.lines.filter((line) => line.amountCents === 2500);
  assert.equal(incoming.length, 2);
  for (const [index, paymentEntryId] of ['p-a', 'p-b'].entries()) {
    const match = await call(`/api/reconciliations/${reconciliationId}/matches`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('m') },
      body: { statementLineId: incoming[index].id, paymentEntryId },
    });
    assert.equal(match.status, 201);
  }
});

test('same file again (new key, other reconciliation) is refused; same key replays; overlapping file skips known movements', async () => {
  const { db, cookies, call } = await setup();
  const september = await draft(call, cookies.treasurer);
  const october = await draft(call, cookies.treasurer, { statementDate: '2026-10-31', statementBalanceCents: 104750 });
  const replayKey = key('imp');
  const first = await importFile(call, cookies.treasurer, september, { camt053: CAMT_FIXTURE }, replayKey);
  assert.equal(first.status, 201);
  const firstImport = (await first.json()).import;

  // Ponowienie po zerwaniu połączenia (ten sam klucz) — ta sama paczka.
  const replay = await importFile(call, cookies.treasurer, september, { camt053: CAMT_FIXTURE }, replayKey);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
  assert.equal((await replay.json()).import.id, firstImport.id);

  for (const target of [september, october]) {
    const again = await importFile(call, cookies.treasurer, target, { camt053: CAMT_FIXTURE });
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), {
      error: 'statement_already_imported', importId: firstImport.id, reconciliationId: september,
    });
  }
  // Ten sam plik z innym zakończeniem linii to nadal ten sam plik.
  const crlf = await importFile(call, cookies.treasurer, october, { camt053: CAMT_FIXTURE.replace(/\n/g, '\r\n') });
  assert.equal(crlf.status, 409);

  // Wyciąg październikowy nakłada się okresem: dwa znane ruchy i jeden nowy.
  const overlapping = camtFile({
    sequence: '2', openingCents: 101250, openingDate: '2026-09-15', closingDate: '2026-10-31',
    movements: [
      { ref: 'SYNT-TX-0002', cents: 2500, bookedOn: '2026-09-14', ustrd: 'Skladka' },
      { ref: 'SYNT-TX-0003', cents: -1250, bookedOn: '2026-09-20', ustrd: 'Zakup' },
      { ref: 'SYNT-TX-0005', cents: 1000, bookedOn: '2026-10-05', ustrd: 'Nowa wplata' },
    ],
  });
  const partial = await importFile(call, cookies.treasurer, october, { camt053: overlapping });
  assert.equal(partial.status, 201);
  const partialBody = await partial.json();
  assert.equal(partialBody.import.lineCount, 1);
  assert.equal(partialBody.skippedDuplicateCount, 2);
  assert.deepEqual(partialBody.skippedDuplicates.map((s) => [s.record, s.reconciliationId]), [[1, september], [2, september]]);
  assert.ok(partialBody.warnings.includes('opening_balance_discontinuity'));

  // Plik, którego wszystkie ruchy już są — brak nowej paczki, 200 z listą pominiętych.
  const onlyKnown = camtFile({ sequence: '3', openingCents: 0, movements: [
    { ref: 'SYNT-TX-0005', cents: 1000, bookedOn: '2026-10-05' },
  ] });
  const none = await importFile(call, cookies.treasurer, october, { camt053: onlyKnown });
  assert.equal(none.status, 200);
  const noneBody = await none.json();
  assert.equal(noneBody.import, null);
  assert.equal(noneBody.skippedDuplicateCount, 1);

  const { rows } = await db.query('SELECT count(*)::int AS n FROM bank_statement_lines');
  assert.equal(rows[0].n, 4);
  // Bezpośredni INSERT tego samego ruchu jest odrzucany przez bazę.
  const hash = (await db.query('SELECT bank_transaction_hash FROM bank_statement_lines LIMIT 1')).rows[0].bank_transaction_hash;
  const importId = (await db.query("SELECT id FROM bank_statement_imports WHERE reconciliation_id = $1 LIMIT 1", [october])).rows[0].id;
  await assert.rejects(db.query(`INSERT INTO bank_statement_lines (id, reconciliation_id, import_id, line_no, booked_on,
    amount_cents, bank_transaction_hash, created_by) VALUES ('dup', $1, $2, 99, '2026-10-06', 100, $3, 'u-treasurer')`,
  [october, importId, hash]), /bank_statement_transaction_already_imported/);
});

test('double click: two simultaneous imports of one file — one creates, the other replays or is refused', async () => {
  const { db, cookies, call } = await setup();
  const reconciliationId = await draft(call, cookies.treasurer);
  const sameKey = key('imp');
  const sameKeyResults = await Promise.all([
    importFile(call, cookies.treasurer, reconciliationId, { coda: CODA_FIXTURE }, sameKey),
    importFile(call, cookies.treasurer, reconciliationId, { coda: CODA_FIXTURE }, sameKey),
  ]);
  assert.deepEqual(sameKeyResults.map((r) => r.status).sort(), [200, 201]);
  const other = await draft(call, cookies.treasurer);
  const text = codaFile({ statementNumber: '002', movements: [
    { seq: 1, bankRef: 'SYNTREF0000000000099', cents: 700, bookedOn: '2026-09-25', communication: 'Test' },
  ] });
  const differentKeys = await Promise.all([
    importFile(call, cookies.treasurer, reconciliationId, { coda: text }),
    importFile(call, cookies.treasurer, other, { coda: text }),
  ]);
  assert.deepEqual(differentKeys.map((r) => r.status).sort(), [201, 409]);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM bank_statement_lines');
  assert.equal(rows[0].n, 4);
});

test('account mismatch, missing configuration, line after statement date and confirmed reconciliation', async () => {
  const { cookies, call } = await setup();
  const reconciliationId = await draft(call, cookies.treasurer);
  const foreign = await importFile(call, cookies.treasurer, reconciliationId, { coda: codaFile({
    iban: OTHER_IBAN, movements: [{ seq: 1, bankRef: 'X1', cents: 100, bookedOn: '2026-09-10' }],
  }) });
  assert.equal(foreign.status, 400);
  assert.deepEqual(await foreign.json(), { error: 'statement_account_mismatch' });

  const late = await importFile(call, cookies.treasurer, reconciliationId, { camt053: camtFile({ movements: [
    { ref: 'SYNT-LATE-1', cents: 100, bookedOn: '2026-10-01' },
  ] }) });
  assert.equal(late.status, 400);
  assert.equal((await late.json()).error, 'statement_line_after_statement_date');

  const invalid = await importFile(call, cookies.treasurer, reconciliationId, { coda: 'Rodzina Testowa' });
  assert.equal(invalid.status, 400);
  const invalidText = await invalid.text();
  assert.deepEqual(JSON.parse(invalidText), { error: 'invalid_statement_file', record: 1 });

  const two = await importFile(call, cookies.treasurer, reconciliationId, { coda: CODA_FIXTURE, lines: [] });
  assert.equal(two.status, 400);

  // Uzgodnienie zatwierdzone: import odrzucony.
  const confirmed = await draft(call, cookies.treasurer, { statementBalanceCents: 0 });
  const confirm = await call(`/api/reconciliations/${confirmed}/confirm`, {
    method: 'POST', cookie: cookies.board, body: { confirmationNote: 'Różnica syntetyczna do testu' },
  });
  assert.equal(confirm.status, 200);
  const afterConfirm = await importFile(call, cookies.treasurer, confirmed, { coda: CODA_FIXTURE });
  assert.equal(afterConfirm.status, 409);
  assert.equal((await afterConfirm.json()).error, 'reconciliation_confirmed');
});

test('file import is disabled without the HMAC key and approved account; manual lines still work', async () => {
  const unconfigured = await setup({});
  const otherId = await draft(unconfigured.call, unconfigured.cookies.treasurer);
  const disabled = await importFile(unconfigured.call, unconfigured.cookies.treasurer, otherId, { coda: CODA_FIXTURE });
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).error, 'bank_import_not_configured');
  // Import ręczny i CSV działają bez konfiguracji (bez identyfikatora transakcji).
  const manual = await importFile(unconfigured.call, unconfigured.cookies.treasurer, otherId,
    { lines: [{ bookedOn: '2026-09-10', amountCents: 100 }] });
  assert.equal(manual.status, 201);

});

test('continuity warnings: closing balance inconsistent with movements, statement balance differs', async () => {
  const { cookies, call } = await setup();
  const reconciliationId = await draft(call, cookies.treasurer, { statementBalanceCents: 1 });
  const response = await importFile(call, cookies.treasurer, reconciliationId, { coda: codaFile({
    closingCents: 999999, movements: [{ seq: 1, bankRef: 'SYNTW1', cents: 100, bookedOn: '2026-09-10' }],
  }) });
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).warnings, ['closing_balance_mismatch', 'statement_balance_differs']);
});

test('file import refused for representative, audit, principal, missing MFA and foreign Origin', async () => {
  const { db, cookies, call } = await setup();
  const reconciliationId = await draft(call, cookies.treasurer);
  for (const cookie of [cookies.rep, cookies.audit, cookies.principal, cookies.treasurerNoMfa]) {
    const denied = await importFile(call, cookie, reconciliationId, { coda: CODA_FIXTURE });
    assert.equal(denied.status, 403);
  }
  const crossOrigin = await importFile(call, cookies.treasurer, reconciliationId, { coda: CODA_FIXTURE }, key('imp'),
    { origin: 'https://evil.invalid' });
  assert.equal(crossOrigin.status, 403);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM bank_statement_imports');
  assert.equal(rows[0].n, 0);
});
