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
test('valid preview preserves two guardians', () => {
  const headers = [...head, 'Opiekun 2', 'E-mail opiekuna 2'];
  const r = validateRows([headers, ['Ala','Nowak','1A','Anna Nowak','anna@example.org','A1','Jan Nowak','jan@example.org']], guessMapping(headers));
  assert.equal(r.validCount,1); assert.equal(r.records[0].guardian1,'Anna Nowak');
  assert.equal(r.records[0].guardian2,'Jan Nowak');
});
test('duplicate stable ID is an error, duplicate name is a warning', () => {
  const r = preview([['Ala','Nowak','1A','','','A1'],['Ala','Nowak','1A','','','A1']]);
  assert.equal(r.validCount,1); assert.match(r.errors[0].message,/Powtórzone ID/); assert.equal(r.warnings.filter(x=>/Możliwy duplikat/.test(x.message)).length,1);
});
test('conflicting contacts for one family ID require manual review', () => {
  const headers = [...head, 'ID rodziny'];
  const rows = [headers, ['Ala','Nowak','1A','Anna Nowak','anna@example.org','A1','R1'], ['Jan','Nowak','2B','Anna Nowak','other@example.org','A2','R1']];
  const result = validateRows(rows, guessMapping(headers));
  assert.equal(result.validCount, 2);
  assert.equal(result.warnings.filter(x => /ID rodziny ma inne dane/.test(x.message)).length, 1);
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
// --- #88: zera wiodące, komórki dat, klasa bez rozróżniania wielkości liter ---

test('numeric XLSX-style cell in an ID column is kept as text with a leading-zero warning', () => {
  // Symulacja komórki liczbowej Excela: read-excel-file zwraca JS `number`, nie string.
  const r = validateRows([head, ['Ala', 'Nowak', '1A', '', '', 7]], guessMapping(head));
  assert.equal(r.validCount, 1);
  assert.equal(r.records[0].studentId, '7');
  assert.ok(r.warnings.some((w) => /zapisany jako liczba \(7\)/.test(w.message) && /zera wiodące/.test(w.message)));
});

test('an ID number beyond Number.isSafeInteger is a row error, not silent precision loss', () => {
  const r = validateRows([head, ['Ala', 'Nowak', '1A', '', '', 12345678901234567890]], guessMapping(head));
  assert.equal(r.validCount, 0);
  assert.match(r.errors[0].message, /zbyt duża/);
});

test('a Date cell in the class column is a readable row error, not "Mon Jan 02 2026…"', () => {
  const r = validateRows([head, ['Ala', 'Nowak', new Date('2026-01-02'), '', '', 'A1']], guessMapping(head));
  assert.equal(r.validCount, 0);
  assert.match(r.errors[0].message, /Klasa.*Excel zamienił wartość na datę/);
});

test('a Date cell in a guardian name column is also a row error', () => {
  const headers = [...head, 'Opiekun 2', 'E-mail opiekuna 2'];
  const r = validateRows([headers, ['Ala', 'Nowak', '1A', new Date(), '', 'A1', '', '']], guessMapping(headers));
  assert.equal(r.validCount, 0);
  assert.match(r.errors[0].message, /Opiekun 1.*datę/);
});

test('class matching ignores case and extra spaces, and maps to the canonical DB spelling', () => {
  const r1 = validateRows([head, ['Ala', 'Nowak', '1a', '', '', 'A1']], guessMapping(head), { allowedClasses: ['1A'] });
  assert.equal(r1.validCount, 1); assert.equal(r1.records[0].className, '1A');
  const r2 = validateRows([head, ['Ala', 'Nowak', ' 1A ', '', '', 'A1']], guessMapping(head), { allowedClasses: ['1A'] });
  assert.equal(r2.validCount, 1); assert.equal(r2.records[0].className, '1A');
});

test('two allowed classes that normalize to the same key are reported as ambiguous, not silently matched', () => {
  const r = validateRows([head, ['Ala', 'Nowak', '1a', '', '', 'A1']], guessMapping(head), { allowedClasses: ['1a', '1A'] });
  assert.equal(r.validCount, 0);
  assert.match(r.errors[0].message, /Niejednoznaczna/);
});

test('XLSX first sheet with synthetic pupils feeds the preview', async () => {
  const fixture = new URL('./fixtures-students.xlsx.base64', import.meta.url);
  const sheet = await readSheet(Buffer.from(readFileSync(fixture, 'utf8').trim(), 'base64'));
  const result = validateRows(sheet, guessMapping(sheet[0]));
  assert.equal(result.validCount, 2);
  assert.deepEqual(result.errors, []);
  assert.equal(result.records[1].email1, 'jan@example.org');
});

// --- #109: szablon CSV — aliasy nagłówków dają mapowanie bez ręcznego wyboru ---
test('template.csv parses with guessMapping and only fictional @example.invalid addresses', () => {
  const csv = readFileSync(new URL('../import/public/template.csv', import.meta.url), 'utf8');
  const rows = parseCsv(csv);
  const mapping = guessMapping(rows[0]);
  for (const field of ['studentId', 'firstName', 'lastName', 'className', 'householdId', 'guardian1', 'email1', 'guardian2', 'email2']) {
    assert.ok(mapping[field] !== undefined, `brak mapowania dla ${field}`);
  }
  const result = validateRows(rows, mapping);
  assert.equal(result.validCount, 2);
  assert.deepEqual(result.errors, []);
  assert.ok(csv.includes('@example.invalid'));
  assert.ok(!csv.includes('@example.org'));
});
