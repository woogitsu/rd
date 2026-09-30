// #184 pkt 1 i 3: ślad odmowy 403 (bez PII, jedno zdarzenie na okno 5 minut
// z licznikiem w access_denial_windows — migracja 0160, tylko dla zalogowanego
// aktora, także dla żądań zmieniających stan) i zaostrzenie assertNoPii dla
// pól-kodów. Dane wyłącznie syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgHandler, handlePgRequest, ROUTES } from '../src/pg/app.js';
import { logAccessDenied, requireAccess } from '../src/pg/authorization.js';
import { assertNoPii } from '../src/pg/audit.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const financeProbe = {
  name: 'finance-probe',
  async handle(req, env, url, json) {
    if (url.pathname !== '/api/probe/finance') return null;
    const access = await requireAccess(req, env, { roles: ['treasurer'], requireMfa: true }, json);
    if (access.response) return access.response;
    return json({ ok: true });
  },
};
// Trasa klasowa: przedstawiciel ma dostęp wyłącznie do przypisanych klas.
const classProbe = {
  name: 'class-probe',
  async handle(req, env, url, json) {
    const match = /^\/api\/probe\/classes\/([^/]+)$/.exec(url.pathname);
    if (!match) return null;
    const access = await requireAccess(req, env, { roles: ['representative'], classId: match[1], schoolYearId: 'y-test' }, json);
    if (access.response) return access.response;
    return json({ ok: true });
  },
};
const probeHandler = createPgHandler([...ROUTES, financeProbe, classProbe]);

async function withDb(fn) {
  const db = await createTestDb();
  try { return await fn(db, { db }); } finally { await db.close(); }
}

async function accessDeniedEvents(db, actorId) {
  const { rows } = await db.query(
    `SELECT a.id, a.entity_type, a.entity_id, a.metadata_json, w.denial_count, w.method
       FROM audit_events a LEFT JOIN access_denial_windows w ON w.audit_event_id = a.id
      WHERE a.actor_id = $1 AND a.action = 'access.denied' ORDER BY a.occurred_at, a.id`,
    [actorId],
  );
  return rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    route: row.entity_id,
    count: row.denial_count,
    method: row.method,
    metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
  }));
}

const representative = (db, userId) => seedUserSession(db, {
  userId, mfa: true, roles: [{ role: 'representative', classId: 'c-1a' }],
});

test('representative denied a finance route leaves exactly one access.denied event with a window', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep1');
  const res = await probeHandler(request('/api/probe/finance?householdId=h-secret', { cookie }), env);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
  const events = await accessDeniedEvents(db, 'rep1');
  assert.equal(events.length, 1);
  assert.equal(events[0].entityType, 'route');
  // Ścieżka bez parametrów zapytania.
  assert.equal(events[0].route, '/api/probe/finance');
  assert.equal(events[0].metadata.method, 'GET');
  assert.equal(events[0].metadata.requiredRole, 'treasurer');
  assert.equal(typeof events[0].metadata.sessionId, 'string');
  assert.equal(events[0].count, 1);
  // Bez PII: bez adresu e-mail i bez wartości z zapytania w metadanych.
  assert.doesNotMatch(JSON.stringify(events[0].metadata), /@|h-secret/);
  assert.doesNotThrow(() => assertNoPii(events[0].metadata));
}));

test('10 denials within 5 minutes → one event with counter 10; an expired window opens a new event', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep2');
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await probeHandler(request('/api/probe/finance', { cookie }), env)).status, 403);
  }
  const events = await accessDeniedEvents(db, 'rep2');
  assert.equal(events.length, 1);
  assert.equal(events[0].count, 10);

  // Okno sprzed 10 minut innego aktora (tryb odtworzenia — inaczej stempel
  // zegara bazy z 0144 przestawiłby znacznik na now()): wygasłe, więc nowa
  // odmowa otwiera nowe zdarzenie, a stare okno zostaje bez zmian.
  const oldCookie = await representative(db, 'rep2b');
  await db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('rd.restore', 'on', true)`);
    await tx.query(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
       VALUES ('ae-old-denied', 'rep2b', 'access.denied', 'route', '/api/probe/finance', now() - interval '10 minutes', '{"method":"GET"}'::jsonb)`,
    );
    await tx.query(
      `INSERT INTO access_denial_windows (id, audit_event_id, actor_id, method, route, denial_count, first_denied_at, last_denied_at)
       VALUES ('00000000-0000-4000-8000-000000000184', 'ae-old-denied', 'rep2b', 'GET', '/api/probe/finance', 3,
               now() - interval '10 minutes', now() - interval '9 minutes')`,
    );
  });
  assert.equal((await probeHandler(request('/api/probe/finance', { cookie: oldCookie }), env)).status, 403);
  const after = await accessDeniedEvents(db, 'rep2b');
  assert.equal(after.length, 2);
  assert.deepEqual(after.map((event) => event.count), [3, 1]);
}));

test('anonymous 401 (GET and POST) leaves no access.denied event', async () => withDb(async (db, env) => {
  assert.equal((await probeHandler(request('/api/probe/finance'), env)).status, 401);
  assert.equal((await probeHandler(request('/api/probe/finance', { method: 'POST', body: {} }), env)).status, 401);
  const { rows } = await db.query(`SELECT 1 FROM audit_events WHERE action = 'access.denied'`);
  assert.equal(rows.length, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM access_denial_windows')).rows[0].n, 0);
}));

test('state-changing denial: representative POST /api/payments → 403, one access.denied; 10 attempts → counter 10', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep3');
  const body = {
    householdId: 'h1', schoolYearId: 'y-test', amountCents: 7500,
    receivedOn: '2026-09-20', method: 'bank', reference: 'synthetic-reference',
  };
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await handlePgRequest(request('/api/payments', {
      method: 'POST', cookie, body, headers: { 'Idempotency-Key': `rep3-pay-key-${String(i).padStart(4, '0')}` },
    }), env);
    assert.equal(res.status, 403);
  }
  const events = await accessDeniedEvents(db, 'rep3');
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '/api/payments');
  assert.equal(events[0].method, 'POST');
  assert.equal(events[0].metadata.method, 'POST');
  assert.equal(events[0].count, 10);
  // Odmowa nie zapisała nic poza śladem odmowy.
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_entries')).rows[0].n, 0);
  const { rows } = await db.query(`SELECT action FROM audit_events WHERE actor_id = 'rep3'`);
  assert.deepEqual(rows.map((row) => row.action), ['access.denied']);
}));

