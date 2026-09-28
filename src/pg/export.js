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
import { csvHeader, csvRow } from './csv.js';

export const EXPORT_FORMAT = 'rd-yearly-export';
// Wersja 2 (#202): gospodarstwa i ich historia (0014), uzgodnienia rachunku
// (0015/0024), zamknięcie roku (0017), przeniesienia kasa ↔ rachunek (0028),
// stan obecności zebrań (0021). Wersja 1 jest nadal przyjmowana do weryfikacji
// i odtworzenia z ostrzeżeniem „paczka niepełna” (docs/EXPORT.md).
export const EXPORT_FORMAT_VERSION = 2;
export const SUPPORTED_FORMAT_VERSIONS = Object.freeze([1, 2]);
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
  // Drugie gospodarstwo dziecka (opieka dzielona) i gospodarstwa opiekunów z historii członkostwa.
  if (has.has('student_households')) {
    parts.push(`id IN (SELECT household_id FROM student_households WHERE student_id IN (${YEAR_STUDENTS}))`);
  }
  if (has.has('guardian_households')) {
    parts.push(`id IN (SELECT household_id FROM guardian_households WHERE guardian_id IN (
      SELECT id FROM guardians WHERE ${guardianScope(has)}))`);
  }
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
    // #127: gospodarstwa z częściami podzielonych wpłat roku.
    if (has.has('payment_allocations')) {
      parts.push('id IN (SELECT household_id FROM payment_allocations WHERE school_year_id = $1)');
    }
  }
  return `(${parts.join(' OR ')})`;
}

// Przedział czasu roku szkolnego (Europe/Brussels), jak w zakresie audytu.
const YEAR_TIME = (column) => `${column} >= (SELECT (starts_on::timestamp AT TIME ZONE 'Europe/Brussels') FROM school_years WHERE id = $1)
      AND ${column} < (SELECT ((ends_on + 1)::timestamp AT TIME ZONE 'Europe/Brussels') FROM school_years WHERE id = $1)`;
