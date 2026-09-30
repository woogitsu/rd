// Jeden przebieg kopii zapasowej PostgreSQL — do uruchamiania jako osobna
// usługa cron Railway `rd-backup` (issue #90). Kończy się po jednym
// przebiegu (wymóg crona Railway); przebieg nakładający się w tym samym
// oknie jest pomijany (ten sam klucz dnia w magazynie kopii).
//
//   DATABASE_URL=…                    baza źródłowa (tylko do odczytu przez pg_dump)
//   BACKUP_ENCRYPTION_PUBLIC_KEY=…    klucz publiczny RSA (PEM) — szyfrowanie po stronie klienta
//   BACKUP_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY
//                                      DRUGI magazyn S3 (poza Railway), tylko dla kopii
//   npm run backup:postgres [-- --force]
//
// Nigdy nie wypisuje adresu bazy, nazwy bucketu ani kluczy dostępu/szyfrowania.
// Zrzut trafia na dysk WYŁĄCZNIE jako plik tymczasowy (katalog 0700), usuwany
// też przy błędzie; dalej idzie już tylko zaszyfrowany. Raport zgodności
// (liczności, sumy, skróty — bez danych osobowych) jest liczony w tej samej
// migawce co zrzut i zapisywany w backup_runs jako punkt odniesienia próby.

import { createPgDatabase } from '../src/db.js';
import { createS3Storage } from '../src/storage.js';
import { runBackup } from '../src/pg/backup.js';
import { appEnvLabel } from '../src/app-env.js';
import { dumpWithReport } from './lib/pg-tools.js';

const REQUIRED_ENV = ['DATABASE_URL', 'BACKUP_ENCRYPTION_PUBLIC_KEY',
  'BACKUP_S3_ENDPOINT', 'BACKUP_S3_REGION', 'BACKUP_S3_BUCKET',
  'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'];

function missingEnv(env) {
  return REQUIRED_ENV.filter((name) => !env[name]);
}

async function main() {
  const env = process.env;
  const missing = missingEnv(env);
  if (missing.length) {
    console.error(`Backup refused: missing environment variables (${missing.length}). Nothing was written.`);
    process.exitCode = 1;
    return;
  }

  const storage = createS3Storage({
    endpoint: env.BACKUP_S3_ENDPOINT,
    region: env.BACKUP_S3_REGION,
    bucket: env.BACKUP_S3_BUCKET,
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY,
    urlStyle: env.BACKUP_S3_URL_STYLE || 'virtual',
  });
  const db = createPgDatabase({ connectionString: env.DATABASE_URL, application_name: 'rd-backup', max: 2 });

  try {
    const result = await runBackup({
      db,
      storage,
      encryptPublicKeyPem: env.BACKUP_ENCRYPTION_PUBLIC_KEY,
      environment: appEnvLabel(env.APP_ENV),
      force: process.argv.includes('--force'),
      // Zrzut + raport (liczności, sumy, skróty) z jednej migawki; plik
      // tymczasowy usuwa dumpWithReport także przy błędzie.
      dump: () => dumpWithReport(env.DATABASE_URL),
    });
    if (result.skipped) {
      console.log(JSON.stringify({ skipped: true }));
    } else {
      console.log(JSON.stringify({ skipped: false, sizeBytes: result.sizeBytes }));
    }
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'backup_failed';
    console.error(`Backup failed: ${code}`);
    process.exitCode = 1;
  } finally {
    await db.close().catch(() => {});
  }
}

await main();
