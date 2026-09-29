// Demo (przegląd 2): /print/ — rok i klasa jako listy wyboru zamiast pól z identyfikatorem,
// jeden format roku na kartce (2026/2027) wyprowadzany z wybranego roku (2026-2027).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeConfig, schoolYearCardLabel } from '../print/core.js';

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
