import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { checkSnapshot, createSnapshot, restoreSnapshot, SNAPSHOT_FORMAT, SNAPSHOT_TABLES, snapshotChecksum, verifySnapshot } from '../src/d1-postgres-migration.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

function syntheticSnapshot() {
  const tables = Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, []]));
  tables.school_years.push({ id: 'year', label: '2026/27', starts_on: '2026-09-01', ends_on: '2027-08-31' });
  tables.classes.push({ id: 'class', school_year_id: 'year', name: '1A' });
  tables.households.push({ id: 'family', created_at: '2026-09-01T00:00:00Z', archived_at: null });
  tables.guardians.push({ id: 'guardian', household_id: 'family', first_name: 'Anna', last_name: 'Testowa', email: 'anna@example.invalid', contact_allowed: 1 });
  tables.students.push({ id: 'student', household_id: 'family', first_name: 'Jan', last_name: 'Testowy' });
  tables.student_guardians.push({ student_id: 'student', guardian_id: 'guardian', contact_allowed: 1, is_primary_contact: 1, starts_on: null, ends_on: null, created_at: '2026-09-01T00:00:00Z' });
  tables.enrollments.push({ id: 'enrollment', student_id: 'student', class_id: 'class', school_year_id: 'year' });
  tables.users.push({ id: 'user', email: 'user@example.invalid', display_name: 'Synthetic User', disabled_at: null, created_at: '2026-09-01T00:00:00Z' });
  tables.payment_entries.push({ id: 'payment', household_id: 'family', school_year_id: 'year', amount_cents: 5000, received_on: '2026-10-01', method: 'bank', reference: null, status: 'recorded', created_by: 'user', created_at: '2026-10-01T00:00:00Z', idempotency_key: null });
  tables.payment_assignments.push({ id: 'assignment', payment_entry_id: 'payment', household_id: 'family', created_by: 'user', created_at: '2026-10-02T00:00:00Z', idempotency_key: 'assignment-1' });
  tables.payment_corrections.push({ id: 'payment-correction', payment_entry_id: 'payment', amount_cents: 500, reason: 'Synthetic correction', created_by: 'user', created_at: '2026-10-03T00:00:00Z', idempotency_key: 'payment-correction-1' });
  tables.ledger_categories.push({ id: 'income', school_year_id: 'year', direction: 'income', name: 'Dobrowolne wpłaty', active: 1, created_by: 'user', created_at: '2026-09-01T00:00:00Z' });
  tables.ledger_entries.push({ id: 'ledger', school_year_id: 'year', direction: 'income', amount_cents: 5000, category: 'income', description: 'Synthetic income', occurred_on: '2026-10-01', method: 'bank', source: null, payment_entry_id: 'payment', source_document_id: null, resolution_reference: null, created_by: 'user', created_at: '2026-10-01T00:00:00Z', idempotency_key: null });
  tables.ledger_corrections.push({ id: 'ledger-correction', ledger_entry_id: 'ledger', amount_cents: 500, reason: 'Synthetic correction', created_by: 'user', created_at: '2026-10-03T00:00:00Z', idempotency_key: 'ledger-correction-1' });
  tables.ledger_budget_lines.push({ id: 'budget-1', school_year_id: 'year', category_id: 'income', planned_cents: 10000, note: null, supersedes_id: null, created_by: 'user', created_at: '2026-09-01T00:00:00Z', idempotency_key: 'budget-line-1' });
  tables.ledger_budget_lines.push({ id: 'budget-2', school_year_id: 'year', category_id: 'income', planned_cents: 12000, note: null, supersedes_id: 'budget-1', created_by: 'user', created_at: '2026-09-02T00:00:00Z', idempotency_key: 'budget-line-2' });
  tables.audit_events.push({ id: 'audit', actor_id: 'user', action: 'synthetic', entity_type: 'test', entity_id: 'test', occurred_at: '2026-10-01T00:00:00Z', metadata_json: '{}' });
  return { format: SNAPSHOT_FORMAT, createdAt: '2026-09-27T00:00:00Z', tables, checksum: snapshotChecksum(tables) };
}

async function emptyPostgres() {
  const db = new PGlite();
  for (const migration of await loadMigrations(directory)) await db.exec(migration.sql);
  return db;
}

