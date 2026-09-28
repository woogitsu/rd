// #188: XLSX w panelu importu bez Web Workera z blob:.
// fflate (używany przez read-excel-file) w przeglądarce oddaje do new Worker(blob:) każdą
// pozycję archiwum skompresowaną metodą deflate i większą niż 512 KiB po rozpakowaniu.
// CSP serwera Node blokuje taki worker. import/xlsx.js przepakowuje plik bez kompresji,
// więc fflate zwraca każdą pozycję synchronicznie. Dane wyłącznie syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import readXlsxFileNode, { readSheet } from 'read-excel-file/node';
import { readXlsxRows, readXlsxSheets, repackXlsxStored, XlsxReadError } from '../import/xlsx.js';

const WORKER_THRESHOLD = 524288; // fflate: su < 524288 → inflateSync, inaczej worker
const HEADER = ['Uczeń', 'Klasa', 'Opiekun 1', 'E-mail 1', 'Opiekun 2', 'E-mail 2', 'ID rodziny', 'Uwagi'];

function syntheticRows(count) {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    // Co trzeci uczeń ma rodzeństwo w tej samej rodzinie; dwoje opiekunów w wierszu.
    const family = `F${String(Math.ceil(i / 2)).padStart(5, '0')}`;
    rows.push([`Uczeń Testowy ${i}`, `${(i % 6) + 1}A`, `Opiekun A${i}`, `opiekun.a${i}@example.invalid`,
      `Opiekun B${i}`, `opiekun.b${i}@example.invalid`, family, i % 7 === 0 ? 'wiersz syntetyczny' : '']);
  }
  return rows;
}

const escapeXml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const column = (index) => String.fromCharCode(65 + index);

// Minimalny, poprawny skoroszyt; sharedStrings: true zapisuje tekst jak Excel (t="s").
function buildXlsx(rows, { sharedStrings = false } = {}) {
  const strings = [];
  const stringIndex = new Map();
  const cell = (value, r, c) => {
    const ref = `${column(c)}${r}`;
    if (value === '') return '';
    if (!sharedStrings) return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    if (!stringIndex.has(value)) { stringIndex.set(value, strings.length); strings.push(value); }
    return `<c r="${ref}" t="s"><v>${stringIndex.get(value)}</v></c>`;
  };
  const sheetRows = [HEADER, ...rows].map((row, r) =>
    `<row r="${r + 1}">${row.map((value, c) => cell(value, r + 1, c)).join('')}</row>`).join('');
  const files = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + (sharedStrings ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : '') + '</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Uczniowie" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + (sharedStrings ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' : '') + '</Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`),
    'docProps/thumbnail.png': new Uint8Array(1024),
  };
  if (sharedStrings) {
    files['xl/sharedStrings.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join('')}</sst>`);
  }
  const zipped = zipSync(files, { level: 6 });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
}

// Skoroszyt z kilkoma arkuszami (#88: „Instrukcja” przed danymi uczniów).
function buildXlsxMultiSheet(sheets) {
  const inlineRows = (rows) => rows.map((row, r) =>
    `<row r="${r + 1}">${row.map((value, c) => (value === '' ? '' : `<c r="${column(c)}${r + 1}" t="inlineStr"><is><t>${escapeXml(String(value))}</t></is></c>`)).join('')}</row>`).join('');
  const sheetEntries = sheets.map((_, i) => `<sheet name="${escapeXml(sheets[i].name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const relEntries = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const typeOverrides = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${typeOverrides}</Types>`),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries}</Relationships>`),
  };
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${inlineRows(sheet.rows)}</sheetData></worksheet>`);
  });
  const zipped = zipSync(files, { level: 6 });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
}

