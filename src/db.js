import pg from 'pg';
import { log } from './log.js';

// Warstwa dostępu do PostgreSQL dla nowego API (Railway).
//
// Kontrakt (taki sam jak PGlite, więc testy mogą podać PGlite jako env.db):
//   db.query(text, params)          -> Promise<{ rows }>
//   db.transaction(async (tx) => …, { retries }) -> wynik funkcji; BEGIN/COMMIT/ROLLBACK na jednym połączeniu
//   tx.query(text, params)          -> Promise<{ rows }>
//   db.close()                      -> zamyka pulę
//
// Zapytania zawsze parametryzowane ($1, $2 …). Nie składać SQL z danych wejściowych.

const DEFAULT_POOL_MAX = 10;
const MAX_POOL_MAX = 50;

// #156: kontrakt transakcji.
//  - `SET LOCAL lock_timeout` (PG_LOCK_TIMEOUT_MS, domyślnie 3 s): czekanie na
//    FOR UPDATE / blokadę doradczą kończy się 55P03 (503 retry_later) zamiast
//    dopiero timeoutem instrukcji (10 s, 57014).
//  - Ponowienie CAŁEJ funkcji `fn` (domyślnie 2 ponowienia = 3 próby, z losowym
//    odstępem) wyłącznie przy 40001 serialization_failure i 40P01
//    deadlock_detected. Obie oznaczają, że PostgreSQL wycofał transakcję, więc
//    ponowienie nie może zdublować zapisu ani zdarzenia audytu. Warunek: `fn`
//    jest czysto bazodanowa i bezpieczna do ponownego uruchomienia — bez
//    Brevo, Storage, sieci ani zmiany stanu w pamięci poza własnymi zmiennymi.
//    Transakcja z takim efektem przekazuje `{ retries: 0 }` (jawnie).
//  - Błąd w trakcie COMMIT, po którym nie wiadomo, czy zapis się utrwalił
//    (zerwane połączenie, klasa 08, wyłączenie serwera 57P0x, timeout), to
//    CommitOutcomeUnknownError (`commit_outcome_unknown`); NIGDY nie jest
//    ponawiany automatycznie. Połączenie jest wyrzucane z puli.
export const DEFAULT_TX_RETRIES = 2;
export const DEFAULT_LOCK_TIMEOUT_MS = 3_000;
const MAX_LOCK_TIMEOUT_MS = 60_000;
const RETRYABLE_TX_CODES = new Set(['40001', '40P01']);
// Klasy SQLSTATE, których błąd przy COMMIT jest jednoznacznym wycofaniem
// (serwer odpowiedział błędem, transakcja nie została zatwierdzona).
const DEFINITE_COMMIT_FAILURE_CLASSES = new Set(['22', '23', '25', '40', '42', '44']);

export class CommitOutcomeUnknownError extends Error {
  constructor(cause) {
    super('commit_outcome_unknown');
    this.name = 'CommitOutcomeUnknownError';
    this.code = 'commit_outcome_unknown';
    this.cause = cause;
  }
}

export function isRetryableTransactionError(error) {
  return typeof error?.code === 'string' && RETRYABLE_TX_CODES.has(error.code);
}

// true: błąd przy COMMIT to pewne wycofanie; false: wynik nieznany.
export function commitFailureIsDefinite(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[0-9A-Z]{5}$/.test(code) && DEFINITE_COMMIT_FAILURE_CLASSES.has(code.slice(0, 2));
}

function defaultBackoffMs(attempt, random = Math.random) {
  return Math.round(20 * 2 ** attempt * (0.5 + random()));
}

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

export function createPgDatabase(poolOrConfig = {}, options = {}) {
  const { lockTimeoutMs: configuredLockTimeout, ...poolInput } = isPool(poolOrConfig) || typeof poolOrConfig === 'string' ? {} : poolOrConfig;
  const lockTimeoutMs = positiveInt(
    options.lockTimeoutMs ?? configuredLockTimeout ?? process.env.PG_LOCK_TIMEOUT_MS,
    DEFAULT_LOCK_TIMEOUT_MS, MAX_LOCK_TIMEOUT_MS,
  );
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const pool = isPool(poolOrConfig)
    ? poolOrConfig
    : new pg.Pool(poolConfig(typeof poolOrConfig === 'string' ? poolOrConfig : poolInput));
  // Błąd bezczynnego połączenia nie może zatrzymać procesu. Nie logujemy treści
  // błędu ani adresu bazy; wyłącznie kod techniczny.
  pool.on?.('error', (error) => {
    log.error('db_idle_client_error', { code: typeof error?.code === 'string' ? error.code : 'unknown' });
  });

  // Sondy diagnostyczne (/health/ready): co najwyżej jedna naraz na pulę, na
  // własnym połączeniu z budżetem czasu po stronie serwera PostgreSQL (#244).
  let probeActive = false;

  async function attemptTransaction(fn) {
    const client = await pool.connect();
    let broken = false;
    let committing = false;
    try {
      await client.query('BEGIN');
      // SET LOCAL (instrukcja narzędziowa) NIE otwiera migawki, więc funkcja fn może jeszcze
      // wydać SET TRANSACTION ISOLATION LEVEL ... (readSnapshot, eksport). Zapytanie
      // SELECT set_config(...) otwierało migawkę i na PostgreSQL kończyło się 25001
      // („must be called before any query”). lockTimeoutMs jest liczbą całkowitą (positiveInt).
      await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
      const result = await fn(wrapClient(client));
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (committing && !commitFailureIsDefinite(error)) {
        // Nie wiadomo, czy COMMIT dotarł do bazy: ROLLBACK nic tu nie wyjaśni,
        // a połączenie jest w nieznanym stanie — wyrzucamy je z puli.
        broken = true;
        throw new CommitOutcomeUnknownError(error);
      }
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  return {
    async query(text, params = []) {
      const result = await pool.query(text, params);
      return { rows: result.rows };
    },
    async transaction(fn, { retries = DEFAULT_TX_RETRIES } = {}) {
      const maxRetries = Number.isInteger(retries) && retries > 0 ? retries : 0;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await attemptTransaction(fn);
        } catch (error) {
          if (attempt >= maxRetries || !isRetryableTransactionError(error)) throw error;
          log.warn('db_transaction_retry', { code: error.code, attempt: attempt + 1, of: maxRetries + 1 });
          await sleep(backoffMs(attempt));
        }
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
