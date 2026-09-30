// Zapis XLSX bez nowej zależności (issue #121): SpreadsheetML składany ręcznie
// i pakowany przez fflate, który jest już zależnością produkcyjną (odczyt
// importu, read-excel-file). Te same kolumny ({ header, type }) co w csv.js.
//
// Gwarancje bezpieczeństwa:
// - żadnej komórki-formuły: nie powstaje element <f>, a tekst trafia jako
//   inlineStr (t="inlineStr"), którego arkusz nie interpretuje jako formuły;
//   dlatego w XLSX tekst NIE dostaje apostrofu (w CSV dostaje — tam arkusz
//   sam zgaduje typ komórki);
// - kwoty ('amount', 'amount_or_blank') to komórki liczbowe z formatem
//   `#,##0.00 "EUR"`; wartość składana z całkowitych centów jako dziesiętny
//   tekst („-12.50”), bez działań zmiennoprzecinkowych, więc bez utraty
//   precyzji; ujemna kwota zostaje liczbą.
// - znaki niedozwolone w XML 1.0 są usuwane z tekstu.
//
// Typy kolumn tylko dla XLSX (#141; CSV ich nie zna i odrzuca je błędem
// invalid_csv_column_type zamiast zgadywać): 'integer' (liczba całkowita,
// np. liczba wpisów), 'date' (sama data „2026-10-20” -> prawdziwa data
// arkusza z formatem dd.mm.yyyy, czyli ten sam polski zapis co w raporcie KR
// z #563, ale z sortowaniem i filtrem po dacie) oraz 'datetime' (znacznik
// czasu ISO UTC albo Date -> data i godzina lokalna Europe/Brussels z formatem
// dd.mm.yyyy hh:mm, jak formatDateOrTimestamp w shared/zoned-time.js; z
// dokładnością do minuty — dokładna wartość UTC zostaje w wersji JSON).
//
// Skoroszyt z wieloma arkuszami (#141: raport KR — arkusz na sekcję; wpłaty —
// „Wpisy” i „Korekty”) składa toXlsxWorkbook; toXlsx to przypadek jednego arkusza.

