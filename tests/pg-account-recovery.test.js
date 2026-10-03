import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { resetPasswordWithToken } from '../src/pg/login.js';
import { createTestDb, request, seedUser, seedUserSession, assertOwnerGuard } from './helpers/pg.js';

// #146: reset hasła/MFA konta chronionego (admin, zarząd, skarbnik) wymaga
// drugiej osoby. Wyłącznie dane syntetyczne (domeny .invalid).

async function setup() {
  const db = await createTestDb();
  const adminA = await seedUserSession(db, { userId: 'u-admin-a', roles: [{ role: 'admin' }], mfa: true });
  const adminB = await seedUserSession(db, { userId: 'u-admin-b', roles: [{ role: 'admin' }], mfa: true });
  const adminC = await seedUserSession(db, { userId: 'u-admin-c', roles: [{ role: 'admin' }], mfa: true });
  await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer' }], mfa: true });
  await seedUser(db, { userId: 'u-plain' });
  return { db, env: { db }, adminA, adminB, adminC };
}

async function call(env, path, { cookie, method = 'GET', body } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie, body }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
const post = (env, path, cookie, body = {}) => call(env, path, { method: 'POST', cookie, body });
const count = async (db, sql, params = []) => (await db.query(sql, params)).rows[0].n;
const events = async (db, prefix) => (await db.query(
  'SELECT actor_id, action, entity_id, metadata_json AS metadata FROM audit_events WHERE action LIKE $1 ORDER BY occurred_at, id', [`${prefix}%`],
)).rows;
const tokens = (db, userId) => count(db, 'SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1', [userId]);

test('reset hasła konta skarbnika: jeden administrator składa tylko wniosek, token nie powstaje', async () => {
  const { db, env, adminA } = await setup();
  try {
    const first = await post(env, '/api/admin/users/u-treasurer/password-reset', adminA, { ttlHours: 3 });
    assert.equal(first.status, 202);
    assert.equal(first.data.token, undefined);
    assert.equal(first.data.request.status, 'pending');
    assert.equal(first.data.request.kind, 'password_reset');
    assert.equal(first.data.created, true);
    assert.equal(await tokens(db, 'u-treasurer'), 0);
    assert.equal((await events(db, 'auth.password_reset_issued')).length, 0);

    // Podwójne kliknięcie: ten sam wniosek, jedno zdarzenie.
    const again = await post(env, '/api/admin/users/u-treasurer/password-reset', adminA, { ttlHours: 3 });
    assert.equal(again.status, 202);
    assert.equal(again.data.request.id, first.data.request.id);
    assert.equal(again.data.created, false);
    assert.equal((await events(db, 'account_recovery.requested')).length, 1);

    // Reset MFA to osobny wniosek.
    const mfa = await post(env, '/api/admin/users/u-treasurer/mfa-reset', adminA, { confirm: 'u-treasurer' });
    assert.equal(mfa.status, 202);
    assert.notEqual(mfa.data.request.id, first.data.request.id);
    assert.equal(mfa.data.request.kind, 'mfa_reset');
    assert.equal((await events(db, 'mfa.reset')).length, 0);
  } finally {
    await db.close();
  }
});

test('konto bez roli chronionej i własne hasło administratora działają bezpośrednio', async () => {
  const { db, env, adminA } = await setup();
  try {
    assert.equal((await post(env, '/api/admin/users/u-plain/password-reset', adminA)).status, 201);
    assert.equal((await post(env, '/api/admin/users/u-admin-a/password-reset', adminA)).status, 201);
    // Wygasły przydział roli nie czyni konta chronionym.
    await seedUserSession(db, { userId: 'u-ex-board', roles: [{ role: 'board', expiresAt: '2020-01-01T00:00:00Z' }], mfa: true });
    assert.equal((await post(env, '/api/admin/users/u-ex-board/password-reset', adminA)).status, 201);
    // Własne MFA nadal zablokowane, bez wniosku.
    const own = await post(env, '/api/admin/users/u-admin-a/mfa-reset', adminA, { confirm: 'u-admin-a' });
    assert.equal(own.status, 409);
    assert.equal(own.data.error, 'cannot_reset_own_mfa');
    assert.equal(await count(db, 'SELECT count(*)::int AS n FROM account_recovery_requests'), 0);
  } finally {
    await db.close();
  }
});

