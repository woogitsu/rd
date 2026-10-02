// Czyste funkcje ekranu „Wnioski opiekunów o zmianę kontaktu” (#140) — bez DOM i sieci,
// testowane w tests/families-guardian-updates.test.js. Wejście: odpowiedź
// GET /api/admin/guardian-update-requests (src/pg/routes/guardian-updates.js).
// Widok pokazuje wyłącznie to, co zwraca API: imię opiekuna, nazwy klas, PROPONOWANY
// e-mail i zgodę, uwagę oraz powód blokady adresu (#94). Obecnych wartości kontaktu
// API nie zwraca, więc ekran ich nie zgaduje. Trasy decyzji nie przyjmują treści
// (brak pola powodu odrzucenia). Uprawnienia egzekwuje serwer (admin, zarząd bez klasy).
import { formatDateOrTimestamp } from "../shared/zoned-time.js";

export const STATUS_OPTIONS = Object.freeze([
  { value: "pending", label: "Oczekujące" },
  { value: "approved", label: "Zatwierdzone" },
  { value: "rejected", label: "Odrzucone" },
]);
export const STATUS_LABELS = Object.freeze(Object.fromEntries(STATUS_OPTIONS.map((item) => [item.value, item.label])));

export const PAGE_LIMIT = 50;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const GUARDIAN_UPDATE_MESSAGES = Object.freeze({
  forbidden: "Kolejka wniosków jest dostępna dla administratora i zarządu bez przydziału klasowego.",
  request_not_found: "Nie znaleziono wniosku.",
  guardian_not_found: "Nie znaleziono opiekuna.",
  invalid_request: "Niepoprawne żądanie.",
});

// Powody blokady adresu (#94) po polsku; nieznany kod pokazujemy neutralnie.
const SUPPRESSION_LABELS = Object.freeze({
  bounce: "odbicie wiadomości",
  hard_bounce: "odbicie wiadomości",
  complaint: "skarga",
  unsubscribe: "wypisanie",
  unsubscribed: "wypisanie",
  manual: "blokada ręczna",
});

export function isValidStatus(status) {
  return Object.hasOwn(STATUS_LABELS, status);
}

