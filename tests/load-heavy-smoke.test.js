// Krótki wariant scenariusza "heavy" (#217) — mała skala (2 lata, 2 klasy/rok,
// 12 uczniów/rok, 50 zdarzeń audytu, import 12 wierszy) na PGlite w procesie,
// żeby CI zostało szybkie. Pełny przebieg z realną skalą:
// `npm run load:test -- --scenario heavy --heavy-full` (docs/RAILWAY_OPERATIONS.md)
// — nie jest wymagany na PR (#111, nocny).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  buildHistoricalData, checkHeavyBudgets, HEAVY_FULL_SCALE, HEAVY_ROUTE_BUDGETS_MS, HEAVY_ROUTE_HEAP_BUDGETS_MB,
  instrumentDb, runHeavyScenario,
} from '../scripts/lib/heavy-scenario.js';
import { loadTest, parseArgs, startHeavyTarget } from '../scripts/load-test.js';

const SMALL_HEAVY = { years: 2, classesPerYear: 2, studentsPerYear: 12, auditEvents: 50, importRows: 12 };

// Tabele biznesowe, których tryb tylko do odczytu nie może zmienić (dzienniki
// odczytu — audit_events, data_access_log, export_runs — są skutkiem każdego odczytu).
const BUSINESS_TABLES = ['payment_entries', 'ledger_entries', 'import_batches', 'students', 'guardians', 'enrollments',
  'email_campaigns', 'email_campaign_recipients', 'email_outbox', 'bank_statement_lines', 'school_year_closures'];

async function counts(db) {
  const result = {};
  for (const table of BUSINESS_TABLES) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
    result[table] = rows[0].n;
  }
  return result;
}

async function getJson(target, role, path) {
  const actor = target.actors.find((a) => a.role === role);
  const response = await fetch(`${target.baseUrl}${path}`, { headers: { Cookie: actor.cookie } });
  return { status: response.status, json: await response.json() };
}

test('--scenario, --heavy-full and heavy flags parse; unknown scenario is rejected', () => {
  assert.equal(parseArgs(['--scenario', 'heavy']).scenario, 'heavy');
  assert.equal(parseArgs([]).scenario, 'light');
  assert.throws(() => parseArgs(['--scenario', 'bogus']));
  const options = parseArgs(['--scenario', 'heavy', '--heavy-years', '3', '--heavy-audit-events', '500',
    '--heavy-import-rows', '40', '--heavy-concurrency', '3']);
  assert.equal(options.heavy.years, 3);
  assert.equal(options.heavy.auditEvents, 500);
  assert.equal(options.heavy.importRows, 40);
  assert.equal(options.heavyConcurrency, 3);
  assert.equal(parseArgs([]).heavyConcurrency, 5);
  // Pełna skala z opisu issue; późniejsza flaga nadpisuje pojedynczy wymiar.
  const full = parseArgs(['--scenario', 'heavy', '--heavy-full', '--heavy-audit-events', '1000']);
  assert.deepEqual({ ...full.heavy, auditEvents: HEAVY_FULL_SCALE.auditEvents }, { ...HEAVY_FULL_SCALE });
  assert.equal(full.heavy.auditEvents, 1000);
});

test('checkHeavyBudgets: breached time or heap budget and errors are reported by route name', () => {
  const ok = { 'GET /api/classes': { errors: 0, latencyMs: { p50: 10 }, budgetMs: 300, heapBudgetMb: null } };
  assert.deepEqual(checkHeavyBudgets(ok), []);
  const breached = { 'GET /api/print/cards': { errors: 0, latencyMs: { p50: 5000 }, budgetMs: 300 } };
  const breaches = checkHeavyBudgets(breached);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0], /GET \/api\/print\/cards/);
  assert.match(breaches[0], /5000 ms > budżet 300 ms/);
  const failed = { 'GET /api/households/{id}': { errors: 2, errorSamples: ['HTTP 500'], latencyMs: { p50: 1 }, budgetMs: 300 } };
  assert.match(checkHeavyBudgets(failed)[0], /2 błędnych odpowiedzi \(HTTP 500\)/);
  const heap = { 'POST /api/exports': { errors: 0, latencyMs: { p50: 1 }, budgetMs: 10_000, heapBudgetMb: 64, memory: { heapDeltaMb: 83 } } };
  assert.match(checkHeavyBudgets(heap)[0], /POST \/api\/exports: przyrost sterty 83 MB > budżet 64 MB/);
  assert.equal(typeof HEAVY_ROUTE_HEAP_BUDGETS_MB['POST /api/exports'], 'number');
});

