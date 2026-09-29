// #109: raport importu do pobrania (CSV, bez danych osobowych) i wykaz
// pominiętych kolumn z ostrzeżeniem dla nagłówków z listy wykluczeń.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorReportCsv, excludedHeaderLabel, unusedColumns } from '../import/report.js';

test('buildErrorReportCsv includes every entry, in both stages, with a Polish header', () => {
  const csv = buildErrorReportCsv([
    { row: 2, stage: 'file', kind: 'error', message: 'Brak: lastName.' },
    { row: 3, stage: 'server', kind: 'conflict', message: 'Możliwa zmiana danych opiekuna.' },
    { row: 3, stage: 'server', kind: 'warning', message: 'Ten sam adres e-mail opiekuna występuje w innej rodzinie.' },
  ]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Wiersz;Etap;Rodzaj;Komunikat');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^2;plik;błąd;Brak: lastName\.$/);
  assert.match(lines[2], /^3;serwer;konflikt;/);
});

test('a message starting with a formula character is neutralized like any other CSV cell', () => {
  const csv = buildErrorReportCsv([{ row: 5, stage: 'file', kind: 'error', message: '=cmd()' }]);
  assert.match(csv, /;'=cmd\(\)\r\n$/);
});

test('report entries never carry names or e-mails (only row/stage/kind/message from validateRows)', () => {
  const csv = buildErrorReportCsv([{ row: 1, stage: 'file', kind: 'warning', message: 'Brak opiekuna: nie będzie możliwy kontakt e-mail.' }]);
  for (const fragment of ['Kowalski', '@example', 'Testowy']) assert.equal(csv.includes(fragment), false);
});

test('unusedColumns lists headers with no mapped field, with the empty header shown as text', () => {
  const headers = ['Imię ucznia', 'Nazwisko ucznia', 'Klasa', 'PESEL', ''];
  const mapping = { firstName: '0', lastName: '1', className: '2' };
  const result = unusedColumns(headers, mapping);
  assert.deepEqual(result.map((c) => c.header), ['PESEL', '(bez nazwy)']);
  assert.equal(result[0].excluded, 'PESEL');
  assert.equal(result[1].excluded, null);
});

test('excludedHeaderLabel flags PESEL, address and phone header variants', () => {
  for (const header of ['PESEL', 'pesel ucznia', 'Adres zamieszkania', 'Telefon', 'nr tel.']) {
    assert.ok(excludedHeaderLabel(header), header);
  }
  assert.equal(excludedHeaderLabel('Klasa'), null);
});

test('#98 missingFromFileSummary: brak uczniów = brak sekcji; lista skrócona; bez imion', async () => {
  const { missingFromFileSummary } = await import('../import/report.js');
  assert.equal(missingFromFileSummary(undefined), null);
  assert.equal(missingFromFileSummary({ count: 0, refs: [] }), null);
  const refs = Array.from({ length: 45 }, (_, i) => `S${i + 1}`);
  const s = missingFromFileSummary({ count: 45, refs });
  assert.equal(s.title, 'W bazie, brak w pliku');
  assert.equal(s.refs.length, 40);
  assert.equal(s.more, 5);
  assert.match(s.text, /: 45\./);
});

test('#98 panel importu renderuje sekcję „W bazie, brak w pliku” z odpowiedzi podglądu', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../import/main.js', import.meta.url), 'utf8');
  assert.match(main, /missingFromFileSummary\(missing\)/);
  assert.match(main, /\.\.\.missingFromFileNodes\(data\.missingFromFile\)/);
});
