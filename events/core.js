// Czysta logika panelu wydarzeń: walidacja, etykiety, czas Europe/Brussels
// i budowanie żądań do /api/events. Bez DOM i bez fetch — testowane w
// tests/events-core.test.js. Kontrakt API: src/pg/events.js, docs/EVENTS.md.

export const TIMEZONE = "Europe/Brussels";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const LOCAL_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const OFFSET_PATTERN = /^[+-]\d{2}:\d{2}$/;

export const STATUSES = Object.freeze(["draft", "submitted", "approved", "published", "cancelled"]);

export const STATUS_LABELS = Object.freeze({
  draft: "Szkic",
  submitted: "Zgłoszone",
  approved: "Zatwierdzone",
  published: "Opublikowane",
  cancelled: "Odwołane",
});

export const AUDIENCE_LABELS = Object.freeze({
  internal: "Wewnętrzne",
  public: "Publiczne",
});

export const ACTION_LABELS = Object.freeze({
  submit: "Zgłoś do zatwierdzenia",
  approve: "Zatwierdź",
  publish: "Opublikuj",
  cancel: "Odwołaj",
});

// Komunikaty dla kodów błędów zwracanych przez src/pg/events.js.
export const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Nie jesteś zalogowany lub sesja wygasła. Zaloguj się i odśwież stronę.",
  forbidden: "Nie masz uprawnień do tej operacji.",
  invalid_origin: "Żądanie odrzucone: niezgodne pochodzenie strony. Otwórz panel pod adresem aplikacji.",
  event_not_found: "Nie znaleziono wydarzenia albo nie masz do niego dostępu.",
  revision_conflict: "Ktoś zmienił wydarzenie w międzyczasie. Odśwież, aby zobaczyć aktualną wersję, i dopiero wtedy powtórz operację.",
  idempotency_conflict: "Poprzednia próba zapisu tego formularza mogła już zostać przyjęta z innymi danymi. Zamknij formularz, odśwież listę i sprawdź, czy szkic istnieje.",
  invalid_idempotency_key: "Niepoprawny identyfikator operacji. Zamknij formularz i otwórz go ponownie.",
  ambiguous_local_time: "Ta godzina występuje dwa razy (zmiana czasu z letniego na zimowy). Wybierz, o które wystąpienie chodzi.",
  nonexistent_local_time: "Ta godzina nie istnieje w Brukseli (zmiana czasu z zimowego na letni). Wybierz inną godzinę.",
  offset_not_valid_in_europe_brussels: "Wybrane przesunięcie nie pasuje do tej daty w Brukseli. Wybierz ponownie.",
  invalid_datetime: "Niepoprawna data lub godzina.",
  ends_before_start: "Koniec nie może być wcześniej niż początek.",
  invalid_title: "Tytuł musi mieć od 3 do 200 znaków.",
  invalid_description: "Opis może mieć najwyżej 4000 znaków.",
  invalid_location: "Miejsce może mieć najwyżej 200 znaków.",
  invalid_organizer: "Organizator może mieć najwyżej 200 znaków.",
  invalid_audience: "Wybierz odbiorców wydarzenia.",
  invalid_school_year: "Niepoprawny identyfikator roku szkolnego.",
  invalid_class: "Niepoprawny identyfikator klasy.",
  invalid_revision: "Brak numeru wersji. Odśwież wydarzenie.",
  invalid_reason: "Powód odwołania musi mieć od 3 do 500 znaków.",
  invalid_transition: "Tego kroku nie można wykonać w obecnym stanie wydarzenia. Odśwież wydarzenie.",
  event_cancelled: "Wydarzenie jest odwołane; odwołanie jest ostateczne.",
  event_not_public: "Publikować można tylko wydarzenie z odbiorcami „Publiczne”.",
  four_eyes_required: "Zatwierdzić musi inna osoba niż autor wydarzenia i autor tej wersji.",
  invalid_event_id: "Niepoprawny identyfikator wydarzenia.",
  invalid_reference: "Wskazany rok szkolny lub klasa nie istnieje.",
  invalid_request: "Serwer odrzucił dane formularza.",
  invalid_json: "Serwer odrzucił dane formularza.",
  invalid_content_type: "Serwer odrzucił format żądania.",
  request_too_large: "Treść jest zbyt długa.",
  service_unavailable: "Usługa jest chwilowo niedostępna. Spróbuj później.",
  not_found: "Nie znaleziono zasobu.",
  method_not_allowed: "Operacja niedozwolona.",
});

