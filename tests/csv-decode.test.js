import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeCsvBytes, describeSource, detectDelimiter } from '../import/csv.js';
import { parseCsv } from '../import/core.js';
import { buildHouseholds, parseInputBytes } from '../print/core.js';

// Wyłącznie sztuczne dane. Kodery pomocnicze dla polskich znaków (TextEncoder zna tylko UTF-8).
const CP1250 = { ą: 0xB9, ć: 0xE6, ę: 0xEA, ł: 0xB3, ń: 0xF1, ó: 0xF3, ś: 0x9C, ź: 0x9F, ż: 0xBF,
  Ą: 0xA5, Ć: 0xC6, Ę: 0xCA, Ł: 0xA3, Ń: 0xD1, Ó: 0xD3, Ś: 0x8C, Ź: 0x8F, Ż: 0xAF };
const ISO_8859_2 = { ...CP1250, ą: 0xB1, ś: 0xB6, ź: 0xBC, Ą: 0xA1, Ś: 0xA6, Ź: 0xAC };
const CP1252 = { é: 0xE9, è: 0xE8, ë: 0xEB, à: 0xE0 };
function encodeSingleByte(text, table) {
  return Uint8Array.from([...text].map((char) => {
    const code = char.codePointAt(0);
    if (code < 0x80) return code;
    if (!(char in table)) throw new Error(`brak znaku ${char} w tabeli testowej`);
    return table[char];
  }));
}
const utf8 = (text) => new TextEncoder().encode(text);
const withBom = (bytes) => Uint8Array.from([0xEF, 0xBB, 0xBF, ...bytes]);
function utf16le(text, bom = true) {
  const out = bom ? [0xFF, 0xFE] : [];
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out.push(c & 0xFF, c >> 8); }
  return Uint8Array.from(out);
}

const LETTERS = 'ąćęłńóśźż ĄĆĘŁŃÓŚŹŻ';
const CSV = [
  'ID rodziny;Imię ucznia;Nazwisko ucznia;Klasa',
  'H-1;Łucja;Źdźbło-Żółć;3a',
  'H-1;Ścibor;Źdźbło-Żółć;5b',
  `H-2;Test;${LETTERS.replace(' ', '')};1c`,
].join('\r\n');

test('koder pomocniczy Windows-1250 zgadza się z TextDecoder', () => {
  assert.equal(new TextDecoder('windows-1250').decode(encodeSingleByte(LETTERS, CP1250)), LETTERS);
  assert.equal(new TextDecoder('iso-8859-2').decode(encodeSingleByte(LETTERS, ISO_8859_2)), LETTERS);
});

test('UTF-8 z BOM: BOM usunięty, kodowanie opisane', () => {
  const result = decodeCsvBytes(withBom(utf8(CSV)));
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.bom, true);
  assert.equal(result.text, CSV);
  assert.deepEqual(result.warnings, []);
  assert.equal(describeSource(result, detectDelimiter(result.text)), 'UTF-8 z BOM, średnik');
});

test('UTF-8 bez BOM przyjmuje ArrayBuffer i widok bajtów', () => {
  const bytes = utf8(CSV);
  const fromBuffer = decodeCsvBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(fromBuffer.encoding, 'utf-8');
  assert.equal(fromBuffer.bom, false);
  assert.equal(fromBuffer.text, CSV);
  assert.equal(decodeCsvBytes(new DataView(bytes.buffer)).text, CSV);
});

test('Windows-1250 (Excel PL): wszystkie polskie litery bez utraty, bez ostrzeżeń', () => {
  const result = decodeCsvBytes(encodeSingleByte(CSV, CP1250));
  assert.equal(result.encoding, 'windows-1250');
  assert.equal(result.label, 'Windows-1250 (Excel PL)');
  assert.equal(result.text, CSV);
  assert.deepEqual(result.warnings, []);
  assert.doesNotMatch(result.text, /\uFFFD/);
});

test('ta sama macierz z UTF-8, UTF-8 z BOM, Windows-1250 i UTF-16 LE', () => {
  const expected = parseCsv(CSV);
  for (const bytes of [utf8(CSV), withBom(utf8(CSV)), encodeSingleByte(CSV, CP1250), utf16le(CSV)]) {
    assert.deepEqual(parseCsv(decodeCsvBytes(bytes).text), expected);
  }
  assert.equal(decodeCsvBytes(utf16le(CSV)).encoding, 'utf-16le');
  assert.equal(expected[1][2], 'Źdźbło-Żółć');
});

test('pomyłka ISO-8859-2: odczyt jako Windows-1250 daje ostrzeżenie, nie cichy wynik', () => {
  const result = decodeCsvBytes(encodeSingleByte('Nazwisko\nŚląska\nŹrebiąt', ISO_8859_2));
  assert.equal(result.encoding, 'windows-1250');
  assert.notEqual(result.text, 'Nazwisko\nŚląska\nŹrebiąt');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /ISO-8859-2/);
});

