import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeHandler, JSON_CSP } from '../src/node-app.js';

// #114 (SR-12): macierz nagłówków bezpieczeństwa dla każdej klasy odpowiedzi.
const DOWNLOAD_CSP = "sandbox; default-src 'none'";
const PREVIEW_CSP = "sandbox; default-src 'none'; frame-ancestors 'self'";

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
const close = (server) => new Promise((resolve) => server.close(resolve));

function fakeApi(request) {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/boom') throw new Error('błąd testowy');
  // Odtwarza nagłówki tras dokumentów (src/pg/routes/documents.js), by sprawdzić, że
  // serwer Node ich nie nadpisuje własnymi.
  if (pathname === '/api/documents/x/download') {
    return new Response('%PDF-1.4', { headers: {
      'Content-Type': 'application/pdf', 'Content-Security-Policy': DOWNLOAD_CSP, 'Cache-Control': 'no-store',
    } });
  }
  if (pathname === '/api/documents/x/preview') {
    return new Response('%PDF-1.4', { headers: {
      'Content-Type': 'application/pdf', 'Content-Security-Policy': PREVIEW_CSP, 'X-Frame-Options': 'SAMEORIGIN',
    } });
  }
  return Response.json({ ok: true });
}

test('macierz nagłówków: każda klasa odpowiedzi ma COOP, Permissions-Policy, nosniff, referrer i poprawne CSP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-headers-matrix-'));
  await mkdir(join(root, 'panel'), { recursive: true });
  await writeFile(join(root, 'panel', 'index.html'), '<!doctype html><title>Panel RD</title>');
  const readiness = async () => ({ ready: true, body: { status: 'ready' } });
  const handler = createNodeHandler({
    distRoot: root, fetchHandler: fakeApi, readiness, publicBaseUrl: 'https://rd.example.invalid',
    jobsHealth: async () => ({ ok: true, failedThresholds: [] }), env: { HEALTH_JOBS_TOKEN: 't'.repeat(40) },
    // #116: strona publiczna renderowana przez serwer (src/pg/public-site.js) — atrapa.
    siteHandler: async (req) => (new URL(req.url).pathname === '/site/feed.xml'
      ? new Response('<feed/>', { headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' } })
      : new Response('<p>strona</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
  });
  const { server, baseUrl } = await listen(handler);
  try {
    const get = (path, init) => fetch(`${baseUrl}${path}`, init);
    const classes = [
      { name: 'panel statyczny', response: await get('/panel/'), csp: /default-src 'self'.*frame-ancestors 'none'/, xfo: 'DENY' },
      { name: 'strona publiczna renderowana przez serwer', response: await get('/site/aktualnosci/x'), csp: /default-src 'self'.*frame-ancestors 'none'.*script-src 'self'; style-src 'self'$/, xfo: 'DENY' },
      { name: 'kanał Atom', response: await get('/site/feed.xml'), csp: /default-src 'self'.*frame-ancestors 'none'/, xfo: 'DENY' },
      { name: 'przekierowanie 308', response: await get('/panel', { redirect: 'manual' }), csp: null, xfo: 'DENY' },
      { name: '/api JSON', response: await get('/api/example'), csp: JSON_CSP, xfo: 'DENY' },
      { name: '/api/public JSON', response: await get('/api/public/news'), csp: JSON_CSP, xfo: 'DENY' },
      { name: '/api 500', response: await get('/api/boom'), csp: JSON_CSP, xfo: 'DENY' },
      { name: '/api 413', response: await get('/api/example', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }), csp: JSON_CSP, xfo: 'DENY' },
      { name: '/health/ready', response: await get('/health/ready'), csp: JSON_CSP, xfo: 'DENY' },
      { name: '/health/jobs 401', response: await get('/health/jobs'), csp: JSON_CSP, xfo: 'DENY' },
      { name: '/health/jobs 200', response: await get('/health/jobs', { headers: { authorization: `Bearer ${'t'.repeat(40)}` } }), csp: JSON_CSP, xfo: 'DENY' },
      { name: 'pobranie pliku', response: await get('/api/documents/x/download'), csp: DOWNLOAD_CSP, xfo: 'DENY' },
      // #466: podgląd inline ma własne CSP i SAMEORIGIN — baseline go nie psuje.
      { name: 'podgląd dokumentu inline', response: await get('/api/documents/x/preview'), csp: PREVIEW_CSP, xfo: 'SAMEORIGIN' },
    ];
    for (const { name, response, csp, xfo } of classes) {
      const h = response.headers;
      assert.equal(h.get('x-content-type-options'), 'nosniff', name);
      assert.equal(h.get('referrer-policy'), 'no-referrer', name);
      assert.equal(h.get('cross-origin-opener-policy'), 'same-origin', name);
      assert.equal(h.get('x-frame-options'), xfo, name);
      const policy = h.get('permissions-policy') ?? '';
      for (const feature of ['camera', 'microphone', 'geolocation']) assert.match(policy, new RegExp(`${feature}=\\(\\)`), `${name}: ${feature}`);
      assert.equal(h.get('strict-transport-security'), 'max-age=31536000', name);
      if (csp instanceof RegExp) assert.match(h.get('content-security-policy') ?? '', csp, name);
      else if (csp) assert.equal(h.get('content-security-policy'), csp, name);
    }
    assert.equal((await get('/api/example')).headers.get('cache-control'), 'no-store');
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('HSTS bez includeSubDomains i preload (D-20 otwarta), a bez https w ogóle brak HSTS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-headers-hsts-'));
  try {
    for (const [publicBaseUrl, expected] of [['https://rd.example.invalid', 'max-age=31536000'], ['http://rd.test', null]]) {
      const handler = createNodeHandler({ distRoot: root, fetchHandler: fakeApi, publicBaseUrl, readiness: async () => ({ ready: true, body: {} }) });
      const { server, baseUrl } = await listen(handler);
      try {
        const response = await fetch(`${baseUrl}/api/example`);
        assert.equal(response.headers.get('strict-transport-security'), expected);
        assert.equal(response.headers.get('content-security-policy'), JSON_CSP);
      } finally { await close(server); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trasy dokumentów zachowują własne CSP (pobranie: sandbox, podgląd: sandbox + SAMEORIGIN)', async () => {
  const source = await readFile(new URL('../src/pg/routes/documents.js', import.meta.url), 'utf8');
  assert.ok(source.includes(`'Content-Security-Policy': "${DOWNLOAD_CSP}"`));
  assert.ok(source.includes(`'Content-Security-Policy': "${PREVIEW_CSP}"`));
  assert.ok(source.includes("'X-Frame-Options': 'SAMEORIGIN'"));
});