test('snapshot checksum rejects tampering before restore', () => {
  const snapshot = syntheticSnapshot();
  verifySnapshot(snapshot);
  snapshot.tables.students[0].first_name = 'Changed';
  assert.throws(() => verifySnapshot(snapshot), /checksum mismatch/);
});

test('snapshot extraction uses only the explicit table allowlist', () => {
  const sqlite = {
    exec(sql) {
      if (sql.includes('sqlite_master')) return [{ columns: ['name'], values: [...SNAPSHOT_TABLES, 'private_internal'].map((name) => [name]) }];
      return [];
    },
  };
  const snapshot = createSnapshot(sqlite, '2026-09-27T00:00:00Z');
  assert.deepEqual(Object.keys(snapshot.tables), SNAPSHOT_TABLES);
  assert.equal(snapshot.tables.private_internal, undefined);
  verifySnapshot(snapshot);
});

test('restore is atomic, reconciled and recreates assignment events', async () => {
  const db = await emptyPostgres();
  try {
    const report = await restoreSnapshot(db, syntheticSnapshot());
    assert.equal(report.counts.students, 1);
    assert.deepEqual(report.payments, { count: 1, net_cents: '4500' });
    assert.deepEqual(report.ledger, { income_cents: '4500', expense_cents: '0' });
    const payment = await db.query("SELECT household_id,status,idempotency_key FROM payment_entries WHERE id='payment'");
    assert.deepEqual(payment.rows[0], { household_id: 'family', status: 'recorded', idempotency_key: 'legacy:payment:payment' });
    const ledger = await db.query("SELECT category_id,method,idempotency_key FROM ledger_entries WHERE id='ledger'");
    assert.deepEqual(ledger.rows[0], { category_id: 'income', method: 'bank', idempotency_key: 'legacy:ledger:ledger' });
    await assert.rejects(restoreSnapshot(db, syntheticSnapshot()), /Target table is not empty/);
    const count = await db.query('SELECT count(*)::int AS count FROM payment_entries');
    assert.equal(count.rows[0].count, 1);
  } finally { await db.close(); }
});

// #166, #191: ensureEmpty dotyczy WSZYSTKICH tabel (poza schema_migrations), nie tylko tabel migawki.
test('#166: wiersz w tabeli spoza migawki (login_rate_limits) blokuje odtworzenie bez zapisu czegokolwiek', async () => {
  const db = await emptyPostgres();
  try {
    const { rows: tables } = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'");
    const outside = tables.map((row) => row.table_name).filter((name) => !SNAPSHOT_TABLES.includes(name));
    assert.ok(outside.length > 20 && outside.includes('login_rate_limits'), `tabele spoza migawki: ${outside.length}`);
    await db.query("INSERT INTO login_rate_limits (scope_type, scope_hash) VALUES ('email', repeat('a', 64))");
    await assert.rejects(restoreSnapshot(db, syntheticSnapshot()), /Target table is not empty: login_rate_limits/);
    const counts = await db.query('SELECT (SELECT count(*) FROM school_years)::int AS years, (SELECT count(*) FROM audit_events)::int AS audit');
    assert.deepEqual(counts.rows[0], { years: 0, audit: 0 }, 'transakcja nie zostawia śladu');
    await db.query('DELETE FROM login_rate_limits');
    assert.equal((await restoreSnapshot(db, syntheticSnapshot())).counts.students, 1, 'po opróżnieniu odtworzenie przechodzi');
  } finally { await db.close(); }
});

test('#166: schema_migrations nie liczy się jako dane, a niepełny schemat jest odrzucany czytelnym błędem', async () => {
  const db = await emptyPostgres();
  try {
    // exec() nie tworzy schema_migrations (robi to migrator); odtwarzamy jej kształt z src/postgres-migrations.js.
    await db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_seq INTEGER NOT NULL DEFAULT 0)');
    await db.query("INSERT INTO schema_migrations (name, checksum) VALUES ('0001_x.sql', repeat('a', 64))");
    assert.equal((await restoreSnapshot(db, syntheticSnapshot())).counts.students, 1);
  } finally { await db.close(); }
  const partial = new PGlite();
  try {
    await partial.exec('CREATE TABLE school_years (id text)');
    await assert.rejects(restoreSnapshot(partial, syntheticSnapshot()), /Target schema is incomplete \(run migrations first\); missing tables: classes/);
  } finally { await partial.close(); }
});

