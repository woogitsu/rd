// Kontrola struktury pliku (issue #89): czyste funkcje, syntetyczne bajty.
// Heurystyka na surowych bajtach — nie zastępuje skanu antywirusowego
// (docs/DOCUMENTS.md, sekcja „Ryzyka i ograniczenia”).
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateStructure } from '../src/documents.js';

const encoder = new TextEncoder();

function validPng() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...new Array(13).fill(0), 0, 0, 0, 0,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
  ]);
}

function validJpeg() {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
}

test('poprawny PDF z %%EOF przechodzi kontrolę', () => {
  const bytes = encoder.encode('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n');
  assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: true });
});

test('PDF bez %%EOF w ostatnim 1 KiB jest odrzucony jako uszkodzony', () => {
  const bytes = encoder.encode('%PDF-1.4\n1 0 obj <<>> endobj\n');
  assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: false, code: 'document_malformed' });
});

test('PDF poliglota z danymi ZIP doklejonymi po %%EOF jest odrzucony', () => {
  const pdf = encoder.encode('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n');
  const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // 1 KiB odstępu, tak że %%EOF (koniec PDF-a) nie znajduje się już w ostatnim 1 KiB pliku.
  const padding = new Uint8Array(1200).fill(0x20);
  const bytes = new Uint8Array(pdf.length + padding.length + zip.length);
  bytes.set(pdf, 0);
  bytes.set(padding, pdf.length);
  bytes.set(zip, pdf.length + padding.length);
  assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: false, code: 'document_malformed' });
});

test('PDF z /JavaScript, /Launch, /EmbeddedFile albo /Encrypt jest odrzucony jako aktywna treść', () => {
  for (const key of ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/RichMedia', '/XFA', '/Encrypt']) {
    const bytes = encoder.encode(`%PDF-1.4\n1 0 obj << ${key} 2 0 R >> endobj\n%%EOF\n`);
    assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: false, code: 'document_active_content' }, key);
  }
});

test('słowo kluczowe zaszyte w treści bez ukośnika nie wywołuje fałszywego odrzucenia', () => {
  const bytes = encoder.encode('%PDF-1.4\n1 0 obj (JavaScript bez ukosnika) endobj\n%%EOF\n');
  assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: true });
});

test('poprawny PNG (sygnatura + IHDR + IEND) przechodzi kontrolę', () => {
  assert.deepEqual(validateStructure(validPng(), 'image/png'), { ok: true });
});

test('PNG z danymi doklejonymi po IEND jest odrzucony', () => {
  const png = validPng();
  const bytes = new Uint8Array(png.length + 9);
  bytes.set(png, 0);
  bytes.set(encoder.encode('extradata'), png.length);
  assert.deepEqual(validateStructure(bytes, 'image/png'), { ok: false, code: 'document_malformed' });
});

test('PNG z uciętym łańcuchem chunków jest odrzucony', () => {
  const png = validPng();
  assert.deepEqual(validateStructure(png.subarray(0, png.length - 5), 'image/png'), { ok: false, code: 'document_malformed' });
});

test('poprawny JPEG (FF D9 na końcu) przechodzi kontrolę, z tolerancją na dopełnienie zerami', () => {
  assert.deepEqual(validateStructure(validJpeg(), 'image/jpeg'), { ok: true });
  const padded = new Uint8Array([...validJpeg(), 0, 0, 0]);
  assert.deepEqual(validateStructure(padded, 'image/jpeg'), { ok: true });
});

test('JPEG bez FF D9 na końcu (dane doklejone po znaczniku) jest odrzucony', () => {
  const bytes = new Uint8Array([...validJpeg(), 0x41, 0x42]);
  assert.deepEqual(validateStructure(bytes, 'image/jpeg'), { ok: false, code: 'document_malformed' });
});

test('typ spoza dozwolonej trójki jest zawsze odrzucony', () => {
  assert.deepEqual(validateStructure(encoder.encode('x'), 'text/csv'), { ok: false, code: 'document_malformed' });
  assert.deepEqual(validateStructure('not bytes', 'application/pdf'), { ok: false, code: 'document_malformed' });
});
