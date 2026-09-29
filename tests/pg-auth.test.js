import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgDatabase, poolConfig } from '../src/db.js';
import { createPgHandler, handlePgRequest, ROUTES } from '../src/pg/app.js';
import {
  acceptInvitation, createInvitation, createSession, listOwnSessions, loadSession, revokeInvitation,
  revokeOwnSession, rotateSession, revokeUserSessions, SESSION_TTL_SECONDS,
} from '../src/pg/auth.js';
import { requireAccess, revokeRoleGrant } from '../src/pg/authorization.js';
import { assertNoPii } from '../src/pg/audit.js';
import { resolveRuntime } from '../src/server.js';
import { createTestDb, request, seedClass, seedUser, seedUserSession } from './helpers/pg.js';

const HOUR = 60 * 60 * 1000;
const past = () => new Date(Date.now() - HOUR);

async function withDb(fn) {
  const db = await createTestDb();
  try { return await fn(db, { db }); } finally { await db.close(); }
}

async function body(response) {
  return response.status === 204 ? null : response.json();
}

// Testowa trasa używająca requireAccess — wzór dla modułów finansowych.
const financeProbe = {
  name: 'finance-probe',
  async handle(req, env, url, json) {
    if (url.pathname !== '/api/probe/finance') return null;
    const access = await requireAccess(req, env, {
      roles: ['treasurer'],
      requireMfa: true,
      classId: url.searchParams.get('class') ?? undefined,
      schoolYearId: url.searchParams.get('year') ?? undefined,
    }, json);
    if (access.response) return access.response;
    return json({ ok: true });
  },
};
const classProbe = {
  name: 'class-probe',
  async handle(req, env, url, json) {
    if (url.pathname !== '/api/probe/class') return null;
    const access = await requireAccess(req, env, {
      roles: ['representative', 'board'],
      classId: url.searchParams.get('class'),
      schoolYearId: url.searchParams.get('year'),
    }, json);
    if (access.response) return access.response;
    return json({ ok: true });
  },
};
const failingProbe = {
  name: 'failing-probe',
  async handle(req, env, url) {
    if (url.pathname !== '/api/probe/fail') return null;
    await env.db.query("INSERT INTO users (id,email,display_name) VALUES ('dup','dup@example.invalid','X'), ('dup2','dup@example.invalid','Y')");
    return null;
  },
};
const probeHandler = createPgHandler([...ROUTES, financeProbe, classProbe, failingProbe]);

test('health and unknown routes', async () => withDb(async (db, env) => {
  assert.deepEqual(await body(await handlePgRequest(request('/health'), env)), { status: 'ok' });
  const missing = await handlePgRequest(request('/api/nope'), env);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');
}));

test('valid session returns the same JSON contract as the Worker', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u1', mfa: true });
  const response = await handlePgRequest(request('/api/session', { cookie }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ['expiresAt', 'mfaVerified', 'sessionId', 'user', 'writeMode']);
  assert.equal(data.mfaVerified, true);
  assert.deepEqual(data.user, { id: 'u1', email: 'u1@example.invalid', displayName: 'Test u1' });
  assert.match(data.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  // #143: writeMode informuje panele o trybie tylko do odczytu; poza tym testem
  // (bez APP_WRITE_MODE=read_only) system działa normalnie.
  assert.equal(data.writeMode, 'normal');
}));

test('missing, malformed, unknown, expired, revoked and disabled sessions are rejected', async () => withDb(async (db, env) => {
  const cases = [
    undefined,
    'rd_session=short',
    'rd_session=' + 'A'.repeat(44),
    'rd_session=' + 'A'.repeat(43),
    await seedUserSession(db, { userId: 'expired', expiresAt: past() }),
    await seedUserSession(db, { userId: 'revoked', revoked: true }),
    await seedUserSession(db, { userId: 'disabled', disabled: true }),
  ];
  for (const cookie of cases) {
    for (const path of ['/api/session', '/api/access']) {
      const response = await handlePgRequest(request(path, { cookie }), env);
      assert.equal(response.status, 401, `${path} ${cookie}`);
      assert.deepEqual(await response.json(), { error: 'unauthenticated' });
    }
  }
}));

