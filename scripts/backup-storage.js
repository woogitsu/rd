// Kopia prywatnego magazynu dokumentów do drugiego magazynu S3 (issue #103).
// Do uruchamiania jako usługa cron Railway (osobna albo wspólna z #90).
// Nigdy nie usuwa w celu; odmawia działania w produkcji bez jawnej flagi.
//
//   DATABASE_URL=…               tylko odczyt tabeli documents
//   BUCKET_*                     magazyn źródłowy (dokumenty, src/storage.js)
//   STORAGE_BACKUP_S3_*          magazyn docelowy (drugi dostawca/region)
//   APP_ENV=production wymaga --allow-production
//
// Raport (liczby, bez nazw plików i adresów) trafia na stdout i, jeśli
// tabela istnieje (patrz #90), do backup_runs.

import { createPgDatabase } from '../src/db.js';
import { createS3Storage, storageFromEnv } from '../src/storage.js';
import { recordStorageBackupRun, runStorageBackup } from '../src/pg/storage-backup.js';

const REQUIRED_TARGET_ENV = ['STORAGE_BACKUP_S3_ENDPOINT', 'STORAGE_BACKUP_S3_REGION', 'STORAGE_BACKUP_S3_BUCKET',
  'STORAGE_BACKUP_S3_ACCESS_KEY_ID', 'STORAGE_BACKUP_S3_SECRET_ACCESS_KEY'];

async function main() {
  const env = process.env;
  if (env.APP_ENV === 'production' && !process.argv.includes('--allow-production')) {
    console.error('Storage backup in production requires explicit --allow-production. Nothing was copied.');
    process.exitCode = 1;
    return;
  }
  if (!env.DATABASE_URL) {
    console.error('DATABASE_URL is required. Nothing was copied.');
    process.exitCode = 1;
    return;
  }
  const missingTarget = REQUIRED_TARGET_ENV.filter((name) => !env[name]);
  if (missingTarget.length) {
    console.error(`Storage backup refused: missing target environment variables (${missingTarget.length}). Nothing was copied.`);
    process.exitCode = 1;
    return;
  }

  let sourceStorage;
  try {
    sourceStorage = storageFromEnv(env);
  } catch (error) {
    console.error(`Source storage configuration error: ${error.code ?? 'invalid'}`);
    process.exitCode = 1;
    return;
  }
  if (!sourceStorage) {
    console.error('BUCKET_* variables are not set. Nothing was copied.');
    process.exitCode = 1;
    return;
  }

  const targetStorage = createS3Storage({
    endpoint: env.STORAGE_BACKUP_S3_ENDPOINT,
    region: env.STORAGE_BACKUP_S3_REGION,
    bucket: env.STORAGE_BACKUP_S3_BUCKET,
    accessKeyId: env.STORAGE_BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_BACKUP_S3_SECRET_ACCESS_KEY,
    urlStyle: env.STORAGE_BACKUP_S3_URL_STYLE || 'virtual',
  });
  const db = createPgDatabase({ connectionString: env.DATABASE_URL, application_name: 'rd-storage-backup', max: 2 });
  const startedAt = new Date();
  try {
    const report = await runStorageBackup({ db, sourceStorage, targetStorage });
    console.log(JSON.stringify(report));
    const result = report.hashMismatches > 0 || report.missingInSource > 0 ? 'failure' : 'success';
    await recordStorageBackupRun(db, {
      environment: env.APP_ENV || 'unknown', result, report, startedAt, finishedAt: new Date(),
      errorCode: result === 'failure' ? 'storage_backup_report_has_issues' : null,
    });
    if (result === 'failure') process.exitCode = 1;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'storage_backup_failed';
    console.error(`Storage backup failed: ${code}`);
    await recordStorageBackupRun(db, {
      environment: env.APP_ENV || 'unknown', result: 'failure', errorCode: code, startedAt, finishedAt: new Date(),
    }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await db.close().catch(() => {});
  }
}

await main();
