// #213: raport dla Komisji Rewizyjnej (GET /api/reports/audit) na PRAWDZIWYM
// PostgreSQL z pulą połączeń (src/db.js). PGlite wykonuje zapytania po kolei,
// więc zapisu z drugiego połączenia w trakcie raportu na nim nie ma — tu każde
// żądanie idzie własnym połączeniem puli. Plik działa wyłącznie z
// RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Wyłącznie dane syntetyczne (@example.invalid), żadnej sieci.
//
// Przeplot jest wymuszany, a nie zgadywany (wzorzec tests/pg-year-close-race.test.js):
// generowanie raportu jest wstrzymywane W TRANSAKCJI zaraz po zapytaniu
// `FROM ledger_year_summary` (bilans). W tym czasie test sprawdza w
// pg_stat_activity, że połączenie raportu jest faktycznie otwartą transakcją
// z migawką (`idle in transaction`, backend_xmin), i na OSOBNYM połączeniu
// wykonuje przez API korektę wpisu (zwrot części wpłaty). Korekta musi się
// zatwierdzić (migawka READ ONLY nie blokuje zapisu), a raport po wznowieniu
// pokazuje w całości stan sprzed korekty. Kontrola pozytywna: ten sam przeplot
// z zapytaniami na puli (bez migawki, jak przed #213) daje raport wewnętrznie
// sprzeczny — więc test naprawdę wykrywa regresję.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { createRealTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-audit-real';
const SUMMARY = /FROM ledger_year_summary/;
const SNAPSHOT_START = 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY';

let seq = 0;
const key = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;

async function withReal(fn) {
  const db = await createRealTestDb();
  try { return await fn(db); } finally { await db.close(); }
}