test('zatwierdzenie: wnioskodawca i właściciel konta nie mogą, drugi administrator może, token raz', async () => {
  const { db, env, adminA, adminB, adminC } = await setup();
  try {
    // Cel: administrator B. Wniosek składa A.
    const requested = await post(env, '/api/admin/users/u-admin-b/password-reset', adminA);
    assert.equal(requested.status, 202);
    const approve = `/api/admin/account-requests/${requested.data.request.id}/approve`;

    const self = await post(env, approve, adminA);
    assert.equal(self.status, 403);
    assert.equal(self.data.error, 'recovery_four_eyes_required');
    const owner = await post(env, approve, adminB);
    assert.equal(owner.status, 403);
    assert.equal(owner.data.error, 'recovery_four_eyes_required');
    assert.equal(await tokens(db, 'u-admin-b'), 0);

    const done = await post(env, approve, adminC);
    assert.equal(done.status, 200);
    assert.match(done.data.token, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(done.data.request.status, 'approved');
    assert.equal(done.data.request.decidedBy, 'u-admin-c');
    assert.equal(await tokens(db, 'u-admin-b'), 1);
    assert.equal((await db.query('SELECT created_by, request_id FROM password_reset_tokens WHERE user_id = $1', ['u-admin-b'])).rows[0].created_by, 'u-admin-c');

    // Ponowne kliknięcie: wniosek zamknięty, brak drugiego tokenu i zdarzenia.
    const twice = await post(env, approve, adminC);
    assert.equal(twice.status, 409);
    assert.equal(twice.data.error, 'recovery_request_closed');
    assert.equal(await tokens(db, 'u-admin-b'), 1);
    assert.equal((await events(db, 'account_recovery.approved')).length, 1);

    // Zdarzenie wydania: kto wnioskował i kto zatwierdził.
    const [issued] = await events(db, 'auth.password_reset_issued');
    assert.equal(issued.actor_id, 'u-admin-c');
    assert.equal(issued.metadata.requestedBy, 'u-admin-a');
    assert.equal(issued.metadata.approvedBy, 'u-admin-c');

    // Wykonanie resetu: auth.password_reset_completed ma issuedBy (nie tylko właściciela konta).
    await resetPasswordWithToken(env, { token: done.data.token, newPassword: 'Syntetyczne-Haslo-9137-xq' });
    const [completed] = await events(db, 'auth.password_reset_completed');
    assert.equal(completed.actor_id, 'u-admin-b');
    assert.equal(completed.metadata.issuedBy, 'u-admin-c');
    assert.equal(completed.metadata.requestId, requested.data.request.id);
  } finally {
    await db.close();
  }
});

test('zatwierdzenie resetu MFA przez drugiego administratora wyłącza czynniki; wniosek nie zmienia nic', async () => {
  const { db, env, adminA, adminB } = await setup();
  try {
    await db.query(
      `INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, confirmed_at)
       VALUES ('f-tr', 'u-treasurer', 'totp', 'AAAAAAAAAA', 'BBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCCCC', now())`,
    );
    const requested = await post(env, '/api/admin/users/u-treasurer/mfa-reset', adminA, { confirm: 'u-treasurer' });
    assert.equal(requested.status, 202);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM user_mfa_factors WHERE id = 'f-tr' AND disabled_at IS NULL"), 1);
    const approve = `/api/admin/account-requests/${requested.data.request.id}/approve`;
    assert.equal((await post(env, approve, adminA)).status, 403);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM user_mfa_factors WHERE id = 'f-tr' AND disabled_at IS NULL"), 1);
    const done = await post(env, approve, adminB);
    assert.equal(done.status, 200);
    assert.equal(done.data.mfa.disabledFactors, 1);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM user_mfa_factors WHERE id = 'f-tr' AND disabled_at IS NULL"), 0);
    const [reset] = await events(db, 'mfa.reset');
    assert.equal(reset.actor_id, 'u-admin-b');
    assert.equal(reset.metadata.requestedBy, 'u-admin-a');
  } finally {
    await db.close();
  }
});

test('odrzucenie i wycofanie wniosku: brak tokenu, wniosek zamknięty, można złożyć nowy', async () => {
  const { db, env, adminA, adminB } = await setup();
  try {
    const requested = await post(env, '/api/admin/users/u-treasurer/password-reset', adminA);
    const id = requested.data.request.id;
    const rejected = await post(env, `/api/admin/account-requests/${id}/reject`, adminA);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.request.status, 'rejected');
    const late = await post(env, `/api/admin/account-requests/${id}/approve`, adminB);
    assert.equal(late.status, 409);
    assert.equal(late.data.error, 'recovery_request_closed');
    assert.equal(await tokens(db, 'u-treasurer'), 0);
    const next = await post(env, '/api/admin/users/u-treasurer/password-reset', adminA);
    assert.equal(next.status, 202);
    assert.notEqual(next.data.request.id, id);
    assert.equal((await post(env, '/api/admin/account-requests/brak-takiego/reject', adminB)).data.error, 'recovery_request_not_found');
    const list = await call(env, '/api/admin/account-requests?status=all', { cookie: adminB });
    assert.equal(list.data.requests.length, 2);
    assert.equal((await call(env, '/api/admin/account-requests?status=zly', { cookie: adminB })).status, 400);
  } finally {
    await db.close();
  }
});

