// Import CSV/XLSX do PostgreSQL (issue #36). Wyłącznie dane syntetyczne,
// domeny .invalid; nie są to dane uczniów ani rodzin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgHandler, handlePgRequest, ROUTES } from '../src/pg/app.js';
import { assertNoPii } from '../src/pg/audit.js';
import { guessMapping, parseCsv, toServerPayload, validateRows } from '../import/core.js';
import { MESSAGES, splitGuardianName } from '../src/pg/routes/import.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-2026';
const HEADER = 'ID ucznia;Imię ucznia;Nazwisko ucznia;Klasa;ID rodziny;Opiekun 1;E-mail opiekuna 1;Opiekun 2;E-mail opiekuna 2';

// #145 (D-06): commit wymaga opublikowanej informacji o przetwarzaniu danych.
// Wstawiana bezpośrednio (poza API) jako naturalny stan tła dla testów, które
// nie dotyczą tej bramki; test samej bramki (poniżej) używa świeżej bazy bez niej.
async function seedPublishedPrivacyNotice(db, { id = 'pn-test', createdBy = 'u-privacy-author' } = {}) {
  await db.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [createdBy, `${createdBy}@example.invalid`, 'Test Autor'],
  );
  await db.query(
    `INSERT INTO privacy_notices (id, body_text, content_hash, decision_ref, status, created_by, approved_by, approved_at, published_by, published_at)
     VALUES ($1, 'Testowa informacja o przetwarzaniu danych.', repeat('a', 64), 'D-06/test', 'published',
             $2, 'u-admin', now(), 'u-admin', now())`,
    [id, createdBy],
  );
  return id;
}

async function withDb(fn) {
  const db = await createTestDb();
  try {
    await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
    await seedClass(db, { id: 'c-2b', schoolYearId: YEAR, name: '2B' });
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    await seedPublishedPrivacyNotice(db);
    return await fn(db, { db }, admin);
  } finally { await db.close(); }
}

// To samo, co robi przeglądarka: parseCsv → guessMapping → validateRows → toServerPayload.
function payloadFromCsv(csv, options = {}, schoolYearId = YEAR) {
  const matrix = parseCsv(csv);
  const result = validateRows(matrix, guessMapping(matrix[0]));
  return toServerPayload(result, schoolYearId, options);
}
const csvOf = (...lines) => `${HEADER}\n${lines.join('\n')}\n`;

function post(path, cookie, body, { key, origin, headers = {} } = {}) {
  return request(path, { method: 'POST', cookie, body, origin, headers: key ? { ...headers, 'Idempotency-Key': key } : headers });
}

async function preview(env, cookie, payload) {
  const response = await handlePgRequest(post('/api/import/preview', cookie, payload), env);
  return { status: response.status, body: await response.json() };
}

async function commitWith(handler, env, cookie, payload, previewBody, key = 'key-00000001', extra = {}) {
  const body = { ...payload, fingerprint: previewBody.fingerprint, planDigest: previewBody.planDigest, ...extra };
  const response = await handler(post('/api/import/commit', cookie, body, { key }), env);
  return { status: response.status, body: await response.json() };
}
const commit = (env, cookie, payload, previewBody, key, extra) => commitWith(handlePgRequest, env, cookie, payload, previewBody, key, extra);

async function previewAndCommit(env, cookie, payload, key) {
  const p = await preview(env, cookie, payload);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return { ...(await commit(env, cookie, payload, p.body, key)), preview: p.body };
}

