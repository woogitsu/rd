// Kontrola redefinicji funkcji triggerów gubiących gałęzie (issue #79).
// Dane wyłącznie syntetyczne (nazwy tabel/funkcji testowe).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFunctionRedefinitions, runCheck } from '../scripts/check-function-redefinitions.js';

function dispatchFn(name, tables) {
  const branches = tables.map((table, i) => `${i === 0 ? 'IF' : 'ELSIF'} TG_TABLE_NAME = '${table}' THEN NULL;`).join('\n  ');
  return `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  ${branches}\n  END IF;\nRETURN NEW;\nEND $$;`;
}

test('checkFunctionRedefinitions: reprodukuje błąd 0036/0038 — druga wersja gubi gałąź pierwszej', () => {
  const migrations = [
    { name: '0036_first.sql', sql: dispatchFn('year_freeze_via_parent', ['ledger_entries', 'bank_reconciliation_matches']) },
    { name: '0038_second.sql', sql: dispatchFn('year_freeze_via_parent', ['ledger_entries', 'payment_refunds']) },
  ];
  const problems = checkFunctionRedefinitions(migrations);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /year_freeze_via_parent/);
  assert.match(problems[0], /bank_reconciliation_matches/);
  assert.match(problems[0], /0038_second\.sql/);
  assert.match(problems[0], /0036_first\.sql/);
});

test('checkFunctionRedefinitions: naprawa (0049) obejmująca sumę gałęzi przechodzi', () => {
  const migrations = [
    { name: '0036_first.sql', sql: dispatchFn('year_freeze_via_parent', ['ledger_entries', 'bank_reconciliation_matches']) },
    { name: '0038_second.sql', sql: dispatchFn('year_freeze_via_parent', ['ledger_entries', 'payment_refunds']) },
    { name: '0049_union.sql', sql: dispatchFn('year_freeze_via_parent', ['ledger_entries', 'bank_reconciliation_matches', 'payment_refunds']) },
  ];
  assert.deepEqual(checkFunctionRedefinitions(migrations), []);
});

test('checkFunctionRedefinitions: naprawa dopisana PRZED kolizją (niższy numer) nie liczy się — musi być ostatnia', () => {
  // Gdyby "naprawa" miała numer niższy niż 0038, na świeżej bazie 0038 i tak
  // nadpisałby ją jako ostatni — test pilnuje, że kolejność liczy się wg numeru pliku.
  const migrations = [
    { name: '0036_first.sql', sql: dispatchFn('year_freeze_via_parent', ['ledger_entries', 'bank_reconciliation_matches']) },
    { name: '0037_early_union.sql', sql: dispatchFn('year_freeze_via_parent', ['ledger_entries', 'bank_reconciliation_matches', 'payment_refunds']) },
    { name: '0038_second.sql', sql: dispatchFn('year_freeze_via_parent', ['ledger_entries', 'payment_refunds']) },
  ];
  const problems = checkFunctionRedefinitions(migrations);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /0038_second\.sql/);
  assert.match(problems[0], /bank_reconciliation_matches/);
});

test('checkFunctionRedefinitions: funkcja zdefiniowana raz — brak problemu', () => {
  const migrations = [{ name: '0022_first.sql', sql: dispatchFn('role_grant_year_freeze', ['role_grants']) }];
  assert.deepEqual(checkFunctionRedefinitions(migrations), []);
});

test('checkFunctionRedefinitions: funkcje bez dyspozycji po TG_TABLE_NAME są pomijane (nie każda redefinicja to błąd)', () => {
  const migrations = [
    { name: '0038_a.sql', sql: `CREATE OR REPLACE FUNCTION payment_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\nEND $$;` },
    { name: '0039_b.sql', sql: `CREATE OR REPLACE FUNCTION payment_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN NEW;\nEND $$;` },
  ];
  assert.deepEqual(checkFunctionRedefinitions(migrations), []);
});

test('checkFunctionRedefinitions: kolejność podana wywołującemu decyduje o tym, co jest "wcześniejsze" (kontrakt: kolejność nakładania)', () => {
  // Ta sama para w odwrotnej kolejności listy: ostatni wpis to teraz ten węższy — gubi 'y'.
  const migrations = [
    { name: 'b.sql', sql: dispatchFn('f', ['x', 'y']) },
    { name: 'a.sql', sql: dispatchFn('f', ['x']) },
  ];
  assert.equal(checkFunctionRedefinitions(migrations).length, 1);
});

test('runCheck: prawdziwe migracje repozytorium (po naprawie #279/0049) przechodzą bez naruszeń', async () => {
  const problems = await runCheck();
  assert.deepEqual(problems, []);
});
