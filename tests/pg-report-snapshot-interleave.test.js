// #213: raport dla Komisji Rewizyjnej, zestawienie przekazania i widok
// uzgodnienia czytają jedną migawkę (REPEATABLE READ, READ ONLY), a nie kilka
// zapytań na puli. Ten plik działa na PGlite (CI go uruchamia, w odróżnieniu od
// tests/pg-report-snapshot-race.test.js, które wymaga RD_TEST_PG_URL).
//
// PGlite serializuje transakcje, więc zapisu z "drugiego połączenia" nie da się
// zatwierdzić w trakcie otwartej transakcji (zakleszczenie). Dowód jest więc
// dwustopniowy, w obrębie jednego handlera:
//  1. KONTROLA: opakowany db wstrzykuje zapis po zapytaniu na PULI (poza
//     transakcją). Ten sam wzorzec odczytu, którym raporty były składane przed
//     #213 (kilka zapytań na env.db), daje na PGlite sprzeczny wynik — więc
//     hak faktycznie wykrywa błąd.
//  2. TRASY: te same haki podpięte pod prawdziwe handlery. Żadne zapytanie
//     danych nie może trafić na pulę (hak nie odpala), całość idzie jedną
//     transakcją zaczynającą się od SET TRANSACTION ... REPEATABLE READ,
//     READ ONLY, a sumy w odpowiedzi są spójne. Powrót do env.db.query albo
//     Promise.all na puli zapali hak i test padnie.
// Wyłącznie dane syntetyczne (@example.invalid).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-snap213';
const DATA_TABLES = /ledger_year_summary|ledger_entry_net|bank_statement_lines|bank_reconciliation_matches|payment_entry_net|ledger_opening_balances/;
const SNAPSHOT_START = 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY';

let db;
let cookies;
let seq = 0;

async function insertIncome(target, id, cents) {
  await target.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
    occurred_on, method, created_by, idempotency_key)
    VALUES ($1, $2, 'income', $3, 'cat-dues', $4, '2026-09-14', 'bank', 'u-treasurer', $5)`,
  [id, YEAR, cents, `Wpis ${id}`, `key-${id}`]);
}

before(async () => {
  db = await createTestDb();
  await seedSchoolYear(db, YEAR);
  cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
    VALUES ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer')`, [YEAR]);
  await insertIncome(db, 'le-1', 10000);
});
after(async () => { await db.close(); });

// Opakowanie db: rejestruje zapytania osobno dla puli i dla transakcji; po
// pierwszym zapytaniu na PULI pasującym do `trigger` uruchamia `inject` na
// surowym db (odpowiednik zapisu z innego połączenia).
function instrument({ trigger = DATA_TABLES, inject = async () => {} } = {}) {
  const log = { pool: [], tx: [], fired: 0 };
  const wrap = (executor, list, isPool) => ({
    async query(sql, params) {
      list.push(String(sql));
      const result = await executor.query(sql, params);
      if (isPool && log.fired === 0 && trigger.test(String(sql))) {
        log.fired += 1;
        await inject();
      }
      return result;
    },
  });
  const env = {
    db: {
      ...wrap(db, log.pool, true),
      transaction: (fn) => db.transaction((tx) => fn(wrap(tx, log.tx, false))),
    },
  };
  return { env, log };
}

const get = (env, path, cookie) => handlePgRequest(request(path, { cookie }), env);

function assertOneSnapshot(log) {
  assert.equal(log.fired, 0, `zapytanie danych poszło na pulę zamiast do migawki: ${log.pool.filter((sql) => DATA_TABLES.test(sql)).join(' | ').slice(0, 200)}`);
  assert.equal(log.tx[0], SNAPSHOT_START, 'transakcja raportu zaczyna się od REPEATABLE READ, READ ONLY');
  assert.ok(log.tx.length > 3, 'odczyty raportu poszły przez transakcję');
}

test('GET /api/reports/audit: jedna migawka, sumy kategorii zgodne z bilansem mimo haka na zapis', async () => {
  const { env, log } = instrument({ trigger: /ledger_year_summary/, inject: () => insertIncome(db, 'le-race-audit', 2500) });
  const response = await get(env, `/api/reports/audit?schoolYearId=${YEAR}&format=json`, cookies.audit);
  assert.equal(response.status, 200);
  const { report } = await response.json();
  assertOneSnapshot(log);
  const categorySum = report.categories.reduce((sum, c) => sum + (c.direction === 'income' ? c.netCents : 0), 0);
  assert.equal(report.balance.incomeCents, 10000);
  assert.equal(categorySum, report.balance.incomeCents);
});

test('GET /api/year-close/{rok}/handover: jedna migawka i asOf z now() transakcji', async () => {
  const { env, log } = instrument({ trigger: /ledger_year_summary|ledger_entry_net/, inject: () => insertIncome(db, 'le-race-handover', 2500) });
  const response = await get(env, `/api/year-close/${YEAR}/handover`, cookies.board);
  assert.equal(response.status, 200);
  const body = await response.json();
  assertOneSnapshot(log);
  assert.equal(body.finance.incomeCents, 10000);
  assert.equal(body.finance.ledgerEntryCount, 1, 'liczba wpisów i bilans z tej samej chwili');
  assert.match(body.asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.ok(Math.abs(Date.parse(body.asOf) - Date.now()) < 60_000);
  assert.equal(log.tx.filter((sql) => /now\(\)/.test(sql)).length >= 1, true);
});

test('GET /api/year-close/{rok} (statusView): jedna migawka', async () => {
  const { env, log } = instrument({ trigger: /ledger_year_summary|ledger_entry_net|ledger_entry_review_status/, inject: () => insertIncome(db, 'le-race-status', 2500) });
  const response = await get(env, `/api/year-close/${YEAR}`, cookies.board);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).balance.incomeCents, 10000);
  assertOneSnapshot(log);
});

