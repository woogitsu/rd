// Sprawozdanie roczne i przepływy środków (#125). Wyłącznie dane syntetyczne,
// z „pułapkami”: e-mail i nazwisko w opisie wpisu nie mogą trafić do sprawozdania.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { request, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const YEAR = 'y-test';
const TRAP = 'pulapka.rodzic@example.invalid';

const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
let shared = null;
let schemaSeq = 0;
after(async () => { await shared?.close(); });

async function freshDb() {
  shared ??= new PGlite();
  const schema = `annual_report_test_${++schemaSeq}`;
  await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  for (const migration of await loadMigrations(migrationsDirectory)) await shared.exec(migration.sql);
  return { query: (...args) => shared.query(...args), exec: (...args) => shared.exec(...args),
    transaction: (fn) => shared.transaction(fn), close: async () => {} };
}

async function setup({ seed = true } = {}) {
  const db = await freshDb();
  await seedSchoolYear(db, YEAR);
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', displayName: 'Skarbnik Testowy', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board', mfa: false }),
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true,
    }),
  };
  if (seed) await seedLedger(db);
  const call = (path, options = {}) => handlePgRequest(request(path, options), { db });
  return { db, cookies, call };
}

async function seedLedger(db) {
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer'),
    ('cat-fair', $1, 'income', 'Kiermasz <b>', 'u-treasurer'),
    ('cat-trips', $1, 'expense', 'Dofinansowanie wycieczek', 'u-treasurer'),
    ('cat-unused', $1, 'expense', 'Nieużywana', 'u-treasurer')`, [YEAR]);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, cash_cents, created_by, idempotency_key)
    VALUES ('ob-1', $1, 100000, 5000, 'u-treasurer', 'ob-key-0001')`, [YEAR]);
  const entry = (id, direction, cents, category, date, method) => db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on,
       method, created_by, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'u-treasurer', $9)`,
    [id, YEAR, direction, cents, category, `Wpłata Jan Pułapka ${TRAP} ${id}`, date, method, `le-key-${id}`]);
  // Wpis gotówkowy i bankowy tego samego dnia.
  await entry('le-bank', 'income', 50000, 'cat-dues', '2026-09-10', 'bank');
  await entry('le-cash', 'income', 3000, 'cat-fair', '2026-09-10', 'cash');
  await entry('le-trip', 'expense', 20000, 'cat-trips', '2026-10-20', 'bank');
  await entry('le-card', 'expense', 1500, 'cat-trips', '2026-10-21', 'card');
  await db.query(`INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
    VALUES ('lc-1', 'le-bank', 5000, 'Korekta ${TRAP}', 'u-treasurer', 'lc-key-0001')`);
  await db.query(`INSERT INTO ledger_transfers (id, school_year_id, direction, amount_cents, transferred_on, description,
    created_by, idempotency_key) VALUES ('tr-1', $1, 'cash_to_bank', 2000, '2026-10-02', 'Wpłata gotówki ${TRAP}', 'u-treasurer', 'tr-key-0001')`, [YEAR]);
  await db.query(`INSERT INTO ledger_budget_lines (id, school_year_id, category_id, planned_cents, note, created_by, idempotency_key)
    VALUES ('bl-1', $1, 'cat-trips', 25000, 'Notatka ${TRAP}', 'u-treasurer', 'bl-key-0001')`, [YEAR]);
}

test('annual report: sums match ledger_year_summary; categories with plan vs execution; bank/cash split', async () => {
  const { db, cookies, call } = await setup();
  const response = await call(`/api/reports/annual?schoolYearId=${YEAR}`, { cookie: cookies.treasurer });
  assert.equal(response.status, 200);
  const { report } = await response.json();
  const summary = (await db.query('SELECT * FROM ledger_year_summary WHERE school_year_id = $1', [YEAR])).rows[0];
  assert.equal(report.balance.openingBalanceCents, Number(summary.opening_balance_cents));
  assert.equal(report.balance.incomeCents, Number(summary.income_cents));
  assert.equal(report.balance.expenseCents, Number(summary.expense_cents));
  assert.equal(report.balance.closingBalanceCents, Number(summary.closing_balance_cents));
  assert.equal(report.balance.closingBalanceCents, 100000 + 45000 + 3000 - 21500);
  assert.equal(report.income.categories.reduce((s, c) => s + c.netCents, 0), report.income.totalCents);
  assert.equal(report.expense.categories.reduce((s, c) => s + c.netCents, 0), report.expense.totalCents);
  // Kasa: 5000 otwarcia + 3000 gotówki + (−1500 karta) − 2000 wpłacone na rachunek.
  assert.equal(report.balance.openingCashCents, 5000);
  assert.equal(report.balance.closingCashCents, 5000 + 3000 - 1500 - 2000);
  const trips = report.expense.categories.find((c) => c.categoryId === 'cat-trips');
  assert.deepEqual([trips.plannedCents, trips.netCents, trips.varianceCents], [25000, 21500, -3500]);
  assert.ok(!report.expense.categories.some((c) => c.categoryId === 'cat-unused'), 'kategoria bez wpisów i planu pominięta');
  assert.deepEqual(report.counts, { entryCount: 4, correctionCount: 1 });
  assert.equal(report.reconciliation.lastConfirmedStatementDate, null);
});

test('no entry descriptions, person identifiers or family data in JSON or HTML; HTML is escaped with report CSP', async () => {
  const { db, cookies, call } = await setup();
  for (const format of ['json', 'html']) {
    const response = await call(`/api/reports/annual?schoolYearId=${YEAR}&format=${format}`, { cookie: cookies.board });
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const secret of [TRAP, 'Pułapka', 'u-treasurer', 'Skarbnik Testowy', 'le-bank', 'household']) {
      assert.ok(!text.includes(secret), `${format}: brak ${secret}`);
    }
    if (format === 'html') {
      assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.doesNotMatch(text, /<script/i);
      assert.match(text, /Kiermasz &lt;b&gt;/);
      assert.match(text, /Projekt sprawozdania/);
    }
  }
  const cash = await (await call(`/api/reports/cash-flow?schoolYearId=${YEAR}`, { cookie: cookies.board })).text();
  assert.ok(!cash.includes(TRAP) && !cash.includes('u-treasurer'));
  const { rows } = await db.query("SELECT action, metadata_json FROM audit_events WHERE action LIKE 'report.%' ORDER BY occurred_at");
  assert.deepEqual(rows.map((r) => r.action), ['report.annual.generated', 'report.annual.generated', 'report.cash_flow.generated']);
  assertEvery(rows, (r) => !JSON.stringify(r.metadata_json).includes('Cents'));
});

test('cash flow: months of the school year, cash and bank on one day separated, running balance ends at closing', async () => {
  const { cookies, call } = await setup();
  const { report } = await (await call(`/api/reports/cash-flow?schoolYearId=${YEAR}&granularity=month`, { cookie: cookies.treasurer })).json();
  assert.equal(report.months.length, 12);
  assert.equal(report.months[0].month, '2026-09');
  const september = report.months[0];
  assert.deepEqual(september.byMethod.bank, { incomeCents: 45000, expenseCents: 0 });
  assert.deepEqual(september.byMethod.cash, { incomeCents: 3000, expenseCents: 0 });
  assert.equal(september.runningCashCents, 8000);
  const october = report.months[1];
  assert.deepEqual(october.transfers, { cashToBankCents: 2000, bankToCashCents: 0 });
  assert.equal(october.byMethod.card.expenseCents, 1500);
  assert.equal(october.runningCashCents, 4500);
  const annual = (await (await call(`/api/reports/annual?schoolYearId=${YEAR}`, { cookie: cookies.treasurer })).json()).report;
  assert.equal(report.totals.incomeCents, annual.balance.incomeCents);
  assert.equal(report.totals.expenseCents, annual.balance.expenseCents);
  assert.equal(report.totals.closingBalanceCents, annual.balance.closingBalanceCents);
  assert.equal(report.totals.closingCashCents, annual.balance.closingCashCents);
  assert.equal(report.months.at(-1).runningBankCents, annual.balance.closingBankCents);

  const bad = await call(`/api/reports/cash-flow?schoolYearId=${YEAR}&granularity=week`, { cookie: cookies.treasurer });
  assert.equal(bad.status, 400);
});

test('year without entries and without budget: valid report with empty sections', async () => {
  const { cookies, call } = await setup({ seed: false });
  const { report } = await (await call(`/api/reports/annual?schoolYearId=${YEAR}`, { cookie: cookies.treasurer })).json();
  assert.deepEqual(report.income, { categories: [], totalCents: 0, plannedCents: null });
  assert.equal(report.balance.closingBalanceCents, 0);
  const html = await (await call(`/api/reports/annual?schoolYearId=${YEAR}&format=html`, { cookie: cookies.treasurer })).text();
  assert.match(html, /Brak przychodów w tym roku/);
  const flow = (await (await call(`/api/reports/cash-flow?schoolYearId=${YEAR}`, { cookie: cookies.treasurer })).json()).report;
  assertEvery(flow.months, (m) => m.incomeCents === 0 && m.runningBalanceCents === 0);
  const missing = await call('/api/reports/annual?schoolYearId=y-missing', { cookie: cookies.treasurer });
  assert.equal(missing.status, 403, 'rok bez przydziału — brak wyroczni istnienia');
});

test('representative, audit, technical admin and missing MFA get 403', async () => {
  const { db, cookies, call } = await setup();
  for (const cookie of [cookies.rep, cookies.audit, cookies.admin, cookies.boardNoMfa]) {
    for (const path of [`/api/reports/annual?schoolYearId=${YEAR}&format=html`, `/api/reports/cash-flow?schoolYearId=${YEAR}`]) {
      const response = await call(path, { cookie });
      assert.equal(response.status, 403, path);
    }
  }
  assert.equal((await call(`/api/reports/annual?schoolYearId=${YEAR}`)).status, 401);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'report.%'");
  assert.equal(rows[0].n, 0);
});

test('dyrekcja (principal, 2026-10-02): sumy roku i przepływy 200 bez danych osobowych, audyt z aktorem; bez MFA lub bez przydziału roku 403; migawki 403', async () => {
  const { db, cookies, call } = await setup();
  const principalNoMfa = await seedUserSession(db, { userId: 'u-principal-nomfa', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: false });
  for (const path of [
    `/api/reports/annual?schoolYearId=${YEAR}&format=json`, `/api/reports/annual?schoolYearId=${YEAR}&format=html`,
    `/api/reports/cash-flow?schoolYearId=${YEAR}`,
  ]) {
    const response = await call(path, { cookie: cookies.principal });
    assert.equal(response.status, 200, path);
    const text = await response.text();
    for (const secret of [TRAP, 'Pułapka', 'u-treasurer', 'Skarbnik Testowy', 'le-bank', 'household', 'u-principal']) {
      assert.ok(!text.includes(secret), `${path}: brak ${secret}`);
    }
    assert.equal((await call(path, { cookie: principalNoMfa })).status, 403, `${path}: bez MFA`);
  }
  const { rows } = await db.query("SELECT action, actor_id FROM audit_events WHERE action LIKE 'report.%' ORDER BY occurred_at");
  assert.deepEqual(rows.map((r) => [r.action, r.actor_id]), [
    ['report.annual.generated', 'u-principal'], ['report.annual.generated', 'u-principal'], ['report.cash_flow.generated', 'u-principal'],
  ]);
  assert.equal((await call(`/api/reports/annual/snapshots?schoolYearId=${YEAR}`, { cookie: cookies.principal })).status, 403);
  assert.equal((await call(`/api/reports/annual?schoolYearId=y-other`, { cookie: cookies.principal })).status, 403, 'inny rok');
});
