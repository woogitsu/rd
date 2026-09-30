// #185: serwer Node nie może buforować ciała dużych uploadów przed sprawdzeniem
// sesji, musi odrzucać zbyt duże Content-Length bez czytania reszty i zwalniać
// miejsce uploadu, gdy klient przerwie połączenie. Wyłącznie syntetyczne bajty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeHandler, isStreamedUploadRoute } from '../src/node-app.js';
import {
  activeUploadSlots, bodyLimitFor, readLimited, resetUploadSlotsForTests, tryAcquireUploadSlot,
} from '../src/documents.js';
import { assertEvery } from './helpers/assertions.js';

const MB = 1024 * 1024;
const QUIET = { info() {}, warn() {}, debug() {}, error() {} };
// Limiter liczby żądań (#126) testowany osobno — tu przepuszcza wszystko,
// żeby do trasy dotarło każde z równoległych żądań.
const OPEN_LIMITER = { acquire: () => ({ ok: true, release() {} }) };

// Jak bodyLimitForApp w src/server.js: 10 MB dla obu tras plików, 1 MiB dla reszty.
const APP_LIKE_LIMIT = (url, method) => (isStreamedUploadRoute(method, url.pathname) ? 10 * MB : MB);

async function withServer(fetchHandler, fn, { bodyLimit = APP_LIKE_LIMIT } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rd-node-upload-'));
  const sockets = new Set();
  const server = createServer(createNodeHandler({ distRoot: root, fetchHandler, bodyLimit, logger: QUIET, rateLimiter: OPEN_LIMITER }));
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bytesRead = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0);
  try {
    return await fn({ port: server.address().port, bytesRead });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

// Klient wysyła deklarowane `total` bajtów z JEDNEGO współdzielonego bufora
// (bez własnych alokacji, żeby nie zafałszować pomiaru pamięci), do chwili
// odpowiedzi serwera albo zamknięcia gniazda.
const SHARED_CHUNK = Buffer.alloc(64 * 1024, 0x20);
function post(port, path, { total = 10 * MB, chunked = false, abortAfter = null, headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path,
      headers: { 'Content-Type': 'application/pdf', ...(chunked ? {} : { 'Content-Length': String(total) }), ...headers },
    });
    let sent = 0;
    let finished = false;
    const done = (value) => { if (!finished) { finished = true; resolve(value); } };
    req.on('response', (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => {
        done({ status: res.statusCode, connection: res.headers.connection, body: Buffer.concat(parts).toString('utf8'), sent });
        req.destroy();
      });
      res.on('error', () => done({ status: res.statusCode, sent }));
    });
    req.on('error', () => done({ status: 0, sent }));
    req.on('close', () => done({ status: 0, sent }));
    const pump = () => {
      while (!req.destroyed && sent < total) {
        if (abortAfter !== null && sent >= abortAfter) { req.destroy(); return; }
        const size = Math.min(SHARED_CHUNK.length, total - sent);
        sent += size;
        if (!req.write(size === SHARED_CHUNK.length ? SHARED_CHUNK : SHARED_CHUNK.subarray(0, size))) {
          req.once('drain', pump);
          return;
        }
      }
      if (!req.destroyed) req.end();
    };
    pump();
  });
}

function samplePeak(read) {
  let peak = read();
  const timer = setInterval(() => { peak = Math.max(peak, read()); }, 2);
  return () => { clearInterval(timer); return Math.max(peak, read()); };
}

test('isStreamedUploadRoute: dokumenty i plik zdjęcia aktualności — nic więcej', () => {
  assert.equal(isStreamedUploadRoute('POST', '/api/documents'), true);
  assert.equal(isStreamedUploadRoute('POST', '/api/news-photos/p-1/file'), true);
  assert.equal(isStreamedUploadRoute('GET', '/api/documents'), false);
  for (const path of ['/api/import/preview', '/api/reconciliation/import', '/api/news-photos/p-1/consents', '/api/documents/d-1/supersede']) {
    assert.equal(isStreamedUploadRoute('POST', path), false, path);
  }
});