const YEAR_RECONCILIATIONS = 'SELECT id FROM bank_reconciliations WHERE school_year_id = $1';

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
  // 0014: członkostwo w gospodarstwach wypełniają triggery — przy odtworzeniu
  // (triggery wyłączone) muszą przyjść z paczki, inaczej karta rodziny daje 404.
  { table: 'student_households', where: () => `student_id IN (${YEAR_STUDENTS})` },
  { table: 'guardian_households', requires: ['guardians'],
    where: (has) => `guardian_id IN (SELECT id FROM guardians WHERE ${guardianScope(has)})` },
  { table: 'enrollment_history', where: () => 'school_year_id = $1' },
  // Historia kontaktu: do decyzji D-03 tylko identyfikatory, flagi zgody i czas —
  // bez poprzedniego i nowego e-maila oraz bez treści powodu. Zmiany z tego roku.
  { table: 'guardian_contact_changes', requires: ['guardians'],
    columns: ['id', 'guardian_id', 'previous_contact_allowed', 'new_contact_allowed', 'source', 'changed_by', 'changed_at'],
    where: (has) => `guardian_id IN (SELECT id FROM guardians WHERE ${guardianScope(has)}) AND ${YEAR_TIME('changed_at')}` },
  // 0026: historia relacji opiekun–dziecko (zgoda, kontakt główny, daty) z tego roku,
  // jak wyżej bez treści powodu (D-03).
  { table: 'student_guardian_changes', requires: ['student_guardians'],
    columns: ['id', 'student_id', 'guardian_id', 'previous_contact_allowed', 'new_contact_allowed',
      'previous_is_primary_contact', 'new_is_primary_contact', 'previous_starts_on', 'new_starts_on',
      'previous_ends_on', 'new_ends_on', 'source', 'changed_by', 'changed_at'],
    where: () => `student_id IN (${YEAR_STUDENTS}) AND ${YEAR_TIME('changed_at')}` },

  { table: 'payment_entries', where: () => 'school_year_id = $1' },
  { table: 'payment_corrections', requires: ['payment_entries'],
    where: () => 'payment_entry_id IN (SELECT id FROM payment_entries WHERE school_year_id = $1)' },
  { table: 'payment_assignments', requires: ['payment_entries'],
    where: () => 'payment_entry_id IN (SELECT id FROM payment_entries WHERE school_year_id = $1)' },
  { table: 'payment_refunds', requires: ['payment_entries'],
    where: () => 'payment_entry_id IN (SELECT id FROM payment_entries WHERE school_year_id = $1)' },
  { table: 'payment_reassignments', requires: ['payment_entries'],
    where: () => 'payment_entry_id IN (SELECT id FROM payment_entries WHERE school_year_id = $1)' },
  // 0104 (#127): części podzielonych wpłat i ich cofnięcia (własna kolumna school_year_id).
  { table: 'payment_allocations', requires: ['payment_entries'], where: () => 'school_year_id = $1' },
  { table: 'payment_allocation_reversals', requires: ['payment_allocations'], where: () => 'school_year_id = $1' },

  { table: 'ledger_categories', where: () => 'school_year_id = $1' },
  { table: 'ledger_opening_balances', where: () => 'school_year_id = $1' },
  { table: 'ledger_opening_balance_adjustments', requires: ['ledger_opening_balances'],
    where: () => 'opening_balance_id IN (SELECT id FROM ledger_opening_balances WHERE school_year_id = $1)' },
  { table: 'ledger_entries', where: () => 'school_year_id = $1' },
  { table: 'ledger_corrections', requires: ['ledger_entries'],
    where: () => 'ledger_entry_id IN (SELECT id FROM ledger_entries WHERE school_year_id = $1)' },
  { table: 'ledger_budget_lines', where: () => 'school_year_id = $1' },
  { table: 'ledger_transfers', where: () => 'school_year_id = $1' },

  // 0015/0024: uzgodnienia rachunku roku z pozycjami wyciągu (tylko skróty tytułów) i powiązaniami.
  { table: 'bank_reconciliations', where: () => 'school_year_id = $1' },
  { table: 'bank_statement_imports', requires: ['bank_reconciliations'],
    where: () => `reconciliation_id IN (${YEAR_RECONCILIATIONS})` },
  { table: 'bank_statement_lines', requires: ['bank_reconciliations'],
    where: () => `reconciliation_id IN (${YEAR_RECONCILIATIONS})` },
  { table: 'bank_reconciliation_matches', requires: ['bank_reconciliations'],
    where: () => `reconciliation_id IN (${YEAR_RECONCILIATIONS})` },
  // 0105 (#127): dopasowania zbiorcze, ich pozycje i cofnięcia (własna kolumna school_year_id).
  { table: 'bank_reconciliation_group_matches', requires: ['bank_reconciliations'], where: () => 'school_year_id = $1' },
  { table: 'bank_reconciliation_group_match_items', requires: ['bank_reconciliation_group_matches'],
    where: () => 'school_year_id = $1' },
  { table: 'bank_reconciliation_group_match_revocations', requires: ['bank_reconciliation_group_matches'],
    where: () => 'school_year_id = $1' },

  { table: 'events', where: () => 'school_year_id = $1' },
  { table: 'event_revisions', requires: ['events'],
    where: () => 'event_id IN (SELECT id FROM events WHERE school_year_id = $1)' },

  { table: 'meetings', where: () => 'school_year_id = $1' },
  { table: 'meeting_agenda_items', requires: ['meetings'],
    where: () => 'meeting_id IN (SELECT id FROM meetings WHERE school_year_id = $1)' },
  { table: 'meeting_attendees', requires: ['meetings'],
    where: () => 'meeting_id IN (SELECT id FROM meetings WHERE school_year_id = $1)' },
  // 0021: licznik rewizji obecności (wypełnia trigger); bez niego kworum wygląda na nieaktualne.
  { table: 'meeting_attendance_state', requires: ['meetings'],
    where: () => 'meeting_id IN (SELECT id FROM meetings WHERE school_year_id = $1)' },
  { table: 'meeting_quorum_checks', requires: ['meetings'],
    where: () => 'meeting_id IN (SELECT id FROM meetings WHERE school_year_id = $1)' },
  { table: 'meeting_minutes', requires: ['meetings'],
    where: () => 'meeting_id IN (SELECT id FROM meetings WHERE school_year_id = $1)' },
  { table: 'meeting_minutes_publications', requires: ['meeting_minutes', 'meetings'],
    where: () => `minutes_id IN (SELECT mm.id FROM meeting_minutes mm JOIN meetings m ON m.id = mm.meeting_id
      WHERE m.school_year_id = $1)` },
  { table: 'resolutions', where: () => 'school_year_id = $1' },
  // #102: wykonanie uchwał — historia zdarzeń powiązana z uchwałą roku.
  { table: 'resolution_execution_events', requires: ['resolutions'],
    where: () => 'resolution_id IN (SELECT id FROM resolutions WHERE school_year_id = $1)' },

  // 0017: stan zamknięcia roku i lista kontrolna.
  { table: 'school_year_closures', where: () => 'school_year_id = $1' },
  { table: 'school_year_closure_checklist', requires: ['school_year_closures'],
    where: () => 'closure_id IN (SELECT id FROM school_year_closures WHERE school_year_id = $1)' },

  { table: 'audit_events', where: () => AUDIT_SCOPE },
]);