async function setup(db) {
  await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on)
    VALUES ($1, '2026/27 test', '2026-09-01', '2027-08-31')`, [YEAR]);
  await seedClass(db, { id: 'c-audit-1a', schoolYearId: YEAR, name: '1A' });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', email: 'skarbnik@example.invalid', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', email: 'kr@example.invalid', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, { userId: 'u-rep', email: 'przedstawiciel@example.invalid', roles: [{ role: 'representative', classId: 'c-audit-1a', schoolYearId: YEAR }], mfa: true }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
    VALUES ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer')`, [YEAR]);
  // Jeden wpływ 100,00 EUR (przelew) — stan wyjściowy z opisu issue.
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
    occurred_on, method, created_by, idempotency_key)
    VALUES ('le-1', $1, 'income', 10000, 'cat-dues', 'Syntetyczna wpłata', '2026-09-14', 'bank', 'u-treasurer', 'le-key-1')`, [YEAR]);
  return cookies;
}

async function call(env, path, { cookie, method = 'GET', body, idempotencyKey } = {}) {
  const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined;
  const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data, text };
}

// Środowisko żądania raportu z barierą: pierwsze zapytanie pasujące do
// `pauseAfter` wstrzymuje handler (po wykonaniu zapytania, wewnątrz
// transakcji) do wywołania release(). `pooled: true` = kontrola pozytywna:
// transakcja NIE jest otwierana, każde zapytanie idzie osobno na pulę
// (autocommit, własna migawka READ COMMITTED) — tak raport był składany przed #213.
function barrierEnv(db, { pauseAfter = SUMMARY, pooled = false } = {}) {
  let armed = true;
  let reach;
  let open;
  const reached = new Promise((resolve) => { reach = resolve; });
  const gate = new Promise((resolve) => { open = resolve; });
  const log = [];
  const wrap = (executor) => ({
    async query(sql, params) {
      const text = String(sql);
      log.push(text);
      if (pooled && text === SNAPSHOT_START) return { rows: [], rowCount: 0 };
      const result = await executor.query(sql, params);
      if (armed && pauseAfter.test(text)) { armed = false; reach(); await gate; }
      return result;
    },
  });
  const env = {
    db: {
      query: (...a) => db.query(...a),
      probe: (...a) => db.probe(...a),
      transaction: (fn, options) => (pooled ? fn(wrap(db)) : db.transaction((tx) => fn(wrap(tx)), options)),
    },
  };
  return { env, reached, release: () => open(), log };
}

// Połączenia aplikacji w otwartej transakcji z utrzymywaną migawką.
async function snapshotHolders(db, { timeoutMs = 2500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    ({ rows } = await db.query(
      `SELECT pid, state FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND state = 'idle in transaction' AND backend_xmin IS NOT NULL`,
    ));
    if (rows.length) return rows;
    await sleep(10);
  }
  return rows;
}

const incomeCategorySum = (report) => report.categories
  .filter((c) => c.direction === 'income').reduce((sum, c) => sum + c.netCents, 0);
const check = (report, id) => report.checks.items.find((item) => item.id === id);

// Raport spójny wewnętrznie: każda kontrola liczona z bilansu wychodzi zgodna
// z liczbami z innych zapytań tej samej odpowiedzi.
function assertConsistent(report, message) {
  assert.equal(incomeCategorySum(report), report.balance.incomeCents, `${message}: suma kategorii = bilans`);
  assert.equal(check(report, 'year_end_balance').ok, true, `${message}: year_end_balance zgodne`);
  const corrected = report.categories.reduce((sum, c) => sum + c.correctedCents, 0);
  assert.equal(corrected, report.corrections.reduce((sum, k) => sum + k.amountCents, 0), `${message}: korekty w kategoriach = lista korekt`);
  assert.equal(report.balance.closingBalanceCents,
    report.balance.openingBalanceCents + report.balance.incomeCents - report.balance.expenseCents, `${message}: bilans zamknięcia`);
}

test('GET /api/reports/audit: korekta zatwierdzona w trakcie generowania nie rozspaja raportu; asOf = chwila migawki', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const barrier = barrierEnv(db);
    const pending = call(barrier.env, `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
    await barrier.reached;

    // Raport trzyma otwartą transakcję z migawką na osobnym połączeniu puli.
    const holders = await snapshotHolders(db);
    assert.equal(holders.length, 1, 'połączenie raportu jest otwartą transakcją z migawką');
    // Zwrot części wpłaty (30,00 EUR) na innym połączeniu — zatwierdza się
    // mimo otwartej migawki (READ ONLY nie blokuje zapisów).
    const correction = await call({ db }, '/api/ledger/le-1/corrections', {
      cookie: cookies.treasurer, method: 'POST', idempotencyKey: key('corr'),
      body: { amountCents: 3000, reason: 'Syntetyczny zwrot części wpłaty' },
    });
    assert.equal(correction.status, 201, correction.text);
    const committedAt = (await db.query('SELECT created_at FROM ledger_corrections WHERE id = $1', [correction.body.correction.id])).rows[0].created_at;
    barrier.release();

    const first = await pending;
    assert.equal(first.status, 200, first.text);
    assert.equal(barrier.log[0], SNAPSHOT_START, 'raport zaczyna się od SET TRANSACTION … REPEATABLE READ, READ ONLY');
    const before = first.body.report;
    assert.equal(before.balance.incomeCents, 10000, 'bilans sprzed korekty');
    assert.deepEqual(before.corrections, [], 'lista korekt sprzed korekty');
    assertConsistent(before, 'raport w trakcie korekty');
    assert.ok(before.asOf, 'asOf w JSON');
    assert.equal(before.generatedAt, before.asOf, 'generatedAt (zgodność wsteczna) = asOf');
    assert.ok(new Date(before.asOf) < new Date(committedAt), 'asOf to chwila migawki — przed zatwierdzeniem korekty');

    const second = await call({ db }, `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
    assert.equal(second.status, 200);
    const after = second.body.report;
    assert.equal(after.balance.incomeCents, 7000, 'kolejny raport widzi korektę w całości');
    assert.equal(after.corrections.length, 1);
    assertConsistent(after, 'raport po korekcie');
    assert.ok(new Date(after.asOf) > new Date(committedAt));

    const events = (await db.query(
      `SELECT metadata_json->>'asOf' AS as_of FROM audit_events WHERE action = 'report.audit.generated' AND entity_id = $1 ORDER BY occurred_at, id`, [YEAR],
    )).rows.map((row) => row.as_of);
    assert.deepEqual(events, [before.asOf, after.asOf], 'metadata.asOf zdarzeń = asOf raportów');
  });
});

test('GET /api/reports/audit?format=html: nagłówek „Stan na” z chwili migawki', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const response = await call({ db }, `/api/reports/audit?schoolYearId=${YEAR}&format=html`, { cookie: cookies.audit });
    assert.equal(response.status, 200);
    const event = (await db.query(
      `SELECT metadata_json->>'format' AS format, metadata_json->>'asOf' AS "asOf" FROM audit_events WHERE action = 'report.audit.generated' AND entity_id = $1`, [YEAR],
    )).rows[0];
    assert.equal(event.format, 'html');
    const [, y, m, d, hh, mm] = event.asOf.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    assert.ok(response.text.includes(`Stan na: ${d}.${m}.${y} ${hh}:${mm} UTC`), 'HTML pokazuje asOf migawki');
  });
});

test('GET /api/reports/audit ponowione bez zapisów: identyczna treść, dwa zdarzenia z różnym asOf', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const a = await call({ db }, `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
    await sleep(5);
    const b = await call({ db }, `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const strip = ({ asOf, generatedAt, ...rest }) => rest;
    assert.deepEqual(strip(b.body.report), strip(a.body.report));
    assert.notEqual(a.body.report.asOf, b.body.report.asOf);
    const asOfs = (await db.query(
      `SELECT metadata_json->>'asOf' AS as_of FROM audit_events WHERE action = 'report.audit.generated' AND entity_id = $1 ORDER BY occurred_at, id`, [YEAR],
    )).rows.map((row) => row.as_of);
    assert.deepEqual(asOfs, [a.body.report.asOf, b.body.report.asOf]);
  });
});

test('GET /api/reports/audit: równoległe raporty i zapisy na puli — każdy raport spójny wewnętrznie', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const writes = [];
    for (let i = 0; i < 6; i += 1) {
      writes.push(call({ db }, '/api/ledger', {
        cookie: cookies.treasurer, method: 'POST', idempotencyKey: key('le'),
        body: { schoolYearId: YEAR, direction: 'income', amountCents: 2500, categoryId: 'cat-dues',
          description: `Syntetyczny wpływ ${i}`, occurredOn: '2026-09-15', method: 'bank' },
      }));
      if (i % 2 === 0) {
        writes.push(call({ db }, '/api/ledger/le-1/corrections', {
          cookie: cookies.treasurer, method: 'POST', idempotencyKey: key('corr'),
          body: { amountCents: 1000, reason: `Syntetyczny zwrot ${i}` },
        }));
      }
    }
    const reports = Array.from({ length: 8 }, () => call({ db }, `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit }));
    const [written, generated] = await Promise.all([Promise.all(writes), Promise.all(reports)]);
    for (const w of written) assert.equal(w.status, 201, w.text);
    for (const [i, r] of generated.entries()) {
      assert.equal(r.status, 200, r.text);
      assertConsistent(r.body.report, `raport ${i}`);
    }
    const final = await call({ db }, `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
    assert.equal(final.body.report.balance.incomeCents, 10000 + 6 * 2500 - 3 * 1000);
    assertConsistent(final.body.report, 'raport końcowy');
  });
});

test('granice ról bez zmian: przedstawiciel klasy — 403 na raport KR', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const response = await call({ db }, `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.rep });
    assert.equal(response.status, 403);
    assert.equal(Number((await db.query(`SELECT count(*) AS n FROM audit_events WHERE action = 'report.audit.generated'`)).rows[0].n), 0);
  });
});