async function tableCounts(db) {
  const { rows } = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
  const counts = {};
  for (const { table_name: table } of rows) {
    counts[table] = (await db.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n;
  }
  return counts;
}

const count = async (db, table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

const BASIC = csvOf(
  'S1;Ala;Testowa;1A;R1;Anna Testowa;anna@example.invalid;Jan Testowy;jan@example.invalid',
  'S2;Ola;Testowa;2B;R1;Anna Testowa;anna@example.invalid;Jan Testowy;jan@example.invalid',
  'S3;Piotr;Próbny;1A;R2;Ewa Próbna;ewa@example.invalid;;',
);

test('preview validates, reports a plan and writes nothing to any table', async () => withDb(async (db, env, admin) => {
  const before = await tableCounts(db);
  const { status, body } = await preview(env, admin, payloadFromCsv(BASIC));
  assert.equal(status, 200);
  assert.equal(body.written, false);
  assert.equal(body.commitAllowed, true);
  assert.match(body.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(body.counts, {
    rowsTotal: 3, rowsAdded: 3, rowsUpdated: 0, rowsUnchanged: 0, rowsConflict: 0, rowsSkipped: 0,
    householdsCreated: 2, guardiansCreated: 3, studentsCreated: 3, enrollmentsCreated: 3, linksCreated: 5,
  });
  assert.deepEqual(await tableCounts(db), before);
  // Raport nie zwraca imion, nazwisk ani adresów.
  const text = JSON.stringify(body);
  for (const fragment of ['Ala', 'Testowa', 'anna@', 'S1', 'R1']) assert.equal(text.includes(fragment), false, fragment);
}));

test('commit is atomic, siblings share guardians and a repeated commit does not duplicate', async () => withDb(async (db, env, admin) => {
  const payload = payloadFromCsv(BASIC);
  const first = await previewAndCommit(env, admin, payload, 'key-00000001');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  assert.equal(await count(db, 'students'), 3);
  assert.equal(await count(db, 'households'), 2);
  assert.equal(await count(db, 'guardians'), 3);
  assert.equal(await count(db, 'student_guardians'), 5);
  assert.equal(await count(db, 'enrollments'), 3);
  const siblings = await db.query("SELECT count(DISTINCT household_id)::int AS n FROM students WHERE source_ref IN ('S1','S2')");
  assert.equal(siblings.rows[0].n, 1);
  const contact = await db.query('SELECT bool_or(contact_allowed) AS any FROM student_guardians');
  assert.equal(contact.rows[0].any, false);

  const snapshot = await tableCounts(db);
  // Podwójne kliknięcie (ten sam klucz) i ponowny import tego samego pliku (nowy klucz, stary podgląd).
  const again = await commit(env, admin, payload, first.preview, 'key-00000001');
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.batchId, first.body.batchId);
  assert.deepEqual(again.body.counts, first.body.counts);
  const secondPreview = await preview(env, admin, payload);
  assert.equal(secondPreview.body.counts.rowsUnchanged, 3);
  const otherKey = await commit(env, admin, payload, secondPreview.body, 'key-00000002');
  assert.equal(otherKey.status, 200);
  assert.equal(otherKey.body.batchId, first.body.batchId);
  assert.deepEqual(await tableCounts(db), snapshot);
}));

test('failure in the middle of a commit rolls back everything', async () => withDb(async (db, env, admin) => {
  const payload = payloadFromCsv(BASIC);
  const p = await preview(env, admin, payload);
  const before = await tableCounts(db);
  // Wstrzyknięty błąd po zapisaniu partii, rodzin, opiekunów, uczniów i zapisów do klas.
  const failingDb = {
    query: (...args) => db.query(...args),
    transaction: (fn) => db.transaction((tx) => fn({
      query(sql, params) {
        if (/^\s*INSERT INTO student_guardians/.test(sql)) throw new Error('injected_failure');
        return tx.query(sql, params);
      },
    })),
  };
  const response = await handlePgRequest(post('/api/import/commit', admin, { ...payload, fingerprint: p.body.fingerprint, planDigest: p.body.planDigest }, { key: 'key-00000003' }), { db: failingDb });
  assert.equal(response.status, 503);
  assert.deepEqual(await tableCounts(db), before);
  // Po usunięciu awarii ten sam klucz działa normalnie.
  const retry = await commit(env, admin, payload, p.body, 'key-00000003');
  assert.equal(retry.status, 201);
}));

test('1200 synthetic rows from a BOM CSV: siblings, two guardians, correct totals', async () => withDb(async (db, env, admin) => {
  const lines = [];
  for (let family = 0; family < 600; family++) {
    for (const child of [0, 1]) {
      lines.push([`S${family}-${child}`, `Dziecko${child}`, `Rodzina${family}`, child ? '2B' : '1A', `R${family}`,
        `Mama Rodzina${family}`, `m${family}@example.invalid`, `Tata Rodzina${family}`, `t${family}@example.invalid`].join(';'));
    }
  }
  const csv = `﻿${HEADER}\r\n${lines.join('\r\n')}\r\n`;
  const payload = payloadFromCsv(csv);
  assert.equal(payload.rows.length, 1200);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 1024 * 1024);
  const result = await previewAndCommit(env, admin, payload, 'key-bulk-0001');
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.counts.rowsAdded, 1200);
  assert.equal(await count(db, 'students'), 1200);
  assert.equal(await count(db, 'households'), 600);
  assert.equal(await count(db, 'guardians'), 1200);
  assert.equal(await count(db, 'student_guardians'), 2400);
  const header = await db.query("SELECT count(*)::int AS n FROM students WHERE source_ref LIKE '﻿%'");
  assert.equal(header.rows[0].n, 0);
}));

test('same surname in different classes is not merged; rows without household ID need explicit consent', async () => withDb(async (db, env, admin) => {
  const csv = csvOf(
    'S10;Adam;Wspólny;1A;;Maria Wspólna;wspolny@example.invalid;;',
    'S11;Beata;Wspólny;2B;;Maria Wspólna;wspolny@example.invalid;;',
  );
  const strict = await preview(env, admin, payloadFromCsv(csv));
  assert.equal(strict.body.counts.rowsConflict, 2);
  assert.equal(strict.body.commitAllowed, false);
  assert.ok(strict.body.rows.every((row) => row.messages[0] === MESSAGES.missingHouseholdId));
  const refused = await commit(env, admin, payloadFromCsv(csv), strict.body, 'key-strict-01');
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error, 'import_has_conflicts');
  assert.equal(await count(db, 'import_batches'), 0);

  const payload = payloadFromCsv(csv, { allowNewHouseholds: true });
  const p = await preview(env, admin, payload);
  assert.equal(p.body.counts.rowsAdded, 2);
  assert.ok(p.body.warnings.some((w) => w.row === 3 && w.message === MESSAGES.emailElsewhere));
  const done = await commit(env, admin, payload, p.body, 'key-allow-01');
  assert.equal(done.status, 201);
  assert.equal(await count(db, 'households'), 2);
  assert.equal(await count(db, 'guardians'), 2);
  const distinct = await db.query("SELECT count(DISTINCT household_id)::int AS n FROM students WHERE last_name = 'Wspólny'");
  assert.equal(distinct.rows[0].n, 2);
}));

