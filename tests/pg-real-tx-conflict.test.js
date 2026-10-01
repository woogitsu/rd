// #156: konflikt serializacji (40001) w transakcji REPEATABLE READ na PRAWDZIWYM
// PostgreSQL. PGlite ma jedno połączenie, więc `tests/pg-tx-retry.test.js`
// wstrzykuje 40001 atrapą; tu błąd pochodzi z serwera: dwie transakcje czytają
// ten sam wiersz z migawki, obie go aktualizują, a druga dostaje 40001
// („could not serialize access due to concurrent update”). Plik działa wyłącznie
// z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Wyłącznie dane syntetyczne w tabeli tymczasowej testu, żadnej sieci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDbError } from '../src/pg/db-errors.js';
import { createRealTestDb } from './helpers/pg.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';

async function withReal(fn) {
  const db = await createRealTestDb();
  try {
    await db.exec('CREATE TABLE tx_conflict_probe (id text PRIMARY KEY, value integer NOT NULL)');
    await db.query("INSERT INTO tx_conflict_probe (id, value) VALUES ('counter', 0)");
    return await fn(db);
  } finally { await db.close(); }
}

// Dwie transakcje REPEATABLE READ: obie czytają licznik z migawki, dopiero potem
// (bariera) obie go zwiększają. Bariera dotyczy tylko pierwszej próby każdej.
function conflictingIncrements(db, options) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const attempts = { a: 0, b: 0 };
  const run = (name) => db.transaction(async (tx) => {
    attempts[name] += 1;
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const { rows } = await tx.query("SELECT value FROM tx_conflict_probe WHERE id = 'counter'");
    if (attempts[name] === 1) {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    }
    await tx.query("UPDATE tx_conflict_probe SET value = $1 WHERE id = 'counter'", [rows[0].value + 1]);
    return rows[0].value + 1;
  }, options);
  return { attempts, results: Promise.allSettled([run('a'), run('b')]) };
}

test('#156: konflikt REPEATABLE READ z serwera (40001) jest ponawiany — oba przyrosty zapisane, bez utraty aktualizacji', { skip }, async () => {
  await withReal(async (db) => {
    const { attempts, results } = conflictingIncrements(db);
    const settled = await results;
    assert.deepEqual(settled.map((r) => r.status), ['fulfilled', 'fulfilled']);
    const { rows } = await db.query("SELECT value FROM tx_conflict_probe WHERE id = 'counter'");
    assert.equal(rows[0].value, 2);
    // Dokładnie jedna z transakcji musiała powtórzyć funkcję (druga próba widzi nową migawkę).
    assert.equal(attempts.a + attempts.b, 3);
  });
});

test('#156: z { retries: 0 } konflikt 40001 trafia do wywołującego, a zapis przegranej transakcji nie zostaje', { skip }, async () => {
  await withReal(async (db) => {
    const { attempts, results } = conflictingIncrements(db, { retries: 0 });
    const settled = await results;
    const rejected = settled.filter((r) => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, '40001');
    assert.equal(attempts.a + attempts.b, 2);
    const { rows } = await db.query("SELECT value FROM tx_conflict_probe WHERE id = 'counter'");
    assert.equal(rows[0].value, 1);
    // Router (siatka bezpieczeństwa w app.js) zwróciłby to jako 503 retry_later + Retry-After.
    assert.deepEqual(classifyDbError(rejected[0].reason), { error: 'retry_later', status: 503, retryAfter: 1, class: 'transient' });
  });
});
