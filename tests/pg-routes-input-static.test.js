// Test statyczny (#154): trasy w src/pg/routes nie mają własnych kopii czytnika
// ciała JSON ani isUniqueError — korzystają ze wspólnego src/pg/input.js.
// Wyłącznie dane syntetyczne.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const ROUTES_DIR = new URL('../src/pg/routes/', import.meta.url);
const files = readdirSync(ROUTES_DIR).filter((name) => name.endsWith('.js'));

// Trasy z odczytem ciała innym niż „obiekt JSON” (nie są kopią readJson):
// documents.js — multipart/bajty pliku z własną walidacją typu i rozmiaru,
// mfa.js — readCode przyjmuje wyłącznie pole `code`.
const CUSTOM_BODY_READERS = new Set(['documents.js', 'mfa.js']);

test('żadna trasa nie definiuje własnego readJson/readBody/isUniqueError', () => {
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, ROUTES_DIR), 'utf8');
    if (/^\s*(?:async\s+)?function\s+(?:readJson\w*|readBody\w*|isUniqueError)\b/m.test(source)) offenders.push(`${file}: własna funkcja`);
    if (/^\s*(?:const|let)\s+(?:isUniqueError)\b/m.test(source)) offenders.push(`${file}: własne isUniqueError`);
  }
  assert.deepEqual(offenders, []);
});

test('trasy czytają ciało wyłącznie przez src/pg/input.js (poza jawnie wyjątkowymi)', () => {
  const offenders = [];
  for (const file of files) {
    if (CUSTOM_BODY_READERS.has(file)) continue;
    const source = readFileSync(new URL(file, ROUTES_DIR), 'utf8');
    if (/\brequest\.(?:text|json|arrayBuffer)\(\)/.test(source)) offenders.push(`${file}: bezpośredni odczyt ciała`);
  }
  assert.deepEqual(offenders, []);
});

test('trasa używająca readJson/readJsonBody/isUniqueError importuje je z ../input.js', () => {
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, ROUTES_DIR), 'utf8');
    const usesReader = /\breadJson(?:Body)?\(/.test(source);
    const usesUnique = /\bisUniqueError\(/.test(source);
    if (!usesReader && !usesUnique) continue;
    const imports = source.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/input\.js'/)?.[1] ?? '';
    if (usesReader && !/\bcreateJsonReader\b/.test(imports)) offenders.push(`${file}: brak createJsonReader`);
    if (usesUnique && !/\bisUniqueError\b/.test(imports)) offenders.push(`${file}: brak isUniqueError`);
  }
  assert.deepEqual(offenders, []);
});
