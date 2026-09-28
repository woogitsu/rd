// #100: rejestr żądań osób (RODO) — wariant zachowawczy (rejestr i przejścia
// stanu, bez eksportu i bez sprostowania identyfikacyjnego). Wyłącznie dane
// syntetyczne (.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

async function setup() {
  const db = await createTestDb();
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('g-1', 'h-1', 'Anna', 'Testowa', 'opiekun1@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-1', 'h-1', 'Ola', 'Testowa');
  `);
  const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
  return { db, env: { db }, admin, board };
}

async function call(env, path, { cookie, method = 'GET', body } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie, body }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

test('admin tworzy żądanie dostępu dla gospodarstwa; zarząd (do decyzji D-08/D-09) i anonim odrzuceni', async () => {
  const { env, admin, board } = await setup();
  assert.equal((await call(env, '/api/admin/data-requests', { cookie: board })).status, 403);
  assert.equal((await call(env, '/api/admin/data-requests')).status, 401);

  const created = await call(env, '/api/admin/data-requests', {
    method: 'POST', cookie: admin,
    body: { kind: 'access', householdId: 'h-1', receivedOn: '2026-10-01' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.request.status, 'received');
  assert.equal(created.data.request.householdId, 'h-1');

  const list = await call(env, '/api/admin/data-requests', { cookie: admin });
  assert.equal(list.status, 200);
  assert.equal(list.data.requests.length, 1);

  // Bez wskazania obiektu — odrzucone; obiekt nieistniejący — 404.
  const noSubject = await call(env, '/api/admin/data-requests', {
    method: 'POST', cookie: admin, body: { kind: 'access', receivedOn: '2026-10-01' },
  });
  assert.equal(noSubject.status, 400);
  assert.equal(noSubject.data.error, 'subject_required');
  const missingHousehold = await call(env, '/api/admin/data-requests', {
    method: 'POST', cookie: admin, body: { kind: 'access', householdId: 'h-nope', receivedOn: '2026-10-01' },
  });
  assert.equal(missingHousehold.status, 404);
});

test('przejścia stanu: bez cofania, końcowe stany są zamknięte, podwójne kliknięcie nie dubluje zdarzenia', async () => {
  const { env, admin } = await setup();
  const created = await call(env, '/api/admin/data-requests', {
    method: 'POST', cookie: admin, body: { kind: 'erasure', guardianId: 'g-1', receivedOn: '2026-10-01' },
  });
  const id = created.data.request.id;

  const verified = await call(env, `/api/admin/data-requests/${id}/status`, {
    method: 'POST', cookie: admin, body: { status: 'identity_verified' },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.request.status, 'identity_verified');
  assert.equal(verified.data.changed, true);

  // Cofnięcie odrzucone.
  const back = await call(env, `/api/admin/data-requests/${id}/status`, {
    method: 'POST', cookie: admin, body: { status: 'received' },
  });
  assert.equal(back.status, 409);
  assert.equal(back.data.error, 'data_request_status_cannot_go_back');

  // Podwójne kliknięcie tego samego przejścia: bez zmiany, bez drugiego zdarzenia audytu.
  const replay = await call(env, `/api/admin/data-requests/${id}/status`, {
    method: 'POST', cookie: admin, body: { status: 'identity_verified' },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.changed, false);

  const answered = await call(env, `/api/admin/data-requests/${id}/status`, {
    method: 'POST', cookie: admin, body: { status: 'answered', decisionNoteRef: 'protokol-2026-10-05' },
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.data.request.decisionNoteRef, 'protokol-2026-10-05');

  // Stan końcowy jest zamknięty: nawet powtórzenie tego samego statusu jest odrzucone.
  const afterClosed = await call(env, `/api/admin/data-requests/${id}/status`, {
    method: 'POST', cookie: admin, body: { status: 'in_progress' },
  });
  assert.equal(afterClosed.status, 409);

  const { rows } = await env.db.query(
    `SELECT action FROM audit_events WHERE entity_type = 'data_subject_request' AND entity_id = $1 ORDER BY occurred_at`,
    [id],
  );
  assert.deepEqual(rows.map((r) => r.action),
    ['data_subject_request.created', 'data_subject_request.status_changed', 'data_subject_request.status_changed']);
});

test('rejestr jest tylko do dopisywania: tożsamość żądania i historia stanów nie da się usunąć ani cofnąć w bazie', async () => {
  const { env, admin } = await setup();
  const created = await call(env, '/api/admin/data-requests', {
    method: 'POST', cookie: admin, body: { kind: 'access', studentId: 's-1', receivedOn: '2026-10-01' },
  });
  const id = created.data.request.id;
  await assert.rejects(env.db.query('DELETE FROM data_subject_requests WHERE id = $1', [id]),
    /data_subject_request_cannot_be_deleted/);
  await assert.rejects(env.db.query(`UPDATE data_subject_requests SET kind = 'erasure' WHERE id = $1`, [id]),
    /data_subject_request_identity_immutable/);
});

test('wiersz rejestru nie zawiera adresu e-mail ani imienia/nazwiska', async () => {
  const { env, admin } = await setup();
  await call(env, '/api/admin/data-requests', {
    method: 'POST', cookie: admin, body: { kind: 'access', householdId: 'h-1', receivedOn: '2026-10-01' },
  });
  const { rows } = await env.db.query('SELECT * FROM data_subject_requests');
  const text = JSON.stringify(rows);
  assert.doesNotMatch(text, /@/);
  assert.doesNotMatch(text, /Anna|Testowa|Ola/);
});