// Metoda kompresji i rozmiar po rozpakowaniu każdej pozycji z katalogu centralnego ZIP.
function zipEntries(buffer) {
  const data = new DataView(buffer);
  let end = buffer.byteLength - 22;
  while (data.getUint32(end, true) !== 0x06054b50) end -= 1;
  const count = data.getUint16(end + 10, true);
  let offset = data.getUint32(end + 16, true);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const method = data.getUint16(offset + 10, true);
    const size = data.getUint32(offset + 24, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extra = data.getUint16(offset + 30, true);
    const comment = data.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(new Uint8Array(buffer, offset + 46, nameLength));
    entries.push({ name, method, size });
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}

// W przeglądarce fflate uruchomiłby worker dla pozycji deflate ≥ 512 KiB (browser.js: unzip).
const wouldStartWorker = (entry) => entry.method === 8 && entry.size >= WORKER_THRESHOLD;

for (const [count, sharedStrings] of [[500, false], [1500, false], [3000, true], [5000, false], [5000, true]]) {
  test(`XLSX ${count} wierszy${sharedStrings ? ' (sharedStrings)' : ''}: odczyt bez workera daje te same wiersze`, async () => {
    const rows = syntheticRows(count);
    const original = buildXlsx(rows, { sharedStrings });
    const stored = repackXlsxStored(original);
    const storedEntries = zipEntries(stored);
    assert.ok(storedEntries.every((entry) => entry.method === 0), 'wszystkie pozycje bez kompresji');
    assert.ok(!storedEntries.some(wouldStartWorker));
    assert.ok(!storedEntries.some((entry) => entry.name.endsWith('.png')), 'pomija pliki spoza XML');
    if (count >= 1500) {
      // Warunek wstępny: oryginał uruchomiłby worker blob: w przeglądarce.
      assert.ok(zipEntries(original).some(wouldStartWorker), 'oryginał ma pozycję deflate ≥ 512 KiB');
    }
    const matrix = await readXlsxRows(original);
    const expected = await readSheet(Buffer.from(original));
    assert.deepEqual(matrix, expected);
    assert.equal(matrix.length, count + 1);
    assert.deepEqual(matrix[0], HEADER);
    assert.equal(matrix[1][6], matrix[2][6], 'rodzeństwo ma to samo ID rodziny');
    assert.equal(matrix[count][5], `opiekun.b${count}@example.invalid`);
  });
}

test('sharedStrings.xml powyżej progu przy małym sheet1.xml', async () => {
  const rows = syntheticRows(40).map((row, i) => row.map((value, c) => (c === 7 ? `uwaga ${i} ${'x'.repeat(20000)}` : value)));
  const original = buildXlsx(rows, { sharedStrings: true });
  const entries = zipEntries(original);
  const sheet = entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml');
  const strings = entries.find((entry) => entry.name === 'xl/sharedStrings.xml');
  assert.ok(sheet.size < WORKER_THRESHOLD && strings.size >= WORKER_THRESHOLD);
  assert.ok(zipEntries(repackXlsxStored(original)).every((entry) => entry.method === 0));
  const matrix = await readXlsxRows(original);
  assert.equal(matrix.length, 41);
  assert.match(matrix[1][7], /^uwaga 0 x+$/);
});

test('uszkodzony plik daje polski komunikat zamiast wyjątku biblioteki', async () => {
  await assert.rejects(readXlsxRows(new TextEncoder().encode('to nie jest zip').buffer), (error) => {
    assert.ok(error instanceof XlsxReadError);
    assert.match(error.message, /nie jest poprawnym arkuszem \.xlsx/);
    return true;
  });
  const noSheet = zipSync({ 'a.xml': strToU8('<a/>') }, { level: 0 });
  await assert.rejects(readXlsxRows(noSheet.buffer), /Nie udało się odczytać arkusza \.xlsx/);
});

// --- #88: wybór arkusza — plik może mieć arkusz „Instrukcja” przed danymi ---

test('readXlsxSheets lists every sheet with its own rows, in workbook order', async () => {
  const original = buildXlsxMultiSheet([
    { name: 'Instrukcja', rows: [['Nie wypełniaj tego arkusza'], ['Dane uczniów są w arkuszu „Uczniowie 1A”.']] },
    { name: 'Uczniowie 1A', rows: [HEADER.slice(0, 6), ['Ala Testowa', '1A', 'Anna Testowa', 'anna@example.invalid', '', '']] },
    { name: 'Uczniowie 2B', rows: [HEADER.slice(0, 6), ['Jan Testowy', '2B', 'Piotr Testowy', 'piotr@example.invalid', '', '']] },
  ]);
  const sheets = await readXlsxSheets(original, (buf) => readXlsxFileNode(Buffer.from(buf)));
  assert.deepEqual(sheets.map((s) => s.name), ['Instrukcja', 'Uczniowie 1A', 'Uczniowie 2B']);
  assert.equal(sheets[1].rows[1][0], 'Ala Testowa');
  assert.equal(sheets[2].rows[1][0], 'Jan Testowy');
  // Wybór drugiego arkusza używa danych już wczytanych — bez ponownego odczytu pliku.
  assert.notEqual(sheets[1].rows, sheets[2].rows);
});

test('readXlsxSheets on a single-sheet file returns exactly one entry', async () => {
  const original = buildXlsx(syntheticRows(3));
  const sheets = await readXlsxSheets(original, (buf) => readXlsxFileNode(Buffer.from(buf)));
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, 'Uczniowie');
  assert.equal(sheets[0].rows.length, 4);
});
