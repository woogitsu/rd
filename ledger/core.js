import { MoneyError, formatEur, parseEurInput } from "../panel/money.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const DIRECTION_LABELS = Object.freeze({ income: "Przychód", expense: "Wydatek" });
export const METHOD_LABELS = Object.freeze({ bank: "Przelew", cash: "Gotówka", card: "Karta", other: "Inna" });

export function isValidId(value) {
  return typeof value === "string" && ID_PATTERN.test(value.trim());
}

// #173: jeden moduł kwot EUR (panel/money.js) dla wszystkich paneli i serwera.
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

export function needsResolution(direction, amountCents) {
  return direction === "expense" && Number(amountCents) > 300_000;
}

export function buildLedgerUrl({ schoolYearId, direction = "", cursor = "", limit = 50 }) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  if (direction && !Object.hasOwn(DIRECTION_LABELS, direction)) throw new Error("Nieznany rodzaj wpisu.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Niepoprawny limit wyników.");
  const params = new URLSearchParams({ schoolYearId: schoolYearId.trim(), limit: String(limit) });
  if (direction) params.set("direction", direction);
  if (cursor) params.set("cursor", cursor);
  return `/api/ledger?${params}`;
}

// Zapytanie listy zapamiętywane przy wczytaniu roku (#192); „Wczytaj następne”
// używa tylko tego zapytania i kursora, nie bieżących pól formularza.
export function ledgerQuery({ schoolYearId, direction = "" }) {
  buildLedgerUrl({ schoolYearId, direction });
  return Object.freeze({ schoolYearId: String(schoolYearId).trim(), direction: String(direction ?? "") });
}

// Adres następnej strony albo null, gdy nie ma kursora lub zapytania.
export function buildNextLedgerUrl(query, cursor) {
  if (!query || typeof cursor !== "string" || cursor === "") return null;
  return buildLedgerUrl({ ...query, cursor });
}

// true, gdy pola formularza różnią się od zapytania wyświetlonej księgi.
export function ledgerFilterChanged(query, current) {
  if (!query) return false;
  return String(current?.schoolYearId ?? "").trim() !== query.schoolYearId
    || String(current?.direction ?? "") !== query.direction;
}

export function buildOverviewUrl(resource, schoolYearId, direction = "") {
  if (!["categories", "summary", "budget"].includes(resource) || !isValidId(schoolYearId)) {
    throw new Error("Niepoprawne parametry podsumowania.");
  }
  const params = new URLSearchParams({ schoolYearId: schoolYearId.trim() });
  if (direction) {
    if (resource !== "categories" || !Object.hasOwn(DIRECTION_LABELS, direction)) {
      throw new Error("Niepoprawny filtr kategorii.");
    }
    params.set("direction", direction);
  }
  return `/api/ledger/${resource}?${params}`;
}

export function normalizeEntry(entry) {
  const amountCents = Number(entry?.amountCents);
  const correctedCents = Number(entry?.correctedCents ?? 0);
  return {
    id: String(entry?.id ?? ""),
    direction: Object.hasOwn(DIRECTION_LABELS, entry?.direction) ? entry.direction : "income",
    categoryName: String(entry?.categoryName ?? "Bez kategorii"),
    description: String(entry?.description ?? ""),
    occurredOn: String(entry?.occurredOn ?? ""),
    method: Object.hasOwn(METHOD_LABELS, entry?.method) ? entry.method : "other",
    source: entry?.source ? String(entry.source) : "",
    resolutionReference: entry?.resolutionReference ? String(entry.resolutionReference) : "",
    amountCents: Number.isSafeInteger(amountCents) ? amountCents : 0,
    correctedCents: Number.isSafeInteger(correctedCents) ? correctedCents : 0,
    netCents: Number.isSafeInteger(Number(entry?.netAmountCents))
      ? Number(entry.netAmountCents)
      : (Number.isSafeInteger(amountCents) ? amountCents : 0) - (Number.isSafeInteger(correctedCents) ? correctedCents : 0),
  };
}

export function makeIdempotencyKey(prefix, randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUUID !== "function") throw new Error("Ta przeglądarka nie obsługuje bezpiecznych identyfikatorów operacji.");
  return `${prefix}-${randomUUID()}`;
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
