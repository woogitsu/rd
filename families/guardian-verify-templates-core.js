// Czyste funkcje ekranu „Szablon wiadomości z kodem weryfikacyjnym” (#140 pkt 5) — bez DOM
// i sieci, testowane w tests/families-guardian-verify-templates.test.js. Wejście: odpowiedź
// GET /api/admin/guardian-verify-templates (src/pg/routes/guardian-updates.js).
// Ekran niczego nie wysyła: tylko wersje szablonu (temat + treść z {kod}), szkic i zatwierdzenie.
// Treść zatwierdza zarząd bez przydziału klasowego, inna osoba niż autor, ze świeżym MFA;
// uprawnienia, zasadę czterech oczu i MFA egzekwuje serwer — ekran tylko tłumaczy odmowy.
// Kod nie dostarcza treści domyślnej: ani przykładu, ani podpowiedzi gotowej wiadomości.
import { errorMessage as sharedErrorMessage } from "../shared/messages.js";
import { shortId } from "../shared/short-id.js";
import { formatDateOrTimestamp } from "../shared/zoned-time.js";

export const TEMPLATES_URL = "/api/admin/guardian-verify-templates";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// Te same granice co parseTemplate w src/pg/routes/guardian-updates.js i CHECK-i 0184
// (test w tests/families-guardian-verify-templates.test.js pilnuje zgodności).
export const SUBJECT_MIN = 3;
export const SUBJECT_MAX = 200;
export const BODY_MIN = 20;
export const BODY_MAX = 4000;
export const BODY_PLACEHOLDERS = Object.freeze(["kod", "waznosc"]);

export const STATUS_LABELS = Object.freeze({ draft: "Szkic", approved: "Zatwierdzony" });

// Odmowy i błędy tras szablonu po polsku; kod spoza listy trafia do słownika wspólnego.
export const TEMPLATE_MESSAGES = Object.freeze({
  forbidden: "Szablon wiadomości z kodem jest dostępny dla administratora i zarządu bez przydziału klasowego; zatwierdza wyłącznie zarząd.",
  self_approval_forbidden: "Szablon zatwierdza inna osoba z zarządu niż autor szkicu. Poproś o zatwierdzenie drugą osobę.",
  mfa_stale: "Zatwierdzenie wymaga świeżego potwierdzenia kodem z aplikacji uwierzytelniającej (ostatnie 15 minut). Wyloguj się, zaloguj ponownie z kodem i zatwierdź jeszcze raz.",
  verify_template_changed: "Treść szablonu różni się od wersji, którą zatwierdzasz. Odśwież widok i sprawdź treść jeszcze raz.",
  verify_template_not_draft: "Ta wersja jest już zatwierdzona i jest niezmienna. Nową treść zapisz jako nowy szkic.",
  verify_template_not_found: "Nie znaleziono tej wersji szablonu.",
  invalid_verify_template: "Temat (3–200 znaków, bez nawiasów klamrowych) albo treść (20–4000 znaków, wyłącznie {kod} i {waznosc}) są niepoprawne.",
  verify_code_placeholder_required: "Treść musi zawierać miejsce na kod: {kod}.",
  forbidden_wording: "Treść zawiera sformułowanie niedozwolone dla dobrowolnej składki (np. „dług”). Zmień treść.",
});

export function templateErrorMessage(code, status) {
  return TEMPLATE_MESSAGES[code] ?? sharedErrorMessage(code, status);
}

// Tekst błędu żądania: nasz słownik ma pierwszeństwo (klient panelu podstawia własny słownik
// rodzin, który nie zna kodów szablonu), potem komunikat klienta, na końcu słownik wspólny.
export function failureText(failure) {
  return TEMPLATE_MESSAGES[failure?.code] ?? failure?.message ?? templateErrorMessage(failure?.code, failure?.status);
}

export function isValidTemplateId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function approveUrl(id) {
  if (!isValidTemplateId(id)) throw new Error("Niepoprawny identyfikator szablonu.");
  return `${TEMPLATES_URL}/${encodeURIComponent(id)}/approve`;
}

