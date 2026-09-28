// Belgijska komunikacja strukturalna OGM-VCS (Febelfin), issue #83.
// Format: 12 cyfr = 10-cyfrowa baza + 2-cyfrowa suma kontrolna (baza mod 97;
// wynik 0 -> 97). Wyświetlana jako "+++ddd/dddd/ddddd+++".
//
// Czyste funkcje, bez dostępu do bazy/sieci — testy w tests/ogm.test.js.

const DIGITS_12 = /^\d{12}$/;
const DIGITS_10 = /^\d{10}$/;

export class OgmError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Suma kontrolna wg specyfikacji Febelfin: baza (liczba 10-cyfrowa) mod 97;
// wynik 0 traktowany jako 97 (mod97 nigdy nie daje "00"). Number jest
// bezpieczny: 10 cyfr < Number.MAX_SAFE_INTEGER.
export function computeCheckDigits(base10) {
  if (typeof base10 !== 'string' || !DIGITS_10.test(base10)) throw new OgmError('invalid_ogm_base');
  const remainder = Number(base10) % 97;
  return remainder === 0 ? 97 : remainder;
}

// Losowa baza 10-cyfrowa (nie kolejny numer, nie data, nie numer klasy —
// wyłącznie losowość kryptograficzna). Unika samych zer.
export function randomBase() {
  const bytes = new Uint32Array(1);
  let base;
  do {
    crypto.getRandomValues(bytes);
    // 0 .. 9_999_999_999 zmieściłoby się w 34 bitach; ograniczamy do zakresu
    // dziesięciocyfrowego przez modulo, z niewielkim odrzuceniem obciążenia
    // (akceptowalne dla identyfikatora, nie dla kryptografii wysokiego ryzyka).
    base = bytes[0] % 10_000_000_000;
  } while (base === 0);
  return String(base).padStart(10, '0');
}

// Buduje pełną, poprawną referencję (12 cyfr) z losowej bazy.
export function generateStructuredReference() {
  const base = randomBase();
  const check = computeCheckDigits(base);
  return base + String(check).padStart(2, '0');
}

// Sprawdza sumę kontrolną 12-cyfrowego ciągu. Zwraca boolean (nie rzuca —
// wywołujący decyduje o kodzie błędu API).
export function isValidStructuredReference(value) {
  if (typeof value !== 'string' || !DIGITS_12.test(value)) return false;
  const base = value.slice(0, 10);
  const check = Number(value.slice(10));
  try {
    return computeCheckDigits(base) === check;
  } catch {
    return false;
  }
}

// Format do druku/e-maila: +++ddd/dddd/ddddd+++
export function formatStructuredReference(value) {
  if (!DIGITS_12.test(String(value ?? ''))) throw new OgmError('invalid_ogm_reference');
  const digits = String(value);
  return `+++${digits.slice(0, 3)}/${digits.slice(3, 7)}/${digits.slice(7, 12)}+++`;
}

// Wyciąga kandydata na komunikację strukturalną z dowolnego tekstu (tytuł
// przelewu z wyciągu bankowego): z otoczeniem +++.../.../...+++, z ***...***,
// albo 12 kolejnych cyfr bez separatorów, otoczone czymkolwiek. Zwraca 12-cyfrowy
// ciąg TYLKO jeśli suma kontrolna się zgadza — literówka w cyfrze nigdy nie
// daje fałszywego dopasowania. Brak dopasowania -> null (pozycja do ręcznego
// przypisania), nic nie jest tu zatwierdzane automatycznie.
const STRUCTURED_PATTERN = /(?:\+{3}|\*{3})\s*(\d{3})\s*\/\s*(\d{4})\s*\/\s*(\d{5})\s*(?:\+{3}|\*{3})/;
const BARE_PATTERN = /(?<!\d)(\d{3})[\s./-]?(\d{4})[\s./-]?(\d{5})(?!\d)/;

export function extractStructuredReference(text) {
  const input = String(text ?? '');
  const structured = STRUCTURED_PATTERN.exec(input);
  const bare = structured ?? BARE_PATTERN.exec(input);
  if (!bare) return null;
  const candidate = `${bare[1]}${bare[2]}${bare[3]}`;
  return isValidStructuredReference(candidate) ? candidate : null;
}
