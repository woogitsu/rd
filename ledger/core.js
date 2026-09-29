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

// #117: wynik wydarzeń (centra kosztów) — GET /api/ledger/cost-centers.
export function buildCostCentersUrl(schoolYearId, format = "json") {
  if (!isValidId(schoolYearId) || !["json", "csv"].includes(format)) throw new Error("Niepoprawne parametry wyniku wydarzeń.");
  return `/api/ledger/cost-centers?${new URLSearchParams({ schoolYearId: schoolYearId.trim(), type: "event", format })}`;
}

const EVENT_STATUS_LABELS = Object.freeze({ draft: "szkic", submitted: "zgłoszone", approved: "zatwierdzone", published: "opublikowane", cancelled: "odwołane" });

// Wiersze tabeli: wydarzenia, potem „Bez przypisania” i „Razem rok” (suma = bilans roku).
export function costCenterRows(report) {
  const toRow = (name, status, entryCount, item) => ({
    name, status, entryCount,
    income: formatCents(Number(item?.incomeCents) || 0),
    expense: formatCents(Number(item?.expenseCents) || 0),
    result: formatCents(Number(item?.resultCents) || 0),
    negative: Number(item?.resultCents) < 0,
  });
  const centers = (Array.isArray(report?.centers) ? report.centers : [])
    .map((c) => toRow(String(c.name ?? c.id ?? ""), EVENT_STATUS_LABELS[c.status] ?? "—", Number(c.entryCount) || 0, c));
  return {
    centers,
    general: toRow("Bez przypisania", "", null, report?.general),
    totals: toRow("Razem rok", "", null, report?.totals),
  };
}

// #93: lista uchwał do wyboru zamiast wolnego tekstu (GET /api/ledger/resolutions — numer,
// tytuł, kwoty; bez treści uchwały, D-09).
export function buildResolutionsUrl(schoolYearId) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  return `/api/ledger/resolutions?${new URLSearchParams({ schoolYearId: schoolYearId.trim() })}`;
}

// Opis pozycji listy uchwał; kwoty w centach EUR. Brak upoważnienia kwotowego to
// „bez limitu kwoty” (D-15, wariant zachowawczy: kwota opcjonalna), nie limit zerowy.
export function resolutionOptionLabel(item) {
  const number = String(item?.number ?? "").trim() || "bez numeru";
  const title = String(item?.title ?? "").trim();
  const remaining = Number.isSafeInteger(item?.remainingCents) ? `pozostało ${formatCents(item.remainingCents)}` : "bez limitu kwoty";
  return `${number}${title ? ` — ${title}` : ""} (${remaining})`;
}

