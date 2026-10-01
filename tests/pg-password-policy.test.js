// #196: polityka haseł przepuszczała polską pisownię z diakrytykami, bo lista
// haseł powszechnych i rdzenie są zapisane bez polskich znaków, a porównanie
// ich zachowywało. Testy odtwarzają tabelę z audytu (dane wyłącznie syntetyczne).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPasswordPolicy, contextStems, passwordPolicyLists, PASSWORD_POLICY } from '../src/pg/password.js';

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

// Ta sama normalizacja co w checkPasswordPolicy (foldLatin + compact) — test
// kontraktu nie może polegać na funkcji, którą sprawdza.
const fold = (value) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L');
const compact = (value) => fold(value.normalize('NFKC').toLowerCase()).replace(/[\s\-_.!@#$%^&*]+/g, '');

test('kontrakt listy: każdy wpis ≥ minLength, bez polskich znaków, bez duplikatów po normalizacji, odrzucany', () => {
  const { commonPasswords } = passwordPolicyLists();
  assert.ok(commonPasswords.length >= 70, `lista za krótka: ${commonPasswords.length}`);
  for (const entry of commonPasswords) {
    // `asdfghjkl;'` (11 znaków) był martwym wpisem — krótszy niż minLength nigdy nie trafi.
    assert.ok([...entry].length >= PASSWORD_POLICY.minLength, `martwy wpis (za krótki): ${entry}`);
    assert.ok([...entry].length <= PASSWORD_POLICY.maxLength, entry);
    assert.equal(entry, fold(entry).toLowerCase(), `wpis musi być zapisany bez polskich znaków i małymi literami: ${entry}`);
    assert.equal(checkPasswordPolicy(entry), 'password_common', entry);
    assert.equal(checkPasswordPolicy(entry.toUpperCase()), 'password_common', `wielkie litery: ${entry}`);
  }
  const normalized = commonPasswords.map(compact);
  const duplicates = normalized.filter((value, index) => normalized.indexOf(value) !== index);
  assert.deepEqual(duplicates, [], 'duplikaty po zdjęciu diakrytyków i separatorów');
});

test('kontrakt rdzeni: tylko litery a–z (inaczej rdzeń jest martwy), bez duplikatów', () => {
  const { commonStems } = passwordPolicyLists();
  for (const stem of commonStems) assert.match(stem, /^[a-z]+$/, `martwy rdzeń: ${stem}`);
  assert.equal(new Set(commonStems).size, commonStems.length);
  // Dawne martwe rdzenie `passw0rd`/`zaq12wsx` — teraz łapane.
  assert.equal(checkPasswordPolicy('Passw0rd2026!'), 'password_common');
  assert.equal(checkPasswordPolicy('Zaq12wsx1234'), 'password_common');
  assert.equal(checkPasswordPolicy("asdfghjkl;'"), 'password_too_short');
});

test('rdzenie Rady i miesiące PL/FR/NL + rok/cyfry/spacje → password_common', () => {
  for (const password of [
    'Styczeń2026!!', 'Październik 2026', 'Grudzień 2025!', 'Składka2026!!', 'Rada123456789', 'Rodzice 2026!!',
    'Szkoła 2026-2027', 'Septembre2026', 'Février 2026!', 'Décembre 2026', 'Oktober 2026!!', 'Augustus2026!',
    'Bruxelles2026', 'Belgique 2026!', 'Maj 2026 12345', 'rada rada 2026',
  ]) {
    assert.equal(checkPasswordPolicy(password), 'password_common', password);
  }
});

test('rdzenie nie odrzucają fraz, w których poza słowem są inne litery (brak fałszywych odrzuceń)', () => {
  for (const password of [
    'Wrzesień to piękny miesiąc', 'kwiecień plecień bo przeplata', 'Rada Rodziców zbiera się w środę',
    'Składka na wycieczkę klasy 3b', 'Oktober in Brussel is koud', 'Mai à Bruxelles sous la pluie',
  ]) {
    assert.equal(checkPasswordPolicy(password), null, password);
  }
});

test('kontekstowe rdzenie z konfiguracji PASSWORD_CONTEXT_STEMS (nazwa szkoły, gmina)', () => {
  const env = { PASSWORD_CONTEXT_STEMS: 'Szkoła Przykładowa, Uccle, , xy' };
  assert.deepEqual(contextStems(env), ['szkolaprzykladowa', 'uccle'], 'litery bez diakrytyków, krótkie/puste pominięte');
  assert.equal(checkPasswordPolicy('Uccle2026!!!!', { env }), 'password_common');
  assert.equal(checkPasswordPolicy('Szkoła Przykładowa 2026', { env }), 'password_common');
  assert.equal(checkPasswordPolicy('Uccle w deszczowy wtorek', { env }), null, 'fraza z nazwą, ale nie sam rdzeń');
  // Bez konfiguracji te same hasła przechodzą — nazwy lokalne nie są w kodzie.
  assert.deepEqual(contextStems({ PASSWORD_CONTEXT_STEMS: '' }), []);
  assert.equal(checkPasswordPolicy('Uccle2026!!!!', { env: { PASSWORD_CONTEXT_STEMS: '' } }), null);
});

test('porównanie z adresem e-mail po zdjęciu diakrytyków', () => {
  const email = 'jan.kowalski@example.invalid';
  assert.equal(checkPasswordPolicy('Jan.Kówalski2026', { email }), 'password_contains_email');
  assert.equal(checkPasswordPolicy('moje jań.kowalski@example.invalid', { email }), 'password_contains_email');
  assert.equal(checkPasswordPolicy('Syntetyczne hasło z polskimi znakami żółć', { email }), null);
});

test('porównanie z listą jest szybkie (Set, lista ładowana raz na proces)', () => {
  const started = process.hrtime.bigint();
  for (let index = 0; index < 1000; index += 1) checkPasswordPolicy(`Syntetyczna fraza numer ${index} żółć`);
  const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 1000;
  assert.ok(perCallMs < 5, `średnio ${perCallMs} ms na wywołanie`);
});

test('podwójna próba zmiany hasła odrzuconym hasłem: druga próba wciąż 400, bez efektów ubocznych', () => {
  // Weryfikacja idempotencji na poziomie czystej funkcji (bez sesji/bazy) —
  // wielokrotne wywołanie z tym samym słabym hasłem daje ten sam wynik.
  const password = 'Hasło123456789';
  assert.equal(checkPasswordPolicy(password), 'password_common');
  assert.equal(checkPasswordPolicy(password), 'password_common');
});

test('lista z wycieków (#196): plik w repo, wpisy w postaci porównawczej, warianty polskie i wielkość liter odrzucane', () => {
  const text = readFileSync(new URL('../src/pg/data/weak-passwords.txt', import.meta.url), 'utf8');
  const entries = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  assert.ok(entries.length >= 100, `lista z wycieków za krótka: ${entries.length}`);
  const { commonPasswords } = passwordPolicyLists();
  for (const entry of entries) {
    assert.equal(entry, compact(entry), `wpis nie jest w postaci porównawczej: ${entry}`);
    assert.ok(commonPasswords.includes(entry), `wpis nie został załadowany: ${entry}`);
  }
  assert.equal(checkPasswordPolicy('Kocham Cię Bardzo'), 'password_common');
  assert.equal(checkPasswordPolicy('MojeHasło12345'), 'password_common');
  assert.equal(checkPasswordPolicy('Tajne-Hasło-1234'), 'password_common');
  assert.equal(checkPasswordPolicy('Syntetyczne hasło z polskimi znakami żółć'), null);
});
