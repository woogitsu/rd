import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeCsvBytes, detectDelimiter, parseCsvMatrix } from '../import/csv.js';
import { parseStatementCsv } from '../src/pg/routes/reconciliation.js';

// #77: wspólny parser CSV także dla wyciągu bankowego. Wyłącznie dane syntetyczne.
const CP1250 = { ą: 0xB9, ć: 0xE6, ę: 0xEA, ł: 0xB3, ń: 0xF1, ó: 0xF3, ś: 0x9C, ź: 0x9F, ż: 0xBF, Ł: 0xA3, Ś: 0x8C };
const CP1252 = { é: 0xE9, è: 0xE8, ë: 0xEB };
const encode = (text, table) => Uint8Array.from([...text].map((c) => (c.codePointAt(0) < 0x80 ? c.codePointAt(0) : table[c])));
const utf16le = (text) => Uint8Array.from([0xFF, 0xFE, ...[...text].flatMap((c) => [c.charCodeAt(0) & 0xFF, c.charCodeAt(0) >> 8])]);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

const STATEMENT = 'data;kwota;tytuł\n2026-01-15;150,00;Składka Łukasz Świątek\n11.02.2026;"1 234,50";"Opis; z średnikiem"\n';
const EXPECTED = [
  { bookedOn: '2026-01-15', amountCents: 15000, reference: 'Składka Łukasz Świątek' },
  { bookedOn: '2026-02-11', amountCents: 123450, reference: 'Opis; z średnikiem' },
];

test('wyciąg: te same pozycje po odczycie UTF-8, UTF-8 z BOM, Windows-1250 i UTF-16 LE', () => {
  const inputs = [
    new TextEncoder().encode(STATEMENT),
    Uint8Array.from([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode(STATEMENT)]),
    encode(STATEMENT, CP1250),
    utf16le(STATEMENT),
  ];
  for (const bytes of inputs) assert.deepEqual(parseStatementCsv(decodeCsvBytes(bytes).text), EXPECTED);
});

test('wyciąg: tabulator jako separator, przecinek dziesiętny i CRLF', () => {
  assert.deepEqual(parseStatementCsv('data\tkwota\ttytuł\r\n2026-03-01\t12,50\t"Tytuł; z średnikiem, i przecinkiem"\r\n'), [
    { bookedOn: '2026-03-01', amountCents: 1250, reference: 'Tytuł; z średnikiem, i przecinkiem' },
  ]);
});

test('wyciąg: nagłówek z separatorem w cudzysłowie nie myli wykrycia', () => {
  // Trzy średniki w cudzysłowie nie mogą przesądzić o separatorze; kolumny są rozdzielone przecinkiem.
  assert.deepEqual(parseStatementCsv('date,amount,"uwagi;;;"\n2026-04-01,5.00,x\n'), [
    { bookedOn: '2026-04-01', amountCents: 500, reference: null },
  ]);
  assert.equal(detectDelimiter('"a;b;c",d,e\n').delimiter, ',');
});

test('wyciąg: remis separatorów i znak zastępczy dają jasny kod błędu, nie zgadywanie', () => {
  assert.equal(code(() => parseStatementCsv('date;amount,reference\n2026-01-01;1,00;x\n')), 'ambiguous_csv_delimiter');
  assert.equal(code(() => parseStatementCsv('date;amount;reference\n2026-01-01;1,00;Ma�gorzata\n')), 'invalid_csv_encoding');
  assert.equal(code(() => parseStatementCsv('date;amount;reference\n2026-01-01;1,00;"niezamknięty\n')), 'invalid_csv');
});

test('parseCsvMatrix: RFC 4180 (cudzysłów w polu, CRLF, puste linie) i limit wierszy', () => {
  assert.deepEqual(parseCsvMatrix('a;b\r\n"x ""y"" z";"l1\nl2"\r\n\r\n'), [['a', 'b'], ['x "y" z', 'l1\nl2']]);
  assert.throws(() => parseCsvMatrix('a\n1\n2\n', { maxRows: 2, limitMessage: 'Limit.' }), /Limit\./);
});

test('FR/NL: é, è, ë w Windows-1252 — automat ostrzega, ręczny wybór odczytuje poprawnie', () => {
  const bytes = encode('data;kwota;tytul\n2026-01-15;10,00;Zoë Hélène Renée Michèle\n', CP1252);
  const auto = decodeCsvBytes(bytes);
  assert.equal(auto.encoding, 'windows-1250');
  assert.ok(auto.warnings.length > 0, 'brak ostrzeżenia o możliwym Windows-1252');
  const manual = decodeCsvBytes(bytes, { encoding: 'windows-1252' });
  assert.equal(manual.text, 'data;kwota;tytul\n2026-01-15;10,00;Zoë Hélène Renée Michèle\n');
  assert.deepEqual(parseStatementCsv(manual.text)[0].reference, 'Zoë Hélène Renée Michèle');
});

test('wyciąg: ręcznie wybrany separator rozstrzyga remis; nieznany separator to invalid_request', () => {
  const tie = 'data;kwota;tytuł,uwagi,x\n2026-09-14;7,00;Żółw, ślimak\n';
  assert.equal(code(() => parseStatementCsv(tie)), 'ambiguous_csv_delimiter');
  assert.deepEqual(parseStatementCsv(tie, { delimiter: ';' }), [{ bookedOn: '2026-09-14', amountCents: 700, reference: null }]);
  assert.deepEqual(parseStatementCsv('data\tkwota\ttytuł\n2026-09-15\t1,00\t"a;b,c"\n', { delimiter: '\t' }), [
    { bookedOn: '2026-09-15', amountCents: 100, reference: 'a;b,c' },
  ]);
  for (const delimiter of ['|', 'tab', '', 1, null]) {
    assert.equal(code(() => parseStatementCsv('date,amount\n2026-09-01,1.00\n', { delimiter })), 'invalid_request');
  }
});
