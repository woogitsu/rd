// #163: PRODUCT.md/DECISIONS.md (D-08) muszą wymieniać role wpisane na stałe
// w modułach tras — inaczej zarząd zatwierdza macierz, której kod nie
// wdraża. Test statyczny (bez PGlite): dla każdego modułu z listy niżej
// sprawdza, że jego stałe ról (wyodrębnione z pliku źródłowego) mają wpis w
// tabeli „Założenia techniczne obecne w kodzie” w DECISIONS.md (D-08) i w
// macierzy PRODUCT.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const decisions = await readFile(new URL('../docs/DECISIONS.md', import.meta.url), 'utf8');
const product = await readFile(new URL('../docs/PRODUCT.md', import.meta.url), 'utf8');

// Moduł źródłowy -> role wymienione w jego stałych ról (ROLE = [...]).
// Lista ręczna (nie regex nad całym drzewem), żeby test pozostał czytelny i
// żeby nowy moduł wymagał świadomego dopisania tutaj (podobnie jak macierz
// tras w AUTHORIZATION.md wymaga wpisu w route-matrix.js).
const MODULES = [
  { file: 'src/pg/routes/families.js', roles: ['admin', 'board', 'treasurer', 'representative'] },
  { file: 'src/pg/routes/payments.js', roles: ['admin', 'board', 'treasurer'] },
  { file: 'src/pg/routes/ledger.js', roles: ['admin', 'board', 'treasurer'] },
  { file: 'src/pg/routes/ledger-cash.js', roles: ['admin', 'board', 'treasurer'] },
  { file: 'src/pg/routes/email.js', roles: ['board', 'treasurer'] },
  { file: 'src/pg/routes/import.js', roles: ['admin', 'board'] },
  { file: 'src/pg/routes/exports.js', roles: ['admin', 'board'] },
  { file: 'src/pg/routes/year-close.js', roles: ['board', 'treasurer'] },
  { file: 'src/pg/routes/print.js', roles: ['admin', 'board', 'treasurer', 'representative'] },
  { file: 'src/pg/routes/reconciliation.js', roles: ['admin', 'board', 'treasurer', 'audit'] },
  { file: 'src/pg/routes/financial-reports.js', roles: ['board', 'treasurer'] },
];

test('every module in MODULES actually defines the roles this test expects (fixture stays honest)', async () => {
  for (const { file, roles } of MODULES) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const role of roles) {
      assert.match(source, new RegExp(`'${role}'`), `${file} should mention role '${role}' in a role list`);
    }
  }
});

test('DECISIONS.md D-08 lists a code file reference for every module route file', () => {
  const d08 = decisions.slice(decisions.indexOf('### D-08.'), decisions.indexOf('### D-09.'));
  assert.notEqual(d08.indexOf('### D-08.'), -1, 'D-08 section not found');
  for (const { file } of MODULES) {
    assert.ok(d08.includes(file), `D-08 "Założenia techniczne" table should reference ${file}`);
  }
});

test('PRODUCT.md marks the access matrix as unapproved and links AUTHORIZATION.md', () => {
  assert.match(product, /Macierz dostępu/);
  assert.match(product, /D-08\/D-09/);
  assert.match(product, /AUTHORIZATION\.md/);
});

test('AUTHORIZATION.md does not claim the module assigns no default role capabilities', () => {
  // #163 item 7: the old sentence implied nobody has access before a board
  // decision, while every route module hardcodes role constants today.
  return readFile(new URL('../docs/AUTHORIZATION.md', import.meta.url), 'utf8').then((authz) => {
    assert.doesNotMatch(authz, /ten moduł nie przypisuje rolom domyślnych zdolności/i);
  });
});
