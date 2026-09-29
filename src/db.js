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

  // Sondy diagnostyczne (/health/ready): co najwyżej jedna naraz na pulę, na
  // własnym połączeniu z budżetem czasu po stronie serwera PostgreSQL (#244).
  let probeActive = false;

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
    /**
     * Zapytania diagnostyczne z twardym budżetem czasu. `Promise.race` kończy
     * tylko oczekiwanie, więc tu każde zapytanie sondy dostaje w transakcji
     * `SET LOCAL statement_timeout` równe POZOSTAŁEMU budżetowi: serwer sam
     * anuluje zapytanie i połączenie wraca do puli najpóźniej po `timeoutMs`
     * (a nie po statement_timeout puli, domyślnie 10 s). Sonda zajmuje
     * najwyżej jedno połączenie; kolejna, gdy poprzednia jeszcze trwa
     * (np. czeka na wolne połączenie), kończy się kodem `probe_busy` bez
     * tworzenia kolejnego oczekującego klienta puli.
     */
    async probe(fn, { timeoutMs = 2000 } = {}) {
      if (probeActive) throw Object.assign(new Error('probe busy'), { code: 'probe_busy' });
      probeActive = true;
      const deadline = Date.now() + timeoutMs;
      let abandoned = false;
      let timer;
      const run = (async () => {
        const client = await pool.connect();
        let broken = false;
        try {
          if (abandoned) return undefined;
          await client.query('BEGIN');
          const result = await fn({
            async query(text, params = []) {
              const remaining = deadline - Date.now();
              if (abandoned || remaining < 1) throw Object.assign(new Error('probe timeout'), { code: 'timeout' });
              await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [String(remaining)]);
              const out = await client.query(text, params);
              return { rows: out.rows };
            },
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch { broken = true; }
          throw error;
        } finally {
          client.release(broken);
        }
      })().finally(() => { probeActive = false; });
      // Późny wynik/błąd porzuconej sondy nie może zostać nieobsłużony.
      run.catch(() => {});
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abandoned = true;
          reject(Object.assign(new Error('readiness timeout'), { code: 'timeout' }));
        }, timeoutMs);
      });
      try {
        return await Promise.race([run, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
