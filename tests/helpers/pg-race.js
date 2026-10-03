// Wspólny szkielet testów wyścigu na PRAWDZIWYM PostgreSQL (#208), nad
// `tests/helpers/pg-barrier.js`. Używają go `pg-real-record-locks.test.js`
// i `pg-real-replay-23505.test.js`. Wyłącznie dane syntetyczne, bez sieci.
//
//   const r = await race(db, {
//     pauseAfter: /UPDATE students SET first_name/,         // A staje w transakcji po tym zapytaniu
//     first: (env) => callApi(env, 'PATCH', path, cookieA, body),
//     second: (env) => callApi(env, 'PATCH', path, cookieB, body),
//   });
//   assertWaitsOn(r, /^SELECT s\.id, s\.first_name/, 'B czeka na blokadę wiersza ucznia');
//
// `race` sprawdza, że A doszło do bariery, że B startuje osobnym połączeniem,
// czeka w bazie na blokadę (`pg_stat_activity`, `wait_event_type = 'Lock'`) i
// nie kończy się przed zatwierdzeniem A. Dopiero potem puszcza A.
import assert from 'node:assert/strict';
import { createRealTestDb } from './pg.js';
import { barrierEnv, countRows, settledWithin, waitForLockWaitersWithQuery } from './pg-barrier.js';

let seq = 0;
export const raceKey = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;

export const auditCount = (db, action) => countRows(db, 'SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action]);

export async function withReal(fn) {
  const db = await createRealTestDb();
  try { return await fn(db); } finally { await db.close(); }
}

/**
 * A z barierą (`pauseAfter`), potem B. Zwraca wyniki obu, kody SQLSTATE
 * transakcji (`errors`, np. '23505') i listę czekających (`waits`, `waitingSql`).
 * `extra` trafia do `env` obu żądań (np. `storage` dla dokumentów). `rewrite`
 * (jak w `barrierEnv`) służy WYŁĄCZNIE kontroli pozytywnej: zmienia SQL obu żądań.
 */
export async function race(db, { pauseAfter, first, second, extra = {}, rewrite = null }) {
  const errors = [];
  const gated = barrierEnv(db, { pauseAfter, errors, extra, rewrite });
  const a = first(gated.env);
  const early = await Promise.race([gated.reached.then(() => null), a.then((r) => r, (e) => e)]);
  assert.equal(early, null, `pierwsze żądanie zakończyło się bez dojścia do bariery: ${JSON.stringify(early?.body ?? String(early))}`);
  const pending = second(barrierEnv(db, { errors, extra, rewrite }).env);
  let waiters = [];
  try {
    waiters = await waitForLockWaitersWithQuery(db, 1);
    assert.equal(await settledWithin(pending, 150), 'pending', 'drugie żądanie nie może się zakończyć przed zatwierdzeniem pierwszego');
  } finally { gated.release(); }
  const [ra, rb] = await Promise.all([a, pending]);
  return { a: ra, b: rb, errors, waits: waiters.map((w) => w.event), waitingSql: waiters.map((w) => w.query).join('\n') };
}

// B czeka w bazie dokładnie w jednym miejscu, a tekst czekającego zapytania
// pasuje do wzorca. `pg_stat_activity.query` jest obcinane do 1024 znaków, więc
// wzorce opisują POCZĄTEK zapytania; zwykły SELECT czeka tylko na `FOR UPDATE`,
// a INSERT/UPDATE — na indeks unikalny albo wiersz zablokowany przez A.
export function assertWaitsOn({ waits, waitingSql }, pattern, message, { event = null } = {}) {
  assert.equal(waits.length, 1, `${message}: ${JSON.stringify(waits)}`);
  assert.match(waitingSql, pattern, `${message} — czekające zapytanie: ${waitingSql}`);
  if (event) assert.deepEqual(waits, [event], `${message}: zdarzenie oczekiwania`);
}