test('rows without student ID are conflicts requiring manual linking', async () => withDb(async (db, env, admin) => {
  const p = await preview(env, admin, payloadFromCsv(csvOf(';Ala;Bezid;1A;R9;;;;')));
  assert.equal(p.body.counts.rowsConflict, 1);
  assert.equal(p.body.rows[0].messages[0], MESSAGES.missingStudentId);
}));

test('existing students: new guardian is an update, changed household, class or name is a conflict', async () => withDb(async (db, env, admin) => {
  assert.equal((await previewAndCommit(env, admin, payloadFromCsv(BASIC), 'key-base-0001')).status, 201);
  const csv = csvOf(
    'S1;Ala;Testowa;1A;R1;Anna Testowa;anna@example.invalid;Nowy Opiekun;nowy@example.invalid',
    'S2;Ola;Testowa;2B;R7;Anna Testowa;anna@example.invalid;;',
    'S3;Piotr;Próbny;2B;R2;Ewa Próbna;ewa@example.invalid;;',
    'S4;Zosia;Testowa;1A;R1;Anna Testowa;anna@example.invalid;;',
    'S1;Ala;Inna;1A;R1;;;;',
  );
  const p = await preview(env, admin, payloadFromCsv(csv));
  const byRow = Object.fromEntries(p.body.rows.map((row) => [row.row, row]));
  assert.equal(byRow[2].action, 'update');
  assert.deepEqual(byRow[2].changes, ['guardian', 'link']);
  assert.equal(byRow[3].messages[0], MESSAGES.householdMismatch);
  assert.equal(byRow[4].messages[0], MESSAGES.classMismatch);
  assert.equal(byRow[5].action, 'add'); // nowe rodzeństwo w istniejącej rodzinie R1
  assert.equal(byRow[6].action, 'skipped'); // powtórzone ID ucznia w pliku
  const done = await commit(env, admin, payloadFromCsv(csv, { skipConflicts: true }), p.body, 'key-upd-00001');
  assert.equal(done.status, 201, JSON.stringify(done.body));
  const r1 = await db.query("SELECT count(*)::int AS n FROM students s JOIN households h ON h.id = s.household_id WHERE h.source_ref = 'R1'");
  assert.equal(r1.rows[0].n, 3);
  const anna = await db.query("SELECT count(*)::int AS n FROM guardians WHERE email = 'anna@example.invalid'");
  assert.equal(anna.rows[0].n, 1);
  const s3 = await db.query("SELECT c.name FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN students s ON s.id = e.student_id WHERE s.source_ref = 'S3'");
  assert.equal(s3.rows[0].name, '1A');
}));

test('new school year enrolment for an existing student is an update', async () => withDb(async (db, env, admin) => {
  await seedClass(db, { id: 'c-2a-27', schoolYearId: 'y-2027', name: '2A' });
  assert.equal((await previewAndCommit(env, admin, payloadFromCsv(csvOf('S1;Ala;Testowa;1A;R1;;;;')), 'key-y1-00001')).status, 201);
  const payload = payloadFromCsv(csvOf('S1;Ala;Testowa;2A;R1;;;;'), {}, 'y-2027');
  const p = await preview(env, admin, payload);
  assert.equal(p.body.rows[0].action, 'update');
  assert.deepEqual(p.body.rows[0].changes, ['enrollment']);
  assert.equal((await commit(env, admin, payload, p.body, 'key-y2-00001')).status, 201);
  assert.equal(await count(db, 'students'), 1);
  assert.equal(await count(db, 'enrollments'), 2);
}));

