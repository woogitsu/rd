// Katalog kodów błędów API (issue #160): docs/API_ERRORS.md musi wypisywać
// każdy kod zwracany przez src/pg/** (bez martwych wpisów, których źródło
// już nie zwraca). Wyłącznie dane syntetyczne — ten test nie dotyka danych.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Ta sama reguła wykrywania kodów co tests/shared-api.test.js#serverErrorCodes —
// jedno źródło prawdy dla „jakie kody istnieją w src/pg”.
function serverErrorCodes() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith('.js')) files.push(path);
    }
  };
  walk(join(ROOT, 'src/pg'));
  files.push(join(ROOT, 'src/documents.js'), join(ROOT, 'src/storage.js'));
  // Czwarta reguła (#160 etap 4): kod jako ostatni argument helpera długości tekstu trasy,
  // np. text(data.note, 3, 500, 'invalid_note') — wcześniej niewykrywany (invalid_note, invalid_notes).
  const pattern = /new (?!(?:Error|TypeError|RangeError|EmailTransportError)\b)[A-Z][A-Za-z]*\(\s*(?:\d{3}\s*,\s*)?['"]([a-z][a-z0-9_]*)['"]|\b(?:error|code)\s*[:=]\s*['"]([a-z][a-z0-9_]*)['"]|\[\s*['"]([a-z][a-z0-9_]*)['"]\s*,\s*[1-5]\d\d\s*\]|\b(?:optionalText|text)\([^()]*,\s*['"]([a-z][a-z0-9_]*)['"]\s*\)/g;
  const codes = new Set(['mfa_required', 'mfa_enrollment_required']);
  for (const file of files) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) codes.add(match[1] ?? match[2] ?? match[3] ?? match[4]);
  return [...codes].sort();
}

function catalogCodes() {
  const text = readFileSync(join(ROOT, 'docs/API_ERRORS.md'), 'utf8');
  const codes = new Set();
  for (const match of text.matchAll(/^\| `([a-z][a-z0-9_]*)` \|/gm)) codes.add(match[1]);
  return codes;
}

test('docs/API_ERRORS.md wypisuje każdy kod błędu zwracany przez src/pg/**', () => {
  const sourceCodes = serverErrorCodes();
  const catalog = catalogCodes();
  assert.ok(sourceCodes.length > 150, `za mało kodów wykrytych w źródle: ${sourceCodes.length}`);
  const missing = sourceCodes.filter((code) => !catalog.has(code));
  assert.deepEqual(missing, [], 'kody bez wpisu w katalogu');
});

test('docs/API_ERRORS.md nie ma martwych wpisów (kod, którego źródło już nie zwraca)', () => {
  const sourceCodes = new Set(serverErrorCodes());
  const stale = [...catalogCodes()].filter((code) => !sourceCodes.has(code));
  assert.deepEqual(stale, [], 'wpisy katalogu bez odpowiadającego kodu w źródle');
});

test('tabela „Polityka 403 i 404 per moduł” zgadza się z x-rd-deny-status w docs/openapi.json', () => {
  const doc = readFileSync(join(ROOT, 'docs/API_ERRORS.md'), 'utf8');
  const section = doc.split('## Polityka 403 i 404 per moduł')[1]?.split(/^## /m)[0] ?? '';
  const documented = new Map();
  for (const match of section.matchAll(/^\| ([a-z][a-z-]*) \| ([^|]+) \|$/gm)) {
    documented.set(match[1], match[2].trim() === '—' ? '' : match[2].trim());
  }
  assert.ok(documented.size > 0, 'brak tabeli polityki 403/404');
  const spec = JSON.parse(readFileSync(join(ROOT, 'docs/openapi.json'), 'utf8'));
  const actual = new Map();
  for (const item of Object.values(spec.paths)) {
    for (const op of Object.values(item)) {
      const statuses = op['x-rd-deny-status'];
      if (!Array.isArray(statuses)) continue;
      const set = actual.get(op.tags[0]) ?? new Set();
      for (const status of statuses) set.add(status);
      actual.set(op.tags[0], set);
    }
  }
  const expected = new Map([...actual].map(([module, set]) => [module, [...set].sort((a, b) => a - b).join(', ')]));
  assert.deepEqual(Object.fromEntries([...documented].sort()), Object.fromEntries([...expected].sort()));
});
