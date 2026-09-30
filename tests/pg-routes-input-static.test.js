// Test statyczny (#154): trasy w src/pg/routes oraz moduły domenowe z własną
// obsługą HTTP (src/pg/events.js, meetings.js, news.js) nie mają własnych kopii
// czytnika ciała JSON, klucza idempotencji, kursora ani isUniqueError —
// korzystają ze wspólnego src/pg/input.js. Wyłącznie dane syntetyczne.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const ROUTES_DIR = new URL('../src/pg/routes/', import.meta.url);
const PG_DIR = new URL('../src/pg/', import.meta.url);
const files = readdirSync(ROUTES_DIR).filter((name) => name.endsWith('.js'));
// Moduły domenowe, które same obsługują żądania HTTP (handle*Request).
const DOMAIN_HTTP_MODULES = ['events.js', 'meetings.js', 'news.js'];
const allSources = [
  ...files.map((file) => ({ file, source: readFileSync(new URL(file, ROUTES_DIR), 'utf8'), importPath: '../input.js' })),
  ...DOMAIN_HTTP_MODULES.map((file) => ({ file, source: readFileSync(new URL(file, PG_DIR), 'utf8'), importPath: './input.js' })),
];

// Trasy z odczytem ciała innym niż „obiekt JSON” (nie są kopią readJson):
// documents.js — multipart/bajty pliku z własną walidacją typu i rozmiaru,
// mfa.js — readCode przyjmuje wyłącznie pole `code`.
const CUSTOM_BODY_READERS = new Set(['documents.js', 'mfa.js']);

test('żadna trasa nie definiuje własnego readJson/readBody/readIdempotencyKey/kursora/isUniqueError', () => {
  const offenders = [];
  for (const { file, source } of allSources) {
    if (/^\s*(?:async\s+)?function\s+(?:readJson\w*|readBody\w*|readIdempotencyKey|encodeCursor|decodeCursor|isUnique\w*)\b/m.test(source)) offenders.push(`${file}: własna funkcja`);
    if (/^\s*(?:const|let)\s+(?:isUnique\w*|encodeCursor|decodeCursor)\b/m.test(source)) offenders.push(`${file}: własna kopia pomocnika`);
    // Naruszenie UNIQUE rozpoznajemy po SQLSTATE 23505, nie po tekście komunikatu.
    if (/duplicate key value/.test(source)) offenders.push(`${file}: dopasowanie tekstu „duplicate key value”`);
  }
  assert.deepEqual(offenders, []);
});

test('trasy czytają ciało wyłącznie przez src/pg/input.js (poza jawnie wyjątkowymi)', () => {
  const offenders = [];
  for (const { file, source } of allSources) {
    if (CUSTOM_BODY_READERS.has(file)) continue;
    if (/\brequest\.(?:text|json|arrayBuffer)\(\)/.test(source)) offenders.push(`${file}: bezpośredni odczyt ciała`);
  }
  assert.deepEqual(offenders, []);
});

test('trasa używająca readJson/readJsonBody/readIdempotencyKey/isUniqueError importuje je z input.js', () => {
  const offenders = [];
  for (const { file, source, importPath } of allSources) {
    const usesReader = /\breadJson(?:Body)?\(/.test(source);
    const usesUnique = /\bisUniqueError\(/.test(source);
    const usesKey = /\breadIdempotencyKey\(/.test(source);
    if (!usesReader && !usesUnique && !usesKey) continue;
    const escaped = importPath.replace(/[.\/]/g, (c) => `\\${c}`);
    const imports = source.match(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${escaped}'`))?.[1] ?? '';
    if (usesReader && !/\bcreateJsonReader\b/.test(imports)) offenders.push(`${file}: brak createJsonReader`);
    if (usesUnique && !/\bisUniqueError\b/.test(imports)) offenders.push(`${file}: brak isUniqueError`);
    if (usesKey && !/\bcreateIdempotencyKeyReader\b/.test(imports)) offenders.push(`${file}: brak createIdempotencyKeyReader`);
  }
  assert.deepEqual(offenders, []);
});
