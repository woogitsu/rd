import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import worker from './index.js';
import { createNodeHandler } from './node-app.js';

export async function startServer({
  host = '0.0.0.0',
  port = Number(process.env.PORT || 3000),
  distRoot = fileURLToPath(new URL('../dist/', import.meta.url)),
  publicBaseUrl = process.env.PUBLIC_BASE_URL,
  env = {},
  fetchHandler = worker.fetch.bind(worker),
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  const handler = createNodeHandler({ distRoot, env, publicBaseUrl, fetchHandler });
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer();
  const address = server.address();
  console.log(`RD Node server listening on ${typeof address === 'object' ? address.port : address}`);
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