test('inconsistent assigned payment aborts without partial rows', async () => {
  const db = await emptyPostgres();
  try {
    const snapshot = syntheticSnapshot();
    snapshot.tables.payment_entries[0].household_id = null;
    snapshot.checksum = snapshotChecksum(snapshot.tables);
    await assert.rejects(restoreSnapshot(db, snapshot), /inconsistent final state/);
    const count = await db.query('SELECT count(*)::int AS count FROM school_years');
    assert.equal(count.rows[0].count, 0);
  } finally { await db.close(); }
});

function withViolations() {
  const snapshot = syntheticSnapshot();
  const { tables } = snapshot;
  const base = tables.ledger_entries[0];
  tables.payment_entries[0].idempotency_key = 'k-1';
  tables.ledger_entries.push({ ...base, id: 'ledger-cat', payment_entry_id: null, category: 'Wycieczka', idempotency_key: 'ledger-cat-key' });
  tables.ledger_entries.push({ ...base, id: 'ledger-method', payment_entry_id: null, method: null, idempotency_key: 'ledger-method-key' });
  tables.ledger_entries.push({ ...base, id: 'ledger-big', payment_entry_id: null, direction: 'expense', amount_cents: 450000, category: 'income', idempotency_key: 'ledger-big-key' });
  snapshot.checksum = snapshotChecksum(tables);
  return snapshot;
}

test('#179: check zbiera wszystkie naruszenia, bez wartości osobowych, i jest powtarzalny', () => {
  const snapshot = withViolations();
  const first = checkSnapshot(snapshot);
  assert.equal(first.ok, false);
  const rules = first.violations.map((v) => `${v.table}|${v.id}|${v.rule}`).sort();
  assert.deepEqual(rules, [
    'ledger_entries|ledger-big|category_year_or_direction_mismatch',
    'ledger_entries|ledger-big|expense_over_3000_eur_without_resolution',
    'ledger_entries|ledger-cat|category_not_found',
    'ledger_entries|ledger-method|method_missing',
    'payment_entries|payment|idempotency_key_length_outside_8_128',
  ]);
  assert.deepEqual(checkSnapshot(snapshot), first);
  assert.doesNotMatch(JSON.stringify(first), /Wycieczka|anna@|Testowa/);
});

test('#179: import bez --check nadal odrzuca niezgodne wiersze przed transakcją i nie zapisuje nic', async () => {
  const db = await emptyPostgres();
  try {
    await assert.rejects(restoreSnapshot(db, withViolations()), (error) => (
      /ledger_entries ledger-cat: category_not_found/.test(error.message) && /ledger-method: method_missing/.test(error.message)
      && /payment_entries payment: idempotency_key_length/.test(error.message) && error.violations.length === 5));
    const count = await db.query('SELECT (SELECT count(*) FROM payment_entries)::int AS p, (SELECT count(*) FROM school_years)::int AS y');
    assert.deepEqual(count.rows[0], { p: 0, y: 0 });
  } finally { await db.close(); }
});

test('#179: brak metody nie jest po cichu zamieniany na other', () => {
  const snapshot = syntheticSnapshot();
  snapshot.tables.ledger_entries[0].method = null;
  snapshot.checksum = snapshotChecksum(snapshot.tables);
  assert.deepEqual(checkSnapshot(snapshot).violations, [{ table: 'ledger_entries', id: 'ledger', rule: 'method_missing' }]);
});

test('#179: CLI --check wypisuje raport i kończy się kodem 1 bez łączenia z bazą', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rd-check-'));
  try {
    const file = path.join(dir, 'snapshot.json');
    await writeFile(file, JSON.stringify(withViolations()));
    const script = fileURLToPath(new URL('../scripts/restore-postgres-snapshot.js', import.meta.url));
    const env = { ...process.env, DATABASE_URL: 'postgres://invalid.invalid/none', DATABASE_MIGRATION_URL: '' };
    await assert.rejects(promisify(execFile)(process.execPath, [script, file, '--check'], { env }), (error) => {
      const report = JSON.parse(error.stdout);
      return error.code === 1 && report.ok === false && report.violations.length === 5;
    });
    const good = path.join(dir, 'good.json');
    await writeFile(good, JSON.stringify(syntheticSnapshot()));
    const { stdout } = await promisify(execFile)(process.execPath, [script, good, '--check'], { env });
    assert.equal(JSON.parse(stdout).ok, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
