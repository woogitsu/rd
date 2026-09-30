// Kontrola mutacyjna blokad (#208, punkt 4): dla każdej blokady z listy
// MUTANTS usuwa ją z kopii kodu (FOR UPDATE albo pg_advisory_xact_lock w jednej
// funkcji) i uruchamia wskazany test na PRAWDZIWYM PostgreSQL. Mutant musi dać
// czerwony test — inaczej blokada nie ma testu, który wykryje jej usunięcie.
//
//   npm run test:pg-mutations                 wszystkie mutanty
//   npm run test:pg-mutations -- --list       tylko lista (bez uruchamiania)
//   npm run test:pg-mutations -- admin-last   wybrane (po id)
//
// Kod repozytorium NIE jest zmieniany: skrypt kopiuje potrzebne katalogi do
// katalogu tymczasowego, tam podmienia jeden plik, uruchamia
// `scripts/test-pg-real.js` (własny serwer albo RD_TEST_PG_URL) i przywraca
// plik przed kolejnym mutantem. Najpierw przebieg bez mutacji (każdy plik
// testowy musi być zielony), potem mutanty. Wyłącznie dane syntetyczne.
//
// Blokady spoza listy (np. families.js, events.js, news.js) nie mają jeszcze
// testu z barierą — docs/TESTING.md, „Kontrola mutacyjna”.
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const DOUBLE_CLICK = 'tests/pg-real-double-click.test.js';
const CONCURRENCY = 'tests/pg-real-concurrency.test.js';
const YEAR_CLOSE = 'tests/pg-year-close-race.test.js';

// kind: 'for-update' usuwa każde `FOR UPDATE [OF x]` w funkcji `fn`;
// 'advisory' zamienia `pg_advisory_xact_lock(` na `(` (zapytanie zostaje
// poprawne i ma te same parametry, ale niczego nie blokuje).
export const MUTANTS = [
  { id: 'payments-correction', file: 'src/pg/routes/payments.js', fn: 'createCorrection', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'payments-assign', file: 'src/pg/routes/payments.js', fn: 'assignPayment', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'ledger-correction', file: 'src/pg/routes/ledger.js', fn: 'createCorrection', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'ledger-payment-link', file: 'src/pg/routes/ledger.js', fn: 'createEntry', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'reconciliation-lock', file: 'src/pg/routes/reconciliation.js', fn: 'loadReconciliation', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'email-campaign-lock', file: 'src/pg/routes/email.js', fn: 'loadCampaign', kind: 'for-update', test: DOUBLE_CLICK },
  { id: 'admin-last', file: 'src/pg/routes/admin.js', fn: 'lockGrantChanges', kind: 'advisory', test: DOUBLE_CLICK },
  { id: 'invitation-pending', file: 'src/pg/auth.js', fn: 'insertInvitation', kind: 'advisory', test: DOUBLE_CLICK },
  { id: 'import-commit', file: 'src/pg/routes/import.js', fn: 'commit', kind: 'advisory', test: DOUBLE_CLICK },
  { id: 'email-cancel', file: 'src/pg/routes/email.js', fn: 'loadCampaign', kind: 'for-update', test: CONCURRENCY },
  { id: 'year-close', file: 'src/pg/routes/year-close.js', fn: 'closeYear', kind: 'advisory', test: YEAR_CLOSE },
];

// Zwraca [początek, koniec) ciała funkcji najwyższego poziomu `fn` w `source`.
export function functionRange(source, fn) {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${fn}\\(`, 'm'));
  if (start < 0) return null;
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^export (?:const|let) |^const [A-Z_]+ = /m);
  return [start, next < 0 ? source.length : start + 1 + next];
}

export function applyMutant(source, mutant) {
  const range = functionRange(source, mutant.fn);
  if (!range) throw new Error(`${mutant.id}: brak funkcji ${mutant.fn} w ${mutant.file}`);
  const body = source.slice(...range);
  const pattern = mutant.kind === 'advisory' ? /pg_advisory_xact_lock\(/g : /\s*FOR UPDATE(?: OF \w+)?/g;
  const replacement = mutant.kind === 'advisory' ? '(' : '';
  const hits = body.match(pattern)?.length ?? 0;
  if (!hits) throw new Error(`${mutant.id}: brak blokady (${mutant.kind}) w ${mutant.fn} — lista mutantów jest nieaktualna`);
  return { source: source.slice(0, range[0]) + body.replace(pattern, replacement) + source.slice(range[1]), hits };
}

function runTests(dir, file) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, ['scripts/test-pg-real.js', file], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => {
      const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN);
      const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN);
      ok({ code: code ?? 1, pass, fail, out });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const selected = args.filter((a) => !a.startsWith('--'));
  const mutants = selected.length ? MUTANTS.filter((m) => selected.includes(m.id)) : MUTANTS;
  if (selected.length && mutants.length !== selected.length) {
    console.error(`Nieznany mutant: ${selected.filter((id) => !MUTANTS.some((m) => m.id === id)).join(', ')}`);
    return 2;
  }
  for (const mutant of mutants) applyMutant(await readFile(join(root, mutant.file), 'utf8'), mutant);
  if (args.includes('--list')) {
    for (const m of mutants) console.log(`${m.id}\t${m.file}#${m.fn}\t${m.kind}\t${m.test}`);
    return 0;
  }

  const dir = await mkdtemp(join(tmpdir(), 'rd-mutants-'));
  try {
    // Cała kopia robocza (~10 MB) bez zależności, historii git i artefaktów budowania:
    // kod aplikacji importuje moduły z wielu katalogów (print/, shared/, import/ …).
    const skipped = new Set(['node_modules', '.git', 'dist', 'test-results', 'playwright-report']);
    for (const entry of await readdir(root)) {
      if (!skipped.has(entry)) await cp(join(root, entry), join(dir, entry), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');

    const baseline = [...new Set(mutants.map((m) => m.test))];
    for (const file of baseline) {
      const result = await runTests(dir, file);
      if (result.code !== 0 || !(result.pass > 0) || result.fail !== 0) {
        console.error(result.out.slice(-4000));
        console.error(`Przebieg bez mutacji nie jest zielony: ${file} (kod ${result.code}, pass ${result.pass}, fail ${result.fail}).`);
        return 2;
      }
      console.log(`# bez mutacji: ${file} — pass ${result.pass}`);
    }

    const survivors = [];
    for (const mutant of mutants) {
      const target = join(dir, mutant.file);
      const original = await readFile(target, 'utf8');
      const { source, hits } = applyMutant(original, mutant);
      await writeFile(target, source);
      try {
        const result = await runTests(dir, mutant.test);
        // Wynik bez linii „# fail” (proces padł przed raportem) to błąd, nie „zabity mutant”.
        const killed = Number.isFinite(result.fail) && result.fail > 0;
        if (!Number.isFinite(result.fail)) {
          console.error(result.out.slice(-3000));
          console.error(`${mutant.id}: brak raportu testów (kod ${result.code}).`);
          return 2;
        }
        console.log(`${killed ? 'zabity  ' : 'PRZEŻYŁ '} ${mutant.id} (${mutant.file}#${mutant.fn}, ${hits}× ${mutant.kind}) — fail ${result.fail}, pass ${result.pass}`);
        if (!killed) survivors.push(mutant.id);
      } finally {
        await writeFile(target, original);
      }
    }
    if (survivors.length) {
      console.error(`Mutanty, których żaden test nie wykrył: ${survivors.join(', ')}`);
      return 1;
    }
    console.log(`# wszystkie mutanty zabite: ${mutants.length}`);
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
