// Wspólne komórki eksportu CSV (issue #121, część: kwoty jako liczby).
//
// Typ kolumny decyduje o formacie:
// - 'text'   — dowolny tekst z bazy lub od użytkownika; wartość zaczynająca się
//              od = + - @ (także po spacjach wiodących i w wersji pełnej
//              szerokości) albo od tabulatora / CR dostaje prefiks apostrofu,
//              żeby arkusz nie potraktował jej jako formuły;
// - 'amount' — kwota EUR w centach (liczba całkowita), formatowana tutaj jako
//              „-1234,56”; nie przechodzi przez neutralizację, bo powstaje
//              w kodzie, więc ujemna kwota zostaje liczbą w arkuszu.
// - 'amount_or_blank' — jak 'amount', ale null/undefined to pusta komórka
//              (brak planu to nie plan zerowy).
//
// Reguła kwot vs tekst: o neutralizacji decyduje typ KOLUMNY, nie wygląd
// wartości. Kwota ujemna z kolumny 'amount' (np. korekta „-12,50”) zostaje
// liczbą; ta sama treść w kolumnie 'text' (np. opis „-12,50”) dostaje apostrof.
// Dlatego kolumny kwot muszą być zadeklarowane jako 'amount' i przekazywać
// centy jako liczbę całkowitą — tekst „-1250” w takiej kolumnie też przejdzie
// przez toSafeInteger, a „=1+1” zostanie odrzucone błędem, nie wpuszczone.
//
// Jedyne miejsce składania CSV w aplikacji (issue #121): toCsv (wiersze, CRLF),
// csvBytes/csvResponse (BOM UTF-8 + nagłówki załącznika). Separator pól:
// średnik (Excel PL/BE), przecinek dziesiętny. XLSX nie jest generowany —
// repo ma tylko odczyt (import), a zapis wymagałby nowej zależności.

import { toSafeInteger } from './routes/payments.js';
import { formatEur } from '../../panel/money.js';

const FORMULA_START = /^[\t\r]|^\s*[=+\-@＝＋－＠]/;

function quote(text) {
  if (/[";\r\n]/.test(text) || text !== text.trim()) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

// Centy EUR -> „1234,56” (przecinek dziesiętny, bez separatora tysięcy — patrz
// docs/EXPORT.md). #173: formatowanie samo pochodzi z panel/money.js; ten
// wrapper zachowuje wcześniejszy błąd techniczny (zamiast cichej utraty
// precyzji) dla BIGINT poza zakresem bezpiecznych liczb całkowitych.
export function formatEuro(cents) {
  return formatEur(toSafeInteger(cents), { style: 'csv' });
}

export function csvCell(value, type = 'text') {
  if (type === 'amount') return formatEuro(value);
  if (type === 'amount_or_blank') return value === null || value === undefined ? '' : formatEuro(value);
  if (type !== 'text') throw new Error('invalid_csv_column_type');
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return quote(text);
}

// columns: [{ header, type }]; values: tablica w kolejności kolumn.
export function csvRow(columns, values) {
  if (values.length !== columns.length) throw new Error('csv_row_length_mismatch');
  return columns.map((column, index) => csvCell(values[index], column.type)).join(';');
}

export function csvHeader(columns) {
  return columns.map((column) => csvCell(column.header)).join(';');
}

export const CSV_BOM = '\uFEFF';

// Cały plik: opcjonalne wiersze przed nagłówkiem (preamble) i po danych
// (trailer) to gotowe linie (np. z csvRow); nagłówek + wiersze danych;
// zakończenie CRLF (RFC 4180). Bez BOM — dodaje go csvBytes/csvResponse.
export function toCsv(columns, rows, { preamble = [], trailer = [] } = {}) {
  const lines = [...preamble, csvHeader(columns), ...rows.map((values) => csvRow(columns, values)), ...trailer];
  return `${lines.join('\r\n')}\r\n`;
}

// Fragment nazwy pliku: tylko ASCII bezpieczne w nagłówku i systemie plików.
export function safeFileSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
}

// Ciało pliku CSV z BOM UTF-8 (Excel poprawnie czyta polskie znaki).
export function csvBytes(text) {
  return text.startsWith(CSV_BOM) ? text : `${CSV_BOM}${text}`;
}

export function csvResponse(text, filename, extraHeaders = {}) {
  return new Response(csvBytes(text), {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}
