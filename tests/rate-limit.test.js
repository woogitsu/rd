// Ogólny limiter żądań (#126, SR-13): progi klas, Retry-After, brak wywołania
// handlera po przekroczeniu, limit współbieżności kosztownych tras, konfiguracja.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeHandler } from '../src/node-app.js';
import { classifyRequest, createRateLimiter, isHeavyPath, rateLimitConfig, RATE_LIMIT_DEFAULTS } from '../src/rate-limit.js';

const args = (pathname, address = '192.0.2.10', cookieHeader = '') => ({ pathname, address, cookieHeader });

test('klasyfikacja: webhook, public, session; poza /api/ brak limitu', () => {
  assert.equal(classifyRequest('/panel/', ''), null);
  assert.equal(classifyRequest('/health/ready', ''), null);
  assert.equal(classifyRequest('/api/email/webhooks/brevo', 'rd_session=abc').cls, 'webhook');
  assert.equal(classifyRequest('/api/public/events', 'rd_session=abc').cls, 'public');
  assert.equal(classifyRequest('/api/meetings/public-minutes', 'rd_session=abc').cls, 'public');
  assert.equal(classifyRequest('/api/payments', '').cls, 'public', 'bez ciasteczka — próg klasy public');
  assert.deepEqual(classifyRequest('/api/payments', 'x=1; rd_session=tajny'), { cls: 'session', session: 'tajny' });
  assert.ok(isHeavyPath('/api/exports') && isHeavyPath('/api/exports/class-roster') && isHeavyPath('/api/import/preview') && isHeavyPath('/api/reports/annual'));
  assert.ok(!isHeavyPath('/api/exportsx') && !isHeavyPath('/api/payments'));
});

test('trasy publiczne: 429 z Retry-After po przekroczeniu progu, okno się odnawia, adresy liczone osobno', () => {
  let time = 1_000_000;
  const limiter = createRateLimiter({ env: { RATE_LIMIT_PUBLIC_PER_MIN: '3' }, now: () => time });
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.acquire(args('/api/public/events')).ok, true);
  const denied = limiter.acquire(args('/api/public/events'));
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfter >= 1 && denied.retryAfter <= 60);
  assert.equal(limiter.acquire(args('/api/public/events', '192.0.2.11')).ok, true, 'inny adres ma własny licznik');
  time += 60_001;
  assert.equal(limiter.acquire(args('/api/public/events')).ok, true, 'nowe okno');
});

test('webhook i sesja mają osobne progi; zalogowane trasy — wyższy domyślny próg', () => {
  const limiter = createRateLimiter({ env: { RATE_LIMIT_WEBHOOK_PER_MIN: '2', RATE_LIMIT_PUBLIC_PER_MIN: '1' } });
  assert.equal(limiter.acquire(args('/api/email/webhooks/brevo')).ok, true);
  assert.equal(limiter.acquire(args('/api/email/webhooks/brevo')).ok, true);
  assert.equal(limiter.acquire(args('/api/email/webhooks/brevo')).ok, false);
  assert.equal(limiter.acquire(args('/api/public/events')).ok, true);
  assert.equal(limiter.acquire(args('/api/public/events')).ok, false);
  // Sesja nie jest blokowana progiem klasy public tego samego adresu.
  for (let i = 0; i < 50; i += 1) assert.equal(limiter.acquire(args('/api/payments', '192.0.2.10', 'rd_session=s1')).ok, true);
  assert.ok(RATE_LIMIT_DEFAULTS.sessionPerWindow > RATE_LIMIT_DEFAULTS.publicPerWindow);
  const strict = createRateLimiter({ env: { RATE_LIMIT_SESSION_PER_MIN: '2' } });
  assert.equal(strict.acquire(args('/api/payments', 'a', 'rd_session=s1')).ok, true);
  assert.equal(strict.acquire(args('/api/payments', 'b', 'rd_session=s1')).ok, true);
  assert.equal(strict.acquire(args('/api/payments', 'c', 'rd_session=s1')).ok, false, 'klucz to sesja, nie adres');
  assert.equal(strict.acquire(args('/api/payments', 'c', 'rd_session=s2')).ok, true);
});

