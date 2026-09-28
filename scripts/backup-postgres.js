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
// Zrzut trafia WYŁĄCZNIE do pliku tymczasowego, usuwanego też przy błędzie;
// nigdy nie jest trzymany w całości w pamięci procesu.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgDatabase } from '../src/db.js';
import { createS3Storage } from '../src/storage.js';
import { runBackup } from '../src/pg/backup.js';

const REQUIRED_ENV = ['DATABASE_URL', 'BACKUP_ENCRYPTION_PUBLIC_KEY',
  'BACKUP_S3_ENDPOINT', 'BACKUP_S3_REGION', 'BACKUP_S3_BUCKET',
  'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'];

function missingEnv(env) {
  return REQUIRED_ENV.filter((name) => !env[name]);
}

// Zrzut niestandardowego formatu (`pg_dump --format=custom`) do pliku
// tymczasowego (uprawnienia domyślne katalogu tmp usługi), a nie do stdout —
// unika trzymania całej kopii w pamięci procesu naraz z szyfrogramem.
async function dumpToTempFile(connectionString) {
  const dir = await mkdtemp(join(tmpdir(), 'rd-backup-'));
  const file = join(dir, 'dump.custom');
  await new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['--format=custom', '--file', file, connectionString], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(Object.assign(new Error('pg_dump_failed'), { code: 'pg_dump_failed', stderr: stderr.slice(-500) }))));
  });
  return { dir, file };
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

  let tempDir;
  try {
    const result = await runBackup({
      db,
      storage,
      encryptPublicKeyPem: env.BACKUP_ENCRYPTION_PUBLIC_KEY,
      environment: env.APP_ENV || 'unknown',
      force: process.argv.includes('--force'),
      dump: async () => {
        const { dir, file } = await dumpToTempFile(env.DATABASE_URL);
        tempDir = dir;
        return readFile(file);
      },
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
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await db.close().catch(() => {});
  }
}

await main();
