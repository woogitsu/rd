// Wersjonowany eksport roczny, weryfikacja manifestu i odtworzenie do pustej
// bazy (issue #9). Prototyp — nie jest wdrożony; opis w docs/EXPORT.md.
//
// Kontrakt wykonawcy jak w src/db.js: executor.query(sql, params) -> { rows },
// db.transaction(async (tx) => …). Działa z pg i PGlite.
//
// Paczka (bundle) jest deterministyczna: te same dane dają bajt w bajt ten sam
// JSON i ten sam SHA-256 manifestu. Dlatego paczka nie zawiera identyfikatora
// przebiegu ani czasu utworzenia (są w export_runs i w nagłówkach HTTP), a
// dziennik audytu w paczce pomija zdarzenia `export.*`.
//
// Paczka zawiera dane osobowe (uczniowie, opiekunowie) i finansowe. Nie
// zapisywać jej w repo, CI, logach ani zgłoszeniach.

import { createHash } from 'node:crypto';

export const EXPORT_FORMAT = 'rd-yearly-export';
export const EXPORT_FORMAT_VERSION = 1;
export const ROSTER_FORMAT = 'rd-class-roster';
export const ROSTER_FORMAT_VERSION = 1;

const MAX_ROWS_PER_TABLE = 500_000;
const INSERT_BATCH_ROWS = 100;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const PATH_PATTERN = /^[a-z][a-z0-9_]{0,62}\.jsonl$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class ExportError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Kanoniczny JSON i skróty

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ExportError('non_finite_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new ExportError('unsupported_value');
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function quoteIdent(name) {
  if (!IDENTIFIER.test(name)) throw new ExportError('invalid_identifier');
  return `"${name}"`;
}

// ---------------------------------------------------------------------------
// Zakres tabel

const YEAR_STUDENTS = 'SELECT student_id FROM enrollments WHERE school_year_id = $1';

function guardianScope(has) {
  const parts = [`id IN (SELECT guardian_id FROM student_guardians WHERE student_id IN (${YEAR_STUDENTS}))`];
  if (has.has('meeting_attendees') && has.has('meetings')) {
    parts.push(`id IN (SELECT ma.guardian_id FROM meeting_attendees ma JOIN meetings m ON m.id = ma.meeting_id
      WHERE m.school_year_id = $1 AND ma.guardian_id IS NOT NULL)`);
  }
  return `(${parts.join(' OR ')})`;
}

function householdScope(has) {
  const parts = [
    `id IN (SELECT household_id FROM students WHERE id IN (${YEAR_STUDENTS}))`,
    `id IN (SELECT household_id FROM guardians WHERE ${guardianScope(has)})`,
  ];
  if (has.has('payment_entries')) {
    parts.push('id IN (SELECT household_id FROM payment_entries WHERE school_year_id = $1 AND household_id IS NOT NULL)');
    if (has.has('payment_assignments')) {
      parts.push(`id IN (SELECT pa.household_id FROM payment_assignments pa
        JOIN payment_entries p ON p.id = pa.payment_entry_id WHERE p.school_year_id = $1)`);
    }
    if (has.has('payment_reassignments')) {
      parts.push(`id IN (SELECT pr.old_household_id FROM payment_reassignments pr
        JOIN payment_entries p ON p.id = pr.payment_entry_id WHERE p.school_year_id = $1)`);
      parts.push(`id IN (SELECT pr.new_household_id FROM payment_reassignments pr
        JOIN payment_entries p ON p.id = pr.payment_entry_id WHERE p.school_year_id = $1)`);
    }
  }
  return `(${parts.join(' OR ')})`;
}

// Zakres audytu: zdarzenia jawnie oznaczone tym rokiem w metadanych
// (schoolYearId), a bez oznaczenia — z dat roku szkolnego (Europe/Brussels). Zdarzenia eksportu (`export.*`) są
// pominięte, żeby kolejny eksport nie zmieniał wyniku poprzedniego.
const AUDIT_SCOPE = `action NOT LIKE 'export.%' AND (
  metadata_json->>'schoolYearId' = $1
  OR (metadata_json->>'schoolYearId' IS NULL
      AND occurred_at >= (SELECT (starts_on::timestamp AT TIME ZONE 'Europe/Brussels') FROM school_years WHERE id = $1)
      AND occurred_at < (SELECT ((ends_on + 1)::timestamp AT TIME ZONE 'Europe/Brussels') FROM school_years WHERE id = $1))
)`;

// Kolejność = kolejność odtwarzania (zgodna z kluczami obcymi).
// `columns` = jawna lista dozwolonych pól (dane osobowe, projekt listy D-03);
// nowe kolumny w tych tabelach nie trafią do eksportu bez zmiany kodu.
// `requires` = tabele, które muszą istnieć, by tabela była eksportowana.
export const EXPORT_TABLES = Object.freeze([
  { table: 'school_years', required: true, where: () => 'id = $1' },
  { table: 'classes', required: true, where: () => 'school_year_id = $1' },
  { table: 'households', required: true, columns: ['id', 'created_at', 'archived_at'], where: householdScope },
  { table: 'students', required: true, columns: ['id', 'household_id', 'first_name', 'last_name'],
    where: () => `id IN (${YEAR_STUDENTS})` },
  { table: 'guardians', required: true,
    columns: ['id', 'household_id', 'first_name', 'last_name', 'email', 'contact_allowed'], where: guardianScope },
  { table: 'student_guardians', required: true,
    columns: ['student_id', 'guardian_id', 'contact_allowed', 'is_primary_contact', 'starts_on', 'ends_on', 'created_at'],
    where: () => `student_id IN (${YEAR_STUDENTS})` },
  { table: 'enrollments', required: true, where: () => 'school_year_id = $1' },

  { table: 'payment_entries', where: () => 'school_year_id = $1' },
  { table: 'payment_corrections', requires: ['payment_entries'],
    where: () => 'payment_entry_id IN (SELECT id FROM payment_entries WHERE school_year_id = $1)' },
  { table: 'payment_assignments', requires: ['payment_entries'],
    where: () => 'payment_entry_id IN (SELECT id FROM payment_entries WHERE school_year_id = $1)' },
  { table: 'payment_refunds', requires: ['payment_entries'],
    where: () => 'payment_entry_id IN (SELECT id FROM payment_entries WHERE school_year_id = $1)' },
  { table: 'payment_reassignments', requires: ['payment_entries'],
    where: () => 'payment_entry_id IN (SELECT id FROM payment_entries WHERE school_year_id = $1)' },

  { table: 'ledger_categories', where: () => 'school_year_id = $1' },
  { table: 'ledger_opening_balances', where: () => 'school_year_id = $1' },
  { table: 'ledger_opening_balance_adjustments', requires: ['ledger_opening_balances'],
    where: () => 'opening_balance_id IN (SELECT id FROM ledger_opening_balances WHERE school_year_id = $1)' },
  { table: 'ledger_entries', where: () => 'school_year_id = $1' },
  { table: 'ledger_corrections', requires: ['ledger_entries'],
    where: () => 'ledger_entry_id IN (SELECT id FROM ledger_entries WHERE school_year_id = $1)' },
  { table: 'ledger_budget_lines', where: () => 'school_year_id = $1' },

  { table: 'events', where: () => 'school_year_id = $1' },
  { table: 'event_revisions', requires: ['events'],
    where: () => 'event_id IN (SELECT id FROM events WHERE school_year_id = $1)' },

  { table: 'meetings', where: () => 'school_year_id = $1' },
  { table: 'meeting_agenda_items', requires: ['meetings'],
    where: () => 'meeting_id IN (SELECT id FROM meetings WHERE school_year_id = $1)' },
  { table: 'meeting_attendees', requires: ['meetings'],
    where: () => 'meeting_id IN (SELECT id FROM meetings WHERE school_year_id = $1)' },
  { table: 'meeting_quorum_checks', requires: ['meetings'],
    where: () => 'meeting_id IN (SELECT id FROM meetings WHERE school_year_id = $1)' },
  { table: 'meeting_minutes', requires: ['meetings'],
    where: () => 'meeting_id IN (SELECT id FROM meetings WHERE school_year_id = $1)' },
  { table: 'meeting_minutes_publications', requires: ['meeting_minutes', 'meetings'],
    where: () => `minutes_id IN (SELECT mm.id FROM meeting_minutes mm JOIN meetings m ON m.id = mm.meeting_id
      WHERE m.school_year_id = $1)` },
  { table: 'resolutions', where: () => 'school_year_id = $1' },

  { table: 'audit_events', where: () => AUDIT_SCOPE },
]);

const KNOWN_TABLES = new Set(EXPORT_TABLES.map((spec) => spec.table));

// ---------------------------------------------------------------------------
// Introspekcja schematu (bez składania SQL z danych wejściowych)

async function listBaseTables(executor) {
  const { rows } = await executor.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
  );
  return new Set(rows.map((row) => row.table_name));
}

