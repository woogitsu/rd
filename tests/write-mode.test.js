// Tryb tylko do odczytu (issue #143). Dane wyłącznie syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handlePgRequest } from '../src/pg/app.js';
import { checkReadiness } from '../src/health.js';
import { resolveRuntime } from '../src/server.js';
import { isWriteExempt, resolveWriteMode, WRITE_MODE_NORMAL, WRITE_MODE_READ_ONLY } from '../src/write-mode.js';
import { createTestDb, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { ROUTE_MATRIX } from './helpers/route-matrix.js';

const BASE = 'https://rd.example';

function call(cookie, path, { method, body, key, origin = BASE } = {}) {
  const upper = method ?? (body !== undefined ? 'POST' : 'GET');
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (upper !== 'GET' && origin) headers.set('Origin', origin);
  if (key) headers.set('Idempotency-Key', key);
  if (body !== undefined) headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Request(`${BASE}${path}`, { method: upper, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function read(response) {
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, retryAfter: response.headers.get('Retry-After') };
}

test('resolveWriteMode: normal i read_only są poprawne, brak wartości = normal, nieznana wartość odmawia', () => {
  assert.equal(resolveWriteMode(undefined), WRITE_MODE_NORMAL);
  assert.equal(resolveWriteMode(''), WRITE_MODE_NORMAL);
  assert.equal(resolveWriteMode('normal'), WRITE_MODE_NORMAL);
  assert.equal(resolveWriteMode('read_only'), WRITE_MODE_READ_ONLY);
  assert.throws(() => resolveWriteMode('READ_ONLY'), /invalid_app_write_mode/);
  assert.throws(() => resolveWriteMode('maintenance'), /invalid_app_write_mode/);
});

test('resolveRuntime odmawia startu przy nieznanej wartości APP_WRITE_MODE, bez tworzenia bazy', () => {
  let created = false;
  assert.throws(
    () => resolveRuntime({ APP_WRITE_MODE: 'oops' }, { createDatabase: () => { created = true; return {}; }, createStorage: () => ({}) }),
    /invalid_app_write_mode/,
  );
  assert.equal(created, false);
});

test('resolveRuntime przenosi APP_WRITE_MODE do env (postgres i legacy)', () => {
  const pg = resolveRuntime({ DATABASE_URL: 'postgres://x', APP_WRITE_MODE: 'read_only' }, { createDatabase: () => ({ close: async () => {} }), createStorage: () => ({}) });
  assert.equal(pg.env.APP_WRITE_MODE, 'read_only');
  const legacy = resolveRuntime({}, { createDatabase: () => ({}), createStorage: () => ({}) });
  assert.equal(legacy.env.APP_WRITE_MODE, 'normal');
});

test('/health/ready zgłasza write_mode niezależnie od stanu bazy', async () => {
  const notConfigured = await checkReadiness({ APP_WRITE_MODE: 'read_only' });
  assert.equal(notConfigured.body.write_mode, 'read_only');
  assert.equal(notConfigured.body.status, 'not_ready');

  const db = await createTestDb();
  try {
    // tests/helpers/pg.js nakłada migracje bezpośrednim SQL (bez schema_migrations),
    // więc readiness bazy zostaje 'not_ready' — sprawdzamy tylko pole write_mode.
    const readOnly = await checkReadiness({ db, APP_WRITE_MODE: 'read_only' });
    assert.equal(readOnly.body.write_mode, 'read_only');
    const normal = await checkReadiness({ db });
    assert.equal(normal.body.write_mode, 'normal');
  } finally {
    await db.close();
  }
});

async function withReadOnlyBackend(fn) {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y-test');
  const boardCookie = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: 'y-test' }], mfa: true });
  const repCookie = await seedUserSession(db, { userId: 'u-repA', roles: [{ role: 'representative', classId: 'kl-1a', schoolYearId: 'y-test' }], mfa: true });
  const env = { db, APP_WRITE_MODE: 'read_only' };
  const normalEnv = { db };
  try {
    await fn({ db, env, normalEnv, boardCookie, repCookie });
  } finally {
    await db.close();
  }
}

test('read_only: żądania zmieniające pod /api/ dostają 503 read_only przed routingiem modułu', async () => withReadOnlyBackend(async ({ env, boardCookie }) => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await read(await handlePgRequest(call(boardCookie, '/api/events', { method, body: { title: 'x' } }), env));
    assert.equal(response.status, 503, method);
    assert.deepEqual(response.body, { error: 'read_only' });
    assert.equal(response.retryAfter, '300');
  }
}));

test('read_only: odczyty (GET) i granice ról działają bez zmian', async () => withReadOnlyBackend(async ({ env, boardCookie, repCookie }) => {
  const board = await read(await handlePgRequest(call(boardCookie, '/api/meetings?schoolYearId=y-test'), env));
  assert.equal(board.status, 200);
  // Przedstawiciel klasy nadal nie widzi wpłat (granica ról niezależna od write mode).
  const rep = await read(await handlePgRequest(call(repCookie, '/api/payments?schoolYearId=y-test'), env));
  assert.equal(rep.status, 403);
}));

