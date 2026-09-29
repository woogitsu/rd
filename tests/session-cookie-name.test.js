import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSessionCookie, clearSessionCookies, createSessionSecret, isLocalAppEnv, readSessionToken, sessionCookie, sessionCookieName,
} from '../src/auth.js';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, TEST_ORIGIN, seedUserSession } from './helpers/pg.js';

const token = 'A'.repeat(43);
const other = 'B'.repeat(43);
const requestWith = (cookie) => new Request('https://rd.example.invalid/api/session', { headers: { Cookie: cookie } });

async function withAppEnv(value, fn) {
  const previous = process.env.APP_ENV;
  if (value === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = value;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previous;
  }
}

test('nazwa cookie zależy od środowiska: lokalnie rd_session, poza lokalnym __Host-rd_session', () => {
  for (const appEnv of [undefined, '', 'development', 'test']) {
    assert.equal(isLocalAppEnv(appEnv), true);
    assert.equal(sessionCookieName(appEnv), 'rd_session');
    assert.match(sessionCookie(token, 3600, appEnv), /^rd_session=/);
  }
  // Nieznana wartość (literówka) = zachowawczo prefiks.
  for (const appEnv of ['staging', 'production', 'prod', 'prodution']) {
    assert.equal(sessionCookieName(appEnv), '__Host-rd_session');
    const cookie = sessionCookie(token, 3600, appEnv);
    assert.match(cookie, /^__Host-rd_session=/);
    // Wymogi prefiksu __Host-: Secure, Path=/, bez Domain.
    assert.match(cookie, /; Path=\/;/);
    assert.match(cookie, /; Secure;/);
    assert.doesNotMatch(cookie, /Domain=/i);
    assert.match(cookie, /HttpOnly; Secure; SameSite=Lax; Max-Age=3600$/);
  }
});

test('domyślna nazwa pochodzi z process.env.APP_ENV', async () => {
  await withAppEnv('production', () => assert.match(sessionCookie(token, 60), /^__Host-rd_session=/));
  await withAppEnv(undefined, () => assert.match(sessionCookie(token, 60), /^rd_session=/));
});

test('odczyt przyjmuje nową i starą nazwę; nowa ma pierwszeństwo; zła wartość odrzucona', () => {
  assert.equal(readSessionToken(requestWith(`__Host-rd_session=${token}`)), token);
  assert.equal(readSessionToken(requestWith(`rd_session=${token}`)), token);
  assert.equal(readSessionToken(requestWith(`rd_session=${other}; __Host-rd_session=${token}`)), token);
  assert.equal(readSessionToken(requestWith(`__Host-rd_session=short; rd_session=${other}`)), other);
  assert.equal(readSessionToken(requestWith('__Host-rd_session=short')), null);
  assert.equal(readSessionToken(requestWith('inne=1')), null);
});

test('czyszczenie: poza lokalnym obie nazwy, lokalnie tylko rd_session', () => {
  const cleared = clearSessionCookies('production');
  assert.equal(cleared.length, 2);
  assert.match(cleared[0], /^__Host-rd_session=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/);
  assert.match(cleared[1], /^rd_session=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/);
  assert.deepEqual(clearSessionCookies('development'), ['rd_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);
  assert.equal(clearSessionCookie('development'), clearSessionCookies('development')[0]);
});

test('sekret sesji z createSessionSecret pasuje do wzorca obu nazw', async () => {
  const { secret } = await createSessionSecret();
  assert.equal(readSessionToken(requestWith(`__Host-rd_session=${secret}`)), secret);
});

test('API w środowisku poza lokalnym: logowanie ustawia __Host-, stare cookie działa, wylogowanie czyści obie nazwy', async () => {
  const db = await createTestDb();
  try {
    await withAppEnv('production', async () => {
      const env = { db, APP_ENV: 'production' };
      const call = (path, cookie, method = 'GET') => handlePgRequest(new Request(`${TEST_ORIGIN}${path}`, {
        method, headers: { Cookie: cookie, ...(method === 'GET' ? {} : { Origin: TEST_ORIGIN }) },
      }), env);
      // Sesja z cookie pod starą nazwą (okres przejściowy) nadal działa…
      const legacy = await seedUserSession(db, { userId: 'u-cookie-legacy' });
      assert.match(legacy, /^rd_session=/);
      assert.equal((await call('/api/session', legacy)).status, 200);
      // …tak samo pod nową nazwą.
      const hostCookie = `__Host-${legacy}`;
      assert.equal((await call('/api/session', hostCookie)).status, 200);
      // Wylogowanie (także podwójne kliknięcie): 204 oba razy, obie nazwy wyczyszczone, jedno zdarzenie audytu.
      const first = await call('/api/logout', hostCookie, 'POST');
      const second = await call('/api/logout', hostCookie, 'POST');
      assert.equal(first.status, 204);
      assert.equal(second.status, 204);
      const setCookies = first.headers.getSetCookie();
      assert.equal(setCookies.length, 2);
      assert.ok(setCookies.some((c) => c.startsWith('__Host-rd_session=;') && c.includes('Max-Age=0') && c.includes('Secure')));
      assert.ok(setCookies.some((c) => c.startsWith('rd_session=;') && c.includes('Max-Age=0')));
      assert.equal((await call('/api/session', hostCookie)).status, 401);
      const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'session.logout'");
      assert.equal(rows[0].n, 1);
    });
  } finally {
    await db.close();
  }
});
