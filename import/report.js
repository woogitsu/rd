// Raport importu do pobrania lokalnie (#109) i wykaz pominiętych kolumn.
// Generowany w przeglądarce, bez zapisu na serwerze. Zawiera wyłącznie numer
// wiersza źródłowego, etap, rodzaj i komunikat — nigdy imię, nazwisko ani
// e-mail (patrz AGENTS.md: brak danych osobowych w raportach/logach).
import { toCsv } from '../src/pg/csv.js';

const REPORT_COLUMNS = [
  { header: 'Wiersz', type: 'text' },
  { header: 'Etap', type: 'text' },
  { header: 'Rodzaj', type: 'text' },
  { header: 'Komunikat', type: 'text' },
];

const STAGE_LABELS = { file: 'plik', server: 'serwer' };
const KIND_LABELS = { error: 'błąd', warning: 'uwaga', conflict: 'konflikt', skipped: 'pominięty' };

// entries: [{ row, stage: 'file'|'server', kind: 'error'|'warning'|'conflict'|'skipped', message }]
export function buildErrorReportCsv(entries) {
  // BOM dodaje dopiero pobieranie pliku (csvBytes w import/main.js).
  return toCsv(REPORT_COLUMNS, entries.map((entry) => [
    String(entry.row ?? ''),
    STAGE_LABELS[entry.stage] ?? String(entry.stage ?? ''),
    KIND_LABELS[entry.kind] ?? String(entry.kind ?? ''),
    String(entry.message ?? ''),
  ]));
}

// Nagłówki wskazujące dane, których Rada nie powinna dostawać importem
// (docs/DECISIONS.md, lista wykluczeń). Dopasowanie tylko do nazwy kolumny,
// nigdy do wartości komórek.
const EXCLUDED_HEADER_PATTERNS = [
  { pattern: /pesel/i, label: 'PESEL' },
  { pattern: /adres|zamieszkani/i, label: 'adres' },
  { pattern: /telefon|\btel\.?\b/i, label: 'telefon' },
  { pattern: /ocen/i, label: 'oceny' },
  { pattern: /zdrow|chorob|diagnoz|alergi/i, label: 'dane zdrowotne' },
  { pattern: /dowod|paszport|legitymacj/i, label: 'numer dokumentu' },
];

export function excludedHeaderLabel(header) {
  const match = EXCLUDED_HEADER_PATTERNS.find(({ pattern }) => pattern.test(header));
  return match ? match.label : null;
}

// Kolumny z pliku, których mapowanie nie użyje (#109, docs/DECISIONS.md:
// „kolumny spoza zatwierdzonej listy importer powinien pomijać i wykazywać
// w raporcie”). Zwraca nazwy nagłówków, nigdy wartości komórek.
export function unusedColumns(headers, mapping) {
  const used = new Set(Object.values(mapping).filter((v) => v !== '' && v !== undefined).map(Number));
  return headers
    .map((header, index) => ({ index, header: header || '(bez nazwy)', excluded: excludedHeaderLabel(header) }))
    .filter((column) => !used.has(column.index));
}

// #98: sekcja podglądu „W bazie, brak w pliku”. Przyjmuje tylko to, co zwraca
// serwer ({ count, refs }) — liczbę i identyfikatory źródłowe uczniów, bez imion.
// Wyłącznie informacja: import niczego nie wypisuje ani nie archiwizuje.
export const MISSING_FROM_FILE_LIMIT = 40;
export function missingFromFileSummary(missing) {
  const count = Number(missing?.count) || 0;
  if (!count) return null;
  const refs = (Array.isArray(missing.refs) ? missing.refs : []).map(String);
  const shown = refs.slice(0, MISSING_FROM_FILE_LIMIT);
  return {
    title: 'W bazie, brak w pliku',
    text: `W wybranym roku w bazie jest uczniów niewystępujących w pliku: ${count}. Import ich nie usuwa ani nie archiwizuje; to tylko informacja do ręcznego wyjaśnienia (np. odejście ze szkoły albo inny plik).`,
    refs: shown,
    more: Math.max(0, count - shown.length),
  };
}
