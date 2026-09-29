// Czyste funkcje panelu administracji kont (bez DOM i sieci) — testowane w tests/admin-core.test.js.
import { errorMessage as sharedErrorMessage } from "../shared/messages.js";
import { shortId } from "../shared/short-id.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ROLE_LABELS = Object.freeze({
  admin: "Administrator techniczny",
  board: "Zarząd",
  treasurer: "Skarbnik",
  representative: "Przedstawiciel klasy",
  audit: "Komisja Rewizyjna",
  principal: "Dyrekcja",
});

// #176: role bez żadnej trasy chronionej dziś (decyzja D-09 nierozstrzygnięta).
// Jedyne źródło prawdy jest po stronie serwera: ROLE_STATUS w src/pg/auth.js
// (tests/admin-core.test.js sprawdza, że ta lista się z nim zgadza). Front-end
// ostrzega przed wysłaniem formularza; serwer i tak odrzuca 422 role_pending_decision.
export const PENDING_DECISION_ROLES = Object.freeze(['principal']);

export function roleNeedsPendingDecisionWarning(role) {
  return PENDING_DECISION_ROLES.includes(role);
}

export const GRANT_STATUS_LABELS = Object.freeze({
  active: "Aktywny",
  expired: "Wygasły",
  revoked: "Wycofany",
});

export const INVITATION_STATUS_LABELS = Object.freeze({
  pending: "Oczekuje",
  accepted: "Przyjęte",
  revoked: "Wycofane",
  expired: "Wygasłe",
});

export const ACTION_LABELS = Object.freeze({
  "auth.password_reset_issued": "Wydanie kodu resetu hasła",
  "auth.password_reset_revoked": "Unieważnienie kodu resetu hasła",
  "mfa.reset": "Reset weryfikacji dwuetapowej",
  "role_grant.created": "Nadanie roli",
  "role_grant.revoked": "Wycofanie roli",
  "role_grant.expired": "Wygaszenie roli",
  "school_year.grants_expired": "Wygaszenie kadencji",
  "invitation.created": "Utworzenie zaproszenia",
  "invitation.revoked": "Wycofanie zaproszenia",
  "invitation.accepted": "Przyjęcie zaproszenia",
  "user.disabled": "Wyłączenie konta",
  "user.enabled": "Włączenie konta",
  "session.revoked": "Wycofanie sesji",
  // Przegląd demo: te zdarzenia dziennik pokazywał surowym kodem (np. „user.created”).
  "user.created": "Utworzenie konta",
  "auth.password_set": "Ustawienie hasła",
  "auth.password_changed": "Zmiana hasła",
  "auth.password_reset_completed": "Ustawienie nowego hasła kodem resetu",
  "invitation.reissued": "Ponowne wydanie zaproszenia",
  "role_grant.school_year_backfilled": "Uzupełnienie roku szkolnego w przydziale roli",
  "school_year.created": "Utworzenie roku szkolnego",
  "class.created": "Utworzenie klasy",
  "account_recovery.requested": "Prośba o odzyskanie konta",
  "account_recovery.approved": "Zatwierdzenie odzyskania konta",
  "account_recovery.rejected": "Odrzucenie odzyskania konta",
  "account_recovery.expired": "Wygaśnięcie prośby o odzyskanie konta",
});

