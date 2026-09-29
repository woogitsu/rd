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