const KNOWN_TABLES = new Set(EXPORT_TABLES.map((spec) => spec.table));

// Tabele dodane w wersji 2 — w paczce wersji 1 ich brak (ostrzeżenie „paczka niepełna”).
export const TABLES_ADDED_IN_V2 = Object.freeze([
  'student_households', 'guardian_households', 'enrollment_history', 'guardian_contact_changes',
  'student_guardian_changes', 'ledger_transfers', 'bank_reconciliations', 'bank_statement_imports', 'bank_statement_lines',
  'bank_reconciliation_matches', 'meeting_attendance_state', 'school_year_closures', 'school_year_closure_checklist',
]);

// Tabele bazowe świadomie poza paczką roku, z uzasadnieniem. Test kompletności
// (tests/pg-export.test.js) wymaga, by każda tabela była w EXPORT_TABLES albo tu.
export const EXPORT_EXCLUDED_TABLES = Object.freeze({
  users: 'konta (e-mail, nazwa) — nie są danymi roku; identyfikatory w created_by zostają bez odpowiednika',
  sessions: 'sesje logowania — dane techniczne i sekrety',
  invitations: 'zaproszenia do kont — sekrety i adresy e-mail',
  user_mfa_factors: 'sekrety MFA — nigdy w paczce',
  mfa_recovery_codes: 'kody odzyskiwania MFA — nigdy w paczce',
  mfa_rate_limits: 'limity prób MFA — dane techniczne',
  user_passwords: 'skróty haseł kont — sekrety, nigdy w paczce',
  login_rate_limits: 'limity prób logowania — dane techniczne',
  password_reset_tokens: 'tokeny resetu hasła — sekrety, nigdy w paczce',
  role_grants: 'przydziały ról — konta, nie dane roku (D-08)',
  documents: 'metadane plików; pliki w prywatnym Storage kopiuje się osobno (RAILWAY_OPERATIONS.md)',
  document_uploads: 'zamiary uploadu dokumentów (klucz obiektu, skrót) — dane techniczne jak documents (0032)',
  data_access_log: 'dziennik odczytu danych rodzin — rozliczalność dostępu, nie dane Rady do odtworzenia; retencja do decyzji D-04 (0067)',
  backup_runs: 'dziennik przebiegów kopii zapasowej i próby odtworzenia — dane operacyjne środowiska, nie danych Rady (0058)',
  import_batches: 'metadane importów — zakres i retencja do decyzji D-04',
  export_runs: 'dziennik eksportów — każdy eksport zmieniałby następny',
  meeting_request_keys: 'klucze idempotencji żądań — dane techniczne',
  email_campaigns: 'kampanie e-mail — zakres i retencja do decyzji D-04 (adresy odbiorców)',
  email_campaign_recipients: 'odbiorcy kampanii zawierają adresy e-mail — D-04',
  email_campaign_exclusions: 'wykluczenia z kampanii — D-04',
  email_outbox: 'kolejka wysyłki z adresami e-mail — D-04',
  email_send_ledger: 'dziennik wysyłek dostawcy — D-04',
  email_suppressions: 'lista blokad adresów e-mail — D-04',
  email_webhook_events: 'zdarzenia dostawcy e-mail — D-04',
  email_worker_runs: 'przebiegi zadania wysyłki — dane techniczne',
  email_preview_sends: 'dziennik wysyłek testowych kampanii na adresy techniczne Rady — dane operacyjne, nie danych roku (#104, D-04)',
  news_posts: 'aktualności są publiczne i nie należą do roku; archiwum osobno (zgody, D-04)',
  news_post_revisions: 'jak news_posts',
  news_photos: 'zdjęcia wymagają zgód na publikację wizerunku — osobny zakres',
  news_photo_consents: 'zgody na wizerunek — osobny zakres (D-04)',
});

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
    `SELECT column_name, data_type, is_identity, identity_generation, is_generated
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
    // Kolumna GENERATED ALWAYS AS (…) STORED (np. bank_reconciliations.difference_cents):
    // jest w paczce do odczytu, ale przy odtworzeniu baza wylicza ją sama.
    generated: row.is_generated === 'ALWAYS',
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
    // #216: oddaje pętlę zdarzeń między tabelami, żeby długi eksport (np.
    // audit_events roku z ~200 tys. wierszy) nie blokował innych żądań
    // (także /health/ready) przez cały czas budowania paczki. Nie dzieli
    // jeszcze przetwarzania JEDNEJ dużej tabeli na partie — pełne
    // strumieniowanie (format v2, kursor, licząca się przyrostowo suma
    // kontrolna) zostaje do osobnego PR, patrz opis PR i issue #216 pkt 1.
    await new Promise((resolve) => { setImmediate(resolve); });
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
  if (!SUPPORTED_FORMAT_VERSIONS.includes(bundle.formatVersion)) fail('unsupported_format_version');
  const { manifest } = bundle;
  if (!isPlainObject(manifest) || !isPlainObject(bundle.files)) fail('invalid_bundle');
  if (typeof bundle.manifestSha256 !== 'string' || !SHA256_PATTERN.test(bundle.manifestSha256)) fail('invalid_manifest_sha256');
  if (sha256Hex(canonicalJson(manifest)) !== bundle.manifestSha256) fail('manifest_hash_mismatch');
  if (manifest.format !== EXPORT_FORMAT || manifest.formatVersion !== bundle.formatVersion) fail('manifest_format_mismatch');
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
    if (bundle.formatVersion < 2 && TABLES_ADDED_IN_V2.includes(entry.table)) fail(`table_not_in_format_version:${entry.path}`);
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

  // Paczka wersji 1 nie ma tabel z 0014/0015/0017/0021/0028 — jest niepełna.
  const warnings = bundle.formatVersion < 2 ? ['bundle_incomplete'] : [];
  return {
    schoolYearId: manifest.schoolYearId,
    formatVersion: manifest.formatVersion,
    manifestSha256: bundle.manifestSha256,
    warnings,
    ...(warnings.length ? { missingTables: [...TABLES_ADDED_IN_V2] } : {}),
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

// Pełna liczność i sumy *_cents tabeli w bazie docelowej. Baza była pusta, więc
// muszą być równe liczbom z manifestu paczki (niezależnie od zakresu eksportu).
async function tableTotals(tx, table, columns) {
  const cents = columns.filter((name) => name.endsWith('_cents'));
  const { rows } = await tx.query(
    `SELECT count(*)::text AS n${cents.map((name, index) => `, COALESCE(sum(${quoteIdent(name)}), 0)::text AS s${index}`).join('')}
       FROM ${quoteIdent(table)}`,
  );
  const sums = {};
  cents.forEach((name, index) => { sums[name] = toSafeNumber(rows[0][`s${index}`]); });
  return { rows: toSafeNumber(rows[0].n), sums };
}

// Paczka wersji 1 nie ma członkostwa w gospodarstwach. Odtwarzamy je z kolumn
// zgodności tak jak backfill migracji 0014 (source 'legacy_backfill'), żeby
// karta rodziny i lista klasy działały. Zwraca liczby dopisanych wierszy.
async function backfillHouseholdsFromV1(tx, existing) {
  const result = { studentHouseholds: 0, guardianHouseholds: 0 };
  if (existing.has('student_households')) {
    const { rows } = await tx.query(`INSERT INTO student_households (id, student_id, household_id, is_primary, source)
      SELECT 'sh-legacy-' || s.id, s.id, s.household_id, true, 'legacy_backfill' FROM students s
      RETURNING id`);
    result.studentHouseholds = rows.length;
  }
  if (existing.has('guardian_households')) {
    const { rows } = await tx.query(`INSERT INTO guardian_households (id, guardian_id, household_id, source)
      SELECT 'gh-legacy-' || g.id, g.id, g.household_id, 'legacy_backfill' FROM guardians g
      RETURNING id`);
    result.guardianHouseholds = rows.length;
  }
  return result;
}

// Kontrola danych, które w działającej bazie tworzą triggery: po odtworzeniu
// z wyłączonymi triggerami muszą przyjść z paczki (albo z backfillu v1).
async function derivedRowsCheck(tx, existing) {
  const checks = [
    ['student_households', `SELECT count(*)::int AS n FROM students s
      WHERE NOT EXISTS (SELECT 1 FROM student_households sh WHERE sh.student_id = s.id)`],
    ['guardian_households', `SELECT count(*)::int AS n FROM guardians g
      WHERE NOT EXISTS (SELECT 1 FROM guardian_households gh WHERE gh.guardian_id = g.id)`],
  ];
  for (const [table, sql] of checks) {
    if (!existing.has(table)) continue;
    const { rows } = await tx.query(sql);
    if (rows[0].n > 0) fail(`restore_verification_failed:derived:${table}`);
  }
}

/**
 * Odtwarza zweryfikowaną paczkę do PUSTEJ bazy z aktualnym schematem
 * (po npm run db:migrate:postgres). Jedna transakcja; pierwszy błąd wycofuje
 * całość. Triggery i klucze obce są wyłączone na czas transakcji
 * (session_replication_role = replica, wymaga roli z uprawnieniem
 * superużytkownika), bo paczka odtwarza stan końcowy, a nie przebieg operacji.
 *
 * Wyłączenie triggerów nie może gubić danych (#202): wszystko, co w działającej
 * bazie wypełniają triggery (członkostwo w gospodarstwach, historia klas,
 * licznik obecności zebrań), jest w paczce wersji 2. Przed zatwierdzeniem
 * transakcja sprawdza: (1) liczność i sumy *_cents każdej tabeli w bazie
 * docelowej = manifest, (2) tabele spoza paczki pozostały puste, (3) dane
 * pochodne triggerów istnieją. Paczka wersji 1 jest przyjmowana z ostrzeżeniem;
 * członkostwo w gospodarstwach jest wtedy odtwarzane jak backfill 0014.
 * Po zatwierdzeniu wykonuje ponowny eksport i porównuje pliki oraz sumy.
 */
export async function restoreBundle(db, bundle) {
  const verified = verifyBundle(bundle);
  const { manifest } = bundle;
  const warnings = [...verified.warnings];
  let backfilled = null;

  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL session_replication_role = 'replica'");
    // Triggery z własnym warunkiem odtworzenia (0027/0028: daty w roku) — i tak wyłączone.
    await tx.query("SET LOCAL rd.restore = 'on'");
    const existing = await assertEmptyTarget(tx);
    for (const entry of manifest.files) {
      if (!existing.has(entry.table)) fail(`target_table_missing:${entry.table}`);
      const targetColumns = await tableColumns(tx, entry.table);
      const columns = entry.columns.map((name) => {
        const column = targetColumns.find((item) => item.name === name);
        if (!column) fail(`target_column_missing:${entry.table}.${name}`);
        return column;
      }).filter((column) => !column.generated);
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

    // (1) Liczności i sumy z paczki = stan bazy docelowej.
    for (const entry of manifest.files) {
      const actual = await tableTotals(tx, entry.table, entry.columns);
      if (actual.rows !== entry.rows) fail(`restore_verification_failed:rows:${entry.table}`);
      if (canonicalJson(actual.sums) !== canonicalJson(entry.sums ?? {})) fail(`restore_verification_failed:sums:${entry.table}`);
    }
    // (2) Nic poza paczką (np. wiersz dopisany przez trigger).
    const listed = new Set(manifest.files.map((entry) => entry.table));
    let v1Backfill = new Set();
    if (bundle.formatVersion < 2) {
      backfilled = await backfillHouseholdsFromV1(tx, existing);
      v1Backfill = new Set(['student_households', 'guardian_households']);
      warnings.push('households_backfilled_from_v1');
    }
    for (const table of [...existing].sort()) {
      if (listed.has(table) || v1Backfill.has(table) || !IDENTIFIER.test(table)) continue;
      const { rows } = await tx.query(`SELECT EXISTS (SELECT 1 FROM ${quoteIdent(table)}) AS present`);
      if (rows[0]?.present) fail(`restore_unexpected_rows:${table}`);
    }
    // (3) Dane pochodne triggerów.
    await derivedRowsCheck(tx, existing);
  });

  // Kontrola po odtworzeniu: ten sam eksport z odtworzonej bazy.
  const again = await buildYearlyExport(db, manifest.schoolYearId);
  const expected = manifest.files.map(({ path, rows, sha256, sums }) => ({ path, rows, sha256, sums }));
  const actual = again.manifest.files
    .filter((entry) => manifest.files.some((item) => item.path === entry.path))
    .map(({ path, rows, sha256, sums }) => ({ path, rows, sha256, sums }));
  const filesMatch = canonicalJson(expected) === canonicalJson(actual);
  // Sumy porównujemy dla kluczy obecnych w paczce (paczka v1 może mieć ich mniej).
  const manifestTotals = manifest.totals ?? {};
  const againTotals = Object.fromEntries(Object.keys(manifestTotals).map((name) => [name, again.manifest.totals[name]]));
  const totalsMatch = canonicalJson(manifestTotals) === canonicalJson(againTotals);
  if (!filesMatch) fail('restore_verification_failed:files');
  if (!totalsMatch) fail('restore_verification_failed:totals');
  return {
    ...verified, warnings, ...(backfilled ? { backfilled } : {}),
    restored: true, reexportFilesMatch: filesMatch, reexportTotalsMatch: totalsMatch, countsMatch: true,
  };
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
       FROM enrollments_current e JOIN students s ON s.id = e.student_id
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
       FROM student_guardians_current sg JOIN guardians g ON g.id = sg.guardian_id
      WHERE sg.student_id IN (SELECT student_id FROM enrollments_current WHERE class_id = $1 AND school_year_id = $2)
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

// ---------------------------------------------------------------------------
// Lista klasy jako CSV do wydruku (#132). Dane te same co JSON (deterministyczny
// `roster` z buildClassRoster) — tylko sortowanie i format są inne. JSON zostaje
// przy COLLATE "C" dla determinizmu bajt w bajt; CSV jest czytany przez ludzi,
// więc sortujemy przez Intl.Collator('pl') (Ćwik/Łukasik/Śliwa/Żak w kolejności
// alfabetu polskiego, nie po bajtach). Bez wpłat, kwot i identyfikatorów rodzin.
const ROSTER_CSV_COLUMNS = [
  { header: 'Lp.', type: 'text' },
  { header: 'Nazwisko ucznia', type: 'text' },
  { header: 'Imię ucznia', type: 'text' },
  { header: 'Opiekun 1', type: 'text' },
  { header: 'E-mail opiekuna 1 (tylko przy zgodzie na kontakt)', type: 'text' },
  { header: 'Opiekun 2', type: 'text' },
  { header: 'E-mail opiekuna 2 (tylko przy zgodzie na kontakt)', type: 'text' },
  { header: 'Kontakt główny', type: 'text' },
  { header: 'Uwagi', type: 'text' },
];

export function buildClassRosterCsv(roster, { generatedAt = new Date() } = {}) {
  const collator = new Intl.Collator('pl', { sensitivity: 'base' });
  const students = [...roster.students].sort((a, b) =>
    collator.compare(a.lastName, b.lastName) || collator.compare(a.firstName, b.firstName) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = [];
  const isoDate = generatedAt.toISOString().slice(0, 10);
  const oneCell = (text) => csvRow([{ header: '', type: 'text' }], [text]);
  lines.push(oneCell(`Lista klasy ${roster.class.name} — rok szkolny ${roster.class.schoolYearId} — wygenerowano ${isoDate}`));
  lines.push('');
  lines.push(csvHeader(ROSTER_CSV_COLUMNS));
  students.forEach((student, index) => {
    const [g1, g2] = student.guardians;
    const primary = student.guardians.find((g) => g.primaryContact);
    lines.push(csvRow(ROSTER_CSV_COLUMNS, [
      String(index + 1),
      student.lastName,
      student.firstName,
      g1 ? `${g1.firstName} ${g1.lastName}` : '',
      g1?.email ?? '',
      g2 ? `${g2.firstName} ${g2.lastName}` : '',
      g2?.email ?? '',
      primary ? `${primary.firstName} ${primary.lastName}` : '',
      '',
    ]));
  });
  lines.push('');
  lines.push(oneCell('Zawiera dane osobowe — nie przesyłać dalej, usunąć po wykorzystaniu.'));
  return `${lines.join('\r\n')}\r\n`;
}