// Przegląd demo: dziennik pokazywał surowe typy obiektów (`role_grant`) i powody
// (`rotated`). Zestawy pokrywa test tests/admin-core.test.js (skan src/pg/**).
export const ENTITY_TYPE_LABELS = Object.freeze({
  account_recovery_request: "Prośba o odzyskanie konta",
  audit_log: "Dziennik zdarzeń",
  bank_reconciliation: "Uzgodnienie wyciągu",
  bank_reconciliation_group_match: "Dopasowanie grupowe wyciągu",
  bank_reconciliation_match: "Dopasowanie pozycji wyciągu",
  bank_statement_import: "Import wyciągu bankowego",
  class: "Klasa",
  data_subject_request: "Wniosek osoby, której dane dotyczą",
  document: "Dokument",
  email_campaign: "Kampania e-mail",
  email_outbox: "Wiadomość w kolejce",
  email_suppression_list: "Lista wstrzymanych adresów",
  email_suppression_release: "Zwolnienie adresu z listy wstrzymanych",
  email_suppression_release_request: "Prośba o zwolnienie adresu",
  email_webhook_event: "Zdarzenie dostawcy e-mail",
  enrollment: "Zapis do klasy",
  export: "Eksport",
  export_run: "Przebieg eksportu",
  financial_report_snapshot: "Migawka sprawozdania",
  guardian: "Opiekun",
  guardian_update_link: "Link aktualizacji danych opiekuna",
  guardian_update_request: "Prośba o aktualizację danych opiekuna",
  import_batch: "Import uczniów",
  invitation: "Zaproszenie",
  ledger_budget_adoption: "Przyjęcie preliminarza",
  ledger_budget_line: "Pozycja preliminarza",
  ledger_category: "Kategoria księgi",
  ledger_correction: "Korekta zapisu księgi",
  ledger_entry: "Zapis księgi",
  ledger_opening_balance: "Saldo otwarcia",
  ledger_opening_balance_adjustment: "Korekta salda otwarcia",
  ledger_transfer: "Przesunięcie środków",
  meeting: "Zebranie",
  meeting_agenda_item: "Punkt porządku obrad",
  meeting_minutes: "Protokół zebrania",
  meeting_minutes_publication: "Udostępnienie protokołu",
  meeting_quorum_check: "Sprawdzenie kworum",
  mfa_factor: "Weryfikacja dwuetapowa",
  mfa_recovery_code: "Kod odzyskiwania weryfikacji",
  password_reset: "Reset hasła",
  payment_allocation: "Przypisanie wpłaty",
  payment_assignment: "Przydział wpłaty",
  payment_correction: "Korekta wpłaty",
  payment_entry: "Wpłata",
  payment_instructions: "Dane do wpłat",
  payment_reassignment: "Zmiana przypisania wpłaty",
  payment_reference: "Tytuł wpłaty",
  payment_refund: "Zwrot wpłaty",
  privacy_notice: "Informacja o prywatności",
  resolution: "Uchwała",
  resolution_execution_event: "Wykonanie uchwały",
  role_grant: "Przydział roli",
  route: "Trasa API",
  school_year: "Rok szkolny",
  school_year_closure: "Zamknięcie roku szkolnego",
  session: "Sesja",
  student_guardian: "Powiązanie ucznia z opiekunem",
  student_household: "Powiązanie ucznia z gospodarstwem",
  user: "Konto",
});

export const REASON_LABELS = Object.freeze({
  admin: "wycofanie przez administratora",
  change: "zmiana",
  duplicate_address: "powtórzony adres",
  idle: "bezczynność",
  invalid_password: "błędne hasło",
  invitation: "zaproszenie",
  login_succeeded: "udane logowanie",
  logout: "wylogowanie",
  malformed: "błędny adres",
  mfa_reset: "reset weryfikacji dwuetapowej",
  no_consent: "brak zgody",
  no_password: "konto bez hasła",
  no_valid_email: "brak poprawnego adresu e-mail",
  opted_out: "rezygnacja z wiadomości",
  password_changed: "zmiana hasła",
  password_reset: "reset hasła",
  password_reset_completed: "ustawienie nowego hasła",
  payment_recorded: "zapisanie wpłaty",
  rehash: "aktualizacja zabezpieczenia hasła",
  reset: "reset",
  rotated: "odnowienie sesji",
  superseded: "zastąpione nowszym",
  suppressed: "adres wstrzymany",
  term_closed: "zakończenie kadencji",
  unknown_account: "nieznane konto",
  user_disabled: "wyłączenie konta",
  user_revoke_all: "wylogowanie ze wszystkich sesji",
  year_close: "zamknięcie roku szkolnego",
});

export function entityTypeLabel(type) {
  return ENTITY_TYPE_LABELS[type] ?? type ?? "—";
}

export function reasonLabel(reason) {
  return REASON_LABELS[reason] ?? reason;
}

// Autor/konto w dzienniku: nazwa konta, jeśli administrator ma je już na liście
// kont (GET /api/admin/users) — inaczej skrócony identyfikator. Brak nowych danych w API.
export function accountName(userId, users = []) {
  if (!userId) return "system";
  const user = (Array.isArray(users) ? users : []).find((item) => item.id === userId);
  return user ? (user.displayName || user.email) : shortId(userId);
}

