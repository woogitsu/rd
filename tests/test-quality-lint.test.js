// Lint jakości testów (#214). Zielone CI ma coś znaczyć, więc pilnujemy wzorców,
// które pozwalają przejść regresji: asercje bez treści, pętle asercji na pustych
// danych, `todo`/`skip` bez uzasadnienia, mocki bazy ignorujące SQL i zdania
// o zależności testów od kolejności. Każda reguła ma kontrolę pozytywną (kod,
// który reguła MUSI wykryć), więc sam lint nie przechodzi „na pusto”.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertCaptured, assertEvery } from './helpers/assertions.js';

const TESTS_DIR = new URL('./', import.meta.url);

// Pliki, w których `assert.ok(x.every(...))` jest zakazane (użyj assertEvery —
// wymaga niepustej kolekcji). Lista z #214; dopisuj kolejne pliki po przeglądzie.
const EVERY_STRICT = [
  'auth.test.js', 'pg-auth.test.js', 'pg-email.test.js', 'pg-ledger-api.test.js',
  'pg-payments-api.test.js', 'pg-reconciliation.test.js',
];
// Pliki, w których wolno używać opcji `todo` testu (pilnowane osobnym meta-testem
// ALLOWED_TODO w pg-authz-matrix.test.js). Bezwarunkowy `skip` jest zakazany
// wszędzie; dozwolony jest tylko skip warunkowy ze zmiennej (np. brak
// RD_TEST_PG_URL), bo wtedy test nie znika po cichu przy pełnej konfiguracji.
const TODO_ALLOWED = new Set(['pg-authz-matrix.test.js']);

