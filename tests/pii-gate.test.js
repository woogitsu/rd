// #152: wspólna bramka pól wolnego tekstu — wariant zachowawczy.
// Dane wyłącznie syntetyczne (e-maile .invalid, IBAN testowe).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXEMPT_FIELDS, FORBIDDEN_CATEGORIES, GATED_FIELDS, PersonalDataError, gateFreeText, piiAuditMetadata,
} from '../src/pg/pii-gate.js';
import { SYNTHETIC_PHONE_IN_TEXT } from './helpers/assertions.js';

const FIELD = 'payment_corrections.reason';

test('tekst bez danych osobowych przechodzi, bez metadanych audytu', () => {
  const gate = gateFreeText([[FIELD, 'Zwrot kosztów materiałów plastycznych']], {});
  assert.deepEqual(gate, { piiConfirmed: false, piiCategories: [] });
  assert.deepEqual(piiAuditMetadata(gate), {});
});

test('puste i brakujące wartości są pomijane', () => {
  assert.doesNotThrow(() => gateFreeText([[FIELD, null], [FIELD, undefined], [FIELD, '']], {}));
});

test('e-mail, IBAN i numer rejestru krajowego: odrzucenie bez obejścia, także z potwierdzeniem', () => {
  const samples = {
    email: 'Kontakt rodzic@example.invalid',
    iban: 'Zwrot na BE68 5390 0754 7034',
    national_id: 'RRN 85.07.30-033.28',
  };
  assert.deepEqual([...FORBIDDEN_CATEGORIES].sort(), ['email', 'iban', 'national_id']);
  for (const [category, text] of Object.entries(samples)) {
    for (const confirm of [false, true]) {
      assert.throws(() => gateFreeText([[FIELD, text]], { confirm }), (error) => {
        assert.ok(error instanceof PersonalDataError);
        assert.equal(error.code, 'personal_data_forbidden');
        assert.equal(error.status, 422);
        assert.ok(error.categories.includes(category), `${category} (confirm=${confirm})`);
        // Bez treści: komunikat i kategorie nie zawierają fragmentu tekstu.
        assert.ok(!JSON.stringify([error.message, error.categories]).includes('example.invalid'));
        return true;
      });
    }
  }
});

test('telefon i znane imię: 422 possible_personal_data, po potwierdzeniu zapis z metadanymi bez treści', () => {
  const knownNames = [{ firstName: 'Anna', lastName: 'Testowa' }];
  const text = 'Zwrot dla Anna Testowa, tel. +32 470 12 34 56';
  assert.throws(() => gateFreeText([[FIELD, text]], { knownNames }), (error) => {
    assert.equal(error.code, 'possible_personal_data');
    assert.deepEqual(new Set(error.categories), new Set(['phone', 'known_name']));
    return true;
  });
  const gate = gateFreeText([[FIELD, text]], { knownNames, confirm: true });
  assert.equal(gate.piiConfirmed, true);
  assert.deepEqual(new Set(gate.piiCategories), new Set(['phone', 'known_name']));
  const metadata = piiAuditMetadata(gate);
  assert.ok(!JSON.stringify(metadata).includes('Anna') && !SYNTHETIC_PHONE_IN_TEXT.test(JSON.stringify(metadata)));
});

test('kategoria jednoznaczna wygrywa z potwierdzeniem, gdy w tekście jest też telefon', () => {
  assert.throws(
    () => gateFreeText([[FIELD, 'mail a@example.invalid, tel +32 470 12 34 56']], { confirm: true }),
    { code: 'personal_data_forbidden' },
  );
});

test('kilka pól naraz: trafienie w którymkolwiek blokuje zapis', () => {
  assert.throws(() => gateFreeText([
    ['ledger_entries.description', 'Zakup papieru'],
    ['ledger_corrections.reason', 'zwrot dla x@example.invalid'],
  ], {}), { code: 'personal_data_forbidden' });
});

test('własna fabryka błędu modułu jest używana (kod, kategorie)', () => {
  class Custom extends Error {}
  assert.throws(() => gateFreeText([[FIELD, 'a@example.invalid']], { fail: (code, categories) => Object.assign(new Custom(code), { categories }) }), Custom);
});

test('nieznane pole jest błędem programisty (bramka wymaga pola z rejestru)', () => {
  assert.throws(() => gateFreeText([['nie.istnieje', 'tekst']], {}), /pii_gate_unknown_field/);
});

test('rejestr: pola bramkowane i wyłączone nie nakładają się, wyłączenia mają uzasadnienie', () => {
  for (const key of Object.keys(EXEMPT_FIELDS)) {
    assert.ok(!GATED_FIELDS.includes(key), `${key} jest jednocześnie bramkowane i wyłączone`);
    assert.ok(EXEMPT_FIELDS[key].length >= 20, `${key}: brak uzasadnienia`);
  }
  assert.equal(new Set(GATED_FIELDS).size, GATED_FIELDS.length, 'duplikaty w GATED_FIELDS');
});