test('access lists only own active grants; expired and revoked grants are ignored', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, {
    userId: 'rep',
    roles: [
      { role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' },
      { role: 'representative', classId: 'c-2a', schoolYearId: 'y-2026', expiresAt: past() },
      { role: 'board', revoked: true },
    ],
  });
  await seedUserSession(db, { userId: 'other', roles: [{ role: 'admin' }] });
  const response = await handlePgRequest(request('/api/access', { cookie }), env);
  assert.deepEqual(await response.json(), {
    grants: [{ role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026', expiresAt: null }],
    hasActiveRole: true,
  });
}));

// #176: hasActiveRole odzwierciedla ROLE_STATUS (src/pg/auth.js), jedno źródło prawdy
// dla ekranu startowego login/ — konto z samym `principal` nie dostaje listy paneli.
test('access: hasActiveRole is false for principal alone, true once any other role is granted', async () => withDb(async (db, env) => {
  const principalOnly = await seedUserSession(db, { userId: 'dir1', roles: [{ role: 'principal' }] });
  const none = await seedUserSession(db, { userId: 'dir2', roles: [] });
  const withAudit = await seedUserSession(db, { userId: 'dir3', roles: [{ role: 'principal' }, { role: 'audit' }] });
  const access = async (cookie) => (await handlePgRequest(request('/api/access', { cookie }), env)).json();
  assert.equal((await access(principalOnly)).hasActiveRole, false);
  assert.equal((await access(none)).hasActiveRole, false);
  assert.equal((await access(withAudit)).hasActiveRole, true, 'audit ma częściowy dostęp (partial), nie pending_decision');
}));

test('representative cannot reach another class or school year; two representatives of one class both can', async () => withDb(async (db, env) => {
  await seedClass(db, { id: 'c-1a-next', schoolYearId: 'y-2027' });
  const first = await seedUserSession(db, { userId: 'rep1', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' }] });
  const second = await seedUserSession(db, { userId: 'rep2', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' }] });
  const other = await seedUserSession(db, { userId: 'rep3', roles: [{ role: 'representative', classId: 'c-2b', schoolYearId: 'y-2026' }] });
  const status = async (cookie, cls, year) => (await probeHandler(request(`/api/probe/class?class=${cls}&year=${year}`, { cookie }), env)).status;
  assert.equal(await status(first, 'c-1a', 'y-2026'), 200);
  assert.equal(await status(second, 'c-1a', 'y-2026'), 200);
  assert.equal(await status(other, 'c-1a', 'y-2026'), 403);
  assert.equal(await status(first, 'c-2b', 'y-2026'), 403);
  assert.equal(await status(first, 'c-1a-next', 'y-2027'), 403);
  assert.equal(await status(first, 'c-1a', 'y-2027'), 403);
}));

test('principal and audit get no default access to class or finance routes', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'dir', mfa: true, roles: [{ role: 'principal' }, { role: 'audit' }] });
  assert.equal((await probeHandler(request('/api/probe/class?class=c-1a&year=y-2026', { cookie }), env)).status, 403);
  assert.equal((await probeHandler(request('/api/probe/finance', { cookie }), env)).status, 403);
}));

test('finance route requires MFA and a treasurer grant', async () => withDb(async (db, env) => {
  const noMfa = await seedUserSession(db, { userId: 't1', roles: [{ role: 'treasurer' }] });
  const withMfa = await seedUserSession(db, { userId: 't2', mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y-2026' }] });
  const expiredGrant = await seedUserSession(db, { userId: 't3', mfa: true, roles: [{ role: 'treasurer', expiresAt: past() }] });
  const noSession = await probeHandler(request('/api/probe/finance'), env);
  assert.equal(noSession.status, 401);
  assert.equal((await probeHandler(request('/api/probe/finance', { cookie: noMfa }), env)).status, 403);
  assert.equal((await probeHandler(request('/api/probe/finance', { cookie: expiredGrant }), env)).status, 403);
  assert.equal((await probeHandler(request('/api/probe/finance?year=y-2026', { cookie: withMfa }), env)).status, 200);
  assert.equal((await probeHandler(request('/api/probe/finance?year=y-2027', { cookie: withMfa }), env)).status, 403);
}));

test('logout requires same Origin for every unsafe API method', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u1' });
  for (const origin of [false, 'https://evil.test', 'http://rd.test', 'null']) {
    const response = await handlePgRequest(request('/api/logout', { method: 'POST', cookie, origin }), env);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'invalid_origin' });
  }
  const other = await handlePgRequest(request('/api/anything', { method: 'DELETE', cookie, origin: 'https://evil.test' }), env);
  assert.equal(other.status, 403);
  assert.equal((await handlePgRequest(request('/api/session', { cookie }), env)).status, 200);
}));