// Walidacja szkicu w przeglądarce jest tylko podpowiedzią (serwer rozstrzyga i zwraca te same
// kody). Zwraca { payload } albo { error: <tekst po polsku>, field: "subject" | "bodyText" }.
export function validateDraft({ subject, bodyText }) {
  const subjectText = String(subject ?? "").trim();
  const body = String(bodyText ?? "").replace(/\r\n/g, "\n").trim();
  if (subjectText.length < SUBJECT_MIN || subjectText.length > SUBJECT_MAX) {
    return { field: "subject", error: `Temat ma mieć od ${SUBJECT_MIN} do ${SUBJECT_MAX} znaków.` };
  }
  if (/[\n{}]/.test(subjectText)) {
    return { field: "subject", error: "Temat nie może zawierać nawiasów klamrowych ani nowej linii — kod {kod} nie trafia do tematu (widać go w podglądzie powiadomień)." };
  }
  if (body.length < BODY_MIN || body.length > BODY_MAX) {
    return { field: "bodyText", error: `Treść ma mieć od ${BODY_MIN} do ${BODY_MAX} znaków.` };
  }
  const found = [...body.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]);
  const braces = (body.match(/[{}]/g) ?? []).length;
  const unknown = found.find((name) => !BODY_PLACEHOLDERS.includes(name));
  if (braces !== found.length * 2 || unknown !== undefined) {
    return { field: "bodyText", error: "W treści dozwolone są wyłącznie znaczniki {kod} i {waznosc}; inne nawiasy klamrowe są niedozwolone." };
  }
  if (!found.includes("kod")) return { field: "bodyText", error: "Treść musi zawierać znacznik {kod} w miejscu, w którym ma stanąć kod." };
  return { payload: { subject: subjectText, bodyText: body } };
}

export function formatTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return formatDateOrTimestamp(date, "Europe/Brussels") ?? "—";
}

// Jeden wiersz tabeli jako tekst (do textContent). Skrót treści tylko jako początek skrótu —
// pełna wartość jest wysyłana przy zatwierdzeniu, żeby serwer porównał wersję, którą widziano.
export function toRow(template, currentId = null) {
  const status = Object.hasOwn(STATUS_LABELS, template?.status) ? template.status : "draft";
  return {
    id: template.id,
    version: Number.isInteger(template.version) ? template.version : null,
    status,
    statusLabel: STATUS_LABELS[status],
    current: Boolean(currentId) && template.id === currentId,
    subject: template.subject ?? "",
    bodyText: template.bodyText ?? "",
    contentHash: typeof template.contentHash === "string" ? template.contentHash : "",
    hashShort: typeof template.contentHash === "string" ? template.contentHash.slice(0, 8) : "—",
    author: shortId(template.createdBy),
    authorFull: template.createdBy ?? "",
    createdAt: formatTimestamp(template.createdAt),
    approver: template.approvedBy ? shortId(template.approvedBy) : "—",
    approvedAt: formatTimestamp(template.approvedAt),
    canApprove: status === "draft",
  };
}

export function toRows(data) {
  const templates = Array.isArray(data?.templates) ? data.templates : [];
  const currentId = typeof data?.currentTemplateId === "string" ? data.currentTemplateId : null;
  return templates.map((template) => toRow(template, currentId));
}

// Zdanie o stanie: czy jest wersja, która obowiązuje, i czy serwer w ogóle wysyła kody.
export function statusSummary(data) {
  const rows = toRows(data);
  const current = rows.find((row) => row.current);
  const parts = [];
  parts.push(current
    ? `Obowiązuje wersja ${current.version} (zatwierdzona ${current.approvedAt}). Nowy wniosek rodzica zapamiętuje najnowszą zatwierdzoną wersję.`
    : "Brak zatwierdzonego szablonu — kod weryfikacyjny nie jest zlecany, dopóki zarząd nie zatwierdzi wersji.");
  parts.push(data?.enabled
    ? "Wysyłka kodów jest włączona w konfiguracji serwera (GUARDIAN_VERIFY_EMAIL_ENABLED)."
    : "Wysyłka kodów jest wyłączona w konfiguracji serwera (GUARDIAN_VERIFY_EMAIL_ENABLED) — żaden kod nie wyjdzie, także po zatwierdzeniu szablonu.");
  return parts.join(" ");
}

export function emptyText(data) {
  return Array.isArray(data?.templates) && data.templates.length === 0 ? "Brak wersji szablonu. Dodaj pierwszy szkic." : "";
}

export function approveConfirmation(row) {
  return `Zatwierdzenie wersji ${row.version} jest niezmienne: treści nie da się potem poprawić, tylko zastąpić nowszą wersją. `
    + "Od zatwierdzenia nowe wnioski rodziców z nowym adresem e-mail dostaną wiadomość z tą treścią (o ile wysyłka jest włączona), "
    + "wyłącznie na adres z wniosku. Tę samą treść zobaczysz niżej — sprawdź ją przed zatwierdzeniem.";
}

export function approveBody(row) {
  return row.contentHash ? { contentHash: row.contentHash } : {};
}

export function approveResultMessage(response, version) {
  const status = response?.template?.status;
  if (status !== "approved") return "Zapisano.";
  return `Wersja ${response.template.version ?? version} została zatwierdzona.`;
}

export function createResultMessage(response) {
  const version = response?.template?.version;
  return Number.isInteger(version)
    ? `Zapisano szkic jako wersję ${version}. Do użycia wymaga zatwierdzenia przez inną osobę z zarządu.`
    : "Zapisano szkic.";
}