async function relationExists(executor, name) {
  const { rows } = await executor.query('SELECT to_regclass($1) IS NOT NULL AS present', [name]);
  return Boolean(rows[0]?.present);
}

async function tableColumns(executor, table) {
  const { rows } = await executor.query(
    `SELECT column_name, data_type, is_identity, identity_generation
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => ({
    name: row.column_name,
    type: row.data_type,
    identityAlways: row.is_identity === 'YES' && row.identity_generation === 'ALWAYS',
    identity: row.is_identity === 'YES',
  }));
}

async function primaryKey(executor, table) {
  const { rows } = await executor.query(
    `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = to_regclass($1) AND i.indisprimary
      ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [table],
  );
  return rows.map((row) => row.name);
}

async function schemaMigrations(executor) {
  if (!(await relationExists(executor, 'schema_migrations'))) return null;
  const { rows } = await executor.query('SELECT name FROM schema_migrations ORDER BY name COLLATE "C"');
  return rows.map((row) => row.name);
}

// Wyrażenie SELECT dające tekstową, niezależną od strefy i sterownika postać.
function selectExpression(column) {
  const q = quoteIdent(column.name);
  switch (column.type) {
    case 'timestamp with time zone':
      return `to_char(${q} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${q}`;
    case 'timestamp without time zone':
      return `to_char(${q}, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS ${q}`;
    case 'date':
      return `to_char(${q}, 'YYYY-MM-DD') AS ${q}`;
    case 'boolean':
    case 'integer':
    case 'smallint':
    case 'text':
      return q;
    default:
      return `${q}::text AS ${q}`;
  }
}

