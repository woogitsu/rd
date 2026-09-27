import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import worker from './index.js';
import { createNodeHandler } from './node-app.js';
import { createPgDatabase } from './db.js';
import { handlePgRequest } from './pg/app.js';
import { bodyLimitFor, maxUploadBytes } from './documents.js';
import { storageFromEnv } from './storage.js';
import { checkReadiness } from './health.js';
import { createRequestMetrics, describeError, log, startMetricsReporter } from './log.js';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

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
        // Logowanie hasłem (#3): role z obowiązkowym MFA i koszt scrypt (log2 N).
        MFA_REQUIRED_ROLES: processEnv.MFA_REQUIRED_ROLES,
        SCRYPT_COST_LOG2: processEnv.SCRYPT_COST_LOG2,
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
  logger,
  metrics,
  readiness,
  trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  const handler = createNodeHandler({ distRoot, env, publicBaseUrl, fetchHandler, bodyLimit, logger, metrics, readiness, trustProxy });
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

// Łagodne zamknięcie (SIGTERM z Railway przy redeployu): przestaje przyjmować
// połączenia, czeka na trwające żądania, zamyka pulę bazy. Po timeoutMs zamyka
// siłą pozostałe połączenia i kończy proces kodem 1. Wywołanie wielokrotne
// (drugi sygnał) nie uruchamia zamykania ponownie.
export function createShutdown({
  server, close = async () => {}, logger = log, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS, exit = (code) => process.exit(code),
  onStart = () => {},
}) {
  let pending = null;
  return function shutdown(signal = 'manual') {
    if (pending) return pending;
    onStart();
    logger.info('server_shutdown_started', { signal: String(signal), timeout_ms: timeoutMs });
    pending = new Promise((resolve) => {
      // Połączenia keep-alive, które skończyły żądanie już po server.close(),
      // stają się bezczynne — zamykamy je cyklicznie, by close() mógł się zakończyć.
      const sweep = setInterval(() => server.closeIdleConnections?.(), 100);
      sweep.unref?.();
      const finish = (code) => { clearInterval(sweep); clearTimeout(timer); resolve(code); };
      const timer = setTimeout(() => {
        logger.error('server_shutdown_timeout', { timeout_ms: timeoutMs });
        server.closeAllConnections?.();
        finish(1);
      }, timeoutMs);
      timer.unref?.();
      server.close(() => {
        clearInterval(sweep);
        Promise.resolve().then(close).then(
          () => { logger.info('server_shutdown_completed'); finish(0); },
          (error) => { logger.error('server_shutdown_close_error', describeError(error)); finish(1); },
        );
      });
      server.closeIdleConnections?.();
    }).then((code) => { exit(code); return code; });
    return pending;
  };
}

function positiveMs(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtime = resolveRuntime();
  const metrics = createRequestMetrics();
  let draining = false;
  const readiness = async (env) => (draining
    ? { ready: false, body: { status: 'not_ready', checks: { server: 'shutting_down' } } }
    : checkReadiness(env));
  const server = await startServer({ env: runtime.env, fetchHandler: runtime.fetchHandler, bodyLimit: runtime.bodyLimit, metrics, readiness });
  const address = server.address();
  log.info('server_started', { mode: runtime.mode, port: typeof address === 'object' ? address.port : null });
  const stopMetrics = startMetricsReporter({ metrics, intervalMs: positiveMs(process.env.METRICS_LOG_INTERVAL_MS, 5 * 60 * 1000) });
  const shutdown = createShutdown({
    server,
    close: () => runtime.close(),
    timeoutMs: positiveMs(process.env.SHUTDOWN_TIMEOUT_MS, DEFAULT_SHUTDOWN_TIMEOUT_MS),
    onStart: () => { draining = true; stopMetrics(); },
  });
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