test('buildHistoricalData: rotation between years, siblings in different classes, two guardians, synthetic e-mails only', () => {
  const data = buildHistoricalData({ years: 3, classesPerYear: 3, studentsPerYear: 20, auditEvents: 0, today: new Date('2026-10-15T00:00:00Z') });
  // Każdy rok ma dokładnie studentsPerYear zapisów; rotacja 1/4 → uczniów łącznie więcej niż na rok.
  assert.equal(data.enrollments.length, 3 * 20);
  assert.equal(data.students.length, 20 + 2 * 5);
  for (const yearId of data.yearIds) assert.equal(data.enrollments.filter((e) => e[3] === yearId).length, 20);
  // Najnowszy rok zawiera dzisiejszą datę.
  assert.deepEqual(data.schoolYears.at(-1).slice(1), ['2026/27', '2026-09-01', '2027-08-31']);
  // Uczeń w kilku latach (karta gospodarstwa sumuje lata).
  const years = new Map();
  for (const [, studentId, , yearId] of data.enrollments) years.set(studentId, (years.get(studentId) ?? new Set()).add(yearId));
  assert.ok([...years.values()].some((set) => set.size === 3));
  // Rodzeństwo: dwoje dzieci jednego gospodarstwa w różnych klasach tego samego roku.
  const siblings = data.householdStudents.get(data.siblingHouseholdId);
  assert.equal(siblings.length, 2);
  const classOf = (studentId) => data.enrollments.find((e) => e[1] === studentId && e[3] === data.latestYear)[2];
  assert.notEqual(classOf(siblings[0]), classOf(siblings[1]));
  // Dwoje opiekunów na gospodarstwo, oboje powiązani z każdym dzieckiem.
  assert.equal(data.guardians.length, 2 * data.households.length);
  assert.equal(data.links.length, 2 * data.students.length);
  // Wyłącznie adresy w zastrzeżonej domenie.
  for (const email of [...data.guardians.map((g) => g[4]), ...data.users.map((u) => u[1])]) assert.match(email, /@example\.invalid$/);
  // Wpłaty częściowe (dwie raty tej samej rodziny w roku), brak wpisu części rodzin, korekty, księga powiązana z wpłatami.
  const perHouseholdYear = new Map();
  for (const [, householdId, yearId] of data.payments) {
    perHouseholdYear.set(`${householdId}:${yearId}`, (perHouseholdYear.get(`${householdId}:${yearId}`) ?? 0) + 1);
  }
  assert.ok([...perHouseholdYear.values()].some((n) => n === 2));
  assert.ok(data.households.some(([id]) => !perHouseholdYear.has(`${id}:${data.latestYear}`)));
  assert.ok(data.corrections.length >= 3 * data.yearIds.length);
  assert.ok(data.ledgerEntries.some((entry) => entry[10] !== null));
  // Gospodarstwo spoza klasy przedstawiciela nie ma dziecka w tej klasie.
  const otherIds = data.householdStudents.get(data.latestOtherHouseholdId);
  assert.ok(otherIds.length > 0 && otherIds.every((id) => data.enrollments.every((e) => e[1] !== id || e[3] !== data.latestYear || e[2] !== data.latestClassId)));
});