function normalizeValue(column, value) {
  if (value === null || value === undefined) return null;
  switch (column.type) {
    case 'bigint':
    case 'numeric': {
      const text = String(value);
      if (/^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
      return text;
    }
    case 'json':
    case 'jsonb':
      return JSON.parse(String(value));
    case 'integer':
    case 'smallint':
      return Number(value);
    case 'boolean':
      return Boolean(value);
    default:
      return String(value);
  }
}

function toSafeNumber(value) {
  if (value === null || value === undefined) return 0;
  const number = Number(String(value));
  if (!Number.isSafeInteger(number)) throw new ExportError('unsafe_integer');
  return number;
}

function centsSums(columns, rows) {
  const sums = {};
  for (const column of columns) {
    if (!column.endsWith('_cents')) continue;
    let total = 0;
    for (const row of rows) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      if (!Number.isSafeInteger(value)) throw new ExportError('invalid_cents_value');
      total += value;
    }
    if (!Number.isSafeInteger(total)) throw new ExportError('unsafe_integer');
    sums[column] = total;
  }
  return sums;
}

async function exportTotals(executor, schoolYearId) {
  const totals = {};
  if (await relationExists(executor, 'household_payment_totals')) {
    const { rows } = await executor.query(
      `SELECT COALESCE(sum(net_amount_cents), 0)::text AS net, COALESCE(sum(payment_count), 0)::text AS count
         FROM household_payment_totals WHERE school_year_id = $1`,
      [schoolYearId],
    );
    totals.payments = { recordedNetCents: toSafeNumber(rows[0]?.net), recordedCount: toSafeNumber(rows[0]?.count) };
  }
  if (await relationExists(executor, 'ledger_year_summary')) {
    const { rows } = await executor.query(
      `SELECT opening_balance_cents::text AS opening, income_cents::text AS income,
              expense_cents::text AS expense, closing_balance_cents::text AS closing
         FROM ledger_year_summary WHERE school_year_id = $1
        ORDER BY opening_balance_cents, closing_balance_cents`,
      [schoolYearId],
    );
    const row = rows[0] ?? {};
    totals.ledger = {
      openingBalanceCents: toSafeNumber(row.opening),
      incomeCents: toSafeNumber(row.income),
      expenseCents: toSafeNumber(row.expense),
      closingBalanceCents: toSafeNumber(row.closing),
    };
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Eksport

/**
 * Buduje deterministyczną paczkę roku szkolnego. Wywołuj w transakcji
 * REPEATABLE READ, żeby wszystkie pliki pochodziły z jednej migawki.
 * @returns {Promise<{ bundle, body, manifest, manifestSha256, rowCounts }>}
 */
export async function buildYearlyExport(executor, schoolYearId) {
  if (typeof schoolYearId !== 'string' || !schoolYearId) throw new ExportError('invalid_school_year');
  const { rows: yearRows } = await executor.query('SELECT id FROM school_years WHERE id = $1', [schoolYearId]);
  if (!yearRows.length) throw new ExportError('school_year_not_found');

  const has = await listBaseTables(executor);
  const files = [];
  const contents = {};
  const rowCounts = {};

  for (const spec of EXPORT_TABLES) {
    if (!has.has(spec.table) || (spec.requires ?? []).some((name) => !has.has(name))) {
      if (spec.required) throw new ExportError(`required_table_missing:${spec.table}`);
      continue;
    }
    const available = await tableColumns(executor, spec.table);
    const selected = spec.columns
      ? available.filter((column) => spec.columns.includes(column.name))
      : available;
    selected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const pk = await primaryKey(executor, spec.table);
    const orderColumns = pk.length ? pk : selected.map((column) => column.name);
    const orderBy = orderColumns.map((name) => {
      const column = available.find((item) => item.name === name);
      return column && column.type === 'text' ? `${quoteIdent(name)} COLLATE "C"` : quoteIdent(name);
    }).join(', ');

    const { rows } = await executor.query(
      `SELECT ${selected.map(selectExpression).join(', ')} FROM ${quoteIdent(spec.table)}
        WHERE ${spec.where(has)} ORDER BY ${orderBy} LIMIT ${MAX_ROWS_PER_TABLE + 1}`,
      [schoolYearId],
    );
    if (rows.length > MAX_ROWS_PER_TABLE) throw new ExportError(`table_too_large:${spec.table}`);

    const records = rows.map((row) => {
      const record = {};
      for (const column of selected) record[column.name] = normalizeValue(column, row[column.name]);
      return record;
    });
    const content = records.map((record) => `${canonicalJson(record)}\n`).join('');
    const path = `${spec.table}.jsonl`;
    const columnNames = selected.map((column) => column.name);
    contents[path] = content;
    rowCounts[spec.table] = records.length;
    files.push({
      path,
      table: spec.table,
      columns: columnNames,
      rows: records.length,
      sha256: sha256Hex(content),
      sums: centsSums(columnNames, records),
    });
  }

  const manifest = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    schoolYearId,
    schema: { migrations: await schemaMigrations(executor) },
    files,
    totals: await exportTotals(executor, schoolYearId),
  };
  const manifestSha256 = sha256Hex(canonicalJson(manifest));
  const bundle = { format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION, manifest, manifestSha256, files: contents };
  return { bundle, body: canonicalJson(bundle), manifest, manifestSha256, rowCounts };
}

// ---------------------------------------------------------------------------
// Weryfikacja paczki względem manifestu (bez bazy)

function fail(code) {
  throw new ExportError(code);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonLines(content, path) {
  if (content === '') return [];
  if (!content.endsWith('\n')) fail(`file_not_terminated:${path}`);
  return content.slice(0, -1).split('\n').map((line, index) => {
    let record;
    try { record = JSON.parse(line); } catch { fail(`invalid_json_line:${path}:${index + 1}`); }
    if (!isPlainObject(record)) fail(`invalid_json_line:${path}:${index + 1}`);
    if (canonicalJson(record) !== line) fail(`non_canonical_line:${path}:${index + 1}`);
    return record;
  });
}

/**
 * Sprawdza format, SHA-256 manifestu, SHA-256 i liczność każdego pliku,
 * kolumny i sumy w centach. Zwraca raport bez treści (tylko liczby).
 */
export function verifyBundle(bundle) {
  if (!isPlainObject(bundle)) fail('invalid_bundle');
  if (bundle.format !== EXPORT_FORMAT) fail('unsupported_format');
  if (bundle.formatVersion !== EXPORT_FORMAT_VERSION) fail('unsupported_format_version');
  const { manifest } = bundle;
  if (!isPlainObject(manifest) || !isPlainObject(bundle.files)) fail('invalid_bundle');
  if (typeof bundle.manifestSha256 !== 'string' || !SHA256_PATTERN.test(bundle.manifestSha256)) fail('invalid_manifest_sha256');
  if (sha256Hex(canonicalJson(manifest)) !== bundle.manifestSha256) fail('manifest_hash_mismatch');
  if (manifest.format !== EXPORT_FORMAT || manifest.formatVersion !== EXPORT_FORMAT_VERSION) fail('manifest_format_mismatch');
  if (typeof manifest.schoolYearId !== 'string' || !manifest.schoolYearId) fail('invalid_manifest');
  if (!Array.isArray(manifest.files)) fail('invalid_manifest');

  const listed = new Set();
  const order = EXPORT_TABLES.map((spec) => spec.table);
  let previous = -1;
  const report = [];
  for (const entry of manifest.files) {
    if (!isPlainObject(entry) || typeof entry.path !== 'string' || !PATH_PATTERN.test(entry.path)) fail('invalid_manifest_entry');
    if (!KNOWN_TABLES.has(entry.table) || entry.path !== `${entry.table}.jsonl`) fail(`unknown_table:${entry.path}`);
    if (listed.has(entry.path)) fail(`duplicate_file:${entry.path}`);
    const position = order.indexOf(entry.table);
    if (position <= previous) fail(`invalid_file_order:${entry.path}`);
    previous = position;
    listed.add(entry.path);
    if (!Array.isArray(entry.columns) || !entry.columns.every((name) => typeof name === 'string' && IDENTIFIER.test(name))) {
      fail(`invalid_columns:${entry.path}`);
    }
    const spec = EXPORT_TABLES[position];
    if (spec.columns && entry.columns.some((name) => !spec.columns.includes(name))) fail(`column_not_allowed:${entry.path}`);

    const content = bundle.files[entry.path];
    if (typeof content !== 'string') fail(`file_missing:${entry.path}`);
    if (sha256Hex(content) !== entry.sha256) fail(`file_hash_mismatch:${entry.path}`);
    const records = parseJsonLines(content, entry.path);
    if (records.length !== entry.rows) fail(`row_count_mismatch:${entry.path}`);
    const expectedKeys = canonicalJson([...entry.columns].sort());
    for (const record of records) {
      if (canonicalJson(Object.keys(record).sort()) !== expectedKeys) fail(`column_mismatch:${entry.path}`);
    }
    if (canonicalJson(centsSums(entry.columns, records)) !== canonicalJson(entry.sums ?? {})) fail(`sum_mismatch:${entry.path}`);
    report.push({ table: entry.table, rows: entry.rows, sums: entry.sums });
  }
  for (const spec of EXPORT_TABLES) {
    if (spec.required && !listed.has(`${spec.table}.jsonl`)) fail(`required_file_missing:${spec.table}.jsonl`);
  }
  for (const path of Object.keys(bundle.files)) if (!listed.has(path)) fail(`unlisted_file:${path}`);

  return {
    schoolYearId: manifest.schoolYearId,
    formatVersion: manifest.formatVersion,
    manifestSha256: bundle.manifestSha256,
    tables: report,
    totals: manifest.totals ?? {},
  };
}

// ---------------------------------------------------------------------------
// Odtworzenie do pustej bazy (test odtworzenia)

// Blokada środowiska produkcyjnego dla skryptów odtwarzania.
export function assertRestoreAllowed({ appEnv, allowProduction = false } = {}) {
  if (appEnv === 'production' && !allowProduction) throw new ExportError('production_restore_requires_allow_production');
}

async function assertEmptyTarget(tx) {
  const tables = [...await listBaseTables(tx)].filter((name) => name !== 'schema_migrations').sort();
  for (const table of tables) {
    if (!IDENTIFIER.test(table)) continue;
    const { rows } = await tx.query(`SELECT EXISTS (SELECT 1 FROM ${quoteIdent(table)}) AS present`);
    if (rows[0]?.present) fail(`target_not_empty:${table}`);
  }
  return new Set(tables);
}

function insertValue(column, value) {
  if (value === null || value === undefined) return null;
  if (column.type === 'json' || column.type === 'jsonb') return JSON.stringify(value);
  if (typeof value === 'object') fail('unexpected_object_value');
  return value;
}

/**
 * Odtwarza zweryfikowaną paczkę do PUSTEJ bazy z aktualnym schematem
 * (po npm run db:migrate:postgres). Jedna transakcja; pierwszy błąd wycofuje
 * całość. Triggery i klucze obce są wyłączone na czas transakcji
 * (session_replication_role = replica, wymaga roli z uprawnieniem
 * superużytkownika), bo paczka odtwarza stan końcowy, a nie przebieg operacji.
 * Po zatwierdzeniu wykonuje ponowny eksport i porównuje pliki oraz sumy.
 */
export async function restoreBundle(db, bundle) {
  const verified = verifyBundle(bundle);
  const { manifest } = bundle;

  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL session_replication_role = 'replica'");
    const existing = await assertEmptyTarget(tx);
    for (const entry of manifest.files) {
      if (!existing.has(entry.table)) fail(`target_table_missing:${entry.table}`);
      const targetColumns = await tableColumns(tx, entry.table);
      const columns = entry.columns.map((name) => {
        const column = targetColumns.find((item) => item.name === name);
        if (!column) fail(`target_column_missing:${entry.table}.${name}`);
        return column;
      });
      const override = columns.some((column) => column.identityAlways) ? ' OVERRIDING SYSTEM VALUE' : '';
      const records = parseJsonLines(bundle.files[entry.path], entry.path);
      for (let start = 0; start < records.length; start += INSERT_BATCH_ROWS) {
        const batch = records.slice(start, start + INSERT_BATCH_ROWS);
        const params = [];
        const tuples = batch.map((record) => `(${columns.map((column) => {
          params.push(insertValue(column, record[column.name]));
          return `$${params.length}`;
        }).join(', ')})`);
        await tx.query(
          `INSERT INTO ${quoteIdent(entry.table)} (${columns.map((column) => quoteIdent(column.name)).join(', ')})${override}
           VALUES ${tuples.join(', ')}`,
          params,
        );
      }
      for (const column of columns.filter((item) => item.identity)) {
        await tx.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT max(${quoteIdent(column.name)}) FROM ${quoteIdent(entry.table)}), 1),
                  (SELECT max(${quoteIdent(column.name)}) FROM ${quoteIdent(entry.table)}) IS NOT NULL)`,
          [entry.table, column.name],
        );
      }
    }
  });

  // Kontrola po odtworzeniu: ten sam eksport z odtworzonej bazy.
  const again = await buildYearlyExport(db, manifest.schoolYearId);
  const expected = manifest.files.map(({ path, rows, sha256, sums }) => ({ path, rows, sha256, sums }));
  const actual = again.manifest.files
    .filter((entry) => manifest.files.some((item) => item.path === entry.path))
    .map(({ path, rows, sha256, sums }) => ({ path, rows, sha256, sums }));
  const filesMatch = canonicalJson(expected) === canonicalJson(actual);
  const totalsMatch = canonicalJson(manifest.totals ?? {}) === canonicalJson(again.manifest.totals);
  if (!filesMatch) fail('restore_verification_failed:files');
  if (!totalsMatch) fail('restore_verification_failed:totals');
  return { ...verified, restored: true, reexportFilesMatch: filesMatch, reexportTotalsMatch: totalsMatch };
}

// ---------------------------------------------------------------------------
// Lista klasy dla przedstawiciela (bez danych finansowych i bez identyfikatorów rodzin)

export async function buildClassRoster(executor, classId) {
  const { rows: classRows } = await executor.query(
    'SELECT id, name, school_year_id FROM classes WHERE id = $1',
    [classId],
  );
  const klass = classRows[0];
  if (!klass) throw new ExportError('class_not_found');
  const { rows: students } = await executor.query(
    `SELECT s.id, s.first_name, s.last_name
       FROM enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.class_id = $1 AND e.school_year_id = $2
      ORDER BY s.last_name COLLATE "C", s.first_name COLLATE "C", s.id COLLATE "C"`,
    [klass.id, klass.school_year_id],
  );
  // Opiekun tylko przy aktywnej relacji; e-mail wyłącznie przy zgodzie na
  // kontakt w relacji i u opiekuna.
  const { rows: links } = await executor.query(
    `SELECT sg.student_id, g.id, g.first_name, g.last_name,
            CASE WHEN sg.contact_allowed AND g.contact_allowed THEN g.email END AS email,
            sg.is_primary_contact
       FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
      WHERE sg.student_id IN (SELECT student_id FROM enrollments WHERE class_id = $1 AND school_year_id = $2)
        AND (sg.starts_on IS NULL OR sg.starts_on <= CURRENT_DATE)
        AND (sg.ends_on IS NULL OR sg.ends_on >= CURRENT_DATE)
      ORDER BY sg.student_id COLLATE "C", g.last_name COLLATE "C", g.first_name COLLATE "C", g.id COLLATE "C"`,
    [klass.id, klass.school_year_id],
  );
  const guardianIds = new Set();
  const roster = {
    format: ROSTER_FORMAT,
    formatVersion: ROSTER_FORMAT_VERSION,
    class: { id: klass.id, name: klass.name, schoolYearId: klass.school_year_id },
    students: students.map((student) => ({
      id: student.id,
      firstName: student.first_name,
      lastName: student.last_name,
      guardians: links.filter((link) => link.student_id === student.id).map((link) => {
        guardianIds.add(link.id);
        return {
          id: link.id,
          firstName: link.first_name,
          lastName: link.last_name,
          email: link.email ?? null,
          primaryContact: Boolean(link.is_primary_contact),
        };
      }),
    })),
  };
  const sha256 = sha256Hex(canonicalJson(roster));
  return {
    roster,
    sha256,
    body: canonicalJson({ ...roster, sha256 }),
    schoolYearId: klass.school_year_id,
    rowCounts: { students: roster.students.length, guardians: guardianIds.size },
  };
}
