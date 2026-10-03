// #111: podział kontroli mutacyjnej blokad (scripts/check-lock-mutations.js) na N części,
// żeby w CI biegła równolegle w jobach `test-pg-mutations (1..N)` zamiast jako drugi krok
// jobu `test-pg-real` (ok. 6,5 min z ok. 9 min tego jobu na GitHub).
//
//   npm run test:pg-mutations -- --shard=2/3          mutanty części 2/3
//   npm run test:pg-mutations -- --shard=2/3 --list   tylko lista mutantów tej części
//   node scripts/lock-mutation-shards.js --plan 3     tabela: szacowany czas i mutanty każdej części
//
// Podział jest deterministyczny i zależy wyłącznie od listy MUTANTS i od N (nie od maszyny
// ani kolejności uruchomienia): mutanty ustawione grupami według pliku testów (grupy
// w kolejności pierwszego wystąpienia na liście, w grupie kolejność z listy), potem ciąg
// pocięty na N kolejnych, niepustych kawałków tak, żeby najdłuższy szacowany kawałek był
// najkrótszy (programowanie dynamiczne). Kawałki kolejne, bo każda część najpierw uruchamia
// bez mutacji każdy plik testów swoich mutantów: grupa trafia w całości do jednej części
// albo jest przecięta na granicy, więc przebieg bez mutacji powtarza się najwyżej N−1 razy.
// Każdy mutant jest w dokładnie jednej części (tests/lock-mutations.test.js).
//
// Szacunek części = suma czasów jednego przebiegu pliku testów dla każdego mutanta + po
// jednym przebiegu bez mutacji dla każdego pliku. Czasy w TEST_SECONDS to średnie z trzech
// przebiegów jobu `test-pg-real` na GitHub (3 października 2026, runy 37120800949,
// 37121017225, 37121057725); mutant trwa tyle co przebieg bez mutacji (±1 s, wyjątek
// pojedyncze mutanty z dłuższym oczekiwaniem na blokadę). Plik spoza tabeli dostaje
// DEFAULT_TEST_SECONDS. Liczą się proporcje, nie sekundy.
import { fileURLToPath } from 'node:url';

export const TEST_SECONDS = {
  'tests/pg-real-double-click.test.js': 11,
  'tests/pg-real-payment-locks.test.js': 3,
  'tests/pg-real-concurrency.test.js': 8,
  'tests/pg-real-domain-locks.test.js': 3.5,
  'tests/pg-year-close-race.test.js': 8,
  'tests/pg-real-cost-center-locks.test.js': 1.5,
  'tests/pg-real-budget-locks.test.js': 2.5,
  'tests/pg-real-record-locks.test.js': 6,
  'tests/pg-real-replay-23505.test.js': 4.5,
  'tests/pg-disable-session-race.test.js': 2,
  'tests/pg-real-request-locks.test.js': 3.5,
  'tests/pg-real-auth-locks.test.js': 5,
  'tests/pg-real-email-locks.test.js': 3,
};
export const DEFAULT_TEST_SECONDS = 5;

export const testSeconds = (file) => (Object.hasOwn(TEST_SECONDS, file) ? TEST_SECONDS[file] : DEFAULT_TEST_SECONDS);

/**
 * `--shard=i/N` → { index: i, total: N }; 1 ≤ i ≤ N.
 * @param {string} value tekst po `--shard=`
 */
export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(String(value));
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!(total >= 1) || !(index >= 1) || index > total) throw new Error(`Niepoprawna część mutantów: --shard=${value} (oczekiwano i/N, 1 ≤ i ≤ N)`);
  return { index, total };
}

/**
 * Mutanty pogrupowane według pliku testów (kolejność pierwszego wystąpienia).
 * @template {{ test: string }} M
 * @param {M[]} mutants
 * @returns {M[]}
 */
