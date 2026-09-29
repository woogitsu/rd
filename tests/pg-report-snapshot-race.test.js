// #213: raport dla Komisji Rewizyjnej, zestawienie przekazania i widok
// uzgodnienia muszą czytać jedną migawkę bazy — na prawdziwym PostgreSQL,
// bo PGlite serializuje transakcje i nie odtwarza przeplotu między
// połączeniami (patrz opis w issue i tests/pg-reconciliation-race.test.js,
// #162/#165, ten sam wzorzec). Działa tylko z RD_TEST_PG_URL, bez niej
// pomijany. Wyłącznie dane syntetyczne.
//
//   RD_TEST_PG_URL=postgres://postgres@127.0.0.1:55462/postgres node --test tests/pg-report-snapshot-race.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPgDatabase } from '../src/db.js';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { fileURLToPath } from 'node:url';
import { request, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { handlePgRequest } from '../src/pg/app.js';
import { buildAuditReport } from '../src/pg/routes/reconciliation.js';
import { readSnapshot } from '../src/pg/db-snapshot.js';

const ADMIN_URL = process.env.RD_TEST_PG_URL;
const YEAR = 'y-report-race';
const skip = ADMIN_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';

async function withDatabase(fn) {
  const name = `rd_report_race_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const db = createPgDatabase({ connectionString: url.toString(), max: 8 });
  try {
    await applyMigrations(client, await loadMigrations(fileURLToPath(new URL('../postgres/migrations/', import.meta.url))));
    await client.end();
    await fn(db, url.toString());
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}

async function seed(db) {
  await seedSchoolYear(db, YEAR);
  await db.query(`INSERT INTO users (id, email, display_name) VALUES ('u-treasurer', 'u-treasurer@example.invalid', 'Skarbnik')`);
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
    VALUES ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer')`, [YEAR]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
    occurred_on, method, created_by, idempotency_key)
    VALUES ('le-1', $1, 'income', 10000, 'cat-dues', 'Wpis 1', '2026-09-14', 'bank', 'u-treasurer', 'le-key-1')`, [YEAR]);
}

// Wstawia równolegle drugi wpis na osobnym, prawdziwym połączeniu — dokładnie
// odtworzenie z opisu issue #213 ("zaraz po zapytaniu FROM ledger_year_summary
// inne połączenie zapisuje wpływ 25,00 EUR").
async function insertConcurrently(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
    occurred_on, method, created_by, idempotency_key)
    VALUES ('le-2', $1, 'income', 2500, 'cat-dues', 'Wpis 2 (dopisany w trakcie raportu)', '2026-09-14', 'bank', 'u-treasurer', 'le-key-2')`, [YEAR]);
  await client.end();
}

test('buildAuditReport w readSnapshot: zapis między zapytaniami nie zmienia wyniku w trakcie generowania raportu', { skip }, async () => {
  await withDatabase(async (db, url) => {
    await seed(db);

    // Migawka trzymana otwarta ręcznie: pierwsze zapytanie buildAuditReport
    // (bilans z ledger_year_summary) na jednym połączeniu REPEATABLE READ,
    // potem — zanim transakcja się skończy — drugie, prawdziwe połączenie
    // zapisuje nowy wpis i zatwierdza go. Migawka pierwszej transakcji nie
    // powinna go zobaczyć w żadnym z pozostałych zapytań raportu.
    let sawConcurrentWriteInEntryCount = null;
    const report = await readSnapshot(db, async (tx) => {
      // Dokładnie punkt z opisu issue: zapytanie o bilans, zaraz potem —
      // na osobnym, prawdziwym połączeniu — konkurencyjny zapis i commit.
      await tx.query('SELECT 1 FROM ledger_year_summary WHERE school_year_id = $1', [YEAR]);
      await insertConcurrently(url);
      // Kontrola: spoza migawki wpis już istnieje (autocommit na db).
      const outside = await db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE school_year_id = $1', [YEAR]);
      sawConcurrentWriteInEntryCount = outside.rows[0].n;
      return buildAuditReport(tx, YEAR);
    });

    assert.equal(sawConcurrentWriteInEntryCount, 2, 'kontrola: zapis spoza migawki już się zapisał (autocommit)');
    assert.equal(report.balance.incomeCents, 10000, 'migawka raportu nie widzi wpisu dopisanego w trakcie generowania');
    const categorySum = report.categories.reduce((sum, c) => sum + (c.direction === 'income' ? c.netCents : 0), 0);
    assert.equal(categorySum, report.balance.incomeCents, 'suma kategorii i bilans pochodzą z tej samej migawki — zawsze zgodne');
  });
});