test('logout revokes the session and audits exactly once, atomically', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u1' });
  const first = await handlePgRequest(request('/api/logout', { method: 'POST', cookie }), env);
  assert.equal(first.status, 204);
  assert.match(first.headers.get('Set-Cookie'), /^rd_session=; .*Max-Age=0$/);
  const second = await handlePgRequest(request('/api/logout', { method: 'POST', cookie }), env);
  assert.equal(second.status, 204);
  assert.equal((await handlePgRequest(request('/api/session', { cookie }), env)).status, 401);
  const { rows } = await db.query("SELECT actor_id, entity_type, metadata_json FROM audit_events WHERE action = 'session.logout'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_id, 'u1');
  const { rows: sessions } = await db.query("SELECT revoked_reason FROM sessions WHERE user_id = 'u1'");
  assert.equal(sessions[0].revoked_reason, 'logout');
}));

test('logout rolls back revocation when the audit insert fails', async () => withDb(async (db) => {
  const cookie = await seedUserSession(db, { userId: 'u1' });
  const failingDb = {
    query: (sql, params) => db.query(sql, params),
    transaction: (fn) => db.transaction((tx) => fn({
      query(sql, params) {
        if (sql.includes('INSERT INTO audit_events')) throw Object.assign(new Error('synthetic'), { code: '57014' });
        return tx.query(sql, params);
      },
    })),
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await handlePgRequest(request('/api/logout', { method: 'POST', cookie }), { db: failingDb });
    assert.equal(response.status, 503);
  } finally { console.error = originalError; }
  assert.equal((await handlePgRequest(request('/api/session', { cookie }), { db })).status, 200);
}));

test('audit log is append-only and role grants are never deleted', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u1', roles: [{ role: 'board' }] });
  await handlePgRequest(request('/api/logout', { method: 'POST', cookie }), env);
  await assert.rejects(db.query("UPDATE audit_events SET action = 'x'"), /append_only/);
  await assert.rejects(db.query('DELETE FROM audit_events'), /append_only/);
  await assert.rejects(db.query('DELETE FROM role_grants'), /cannot_be_deleted/);
  await assert.rejects(db.query("UPDATE role_grants SET role = 'admin'"), /scope_immutable/);
}));

test('role grant revocation takes effect on the next request and is audited', async () => withDb(async (db, env) => {
  await seedUser(db, { userId: 'admin' });
  const cookie = await seedUserSession(db, { userId: 'rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' }] });
  const status = async () => (await probeHandler(request('/api/probe/class?class=c-1a&year=y-2026', { cookie }), env)).status;
  assert.equal(await status(), 200);
  const { rows: [grant] } = await db.query("SELECT id FROM role_grants WHERE user_id = 'rep'");
  assert.equal(await revokeRoleGrant(env, { grantId: grant.id, actorId: 'admin' }), true);
  assert.equal(await revokeRoleGrant(env, { grantId: grant.id, actorId: 'admin' }), false);
  assert.equal(await status(), 403);
  await assert.rejects(db.query('UPDATE role_grants SET revoked_at = NULL, revoked_by = NULL'), /already_revoked/);
  const { rows } = await db.query("SELECT actor_id FROM audit_events WHERE action = 'role_grant.revoked'");
  assert.deepEqual(rows, [{ actor_id: 'admin' }]);
}));

test('session rotation revokes the old secret and keeps the chain', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u1' });
  const session = await loadSession(request('/api/session', { cookie }), env);
  const rotated = await rotateSession(env, session, { mfaVerified: true });
  assert.match(rotated.cookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(await loadSession(request('/api/session', { cookie }), env), null);
  const fresh = await loadSession(request('/api/session', { cookie: `rd_session=${rotated.secret}` }), env);
  assert.equal(fresh.mfaVerified, true);
  const { rows } = await db.query('SELECT rotated_from FROM sessions WHERE id = $1', [rotated.sessionId]);
  assert.equal(rows[0].rotated_from, session.sessionId);
  await assert.rejects(rotateSession(env, session), /session_not_active/);
  const { rows: hashes } = await db.query('SELECT token_hash FROM sessions');
  assert.ok(hashes.every((row) => row.token_hash !== rotated.secret));
}));

