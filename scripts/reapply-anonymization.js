// Ponowne zastosowanie przebiegów anonimizacji po odtworzeniu kopii bazy (#91,
// dług anonimizacji; docs/RETENTION.md, docs/RAILWAY_OPERATIONS.md).
//
//   DATABASE_URL=… APP_ENV=staging npm run anonymization:reapply -- \
//     --log=<dziennik.json> [--log=<kolejny.json> …] --actor=<userId> [--dry-run] [--allow-production]
//
// Dziennik pochodzi z `npm run anonymization:export-log` i jest przechowywany POZA
// bazą. `--actor` jest wymagany: aktywny administrator w odtworzonej bazie (po
// odtworzeniu z paczki rocznej konta nie wracają — najpierw bootstrap, #187).
// `--dry-run` wykonuje całą pracę w transakcji, którą wycofuje (dokładny podgląd,
// zostaje tylko zdarzenie audytu podglądu); bez niego zmiany są zapisywane w jednej
// transakcji. Ponowne uruchomienie jest idempotentne (przebiegi już w bazie i
// gospodarstwa już zanonimizowane są pomijane). Poza testami i stagingiem wymaga
// --allow-production (APP_ENV=production albo nierozpoznane/brak).
//
// Wynik na stdout: JSON z samymi identyfikatorami, kodami i licznikami — bez imion,
// e-maili i tekstów. Błędy na stderr jako stałe kody.
// Kody wyjścia: 0 = wykonano (także gdy nic nie było do zmiany), 1 = błąd użycia,
// pliku lub bazy, 2 = odmowa (blokada środowiska, aktor nie jest administratorem).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { appEnvWarning, guardDangerousOperation } from '../src/app-env.js';
import { createPgDatabase } from '../src/db.js';
import { mergeLogRuns, parseAnonymizationLog } from '../src/pg/anonymization-log.js';
import { reapplyAnonymizationRuns } from '../src/pg/anonymization-reapply.js';
import { parseCliOptions } from './lib/cli-options.js';

const USAGE = 'Usage: npm run anonymization:reapply -- --log=<anonymization-log.json> [--log=<more.json> …] --actor=<userId> [--dry-run] [--allow-production]';

function stableCode(error, fallback) {
  return typeof error?.code === 'string' && /^[A-Za-z0-9_:.[\]-]{1,100}$/.test(error.code) ? error.code : fallback;
}

export async function runReapplyCli({ argv, env, db, stdout = process.stdout, stderr = process.stderr, read = readFile }) {
  const options = parseCliOptions(argv, { values: ['actor'], repeatable: ['log'], flags: ['dry-run', 'allow-production'] });
  if (options.errors.length || !options.values.actor || !options.lists.log.length) {
    stderr.write(`${USAGE}\n`);
    return 1;
  }
  const dryRun = options.flags.has('dry-run');
  if (!dryRun && guardDangerousOperation(env.APP_ENV, { allowProduction: options.flags.has('allow-production') }).refused) {
    const warning = appEnvWarning(env.APP_ENV);
    if (warning) stderr.write(`${warning}\n`);
    stderr.write('Re-applying anonymization in production (or with unrecognised APP_ENV) requires explicit --allow-production. Nothing was changed.\n');
    return 2;
  }

  let runs;
  try {
    const lists = [];
    for (const path of options.lists.log) lists.push(parseAnonymizationLog(await read(path, 'utf8')).runs);
    runs = mergeLogRuns(lists);
  } catch (error) {
    stderr.write(`Log refused (${error?.code === 'ENOENT' ? 'log_file_not_found' : stableCode(error, 'log_unreadable')}). Nothing was changed.\n`);
    return 1;
  }

  const connectionString = env.DATABASE_URL || env.DATABASE_MIGRATION_URL;
  if (!db && !connectionString) {
    stderr.write('DATABASE_URL is required. Nothing was changed.\n');
    return 1;
  }
  const database = db ?? createPgDatabase({ connectionString, application_name: 'rd-anonymization-reapply', max: 1 });
  try {
    const result = await reapplyAnonymizationRuns(database, { actorId: options.values.actor, runs, dryRun });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code = stableCode(error, 'reapply_failed');
    stderr.write(`Re-applying anonymization failed (${code}). Nothing was changed.\n`);
    return error?.status === 403 ? 2 : 1;
  } finally {
    if (!db) await database.close().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runReapplyCli({ argv: process.argv.slice(2), env: process.env });
}
