// Eksport roczny w wersji 2 (#202): gospodarstwa i ich historia, uzgodnienia,
// zamknięcie roku; odtworzenie bez utraty danych pochodnych triggerów;
// zgodność z paczką wersji 1. PGlite, wyłącznie dane syntetyczne (.invalid).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import {
  buildYearlyExport, canonicalJson, EXPORT_EXCLUDED_TABLES, EXPORT_FORMAT_VERSION, EXPORT_TABLES, restoreBundle,
  sha256Hex, TABLES_ADDED_IN_V2, verifyBundle,
} from '../src/pg/export.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-2026';
const NEXT = 'y-2027';

let source;
let bundle;
let keySeq = 0;
const key = (prefix) => `${prefix}-${String(++keySeq).padStart(6, '0')}`;

async function call(db, method, path, cookie, body, idempotencyKey) {
  const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
  const response = await handlePgRequest(request(path, { method, cookie, body, headers }), { db });
  const text = await response.text();
  return { status: response.status, body: text && response.headers.get('Content-Type')?.includes('json') ? JSON.parse(text) : text };
}

async function seedSource(db) {
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-2b', schoolYearId: YEAR, name: '2B' });
  await seedUser(db, { userId: 'u-seed' });
  // Rodzeństwo s-1 (1A) i s-2 (2B) w h-1; s-3 w opiece dzielonej: główne h-2, drugie h-3.
  await db.query("INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3')");
  await db.query(`INSERT INTO students (id, household_id, first_name, last_name) VALUES
    ('s-1', 'h-1', 'Uczeń', 'Pierwszy'), ('s-2', 'h-1', 'Uczennica', 'Pierwsza'), ('s-3', 'h-2', 'Uczeń', 'Trzeci')`);
  await db.query(`INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
    ('g-1', 'h-1', 'Opiekun', 'Jeden', 'g1@example.invalid', true),
    ('g-2', 'h-2', 'Opiekunka', 'Dwa', 'g2@example.invalid', true),
    ('g-3', 'h-3', 'Opiekun', 'Trzy', 'g3@example.invalid', true)`);
  await db.query(`INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
    ('s-1', 'g-1', true, true), ('s-2', 'g-1', true, true), ('s-3', 'g-2', true, true), ('s-3', 'g-3', true, false)`);
  await db.query(`INSERT INTO student_households (id, student_id, household_id, is_primary, source)
    VALUES ('sh-s3-second', 's-3', 'h-3', false, 'api')`);
  await db.query(`INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
    ('e-1', 's-1', 'c-1a', '${YEAR}'), ('e-2', 's-2', 'c-2b', '${YEAR}'), ('e-3', 's-3', 'c-1a', '${YEAR}')`);
  // Historia kontaktu: zmiana w roku (w paczce, bez adresów) i zmiana sprzed roku (poza paczką).
  await db.query(`INSERT INTO guardian_contact_changes (id, guardian_id, previous_email, new_email, previous_contact_allowed,
      new_contact_allowed, reason, source, changed_at) VALUES
    ('gcc-in', 'g-2', 'stary@example.invalid', 'g2@example.invalid', true, true, 'Zmiana adresu', 'direct', '2026-10-05T10:00:00Z'),
    ('gcc-old', 'g-2', 'dawny@example.invalid', 'stary@example.invalid', true, true, 'Dawna zmiana', 'direct', '2025-10-05T10:00:00Z')`);
  // Historia relacji opiekun–dziecko (0026): zmiana w roku w paczce (bez powodu), sprzed roku poza paczką.
  await db.query(`INSERT INTO student_guardian_changes (id, student_id, guardian_id, previous_contact_allowed, new_contact_allowed,
      previous_is_primary_contact, new_is_primary_contact, reason, source, changed_at) VALUES
    ('sgc-in', 's-3', 'g-3', false, true, false, false, 'Zgoda opiekuna', 'direct', '2026-10-06T10:00:00Z'),
    ('sgc-old', 's-3', 'g-3', true, false, false, false, 'Dawna zmiana', 'direct', '2025-10-06T10:00:00Z')`);

  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-in', '${YEAR}', 'income', 'Dobrowolne wpłaty', 'u-seed')`);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key) VALUES
    ('le-1', '${YEAR}', 'income', 20000, 'cat-in', 'Wpływ przelewem', '2026-09-20', 'bank', 'u-seed', 'ledger-key-0001'),
    ('le-2', '${YEAR}', 'income', 3000, 'cat-in', 'Wpływ gotówką', '2026-09-21', 'cash', 'u-seed', 'ledger-key-0002')`);
  await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
    VALUES ('p-1', 'h-1', '${YEAR}', 5000, '2026-09-15', 'bank', 'recorded', 'u-seed', 'payment-key-0001')`);

  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    boardA: await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
  };
  // Przeniesienie gotówki na rachunek (0028).
  const transfer = await call(db, 'POST', '/api/ledger/transfers', cookies.treasurer, {
    schoolYearId: YEAR, direction: 'cash_to_bank', amountCents: 3000, transferredOn: '2026-09-25', description: 'Wpłata gotówki na rachunek',
  }, key('tr'));
  assert.equal(transfer.status, 201, JSON.stringify(transfer.body));

  // Uzgodnienie: pozycje, powiązanie cofnięte z powodem, ponowne powiązanie, zatwierdzenie przez drugą osobę.
  const created = await call(db, 'POST', '/api/reconciliations', cookies.treasurer,
    { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 23000 }, key('rec'));
  assert.equal(created.status, 201);
  const recId = created.body.reconciliation.id;
  const lines = await call(db, 'POST', `/api/reconciliations/${recId}/lines`, cookies.treasurer,
    { lines: [{ bookedOn: '2026-09-20', amountCents: 20000, reference: 'Tytuł syntetyczny' }] }, key('lines'));
  assert.equal(lines.status, 201);
  const detail = await call(db, 'GET', `/api/reconciliations/${recId}`, cookies.treasurer);
  const lineId = detail.body.lines[0].id;
  const match = await call(db, 'POST', `/api/reconciliations/${recId}/matches`, cookies.treasurer,
    { statementLineId: lineId, ledgerEntryId: 'le-1' }, key('match'));
  assert.equal(match.status, 201);
  const revoked = await call(db, 'POST', `/api/reconciliations/${recId}/matches/${match.body.match.id}/revocation`, cookies.treasurer,
    { reason: 'Powiązanie do sprawdzenia' });
  assert.equal(revoked.status, 200);
  assert.equal((await call(db, 'POST', `/api/reconciliations/${recId}/matches`, cookies.treasurer,
    { statementLineId: lineId, ledgerEntryId: 'le-1' }, key('match'))).status, 201);
  const confirmed = await call(db, 'POST', `/api/reconciliations/${recId}/confirm`, cookies.boardA, {});
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  // Zamknięcie roku (cztery oczy).
  assert.equal((await call(db, 'POST', `/api/year-close/${YEAR}/start`, cookies.boardA, { nextSchoolYearId: NEXT })).status, 201);
  for (const item of CHECKLIST_ITEMS) {
    assert.equal((await call(db, 'POST', `/api/year-close/${YEAR}/checklist/${item}`, cookies.boardA, { note: `Potwierdzenie ${item}` })).status, 201);
  }
  assert.equal((await call(db, 'POST', `/api/year-close/${YEAR}/close`, cookies.boardB, {})).status, 200);
  return { reconciliationId: recId };
}