test('kosztowne trasy: limit równoczesnych żądań na sesję, zwolnienie odblokowuje, podwójne zwolnienie jest bezpieczne', () => {
  const limiter = createRateLimiter({ env: { RATE_LIMIT_HEAVY_CONCURRENCY: '2' } });
  const cookie = 'rd_session=s1';
  const first = limiter.acquire(args('/api/exports', 'a', cookie));
  const second = limiter.acquire(args('/api/import/preview', 'a', cookie));
  const third = limiter.acquire(args('/api/reports/annual', 'a', cookie));
  assert.deepEqual([first.ok, second.ok, third.ok], [true, true, false]);
  assert.ok(third.retryAfter > 0);
  assert.equal(limiter.acquire(args('/api/exports', 'a', 'rd_session=s2')).ok, true, 'inna sesja');
  assert.equal(limiter.acquire(args('/api/payments', 'a', cookie)).ok, true, 'zwykła trasa nie jest liczona');
  first.release();
  first.release();
  assert.equal(limiter.acquire(args('/api/exports', 'a', cookie)).ok, true);
  assert.equal(limiter.acquire(args('/api/exports', 'a', cookie)).ok, false, 'podwójne release nie zwolniło drugiego slotu');
});

test('konfiguracja: wyłączenie, próg 0 = brak limitu klasy, błędne wartości → domyślne', () => {
  const off = createRateLimiter({ env: { RATE_LIMIT_DISABLED: '1', RATE_LIMIT_PUBLIC_PER_MIN: '1' } });
  for (let i = 0; i < 20; i += 1) assert.equal(off.acquire(args('/api/public/events')).ok, true);
  const unlimited = createRateLimiter({ env: { RATE_LIMIT_PUBLIC_PER_MIN: '0' } });
  for (let i = 0; i < 1000; i += 1) assert.equal(unlimited.acquire(args('/api/public/events')).ok, true);
  const config = rateLimitConfig({ RATE_LIMIT_PUBLIC_PER_MIN: 'abc', RATE_LIMIT_SESSION_PER_MIN: '-4' });
  assert.equal(config.publicPerWindow, RATE_LIMIT_DEFAULTS.publicPerWindow);
  assert.equal(config.sessionPerWindow, RATE_LIMIT_DEFAULTS.sessionPerWindow);
});

test('pamięć limitera jest ograniczona (MAX_KEYS)', () => {
  const limiter = createRateLimiter({});
  for (let i = 0; i < 25_000; i += 1) limiter.acquire(args('/api/public/events', `10.${i % 250}.${Math.floor(i / 250)}.1`));
  assert.ok(limiter.size() <= 20_000);
});

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('serwer Node: po przekroczeniu progu 429 z Retry-After i BEZ wywołania handlera (bazy); /health i statyki wolne', async () => {
  const distRoot = await mkdtemp(join(tmpdir(), 'rd-rate-'));
  let delegated = 0;
  const fetchHandler = async () => { delegated += 1; return Response.json({ ok: true }); };
  const rateLimiter = createRateLimiter({ env: { RATE_LIMIT_PUBLIC_PER_MIN: '2' } });
  const { server, baseUrl } = await listen(createNodeHandler({
    distRoot, fetchHandler, rateLimiter, readiness: async () => ({ ready: true, body: { status: 'ready' } }),
  }));
  try {
    assert.equal((await fetch(`${baseUrl}/api/public/events`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/public/events`)).status, 200);
    const denied = await fetch(`${baseUrl}/api/public/events`);
    assert.equal(denied.status, 429);
    assert.deepEqual(await denied.json(), { error: 'rate_limited' });
    assert.ok(Number(denied.headers.get('retry-after')) >= 1);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(delegated, 2, 'odrzucone żądanie nie dotarło do handlera');
    const post = await fetch(`${baseUrl}/api/public/guardian-update`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(post.status, 429);
    assert.equal(delegated, 2);
    for (let i = 0; i < 5; i += 1) assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/`, { redirect: 'manual' })).status, 308);
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
  }
});
