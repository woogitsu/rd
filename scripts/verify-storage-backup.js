// Weryfikacja kopii bucketu dokumentów i próba odtworzenia LOKALNIE (issue #103).
// Nie łączy się z Railway ani z prawdziwym bucketem: kopia to katalog
// (np. pobrany przez operatora po decyzji D-01/D-20), cel odtworzenia to katalog.
//
//   DATABASE_URL=…                   tylko odczyt tabel documents i news_photo_files
//   --backup-dir <katalog>           kopia z obiektami docs/<id>
//   --restore-dir <katalog>          (opcjonalnie) cel próby odtworzenia
//   --sample <N>                     rozmiar próbki (domyślnie 20)
//   --manifest-out <plik>            (opcjonalnie) zapis manifestu SHA-256
//   APP_ENV=production wymaga --allow-production (baza produkcyjna)
//
// Raport (liczby i identyfikatory techniczne, bez nazw plików) na stdout.
// Kod wyjścia 1 przy brakach, niezgodnych skrótach lub błędzie.

import { writeFile } from 'node:fs/promises';
import { appEnvWarning, guardDangerousOperation } from '../src/app-env.js';
import { createPgDatabase } from '../src/db.js';
import { createDirectoryStorage } from '../src/storage-dir.js';
import { buildStorageManifest, runStorageRestoreDrill, verifyStorageBackup } from '../src/pg/storage-backup-verify.js';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const env = process.env;
  if (guardDangerousOperation(env.APP_ENV, { allowProduction: process.argv.includes('--allow-production') }).refused) {
    const warning = appEnvWarning(env.APP_ENV);
    if (warning) console.error(warning);
    console.error('Backup verification in production (or with unrecognised APP_ENV) requires explicit --allow-production. Nothing was checked.');
    process.exitCode = 1;
    return;
  }
  const backupDir = option('--backup-dir');
  if (!env.DATABASE_URL || !backupDir) {
    console.error('DATABASE_URL and --backup-dir are required. Nothing was checked.');
    process.exitCode = 1;
    return;
  }
  const sample = option('--sample') === undefined ? 20 : Number(option('--sample'));
  const db = createPgDatabase({ connectionString: env.DATABASE_URL, application_name: 'rd-storage-verify', max: 1 });
  try {
    const backupStorage = createDirectoryStorage(backupDir);
    const manifest = await buildStorageManifest(backupStorage);
    if (option('--manifest-out')) await writeFile(option('--manifest-out'), JSON.stringify(manifest));
    const verification = await verifyStorageBackup({ db, manifest });
    const output = { verification };
    let ok = verification.ok;
    if (option('--restore-dir')) {
      output.restoreDrill = await runStorageRestoreDrill({
        db, backupStorage, restoreStorage: createDirectoryStorage(option('--restore-dir')), sampleSize: sample,
      });
      ok = ok && output.restoreDrill.ok;
    }
    console.log(JSON.stringify(output));
    if (!ok) process.exitCode = 1;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,60}$/.test(error.code) ? error.code : 'storage_verify_failed';
    console.error(`Backup verification failed: ${code}`);
    process.exitCode = 1;
  } finally {
    await db.close().catch(() => {});
  }
}

await main();