// Limit upoważnienia wybranej uchwały względem kwoty wydatku. Serwer i tak
// rozstrzyga (409 resolution_amount_exceeded/expired); to podpowiedź przed zapisem.
export function resolutionLimitInfo(item, amountCents, occurredOn = "") {
  if (!item) return { text: "", exceeded: false, expired: false };
  const parts = [];
  const hasLimit = Number.isSafeInteger(item.authorizedAmountCents);
  if (hasLimit) {
    parts.push(`Upoważnienie: ${formatCents(item.authorizedAmountCents)}`);
    parts.push(`wykorzystano ${formatCents(Number(item.spentNetCents) || 0)}`);
    parts.push(`pozostało ${formatCents(Number(item.remainingCents) || 0)}`);
  } else {
    parts.push("Uchwała nie określa kwoty upoważnienia");
  }
  if (item.validUntil) parts.push(`ważne do ${item.validUntil}`);
  const exceeded = hasLimit && Number.isSafeInteger(amountCents) && amountCents > Number(item.remainingCents);
  const expired = Boolean(item.validUntil && occurredOn && occurredOn > item.validUntil);
  let text = parts.join(", ") + ".";
  if (exceeded) text += " Kwota wydatku przekracza pozostałą kwotę upoważnienia — zapis zostanie odrzucony.";
  if (expired) text += " Data wydatku jest późniejsza niż termin upoważnienia — zapis zostanie odrzucony.";
  return { text, exceeded, expired };
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
  // #107: "budget/execution" — preliminarz (przyjęty i bieżący) a wykonanie netto per kategoria.
  if (!["categories", "summary", "budget", "budget/execution"].includes(resource) || !isValidId(schoolYearId)) {
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
    // #87: liczba dowodów (dokument główny + dołączone); null, gdy API jej nie podaje.
    attachmentCount: Array.isArray(entry?.attachmentIds) ? entry.attachmentIds.length : null,
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

// #107: wiersz zestawienia plan vs wykonanie dla tabeli panelu. Brak planu to
// „poza planem”, nie plan zerowy; przekroczenie opisane tekstem, nie tylko kolorem.
export function budgetExecutionRow(item) {
  const planned = Number.isSafeInteger(item?.currentPlanCents) ? item.currentPlanCents : null;
  const executed = Number.isSafeInteger(item?.executedNetCents) ? item.executedNetCents : 0;
  const percent = typeof item?.executionPercent === "number" ? `${String(item.executionPercent).replace(".", ",")}%` : "—";
  const notes = [];
  if (item?.active === false) notes.push("kategoria wyłączona");
  if (planned === null) notes.push("poza planem");
  if (item?.overBudget) notes.push("przekroczenie planu");
  return {
    categoryName: String(item?.categoryName ?? "Bez kategorii"),
    direction: Object.hasOwn(DIRECTION_LABELS, item?.direction) ? item.direction : "expense",
    planned: planned === null ? "—" : formatCents(planned),
    executed: formatCents(executed),
    percent,
    note: notes.join(", "),
    overBudget: Boolean(item?.overBudget),
  };
}

// #107 (panel): historia wersji preliminarza i formularze zapisu. Wszystkie trasy są
// istniejące i autoryzowane po stronie serwera; ukrywanie przycisków to tylko skrót.
export function buildBudgetHistoryUrl(schoolYearId) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  return `/api/ledger/budget/history?${new URLSearchParams({ schoolYearId: schoolYearId.trim() })}`;
}

// Przyjęcie preliminarza zapisuje wyłącznie zarząd (ADOPTION_ROLES w ledger-budget.js).
export function canAdoptBudget(grants, schoolYearId = "") {
  return (Array.isArray(grants) ? grants : []).some((grant) => grant?.role === "board"
    && !grant.classId
    && (!schoolYearId || !grant.schoolYearId || grant.schoolYearId === String(schoolYearId).trim()));
}

function shortTimestamp(value) {
  return typeof value === "string" && value.length >= 16 ? `${value.slice(0, 10)} ${value.slice(11, 16)} UTC` : String(value ?? "—");
}

// Wersje linii per kategoria (numer wersji 1…n według kolejności zapisu) i przyjęcia,
// w których dana wersja weszła do „planu przyjętego”. Kwoty w centach EUR.
export function budgetHistoryView(history) {
  const lines = Array.isArray(history?.lines) ? history.lines : [];
  const adoptions = Array.isArray(history?.adoptions) ? history.adoptions : [];
  const versionOf = new Map();
  const perCategory = new Map();
  for (const line of lines) {
    const count = (perCategory.get(line.categoryId) ?? 0) + 1;
    perCategory.set(line.categoryId, count);
    versionOf.set(line.id, count);
  }
  const adoptedOn = (lineId) => adoptions.filter((a) => Array.isArray(a.lineIds) && a.lineIds.includes(lineId)).map((a) => a.adoptedOn);
  const rows = lines.map((line) => ({
    id: String(line.id),
    categoryId: String(line.categoryId ?? ""),
    categoryName: String(line.categoryName ?? "Bez kategorii"),
    direction: Object.hasOwn(DIRECTION_LABELS, line.direction) ? line.direction : "expense",
    version: versionOf.get(line.id),
    planned: Number.isSafeInteger(line.plannedCents) ? formatCents(line.plannedCents) : "—",
    plannedCents: Number.isSafeInteger(line.plannedCents) ? line.plannedCents : null,
    reason: line.note ? String(line.note) : "—",
    createdBy: String(line.createdBy ?? "—"),
    createdAt: shortTimestamp(line.createdAt),
    current: line.current === true,
    adoptedOn: adoptedOn(line.id),
  }));
  const adoptionRows = adoptions.map((a) => ({
    id: String(a.id),
    adoptedOn: String(a.adoptedOn ?? "—"),
    note: String(a.note ?? "—"),
    resolution: a.resolutionNumber ? String(a.resolutionNumber) : "—",
    adoptedBy: String(a.adoptedBy ?? "—"),
    lineCount: Array.isArray(a.lineIds) ? a.lineIds.length : 0,
  }));
  return { rows, adoptionRows, currentLines: rows.filter((row) => row.current) };
}

function trimmedText(value, min, max, message) {
  const text = String(value ?? "").trim();
  if (text.length < min || text.length > max) throw new Error(message);
  return text;
}

// Treści żądań; kwoty zawsze w centach (parseEuroAmount), plan musi być większy od zera.
export function categoryRequestBody({ schoolYearId, direction, name }) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  if (!Object.hasOwn(DIRECTION_LABELS, direction)) throw new Error("Nieznany rodzaj kategorii.");
  return { schoolYearId: schoolYearId.trim(), direction, name: trimmedText(name, 2, 100, "Nazwa kategorii ma 2–100 znaków.") };
}

export function deactivationRequestBody({ categoryId, reason }) {
  if (!isValidId(categoryId)) throw new Error("Wybierz kategorię.");
  return { categoryId, body: { reason: trimmedText(reason, 3, 500, "Podaj powód (3–500 znaków).") } };
}

export function budgetLineRequestBody({ schoolYearId, categoryId, amount, note }) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  if (!isValidId(categoryId)) throw new Error("Wybierz kategorię.");
  const body = { schoolYearId: schoolYearId.trim(), categoryId, plannedCents: parseEuroAmount(amount) };
  const text = String(note ?? "").trim();
  if (text) body.note = trimmedText(text, 3, 500, "Uwaga ma 3–500 znaków.");
  return body;
}

export function budgetRevisionRequestBody({ lineId, amount, reason }) {
  if (!isValidId(lineId)) throw new Error("Wybierz linię preliminarza.");
  return { lineId, body: { plannedCents: parseEuroAmount(amount), reason: trimmedText(reason, 3, 500, "Podaj powód (3–500 znaków).") } };
}

export function budgetAdoptionRequestBody({ schoolYearId, adoptedOn, note, resolutionId }) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(adoptedOn ?? ""))) throw new Error("Podaj datę przyjęcia.");
  const body = { schoolYearId: schoolYearId.trim(), adoptedOn, note: trimmedText(note, 3, 500, "Podaj opis przyjęcia (3–500 znaków).") };
  const resolution = String(resolutionId ?? "").trim();
  if (resolution) {
    if (!isValidId(resolution)) throw new Error("Niepoprawny identyfikator uchwały.");
    body.resolutionId = resolution;
  }
  return body;
}
