import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_ID = 732481612;
const MANIFEST_NAME = 'MANIFEST.json';

export async function loadMigrations(directory) {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(join(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

// Manifest kolejności i sum kontrolnych (issue #79, postgres/README.md).
// Brak pliku = repozytorium jeszcze bez manifestu; wołający dostaje null
// i migrator działa jak dotąd (kolejność alfabetyczna nazw plików).
export async function loadManifest(directory) {
  try {
    const raw = await readFile(join(directory, MANIFEST_NAME), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// Numer z prefiksu nazwy pliku (np. '0018' z '0018_news.sql'), do kontroli
// kolejności nałożenia — NIE do porządku samego zastosowania (patrz #79:
// numeracja plików ≠ kolejność scalania do main).
function numericPrefix(name) {
  const match = /^(\d{4})_/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * @param {object} client kontrakt src/db.js (query, w testach też fakeClient)
 * @param {Array<{name:string, sql:string, checksum:string}>} migrations z loadMigrations()
 * @param {object} [options]
 * @param {boolean} [options.allowOutOfOrder=false] pomija kontrolę kolejności (#79) —
 *   świadoma decyzja operatora, opisać w protokole/PR dlaczego była potrzebna.
 */
export async function applyMigrations(client, migrations, { allowOutOfOrder = false } = {}) {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_seq INTEGER NOT NULL DEFAULT 0
    )`);
    // Kompatybilnie dla baz sprzed tej zmiany (issue #79): kolumna dodana
    // z DEFAULT 0, potem wypełniona raz wg dotychczasowej kolejności
    // (applied_at) — no-op przy kolejnych uruchomieniach (WHERE applied_seq = 0).
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS applied_seq INTEGER NOT NULL DEFAULT 0');
    await client.query(`UPDATE schema_migrations AS m SET applied_seq = ranked.rn
      FROM (SELECT name, row_number() OVER (ORDER BY applied_at) AS rn FROM schema_migrations) AS ranked
      WHERE m.name = ranked.name AND m.applied_seq = 0`);
    const { rows } = await client.query('SELECT name, checksum, applied_seq FROM schema_migrations');
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));
    const known = new Set(migrations.map((migration) => migration.name));
    for (const name of applied.keys()) {
      if (!known.has(name)) throw new Error(`Applied migration is missing from source: ${name}`);
    }
    let maxAppliedNumber = 0;
    let maxSeq = 0;
    for (const row of rows) {
      const number = numericPrefix(row.name);
      if (number !== null) maxAppliedNumber = Math.max(maxAppliedNumber, number);
      maxSeq = Math.max(maxSeq, Number(row.applied_seq) || 0);
    }
    const completed = [];
    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        if (applied.get(migration.name) !== migration.checksum) {
          throw new Error(`Migration checksum changed: ${migration.name}`);
        }
        continue;
      }
      const number = numericPrefix(migration.name);
      // Out-of-order (#79): plik z numerem ≤ już nałożonemu na TĘJ bazie —
      // typowy skutek scalenia gałęzi w innej kolejności niż numeracja.
      if (!allowOutOfOrder && number !== null && number <= maxAppliedNumber) {
        throw new Error(
          `Out-of-order migration: ${migration.name} (number ${number} <= ${maxAppliedNumber} already applied on this database; `
          + 'pass { allowOutOfOrder: true } only after a deliberate review)',
        );
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        maxSeq += 1;
        await client.query(
          'INSERT INTO schema_migrations (name, checksum, applied_seq) VALUES ($1, $2, $3)',
          [migration.name, migration.checksum, maxSeq],
        );
        await client.query('COMMIT');
        completed.push(migration.name);
        if (number !== null) maxAppliedNumber = Math.max(maxAppliedNumber, number);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return completed;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
  }
}