// Handlery HTTP na prawdziwym PostgreSQL: opakowanie db wstrzykuje zapis na
// OSOBNYM połączeniu (i zatwierdza go) po pierwszym zapytaniu danych wewnątrz
// migawki. Odpowiedź musi pokazywać stan sprzed zapisu w całości.
function hookedEnv(db, { trigger, inject }) {
  const state = { fired: 0, txQueries: [] };
  const wrap = (tx) => ({
    async query(sql, params) {
      state.txQueries.push(String(sql));
      const result = await tx.query(sql, params);
      if (state.fired === 0 && trigger.test(String(sql))) {
        state.fired += 1;
        await inject();
      }
      return result;
    },
  });
  return { state, env: { db: { query: (...a) => db.query(...a), transaction: (fn, o) => db.transaction((tx) => fn(wrap(tx)), o) } } };
}

async function seedSessions(db) {
  return {
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
  };
}

test('GET /api/year-close/{rok}/handover: zapis na osobnym połączeniu w trakcie nie zmienia zestawienia', { skip }, async () => {
  await withDatabase(async (db, url) => {
    await seed(db);
    const cookies = await seedSessions(db);
    const { env, state } = hookedEnv(db, { trigger: /ledger_year_summary|ledger_entry_net/, inject: () => insertConcurrently(url) });
    const response = await handlePgRequest(request(`/api/year-close/${YEAR}/handover`, { cookie: cookies.board }), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(state.fired, 1, 'zapis został wstrzyknięty w trakcie migawki');
    assert.equal(state.txQueries[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_entries WHERE school_year_id = $1', [YEAR])).rows[0].n, 2);
    assert.equal(body.finance.incomeCents, 10000, 'bilans sprzed zapisu');
    assert.equal(body.finance.ledgerEntryCount, 1, 'liczba wpisów z tej samej chwili co bilans');
  });
});

test('GET /api/reconciliations/{id}: dopasowanie zatwierdzone w trakcie odczytu nie rozjeżdża pozycji i listy dopasowań', { skip }, async () => {
  await withDatabase(async (db, url) => {
    await seed(db);
    const cookies = await seedSessions(db);
    const call = (path, options = {}) => handlePgRequest(request(path, options), { db });
    const created = await call('/api/reconciliations', {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': 'rec-snap-race-1' },
      body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 10000 },
    });
    assert.equal(created.status, 201);
    const { reconciliation } = await created.json();
    const imported = await call(`/api/reconciliations/${reconciliation.id}/lines`, {
      method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': 'imp-snap-race-1' },
      body: { lines: [{ bookedOn: '2026-09-14', amountCents: 10000, reference: 'Syntetyczna pozycja' }] },
    });
    assert.equal(imported.status, 201);
    const lineId = (await db.query('SELECT id FROM bank_statement_lines WHERE reconciliation_id = $1', [reconciliation.id])).rows[0].id;

    const { env, state } = hookedEnv(db, {
      trigger: /bank_statement_lines/,
      inject: async () => {
        const matched = await call(`/api/reconciliations/${reconciliation.id}/matches`, {
          method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': 'm-snap-race-1' },
          body: { statementLineId: lineId, ledgerEntryId: 'le-1' },
        });
        assert.equal(matched.status, 201, 'dopasowanie zatwierdzone na osobnej transakcji w trakcie migawki');
      },
    });
    const response = await handlePgRequest(request(`/api/reconciliations/${reconciliation.id}`, { cookie: cookies.treasurer }), env);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(state.fired, 1);
    const matchedLines = detail.lines.filter((line) => line.matchId);
    assert.equal(matchedLines.length, detail.matches.filter((m) => !m.revokedAt).length, 'pozycje z dopasowaniem = aktywne dopasowania');
    assert.equal(detail.summary.unmatchedLineCount, detail.lines.length - matchedLines.length);
    // Kontrola: po migawce dopasowanie już istnieje.
    const after = await (await call(`/api/reconciliations/${reconciliation.id}`, { cookie: cookies.treasurer })).json();
    assert.equal(after.matches.filter((m) => !m.revokedAt).length, 1);
  });
});
