import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

async function paymentsDb() {
  const db = new PGlite();
  for (const migration of await loadMigrations(directory)) await db.exec(migration.sql);
  await db.query("INSERT INTO school_years VALUES ('year','2026/27','2026-09-01','2027-08-31')");
  await db.query("INSERT INTO households (id) VALUES ('family'), ('family2')");
  await db.query("INSERT INTO users (id,email,display_name) VALUES ('user','test@example.invalid','Synthetic')");
  return db;
}

test('corrections remain append only and cannot overdraw a payment', async () => {
  const db = await paymentsDb();
  try {
    await db.query("INSERT INTO payment_entries (id,household_id,school_year_id,amount_cents,received_on,method,created_by,idempotency_key) VALUES ('p1','family','year',12000,'2026-10-01','bank','user','payment-1')");
    await db.query("INSERT INTO payment_corrections (id,payment_entry_id,amount_cents,reason,created_by,idempotency_key) VALUES ('c1','p1',3000,'Test correction','user','correction-1')");
    await assert.rejects(db.query("INSERT INTO payment_corrections (id,payment_entry_id,amount_cents,reason,created_by,idempotency_key) VALUES ('c2','p1',9001,'Too much correction','user','correction-2')"), /payment_correction_exceeds_remaining_amount/);
    await assert.rejects(db.query("UPDATE payment_entries SET amount_cents=10000 WHERE id='p1'"), /payment_financial_facts_immutable/);
    await assert.rejects(db.query("DELETE FROM payment_entries WHERE id='p1'"), /payment_entries_cannot_be_deleted/);
    await assert.rejects(db.query("UPDATE payment_corrections SET amount_cents=2000 WHERE id='c1'"), /cannot_be_changed/);
    const { rows } = await db.query("SELECT net_amount_cents, payment_count FROM household_payment_totals WHERE household_id='family'");
    assert.equal(Number(rows[0].net_amount_cents), 9000);
    assert.equal(Number(rows[0].payment_count), 1);
  } finally { await db.close(); }
});

test('unmatched assignment transitions exactly once and is atomic', async () => {
  const db = await paymentsDb();
  try {
    await db.query("INSERT INTO payment_entries (id,school_year_id,amount_cents,received_on,method,status,created_by,idempotency_key) VALUES ('p2','year',2500,'2026-10-01','cash','unmatched','user','payment-2')");
    await assert.rejects(db.query("UPDATE payment_entries SET household_id='family',status='recorded' WHERE id='p2'"), /payment_assignment_event_required/);
    await db.query("INSERT INTO payment_assignments (id,payment_entry_id,household_id,created_by,idempotency_key) VALUES ('a1','p2','family','user','assignment-1')");
    const { rows } = await db.query("SELECT status, household_id FROM payment_entries WHERE id='p2'");
    assert.deepEqual(rows[0], { status: 'recorded', household_id: 'family' });
    await assert.rejects(db.query("INSERT INTO payment_assignments (id,payment_entry_id,household_id,created_by,idempotency_key) VALUES ('a2','p2','family2','user','assignment-2')"));
    await assert.rejects(db.query("UPDATE payment_entries SET household_id='family2' WHERE id='p2'"), /payment_assignment_event_required/);
    await assert.rejects(db.query("DELETE FROM payment_assignments WHERE id='a1'"), /cannot_be_changed/);
    const total = await db.query("SELECT net_amount_cents FROM household_payment_totals WHERE household_id='family'");
    assert.equal(Number(total.rows[0].net_amount_cents), 2500);
  } finally { await db.close(); }
});

test('unmatched and legacy reversed payments do not count as household contributions', async () => {
  const db = await paymentsDb();
  try {
    await db.query("INSERT INTO payment_entries (id,school_year_id,amount_cents,received_on,method,status,created_by,idempotency_key) VALUES ('p3','year',1000,'2026-10-01','cash','unmatched','user','payment-3')");
    await db.query("INSERT INTO payment_entries (id,household_id,school_year_id,amount_cents,received_on,method,status,created_by,idempotency_key) VALUES ('p4','family','year',1000,'2026-10-01','cash','reversed','user','payment-4')");
    const { rows } = await db.query('SELECT count(*)::int AS count FROM household_payment_totals');
    assert.equal(rows[0].count, 0);
    await assert.rejects(db.query("INSERT INTO payment_corrections (id,payment_entry_id,amount_cents,reason,created_by,idempotency_key) VALUES ('c3','p4',100,'Reversed payment','user','correction-3')"), /legacy_reversed_payment_cannot_be_corrected/);
  } finally { await db.close(); }
});
