// Raport zgodności bazy do próbnego odtworzenia (issue #90): liczności tabel,
// sumy kwot w centach i skróty SHA-256 zawartości tabel finansowych oraz
// dopisywanych (audyt). Wyłącznie liczby, nazwy tabel i skróty — żadnych
// wartości z wierszy, więc raport nie zawiera danych osobowych i może trafić
// do `backup_runs` oraz na stdout.
//
// Kontrakt `query(sql, params) -> { rows }` spełniają pg.Client, PGlite i db.
// Raport MUSI być liczony w jednej sesji (ustawiamy w niej strefę UTC, żeby
// tekstowa postać znaczników czasu była taka sama w bazie źródłowej i po
// odtworzeniu). Format: { rowCounts: { tabela: n }, sums: { klucz: liczba|skrót } }.

// Tabele i widoki, których zawartość porównujemy skrótem (kolejność wierszy
// nie ma znaczenia). Brakujące w schemacie są pomijane — lista nie wymusza
// migracji, a zmiana nazwy tabeli i tak zmieni raport (rowCounts).
export const CHECKSUM_RELATIONS = [
  'payment_entries', 'payment_corrections', 'payment_refunds', 'payment_assignments',
  'payment_allocations', 'payment_allocation_reversals', 'payment_reassignments',
  'ledger_categories', 'ledger_entries', 'ledger_corrections', 'ledger_transfers',
  'ledger_opening_balances', 'ledger_opening_balance_adjustments',
  'student_guardians', 'student_households', 'guardian_households',
  'audit_events', 'email_outbox', 'email_send_ledger',
  'household_payment_totals', 'ledger_year_summary',
];

// Kolumny kwot sumowane w tabelach finansowych (jeśli istnieją).
const AMOUNT_COLUMN = 'amount_cents';

const IDENTIFIER = /^[a-z0-9_]{1,80}$/;

function quoteIdent(name) {
  if (!IDENTIFIER.test(name)) throw Object.assign(new Error('restore_report_bad_identifier'), { code: 'restore_report_bad_identifier' });
  return `"${name}"`;
}

const number = (value) => Number(value);

export async function buildRestoreReport(query) {
  await query("SELECT set_config('TimeZone', 'UTC', false)");

  const tables = (await query(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  )).rows.map((row) => row.name);
  const views = (await query(
    "SELECT viewname AS name FROM pg_views WHERE schemaname = 'public' ORDER BY viewname",
  )).rows.map((row) => row.name);

  const rowCounts = {};
  for (const table of tables) {
    rowCounts[table] = number((await query(`SELECT count(*)::int AS n FROM ${quoteIdent(table)}`)).rows[0].n);
  }

  const sums = {};
  const present = new Set([...tables, ...views]);
  for (const relation of CHECKSUM_RELATIONS) {
    if (!present.has(relation)) continue;
    const { rows } = await query(
      `SELECT coalesce(encode(sha256(convert_to(string_agg(encode(sha256(convert_to(t::text, 'UTF8')), 'hex'), ''
                ORDER BY encode(sha256(convert_to(t::text, 'UTF8')), 'hex')), 'UTF8')), 'hex'), 'empty') AS digest
         FROM ${quoteIdent(relation)} t`,
    );
    sums[`sha256.${relation}`] = rows[0].digest;
  }

  const amountTables = new Set((await query(
    `SELECT table_name AS name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = $1`,
    [AMOUNT_COLUMN],
  )).rows.map((row) => row.name));
  for (const table of CHECKSUM_RELATIONS) {
    if (!tables.includes(table) || !amountTables.has(table)) continue;
    const { rows } = await query(`SELECT coalesce(sum(${AMOUNT_COLUMN}), 0)::bigint AS total FROM ${quoteIdent(table)}`);
    sums[`sum.${table}.${AMOUNT_COLUMN}`] = number(rows[0].total);
  }

  if (present.has('household_payment_totals')) {
    const { rows } = await query(
      'SELECT coalesce(sum(net_amount_cents), 0)::bigint AS net, coalesce(sum(payment_count), 0)::bigint AS n FROM household_payment_totals',
    );
    sums['sum.household_payment_totals.net_amount_cents'] = number(rows[0].net);
    sums['sum.household_payment_totals.payment_count'] = number(rows[0].n);
  }
  if (present.has('ledger_year_summary')) {
    const { rows } = await query(
      `SELECT coalesce(sum(income_cents), 0)::bigint AS income, coalesce(sum(expense_cents), 0)::bigint AS expense,
              coalesce(sum(closing_balance_cents), 0)::bigint AS closing FROM ledger_year_summary`,
    );
    sums['sum.ledger_year_summary.income_cents'] = number(rows[0].income);
    sums['sum.ledger_year_summary.expense_cents'] = number(rows[0].expense);
    sums['sum.ledger_year_summary.closing_balance_cents'] = number(rows[0].closing);
  }

  // Schemat: wyzwalacze (tabele tylko do dopisywania muszą przeżyć odtworzenie)
  // i lista nałożonych migracji.
  const triggers = (await query(
    `SELECT c.relname || '.' || t.tgname AS name FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public' ORDER BY 1`,
  )).rows.map((row) => row.name);
  sums['schema.triggers.count'] = triggers.length;
  sums['schema.triggers.sha256'] = (await query(
    "SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS digest", [triggers.join('\n')],
  )).rows[0].digest;

  if (tables.includes('schema_migrations')) {
    const { rows } = await query(
      `SELECT count(*)::int AS n,
              coalesce(encode(sha256(convert_to(string_agg(name || ':' || checksum, ',' ORDER BY name), 'UTF8')), 'hex'), 'empty') AS digest
         FROM schema_migrations`,
    );
    sums['schema.migrations.count'] = number(rows[0].n);
    sums['schema.migrations.sha256'] = rows[0].digest;
  }
  return { rowCounts, sums };
}

// Porównanie raportów; zwraca listę różnic { section, key, expected, actual }.
// Puste = zgodne. Wartości to liczby i skróty (bez danych osobowych).
export function compareRestoreReports(expected, actual) {
  const differences = [];
  for (const section of ['rowCounts', 'sums']) {
    const want = expected?.[section] ?? {};
    const got = actual?.[section] ?? {};
    for (const key of [...new Set([...Object.keys(want), ...Object.keys(got)])].sort()) {
      if (!(key in got)) differences.push({ section, key, expected: want[key], actual: null });
      else if (!(key in want)) differences.push({ section, key, expected: null, actual: got[key] });
      else if (want[key] !== got[key]) differences.push({ section, key, expected: want[key], actual: got[key] });
    }
  }
  return differences;
}