// Zwraca listę naruszeń { rule, line } dla treści pliku.
export function lintSource(name, text) {
  const violations = [];
  const lines = text.split('\n');
  const flag = (rule, index) => violations.push({ rule, line: index + 1, text: lines[index].trim() });
  lines.forEach((line, index) => {
    if (/^\s*\/\//.test(line)) return;
    if (/\bassert(?:\.ok|\.equal|\.strictEqual)?\(\s*true\s*(?:,\s*true\s*)?[,)]/.test(line)) flag('assert-true-literal', index);
    if (/\bassert\.(?:equal|strictEqual|deepEqual)\(\s*(true|false|null|0|1)\s*,\s*\1\s*[,)]/.test(line)) flag('assert-literal-equals-itself', index);
    if (/\.forEach\(\s*\(?[\w\s,]*\)?\s*=>\s*\{\s*\}\s*\)/.test(line)) flag('empty-foreach', index);
    if (/for\s*\([^)]*\)\s*\{\s*\}/.test(line)) flag('empty-for-loop', index);
    if (/assert\.ok\(.*\.every\(/.test(line) && EVERY_STRICT.includes(name)) flag('every-without-nonempty', index);
    if (/\{\s*todo\b|\.todo\(/.test(line) && !TODO_ALLOWED.has(name)) flag('todo-not-allowed', index);
    if (/\{\s*skip:\s*(?:true|['"`])|\.skip\(/.test(line)) flag('unconditional-skip', index);
    if (/first:\s*async\s*\(\)\s*=>\s*(?:session|row|result|user)\b/.test(line)) flag('db-mock-ignores-sql', index);
    if (/kolejność ma znaczenie/i.test(line)) flag('order-dependent-tests', index);
  });
  return violations;
}

test('lint testów: reguły wykrywają wzorce zakazane (kontrola pozytywna)', () => {
  const cases = [
    ['x.test.js', 'assert.ok(true);', 'assert-true-literal'],
    ['x.test.js', 'assert.equal(true, true);', 'assert-literal-equals-itself'],
    ['x.test.js', 'items.forEach(() => {});', 'empty-foreach'],
    ['x.test.js', 'for (const row of rows) {}', 'empty-for-loop'],
    ['pg-email.test.js', 'assert.ok(rows.every((row) => row.ok));', 'every-without-nonempty'],
    ['x.test.js', "test('a', { todo: 'później' }, () => {});", 'todo-not-allowed'],
    ['x.test.js', "test.skip('a', () => {});", 'unconditional-skip'],
    ['x.test.js', "test('a', { skip: true }, () => {});", 'unconditional-skip'],
    ['x.test.js', 'const statement = { first: async () => session };', 'db-mock-ignores-sql'],
    ['x.test.js', '// Testy wykonują się po kolei; kolejność ma znaczenie.\nconst x = "kolejność ma znaczenie";', 'order-dependent-tests'],
  ];
  for (const [name, source, rule] of cases) {
    assert.ok(lintSource(name, source).some((violation) => violation.rule === rule), `reguła ${rule} musi wykryć: ${source}`);
  }
  // Ten sam kod w pliku spoza listy nie łamie reguły „every”, a poprawne wzorce przechodzą.
  assert.deepEqual(lintSource('x.test.js', 'assert.ok(rows.every((row) => row.ok));'), []);
  assert.deepEqual(lintSource('x.test.js', "test('a', { skip }, () => {});"), [], 'skip warunkowy ze zmiennej jest dozwolony');
  assert.deepEqual(lintSource('pg-authz-matrix.test.js', "test('a', { todo: 'x' }, () => {});"), []);
  assert.deepEqual(lintSource('pg-email.test.js', 'assertEvery(rows, (row) => row.ok);\nassert.equal(rows.length, 3);'), []);
});

test('lint testów: pliki testów nie łamią reguł jakości', async () => {
  const names = (await readdir(TESTS_DIR)).filter((name) => name.endsWith('.test.js') && name !== 'test-quality-lint.test.js');
  assertCaptured(names, { min: 50, message: 'lint musi objąć pliki testów (katalog tests/)' });
  const problems = [];
  for (const name of names) {
    const text = await readFile(new URL(name, TESTS_DIR), 'utf8');
    for (const violation of lintSource(name, text)) problems.push(`${name}:${violation.line} [${violation.rule}] ${violation.text}`);
  }
  assert.deepEqual(problems, []);
});

test('pomocniki assertEvery/assertCaptured nie przechodzą na pustych danych (kontrola pozytywna)', () => {
  assert.throws(() => assertEvery([], () => true, 'pusta'), /pusta kolekcja/);
  assert.throws(() => assertEvery([1, 2, 3], (n) => n < 3, 'za duże'), /nie spełnia warunku/);
  assert.throws(() => assertCaptured([]), /co najmniej 1/);
  assert.throws(() => assertCaptured([1], { exact: 2 }), /dokładnie 2/);
  assert.doesNotThrow(() => assertEvery([1, 2], (n) => n > 0));
  assert.deepEqual(assertCaptured(['a'], { exact: 1 }), ['a']);
});

// Detektor „bez danych osobowych w logach”: logger piszący adres e-mail MUSI go oblać.
test('detektor danych osobowych w logach oblewa, gdy logger zapisuje adres e-mail (kontrola pozytywna)', () => {
  const noEmails = (lines) => assertEvery(lines, (line) => !line.includes('@'), 'logi bez adresów e-mail');
  assert.doesNotThrow(() => noEmails(['awaria zapisu audytu']));
  assert.throws(() => noEmails(['awaria dla rodzic@example.invalid']), /nie spełnia warunku/);
  assert.throws(() => noEmails([]), /pusta kolekcja/, 'brak przechwyconych logów nie może uchodzić za dowód');
});

// Pułapka na sieć działa globalnie (tests/setup.js): próba użycia sieci oblewa
// proces nawet wtedy, gdy test połknął wyjątek pułapki; pętla zwrotna jest wolna.
test('tests/setup.js: próba fetch poza pętlą zwrotną oblewa przebieg, nawet po połknięciu wyjątku', () => {
  const setup = fileURLToPath(new URL('setup.js', TESTS_DIR));
  const run = (code) => spawnSync(process.execPath, ['--import', setup, '--input-type=module', '-e', code], { encoding: 'utf8' });

  const swallowed = run("try { await fetch('https://example.invalid/x'); } catch {}");
  assert.equal(swallowed.status, 1, swallowed.stderr);
  assert.match(swallowed.stderr, /network_forbidden_in_tests/);

  const thrown = run("await fetch('https://example.invalid/x').then(() => process.exit(3), (e) => { console.log(e.message); });");
  assert.match(thrown.stdout, /network_forbidden_in_tests/);

  const loopback = run("const { createServer } = await import('node:http'); const s = createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', async () => { const res = await fetch(`http://127.0.0.1:${s.address().port}/`); console.log(await res.text()); s.close(); });");
  assert.equal(loopback.status, 0, loopback.stderr);
  assert.equal(loopback.stdout.trim(), 'ok');

  const env = run("console.log(process.env.APP_ENV)");
  assert.equal(env.stdout.trim(), process.env.APP_ENV || 'test');
});
