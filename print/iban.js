// Walidacja IBAN (ISO 13616, suma kontrolna mod 97), issue #92. Czysta funkcja,
// bez dostępu do DOM/sieci — testy w tests/iban.test.js.

const LETTER_VALUE = (char) => char.charCodeAt(0) - 55; // A=10 ... Z=35

export function normalizeIban(value) {
  return String(value ?? "").toUpperCase().replace(/\s+/g, "");
}

// Format ogólny ISO 13616: 2 litery kraju + 2 cyfry kontrolne + do 30 znaków
// alfanumerycznych krajowego BBAN. Belgia (BE) ma zawsze 16 znaków — sprawdzane
// osobno, bo to jedyny kraj używany w tym repozytorium (D-13).
const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const IBAN_BE_SHAPE = /^BE\d{14}$/;

export function isValidIban(value) {
  const iban = normalizeIban(value);
  if (!IBAN_SHAPE.test(iban)) return false;
  if (iban.startsWith("BE") && !IBAN_BE_SHAPE.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric = "";
  for (const char of rearranged) {
    numeric += /[0-9]/.test(char) ? char : String(LETTER_VALUE(char));
  }
  // Liczba może mieć ponad 30 cyfr — BigInt zamiast Number.
  let remainder = 0n;
  for (const digit of numeric) {
    remainder = (remainder * 10n + BigInt(digit)) % 97n;
  }
  return remainder === 1n;
}

// Format do wyświetlenia: grupy po 4 znaki, spacje (nie wpływa na wartość zapisaną w bazie/QR).
export function formatIbanForDisplay(value) {
  const iban = normalizeIban(value);
  return iban.replace(/(.{4})/g, "$1 ").trim();
}
