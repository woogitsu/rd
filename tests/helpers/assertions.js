// Pomocniki asercji odporne na „przejście na pusto” (#214).
//
// `assert.ok(rows.every(...))` przechodzi także dla pustej tablicy — np. gdy
// logger przestaje pisać na console.error albo zapytanie nic nie zwraca. Te
// pomocniki wymagają, by sprawdzana kolekcja NIE była pusta (albo miała
// dokładną/minimalną liczbę elementów).
import assert from 'node:assert/strict';

// Kolekcja przechwyconych wpisów (logi, wiadomości, wiersze) musi mieć
// co najmniej `min` elementów albo dokładnie `exact`. Zwraca kolekcję.
export function assertCaptured(items, { min = 1, exact, message } = {}) {
  assert.ok(Array.isArray(items), 'assertCaptured: oczekiwano tablicy');
  if (exact !== undefined) {
    assert.equal(items.length, exact, message ?? `oczekiwano dokładnie ${exact} przechwyconych wpisów, jest ${items.length}`);
  } else {
    assert.ok(items.length >= min, message ?? `oczekiwano co najmniej ${min} przechwyconych wpisów, jest ${items.length}`);
  }
  return items;
}

// Każdy element spełnia predykat ORAZ kolekcja nie jest pusta (lub ma
// `min`/`exact` elementów).
export function assertEvery(items, predicate, message, options = {}) {
  const list = Array.from(items);
  assertCaptured(list, { ...options, message: options.message ?? `${message ?? 'assertEvery'}: pusta kolekcja nie dowodzi zachowania` });
  const offending = list.findIndex((item, index) => !predicate(item, index));
  assert.equal(offending, -1, `${message ?? 'assertEvery'}: element #${offending} nie spełnia warunku: ${JSON.stringify(list[offending])}`);
}

// Syntetyczny numer telefonu używany w testach bramki danych osobowych
// (+32 470 12 34 56) w dowolnym zapisie. Asercja „metadane nie zawierają
// telefonu” musi szukać CAŁEGO numeru: krótki podciąg (np. '470') trafia też
// w losowy UUID lub skrót w metadanych i daje niestabilny wynik (#214, #548).
export const SYNTHETIC_PHONE_IN_TEXT = /(?:\+?32[\s./-]?)?470[\s./-]?12[\s./-]?34[\s./-]?56/;
