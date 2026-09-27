import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeHandler } from '../src/node-app.js';

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
    assert.deepEqual(await api.json(), { ok: true });

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