test('kontrola pozytywna: ten sam przeplot bez migawki (zapytania na puli) daje raport sprzeczny', { skip }, async () => {
  await withReal(async (db) => {
    const cookies = await setup(db);
    const barrier = barrierEnv(db, { pooled: true });
    const pending = call(barrier.env, `/api/reports/audit?schoolYearId=${YEAR}`, { cookie: cookies.audit });
    await barrier.reached;
    assert.equal((await snapshotHolders(db, { timeoutMs: 200 })).length, 0, 'bez transakcji nie ma trzymanej migawki');
    const correction = await call({ db }, '/api/ledger/le-1/corrections', {
      cookie: cookies.treasurer, method: 'POST', idempotencyKey: key('corr'),
      body: { amountCents: 3000, reason: 'Syntetyczny zwrot części wpłaty' },
    });
    assert.equal(correction.status, 201, correction.text);
    barrier.release();
    const { status, body } = await pending;
    assert.equal(status, 200);
    const report = body.report;
    assert.equal(report.balance.incomeCents, 10000, 'bilans z chwili przed korektą');
    assert.equal(incomeCategorySum(report), 7000, 'kategorie z chwili po korekcie');
    assert.equal(check(report, 'year_end_balance').ok, false, 'raport sam zgłasza fałszywą niezgodność');
  });
});
