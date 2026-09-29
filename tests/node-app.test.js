import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineSecurityHeaders, createNodeHandler } from '../src/node-app.js';
import { bodyLimitFor } from '../src/documents.js';

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('Node handler validates required configuration', () => {
  assert.throws(() => createNodeHandler(), /distRoot is required/);
  assert.throws(() => createNodeHandler({ distRoot: '/tmp' }), /fetchHandler is required/);
});

test('Node server serves built applications and delegates API requests safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-node-app-'));
  await mkdir(join(root, 'panel', 'assets'), { recursive: true });
  await writeFile(join(root, 'panel', 'index.html'), '<!doctype html><title>Panel RD</title>');
  await writeFile(join(root, 'panel', 'assets', 'app.js'), 'globalThis.__rd = true;');
  await writeFile(join(root, 'panel', 'assets', 'app.js.map'), '{}');

  let delegated = 0;
  const fetchHandler = async (request) => {
    delegated += 1;
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'public, max-age=60' } });
    }
    if (url.pathname === '/api/example') {
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'public, max-age=60' } });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  const handler = createNodeHandler({ distRoot: root, fetchHandler });
  const { server, baseUrl } = await listen(handler);

  try {
    const redirect = await fetch(`${baseUrl}/panel`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/panel/');

    const html = await fetch(`${baseUrl}/panel/`);
    assert.equal(html.status, 200);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    assert.match(html.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await html.text(), /Panel RD/);

    const asset = await fetch(`${baseUrl}/panel/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=3600');

    const head = await fetch(`${baseUrl}/panel/assets/app.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const sourceMap = await fetch(`${baseUrl}/panel/assets/app.js.map`);
    assert.equal(sourceMap.status, 404);
    assert.deepEqual(await sourceMap.json(), { error: 'not_found' });

    const missing = await fetch(`${baseUrl}/panel/missing.js`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not_found' });

    const api = await fetch(`${baseUrl}/api/example`);
    assert.equal(api.status, 200);
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.equal(api.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.deepEqual(await api.json(), { ok: true });

    // Panel (nie /site/) — noindex, żeby przeglądarki i wyszukiwarki nie
    // indeksowały ekranów wymagających logowania (#116).
    assert.equal(html.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(asset.headers.get('x-robots-tag'), 'noindex, nofollow');

    const beforeLargeRequest = delegated;
    const tooLarge = await fetch(`${baseUrl}/api/example`, {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { error: 'request_too_large' });
    assert.equal(delegated, beforeLargeRequest);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('Node server keeps /site/ and /api/public/ indexable and serves robots.txt (#116)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-node-app-'));
  await mkdir(join(root, 'site'), { recursive: true });
  await writeFile(join(root, 'site', 'index.html'), '<!doctype html><title>Strona RD</title>');

  const fetchHandler = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/public/news') {
      return Response.json({ items: [] }, { headers: { 'Cache-Control': 'public, max-age=60' } });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  const handler = createNodeHandler({ distRoot: root, fetchHandler });
  const { server, baseUrl } = await listen(handler);

  try {
    const site = await fetch(`${baseUrl}/site/`);
    assert.equal(site.status, 200);
    assert.equal(site.headers.get('x-robots-tag'), null);

    const publicApi = await fetch(`${baseUrl}/api/public/news`);
    assert.equal(publicApi.status, 200);
    assert.equal(publicApi.headers.get('x-robots-tag'), null);

    const robots = await fetch(`${baseUrl}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.equal(robots.headers.get('content-type'), 'text/plain; charset=utf-8');
    const body = await robots.text();
    assert.match(body, /Disallow: \/panel\//);
    assert.match(body, /Disallow: \/documents\//);
    assert.match(body, /Disallow: \/api\//);
    assert.match(body, /Allow: \/api\/public\//);
    assert.match(body, /Allow: \/site\//);
    assert.doesNotMatch(body, /Disallow: \/site\//);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('Node server raises the body limit only for the document upload route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-node-app-'));
  const received = [];
  const fetchHandler = async (request) => {
    received.push((await request.arrayBuffer()).byteLength);
    return Response.json({ ok: true });
  };
  const bodyLimit = bodyLimitFor(2 * 1024 * 1024);
  const { server, baseUrl } = await listen(createNodeHandler({ distRoot: root, fetchHandler, bodyLimit }));
  try {
    const body = 'x'.repeat(1024 * 1024 + 1);
    const upload = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body });
    assert.equal(upload.status, 200);
    assert.deepEqual(received, [body.length]);
    const other = await fetch(`${baseUrl}/api/logout`, { method: 'POST', body });
    assert.equal(other.status, 413);
    const tooLarge = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024 + 1) });
    assert.equal(tooLarge.status, 413);
    assert.equal(received.length, 1);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

// #185: POST /api/documents nie może buforować ciała w pamięci przed
// sprawdzeniem sesji. Trasa (fetchHandler symuluje documents.js) odrzuca bez
// sesji BEZ dotykania request.body — serwer nie może przeczytać strumienia
// za nią, więc licznik odebranych bajtów musi zostać na zerze.
test('Node server: POST /api/documents nie czyta ciała, gdy trasa odrzuca przed jego odczytem (np. brak sesji)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-node-app-'));
  let bodyTouched = false;
  const fetchHandler = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/documents') {
      // Symuluje documents.js: sprawdza sesję i odrzuca, zanim cokolwiek
      // dotknie request.body.
      return Response.json({ error: 'unauthenticated' }, { status: 401 });
    }
    bodyTouched = true;
    return Response.json({ ok: true });
  };
  const bodyLimit = bodyLimitFor(10 * 1024 * 1024);
  const { server, baseUrl } = await listen(createNodeHandler({ distRoot: root, fetchHandler, bodyLimit }));
  try {
    // Ciało większe niż limit dla zwykłych tras (1 MiB) — gdyby serwer
    // buforował je przed wywołaniem trasy (stary kod), zadziałałoby to
    // tak samo jak przy prawdziwym uploadzie; tu liczy się, że w ogóle nie
    // jest czytane.
    const body = 'x'.repeat(5 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/documents`, { method: 'POST', body });
    assert.equal(res.status, 401);
    assert.equal(bodyTouched, false, 'fetchHandler dla innej trasy nie powinien się wykonać');
    // Połączenie zamknięte świadomie (patrz writeFetchResponse) — nieprzeczytane
    // bajty nie zawisają na współdzielonym gnieździe keep-alive.
    assert.equal(res.headers.get('connection'), 'close');
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('Node server: / przekierowuje na /login/, adres klienta nadpisuje nagłówek od klienta', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-node-login-'));
  await mkdir(join(root, 'login'), { recursive: true });
  await writeFile(join(root, 'login', 'index.html'), '<!doctype html><title>Logowanie RD</title>');
  const seen = [];
  const fetchHandler = async (request) => {
    seen.push(request.headers.get('x-rd-client-ip'));
    return Response.json({ ok: true });
  };
  const direct = await listen(createNodeHandler({ distRoot: root, fetchHandler }));
  const proxied = await listen(createNodeHandler({ distRoot: root, fetchHandler, trustProxy: true }));
  try {
    const home = await fetch(`${direct.baseUrl}/`, { redirect: 'manual' });
    assert.equal(home.status, 308);
    assert.equal(home.headers.get('location'), '/login/');
    const page = await fetch(`${direct.baseUrl}/login/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Logowanie RD/);

    const forged = { 'x-rd-client-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 192.0.2.44' };
    await fetch(`${direct.baseUrl}/api/login`, { headers: forged });
    await fetch(`${proxied.baseUrl}/api/login`, { headers: forged });
    assert.equal(seen[0], '127.0.0.1', 'bez zaufanego proxy: adres gniazda, nie nagłówki klienta');
    assert.equal(seen[1], '192.0.2.44', 'za proxy: ostatni wpis X-Forwarded-For');
  } finally {
    await close(direct.server);
    await close(proxied.server);
    await rm(root, { recursive: true, force: true });
  }
});

// #114 (SR-12): HSTS tylko gdy PUBLIC_BASE_URL zaczyna się od https://ale niezależnie
// od tego nosniff/X-Frame-Options/Referrer-Policy trafiają do KAŻDEJ odpowiedzi (statyczna,
// API, przekierowanie 308, /health/ready, błąd 413/500) — nie tylko do plików statycznych.
test('baselineSecurityHeaders: HSTS tylko przy https, reszta zawsze', () => {
  const withHttps = baselineSecurityHeaders('https://rd.example.invalid');
  assert.equal(withHttps['Strict-Transport-Security'], 'max-age=31536000');
  assert.doesNotMatch(withHttps['Strict-Transport-Security'], /includeSubDomains|preload/i, 'D-20: bez includeSubDomains/preload');
  assert.equal(withHttps['X-Content-Type-Options'], 'nosniff');
  assert.equal(withHttps['X-Frame-Options'], 'DENY');
  assert.equal(withHttps['Referrer-Policy'], 'no-referrer');

  for (const value of ['http://rd.example.invalid', '', undefined, 'not-a-url']) {
    const headers = baselineSecurityHeaders(value);
    assert.equal(headers['Strict-Transport-Security'], undefined, String(value));
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  }
});

test('każda odpowiedź serwera Node ma nosniff, X-Frame-Options i (przy https) HSTS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-node-headers-'));
  await mkdir(join(root, 'panel'), { recursive: true });
  await writeFile(join(root, 'panel', 'index.html'), '<!doctype html><title>Panel RD</title>');
  const fetchHandler = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/health/ready') throw new Error('nieużywane — /health/ready jest obsługiwane wcześniej');
    if (url.pathname === '/api/boom') throw new Error('błąd testowy');
    return Response.json({ ok: true });
  };
  const readiness = async () => ({ ready: true, body: { status: 'ready' } });
  const httpHandler = createNodeHandler({ distRoot: root, fetchHandler, readiness, publicBaseUrl: 'http://rd.test' });
  const httpsHandler = createNodeHandler({ distRoot: root, fetchHandler, readiness, publicBaseUrl: 'https://rd.example.invalid' });
  const http = await listen(httpHandler);
  const https = await listen(httpsHandler);
  try {
    for (const { baseUrl, expectHsts } of [{ baseUrl: http.baseUrl, expectHsts: false }, { baseUrl: https.baseUrl, expectHsts: true }]) {
      const cases = [
        await fetch(`${baseUrl}/panel`, { redirect: 'manual' }), // 308
        await fetch(`${baseUrl}/panel/`), // 200 statyczna
        await fetch(`${baseUrl}/health/ready`), // 200 gotowość
        await fetch(`${baseUrl}/api/example`), // 200 API
        await fetch(`${baseUrl}/api/example`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }), // 413
        await fetch(`${baseUrl}/api/boom`), // 500
      ];
      for (const response of cases) {
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${response.status} ${baseUrl}`);
        assert.equal(response.headers.get('x-frame-options'), 'DENY', `${response.status} ${baseUrl}`);
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer', `${response.status} ${baseUrl}`);
        if (expectHsts) assert.match(response.headers.get('strict-transport-security') ?? '', /max-age=31536000/, `${response.status} ${baseUrl}`);
        else assert.equal(response.headers.get('strict-transport-security'), null, `${response.status} ${baseUrl} nie powinien mieć HSTS bez https`);
      }
    }
  } finally {
    await close(http.server);
    await close(https.server);
    await rm(root, { recursive: true, force: true });
  }
});

test('Node server odpowiada 204 na /favicon.ico bez delegowania do API (przegląd demo: 404 w konsoli na każdym ekranie)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-node-app-'));
  let delegated = 0;
  const fetchHandler = async () => {
    delegated += 1;
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  const { server, baseUrl } = await listen(createNodeHandler({ distRoot: root, fetchHandler }));
  try {
    const get = await fetch(`${baseUrl}/favicon.ico`);
    assert.equal(get.status, 204);
    assert.equal(await get.text(), '');
    const head = await fetch(`${baseUrl}/favicon.ico`, { method: 'HEAD' });
    assert.equal(head.status, 204);
    assert.equal(delegated, 0);
    // Inne metody nie są specjalnie traktowane (trafiają do zwykłej obsługi → 404 z API).
    const post = await fetch(`${baseUrl}/favicon.ico`, { method: 'POST', body: '{}' });
    assert.notEqual(post.status, 204);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('Node server (#216): odpowiedź z Content-Length idzie strumieniowo z nagłówkami; przerwanie pobierania nie psuje serwera', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rd-node-app-'));
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const chunks = 200; // ok. 12,5 MiB
  let cancelled = false;
  const fetchHandler = async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== '/api/exports') return Response.json({ ok: true });
    let index = 0;
    const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.length * chunks) });
    headers.append('Set-Cookie', 'a=1; Path=/; HttpOnly');
    headers.append('Set-Cookie', 'b=2; Path=/; HttpOnly');
    const body = new ReadableStream({
      pull(controller) {
        if (index >= chunks) { controller.close(); return; }
        index += 1;
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });
    return new Response(body, { status: 200, headers });
  };
  const { server, baseUrl } = await listen(createNodeHandler({ distRoot: root, fetchHandler }));
  try {
    const full = await fetch(`${baseUrl}/api/exports`, { method: 'POST' });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-length'), String(chunk.length * chunks));
    assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(full.headers.getSetCookie().map((cookie) => cookie.split(';')[0]), ['a=1', 'b=2']);
    assert.equal((await full.arrayBuffer()).byteLength, chunk.length * chunks);

    // Klient czyta jeden kawałek i zrywa połączenie.
    const partial = await fetch(`${baseUrl}/api/exports`, { method: 'POST' });
    const reader = partial.body.getReader();
    await reader.read();
    await reader.cancel();
    for (let attempt = 0; attempt < 50 && !cancelled; attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(cancelled, true, 'źródło strumienia zostało anulowane po zerwaniu połączenia');

    // Serwer nadal obsługuje żądania.
    const after = await fetch(`${baseUrl}/api/other`);
    assert.equal(after.status, 200);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});
