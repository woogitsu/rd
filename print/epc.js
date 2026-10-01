// Ładunek kodu QR EPC (SEPA QR, wytyczne EPC069-12), issue #92. Czysta funkcja —
// nie generuje obrazu (to biblioteka QR po stronie klienta), tylko 12-liniowy
// tekst do zakodowania. Testy w tests/epc.test.js.
//
// Pola (kolejność ma znaczenie, każda linia zakończona \n, kodowanie UTF-8):
//   1 BCD  2 002 (wersja)  3 1 (UTF-8)  4 SCT  5 BIC (może być puste w EOG)
//   6 nazwa odbiorcy (<=70)  7 IBAN  8 kwota "EUR12.35" (może być pusta)
//   9 cel (puste)  10 referencja strukturalna (RF/OGM-VCS) XOR 11 tytuł (<=140)  12 info (<=70)
// Limit całości: 331 bajtów UTF-8 (specyfikacja EPC069-12).

import { isValidIban, normalizeIban } from "./iban.js";
import { isValidStructuredReference } from "../src/pg/ogm.js";

export const MAX_EPC_BYTES = 331;
export const MAX_NAME_LENGTH = 70;
export const MAX_UNSTRUCTURED_LENGTH = 140;
export const MAX_INFO_LENGTH = 70;

export class EpcError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function assert(condition, code) {
  if (!condition) throw new EpcError(code);
}

// Kwota w QR wg specyfikacji: "EUR" + liczba z kropką dziesiętną, bez separatora
// tysięcy, 2 miejsca po przecinku, > 0 i <= 999999999.99. Puste pole = brak
// kwoty w QR (składka dobrowolna — domyślne zachowanie, patrz AGENTS.md).
function formatEpcAmount(amountCents) {
  if (amountCents === null || amountCents === undefined) return "";
  assert(Number.isSafeInteger(amountCents) && amountCents > 0, "invalid_amount");
  assert(amountCents <= 99_999_999_999, "invalid_amount");
  const euros = Math.trunc(amountCents / 100);
  const cents = String(amountCents % 100).padStart(2, "0");
  return `EUR${euros}.${cents}`;
}

// Znaki sterujące (w tym \n, \r, \t) w polu tekstowym rozbiłyby 12-liniowy
// ładunek i podmieniły kolejne pola (np. IBAN) — odrzucamy je, nie czyścimy.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
// BIC (ISO 9362): 4 litery banku, 2 litery kraju, 2 znaki lokalizacji, opcjonalnie 3 znaki oddziału.
const BIC_PATTERN = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

function byteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * @param {object} input
 * @param {string} input.iban
 * @param {string} [input.bic]           opcjonalny w SEPA/EOG
 * @param {string} input.name            nazwa odbiorcy, <=70 znaków
 * @param {number|null} [input.amountCents]  kwota w centach EUR albo null/undefined (pole puste — domyślne)
 * @param {string} [input.structuredReference]  12-cyfrowa referencja OGM-VCS (#83) — bez separatorów/+++/***
 * @param {string} [input.unstructuredText]      tytuł niestrukturalny — TYLKO gdy brak structuredReference
 * @param {string} [input.info]           informacja odbiorcy do płatnika, <=70 znaków
 * @returns {string} 12-liniowy ładunek EPC (linie oddzielone "\n")
 */
export function buildEpcPayload({
  iban, bic = "", name, amountCents = null, structuredReference = "", unstructuredText = "", info = "",
}) {
  const normalizedIban = normalizeIban(iban);
  assert(isValidIban(normalizedIban), "invalid_iban");
  const trimmedName = String(name ?? "").trim();
  assert(trimmedName.length > 0 && [...trimmedName].length <= MAX_NAME_LENGTH, "invalid_name");
  assert(!CONTROL_CHARS.test(trimmedName), "invalid_name");
  const trimmedInfo = String(info ?? "").trim();
  assert([...trimmedInfo].length <= MAX_INFO_LENGTH, "invalid_info");
  assert(!CONTROL_CHARS.test(trimmedInfo), "invalid_info");
  const trimmedBic = String(bic ?? "").trim().toUpperCase();
  if (trimmedBic) assert(BIC_PATTERN.test(trimmedBic), "invalid_bic");

  const structured = String(structuredReference ?? "").trim();
  const unstructured = String(unstructuredText ?? "").trim();
  assert(!(structured && unstructured), "invalid_remittance_both");
  // OGM-VCS: 12 cyfr z poprawną sumą kontrolną mod 97 (#83).
  if (structured) assert(isValidStructuredReference(structured), "invalid_structured_reference");
  assert([...unstructured].length <= MAX_UNSTRUCTURED_LENGTH, "invalid_unstructured_text");
  assert(!CONTROL_CHARS.test(unstructured), "invalid_unstructured_text");

  const amount = formatEpcAmount(amountCents);

  const lines = [
    "BCD",
    "002",
    "1",
    "SCT",
    trimmedBic,
    trimmedName,
    normalizedIban,
    amount,
    "",
    structured,
    unstructured,
    trimmedInfo,
  ];
  const payload = lines.join("\n");
  assert(byteLength(payload) <= MAX_EPC_BYTES, "epc_payload_too_large");
  return payload;
}
