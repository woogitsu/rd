// #244: sonda /health/ready nie może trzymać połączenia z puli dłużej niż budżet
// czasu, a równoległe sondy nie mogą tworzyć kolejki klientów puli.
// Dowody: (1) atrapa puli liczy connect/zapytania, (2) PGlite jako serwer, który
// naprawdę anuluje zapytanie przez statement_timeout, (3) prawdziwy PostgreSQL
// z RD_TEST_PG_URL (pg_stat_activity) — pomijany bez zmiennej, nie jest jedynym dowodem.
// Wyłącznie dane syntetyczne.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createPgDatabase } from '../src/db.js';
import { checkReadiness } from '../src/health.js';
import { createLogger } from '../src/log.js';

const logger = createLogger({ level: 'error', sink: () => {} });
const noMigrations = { migrations: async () => [] };

// Atrapa puli: każde zapytanie „wisi” do zwolnienia bramki; zapisuje wywołania.
function fakePool({ hang = true, connectDelay = 0 } = {}) {
  const state = { connects: 0, released: [], queries: [], timeouts: [], gate: null };
  state.gate = new Promise((resolve) => { state.open = resolve; });
  const pool = {
    on() {},
    async query() { throw new Error('probe nie może używać pool.query'); },
    async connect() {
      state.connects += 1;
      if (connectDelay) await sleep(connectDelay);
      return {
        async query(text, params) {
          state.queries.push(text);
          if (text.includes('set_config')) { state.timeouts.push(Number(params[0])); return { rows: [] }; }
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] };
          if (hang) await state.gate;
          return { rows: text.includes('to_regclass') ? [{ present: false }] : [] };
        },
        release(broken) { state.released.push(Boolean(broken)); },
      };
    },
  };
  return { pool, state };
}

test('sonda ustawia SET LOCAL statement_timeout równy pozostałemu budżetowi przed każdym zapytaniem', async () => {
  const { pool, state } = fakePool({ hang: false });
  const db = createPgDatabase(pool);
  const result = await checkReadiness({ db }, { logger, timeoutMs: 2000, ...noMigrations });
  assert.equal(result.ready, true); // brak schema_migrations, ale lista oczekiwanych migracji pusta
  assert.equal(state.connects, 1);
  assert.equal(state.timeouts.length, 2); // SELECT 1 + sprawdzenie schema_migrations
  for (const ms of state.timeouts) assert.ok(ms >= 1 && ms <= 2000, `budżet ${ms}`);
  assert.ok(state.timeouts[1] <= state.timeouts[0]);
  assert.equal(state.queries[0], 'BEGIN');
  assert.equal(state.queries.at(-1), 'COMMIT');
  assert.deepEqual(state.released, [false]);
});

test('50 równoległych sond przy wiszącej bazie: jedno połączenie, wszystkie 503/timeout w budżecie, brak kolejki puli', async () => {
  const { pool, state } = fakePool({ hang: true });
  const db = createPgDatabase(pool);
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 50 }, () => checkReadiness({ db }, { logger, timeoutMs: 150, ...noMigrations })));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `sondy trwały ${elapsed} ms`);
  for (const result of results) {
    assert.equal(result.ready, false);
    assert.equal(result.body.checks.database, 'timeout');
  }
  assert.equal(state.connects, 1);
  // Zapytanie porzuconej sondy nadal wisi w atrapie (jak zapytanie u wolnego serwera,
  // zanim je anuluje) — kolejna fala nie tworzy drugiego połączenia, tylko probe_busy.
  const wave = await Promise.all(Array.from({ length: 20 }, () => checkReadiness({ db }, { logger, timeoutMs: 150, ...noMigrations })));
  for (const result of wave) assert.equal(result.body.checks.database, 'timeout');
  assert.equal(state.connects, 1);
  assert.equal(state.released.length, 0);
  // Serwer „anuluje” zapytanie: połączenie wraca do puli, kolejna sonda działa.
  state.open();
  await sleep(20);
  assert.deepEqual(state.released, [false]);
  const after = await checkReadiness({ db }, { logger, timeoutMs: 150, ...noMigrations });
  assert.equal(after.body.checks.database, 'ok');
  assert.equal(state.connects, 2);
});