export const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Sesja wygasła. Zaloguj się ponownie.",
  forbidden: "Brak uprawnień. Panel wymaga roli administratora i potwierdzonego MFA.",
  invalid_origin: "Żądanie odrzucone: niezgodne pochodzenie strony.",
  last_admin_grant: "Nie można odebrać sobie ostatniego aktywnego przydziału administratora.",
  cannot_disable_self: "Nie można wyłączyć własnego konta.",
  class_required: "Przedstawiciel klasy wymaga wskazania klasy.",
  class_not_found: "Wskazana klasa nie istnieje.",
  school_year_not_found: "Wskazany rok szkolny nie istnieje.",
  class_not_in_school_year: "Klasa nie należy do wskazanego roku szkolnego.",
  school_year_not_finished: "Rok szkolny jeszcze się nie zakończył.",
  confirmation_required: "Potwierdź identyfikator (konta albo roku szkolnego).",
  cannot_reset_own_mfa: "Nie można zresetować weryfikacji dwuetapowej własnego konta.",
  invitation_pending: "Dla tego adresu i zakresu istnieje już oczekujące zaproszenie.",
  invitation_already_accepted: "Zaproszenie zostało już przyjęte.",
  user_disabled: "Konto jest wyłączone.",
  user_not_found: "Nie znaleziono konta.",
  grant_not_found: "Nie znaleziono przydziału.",
  invalid_email: "Podaj poprawny adres e-mail.",
  invalid_role: "Wybierz rolę z listy.",
  invalid_expires_at: "Data wygaśnięcia musi być w przyszłości (najwyżej 3 lata).",
  invalid_ttl: "Ważność zaproszenia: od 1 do 336 godzin.",
  // #176: rola bez żadnej trasy dziś (np. principal) i przydział klasowy dla roli
  // bez tras klasowych — patrz docs/AUTHORIZATION.md „Stan roli i konto bez funkcji”.
  role_pending_decision: "Ta rola nie daje dziś dostępu do żadnego panelu (decyzja zarządu i szkoły jeszcze nie zapadła). Konto powstałoby bez żadnej funkcji. Potwierdź świadomie albo wybierz inną rolę.",
  class_scope_not_supported: "Ta rola nie ma tras ograniczonych do jednej klasy. Zostaw pole klasy puste.",
});

export function errorMessage(code, status) {
  if (code && Object.hasOwn(ERROR_MESSAGES, code)) return ERROR_MESSAGES[code];
  return sharedErrorMessage(code, status);
}

export function isValidId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function optionalId(value, message) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!isValidId(text)) throw new Error(message);
  return text;
}

export function buildGrantsUrl({ userId = "", role = "", schoolYearId = "", classId = "", status = "active" } = {}) {
  const params = new URLSearchParams();
  const user = optionalId(userId, "Niepoprawny identyfikator konta.");
  const year = optionalId(schoolYearId, "Niepoprawny identyfikator roku.");
  const klass = optionalId(classId, "Niepoprawny identyfikator klasy.");
  if (role && !Object.hasOwn(ROLE_LABELS, role)) throw new Error("Nieznana rola.");
  if (status && status !== "all" && !Object.hasOwn(GRANT_STATUS_LABELS, status)) throw new Error("Nieznany status.");
  if (user) params.set("userId", user);
  if (role) params.set("role", role);
  if (year) params.set("schoolYearId", year);
  if (klass) params.set("classId", klass);
  params.set("status", status || "active");
  return `/api/admin/grants?${params.toString()}`;
}

// Data z pola <input type="date"> oznacza „ważny do końca tego dnia”; wysyłamy
// północ UTC następnego dnia (w Brukseli to 1:00 lub 2:00 w nocy).
export function dateToExpiresAt(value, now = new Date()) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("Podaj datę w formacie RRRR-MM-DD.");
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error("Niepoprawna data.");
  date.setUTCDate(date.getUTCDate() + 1);
  if (date.getTime() <= now.getTime()) throw new Error("Data wygaśnięcia musi być w przyszłości.");
  return date.toISOString();
}

export function grantPayload({ userId, role, schoolYearId, classId, expiresOn }, now = new Date()) {
  const user = String(userId ?? "").trim();
  if (!isValidId(user)) throw new Error("Wybierz konto.");
  if (!Object.hasOwn(ROLE_LABELS, role)) throw new Error("Wybierz rolę.");
  const klass = optionalId(classId, "Niepoprawny identyfikator klasy.");
  if (role === "representative" && !klass) throw new Error("Przedstawiciel klasy wymaga wskazania klasy.");
  const payload = { userId: user, role };
  const year = optionalId(schoolYearId, "Niepoprawny identyfikator roku.");
  if (year) payload.schoolYearId = year;
  if (klass) payload.classId = klass;
  const expiresAt = dateToExpiresAt(expiresOn, now);
  if (expiresAt) payload.expiresAt = expiresAt;
  return payload;
}

export function invitationPayload({ email, role, schoolYearId, classId, ttlHours }) {
  const address = String(email ?? "").trim().toLowerCase();
  if (address.length > 254 || !EMAIL_PATTERN.test(address)) throw new Error("Podaj poprawny adres e-mail.");
  if (!Object.hasOwn(ROLE_LABELS, role)) throw new Error("Wybierz rolę.");
  const klass = optionalId(classId, "Niepoprawny identyfikator klasy.");
  if (role === "representative" && !klass) throw new Error("Przedstawiciel klasy wymaga wskazania klasy.");
  const payload = { email: address, role };
  const year = optionalId(schoolYearId, "Niepoprawny identyfikator roku.");
  if (year) payload.schoolYearId = year;
  if (klass) payload.classId = klass;
  const hoursText = String(ttlHours ?? "").trim();
  if (hoursText) {
    const hours = Number(hoursText);
    if (!Number.isInteger(hours) || hours < 1 || hours > 336) throw new Error("Ważność zaproszenia: od 1 do 336 godzin.");
    payload.ttlHours = hours;
  }
  return payload;
}