test('#185: 20 równoczesnych anonimowych POST po 10 MB — 401 bez odczytu ciała, arrayBuffers rośnie < 20 MB', async () => {
  let invoked = 0;
  // Jak documents.js i news.js: bez sesji odmowa zanim cokolwiek dotknie request.body.
  const fetchHandler = async () => { invoked += 1; return Response.json({ error: 'unauthenticated' }, { status: 401 }); };
  await withServer(fetchHandler, async ({ port, bytesRead }) => {
    globalThis.gc?.();
    const before = process.memoryUsage().arrayBuffers;
    const stop = samplePeak(() => process.memoryUsage().arrayBuffers);
    const paths = Array.from({ length: 20 }, (_, i) => (i % 2 ? '/api/documents?kind=financial' : `/api/news-photos/p-${i}/file`));
    const results = await Promise.all(paths.map((path) => post(port, path)));
    const peak = stop();
    assert.deepEqual(results.map((r) => r.status), Array(20).fill(401));
    assertEvery(results, (r) => r.connection === 'close', 'nieprzeczytane ciało -> zamknięte połączenie');
    assert.equal(invoked, 20, 'trasa wywołana dla każdego żądania, zanim nadeszło całe ciało');
    const read = bytesRead();
    assert.ok(read < 20 * MB, `serwer odebrał ${(read / MB).toFixed(1)} MB z deklarowanych 200 MB`);
    const growth = peak - before;
    assert.ok(growth < 20 * MB, `wzrost arrayBuffers ${(growth / MB).toFixed(1)} MB`);
  });
});

test('#185: Content-Length ponad limit -> 413 bez wywołania trasy i bez czytania reszty ciała', async () => {
  let invoked = 0;
  const fetchHandler = async () => { invoked += 1; return Response.json({ ok: true }); };
  await withServer(fetchHandler, async ({ port, bytesRead }) => {
    for (const path of ['/api/documents', '/api/logout']) {
      const result = await post(port, path, { total: 26 * MB });
      assert.equal(result.status, 413, path);
      assert.equal(JSON.parse(result.body).error, 'request_too_large');
      assert.equal(result.connection, 'close', `${path}: połączenie zamknięte, reszta ciała nie jest dopijana`);
    }
    assert.equal(invoked, 0);
    assert.ok(bytesRead() < 8 * MB, `serwer odebrał ${(bytesRead() / MB).toFixed(1)} MB z 52 MB`);
  });
});

test('#185: chunked (bez Content-Length) ponad limit -> 413 także, gdy trasa czyta ciało inaczej niż readLimited', async () => {
  const fetchHandler = async (request) => {
    // Celowo bez readLimited: limit pilnuje strumień w node-app.js.
    try {
      await request.arrayBuffer();
    } catch (error) {
      if (error instanceof RangeError) return Response.json({ error: 'document_too_large' }, { status: 413 });
      throw error;
    }
    return Response.json({ ok: true }, { status: 201 });
  };
  await withServer(fetchHandler, async ({ port }) => {
    const over = await post(port, '/api/documents', { total: 3 * MB, chunked: true });
    assert.equal(over.status, 413);
    assert.equal(JSON.parse(over.body).error, 'document_too_large');
    const within = await post(port, '/api/documents', { total: MB, chunked: true });
    assert.equal(within.status, 201);
  }, { bodyLimit: bodyLimitFor(2 * MB) });
});

test('#185: przerwany upload zwalnia miejsce semafora', async () => {
  resetUploadSlotsForTests();
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  // Jak documents.js: miejsce zajęte przed odczytem, zwolnione w finally.
  const fetchHandler = async (request) => {
    const release = tryAcquireUploadSlot(1, 'u-synthetic');
    if (!release) return Response.json({ error: 'upload_busy' }, { status: 503 });
    try {
      await readLimited(request, 10 * MB);
      return Response.json({ ok: true }, { status: 201 });
    } catch {
      return Response.json({ error: 'aborted' }, { status: 400 });
    } finally {
      release();
      settle();
    }
  };
  await withServer(fetchHandler, async ({ port }) => {
    const aborted = await post(port, '/api/documents', { total: 5 * MB, abortAfter: MB });
    assert.equal(aborted.status, 0, 'klient zerwał połączenie');
    await settled;
    assert.equal(activeUploadSlots(), 0, 'miejsce wróciło do puli');
    const next = await post(port, '/api/documents', { total: 64 * 1024 });
    assert.equal(next.status, 201, 'kolejny upload dostaje miejsce');
  });
  resetUploadSlotsForTests();
});

test('#185: odczyt 10 MB z deklarowaną długością to jedna alokacja rozmiaru pliku', async () => {
  const size = 10 * MB;
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= size) { controller.close(); return; }
      sent += SHARED_CHUNK.length;
      controller.enqueue(new Uint8Array(SHARED_CHUNK.buffer, SHARED_CHUNK.byteOffset, SHARED_CHUNK.length));
    },
  }, { highWaterMark: 0 });
  const request = new Request('https://rd.example.invalid/api/documents', {
    method: 'POST', body, duplex: 'half', headers: { 'Content-Length': String(size) },
  });
  const bytes = await readLimited(request, 25 * MB);
  assert.equal(bytes.byteLength, size);
  assert.equal(bytes.buffer.byteLength, size, 'bufor wynikowy = prealokowany bufor, bez kopii zapasowej ani podwajania');
});
