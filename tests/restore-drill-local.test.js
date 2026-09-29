// Automatyczna próba odtworzenia na danych syntetycznych (issue #90).
//
// Część bez serwera (PGlite): raport zgodności, porównanie, brak danych
// osobowych w raporcie, blokada hostów innych niż lokalne.
// Część na prawdziwym PostgreSQL (pg_dump → szyfrowanie → pg_restore →
// migrator → porównanie raportu): tylko z RD_TEST_PG_URL (lokalny serwer z
// prawem CREATE DATABASE, pg_dump/pg_restore w PATH), inaczej pomijana:
//
//   RD_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres node --test tests/restore-drill-local.test.js
//
// Wyłącznie dane syntetyczne (@example.invalid); żadnych połączeń z Railway.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/pg.js';
import { buildRestoreReport, compareRestoreReports } from '../src/pg/restore-report.js';
import { buildSyntheticData, insertSyntheticData } from '../scripts/lib/synthetic-seed.js';
import { assertLocalServer, runLocalRestoreDrill } from '../scripts/lib/local-restore-drill.js';

const ADMIN_URL = process.env.RD_TEST_PG_URL;
const skipReal = ADMIN_URL ? false : 'brak RD_TEST_PG_URL (wymaga lokalnego PostgreSQL z pg_dump/pg_restore)';

test('assertLocalServer: only local servers, never Railway hosts', () => {
  for (const url of ['postgres://u@127.0.0.1:5432/postgres', 'postgres://u@localhost/postgres', 'postgres://u@[::1]:5432/postgres', 'postgres://u@%2Ftmp%2Fpgsock/postgres']) {
    assert.doesNotThrow(() => assertLocalServer(url), url);
  }
  for (const url of ['postgres://u:p@db.railway.internal:5432/railway', 'postgres://u:p@viaduct.proxy.rlwy.net:1234/railway', 'postgres://u@10.0.0.5/postgres', 'nie-adres']) {
    assert.throws(() => assertLocalServer(url), (error) => /^local_drill_/.test(error.code) && !String(error.message).includes('rlwy'), url);
  }
});

test('buildRestoreReport: financial sums match the seed, no personal data, changes are detected', async () => {
  const db = await createTestDb();
  try {
    const data = await insertSyntheticData(db, buildSyntheticData());
    const query = (sql, params) => db.query(sql, params);
    const first = await buildRestoreReport(query);
    const again = await buildRestoreReport(query);
    assert.deepEqual(compareRestoreReports(first, again), [], 'raport jest deterministyczny');

    // Wpłaty częściowe i korekty: suma netto = wpłaty - korekty.
    const paid = data.payments.reduce((sum, row) => sum + Number(row[3]), 0);
    const corrected = data.corrections.reduce((sum, row) => sum + Number(row[2]), 0);
    assert.equal(first.sums['sum.payment_entries.amount_cents'], paid);
    assert.equal(first.sums['sum.payment_corrections.amount_cents'], corrected);
    assert.equal(first.sums['sum.household_payment_totals.net_amount_cents'], paid - corrected);
    // Rodzeństwo i dwoje opiekunów: liczności powiązań.
    assert.equal(first.rowCounts.students, data.students.length);
    assert.equal(first.rowCounts.student_households, data.students.length);
    assert.equal(first.rowCounts.student_guardians, data.links.length);
    assert.equal(first.rowCounts.payment_entries, data.payments.length);
    assert.match(first.sums['sha256.payment_entries'], /^[0-9a-f]{64}$/);
    assert.ok(first.sums['schema.triggers.count'] > 0, 'wyzwalacze tabel tylko do dopisywania są w raporcie');

    // Raport bez danych osobowych: żadnych imion, adresów e-mail ani wartości pól.
    const serialized = JSON.stringify(first);
    for (const forbidden of ['example.invalid', 'Opiekun', 'Uczeń', 'Syntetyczny', 'REF-']) assert.ok(!serialized.includes(forbidden), forbidden);

    // Dodatkowa wpłata zmienia liczność, sumę i skrót — porównanie to wykrywa.
    await db.query(
      `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, reference, status, created_by, idempotency_key)
       VALUES ('p-extra', 'h0001', 'y2026', 1234, '2026-10-05', 'bank', 'REF-X', 'recorded', 'u0009', 'volume-payment-extra')`,
    );
    const changed = await buildRestoreReport(query);
    const keys = compareRestoreReports(first, changed).map((d) => `${d.section}:${d.key}`);
    assert.ok(keys.includes('rowCounts:payment_entries'));
    assert.ok(keys.includes('sums:sha256.payment_entries'));
    assert.ok(keys.includes('sums:sum.payment_entries.amount_cents'));
    assert.ok(keys.includes('sums:sum.household_payment_totals.net_amount_cents'));
    assert.ok(!keys.includes('rowCounts:payment_corrections'));
  } finally {
    await db.close();
  }
});