test('disabled user cannot get a new session and all sessions can be revoked', async () => withDb(async (db, env) => {
  await seedUser(db, { userId: 'gone', disabled: true });
  await assert.rejects(createSession(db, { userId: 'gone' }), /user_unavailable/);
  await seedUser(db, { userId: 'admin' });
  const a = await seedUserSession(db, { userId: 'u1' });
  const b = await seedUserSession(db, { userId: 'u1' });
  assert.equal(await revokeUserSessions(env, { userId: 'u1', actorId: 'admin' }), 2);
  for (const cookie of [a, b]) assert.equal((await handlePgRequest(request('/api/session', { cookie }), env)).status, 401);
}));

test('invitation is one-time, expires, can be revoked and must match the account email', async () => withDb(async (db, env) => {
  await seedUser(db, { userId: 'admin' });
  await seedClass(db, { id: 'c-1a', schoolYearId: 'y-2026' });
  await seedUser(db, { userId: 'rep', email: 'Rep.Synthetic@example.invalid' });
  await seedUser(db, { userId: 'intruder' });

  await assert.rejects(createInvitation(env, { actorId: 'admin', email: 'x@example.invalid', role: 'representative' }), /class_required/);
  await assert.rejects(createInvitation(env, { actorId: 'admin', email: 'x@example.invalid', role: 'superuser' }), /invalid_role/);
  await assert.rejects(createInvitation(env, { actorId: 'admin', email: 'not-an-email', role: 'board' }), /invalid_email/);
  await assert.rejects(createInvitation(env, { actorId: 'admin', email: 'x@example.invalid', role: 'representative', classId: 'c-1a', schoolYearId: 'y-2027' }), /class_not_in_school_year/);

  const invite = await createInvitation(env, { actorId: 'admin', email: 'rep.synthetic@example.invalid', role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' });
  assert.deepEqual(await acceptInvitation(env, { token: invite.secret, userId: 'intruder' }), { ok: false, error: 'invalid_invitation', reason: 'email_mismatch' });
  assert.deepEqual(await acceptInvitation(env, { token: 'bad', userId: 'rep' }), { ok: false, error: 'invalid_invitation', reason: 'malformed' });
  // Podwójne kliknięcie: FOR UPDATE szereguje oba wywołania, ale kolejność
  // nie jest gwarantowana — wygrywa dokładnie jedno, drugie widzi already_used.
  const doubleClick = await Promise.all([
    acceptInvitation(env, { token: invite.secret, userId: 'rep' }),
    acceptInvitation(env, { token: invite.secret, userId: 'rep' }),
  ]);
  assert.equal(doubleClick.filter((result) => result.ok === true).length, 1);
  assert.deepEqual(doubleClick.filter((result) => !result.ok).map((result) => result.reason), ['already_used']);
  const { rows: grants } = await db.query("SELECT role, class_id, school_year_id, granted_by FROM role_grants WHERE user_id = 'rep'");
  assert.deepEqual(grants, [{ role: 'representative', class_id: 'c-1a', school_year_id: 'y-2026', granted_by: 'admin' }]);

  const revokedInvite = await createInvitation(env, { actorId: 'admin', email: 'rep.synthetic@example.invalid', role: 'board' });
  assert.equal(await revokeInvitation(env, { invitationId: revokedInvite.invitationId, actorId: 'admin' }), true);
  assert.equal((await acceptInvitation(env, { token: revokedInvite.secret, userId: 'rep' })).reason, 'revoked');
  assert.equal(await revokeInvitation(env, { invitationId: invite.invitationId, actorId: 'admin' }), false);

  const expiring = await createInvitation(env, { actorId: 'admin', email: 'rep.synthetic@example.invalid', role: 'board', ttlSeconds: 60 });
  await db.query('ALTER TABLE invitations DISABLE TRIGGER invitations_guard');
  await db.query("UPDATE invitations SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1", [expiring.invitationId]);
  await db.query('ALTER TABLE invitations ENABLE TRIGGER invitations_guard');
  assert.equal((await acceptInvitation(env, { token: expiring.secret, userId: 'rep' })).reason, 'expired');

  const { rows: invitations } = await db.query('SELECT token_hash FROM invitations');
  assert.ok(invitations.every((row) => row.token_hash !== invite.secret && row.token_hash.length === 64));
}));

test('no email addresses reach audit metadata or console logs', async () => withDb(async (db, env) => {
  const logs = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const level of Object.keys(original)) console[level] = (...args) => logs.push(args.join(' '));
  try {
    await seedUser(db, { userId: 'admin' });
    await seedUser(db, { userId: 'rep', email: 'pii.check@example.invalid' });
    const invite = await createInvitation(env, { actorId: 'admin', email: 'pii.check@example.invalid', role: 'board' });
    await acceptInvitation(env, { token: invite.secret, userId: 'rep' });
    const cookie = await seedUserSession(db, { userId: 'rep' });
    await handlePgRequest(request('/api/logout', { method: 'POST', cookie }), env);
    const failed = await probeHandler(request('/api/probe/fail'), env);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'service_unavailable' });
  } finally { Object.assign(console, original); }
  const { rows } = await db.query('SELECT metadata_json::text AS metadata FROM audit_events');
  assert.ok(rows.length >= 4);
  for (const row of rows) assert.doesNotMatch(row.metadata, /@/);
  assert.ok(logs.length >= 1);
  for (const line of logs) assert.doesNotMatch(line, /@|example\.invalid/);
  assert.throws(() => assertNoPii({ email: 'x' }), /audit_metadata_pii/);
  assert.throws(() => assertNoPii({ note: 'a@b.c' }), /audit_metadata_pii/);
}));

