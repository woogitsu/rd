// #208: lista mutantów kontroli mutacyjnej blokad (scripts/check-lock-mutations.js)
// nie może się po cichu zestarzeć. Test statyczny, bez bazy: każdy mutant
// wskazuje istniejącą funkcję, która nadal ma blokadę danego rodzaju, a jego
// plik testowy działa na prawdziwym PostgreSQL (czyta RD_TEST_PG_URL).
// Samo uruchomienie mutantów: `npm run test:pg-mutations` (job test-pg-real w CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MUTANTS, applyMutant, functionRange, selectMutantLocks } from '../scripts/check-lock-mutations.js';
import { scanSource } from '../scripts/lock-inventory.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

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

test('npm run test:pg-mutations uruchamia skrypt, a CI wywołuje go w jobie test-pg-real', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:pg-mutations'], 'node scripts/check-lock-mutations.js');
  const ci = read('.github/workflows/ci.yml');
  const job = ci.slice(ci.indexOf('\n  test-pg-real:'), ci.indexOf('\n  migrations-order:'));
  assert.match(job, /run: npm run test:pg-mutations/);
});
