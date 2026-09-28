// #176: stan roli (ROLE_STATUS w src/pg/auth.js) — dyrekcja (`principal`) nie ma dziś
// żadnej trasy chronionej. Admin nie tworzy takiego zaproszenia bez świadomej flagi,
// a przydział klasowy dla roli bez tras klasowych jest odrzucany zamiast ciche „nic”.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { ROLE_STATUS } from '../src/pg/auth.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

async function setup(extraEnv = {}) {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y-now', { startsOn: '2026-09-01', endsOn: '2099-08-31' });
  await seedClass(db, { id: 'c-now-1a', schoolYearId: 'y-now', name: '1A' });
  const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  return { db, env: { db, ...extraEnv }, admin };
}

async function call(env, path, { cookie, method = 'GET', body, origin } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie, body, origin }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
const post = (env, path, cookie, body = {}) => call(env, path, { method: 'POST', cookie, body });

test('ROLE_STATUS: principal jest "pending_decision", audit "partial", reszta "active"', () => {
  assert.equal(ROLE_STATUS.principal, 'pending_decision');
  assert.equal(ROLE_STATUS.audit, 'partial');
  for (const role of ['admin', 'board', 'treasurer', 'representative']) assert.equal(ROLE_STATUS[role], 'active');
});

test('zaproszenie principal jest odrzucane (422 role_pending_decision) bez ALLOW_PENDING_ROLES', async () => {
  const { db, env, admin } = await setup();
  try {
    const created = await post(env, '/api/admin/invitations', admin, { email: 'dyrekcja@example.invalid', role: 'principal' });
    assert.equal(created.status, 422);
    assert.equal(created.data.error, 'role_pending_decision');
    // Inne role bez zmian.
    const board = await post(env, '/api/admin/invitations', admin, { email: 'zarzad@example.invalid', role: 'board' });
    assert.equal(board.status, 201);
  } finally { await db.close(); }
});

test('ALLOW_PENDING_ROLES=true wyłącza blokadę; podwójne kliknięcie daje jedno zaproszenie', async () => {
  const { db, env, admin } = await setup({ ALLOW_PENDING_ROLES: 'true' });
  try {
    const first = await post(env, '/api/admin/invitations', admin, { email: 'dyrekcja@example.invalid', role: 'principal' });
    assert.equal(first.status, 201);
    const second = await post(env, '/api/admin/invitations', admin, { email: 'dyrekcja@example.invalid', role: 'principal' });
    assert.equal(second.status, 409);
    assert.equal(second.data.error, 'invitation_pending');
  } finally { await db.close(); }
});

test('przydział classId dla roli bez tras klasowych → 422 class_scope_not_supported (zaproszenie i przydział bezpośredni)', async () => {
  const { db, env, admin } = await setup({ ALLOW_PENDING_ROLES: 'true' });
  try {
    for (const role of ['board', 'treasurer', 'audit', 'principal', 'admin']) {
      const invited = await post(env, '/api/admin/invitations', admin,
        { email: `${role}@example.invalid`, role, classId: 'c-now-1a' });
      assert.equal(invited.status, 422, role);
      assert.equal(invited.data.error, 'class_scope_not_supported', role);
    }
    const { seedUser } = await import('./helpers/pg.js');
    await seedUser(db, { userId: 'u-target' });
    const granted = await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'audit', classId: 'c-now-1a' });
    assert.equal(granted.status, 422);
    assert.equal(granted.data.error, 'class_scope_not_supported');
    // representative z classId nadal działa jak dotychczas.
    const repOk = await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'representative', classId: 'c-now-1a' });
    assert.equal(repOk.status, 201);
  } finally { await db.close(); }
});
