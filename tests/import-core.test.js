import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSheet } from 'read-excel-file/node';
import { parseCsv, guessMapping, validateRows } from '../import/core.js';
const head = ['Imię ucznia','Nazwisko ucznia','Klasa','Opiekun 1','E-mail opiekuna 1','ID ucznia'];
const preview = rows => validateRows([head,...rows], guessMapping(head));
test('CSV: BOM, semicolon, CRLF, embedded newline and escaped quote', () => {
  const rows = parseCsv('\uFEFFImię;Nazwisko;Klasa\r\n"Ala\nMaria";"Ko""t";1A\r\n');
  assert.deepEqual(rows,[['Imię','Nazwisko','Klasa'],['Ala\nMaria','Ko"t','1A']]);
});
test('CSV rejects malformed quote', () => assert.throws(() => parseCsv('a;b\n"bad;b'),/cudzysłowu/));
test('CSV detects separator outside quoted header cells', () => {
  assert.deepEqual(parseCsv('"Nazwisko, imię";Klasa\n"Nowak, Ala";1A'), [['Nazwisko, imię','Klasa'],['Nowak, Ala','1A']]);
});
test('valid preview has no side effects and preserves two guardians', () => {
  const r = preview([['Ala','Nowak','1A','Anna Nowak','anna@example.org','A1']]);
  assert.equal(r.validCount,1); assert.equal(r.records[0].guardian1,'Anna Nowak');
});
test('duplicate stable ID is an error, duplicate name is a warning', () => {
  const r = preview([['Ala','Nowak','1A','','','A1'],['Ala','Nowak','1A','','','A1']]);
  assert.equal(r.validCount,1); assert.match(r.errors[0].message,/Powtórzone ID/); assert.equal(r.warnings.filter(x=>/Możliwy duplikat/.test(x.message)).length,1);
});
test('email without guardian is rejected', () => assert.equal(preview([['Ala','Nowak','1A','','anna@example.org','A1']]).validCount,0));
test('unknown class is rejected when a class list is supplied', () => {
  const r = validateRows([head,['Ala','Nowak','2B','','','A1']], guessMapping(head), {allowedClasses:['1A']});
  assert.match(r.errors[0].message,/Nieznana klasa/);
});
test('required columns and duplicate mappings are rejected', () => {
  assert.throws(() => validateRows([head,['Ala','Nowak','1A']], {firstName:0,lastName:0,className:2}),/Jedna kolumna/);
  assert.throws(() => validateRows([head,['Ala','Nowak','1A']], {firstName:0,lastName:1}),/Brakuje mapowania/);
});
test('mapping cannot point outside the sheet', () => {
  assert.throws(() => validateRows([head,['Ala','Nowak','1A']], {firstName:0,lastName:1,className:2,email1:30}),/nieprawidłową kolumnę/);
});
test('formula-like values remain inert strings', () => {
  const r = preview([['=HYPERLINK("evil")','Nowak','1A','','','A1']]);
  assert.equal(r.records[0].firstName,'=HYPERLINK("evil")');
});
test('1000 rows are accepted without truncation', () => {
  const rows = Array.from({length:1000},(_,i)=>['Ala','Nowak',`1A`,'','','ID'+i]);
  assert.equal(preview(rows).validCount,1000);
});
test('XLSX first sheet with synthetic pupils feeds the preview', async () => {
  const fixture = new URL('./fixtures-students.xlsx.base64', import.meta.url);
  const sheet = await readSheet(Buffer.from(readFileSync(fixture, 'utf8').trim(), 'base64'));
  const result = validateRows(sheet, guessMapping(sheet[0]));
  assert.equal(result.validCount, 2);
  assert.deepEqual(result.errors, []);
  assert.equal(result.records[1].email1, 'jan@example.org');
});