// Odczyty porównywane przed eksportem i po odtworzeniu (bez generatedAt).
async function snapshotViews(db) {
  const cookie = await seedUserSession(db, { userId: 'u-reader', roles: [{ role: 'board' }], mfa: true });
  const get = async (path) => {
    const result = await call(db, 'GET', path, cookie);
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const report = await get(`/api/reports/audit?schoolYearId=${YEAR}`);
  delete report.report.generatedAt;
  return {
    classA: await get('/api/classes/c-1a/students'),
    classB: await get('/api/classes/c-2b/students'),
    h1: await get('/api/households/h-1'),
    h2: await get('/api/households/h-2'),
    h3: await get('/api/households/h-3'),
    report,
    yearClose: await get(`/api/year-close/${YEAR}`),
  };
}

let sourceViews;
before(async () => {
  source = await createTestDb();
  await seedSource(source);
  sourceViews = await snapshotViews(source);
  // Czytelnik z paczki nie może trafić do porównania (users i sesje są poza paczką).
  ({ bundle } = await source.transaction((tx) => buildYearlyExport(tx, YEAR)));
});
after(async () => {
  await source?.close();
});

const linesOf = (b, table) => (b.files[`${table}.jsonl`] ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));

function rehash(b) {
  for (const entry of b.manifest.files) {
    const content = b.files[entry.path];
    entry.sha256 = sha256Hex(content);
    const records = linesOf(b, entry.table);
    entry.rows = records.length;
    const sums = {};
    for (const column of entry.columns.filter((name) => name.endsWith('_cents'))) {
      sums[column] = records.reduce((total, record) => total + (record[column] ?? 0), 0);
    }
    entry.sums = sums;
  }
  b.manifestSha256 = sha256Hex(canonicalJson(b.manifest));
  return b;
}

