// Walidacja IBAN mod 97 (#92). Wyłącznie funkcje czyste, dane syntetyczne/przykładowe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatIbanForDisplay, isValidIban, normalizeIban } from '../print/iban.js';

test('isValidIban: znane poprawne przykłady (belgijski i brytyjski)', () => {
  assert.equal(isValidIban('BE68539007547034'), true);
  assert.equal(isValidIban('be68 5390 0754 7034'), true); // małe litery i spacje
  assert.equal(isValidIban('GB82WEST12345698765432'), true);
});

test('isValidIban: literówka w sumie kontrolnej -> false', () => {
  assert.equal(isValidIban('BE69539007547034'), false);
});

test('isValidIban: belgijski IBAN musi mieć dokładnie 16 znaków', () => {
  assert.equal(isValidIban('BE6853900754703'), false); // 15
  assert.equal(isValidIban('BE685390075470344'), false); // 17
});

test('isValidIban: same zera i śmieciowy wejściowy tekst', () => {
  assert.equal(isValidIban('BE00000000000000'), false);
  assert.equal(isValidIban(''), false);
  assert.equal(isValidIban(null), false);
  assert.equal(isValidIban('nie to pole'), false);
});

test('normalizeIban / formatIbanForDisplay', () => {
  assert.equal(normalizeIban(' be68 5390 0754 7034 '), 'BE68539007547034');
  assert.equal(formatIbanForDisplay('BE68539007547034'), 'BE68 5390 0754 7034');
});
