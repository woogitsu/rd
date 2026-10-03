// #111: shardy CI pokrywają każdy plik tests/*.test.js dokładnie raz. Listę plików shardu
// wybiera scripts/ci-shard-files.js według wag (scripts/ci-shard-weights.json), a nie
// `node --test --test-shard=i/N`. Test statyczny: czyta ci.yml i wagi; uruchamia wyłącznie
// skrypt podziału (bez testów, bez sieci).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { listTestFiles, loadWeights, planShards, simulateShard, weightOf } from '../scripts/ci-shard-files.js';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const testsDir = new URL('../tests/', import.meta.url);
const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test.js')).sort().map((f) => `tests/${f}`);
const table = loadWeights();
const script = fileURLToPath(new URL('../scripts/ci-shard-files.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const jobBlock = workflow.match(/^ {2}test:\n([\s\S]*?)(?=^ {2}\S)/m);
const block = jobBlock ? jobBlock[1] : '';
const matrix = block.match(/shard:\s*\[([^\]]+)\]/);
const shards = matrix ? matrix[1].split(',').map((s) => Number(s.trim())) : [];
const total = shards.length;

// Każdy plik dokładnie raz: suma list shardów 1..N to dokładnie `expected`, bez powtórzeń.
function assertPartition(plan, expected) {
  const seen = new Map();
  for (const shard of plan) for (const file of shard.files) seen.set(file, (seen.get(file) || 0) + 1);
  assert.deepEqual([...seen.keys()].sort(), [...expected].sort());
  for (const file of expected) assert.equal(seen.get(file), 1, `${file} w ${seen.get(file) || 0} shardach`);
  for (const [index, shard] of plan.entries()) assert.ok(shard.files.length > 0, `shard ${index + 1} bez plików`);
}

test('job `test` has a shard matrix 1..N without gaps or duplicates', () => {
  assert.ok(total > 0, 'shard matrix not found in job `test`');
  assert.deepEqual(shards, shards.map((_, i) => i + 1));
});

test('job `test` takes its files from scripts/ci-shard-files.js for shard i/N with N equal to the matrix size', () => {
  const pick = block.match(/files=\$\(node scripts\/ci-shard-files\.js \$\{\{ matrix\.shard \}\} (\d+)\)/);
  assert.ok(pick, 'missing files=$(node scripts/ci-shard-files.js ${{ matrix.shard }} N)');
  assert.equal(Number(pick[1]), total);
  // Pusty wynik nie może uruchomić `node --test` bez plików (domyślny wzorzec = cały katalog).
  assert.match(block, /test -n "\$files"/);
  const commands = [...block.matchAll(/^\s*(node --test .*)$/gm)].map((m) => m[1]);
  assert.equal(commands.length, 1, 'expected exactly one node --test command in job `test`');
  const [command] = commands;
  assert.match(command, /--test-concurrency=2\b/);
  assert.match(command, /--import \.\/tests\/setup\.js\b/);
  assert.match(command, /\$files\s*$/);
  // `--test-shard` dzieliłby listę jeszcze raz (każdy shard uruchomiłby tylko część swoich plików).
  assert.doesNotMatch(block, /--test-shard/);
});

test('job `test` keeps the memory measurement (RD_TEST_RSS_LOG + summarize-test-memory step)', () => {
  assert.match(block, /RD_TEST_RSS_LOG: \$\{\{ runner\.temp \}\}\/test-rss\.log/);
  assert.match(block, /- if: always\(\)\n\s+run: node scripts\/summarize-test-memory\.js "\$RD_TEST_RSS_LOG"/);
});

test('no test file lives outside the tests/*.test.js glob (subdirectories are not sharded)', async () => {
  const stray = [];
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, dir), `${rel}${entry.name}/`);
      else if (rel && /\.test\.js$/.test(entry.name)) stray.push(`${rel}${entry.name}`);
    }
  }
  await walk(testsDir, '');
  assert.deepEqual(stray, [], 'test files in subdirectories are not run by CI shards');
});

test('the shard script lists the same files as tests/*.test.js', () => {
  assert.deepEqual(listTestFiles(), files);
});

test('every test file lands in exactly one shard', () => {
  assert.ok(files.length >= total, 'fewer test files than shards');
  assertPartition(planShards(files, total, table), files);
});

test('a new file without a weight gets defaultWeight and still lands in exactly one shard', () => {
  const extra = ['tests/zz-nowy-plik-bez-wagi.test.js', 'tests/aa-drugi-nowy.test.js'];
  for (const file of extra) {
    assert.ok(!Object.hasOwn(table.weights, file));
    assert.equal(weightOf(file, table), table.defaultWeight);
  }
  assertPartition(planShards([...files, ...extra], total, table), [...files, ...extra]);
});

test('the plan does not depend on input order (every job computes the same split)', () => {
  const reversed = planShards([...files].reverse(), total, table);
  assert.deepEqual(reversed, planShards(files, total, table));
});

test('the CLI prints a disjoint list for each shard i/N and their union is every test file', () => {
  const union = [];
  for (const shard of shards) {
    const result = spawnSync(process.execPath, [script, String(shard), String(total)], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const listed = result.stdout.split('\n').filter(Boolean);
    assert.ok(listed.length > 0, `shard ${shard} is empty`);
    union.push(...listed);
  }
  assert.equal(new Set(union).size, union.length, 'a file is listed in two shards');
  assert.deepEqual(union.sort(), files);
});

test('the CLI rejects a bad shard index (non-zero exit, nothing on stdout)', () => {
  for (const args of [['0', '6'], ['7', '6'], ['x', '6'], ['1'], []]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 1, `args ${args.join(' ')}`);
    assert.equal(result.stdout, '', `args ${args.join(' ')}`);
  }
});

test('simulateShard models --test-concurrency=2: alphabetical order, each file in the first free slot', () => {
  const w = { 'a.test.js': 10, 'b.test.js': 1, 'c.test.js': 1, 'd.test.js': 5 };
  // a→slot1 (0–10), b→slot2 (0–1), c→slot2 (1–2), d→slot2 (2–7): koniec 10.
  assert.equal(simulateShard(Object.keys(w).reverse(), (f) => w[f]), 10);
  assert.equal(simulateShard(['a.test.js', 'd.test.js'], (f) => w[f], 1), 15);
});

test('the estimated longest shard stays within 25% of the lower bound max(heaviest file, total weight / 2N)', () => {
  const plan = planShards(files, total, table);
  const heaviest = Math.max(...files.map((file) => weightOf(file, table)));
  const longest = Math.max(...plan.map((shard) => shard.estimate));
  const average = files.reduce((sum, file) => sum + weightOf(file, table), 0) / total / 2;
  const bound = Math.max(heaviest, average);
  assert.ok(longest <= bound * 1.25, `najdłuższy shard ${longest.toFixed(0)} s, dolna granica ${bound.toFixed(0)} s`);
});
