// Eksport CSV wpisów wpłat i korekt (#141). Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const BASE = 'https://rd.example';
const DEBT_WORDS = /debt|due|owed|owing|outstanding|arrear|balance|receivable|d[lł]u[zż]n|zaleg|nale[zż]/i;

function call(cookie, path, { method = 'GET', body, key, origin = BASE, contentType = 'application/json' } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (method !== 'GET' && origin) headers.set('Origin', origin);
  if (key) headers.set('Idempotency-Key', key);
  if (contentType && method !== 'GET') headers.set('Content-Type', contentType);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Request(`${BASE}${path}`, { method, headers, body: payload });
}

async function pgBackend({ role = 'treasurer', mfa = true, schoolYearId = 'y2026', classId } = {}) {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y2025', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, 'y2026');
  for (const householdId of ['h1', 'h2']) await seedEnrolledHousehold(db, householdId, ['y2025', 'y2026']);
  const cookie = await seedUserSession(db, { userId: 'u1', mfa, roles: [{ role, schoolYearId, classId }] });
  const env = { db };
  return {
    db, env, cookie,
    fetch: (req) => handlePgRequest(req, env),
    as: (userId, options) => seedUserSession(db, { userId, ...options }),
    count: async (table, where = 'TRUE') => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n),
    close: () => db.close(),
  };
}

async function withPg(options, fn) {
  const backend = await pgBackend(options);
  try { return await fn(backend); } finally { await backend.close(); }
}

async function createPayment(backend, patch = {}, key = `pay-${crypto.randomUUID()}`) {
  const body = { householdId: 'h1', schoolYearId: 'y2026', amountCents: 7500, receivedOn: '2026-09-20', method: 'bank', ...patch };
  const res = await backend.fetch(call(backend.cookie, '/api/payments', { method: 'POST', body, key }));
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).payment;
}

async function exportCsv(backend, query = 'schoolYearId=y2026', cookie = backend.cookie) {
  const res = await backend.fetch(call(cookie, `/api/payments/export.csv?${query}`));
  return { status: res.status, headers: res.headers, text: res.status === 200 ? await res.text() : await res.json() };
}

test('eksport CSV: nagłówek ostrzegawczy, dyspozytor i brak zakazanych słów', async () => withPg({}, async (backend) => {
  await createPayment(backend, {}, 'exp-p1-0001');
  const result = await exportCsv(backend);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  assert.match(result.headers.get('Content-Disposition'), /attachment; filename="wplaty-y2026\.csv"/);
  assert.match(result.text, /Składki są dobrowolne; brak wpisu nie oznacza braku wpłaty\./);
  assert.doesNotMatch(result.text, DEBT_WORDS);
  assert.equal(await backend.count('audit_events', "action = 'payment.exported'"), 1);
}));

test('wpłata częściowa z dwiema korektami: dwa wiersze w eksporcie, poprawna kwota netto', async () => withPg({}, async (backend) => {
  const payment = await createPayment(backend, { amountCents: 10000 }, 'exp-p2-0001');
  const correctionPath = `/api/payments/${payment.id}/corrections`;
  const c1 = await backend.fetch(call(backend.cookie, correctionPath, {
    method: 'POST', body: { amountCents: 3000, reason: 'Pierwsza korekta częściowa' }, key: 'exp-c1-0001',
  }));
  assert.equal(c1.status, 201);
  const c2 = await backend.fetch(call(backend.cookie, correctionPath, {
    method: 'POST', body: { amountCents: 2000, reason: 'Druga korekta częściowa' }, key: 'exp-c2-0001',
  }));
  assert.equal(c2.status, 201);

  const result = await exportCsv(backend);
  assert.equal(result.status, 200);
  const lines = result.text.trim().split('\r\n');
  const entryLine = lines.find((line) => line.startsWith('wpis;') && line.includes(payment.id));
  const correctionLines = lines.filter((line) => line.startsWith('korekta;'));
  assert.equal(correctionLines.length, 2, 'dwie korekty jako osobne wiersze');
  const cells = entryLine.split(';');
  assert.equal(cells[9], '50,00'); // netto_eur = 100,00 - 30,00 - 20,00
}));