test('invalid class and unknown year are rejected by the server; invalid e-mail only degrades to a warning (#207)', async () => withDb(async (db, env, admin) => {
  // #207 (krok 3a): błędny e-mail JEDNEGO opiekuna nie wyrzuca całego wiersza z importu —
  // uczeń i opiekun trafiają do bazy z email = NULL, a wiersz dostaje ostrzeżenie do
  // poprawienia i ponownego wczytania. Skipowany jest tylko wiersz z nieznaną klasą.
  const csv = csvOf('S1;Ala;Testowa;9Z;R1;;;;', 'S2;Ola;Testowa;1A;R1;Anna Testowa;zly-adres;;');
  // Ostrzeżenie o błędnym adresie powstaje w przeglądarce (validateRows), zanim
  // dane trafią do serwera — payloadFromCsv wysyła już oczyszczony wiersz
  // (email = ''), więc serwer, uruchamiając tę samą walidację ponownie na już
  // wyczyszczonym wejściu, tego ostrzeżenia nie powtarza (nie ma już czego flagować).
  const clientResult = validateRows(parseCsv(csv), guessMapping(parseCsv(csv)[0]));
  assert.match(clientResult.warnings.map((w) => w.message).join(' '), /Niepoprawny adres e-mail/);
  const payload = toServerPayload(clientResult, YEAR, { skipConflicts: true });
  const p = await preview(env, admin, payload);
  assert.equal(p.body.counts.rowsSkipped, 1);
  assert.equal(p.body.counts.rowsAdded, 1);
  assert.match(p.body.rows[0].messages.join(' '), /Nieznana klasa/);
  assert.equal(p.body.rows[1].action, 'add');
  assert.equal((await commit(env, admin, payload, p.body, 'key-bad-email-0001')).status, 201);
  const g = await db.query("SELECT email FROM guardians WHERE first_name = 'Anna'");
  assert.equal(g.rows[0].email, null);
  const unknownYear = await preview(env, admin, payloadFromCsv(BASIC, {}, 'y-1999'));
  assert.equal(unknownYear.status, 422);
  assert.equal(unknownYear.body.error, 'unknown_school_year');
  // Klient nie może pominąć walidacji serwera, podsyłając poprawiony wynik.
  const tampered = payloadFromCsv(BASIC);
  tampered.rows[0][3] = '9Z';
  const t = await preview(env, admin, tampered);
  assert.equal(t.body.counts.rowsSkipped, 1);
  for (const bad of [{ ...tampered, columns: ['x'] }, { ...tampered, version: 2 }, { ...tampered, rows: [[{}, 1, 2, 3, 4, 5, 6, 7, 8]] }]) {
    assert.equal((await preview(env, admin, bad)).status, 400);
  }
  // 1 uczeń (Ola) z wcześniejszego commitu tego testu (#207: e-mail nie blokuje importu).
  assert.equal(await count(db, 'students'), 1);
}));

test('formula-like text is stored verbatim as inert text', async () => withDb(async (db, env, admin) => {
  const csv = csvOf('S1;"=HYPERLINK(""http://x.invalid"")";Testowa;1A;R1;@SUM(A1) Test;;;');
  assert.equal((await previewAndCommit(env, admin, payloadFromCsv(csv), 'key-formula1')).status, 201);
  const { rows } = await db.query('SELECT first_name FROM students');
  assert.equal(rows[0].first_name, '=HYPERLINK("http://x.invalid")');
  const g = await db.query('SELECT first_name, last_name FROM guardians');
  assert.deepEqual(g.rows[0], { first_name: '@SUM(A1)', last_name: 'Test' });
}));

test('stale preview, tampered rows and reused idempotency key are refused', async () => withDb(async (db, env, admin) => {
  const payload = payloadFromCsv(BASIC);
  const p = await preview(env, admin, payload);
  // Ktoś inny w międzyczasie importuje ucznia S3.
  assert.equal((await previewAndCommit(env, admin, payloadFromCsv(csvOf('S3;Piotr;Próbny;1A;R2;;;;')), 'key-other-01')).status, 201);
  const stale = await commit(env, admin, payload, p.body, 'key-stale-01');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'preview_stale');

  const tampered = payloadFromCsv(BASIC);
  tampered.rows[0][1] = 'Zmieniona';
  const mismatch = await commit(env, admin, tampered, p.body, 'key-tamper-1');
  assert.equal(mismatch.body.error, 'fingerprint_mismatch');

  const reused = await commit(env, admin, payload, (await preview(env, admin, payload)).body, 'key-other-01');
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, 'idempotency_key_reused');

  const noKey = await handlePgRequest(post('/api/import/commit', admin, { ...payload, fingerprint: p.body.fingerprint, planDigest: p.body.planDigest }), env);
  assert.equal(noKey.status, 400);
  assert.equal((await noKey.json()).error, 'idempotency_key_required');
  const noPreview = await handlePgRequest(post('/api/import/commit', admin, payload, { key: 'key-nopreview' }), env);
  assert.equal((await noPreview.json()).error, 'preview_required');
}));

test('role, scope, MFA and origin checks happen on the server', async () => withDb(async (db, env, admin) => {
  const payload = payloadFromCsv(BASIC);
  const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true });
  const boardClass = await seedUserSession(db, { userId: 'u-board-class', roles: [{ role: 'board', classId: 'c-1a', schoolYearId: YEAR }], mfa: true });
  const boardOtherYear = await seedUserSession(db, { userId: 'u-board-y', roles: [{ role: 'board', schoolYearId: 'y-2030' }], mfa: true });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', roles: [{ role: 'treasurer' }], mfa: true });
  const noMfa = await seedUserSession(db, { userId: 'u-admin-nomfa', roles: [{ role: 'admin' }], mfa: false });
  const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });

  for (const cookie of [rep, boardClass, boardOtherYear, treasurer, noMfa]) {
    const response = await handlePgRequest(post('/api/import/preview', cookie, payload), env);
    assert.equal(response.status, 403);
    const c = await handlePgRequest(post('/api/import/commit', cookie, { ...payload, fingerprint: '0'.repeat(64), planDigest: '0'.repeat(64) }, { key: 'key-denied-01' }), env);
    assert.equal(c.status, 403);
  }
  assert.equal((await handlePgRequest(post('/api/import/preview', null, payload), env)).status, 401);
  const cross = await handlePgRequest(post('/api/import/preview', admin, payload, { origin: 'https://evil.invalid' }), env);
  assert.equal(cross.status, 403);
  assert.equal((await cross.json()).error, 'invalid_origin');
  assert.equal((await handlePgRequest(post('/api/import/preview', admin, payload, { origin: false }), env)).status, 403);
  assert.equal((await handlePgRequest(post('/api/import/preview', admin, 'x=1', { headers: { 'Content-Type': 'text/plain' } }), env)).status, 415);
  assert.equal((await preview(env, board, payload)).status, 200);

  const options = await handlePgRequest(request('/api/import/options', { cookie: board }), env);
  assert.deepEqual((await options.json()).schoolYears, [{ id: YEAR, label: `test ${YEAR}`, classes: ['1A', '2B'] }]);
  assert.equal((await handlePgRequest(request('/api/import/options', { cookie: rep }), env)).status, 403);
  assert.equal(await count(db, 'import_batches'), 0);
}));

