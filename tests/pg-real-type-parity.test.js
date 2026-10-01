// #208 pkt 5: zgodność typów JS zwracanych przez adapter bazy na PGlite i na
// prawdziwym PostgreSQL (sterownik `pg`, `createPgDatabase` z src/db.js).
// Cel: wykryć kod, który działa na PGlite, a na `pg` dostaje tekst zamiast liczby
// (lub odwrotnie). src/db.js nie ustawia `setTypeParser` ani nie normalizuje
// wierszy (wrapClient zwraca `result.rows` bez zmian), więc typy to surowe typy
// sterownika. Test DOKUMENTUJE stan: osobno dla każdego backendu zapisuje
// oczekiwaną mapę typów, a test porównawczy wymaga dokładnie znanej listy
// rozbieżności. Gdy ktoś doda parser typów (lub zmieni PGlite), lista przestaje
// się zgadzać i test każe zaktualizować dokument — to nie jest naprawa kodu.
// Plik czyta RD_TEST_PG_URL (npm run test:pg-real); bez niej część na prawdziwym
// PostgreSQL jest pomijana. Wyłącznie dane syntetyczne, żadnej sieci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toSafeInteger } from '../src/pg/routes/payments.js';
import { createTestDb, createRealTestDb } from './helpers/pg.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';

// Strefa inna niż UTC, żeby rozbieżność `date` (północ lokalna vs UTC) była widoczna.
process.env.TZ = 'Europe/Brussels';

const PROBE_TABLE = `CREATE TABLE type_parity_probe (
  id uuid PRIMARY KEY,
  amount_cents bigint NOT NULL,
  small_cents integer NOT NULL,
  rate numeric(12,2) NOT NULL,
  paid_on date NOT NULL,
  created_at timestamptz NOT NULL,
  is_active boolean NOT NULL,
  meta jsonb NOT NULL,
  tags text[] NOT NULL,
  big_list bigint[] NOT NULL,
  note text,
  maybe_cents bigint
)`;

const INSERT = `INSERT INTO type_parity_probe
  (id, amount_cents, small_cents, rate, paid_on, created_at, is_active, meta, tags, big_list, note, maybe_cents)
  VALUES
  ('3f2b8c1e-0000-4000-8000-000000000001', 5000000000, 2500, 12.50, '2026-09-01', '2026-09-01T10:00:00.123456Z', true,
   '{"a":1,"b":[1,2]}', ARRAY['x','y'], ARRAY[1,2], 'abc', NULL),
  ('3f2b8c1e-0000-4000-8000-000000000002', 700, 700, 0.10, '2026-09-02', '2026-09-02T08:30:00Z', false,
   '{}', ARRAY[]::text[], ARRAY[]::bigint[], NULL, 5)`;

// Zapytania używane w aplikacji: agregaty (COUNT, SUM, bigint), kolumny surowe, rzutowania.
const QUERIES = {
  columns: `SELECT id, amount_cents, small_cents, rate, paid_on, created_at, is_active, meta, tags, big_list, note, maybe_cents
            FROM type_parity_probe WHERE small_cents = 2500`,
  nulls: `SELECT note, maybe_cents FROM type_parity_probe WHERE small_cents = 700`,
  aggregates: `SELECT count(*) AS cnt, count(note) AS cnt_note, sum(amount_cents) AS sum_bigint, sum(small_cents) AS sum_int,
                      sum(rate) AS sum_numeric, avg(small_cents) AS avg_int, max(amount_cents) AS max_bigint,
                      coalesce(sum(maybe_cents), 0) AS sum_coalesce
               FROM type_parity_probe`,
  casts: `SELECT count(*)::int AS cnt_int, sum(amount_cents)::int8 AS sum_int8, sum(small_cents)::bigint AS sum_big,
                 to_char(max(paid_on), 'YYYY-MM-DD') AS paid_text, (sum(rate) * 100)::bigint AS rate_cents
          FROM type_parity_probe`,
};

function kind(value) {
  if (value === null) return 'null';
  if (value instanceof Date) return 'Date';
  if (Array.isArray(value)) return `array<${value.length ? kind(value[0]) : 'empty'}>`;
  return typeof value;
}

async function describeAll(db) {
  await db.exec(PROBE_TABLE);
  await db.exec(INSERT);
  const out = {};
  for (const [name, sql] of Object.entries(QUERIES)) {
    const { rows } = await db.query(sql);
    assert.equal(rows.length, 1, `zapytanie ${name} zwraca jeden wiersz`);
    for (const [column, value] of Object.entries(rows[0])) out[`${name}.${column}`] = kind(value);
  }
  return out;
}

// `tags` w drugim wierszu nie jest tu opisywany (pusta tablica) — `columns` czyta wiersz z tablicą niepustą.
// Oczekiwane typy na PGlite (0.5.x): int8, COUNT i SUM(integer) jako number; SUM(bigint) i SUM(numeric)
// to numeric, więc string na obu backendach (nie rozbieżność).
const EXPECTED_PGLITE = {
  'columns.id': 'string', 'columns.amount_cents': 'number', 'columns.small_cents': 'number', 'columns.rate': 'string',
  'columns.paid_on': 'Date', 'columns.created_at': 'Date', 'columns.is_active': 'boolean', 'columns.meta': 'object',
  'columns.tags': 'array<string>', 'columns.big_list': 'array<number>', 'columns.note': 'string', 'columns.maybe_cents': 'null',
  'nulls.note': 'null', 'nulls.maybe_cents': 'number',
  'aggregates.cnt': 'number', 'aggregates.cnt_note': 'number', 'aggregates.sum_bigint': 'string', 'aggregates.sum_int': 'number',
  'aggregates.sum_numeric': 'string', 'aggregates.avg_int': 'string', 'aggregates.max_bigint': 'number', 'aggregates.sum_coalesce': 'string',
  'casts.cnt_int': 'number', 'casts.sum_int8': 'number', 'casts.sum_big': 'number', 'casts.paid_text': 'string', 'casts.rate_cents': 'number',
};