// #164: link gotowy do wklejenia zamiast samego tokenu — admin nie musi
// ręcznie składać adresu ekranu logowania. Token trafia wyłącznie w część
// „#…” (nigdy do zapytania), więc nie idzie do logów serwera ani historii
// przeglądarki po wczytaniu (login/main.js usuwa go z paska adresu).
export function invitationLink(token, origin) {
  return `${origin}/login/#invite=${token}`;
}

// Indeks klas: id -> { name, schoolYearId, yearLabel } z odpowiedzi /api/admin/school-years.
export function indexClasses(schoolYears = []) {
  const map = new Map();
  for (const year of schoolYears) {
    for (const item of year.classes ?? []) map.set(item.id, { name: item.name, schoolYearId: year.id, yearLabel: year.label });
  }
  return map;
}

export function scopeLabel(grant, classes = new Map(), years = new Map()) {
  const parts = [];
  if (grant.classId) parts.push(`klasa ${classes.get(grant.classId)?.name ?? grant.classId}`);
  if (grant.schoolYearId) parts.push(`rok ${years.get(grant.schoolYearId)?.label ?? grant.schoolYearId}`);
  return parts.length ? parts.join(", ") : "cała Rada";
}

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Brussels" }).format(date);
}

// Podpowiedź w UI (serwer i tak odmawia): czy wycofanie tego przydziału
// odebrałoby zalogowanemu administratorowi ostatni aktywny dostęp admina.
export function isOwnLastAdminGrant(grants, actorId, grantId) {
  const target = grants.find((grant) => grant.id === grantId);
  if (!target || target.userId !== actorId || target.role !== "admin" || target.status !== "active") return false;
  return !grants.some((grant) => grant.id !== grantId && grant.userId === actorId && grant.role === "admin" && grant.status === "active");
}

export function confirmationText(action, subject) {
  switch (action) {
    case "revoke-grant": return `Wycofać przydział: ${subject}? Wpis zostanie w historii.`;
    case "revoke-invitation": return `Wycofać zaproszenie dla ${subject}? Token przestanie działać.`;
    case "disable": return `Wyłączyć konto ${subject}? Wszystkie sesje zostaną wycofane.`;
    case "enable": return `Włączyć konto ${subject}? Przydziały ról pozostają bez zmian.`;
    case "revoke-sessions": return `Wylogować ${subject} ze wszystkich urządzeń?`;
    case "password-reset": return `Wydać nowy kod resetu hasła dla ${subject}? Poprzedni nieużyty kod przestanie działać.`;
    default: return "Potwierdzić operację?";
  }
}

// #224: reset MFA wyłącza czynnik i kody odzyskiwania konta — wymaga wpisania
// identyfikatora konta (kontrakt POST /api/admin/users/{id}/mfa-reset), żeby
// nie wykasować cudzego dostępu jednym kliknięciem. `typed` to surowa wartość
// z okna przeglądarki: null = anulowano (Escape/Anuluj), string = wpisano.
export function mfaResetConfirmation(typed, userId) {
  if (typed === null) return { cancelled: true, ok: false };
  return { cancelled: false, ok: typed.trim() === userId };
}

// #224: link gotowy do wklejenia zamiast samego kodu resetu — patrz #164,
// gdzie ten sam brak dotyczy zaproszeń. Token wyłącznie w części „#…”.
export function passwordResetLink(token, origin) {
  return `${origin}/login/#reset=${token}`;
}

export function describeAuditEvent(event, users = []) {
  const label = ACTION_LABELS[event.action] ?? event.action;
  const meta = event.metadata ?? {};
  const details = [];
  if (meta.role) details.push(ROLE_LABELS[meta.role] ?? meta.role);
  if (meta.userId) details.push(`konto ${accountName(meta.userId, users)}`);
  if (meta.classId) details.push(`klasa ${meta.classId}`);
  if (meta.schoolYearId) details.push(`rok ${meta.schoolYearId}`);
  if (meta.reason) details.push(`powód: ${reasonLabel(meta.reason)}`);
  if (Number.isInteger(meta.count)) details.push(`liczba: ${meta.count}`);
  return { label, details: details.join(", ") };
}
