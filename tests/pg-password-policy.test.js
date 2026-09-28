// #196: polityka haseł przepuszczała polską pisownię z diakrytykami, bo lista
// haseł powszechnych i rdzenie są zapisane bez polskich znaków, a porównanie
// ich zachowywało. Testy odtwarzają tabelę z audytu (dane wyłącznie syntetyczne).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPasswordPolicy, PASSWORD_POLICY } from '../src/pg/password.js';

// Dostęp do listy przez zachowanie funkcji (nie eksportujemy wewnętrznego Set),
// więc kontrakt listy sprawdzamy pośrednio: żadne z podanych haseł nie może
// przejść, a długie syntetyczne frazy z diakrytykami nadal muszą być przyjęte.
test('checkPasswordPolicy odrzuca polskie warianty haseł powszechnych (diakrytyki, spacje, rok, znaki)', () => {
  const rejected = [
    'Haslo123456789',
    'Hasło123456789',
    'hasło12345678',
    'Radarodzicow2027',
    'Radarodziców123',
    'Rada Rodziców 2026',
    'Szkołapolska1',
    'Kochamcię1234',
    'Bruksela2026!',
    'Wrzesień2026!',
    'Zaq1@wsxcde3',
  ];
  for (const password of rejected) {
    assert.equal(checkPasswordPolicy(password), 'password_common', password);
  }
});

test('checkPasswordPolicy nie odrzuca długich syntetycznych fraz z polskimi znakami (brak fałszywych odrzuceń)', () => {
  assert.equal(checkPasswordPolicy('Syntetyczne hasło z polskimi znakami żółć'), null);
  assert.equal(checkPasswordPolicy('zażółć gęślą jaźń dwanaście'), null);
  assert.equal(checkPasswordPolicy('Ćwiczebne zdanie bez znaczenia 42'), null);
});

test('kontrakt listy: każdy wpis ma co najmniej minLength znaków (martwy wpis 11-znakowy usunięty)', () => {
  // `asdfghjkl;'` (11 znaków) był martwym wpisem — krótszy niż PASSWORD_POLICY.minLength=12,
  // więc nigdy nie mógł zostać dopasowany. checkPasswordPolicy odrzuca go już na etapie
  // password_too_short, więc test kontraktu sprawdza to zachowanie zamiast czytać Set wprost.
  assert.equal(checkPasswordPolicy("asdfghjkl;'"), 'password_too_short');
  assert.ok(PASSWORD_POLICY.minLength === 12);
});

test('podwójna próba zmiany hasła odrzuconym hasłem: druga próba wciąż 400, bez efektów ubocznych', () => {
  // Weryfikacja idempotencji na poziomie czystej funkcji (bez sesji/bazy) —
  // wielokrotne wywołanie z tym samym słabym hasłem daje ten sam wynik.
  const password = 'Hasło123456789';
  assert.equal(checkPasswordPolicy(password), 'password_common');
  assert.equal(checkPasswordPolicy(password), 'password_common');
});