test('sonda czekająca na wolne połączenie porzuca je po dojściu i nie wykonuje zapytań', async () => {
  const { pool, state } = fakePool({ hang: false, connectDelay: 120 });
  const db = createPgDatabase(pool);
  const result = await checkReadiness({ db }, { logger, timeoutMs: 30, ...noMigrations });
  assert.equal(result.body.checks.database, 'timeout');
  await sleep(200);
  assert.deepEqual(state.queries, []);
  assert.deepEqual(state.released, [false]);
  // Po porzuconej sondzie licznik jest wolny.
  const next = await checkReadiness({ db }, { logger, timeoutMs: 1000, ...noMigrations });
  assert.equal(next.body.checks.database, 'ok');
});

test('błąd pool.connect zwalnia miejsce sondy', async () => {
  let fail = true;
  const pool = {
    on() {},
    async query() { throw new Error('probe nie może używać pool.query'); },
    async connect() {
      if (fail) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return { async query(text) { return { rows: text.includes('to_regclass') ? [{ present: false }] : [] }; }, release() {} };
    },
  };
  const db = createPgDatabase(pool);
  const first = await checkReadiness({ db }, { logger, ...noMigrations });
  assert.equal(first.body.checks.database, 'error');
  fail = false;
  const second = await checkReadiness({ db }, { logger, ...noMigrations });
  assert.equal(second.body.checks.database, 'ok');
});

// PGlite jako serwer, który naprawdę egzekwuje statement_timeout.
function pglitePool(lite) {
  const state = { released: 0 };
  return {
    state,
    pool: {
      on() {},
      async query() { throw new Error('probe nie może używać pool.query'); },
      async connect() {
        return {
          async query(text, params = []) { const r = await lite.query(text, params); return { rows: r.rows }; },
          release() { state.released += 1; },
        };
      },
    },
  };
}

test('PGlite: serwer anuluje wolne zapytanie sondy po budżecie (57014), transakcja wycofana, brak przecieku ustawień', async () => {
  const lite = new PGlite();
  try {
    const { pool, state } = pglitePool(lite);
    const db = createPgDatabase(pool);
    const started = Date.now();
    await assert.rejects(
      db.probe(async (q) => { await q.query('SELECT pg_sleep(5)'); }, { timeoutMs: 200 }),
      (error) => ['timeout', '57014'].includes(error.code),
    );
    assert.ok(Date.now() - started < 2000);
    // Po wycofaniu SET LOCAL nie zostaje na sesji: zwykłe zapytanie nie ma limitu 200 ms.
    const shown = await lite.query("SELECT current_setting('statement_timeout') AS v");
    assert.equal(shown.rows[0].v, '0');
    await lite.query('SELECT pg_sleep(0.3)');
    assert.equal(state.released, 1);
  } finally {
    await lite.close();
  }
});

// Prawdziwy PostgreSQL (opcjonalnie): pg_stat_activity nie zawiera porzuconej sondy,
// a zwykłe zapytanie API ma dostęp do puli podczas 50 sond.
const ADMIN_URL = process.env.RD_TEST_PG_URL;
const skip = ADMIN_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';

test('PostgreSQL: wolne zapytanie sondy znika z pg_stat_activity po budżecie, pula zostaje dostępna', { skip }, async () => {
  const db = createPgDatabase({ connectionString: ADMIN_URL, max: 3, application_name: 'rd_probe_test' });
  const watcher = new pg.Client({ connectionString: ADMIN_URL });
  await watcher.connect();
  try {
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 50 }, () => db.probe(async (q) => { await q.query('SELECT pg_sleep(10)'); }, { timeoutMs: 300 }).then(() => 'ok', (error) => error.code)));
    assert.ok(Date.now() - started < 2000);
    assert.ok(results.every((code) => ['timeout', 'probe_busy'].includes(code)), JSON.stringify(results));
    await sleep(300); // czas na anulowanie przez serwer
    const active = await watcher.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'rd_probe_test' AND state <> 'idle' AND query LIKE '%pg_sleep%'");
    assert.equal(active.rows[0].n, 0);
    const plain = await db.query('SELECT 1 AS one');
    assert.equal(plain.rows[0].one, 1);
    const readiness = await checkReadiness({ db }, { logger, timeoutMs: 1000, migrations: async () => [] });
    assert.equal(readiness.body.checks.database, 'ok');
  } finally {
    await watcher.end();
    await db.close();
  }
});
