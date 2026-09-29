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

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
export const MAX_SEARCH_LENGTH = 100;

// Filtry listy wpłat poza rokiem (#128); puste wartości są pomijane w adresie.
const EXTRA_FILTERS = Object.freeze(["dateFrom", "dateTo", "method", "householdId", "q"]);

function normalizeExtraFilters(filters) {
  const out = {};
  for (const key of EXTRA_FILTERS) out[key] = String(filters?.[key] ?? "").trim();
  return out;
}

// Zapytanie zawiera tylko wypełnione filtry dodatkowe (puste nie zmieniają kształtu).
function filledExtraFilters(filters) {
  return Object.fromEntries(Object.entries(normalizeExtraFilters(filters)).filter(([, value]) => value !== ""));
}

function checkExtraFilters(extra) {
  if ((extra.dateFrom && !isValidDate(extra.dateFrom)) || (extra.dateTo && !isValidDate(extra.dateTo))) {
    throw new Error("Podaj poprawną datę.");
  }
  if (extra.dateFrom && extra.dateTo && extra.dateFrom > extra.dateTo) {
    throw new Error("Data końca nie może być wcześniejsza niż data początku.");
  }
  if (extra.method && !Object.hasOwn(METHOD_LABELS, extra.method)) throw new Error("Nieznany sposób wpłaty.");
  if (extra.householdId && !isValidId(extra.householdId)) throw new Error("Niepoprawny wybór rodziny.");
  if (extra.q.length > MAX_SEARCH_LENGTH) throw new Error(`Fraza może mieć najwyżej ${MAX_SEARCH_LENGTH} znaków.`);
}

export function buildPaymentsUrl({ schoolYearId, status = "", cursor = "", limit = 50, ...filters }) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  if (status && !Object.hasOwn(STATUS_LABELS, status)) throw new Error("Nieznany status wpłaty.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Niepoprawny limit wyników.");
  const extra = normalizeExtraFilters(filters);
  checkExtraFilters(extra);

  const params = new URLSearchParams({ schoolYearId: schoolYearId.trim(), limit: String(limit) });
  if (status) params.set("status", status);
  for (const key of EXTRA_FILTERS) if (extra[key]) params.set(key, extra[key]);
  if (cursor) params.set("cursor", cursor);
  return `/api/payments?${params.toString()}`;
}

// Zapytanie listy zapamiętywane przy wczytaniu pierwszej strony (#192).
// „Wczytaj następne” używa wyłącznie tego zapytania i kursora z serwera,
// nigdy bieżących, niezatwierdzonych pól formularza.
export function paymentsQuery({ schoolYearId, status = "", ...filters }) {
  buildPaymentsUrl({ schoolYearId, status, ...filters });
  return Object.freeze({
    schoolYearId: String(schoolYearId).trim(),
    status: String(status ?? ""),
    ...filledExtraFilters(filters),
  });
}

// Adres następnej strony albo null, gdy nie ma czego dociągać (brak kursora lub zapytania).
export function buildNextPaymentsUrl(query, cursor) {
  if (!query || typeof cursor !== "string" || cursor === "") return null;
  return buildPaymentsUrl({ ...query, cursor });
}

// true, gdy pola formularza różnią się od zapytania, które dało wyświetloną listę.
export function paymentsFilterChanged(query, current) {
  if (!query) return false;
  const extra = normalizeExtraFilters(current);
  return String(current?.schoolYearId ?? "").trim() !== query.schoolYearId
    || String(current?.status ?? "") !== query.status
    || EXTRA_FILTERS.some((key) => extra[key] !== (query[key] ?? ""));
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

// Role finansowe jak FINANCIAL_ROLES w src/pg/routes/payments.js i ledger.js (test
// tests/role-policy-parity.test.js pilnuje zgodności). Liczą się tylko przydziały bez klasy
// (isAuthorizedScoped bez classId). Ukrycie akcji to skrót — serwer i tak autoryzuje (#225).
export const FINANCIAL_ROLES = Object.freeze(["admin", "board", "treasurer"]);

export function hasFinancialAccess(grants, schoolYearId = "") {
  return (Array.isArray(grants) ? grants : []).some((grant) => FINANCIAL_ROLES.includes(grant?.role)
    && !grant.classId
    && (!schoolYearId || !grant.schoolYearId || grant.schoolYearId === String(schoolYearId).trim()));
}

// Opis błędu HTTP dla osoby korzystającej z panelu: 403 to brak uprawnień, nie awaria.
export function describeApiError(status, code) {
  if (status === 401 || code === "unauthenticated") return "Sesja wygasła. Zaloguj się ponownie.";
  if (code === "mfa_required") return "Potwierdź logowanie drugim składnikiem (MFA), aby korzystać z finansów.";
  if (status === 403 || code === "forbidden") return "Nie masz uprawnień do tej operacji w wybranym roku szkolnym.";
  return null;
}
