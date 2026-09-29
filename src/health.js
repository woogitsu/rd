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
import { isReadOnly, WRITE_MODE_NORMAL, WRITE_MODE_READ_ONLY } from './write-mode.js';

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

// Sprawdzenia trwające dla danej instancji `env.db`. Klucz to sam obiekt
// `db` (WeakMap), więc różne środowiska (różne pule/testy) nigdy się nie
// mieszają, a wpis znika sam, gdy `db` przestaje być używane.
const inflightChecks = new WeakMap();

/**
 * @returns {Promise<{ ready: boolean, body: object }>}
 */
export async function checkReadiness(env = {}, options = {}) {
  const writeMode = isReadOnly(env) ? WRITE_MODE_READ_ONLY : WRITE_MODE_NORMAL;
  const withWriteMode = ({ ready, body }) => ({ ready, body: { ...body, write_mode: writeMode } });
  if (!env?.db || typeof env.db.query !== 'function') {
    return withWriteMode({ ready: false, body: { status: 'not_ready', checks: { database: 'not_configured' } } });
  }
  const existing = inflightChecks.get(env.db);
  if (existing) return existing.then(withWriteMode);
  const promise = performReadinessCheck(env.db, options);
  inflightChecks.set(env.db, promise);
  try {
    return withWriteMode(await promise);
  } finally {
    // Tylko sprzątanie „własnego” wpisu — na wypadek, gdyby db zdążyło
    // w międzyczasie dostać nowy wpis (nie powinno, ale nie nadpisujemy cudzego).
    if (inflightChecks.get(env.db) === promise) inflightChecks.delete(env.db);
  }
}

async function performReadinessCheck(db, {
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  migrations: migrationsProvider = repositoryMigrations,
  logger = log,
} = {}) {
  try {
    const expected = await migrationsProvider();
    const runChecks = async (q) => {
      await q.query('SELECT 1');
      const table = await q.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
      if (!table.rows?.[0]?.present) return { applied: null };
      const { rows } = await q.query('SELECT name, checksum FROM schema_migrations');
      return { applied: new Map(rows.map((row) => [row.name, row.checksum])) };
    };
    // Prawdziwa pula (src/db.js) udostępnia `probe`: zapytania mają budżet
    // czasu po stronie serwera (SET LOCAL statement_timeout), więc po
    // przekroczeniu 2 s PostgreSQL je anuluje, a połączenie wraca do puli (#244).
    // Atrapy i PGlite nie mają `probe` — wtedy sam wyścig z czasem.
    const result = typeof db.probe === 'function'
      ? await db.probe(runChecks, { timeoutMs })
      : await withTimeout(runChecks(db), timeoutMs);
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
    return { ready: false, body: { status: 'not_ready', checks: { database: ['timeout', 'probe_busy', '57014', '55P03'].includes(detail.code) ? 'timeout' : 'error' } } };
  }
}
