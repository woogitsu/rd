// Narzędzia do testów równoważności: stary Worker (D1) i nowy router PostgreSQL.
// Wyłącznie dane syntetyczne; domeny .invalid / .example.
//
//   const legacy = createLegacyDb();                    // SQLite w pamięci + migrations/*.sql
//   const env = { DB: d1Adapter(legacy) };              // kontrakt D1 dla src/index.js
//   const snap = await snapshotResponse(await worker.fetch(req, env), createNormalizer());
//   assertSameScenario(legacySteps, pgSteps, { allowed: { 'label': { legacy, pg, reason } } });
//
// Stary Worker używa D1 (SQLite). W testach D1 zastępuje wbudowany node:sqlite
// z tym samym dialektem SQL co D1; adapter udostępnia prepare/bind/first/all/run/batch.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const LEGACY_MIGRATIONS = new URL('../../migrations/', import.meta.url);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export function legacyMigrationNames() {
  return readdirSync(LEGACY_MIGRATIONS)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => name.replace(/\.sql$/, ''));
}

// Baza SQLite z migracjami D1 (domyślnie wszystkimi) i włączonymi kluczami obcymi.
export function createLegacyDb(names = legacyMigrationNames()) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of names) db.exec(readFileSync(new URL(`${name}.sql`, LEGACY_MIGRATIONS), 'utf8'));
  return db;
}

// Minimalny adapter D1 nad node:sqlite: prepare().bind().first()/all()/run() oraz batch() w transakcji.
export function d1Adapter(db) {
  function bound(sql, values) {
    const run = () => {
      const result = db.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    };
    return {
      first: async () => { const row = db.prepare(sql).get(...values); return row ? { ...row } : null; },
      all: async () => ({ results: db.prepare(sql).all(...values).map((row) => ({ ...row })) }),
      run: async () => run(),
      _run: run,
    };
  }
  return {
    prepare: (sql) => ({ bind: (...values) => bound(sql, values) }),
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement._run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function decodeBase64UrlJson(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  return JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)));
}

/**
 * Normalizator odpowiedzi do porównania:
 * - losowe UUID -> <id1>, <id2>… w kolejności pojawienia się (osobno dla każdego backendu),
 * - klucze z `cursorKeys` (base64url JSON) są dekodowane i normalizowane rekurencyjnie,
 * - klucze z `timestampKeys` są sprowadzane do ISO 8601 (to samo miejsce w czasie,
 *   różny zapis tekstowy SQLite/PostgreSQL jest różnicą formatu, nie treści).
 */
export function createNormalizer({ cursorKeys = ['nextCursor'], timestampKeys = [] } = {}) {
  const ids = new Map();
  const cursors = new Set(cursorKeys);
  const timestamps = new Set(timestampKeys);
  const label = (id) => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
    return ids.get(id);
  };
  const visit = (value, key) => {
    if (typeof value === 'string') {
      if (cursors.has(key)) return visit(decodeBase64UrlJson(value));
      if (timestamps.has(key)) {
        const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
        return Number.isNaN(date.getTime()) ? value : date.toISOString();
      }
      return value.replace(UUID, label);
    }
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k)]));
    }
    return value;
  };
  return visit;
}

// Status, wszystkie nagłówki (posortowane, małe litery) i ciało po normalizacji.
export async function snapshotResponse(response, normalize = (value) => value) {
  const text = await response.text();
  const type = response.headers.get('Content-Type') ?? '';
  let body = text === '' ? null : text;
  if (text && type.startsWith('application/json')) body = normalize(JSON.parse(text));
  const headers = [...response.headers].map(([name, value]) => [name.toLowerCase(), value])
    .sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b)));
  return { status: response.status, headers, body };
}

/**
 * Porównuje kroki dwóch backendów. Każdy krok: { label, status, headers, body }.
 * `allowed` to mapa label -> { legacy: {status, error?}, pg: {status, error?}, reason }
 * dla uzasadnionych różnic. Krok z `allowed` musi faktycznie się różnić dokładnie tak,
 * jak opisano; każda inna różnica kończy test błędem.
 */
export function assertSameScenario(legacySteps, pgSteps, { allowed = {} } = {}) {
  assert.deepEqual(pgSteps.map((s) => s.label), legacySteps.map((s) => s.label), 'same scenario steps');
  const seen = new Set();
  for (let index = 0; index < legacySteps.length; index += 1) {
    const expected = legacySteps[index];
    const actual = pgSteps[index];
    const difference = allowed[expected.label];
    if (!difference) {
      assert.deepEqual(actual, expected, `step: ${expected.label}`);
      continue;
    }
    seen.add(expected.label);
    for (const [side, step] of [['legacy', expected], ['pg', actual]]) {
      assert.equal(step.status, difference[side].status, `${side} status: ${expected.label}`);
      if ('error' in difference[side]) assert.equal(step.body?.error, difference[side].error, `${side} error: ${expected.label}`);
    }
    assert.notDeepEqual(actual, expected, `documented difference no longer differs: ${expected.label}`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(allowed).sort(), 'every documented difference is exercised');
}
