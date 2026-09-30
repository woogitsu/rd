// Weryfikacja paczki eksportu rocznego i test odtworzenia (issue #9, docs/EXPORT.md).
//
//   node scripts/verify-export.js <paczka.json>                    tylko manifest i sumy (bez bazy)
//   node scripts/verify-export.js <paczka.json> --restore-pglite   odtworzenie do pustego PGlite w pamięci
//   DATABASE_URL=… APP_ENV=staging node scripts/verify-export.js <paczka.json> --restore-database
//                                                                  odtworzenie do PUSTEJ bazy po migracjach
//
// Paczka jest czytana strumieniowo (#216): w pamięci jest fragment pliku i
// jedna linia JSONL, nie cała paczka; odtworzenie czyta plik drugi raz i wstawia
// wiersze partiami.
//
// Raport zawiera tylko liczności, sumy w centach i skróty — bez danych osobowych.
// Odtworzenie odmawia bazy niepustej oraz APP_ENV=production bez --allow-production.

import { fileURLToPath } from 'node:url';
import { assertRestoreAllowed, restoreBundleFile, verifyBundleFile } from '../src/pg/export.js';
import { loadMigrations } from '../src/postgres-migrations.js';

const args = process.argv.slice(2);
const bundlePath = args.find((arg) => !arg.startsWith('--'));
const restorePglite = args.includes('--restore-pglite');
const restoreDatabase = args.includes('--restore-database');

async function main() {
  if (!bundlePath || (restorePglite && restoreDatabase)) {
    throw new Error('Usage: node scripts/verify-export.js <bundle.json> [--restore-pglite | --restore-database [--allow-production]]');
  }
  if (restoreDatabase) {
    assertRestoreAllowed({ appEnv: process.env.APP_ENV, allowProduction: args.includes('--allow-production') });
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required with --restore-database');
  }

  // Błędy parsera to same kody (bez cytowania treści pliku).
  const report = await verifyBundleFile(bundlePath);
  if (report.warnings?.includes('bundle_incomplete')) {
    // Paczka wersji 1 (sprzed #202): brak gospodarstw, uzgodnień i zamknięcia roku.
    console.error(`Warning: bundle_incomplete (formatVersion ${report.formatVersion}); missing tables: ${report.missingTables.join(', ')}`);
  }
  if (!restorePglite && !restoreDatabase) {
    console.log(JSON.stringify({ verified: true, ...report }));
    return;
  }

  let db;
  if (restorePglite) {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
    const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
    for (const migration of await loadMigrations(directory)) await db.exec(migration.sql);
  } else {
    const { createPgDatabase } = await import('../src/db.js');
    db = createPgDatabase({ connectionString: process.env.DATABASE_URL });
  }
  try {
    const started = Date.now();
    const restored = await restoreBundleFile(db, bundlePath);
    console.log(JSON.stringify({ verified: true, ...restored, restoreMs: Date.now() - started }));
  } finally {
    await db.close().catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  // Kod błędu z modułu eksportu nie zawiera danych osobowych; komunikaty
  // sterownika bazy mogą je zawierać, więc z nich podajemy tylko kod.
  const message = error?.code && /^[a-z_]+(:[A-Za-z0-9_.:]+)?$/.test(error.code) ? error.code
    : error?.code ? `database_error:${error.code}` : error?.message;
  console.error(`Export verification failed: ${message}`);
  process.exitCode = 1;
}
