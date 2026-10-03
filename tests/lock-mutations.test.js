// #208: lista mutantów kontroli mutacyjnej blokad (scripts/check-lock-mutations.js)
// nie może się po cichu zestarzeć. Test statyczny, bez bazy: każdy mutant
// wskazuje istniejącą funkcję, która nadal ma blokadę danego rodzaju, a jego
// plik testowy działa na prawdziwym PostgreSQL (czyta RD_TEST_PG_URL).
// Samo uruchomienie mutantów: `npm run test:pg-mutations` (w CI job test-pg-mutations,
// podzielony na części `--shard=i/N`, #111; podział: scripts/lock-mutation-shards.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MUTANTS, applyMutant, functionRange, selectMutantLocks } from '../scripts/check-lock-mutations.js';
import { scanSource } from '../scripts/lock-inventory.js';
import { DEFAULT_TEST_SECONDS, TEST_SECONDS, estimateSeconds, parseShard, planMutantShards, shardMutants, testSeconds } from '../scripts/lock-mutation-shards.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const ci = read('.github/workflows/ci.yml');
// Blok jobu w ci.yml: od nagłówka do następnej linii z wcięciem 2 (job albo komentarz przed nim) albo końca pliku.
const jobBlock = (name) => ci.match(new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|(?![\\s\\S]))`, 'm'))?.[1] ?? '';
const mutationsJob = jobBlock('test-pg-mutations');
const parts = (mutationsJob.match(/^\s+part:\s*\[([^\]]+)\]/m)?.[1] ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean);

// Każdy mutant w dokładnie jednej części, części niepuste, suma = cała lista.
function assertPartition(plan, mutants) {
  const ids = plan.flatMap((part) => part.mutants.map((m) => m.id));
  assert.equal(new Set(ids).size, ids.length, 'mutant w dwóch częściach');
  assert.deepEqual([...ids].sort(), mutants.map((m) => m.id).sort(), 'suma części to wszystkie mutanty');
  for (const [index, part] of plan.entries()) {
    assert.ok(part.mutants.length > 0, `część ${index + 1} bez mutantów`);
    assert.deepEqual(part.files, [...new Set(part.mutants.map((m) => m.test))]);
    assert.equal(part.estimate, estimateSeconds(part.mutants));
  }
}

test('każdy mutant usuwa istniejącą blokadę tylko w swojej funkcji', () => {
  assert.ok(MUTANTS.length >= 10);
  assert.equal(new Set(MUTANTS.map((m) => m.id)).size, MUTANTS.length, 'unikalne id mutantów');
  for (const mutant of MUTANTS) {
    const source = read(mutant.file);
    const { source: mutated, hits } = applyMutant(source, mutant);
    assert.ok(hits > 0, mutant.id);
    assert.notEqual(mutated, source, mutant.id);
    const [start, end] = functionRange(source, mutant.fn);
    // Poza ciałem funkcji nic się nie zmienia.
    assert.equal(mutated.slice(0, start), source.slice(0, start), `${mutant.id}: zmiana przed funkcją`);
    assert.equal(mutated.slice(mutated.length - (source.length - end)), source.slice(end), `${mutant.id}: zmiana po funkcji`);
    if (mutant.kind === 'advisory') {
      assert.doesNotMatch(mutated.slice(start, mutated.length - (source.length - end)), /pg_advisory_xact_lock\(/, `${mutant.id}: blokada usunięta w całości`);
    } else {
      // Znikają dokładnie wskazane blokady (rodzaj, opcjonalnie tabela); pozostałe
      // blokady funkcji i komentarze zostają.
      assert.deepEqual(selectMutantLocks(mutated, mutant), [], `${mutant.id}: blokada usunięta w całości`);
      const inFunction = (text) => scanSource(text, mutant.file).filter((l) => l.fn === mutant.fn).length;
      assert.equal(inFunction(mutated), inFunction(source) - hits, `${mutant.id}: usunięte tylko wskazane blokady`);
    }
  }
});

test('pliki testowe mutantów działają na prawdziwym PostgreSQL (nie PGlite)', () => {
  for (const file of new Set(MUTANTS.map((m) => m.test))) {
    assert.match(read(file), /process\.env\.RD_TEST_PG_URL/, file);
  }
});

test('kontrola pozytywna: nieaktualny mutant (brak funkcji albo blokady) jest błędem, nie „zabitym” mutantem', () => {
  assert.throws(() => applyMutant('async function a() { return 1; }\n', { id: 'x', file: 'x.js', fn: 'a', kind: 'for-update' }), /nieaktualna/);
  assert.throws(() => applyMutant('async function a() {}\n', { id: 'x', file: 'x.js', fn: 'b', kind: 'advisory' }), /brak funkcji/);
  const source = "async function a(tx) { await tx.query('SELECT 1 FROM t WHERE id = $1 FOR UPDATE'); }\nasync function b(tx) { await tx.query('SELECT 1 FROM t FOR UPDATE'); }\n";
  const { source: mutated } = applyMutant(source, { id: 'x', file: 'x.js', fn: 'a', kind: 'for-update' });
  assert.equal(mutated, "async function a(tx) { await tx.query('SELECT 1 FROM t WHERE id = $1'); }\nasync function b(tx) { await tx.query('SELECT 1 FROM t FOR UPDATE'); }\n");
  // Mutant z `table` usuwa tylko blokadę tej tabeli, `for-share` — tylko FOR SHARE; komentarz zostaje.
  const two = [
    'async function c(tx) {',
    '  // FOR UPDATE w komentarzu',
    "  await tx.query('SELECT 1 FROM t WHERE id = $1 FOR UPDATE');",
    "  await tx.query('SELECT 1 FROM u WHERE id = $1 FOR UPDATE');",
    "  await tx.query('SELECT 1 FROM w WHERE id = $1 FOR SHARE');",
    '}',
  ].join('\n');
  assert.equal(applyMutant(two, { id: 'y', file: 'x.js', fn: 'c', kind: 'for-update', table: 'u' }).source,
    two.replace("FROM u WHERE id = $1 FOR UPDATE'", "FROM u WHERE id = $1'"));
  assert.equal(applyMutant(two, { id: 'z', file: 'x.js', fn: 'c', kind: 'for-share' }).source, two.replace(' FOR SHARE', ''));
  assert.throws(() => applyMutant(two, { id: 'q', file: 'x.js', fn: 'c', kind: 'for-update', table: 'brak' }), /nieaktualna/);
});

test('npm run test:pg-mutations uruchamia skrypt, a CI wywołuje go w jobie test-pg-mutations (nie w test-pg-real)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:pg-mutations'], 'node scripts/check-lock-mutations.js');
  assert.match(mutationsJob, /run: npm run test:pg-mutations -- --shard=/);
  // test-pg-real uruchamia tylko testy na PG; mutanty drugi raz w tym jobie przedłużyłyby PR (#111).
  const pgReal = jobBlock('test-pg-real');
  assert.match(pgReal, /run: npm run test:pg-real\s*$/m);
  assert.doesNotMatch(pgReal, /test:pg-mutations|check-lock-mutations/);
});

test('#111: części mutantów i/N są rozłączne, niepuste, a ich suma to wszystkie mutanty (N = 1..8)', () => {
  for (let total = 1; total <= 8; total += 1) {
    const plan = planMutantShards(MUTANTS, total);
    assert.equal(plan.length, total);
    assertPartition(plan, MUTANTS);
    // shardMutants(i, N) to dokładnie część i planu, a plan jest powtarzalny (każdy job liczy ten sam).
    for (let index = 1; index <= total; index += 1) assert.deepEqual(shardMutants(MUTANTS, index, total), plan[index - 1].mutants);
    assert.deepEqual(planMutantShards(MUTANTS, total), plan);
  }
});

test('#111: nowy mutant (także z plikiem testów spoza TEST_SECONDS) trafia do dokładnie jednej części', () => {
  const extra = [
    { id: 'zz-nowy-plik', file: 'src/pg/x.js', fn: 'x', kind: 'for-update', test: 'tests/pg-real-zz-nowy.test.js' },
    { id: 'zz-istniejacy-plik', file: 'src/pg/y.js', fn: 'y', kind: 'for-update', test: MUTANTS[0].test },
  ];
  assert.ok(!Object.hasOwn(TEST_SECONDS, extra[0].test));
  assert.equal(testSeconds(extra[0].test), DEFAULT_TEST_SECONDS);
  for (const total of [1, 3, 4]) assertPartition(planMutantShards([...MUTANTS, ...extra], total), [...MUTANTS, ...extra]);
});

test('#111: części są kolejnymi kawałkami listy pogrupowanej według pliku testów (przebieg bez mutacji powtarza się najwyżej N−1 razy)', () => {
  for (const total of [2, 3, 4]) {
    const plan = planMutantShards(MUTANTS, total);
    const files = new Set(MUTANTS.map((m) => m.test));
    const runs = plan.reduce((sum, part) => sum + part.files.length, 0);
    assert.ok(runs <= files.size + total - 1, `N=${total}: ${runs} przebiegów bez mutacji dla ${files.size} plików`);
  }
});

test('#111: --shard odrzuca zły numer części', () => {
  assert.deepEqual(parseShard('2/3'), { index: 2, total: 3 });
  for (const bad of ['0/3', '4/3', '3', 'a/3', '1/0', '-1/3', '1.5/3', '']) assert.throws(() => parseShard(bad), /Niepoprawna część/, bad);
  assert.throws(() => planMutantShards(MUTANTS.slice(0, 2), 3), /mniej niż części/);
  assert.throws(() => shardMutants(MUTANTS, 4, 3), /niepoprawny numer/);
});

test('#111: CI uruchamia wszystkie części 1..N mutantów, każdą z `--shard=i/N`, a CLI daje rozłączne listy o sumie równej MUTANTS', () => {
  assert.ok(parts.length >= 2, 'brak macierzy `part` w jobie test-pg-mutations');
  assert.deepEqual(parts, parts.map((_, i) => i + 1), 'macierz części bez luk i powtórzeń');
  const command = mutationsJob.match(/run: npm run test:pg-mutations -- --shard=\$\{\{ matrix\.part \}\}\/(\d+)\s*$/m);
  assert.ok(command, 'brak `npm run test:pg-mutations -- --shard=${{ matrix.part }}/N`');
  assert.equal(Number(command[1]), parts.length, 'N w --shard równe rozmiarowi macierzy');
  assert.match(mutationsJob, /fail-fast: false/, 'błąd jednej części nie anuluje pozostałych (pełna lista przeżywających)');
  const listed = [];
  for (const part of parts) {
    const result = spawnSync(process.execPath, ['scripts/check-lock-mutations.js', '--list', `--shard=${part}/${parts.length}`], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const ids = result.stdout.split('\n').filter(Boolean).map((line) => line.split('\t')[0]);
    assert.ok(ids.length > 0, `część ${part} pusta`);
    listed.push(...ids);
  }
  assert.equal(new Set(listed).size, listed.length, 'mutant w dwóch częściach CI');
  assert.deepEqual(listed.sort(), MUTANTS.map((m) => m.id).sort());
  for (const args of [['--list', '--shard=0/3'], ['--list', '--shard=x'], ['--list', '--shard=1/3', MUTANTS[0].id]]) {
    const result = spawnSync(process.execPath, ['scripts/check-lock-mutations.js', ...args], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
  }
});

test('#111: job test-pg-mutations ma własną usługę postgres (ten sam digest co test-pg-real) i RD_TEST_PG_URL, a ci-ok wymaga obu jobów PG', () => {
  const image = (block) => block.match(/^\s+image:\s*(\S+)\s*$/m)?.[1];
  assert.ok(image(mutationsJob), 'brak usługi postgres w test-pg-mutations');
  assert.equal(image(mutationsJob), image(jobBlock('test-pg-real')));
  assert.match(mutationsJob, /RD_TEST_PG_URL: postgres:\/\/[^\s@]+@127\.0\.0\.1:5432\//);
  const okJob = jobBlock('ci-ok');
  const needs = (okJob.match(/needs:\s*\[([^\]]+)\]/)?.[1] ?? '').split(',').map((s) => s.trim());
  for (const job of ['test-pg-real', 'test-pg-mutations']) {
    assert.ok(needs.includes(job), `ci-ok musi wymagać ${job}`);
    assert.match(okJob, new RegExp(`\\[ "\\$\\{\\{ needs\\.${job}\\.result \\}\\}" != "success" \\]`), `ci-ok musi sprawdzać wynik ${job}`);
  }
});

test('#111: najdłuższa szacowana część CI mieści się w 125% średniej (szacunek całości / N)', () => {
  const plan = planMutantShards(MUTANTS, parts.length);
  const longest = Math.max(...plan.map((part) => part.estimate));
  const average = estimateSeconds(MUTANTS) / parts.length;
  assert.ok(longest <= average * 1.25, `najdłuższa część ~${longest.toFixed(0)} s, średnia ${average.toFixed(0)} s`);
});
