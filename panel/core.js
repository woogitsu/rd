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

export function formatCents(value) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) return "—";

  return new Intl.NumberFormat("pl-PL", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

export function parseEuroAmount(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Podaj kwotę z maksymalnie dwoma miejscami po przecinku.");
  }

  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 100_000_000) {
    throw new Error("Kwota musi mieścić się między 0,01 EUR a 1 000 000 EUR.");
  }

  return cents;
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

// Zapytanie listy zapamiętywane przy wczytaniu pierwszej strony (#192).
// „Wczytaj następne” używa wyłącznie tego zapytania i kursora z serwera,
// nigdy bieżących, niezatwierdzonych pól formularza.
export function paymentsQuery({ schoolYearId, status = "" }) {
  buildPaymentsUrl({ schoolYearId, status });
  return Object.freeze({ schoolYearId: String(schoolYearId).trim(), status: String(status ?? "") });
}

// Adres następnej strony albo null, gdy nie ma czego dociągać (brak kursora lub zapytania).
export function buildNextPaymentsUrl(query, cursor) {
  if (!query || typeof cursor !== "string" || cursor === "") return null;
  return buildPaymentsUrl({ ...query, cursor });
}

// true, gdy pola formularza różnią się od zapytania, które dało wyświetloną listę.
export function paymentsFilterChanged(query, current) {
  if (!query) return false;
  return String(current?.schoolYearId ?? "").trim() !== query.schoolYearId
    || String(current?.status ?? "") !== query.status;
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