test('instrumentDb: counts queries, keeps the slowest SQL text without parameters, measures JS gaps in a transaction', async () => {
  const db = new PGlite();
  try {
    await db.query('SELECT 1'); // rozgrzanie — pierwsze zapytanie PGlite jest wolne
    const stats = instrumentDb(db);
    await stats.db.query('SELECT $1::text AS secret', ['opiekun@example.invalid']);
    await stats.db.transaction(async (tx) => {
      await tx.query('SELECT 1');
      await new Promise((resolve) => setTimeout(resolve, 40));
      await tx.query('SELECT pg_sleep(0.2)');
    });
    const snap = stats.snapshot();
    assert.equal(snap.queries, 3);
    assert.equal(snap.transactions, 1);
    assert.match(snap.slowestQuery, /pg_sleep/);
    assert.ok(snap.maxTxJsGapMs >= 30, JSON.stringify(snap));
    assert.ok(!JSON.stringify(snap).includes('example.invalid'));
    stats.reset();
    assert.equal(stats.snapshot().queries, 0);
  } finally {
    await db.close();
  }
});

test('heavy scenario: read-only pass changes nothing, full pass covers every route, one write per double click, no e-mail', { timeout: 240_000 }, async () => {
  const target = await startHeavyTarget({ heavy: SMALL_HEAVY });
  try {
    const { db, data } = target;

    // Tryb tylko do odczytu (jak zdalnie na stagingu): tabele biznesowe bez zmian.
    const before = await counts(db);
    const readOnly = await runHeavyScenario({
      baseUrl: target.baseUrl, actors: target.actors, ...target.ids, readOnly: true, iterations: 1, concurrency: 2,
    });
    assert.deepEqual(await counts(db), before);
    assert.deepEqual(checkHeavyBudgets(readOnly.byOperation), []);
    assert.ok(!Object.keys(readOnly.byOperation).some((name) => name.startsWith('POST')), Object.keys(readOnly.byOperation).join(', '));
    assert.equal(readOnly.byOperation['GET /api/classes'].memory, undefined);

    // Rodzeństwo i dwoje opiekunów: karta gospodarstwa i kartki mają poprawną liczbę wierszy.
    const card = await getJson(target, 'treasurer', `/api/households/${data.siblingHouseholdId}`);
    assert.equal(card.status, 200);
    assert.equal(card.json.students.length, 2);
    assert.equal(card.json.guardians.length, 2);
    const multiYear = await getJson(target, 'treasurer', `/api/households/${data.latestHouseholdId}`);
    const paidYears = new Set(data.payments.filter((p) => p[1] === data.latestHouseholdId).map((p) => p[2]));
    assert.equal(multiYear.json.paymentTotals.length, paidYears.size);
    const cards = await getJson(target, 'board', `/api/print/cards?schoolYearId=${data.latestYear}`);
    assert.equal(cards.json.rows.length, SMALL_HEAVY.studentsPerYear);
    assert.equal(cards.json.rows.filter((row) => row.householdId === data.siblingHouseholdId).length, 2);
    const classCards = await getJson(target, 'representative', `/api/print/cards?schoolYearId=${data.latestYear}&classId=${data.latestClassId}`);
    const inClass = data.enrollments.filter((e) => e[2] === data.latestClassId).length;
    assert.equal(classCards.json.rows.length, inClass);

    // Pełny przebieg lokalny z zapisami.
    const result = await runHeavyScenario({
      baseUrl: target.baseUrl, actors: target.actors, ...target.ids, dbStats: target.dbStats, iterations: 2, concurrency: 2,
    });
    const routeNames = Object.keys(HEAVY_ROUTE_BUDGETS_MS).concat([
      'GET /api/households/{id} (representative, out of scope)', 'POST /api/exports (representative, 403)',
    ]);
    for (const name of routeNames) {
      const entry = result.byOperation[name];
      assert.ok(entry, `missing operation ${name}`);
      assert.equal(entry.errors, 0, `${name}: ${JSON.stringify(entry)}`);
      assert.ok(entry.requests > 0);
      assert.equal(typeof entry.latencyMs.p50, 'number');
      assert.equal(typeof entry.latencyMs.p95, 'number');
      assert.equal(typeof entry.responseBytes, 'number');
      assert.equal(typeof entry.memory.heapDeltaMb, 'number');
      assert.equal(typeof entry.db.queries, 'number');
      assert.equal(typeof entry.db.maxTxJsGapMs, 'number');
    }
    assert.deepEqual(result.skipped, []);
    // Odczyty mają fazę równoczesną; zapisy — nie.
    assert.equal(result.byOperation['GET /api/print/cards'].concurrent.requests, 4);
    assert.equal(result.byOperation['POST /api/exports'].concurrent, undefined);
    assert.ok(result.byOperation['POST /api/exports'].db.transactions >= 1);
    assert.equal(typeof result.peakRssMb, 'number');
    assert.equal(typeof result.maxEventLoopDelayMs, 'number');
    assert.deepEqual(checkHeavyBudgets(result.byOperation), []);

    // Import: zapis + podwójne kliknięcie i ponowienie → dokładnie dwie partie.
    const batches = await db.query('SELECT count(*)::int AS n FROM import_batches');
    assert.equal(batches.rows[0].n, 2);
    // Podwójne kliknięcie migawki: jedna spójna lista odbiorców (bez duplikatów).
    const snapshots = await db.query(
      `SELECT c.id, c.recipients_count, (SELECT count(*)::int FROM email_campaign_recipients r WHERE r.campaign_id = c.id) AS n
         FROM email_campaigns c`,
    );
    assert.equal(snapshots.rows.length, 2);
    for (const row of snapshots.rows) assert.equal(row.n, row.recipients_count);
    // Zamknięcie najstarszego roku.
    const closure = await db.query('SELECT status FROM school_year_closures WHERE school_year_id = $1', [data.closeYearId]);
    assert.equal(closure.rows[0].status, 'closed');
    // Scenariusz nie wysyła żadnej wiadomości: brak wywołań …/queue, brak wierszy email_outbox.
    const outbox = await db.query('SELECT count(*)::int AS n FROM email_outbox');
    assert.equal(outbox.rows[0].n, 0);
    const notDraft = await db.query("SELECT count(*)::int AS n FROM email_campaigns WHERE status <> 'draft'");
    assert.equal(notDraft.rows[0].n, 0);
  } finally {
    await target.close();
  }
});

