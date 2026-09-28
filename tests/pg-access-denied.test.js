// #184 pkt 1 i 3: ślad odmowy 403 (bez PII, zdeduplikowany w oknie 5 minut,
// tylko dla zalogowanego aktora) i zaostrzenie assertNoPii dla pól-kodów.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgHandler, ROUTES } from '../src/pg/app.js';
import { requireAccess } from '../src/pg/authorization.js';
import { assertNoPii } from '../src/pg/audit.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

const financeProbe = {
  name: 'finance-probe',
  async handle(req, env, url, json) {
    if (url.pathname !== '/api/probe/finance') return null;
    const access = await requireAccess(req, env, { roles: ['treasurer'], requireMfa: true }, json);
    if (access.response) return access.response;
    return json({ ok: true });
  },
};
const probeHandler = createPgHandler([...ROUTES, financeProbe]);

async function withDb(fn) {
  const db = await createTestDb();
  try { return await fn(db, { db }); } finally { await db.close(); }
}

async function accessDeniedEvents(db, actorId) {
  const { rows } = await db.query(
    `SELECT entity_id, metadata_json FROM audit_events
      WHERE actor_id = $1 AND action = 'access.denied' ORDER BY occurred_at`,
    [actorId],
  );
  return rows.map((row) => ({
    route: row.entity_id,
    metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
  }));
}

test('representative denied a finance route leaves exactly one access.denied event', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'rep1', mfa: true, roles: [{ role: 'representative', classId: 'c-1a' }] });
  const res = await probeHandler(request('/api/probe/finance', { cookie }), env);
  assert.equal(res.status, 403);
  const events = await accessDeniedEvents(db, 'rep1');
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '/api/probe/finance');
  assert.equal(events[0].metadata.requiredRole, 'treasurer');
  assert.equal(typeof events[0].metadata.sessionId, 'string');
  // Bez PII: bez adresu e-mail w metadanych.
  assert.doesNotMatch(JSON.stringify(events[0].metadata), /@/);
}));

test('repeated denial within 5 minutes does not add a second event; a later one does', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'rep2', mfa: true, roles: [{ role: 'representative', classId: 'c-1a' }] });
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await probeHandler(request('/api/probe/finance', { cookie }), env)).status, 403);
  }
  assert.equal((await accessDeniedEvents(db, 'rep2')).length, 1);
  // audit_events jest tylko do dopisywania (nie da się cofnąć czasu istniejącego
  // wiersza) — symulujemy starsze zdarzenie osobnym wstawieniem poza oknem.
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
     VALUES ('ae-old-denied', 'rep2', 'access.denied', 'route', '/api/probe/finance', now() - interval '10 minutes', '{}'::jsonb)`,
  );
  assert.equal((await probeHandler(request('/api/probe/finance', { cookie }), env)).status, 403);
  assert.equal((await accessDeniedEvents(db, 'rep2')).length, 2);
}));

test('anonymous 401 leaves no access.denied event', async () => withDb(async (db, env) => {
  const res = await probeHandler(request('/api/probe/finance'), env);
  assert.equal(res.status, 401);
  const { rows } = await db.query(`SELECT 1 FROM audit_events WHERE action = 'access.denied'`);
  assert.equal(rows.length, 0);
}));

test('denial of a state-changing (POST) request leaves no access.denied event', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'rep3', mfa: true, roles: [{ role: 'representative', classId: 'c-1a' }] });
  const res = await probeHandler(request('/api/probe/finance', { method: 'POST', cookie, body: {} }), env);
  assert.equal(res.status, 403);
  const { rows } = await db.query(`SELECT 1 FROM audit_events WHERE actor_id = 'rep3' AND action = 'access.denied'`);
  // Macierz uprawnień (tests/pg-authz-matrix.test.js) sprawdza, że odmowa
  // żądania zmieniającego stan nie zapisuje niczego, także w audit_events —
  // dlatego ślad odmowy działa wyłącznie dla GET (patrz logAccessDenied).
  assert.equal(rows.length, 0);
}));

test('assertNoPii rejects free text in code-only fields, accepts a code', () => {
  assert.throws(() => assertNoPii({ reason: 'Jan Kowalski' }), /audit_metadata_pii/);
  assert.doesNotThrow(() => assertNoPii({ reason: 'user_disabled' }));
  assert.throws(() => assertNoPii({ status: 'Zatwierdzone przez zarząd' }), /audit_metadata_pii/);
  assert.doesNotThrow(() => assertNoPii({ status: 'sending' }));
});