test('wygasły wniosek nie wydaje tokenu; nowy wniosek zastępuje wygasły', async () => {
  const { db, env, adminA, adminB } = await setup();
  try {
    await db.query(
      `INSERT INTO account_recovery_requests (id, kind, target_user_id, requested_by, ttl_seconds, created_at, expires_at)
       VALUES ('req-old', 'password_reset', 'u-treasurer', 'u-admin-a', 7200, now() - interval '2 days', now() - interval '1 day')`,
    );
    const expired = await post(env, '/api/admin/account-requests/req-old/approve', adminB);
    assert.equal(expired.status, 409);
    assert.equal(expired.data.error, 'recovery_request_expired');
    assert.equal(await tokens(db, 'u-treasurer'), 0);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM account_recovery_requests WHERE id = 'req-old' AND status = 'expired'"), 1);
    const fresh = await post(env, '/api/admin/users/u-treasurer/password-reset', adminA);
    assert.equal(fresh.status, 202);
    assert.notEqual(fresh.data.request.id, 'req-old');
  } finally {
    await db.close();
  }
});

test('granice ról i MFA: zarząd, skarbnik i stare MFA nie zatwierdzają; baza pilnuje czterech oczu', async () => {
  const { db, env, adminA, adminB } = await setup();
  try {
    const requested = await post(env, '/api/admin/users/u-treasurer/password-reset', adminA);
    const approve = `/api/admin/account-requests/${requested.data.request.id}/approve`;
    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
    const treasurer = await seedUserSession(db, { userId: 'u-tr2', roles: [{ role: 'treasurer' }], mfa: true });
    for (const cookie of [board, treasurer]) {
      assert.equal((await post(env, approve, cookie)).status, 403);
      assert.equal((await call(env, '/api/admin/account-requests', { cookie })).status, 403);
    }
    assert.equal((await call(env, '/api/admin/account-requests')).status, 401);
    await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-admin-b'");
    const stale = await post(env, approve, adminB);
    assert.equal(stale.status, 403);
    assert.equal(stale.data.error, 'mfa_stale');
    assert.equal(await tokens(db, 'u-treasurer'), 0);

    // Bezpośredni UPDATE z pominięciem API: zatwierdzenie przez wnioskodawcę odrzuca CHECK.
    await assert.rejects(
      db.query("UPDATE account_recovery_requests SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE id = $1", [requested.data.request.id]),
      /account_recovery_requests_check|check/i,
    );
    await assertOwnerGuard(db, 'DELETE FROM account_recovery_requests', /account_recovery_request_immutable/);
  } finally {
    await db.close();
  }
});

test('audyt wniosków nie zawiera danych osobowych ani tokenów', async () => {
  const { db, env, adminA, adminB } = await setup();
  try {
    const requested = await post(env, '/api/admin/users/u-treasurer/password-reset', adminA);
    const done = await post(env, `/api/admin/account-requests/${requested.data.request.id}/approve`, adminB);
    const all = JSON.stringify((await db.query('SELECT action, metadata_json FROM audit_events WHERE action LIKE $1 OR action LIKE $2', ['account_recovery.%', 'auth.password_reset%'])).rows);
    assert.doesNotMatch(all, /@|example\.invalid/);
    assert.ok(!all.includes(done.data.token));
    const listing = JSON.stringify((await call(env, '/api/admin/account-requests?status=all', { cookie: adminA })).data);
    assert.ok(!listing.includes(done.data.token));
    assert.doesNotMatch(listing, /@/);
  } finally {
    await db.close();
  }
});
