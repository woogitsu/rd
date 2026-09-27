import pg from 'pg';
import { log } from './log.js';

// Warstwa dostępu do PostgreSQL dla nowego API (Railway).
//
// Kontrakt (taki sam jak PGlite, więc testy mogą podać PGlite jako env.db):
//   db.query(text, params)          -> Promise<{ rows }>
//   db.transaction(async (tx) => …) -> wynik funkcji; BEGIN/COMMIT/ROLLBACK na jednym połączeniu
//   tx.query(text, params)          -> Promise<{ rows }>
//   db.close()                      -> zamyka pulę
//
// Zapytania zawsze parametryzowane ($1, $2 …). Nie składać SQL z danych wejściowych.

const DEFAULT_POOL_MAX = 10;
const MAX_POOL_MAX = 50;

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(number, max);
}

export function poolConfig(config = {}, processEnv = process.env) {
  const input = typeof config === 'string' ? { connectionString: config } : { ...config };
  return {
    ...input,
    max: positiveInt(input.max ?? processEnv.PG_POOL_MAX, DEFAULT_POOL_MAX, MAX_POOL_MAX),
    idleTimeoutMillis: input.idleTimeoutMillis ?? 10_000,
    connectionTimeoutMillis: input.connectionTimeoutMillis ?? 5_000,
    statement_timeout: input.statement_timeout ?? positiveInt(processEnv.PG_STATEMENT_TIMEOUT_MS, 10_000),
    idle_in_transaction_session_timeout: input.idle_in_transaction_session_timeout ?? 15_000,
    application_name: input.application_name ?? 'rd',
  };
}

function isPool(value) {
  return value && typeof value.connect === 'function' && typeof value.query === 'function';
}

function wrapClient(client) {
  return {
    async query(text, params = []) {
      const result = await client.query(text, params);
      return { rows: result.rows };
    },
  };
}

export function createPgDatabase(poolOrConfig = {}) {
  const pool = isPool(poolOrConfig) ? poolOrConfig : new pg.Pool(poolConfig(poolOrConfig));
  // Błąd bezczynnego połączenia nie może zatrzymać procesu. Nie logujemy treści
  // błędu ani adresu bazy; wyłącznie kod techniczny.
  pool.on?.('error', (error) => {
    log.error('db_idle_client_error', { code: typeof error?.code === 'string' ? error.code : 'unknown' });
  });

  return {
    async query(text, params = []) {
      const result = await pool.query(text, params);
      return { rows: result.rows };
    },
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await fn(wrapClient(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
        throw error;
      } finally {
        client.release(broken);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
