import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import worker from './index.js';
import { createNodeHandler } from './node-app.js';
import { createPgDatabase } from './db.js';
import { handlePgRequest } from './pg/app.js';
import { bodyLimitFor, maxUploadBytes } from './documents.js';
import { storageFromEnv } from './storage.js';

// Wybór warstwy API. Z DATABASE_URL: nowe API na PostgreSQL (env.db).
// Bez niej: dotychczasowy router Workera (bez D1 chronione trasy zwracają 503).
// Migracje NIE są uruchamiane przy starcie — wyłącznie `npm run db:migrate:postgres`.
// Storage Bucket (BUCKET_*) jest opcjonalny: bez niego trasy dokumentów zwracają 503.
export function resolveRuntime(processEnv = process.env, { createDatabase = createPgDatabase, createStorage = storageFromEnv } = {}) {
  if (processEnv.DATABASE_URL) {
    const storage = createStorage(processEnv);
    const documentMaxBytes = maxUploadBytes(processEnv.DOCUMENT_MAX_BYTES);
    const db = createDatabase({ connectionString: processEnv.DATABASE_URL });
    return {
      mode: 'postgres',
      env: {
        db,
        storage,
        documentMaxBytes,
        APP_ENV: processEnv.APP_ENV,
        IMPORT_ENABLED: processEnv.IMPORT_ENABLED,
        // Webhook i plan kampanii e-mail (#40). Klucz API Brevo NIE trafia do serwera HTTP —
        // używa go wyłącznie zadanie scripts/email-worker.js.
        BREVO_WEBHOOK_SECRET: processEnv.BREVO_WEBHOOK_SECRET,
        EMAIL_DAILY_LIMIT: processEnv.EMAIL_DAILY_LIMIT,
        EMAIL_DAILY_RESERVED: processEnv.EMAIL_DAILY_RESERVED,
        EMAIL_CAMPAIGN_MIN_DAYS: processEnv.EMAIL_CAMPAIGN_MIN_DAYS,
        EMAIL_CAMPAIGN_MIN_DAILY: processEnv.EMAIL_CAMPAIGN_MIN_DAILY,
        // MFA (#3): klucz szyfrowania sekretów TOTP, wyłącznie jako sekret usługi Railway.
        MFA_ENCRYPTION_KEY: processEnv.MFA_ENCRYPTION_KEY,
      },
      fetchHandler: handlePgRequest,
      bodyLimit: bodyLimitFor(documentMaxBytes),
      close: () => db.close(),
    };
  }
  return { mode: 'legacy', env: {}, fetchHandler: worker.fetch.bind(worker), close: async () => {} };
}

export async function startServer({
  host = '0.0.0.0',
  port = Number(process.env.PORT || 3000),
  distRoot = fileURLToPath(new URL('../dist/', import.meta.url)),
  publicBaseUrl = process.env.PUBLIC_BASE_URL,
  env = {},
  fetchHandler = worker.fetch.bind(worker),
  bodyLimit,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  const handler = createNodeHandler({ distRoot, env, publicBaseUrl, fetchHandler, bodyLimit });
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtime = resolveRuntime();
  const server = await startServer({ env: runtime.env, fetchHandler: runtime.fetchHandler, bodyLimit: runtime.bodyLimit });
  const address = server.address();
  console.log(`RD Node server (${runtime.mode}) listening on ${typeof address === 'object' ? address.port : address}`);
  const shutdown = () => server.close(() => {
    runtime.close().catch(() => {}).finally(() => process.exit(0));
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
