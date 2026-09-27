import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createShutdown } from '../src/server.js';
import { createLogger } from '../src/log.js';

function quiet() {
  const lines = [];
  return { logger: createLogger({ level: 'debug', sink: (line) => lines.push(line) }), events: () => lines.map((line) => JSON.parse(line).event) };
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('shutdown closes the server, then the database, and exits 0 once', async () => {
  const server = await listen((req, res) => res.end('ok'));
  const order = [];
  const exits = [];
  const { logger, events } = quiet();
  const shutdown = createShutdown({
    server, logger, timeoutMs: 2000,
    close: async () => { order.push('db'); },
    exit: (code) => exits.push(code),
    onStart: () => order.push('start'),
  });
  const first = shutdown('SIGTERM');
  const second = shutdown('SIGTERM');
  assert.equal(first, second);
  assert.equal(await first, 0);
  assert.deepEqual(order, ['start', 'db']);
  assert.deepEqual(exits, [0]);
  assert.equal(server.listening, false);
  assert.deepEqual(events(), ['server_shutdown_started', 'server_shutdown_completed']);
});

test('shutdown waits for an in-flight request before closing the database', async () => {
  let release;
  const server = await listen((req, res) => { release = () => res.end('done'); });
  const port = server.address().port;
  const pending = fetch(`http://127.0.0.1:${port}/slow`);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  const order = [];
  const shutdown = createShutdown({ server, logger: quiet().logger, timeoutMs: 2000, close: async () => order.push('db'), exit: () => {} });
  const done = shutdown('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, []);
  release();
  assert.equal(await (await pending).text(), 'done');
  assert.equal(await done, 0);
  assert.deepEqual(order, ['db']);
});

test('shutdown forces exit 1 after the timeout when a request hangs or db.close fails', async () => {
  const server = await listen(() => {});
  const port = server.address().port;
  fetch(`http://127.0.0.1:${port}/hang`).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  const { logger, events } = quiet();
  const exits = [];
  const code = await createShutdown({ server, logger, timeoutMs: 50, exit: (c) => exits.push(c) })('SIGTERM');
  assert.equal(code, 1);
  assert.deepEqual(exits, [1]);
  assert.ok(events().includes('server_shutdown_timeout'));

  const other = await listen((req, res) => res.end());
  const failed = await createShutdown({
    server: other, logger, timeoutMs: 2000, exit: () => {},
    close: async () => { throw Object.assign(new Error('postgres://user:secret@host'), { code: '57P01' }); },
  })('SIGTERM');
  assert.equal(failed, 1);
});