test('plik Windows-1252 (Excel BE/FR): ostrzeżenie i poprawny odczyt po ręcznym wyborze', () => {
  const bytes = encodeSingleByte('Nom;Classe\nMichèle Lefèvre;3a', CP1252);
  const auto = decodeCsvBytes(bytes);
  assert.equal(auto.encoding, 'windows-1250');
  assert.ok(auto.warnings.some((w) => /Windows-1252/.test(w)));
  const manual = decodeCsvBytes(bytes, { encoding: 'windows-1252' });
  assert.equal(manual.text, 'Nom;Classe\nMichèle Lefèvre;3a');
  assert.deepEqual(manual.warnings, []);
});

test('nierozpoznane bajty, UTF-16 bez BOM i zły ręczny wybór kończą się czytelnym błędem', () => {
  assert.throws(() => decodeCsvBytes(Uint8Array.from([0x41, 0x81, 0x42])), /nieznane kodowanie/);
  assert.throws(() => decodeCsvBytes(utf16le('Imię;Klasa', false)), /nieznane kodowanie/);
  assert.throws(() => decodeCsvBytes(encodeSingleByte(CSV, CP1250), { encoding: 'utf-8' }), /nie jest zapisany w kodowaniu UTF-8/);
  assert.throws(() => decodeCsvBytes(utf8('x'), { encoding: 'koi8-r' }), /Nieznane kodowanie/);
  assert.throws(() => decodeCsvBytes('tekst'), /Nie udało się odczytać/);
});

test('separator: znaki w cudzysłowie nie są liczone', () => {
  assert.equal(detectDelimiter('"Nazwisko; imię; drugie",Klasa\n"A;B",1a').delimiter, ',');
  assert.equal(detectDelimiter('"Nazwisko, imię";Klasa;E-mail').delimiter, ';');
  assert.equal(detectDelimiter('\uFEFF"Imię"\t"Klasa"\t"E-mail"').delimiter, '\t');
  assert.equal(detectDelimiter('\r\n\r\nImię;Klasa\n1,2,3,4,5').delimiter, ';');
  assert.deepEqual(detectDelimiter('Imię'), { delimiter: ',', label: 'przecinek', tie: false });
  const tie = detectDelimiter('a;b,c');
  assert.equal(tie.tie, true);
  assert.match(describeSource({ label: 'UTF-8' }, tie), /niejednoznaczny/);
});

test('parseCsv rozpoznaje tabulator (eksport „Tekst Unicode”) i przecinek z ; w cudzysłowie', () => {
  assert.deepEqual(parseCsv('Imię\tKlasa\r\n"Ala; Maria"\t1A\r\n'), [['Imię', 'Klasa'], ['Ala; Maria', '1A']]);
  assert.deepEqual(parseCsv('"Nazwisko; imię",Klasa\n"Nowak; Ala",1A'), [['Nazwisko; imię', 'Klasa'], ['Nowak; Ala', '1A']]);
  const tsv = 'Imię\tNazwisko\tKlasa\r\nŻaneta\tŁęcka\t2b';
  assert.deepEqual(parseCsv(decodeCsvBytes(utf16le(tsv)).text), [['Imię', 'Nazwisko', 'Klasa'], ['Żaneta', 'Łęcka', '2b']]);
});

test('druk: plik Windows-1250 daje poprawne nazwiska, rodzeństwo na jednej kartce', () => {
  for (const bytes of [utf8(CSV), withBom(utf8(CSV)), encodeSingleByte(CSV, CP1250), utf16le(CSV)]) {
    const parsed = parseInputBytes(bytes, 'lista.csv');
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.source.delimiter.delimiter, ';');
    const h1 = buildHouseholds(parsed.rows).households.find((h) => h.householdId === 'H-1');
    assert.deepEqual(h1.students.map((s) => s.name), ['Łucja Źdźbło-Żółć', 'Ścibor Źdźbło-Żółć']);
  }
  assert.equal(parseInputBytes(encodeSingleByte(CSV, CP1250), 'lista.csv').source.encoding, 'windows-1250');
});

test('druk: niepoprawny bajt blokuje wczytanie, JSON tylko w UTF-8', () => {
  const broken = Uint8Array.from([...encodeSingleByte('ID rodziny;Imię ucznia;Nazwisko ucznia;Klasa\nH-1;Ala;Test', CP1250), 0x81, 0x3B, 0x33, 0x61]);
  assert.throws(() => parseInputBytes(broken, 'lista.csv'), /nieznane kodowanie/);
  assert.throws(() => parseInputBytes(encodeSingleByte(CSV, CP1250), 'lista.csv', { encoding: 'utf-8' }), /UTF-8/);
  const json = JSON.stringify([{ householdId: 'H-9', firstName: 'Ósemka', lastName: 'Test', className: '1a' }]);
  assert.equal(parseInputBytes(utf8(json), 'a.json').rows.length, 1);
  assert.throws(() => parseInputBytes(encodeSingleByte(json, CP1250), 'a.json'), /UTF-8/);
  assert.throws(() => parseInputBytes(utf8('x'), 'a.xlsx'), /\.csv/);
});
