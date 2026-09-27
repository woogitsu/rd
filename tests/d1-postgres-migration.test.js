import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { createSnapshot, restoreSnapshot, SNAPSHOT_FORMAT, SNAPSHOT_TABLES, snapshotChecksum, verifySnapshot } from '../src/d1-postgres-migration.js';

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
  tables.ledger_entries.push({ id: 'ledger', school_year_id: 'year', direction: 'income', amount_cents: 5000, category: 'income', description: 'Synthetic income', occurred_on: '2026-10-01', method: null, source: null, payment_entry_id: 'payment', source_document_id: null, resolution_reference: null, created_by: 'user', created_at: '2026-10-01T00:00:00Z', idempotency_key: null });
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
    assert.deepEqual(ledger.rows[0], { category_id: 'income', method: 'other', idempotency_key: 'legacy:ledger:ledger' });
    await assert.rejects(restoreSnapshot(db, syntheticSnapshot()), /Target table is not empty/);
    const count = await db.query('SELECT count(*)::int AS count FROM payment_entries');
    assert.equal(count.rows[0].count, 1);
  } finally { await db.close(); }
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