test('GET /api/reports/audit ponowione: dwa zdarzenia z różnym asOf, treść identyczna bez zapisów', async () => {
  const strip = (report) => { const { generatedAt, asOf, ...rest } = report; return rest; };
  const first = await (await get({ db }, `/api/reports/audit?schoolYearId=${YEAR}&format=json`, cookies.audit)).json();
  const second = await (await get({ db }, `/api/reports/audit?schoolYearId=${YEAR}&format=json`, cookies.audit)).json();
  assert.deepEqual(strip(second.report), strip(first.report));
  const { rows } = await db.query(
    `SELECT metadata_json->>'asOf' AS as_of FROM audit_events WHERE action = 'report.audit.generated' AND entity_id = $1 ORDER BY occurred_at`, [YEAR]);
  const asOfs = rows.map((row) => row.as_of);
  assert.ok(asOfs.length >= 2);
  assert.notEqual(asOfs.at(-1), asOfs.at(-2), 'każde wygenerowanie ma własny czas migawki');
});

test('GET /api/reconciliations/{id}: jedna migawka; pozycje i dopasowania spójne mimo haka na zapis', async () => {
  const call = (path, options = {}) => handlePgRequest(request(path, options), { db });
  const created = await call('/api/reconciliations', {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': `rec-snap-${++seq}` },
    body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 10000 },
  });
  assert.equal(created.status, 201);
  const { reconciliation } = await created.json();
  const imported = await call(`/api/reconciliations/${reconciliation.id}/lines`, {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': `imp-snap-${++seq}` },
    body: { lines: [{ bookedOn: '2026-09-14', amountCents: 10000, reference: 'Syntetyczna pozycja' }] },
  });
  assert.equal(imported.status, 201);
  const lineId = (await db.query('SELECT id FROM bank_statement_lines WHERE reconciliation_id = $1', [reconciliation.id])).rows[0].id;

  // Hak dopasowuje pozycję dokładnie wtedy, gdy stary kod skończyłby czytać
  // listę pozycji (zapytanie na puli) — dokument pokazałby pozycję jako
  // niedopasowaną razem z dopasowaniem, którego nie ma na liście.
  const { env, log } = instrument({
    trigger: /bank_statement_lines/,
    inject: async () => {
      const matched = await call(`/api/reconciliations/${reconciliation.id}/matches`, {
        method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': `m-snap-${++seq}` },
        body: { statementLineId: lineId, ledgerEntryId: 'le-1' },
      });
      assert.equal(matched.status, 201);
    },
  });
  const response = await get(env, `/api/reconciliations/${reconciliation.id}`, cookies.treasurer);
  assert.equal(response.status, 200);
  const detail = await response.json();
  assertOneSnapshot(log);
  const matchedLines = detail.lines.filter((line) => line.matchId);
  assert.equal(matchedLines.length, detail.matches.filter((m) => !m.revokedAt).length, 'pozycje z dopasowaniem = aktywne dopasowania');
  assert.equal(detail.summary.unmatchedLineCount, detail.lines.length - matchedLines.length);
});

test('granice ról bez zmian: przedstawiciel i audyt nie czytają zestawienia przekazania ani uzgodnień', async () => {
  assert.equal((await get({ db }, `/api/year-close/${YEAR}/handover`, cookies.rep)).status, 403);
  assert.equal((await get({ db }, `/api/year-close/${YEAR}/handover`, cookies.audit)).status, 403);
  assert.equal((await get({ db }, `/api/reports/audit?schoolYearId=${YEAR}`, cookies.rep)).status, 403);
  assert.equal((await get({ db }, '/api/reconciliations/nie-istnieje', cookies.audit)).status, 403);
});

// Ostatni test: księga jest tylko do dopisywania, więc wpis kontrolny zostaje.
test('kontrola: odczyt kilkoma zapytaniami na puli daje sprzeczny wynik przy zapisie między zapytaniami', async () => {
  const { env } = instrument({ trigger: /ledger_year_summary/, inject: () => insertIncome(db, 'le-control', 2500) });
  const summary = (await env.db.query('SELECT income_cents FROM ledger_year_summary WHERE school_year_id = $1', [YEAR])).rows[0];
  const categories = (await env.db.query(
    `SELECT COALESCE(sum(net_amount_cents), 0)::int AS total FROM ledger_entry_net WHERE school_year_id = $1 AND direction = 'income'`, [YEAR])).rows[0];
  assert.equal(Number(summary.income_cents), 10000);
  assert.equal(categories.total, 12500, 'hak działa: druga migawka widzi zapis wstrzyknięty po pierwszym zapytaniu');
});