test('wpłata nieprzypisana: widoczna jako do wyjaśnienia, bez numeru rodziny', async () => withPg({}, async (backend) => {
  await createPayment(backend, { householdId: null, reference: null }, 'exp-p3-0001');
  const result = await exportCsv(backend);
  assert.equal(result.status, 200);
  const line = result.text.split('\r\n').find((l) => l.startsWith('wpis;'));
  const cells = line.split(';');
  assert.equal(cells[5], 'nieprzypisana do wyjaśnienia');
  assert.equal(cells[6], ''); // numer_rodziny puste
}));

test('skarbnik innego roku -> 403; przedstawiciel -> 403; bez MFA -> 403', async () => withPg({}, async (backend) => {
  const other = await backend.as('u2', { mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y2025' }] });
  const otherYear = await exportCsv(backend, 'schoolYearId=y2026', other);
  assert.equal(otherYear.status, 403);

  const rep = await backend.as('u3', { mfa: true, roles: [{ role: 'representative', schoolYearId: 'y2026', classId: 'c-1a' }] });
  const repResult = await exportCsv(backend, 'schoolYearId=y2026', rep);
  assert.equal(repResult.status, 403);

  const noMfa = await backend.as('u4', { mfa: false, roles: [{ role: 'treasurer', schoolYearId: 'y2026' }] });
  const noMfaResult = await exportCsv(backend, 'schoolYearId=y2026', noMfa);
  assert.equal(noMfaResult.status, 403);
}));

test('podwójne kliknięcie eksportu: dwa zdarzenia audytu, identyczna treść pliku', async () => withPg({}, async (backend) => {
  await createPayment(backend, {}, 'exp-p4-0001');
  const [first, second] = await Promise.all([exportCsv(backend), exportCsv(backend)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.text, second.text);
  assert.equal(await backend.count('audit_events', "action = 'payment.exported'"), 2);
}));

test('nieznany rok (admin) -> 404; brak parametru -> 400', async () => withPg({}, async (backend) => {
  const admin = await backend.as('u-admin', { mfa: true, roles: [{ role: 'admin' }] });
  const missingYear = await exportCsv(backend, 'schoolYearId=y-missing', admin);
  assert.equal(missingYear.status, 404);
  const badRequest = await backend.fetch(call(backend.cookie, '/api/payments/export.csv'));
  assert.equal(badRequest.status, 400);
}));

// --- XLSX (#141): arkusze „Wpisy” i „Korekty”, te same role i ślady co CSV ---

async function exportXlsx(backend, query = 'schoolYearId=y2026', cookie = backend.cookie) {
  const res = await backend.fetch(call(cookie, `/api/payments/export.xlsx?${query}`));
  if (res.status !== 200) return { status: res.status, body: await res.json() };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { default: readXlsxFileNode } = await import('read-excel-file/node');
  const sheets = await readXlsxFileNode(Buffer.from(bytes));
  return { status: res.status, headers: res.headers, bytes, names: sheets.map((s) => s.sheet), sheets: Object.fromEntries(sheets.map((s) => [s.sheet, s.data])) };
}

// Wiersze danych arkusza pod nagłówkiem (pierwsza komórka „id”).
function sheetRows(rows) {
  const start = rows.findIndex((row) => row[0] === 'id');
  return { header: rows[start], rows: rows.slice(start + 1) };
}
const toCents = (value) => Math.round(value * 100);

test('eksport XLSX: dwa arkusze, ostrzeżenie, korekty osobno z id wpisu, netto poprawne, brak formuł', async () => withPg({}, async (backend) => {
  const payment = await createPayment(backend, { amountCents: 10000 }, 'xls-p1-0001');
  for (const [cents, reason, key] of [[3000, 'Pierwsza korekta częściowa', 'xls-c1-0001'], [2000, '=HYPERLINK("http://evil.example")', 'xls-c2-0001']]) {
    const res = await backend.fetch(call(backend.cookie, `/api/payments/${payment.id}/corrections`, { method: 'POST', body: { amountCents: cents, reason }, key }));
    assert.equal(res.status, 201, await res.clone().text());
  }
  await createPayment(backend, { householdId: null, reference: null, amountCents: 1234 }, 'xls-p2-0001');

  const result = await exportXlsx(backend);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Content-Type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(result.headers.get('Content-Disposition'), 'attachment; filename="wplaty-y2026.xlsx"');
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(result.names, ['Wpisy', 'Korekty']);
  const { unzipSync, strFromU8 } = await import('fflate');
  for (const [name, part] of Object.entries(unzipSync(result.bytes))) {
    const text = strFromU8(part);
    assert.ok(!/<f[\s>/]/.test(text), `${name} bez formuł`);
    assert.doesNotMatch(text, DEBT_WORDS, `${name} bez słów o należnościach`);
  }
  for (const name of result.names) assert.equal(result.sheets[name][0][0], 'Składki są dobrowolne; brak wpisu nie oznacza braku wpłaty.');

  const entries = sheetRows(result.sheets.Wpisy);
  assert.deepEqual(entries.header, ['id', 'data', 'kwota_eur', 'metoda', 'stan_przypisania', 'numer_rodziny', 'suma_korekt_eur', 'suma_zwrotow_eur', 'netto_eur']);
  const entry = entries.rows.find((row) => row[0] === payment.id);
  assert.ok(entry[1] instanceof Date && entry[1].toISOString().startsWith('2026-09-20'), 'data jako prawdziwa data arkusza');
  assert.deepEqual(entry.slice(2).map((v) => (typeof v === 'number' ? toCents(v) : v)), [10000, 'Przelew', 'przypisana', 'h1', 5000, 0, 5000]);
  const unassigned = entries.rows.find((row) => row[0] !== payment.id);
  assert.equal(unassigned[4], 'nieprzypisana do wyjaśnienia');
  assert.equal(unassigned[5], null, 'nieprzypisana bez numeru rodziny');

  const corrections = sheetRows(result.sheets.Korekty);
  assert.deepEqual(corrections.header, ['id', 'id_wpisu_wplaty', 'data', 'kwota_korekty_eur', 'numer_rodziny', 'powod_korekty', 'rola_aktora']);
  assert.equal(corrections.rows.length, 2, 'dwie korekty jako osobne wiersze');
  for (const row of corrections.rows) assert.equal(row[1], payment.id);
  assert.deepEqual(corrections.rows.map((row) => toCents(row[3])).sort(), [2000, 3000]);
  const formulaReason = corrections.rows.find((row) => row[5].startsWith('='));
  assert.equal(formulaReason[5], '=HYPERLINK("http://evil.example")', 'opis-formuła zostaje tekstem');
  assert.equal(formulaReason[6], 'treasurer', 'rola aktora, nie e-mail');

  const events = (await backend.db.query("SELECT metadata_json FROM audit_events WHERE action = 'payment.exported'")).rows;
  assert.deepEqual(events.map((e) => e.metadata_json), [{ schoolYearId: 'y2026', format: 'xlsx', entryCount: 2, correctionCount: 2 }]);
  const access = (await backend.db.query("SELECT access_kind, row_count, outcome FROM data_access_log WHERE access_kind = 'payment_export'")).rows;
  assert.deepEqual(access.map((row) => [row.access_kind, Number(row.row_count), row.outcome]), [['payment_export', 4, 'ok']]);
}));

test('eksport XLSX: suma netto przypisanych = recordedNetCents z manifestu eksportu rocznego', async () => withPg({}, async (backend) => {
  const { buildYearlyExport } = await import('../src/pg/export.js');
  // Rodzeństwo (jedna rodzina h1, dwie wpłaty) i drugi opiekun innej rodziny (h2) płacący osobno.
  const first = await createPayment(backend, { amountCents: 4000 }, 'xls-s1-0001');
  await createPayment(backend, { amountCents: 2500, receivedOn: '2026-09-21' }, 'xls-s2-0001');
  await createPayment(backend, { householdId: 'h2', amountCents: 3000, method: 'cash' }, 'xls-g1-0001');
  await createPayment(backend, { householdId: 'h2', amountCents: 1500 }, 'xls-g2-0001');
  await createPayment(backend, { householdId: null, reference: null, amountCents: 999 }, 'xls-u1-0001');
  const corr = await backend.fetch(call(backend.cookie, `/api/payments/${first.id}/corrections`, { method: 'POST', body: { amountCents: 500, reason: 'Korekta syntetyczna' }, key: 'xls-sc-0001' }));
  assert.equal(corr.status, 201);

  const result = await exportXlsx(backend);
  const { rows } = sheetRows(result.sheets.Wpisy);
  assert.equal(rows.length, 5);
  const assigned = rows.filter((row) => row[4] === 'przypisana');
  assert.deepEqual(assigned.filter((row) => row[5] === 'h1').length, 2, 'rodzeństwo: jeden numer rodziny, dwa wpisy');
  assert.deepEqual(assigned.filter((row) => row[5] === 'h2').length, 2, 'dwie osoby płacące osobno: dwa wpisy');
  const netSum = assigned.reduce((total, row) => total + toCents(row[8]), 0);
  const { manifest } = await backend.db.transaction((tx) => buildYearlyExport(tx, 'y2026', { sink: () => {} }));
  assert.equal(netSum, manifest.totals.payments.recordedNetCents);
  assert.equal(netSum, 4000 - 500 + 2500 + 3000 + 1500);
}));

test('eksport XLSX: role jak CSV, podwójne kliknięcie = dwa zdarzenia i te same bajty, zły parametr', async () => withPg({}, async (backend) => {
  await createPayment(backend, {}, 'xls-p5-0001');
  const other = await backend.as('u2', { mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y2025' }] });
  assert.equal((await exportXlsx(backend, 'schoolYearId=y2026', other)).status, 403);
  const rep = await backend.as('u3', { mfa: true, roles: [{ role: 'representative', schoolYearId: 'y2026', classId: 'c-1a' }] });
  assert.equal((await exportXlsx(backend, 'schoolYearId=y2026', rep)).status, 403);
  const principal = await backend.as('u5', { mfa: true, roles: [{ role: 'principal', schoolYearId: 'y2026' }] });
  assert.equal((await exportXlsx(backend, 'schoolYearId=y2026', principal)).status, 403);
  const audit = await backend.as('u6', { mfa: true, roles: [{ role: 'audit', schoolYearId: 'y2026' }] });
  assert.equal((await exportXlsx(backend, 'schoolYearId=y2026', audit)).status, 403, 'D-09: KR bez eksportu wpłat (wariant zachowawczy)');
  const noMfa = await backend.as('u4', { mfa: false, roles: [{ role: 'treasurer', schoolYearId: 'y2026' }] });
  assert.equal((await exportXlsx(backend, 'schoolYearId=y2026', noMfa)).status, 403);
  assert.equal(await backend.count('audit_events', "action = 'payment.exported'"), 0, 'odmowa nie zapisuje zdarzenia eksportu');

  const [a, b] = await Promise.all([exportXlsx(backend), exportXlsx(backend)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual(a.bytes, b.bytes);
  assert.equal(await backend.count('audit_events', "action = 'payment.exported'"), 2);
  // Dziennik odczytu deduplikuje w oknie 5 min (#133): jeden wiersz, licznik trafień 2.
  const hits = (await backend.db.query("SELECT COALESCE(sum(hit_count), 0)::int AS n FROM data_access_log WHERE access_kind = 'payment_export'")).rows[0].n;
  assert.equal(hits, 2);

  const filtered = await exportXlsx(backend, 'schoolYearId=y2026&method=cash');
  assert.equal(sheetRows(filtered.sheets.Wpisy).rows.length, 0);
  assert.deepEqual(await exportXlsx(backend, 'schoolYearId=y2026&from=2026-10-01&to=2026-09-01'), { status: 400, body: { error: 'invalid_window' } });
  assert.equal((await exportXlsx(backend, '')).status, 400);
}));
