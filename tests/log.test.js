import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, createRequestMetrics, redactFields, redactString, sanitizePath, startMetricsReporter } from '../src/log.js';

// Wyłącznie dane syntetyczne (.invalid, przykładowy IBAN z dokumentacji ECBS).
function capture(level = 'debug') {
  const lines = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line), now: () => new Date('2026-09-27T10:00:00Z') });
  return { logger, lines, entries: () => lines.map((line) => JSON.parse(line)) };
}

test('log entry is a single JSON line with level, event and technical fields', () => {
  const { logger, lines, entries } = capture();
  logger.info('http_request', { method: 'GET', path: '/api/payments/:id', status: 200, duration_ms: 12, module: 'payments' });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /\n/);
  assert.deepEqual(entries()[0], {
    method: 'GET', path: '/api/payments/:id', status: 200, duration_ms: 12, module: 'payments',
    time: '2026-09-27T10:00:00.000Z', level: 'info', event: 'http_request', message: 'http_request',
  });
});

test('level threshold filters entries; invalid event codes are replaced', () => {
  const { logger, entries } = capture('warn');
  logger.debug('a_debug');
  logger.info('an_info');
  logger.warn('Some free text with jan@example.invalid');
  logger.error('an_error', { level: 'debug', event: 'spoofed' });
  assert.deepEqual(entries().map((entry) => [entry.level, entry.event]), [['warn', 'invalid_event'], ['error', 'an_error']]);
  const silent = capture('silent');
  silent.logger.error('an_error');
  assert.equal(silent.lines.length, 0);
});

test('redaction drops sensitive field names (emails, names, cookies, tokens, IBAN, bodies)', () => {
  const fields = redactFields({
    email: 'rodzic@example.invalid',
    parentEmail: 'rodzic@example.invalid',
    first_name: 'Anna',
    lastName: 'Testowa',
    displayName: 'Anna Testowa',
    cookie: 'rd_session=abc',
    authorization: 'Bearer abc',
    token: 'abc',
    sessionId: 's-1',
    iban: 'BE68539007547034',
    body: { amount: 10 },
    query: 'q=1',
    status: 500,
    module: 'payments',
  });
  assert.deepEqual(fields, { status: 500, module: 'payments', redacted: 12 });
});

test('redaction scrubs e-mails, tokens, cookies, query strings and IBAN-like values inside strings', () => {
  const scrub = (value) => redactString(value);
  assert.equal(scrub('/api/payments?email=rodzic@example.invalid&x=1'), '/api/payments');
  assert.equal(scrub('/panel/#token=abc'), '/panel/');
  assert.equal(scrub('kontakt rodzic.test+1@example.invalid'), 'kontakt [email]');
  assert.equal(scrub('Bearer abcDEF123456.ghi'), '[token]');
  assert.equal(scrub('rd_session=Zx81kQ2m; other=1'), 'rd_session=[redacted]; other=1');
  assert.equal(scrub('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'), '[token]');
  assert.equal(scrub('secret 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15e6c15b0f00a08'), 'secret [token]');
  assert.equal(scrub('konto BE68 5390 0754 7034'), 'konto [iban]');
  assert.equal(scrub('konto BE68539007547034'), 'konto [iban]');
  assert.equal(scrub('PL61 1090 1014 0000 0712 1981 2874 wpłata'), '[iban] wpłata');
  assert.equal(scrub('payments_create'), 'payments_create');
  assert.equal(scrub('x'.repeat(500)).length, 201);
});

test('nested values, errors and dates are redacted recursively', () => {
  const error = Object.assign(new Error('duplicate key (email)=(rodzic@example.invalid)'), { code: '23505', detail: 'Key (email)=(rodzic@example.invalid)' });
  const fields = redactFields({ error, context: { module: 'auth', note: 'rodzic@example.invalid', phone: '+32 000' }, at: new Date('2026-01-01T00:00:00Z') });
  assert.deepEqual(fields, { error: { code: '23505', kind: 'Error' }, context: { module: 'auth', note: '[email]' }, at: '2026-01-01T00:00:00.000Z' });
  assert.doesNotMatch(JSON.stringify(fields), /@|duplicate/);
});

test('logger output never contains e-mails, cookies or query strings passed by mistake', () => {
  const { logger, lines } = capture();
  logger.error('api_route_error', {
    module: 'payments',
    path: '/api/payments/12?email=rodzic@example.invalid',
    headers: { cookie: 'rd_session=Zx81kQ2m' },
    note: 'Cookie: rd_session=Zx81kQ2m9pQ4sT7vX0yB3nC6',
    reason: 'IBAN BE68539007547034 rodzic@example.invalid',
  });
  const [line] = lines;
  assert.doesNotMatch(line, /@|rd_session=Z|BE68|\?email/);
  assert.match(line, /"path":"\/api\/payments\/12"/);
});

test('sanitizePath strips query strings and replaces id-like segments', () => {
  assert.equal(sanitizePath('/api/payments/123?x=1'), '/api/payments/:id');
  assert.equal(sanitizePath('/api/households/4f5b0c2e-8d1a-4c7e-9a3b-2e6f1d0c9b8a/payments'), '/api/households/:id/payments');
  assert.equal(sanitizePath('/api/users/rodzic%40example.invalid'), '/api/users/:id');
  assert.equal(sanitizePath('/api/events/ev-2026-0042'), '/api/events/:id');
  assert.equal(sanitizePath('/api/x/Zx81kQ2m9pQ4sT7vX0yB3nC6Zx81kQ2m9pQ4sT7vX0yB3nC6'), '/api/x/:id');
  assert.equal(sanitizePath('/panel/assets/index-BdX12abc.js'), '/panel/assets/index-BdX12abc.js');
  assert.equal(sanitizePath('/api/session'), '/api/session');
  assert.equal(sanitizePath('/%E0%A4%A'), '/:id');
  assert.equal(sanitizePath('/health/ready#x'), '/health/ready');
});

test('request metrics count status classes and the reporter logs only non-empty periods', async (t) => {
  const metrics = createRequestMetrics();
  metrics.record(200, 5);
  metrics.record(404, 3);
  metrics.record(503, 40);
  assert.deepEqual(metrics.snapshot(), { requests: 3, status_2xx: 1, status_3xx: 0, status_4xx: 1, status_5xx: 1, duration_ms_total: 48, duration_ms_max: 40 });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { logger, entries } = capture();
  const stop = startMetricsReporter({ metrics, logger, intervalMs: 1000 });
  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  stop();
  const logged = entries();
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, 'http_metrics');
  assert.equal(logged[0].requests, 3);
  assert.equal(logged[0].status_5xx, 1);
  assert.equal(logged[0].duration_ms_avg, 16);
  assert.equal(metrics.snapshot().requests, 0);
});
