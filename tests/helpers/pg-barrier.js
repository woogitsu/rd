// Bariera dla testów współbieżności na PRAWDZIWYM PostgreSQL (#208).
// PGlite wykonuje transakcje po kolei, więc `Promise.all` na nim nie tworzy
// wyścigu. Tu przeplot jest wymuszany, a nie zgadywany:
//
//   const first = barrierEnv(db, { pauseAfter: /INSERT INTO payment_entries/ });
//   const a = callApi(first.env, 'POST', '/api/payments', cookie, body, 'klucz');
//   await first.reached;                       // A trzyma blokady, jeszcze bez COMMIT
//   const b = callApi(barrierEnv(db).env, …);  // B startuje w tym czasie
//   await waitForLockWaiters(db, 1);           // B naprawdę czeka w bazie (pg_stat_activity)
//   first.release();                           // A zatwierdza, B widzi wynik A
//
// Każda transakcja biegnie z `retries: 0` (ponowienie 40001/40P01 w src/db.js
// ukryłoby błąd), a kody SQLSTATE lądują w `errors` — gałąź „23505 →
// odtworzenie zapisu” jest wtedy widoczna jako `errors.includes('23505')`.
//
// `rewrite(sql, params)` służy WYŁĄCZNIE kontroli pozytywnej (mutacja w teście):
// zwraca zmieniony tekst SQL albo `null`, aby pominąć zapytanie (np. blokadę
// doradczą). Dzięki temu test pokazuje, że bez danej blokady wynik jest zły,
// czyli że wykrywa jej usunięcie. Wyłącznie dane syntetyczne, żadnej sieci.
import { setTimeout as sleep } from 'node:timers/promises';
import { handlePgRequest } from '../../src/pg/app.js';
import { request } from './pg.js';

export const SQLSTATE = /^[0-9A-Z]{5}$/;

export function barrierEnv(db, { pauseAfter = null, rewrite = null, extra = {}, errors = [] } = {}) {
  let armed = Boolean(pauseAfter);
  let reach;
  let open;
  const reached = new Promise((resolve) => { reach = resolve; });
  const gate = new Promise((resolve) => { open = resolve; });
  const run = async (executor, sql, params) => {
    let text = String(sql);
    if (rewrite) {
      const next = rewrite(text, params);
      if (next === null) return { rows: [] };
      text = next;
    }
    return executor.query(text, params);
  };
  const env = {
    ...extra,
    db: {
      query: (sql, params) => run(db, sql, params),
      probe: (...a) => db.probe(...a),
      transaction: async (fn) => {
        try {
          return await db.transaction((tx) => fn({
            query: async (sql, params) => {
              const result = await run(tx, sql, params);
              if (armed && pauseAfter.test(String(sql))) { armed = false; reach(); await gate; }
              return result;
            },
          }), { retries: 0 });
        } catch (error) {
          if (typeof error?.code === 'string' && SQLSTATE.test(error.code)) errors.push(error.code);
          throw error;
        }
      },
    },
  };
  return { env, errors, reached, release: () => open() };
}

// Mutacje używane w kontrolach pozytywnych.
export const dropForUpdate = (pattern) => (sql) => (pattern.test(sql) ? sql.replace(/\s+FOR UPDATE(?: OF \w+)?/g, '') : sql);
export const dropAdvisoryLock = (matches = () => true) => (sql, params) => (
  /pg_advisory_xact_lock/.test(sql) && matches(sql, params) ? null : sql
);

export async function callApi(env, method, path, cookie, body, idempotencyKey = null) {
  const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
  const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data, replayed: response.headers.get('Idempotency-Replayed') };
}

// Czeka, aż co najmniej `n` połączeń aplikacji czeka w bazie na blokadę.
// Zwraca posortowaną listę wait_event (np. 'advisory', 'transactionid', 'tuple').
export async function waitForLockWaiters(db, n = 1, options = {}) {
  return (await waitForLockWaitersWithQuery(db, n, options)).map((row) => row.event);
}

// Jak wyżej, ale z tekstem zapytania, które czeka (`pg_stat_activity.query`).
// Pozwala odróżnić „czeka na FOR UPDATE / blokadę doradczą” (punkt serializacji
// w kodzie) od „doszło do INSERT i czeka na indeks unikalny” — tę drugą sytuację
// daje usunięcie blokady, gdy ograniczenie w bazie nadal chroni dane.
export async function waitForLockWaitersWithQuery(db, n = 1, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let waiters = [];
  let previous = null;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT wait_event, query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
        ORDER BY wait_event, query`,
    );
    waiters = rows.map((row) => ({ event: row.wait_event, query: row.query }));
    // Dwa kolejne identyczne odczyty: `wait_event_type` i `query` jednego procesu bywają
    // chwilowo niespójne (nocny przebieg 20×: czekający z tekstem poprzedniej instrukcji
    // `SET LOCAL lock_timeout`), więc pierwszy odczyt z czekającym nie wystarcza.
    const snapshot = JSON.stringify(waiters);
    if (waiters.length >= n && snapshot === previous) return waiters;
    previous = snapshot;
    await sleep(10);
  }
  return waiters;
}

// Czeka, aż obietnica się rozstrzygnie, najwyżej `ms`; zwraca 'settled' albo 'pending'.
export async function settledWithin(promise, ms) {
  return Promise.race([promise.then(() => 'settled', () => 'settled'), sleep(ms).then(() => 'pending')]);
}

export async function countRows(db, sql, params = []) {
  return Number((await db.query(sql, params)).rows[0].n);
}
