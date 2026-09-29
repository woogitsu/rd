import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createLegacyDb, d1Adapter } from './helpers/parity.js';
import {
  clearSessionCookie, createSessionSecret, hashSecret, isSameOrigin,
  parseCookies, readSessionToken, sessionCookie,
} from '../src/auth.js';

const knownToken = 'A'.repeat(43);

test('session secret is random, URL-safe and stored only as a hash', async () => {
  const first = await createSessionSecret();
  const second = await createSessionSecret();
  assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.tokenHash, await hashSecret(first.secret));
  assert.notEqual(first.secret, second.secret);
  assert.equal(first.tokenHash.length, 64);
});

test('cookie parsing rejects malformed and oversized session values', () => {
  assert.deepEqual(parseCookies('a=1; rd_session=token=part; a=2'), { a: '1', rd_session: 'token=part' });
  assert.equal(readSessionToken(new Request('https://rd.example', { headers: { Cookie: 'rd_session=short' } })), null);
  assert.equal(readSessionToken(new Request('https://rd.example', { headers: { Cookie: `rd_session=${knownToken}` } })), knownToken);
});

test('session cookies are secure and limited to 24 hours', () => {
  assert.match(sessionCookie(knownToken, 999999), /HttpOnly; Secure; SameSite=Lax; Max-Age=86400$/);
  assert.match(clearSessionCookie(), /Max-Age=0$/);
});

test('same-origin validation is strict', () => {
  assert.equal(isSameOrigin(new Request('https://rd.example/api/logout', { headers: { Origin: 'https://rd.example' } })), true);
  assert.equal(isSameOrigin(new Request('https://rd.example/api/logout', { headers: { Origin: 'https://evil.example' } })), false);
});

// #214: wcześniej mockDb zwracał tę samą sesję dla KAŻDEGO SQL, więc testy
// przechodziły także po usunięciu warunków expires_at / revoked_at / disabled_at
// z zapytania w src/auth.js. Teraz działa prawdziwy SQL na SQLite z migracjami D1.
const FUTURE = '2099-01-01 00:00:00';
const PAST = '2000-01-01 00:00:00';
const tokenOf = (char) => char.repeat(43);
const cookieOf = (char) => `rd_session=${tokenOf(char)}`;

async function legacyEnv() {
  const db = createLegacyDb();
  const user = db.prepare('INSERT INTO users (id, email, display_name, disabled_at) VALUES (?, ?, ?, ?)');
  user.run('u1', 'test@example.invalid', 'Osoba Testowa', null);
  user.run('u-off', 'off@example.invalid', 'Osoba Wyłączona', '2026-09-01 00:00:00');
  const session = db.prepare(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, mfa_verified_at, revoked_at)
                              VALUES (?, ?, ?, '2026-09-27 07:00:00', ?, ?, ?)`);
  const rows = [
    ['s-ok', 'u1', 'A', FUTURE, null, null],
    ['s-mfa', 'u1', 'B', FUTURE, '2026-09-27 08:00:00', null],
    ['s-expired', 'u1', 'C', PAST, null, null],
    ['s-revoked', 'u1', 'D', FUTURE, null, '2026-09-26 00:00:00'],
    ['s-disabled', 'u-off', 'E', FUTURE, null, null],
    ['s-logout', 'u1', 'F', FUTURE, null, null],
  ];
  for (const [id, userId, char, expires, mfa, revoked] of rows) {
    session.run(id, userId, await hashSecret(tokenOf(char)), expires, mfa, revoked);
  }
  return { db, env: { DB: d1Adapter(db) } };
}

function sessionRequest(char) {
  return new Request('https://rd.example/api/session', char ? { headers: { Cookie: cookieOf(char) } } : {});
}

test('GET /api/session returns 401 without a valid cookie', async () => {
  const { db, env } = await legacyEnv();
  try {
    const response = await worker.fetch(sessionRequest(), env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
    const unknown = await worker.fetch(sessionRequest('Z'), env);
    assert.equal(unknown.status, 401, 'nieznany, poprawnie sformatowany token');
  } finally { db.close(); }
});

test('GET /api/session returns the active user without exposing the token', async () => {
  const { db, env } = await legacyEnv();
  try {
    const response = await worker.fetch(sessionRequest('A'), env);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.user.id, 'u1');
    assert.equal(data.mfaVerified, false);
    assert.equal(JSON.stringify(data).includes(tokenOf('A')), false);
    const mfa = await (await worker.fetch(sessionRequest('B'), env)).json();
    assert.equal(mfa.mfaVerified, true);
  } finally { db.close(); }
});

test('GET /api/session rejects expired, revoked and disabled-account sessions (real SQL)', async () => {
  const { db, env } = await legacyEnv();
  try {
    for (const [char, why] of [['C', 'wygasła'], ['D', 'cofnięta'], ['E', 'konto wyłączone']]) {
      const response = await worker.fetch(sessionRequest(char), env);
      assert.equal(response.status, 401, `sesja ${why} musi dać 401`);
    }
    // kontrola pozytywna: ta sama baza, ważna sesja przechodzi
    assert.equal((await worker.fetch(sessionRequest('A'), env)).status, 200);
  } finally { db.close(); }
});

test('logout rejects cross-origin requests and revokes a valid session', async () => {
  const { db, env } = await legacyEnv();
  try {
    const blocked = await worker.fetch(new Request('https://rd.example/api/logout', {
      method: 'POST', headers: { Origin: 'https://evil.example', Cookie: cookieOf('F') },
    }), env);
    assert.equal(blocked.status, 403);
    assert.equal(db.prepare("SELECT revoked_at FROM sessions WHERE id = 's-logout'").get().revoked_at, null,
      'żądanie z obcego origin nie cofa sesji');

    const response = await worker.fetch(new Request('https://rd.example/api/logout', {
      method: 'POST', headers: { Origin: 'https://rd.example', Cookie: cookieOf('F') },
    }), env);
    assert.equal(response.status, 204);
    assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.notEqual(db.prepare("SELECT revoked_at FROM sessions WHERE id = 's-logout'").get().revoked_at, null);
    assert.equal((await worker.fetch(sessionRequest('F'), env)).status, 401, 'po wylogowaniu token nie działa');
    const audit = db.prepare("SELECT entity_id FROM audit_events WHERE action = 'session.logout'").all();
    assert.deepEqual(audit.map((row) => row.entity_id), ['s-logout'], 'wylogowanie zapisuje zdarzenie audytu');
  } finally { db.close(); }
});
