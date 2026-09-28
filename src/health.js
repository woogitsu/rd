// Gotowość (readiness) serwera Node: /health/ready.
//
// /health (liveness) potwierdza tylko, że proces odpowiada — tak jak dotąd.
// /health/ready dodatkowo sprawdza bazę, gdy jest skonfigurowana (env.db):
//   1. `SELECT 1` z krótkim limitem czasu,
//   2. czy tabela schema_migrations zawiera wszystkie pliki z postgres/migrations,
//   3. czy suma kontrolna każdego nałożonego pliku zgadza się z repozytorium (#79).
// Odpowiedź zawiera wyłącznie stan techniczny: liczby i nazwy brakujących
// migracji (nazwy plików z repozytorium), nigdy danych z tabel ani treści błędów.
// 503 = niegotowy (brak bazy, błąd/timeout bazy, brakujące migracje, niezgodna
// suma kontrolna, zamykanie).

import { fileURLToPath } from 'node:url';
import { loadMigrations } from './postgres-migrations.js';
import { describeError, log } from './log.js';

export const DEFAULT_READINESS_TIMEOUT_MS = 2000;
const MIGRATIONS_DIR = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

let cachedMigrations = null;
async function repositoryMigrations() {
  if (!cachedMigrations) cachedMigrations = loadMigrations(MIGRATIONS_DIR);
  try {
    return await cachedMigrations;
  } catch (error) {
    cachedMigrations = null;
    throw error;
  }
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('readiness timeout'), { code: 'timeout' })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @returns {Promise<{ ready: boolean, body: object }>}
 */
export async function checkReadiness(env = {}, {
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  migrations: migrationsProvider = repositoryMigrations,
  logger = log,
} = {}) {
  if (!env?.db || typeof env.db.query !== 'function') {
    return { ready: false, body: { status: 'not_ready', checks: { database: 'not_configured' } } };
  }
  try {
    const expected = await migrationsProvider();
    const result = await withTimeout((async () => {
      await env.db.query('SELECT 1');
      const table = await env.db.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
      if (!table.rows?.[0]?.present) return { applied: null };
      const { rows } = await env.db.query('SELECT name, checksum FROM schema_migrations');
      return { applied: new Map(rows.map((row) => [row.name, row.checksum])) };
    })(), timeoutMs);
    const missing = result.applied ? expected.filter((item) => !result.applied.has(item.name)).map((item) => item.name) : expected.map((item) => item.name);
    // Suma kontrolna nałożonego pliku ≠ suma w repozytorium (#79): plik scalonej
    // migracji został potem zmieniony. Odpowiedź nie zawiera treści SQL ani sum.
    const mismatched = result.applied
      ? expected.filter((item) => result.applied.has(item.name) && result.applied.get(item.name) !== item.checksum).map((item) => item.name)
      : [];
    const migrations = {
      expected: expected.length,
      applied: expected.length - missing.length,
      missing_count: missing.length,
      missing,
    };
    if (mismatched.length) {
      logger.error('readiness_migrations_checksum_mismatch', { mismatch_count: mismatched.length });
      return { ready: false, body: { status: 'not_ready', checks: { database: 'ok', migrations: 'checksum_mismatch' }, migrations: { ...migrations, mismatched_count: mismatched.length, mismatched } } };
    }
    if (missing.length) {
      logger.warn('readiness_migrations_pending', { missing_count: missing.length });
      return { ready: false, body: { status: 'not_ready', checks: { database: 'ok', migrations: 'pending' }, migrations } };
    }
    return { ready: true, body: { status: 'ready', checks: { database: 'ok', migrations: 'ok' }, migrations: { expected: expected.length, applied: expected.length } } };
  } catch (error) {
    const detail = describeError(error);
    logger.error('readiness_database_error', detail);
    return { ready: false, body: { status: 'not_ready', checks: { database: detail.code === 'timeout' ? 'timeout' : 'error' } } };
  }
}