test('GET and POST on the same path are separate windows', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep4');
  assert.equal((await probeHandler(request('/api/probe/finance', { cookie }), env)).status, 403);
  assert.equal((await probeHandler(request('/api/probe/finance', { method: 'POST', cookie, body: {} }), env)).status, 403);
  assert.equal((await probeHandler(request('/api/probe/finance', { method: 'POST', cookie, body: {} }), env)).status, 403);
  const events = await accessDeniedEvents(db, 'rep4');
  assert.deepEqual(events.map((event) => [event.method, event.count]).sort(), [['GET', 1], ['POST', 2]]);
}));

test('email: representative approving a campaign → 403 and access.denied (POST)', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep5');
  const res = await handlePgRequest(request('/api/email/campaigns/camp-x/approve', {
    method: 'POST', cookie, body: { contentHash: 'a'.repeat(64), recipientsHash: 'b'.repeat(64) },
  }), env);
  assert.equal(res.status, 403);
  const events = await accessDeniedEvents(db, 'rep5');
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '/api/email/campaigns/camp-x/approve');
  assert.equal(events[0].method, 'POST');
}));

test('representative of two classes: own classes pass without an event, a class outside the assignment → 403 + event', async () => withDb(async (db, env) => {
  await seedClass(db, { id: 'c-1c' });
  const cookie = await seedUserSession(db, {
    userId: 'rep6', mfa: true, roles: [{ role: 'representative', classId: 'c-1a' }, { role: 'representative', classId: 'c-1b' }],
  });
  assert.equal((await probeHandler(request('/api/probe/classes/c-1a', { cookie }), env)).status, 200);
  assert.equal((await probeHandler(request('/api/probe/classes/c-1b', { cookie }), env)).status, 200);
  assert.equal((await probeHandler(request('/api/probe/classes/c-1c', { cookie }), env)).status, 403);
  const events = await accessDeniedEvents(db, 'rep6');
  assert.deepEqual(events.map((event) => event.route), ['/api/probe/classes/c-1c']);
}));

test('access_denial_windows: only the counter moves; no rewrite, no delete, no truncate', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep7');
  assert.equal((await probeHandler(request('/api/probe/finance', { cookie }), env)).status, 403);
  await assert.rejects(db.query(`UPDATE access_denial_windows SET route = '/api/other'`), /access_denial_window_immutable/);
  await assert.rejects(db.query('UPDATE access_denial_windows SET denial_count = 0'), /access_denial_window_immutable|check/i);
  await assert.rejects(db.query(`UPDATE access_denial_windows SET first_denied_at = now() - interval '1 hour'`), /access_denial_window_immutable/);
  await assert.rejects(db.query('DELETE FROM access_denial_windows'), /access_denial_windows_cannot_be_deleted/);
  await assert.rejects(db.query('TRUNCATE access_denial_windows'));
  await db.query('UPDATE access_denial_windows SET denial_count = denial_count + 1');
  assert.equal((await accessDeniedEvents(db, 'rep7'))[0].count, 2);
}));

test('failure of the denial log never changes the 403 response', async () => withDb(async (db) => {
  const cookie = await representative(db, 'rep8');
  // Baza, która odmawia każdej transakcji (np. awaria połączenia przy zapisie).
  const broken = new Proxy(db, {
    get(target, key) {
      if (key === 'transaction') return async () => { throw new Error('synthetic_failure'); };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const res = await probeHandler(request('/api/probe/finance', { cookie }), { db: broken });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
  // Bez aktora (kontekst bez sesji) — nic się nie zapisuje.
  await logAccessDenied({ db }, null, { roles: ['treasurer'] }, request('/api/probe/finance'));
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.denied'`)).rows[0].n, 0);
}));

test('admin audit list shows the denial counter on access.denied', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep9');
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await probeHandler(request('/api/probe/finance', { method: 'POST', cookie, body: {} }), env);
  }
  const admin = await seedUserSession(db, { userId: 'adm1', mfa: true, roles: [{ role: 'admin' }] });
  const res = await handlePgRequest(request('/api/admin/audit?domain=access', { cookie: admin }), env);
  assert.equal(res.status, 200);
  const { events } = await res.json();
  const denied = events.filter((event) => event.action === 'access.denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].actorId, 'rep9');
  assert.equal(denied[0].denialCount, 3);
  assert.equal(denied[0].metadata.method, 'POST');
  // Inne zdarzenia nie mają licznika odmów.
  assert.deepEqual(events.filter((event) => event.action !== 'access.denied' && 'denialCount' in event), []);
}));

test('assertNoPii rejects free text in code-only fields, accepts a code', () => {
  assert.throws(() => assertNoPii({ reason: 'Jan Kowalski' }), /audit_metadata_pii/);
  assert.doesNotThrow(() => assertNoPii({ reason: 'user_disabled' }));
  assert.throws(() => assertNoPii({ status: 'Zatwierdzone przez zarząd' }), /audit_metadata_pii/);
  assert.doesNotThrow(() => assertNoPii({ status: 'sending' }));
});