test('compareRestoreReports: missing and extra keys are differences', () => {
  const a = { rowCounts: { t1: 1, t2: 2 }, sums: { x: 'a' } };
  const b = { rowCounts: { t1: 1, t3: 3 }, sums: { x: 'b' } };
  const keys = compareRestoreReports(a, b).map((d) => `${d.section}:${d.key}:${d.expected}:${d.actual}`);
  assert.deepEqual(keys, ['rowCounts:t2:2:null', 'rowCounts:t3:null:3', 'sums:x:a:b']);
});

test('lokalna próba odtworzenia: dump → restore → zgodność raportu (pg_dump/pg_restore)', { skip: skipReal, timeout: 300000 }, async () => {
  let inspected = false;
  const result = await runLocalRestoreDrill({
    adminUrl: ADMIN_URL,
    // Zapis po kopii: punktem odniesienia jest migawka kopii, nie żywa baza.
    afterBackup: (source) => source.query(
      "INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id) VALUES ('ae-po-kopii', 'u0001', 'payment.recorded', 'payment_entry', 'p0009')",
    ),
    inspectTarget: async (target, source) => {
      inspected = true;
      const count = async (client, sql) => Number((await client.query(sql)).rows[0].n);
      // Rodzeństwo: rodzina h0001 ma dwoje dzieci; dziecko z dwojgiem opiekunów z kontaktem.
      assert.equal(await count(target, "SELECT count(*) AS n FROM students WHERE household_id = 'h0001'"), 2);
      assert.equal(await count(target, "SELECT count(*) AS n FROM student_guardians WHERE student_id = 's0001' AND contact_allowed"), 2);
      assert.equal(await count(target, 'SELECT count(*) AS n FROM student_households'), await count(source, 'SELECT count(*) AS n FROM student_households'));
      assert.equal(await count(target, 'SELECT count(*) AS n FROM guardian_households'), await count(source, 'SELECT count(*) AS n FROM guardian_households'));
      // Wpłaty częściowe i korekty: sumy netto zgodne ze źródłem (bez wpisu po kopii — to tylko audyt).
      const net = "SELECT coalesce(sum(net_amount_cents), 0) AS n FROM household_payment_totals";
      assert.equal(await count(target, net), await count(source, net));
      // Wyzwalacze tabel tylko do dopisywania działają po odtworzeniu.
      await assert.rejects(target.query("UPDATE audit_events SET action = 'zmiana' WHERE id = 'ae-1'"), /append|immutable|cannot|niezmien/i);
      await assert.rejects(target.query("DELETE FROM payment_entries WHERE id = 'p0001'"), /./);
    },
  });
  assert.ok(inspected);
  assert.equal(result.report.comparison, 'matched');
  assert.equal(result.report.rowCounts.payment_corrections, result.seed.corrections);
  assert.equal(result.report.rowCounts.audit_events, 5, 'zdarzenie dopisane po kopii nie należy do odtworzenia');
  assert.equal(result.report.rowCounts.students, result.seed.students);
});

test('lokalna próba odtworzenia: utrata wiersza po odtworzeniu → niezgodność raportu, błąd', { skip: skipReal, timeout: 300000 }, async () => {
  await assert.rejects(
    runLocalRestoreDrill({
      adminUrl: ADMIN_URL,
      mutateTarget: async (target) => {
        await target.query('ALTER TABLE payment_corrections DISABLE TRIGGER USER');
        await target.query("DELETE FROM payment_corrections WHERE id = 'pc0001'");
        await target.query('ALTER TABLE payment_corrections ENABLE TRIGGER USER');
      },
    }),
    (error) => {
      assert.equal(error.code, 'restore_report_mismatch');
      const keys = error.differences.map((d) => `${d.section}:${d.key}`);
      assert.ok(keys.includes('rowCounts:payment_corrections'));
      assert.ok(keys.includes('sums:sha256.payment_corrections'));
      assert.ok(keys.includes('sums:sum.household_payment_totals.net_amount_cents'));
      return true;
    },
  );
});

test('lokalna próba odtworzenia: uszkodzona kopia w magazynie → błąd sumy kontrolnej, nie sukces', { skip: skipReal, timeout: 300000 }, async () => {
  await assert.rejects(
    runLocalRestoreDrill({
      adminUrl: ADMIN_URL,
      tamperStorage: (storage, key) => { storage.raw(key).body[10] ^= 0xff; },
    }),
    (error) => error.code === 'restore_checksum_mismatch',
  );
});
