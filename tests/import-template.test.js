// #109: szablon XLSX/CSV, pamięć mapowania i raport z wieloma błędami. Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { readSheet } from 'read-excel-file/node';
import { guessMapping, parseCsv, validateRows } from '../import/core.js';
import { buildTemplateXlsx, TEMPLATE_HEADERS } from '../import/template-xlsx.js';
import { readXlsxSheets } from '../import/xlsx.js';
import { buildErrorReportCsv } from '../import/report.js';
import { applyRememberedMapping, clearRememberedMapping, loadRememberedMapping, MAPPING_STORAGE_KEY, saveRememberedMapping } from '../import/mapping-memory.js';

const url = (name) => new URL(`../import/public/${name}`, import.meta.url);
const toArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), data };
};

test('plik template.xlsx w repo jest aktualnym wynikiem generatora (npm: node scripts/build-import-template.js)', () => {
  assert.deepEqual(new Uint8Array(readFileSync(url('template.xlsx'))), buildTemplateXlsx());
});

test('szablon XLSX: arkusz Dane mapuje się aliasami bez ręcznego wyboru, a Instrukcja jest osobnym arkuszem', async () => {
  const sheets = await readXlsxSheets(toArrayBuffer(readFileSync(url('template.xlsx'))));
  assert.deepEqual(sheets.map((s) => s.name), ['Dane', 'Instrukcja']);
  const [data] = sheets;
  assert.deepEqual(data.rows[0], TEMPLATE_HEADERS);
  const mapping = guessMapping(data.rows[0]);
  assert.equal(Object.keys(mapping).length, 9);
  const result = validateRows(data.rows, Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, String(v)])), { allowedClasses: ['1A', '2B'] });
  assert.equal(result.errors.length, 0);
  assert.equal(result.validCount, 2);
});

test('szablon XLSX: kolumny jako Tekst, walidacja klasy jako ostrzeżenie, tylko dane fikcyjne', async () => {
  const files = unzipSync(new Uint8Array(readFileSync(url('template.xlsx'))));
  const sheet1 = strFromU8(files['xl/worksheets/sheet1.xml']);
  assert.match(strFromU8(files['xl/styles.xml']), /numFmtId="49"/);
  assert.match(sheet1, /<col [^>]*style="1"/);
  assert.match(sheet1, /type="list" errorStyle="warning"/);
  assert.match(sheet1, /<formula1>"1A,1B,2A,2B,3A,3B"<\/formula1>/);
  assert.match(strFromU8(files['xl/worksheets/sheet2.xml']), /PESEL/);
  const emails = Object.values(files).map(strFromU8).join('').match(/[\w.+-]+@[\w.-]+/g) ?? [];
  assert.ok(emails.length > 0 && emails.every((e) => e.endsWith('@example.invalid')));
  // Identyfikator z zerami wiodącymi zostaje tekstem.
  const rows = await readSheet(readFileSync(url('template.xlsx')));
  assert.equal(typeof rows[1][0], 'string');
});

test('szablon CSV: parseCsv daje pełne mapowanie aliasów, tylko adresy @example.invalid', () => {
  const text = readFileSync(url('template.csv'), 'utf8');
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], TEMPLATE_HEADERS);
  assert.equal(Object.keys(guessMapping(rows[0])).length, 9);
  assert.ok((text.match(/@[\w.-]+/g) ?? []).every((d) => d === '@example.invalid'));
});

test('raport z 500 błędami zawiera każdy wiersz, bez imion i e-maili, z neutralizacją formuł', () => {
  const header = 'Imię ucznia;Nazwisko ucznia;Klasa\r\n';
  const body = Array.from({ length: 500 }, (_, i) => `Jan${i};Testowy${i};9Z`).join('\r\n');
  const result = validateRows(parseCsv(header + body), { firstName: '0', lastName: '1', className: '2' }, { allowedClasses: ['1A'] });
  assert.ok(result.errors.length >= 500);
  const entries = [...result.errors.map((e) => ({ ...e, stage: 'file', kind: 'error' })), { row: 999, stage: 'file', kind: 'error', message: '=HYPERLINK("x")' }];
  const lines = buildErrorReportCsv(entries).trim().split('\r\n');
  assert.equal(lines.length, entries.length + 1);
  assert.ok(lines.at(-1).includes("'=HYPERLINK"));
  for (const fragment of ['Jan1;', 'Testowy', '@']) assert.equal(lines.join('\n').includes(fragment), false);
});

test('pamięć mapowania: zapis, odtworzenie po tych samych nagłówkach, aliasy mają pierwszeństwo', () => {
  const storage = memoryStorage();
  const headers = ['Uczeń imię', 'Uczeń nazwisko', 'Oddział szkolny', 'PESEL'];
  const chosen = { firstName: '0', lastName: '1', className: '2', email1: '3' };
  assert.equal(saveRememberedMapping(headers, chosen, storage), true);
  const remembered = loadRememberedMapping(storage);
  assert.deepEqual(remembered, { 'uczeń imię': 'firstName', 'uczeń nazwisko': 'lastName', 'oddział szkolny': 'className' }); // PESEL nie jest zapamiętywany
  assert.deepEqual(applyRememberedMapping(headers, guessMapping(headers), remembered), { firstName: 0, lastName: 1, className: 2 });
  // Alias „Klasa” ma pierwszeństwo przed zapamiętanym przypisaniem tego pola.
  const other = ['Klasa', 'Oddział szkolny'];
  assert.deepEqual(applyRememberedMapping(other, guessMapping(other), remembered), { className: 0 });
  // W magazynie są wyłącznie nazwy nagłówków i pól.
  assert.doesNotMatch(storage.data.get(MAPPING_STORAGE_KEY), /example|@/);
});

test('pamięć mapowania: wyczyszczenie oraz zablokowany albo uszkodzony localStorage nie psują strony', () => {
  const storage = memoryStorage();
  saveRememberedMapping(['Imię'], { firstName: '0' }, storage);
  assert.equal(clearRememberedMapping(storage), true);
  assert.deepEqual(loadRememberedMapping(storage), {});
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } };
  assert.deepEqual(loadRememberedMapping(blocked), {});
  assert.equal(saveRememberedMapping(['Imię'], { firstName: '0' }, blocked), false);
  assert.equal(clearRememberedMapping(blocked), false);
  assert.deepEqual(loadRememberedMapping(memoryStorage({ [MAPPING_STORAGE_KEY]: '{oops' })), {});
  assert.deepEqual(loadRememberedMapping(memoryStorage({ [MAPPING_STORAGE_KEY]: '{"x":"__proto__","y":"firstName"}' })), { y: 'firstName' });
});