export function orderByTestFile(mutants) {
  const groups = new Map();
  for (const mutant of mutants) {
    if (!groups.has(mutant.test)) groups.set(mutant.test, []);
    groups.get(mutant.test).push(mutant);
  }
  return [...groups.values()].flat();
}

/**
 * Szacowany czas części: przebieg bez mutacji każdego pliku + przebieg na każdy mutant.
 * @param {{ test: string }[]} mutants
 */
export function estimateSeconds(mutants) {
  const files = new Set(mutants.map((m) => m.test));
  return [...files].reduce((sum, file) => sum + testSeconds(file), 0)
    + mutants.reduce((sum, m) => sum + testSeconds(m.test), 0);
}

/**
 * Części 1..total (indeks 0 = część 1): kolejne kawałki listy uporządkowanej według pliku
 * testów, minimalizujące najdłuższy szacunek; remis — wcześniejsze cięcie.
 * @template {{ id: string, test: string }} M
 * @param {M[]} mutants
 * @param {number} total
 * @returns {{ mutants: M[], files: string[], estimate: number }[]}
 */
export function planMutantShards(mutants, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error('liczba części musi być dodatnią liczbą całkowitą');
  if (mutants.length < total) throw new Error(`mutantów (${mutants.length}) mniej niż części (${total})`);
  const ordered = orderByTestFile(mutants);
  const n = ordered.length;
  const cost = (from, to) => estimateSeconds(ordered.slice(from, to));
  // best[k][j]: najmniejszy możliwy najdłuższy kawałek przy podziale pierwszych j mutantów na k kawałków.
  const best = Array.from({ length: total + 1 }, () => Array(n + 1).fill(Infinity));
  const cut = Array.from({ length: total + 1 }, () => Array(n + 1).fill(0));
  best[0][0] = 0;
  for (let k = 1; k <= total; k += 1) {
    for (let j = k; j <= n; j += 1) {
      for (let i = k - 1; i < j; i += 1) {
        const value = Math.max(best[k - 1][i], cost(i, j));
        if (value < best[k][j]) { best[k][j] = value; cut[k][j] = i; }
      }
    }
  }
  const bounds = [];
  for (let k = total, j = n; k > 0; k -= 1) { bounds.unshift([cut[k][j], j]); j = cut[k][j]; }
  return bounds.map(([from, to]) => {
    const part = ordered.slice(from, to);
    return { mutants: part, files: [...new Set(part.map((m) => m.test))], estimate: estimateSeconds(part) };
  });
}

/**
 * Mutanty części `index`/`total` (numeracja od 1).
 * @template {{ id: string, test: string }} M
 * @param {M[]} mutants
 * @param {number} index
 * @param {number} total
 * @returns {M[]}
 */
export function shardMutants(mutants, index, total) {
  if (!Number.isInteger(index) || index < 1 || index > total) throw new Error(`niepoprawny numer części ${index}/${total}`);
  return planMutantShards(mutants, total)[index - 1].mutants;
}

async function main() {
  const args = process.argv.slice(2);
  const total = Number(args[args.indexOf('--plan') + 1]);
  if (!args.includes('--plan') || !Number.isInteger(total) || total < 1) {
    console.error('Użycie: node scripts/lock-mutation-shards.js --plan N');
    return 1;
  }
  const { MUTANTS } = await import('./check-lock-mutations.js');
  const plan = planMutantShards(MUTANTS, total);
  console.log(`# mutantów: ${MUTANTS.length}, szacunek bez podziału: ${estimateSeconds(MUTANTS).toFixed(0)} s`);
  for (const [index, part] of plan.entries()) {
    console.log(`${index + 1}/${total}\t~${part.estimate.toFixed(0)} s\t${part.mutants.length} mutantów\t${part.files.join(', ')}`);
  }
  return 0;
}

// Bez await na najwyższym poziomie: main() importuje check-lock-mutations.js, który importuje ten moduł
// (jak w scripts/lock-inventory.js).
if (process.argv[1] === fileURLToPath(import.meta.url)) main().then((code) => { process.exitCode = code; });
