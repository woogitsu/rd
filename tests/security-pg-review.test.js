// Testy regresyjne przeglądu bezpieczeństwa stosu PostgreSQL (docs/SECURITY_REVIEW.md, 2026-09-27).
// Wyłącznie dane syntetyczne (.invalid / .test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeHandler } from '../src/node-app.js';
import { createPgHandler, handlePgRequest, ROUTES } from '../src/pg/app.js';
import { isAuthorizedScoped, requireAccess } from '../src/pg/authorization.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const paymentInput = {
  householdId: 'h-sec-1', schoolYearId: 'y-2026', amountCents: 2500,
  receivedOn: '2026-10-01', method: 'bank', reference: 'SEC-REF',
};

function payment(cookie, key, body = paymentInput) {
  return request('/api/payments', {
    method: 'POST', cookie, body, headers: { 'Idempotency-Key': key },
  });
}

// SR-01: przydział finansowy ograniczony do klasy nie może działać jak przydział szkolny.
test('SR-01: class-scoped treasurer/board/admin grant gives no access to payments', async () => {
  const db = await createTestDb();
  try {
    await seedSchoolYear(db, 'y-2026');
    await db.query("INSERT INTO households (id) VALUES ('h-sec-1')");
    const env = { db };
    const school = await seedUserSession(db, { userId: 'u-sec-school', mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y-2026' }] });
    const created = await handlePgRequest(payment(school, 'sec-key-school-01'), env);
    assert.equal(created.status, 201);
    const paymentId = (await created.json()).payment.id;

    for (const role of ['treasurer', 'board', 'admin']) {
      const cookie = await seedUserSession(db, {
        userId: `u-sec-class-${role}`, mfa: true, roles: [{ role, classId: 'c-sec-1a', schoolYearId: 'y-2026' }],
      });
      const responses = [
        await handlePgRequest(request('/api/payments?schoolYearId=y-2026', { cookie }), env),
        await handlePgRequest(payment(cookie, `sec-key-${role}-01`), env),
        await handlePgRequest(request(`/api/payments/${paymentId}/corrections`, {
          method: 'POST', cookie, body: { amountCents: 100, reason: 'Próba klasy' }, headers: { 'Idempotency-Key': `sec-key-${role}-02` },
        }), env),
      ];
      for (const response of responses) {
        assert.equal(response.status, 403, role);
        assert.deepEqual(await response.json(), { error: 'forbidden' });
      }
    }
    assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM payment_entries')).rows[0].n), 1);
    assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM payment_corrections')).rows[0].n), 0);

    const list = await handlePgRequest(request('/api/payments?schoolYearId=y-2026', { cookie: school }), env);
    assert.equal(list.status, 200);
  } finally {
    await db.close();
  }
});

// SR-02: requireAccess bez classId pomija przydziały klasowe.
test('SR-02: requireAccess without classId ignores class-scoped grants', async () => {
  const db = await createTestDb();
  try {
    const env = { db };
    const probe = {
      name: 'scope-probe',
      async handle(req, _env, url, json) {
        if (url.pathname !== '/api/probe/scope') return null;
        const classId = url.searchParams.get('class') ?? undefined;
        const access = await requireAccess(req, _env, { roles: ['board', 'representative'], classId, schoolYearId: 'y-2026' }, json);
        return access.response ?? json({ ok: true });
      },
    };
    const handler = createPgHandler([...ROUTES, probe]);
    const rep = await seedUserSession(db, { userId: 'u-sec-rep', roles: [{ role: 'representative', classId: 'c-sec-1a', schoolYearId: 'y-2026' }] });
    // Zarząd z sesją MFA (bramka MFA routera); test dotyczy zakresu, nie MFA.
    const classBoard = await seedUserSession(db, { userId: 'u-sec-cboard', roles: [{ role: 'board', classId: 'c-sec-1a', schoolYearId: 'y-2026' }], mfa: true });
    const board = await seedUserSession(db, { userId: 'u-sec-board', roles: [{ role: 'board', schoolYearId: 'y-2026' }], mfa: true });
    const status = async (cookie, query = '') => (await handler(request(`/api/probe/scope${query}`, { cookie }), env)).status;
    assert.equal(await status(rep), 403);
    assert.equal(await status(classBoard), 403);
    assert.equal(await status(board), 200);
    assert.equal(await status(rep, '?class=c-sec-1a'), 200);
    assert.equal(await status(rep, '?class=c-sec-2b'), 403);
    assert.equal(await status(board, '?class=c-sec-2b'), 200);
  } finally {
    await db.close();
  }

  const context = { session: { user: { id: 'u' }, mfaVerified: true }, grants: [{ role: 'treasurer', classId: 'c1', schoolYearId: null }] };
  assert.equal(isAuthorizedScoped(context, { roles: ['treasurer'] }), false);
  assert.equal(isAuthorizedScoped(context, { roles: ['treasurer'], classId: 'c1' }), true);
});

// SR-03: linia żądania w formie absolutnej nie zmienia originu z PUBLIC_BASE_URL.
test('SR-03: absolute-form request target cannot override PUBLIC_BASE_URL origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-sec-'));
  const seen = [];
  const handler = createNodeHandler({
    distRoot: root,
    publicBaseUrl: 'https://rd.test',
    fetchHandler: async (req) => { seen.push(req.url); return Response.json({ ok: true }); },
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const send = (target) => new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`POST ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.invalid\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  try {
    await send('http://evil.invalid/api/logout?x=1');
    await send('http://evil.invalid//evil.invalid/api/logout');
    assert.equal(seen[0], 'https://rd.test/api/logout?x=1');
    assert.equal(new URL(seen[1]).origin, 'https://rd.test');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
