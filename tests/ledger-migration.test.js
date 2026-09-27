import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration = number => readFileSync(new URL(`../migrations/${number}.sql`, import.meta.url), 'utf8');

function ledgerDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of [
    '0001_initial',
    '0002_auth_sessions',
    '0003_student_guardians',
    '0004_enrollment_school_year',
    '0005_payment_corrections',
    '0006_payment_assignments',
    '0007_ledger_schema',
  ]) db.exec(migration(name));
  db.exec(`
    INSERT INTO school_years (id, label, starts_on, ends_on)
      VALUES ('y2026', '2026/2027', '2026-09-01', '2027-06-30');
    INSERT INTO users (id, email, display_name)
      VALUES ('u1', 'skarbnik@example.org', 'Osoba Testowa');
    INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by)
      VALUES ('d1', 'synthetic/document.pdf', 'application/pdf', 1200, 'receipt', 'u1');
    INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
      VALUES ('income-donations', 'y2026', 'income', 'Dobrowolne wpłaty', 'u1'),
             ('expense-events', 'y2026', 'expense', 'Wydarzenia', 'u1');
  `);
  return db;
}

test('ledger derives balances from immutable entries and additive corrections', () => {
  const db = ledgerDatabase();
  db.exec(`
    INSERT INTO ledger_opening_balances (
      id, school_year_id, amount_cents, source_document_id, note, created_by, idempotency_key
    ) VALUES ('ob1', 'y2026', 10000, 'd1', 'Bilans testowy', 'u1', 'opening-key-0001');
    INSERT INTO ledger_opening_balance_adjustments (
      id, opening_balance_id, amount_cents, reason, created_by, idempotency_key
    ) VALUES ('oba1', 'ob1', 5000, 'Testowa korekta bilansu', 'u1', 'opening-adjustment-0001');
    INSERT INTO ledger_entries (
      id, school_year_id, direction, amount_cents, category, description, occurred_on,
      source_document_id, created_by, method, source, idempotency_key
    ) VALUES (
      'le1', 'y2026', 'income', 100000, 'income-donations', 'Wpływ testowy', '2026-09-20',
      'd1', 'u1', 'bank', 'Wpłaty rodzin', 'ledger-key-0001'
    );
    INSERT INTO ledger_entries (
      id, school_year_id, direction, amount_cents, category, description, occurred_on,
      source_document_id, created_by, method, idempotency_key
    ) VALUES (
      'le2', 'y2026', 'expense', 300000, 'expense-events', 'Wydatek testowy', '2026-09-21',
      'd1', 'u1', 'bank', 'ledger-key-0002'
    );
    INSERT INTO ledger_entries (
      id, school_year_id, direction, amount_cents, category, description, occurred_on,
      source_document_id, created_by, method, resolution_reference, idempotency_key
    ) VALUES (
      'le3', 'y2026', 'expense', 350000, 'expense-events', 'Większy wydatek testowy', '2026-09-22',
      'd1', 'u1', 'bank', 'Uchwała testowa 1/2026', 'ledger-key-0003'
    );
    INSERT INTO ledger_corrections (
      id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key
    ) VALUES ('lc1', 'le3', 50000, 'Testowa korekta wydatku', 'u1', 'ledger-correction-0001');
  `);

  assert.deepEqual(
    { ...db.prepare('SELECT * FROM ledger_year_summary WHERE school_year_id = ?').get('y2026') },
    {
      school_year_id: 'y2026',
      opening_balance_cents: 15000,
      income_cents: 100000,
      expense_cents: 600000,
      closing_balance_cents: -485000,
    },
  );
  assert.throws(
    () => db.prepare('UPDATE ledger_entries SET amount_cents = ? WHERE id = ?').run(1, 'le1'),
    /ledger_entry_financial_facts_immutable/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM ledger_corrections WHERE id = ?').run('lc1'),
    /ledger_corrections_cannot_be_deleted/,
  );
  assert.throws(
    () => db.prepare('UPDATE ledger_categories SET name = ? WHERE id = ?').run('Zmieniona nazwa', 'income-donations'),
    /ledger_category_facts_immutable/,
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO ledger_corrections (
        id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('lc2', 'le3', 300001, 'Za duża korekta', 'u1', 'ledger-correction-0002'),
    /ledger_correction_exceeds_remaining_amount/,
  );
  db.close();
});

test('ledger enforces category, source document, idempotency and resolution threshold', () => {
  const db = ledgerDatabase();
  const insert = db.prepare(`
    INSERT INTO ledger_entries (
      id, school_year_id, direction, amount_cents, category, description, occurred_on,
      source_document_id, created_by, method, resolution_reference, idempotency_key
    ) VALUES (?, 'y2026', ?, ?, ?, 'Wydatek syntetyczny', '2026-09-23', ?, 'u1', 'bank', ?, ?)
  `);

  assert.throws(
    () => insert.run('le1', 'expense', 300001, 'expense-events', 'd1', null, 'ledger-key-0101'),
    /ledger_expense_resolution_required/,
  );
  assert.throws(
    () => insert.run('le2', 'expense', 1000, 'income-donations', 'd1', null, 'ledger-key-0102'),
    /ledger_category_mismatch/,
  );
  assert.throws(
    () => insert.run('le3', 'expense', 1000, 'expense-events', 'missing', null, 'ledger-key-0103'),
    /ledger_source_document_not_found/,
  );
  insert.run('le4', 'expense', 300001, 'expense-events', 'd1', 'Uchwała testowa 2/2026', 'ledger-key-0104');
  assert.throws(
    () => insert.run('le5', 'expense', 1000, 'expense-events', 'd1', null, 'ledger-key-0104'),
    /UNIQUE constraint failed/,
  );
  db.close();
});

test('budget revisions preserve history and expose only the current plan', () => {
  const db = ledgerDatabase();
  db.exec(`
    INSERT INTO ledger_budget_lines (
      id, school_year_id, category_id, planned_cents, note, created_by, idempotency_key
    ) VALUES ('bl1', 'y2026', 'expense-events', 500000, 'Plan początkowy', 'u1', 'budget-key-0001');
    INSERT INTO ledger_budget_lines (
      id, school_year_id, category_id, planned_cents, note, supersedes_id, created_by, idempotency_key
    ) VALUES ('bl2', 'y2026', 'expense-events', 450000, 'Korekta planu', 'bl1', 'u1', 'budget-key-0002');
  `);

  assert.deepEqual(
    { ...db.prepare('SELECT id, planned_cents FROM ledger_current_budget').get() },
    { id: 'bl2', planned_cents: 450000 },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_budget_lines').get().count, 2);
  assert.throws(
    () => db.prepare('UPDATE ledger_budget_lines SET planned_cents = ? WHERE id = ?').run(1, 'bl1'),
    /ledger_budget_lines_cannot_be_updated/,
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO ledger_budget_lines (
        id, school_year_id, category_id, planned_cents, note, created_by, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('bl3', 'y2026', 'expense-events', 100, 'Drugi plan początkowy', 'u1', 'budget-key-0003'),
    /UNIQUE constraint failed/,
  );
  db.close();
});
