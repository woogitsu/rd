// Czyste funkcje widoku rodzin (bez DOM), aby dało się je testować w Node.

import { formatEur } from "../panel/money.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ERROR_MESSAGES = {
  unauthenticated: "Sesja wygasła lub nie jesteś zalogowany.",
  forbidden: "Brak uprawnień do danych rodzin.",
  not_found: "Nie znaleziono lub brak dostępu.",
  class_not_found: "Nie znaleziono klasy lub brak dostępu.",
  class_year_mismatch: "Klasa należy do innego roku szkolnego.",
  invalid_email: "Niepoprawny adres e-mail.",
  invalid_reason: "Podaj powód zmiany (3–500 znaków).",
  invalid_effective_on: "Podaj poprawną datę zmiany.",
  invalid_origin: "Żądanie odrzucone (niezgodny origin).",
  service_unavailable: "Usługa chwilowo niedostępna.",
};

export function errorMessage(code, status) {
  return ERROR_MESSAGES[code] ?? `Błąd serwera (${status}).`;
}

export function isValidId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function parseRoute(hash) {
  const path = String(hash || "").replace(/^#/, "");
  const classMatch = path.match(/^\/classes\/([^/]+)$/);
  if (classMatch && isValidId(decodeURIComponent(classMatch[1]))) {
    return { view: "class", id: decodeURIComponent(classMatch[1]) };
  }
  const householdMatch = path.match(/^\/households\/([^/]+)$/);
  if (householdMatch && isValidId(decodeURIComponent(householdMatch[1]))) {
    return { view: "household", id: decodeURIComponent(householdMatch[1]) };
  }
  return { view: "classes" };
}

export const classHref = (id) => `#/classes/${encodeURIComponent(id)}`;
export const householdHref = (id) => `#/households/${encodeURIComponent(id)}`;

export function groupClassesByYear(classes) {
  const groups = new Map();
  for (const item of classes) {
    if (!groups.has(item.schoolYearId)) {
      groups.set(item.schoolYearId, { schoolYearId: item.schoolYearId, label: item.schoolYearLabel, classes: [] });
    }
    groups.get(item.schoolYearId).classes.push(item);
  }
  return [...groups.values()];
}

export function fullName(person) {
  return [person.lastName, person.firstName].filter(Boolean).join(" ");
}

export function canEditFamilies(grants) {
  return Array.isArray(grants) && grants.some((grant) => grant.role === "admin" || grant.role === "board");
}

// #173: jeden moduł kwot EUR (panel/money.js). Wartość null/błędna -> „—”,
// nigdy „0,00 €” (czytane wcześniej jako „brak wpłaty”).
export function formatCents(cents) {
  return formatEur(cents, { style: "screen" });
}

// Zwraca obiekt do PATCH /api/guardians/{id}/contact albo { error }.
export function buildContactPatch({ email, contactAllowed, reason }, current) {
  const trimmedReason = String(reason ?? "").trim();
  if (trimmedReason.length < 3 || trimmedReason.length > 500) return { error: ERROR_MESSAGES.invalid_reason };
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (normalizedEmail && (normalizedEmail.length > 254 || !EMAIL_PATTERN.test(normalizedEmail))) {
    return { error: ERROR_MESSAGES.invalid_email };
  }
  const patch = { reason: trimmedReason };
  if ((normalizedEmail || null) !== (current?.email ?? null)) patch.email = normalizedEmail || null;
  if (Boolean(contactAllowed) !== Boolean(current?.contactAllowed)) patch.contactAllowed = Boolean(contactAllowed);
  if (!("email" in patch) && !("contactAllowed" in patch)) return { error: "Brak zmian do zapisania." };
  return { patch };
}
