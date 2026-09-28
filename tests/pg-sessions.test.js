// #150: GET /api/sessions (lista własnych sesji) i POST /api/sessions/{id}/revoke
// (cofnięcie jednej własnej sesji). Wyłącznie dane syntetyczne (domeny .invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

async function withDb(fn) {
  const db = await createTestDb();
  try { return await fn(db, { db }); } finally { await db.close(); }
}

test('GET /api/sessions: bez sesji 401; z sesją — tylko własne, bez IP/User-Agent', async () => withDb(async (db, env) => {
  const anon = await handlePgRequest(request('/api/sessions'), env);
  assert.equal(anon.status, 401);

  const cookieA1 = await seedUserSession(db, { userId: 'u-ses-a' });
  const cookieA2 = await seedUserSession(db, { userId: 'u-ses-a' });
  await seedUserSession(db, { userId: 'u-ses-b' }); // inne konto — nie może być widoczne

  const response = await handlePgRequest(request('/api/sessions', { cookie: cookieA1 }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const { sessions } = await response.json();
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s) => Object.keys(s).sort().join(','))[0], 'createdAt,current,id,lastSeenAt,mfaVerified');
  for (const row of sessions) {
    for (const forbidden of ['ip', 'userAgent', 'ipAddress', 'user_agent']) assert.equal(forbidden in row, false);
  }
  const current = sessions.find((s) => s.current);
  assert.ok(current, 'dokładnie jedna sesja jest oznaczona jako bieżąca');
  const other = sessions.find((s) => !s.current);
  assert.ok(other);
  void cookieA2;
}));

test('POST /api/sessions/{id}/revoke: cofa własną (inne urządzenie), 404 na cudzej i nieistniejącej, podwójne kliknięcie', async () => withDb(async (db, env) => {
  const cookieA1 = await seedUserSession(db, { userId: 'u-rev-a' });
  const cookieA2 = await seedUserSession(db, { userId: 'u-rev-a' });
  const cookieB = await seedUserSession(db, { userId: 'u-rev-b' });

  const listA = await (await handlePgRequest(request('/api/sessions', { cookie: cookieA1 }), env)).json();
  const listB = await (await handlePgRequest(request('/api/sessions', { cookie: cookieB }), env)).json();
  const otherOwnId = listA.sessions.find((s) => !s.current).id;
  const otherAccountId = listB.sessions[0].id;

  // Cudza sesja: 404, jak brak obiektu (SR-07) — nie ujawnia jej istnienia.
  const foreign = await handlePgRequest(request(`/api/sessions/${otherAccountId}/revoke`, { method: 'POST', cookie: cookieA1, body: {} }), env);
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).error, 'not_found');

  // Nieistniejący identyfikator: 404.
  const missing = await handlePgRequest(request('/api/sessions/nie-ma-takiej/revoke', { method: 'POST', cookie: cookieA1, body: {} }), env);
  assert.equal(missing.status, 404);

  // Własna, inna sesja (inne urządzenie): 200, cookie tego żądania NIE jest czyszczone.
  const revoke = await handlePgRequest(request(`/api/sessions/${otherOwnId}/revoke`, { method: 'POST', cookie: cookieA1, body: {} }), env);
  assert.equal(revoke.status, 200);
  assert.deepEqual(await revoke.json(), { revoked: true });
  assert.equal(revoke.headers.get('Set-Cookie'), null);
  assert.equal((await handlePgRequest(request('/api/session', { cookie: cookieA2 }), env)).status, 401, 'inne urządzenie jest wylogowane');
  assert.equal((await handlePgRequest(request('/api/session', { cookie: cookieA1 }), env)).status, 200, 'bieżące urządzenie zostaje zalogowane');

  // Podwójne kliknięcie na już wycofanej sesji: drugie 404, nie 200 ponownie.
  const again = await handlePgRequest(request(`/api/sessions/${otherOwnId}/revoke`, { method: 'POST', cookie: cookieA1, body: {} }), env);
  assert.equal(again.status, 404);
}));

test('POST /api/sessions/{id}/revoke na BIEŻĄCEJ sesji czyści cookie (jak /api/logout)', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-rev-self' });
  const { sessions } = await (await handlePgRequest(request('/api/sessions', { cookie }), env)).json();
  const ownId = sessions[0].id;
  const response = await handlePgRequest(request(`/api/sessions/${ownId}/revoke`, { method: 'POST', cookie, body: {} }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie') ?? '', /rd_session=;/);
  assert.equal((await handlePgRequest(request('/api/session', { cookie }), env)).status, 401);
}));

test('GET/POST /api/sessions: metoda i pochodzenie sprawdzane jak inne trasy chronione', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-methods' });
  const wrongMethod = await handlePgRequest(request('/api/sessions', { method: 'POST', cookie, body: {} }), env);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'GET');
  const wrongMethod2 = await handlePgRequest(request('/api/sessions/x/revoke', { cookie }), env);
  assert.equal(wrongMethod2.status, 405);
  assert.equal(wrongMethod2.headers.get('Allow'), 'POST');
  const crossOrigin = await handlePgRequest(request('/api/sessions/x/revoke', {
    method: 'POST', cookie, body: {}, origin: 'https://evil.example.invalid',
  }), env);
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error, 'invalid_origin');
}));
