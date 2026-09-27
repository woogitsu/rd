import { createHash } from 'node:crypto';

export const SNAPSHOT_FORMAT = 'rd-d1-snapshot-v1';

const specs = [
  ['school_years', ['id', 'label', 'starts_on', 'ends_on']],
  ['classes', ['id', 'school_year_id', 'name']],
  ['households', ['id', 'created_at', 'archived_at']],
  ['guardians', ['id', 'household_id', 'first_name', 'last_name', 'email', 'contact_allowed']],
  ['students', ['id', 'household_id', 'first_name', 'last_name']],
  ['student_guardians', ['student_id', 'guardian_id', 'contact_allowed', 'is_primary_contact', 'starts_on', 'ends_on', 'created_at']],
  ['enrollments', ['id', 'student_id', 'class_id', 'school_year_id']],
  ['users', ['id', 'email', 'display_name', 'disabled_at', 'created_at']],
  ['role_grants', ['id', 'user_id', 'role', 'class_id', 'school_year_id', 'expires_at']],
  ['documents', ['id', 'object_key', 'mime_type', 'byte_size', 'kind', 'created_by', 'created_at']],
  ['events', ['id', 'school_year_id', 'title', 'begins_at', 'description', 'visibility', 'published_at', 'created_by']],
  ['payment_entries', ['id', 'household_id', 'school_year_id', 'amount_cents', 'received_on', 'method', 'reference', 'status', 'created_by', 'created_at', 'idempotency_key']],
  ['payment_assignments', ['id', 'payment_entry_id', 'household_id', 'created_by', 'created_at', 'idempotency_key']],
  ['payment_corrections', ['id', 'payment_entry_id', 'amount_cents', 'reason', 'created_by', 'created_at', 'idempotency_key']],
  ['ledger_categories', ['id', 'school_year_id', 'direction', 'name', 'active', 'created_by', 'created_at']],
  ['ledger_entries', ['id', 'school_year_id', 'direction', 'amount_cents', 'category_id', 'description', 'occurred_on', 'method', 'source', 'payment_entry_id', 'source_document_id', 'resolution_reference', 'created_by', 'created_at', 'idempotency_key']],
  ['ledger_corrections', ['id', 'ledger_entry_id', 'amount_cents', 'reason', 'created_by', 'created_at', 'idempotency_key']],
  ['ledger_opening_balances', ['id', 'school_year_id', 'amount_cents', 'source_document_id', 'note', 'created_by', 'created_at', 'idempotency_key']],
  ['ledger_opening_balance_adjustments', ['id', 'opening_balance_id', 'amount_cents', 'reason', 'created_by', 'created_at', 'idempotency_key']],
  ['ledger_budget_lines', ['id', 'school_year_id', 'category_id', 'planned_cents', 'note', 'supersedes_id', 'created_by', 'created_at', 'idempotency_key']],
  ['audit_events', ['id', 'actor_id', 'action', 'entity_type', 'entity_id', 'occurred_at', 'metadata_json']],
];

export const SNAPSHOT_TABLES = specs.map(([name]) => name);

function canonicalPayload(tables) {
  return JSON.stringify({ format: SNAPSHOT_FORMAT, tables });
}

export function snapshotChecksum(tables) {
  return createHash('sha256').update(canonicalPayload(tables)).digest('hex');
}

export function createSnapshot(sqlite, createdAt = new Date().toISOString()) {
  const existing = new Set(sqlite.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values.flat() ?? []);
  const missing = SNAPSHOT_TABLES.filter((name) => !existing.has(name));
  if (missing.length) throw new Error(`D1 schema is incomplete; missing tables: ${missing.join(', ')}`);
  const tables = {};
  for (const table of SNAPSHOT_TABLES) {
    const result = sqlite.exec(`SELECT * FROM "${table}" ORDER BY rowid`)[0];
    tables[table] = result ? result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]]))) : [];
  }
  return { format: SNAPSHOT_FORMAT, createdAt, checksum: snapshotChecksum(tables), tables };
}

export function verifySnapshot(snapshot) {
  if (snapshot?.format !== SNAPSHOT_FORMAT || !snapshot.tables || typeof snapshot.tables !== 'object') {
    throw new Error('Unsupported or malformed snapshot');
  }
  const missing = SNAPSHOT_TABLES.filter((name) => !Array.isArray(snapshot.tables[name]));
  if (missing.length) throw new Error(`Snapshot is missing tables: ${missing.join(', ')}`);
  if (snapshot.checksum !== snapshotChecksum(snapshot.tables)) throw new Error('Snapshot checksum mismatch');
}

function bool(value) {
  return value === true || value === 1 || value === '1';
}

function legacyKey(kind, id) {
  return `legacy:${kind}:${id}`;
}

