import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

test('events and meetings are served by the PostgreSQL router with server-side sessions', async () => {
  const db = await createTestDb();
  try {
    const env = { db };
    const publicEvents = await handlePgRequest(request('/api/public/events'), env);
    assert.equal(publicEvents.status, 200);

    for (const path of ['/api/events?schoolYearId=y-test', '/api/meetings?schoolYearId=y-test']) {
      const anonymous = await handlePgRequest(request(path), env);
      assert.equal(anonymous.status, 401, path);
    }

    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: 'y-test' }], mfa: true });
    for (const path of ['/api/events?schoolYearId=y-test', '/api/meetings?schoolYearId=y-test']) {
      const allowed = await handlePgRequest(request(path, { cookie: board }), env);
      assert.equal(allowed.status, 200, path);
    }

    const crossOrigin = await handlePgRequest(request('/api/events', {
      method: 'POST', cookie: board, origin: 'https://evil.example', body: {},
      headers: { 'Idempotency-Key': 'event-cross-origin-1' },
    }), env);
    assert.equal(crossOrigin.status, 403);
  } finally {
    await db.close();
  }
});
