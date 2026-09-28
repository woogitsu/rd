// Czyste funkcje panelu administracji kont (bez DOM i sieci) — testowane w tests/admin-core.test.js.

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
});

const ERROR_MESSAGES = Object.freeze({
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
  confirmation_required: "Potwierdź identyfikator roku szkolnego.",
  invitation_pending: "Dla tego adresu i zakresu istnieje już oczekujące zaproszenie.",
  invitation_already_accepted: "Zaproszenie zostało już przyjęte.",
  user_disabled: "Konto jest wyłączone.",
  user_not_found: "Nie znaleziono konta.",
  grant_not_found: "Nie znaleziono przydziału.",
  invalid_email: "Podaj poprawny adres e-mail.",
  invalid_role: "Wybierz rolę z listy.",
  invalid_expires_at: "Data wygaśnięcia musi być w przyszłości (najwyżej 3 lata).",
  invalid_ttl: "Ważność zaproszenia: od 1 do 336 godzin.",
});

export function errorMessage(code, status) {
  if (code && Object.hasOwn(ERROR_MESSAGES, code)) return ERROR_MESSAGES[code];
  if (status >= 500) return "Usługa chwilowo niedostępna. Spróbuj ponownie.";
  return code ? `Operacja odrzucona (${code}).` : `Błąd serwera (${status ?? "?"}).`;
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
    default: return "Potwierdzić operację?";
  }
}

export function describeAuditEvent(event) {
  const label = ACTION_LABELS[event.action] ?? event.action;
  const meta = event.metadata ?? {};
  const details = [];
  if (meta.role) details.push(ROLE_LABELS[meta.role] ?? meta.role);
  if (meta.userId) details.push(`konto ${meta.userId}`);
  if (meta.classId) details.push(`klasa ${meta.classId}`);
  if (meta.schoolYearId) details.push(`rok ${meta.schoolYearId}`);
  if (meta.reason) details.push(`powód: ${meta.reason}`);
  if (Number.isInteger(meta.count)) details.push(`liczba: ${meta.count}`);
  return { label, details: details.join(", ") };
}
