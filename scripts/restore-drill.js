// Próba odtworzenia najnowszej udanej kopii PostgreSQL do bazy DOCELOWEJ,
// osobnej od źródłowej (issue #90). Do uruchamiania jako usługa cron
// `rd-restore-drill` (najpierw na stagingu — w produkcji wymaga jawnej flagi).
//
//   DATABASE_URL=…                     baza źródłowa (tylko odczyt backup_runs)
//   RESTORE_DRILL_TARGET_DATABASE_URL=… baza DOCELOWA — MUSI się różnić (host+nazwa) od DATABASE_URL
//   BACKUP_DECRYPTION_PRIVATE_KEY=…    klucz prywatny RSA (PEM)
//   BACKUP_S3_*                        jak w backup-postgres.js
//   APP_ENV=production wymaga --allow-production
//
// Raport (liczności, sumy i skróty, bez danych osobowych) jest porównywany
// z raportem zapisanym przy tworzeniu kopii (backup_runs.row_counts/sums, ta
// sama migawka co zrzut); niezgodność = kod wyjścia 1. Wynik trafia do
// backup_runs (kind=restore_drill) w bazie ŹRÓDŁOWEJ; baza docelowa jest czyszczona przez
// operatora usługi (osobna, jednorazowa baza „drill” — poza zakresem skryptu).

import { appEnvWarning, guardDangerousOperation } from '../src/app-env.js';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { createPgDatabase } from '../src/db.js';
import { createS3Storage } from '../src/storage.js';
import { runRestoreDrill } from '../src/pg/backup.js';
import { buildRestoreReport } from '../src/pg/restore-report.js';
import { restoreInto } from './lib/pg-tools.js';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';

const REQUIRED_ENV = ['DATABASE_URL', 'RESTORE_DRILL_TARGET_DATABASE_URL', 'BACKUP_DECRYPTION_PRIVATE_KEY',
  'BACKUP_S3_ENDPOINT', 'BACKUP_S3_REGION', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'];

async function main() {
  const env = process.env;
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length) {
    console.error(`Restore drill refused: missing environment variables (${missing.length}).`);
    process.exitCode = 1;
    return;
  }
  if (guardDangerousOperation(env.APP_ENV, { allowProduction: process.argv.includes('--allow-production') }).refused) {
    const warning = appEnvWarning(env.APP_ENV);
    if (warning) console.error(warning);
    console.error('Restore drill in production (or with unrecognised APP_ENV) requires explicit --allow-production.');
    process.exitCode = 1;
    return;
  }

  const storage = createS3Storage({
    endpoint: env.BACKUP_S3_ENDPOINT, region: env.BACKUP_S3_REGION, bucket: env.BACKUP_S3_BUCKET,
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY,
    urlStyle: env.BACKUP_S3_URL_STYLE || 'virtual',
  });
  const db = createPgDatabase({ connectionString: env.DATABASE_URL, application_name: 'rd-restore-drill', max: 2 });
  const targetClient = new Client({ connectionString: env.RESTORE_DRILL_TARGET_DATABASE_URL });
  const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

  try {
    await targetClient.connect();
    const report = await runRestoreDrill({
      db,
      storage,
      decryptPrivateKeyPem: env.BACKUP_DECRYPTION_PRIVATE_KEY,
      sourceUrl: env.DATABASE_URL,
      targetUrl: env.RESTORE_DRILL_TARGET_DATABASE_URL,
      environment: env.APP_ENV || 'unknown',
      restore: (plaintext) => restoreInto(env.RESTORE_DRILL_TARGET_DATABASE_URL, plaintext),
      migrateTarget: async () => {
        const applied = await applyMigrations(targetClient, await loadMigrations(migrationsDirectory));
        // applyMigrations zwraca listę NAŁOŻONYCH plików; po pg_restore z
        // aktualnym zrzutem oczekujemy pustej listy ("No pending migrations.").
        return applied;
      },
      reportQuery: () => buildRestoreReport((sql, params) => targetClient.query(sql, params)),
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'restore_drill_failed';
    console.error(`Restore drill failed: ${code}`);
    // Tylko nazwy sekcji/kluczy — bez wartości (skróty i sumy zostają w dzienniku).
    if (Array.isArray(error?.differences)) for (const d of error.differences.slice(0, 50)) console.error(`  ${d.section}: ${d.key}`);
    process.exitCode = 1;
  } finally {
    await targetClient.end().catch(() => {});
    await db.close().catch(() => {});
  }
}

await main();