test('production requires an explicit IMPORT_ENABLED switch', async () => withDb(async (db, env, admin) => {
  const payload = payloadFromCsv(BASIC);
  const off = await handlePgRequest(post('/api/import/preview', admin, payload), { ...env, APP_ENV: 'production' });
  assert.equal(off.status, 403);
  assert.equal((await off.json()).error, 'import_disabled');
  const on = await handlePgRequest(post('/api/import/preview', admin, payload), { ...env, APP_ENV: 'production', IMPORT_ENABLED: 'true' });
  assert.equal(on.status, 200);

  // #166: 'prod' i inna wielkość liter ('Production'/'PRODUCTION') muszą być
  // rozpoznane tak samo jak 'production' — literówka w konfiguracji Railway
  // nie może zostawić importu danych dzieci i opiekunów włączonym po cichu.
  for (const appEnv of ['prod', 'Production', 'PRODUCTION', '  production  ']) {
    const blocked = await handlePgRequest(post('/api/import/preview', admin, payload), { ...env, APP_ENV: appEnv });
    assert.equal(blocked.status, 403, appEnv);
    assert.equal((await blocked.json()).error, 'import_disabled', appEnv);
    const allowed = await handlePgRequest(post('/api/import/preview', admin, payload), { ...env, APP_ENV: appEnv, IMPORT_ENABLED: 'true' });
    assert.equal(allowed.status, 200, appEnv);
  }
  // Ta sama trasa commit, nie tylko preview.
  const commitBlocked = await handlePgRequest(
    post('/api/import/commit', admin, { ...payload, fingerprint: '0'.repeat(64), planDigest: '0'.repeat(64) }, { key: 'key-prod-01' }),
    { ...env, APP_ENV: 'PROD' },
  );
  assert.equal(commitBlocked.status, 403);
  assert.equal((await commitBlocked.json()).error, 'import_disabled');
}));