test('read_only: /api/login i /api/logout są zwolnione z blokady zapisu', async () => withReadOnlyBackend(async ({ env, boardCookie }) => {
  const logout = await handlePgRequest(call(boardCookie, '/api/logout', { method: 'POST' }), env);
  assert.equal(logout.status, 204);

  const login = await read(await handlePgRequest(call(null, '/api/login', { method: 'POST', body: { email: 'brak@example.invalid', password: 'x' } }), env));
  // Nie sprawdzamy tu logiki logowania — tylko że read_only jej nie blokuje 503-ką.
  assert.notEqual(login.status, 503);
}));

test('read_only: webhook Brevo (POST, cross-origin dozwolony) też dostaje 503 — dostawca ponawia dostarczenie', async () => withReadOnlyBackend(async ({ env }) => {
  const request = new Request(`${BASE}/api/email/webhooks/brevo`, {
    method: 'POST',
    headers: { Origin: 'https://api.brevo.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'delivered' }),
  });
  const response = await read(await handlePgRequest(request, env));
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: 'read_only' });
}));

test('podwójne kliknięcie w chwili przełączenia na read_only: żądanie sprzed przełączenia zapisane raz, po — 503; ponowienie po powrocie do normal nie duplikuje', async () => withReadOnlyBackend(async ({ db, env, normalEnv, boardCookie }) => {
  await seedEnrolledHousehold(db, 'h1', ['y-test']);
  const key = `switch-${crypto.randomUUID()}`;
  const paymentBody = { householdId: 'h1', schoolYearId: 'y-test', amountCents: 5000, receivedOn: '2026-09-20', method: 'bank', reference: 'synthetic' };
  const treasurerCookie = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: 'y-test' }], mfa: true });

  // Przed przełączeniem: zapis przechodzi normalnie.
  const before = await read(await handlePgRequest(call(treasurerCookie, '/api/payments', { body: paymentBody, key }), normalEnv));
  assert.equal(before.status, 201);

  // Po przełączeniu na read_only: to samo żądanie (np. drugie kliknięcie w locie) dostaje 503, bez duplikatu.
  const duringReadOnly = await read(await handlePgRequest(call(treasurerCookie, '/api/payments', { body: paymentBody, key }), env));
  assert.equal(duringReadOnly.status, 503);

  // Po powrocie do normal: ponowienie z tym samym kluczem odtwarza ten sam zapis (jeden wiersz).
  const afterBack = await read(await handlePgRequest(call(treasurerCookie, '/api/payments', { body: paymentBody, key }), normalEnv));
  assert.equal(afterBack.status, 200);
  assert.equal(afterBack.body.payment.id, before.body.payment.id);

  const count = await db.query("SELECT count(*)::int AS n FROM payment_entries WHERE idempotency_key = $1", [key]);
  assert.equal(count.rows[0].n, 1);
}));

// Bramka read_only działa na samym method+pathname, przed wczytaniem sesji/obiektu
// (patrz src/pg/app.js) — dlatego dowolna wartość identyfikatora w ścieżce wystarcza.
// Kryterium akceptacji #143: żaden moduł z tests/helpers/route-matrix.js nie zapisuje
// w read_only. Test iteruje po całej macierzy tras (#79/#119 pokazały, że lista
// wpisana ręcznie gubi trasy dopisane później przez inne moduły).
function stripQuery(pathTemplate) {
  return pathTemplate.split('?')[0].replace(/:[A-Za-z][A-Za-z0-9]*/g, 'x');
}

test('read_only: KAŻDA trasa zmieniająca z macierzy tras dostaje 503 (poza zwolnionymi)', async () => {
  const env = { APP_WRITE_MODE: 'read_only' };
  const seen = new Set();
  for (const route of ROUTE_MATRIX) {
    if (route.method === 'GET') continue;
    const pathname = stripQuery(route.path);
    if (seen.has(`${route.method} ${pathname}`)) continue;
    seen.add(`${route.method} ${pathname}`);
    const response = await handlePgRequest(call(null, pathname, { method: route.method, body: {} }), env);
    if (isWriteExempt(pathname)) {
      assert.notEqual(response.status, 503, `${route.id}: trasa zwolniona nie powinna dostać 503`);
      continue;
    }
    assert.equal(response.status, 503, `${route.id} (${route.module}): oczekiwano 503 read_only, otrzymano ${response.status}`);
    const body = await response.clone().json();
    assert.deepEqual(body, { error: 'read_only' }, `${route.id}: nieoczekiwana treść odpowiedzi`);
  }
  // Meta-asercja: macierz nie jest pusta i faktycznie objęła wiele modułów (jak
  // w tests/pg-authz-matrix.test.js) — inaczej test przechodziłby pusty i nic nie sprawdzał.
  const modules = new Set(ROUTE_MATRIX.filter((route) => route.method !== 'GET').map((route) => route.module));
  assert.ok(modules.size >= 10, `spodziewano się tras z co najmniej 10 modułów, jest ${modules.size}`);
});
