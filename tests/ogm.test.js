// Belgijska komunikacja strukturalna OGM-VCS (#83). Wyłącznie funkcje czyste.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCheckDigits, extractStructuredReference, formatStructuredReference,
  generateStructuredReference, isValidStructuredReference, OgmError, randomBase,
} from '../src/pg/ogm.js';

test('computeCheckDigits: mod 97, wynik 0 -> 97', () => {
  // 9700000000 mod 97 === 0 -> suma kontrolna 97
  assert.equal(computeCheckDigits('9700000000'), 97);
  assert.equal(computeCheckDigits('0000000001'), 1);
  assert.equal(computeCheckDigits('0000000000'), 97);
});

test('computeCheckDigits: odrzuca bazę spoza 10 cyfr', () => {
  assert.throws(() => computeCheckDigits('123'), OgmError);
  assert.throws(() => computeCheckDigits('12345678901'), OgmError);
  assert.throws(() => computeCheckDigits('abcdefghij'), OgmError);
});

test('generateStructuredReference: zawsze 12 cyfr z poprawną sumą kontrolną', () => {
  for (let i = 0; i < 200; i += 1) {
    const reference = generateStructuredReference();
    assert.match(reference, /^\d{12}$/);
    assert.equal(isValidStructuredReference(reference), true);
  }
});

test('randomBase: nigdy sama zer, zawsze 10 cyfr', () => {
  for (let i = 0; i < 50; i += 1) {
    const base = randomBase();
    assert.match(base, /^\d{10}$/);
    assert.notEqual(base, '0000000000');
  }
});

test('isValidStructuredReference: literówka w jednej cyfrze psuje sumę kontrolną', () => {
  const reference = generateStructuredReference();
  const digits = reference.split('');
  const flipIndex = 3;
  digits[flipIndex] = String((Number(digits[flipIndex]) + 1) % 10);
  const mutated = digits.join('');
  assert.notEqual(mutated, reference);
  assert.equal(isValidStructuredReference(mutated), false);
});

test('isValidStructuredReference: odrzuca zły kształt', () => {
  assert.equal(isValidStructuredReference('123'), false);
  assert.equal(isValidStructuredReference('12345678901a'), false);
  assert.equal(isValidStructuredReference(null), false);
});

test('formatStructuredReference: +++ddd/dddd/ddddd+++', () => {
  assert.equal(formatStructuredReference('123456789012'), '+++123/4567/89012+++');
  assert.throws(() => formatStructuredReference('123'), OgmError);
});

test('extractStructuredReference: z +++...+++ i z ***...***', () => {
  const reference = generateStructuredReference();
  const formatted = formatStructuredReference(reference);
  assert.equal(extractStructuredReference(`Składka +++${formatted.slice(3)}`), reference);
  assert.equal(extractStructuredReference(formatted), reference);
  const starFormatted = formatted.replaceAll('+++', '***');
  assert.equal(extractStructuredReference(`opis ${starFormatted} rodzina`), reference);
});

test('extractStructuredReference: bare 12 cyfr otoczone tekstem', () => {
  const reference = generateStructuredReference();
  assert.equal(extractStructuredReference(`przelew ${reference} dziekuje`), reference);
});

test('extractStructuredReference: literówka -> brak dopasowania (null)', () => {
  const reference = generateStructuredReference();
  const digits = reference.split('');
  digits[5] = String((Number(digits[5]) + 1) % 10);
  const mutated = digits.join('');
  assert.equal(extractStructuredReference(`przelew ${mutated}`), null);
});

test('extractStructuredReference: brak dowolnej referencji -> null', () => {
  assert.equal(extractStructuredReference('składka na wycieczkę klasową'), null);
  assert.equal(extractStructuredReference(''), null);
  assert.equal(extractStructuredReference(undefined), null);
});

test('extractStructuredReference: dodatkowe słowo w tytule nie przeszkadza (inaczej niż porównanie tekstu #83)', () => {
  const reference = generateStructuredReference();
  const formatted = formatStructuredReference(reference);
  assert.equal(extractStructuredReference(`składka ${formatted} Jan Kowalski`), reference);
});

test('extractStructuredReference: dwie różne referencje w tytule -> null, ta sama powtórzona -> referencja (#83)', () => {
  const first = generateStructuredReference();
  let second = generateStructuredReference();
  while (second === first) second = generateStructuredReference();
  const f1 = formatStructuredReference(first);
  const f2 = formatStructuredReference(second);
  assert.equal(extractStructuredReference(`składka ${f1} i ${f2}`), null);
  assert.equal(extractStructuredReference(`${first} ${second}`), null);
  assert.equal(extractStructuredReference(`${f1} powtórzone ${f1}`), first);
  // Zapis z +++/*** ma pierwszeństwo przed samymi cyframi w dalszej części tytułu.
  assert.equal(extractStructuredReference(`${f1} numer ${second}`), first);
});

test('extractStructuredReference: błędna suma w zapisie z plusami nie blokuje poprawnej referencji obok, ale sama nie wystarcza', () => {
  const reference = generateStructuredReference();
  const broken = reference.slice(0, 10) + String((Number(reference.slice(10)) % 97) + 1).padStart(2, '0');
  assert.equal(isValidStructuredReference(broken), false);
  assert.equal(extractStructuredReference(formatStructuredReference(broken)), null);
  assert.equal(extractStructuredReference(`${formatStructuredReference(broken)} ${formatStructuredReference(reference)}`), reference);
});