export function isValidRequestId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function buildListUrl(status, cursor = null, limit = PAGE_LIMIT) {
  if (!isValidStatus(status)) throw new Error("Niepoprawny filtr statusu.");
  const params = new URLSearchParams({ status, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return `/api/admin/guardian-update-requests?${params}`;
}

export function decisionUrl(id, decision) {
  if (!isValidRequestId(id)) throw new Error("Niepoprawny identyfikator wniosku.");
  if (decision !== "approve" && decision !== "reject") throw new Error("Niepoprawna decyzja.");
  return `/api/admin/guardian-update-requests/${encodeURIComponent(id)}/${decision}`;
}

export function formatCreatedAt(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return formatDateOrTimestamp(date, "Europe/Brussels") ?? "—";
}

// e-mail: undefined = bez zmiany, null/"" = usunięcie adresu, tekst = nowy adres.
export function describeEmailChange(request) {
  if (request.proposedEmail === undefined) return { kind: "none", text: "bez zmiany" };
  if (request.proposedEmail === null || request.proposedEmail === "") return { kind: "clear", text: "usunięcie adresu e-mail" };
  return { kind: "set", text: request.proposedEmail };
}

export function describeConsentChange(request) {
  if (request.proposedContactAllowed === undefined) return { kind: "none", text: "bez zmiany" };
  return request.proposedContactAllowed
    ? { kind: "allow", text: "zgoda na kontakt: tak" }
    : { kind: "withdraw", text: "wycofanie zgody na kontakt" };
}

// #140 pkt 5 (0184): stan kodu weryfikacyjnego nowego adresu z API
// (`verification`, `verificationReason`). Weryfikacja jest opcjonalna
// (wskazanie 2026-10-02): zatwierdzenie bez potwierdzenia jest dozwolone, ale
// widok mówi to wprost, a serwer zapisuje w dzienniku zdarzeń.
export const VERIFICATION_LABELS = Object.freeze({
  none: "nie wysłano kodu",
  sent: "kod wysłany, czeka na potwierdzenie",
  confirmed: "adres potwierdzony kodem",
  expired: "kod wygasł bez potwierdzenia",
  failed: "wysyłka lub potwierdzenie nieudane",
});

const VERIFICATION_REASON_LABELS = Object.freeze({
  no_new_email: "wniosek bez nowego adresu",
  not_requested: "kod nie był zlecony",
  verification_disabled: "weryfikacja wyłączona w konfiguracji",
  template_missing: "brak zatwierdzonego szablonu wiadomości z kodem",
  privacy_notice_missing: "brak opublikowanej informacji o przetwarzaniu danych",
  processing_restricted: "ograniczenie przetwarzania danych",
  request_decided: "wniosek rozstrzygnięty przed wysyłką",
  address_suppressed: "adres na liście wyłączeń",
  attempts_exhausted: "wyczerpany limit prób wpisania kodu",
  delivery_unknown: "nieznany wynik doręczenia",
  recipient_not_allowlisted: "adres spoza listy adresów testowych",
  template_not_approved: "szablon niezatwierdzony",
  no_valid_email: "niepoprawny adres",
});

// null, gdy wniosek nie zmienia adresu na nowy (brak czego weryfikować).
export function describeVerification(request) {
  if (describeEmailChange(request).kind !== "set") return null;
  const status = Object.hasOwn(VERIFICATION_LABELS, request.verification) ? request.verification : "none";
  const reason = request.verificationReason
    ? VERIFICATION_REASON_LABELS[request.verificationReason] ?? "inny powód"
    : null;
  return {
    status,
    confirmed: status === "confirmed",
    text: reason ? `${VERIFICATION_LABELS[status]} (${reason})` : VERIFICATION_LABELS[status],
  };
}

export function suppressionWarning(request) {
  const reason = request.proposedEmailSuppression;
  if (!reason) return null;
  const label = SUPPRESSION_LABELS[reason] ?? "aktywna blokada";
  return `Proponowany adres jest na liście wyłączeń (${label}). Zatwierdzenie nie zdejmuje blokady — wysyłka na ten adres pozostaje wstrzymana.`;
}

// Jeden wiersz tabeli: wartości już jako tekst (do textContent).
export function toRow(request) {
  const email = describeEmailChange(request);
  const consent = describeConsentChange(request);
  const classes = Array.isArray(request.classNames) ? request.classNames : [];
  return {
    id: request.id,
    guardian: request.guardianFirstName || "—",
    classes: classes.length ? classes.join(", ") : "—",
    email,
    consent,
    warning: suppressionWarning(request),
    verification: describeVerification(request),
    note: request.note || "",
    createdAt: formatCreatedAt(request.createdAt),
  };
}

// Dociąganie stron: dołącza nową stronę, pomija powtórzone identyfikatory
// (np. po odświeżeniu w trakcie), zachowuje kolejność serwera.
export function mergePage(existing, page) {
  const seen = new Set(existing.map((item) => item.id));
  const added = (Array.isArray(page?.requests) ? page.requests : []).filter((item) => item && !seen.has(item.id));
  return [...existing, ...added];
}

export function pageState(page) {
  const nextCursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
  return { nextCursor, truncated: Boolean(page?.truncated) || nextCursor !== null };
}

export function summaryText(status, count, hasMore) {
  const label = STATUS_LABELS[status] ?? status;
  if (count === 0) return `${label}: brak wniosków.`;
  return `${label}: ${count} ${hasMore ? "wczytanych (są kolejne)" : "w sumie"}.`;
}

// Wniosek można rozstrzygnąć tylko w stanie „oczekujące”; reszta to widok historii.
export function canDecide(status) {
  return status === "pending";
}

export function confirmationText(decision, row) {
  const who = `opiekuna ${row.guardian} (klasa: ${row.classes})`;
  if (decision === "approve") {
    const base = `Zatwierdzenie zapisze proponowany kontakt ${who} w danych rodziny i w historii zmian. Zmiany: e-mail — ${row.email.text}; zgoda — ${row.consent.text}.`;
    if (row.verification && !row.verification.confirmed) {
      return `${base} Uwaga: nowy adres NIE jest potwierdzony kodem (${row.verification.text}). Zatwierdzenie bez potwierdzenia zostanie odnotowane w dzienniku zdarzeń.`;
    }
    return base;
  }
  return `Odrzucenie nie zmieni danych ${who}. Link wniosku pozostanie zużyty. Trasa nie zapisuje powodu odrzucenia.`;
}

export function resultMessage(decision, response) {
  if (!response || typeof response !== "object") return "Zapisano decyzję.";
  const expected = decision === "approve" ? "approved" : "rejected";
  if (response.status !== expected) {
    return `Wniosek był już rozstrzygnięty (${STATUS_LABELS[response.status] ?? response.status}); nie zapisano drugiej decyzji.`;
  }
  if (decision === "reject") return "Wniosek odrzucony; dane opiekuna bez zmian.";
  return response.changed ? "Wniosek zatwierdzony; kontakt opiekuna zaktualizowany." : "Wniosek zatwierdzony; kontakt był już zgodny z wnioskiem, bez zmiany.";
}
