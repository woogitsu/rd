// Krótki wariant scenariusza "heavy" (#217) — mała skala (2 lata, 2 klasy/rok,
// 12 uczniów/rok, 50 zdarzeń audytu) na PGlite w procesie, żeby CI zostanie
// szybki. Pełny przebieg z realną skalą: `npm run load:test -- --scenario heavy`
// (docs/RAILWAY_OPERATIONS.md) — nie jest wymagany na PR (#111, nocny).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { startServer } from '../src/server.js';
import { handlePgRequest } from '../src/pg/app.js';
import { pgliteClient } from '../scripts/smoke-postgres.js';
import {
  buildHistoricalData, checkHeavyBudgets, HEAVY_ROUTE_BUDGETS_MS, insertHistoricalData, runHeavyScenario, seedHeavySessions,
} from '../scripts/lib/heavy-scenario.js';
import { loadTest, parseArgs } from '../scripts/load-test.js';

const migrationsDir = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const SMALL_HEAVY = { years: 2, classesPerYear: 2, studentsPerYear: 12, auditEvents: 50 };

async function startSmallHeavyTarget() {
  const db = new PGlite();
  await applyMigrations(pgliteClient(db), await loadMigrations(migrationsDir));
  const data = buildHistoricalData(SMALL_HEAVY);
  const reconciliationId = await insertHistoricalData(db, data);
  const cookies = await seedHeavySessions(db, data.users.map(([id]) => id));
  const roles = new Map(data.grants.map(([, userId, role]) => [userId, role]));
  const actors = data.users.map(([userId]) => ({ userId, role: roles.get(userId), cookie: cookies.get(userId) }));
  const server = await startServer({
    host: '127.0.0.1', port: 0, distRoot, env: { db, APP_ENV: 'load-test' }, fetchHandler: handlePgRequest,
  });
  return {
    db, data, reconciliationId, actors,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

test('--scenario parses to "heavy" and rejects an unknown value', () => {
  assert.equal(parseArgs(['--scenario', 'heavy']).scenario, 'heavy');
  assert.equal(parseArgs([]).scenario, 'light');
  assert.throws(() => parseArgs(['--scenario', 'bogus']));
  const options = parseArgs(['--scenario', 'heavy', '--heavy-years', '3', '--heavy-audit-events', '500']);
  assert.equal(options.heavy.years, 3);
  assert.equal(options.heavy.auditEvents, 500);
});

test('checkHeavyBudgets: a breached route is reported by name with its p50 and budget', () => {
  const ok = { 'GET /api/classes': { errors: 0, latencyMs: { p50: 10 }, budgetMs: 300 } };
  assert.deepEqual(checkHeavyBudgets(ok), []);
  const breached = { 'GET /api/print/cards': { errors: 0, latencyMs: { p50: 5000 }, budgetMs: 300 } };
  const breaches = checkHeavyBudgets(breached);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /GET \/api\/print\/cards/);
  assert.match(breaches[0], /5000 ms > budżet 300 ms/);
  const failed = { 'GET /api/households/{id}': { errors: 2, latencyMs: { p50: 1 }, budgetMs: 300 } };
  assert.match(checkHeavyBudgets(failed)[0], /2 błędnych odpowiedzi/);
});

test('heavy scenario: routes run, budgets present, and no e-mail is queued', { timeout: 120_000 }, async () => {
  const target = await startSmallHeavyTarget();
  try {
    const result = await runHeavyScenario({
      baseUrl: target.baseUrl, actors: target.actors, latestYear: target.data.latestYear,
      classId: target.data.latestClassId, householdId: target.data.latestHouseholdId,
      otherHouseholdId: target.data.latestOtherHouseholdId, reconciliationId: target.reconciliationId,
      iterations: 2, timeoutMs: 20_000,
    });
    const routeNames = [
      'GET /api/classes', 'GET /api/classes/{id}/students', 'GET /api/households/{id}',
      'GET /api/print/cards', 'GET /api/ledger/export.csv', 'GET /api/reports/audit',
      'GET /api/reconciliations', 'POST /api/reconciliations/{id}/lines',
      'GET /api/reconciliations/{id}', 'GET /api/reconciliations/{id}/suggestions',
      'GET /api/households/{id} (representative, out of scope)',
    ];
    for (const name of routeNames) {
      const entry = result.byOperation[name];
      assert.ok(entry, `missing operation ${name}`);
      assert.equal(entry.errors, 0, `${name}: ${JSON.stringify(entry)}`);
      assert.ok(entry.requests > 0);
      assert.equal(typeof entry.latencyMs.p50, 'number');
      assert.equal(typeof entry.responseBytes, 'number');
    }
    // Budżety z tabeli HEAVY_ROUTE_BUDGETS_MS — każda znana trasa ma budżet.
    assert.equal(result.byOperation['GET /api/classes'].budgetMs, HEAVY_ROUTE_BUDGETS_MS['GET /api/classes']);
    assert.equal(typeof result.peakHeapUsedMb, 'number');
    assert.equal(typeof result.maxEventLoopDelayMs, 'number');
    assert.deepEqual(checkHeavyBudgets(result.byOperation), []);

    // Scenariusz nie wysyła żadnej wiadomości: brak wywołań …/queue, brak wierszy email_outbox.
    const outbox = await target.db.query('SELECT count(*)::int AS n FROM email_outbox');
    assert.equal(outbox.rows[0].n, 0);
  } finally {
    await target.close();
  }
});

test('loadTest with scenario "heavy" returns a passing report shaped for the CLI', { timeout: 120_000 }, async () => {
  const report = await loadTest({
    users: 1, durationSec: 1, thinkMs: 0, timeoutMs: 20_000, target: null, allowWrites: null,
    scenario: 'heavy', heavyIterations: 1, heavy: SMALL_HEAVY, thresholds: {},
  });
  assert.equal(report.mode, 'local');
  assert.equal(report.scenario, 'heavy');
  assert.match(report.target, /not representative/);
  assert.deepEqual(report.dataset, { years: 2, students: 24, guardians: 44, auditEvents: 50 });
  assert.equal(typeof report.setupMs, 'number');
  assert.deepEqual(report.breaches, []);
  assert.equal(report.passed, true);
});

test('remote target refuses scenario "heavy" (local-write-only, #217)', async () => {
  await assert.rejects(
    loadTest({ scenario: 'heavy', target: 'https://rd-staging.example.test', heavy: SMALL_HEAVY, heavyIterations: 1 }, { env: {} }),
    /heavy.*locally only/,
  );
});
