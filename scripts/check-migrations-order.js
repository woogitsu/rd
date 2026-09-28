// Kontrola integralności migracji względem gałęzi bazowej (issue #79, CI).
// Dwie zasady, niezależnie od kolejności scalania PR-ów:
//   1. żaden plik postgres/migrations/*.sql obecny już na gałęzi bazowej nie
//      może być zmieniony ani usunięty w tym PR (scalony plik jest ostateczny —
//      poprawka to NOWY numer, nie edycja starego);
//   2. każdy NOWY plik ma numer większy niż maksimum numerów obecnych na
//      gałęzi bazowej (konflikt numerów rozwiązuje przenumerowanie PRZED
//      scaleniem, nie po).
// Numeracja plików ≠ kolejność faktycznego nałożenia (patrz postgres/README.md
// i src/postgres-migrations.js) — ta kontrola pilnuje tylko, że PR się
// "dopisuje" do końca, nie że kolejność scalania odpowiada numeracji.
//
//   node scripts/check-migrations-order.js [--base origin/main] [--cwd <repo>]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class MigrationsOrderError extends Error {}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const NAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
function numberOf(name) {
  return Number(name.slice(0, 4));
}

/**
 * Czysta logika (testowalna bez repozytorium git): `changed` to lista wpisów
 * `git diff --name-status <base>...HEAD -- postgres/migrations/*.sql`
 * ({ status: 'A'|'M'|'D'|'R100'…, path }), `baseNames` to lista plików
 * *.sql obecnych na gałęzi bazowej.
 */
export function checkMigrationsOrder(changed, baseNames) {
  const problems = [];
  const baseMax = baseNames.filter((n) => NAME_PATTERN.test(n)).reduce((max, n) => Math.max(max, numberOf(n)), 0);
  for (const { status, path } of changed) {
    const name = path.split('/').pop();
    if (!NAME_PATTERN.test(name)) continue; // MANIFEST.json itd. — sprawdzane osobno
    const kind = status[0]; // 'R100' -> 'R'
    if (kind === 'A') {
      if (numberOf(name) <= baseMax) {
        problems.push(`${name}: nowy plik ma numer ${name.slice(0, 4)} <= maksimum na gałęzi bazowej (${String(baseMax).padStart(4, '0')}) — przenumerować przed scaleniem.`);
      }
    } else if (baseNames.includes(name)) {
      // Zmiana/usunięcie/zmiana nazwy pliku, który już istniał na bazie.
      problems.push(`${name}: scalony plik migracji nie może być zmieniony ani usunięty (status ${status}) — poprawka to nowy numer.`);
    }
  }
  return problems;
}

export function runCheck({ base = 'origin/main', cwd = process.cwd() } = {}) {
  let baseListing;
  try {
    baseListing = git(['ls-tree', '-r', '--name-only', base, '--', 'postgres/migrations'], cwd);
  } catch (error) {
    throw new MigrationsOrderError(`cannot read ${base}:postgres/migrations (${error.message.split('\n')[0]})`);
  }
  const baseNames = baseListing.split('\n').filter(Boolean).map((p) => p.split('/').pop());
  const diff = git(['diff', '--name-status', `${base}...HEAD`, '--', 'postgres/migrations'], cwd);
  const changed = diff.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status, path: rest.at(-1) };
  });
  return checkMigrationsOrder(changed, baseNames);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseIndex = process.argv.indexOf('--base');
  const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : 'origin/main';
  try {
    const problems = runCheck({ base });
    if (problems.length) {
      console.error('Migration order/integrity check failed:');
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(`Migration order/integrity check passed against ${base}.`);
    }
  } catch (error) {
    console.error(`Migration order/integrity check could not run: ${error.message}`);
    process.exitCode = 1;
  }
}