function orderBudgetLines(rows) {
  const pending = new Map(rows.map((row) => [row.id, row]));
  const ordered = [];
  while (pending.size) {
    let progressed = false;
    for (const [id, row] of pending) {
      if (row.supersedes_id == null || ordered.some((item) => item.id === row.supersedes_id)) {
        ordered.push(row); pending.delete(id); progressed = true;
      }
    }
    if (!progressed) throw new Error('Budget revisions contain a cycle or missing parent');
  }
  return ordered;
}

export function normalizeSnapshot(snapshot) {
  verifySnapshot(snapshot);
  const tables = structuredClone(snapshot.tables);
  const assignments = new Map(tables.payment_assignments.map((row) => [row.payment_entry_id, row]));
  tables.payment_entries = tables.payment_entries.map((row) => {
    const assignment = assignments.get(row.id);
    if (assignment) {
      if (row.status !== 'recorded' || row.household_id !== assignment.household_id) {
        throw new Error(`Assigned payment has inconsistent final state: ${row.id}`);
      }
      row.status = 'unmatched'; row.household_id = null;
    }
    row.idempotency_key ||= legacyKey('payment', row.id);
    return row;
  });
  tables.guardians.forEach((row) => { row.contact_allowed = bool(row.contact_allowed); });
  tables.student_guardians.forEach((row) => {
    row.contact_allowed = bool(row.contact_allowed);
    row.is_primary_contact = bool(row.is_primary_contact);
  });
  tables.ledger_categories.forEach((row) => { row.active = bool(row.active); });
  tables.ledger_entries.forEach((row) => {
    row.category_id ??= row.category;
    row.method ||= 'other';
    row.idempotency_key ||= legacyKey('ledger', row.id);
  });
  tables.audit_events.forEach((row) => {
    if (typeof row.metadata_json !== 'string') row.metadata_json = JSON.stringify(row.metadata_json ?? {});
  });
  tables.ledger_budget_lines = orderBudgetLines(tables.ledger_budget_lines);
  return tables;
}

export function sourceReconciliation(tables) {
  const counts = Object.fromEntries(specs.map(([table]) => [table, tables[table].length]));
  const paymentCorrections = new Map();
  for (const row of tables.payment_corrections) {
    paymentCorrections.set(row.payment_entry_id, (paymentCorrections.get(row.payment_entry_id) ?? 0n) + BigInt(row.amount_cents));
  }
  const paymentNet = tables.payment_entries.reduce((sum, row) => sum + BigInt(row.amount_cents) - (paymentCorrections.get(row.id) ?? 0n), 0n);
  const ledgerCorrections = new Map();
  for (const row of tables.ledger_corrections) {
    ledgerCorrections.set(row.ledger_entry_id, (ledgerCorrections.get(row.ledger_entry_id) ?? 0n) + BigInt(row.amount_cents));
  }
  let income = 0n;
  let expense = 0n;
  for (const row of tables.ledger_entries) {
    const net = BigInt(row.amount_cents) - (ledgerCorrections.get(row.id) ?? 0n);
    if (row.direction === 'income') income += net;
    if (row.direction === 'expense') expense += net;
  }
  return {
    counts,
    payments: { count: tables.payment_entries.length, net_cents: paymentNet.toString() },
    ledger: { income_cents: income.toString(), expense_cents: expense.toString() },
  };
}

async function ensureEmpty(client) {
  for (const [table] of specs) {
    const { rows } = await client.query(`SELECT count(*)::int AS count FROM "${table}"`);
    if (Number(rows[0].count) !== 0) throw new Error(`Target table is not empty: ${table}`);
  }
}

export async function restoreSnapshot(client, snapshot) {
  const tables = normalizeSnapshot(snapshot);
  const expected = sourceReconciliation(tables);
  await client.query('BEGIN');
  try {
    await ensureEmpty(client);
    for (const [table, columns] of specs) {
      for (const row of tables[table]) {
        const values = columns.map((column) => row[column] ?? null);
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
        await client.query(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${placeholders})`, values);
      }
    }
    const report = await reconciliationReport(client);
    if (JSON.stringify(report) !== JSON.stringify(expected)) {
      throw new Error('Reconciliation mismatch; restore was rolled back');
    }
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function reconciliationReport(client) {
  const counts = {};
  for (const [table] of specs) {
    const { rows } = await client.query(`SELECT count(*)::int AS count FROM "${table}"`);
    counts[table] = Number(rows[0].count);
  }
  const payments = await client.query('SELECT count(*)::int AS count, COALESCE(sum(net_amount_cents),0)::text AS net_cents FROM payment_entry_net');
  const ledger = await client.query("SELECT COALESCE(sum(net_amount_cents) FILTER (WHERE direction='income'),0)::text AS income_cents, COALESCE(sum(net_amount_cents) FILTER (WHERE direction='expense'),0)::text AS expense_cents FROM ledger_entry_net");
  return { counts, payments: payments.rows[0], ledger: ledger.rows[0] };
}
