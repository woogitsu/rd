// #176: stan roli (ROLE_STATUS w src/pg/auth.js). Dyrekcja (`principal`) ma od 2026-10-02
// odczyt zebrań i sum zbiorczych (status `partial`), więc zaproszenie nie wymaga flagi;
// mechanizm `pending_decision` zostaje dla przyszłych ról (dziś żadna go nie ma).
// Przydział klasowy dla roli bez tras klasowych jest odrzucany zamiast ciche „nic”.
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

test('ROLE_STATUS: principal i audit są "partial", reszta "active", żadna rola nie jest "pending_decision"', () => {
  assert.equal(ROLE_STATUS.principal, 'partial');
  assert.equal(ROLE_STATUS.audit, 'partial');
  for (const role of ['admin', 'board', 'treasurer', 'representative']) assert.equal(ROLE_STATUS[role], 'active');
  const pending = Object.values(ROLE_STATUS).filter((status) => status === 'pending_decision');
  assert.deepEqual(pending, []);
});

test('zaproszenie principal działa bez ALLOW_PENDING_ROLES; podwójne kliknięcie daje jedno zaproszenie', async () => {
  const { db, env, admin } = await setup();
  try {
    const first = await post(env, '/api/admin/invitations', admin, { email: 'dyrekcja@example.invalid', role: 'principal' });
    assert.equal(first.status, 201);
    const second = await post(env, '/api/admin/invitations', admin, { email: 'dyrekcja@example.invalid', role: 'principal' });
    assert.equal(second.status, 409);
    assert.equal(second.data.error, 'invitation_pending');
  } finally { await db.close(); }
});

test('przydział classId dla roli bez tras klasowych → 422 class_scope_not_supported (zaproszenie i przydział bezpośredni)', async () => {
  const { db, env, admin } = await setup();
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
