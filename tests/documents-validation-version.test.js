// #89 (0161): wersja reguł kontroli struktury zapisywana przy dokumencie.
// Podgląd pomija ponowną kontrolę pliku sprawdzonego BIEŻĄCĄ wersją, więc każda
// zmiana reguł bez podbicia DOCUMENT_VALIDATION_VERSION osłabiłaby podgląd.
// Test liczy odcisk kodu reguł (między znacznikami w src/documents.js, bez
// komentarzy i pustych linii) i porównuje z odciskiem zapisanym dla bieżącej wersji.
//
// Gdy test pada po zmianie reguł: podbij DOCUMENT_VALIDATION_VERSION w
// src/documents.js i DOPISZ nową parę wersja → odcisk poniżej (starych nie zmieniaj).
// Sama zmiana komentarzy nie zmienia odcisku.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DOCUMENT_VALIDATION_VERSION } from '../src/documents.js';

const RULE_FINGERPRINTS = Object.freeze({
  1: 'bc6c3505a62ce28323b0fb298015f68ff51ca80d62000f0a8fe174dc2005222f',
});

const START = '// --- reguły kontroli struktury: początek';
const END = '// --- reguły kontroli struktury: koniec ---';

function rulesFingerprint(source) {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  assert.ok(start >= 0 && end > start, 'brak znaczników reguł kontroli struktury w src/documents.js');
  assert.equal(source.indexOf(START, start + 1), -1, 'znacznik początku reguł występuje więcej niż raz');
  assert.equal(source.indexOf(END, end + 1), -1, 'znacznik końca reguł występuje więcej niż raz');
  const body = source.slice(source.indexOf('\n', start) + 1, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .join('\n');
  return createHash('sha256').update(body).digest('hex');
}

test('DOCUMENT_VALIDATION_VERSION is a positive integer with a recorded fingerprint (#89)', () => {
  assert.ok(Number.isInteger(DOCUMENT_VALIDATION_VERSION) && DOCUMENT_VALIDATION_VERSION >= 1);
  assert.ok(Object.hasOwn(RULE_FINGERPRINTS, DOCUMENT_VALIDATION_VERSION),
    `brak odcisku dla wersji ${DOCUMENT_VALIDATION_VERSION} — dopisz go w tym teście`);
  const versions = Object.keys(RULE_FINGERPRINTS).map(Number);
  assert.equal(Math.max(...versions), DOCUMENT_VALIDATION_VERSION, 'bieżąca wersja musi być najwyższą zapisaną');
  assert.equal(new Set(Object.values(RULE_FINGERPRINTS)).size, versions.length, 'każda wersja reguł ma inny odcisk');
});

test('validation rules code matches the fingerprint of the current DOCUMENT_VALIDATION_VERSION (#89)', () => {
  const source = readFileSync(new URL('../src/documents.js', import.meta.url), 'utf8');
  assert.equal(rulesFingerprint(source), RULE_FINGERPRINTS[DOCUMENT_VALIDATION_VERSION],
    'reguły kontroli struktury zmieniły się: podbij DOCUMENT_VALIDATION_VERSION i dopisz nowy odcisk');
});

test('fingerprint ignores comments and indentation but not rule changes (#89)', () => {
  const wrap = (body) => `x\n${START} (…) ---\n${body}\n${END}\n`;
  const base = rulesFingerprint(wrap("const KEYS = ['/JS'];"));
  assert.equal(rulesFingerprint(wrap("  // komentarz\n\n    const KEYS = ['/JS'];")), base);
  assert.notEqual(rulesFingerprint(wrap("const KEYS = ['/JS', '/AA'];")), base);
});
