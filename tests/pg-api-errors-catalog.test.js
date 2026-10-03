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
  // #160 etap 6: parser treści kampanii e-mail (ContentError i kody `code: 'invalid_subject'` zwracane
  // przez trasy src/pg/routes/email.js bez zmiany).
  files.push(join(ROOT, 'src/documents.js'), join(ROOT, 'src/storage.js'), join(ROOT, 'src/email/content.js'));
  // Czwarta reguła (#160 etap 4): kod jako ostatni argument helpera długości tekstu trasy,
  // np. text(data.note, 3, 500, 'invalid_note') — wcześniej niewykrywany (invalid_note, invalid_notes); od #160 etapu 7
  // także identyfikator ze ścieżki w module zebrań, np. requireId(meetingId, 'invalid_meeting_id'); od #160 etapu 10
  // odwołanie i liczba w module aktualności, np. reference(input.licenseDocumentRef, 'invalid_license_document_ref')
  // i count(input.identifiableAdults, 'invalid_identifiable_adults').
  // Szósta reguła (#160 etap 10): kod jako drugi element trójki mapowania błędu bazy `['komunikat', 'kod', status]`
  // (DB_ERRORS w src/pg/news.js, np. photo_rights_unverified; tak samo listy mapowań year-close i KR).
  const pattern = /new (?!(?:Error|TypeError|RangeError|EmailTransportError)\b)[A-Z][A-Za-z]*\(\s*(?:\d{3}\s*,\s*)?['"]([a-z][a-z0-9_]*)['"]|\b(?:error|code)\s*[:=]\s*['"]([a-z][a-z0-9_]*)['"]|\[\s*['"]([a-z][a-z0-9_]*)['"]\s*,\s*[1-5]\d\d\s*\]|\b(?:optionalText|text|requireId|reference|count)\([^()]*,\s*['"]([a-z][a-z0-9_]*)['"]\s*\)|\[\s*['"][a-z][a-z0-9_]*['"]\s*,\s*['"]([a-z][a-z0-9_]*)['"]\s*,\s*[1-5]\d\d\s*\]/g;
  // Kody zwracane przez funkcje pomocnicze (`return 'kod'`), których wzorce nie widzą: bramka MFA routera,
  // krok w górę MFA (freshMfaForbiddenCode, src/pg/authorization.js) i odmowa adresu wysyłki testowej
  // (previewRecipientRefusal, src/email/brevo.js; trasa zwraca go jako 403, #160 etap 6); od #160 etapu 11
  // polityka haseł (checkPasswordPolicy, src/pg/password.js: password_too_short, password_common,
  // password_contains_email) i brak czynnika w attemptFactor (src/pg/mfa.js, kod wybierany operatorem `?:`).
  const codes = new Set([
    'mfa_required', 'mfa_enrollment_required', 'mfa_stale', 'preview_recipient_not_allowed',
    'password_too_short', 'password_common', 'password_contains_email', 'mfa_enrollment_not_found', 'mfa_not_enrolled',
  ]);
  // Piąta reguła (#160 etap 7): kody reguł bazy (RAISE EXCEPTION w triggerach), które moduł zebrań przepuszcza
  // bez zmiany jako 409 — lista `DATABASE_CONFLICTS = new Set([...])` w src/pg/meetings.js (np. meeting_locked).
  const conflictList = /\bDATABASE_CONFLICTS\s*=\s*new Set\(\[([^\]]*)\]\)/g;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) codes.add(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]);
    for (const list of text.matchAll(conflictList)) for (const item of list[1].matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)) codes.add(item[1]);
  }
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
