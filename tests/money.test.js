// Jeden moduł kwot EUR (#173): parser i formater współdzielony przez panel i serwer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MoneyError, formatEur, parseCentsCell, parseEurInput, parseStatementAmount } from '../panel/money.js';

test('parseEurInput: tabela wejść poprawnych', () => {
  const cases = [
    ['12,5', 1250],
    ['12.50', 1250],
    ['0,01', 1],
    ['1 234,56', 123456],
    ['1.234,56', 123456],
    ['12 345,67 €', 1234567],
    ['12,50 €', 1250],
    ['12,50EUR', 1250],
    ['1000000', 100_000_000],
    ['1000000,00', 100_000_000],
    ['  1234,56  ', 123456],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseEurInput(input), expected, `wejście: ${JSON.stringify(input)}`);
  }
});

test('parseEurInput: tabela wejść odrzuconych (format)', () => {
  const cases = ['1,234', '1e3', '0x10', '-5', '', '   ', '1..2', '1,,2', '12,345', 'abc', '１２３,５６'];
  for (const input of cases) {
    assert.throws(() => parseEurInput(input), MoneyError, `wejście: ${JSON.stringify(input)}`);
    try { parseEurInput(input); assert.fail('powinno rzucić'); } catch (error) {
      assert.equal(error.code, 'invalid_amount_format', `wejście: ${JSON.stringify(input)}`);
    }
  }
});

test('parseEurInput: poza zakresem', () => {
  for (const input of ['0', '1000000,01', '0,00']) {
    try { parseEurInput(input); assert.fail('powinno rzucić'); } catch (error) {
      assert.equal(error.code, 'amount_out_of_range', `wejście: ${JSON.stringify(input)}`);
    }
  }
});

test('parseEurInput: wklejenie kwoty sformatowanej przez formatEur(screen) działa (round-trip)', () => {
  for (const cents of [1, 100, 999, 1000, 123456, 1_234_567, 100_000_000, 79_190_019]) {
    const text = formatEur(cents, { style: 'screen' });
    assert.equal(parseEurInput(text), cents, `round-trip dla ${cents}`);
  }
});

test('parseEurInput: round-trip dla losowej próbki 1..100 000 000 centów', () => {
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let i = 0; i < 500; i += 1) {
    const cents = 1 + Math.floor(next() * 100_000_000);
    const text = formatEur(cents, { style: 'screen' });
    assert.equal(parseEurInput(text), cents, `round-trip dla ${cents} (${text})`);
  }
});

test('parseStatementAmount: znak i ta sama gramatyka', () => {
  assert.equal(parseStatementAmount('-1 234,56'), -123456);
  assert.equal(parseStatementAmount('+40,00'), 4000);
  assert.equal(parseStatementAmount('1.234,56'), 123456);
  assert.equal(parseStatementAmount('12,50 €'), 1250);
  assert.throws(() => parseStatementAmount('1,234'), MoneyError);
});

test('parseCentsCell: tylko cyfry ASCII, bez wykładnika/hex/ułamka', () => {
  assert.equal(parseCentsCell('1500'), 1500);
  assert.equal(parseCentsCell(' 25 '), 25);
  for (const input of ['1e3', '0x10', '25.0', '-5', '1,5', '']) {
    assert.throws(() => parseCentsCell(input), MoneyError, `wejście: ${JSON.stringify(input)}`);
  }
});

test('formatEur: null/brak wartości -> „—”, nigdy „0,00 €”', () => {
  assert.equal(formatEur(null), '—');
  assert.equal(formatEur(undefined), '—');
  assert.equal(formatEur(Number.NaN), '—');
  assert.equal(formatEur('abc'), '—');
});

test('formatEur: ta sama kwota ma ten sam zapis w każdym stylu (grupowanie od 1000)', () => {
  assert.equal(formatEur(123456, { style: 'screen' }), '1 234,56 €');
  assert.equal(formatEur(123456, { style: 'print' }), '1 234,56 EUR');
  assert.equal(formatEur(123456, { style: 'csv' }), '1234,56');
  assert.equal(formatEur(0, { style: 'screen' }), '0,00 €');
  assert.equal(formatEur(-500, { style: 'screen' }), '−5,00 €');
  assert.equal(formatEur(-500, { style: 'csv' }), '-5,00');
});