export function errorMessage(code, status) {
  if (code && Object.hasOwn(ERROR_MESSAGES, code)) return ERROR_MESSAGES[code];
  if (status === 401) return ERROR_MESSAGES.unauthenticated;
  if (status === 403) return ERROR_MESSAGES.forbidden;
  if (status >= 500) return "Błąd serwera. Spróbuj ponownie za chwilę.";
  return status ? `Nieoczekiwany błąd (${status}).` : "Brak połączenia z serwerem. Sprawdź sieć i spróbuj ponownie.";
}

// Błąd z kodem API — main.js rzuca go po nieudanej odpowiedzi.
export class ApiError extends Error {
  constructor(code, status) {
    super(errorMessage(code, status));
    this.code = code || null;
    this.status = status || 0;
  }
}

export function isConflict(error) {
  return error?.code === "revision_conflict";
}

export function isUnauthenticated(error) {
  return error?.status === 401 || error?.code === "unauthenticated";
}

export function isValidId(value) {
  return typeof value === "string" && ID_PATTERN.test(value.trim());
}

// ---------- czas Europe/Brussels ----------

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function brusselsWall(date) {
  const p = Object.fromEntries(partsFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

export function brusselsOffsetMinutes(date) {
  const seconds = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((brusselsWall(date) - seconds) / 60000);
}

export function formatOffset(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function offsetLabel(offset) {
  if (offset === "+02:00") return "czas letni, UTC+02:00";
  if (offset === "+01:00") return "czas zimowy, UTC+01:00";
  return `UTC${offset}`;
}

// Klasyfikuje czas lokalny z pola datetime-local ("RRRR-MM-DDTGG:MM").
// kind: "empty" | "invalid" | "ok" | "ambiguous" | "nonexistent";
// offsets: przesunięcia, przy których ten czas istnieje w Brukseli.
export function classifyBrusselsLocal(value) {
  const text = String(value ?? "").trim();
  if (!text) return { kind: "empty", offsets: [] };
  const match = LOCAL_INPUT_PATTERN.exec(text);
  if (!match) return { kind: "invalid", offsets: [] };
  const [, y, mo, d, h, mi] = match.map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d
    || check.getUTCHours() !== h || check.getUTCMinutes() !== mi || y < 2000 || y > 2100) {
    return { kind: "invalid", offsets: [] };
  }
  const offsets = [120, 60].filter((offset) => brusselsWall(new Date(wall - offset * 60000)) === wall);
  if (offsets.length === 0) return { kind: "nonexistent", offsets: [] };
  return { kind: offsets.length > 1 ? "ambiguous" : "ok", offsets: offsets.map(formatOffset) };
}

// Chwila UTC dla czasu lokalnego; przy godzinie podwójnej wymaga offsetu.
export function localToInstant(value, offset = "") {
  const info = classifyBrusselsLocal(value);
  if (info.kind === "ok") return new Date(`${value}:00${info.offsets[0]}`);
  if (info.kind === "ambiguous" && info.offsets.includes(offset)) return new Date(`${value}:00${offset}`);
  return null;
}

// Wartość wysyłana do API: przesunięcie tylko wtedy, gdy godzina jest podwójna.
export function toApiLocal(value, offset = "") {
  const info = classifyBrusselsLocal(value);
  if (info.kind === "ambiguous" && OFFSET_PATTERN.test(offset) && info.offsets.includes(offset)) return `${value}${offset}`;
  return value;
}

// Rozbija czas z API ("2026-10-25T02:30:00+02:00") na wartość pola i offset.
export function fromApiLocal(value) {
  const text = String(value ?? "");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?([+-]\d{2}:\d{2}|Z)?$/.exec(text);
  if (!match) return { local: "", offset: "" };
  const info = classifyBrusselsLocal(match[1]);
  return { local: match[1], offset: info.kind === "ambiguous" ? (match[2] ?? "") : "" };
}

const dateTimeFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIMEZONE,
  weekday: "short", day: "numeric", month: "long", year: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const timeFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
const stampFormatter = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIMEZONE, dateStyle: "short", timeStyle: "short",
});

function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Dopisek o przesunięciu tylko w godzinie podwójnej, gdzie sama godzina nie wystarcza.
function ambiguityNote(date) {
  const wall = new Date(brusselsWall(date)).toISOString().slice(0, 16);
  return classifyBrusselsLocal(wall).kind === "ambiguous" ? ` (${offsetLabel(formatOffset(brusselsOffsetMinutes(date)))})` : "";
}

// Czas w Brukseli niezależnie od strefy przeglądarki.
export function formatBrussels(value) {
  const date = toDate(value);
  if (!date) return "—";
  return `${dateTimeFormatter.format(date)}${ambiguityNote(date)}`;
}

