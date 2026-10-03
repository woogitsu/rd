import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgliteTestDb } from './helpers/pg.js';


async function ledgerDb() {
  const db = await createPgliteTestDb();
  await db.query("INSERT INTO school_years VALUES ('year','2026/27','2026-09-01','2027-08-31'), ('other','2027/28','2027-09-01','2028-08-31')");
  await db.query("INSERT INTO households (id) VALUES ('family')");
  await db.query("INSERT INTO users (id,email,display_name) VALUES ('user','test@example.invalid','Synthetic')");
  await db.query("INSERT INTO ledger_categories (id,school_year_id,direction,name,created_by) VALUES ('income','year','income','Dobrowolne wpłaty','user'), ('expense','year','expense','Wydarzenia','user'), ('other-expense','other','expense','Wydatki','user')");
  return db;
}

test('ledger summary uses net entries and opening balance adjustments exactly once', async () => {
  const db = await ledgerDb();
  try {
    await db.query("INSERT INTO ledger_opening_balances (id,school_year_id,amount_cents,created_by,idempotency_key) VALUES ('opening','year',10000,'user','opening-1')");
    await db.query("INSERT INTO ledger_opening_balance_adjustments (id,opening_balance_id,amount_cents,reason,created_by,idempotency_key) VALUES ('adjustment','opening',500,'Synthetic adjustment','user','adjustment-1')");
    await db.query("INSERT INTO ledger_entries (id,school_year_id,direction,amount_cents,category_id,description,occurred_on,method,created_by,idempotency_key) VALUES ('income-entry','year','income',5000,'income','Synthetic income','2026-10-01','bank','user','ledger-entry-1'), ('expense-entry','year','expense',2000,'expense','Synthetic expense','2026-10-02','card','user','ledger-entry-2')");
    await db.query("INSERT INTO ledger_corrections (id,ledger_entry_id,amount_cents,reason,created_by,idempotency_key) VALUES ('correction','expense-entry',250,'Synthetic correction','user','ledger-correction-1')");
    const { rows } = await db.query("SELECT * FROM ledger_year_summary WHERE school_year_id='year'");
    assert.equal(Number(rows[0].opening_balance_cents), 10500);
    assert.equal(Number(rows[0].income_cents), 5000);
    assert.equal(Number(rows[0].expense_cents), 1750);
    assert.equal(Number(rows[0].closing_balance_cents), 13750);
  } finally { await db.close(); }
});

test('ledger rejects excessive correction, mutation and invalid large expense', async () => {
  const db = await ledgerDb();
  try {
    await assert.rejects(db.query("INSERT INTO ledger_entries (id,school_year_id,direction,amount_cents,category_id,description,occurred_on,method,created_by,idempotency_key) VALUES ('large','year','expense',300001,'expense','Synthetic large expense','2026-10-01','bank','user','ledger-large-1')"));
    await db.query("INSERT INTO ledger_entries (id,school_year_id,direction,amount_cents,category_id,description,occurred_on,method,resolution_reference,created_by,idempotency_key) VALUES ('large','year','expense',300001,'expense','Synthetic large expense','2026-10-01','bank','UCH-1','user','ledger-large-1')");
    await db.query("INSERT INTO ledger_corrections (id,ledger_entry_id,amount_cents,reason,created_by,idempotency_key) VALUES ('c1','large',300000,'Synthetic correction','user','ledger-correction-1')");
    await assert.rejects(db.query("INSERT INTO ledger_corrections (id,ledger_entry_id,amount_cents,reason,created_by,idempotency_key) VALUES ('c2','large',2,'Too much','user','ledger-correction-2')"), /ledger_correction_exceeds_remaining_amount/);
    await assert.rejects(db.query("UPDATE ledger_entries SET amount_cents=1 WHERE id='large'"), /cannot_be_changed/);
    await assert.rejects(db.query("DELETE FROM ledger_corrections WHERE id='c1'"), /cannot_be_changed/);
  } finally { await db.close(); }
});

test('ledger validates active category and one matching payment link', async () => {
  const db = await ledgerDb();
  try {
    await db.query("INSERT INTO payment_entries (id,household_id,school_year_id,amount_cents,received_on,method,created_by,idempotency_key) VALUES ('payment','family','year',4000,'2026-10-01','bank','user','payment-ledger-1')");
    await db.query("INSERT INTO ledger_entries (id,school_year_id,direction,amount_cents,category_id,description,occurred_on,method,payment_entry_id,created_by,idempotency_key) VALUES ('linked','year','income',4000,'income','Synthetic payment income','2026-10-01','bank','payment','user','ledger-linked-1')");
    await assert.rejects(db.query("INSERT INTO ledger_entries (id,school_year_id,direction,amount_cents,category_id,description,occurred_on,method,payment_entry_id,created_by,idempotency_key) VALUES ('linked2','year','income',4000,'income','Duplicate payment income','2026-10-01','bank','payment','user','ledger-linked-2')"));
    await assert.rejects(db.query("INSERT INTO ledger_entries (id,school_year_id,direction,amount_cents,category_id,description,occurred_on,method,created_by,idempotency_key) VALUES ('wrong-category','year','expense',100,'other-expense','Wrong year category','2026-10-01','cash','user','ledger-wrong-1')"));
    await db.query("UPDATE ledger_categories SET active=false WHERE id='expense'");
    await assert.rejects(db.query("INSERT INTO ledger_entries (id,school_year_id,direction,amount_cents,category_id,description,occurred_on,method,created_by,idempotency_key) VALUES ('inactive','year','expense',100,'expense','Inactive category','2026-10-01','cash','user','ledger-inactive-1')"), /ledger_category_inactive/);
  } finally { await db.close(); }
});

test('budget revisions preserve history and prevent branching', async () => {
  const db = await ledgerDb();
  try {
    await db.query("INSERT INTO ledger_budget_lines (id,school_year_id,category_id,planned_cents,created_by,idempotency_key) VALUES ('budget-1','year','expense',10000,'user','budget-line-1')");
    await db.query("INSERT INTO ledger_budget_lines (id,school_year_id,category_id,planned_cents,supersedes_id,created_by,idempotency_key) VALUES ('budget-2','year','expense',12000,'budget-1','user','budget-line-2')");
    await assert.rejects(db.query("INSERT INTO ledger_budget_lines (id,school_year_id,category_id,planned_cents,supersedes_id,created_by,idempotency_key) VALUES ('budget-3','year','expense',13000,'budget-1','user','budget-line-3')"));
    await assert.rejects(db.query("UPDATE ledger_budget_lines SET planned_cents=1 WHERE id='budget-2'"), /cannot_be_changed/);
    const { rows } = await db.query('SELECT id, planned_cents FROM ledger_current_budget');
    assert.deepEqual(rows, [{ id: 'budget-2', planned_cents: 12000 }]);
  } finally { await db.close(); }
});
