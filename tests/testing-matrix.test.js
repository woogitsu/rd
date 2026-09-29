// #211: meta-test macierzy docs/TESTING.md. Statyczny (bez PGlite): tabela musi
// nadążać za testami i za ROUTES, tak jak macierz tras w pg-authz-matrix.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '../src/pg/app.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const doc = readFileSync(new URL('../docs/TESTING.md', import.meta.url), 'utf8');

const SCENARIOS = ['Role', '2 opiekunów', 'Rodzeństwo', 'Wpł. częściowe', 'Podw. kliknięcie', 'Ponowienie', 'Błędny e-mail', 'Korekty'];

function section(title) {
  const start = doc.indexOf(`## ${title}`);
  assert.ok(start >= 0, `brak sekcji „${title}” w docs/TESTING.md`);
  const rest = doc.slice(start + 3);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

function rows(body) {
  return body.split('\n').filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^-+$/.test(cell)))
    .slice(1); // nagłówek
}

const matrix = rows(section('Macierz')).map(([id, modules, ...cells]) => ({
  id, modules: modules.split(',').map((m) => m.trim()), cells: Object.fromEntries(SCENARIOS.map((name, i) => [name, cells[i]])),
}));
const evidence = rows(section('Rejestr dowodów')).map(([row, scenario, file, fragment]) => ({ row, scenario, file, fragment }));

test('macierz: każde pole to ✓, ~, n/d z powodem albo — z odwołaniem do zgłoszenia', () => {
  assert.ok(matrix.length >= 15, 'macierz ma wiersze modułów');
  assert.equal(new Set(matrix.map((row) => row.id)).size, matrix.length, 'unikalne identyfikatory wierszy');
  for (const row of matrix) {
    for (const scenario of SCENARIOS) {
      const cell = row.cells[scenario];
      assert.ok(cell, `${row.id} / ${scenario}: puste pole`);
      const ok = cell === '✓' || /^~ \(.{3,}\)$/.test(cell)
        || /^n\/d \(.{8,}\)$/.test(cell) || /^— \(#\d+\)$/.test(cell);
      assert.ok(ok, `${row.id} / ${scenario}: pole „${cell}” nie ma formy ✓, ~, n/d (powód) ani — (#N)`);
    }
  }
});

test('macierz: każdy moduł z ROUTES ma wiersz i odwrotnie', () => {
  const registered = ROUTES.map((route) => route.name);
  const listed = matrix.flatMap((row) => row.modules);
  assert.equal(new Set(listed).size, listed.length, 'moduł nie może występować w dwóch wierszach');
  for (const name of registered) {
    assert.ok(listed.includes(name), `Moduł tras "${name}" (src/pg/app.js) nie ma wiersza w docs/TESTING.md`);
  }
  for (const name of listed) assert.ok(registered.includes(name), `docs/TESTING.md opisuje moduł "${name}", którego nie ma w ROUTES`);
});

test('macierz: pola ✓ (poza Role) mają dowód, a dowód wskazuje istniejący test', () => {
  const ids = new Set(matrix.map((row) => row.id));
  for (const item of evidence) {
    assert.ok(ids.has(item.row), `dowód dla nieznanego wiersza „${item.row}”`);
    assert.ok(SCENARIOS.includes(item.scenario) && item.scenario !== 'Role', `dowód dla nieznanego scenariusza „${item.scenario}”`);
    assert.ok(existsSync(`${ROOT}${item.file}`), `brak pliku testu ${item.file}`);
    const lines = readFileSync(`${ROOT}${item.file}`, 'utf8').split('\n')
      .filter((line) => /^\s*(test|it)(\.\w+)?\(/.test(line));
    assert.ok(lines.some((line) => line.includes(item.fragment)),
      `${item.file}: brak testu z fragmentem nazwy „${item.fragment}” (wiersz ${item.row} / ${item.scenario})`);
    assert.equal(matrix.find((row) => row.id === item.row).cells[item.scenario] === '✓', true,
      `dowód dla pola ${item.row} / ${item.scenario}, które nie jest oznaczone ✓`);
  }
  for (const row of matrix) {
    for (const scenario of SCENARIOS.filter((name) => name !== 'Role')) {
      if (row.cells[scenario] !== '✓') continue;
      assert.ok(evidence.some((item) => item.row === row.id && item.scenario === scenario),
        `${row.id} / ${scenario}: ✓ bez wpisu w rejestrze dowodów`);
    }
  }
});

test('macierz: kolumna Role opiera się na macierzy uprawnień, która zna każdy moduł wiersza', () => {
  const authz = readFileSync(new URL('./helpers/route-matrix.js', import.meta.url), 'utf8');
  for (const row of matrix) {
    assert.equal(row.cells.Role, '✓', `${row.id}: granice ról muszą być pokryte (tests/pg-authz-matrix.test.js)`);
    for (const name of row.modules) {
      assert.ok(authz.includes(`module: '${name}'`), `${row.id}: moduł "${name}" bez wpisów w tests/helpers/route-matrix.js`);
    }
  }
});
