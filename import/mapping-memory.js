// Zapamiętane mapowanie kolumn (#109): słownik „znormalizowany nagłówek → pole”
// w localStorage tej przeglądarki. Nie zawiera żadnych wartości z wierszy, a nagłówki
// z listy wykluczeń (PESEL, adres…) i zbyt długie nie są zapamiętywane.
// Każdy odczyt i zapis w try/catch — strona działa też przy zablokowanym localStorage.
import { FIELDS } from './core.js';
import { excludedHeaderLabel } from './report.js';

export const MAPPING_STORAGE_KEY = 'rd.import.mapping.v1';
const FIELD_KEYS = new Set(FIELDS.map(([key]) => key));
const MAX_HEADERS = 60;
const MAX_HEADER_LENGTH = 80;

export const normalizeHeader = (value) => String(value ?? '').trim().toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ');

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadRememberedMapping(storage = defaultStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem(MAPPING_STORAGE_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [header, field] of Object.entries(parsed)) {
      if (typeof field === 'string' && FIELD_KEYS.has(field) && header.length <= MAX_HEADER_LENGTH) clean[header] = field;
    }
    return clean;
  } catch { return {}; }
}

// Uzupełnia `suggested` (pole → indeks kolumny) zapamiętanymi przypisaniami dla nagłówków
// z tego pliku. Aliasy z guessMapping mają pierwszeństwo; jedna kolumna i jedno pole tylko raz.
export function applyRememberedMapping(headers, suggested, remembered) {
  const result = { ...suggested };
  const usedColumns = new Set(Object.values(result).map(Number));
  headers.forEach((header, index) => {
    const field = remembered[normalizeHeader(header)];
    if (!field || result[field] !== undefined || usedColumns.has(index)) return;
    result[field] = index;
    usedColumns.add(index);
  });
  return result;
}

// mapping: pole → wartość <select> ('' = pomiń, inaczej indeks kolumny jako tekst).
// Zwraca true, gdy zapis się udał.
export function saveRememberedMapping(headers, mapping, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    const stored = loadRememberedMapping(storage);
    for (const [field, value] of Object.entries(mapping)) {
      if (!FIELD_KEYS.has(field) || value === '' || value === undefined) continue;
      const header = normalizeHeader(headers[Number(value)]);
      if (!header || header.length > MAX_HEADER_LENGTH || excludedHeaderLabel(header)) continue;
      // Ten sam nagłówek wskazuje jedno pole: nowszy wybór zastępuje starszy.
      for (const key of Object.keys(stored)) if (stored[key] === field) delete stored[key];
      stored[header] = field;
    }
    const entries = Object.entries(stored).slice(-MAX_HEADERS * 2);
    storage.setItem(MAPPING_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    return true;
  } catch { return false; }
}

export function clearRememberedMapping(storage = defaultStorage()) {
  try { storage?.removeItem(MAPPING_STORAGE_KEY); return true; } catch { return false; }
}

export const hasRememberedMapping = (storage = defaultStorage()) => Object.keys(loadRememberedMapping(storage)).length > 0;