import { strToU8, zipSync } from 'fflate';
import { toSafeInteger } from './routes/payments.js';
import { zoneParts } from '../../shared/zoned-time.js';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Znaki sterujące poza \t \n \r, samotne surogaty i U+FFFE/U+FFFF psują XML.
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function xmlText(value) {
  return String(value).replace(XML_ILLEGAL, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// 0 -> A, 25 -> Z, 26 -> AA.
export function columnLetters(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// Centy (całkowite) -> „-12.50” (kropka jako zapis wartości w XML, niezależna od ustawień regionalnych).
export function centsToXlsxNumber(cents) {
  const value = toSafeInteger(cents);
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// Nazwa arkusza: max 31 znaków, bez []:*?/\ i apostrofu na brzegach.
export function sheetNameOf(name) {
  const cleaned = String(name || 'Arkusz').replace(/[[\]:*?/\\]/g, ' ').replace(XML_ILLEGAL, '').trim().replace(/^'+|'+$/g, '');
  return cleaned.slice(0, 31) || 'Arkusz';
}

// Strefa znaczników czasu w arkuszu — ta sama co w raporcie KR i panelach.
export const XLSX_TIME_ZONE = 'Europe/Brussels';

const DAY_MS = 86_400_000;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// „2026-10-20” -> numer seryjny dnia arkusza (system 1900; 1 = 1900-01-01).
export function dateToXlsxSerial(value) {
  const match = ISO_DATE.exec(String(value ?? ''));
  if (!match) throw new Error('invalid_xlsx_date');
  const [year, month, day] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new Error('invalid_xlsx_date');
  return String((ms - EXCEL_EPOCH) / DAY_MS);
}

// Znacznik czasu -> numer seryjny daty i godziny lokalnej (minuty jako ułamek
// doby, zapis dziesiętny bez zaokrągleń binarnych: 15 cyfr po kropce).
export function timestampToXlsxSerial(value, timeZone = XLSX_TIME_ZONE) {
  const instant = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(instant.getTime())) throw new Error('invalid_xlsx_datetime');
  const p = zoneParts(instant, timeZone);
  const days = (Date.UTC(p.year, p.month - 1, p.day) - EXCEL_EPOCH) / DAY_MS;
  const minutes = p.hour * 60 + p.minute;
  if (!minutes) return String(days);
  return `${days}.${(minutes / 1440).toFixed(15).slice(2).replace(/0+$/, '')}`;
}

const STYLE_HEADER = 1;
const STYLE_AMOUNT = 2;
const STYLE_DATE = 3;
const STYLE_DATETIME = 4;

function textCell(ref, value, style = 0) {
  const s = style ? ` s="${style}"` : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function cellXml(column, value, ref) {
  if (column.type === 'amount' || column.type === 'amount_or_blank') {
    if (column.type === 'amount_or_blank' && (value === null || value === undefined)) return '';
    return `<c r="${ref}" s="${STYLE_AMOUNT}"><v>${centsToXlsxNumber(value)}</v></c>`;
  }
  if (column.type === 'integer') {
    if (value === null || value === undefined || value === '') return '';
    return `<c r="${ref}"><v>${toSafeInteger(value)}</v></c>`;
  }
  if (column.type === 'date') {
    if (value === null || value === undefined || value === '') return '';
    return `<c r="${ref}" s="${STYLE_DATE}"><v>${dateToXlsxSerial(value)}</v></c>`;
  }
  if (column.type === 'datetime') {
    if (value === null || value === undefined || value === '') return '';
    return `<c r="${ref}" s="${STYLE_DATETIME}"><v>${timestampToXlsxSerial(value)}</v></c>`;
  }
  if (column.type !== 'text') throw new Error('invalid_xlsx_column_type');
  if (value === null || value === undefined || value === '') return '';
  return textCell(ref, value);
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00 &quot;EUR&quot;"/>'
  + '<numFmt numFmtId="165" formatCode="dd.mm.yyyy"/><numFmt numFmtId="166" formatCode="dd.mm.yyyy hh:mm"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

function contentTypesXml(sheetCount) {
  const sheets = Array.from({ length: sheetCount }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" `
    + 'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>';
}

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

// Arkusze mają rId1…rIdN, arkusz stylów rId(N+1).
function workbookRelsXml(sheetCount) {
  const sheets = Array.from({ length: sheetCount }, (_, i) => `<Relationship Id="rId${i + 1}" `
    + `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets
    + `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>';
}

function workbookXml(sheetNames) {
  const sheets = sheetNames.map((name, i) => `<sheet name="${xmlText(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets>${sheets}</sheets></workbook>`;
}

const COLUMN_WIDTH = { text: 24, date: 12, datetime: 17, integer: 10 };

// Jeden arkusz: opcjonalne jednokomórkowe wiersze `preamble` przed nagłówkiem
// i `trailer` po danych (#132 — nazwa klasy, rok, stopka o danych osobowych).
// Wiersz nagłówka kolumn jest zamrożony.
function worksheetXml(columns, rows, { preamble = [], trailer = [] } = {}) {
  const lines = [];
  let r = 0;
  preamble.forEach((text, i) => {
    r += 1;
    lines.push(`<row r="${r}">${text === '' ? '' : textCell(`A${r}`, text, i === 0 ? STYLE_HEADER : 0)}</row>`);
  });
  r += 1;
  const headerRow = r;
  const headerCells = columns.map((column, i) => textCell(`${columnLetters(i)}${r}`, column.header, STYLE_HEADER)).join('');
  lines.push(`<row r="${r}">${headerCells}</row>`);
  rows.forEach((values) => {
    if (values.length !== columns.length) throw new Error('xlsx_row_length_mismatch');
    r += 1;
    const cells = columns.map((column, i) => cellXml(column, values[i], `${columnLetters(i)}${r}`)).join('');
    lines.push(`<row r="${r}">${cells}</row>`);
  });
  trailer.forEach((text) => {
    r += 1;
    lines.push(`<row r="${r}">${text === '' ? '' : textCell(`A${r}`, text)}</row>`);
  });
  const lastRef = `${columnLetters(Math.max(columns.length, 1) - 1)}${r}`;
  const cols = columns.map((column, i) => {
    const width = COLUMN_WIDTH[column.type] ?? 16;
    return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="A1:${lastRef}"/>`
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<cols>${cols}</cols><sheetData>${lines.join('')}</sheetData></worksheet>`;
}

// sheets: [{ name, columns, rows, preamble?, trailer? }] — kolejność = kolejność
// kart w pliku. Nazwy arkuszy po sheetNameOf muszą być różne (arkusz nie
// rozróżnia wielkości liter). Zwraca Uint8Array z plikiem XLSX.
export function toXlsxWorkbook(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('xlsx_no_sheets');
  const names = sheets.map((sheet) => sheetNameOf(sheet.name));
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new Error('xlsx_duplicate_sheet_name');
  const mtime = Date.UTC(2000, 0, 1); // stała data: ten sam wynik bajt w bajt dla tych samych danych
  const file = (text) => [strToU8(text), { mtime }];
  const parts = {
    '[Content_Types].xml': file(contentTypesXml(sheets.length)),
    '_rels/.rels': file(ROOT_RELS),
    'xl/workbook.xml': file(workbookXml(names)),
    'xl/_rels/workbook.xml.rels': file(workbookRelsXml(sheets.length)),
    'xl/styles.xml': file(STYLES),
  };
  sheets.forEach((sheet, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = file(worksheetXml(sheet.columns, sheet.rows, sheet));
  });
  return zipSync(parts, { level: 6 });
}

// columns: [{ header, type }]; rows: tablice wartości w kolejności kolumn
// (jak w toCsv). Opcjonalnie `preamble` / `trailer` (jak w toCsv). Jeden arkusz.
export function toXlsx(columns, rows, { sheetName = 'Arkusz', preamble = [], trailer = [] } = {}) {
  return toXlsxWorkbook([{ name: sheetName, columns, rows, preamble, trailer }]);
}

export function xlsxResponse(bytes, filename, extraHeaders = {}) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}
