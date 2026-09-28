// Gotowość (readiness) serwera Node: /health/ready.
//
// /health (liveness) potwierdza tylko, że proces odpowiada — tak jak dotąd.
// /health/ready dodatkowo sprawdza bazę, gdy jest skonfigurowana (env.db):
//   1. `SELECT 1` z krótkim limitem czasu,
//   2. czy tabela schema_migrations zawiera wszystkie pliki z postgres/migrations.
// Odpowiedź zawiera wyłącznie stan techniczny: liczby i nazwy brakujących
// migracji (nazwy plików z repozytorium), nigdy danych z tabel ani treści błędów.
// 503 = niegotowy (brak bazy, błąd/timeout bazy, brakujące migracje, zamykanie).
//
// Endpoint jest publiczny (bez sesji). Timeout HTTP (`timeoutMs`, domyślnie 2 s)
// wygrywa wyścig z zapytaniem, ale nie anuluje samego zapytania — ono nadal
// zajmuje połączenie z puli aż do serwerowego `statement_timeout` (domyślnie
// 10 s, patrz src/db.js). Bez zabezpieczenia N równoległych sond potrafiłoby
// zająć całą pulę (domyślnie 10 połączeń) podczas spowolnienia bazy i
// utrudnić jej odzyskanie (#244). Dlatego równoległe wywołania dla tej samej
// `env.db` dzielą jedno trwające sprawdzenie (single-flight): druga i kolejne
// sondy, które przyjdą zanim pierwsza się zakończy, nie wysyłają nowych
// zapytań, tylko czekają na wynik już trwającego sprawdzenia. Po zakończeniu
// (sukces, błąd lub timeout) kolejne wywołanie zaczyna sprawdzenie od nowa —
// to nie jest bufor wyniku, tylko ograniczenie liczby jednocześnie
// wykonywanych zapytań do jednego na instancję bazy.
// Realne anulowanie zapytania na poziomie klienta `pg` (żeby zwolnić
// połączenie od razu po upływie `timeoutMs`, a nie dopiero po
// `statement_timeout`) zostaje jako osobny follow-up — wymagałby zmiany
// współdzielonego kontraktu `env.db.query` (patrz src/db.js), używanego też
// przez PGlite w testach.

import { fileURLToPath } from 'node:url';
import { loadMigrations } from './postgres-migrations.js';
import { describeError, log } from './log.js';

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

// Sprawdzenia trwające dla danej instancji `env.db`. Klucz to sam obiekt
// `db` (WeakMap), więc różne środowiska (różne pule/testy) nigdy się nie
// mieszają, a wpis znika sam, gdy `db` przestaje być używane.
const inflightChecks = new WeakMap();

/**
 * @returns {Promise<{ ready: boolean, body: object }>}
 */
export async function checkReadiness(env = {}, options = {}) {
  if (!env?.db || typeof env.db.query !== 'function') {
    return { ready: false, body: { status: 'not_ready', checks: { database: 'not_configured' } } };
  }
  const existing = inflightChecks.get(env.db);
  if (existing) return existing;
  const promise = performReadinessCheck(env.db, options);
  inflightChecks.set(env.db, promise);
  try {
    return await promise;
  } finally {
    // Tylko sprzątanie „własnego” wpisu — na wypadek, gdyby db zdążyło
    // w międzyczasie dostać nowy wpis (nie powinno, ale nie nadpisujemy cudzego).
    if (inflightChecks.get(env.db) === promise) inflightChecks.delete(env.db);
  }
}

async function performReadinessCheck(db, {
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  migrationNames = repositoryMigrationNames,
  logger = log,
} = {}) {
  try {
    const expected = await migrationNames();
    const result = await withTimeout((async () => {
      await db.query('SELECT 1');
      const table = await db.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
      if (!table.rows?.[0]?.present) return { applied: null };
      const { rows } = await db.query('SELECT name FROM schema_migrations');
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
      return { ready: false, body: { status: 'not_ready', checks: { database: 'ok', migrations: 'pending' }, migrations } };
    }
    return { ready: true, body: { status: 'ready', checks: { database: 'ok', migrations: 'ok' }, migrations: { expected: expected.length, applied: expected.length } } };
  } catch (error) {
    const detail = describeError(error);
    logger.error('readiness_database_error', detail);
    return { ready: false, body: { status: 'not_ready', checks: { database: detail.code === 'timeout' ? 'timeout' : 'error' } } };
  }
}