export function formatRange(startsUtc, endsUtc) {
  const start = toDate(startsUtc);
  if (!start) return "—";
  const end = toDate(endsUtc);
  if (!end) return formatBrussels(start);
  if (dayKeyFormatter.format(start) === dayKeyFormatter.format(end)) {
    return `${formatBrussels(start)} – ${timeFormatter.format(end)}${ambiguityNote(end)}`;
  }
  return `${formatBrussels(start)} – ${formatBrussels(end)}`;
}

export function formatStamp(value) {
  const date = toDate(value);
  return date ? stampFormatter.format(date) : "—";
}

// ---------- walidacja formularza ----------

function optionalText(value, max, field, message, errors) {
  const text = String(value ?? "").trim();
  if (text.length > max) errors[field] = message;
  return text || null;
}

// values: { schoolYearId, classId, title, description, startsAt, startsOffset,
// endsAt, endsOffset, location, organizer, audience }, mode: "create" | "edit".
// Zwraca { errors, content, scope, needsOffset }.
export function validateEventForm(values, { mode = "create" } = {}) {
  const errors = {};
  const needsOffset = {};
  const scope = {};
  if (mode === "create") {
    const schoolYearId = String(values.schoolYearId ?? "").trim();
    if (!isValidId(schoolYearId)) errors.schoolYearId = "Podaj poprawny identyfikator roku szkolnego.";
    const classId = String(values.classId ?? "").trim();
    if (classId && !isValidId(classId)) errors.classId = ERROR_MESSAGES.invalid_class;
    scope.schoolYearId = schoolYearId;
    scope.classId = classId || null;
  }

  const title = String(values.title ?? "").trim();
  if (title.length < 3 || title.length > 200) errors.title = ERROR_MESSAGES.invalid_title;
  const description = optionalText(values.description, 4000, "description", ERROR_MESSAGES.invalid_description, errors);
  const location = optionalText(values.location, 200, "location", ERROR_MESSAGES.invalid_location, errors);
  const organizer = optionalText(values.organizer, 200, "organizer", ERROR_MESSAGES.invalid_organizer, errors);
  const audience = values.audience;
  if (!Object.hasOwn(AUDIENCE_LABELS, audience)) errors.audience = ERROR_MESSAGES.invalid_audience;

  const checkTime = (field, offsetField, required) => {
    const value = String(values[field] ?? "").trim();
    const offset = String(values[offsetField] ?? "");
    const info = classifyBrusselsLocal(value);
    if (info.kind === "empty") {
      if (required) errors[field] = "Podaj datę i godzinę początku.";
      return { api: null, instant: null };
    }
    if (info.kind === "invalid") errors[field] = ERROR_MESSAGES.invalid_datetime;
    else if (info.kind === "nonexistent") errors[field] = ERROR_MESSAGES.nonexistent_local_time;
    else if (info.kind === "ambiguous") {
      needsOffset[field] = info.offsets;
      if (!info.offsets.includes(offset)) errors[field] = ERROR_MESSAGES.ambiguous_local_time;
    }
    return { api: toApiLocal(value, offset), instant: localToInstant(value, offset) };
  };
  const start = checkTime("startsAt", "startsOffset", true);
  const end = checkTime("endsAt", "endsOffset", false);
  if (start.instant && end.instant && end.instant < start.instant) errors.endsAt = ERROR_MESSAGES.ends_before_start;

  return {
    errors,
    needsOffset,
    scope,
    content: {
      title,
      description,
      startsAt: start.api,
      endsAt: end.api,
      location,
      organizer,
      audience,
    },
  };
}

export function validateReason(value) {
  const reason = String(value ?? "").trim();
  if (reason.length < 3 || reason.length > 500) return { error: ERROR_MESSAGES.invalid_reason, reason };
  return { error: null, reason };
}

// ---------- żądania ----------

const JSON_HEADERS = Object.freeze({ "Content-Type": "application/json" });

export function buildListUrl(schoolYearId) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  return `/api/events?${new URLSearchParams({ schoolYearId: schoolYearId.trim() })}`;
}

export function buildEventUrl(eventId) {
  if (!isValidId(eventId)) throw new Error(ERROR_MESSAGES.invalid_event_id);
  return `/api/events/${encodeURIComponent(eventId)}`;
}

export function buildCreateRequest({ scope, content }, idempotencyKey) {
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(idempotencyKey)) {
    throw new Error(ERROR_MESSAGES.invalid_idempotency_key);
  }
  const body = { schoolYearId: scope.schoolYearId, ...content };
  if (scope.classId) body.classId = scope.classId;
  return {
    url: "/api/events",
    method: "POST",
    headers: { ...JSON_HEADERS, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  };
}

function requireRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(ERROR_MESSAGES.invalid_revision);
  return revision;
}

// Pełna treść + numer wersji widzianej przez użytkownika. Puste pola = null (wyczyszczenie).
export function buildUpdateRequest(eventId, revision, content) {
  return {
    url: buildEventUrl(eventId),
    method: "PATCH",
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ revision: requireRevision(revision), ...content }),
  };
}

export function buildActionRequest(eventId, action, revision, reason) {
  if (!Object.hasOwn(ACTION_LABELS, action)) throw new Error("Nieznana operacja.");
  const body = { revision: requireRevision(revision) };
  if (action === "cancel") {
    const checked = validateReason(reason);
    if (checked.error) throw new Error(checked.error);
    body.reason = checked.reason;
  }
  return {
    url: `${buildEventUrl(eventId)}/${action}`,
    method: "POST",
    headers: { ...JSON_HEADERS },
    body: JSON.stringify(body),
  };
}

export function makeIdempotencyKey(prefix, randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUUID !== "function") throw new Error("Ta przeglądarka nie obsługuje bezpiecznych identyfikatorów operacji.");
  return `${prefix}-${randomUUID()}`;
}

// Jeden klucz na otwarty formularz: ponowienie (podwójne kliknięcie, błąd sieci)
// wysyła ten sam klucz, więc serwer zwraca ten sam szkic. Reset po sukcesie
// albo zamknięciu formularza.
export function createKeyHolder(prefix, randomUUID) {
  let key = null;
  return {
    get() {
      key ||= makeIdempotencyKey(prefix, randomUUID);
      return key;
    },
    peek: () => key,
    reset() { key = null; },
  };
}

// ---------- widok ----------

export function filterEvents(events, status = "") {
  const list = Array.isArray(events) ? events : [];
  if (!status) return list;
  return list.filter((event) => event?.status === status);
}

export function countByStatus(events) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const event of Array.isArray(events) ? events : []) {
    if (Object.hasOwn(counts, event?.status)) counts[event.status] += 1;
  }
  return counts;
}

// Kroki możliwe w danym stanie. Serwer i tak sprawdza rolę; przyciski to tylko skrót.
export function availableActions(event) {
  switch (event?.status) {
    case "draft": return ["submit", "cancel"];
    case "submitted": return ["approve", "cancel"];
    case "approved": return event.audience === "public" ? ["publish", "cancel"] : ["cancel"];
    case "published": return ["cancel"];
    default: return [];
  }
}

export function canEditEvent(event) {
  return Boolean(event) && event.status !== "cancelled";
}

// Czy wydarzenie ma opublikowaną wersję starszą niż bieżąca (strona publiczna pokazuje starszą).
export function publishedIsBehind(event) {
  return Number.isSafeInteger(event?.publishedRevision) && event.publishedRevision !== event.revision;
}

export function revisionMarks(event, revision) {
  const marks = [];
  if (revision === event?.revision) marks.push("bieżąca");
  if (revision === event?.submittedRevision) marks.push("zgłoszona");
  if (revision === event?.approvedRevision) marks.push("zatwierdzona");
  if (revision === event?.publishedRevision) marks.push("opublikowana");
  return marks;
}

// Pola, które zmieniły się względem poprzedniej wersji (do widoku historii).
const REVISION_FIELDS = Object.freeze({
  title: "tytuł",
  description: "opis",
  startsAt: "początek",
  endsAt: "koniec",
  location: "miejsce",
  organizer: "organizator",
  audience: "odbiorcy",
});

export function changedFields(previous, current) {
  if (!previous) return [];
  return Object.entries(REVISION_FIELDS)
    .filter(([key]) => (previous[key] ?? null) !== (current[key] ?? null))
    .map(([, label]) => label);
}

// Wartości formularza z wydarzenia (edycja).
export function formValuesFromEvent(event) {
  const start = fromApiLocal(event?.startsAt);
  const end = fromApiLocal(event?.endsAt);
  return {
    schoolYearId: event?.schoolYearId ?? "",
    classId: event?.classId ?? "",
    title: event?.title ?? "",
    description: event?.description ?? "",
    startsAt: start.local,
    startsOffset: start.offset,
    endsAt: end.local,
    endsOffset: end.offset,
    location: event?.location ?? "",
    organizer: event?.organizer ?? "",
    audience: event?.audience ?? "internal",
  };
}
