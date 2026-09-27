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
// Separator pól: średnik (Excel PL/BE), przecinek dziesiętny.

import { toSafeInteger } from './routes/payments.js';

const FORMULA_START = /^[\t\r]|^\s*[=+\-@＝＋－＠]/;

function quote(text) {
  if (/[";\r\n]/.test(text) || text !== text.trim()) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

// Centy EUR -> „1234,56” (przecinek dziesiętny, bez separatora tysięcy).
export function formatEuro(cents) {
  const value = toSafeInteger(cents);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

export function csvCell(value, type = 'text') {
  if (type === 'amount') return formatEuro(value);
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
