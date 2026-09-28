// #152: testy jednostkowe wykrywania możliwych danych osobowych.
// Wyłącznie dane syntetyczne (e-maile .invalid, IBAN testowe).
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPossiblePersonalData, hasPossiblePersonalData } from '../src/pg/pii-check.js';

test('wykrywa e-mail (w tym błędny adres rodzica z treści)', () => {
  const result = detectPossiblePersonalData('Proszę o kontakt: rodzic@example.invalid w sprawie składki.');
  assert.deepEqual(result.categories, ['email']);
  assert.equal(result.counts.email, 1);
});

test('wykrywa poprawny IBAN BE i PL (mod-97), odrzuca przypadkowy ciąg cyfr', () => {
  // IBAN-y syntetyczne o poprawnej sumie kontrolnej (test).
  const be = detectPossiblePersonalData('Przelew na BE68 5390 0754 7034.');
  assert.ok(be.categories.includes('iban'), 'poprawny BE powinien być wykryty');
  const pl = detectPossiblePersonalData('Numer PL61 1090 1014 0000 0712 1981 2874.');
  assert.ok(pl.categories.includes('iban'), 'poprawny PL powinien być wykryty');
  const bogus = detectPossiblePersonalData('Faktura BE00 0000 0000 0000 na kwotę.');
  assert.ok(!bogus.categories.includes('iban'), 'zły checksum nie powinien być liczony jako IBAN');
});

test('wykrywa telefon PL/BE, nie myli z dowolną długą liczbą', () => {
  const withPhone = detectPossiblePersonalData('Zadzwoń: +32 470 12 34 56 po godzinie 18.');
  assert.ok(withPhone.categories.includes('phone'));
  const plPhone = detectPossiblePersonalData('Kontakt 0601-234-567 w razie pytań.');
  assert.ok(plPhone.categories.includes('phone'));
  const bareNumber = detectPossiblePersonalData('Kwota referencyjna 1234567890123456.');
  assert.ok(!bareNumber.categories.includes('phone'), 'sam ciąg cyfr bez separatora/prefiksu nie jest telefonem');
});

test('rodzeństwo: "Anna i Piotr Testowy" daje dwa trafienia known_name', () => {
  const knownNames = [
    { firstName: 'Anna', lastName: 'Testowy' },
    { firstName: 'Piotr', lastName: 'Testowy' },
    { firstName: 'Ewa', lastName: 'Inna' },
  ];
  const result = detectPossiblePersonalData('Składka Anna i Piotr Testowy za październik.', { knownNames });
  assert.equal(result.counts.known_name, 2);
  assert.ok(result.categories.includes('known_name'));
});

test('nazwisko identyczne z nazwą ulicy/firmy bez odpowiadającego imienia w tekście nie trafia', () => {
  const knownNames = [{ firstName: 'Jan', lastName: 'Długa' }];
  const result = detectPossiblePersonalData('Faktura za naprawę na ul. Długa 5.', { knownNames });
  assert.equal(result.counts.known_name, 0, 'brak imienia "Jan" w tekście — brak trafienia');
});

test('nazwisko wieloczłonowe (przedrostek) wymaga obu części', () => {
  const knownNames = [{ firstName: 'Piotr', lastName: 'van der Berg' }];
  assert.equal(detectPossiblePersonalData('Rozmowa z Piotrem.', { knownNames }).counts.known_name, 0);
  const result = detectPossiblePersonalData('Rozmowa z Piotr van der Berg wczoraj.', { knownNames });
  assert.equal(result.counts.known_name, 1);
});

test('błędny e-mail w treści (np. rodzic@example.invalid) jest wykrywany jako email (kryterium testów #152)', () => {
  const result = detectPossiblePersonalData('Błędny adres: rodzic@example.invalid, proszę poprawić.');
  assert.ok(result.categories.includes('email'));
});

test('lista nazw nigdy nie wycieka w wyniku — zwracane są tylko kategorie i liczby', () => {
  const knownNames = [{ firstName: 'Anna', lastName: 'Testowa' }];
  const result = detectPossiblePersonalData('Wpłata od Anna Testowa.', { knownNames });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('Anna') && !serialized.includes('Testowa'));
  assert.deepEqual(Object.keys(result).sort(), ['categories', 'counts']);
});

test('hasPossiblePersonalData: skrót bez pełnego wyniku', () => {
  assert.equal(hasPossiblePersonalData('Bez żadnych danych.'), false);
  assert.equal(hasPossiblePersonalData('Kontakt jan@example.invalid'), true);
});

test('tekst bez żadnych danych osobowych nie daje żadnej kategorii', () => {
  const result = detectPossiblePersonalData('Zwrot kosztów za materiały na zajęcia plastyczne.');
  assert.deepEqual(result.categories, []);
});

test('wydajność: sprawdzenie przy ~1000 uczniach mieści się poniżej 50 ms', () => {
  const knownNames = Array.from({ length: 1000 }, (_, i) => ({ firstName: `Imie${i}`, lastName: `Nazwisko${i}` }));
  const text = 'Składka na wycieczkę szkolną dla klasy — bez wymieniania nazwisk uczniów w tym opisie.';
  const start = performance.now();
  detectPossiblePersonalData(text, { knownNames });
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 50, `sprawdzenie trwało ${elapsed.toFixed(1)} ms`);
});
