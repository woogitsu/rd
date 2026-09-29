// Demo (przegląd 2): /print/ — rok i klasa jako listy wyboru zamiast pól z identyfikatorem,
// jeden format roku na kartce (2026/2027) wyprowadzany z wybranego roku (2026-2027).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildHouseholds, canLoadAllClasses, cardCountLabel, normalizeConfig, previewBlockedMessage, renderCardsHtml,
  schoolYearCardLabel, studentClassLabel,
} from '../print/core.js';

const mainJs = readFileSync(new URL('../print/main.js', import.meta.url), 'utf8');

test('schoolYearCardLabel zamienia identyfikator roku na format kartki i odrzuca inne kształty', () => {
  assert.equal(schoolYearCardLabel('2026-2027'), '2026/2027');
  assert.equal(schoolYearCardLabel(' 2025-2026 '), '2025/2026');
  for (const bad of ['', null, undefined, '2026/2027', '26-27', 'rok']) assert.equal(schoolYearCardLabel(bad), '');
});

test('wynik schoolYearCardLabel przechodzi walidację treści kartki', () => {
  const { errors } = normalizeConfig({ councilName: 'Rada', contact: 'rada@example.invalid', schoolYear: schoolYearCardLabel('2026-2027') });
  assert.deepEqual(errors, []);
});

test('createApiControls tworzy listy select (rok, klasa), bez pól tekstowych z identyfikatorem', () => {
  const body = mainJs.slice(mainJs.indexOf('function createApiControls()'), mainJs.indexOf('// Pole „Rok szkolny”'));
  assert.match(body, /document\.createElement\("select"\)/);
  assert.doesNotMatch(body, /input\.type = "text"|placeholder/);
  assert.doesNotMatch(mainJs, /Podaj identyfikator roku szkolnego/);
});

test('lata z /api/access (fillYearSelect), klasy z /api/classes dla wybranego roku', () => {
  assert.match(mainJs, /apiRequest\("\/api\/access"/);
  assert.match(mainJs, /fillYearSelect\(api\.yearInput, grants\)/);
  assert.match(mainJs, /apiRequest\(`\/api\/classes\?\$\{params\}`/);
  assert.match(mainJs, /api\.yearInput\.addEventListener\("change"/);
});

test('pole roku treści kartki jest wypełniane z wybranego roku tylko przed ręczną edycją formularza', () => {
  assert.match(mainJs, /function syncCardYear\(\) \{\s*\n\s*if \(state\.configTouched\) return;/);
});

// Przegląd demo 3 (docs/DEMO.md, krok 7).
test('cardCountLabel odmienia liczbę kartek po polsku', () => {
  assert.equal(cardCountLabel(1), '1 kartka');
  for (const n of [2, 3, 4, 22, 24, 102]) assert.equal(cardCountLabel(n), `${n} kartki`);
  for (const n of [0, 5, 11, 12, 13, 14, 20, 25, 112]) assert.equal(cardCountLabel(n), `${n} kartek`);
  assert.match(mainJs, /Podgląd: \$\{cardCountLabel\(result\.count\)\}\./);
  assert.doesNotMatch(mainJs, /\$\{result\.count\} kartek/);
});

test('studentClassLabel nie dubluje słowa „klasa” przy nazwie klasy z serwera', () => {
  assert.equal(studentClassLabel('Klasa 0-A (dane przykładowe)'), 'Klasa 0-A (dane przykładowe)');
  assert.equal(studentClassLabel('klasa 2b'), 'klasa 2b');
  assert.equal(studentClassLabel('1a'), 'klasa 1a');
  assert.equal(studentClassLabel(''), '');
  const { households } = buildHouseholds([
    { householdId: 'h-1', name: 'Uczeń Przykładowy', className: 'Klasa 0-A' },
    { householdId: 'h-1', name: 'Rodzeństwo Przykładowe', className: '3b' },
  ]);
  const { html } = renderCardsHtml(households, ['h-1'], {
    councilName: 'Rada Rodziców', schoolYear: '2026/2027', contact: 'dyżur Rady (dane przykładowe)',
  });
  assert.match(html, /Uczeń Przykładowy, Klasa 0-A</);
  assert.match(html, /Rodzeństwo Przykładowe, klasa 3b</);
  assert.doesNotMatch(html, /klasa Klasa/);
});

test('podgląd przy niepełnej treści kartki wskazuje brakujące pole (np. Kontakt), bez czerwonego błędu w kroku 1', () => {
  const { errors } = normalizeConfig({ councilName: 'Rada Rodziców', schoolYear: '2026/2027', contact: '' });
  assert.deepEqual(errors, ['Podaj kontakt do Rady.']);
  assert.equal(previewBlockedMessage(errors), 'Uzupełnij treść kartki w kroku 1, aby zobaczyć podgląd. Podaj kontakt do Rady.');
  assert.equal(previewBlockedMessage([]), 'Uzupełnij treść kartki w kroku 1, aby zobaczyć podgląd.');
});

test('„Wszystkie klasy (zarząd)” tylko dla roli finansowej bez ograniczenia do klasy (jak printScope)', () => {
  assert.equal(canLoadAllClasses([{ role: 'board', schoolYearId: '2026-2027', classId: null }], '2026-2027'), true);
  assert.equal(canLoadAllClasses([{ role: 'admin', schoolYearId: null, classId: null }], '2026-2027'), true);
  assert.equal(canLoadAllClasses([{ role: 'treasurer', schoolYearId: '2025-2026', classId: null }], '2026-2027'), false);
  assert.equal(canLoadAllClasses([{ role: 'representative', schoolYearId: '2026-2027', classId: 'c0001' }], '2026-2027'), false);
  assert.equal(canLoadAllClasses([{ role: 'treasurer', schoolYearId: '2026-2027', classId: 'c0001' }], '2026-2027'), false);
  assert.equal(canLoadAllClasses([], '2026-2027'), false);
  assert.equal(canLoadAllClasses(undefined), false);
  const body = mainJs.slice(mainJs.indexOf('async function loadClassOptions()'), mainJs.indexOf('async function initApiControls()'));
  assert.match(body, /canLoadAllClasses\(accessGrants, schoolYearId\)/);
  assert.doesNotMatch(mainJs, /Podaj identyfikator swojej klasy/);
});
