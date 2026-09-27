// Równoważność API (issue #31/#41): /health, /api/session, /api/access, /api/logout,
// 404, kody błędów i nagłówki — stary Worker (D1) kontra handlePgRequest (PGlite).
// Ten sam scenariusz na tych samych danych syntetycznych; porównanie po normalizacji.
// Wyniki i uzasadnione różnice: docs/EQUIVALENCE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { hashSecret } from '../src/auth.js';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb } from './helpers/pg.js';
import { assertSameScenario, createLegacyDb, createNormalizer, d1Adapter, snapshotResponse } from './helpers/parity.js';

const BASE = 'https://rd.example';
const token = (char) => char.repeat(43);

// Wspólny, syntetyczny stan obu baz. Czas zapisany jako UTC; w D1 w formacie
// CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS'), w PostgreSQL jako TIMESTAMPTZ.
const FIXTURE = {
  users: [
    { id: 'u-admin', email: 'admin@example.invalid', displayName: 'Test Admin' },
    { id: 'u-rep', email: 'rep@example.invalid', displayName: 'Test Przedstawiciel' },
    { id: 'u-none', email: 'none@example.invalid', displayName: 'Test Bez Ról' },
    { id: 'u-off', email: 'off@example.invalid', displayName: 'Test Wyłączony', disabled: '2026-09-01 00:00:00' },
  ],
  grants: [
    { id: 'g-admin', userId: 'u-admin', role: 'admin' },
    { id: 'g-rep', userId: 'u-rep', role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' },
    { id: 'g-rep-b', userId: 'u-rep', role: 'representative', classId: 'c-1b', schoolYearId: 'y-2026', expiresAt: '2099-06-30 00:00:00' },
    { id: 'g-rep-old', userId: 'u-rep', role: 'treasurer', schoolYearId: 'y-2026', expiresAt: '2001-01-01 00:00:00' },
    { id: 'g-off', userId: 'u-off', role: 'board' },
  ],
  sessions: [
    { id: 's-admin', userId: 'u-admin', token: token('A'), expiresAt: '2099-01-01 00:00:00', mfa: '2026-09-27 08:00:00' },
    { id: 's-rep', userId: 'u-rep', token: token('B'), expiresAt: '2099-01-01 00:00:00' },
    { id: 's-none', userId: 'u-none', token: token('C'), expiresAt: '2099-01-01 00:00:00' },
    { id: 's-off', userId: 'u-off', token: token('D'), expiresAt: '2099-01-01 00:00:00' },
    { id: 's-expired', userId: 'u-rep', token: token('E'), expiresAt: '2000-01-02 00:00:00', createdAt: '2000-01-01 00:00:00' },
    { id: 's-revoked', userId: 'u-rep', token: token('F'), expiresAt: '2099-01-01 00:00:00', revoked: '2026-09-26 00:00:00' },
    { id: 's-logout', userId: 'u-rep', token: token('G'), expiresAt: '2099-01-01 00:00:00' },
  ],
};

const utc = (value) => (value ? `${value.replace(' ', 'T')}Z` : null);

async function legacyBackend() {
  const db = createLegacyDb();
  db.exec(`
    INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ('y-2026', '2026/27', '2026-09-01', '2027-08-31');
    INSERT INTO classes (id, school_year_id, name) VALUES ('c-1a', 'y-2026', '1A'), ('c-1b', 'y-2026', '1B');
  `);
  for (const user of FIXTURE.users) {
    db.prepare('INSERT INTO users (id, email, display_name, disabled_at) VALUES (?, ?, ?, ?)')
      .run(user.id, user.email, user.displayName, user.disabled ?? null);
  }
  for (const grant of FIXTURE.grants) {
    db.prepare('INSERT INTO role_grants (id, user_id, role, class_id, school_year_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(grant.id, grant.userId, grant.role, grant.classId ?? null, grant.schoolYearId ?? null, grant.expiresAt ?? null);
  }
  for (const session of FIXTURE.sessions) {
    db.prepare(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, mfa_verified_at, revoked_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, session.userId, await hashSecret(session.token), session.createdAt ?? '2026-09-27 07:00:00',
        session.expiresAt, session.mfa ?? null, session.revoked ?? null);
  }
  const env = { DB: d1Adapter(db) };
  return {
    kind: 'legacy',
    fetch: (req) => worker.fetch(req, env),
    one: async (sql, ...params) => db.prepare(sql).get(...params),
    close: async () => db.close(),
  };
}

async function pgBackend() {
  const db = await createTestDb();
  await db.exec(`
    INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ('y-2026', '2026/27', '2026-09-01', '2027-08-31');
    INSERT INTO classes (id, school_year_id, name) VALUES ('c-1a', 'y-2026', '1A'), ('c-1b', 'y-2026', '1B');
  `);
  for (const user of FIXTURE.users) {
    await db.query('INSERT INTO users (id, email, display_name, disabled_at) VALUES ($1, $2, $3, $4)',
      [user.id, user.email, user.displayName, utc(user.disabled)]);
  }
  for (const grant of FIXTURE.grants) {
    await db.query('INSERT INTO role_grants (id, user_id, role, class_id, school_year_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [grant.id, grant.userId, grant.role, grant.classId ?? null, grant.schoolYearId ?? null, utc(grant.expiresAt)]);
  }
  for (const session of FIXTURE.sessions) {
    await db.query(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, mfa_verified_at, revoked_at, revoked_reason)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [session.id, session.userId, await hashSecret(session.token), utc(session.createdAt ?? '2026-09-27 07:00:00'),
      utc(session.expiresAt), utc(session.mfa), utc(session.revoked), session.revoked ? 'admin' : null]);
  }
  const env = { db };
  return {
    kind: 'pg',
    fetch: (req) => handlePgRequest(req, env),
    one: async (sql, ...params) => (await db.query(sql.replace(/\?/g, (_, i, s) => `$${s.slice(0, i).split('?').length}`), params)).rows[0],
    close: () => db.close(),
  };
}

function call(path, { method = 'GET', cookie, origin, headers = {} } = {}) {
  const finalHeaders = new Headers(headers);
  if (cookie) finalHeaders.set('Cookie', cookie);
  if (origin) finalHeaders.set('Origin', origin);
  return new Request(new URL(path, BASE), { method, headers: finalHeaders });
}
const cookieOf = (char) => `rd_session=${token(char)}`;
const same = { origin: BASE };

// Scenariusz wspólny dla obu backendów. Kolejność ma znaczenie (wylogowanie).
const SCENARIO = [
  ['health', call('/health')],
  ['health query', call('/health?probe=1')],
  ['health HEAD', call('/health', { method: 'HEAD' })],
  ['health POST', call('/health', { method: 'POST' })],
  ['health with session cookie', call('/health', { cookie: cookieOf('A') })],

  ['session no cookie', call('/api/session')],
  ['session malformed cookie', call('/api/session', { cookie: 'rd_session=short' })],
  ['session unknown token', call('/api/session', { cookie: cookieOf('Z') })],
  ['session expired', call('/api/session', { cookie: cookieOf('E') })],
  ['session revoked', call('/api/session', { cookie: cookieOf('F') })],
  ['session disabled user', call('/api/session', { cookie: cookieOf('D') })],
  ['session representative', call('/api/session', { cookie: cookieOf('B') })],
  ['session admin with MFA', call('/api/session', { cookie: cookieOf('A') })],
  ['session among other cookies', call('/api/session', { cookie: `theme=light; ${cookieOf('C')}; x=1` })],
  ['session duplicate cookie first wins', call('/api/session', { cookie: `${cookieOf('B')}; ${cookieOf('Z')}` })],
  ['session duplicate cookie unknown first', call('/api/session', { cookie: `${cookieOf('Z')}; ${cookieOf('B')}` })],
  ['session POST same origin', call('/api/session', { method: 'POST', cookie: cookieOf('B'), ...same })],
  ['session POST without origin', call('/api/session', { method: 'POST', cookie: cookieOf('B') })],

  ['access no cookie', call('/api/access')],
  ['access expired', call('/api/access', { cookie: cookieOf('E') })],
  ['access disabled user', call('/api/access', { cookie: cookieOf('D') })],
  ['access representative (only assigned classes, no expired grant)', call('/api/access', { cookie: cookieOf('B') })],
  ['access admin', call('/api/access', { cookie: cookieOf('A') })],
  ['access without grants', call('/api/access', { cookie: cookieOf('C') })],
  ['access PUT same origin', call('/api/access', { method: 'PUT', cookie: cookieOf('A'), ...same })],

  ['logout GET', call('/api/logout', { cookie: cookieOf('G') })],
  ['logout without origin', call('/api/logout', { method: 'POST', cookie: cookieOf('G') })],
  ['logout foreign origin', call('/api/logout', { method: 'POST', cookie: cookieOf('G'), origin: 'https://evil.example' })],
  ['logout origin null', call('/api/logout', { method: 'POST', cookie: cookieOf('G'), origin: 'null' })],
  ['logout origin other scheme', call('/api/logout', { method: 'POST', cookie: cookieOf('G'), origin: 'http://rd.example' })],
  ['session still valid after refused logout', call('/api/session', { cookie: cookieOf('G') })],
  ['logout no cookie', call('/api/logout', { method: 'POST', ...same })],
  ['logout unknown token', call('/api/logout', { method: 'POST', cookie: cookieOf('Z'), ...same })],
  ['logout', call('/api/logout', { method: 'POST', cookie: cookieOf('G'), ...same })],
  ['session after logout', call('/api/session', { cookie: cookieOf('G') })],
  ['access after logout', call('/api/access', { cookie: cookieOf('G') })],
  ['logout double click', call('/api/logout', { method: 'POST', cookie: cookieOf('G'), ...same })],
  ['logout expired session', call('/api/logout', { method: 'POST', cookie: cookieOf('E'), ...same })],

  ['root', call('/')],
  ['api prefix', call('/api')],
  ['api slash', call('/api/')],
  ['session trailing slash', call('/api/session/')],
  ['session uppercase path', call('/API/session')],
  ['sessions typo', call('/api/sessions', { cookie: cookieOf('A') })],
  ['unknown api GET', call('/api/unknown')],
  ['unknown api DELETE same origin', call('/api/unknown', { method: 'DELETE', ...same })],
  ['unknown api DELETE without origin', call('/api/unknown', { method: 'DELETE' })],
  ['unknown static path', call('/secret.txt')],

  // Trasy dodane w nowym API (wydarzenia, zebrania): stary Worker ich nie ma.
  ['events without session', call('/api/events')],
  ['public events', call('/api/public/events')],
  ['meetings without session', call('/api/meetings')],
];

// Uzasadnione różnice (opis w docs/EQUIVALENCE.md). Każda inna różnica = błąd testu.
const ALLOWED = {
  'session POST without origin': {
    legacy: { status: 404, error: 'not_found' }, pg: { status: 403, error: 'invalid_origin' },
    reason: 'router PostgreSQL odrzuca każde POST/PUT/PATCH/DELETE pod /api/ bez zgodnego Origin przed wyborem trasy',
  },
  'unknown api DELETE without origin': {
    legacy: { status: 404, error: 'not_found' }, pg: { status: 403, error: 'invalid_origin' },
    reason: 'jak wyżej: kontrola Origin przed dopasowaniem trasy',
  },
  'events without session': {
    legacy: { status: 404, error: 'not_found' }, pg: { status: 401, error: 'unauthenticated' },
    reason: 'nowa trasa (#12), nieobecna w Workerze',
  },
  'public events': {
    legacy: { status: 404, error: 'not_found' }, pg: { status: 200 },
    reason: 'nowa publiczna trasa (#12) z Cache-Control public, max-age=60',
  },
  'meetings without session': {
    legacy: { status: 404, error: 'not_found' }, pg: { status: 401, error: 'unauthenticated' },
    reason: 'nowa trasa (#13), nieobecna w Workerze',
  },
};

async function run(backend) {
  const normalize = createNormalizer({ cursorKeys: [], timestampKeys: ['expiresAt'] });
  const steps = [];
  for (const [label, req] of SCENARIO) {
    const response = await backend.fetch(req.clone());
    steps.push({ label, ...(await snapshotResponse(response, normalize)) });
  }
  return steps;
}

test('session, access, logout, health and 404 match the legacy Worker step by step', async () => {
  const legacy = await legacyBackend();
  const pg = await pgBackend();
  try {
    const expected = await run(legacy);
    const actual = await run(pg);
    assertSameScenario(expected, actual, { allowed: ALLOWED });

    // Scenariusz obejmuje sukcesy i odmowy.
    const statuses = new Set(expected.map((s) => s.status));
    for (const status of [200, 204, 401, 403, 404]) assert.ok(statuses.has(status), `status ${status} exercised`);

    const byLabel = Object.fromEntries(expected.map((s) => [s.label, s]));
    assert.deepEqual(byLabel['access representative (only assigned classes, no expired grant)'].body, {
      grants: [
        { role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026', expiresAt: null },
        { role: 'representative', classId: 'c-1b', schoolYearId: 'y-2026', expiresAt: '2099-06-30T00:00:00.000Z' },
      ],
    });
    assert.equal(byLabel['session admin with MFA'].body.mfaVerified, true);
    assert.equal(byLabel['session representative'].body.mfaVerified, false);
    assert.deepEqual(byLabel.logout.headers, [
      ['cache-control', 'no-store'],
      ['set-cookie', 'rd_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'],
    ]);
    assert.equal(byLabel.logout.body, null);
    for (const label of ['health', 'session no cookie', 'root', 'logout without origin']) {
      assert.deepEqual(byLabel[label].headers, [
        ['cache-control', 'no-store'],
        ['content-type', 'application/json; charset=utf-8'],
        ['x-content-type-options', 'nosniff'],
      ], `JSON headers: ${label}`);
    }
    // Żadna odpowiedź oprócz wylogowania nie ustawia cookie.
    for (const step of [...expected, ...actual]) {
      if (!step.label.startsWith('logout') || step.status !== 204) {
        assert.ok(!step.headers.some(([name]) => name === 'set-cookie'), `no Set-Cookie: ${step.label}`);
      }
    }

    // Skutki w bazie: jedna sesja wycofana, jedno zdarzenie audytu mimo podwójnego kliknięcia.
    for (const backend of [legacy, pg]) {
      const logoutEvents = await backend.one("SELECT count(*) AS n FROM audit_events WHERE action = 'session.logout' AND entity_id = ?", 's-logout');
      assert.equal(Number(logoutEvents.n), 1, `${backend.kind}: one logout audit event`);
      const actor = await backend.one("SELECT actor_id FROM audit_events WHERE action = 'session.logout'");
      assert.equal(actor.actor_id, 'u-rep', `${backend.kind}: audit actor`);
      const revoked = await backend.one('SELECT count(*) AS n FROM sessions WHERE revoked_at IS NOT NULL');
      assert.equal(Number(revoked.n), 2, `${backend.kind}: only s-revoked and s-logout revoked`);
      const all = await backend.one('SELECT count(*) AS n FROM audit_events');
      assert.equal(Number(all.n), 1, `${backend.kind}: refused logouts leave no audit event`);
    }
    // Surowy zapis czasu różni się tylko formatem (SQLite tekst / ISO z PostgreSQL); chwila ta sama.
    const readSession = async (backend) => (await backend.fetch(call('/api/session', { cookie: cookieOf('B') }))).json();
    const [oldBody, newBody] = [await readSession(legacy), await readSession(pg)];
    assert.equal(oldBody.expiresAt, '2099-01-01 00:00:00');
    assert.equal(newBody.expiresAt, '2099-01-01T00:00:00.000Z');
    assert.deepEqual({ ...oldBody, expiresAt: null }, { ...newBody, expiresAt: null });

    // Różnica danych (nie odpowiedzi): PostgreSQL zapisuje powód wycofania.
    assert.equal((await pg.one("SELECT revoked_reason FROM sessions WHERE id = ?", 's-logout')).revoked_reason, 'logout');
  } finally {
    await legacy.close();
    await pg.close();
  }
});

test('database failure returns the same 503 contract and logs no token or e-mail', async () => {
  const legacyEnv = { DB: { prepare() { throw new Error('D1_ERROR: synthetic outage rep@example.invalid'); }, batch() { throw new Error('down'); } } };
  const failing = async () => { throw Object.assign(new Error('synthetic outage rep@example.invalid'), { code: '57P01' }); };
  const pgEnv = { db: { query: failing, transaction: failing } };
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    const steps = [
      ['health', call('/health')],
      ['session', call('/api/session', { cookie: cookieOf('B') })],
      ['access', call('/api/access', { cookie: cookieOf('B') })],
      ['logout', call('/api/logout', { method: 'POST', cookie: cookieOf('B'), ...same })],
      ['session without cookie (no database call)', call('/api/session')],
      ['logout without cookie (no database call)', call('/api/logout', { method: 'POST', ...same })],
    ];
    const results = { legacy: [], pg: [] };
    for (const [label, req] of steps) {
      results.legacy.push({ label, ...(await snapshotResponse(await worker.fetch(req.clone(), legacyEnv))) });
      results.pg.push({ label, ...(await snapshotResponse(await handlePgRequest(req.clone(), pgEnv))) });
    }
    assertSameScenario(results.legacy, results.pg);
    assert.deepEqual(results.pg.map((s) => s.status), [200, 503, 503, 503, 401, 204]);
    assert.deepEqual(results.pg[1].body, { error: 'service_unavailable' });
  } finally {
    console.error = original;
  }
  assert.ok(logged.length >= 3, 'PostgreSQL router logs technical errors');
  for (const line of logged) {
    assert.match(line, /^\[api\] route=session error=57P01$/);
    assert.ok(!line.includes(token('B')) && !line.includes('@'), 'no secrets or e-mail in logs');
  }
});