test('database wrapper bounds the pool and runs transactions on one client', async () => {
  assert.equal(poolConfig({}, {}).max, 10);
  assert.equal(poolConfig({}, { PG_POOL_MAX: '4' }).max, 4);
  assert.equal(poolConfig({}, { PG_POOL_MAX: '999' }).max, 50);
  assert.equal(poolConfig({}, { PG_POOL_MAX: 'x' }).max, 10);
  assert.ok(poolConfig('postgres://synthetic.invalid/db', {}).statement_timeout > 0);

  const calls = [];
  let released = null;
  const client = { query: async (sql) => { calls.push(sql); return { rows: [{ ok: 1 }] }; }, release: (broken) => { released = broken; } };
  const pool = { connect: async () => client, query: async (sql) => ({ rows: [{ sql }], rowCount: 1 }), end: async () => { calls.push('END'); } };
  const db = createPgDatabase(pool);
  assert.deepEqual(await db.query('SELECT 1', []), { rows: [{ sql: 'SELECT 1' }] });
  assert.equal(await db.transaction(async (tx) => (await tx.query('SELECT $1', [1])).rows[0].ok), 1);
  // #156: po BEGIN transakcja ustawia lock_timeout (SET LOCAL).
  const lockTimeout = "SELECT set_config('lock_timeout', $1, true)";
  assert.deepEqual(calls, ['BEGIN', lockTimeout, 'SELECT $1', 'COMMIT']);
  assert.equal(released, false);
  calls.length = 0;
  await assert.rejects(db.transaction(async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(calls, ['BEGIN', lockTimeout, 'ROLLBACK']);
  await db.close();
  assert.ok(calls.includes('END'));
});

test('server selects PostgreSQL API only when DATABASE_URL is set and never migrates', async () => {
  const legacy = resolveRuntime({});
  assert.equal(legacy.mode, 'legacy');
  let config = null;
  const fakeDb = { query: async () => ({ rows: [] }), transaction: async () => {}, close: async () => {} };
  const pgRuntime = resolveRuntime({ DATABASE_URL: 'postgres://synthetic.invalid/rd' }, { createDatabase: (c) => { config = c; return fakeDb; } });
  assert.equal(pgRuntime.mode, 'postgres');
  assert.equal(pgRuntime.env.db, fakeDb);
  assert.equal(pgRuntime.fetchHandler, handlePgRequest);
  assert.equal(config.connectionString, 'postgres://synthetic.invalid/rd');
  assert.equal('DATABASE_URL' in pgRuntime.env, false);
});

// --- #150: limit bezczynności, absolutny limit rotacji, własne sesje --------

test('#150: sesja bez aktywności dłużej niż limit jest wycofana (idle), z audytem, bez zacierania historii', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-idle' });
  const session = await loadSession(request('/api/session', { cookie }), env);
  assert.ok(session, 'sesja świeżo utworzona jest ważna');
  // Symulacja bezczynności: cofamy last_seen_at poza domyślny limit (30 min).
  // `created_at` jest niezmienne po zapisie (migracja 0082, session_guard_trigger)
  // i tak nie decyduje o bezczynności, gdy last_seen_at jest już ustawione.
  await db.query(
    "UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE id = $1",
    [session.sessionId],
  );
  assert.equal(await loadSession(request('/api/session', { cookie }), env), null, 'sesja bezczynna dłużej niż limit przestaje działać');
  const row = (await db.query('SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1', [session.sessionId])).rows[0];
  assert.ok(row.revoked_at, 'wygaśnięcie z bezczynności jest jawnym wycofaniem, nie cichym zniknięciem');
  assert.equal(row.revoked_reason, 'idle');
  const audit = (await db.query("SELECT * FROM audit_events WHERE entity_id = $1 AND action = 'session.revoked'", [session.sessionId])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].metadata_json.reason, 'idle');

  // Limit skonfigurowany na 0 wyłącza sprawdzenie (tylko do testów/lokalnie).
  const cookie2 = await seedUserSession(db, { userId: 'u-idle2' });
  const session2 = await loadSession(request('/api/session', { cookie: cookie2 }), env);
  await db.query("UPDATE sessions SET last_seen_at = now() - interval '10 hours' WHERE id = $1", [session2.sessionId]);
  assert.ok(await loadSession(request('/api/session', { cookie: cookie2 }), { ...env, SESSION_IDLE_TIMEOUT_SECONDS: '0' }));
}));

