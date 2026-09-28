// Wspólne elementy parserów wyciągów bankowych (#105). Czyste funkcje, bez
// zapisu treści pliku. Błąd wskazuje wyłącznie numer rekordu (wiersza CODA
// albo kolejnego elementu XML) — nigdy fragment treści, bo plik wyciągu
// zawiera dane wszystkich kontrahentów.

export class StatementFileError extends Error {
  constructor(code, record = null) {
    super(code);
    this.name = 'StatementFileError';
    this.code = code;
    this.record = record;
  }
}

export const MAX_STATEMENT_FILE_BYTES = 256 * 1024;
export const MAX_STATEMENT_MOVEMENTS = 500;
export const MAX_MOVEMENT_CENTS = 100_000_000;
export const MAX_BALANCE_CENTS = 10_000_000_000;

// IBAN: wielkie litery, bez spacji; poprawna suma kontrolna mod 97 (ISO 13616).
export function normalizeIban(value) {
  if (typeof value !== 'string') return null;
  const iban = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return null;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1 ? iban : null;
}

// Belgijski numer rachunku (BBAN, 12 cyfr) -> IBAN BE.
export function belgianBbanToIban(bban) {
  if (!/^\d{12}$/.test(bban)) return null;
  // BE = 11 14; +00 jako miejsce na cyfry kontrolne.
  let remainder = 0;
  for (const digit of `${bban}111400`) remainder = (remainder * 10 + Number(digit)) % 97;
  const check = String(98 - remainder).padStart(2, '0');
  return normalizeIban(`BE${check}${bban}`);
}

export function validIsoDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === text;
}
