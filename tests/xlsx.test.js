// Moduł XLSX (issue #121): typy komórek, brak formuł, kwoty z centów, poprawny pakiet OPC.
// Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { centsToXlsxNumber, columnLetters, sheetNameOf, toXlsx, xlsxResponse, XLSX_CONTENT_TYPE } from '../src/pg/xlsx.js';

const COLUMNS = [
  { header: 'opis', type: 'text' },
  { header: 'kwota_eur', type: 'amount' },
  { header: 'plan_eur', type: 'amount_or_blank' },
];

function open(bytes) {
  const files = unzipSync(bytes);
  return { files, sheet: strFromU8(files['xl/worksheets/sheet1.xml']) };
}

test('pakiet zawiera wymagane części i typ MIME odpowiada XLSX', () => {
  const { files } = open(toXlsx(COLUMNS, [['a', 100, null]]));
  assert.deepEqual(Object.keys(files).sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
  ]);
  const response = xlsxResponse(new Uint8Array([1]), 'plik.xlsx');
  assert.equal(response.headers.get('content-type'), XLSX_CONTENT_TYPE);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="plik.xlsx"');
});

test('żadnej formuły: tekst z znakami formuły to inlineStr, bez elementu <f>', () => {
  const cases = ['=HYPERLINK("http://evil.example")', '+1', '-1', '@SUM(A1)', '\t=1', '  =1', '＝1', '=1+1</t><f>2</f>'];
  const { files, sheet } = open(toXlsx(COLUMNS, cases.map((text) => [text, 0, 0])));
  for (const [name, bytes] of Object.entries(files)) assert.ok(!/<f[\s>/]/.test(strFromU8(bytes)), name);
  assert.equal((sheet.match(/t="inlineStr"/g) ?? []).length, 3 + cases.length); // 3 nagłówki + teksty
  assert.ok(!/<c [^>]*t="(str|f)"/.test(sheet));
  // Wstrzyknięty znacznik jest zescapowany, nie staje się elementem.
  assert.ok(sheet.includes('=1+1&lt;/t&gt;&lt;f&gt;2&lt;/f&gt;'));
});

test('kwoty: liczby z centów, także ujemne, zero i duże; komórka pusta dla braku planu', () => {
  assert.equal(centsToXlsxNumber(-1250), '-12.50');
  assert.equal(centsToXlsxNumber(-5), '-0.05');
  assert.equal(centsToXlsxNumber(0), '0.00');
  assert.equal(centsToXlsxNumber('123456'), '1234.56');
  assert.equal(centsToXlsxNumber(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  assert.throws(() => centsToXlsxNumber('9007199254740993'), /unsafe_integer/);
  assert.throws(() => centsToXlsxNumber('=1+1'), /unsafe_integer/);
  const { sheet } = open(toXlsx(COLUMNS, [['a', -1250, null], ['b', 0, 5]]));
  assert.ok(sheet.includes('<c r="B2" s="2"><v>-12.50</v></c>'));
  assert.ok(sheet.includes('<c r="B3" s="2"><v>0.00</v></c>'));
  assert.ok(!sheet.includes('r="C2"'), 'brak planu = pusta komórka');
  assert.ok(sheet.includes('<c r="C3" s="2"><v>0.05</v></c>'));
  const styles = open(toXlsx(COLUMNS, [])).files['xl/styles.xml'];
  assert.ok(strFromU8(styles).includes('formatCode="#,##0.00 &quot;EUR&quot;"'));
});

test('polskie znaki, cudzysłowy, nowa linia i znaki niedozwolone w XML', () => {
  const { sheet } = open(toXlsx(COLUMNS, [['Zażółć "gęślą" <jaźń> & ; \n druga\u0000\u0008 linia', 1, null]]));
  assert.ok(sheet.includes('Zażółć &quot;gęślą&quot; &lt;jaźń&gt; &amp; ; \n druga linia'));
  assert.ok(sheet.includes('xml:space="preserve"'));
  assert.ok(!/[\u0000-\u0008]/.test(sheet));
});

test('błędy wejścia: długość wiersza i nieznany typ kolumny', () => {
  assert.throws(() => toXlsx(COLUMNS, [['a', 1]]), /xlsx_row_length_mismatch/);
  assert.throws(() => toXlsx([{ header: 'x', type: 'date' }], [['2026-01-01']]), /invalid_xlsx_column_type/);
});

test('litery kolumn i nazwa arkusza', () => {
  assert.deepEqual([0, 25, 26, 51, 52, 701, 702].map(columnLetters), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  assert.equal(sheetNameOf('Księga: y2026/[x]'), 'Księga  y2026  x');
  assert.equal(sheetNameOf('x'.repeat(40)).length, 31);
  assert.equal(sheetNameOf(''), 'Arkusz');
  assert.equal(sheetNameOf("'a'"), 'a');
});

test('ten sam zestaw danych daje te same bajty', () => {
  const rows = [['a', 100, null]];
  assert.deepEqual(toXlsx(COLUMNS, rows), toXlsx(COLUMNS, rows));
});

test('plik czyta niezależny czytnik (read-excel-file): typy string/number, ujemna kwota jako liczba', async () => {
  const { default: readXlsxFileNode } = await import('read-excel-file/node');
  const bytes = toXlsx(COLUMNS, [['=1+1', -1250, null], ['zwykły', 5, 1999]], { sheetName: 'Test' });
  const sheets = await readXlsxFileNode(Buffer.from(bytes));
  const rows = sheets[0].data ?? sheets[0];
  assert.deepEqual(rows[0], ['opis', 'kwota_eur', 'plan_eur']);
  assert.deepEqual(rows[1], ['=1+1', -12.5, null]);
  assert.deepEqual(rows[2], ['zwykły', 0.05, 19.99]);
  assert.equal(typeof rows[1][0], 'string');
});

test('preamble i trailer: jednokomórkowe wiersze, nagłówek kolumn zamrożony pod preamble', () => {
  const { sheet } = open(toXlsx(COLUMNS, [['a', 100, null]], { preamble: ['=Tytuł', ''], trailer: ['', 'Stopka'] }));
  assert.ok(sheet.includes('<row r="1"><c r="A1" s="1" t="inlineStr">'));
  assert.ok(sheet.includes('<row r="2"></row>'));
  assert.ok(sheet.includes('<c r="A3" s="1" t="inlineStr"><is><t xml:space="preserve">opis</t>'));
  assert.ok(sheet.includes('<c r="A6" t="inlineStr"><is><t xml:space="preserve">Stopka</t>'));
  assert.ok(sheet.includes('<dimension ref="A1:C6"/>'));
  assert.ok(sheet.includes('ySplit="3" topLeftCell="A4"'));
  assert.ok(!/<f[\s>/]/.test(sheet));
});
