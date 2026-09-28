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
import { seedSchoolYear } from './helpers/pg.js';
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
