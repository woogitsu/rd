// Czyste funkcje widoku rodzin (bez DOM), aby dało się je testować w Node.
import { errorMessage as sharedErrorMessage } from "../shared/messages.js";

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
  return ERROR_MESSAGES[code] ?? sharedErrorMessage(code, status);
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
  if (path === "/overview") return { view: "overview" };
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

// Pulpit przedstawiciela (/api/representative/overview) jest dostępny tylko z przydziałem
// przedstawiciela; pozostałe role dostawałyby 403 w konsoli (przegląd demo).
export function hasRepresentativeGrant(grants) {
  return Array.isArray(grants) && grants.some((grant) => grant && grant.role === "representative");
}

// Wyszukiwanie po imieniu/nazwisku na już wczytanej liście uczniów klasy (issue #128).
// Filtr działa po stronie klienta — dane są już w przeglądarce, więc nie potrzeba
// nowej trasy API. Dopasowanie jest bez rozróżniania wielkości liter i polskich
// diakrytyków (NFD), tak by "Kowalski" znajdował też "kowalski" czy "Nowicka".
function foldDiacritics(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function filterStudentsByName(students, query) {
  const list = Array.isArray(students) ? students : [];
  const needle = foldDiacritics(query).trim();
  if (!needle) return list;
  return list.filter((student) => foldDiacritics(fullName(student)).includes(needle));
}

// Sortowanie alfabetyczne po nazwisku, potem imieniu (locale pl).
export function sortStudentsByName(students) {
  return [...(Array.isArray(students) ? students : [])].sort((a, b) =>
    fullName(a).localeCompare(fullName(b), "pl", { sensitivity: "base" })
  );
}

// #173: jeden moduł kwot EUR (panel/money.js). Wartość null/błędna -> „—”,
// nigdy „0,00 €” (czytane wcześniej jako „brak wpłaty”).
export function formatCents(cents) {
  return formatEur(cents, { style: "screen" });
}

// Zakończenie opieki (#86, #535). Przyciski „Zakończ …” są tylko podpowiedzią UX
// z /api/access; o dostępie decyduje serwer (403/404 pokazujemy jako komunikat).
export const END_KINDS = Object.freeze({
  enrollment: { label: "Zakończ naukę w szkole", dateLabel: "Data odejścia (ostatni dzień nauki)", field: "endedOn", done: "Zapisano odejście ucznia ze szkoły." },
  relation: { label: "Zakończ opiekę", dateLabel: "Ostatni dzień opieki", field: "endsOn", done: "Zapisano zakończenie relacji opiekun–dziecko." },
  studentHousehold: { label: "Zakończ członkostwo", dateLabel: "Pierwszy dzień poza gospodarstwem", field: "endsOn", done: "Zapisano zakończenie członkostwa ucznia w gospodarstwie." },
  guardianHousehold: { label: "Zakończ członkostwo", dateLabel: "Pierwszy dzień poza gospodarstwem", field: "endsOn", done: "Zapisano zakończenie członkostwa opiekuna w gospodarstwie." },
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Zakres szeroki (admin/zarząd bez klasy): tylko on może kończyć członkostwo opiekuna
// i dodawać członkostwo ucznia. To wyłącznie podpowiedź dla przycisku.
export function canEndGuardianHousehold(grants) {
  return Array.isArray(grants) && grants.some((grant) => (grant?.role === "admin" || grant?.role === "board") && !grant.classId);
}

// target: { kind, studentId?, guardianId?, enrollmentId?, membershipId? }
// Zwraca { url, method, body } albo { error }. Brak identyfikatora = brak trasy.
export function buildEndRequest(target, { date, reason, confirmPersonalData = false } = {}) {
  const spec = END_KINDS[target?.kind];
  if (!spec) return { error: "Nieznana operacja." };
  const part = (value) => (isValidId(value) ? encodeURIComponent(value) : null);
  let url = null;
  if (target.kind === "enrollment") {
    const [s, e] = [part(target.studentId), part(target.enrollmentId)];
    if (s && e) url = `/api/students/${s}/enrollments/${e}/end`;
  } else if (target.kind === "relation") {
    const [g, s] = [part(target.guardianId), part(target.studentId)];
    if (g && s) url = `/api/guardians/${g}/students/${s}/end`;
  } else if (target.kind === "studentHousehold") {
    const [s, m] = [part(target.studentId), part(target.membershipId)];
    if (s && m) url = `/api/students/${s}/households/${m}/end`;
  } else {
    const [g, m] = [part(target.guardianId), part(target.membershipId)];
    if (g && m) url = `/api/guardians/${g}/households/${m}/end`;
  }
  if (!url) return { error: "Brak identyfikatora zapisu — odśwież kartę gospodarstwa." };
  if (!isValidDate(date)) return { error: errorMessage("invalid_ended_on") };
  const trimmed = String(reason ?? "").trim();
  if (trimmed.length < 3 || trimmed.length > 500) return { error: ERROR_MESSAGES.invalid_reason };
  const body = { [spec.field]: date, reason: trimmed };
  if (confirmPersonalData === true) body.confirmPersonalData = true;
  return { url, method: "POST", body };
}

// Komunikaty po udanym zakończeniu: changed:false = powtórka (podwójne kliknięcie),
// campaignsToReview / withoutPrimaryHousehold / withoutHousehold to ostrzeżenia dla zarządu.
export function endResultMessages(kind, response) {
  const spec = END_KINDS[kind];
  const messages = [];
  if (response?.changed === false) {
    messages.push("Ta zmiana była już zapisana wcześniej — nic nie zmieniono.");
  } else if (spec) {
    messages.push(spec.done);
  }
  const campaigns = Array.isArray(response?.campaignsToReview) ? response.campaignsToReview : [];
  if (campaigns.length) {
    messages.push(`Opiekun jest adresatem zatwierdzonych kampanii e-mail (${campaigns.join(", ")}). Wiadomość do niego nie zostanie wysłana; sprawdź te kampanie i w razie potrzeby przygotuj nową migawkę.`);
  }
  if (response?.withoutPrimaryHousehold === true) {
    messages.push("Uczeń nie ma teraz głównego gospodarstwa, więc wypada z kampanii i kartek. Dodaj nowe członkostwo, jeśli to pomyłka.");
  }
  if (response?.withoutHousehold === true) {
    messages.push("Opiekun nie ma teraz żadnego bieżącego gospodarstwa.");
  }
  return messages;
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

// #131: pulpit zarządu — wiersze tabeli statystyk klas. Kolejność zostaje taka,
// jak zwrócił serwer (po nazwie klasy); brak sortowania i kolorów po odsetku.
// Odsetek wpisów wpłat to informacja o ewidencji, nie o zobowiązaniach: null
// (klasa poniżej progu) i brak pola (brak dostępu do danych wpłat) → „—”.
export function formatPercent(value) {
  return Number.isFinite(value) ? `${value}%` : "—";
}

export function hasPaymentColumn(overview) {
  return Boolean(overview?.classes?.length || overview?.totals) && Object.hasOwn(overview?.totals ?? {}, "paymentEntryRatePercent");
}

function boardOverviewRow(label, entry, withPayments) {
  const cells = [
    label,
    String(entry.studentCount),
    String(entry.householdCount),
    String(entry.representative.active),
    String(entry.representative.pendingInvites),
    String(entry.contactEmailCount),
    String(entry.noContactCount),
  ];
  if (withPayments) cells.push(formatPercent(entry.paymentEntryRatePercent));
  return cells;
}

export function overviewRows(overview) {
  const withPayments = hasPaymentColumn(overview);
  const rows = (overview?.classes ?? []).map((item) => boardOverviewRow(item.name, item, withPayments));
  return { withPayments, rows, total: overview?.totals ? boardOverviewRow("Razem", overview.totals, withPayments) : null };
}

// Pulpit przedstawiciela (#118): teksty komórek tabeli „Do zrobienia w klasie”.
// Wyłącznie liczby i daty z GET /api/representative/overview — bez słów o
// zaległościach i bez wpłat (D-08).
function plDate(iso) {
  return iso ? new Date(iso).toLocaleDateString("pl-PL", { timeZone: "Europe/Brussels" }) : null;
}

export function overviewRow(item) {
  const events = item.events ?? {};
  const meeting = item.nextMeeting;
  return {
    id: item.id,
    name: item.name,
    paperCards: `${item.needsPaperCardCount} z ${item.studentCount}`,
    lastPrinted: plDate(item.cards?.lastPrintedAt) ?? "brak wydruku w dzienniku",
    events: `robocze: ${events.draftCount ?? 0}, czekają na zarząd: ${events.submittedCount ?? 0}`,
    meeting: meeting ? `${meeting.title}, ${plDate(meeting.scheduledAt)}` : "brak zaplanowanego",
    documents: `${item.documents?.activeCount ?? 0}${item.documents?.latestAt ? `, najnowszy ${plDate(item.documents.latestAt)}` : ""}`,
  };
}

// #131: eksport tabeli „Statystyki klas” (te same uprawnienia co widok — serwer decyduje).
export const OVERVIEW_EXPORT_FORMATS = Object.freeze(["csv", "xlsx"]);

export function boardOverviewExportUrl(schoolYearId, format) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(String(schoolYearId ?? ""))) throw new Error("Wybierz rok szkolny.");
  if (!OVERVIEW_EXPORT_FORMATS.includes(format)) throw new Error("Nieznany format eksportu.");
  return `/api/board/overview/export.${format}?schoolYearId=${encodeURIComponent(schoolYearId)}`;
}

export function exportFilename(header, fallback) {
  const match = /filename="([A-Za-z0-9_.-]{1,200})"/.exec(String(header ?? ""));
  return match ? match[1] : fallback;
}
