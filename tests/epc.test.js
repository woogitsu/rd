// Ładunek kodu QR EPC / SEPA QR (EPC069-12), issue #92. Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEpcPayload, EpcError, MAX_EPC_BYTES } from '../print/epc.js';

const IBAN = 'BE68539007547034';
const REF = '123456789002'; // suma kontrolna: 1234567890 mod 97 = 2

function lines(payload) {
  return payload.split('\n');
}

test('buildEpcPayload: pola i kolejność zgodne z EPC069-12', () => {
  const payload = buildEpcPayload({ iban: IBAN, name: 'Rada Rodziców', structuredReference: REF });
  const parts = lines(payload);
  assert.equal(parts.length, 12);
  assert.deepEqual(parts.slice(0, 4), ['BCD', '002', '1', 'SCT']);
  assert.equal(parts[4], ''); // BIC opcjonalny
  assert.equal(parts[5], 'Rada Rodziców');
  assert.equal(parts[6], IBAN);
  assert.equal(parts[7], ''); // kwota pusta domyślnie — składka dobrowolna
  assert.equal(parts[8], ''); // cel
  assert.equal(parts[9], REF);
  assert.equal(parts[10], ''); // tytuł niestrukturalny pusty, bo jest referencja
  assert.equal(parts[11], '');
});

test('buildEpcPayload: kwota pusta, chyba że jawnie podana (Rada może zdecydować inaczej)', () => {
  const withoutAmount = buildEpcPayload({ iban: IBAN, name: 'Test', structuredReference: REF });
  assert.equal(lines(withoutAmount)[7], '');
  const withAmount = buildEpcPayload({ iban: IBAN, name: 'Test', structuredReference: REF, amountCents: 1235 });
  assert.equal(lines(withAmount)[7], 'EUR12.35');
});

test('buildEpcPayload: BIC ustawiany, gdy podany', () => {
  const payload = buildEpcPayload({ iban: IBAN, bic: 'GEBABEBB', name: 'Test', structuredReference: REF });
  assert.equal(lines(payload)[4], 'GEBABEBB');
});

test('buildEpcPayload: referencja strukturalna XOR tytuł niestrukturalny', () => {
  const withText = buildEpcPayload({ iban: IBAN, name: 'Test', unstructuredText: 'Składka 2026/2027' });
  assert.equal(lines(withText)[9], '');
  assert.equal(lines(withText)[10], 'Składka 2026/2027');
  assert.throws(() => buildEpcPayload({
    iban: IBAN, name: 'Test', structuredReference: REF, unstructuredText: 'oba naraz',
  }), EpcError);
});

test('buildEpcPayload: odrzuca niepoprawny IBAN', () => {
  assert.throws(() => buildEpcPayload({ iban: 'BE00000000000000', name: 'Test' }), /invalid_iban/);
});

test('buildEpcPayload: nazwa odbiorcy 70 znaków OK, 71 odrzucone', () => {
  const name70 = 'Ą'.repeat(70);
  assert.doesNotThrow(() => buildEpcPayload({ iban: IBAN, name: name70, structuredReference: REF }));
  const name71 = 'Ą'.repeat(71);
  assert.throws(() => buildEpcPayload({ iban: IBAN, name: name71, structuredReference: REF }), /invalid_name/);
});

test('buildEpcPayload: tytuł niestrukturalny 140 znaków OK, 141 odrzucone', () => {
  const text140 = 'x'.repeat(140);
  assert.doesNotThrow(() => buildEpcPayload({ iban: IBAN, name: 'Test', unstructuredText: text140 }));
  const text141 = 'x'.repeat(141);
  assert.throws(() => buildEpcPayload({ iban: IBAN, name: 'Test', unstructuredText: text141 }), /invalid_unstructured_text/);
});

test('buildEpcPayload: referencja strukturalna musi mieć poprawny kształt (12 cyfr)', () => {
  assert.throws(() => buildEpcPayload({ iban: IBAN, name: 'Test', structuredReference: '123' }), /invalid_structured_reference/);
});

test('buildEpcPayload: limit 331 bajtów (nazwa i info maksymalne razem)', () => {
  const name70 = 'Rada Rodziców przy Szkole Polskiej im. Bardzo Długiej Nazwy Testowej.'.slice(0, 70);
  const info70 = 'x'.repeat(70);
  const payload = buildEpcPayload({
    iban: IBAN, bic: 'GEBABEBB', name: name70, structuredReference: REF, info: info70,
  });
  assert.ok(new TextEncoder().encode(payload).byteLength <= MAX_EPC_BYTES);
});

test('buildEpcPayload: koniec linii \\n, brak CRLF', () => {
  const payload = buildEpcPayload({ iban: IBAN, name: 'Test', structuredReference: REF });
  assert.equal(payload.includes('\r'), false);
  assert.equal(payload.split('\n').length, 12);
});
