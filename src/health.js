// Gotowość (readiness) serwera Node: /health/ready.
//
// /health (liveness) potwierdza tylko, że proces odpowiada — tak jak dotąd.
// /health/ready dodatkowo sprawdza bazę, gdy jest skonfigurowana (env.db):
//   1. `SELECT` z krótkim limitem czasu, który przy okazji odczytuje
//      `transaction_read_only` (#149): baza tylko do odczytu (replika, tryb
//      awaryjny) przy normalnym `APP_WRITE_MODE` to 503 `database: "read_only"`,
//      bez żadnego zapisu kontrolnego i bez tworzenia danych,
//   2. czy tabela schema_migrations zawiera wszystkie pliki z postgres/migrations,
//   3. czy suma kontrolna każdego nałożonego pliku zgadza się z repozytorium (#79),
//   4. przy APP_ENV=production: czy aplikacja nie działa rolą właściciela tabel
//      ani superużytkownikiem (SR-05, #101). To tylko OSTRZEŻENIE w logu
//      (`readiness_database_role_privileged`, bez nazwy roli i danych), nie
//      zmienia gotowości i nie trafia do publicznej odpowiedzi; powtarza się
//      najwyżej raz na godzinę na instancję bazy. Rola `rd_app` (migracja 0170)
//      nie jest właścicielem i nie ostrzega.
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
import { isProductionEnv } from './app-env.js';
import { loadMigrations } from './postgres-migrations.js';
import { describeError, log } from './log.js';
import { isReadOnly, WRITE_MODE_NORMAL, WRITE_MODE_READ_ONLY } from './write-mode.js';

export const DEFAULT_READINESS_TIMEOUT_MS = 2000;
export const PRIVILEGED_ROLE_WARN_INTERVAL_MS = 60 * 60 * 1000;
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
// Ostatnie ostrzeżenie o roli uprzywilejowanej dla danej instancji `env.db`.
const lastRoleWarning = new WeakMap();

// Czy rola połączenia jest superużytkownikiem albo właścicielem (także przez
// członkostwo) tabeli schema_migrations. Tylko katalog systemowy, żadnych danych.
// Błąd lub nietypowa odpowiedź (atrapa bazy) = brak ostrzeżenia, nigdy niegotowość.
async function privilegedRole(q) {
  try {
    const { rows } = await q.query(
      `SELECT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS superuser,
              COALESCE((SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = to_regclass('public.schema_migrations')), false) AS owner`,
    );
    const row = rows?.[0];
    if (!row || (row.superuser !== true && row.owner !== true)) return null;
    return { superuser: row.superuser === true, owner: row.owner === true };
  } catch {
    return null;
  }
}

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
  const promise = performReadinessCheck(env.db, { appEnv: env.APP_ENV, ...options, expectWritable: writeMode === WRITE_MODE_NORMAL });
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
  expectWritable = true,
  appEnv,
  now = () => Date.now(),
} = {}) {
  try {
    const expected = await migrationsProvider();
    const warnPrivileged = isProductionEnv(appEnv);
    const runChecks = async (q) => {
      const probeRow = await q.query("SELECT current_setting('transaction_read_only') AS read_only");
      const readOnly = probeRow.rows?.[0]?.read_only === 'on';
      const table = await q.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present");
      if (!table.rows?.[0]?.present) return { applied: null, readOnly, privileged: null };
      const { rows } = await q.query('SELECT name, checksum FROM schema_migrations');
      return { applied: new Map(rows.map((row) => [row.name, row.checksum])), readOnly, privileged: warnPrivileged ? await privilegedRole(q) : null };
    };
    // Prawdziwa pula (src/db.js) udostępnia `probe`: zapytania mają budżet
    // czasu po stronie serwera (SET LOCAL statement_timeout), więc po
    // przekroczeniu 2 s PostgreSQL je anuluje, a połączenie wraca do puli (#244).
    // Atrapy i PGlite nie mają `probe` — wtedy sam wyścig z czasem.
    const result = typeof db.probe === 'function'
      ? await db.probe(runChecks, { timeoutMs })
      : await withTimeout(runChecks(db), timeoutMs);
    if (result.privileged) {
      const at = now();
      const last = lastRoleWarning.get(db);
      if (last === undefined || at - last >= PRIVILEGED_ROLE_WARN_INTERVAL_MS) {
        lastRoleWarning.set(db, at);
        logger.warn('readiness_database_role_privileged', result.privileged);
      }
    }
    if (result.readOnly && expectWritable) {
      logger.error('readiness_database_read_only', {});
      return { ready: false, body: { status: 'not_ready', checks: { database: 'read_only' } } };
    }
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