test('audit event records actor and counts only, without PII', async () => withDb(async (db, env, admin) => {
  const done = await previewAndCommit(env, admin, payloadFromCsv(BASIC), 'key-audit-01');
  const { rows } = await db.query("SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'import.committed'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_id, 'u-admin');
  assert.equal(rows[0].entity_type, 'import_batch');
  assert.equal(rows[0].entity_id, done.body.batchId);
  assert.doesNotThrow(() => assertNoPii(rows[0].metadata_json));
  const text = JSON.stringify(rows[0].metadata_json);
  for (const fragment of ['Ala', 'Testowa', 'example.invalid', 'S1', 'R1']) assert.equal(text.includes(fragment), false, fragment);
  assert.equal(rows[0].metadata_json.counts.studentsCreated, 3);
  const batch = (await db.query('SELECT * FROM import_batches')).rows[0];
  assert.equal(batch.actor_id, 'u-admin');
  await assert.rejects(db.query('DELETE FROM import_batches'), /append_only/);
}));

// #248: bez set_config('rd.actor_id', …, true) przed bulkInsert, triggery historii
// rodzin (0014/0023) zapisywały created_by/changed_by = NULL i source = 'direct',
// jakby import był bezpośrednim SQL-em, mimo że audit_events i import_batches
// poprawnie wskazywały operatora. Sprawdza nowego ucznia, nowego opiekuna,
// rodzeństwo we wspólnej rodzinie i istniejącego ucznia bez przypisania w wybranym
// roku, a także że podwójne kliknięcie/ponowienie nie dopisuje kolejnych wierszy.
test('#248: import stamps the actor on student_households/guardian_households/enrollment_history, not just audit_events', async () => withDb(async (db, env, admin) => {
  await seedClass(db, { id: 'c-2a-27', schoolYearId: 'y-2027', name: '2A' });

  // Nowy uczeń, nowy opiekun, rodzeństwo we wspólnej rodzinie (S1+S2 -> R1), uczeń bez opiekunów (S3).
  const first = await previewAndCommit(env, admin, payloadFromCsv(BASIC), 'key-hist-0001');
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const sh = await db.query('SELECT created_by, source FROM student_households');
  assert.equal(sh.rows.length, 3);
  for (const row of sh.rows) {
    assert.equal(row.created_by, 'u-admin', JSON.stringify(row));
    assert.equal(row.source, 'student_insert');
  }
  const gh = await db.query('SELECT created_by, source FROM guardian_households');
  assert.equal(gh.rows.length, 3);
  for (const row of gh.rows) {
    assert.equal(row.created_by, 'u-admin', JSON.stringify(row));
    assert.equal(row.source, 'guardian_insert');
  }
  const eh = await db.query("SELECT changed_by, source, reason FROM enrollment_history WHERE kind = 'enrolled' AND school_year_id = $1", [YEAR]);
  assert.equal(eh.rows.length, 3);
  for (const row of eh.rows) {
    assert.equal(row.changed_by, 'u-admin', JSON.stringify(row));
    assert.equal(row.source, 'api');
    assert.equal(row.reason, 'import_csv_xlsx');
  }

  // Istniejący uczeń (S1) bez przypisania w nowo wybranym roku szkolnym: nowy
  // wpis enrollment_history typu 'enrolled', bez tworzenia drugiej rodziny/opiekunów.
  const nextYearPayload = payloadFromCsv(csvOf('S1;Ala;Testowa;2A;R1;;;;'), {}, 'y-2027');
  const nextYear = await previewAndCommit(env, admin, nextYearPayload, 'key-hist-0002');
  assert.equal(nextYear.status, 201, JSON.stringify(nextYear.body));
  const enrolled2027 = await db.query("SELECT changed_by, source, reason FROM enrollment_history WHERE school_year_id = 'y-2027'");
  assert.equal(enrolled2027.rows.length, 1);
  assert.equal(enrolled2027.rows[0].changed_by, 'u-admin');
  assert.equal(enrolled2027.rows[0].source, 'api');
  assert.equal(enrolled2027.rows[0].reason, 'import_csv_xlsx');
  // Ten import nie dotknął gospodarstw ani opiekunów — liczba wierszy bez zmian.
  assert.equal(await count(db, 'student_households'), 3);
  assert.equal(await count(db, 'guardian_households'), 3);

  // Podwójne kliknięcie (ten sam klucz idempotencji) tej samej pierwszej partii:
  // wynik z cache, żadnych dodatkowych wierszy historii.
  const shBefore = await count(db, 'student_households');
  const ghBefore = await count(db, 'guardian_households');
  const ehBefore = await count(db, 'enrollment_history');
  const doubleClick = await commit(env, admin, payloadFromCsv(BASIC), first.preview, 'key-hist-0001');
  assert.equal(doubleClick.status, 200);
  assert.equal(doubleClick.body.replayed, true);
  assert.equal(doubleClick.body.batchId, first.body.batchId);
  assert.equal(await count(db, 'student_households'), shBefore);
  assert.equal(await count(db, 'guardian_households'), ghBefore);
  assert.equal(await count(db, 'enrollment_history'), ehBefore);

  // Ponowienie tej samej partii z nowym kluczem idempotencji (ale ten sam
  // fingerprint danych) — ten sam batch, wciąż żadnych nowych wierszy historii.
  const secondPreview = await preview(env, admin, payloadFromCsv(BASIC));
  const retry = await commit(env, admin, payloadFromCsv(BASIC), secondPreview.body, 'key-hist-0003');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.batchId, first.body.batchId);
  assert.equal(await count(db, 'student_households'), shBefore);
  assert.equal(await count(db, 'guardian_households'), ghBefore);
  assert.equal(await count(db, 'enrollment_history'), ehBefore);
}));

test('unknown import subpaths fall through and wrong methods are rejected', async () => withDb(async (db, env, admin) => {
  const handler = createPgHandler(ROUTES);
  assert.equal((await handler(request('/api/import/nope', { cookie: admin }), env)).status, 404);
  assert.equal((await handler(request('/api/import/preview', { cookie: admin }), env)).status, 405);
}));

// --- #145 (D-06): commit wymaga opublikowanej informacji o przetwarzaniu danych ---

test('#145 commit without a published privacy notice is refused; preview is not blocked', async () => {
  const db = await createTestDb();
  try {
    await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const env = { db };
    const payload = payloadFromCsv(csvOf('S1;Ala;Testowa;1A;R1;Jan Testowy;jan@example.invalid;;'));
    const p = await preview(env, admin, payload);
    assert.equal(p.status, 200, 'podgląd nie zapisuje niczego i nie jest blokowany przez bramkę');
    const c = await commit(env, admin, payload, p.body, 'key-privacy-0001');
    assert.equal(c.status, 409);
    assert.deepEqual(c.body, { error: 'privacy_notice_missing' });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM import_batches')).rows[0].n, 0);

    // Draft/nieopublikowana wersja nadal blokuje.
    await db.query(
      `INSERT INTO privacy_notices (id, body_text, content_hash, decision_ref, status, created_by)
       VALUES ('pn-draft', 'Szkic.', repeat('b', 64), 'D-06/szkic', 'draft', 'u-admin')`,
    );
    const stillMissing = await commit(env, admin, payload, p.body, 'key-privacy-0001');
    assert.deepEqual(stillMissing.body, { error: 'privacy_notice_missing' });

    // Publikacja odblokowuje; batch zapisuje, która wersja obowiązywała.
    const noticeId = await seedPublishedPrivacyNotice(db, { id: 'pn-published' });
    const ok = await commit(env, admin, payload, p.body, 'key-privacy-0001');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(
      (await db.query('SELECT privacy_notice_id FROM import_batches WHERE id = $1', [ok.body.batchId])).rows[0].privacy_notice_id,
      noticeId,
    );
  } finally {
    await db.close();
  }
});