test('#150: last_seen_at jest aktualizowany najwyżej raz na okno throttlingu, nie przy każdym żądaniu', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-throttle' });
  const first = await loadSession(request('/api/session', { cookie }), env);
  const afterFirst = (await db.query('SELECT last_seen_at FROM sessions WHERE id = $1', [first.sessionId])).rows[0].last_seen_at;
  assert.ok(afterFirst, 'pierwsze żądanie ustawia last_seen_at (był NULL po utworzeniu)');
  // Drugie żądanie tuż po pierwszym: w oknie throttlingu (5 min) — bez nowego zapisu.
  await loadSession(request('/api/session', { cookie }), env);
  const afterSecond = (await db.query('SELECT last_seen_at FROM sessions WHERE id = $1', [first.sessionId])).rows[0].last_seen_at;
  assert.deepEqual(afterSecond, afterFirst, 'drugie żądanie w oknie throttlingu nie zmienia last_seen_at');
}));

test('#150: rotacja (MFA/zmiana hasła) nie przedłuża absolutnego limitu 24h od pierwszego logowania', async () => withDb(async (db, env) => {
  // `created_at` sesji jest niezmienne po zapisie (migracja 0082,
  // session_guard_trigger), więc symulacja "zalogowała się 23h50m temu"
  // musi ustawić created_at PRZY tworzeniu sesji, nie przez UPDATE po fakcie.
  const almostExpired = new Date(Date.now() - (SESSION_TTL_SECONDS - 10 * 60) * 1000);
  const cookie = await seedUserSession(db, { userId: 'u-rotchain', createdAt: almostExpired, expiresAt: new Date(almostExpired.getTime() + SESSION_TTL_SECONDS * 1000) });
  // last_seen_at (mutowalne — w przeciwieństwie do created_at) musi być świeże,
  // inaczej test padnie na limicie bezczynności zamiast na absolutnym limicie
  // rotacji, który tu badamy: w praktyce sesja miałaby aktywność w tym czasie.
  await db.query("UPDATE sessions SET last_seen_at = now() WHERE user_id = 'u-rotchain'");
  const first = await loadSession(request('/api/session', { cookie }), env);

  const rotated = await rotateSession(env, first, { mfaVerified: true });
  const rotatedExpires = new Date(rotated.expiresAt).getTime();
  // Bez ochrony absolutnego limitu rotacja dałaby ~24h OD TERAZ; z ochroną — najwyżej
  // ~10 minut od teraz (do granicy 24h od PIERWSZEGO logowania), z tolerancją na czas testu.
  const maxExpected = Date.now() + 15 * 60 * 1000;
  assert.ok(rotatedExpires <= maxExpected, `expiresAt nie może przekroczyć absolutnego limitu pierwszej sesji: ${rotated.expiresAt}`);

  // Druga rotacja w łańcuchu (np. kolejne potwierdzenie MFA) nadal respektuje TEN SAM
  // pierwotny limit — nie "24h od drugiej rotacji".
  const secondSession = await loadSession(request('/api/session', { cookie: `rd_session=${rotated.secret}` }), env);
  const rotatedAgain = await rotateSession(env, secondSession, { mfaVerified: true });
  const rotatedAgainExpires = new Date(rotatedAgain.expiresAt).getTime();
  assert.ok(rotatedAgainExpires <= maxExpected, `łańcuch rotacji nie przedłuża absolutnego limitu: ${rotatedAgain.expiresAt}`);
}));

