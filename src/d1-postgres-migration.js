import { createHash } from 'node:crypto';
import { parseBrusselsLocal } from './pg/events.js';

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

// Klucz wiersza do raportów (identyfikatory, nigdy treść).
const KEY_COLUMNS = { student_guardians: ['student_id', 'guardian_id'] };
function rowKey(table, row) {
  return (KEY_COLUMNS[table] ?? ['id']).map((column) => row[column]).join('|');
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

// #198: spójność, której pilnują ograniczenia PostgreSQL (0081/0143). Zamiast
// ogólnego błędu FK/UNIQUE w środku transakcji — czytelny błąd z identyfikatorami
// wierszy (bez e-maili). Niczego nie naprawiamy po cichu.
function assertScopeConsistency(tables) {
  const classYear = new Map(tables.classes.map((row) => [row.id, row.school_year_id]));
  for (const row of tables.role_grants) {
    if (row.class_id == null) continue;
    if (row.school_year_id == null) throw new Error(`Role grant has a class but no school year: ${row.id}`);
    if (classYear.get(row.class_id) !== row.school_year_id) {
      throw new Error(`Role grant class does not belong to its school year: ${row.id}`);
    }
  }
  const byEmail = new Map();
  for (const row of tables.users) {
    if (typeof row.email !== 'string') continue;
    const normalized = row.email.trim().toLowerCase();
    if (normalized !== row.email) throw new Error(`User email is not in lower(btrim()) form: ${row.id}`);
    byEmail.set(normalized, [...(byEmail.get(normalized) ?? []), row.id]);
  }
  for (const ids of byEmail.values()) {
    if (ids.length > 1) throw new Error(`Duplicate user email (case-insensitive): ${ids.sort().join(', ')}`);
  }
}

// Reguła dla godzin wydarzeń (#183): `events.begins_at` to czas wpisany przez człowieka,
// nie znacznik techniczny, więc nie wolno go czytać domyślnie jako UTC. Wartości bez strefy
// wymagają jawnej decyzji (`eventTimeZone`); wartości z `Z` / `±hh:mm` przechodzą bez zmian.
export const EVENT_TIME_ZONES = ['Europe/Brussels', 'UTC'];
const NAIVE_EVENT_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/;
const ZONED_EVENT_TIME = /(Z|[+-]\d{2}:?\d{2})$/i;

function isNaiveEventTime(value) {
  return typeof value === 'string' && !ZONED_EVENT_TIME.test(value.trim());
}

export function eventTimeSummary(snapshot, eventTimeZone) {
  const naive = (snapshot.tables?.events ?? []).filter((row) => isNaiveEventTime(row.begins_at)).length;
  return { eventsWithNaiveTime: naive, rule: naive ? (eventTimeZone ?? null) : 'not_needed' };
}

function normalizeEventTimes(events, eventTimeZone) {
  const naive = events.filter((row) => isNaiveEventTime(row.begins_at));
  if (!naive.length) return;
  if (!EVENT_TIME_ZONES.includes(eventTimeZone)) {
    throw new Error(`Events have begins_at without a time zone (${naive.length}, e.g. ${naive[0].id}); `
      + `specify eventTimeZone (--event-local-time-zone=Europe/Brussels or --event-time-zone=UTC)`);
  }
  for (const row of naive) {
    const match = NAIVE_EVENT_TIME.exec(row.begins_at.trim());
    if (!match) throw new Error(`Unsupported begins_at format: ${row.id}`);
    const local = `${match[1]}T${match[2]}`;
    if (eventTimeZone === 'UTC') {
      row.begins_at = `${local.length === 16 ? `${local}:00` : local}Z`;
      continue;
    }
    try {
      row.begins_at = parseBrusselsLocal(local).toISOString();
    } catch (error) {
      // nonexistent_local_time / ambiguous_local_time (zmiana czasu): bez zgadywania przesunięcia.
      throw new Error(`Event begins_at cannot be converted to Europe/Brussels (${error.message}): ${row.id}`);
    }
  }
}

// #182: lista kolumn jest zamknięta. `createSnapshot` robi `SELECT *`, a INSERT bierze tylko
// kolumny z `specs`, więc niepusta wartość w innej kolumnie (np. `ledger_entries.approval_id`
// z D1 0001) zniknęłaby po cichu. Wybór: PRZERYWAMY (nie ostrzegamy) — dane finansowe nie mogą
// ginąć bez decyzji; przeniesienie albo świadome pominięcie kolumny wymaga zmiany mapowania
// (D-03). Kolumna z NULL / pustym tekstem nie niesie danych i przechodzi. `ledger_entries.category`
// jest legalnie zużywana przez mapowanie na `category_id`.
const CONSUMED_LEGACY_COLUMNS = { ledger_entries: ['category'] };

export function assertNoUnmappedColumns(snapshotTables) {
  const problems = [];
  for (const [table, columns] of specs) {
    const known = new Set([...columns, ...(CONSUMED_LEGACY_COLUMNS[table] ?? [])]);
    const found = new Map();
    for (const row of snapshotTables[table]) {
      for (const [column, value] of Object.entries(row)) {
        if (known.has(column) || value == null || value === '') continue;
        const entry = found.get(column) ?? { count: 0, example: rowKey(table, row) };
        entry.count += 1;
        found.set(column, entry);
      }
    }
    for (const [column, { count, example }] of found) {
      problems.push(`${table}.${column} (${count} rows with data, e.g. ${example})`);
    }
  }
  if (problems.length) {
    throw new Error(`Snapshot has columns outside the migration mapping; restore refused: ${problems.join('; ')}`);
  }
}

// #179: reguły, które PostgreSQL egzekwuje twardo, a D1 sprzed migracji 0005/0007 mogło je łamać
// (triggery D1 blokują poprawkę w miejscu). Zbieramy WSZYSTKIE naruszenia jako listę
// { table, id, rule } — tylko identyfikatory i nazwy reguł, bez wartości. Niczego nie poprawiamy
// po cichu: brak metody, nieistniejąca kategoria, wydatek > 3000 EUR bez uchwały itd. wymagają decyzji
// skarbnika (D-15, D-09/D-12), a nie domysłu narzędzia.
export const LEDGER_METHODS = ['bank', 'cash', 'card', 'other'];
const LARGE_EXPENSE_CENTS = 300000;
const KEYED_TABLES = specs.filter(([, columns]) => columns.includes('idempotency_key')).map(([name]) => name);

export class MigrationViolationsError extends Error {
  constructor(violations) {
    super(`Snapshot violates PostgreSQL rules; restore refused before any transaction (${violations.length}): `
      + violations.map(formatViolation).join('; '));
    this.name = 'MigrationViolationsError';
    this.violations = violations;
  }
}

export function formatViolation({ table, id, rule }) {
  return `${table} ${id}: ${rule}`;
}

export function collectViolations(snapshotTables) {
  const violations = [];
  const add = (table, row, rule) => violations.push({ table, id: rowKey(table, row), rule });
  for (const table of KEYED_TABLES) {
    for (const row of snapshotTables[table]) {
      const key = row.idempotency_key;
      if (key == null || key === '') continue; // brak klucza: deterministyczny klucz legacy:<typ>:<id>
      const length = String(key).trim().length;
      if (length < 8 || length > 128) add(table, row, 'idempotency_key_length_outside_8_128');
    }
  }
  const categories = new Set(snapshotTables.ledger_categories.map((row) => `${row.id}|${row.school_year_id}|${row.direction}`));
  const categoryIds = new Set(snapshotTables.ledger_categories.map((row) => row.id));
  for (const row of snapshotTables.ledger_entries) {
    const categoryId = row.category_id ?? row.category;
    if (categoryId == null || categoryId === '') add('ledger_entries', row, 'category_missing');
    else if (!categoryIds.has(categoryId)) add('ledger_entries', row, 'category_not_found');
    else if (!categories.has(`${categoryId}|${row.school_year_id}|${row.direction}`)) add('ledger_entries', row, 'category_year_or_direction_mismatch');
    if (!LEDGER_METHODS.includes(row.method)) add('ledger_entries', row, row.method == null || row.method === '' ? 'method_missing' : 'method_not_allowed');
    if (row.direction === 'expense' && Number(row.amount_cents) > LARGE_EXPENSE_CENTS
      && String(row.resolution_reference ?? '').trim().length < 3) {
      add('ledger_entries', row, 'expense_over_3000_eur_without_resolution');
    }
    if (row.payment_entry_id != null && row.direction !== 'income') add('ledger_entries', row, 'payment_link_on_non_income');
  }
  return violations;
}

// Tryb --check: wszystkie naruszenia reguł + pierwszy błąd pozostałych kontroli normalizacji
// (spójność zakresów, strefa czasu wydarzeń, kolumny spoza mapowania), jeśli reguły są spełnione.
export function checkSnapshot(snapshot, { eventTimeZone } = {}) {
  verifySnapshot(snapshot);
  const violations = collectViolations(snapshot.tables);
  let otherError = null;
  try { normalizeSnapshot(snapshot, { eventTimeZone, skipRuleCheck: true }); } catch (error) { otherError = error.message; }
  return { ok: violations.length === 0 && otherError == null, violations, otherError };
}

export function normalizeSnapshot(snapshot, { eventTimeZone, skipRuleCheck = false } = {}) {
  verifySnapshot(snapshot);
  assertNoUnmappedColumns(snapshot.tables);
  if (!skipRuleCheck) {
    const violations = collectViolations(snapshot.tables);
    if (violations.length) throw new MigrationViolationsError(violations);
  }
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
  assertScopeConsistency(tables);
  tables.guardians.forEach((row) => { row.contact_allowed = bool(row.contact_allowed); });
  tables.student_guardians.forEach((row) => {
    row.contact_allowed = bool(row.contact_allowed);
    row.is_primary_contact = bool(row.is_primary_contact);
  });
  tables.ledger_categories.forEach((row) => { row.active = bool(row.active); });
  // PostgreSQL 0008: nieopublikowane wydarzenie musi zaczynać jako szkic bez daty publikacji.
  // Nie zgadujemy, czy było kiedyś publiczne — przerywamy z czytelnym błędem zamiast event_must_start_as_draft.
  tables.events.forEach((row) => {
    if (row.visibility !== 'published' && row.published_at != null) {
      throw new Error(`Unpublished event has published_at: ${row.id}`);
    }
  });
  normalizeEventTimes(tables.events, eventTimeZone);
  tables.ledger_entries.forEach((row) => {
    row.category_id ??= row.category;
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

// Postać kanoniczna wartości (#182): ta sama po stronie źródła (SQLite/JSON) i PostgreSQL.
// Daty -> YYYY-MM-DD, czasy -> ISO UTC, flagi -> true/false, kwoty -> tekst liczby, JSON -> klucze posortowane.
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
}

function canonicalValue(dataType, value) {
  if (value == null) return null;
  if (dataType === 'boolean') return String(bool(value) || value === 't' || value === 'true');
  if (dataType === 'date') return String(value).slice(0, 10);
  if (dataType === 'timestamp with time zone') {
    const text = String(value).trim().replace(' ', 'T');
    const zoned = /(Z|[+-]\d{2}(:?\d{2})?)$/i.test(text) ? text.replace(/([+-]\d{2})$/, '$1:00') : `${text}Z`;
    const time = new Date(zoned);
    if (Number.isNaN(time.getTime())) return `invalid:${text}`;
    return time.toISOString();
  }
  if (dataType === 'jsonb') {
    try { return JSON.stringify(sortKeys(typeof value === 'string' ? JSON.parse(value) : value)); } catch { return `invalid:${String(value)}`; }
  }
  if (dataType === 'bigint' || dataType === 'integer' || dataType === 'smallint') return String(BigInt(value));
  return String(value);
}

const DB_GENERATED = Symbol('db-generated');

function rowDigest(columns, types, row, expectedRow) {
  const parts = columns.map((column) => (
    expectedRow?.[column] === DB_GENERATED
      ? (row[column] == null ? null : 'db-generated')
      : canonicalValue(types[column], row[column])));
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function expectedCanonicalRows(rawTables, normalized) {
  const rawPayments = new Map(rawTables.payment_entries.map((row) => [row.id, row]));
  const rows = {};
  for (const [table] of specs) rows[table] = normalized[table];
  // Przypisanie wpłaty jest odtwarzane przez stan przejściowy `unmatched`; stan końcowy ma być jak w D1.
  rows.payment_entries = normalized.payment_entries.map((row) => ({
    ...row, status: rawPayments.get(row.id).status, household_id: rawPayments.get(row.id).household_id,
  }));
  // Udokumentowane wyjątki: opublikowane wydarzenie bez `published_at` dostaje w PostgreSQL (0008)
  // czas importu — oczekujemy tylko, że wartość nie jest pusta.
  rows.events = normalized.events.map((row) => (
    row.visibility === 'published' && row.published_at == null ? { ...row, published_at: DB_GENERATED } : row));
  return rows;
}

async function columnTypes(client) {
  const { rows } = await client.query(
    "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)",
    [SNAPSHOT_TABLES],
  );
  const types = {};
  for (const row of rows) (types[row.table_name] ??= {})[row.column_name] = row.data_type;
  return types;
}

// Czyta każdą tabelę z `specs` z bazy docelowej i porównuje odciski wierszy z oczekiwanymi.
// Błąd wskazuje tabelę i identyfikatory wierszy, bez ich treści. Zwraca odcisk na tabelę.
async function compareRowFingerprints(client, expectedRows) {
  const types = await columnTypes(client);
  const fingerprints = {};
  const failures = [];
  for (const [table, columns] of specs) {
    const columnType = types[table] ?? {};
    const select = columns.map((column) => `"${column}"::text AS "${column}"`).join(', ');
    // Surowy tekst PostgreSQL liczymy w UTC, jak reszta odtworzenia.
    const expectedByKey = new Map(expectedRows[table].map((row) => [rowKey(table, row), row]));
    const actual = new Map((await client.query(`SELECT ${select} FROM "${table}"`)).rows
      .map((row) => [rowKey(table, row), rowDigest(columns, columnType, row, expectedByKey.get(rowKey(table, row)))]));
    const expected = new Map([...expectedByKey].map(([key, row]) => [key, rowDigest(columns, columnType, row, row)]));
    const different = [...new Set([...expected.keys(), ...actual.keys()])]
      .filter((key) => expected.get(key) !== actual.get(key)).sort();
    if (different.length) {
      failures.push(`${table}: ${different.length} rows (${different.slice(0, 5).join(', ')}${different.length > 5 ? ', ...' : ''})`);
    }
    fingerprints[table] = createHash('sha256').update([...actual.values()].sort().join('')).digest('hex');
  }
  if (failures.length) throw new Error(`Row fingerprint mismatch; restore was rolled back: ${failures.join('; ')}`);
  return fingerprints;
}

async function ensureEmpty(client) {
  for (const [table] of specs) {
    const { rows } = await client.query(`SELECT count(*)::int AS count FROM "${table}"`);
    if (Number(rows[0].count) !== 0) throw new Error(`Target table is not empty: ${table}`);
  }
}

export async function restoreSnapshot(client, snapshot, options = {}) {
  const tables = normalizeSnapshot(snapshot, options);
  // #182: wartość oczekiwana pochodzi z SUROWEGO snapshotu (sumy), a odciski z wierszy źródłowych
  // po udokumentowanym mapowaniu — nie z danych porównywanych same ze sobą po odczycie z bazy.
  const expected = sourceReconciliation(snapshot.tables);
  const expectedRows = expectedCanonicalRows(snapshot.tables, tables);
  await client.query('BEGIN');
  try {
    // D1 zapisuje CURRENT_TIMESTAMP jako tekst UTC bez strefy ('YYYY-MM-DD HH:MM:SS').
    // Bez tego PostgreSQL odczytałby go w strefie sesji serwera (np. Europe/Brussels).
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    // Historyczne wpisy i wpłaty z datą spoza roku szkolnego przechodzą bez zmian
    // (0027: trigger daty pomija odtworzenie); raport KR pokazuje je jako odchylenia.
    await client.query("SET LOCAL rd.restore = 'on'");
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
    const fingerprints = await compareRowFingerprints(client, expectedRows);
    await client.query('COMMIT');
    return { ...report, fingerprints };
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
