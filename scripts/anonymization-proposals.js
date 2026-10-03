// Propozycja do zatwierdzenia: raport kandydatów do anonimizacji z polityki
// retencji (#91). TYLKO ODCZYT — niczego nie wykonuje i nie ma harmonogramu.
//
//   DATABASE_URL=… npm run anonymization:proposals [-- --json]
//
// Administrator przegląda listę i wybrane gospodarstwa anonimizuje RĘCZNIE
// istniejącą trasą POST /api/admin/anonymizations (podgląd, potem wykonanie z
// `confirm` i `expectedPlanSha256`). Bez kompletu zatwierdzonych polityk
// (D-04 nieustalone) raport mówi „brak polityk”. Wskazanie użytkownika
// 2026-10-02: bez automatycznego usuwania (docs/DECISIONS.md). Zasady i granice:
// src/pg/anonymization-proposals.js, docs/RETENTION.md.
// Wynik: identyfikatory techniczne i liczniki — bez imion, e-maili i tekstów.

import { fileURLToPath } from 'node:url';
import { createPgDatabase } from '../src/db.js';
import { proposeRetentionAnonymizations } from '../src/pg/anonymization-proposals.js';
import { parseCliOptions } from './lib/cli-options.js';

const USAGE = 'Usage: npm run anonymization:proposals [-- --json]';

export function renderProposalsText(report) {
  const lines = ['Propozycja do zatwierdzenia — anonimizacja z polityki retencji (tylko raport, nic nie wykonano).'];
  if (report.status !== 'ok') {
    lines.push(`Wynik: ${report.summary}. Nikt nie jest wskazany; kod nie ma wartości domyślnej okresu (D-04).`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `Ocenione gospodarstwa: ${report.evaluated}; okres nie upłynął: ${report.periodNotElapsed}; nic do zmiany: ${report.nothingToChange}; ${report.summary}.`,
    `Obowiązujące polityki (id): ${report.policyIds.join(', ')}.`,
  );
  for (const candidate of report.candidates) {
    const total = Object.values(candidate.counts).reduce((sum, n) => sum + n, 0);
    lines.push(`- gospodarstwo ${candidate.householdId}: ${total} wierszy do zmiany, plan ${candidate.planSha256}, `
      + `osoby wspólne z innymi gospodarstwami (zostają): opiekunowie ${candidate.retained.guardians}, dzieci ${candidate.retained.students}`);
  }
  lines.push('Wykonanie: wyłącznie ręcznie, POST /api/admin/anonymizations (podgląd -> confirm + expectedPlanSha256 z podglądu). Plan może się zmienić po przebiegu dla innego gospodarstwa.');
  return `${lines.join('\n')}\n`;
}

export async function runProposalsCli({ argv, env, db, stdout = process.stdout, stderr = process.stderr }) {
  const options = parseCliOptions(argv, { flags: ['json'] });
  if (options.errors.length) {
    stderr.write(`${USAGE}\n`);
    return 1;
  }
  if (!db && !env.DATABASE_URL) {
    stderr.write('DATABASE_URL is required.\n');
    return 1;
  }
  const database = db ?? createPgDatabase({ connectionString: env.DATABASE_URL, application_name: 'rd-anonymization-proposals', max: 1 });
  try {
    const report = await proposeRetentionAnonymizations(database);
    stdout.write(options.flags.has('json') ? `${JSON.stringify(report, null, 2)}\n` : renderProposalsText(report));
    return 0;
  } catch (error) {
    stderr.write(`Report failed (${typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(error.code) ? error.code : 'report_failed'}).\n`);
    return 1;
  } finally {
    if (!db) await database.close().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runProposalsCli({ argv: process.argv.slice(2), env: process.env });
}
