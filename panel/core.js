import { MoneyError, formatEur, parseEurInput } from "./money.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const METHOD_LABELS = Object.freeze({
  bank: "Przelew",
  cash: "Gotówka",
  other: "Inna",
});

export const STATUS_LABELS = Object.freeze({
  recorded: "Przypisana",
  unmatched: "Do przypisania",
});

export function isValidId(value) {
  return typeof value === "string" && ID_PATTERN.test(value.trim());
}

// #173: jeden moduł kwot EUR (src/pg i panele) — patrz panel/money.js.
export function formatCents(value) {
  return formatEur(value, { style: "screen" });
}

export function parseEuroAmount(value) {
  try {
    return parseEurInput(value);
  } catch (error) {
    if (error instanceof MoneyError && error.code === "amount_out_of_range") {
      throw new Error("Kwota musi mieścić się między 0,01 EUR a 1 000 000 EUR.");
    }
    // Treść zgodna z poprzednim komunikatem (tests/ledger-panel-core.test.js) —
    // maksymalnie dwa miejsca po przecinku to najczęstsza przyczyna błędu formatu.
    throw new Error("Podaj kwotę z maksymalnie dwoma miejscami po przecinku.");
  }
}

export function buildPaymentsUrl({ schoolYearId, status = "", cursor = "", limit = 50 }) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  if (status && !Object.hasOwn(STATUS_LABELS, status)) throw new Error("Nieznany status wpłaty.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Niepoprawny limit wyników.");

  const params = new URLSearchParams({ schoolYearId: schoolYearId.trim(), limit: String(limit) });
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return `/api/payments?${params.toString()}`;
}

export function makeIdempotencyKey(prefix, randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUUID !== "function") throw new Error("Ta przeglądarka nie obsługuje bezpiecznych identyfikatorów operacji.");
  return `${prefix}-${randomUUID()}`;
}

export function normalizePayment(payment) {
  const amountCents = Number(payment?.amountCents);
  const correctedCents = Number(payment?.correctedCents ?? 0);

  return {
    id: String(payment?.id ?? ""),
    schoolYearId: String(payment?.schoolYearId ?? ""),
    householdId: payment?.householdId ? String(payment.householdId) : null,
    receivedOn: String(payment?.receivedOn ?? ""),
    method: Object.hasOwn(METHOD_LABELS, payment?.method) ? payment.method : "other",
    status: Object.hasOwn(STATUS_LABELS, payment?.status) ? payment.status : "unmatched",
    reference: String(payment?.reference ?? ""),
    amountCents: Number.isSafeInteger(amountCents) ? amountCents : 0,
    correctedCents: Number.isSafeInteger(correctedCents) ? correctedCents : 0,
    netCents: Number.isSafeInteger(Number(payment?.netAmountCents))
      ? Number(payment.netAmountCents)
      : Number.isSafeInteger(amountCents) && Number.isSafeInteger(correctedCents)
        ? amountCents - correctedCents
        : 0,
  };
}
