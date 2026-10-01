// Czyste funkcje panelu administracji kont (bez DOM i sieci) — testowane w tests/admin-core.test.js.
import { errorMessage as sharedErrorMessage } from "../shared/messages.js";
import { formatSchoolYear } from "../shared/school-year.js";
import { shortId } from "../shared/short-id.js";
import { formatDateOrTimestamp } from "../shared/zoned-time.js";
import { AUDIT_ACTION_LABELS, AUDIT_DOMAINS } from "../shared/audit-actions.js";

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

// #181: etykiety wszystkich akcji dziennika z jednego słownika (shared/audit-actions.js),
// wspólnego z serwerem — także finanse, e-mail, dokumenty, zebrania (filtr domen).
export const ACTION_LABELS = AUDIT_ACTION_LABELS;

// Opcje filtra domeny w tabeli dziennika: pusta wartość = widok domyślny
// (konta i role — AUDIT_ACTIONS po stronie serwera).
export const AUDIT_DOMAIN_OPTIONS = Object.freeze([
  { value: "", label: "Konta i role (widok domyślny)" },
  ...Object.entries(AUDIT_DOMAINS).map(([value, domain]) => ({ value, label: domain.label })),
]);

export function auditListPath(domain) {
  const params = new URLSearchParams({ limit: "100" });
  if (domain && Object.hasOwn(AUDIT_DOMAINS, domain)) params.set("domain", domain);
  return `/api/admin/audit?${params}`;
}

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
  data_access_log: "Dziennik dostępu do danych",
  data_subject_request: "Wniosek osoby, której dane dotyczą",
  document: "Dokument",
  email_campaign: "Kampania e-mail",
  email_outbox: "Wiadomość w kolejce",
  email_suppression_list: "Lista wstrzymanych adresów",
  email_suppression_release: "Zwolnienie adresu z listy wstrzymanych",
  email_suppression_release_request: "Prośba o zwolnienie adresu",
  email_provider_pause: "Wstrzymanie wysyłki u dostawcy e-mail",
  email_send_ledger: "Dziennik dziennego limitu e-mail",
  email_webhook_event: "Zdarzenie dostawcy e-mail",
  enrollment: "Zapis do klasy",
  event: "Wydarzenie",
  export: "Eksport",
  export_run: "Przebieg eksportu",
  financial_report_snapshot: "Migawka sprawozdania",
  guardian: "Opiekun",
  guardian_update_link: "Link aktualizacji danych opiekuna",
  guardian_update_request: "Prośba o aktualizację danych opiekuna",
  import_batch: "Import uczniów",
  invitation: "Zaproszenie",
  invitation_batch: "Partia zaproszeń",
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
  role_grant_request: "Wniosek o nadanie roli",
  route: "Trasa API",
  school_year: "Rok szkolny",
  promotion_run: "Promocja uczniów na nowy rok",
  school_year_closure: "Zamknięcie roku szkolnego",
  session: "Sesja",
  student_guardian: "Powiązanie ucznia z opiekunem",
  student_household: "Powiązanie ucznia z gospodarstwem",
  guardian_household: "Powiązanie opiekuna z gospodarstwem",
  user: "Konto",
});

