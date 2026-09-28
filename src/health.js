// Gotowość (readiness) serwera Node: /health/ready.
//
// /health (liveness) potwierdza tylko, że proces odpowiada — tak jak dotąd.
// /health/ready dodatkowo sprawdza bazę, gdy jest skonfigurowana (env.db):
//   1. `SELECT 1` z krótkim limitem czasu,
//   2. czy tabela schema_migrations zawiera wszystkie pliki z postgres/migrations.
// Odpowiedź zawiera wyłącznie stan techniczny: liczby i nazwy brakujących
// migracji (nazwy plików z repozytorium), nigdy danych z tabel ani treści błędów.
// 503 = niegotowy (brak bazy, błąd/timeout bazy, brakujące migracje, zamykanie).

import { fileURLToPath } from 'node:url';
import { loadMigrations } from './postgres-migrations.js';
import { describeError, log } from './log.js';
import { isReadOnly, WRITE_MODE_NORMAL, WRITE_MODE_READ_ONLY } from './write-mode.js';

export const DEFAULT_READINESS_TIMEOUT_MS = 2000;
const MIGRATIONS_DIR = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

let cachedNames = null;
async function repositoryMigrationNames() {
  if (!cachedNames) cachedNames = loadMigrations(MIGRATIONS_DIR).then((items) => items.map((item) => item.name));
  try {
    return await cachedNames;
  } catch (error) {
    cachedNames = null;
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
  migrationNames = repositoryMigrationNames,
  logger = log,
} = {}) {
  const writeMode = isReadOnly(env) ? WRITE_MODE_READ_ONLY : WRITE_MODE_NORMAL;
  const withWriteMode = ({ ready, body }) => ({ ready, body: { ...body, write_mode: writeMode } });
  if (!env?.db || typeof env.db.query !== 'function') {
    return withWriteMode({ ready: false, body: { status: 'not_ready', checks: { database: 'not_configured' } } });
  }
  try {
    const expected = await migrationNames();
    const result = await withTimeout((async () => {
      await env.db.query('SELECT 1');
      const table = await env.db.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
      if (!table.rows?.[0]?.present) return { applied: null };
      const { rows } = await env.db.query('SELECT name FROM schema_migrations');
      return { applied: new Set(rows.map((row) => row.name)) };
    })(), timeoutMs);
    const missing = result.applied ? expected.filter((name) => !result.applied.has(name)) : expected;
    const migrations = {
      expected: expected.length,
      applied: expected.length - missing.length,
      missing_count: missing.length,
      missing,
    };
    if (missing.length) {
      logger.warn('readiness_migrations_pending', { missing_count: missing.length });
      return withWriteMode({ ready: false, body: { status: 'not_ready', checks: { database: 'ok', migrations: 'pending' }, migrations } });
    }
    return withWriteMode({ ready: true, body: { status: 'ready', checks: { database: 'ok', migrations: 'ok' }, migrations: { expected: expected.length, applied: expected.length } } });
  } catch (error) {
    const detail = describeError(error);
    logger.error('readiness_database_error', detail);
    return withWriteMode({ ready: false, body: { status: 'not_ready', checks: { database: detail.code === 'timeout' ? 'timeout' : 'error' } } });
  }
}