test('kompletność: każda tabela bazowa jest w eksporcie albo na liście wyjątków z uzasadnieniem', async () => {
  const { rows } = await source.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
  );
  const exported = new Set(EXPORT_TABLES.map((spec) => spec.table));
  for (const { table_name: table } of rows) {
    if (table === 'schema_migrations') continue;
    const excluded = Object.hasOwn(EXPORT_EXCLUDED_TABLES, table);
    assert.ok(exported.has(table) || excluded,
      `Tabela ${table} nie jest w EXPORT_TABLES ani w EXPORT_EXCLUDED_TABLES (src/pg/export.js) — zdecyduj i opisz w docs/EXPORT.md`);
    assert.ok(!(exported.has(table) && excluded), `${table}: jednocześnie eksportowana i wykluczona`);
    if (excluded) assert.ok(EXPORT_EXCLUDED_TABLES[table].length >= 10, `${table}: brak uzasadnienia`);
  }
  const names = new Set(rows.map((row) => row.table_name));
  for (const table of Object.keys(EXPORT_EXCLUDED_TABLES)) assert.ok(names.has(table), `wyjątek dla nieistniejącej tabeli ${table}`);
});

test('paczka v2 zawiera gospodarstwa, historię, uzgodnienia i zamknięcie; bez e-maili z historii i bez sekretów', async () => {
  assert.equal(EXPORT_FORMAT_VERSION, 2);
  assert.equal(bundle.formatVersion, 2);
  const report = verifyBundle(bundle);
  assert.deepEqual(report.warnings, []);
  // Opieka dzielona: s-3 ma gospodarstwo główne i drugie.
  const sh = linesOf(bundle, 'student_households');
  assert.deepEqual(sh.filter((row) => row.student_id === 's-3').map((row) => [row.household_id, row.is_primary]).sort(),
    [['h-2', true], ['h-3', false]]);
  assert.equal(sh.filter((row) => row.household_id === 'h-1').length, 2, 'rodzeństwo w jednym gospodarstwie');
  assert.equal(linesOf(bundle, 'guardian_households').length, 3);
  assert.deepEqual(linesOf(bundle, 'households').map((row) => row.id), ['h-1', 'h-2', 'h-3']);
  assert.equal(linesOf(bundle, 'enrollment_history').length, 3);
  const contact = linesOf(bundle, 'guardian_contact_changes');
  assert.deepEqual(contact.map((row) => row.id), ['gcc-in']);
  assert.deepEqual(Object.keys(contact[0]).sort(),
    ['changed_at', 'changed_by', 'guardian_id', 'id', 'new_contact_allowed', 'previous_contact_allowed', 'source']);
  const relation = linesOf(bundle, 'student_guardian_changes');
  assert.deepEqual(relation.map((row) => row.id), ['sgc-in']);
  assert.equal(relation[0].reason, undefined, 'bez treści powodu (D-03)');
  const matches = linesOf(bundle, 'bank_reconciliation_matches');
  assert.equal(matches.length, 2);
  assert.ok(matches.some((row) => row.revoke_reason === 'Powiązanie do sprawdzenia'), 'cofnięcie z powodem w paczce');
  assert.equal(linesOf(bundle, 'bank_reconciliations')[0].status, 'confirmed');
  assert.equal(linesOf(bundle, 'bank_statement_lines').length, 1);
  assert.equal(linesOf(bundle, 'school_year_closures')[0].status, 'closed');
  assert.equal(linesOf(bundle, 'school_year_closure_checklist').length, 6);
  assert.equal(linesOf(bundle, 'ledger_transfers').length, 1);
  // Adresy e-mail tylko w tabeli opiekunów (D-03); żadnych z historii, kampanii ani sekretów MFA.
  for (const [path, content] of Object.entries(bundle.files)) {
    if (path === 'guardians.jsonl') continue;
    assert.doesNotMatch(content, /@example\.invalid/, path);
  }
  for (const table of ['users', 'sessions', 'user_mfa_factors', 'mfa_recovery_codes', 'user_passwords', 'password_reset_tokens',
    'email_campaign_recipients', 'email_outbox']) {
    assert.equal(bundle.files[`${table}.jsonl`], undefined, table);
  }
  // Podwójny eksport daje ten sam skrót (determinizm dla nowych tabel).
  const again = await source.transaction((tx) => buildYearlyExport(tx, YEAR));
  assert.equal(again.manifestSha256, bundle.manifestSha256);
});

