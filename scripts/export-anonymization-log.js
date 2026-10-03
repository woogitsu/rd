// Eksport dziennika przebiegów anonimizacji do pliku PRZECHOWYWANEGO POZA BAZĄ
// (#91, dług anonimizacji; format i zasady: src/pg/anonymization-log.js).
//
//   DATABASE_URL=… npm run anonymization:export-log -- --out=<plik.json>
//
// Plik zawiera wyłącznie identyfikatory gospodarstw i przebiegów, kody powodów i
// skróty planu — bez imion, e-maili i tekstów. Mimo to to dane operacyjne:
// przechowuj go poza bazą i poza repozytorium (miejsce i czas przechowywania to
// decyzje D-01/D-04/D-20, kod ich nie zakłada). Eksportuj po KAŻDYM przebiegu
// anonimizacji; po odtworzeniu kopii plik pozwala ponowić przebiegi
// (npm run anonymization:reapply). Skrypt odmawia nadpisania istniejącego pliku
// (nowszy eksport z bazy odtworzonej ze starej kopii mógłby zgubić przebiegi) —
// zapisuj kolejne eksporty pod nowymi nazwami; ponowienie przyjmuje wiele plików.
// Nic nie wypisuje o adresie bazy; plik powstaje z prawami 0600.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPgDatabase } from '../src/db.js';
import { readAnonymizationLog, serializeAnonymizationLog } from '../src/pg/anonymization-log.js';
import { parseCliOptions } from './lib/cli-options.js';

const USAGE = 'Usage: npm run anonymization:export-log -- --out=<new-file.json>';

export async function runExportLogCli({ argv, env, db, stdout = process.stdout, stderr = process.stderr, write = writeFile }) {
  const options = parseCliOptions(argv, { values: ['out'] });
  if (options.errors.length || !options.values.out) {
    stderr.write(`${USAGE}\n`);
    return 1;
  }
  if (!db && !env.DATABASE_URL) {
    stderr.write('DATABASE_URL is required. Nothing was written.\n');
    return 1;
  }
  const database = db ?? createPgDatabase({ connectionString: env.DATABASE_URL, application_name: 'rd-anonymization-log', max: 1 });
  try {
    const log = await readAnonymizationLog(database);
    // 'wx': istniejący plik nie zostaje nadpisany; 0600: tylko właściciel.
    await write(options.values.out, serializeAnonymizationLog(log), { flag: 'wx', mode: 0o600 });
    stdout.write(`${JSON.stringify({ runs: log.runs.length, runsSha256: log.runsSha256, exportedAt: log.exportedAt })}\n`);
    return 0;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      stderr.write('Export refused (output_file_exists). The file was not overwritten; choose a new name.\n');
      return 1;
    }
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(error.code) ? error.code : 'export_failed';
    stderr.write(`Export failed (${code}). Nothing was written.\n`);
    return 1;
  } finally {
    if (!db) await database.close().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runExportLogCli({ argv: process.argv.slice(2), env: process.env });
}
