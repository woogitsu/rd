// Regresja z przeglądu UI przed pokazem dla zarządu: `/print/` pokazywało
// czerwony błąd walidacji („Podaj rok szkolny w formacie 2026/2027. Podaj
// kontakt do Rady.”) zaraz po wejściu na stronę, zanim ktokolwiek cokolwiek
// wpisał — renderPreview() liczyło błędy konfiguracji i wypisywało je do
// #config-error przy pierwszym renderze (wywołanym na końcu main.js).
// Błędy mają się pojawiać dopiero po interakcji z formularzem konfiguracji
// albo po próbie druku. Statyczny przegląd kodu źródłowego (wzorem
// tests/meetings-shared-view.test.js) — zachowanie w przeglądarce sprawdzone
// ręcznie Playwrightem po `npm run build`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainJs = readFileSync(new URL('../print/main.js', import.meta.url), 'utf8');

test('renderPreview() ogłasza błędy configError tylko, gdy formularz konfiguracji został dotknięty', () => {
  assert.match(
    mainJs,
    /if \(state\.configTouched\) \{\s*\n\s*setText\(configError, errors\.join\(" "\)\);\s*\n\s*markInvalid\(errors\);\s*\n\s*\} else \{\s*\n\s*setText\(configError, ""\);\s*\n\s*markInvalid\(\[\]\);\s*\n\s*\}/,
  );
});

test('stan startowy configTouched jest false — pierwszy render (na końcu pliku) nie pokazuje błędu', () => {
  assert.match(
    mainJs,
    /const state = \{\s*\n\s*households: \[\],\s*\n\s*selected: new Set\(\),\s*\n\s*paymentInstructions: null,\s*\n\s*configTouched: false,\s*\n\s*\};/,
  );
  // renderPreview() wywoływane jest raz przy starcie modułu, zanim jakikolwiek
  // event listener mógł ustawić configTouched na true.
  assert.match(mainJs.trimEnd(), /renderPreview\(\);$/);
});

test('interakcja z formularzem konfiguracji ustawia configTouched przed przeliczeniem podglądu', () => {
  assert.match(
    mainJs,
    /configForm\.addEventListener\("input", \(\) => \{\s*\n\s*state\.configTouched = true;\s*\n\s*updateSummary\(\);\s*\n\s*\}\);/,
  );
});

test('próba druku ustawia configTouched, zanim ewentualny błąd zostanie ogłoszony', () => {
  assert.match(
    mainJs,
    /printButton\.addEventListener\("click", \(\) => \{\s*\n\s*state\.configTouched = true;\s*\n\s*if \(!confirmBox\.checked \|\| !state\.selected\.size\) return;\s*\n\s*renderPreview\(\);/,
  );
});

test('błędy konfiguracji nadal blokują podgląd/druk niezależnie od tego, czy są ogłoszone (confirmBox.disabled)', () => {
  // Nie ogłaszać błędu ≠ ignorować go: przycisk potwierdzenia ma zostać
  // zablokowany, dopóki konfiguracja jest niepoprawna, także przed dotknięciem formularza.
  const block = mainJs.slice(mainJs.indexOf('function renderPreview'), mainJs.indexOf('function resetData'));
  assert.match(block, /if \(errors\.length\) \{\s*\n\s*preview\.replaceChildren\(\);\s*\n\s*setText\(previewMessage, "Uzupełnij treść kartki, aby zobaczyć podgląd\."\);\s*\n\s*confirmBox\.disabled = true;/);
});