export const REASON_LABELS = Object.freeze({
  admin: "wycofanie przez administratora",
  change: "zmiana",
  duplicate_address: "powtórzony adres",
  followup_already_covered: "rodzina już w innej kampanii uzupełniającej",
  idle: "bezczynność",
  invalid_password: "błędne hasło",
  invitation: "zaproszenie",
  login_succeeded: "udane logowanie",
  logout: "wylogowanie",
  malformed: "błędny adres",
  mfa_reset: "reset weryfikacji dwuetapowej",
  no_consent: "brak zgody",
  no_payment_reference: "brak aktywnej komunikacji strukturalnej rodziny",
  no_other_admin: "brak innego administratora do zatwierdzenia",
  no_password: "konto bez hasła",
  no_valid_email: "brak poprawnego adresu e-mail",
  opted_out: "rezygnacja z wiadomości",
  password_changed: "zmiana hasła",
  password_reset: "reset hasła",
  password_reset_completed: "ustawienie nowego hasła",
  payment_recorded: "zapisanie wpłaty",
  rehash: "aktualizacja zabezpieczenia hasła",
  reissued: "wydanie nowego zaproszenia",
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
  if (grant.classId) {
    // Przegląd demo 4: „klasa Klasa 0-A” — nazwa z serwera zaczyna się już od „Klasa”.
    const name = String(classes.get(grant.classId)?.name ?? grant.classId);
    parts.push(/^klasa\b/i.test(name) ? name : `klasa ${name}`);
  }
  if (grant.schoolYearId) parts.push(`rok ${formatSchoolYear(years.get(grant.schoolYearId)?.label ?? grant.schoolYearId)}`);
  return parts.length ? parts.join(", ") : "cała Rada";
}

// Przegląd demo 5: „3.10.2026, 17:48” → „03.10.2026 17:48” — ten sam zapis co reszta
// aplikacji (shared/zoned-time.js#formatDateOrTimestamp, #563), czas Europe/Brussels.
// Sama data („2026-09-01”) → „01.09.2026” (tabela lat szkolnych).
export function formatDateTime(value) {
  if (!value) return "—";
  if (!(value instanceof Date) && Number.isNaN(new Date(value).getTime())) return "—";
  return formatDateOrTimestamp(value, "Europe/Brussels") ?? "—";
}

// Konto w listach wyboru: e-mail i skrót identyfikatora zamiast pełnego UUID
// (przegląd demo 5). Pełny identyfikator zostaje w wartości opcji.
export function userOptionLabel(user) {
  return `${user?.email ?? "—"} (${shortId(user?.id)})`;
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

// #136: treść wspólnego okna potwierdzenia dla akcji na kontach, przydziałach
// i zaproszeniach — tytuł-czasownik, przycisk z nazwą akcji i lista skutków:
// kogo dotyczy, jaki zakres (klasa/rok) i ile aktywnych sesji zostanie zakończonych
// (liczby z listy kont w chwili otwarcia okna). Wszystkie te akcje zmieniają dostęp,
// więc fokus startuje na „Anuluj” (destructive). Czysta funkcja — test w admin-core.
export function confirmationDialog(action, context = {}) {
  const account = context.account ?? "—";
  const sessions = Number.isSafeInteger(context.activeSessions) ? context.activeSessions : null;
  const grants = Number.isSafeInteger(context.activeGrants) ? context.activeGrants : null;
  const sessionsLine = sessions === null ? null : `Aktywne sesje do zakończenia: ${sessions}`;
  const history = "Operacja trafi do dziennika zdarzeń (kto, kiedy, jakie konto).";
  const base = { destructive: true };
  switch (action) {
    case "disable":
      return { ...base, title: "Wyłączyć konto?", confirmLabel: "Wyłącz konto", effects: [
        `Konto: ${account}`,
        "Osoba traci dostęp do wszystkich paneli do czasu ponownego włączenia konta.",
        sessionsLine,
        "Nieużyty kod resetu hasła przestanie działać.",
        grants === null ? null : `Aktywne przydziały ról: ${grants} — zostają zapisane i wrócą po włączeniu konta.`,
        history,
      ] };
    case "enable":
      return { ...base, title: "Włączyć konto?", confirmLabel: "Włącz konto", effects: [
        `Konto: ${account}`,
        grants === null ? "Przydziały ról pozostają bez zmian." : `Osoba odzyska dostęp wynikający z aktywnych przydziałów ról: ${grants}.`,
        history,
      ] };
    case "revoke-sessions":
      return { ...base, title: "Wylogować ze wszystkich urządzeń?", confirmLabel: "Wyloguj wszędzie", effects: [
        `Konto: ${account}`,
        sessionsLine,
        "Konto i przydziały ról zostają; osoba zaloguje się ponownie.",
        history,
      ] };
    case "password-reset":
      return { ...base, title: "Wydać kod resetu hasła?", confirmLabel: "Wydaj kod resetu", effects: [
        `Konto: ${account}`,
        "Po wydaniu nowego kodu poprzedni nieużyty kod przestanie działać.",
        "Konto z rolą chronioną: powstanie tylko wniosek do zatwierdzenia przez innego administratora.",
        "Kod przekaż osobie bezpiecznym kanałem; panel niczego nie wysyła e-mailem.",
        history,
      ] };
    case "revoke-grant":
      return { ...base, title: "Wycofać przydział?", confirmLabel: "Wycofaj przydział", effects: [
        `Konto: ${account}`,
        `Rola: ${context.role ?? "—"}`,
        `Zakres: ${context.scope ?? "—"}`,
        "Osoba traci uprawnienia wynikające z tego przydziału; inne przydziały i konto zostają.",
        "Wpis przydziału zostaje w historii jako wycofany.",
      ] };
    case "revoke-invitation":
      return { ...base, title: "Wycofać zaproszenie?", confirmLabel: "Wycofaj zaproszenie", effects: [
        `Adres: ${account}`,
        context.role ? `Rola: ${context.role}` : null,
        context.scope ? `Zakres: ${context.scope}` : null,
        "Link z zaproszenia przestanie działać; konto nie powstanie.",
        history,
      ] };
    case "reissue-invitation":
      return { ...base, title: "Wydać nowy link zaproszenia?", confirmLabel: "Wydaj nowy link", effects: [
        `Adres: ${account}`,
        context.role ? `Rola: ${context.role}` : null,
        context.scope ? `Zakres: ${context.scope}` : null,
        "Poprzedni link przestanie działać; powstanie nowy link do przekazania (bez wysyłki e-mailem).",
        history,
      ] };
    default:
      return { ...base, title: "Potwierdzić operację?", confirmLabel: "Potwierdź", effects: [confirmationText(action, account)] };
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
  if (meta.schoolYearId) details.push(`rok ${formatSchoolYear(meta.schoolYearId)}`);
  if (meta.reason) details.push(`powód: ${reasonLabel(meta.reason)}`);
  if (Number.isInteger(meta.count)) details.push(`liczba: ${meta.count}`);
  // #184: odmowa dostępu — metoda HTTP i liczba odmów w oknie 5 minut (0160).
  if (event.action === "access.denied" && typeof meta.method === "string") details.push(`metoda ${meta.method}`);
  if (Number.isInteger(event.denialCount)) details.push(`odmów w ciągu 5 min: ${event.denialCount}`);
  // #181: serwer pomija w widoku wolny tekst i pola z danymi osobowymi — tylko liczba.
  const redacted = Array.isArray(event.redactedFields) ? event.redactedFields.length : 0;
  if (redacted) details.push(`ukryte pola opisowe: ${redacted}`);
  return { label, details: details.join(", ") };
}

// --- #207: nowy rok szkolny i klasy z panelu (trasy #78, wyłącznie admin) ------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Treść POST /api/admin/school-years; serwer powtarza walidację (400/409).
export function schoolYearPayload({ id, label, startsOn, endsOn }) {
  const yearId = String(id ?? "").trim();
  if (!isValidId(yearId)) throw new Error("Podaj identyfikator roku (litery, cyfry, „-”, „_”, „.”; np. 2027-2028).");
  const name = String(label ?? "").trim();
  if (!name || name.length > 200) throw new Error("Podaj nazwę roku szkolnego (maksymalnie 200 znaków).");
  if (!DATE_PATTERN.test(String(startsOn ?? "")) || !DATE_PATTERN.test(String(endsOn ?? ""))) throw new Error("Podaj daty początku i końca roku.");
  if (endsOn < startsOn) throw new Error("Data końca nie może być wcześniejsza niż data początku.");
  return { id: yearId, label: name, startsOn, endsOn };
}

// Nazwy klas z pola tekstowego: przecinek, średnik lub nowa linia. Powtórzenia
// (bez względu na wielkość liter) to błąd — jak po stronie serwera (duplicate_name).
export function classNamesPayload(text) {
  const names = String(text ?? "").split(/[,;\n]/).map((name) => name.trim()).filter(Boolean);
  if (!names.length || names.length > 100 || names.some((name) => name.length > 60)) {
    throw new Error("Podaj nazwy klas (każda do 60 znaków), oddzielone przecinkami.");
  }
  const seen = new Set();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Nazwa klasy „${name}” powtarza się na liście.`);
    seen.add(key);
  }
  return { names };
}

// --- #146: wnioski o nadanie roli chronionej (GET /api/admin/grant-requests) ----
// Serwer sam pilnuje zasady czterech oczu (403 grant_four_eyes_required) — funkcje
// niżej decydują tylko, które przyciski panel pokazuje.

export const GRANT_REQUEST_STATUS_LABELS = Object.freeze({
  pending: "Oczekuje",
  approved: "Zatwierdzony",
  rejected: "Odrzucony",
  expired: "Wygasły",
});

export const GRANT_REQUEST_KIND_LABELS = Object.freeze({
  grant: "Nadanie roli istniejącemu kontu",
  invitation: "Zaproszenie z rolą",
});

export function grantRequestsPath(status = "pending") {
  const value = status === "all" || Object.hasOwn(GRANT_REQUEST_STATUS_LABELS, status) ? status : "pending";
  return `/api/admin/grant-requests?${new URLSearchParams({ status: value })}`;
}

// Wiek wniosku słownie (od utworzenia do `now`); zaokrąglenie w dół.
export function requestAge(createdAt, now = new Date()) {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return "—";
  const minutes = Math.max(0, Math.floor((now.getTime() - created) / 60000));
  if (minutes < 1) return "przed chwilą";
  if (minutes < 60) return `${minutes} min temu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} godz. temu`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 dzień temu" : `${days} dni temu`;
}

// Model wiersza listy wniosków. `me` = { id, email } zalogowanego administratora.
// Zatwierdzić nie może wnioskodawca ani adresat (konto albo adres zaproszenia) —
// przycisku wtedy nie ma. Wniosek oczekujący po terminie jest pokazany jako
// wygasły, bez „Zatwierdź” (serwer zwróciłby 409 grant_request_expired).
export function grantRequestRow(request, { me = {}, users = [], classes = new Map(), years = new Map(), now = new Date() } = {}) {
  const ownEmail = String(me.email ?? "").toLowerCase();
  const target = request.userId ? accountName(request.userId, users) : (request.email ?? "—");
  const overdue = request.status === "pending" && new Date(request.expiresAt).getTime() <= now.getTime();
  const status = overdue ? "expired" : request.status;
  const pending = request.status === "pending";
  const ownRequest = Boolean(me.id) && request.requestedBy === me.id;
  const addressee = (Boolean(me.id) && request.userId === me.id)
    || (Boolean(ownEmail) && String(request.email ?? "").toLowerCase() === ownEmail);
  let approveBlockedReason = null;
  if (ownRequest) approveBlockedReason = "Własny wniosek zatwierdza inny administrator.";
  else if (addressee) approveBlockedReason = "Wniosek dotyczy Twojego konta — zatwierdza inny administrator.";
  else if (overdue) approveBlockedReason = "Wniosek wygasł — trzeba złożyć nowy.";
  return {
    id: request.id,
    kind: GRANT_REQUEST_KIND_LABELS[request.kind] ?? request.kind,
    requester: accountName(request.requestedBy, users),
    target,
    role: ROLE_LABELS[request.role] ?? request.role,
    scope: scopeLabel({ schoolYearId: request.schoolYearId, classId: null }, classes, years),
    age: requestAge(request.createdAt, now),
    status,
    statusLabel: GRANT_REQUEST_STATUS_LABELS[status] ?? status,
    canApprove: pending && !approveBlockedReason,
    canReject: pending,
    rejectLabel: ownRequest ? "Wycofaj wniosek" : "Odrzuć",
    note: pending ? approveBlockedReason : null,
    // 0159: powód odrzucenia (opcjonalny) — tylko przy wniosku odrzuconym.
    rejectReason: request.status === "rejected" && request.rejectReason ? `Powód: ${request.rejectReason}` : null,
  };
}

// Skutki w oknie potwierdzenia (#136/#582): przycisk nazywa akcję.
export function grantRequestDialog(action, request, row) {
  const lines = [
    `Wnioskuje: ${row.requester}`,
    `${request.kind === "invitation" ? "Adres zaproszenia" : "Konto"}: ${row.target}`,
    `Rola: ${row.role}`,
    `Zakres: ${row.scope}`,
  ];
  if (action === "approve") {
    const effect = request.kind === "invitation"
      ? [
        request.replacesInvitationId ? "Poprzedni link zaproszenia dla tego adresu przestanie działać." : null,
        "Powstanie zaproszenie z tą rolą. Link zobaczysz tylko raz, w tym oknie panelu — przekaż go osobnym, zaufanym kanałem. Panel niczego nie wysyła e-mailem.",
      ]
      : [
        request.grantExpiresAt ? `Przydział będzie ważny do ${formatDateTime(request.grantExpiresAt)}.` : "Przydział bezterminowy (do wycofania albo wygaszenia kadencji).",
        "Konto od razu dostanie uprawnienia tej roli. Jako nadający w historii zapiszesz się Ty.",
      ];
    return {
      destructive: true,
      title: "Zatwierdzić nadanie roli?",
      confirmLabel: request.kind === "invitation" ? "Zatwierdź i wydaj link" : "Zatwierdź i nadaj rolę",
      effects: [...lines, ...effect, "Wymagane świeże potwierdzenie kodem z aplikacji. Zatwierdzenie trafi do dziennika zdarzeń."],
    };
  }
  return {
    destructive: true,
    title: row.rejectLabel === "Wycofaj wniosek" ? "Wycofać wniosek?" : "Odrzucić wniosek?",
    confirmLabel: row.rejectLabel === "Wycofaj wniosek" ? "Wycofaj wniosek" : "Odrzuć wniosek",
    effects: [
      ...lines,
      "Rola nie zostanie nadana, a zaproszenie nie powstanie. Wniosek zostaje w historii jako odrzucony.",
      "Aby wrócić do sprawy, trzeba złożyć nowy wniosek.",
      "Powód jest opcjonalny; zobaczą go administratorzy na liście wniosków. Odrzucenie trafi do dziennika zdarzeń (kto, kiedy, który wniosek, czy podano powód — bez jego treści).",
    ],
  };
}

// Ciało POST …/reject (0159): pusty powód (albo same spacje) = brak powodu.
// Serwer i tak normalizuje; długość 3–500 i bramkę danych osobowych sprawdza serwer.
export function rejectRequestPayload(reason) {
  const value = String(reason ?? "").trim();
  return value ? { reason: value } : {};
}