// --- #98: dopasowanie opiekuna, przedrostki nazwisk, raport „brak w pliku" ---

test('splitGuardianName keeps Dutch/Belgian and French surname particles with the last name', () => {
  assert.deepEqual(splitGuardianName('Jan Kowalski'), { firstName: 'Jan', lastName: 'Kowalski' });
  assert.deepEqual(splitGuardianName('Anna Maria de Smet'), { firstName: 'Anna Maria', lastName: 'de Smet' });
  assert.deepEqual(splitGuardianName('Piotr van der Berg'), { firstName: 'Piotr', lastName: 'van der Berg' });
  assert.deepEqual(splitGuardianName('Ewa von Neumann'), { firstName: 'Ewa', lastName: 'von Neumann' });
  assert.deepEqual(splitGuardianName('Kowalski'), { firstName: 'Kowalski', lastName: '' });
  // Same przedrostki bez imienia — co najmniej jeden wyraz zostaje w imieniu.
  assert.deepEqual(splitGuardianName('van der Berg'), { firstName: 'van', lastName: 'der Berg' });
});

test('re-import with a changed guardian e-mail is a conflict, not a second guardian (only that row)', async () => withDb(async (db, env, admin) => {
  const base = csvOf(
    'S1;Ala;Testowa;1A;R1;Anna Testowa;anna@example.invalid;Jan Testowy;jan@example.invalid',
    'S2;Ola;Testowa;1A;R1;Anna Testowa;anna@example.invalid;Jan Testowy;jan@example.invalid',
  );
  const first = await previewAndCommit(env, admin, payloadFromCsv(base), 'key-e98-0001');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(await count(db, 'guardians'), 2);

  // Tylko drugi opiekun (Jan) zmienia e-mail; pierwszy wiersz (S1) dostaje konflikt,
  // drugi (S2, ten sam opiekun 2) też — bo dotyczy tej samej pary rodzina+opiekun.
  const changed = csvOf(
    'S1;Ala;Testowa;1A;R1;Anna Testowa;anna@example.invalid;Jan Testowy;jan.nowy@example.invalid',
    'S2;Ola;Testowa;1A;R1;Anna Testowa;anna@example.invalid;Jan Testowy;jan.nowy@example.invalid',
  );
  const p = await preview(env, admin, payloadFromCsv(changed));
  assert.equal(p.body.counts.rowsConflict, 2);
  assert.equal(p.body.counts.guardiansCreated, 0);
  const byRow = Object.fromEntries(p.body.rows.map((row) => [row.row, row]));
  assert.equal(byRow[2].messages[0], MESSAGES.guardianMaybeChanged);
  assert.equal(byRow[3].messages[0], MESSAGES.guardianMaybeChanged);

  const done = await commit(env, admin, payloadFromCsv(changed, { skipConflicts: true }), p.body, 'key-e98-0002');
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(await count(db, 'guardians'), 2, 'no second guardian is created for a changed e-mail');
  const stillOld = await db.query("SELECT count(*)::int AS n FROM guardians WHERE email = 'jan@example.invalid'");
  assert.equal(stillOld.rows[0].n, 1, 'the existing guardian record is left untouched, not overwritten');
}));

test('re-import with a corrected guardian surname typo (same e-mail) is a conflict', async () => withDb(async (db, env, admin) => {
  const base = csvOf('S1;Ala;Testowa;1A;R1;Ana Kowalska;ana@example.invalid;;');
  await previewAndCommit(env, admin, payloadFromCsv(base), 'key-e98-0003');
  const p = await preview(env, admin, payloadFromCsv(csvOf('S1;Ala;Testowa;1A;R1;Anna Kowalska;ana@example.invalid;;')));
  assert.equal(p.body.counts.rowsConflict, 1);
  assert.equal(p.body.rows[0].messages[0], MESSAGES.guardianMaybeChanged);
  assert.equal(await count(db, 'guardians'), 1);
}));

test('the same guardian in two separate households (parents apart) is not a false conflict', async () => withDb(async (db, env, admin) => {
  const csv = csvOf(
    'S1;Ala;Testowa;1A;R1;Anna Testowa;anna@example.invalid;;',
    'S2;Ola;Inna;1A;R2;Anna Testowa;anna@example.invalid;;',
  );
  const p = await preview(env, admin, payloadFromCsv(csv));
  assert.equal(p.body.counts.rowsConflict, 0);
  assert.equal(p.body.counts.guardiansCreated, 2);
  assert.ok(p.body.warnings.some((w) => w.message === MESSAGES.emailElsewhere));
}));

test('double-click and retry after a guardian conflict do not duplicate guardians', async () => withDb(async (db, env, admin) => {
  await previewAndCommit(env, admin, payloadFromCsv(csvOf('S1;Ala;Testowa;1A;R1;Anna Testowa;anna@example.invalid;;')), 'key-e98-0004');
  const changed = payloadFromCsv(csvOf('S1;Ala;Testowa;1A;R1;Hanna Testowa;anna@example.invalid;;'), { skipConflicts: true });
  const p = await preview(env, admin, changed);
  const first = await commit(env, admin, changed, p.body, 'key-e98-0005');
  assert.equal(first.status, 201);
  const snapshot = await tableCounts(db);
  const retry = await commit(env, admin, changed, p.body, 'key-e98-0005');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.deepEqual(await tableCounts(db), snapshot);
}));