test('loadTest with scenario "heavy" returns a passing report shaped for the CLI', { timeout: 240_000 }, async () => {
  const report = await loadTest({
    users: 1, durationSec: 1, thinkMs: 0, timeoutMs: 20_000, target: null, allowWrites: null,
    scenario: 'heavy', heavyIterations: 1, heavyConcurrency: 2, heavy: SMALL_HEAVY, thresholds: {},
  });
  assert.equal(report.mode, 'local');
  assert.equal(report.scenario, 'heavy');
  assert.match(report.target, /not representative/);
  assert.equal(report.dataset.years, 2);
  assert.equal(report.dataset.studentsPerYear, 12);
  assert.equal(report.dataset.enrollments, 24);
  assert.equal(report.dataset.auditEvents, 50);
  assert.equal(report.emailOutboxRows, 0);
  assert.equal(typeof report.setupMs, 'number');
  assert.deepEqual(report.breaches, []);
  assert.equal(report.passed, true);
});

test('remote scenario "heavy": same safeguards as the default scenario and read-only (#217 pkt 4)', async () => {
  const env = { LOAD_TEST_ALLOWED_HOSTS: 'rd-staging.example.test', LOAD_TEST_SCHOOL_YEAR_ID: 'y1', LOAD_TEST_SESSION_BOARD: 'x' };
  await assert.rejects(
    loadTest({ scenario: 'heavy', target: 'https://rd-staging.example.test', heavy: SMALL_HEAVY, heavyIterations: 1 }, { env }),
    /--i-confirm-staging/,
  );
  await assert.rejects(
    loadTest({ scenario: 'heavy', target: 'https://rd-staging.example.test', confirmStaging: true, allowWrites: true, heavy: SMALL_HEAVY }, { env }),
    /read-only/,
  );
  await assert.rejects(
    loadTest({ scenario: 'heavy', target: 'https://other.example.test', confirmStaging: true, heavy: SMALL_HEAVY }, { env }),
    /not listed in LOAD_TEST_ALLOWED_HOSTS/,
  );
  await assert.rejects(
    loadTest({ scenario: 'heavy', target: 'https://rd-staging.example.test', confirmStaging: true, heavy: SMALL_HEAVY }, { env: { ...env, APP_ENV: 'production' } }),
    /production/,
  );
});
