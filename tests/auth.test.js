import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  clearSessionCookie, createSessionSecret, hashSecret, isSameOrigin,
  parseCookies, readSessionToken, sessionCookie,
} from '../src/auth.js';

const knownToken = 'A'.repeat(43);

function mockDb(session = null) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...values) {
          const statement = { sql, values, first: async () => session, run: async () => ({ success: true }) };
          calls.push(statement);
          return statement;
        },
      };
    },
    async batch(statements) { calls.push({ batch: statements }); return statements.map(() => ({ success: true })); },
  };
}

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

test('GET /api/session returns 401 without a valid cookie', async () => {
  const response = await worker.fetch(new Request('https://rd.example/api/session'), { DB: mockDb() });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthenticated' });
});

test('GET /api/session returns the active user without exposing the token', async () => {
  const DB = mockDb({
    session_id: 's1', expires_at: '2026-09-28T00:00:00Z', mfa_verified_at: null,
    user_id: 'u1', email: 'test@example.org', display_name: 'Osoba Testowa',
  });
  const request = new Request('https://rd.example/api/session', { headers: { Cookie: `rd_session=${knownToken}` } });
  const response = await worker.fetch(request, { DB });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.user.id, 'u1');
  assert.equal(data.mfaVerified, false);
  assert.equal(JSON.stringify(data).includes(knownToken), false);
  assert.equal(DB.calls[0].values[0], await hashSecret(knownToken));
});

test('logout rejects cross-origin requests and revokes a valid session atomically', async () => {
  const blockedDb = mockDb();
  const blocked = await worker.fetch(new Request('https://rd.example/api/logout', {
    method: 'POST', headers: { Origin: 'https://evil.example', Cookie: `rd_session=${knownToken}` },
  }), { DB: blockedDb });
  assert.equal(blocked.status, 403);
  assert.equal(blockedDb.calls.length, 0);

  const DB = mockDb({
    session_id: 's1', expires_at: '2026-09-28T00:00:00Z', mfa_verified_at: '2026-09-27T00:00:00Z',
    user_id: 'u1', email: 'test@example.org', display_name: 'Osoba Testowa',
  });
  const response = await worker.fetch(new Request('https://rd.example/api/logout', {
    method: 'POST', headers: { Origin: 'https://rd.example', Cookie: `rd_session=${knownToken}` },
  }), { DB });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal(DB.calls.some(call => call.batch?.length === 2), true);
});
