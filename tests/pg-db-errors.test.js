// Klasyfikacja błędów bazy w routerze (#156): stany biznesowe -> 409, błędy
// przejściowe -> 503 + Retry-After, reszta -> 503 jak dotychczas; nagłówek
// Allow przy każdym 405. Wyłącznie dane syntetyczne.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDbError } from '../src/pg/db-errors.js';
import { createPgHandler, handlePgRequest, ROUTES } from '../src/pg/app.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

describe('#156: classifyDbError (jednostkowo)', () => {
  test('komunikat triggera zamrożenia roku -> business, 409', () => {
    assert.deepEqual(classifyDbError(new Error('school_year_closed')),
      { error: 'school_year_closed', status: 409, class: 'business' });
    assert.deepEqual(classifyDbError(new Error('school_year_closure_is_final')),
      { error: 'school_year_closed', status: 409, class: 'business' });
  });

  test('SQLSTATE przejściowe -> transient, 503 + retryAfter', () => {
    for (const code of ['40001', '40P01', '55P03']) {
      const error = Object.assign(new Error('x'), { code });
      assert.deepEqual(classifyDbError(error), { error: 'retry_later', status: 503, retryAfter: 1, class: 'transient' });
    }
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    assert.deepEqual(classifyDbError(timeout), { error: 'timeout', status: 503, retryAfter: 5, class: 'transient' });
  });

  test('nieznany błąd -> bug, 503 bez retryAfter (zachowanie sprzed #156)', () => {
    assert.deepEqual(classifyDbError(new Error('cokolwiek nieznanego')),
      { error: 'service_unavailable', status: 503, class: 'bug' });
    assert.deepEqual(classifyDbError(Object.assign(new Error('x'), { code: '23505' })),
      { error: 'service_unavailable', status: 503, class: 'bug' });
  });
});

// Trasa testowa symulująca moduł BEZ własnego mapDatabaseError — dokładnie
// przypadek, który app.js ma teraz klasyfikować zamiast zawsze zwracać 503.
function throwingProbe(errorFactory) {
  return {
    name: 'throwing-probe',
    async handle(req, env, url) {
      if (url.pathname !== '/api/probe/throw') return null;
      throw errorFactory();
    },
  };
}

describe('#156: app.js — siec bezpieczeństwa dla modułu bez własnego mapowania', () => {
  test('nieprzechwycony school_year_closed -> 409, nie 503', async () => {
    const db = await createTestDb();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-1' });
      const handler = createPgHandler([...ROUTES, throwingProbe(() => new Error('school_year_closed'))]);
      const res = await handler(request('/api/probe/throw', { cookie }), { db });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: 'school_year_closed' });
    } finally {
      await db.close();
    }
  });

  test('nieprzechwycony deadlock (40P01) -> 503 z Retry-After', async () => {
    const db = await createTestDb();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-1' });
      const handler = createPgHandler([...ROUTES, throwingProbe(() => Object.assign(new Error('deadlock detected'), { code: '40P01' }))]);
      const res = await handler(request('/api/probe/throw', { cookie }), { db });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('Retry-After'), '1');
      assert.deepEqual(await res.json(), { error: 'retry_later' });
    } finally {
      await db.close();
    }
  });

  test('nieprzechwycony query_canceled (57014) -> 503 z Retry-After: 5', async () => {
    const db = await createTestDb();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-1' });
      const handler = createPgHandler([...ROUTES, throwingProbe(() => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))]);
      const res = await handler(request('/api/probe/throw', { cookie }), { db });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('Retry-After'), '5');
      assert.deepEqual(await res.json(), { error: 'timeout' });
    } finally {
      await db.close();
    }
  });

  test('inny nieznany błąd -> 503 service_unavailable bez Retry-After (bez regresji)', async () => {
    const db = await createTestDb();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-1' });
      const handler = createPgHandler([...ROUTES, throwingProbe(() => new Error('cos innego'))]);
      const res = await handler(request('/api/probe/throw', { cookie }), { db });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('Retry-After'), null);
      assert.deepEqual(await res.json(), { error: 'service_unavailable' });
    } finally {
      await db.close();
    }
  });
});

// Nagłówek Allow przy 405 (RFC 9110 §15.5.6) — luki znalezione w #156.
describe('#156: nagłówek Allow przy 405', () => {
  const cases = [
    ['PATCH', '/api/public/events'],
    ['POST', '/api/public/news'],
    ['DELETE', '/api/meetings'],
    ['DELETE', '/api/admin/grants'],
    ['DELETE', '/api/email/webhooks/brevo'],
    ['DELETE', '/api/email/campaigns'],
    ['DELETE', '/api/reconciliations'],
    ['POST', '/api/reports/audit'],
    ['GET', '/api/import/preview'],
    ['DELETE', '/api/year-close/y-2026'],
    ['DELETE', '/api/year-close/y-2026/start'],
  ];

  test('każda odpowiedź 405 z tras zmienionych w #156 ma nagłówek Allow', async () => {
    const db = await createTestDb();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
      for (const [method, path] of cases) {
        const res = await handlePgRequest(request(path, { method, cookie }), { db });
        if (res.status !== 405) continue; // niektóre kombinacje trafiają w 401/403 wcześniej — to nie jest przedmiotem tego testu
        assert.ok(res.headers.get('Allow'), `${method} ${path} -> 405 bez nagłówka Allow`);
      }
    } finally {
      await db.close();
    }
  });
});
