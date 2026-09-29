// Szablon importu .xlsx (#109), generowany bez nowej zależności: ręczny OOXML
// spakowany fflate (już w dependencies, używany przez import/xlsx.js).
// Uruchamiany skryptem `node scripts/build-import-template.js` (wynik trafia do
// import/public/template.xlsx). Dane wyłącznie fikcyjne (@example.invalid).
// Wynik jest deterministyczny (stała data w archiwum), więc test porównuje plik z repo.
import { strToU8, zipSync } from 'fflate';

export const TEMPLATE_HEADERS = [
  'ID ucznia', 'Imię ucznia', 'Nazwisko ucznia', 'Klasa', 'ID rodziny',
  'Opiekun 1', 'E-mail opiekuna 1', 'Opiekun 2', 'E-mail opiekuna 2',
];
export const TEMPLATE_ROWS = [
  ['TEST-001', 'Alicja', 'Przykładowa', '1A', 'ROD-001', 'Anna Przykładowa', 'anna@example.invalid', 'Jan Przykładowy', 'jan@example.invalid'],
  ['TEST-002', 'Marek', 'Przykładowy', '2B', 'ROD-001', 'Anna Przykładowa', 'anna@example.invalid', 'Jan Przykładowy', 'jan@example.invalid'],
];
// Przykładowa lista klas do walidacji; prawdziwe nazwy klas ustala szkoła.
// Walidacja ma styl „ostrzeżenie”, więc inna klasa nie jest blokowana.
export const TEMPLATE_CLASSES = ['1A', '1B', '2A', '2B', '3A', '3B'];
export const TEMPLATE_INSTRUCTIONS = [
  ['Instrukcja do szablonu importu uczniów (RD)'],
  [''],
  ['Wpisuj dane w arkuszu „Dane”. Ten arkusz („Instrukcja”) nie jest importowany.'],
  ['Wymagane kolumny: Imię ucznia, Nazwisko ucznia, Klasa. Pozostałe są opcjonalne.'],
  ['Kolumny są sformatowane jako Tekst, żeby Excel nie usuwał zer wiodących z identyfikatorów ani nie zamieniał „1-2” na datę.'],
  ['ID ucznia i ID rodziny: własne identyfikatory szkoły, identyczne przy każdym kolejnym imporcie. Rodzeństwo łączy wspólne ID rodziny.'],
  ['Klasa: wpisuj tak, jak w systemie (np. 1A). Lista w szablonie jest tylko przykładowa.'],
  ['E-mail opiekuna: jeden adres w komórce. Podaj też imię i nazwisko opiekuna w tym samym wierszu.'],
  ['Nie dodawaj kolumn z numerem PESEL, adresem zamieszkania, telefonem, ocenami ani danymi zdrowotnymi — import ich nie przyjmuje.'],
  ['Przykładowe wiersze w arkuszu „Dane” (adresy @example.invalid) usuń przed wpisaniem prawdziwych danych.'],
  ['Zapisując plik wybierz format .xlsx albo CSV. Format .ods nie jest obsługiwany.'],
];

const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const columnLetter = (index) => String.fromCharCode(65 + index);
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function sheetXml(rows, { textStyle, validation = '', widths = [] }) {
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) =>
    `<c r="${columnLetter(c)}${r + 1}" s="${textStyle}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`).join('')}</row>`).join('');
  return `${XML}<worksheet xmlns="${NS}">${cols}<sheetData>${body}</sheetData>${validation}</worksheet>`;
}

export function buildTemplateXlsx() {
  const classValidation = `<dataValidations count="1"><dataValidation type="list" errorStyle="warning" allowBlank="1" showErrorMessage="1" errorTitle="Klasa" error="Tej klasy nie ma na przykładowej liście. Upewnij się, że nazwa zgadza się z systemem." sqref="D2:D5001"><formula1>"${TEMPLATE_CLASSES.join(',')}"</formula1></dataValidation></dataValidations>`;
  // Każdy wiersz danych ma format Tekst (numFmtId 49 = „@”); puste komórki do 5001 wiersza dostają go przez styl kolumn.
  const dataSheet = sheetXml([TEMPLATE_HEADERS, ...TEMPLATE_ROWS], { textStyle: 1, validation: classValidation, widths: [12, 16, 18, 8, 12, 20, 26, 20, 26] })
    .replace(/(<col [^>]*?)\/>/g, '$1 style="1"/>');
  const files = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML}<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dane" sheetId="1" r:id="rId1"/><sheet name="Instrukcja" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${XML}<styleSheet xmlns="${NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': dataSheet,
    'xl/worksheets/sheet2.xml': sheetXml(TEMPLATE_INSTRUCTIONS, { textStyle: 0, widths: [120] }),
  };
  // fflate zapisuje czas DOS z lokalnych składników daty, więc stała data musi być lokalna (nie UTC) — inaczej bajty zależą od strefy czasowej maszyny.
  const ZIP_MTIME = new Date(2026, 0, 1, 0, 0, 0);
  const entries = Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, [strToU8(xml), { mtime: ZIP_MTIME, level: 6 }]]));
  return zipSync(entries);
}
