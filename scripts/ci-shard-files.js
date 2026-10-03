// #111: zrównoważony podział plików tests/*.test.js na shardy jobu `test` w CI.
//
// `node --test --test-shard=i/N` przydziela pliki według pozycji na posortowanej liście
// (indeks modulo N), a nie według czasu, więc jeden shard potrafił zebrać kilka
// najdłuższych plików (467 s wobec 152–218 s pozostałych). Ten skrypt wypisuje listę
// plików dla shardu i/N na podstawie zmierzonych czasów z scripts/ci-shard-weights.json:
//
//   node scripts/ci-shard-files.js 3 6          # pliki shardu 3/6, po jednym w wierszu
//   node scripts/ci-shard-files.js --plan 6     # tabela: szacowany czas i liczba plików każdego shardu
//
// Metoda zachłanna (LPT): pliki od najcięższego, każdy do shardu, którego szacowany
// czas po dołożeniu pliku jest najmniejszy (remis: mniejsza suma wag, potem niższy numer).
// Szacowany czas shardu to symulacja tego, co robi `node --test --test-concurrency=2`:
// pliki w kolejności alfabetycznej (node sortuje listę), każdy startuje w pierwszym
// wolnym z dwóch slotów. Plik spoza pliku wag dostaje `defaultWeight`. Każdy plik
// trafia do dokładnie jednego shardu (pilnuje tests/ci-shard-coverage.test.js).
// Wyłącznie odczyt katalogu tests/ i pliku wag; bez sieci i zmiennych środowiskowych.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEST_CONCURRENCY = 2;
const root = new URL('../', import.meta.url);

export function listTestFiles(dir = new URL('tests/', root)) {
  return readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort().map((name) => `tests/${name}`);
}

export function loadWeights(path = new URL('scripts/ci-shard-weights.json', root)) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!(Number(data.defaultWeight) > 0)) throw new Error('ci-shard-weights.json: defaultWeight musi być liczbą dodatnią');
  for (const [file, weight] of Object.entries(data.weights ?? {})) {
    if (!(Number(weight) >= 0)) throw new Error(`ci-shard-weights.json: niepoprawna waga ${file}`);
  }
  return { defaultWeight: Number(data.defaultWeight), weights: data.weights ?? {} };
}

export function weightOf(file, { weights, defaultWeight }) {
  return Object.hasOwn(weights, file) ? Number(weights[file]) : defaultWeight;
}

// Czas shardu przy `--test-concurrency=slots`: pliki alfabetycznie, każdy w pierwszym wolnym slocie.
export function simulateShard(files, weightFor, slots = TEST_CONCURRENCY) {
  const free = Array(slots).fill(0);
  for (const file of [...files].sort()) {
    const slot = free.indexOf(Math.min(...free));
    free[slot] += weightFor(file);
  }
  return Math.max(...free);
}

/**
 * @param {string[]} files ścieżki `tests/x.test.js`
 * @param {number} total liczba shardów
 * @param {{ weights: Record<string, number>, defaultWeight: number }} table
 * @returns {{ files: string[], sum: number, estimate: number }[]} shardy 1..total (indeks 0 = shard 1)
 */
export function planShards(files, total, table) {
  if (!Number.isInteger(total) || total < 1) throw new Error('liczba shardów musi być dodatnią liczbą całkowitą');
  const weightFor = (file) => weightOf(file, table);
  const shards = Array.from({ length: total }, () => ({ files: [], sum: 0, estimate: 0 }));
  const order = [...new Set(files)].sort((a, b) => weightFor(b) - weightFor(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of order) {
    let best = null;
    shards.forEach((shard, index) => {
      const estimate = simulateShard([...shard.files, file], weightFor);
      const sum = shard.sum + weightFor(file);
      if (!best || estimate < best.estimate || (estimate === best.estimate && sum < best.sum)) best = { index, estimate, sum };
    });
    const shard = shards[best.index];
    shard.files.push(file);
    shard.sum = best.sum;
    shard.estimate = best.estimate;
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

function parseIndex(value, label) {
  const number = Number(value);
  if (!/^\d+$/.test(String(value ?? '')) || number < 1) throw new Error(`${label}: oczekiwano dodatniej liczby całkowitej, jest „${value}”`);
  return number;
}

export function main(argv, { stdout = process.stdout } = {}) {
  const table = loadWeights();
  const files = listTestFiles();
  if (argv[0] === '--plan') {
    const total = parseIndex(argv[1], 'N');
    const lines = ['| Shard | Pliki | Suma wag (s) | Szacowany czas (s) |', '|---|---|---|---|'];
    planShards(files, total, table).forEach((shard, index) => {
      lines.push(`| ${index + 1}/${total} | ${shard.files.length} | ${shard.sum.toFixed(0)} | ${shard.estimate.toFixed(0)} |`);
    });
    stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  const index = parseIndex(argv[0], 'i');
  const total = parseIndex(argv[1], 'N');
  if (index > total) throw new Error(`shard ${index} poza zakresem 1..${total}`);
  const shard = planShards(files, total, table)[index - 1];
  // Pusty shard oznaczałby `node --test` bez plików, czyli domyślny wzorzec (cały katalog).
  if (!shard.files.length) throw new Error(`shard ${index}/${total} nie ma żadnego pliku (mniej plików niż shardów)`);
  stdout.write(`${shard.files.join('\n')}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ci-shard-files: ${error.message}\n`);
    process.exitCode = 1;
  }
}
