// Wspólne komórki CSV (issue #121): neutralizacja formuł tylko w polach
// tekstowych, kwoty z centów jako liczby (także ujemne). Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvHeader, csvRow, formatEuro } from '../src/pg/csv.js';

test('amount columns stay numbers, including negative corrections', () => {
  assert.equal(csvCell(-1250, 'amount'), '-12,50');
  assert.equal(csvCell('-1250', 'amount'), '-12,50');
  assert.equal(csvCell(-5, 'amount'), '-0,05');
  assert.equal(csvCell(0, 'amount'), '0,00');
  assert.equal(csvCell(null, 'amount'), '0,00');
  assert.equal(csvCell(123456, 'amount'), '1234,56');
  assert.equal(csvCell(10n, 'amount'), '0,10');
  assert.throws(() => csvCell('9007199254740993', 'amount'), /unsafe_integer/);
  assert.throws(() => csvCell('=1+1', 'amount'), /unsafe_integer/);
  assert.throws(() => csvCell('12,50', 'amount'), /unsafe_integer/);
  assert.equal(formatEuro(-100000000), '-1000000,00');
});

test('text columns neutralise formula starters (OWASP CSV injection cases)', () => {
  const cases = [
    ['=HYPERLINK("http://evil.example")', `"'=HYPERLINK(""http://evil.example"")"`],
    ['+48', "'+48"],
    ['-1', "'-1"],
    ['-12,50', "'-12,50"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1', "'\t=1"],
    ['\r=1', `"'\r=1"`],
    ['  =1', "'  =1"],
    ['　+1', "'　+1"],
    ['＝1', "'＝1"],
    ['＋1', "'＋1"],
    ['－1', "'－1"],
    ['＠x', "'＠x"],
  ];
  for (const [input, expected] of cases) assert.equal(csvCell(input), expected, JSON.stringify(input));
  assert.equal(csvCell('-5', 'text'), "'-5");
  assert.equal(csvCell('Zwykły tekst – 5 = 5'), 'Zwykły tekst – 5 = 5');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.throws(() => csvCell('x', 'formula'), /invalid_csv_column_type/);
});

test('text columns quote separators, quotes, newlines and edge whitespace', () => {
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('wiersz\ndrugi'), '"wiersz\ndrugi"');
  assert.equal(csvCell('wiersz\r\ndrugi'), '"wiersz\r\ndrugi"');
  assert.equal(csvCell(' spacja '), '" spacja "');
  assert.equal(csvCell('-2+3 wiersz\ndrugi'), `"'-2+3 wiersz\ndrugi"`);
});

test('csvRow applies the column type per cell', () => {
  const columns = [{ header: 'opis', type: 'text' }, { header: 'kwota_eur', type: 'amount' }, { header: 'korekty_eur', type: 'amount' }];
  assert.equal(csvHeader(columns), 'opis;kwota_eur;korekty_eur');
  assert.equal(csvRow(columns, ['-korekta; "x"', 5000, -1250]), `"'-korekta; ""x""";50,00;-12,50`);
  assert.throws(() => csvRow(columns, ['x', 1]), /csv_row_length_mismatch/);
});
