// #111: shardy CI (`node --test --test-shard=i/N`) pokrywają każdy plik
// tests/*.test.js dokładnie raz. Test statyczny: czyta ci.yml, nic nie uruchamia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const testsDir = new URL('../tests/', import.meta.url);
const files = (await readdir(testsDir)).filter((f) => f.endsWith('.test.js')).sort();

const jobBlock = workflow.match(/^ {2}test:\n([\s\S]*?)(?=^ {2}\S)/m);
const block = jobBlock ? jobBlock[1] : '';
const matrix = block.match(/shard:\s*\[([^\]]+)\]/);
const shards = matrix ? matrix[1].split(',').map((s) => Number(s.trim())) : [];
const commands = [...block.matchAll(/run:\s*(node --test .*)/g)].map((m) => m[1]);

test('job `test` has a shard matrix 1..N without gaps or duplicates', () => {
  assert.ok(shards.length > 0, 'shard matrix not found in job `test`');
  assert.deepEqual(shards, shards.map((_, i) => i + 1));
});

test('the shard command uses the whole tests/*.test.js glob and the same total as the matrix', () => {
  assert.equal(commands.length, 1, 'expected exactly one node --test command in job `test`');
  const [command] = commands;
  const total = command.match(/--test-shard=\$\{\{ matrix\.shard \}\}\/(\d+)/);
  assert.ok(total, 'missing --test-shard=${{ matrix.shard }}/N');
  assert.equal(Number(total[1]), shards.length);
  assert.match(command, /\btests\/\*\.test\.js\b/);
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

test('node --test-shard=i/N assigns every file to exactly one shard (index modulo N)', () => {
  const total = shards.length;
  assert.ok(files.length >= total, 'fewer test files than shards');
  const seen = new Map();
  for (const shard of shards) {
    files.forEach((file, index) => {
      if (index % total === shard - 1) seen.set(file, (seen.get(file) || 0) + 1);
    });
  }
  assert.equal(seen.size, files.length);
  for (const file of files) assert.equal(seen.get(file), 1, `${file} covered ${seen.get(file) || 0} times`);
});