test('#150: własne sesje — lista tylko swoich, cofnięcie cudzej sesji nic nie zmienia', async () => withDb(async (db, env) => {
  const cookieA1 = await seedUserSession(db, { userId: 'u-sess-a' });
  const cookieA2 = await seedUserSession(db, { userId: 'u-sess-a' });
  const cookieB = await seedUserSession(db, { userId: 'u-sess-b' });
  const sessA1 = await loadSession(request('/api/session', { cookie: cookieA1 }), env);
  const sessA2 = await loadSession(request('/api/session', { cookie: cookieA2 }), env);
  const sessB = await loadSession(request('/api/session', { cookie: cookieB }), env);

  const listed = await listOwnSessions(env, sessA1);
  assert.equal(listed.length, 2, 'tylko własne sesje konta u-sess-a');
  assert.ok(listed.every((row) => !('ip' in row) && !('userAgent' in row)), 'bez IP i User-Agent (minimalizacja)');
  assert.deepEqual(listed.find((row) => row.id === sessA1.sessionId)?.current, true);
  assert.deepEqual(listed.find((row) => row.id === sessA2.sessionId)?.current, false);

  // Cudza sesja: `false` (jak brak obiektu, SR-07) — nic się nie zmienia w bazie.
  assert.equal(await revokeOwnSession(env, sessA1, sessB.sessionId), false);
  assert.equal((await db.query('SELECT revoked_at FROM sessions WHERE id = $1', [sessB.sessionId])).rows[0].revoked_at, null);

  // Własna, ale INNA sesja (inne urządzenie): cofnięta, bieżąca (sessA1) zostaje.
  assert.equal(await revokeOwnSession(env, sessA1, sessA2.sessionId), true);
  assert.ok((await db.query('SELECT revoked_at FROM sessions WHERE id = $1', [sessA2.sessionId])).rows[0].revoked_at);
  assert.equal(await loadSession(request('/api/session', { cookie: cookieA1 }), env) !== null, true, 'bieżąca sesja zostaje aktywna');

  // Podwójne kliknięcie „Wyloguj to urządzenie”: drugie wywołanie na już wycofanej sesji -> false.
  assert.equal(await revokeOwnSession(env, sessA1, sessA2.sessionId), false);
}));

test('bodyLimit: POST /api/news-photos/:id/file has its own higher limit, independent of DOCUMENT_MAX_BYTES', async () => {
  const fakeDb = { query: async () => ({ rows: [] }), transaction: async () => {}, close: async () => {} };
  const { bodyLimit } = resolveRuntime(
    { DATABASE_URL: 'postgres://synthetic.invalid/rd', DOCUMENT_MAX_BYTES: String(2 * 1024 * 1024) },
    { createDatabase: () => fakeDb },
  );
  const photoUrl = new URL('https://rd.example.invalid/api/news-photos/abc/file');
  const docUrl = new URL('https://rd.example.invalid/api/documents');
  const otherUrl = new URL('https://rd.example.invalid/api/news-photos');
  assert.equal(bodyLimit(photoUrl, 'POST'), 10 * 1024 * 1024);
  assert.equal(bodyLimit(docUrl, 'POST'), 2 * 1024 * 1024);
  assert.notEqual(bodyLimit(otherUrl, 'POST'), 10 * 1024 * 1024);
  // GET nie zmienia limitu (żadna z tras nie przesyła ciała).
  assert.notEqual(bodyLimit(photoUrl, 'GET'), 10 * 1024 * 1024);
});