test('preview reports students enrolled this year but missing from the file, without names', async () => withDb(async (db, env, admin) => {
  await previewAndCommit(env, admin, payloadFromCsv(BASIC), 'key-e98-0006');
  const onlyTwo = csvOf(
    'S1;Ala;Testowa;1A;R1;Anna Testowa;anna@example.invalid;Jan Testowy;jan@example.invalid',
    'S2;Ola;Testowa;2B;R1;Anna Testowa;anna@example.invalid;Jan Testowy;jan@example.invalid',
  );
  const p = await preview(env, admin, payloadFromCsv(onlyTwo));
  assert.deepEqual(p.body.missingFromFile, { count: 1, refs: ['S3'] });
  const text = JSON.stringify(p.body.missingFromFile);
  for (const fragment of ['Piotr', 'Próbny', 'ewa@']) assert.equal(text.includes(fragment), false, fragment);
}));

test('a guardian name with a surname particle is split and stored correctly', async () => withDb(async (db, env, admin) => {
  const csv = csvOf('S1;Ala;Testowa;1A;R1;Anna Maria de Smet;anna@example.invalid;;');
  const result = await previewAndCommit(env, admin, payloadFromCsv(csv), 'key-e98-0007');
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const g = await db.query("SELECT first_name, last_name FROM guardians WHERE email = 'anna@example.invalid'");
  assert.deepEqual(g.rows[0], { first_name: 'Anna Maria', last_name: 'de Smet' });
}));

// #2: replay wyłącznie przy tym samym kluczu albo gdy plan nie ma już nic do zapisania.
test('#2 skipped row -> conflict removed -> same file with a new key is committed as a new batch', async () => withDb(async (db, env, admin) => {
  await previewAndCommit(env, admin, payloadFromCsv(csvOf('S1;Ala;Testowa;1A;R1;Anna Testowa;anna@example.invalid;;')), 'key-r2-00001');
  // Wiersz S1: inne nazwisko ucznia niż w bazie (konflikt) + nowy drugi opiekun.
  const file = csvOf('S1;Ala;Inna;1A;R1;Anna Testowa;anna@example.invalid;Nowy Opiekun;nowy@example.invalid');
  const payload = payloadFromCsv(file, { skipConflicts: true });
  const p1 = await preview(env, admin, payload);
  assert.equal(p1.body.counts.rowsConflict, 1);
  const first = await commit(env, admin, payload, p1.body, 'key-r2-00002');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.counts.rowsConflict, 1);
  assert.equal(await count(db, 'guardians'), 1);

  // Konflikt nadal istnieje, nowy klucz: nic do zapisania, więc zapisany wynik bez nowej partii.
  const p2 = await preview(env, admin, payload);
  const stillConflict = await commit(env, admin, payload, p2.body, 'key-r2-00003');
  assert.equal(stillConflict.status, 200);
  assert.equal(stillConflict.body.replayed, true);
  assert.equal(stillConflict.body.batchId, first.body.batchId);
  assert.equal(await count(db, 'import_batches'), 2);

  // Poprawka danych w bazie usuwa przyczynę konfliktu.
  await db.query("UPDATE students SET last_name = 'Inna' WHERE source_ref = 'S1'");
  const p3 = await preview(env, admin, payload);
  assert.equal(p3.body.counts.rowsConflict, 0);
  assert.equal(p3.body.counts.rowsUpdated, 1);
  const second = await commit(env, admin, payload, p3.body, 'key-r2-00004');
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.replayed, false);
  assert.notEqual(second.body.batchId, first.body.batchId);
  assert.equal(await count(db, 'guardians'), 2, 'pominięty wiersz został zastosowany');
  assert.equal(await count(db, 'import_batches'), 3);

  // Ten sam klucz to nadal podwójne kliknięcie; nowy klucz bez zmian w bazie to powtórka ostatniej partii.
  const dbl = await commit(env, admin, payload, p3.body, 'key-r2-00004');
  assert.equal(dbl.body.replayed, true);
  assert.equal(dbl.body.batchId, second.body.batchId);
  const p4 = await preview(env, admin, payload);
  const again = await commit(env, admin, payload, p4.body, 'key-r2-00005');
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.batchId, second.body.batchId);
  assert.equal(await count(db, 'guardians'), 2);
  assert.equal(await count(db, 'import_batches'), 3);
}));

test('#2 parallel commits of the same file with different keys write once', async () => withDb(async (db, env, admin) => {
  const payload = payloadFromCsv(BASIC);
  const p = await preview(env, admin, payload);
  const [a, b] = await Promise.all([
    commit(env, admin, payload, p.body, 'key-r2-par-01'),
    commit(env, admin, payload, p.body, 'key-r2-par-02'),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.body.batchId, b.body.batchId);
  assert.equal(await count(db, 'import_batches'), 1);
  assert.equal(await count(db, 'students'), 3);
  assert.equal(await count(db, 'guardians'), 3);
}));