test('odtworzenie v2: lista klasy, karta gospodarstwa, raport KR i stan zamknięcia jak przed eksportem', async () => {
  const target = await createTestDb();
  try {
    const report = await restoreBundle(target, bundle);
    assert.equal(report.restored, true);
    assert.equal(report.countsMatch, true);
    assert.deepEqual(report.warnings, []);
    const restoredViews = await snapshotViews(target);
    assert.deepEqual(restoredViews, sourceViews);
    // Konkretnie: gospodarstwa uczniów, uzgodnienie zatwierdzone, rok zamknięty.
    const s3 = restoredViews.classA.students?.find((student) => student.id === 's-3') ?? null;
    assert.ok(s3, JSON.stringify(restoredViews.classA).slice(0, 300));
    assert.equal(s3.households.length, 2);
    assert.equal(restoredViews.report.report.reconciliations.confirmedCount, 1);
    assert.equal(restoredViews.yearClose.status, 'closed');
    // Triggery działają po odtworzeniu: zamrożenie roku.
    await assert.rejects(target.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
      VALUES ('cat-late', '${YEAR}', 'income', 'Spóźniona', 'u-seed')`), /school_year_closed/);
  } finally {
    await target.close();
  }
});

test('odtworzenie odrzuca paczkę bez danych pochodnych triggerów; baza docelowa zostaje pusta', async () => {
  const broken = rehash(JSON.parse(JSON.stringify(bundle)));
  broken.files['student_households.jsonl'] = '';
  rehash(broken);
  assert.doesNotThrow(() => verifyBundle(broken));
  const target = await createTestDb();
  try {
    await assert.rejects(restoreBundle(target, broken), { code: 'restore_verification_failed:derived:student_households' });
    assert.equal((await target.query('SELECT count(*)::int AS n FROM students')).rows[0].n, 0);
  } finally {
    await target.close();
  }
});

function asV1(v2) {
  const v1 = JSON.parse(JSON.stringify(v2));
  v1.formatVersion = 1;
  v1.manifest.formatVersion = 1;
  v1.manifest.files = v1.manifest.files.filter((entry) => !TABLES_ADDED_IN_V2.includes(entry.table));
  for (const table of TABLES_ADDED_IN_V2) delete v1.files[`${table}.jsonl`];
  v1.manifestSha256 = sha256Hex(canonicalJson(v1.manifest));
  return v1;
}

test('zgodność: paczka v1 jest przyjmowana z ostrzeżeniem, gospodarstwa odtwarzane jak backfill 0014', async () => {
  const v1 = asV1(bundle);
  const verified = verifyBundle(v1);
  assert.deepEqual(verified.warnings, ['bundle_incomplete']);
  assert.deepEqual(verified.missingTables, [...TABLES_ADDED_IN_V2]);
  // Paczka v1 nie może zawierać tabel wersji 2.
  const mixed = JSON.parse(JSON.stringify(v1));
  const extra = bundle.manifest.files.find((entry) => entry.table === 'school_year_closures');
  mixed.manifest.files.push(extra);
  mixed.manifest.files.sort((a, b) => EXPORT_TABLES.findIndex((s) => s.table === a.table) - EXPORT_TABLES.findIndex((s) => s.table === b.table));
  mixed.files[extra.path] = bundle.files[extra.path];
  mixed.manifestSha256 = sha256Hex(canonicalJson(mixed.manifest));
  assert.throws(() => verifyBundle(mixed), { code: 'table_not_in_format_version:school_year_closures.jsonl' });

  const target = await createTestDb();
  try {
    const report = await restoreBundle(target, v1);
    assert.deepEqual(report.warnings, ['bundle_incomplete', 'households_backfilled_from_v1']);
    assert.deepEqual(report.backfilled, { studentHouseholds: 3, guardianHouseholds: 3 });
    const cookie = await seedUserSession(target, { userId: 'u-reader', roles: [{ role: 'board' }], mfa: true });
    const card = await call(target, 'GET', '/api/households/h-1', cookie);
    assert.equal(card.status, 200);
    const klass = await call(target, 'GET', '/api/classes/c-1a/students', cookie);
    assert.equal(klass.status, 200);
    // Paczka v1 nie niesie drugiego gospodarstwa ani uzgodnień — stąd ostrzeżenie.
    const s3 = klass.body.students.find((student) => student.id === 's-3');
    assert.equal(s3.households.length, 1);
  } finally {
    await target.close();
  }
});

test('nieznana wersja formatu jest odrzucana', () => {
  const future = JSON.parse(JSON.stringify(bundle));
  future.formatVersion = 3;
  assert.throws(() => verifyBundle(future), { code: 'unsupported_format_version' });
});