// Oczekiwane typy na `pg` (node-postgres 8.x) bez parserów: int8 (bigint, COUNT, SUM(integer), MAX(bigint)) jako string.
const EXPECTED_PG = {
  ...EXPECTED_PGLITE,
  'columns.amount_cents': 'string', 'columns.big_list': 'array<string>', 'nulls.maybe_cents': 'string',
  'aggregates.cnt': 'string', 'aggregates.cnt_note': 'string', 'aggregates.sum_int': 'string', 'aggregates.max_bigint': 'string',
  'casts.sum_int8': 'string', 'casts.sum_big': 'string', 'casts.rate_cents': 'string',
};

// Klucze, na których PGlite i `pg` dają różne typy JS (stan na dziś, patrz EXPECTED_*).
const KNOWN_DIVERGENCES = Object.keys(EXPECTED_PGLITE).filter((key) => EXPECTED_PGLITE[key] !== EXPECTED_PG[key]).sort();

async function withDb(make, fn) {
  const db = await make();
  try { return await fn(db); } finally { await db.close(); }
}

test('#208/5: typy JS na PGlite — int8, COUNT i SUM(integer) jako number, numeric/uuid jako string, date/timestamptz jako Date', async () => {
  const actual = await withDb(createTestDb, describeAll);
  assert.deepEqual(actual, EXPECTED_PGLITE);
  assert.ok(Object.keys(actual).length > 20, 'opisano wszystkie kolumny zapytań');
});

test('#208/5: typy JS na pg (createPgDatabase) — int8, COUNT i SUM(integer) jako string, reszta jak na PGlite', { skip }, async () => {
  const actual = await withDb(createRealTestDb, describeAll);
  assert.deepEqual(actual, EXPECTED_PG);
});

test('#208/5: rozbieżności PGlite vs pg to dokładnie znana lista — nowa rozbieżność albo parser typów wymaga aktualizacji dokumentu', { skip }, async () => {
  const pglite = await withDb(createTestDb, describeAll);
  const real = await withDb(createRealTestDb, describeAll);
  assert.deepEqual(Object.keys(pglite).sort(), Object.keys(real).sort());
  const diverging = Object.keys(pglite).filter((key) => pglite[key] !== real[key]).sort();
  assert.ok(diverging.length > 0, 'dziś istnieją rozbieżności (brak setTypeParser w src/db.js)');
  assert.deepEqual(diverging, KNOWN_DIVERGENCES);
  // Każda znana rozbieżność dotyczy wyłącznie liczby całkowitej 64-bitowej: number na PGlite, tekst na pg.
  for (const key of diverging) {
    assert.match(`${pglite[key]}>${real[key]}`, /^(?:array<)?number>?>(?:array<)?string>?$/, key);
  }
});

test('#208/5: wartości po konwencji aplikacji (::int, toSafeInteger, to_char) są identyczne w JSON na obu backendach', { skip }, async () => {
  async function normalized(db) {
    await db.exec(PROBE_TABLE);
    await db.exec(INSERT);
    const { rows: [agg] } = await db.query(QUERIES.aggregates);
    const { rows: [col] } = await db.query(QUERIES.columns);
    const { rows: [cast] } = await db.query(QUERIES.casts);
    return JSON.stringify({
      cnt: toSafeInteger(agg.cnt), cntNote: toSafeInteger(agg.cnt_note), sumBigint: toSafeInteger(agg.sum_bigint),
      sumInt: toSafeInteger(agg.sum_int), maxBigint: toSafeInteger(agg.max_bigint), sumCoalesce: toSafeInteger(agg.sum_coalesce),
      amount: toSafeInteger(col.amount_cents), bigList: col.big_list.map(toSafeInteger), rate: col.rate, sumNumeric: agg.sum_numeric,
      meta: col.meta, tags: col.tags, id: col.id, active: col.is_active,
      castCount: cast.cnt_int, castSum: toSafeInteger(cast.sum_int8), paidText: cast.paid_text, rateCents: toSafeInteger(cast.rate_cents),
      createdAt: col.created_at.toISOString(),
    });
  }
  const pglite = await withDb(createTestDb, normalized);
  const real = await withDb(createRealTestDb, normalized);
  assert.ok(pglite.length > 100);
  assert.equal(real, pglite);
});

test('#208/5: kolumna `date` — PGlite zwraca północ UTC, pg północ lokalną; to_char daje ten sam tekst', { skip }, async () => {
  async function paidOn(db) {
    await db.exec(PROBE_TABLE);
    await db.exec(INSERT);
    const { rows: [row] } = await db.query(
      "SELECT paid_on, to_char(paid_on, 'YYYY-MM-DD') AS paid_text FROM type_parity_probe WHERE small_cents = 2500",
    );
    return { iso: row.paid_on.toISOString(), text: row.paid_text };
  }
  const pglite = await withDb(createTestDb, paidOn);
  const real = await withDb(createRealTestDb, paidOn);
  assert.equal(pglite.text, '2026-09-01');
  assert.equal(real.text, pglite.text);
  // Europe/Brussels (UTC+2 we wrześniu): pg → 2026-08-31T22:00Z, PGlite → 2026-09-01T00:00Z.
  assert.equal(pglite.iso, '2026-09-01T00:00:00.000Z');
  assert.equal(real.iso, '2026-08-31T22:00:00.000Z');
});
