// Czysta logika panelu zebrań (#13). Bez DOM i bez sieci, testowana w
// tests/meetings-core.test.js. Kontrakt API: src/pg/meetings.js, docs/MEETINGS.md.
//
// Panel nie koduje regulaminu (D-21) i nie prowadzi głosowania elektronicznego
// (D-19). Wynik quorum oblicza serwer z ręcznie wpisanej reguły i listy obecności;
// liczby głosów wpisuje sekretarz po głosowaniu przeprowadzonym na zebraniu.

import { statusMessage } from "../shared/messages.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const TIME_ZONE = "Europe/Brussels";

export const KIND_LABELS = Object.freeze({
  plenary: "Zebranie ogólne",
  board: "Zebranie zarządu",
  class: "Zebranie klasowe",
});

export const STATUS_LABELS = Object.freeze({
  draft: "Szkic",
  scheduled: "Zaplanowane",
  held: "Odbyte",
  archived: "Zarchiwizowane",
});

export const STATUS_ACTION_LABELS = Object.freeze({
  draft: "Przywróć do szkicu",
  scheduled: "Oznacz jako zaplanowane",
  held: "Oznacz jako odbyte",
  archived: "Zarchiwizuj",
});

const STATUS_TRANSITIONS = Object.freeze({
  draft: ["scheduled"],
  scheduled: ["draft", "held"],
  held: ["archived"],
  archived: [],
});

export const CAPACITY_LABELS = Object.freeze({
  representative: "Przedstawiciel klasy",
  board_member: "Członek zarządu",
  audit_member: "Członek Komisji Rewizyjnej",
  principal: "Dyrekcja",
  teacher: "Nauczyciel",
  guardian: "Rodzic / opiekun",
  guest: "Gość",
  other: "Inna funkcja",
});

export const QUORUM_MODE_LABELS = Object.freeze({
  not_configured: "Nie ustalono reguły",
  fraction: "Ułamek składu uprawnionego",
  minimum_count: "Minimalna liczba obecnych uprawnionych",
});

export const MINUTES_STATUS_LABELS = Object.freeze({
  draft: "Projekt",
  approved: "Zatwierdzony",
});

export const VISIBILITY_LABELS = Object.freeze({
  internal: "Wewnętrzny",
  parents: "Rodzice",
  public: "Publiczny",
});

export const RESOLUTION_STATUS_LABELS = Object.freeze({
  draft: "Projekt",
  adopted: "Przyjęta",
  rejected: "Odrzucona",
  withdrawn: "Wycofana",
});

export const VOTE_LABELS = Object.freeze({
  votesFor: "Za",
  votesAgainst: "Przeciw",
  votesAbstain: "Wstrzymało się",
});

export const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "Sesja wygasła lub nie zalogowano się. Zaloguj się ponownie.",
  forbidden: "Brak uprawnień do tej operacji lub tego zebrania.",
  invalid_origin: "Żądanie odrzucone: niezgodny adres panelu.",
  invalid_request: "Serwer odrzucił dane formularza. Sprawdź pola.",
  invalid_json: "Serwer nie odczytał danych formularza.",
  invalid_content_type: "Serwer nie odczytał danych formularza.",
  request_too_large: "Treść jest zbyt długa.",
  invalid_reference: "Wskazana osoba, klasa lub ustalenie quorum nie istnieje.",
  invalid_idempotency_key: "Niepoprawny identyfikator operacji. Otwórz formularz ponownie.",
  idempotency_conflict: "Ten formularz był już wysłany z innymi danymi. Poprzednia próba mogła zostać zapisana — sprawdź odświeżone dane przed ponownym wysłaniem.",
  invalid_quorum_rule: "Niepoprawna reguła quorum.",
  invalid_meeting_id: "Niepoprawny identyfikator zebrania.",
  invalid_minutes_id: "Niepoprawny identyfikator protokołu.",
  invalid_resolution_id: "Niepoprawny identyfikator uchwały.",
  meeting_not_found: "Nie znaleziono zebrania.",
  minutes_not_found: "Nie znaleziono wersji protokołu.",
  resolution_not_found: "Nie znaleziono uchwały.",
  not_found: "Nie znaleziono zasobu.",
  method_not_allowed: "Operacja niedostępna.",
  service_unavailable: "Usługa jest chwilowo niedostępna.",
  conflict: "Konflikt danych. Odśwież zebranie i spróbuj ponownie.",
  concurrent_version: "Ktoś inny zapisał zmianę w tym samym czasie. Odśwież zebranie.",
  meeting_locked: "Zebranie jest zablokowane: protokół został zatwierdzony albo zebranie zarchiwizowano.",
  meeting_status_transition_invalid: "Ta zmiana statusu zebrania jest niedozwolona.",
  meeting_archive_requires_approved_minutes: "Archiwizacja wymaga zatwierdzonego protokołu.",
  meeting_identity_immutable: "Rodzaju, roku ani klasy zebrania nie można zmienić.",
  meeting_must_start_as_draft_or_scheduled: "Nowe zebranie musi być szkicem albo zaplanowane.",
  quorum_requires_held_meeting: "Quorum można ustalić tylko dla zebrania oznaczonego jako odbyte.",
  quorum_rule_not_configured: "Najpierw wpisz regułę quorum dla tego zebrania.",
  quorum_attendance_exceeds_voting_body: "Liczba obecnych uprawnionych przekracza wpisany skład uprawniony. Popraw listę obecności lub regułę.",
  minutes_require_held_meeting: "Protokół można dodać tylko do zebrania oznaczonego jako odbyte.",
  minutes_version_mismatch: "Konflikt numeracji wersji protokołu. Odśwież zebranie.",
  minutes_approved_immutable: "Zatwierdzonej wersji protokołu nie można zmienić.",
  minutes_version_immutable: "Zapisanej wersji protokołu nie można zmienić.",
  minutes_not_latest_version: "Zatwierdzić można tylko najnowszą wersję protokołu.",
  minutes_open_resolutions: "Protokołu nie można zatwierdzić, dopóki zebranie ma projekty uchwał. Rozstrzygnij albo wycofaj każdy projekt.",
  minutes_not_approved: "Widoczność można ustawić tylko dla zatwierdzonej wersji.",
  resolution_final_immutable: "Uchwała przyjęta lub odrzucona jest niezmienna. Użyj poprawki zapisu.",
  resolution_identity_immutable: "Numeru ani zebrania uchwały nie można zmienić poprawką.",
  resolution_correction_mismatch: "Poprawka nie pasuje do bieżącej rewizji uchwały. Odśwież zebranie.",
  resolution_amends_requires_adopted: "Zmieniać można tylko uchwałę przyjętą.",
  resolution_requires_held_meeting: "Wynik uchwały można wpisać tylko dla zebrania oznaczonego jako odbyte.",
  resolution_quorum_check_required: "Wskaż ustalenie quorum z tego zebrania.",
  resolution_votes_exceed_present_voters: "Suma głosów przekracza liczbę obecnych uprawnionych w wybranym ustaleniu quorum.",
  resolution_quorum_check_stale: "Lista obecności zmieniła się po wybranym ustaleniu quorum. Ustal quorum ponownie i wskaż nowe ustalenie.",
  resolution_number_required: "Uchwała przyjęta wymaga numeru.",
  resolution_number_taken: "Ten numer uchwały jest już zajęty w tym roku szkolnym.",
  vote_record_required: "Wynik uchwały wymaga wszystkich trzech liczb głosów i ustalenia quorum.",
  agenda_position_taken: "Ta pozycja porządku obrad jest już zajęta.",
});

export function errorMessage(code, status) {
  if (typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code)) return ERROR_MESSAGES[code];
  if (status === 409) return ERROR_MESSAGES.conflict;
  if (status >= 500) return statusMessage(status);
  return `Operacja nie powiodła się${status ? ` (${status})` : ""}.`;
}

export function isValidId(value) {
  return typeof value === "string" && ID_PATTERN.test(value.trim());
}

export function makeIdempotencyKey(prefix, randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUUID !== "function") throw new Error("Ta przeglądarka nie obsługuje bezpiecznych identyfikatorów operacji.");
  return `${prefix}-${randomUUID()}`;
}

export function buildMeetingsUrl(schoolYearId) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  return `/api/meetings?${new URLSearchParams({ schoolYearId: schoolYearId.trim() })}`;
}

// #167: przedstawiciel bez roli z MEETING_READ_ROLES czyta wyłącznie protokoły
// udostępnione (GET /api/meetings/shared-minutes) — ta sama walidacja identyfikatora,
// bez wysyłania zapytania, które z góry skończy się 403 (listMeetings).
export function buildSharedMinutesUrl(schoolYearId) {
  if (!isValidId(schoolYearId)) throw new Error("Podaj poprawny identyfikator roku szkolnego.");
  return `/api/meetings/shared-minutes?${new URLSearchParams({ schoolYearId: schoolYearId.trim() })}`;
}

export function meetingUrl(meetingId, ...rest) {
  if (!isValidId(meetingId)) throw new Error("Niepoprawny identyfikator zebrania.");
  return ["/api/meetings", meetingId, ...rest].map((part, index) => (index === 0 ? part : encodeURIComponent(part))).join("/");
}

// ---------- czas Europe/Brussels ----------

const brusselsParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// ISO (UTC) → wartość pola datetime-local w czasie brukselskim („2026-10-05T18:30”).
export function isoToBrusselsLocal(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.valueOf())) return "";
  const parts = Object.fromEntries(brusselsParts.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// Wartość datetime-local rozumiana jako czas brukselski → ISO UTC, niezależnie od
// strefy przeglądarki. Godzina podwójna przy zmianie czasu → pierwsze wystąpienie.
export function brusselsLocalToIso(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) throw new Error("Podaj datę i godzinę zebrania.");
  const [, year, month, day, hour, minute] = match.map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`;
  // Bruksela ma przesunięcie +01:00 (CET) albo +02:00 (CEST).
  for (const offsetMinutes of [120, 60]) {
    const candidate = new Date(wall - offsetMinutes * 60_000);
    if (isoToBrusselsLocal(candidate.toISOString()) === normalized) return candidate.toISOString();
  }
  throw new Error("Ta godzina nie istnieje w Brukseli (zmiana czasu). Wybierz inną.");
}

const displayFormat = new Intl.DateTimeFormat("pl-PL", {
  timeZone: TIME_ZONE,
  dateStyle: "long",
  timeStyle: "short",
});

export function formatBrussels(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.valueOf())) return "—";
  return displayFormat.format(date);
}

// ---------- status zebrania ----------

export function allowedStatusTransitions(status) {
  return STATUS_TRANSITIONS[status] ? [...STATUS_TRANSITIONS[status]] : [];
}

// Zebranie jest zablokowane po archiwizacji lub pierwszym zatwierdzeniu protokołu.
export function isMeetingLocked(detail) {
  if (detail?.meeting?.status === "archived") return true;
  return Array.isArray(detail?.minutes) && detail.minutes.some((item) => item.status === "approved");
}

// ---------- reguła quorum ----------

function parseInteger(value, { min, max, label }) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label}: podaj liczbę całkowitą.`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label}: dozwolony zakres ${min}–${max}.`);
  }
  return number;
}

// Pola formularza (tekst) → pola API reguły quorum. Źródło reguły jest w panelu
// obowiązkowe dla każdej skonfigurowanej reguły (API dopuszcza jego brak).
export function buildQuorumRule(fields = {}) {
  const mode = fields.quorumMode || "not_configured";
  if (!Object.hasOwn(QUORUM_MODE_LABELS, mode)) throw new Error("Nieznany rodzaj reguły quorum.");
  const source = String(fields.quorumRuleSource ?? "").trim();
  const sizeRaw = String(fields.votingBodySize ?? "").trim();
  const rule = {
    quorumMode: mode,
    votingBodySize: sizeRaw ? parseInteger(sizeRaw, { min: 1, max: 10000, label: "Liczebność składu uprawnionego" }) : null,
    quorumRuleSource: source || null,
  };
  if (mode === "not_configured") return rule;
  if (source.length < 3 || source.length > 200) {
    throw new Error("Źródło reguły: wpisz, skąd pochodzi reguła (np. paragraf regulaminu), 3–200 znaków.");
  }
  if (mode === "fraction") {
    if (rule.votingBodySize === null) throw new Error("Reguła ułamkowa wymaga liczebności składu uprawnionego.");
    rule.quorumNumerator = parseInteger(fields.quorumNumerator, { min: 1, max: 1000, label: "Licznik" });
    rule.quorumDenominator = parseInteger(fields.quorumDenominator, { min: 1, max: 1000, label: "Mianownik" });
    if (fields.quorumInclusive !== "true" && fields.quorumInclusive !== "false") {
      throw new Error("Wybierz, czy wymagane jest „co najmniej”, czy „więcej niż”.");
    }
    rule.quorumInclusive = fields.quorumInclusive === "true";
    if (rule.quorumNumerator > rule.quorumDenominator) throw new Error("Licznik nie może być większy od mianownika.");
    if (!rule.quorumInclusive && rule.quorumNumerator === rule.quorumDenominator) {
      throw new Error("„Więcej niż” całego składu jest niemożliwe do spełnienia.");
    }
  } else {
    rule.quorumMinCount = parseInteger(fields.quorumMinCount, { min: 1, max: 10000, label: "Minimalna liczba obecnych" });
  }
  return rule;
}

// Reguła w kształcie z API (meeting.quorumRule lub ustalenie quorum).
function normalizeRule(rule = {}) {
  return {
    mode: rule.mode ?? rule.quorumMode ?? "not_configured",
    numerator: rule.numerator ?? rule.quorumNumerator ?? null,
    denominator: rule.denominator ?? rule.quorumDenominator ?? null,
    inclusive: rule.inclusive ?? rule.quorumInclusive ?? null,
    minCount: rule.minCount ?? rule.quorumMinCount ?? null,
    votingBodySize: rule.votingBodySize ?? null,
  };
}

// Ta sama arytmetyka co trigger meeting_quorum_compute — wyłącznie podgląd.
export function requiredCountForRule(input) {
  const rule = normalizeRule(input);
  if (rule.mode === "fraction") {
    const { numerator: n, denominator: d, votingBodySize: size } = rule;
    if (![n, d, size].every(Number.isSafeInteger) || d < 1) return null;
    const required = rule.inclusive ? Math.ceil((n * size) / d) : Math.floor((n * size) / d) + 1;
    return Math.max(required, 1);
  }
  if (rule.mode === "minimum_count") return Number.isSafeInteger(rule.minCount) ? Math.max(rule.minCount, 1) : null;
  return null;
}

export function describeQuorumRule(input) {
  const rule = normalizeRule(input);
  if (rule.mode === "fraction") {
    const relation = rule.inclusive ? "co najmniej" : "więcej niż";
    return `${relation} ${rule.numerator}/${rule.denominator} składu uprawnionego (${rule.votingBodySize} osób) — wymagane ${requiredCountForRule(rule)} obecnych uprawnionych`;
  }
  if (rule.mode === "minimum_count") {
    return `co najmniej ${rule.minCount} obecnych osób z prawem głosu`;
  }
  return "reguła quorum nie została wpisana — ustalenie quorum jest niemożliwe";
}

export const QUORUM_BASIS_NOTE =
  "Wynik obliczył serwer z reguły i listy obecności wpisanych ręcznie dla tego zebrania. Aplikacja nie zna regulaminu Rady: poprawność wyniku zależy od poprawności tych wpisów.";

export function describeQuorumCheck(check) {
  if (!check) return null;
  const present = check.presentEligible;
  const required = check.requiredCount;
  return {
    met: check.met === true,
    headline: check.met === true ? "Quorum osiągnięte" : "Quorum nieosiągnięte",
    detail: `Obecni z prawem głosu: ${present}; wymagane: ${required}. Reguła: ${describeQuorumRule(check)}.`
      + (check.current === false ? " Lista obecności zmieniła się po tym ustaleniu — nowa uchwała wymaga ponownego ustalenia quorum." : ""),
    stale: check.current === false,
    basis: QUORUM_BASIS_NOTE,
  };
}

// ---------- lista kontrolna przed zatwierdzeniem protokołu (#81) ----------

const CHECKLIST_LABELS = {
  meeting_not_held: () => "Zebranie nie ma statusu „Odbyte”. Protokół można zatwierdzić dopiero po odbyciu zebrania.",
  open_resolutions: (count) => `Otwarte projekty uchwał: ${count}. Rozstrzygnij albo wycofaj każdy projekt przed zatwierdzeniem.`,
  quorum_rule_missing: () => "Reguła quorum nie została wpisana. Po zatwierdzeniu nie da się jej uzupełnić.",
  quorum_rule_source_missing: () => "Brak źródła reguły quorum (np. paragrafu regulaminu).",
  no_quorum_check: () => "Quorum nie zostało ustalone.",
  stale_quorum_check: () => "Lista obecności zmieniła się po ostatnim ustaleniu quorum.",
  resolutions_on_stale_check: (count) => `Uchwały oparte na nieaktualnym ustaleniu quorum: ${count}. Po zatwierdzeniu poprawi je tylko nowy zapis.`,
};

// Zamienia odpowiedź GET /api/meetings/:id/approval-checklist na pozycje do
// wyświetlenia. Nieznany kod jest pomijany (serwer może być nowszy od panelu).
export function describeApprovalChecklist(checklist) {
  const items = Array.isArray(checklist?.items) ? checklist.items : [];
  const described = items
    .filter((item) => typeof CHECKLIST_LABELS[item?.code] === "function")
    .map((item) => ({ code: item.code, blocking: item.blocking === true, text: CHECKLIST_LABELS[item.code](item.count) }));
  return {
    blocking: described.filter((item) => item.blocking),
    warnings: described.filter((item) => !item.blocking),
  };
}

// ---------- lista obecności ----------

export function attendeeReference(attendee) {
  if (attendee?.userId) return { type: "user", id: attendee.userId, label: `Konto: ${attendee.userId}` };
  if (attendee?.guardianId) return { type: "guardian", id: attendee.guardianId, label: `Opiekun: ${attendee.guardianId}` };
  return { type: "", id: "", label: "—" };
}

export function summarizeAttendance(attendees = []) {
  const list = Array.isArray(attendees) ? attendees : [];
  return {
    recorded: list.length,
    present: list.filter((item) => item.present === true).length,
    eligible: list.filter((item) => item.votingEligible === true).length,
    presentEligible: list.filter((item) => item.present === true && item.votingEligible === true).length,
  };
}

function yesNo(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label}: zaznacz „tak” albo „nie”.`);
}

// Pola formularza obecności → treść żądania. Prawo głosu i obecność nie mają wartości domyślnej.
export function buildAttendancePayload(fields = {}) {
  const id = String(fields.personId ?? "").trim();
  if (!isValidId(id)) throw new Error("Podaj poprawny identyfikator osoby.");
  if (fields.personType !== "user" && fields.personType !== "guardian") throw new Error("Wybierz rodzaj identyfikatora osoby.");
  if (!Object.hasOwn(CAPACITY_LABELS, fields.capacity)) throw new Error("Wybierz funkcję na zebraniu.");
  return {
    ...(fields.personType === "user" ? { userId: id } : { guardianId: id }),
    capacity: fields.capacity,
    present: yesNo(fields.present, "Obecność"),
    votingEligible: yesNo(fields.votingEligible, "Prawo głosu"),
  };
}

// ---------- głosy ----------

export function parseVoteCount(value, label) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  return parseInteger(raw, { min: 0, max: 10000, label });
}

// Liczby głosów wpisane przez sekretarza. Dla wyniku (przyjęta/odrzucona) wymagane są
// wszystkie trzy liczby i ustalenie quorum; suma nie może przekroczyć liczby obecnych
// uprawnionych w tym ustaleniu. Panel nie ocenia większości — status wpisuje sekretarz.
export function validateVotes(fields = {}, { status = "draft", quorumCheck = null } = {}) {
  const votes = {};
  for (const [key, label] of Object.entries(VOTE_LABELS)) votes[key] = parseVoteCount(fields[key], label);
  const final = status === "adopted" || status === "rejected";
  const values = Object.values(votes);
  if (final) {
    if (values.some((value) => value === null)) throw new Error("Wynik uchwały wymaga wszystkich trzech liczb: za, przeciw, wstrzymało się (także 0).");
    if (!quorumCheck) throw new Error("Wynik uchwały wymaga wskazania ustalenia quorum z tego zebrania.");
  }
  const entered = values.filter((value) => value !== null);
  const total = entered.reduce((sum, value) => sum + value, 0);
  if (quorumCheck && entered.length && total > quorumCheck.presentEligible) {
    throw new Error(`Suma głosów (${total}) przekracza liczbę obecnych z prawem głosu (${quorumCheck.presentEligible}) w wybranym ustaleniu quorum.`);
  }
  return { votes, total };
}

export function formatVotes(resolution) {
  const values = [resolution?.votesFor, resolution?.votesAgainst, resolution?.votesAbstain];
  if (values.every((value) => value === null || value === undefined)) return "—";
  return values.map((value) => (value ?? "—")).join(" / ");
}

// ---------- uchwały ----------

// Bieżące rewizje: uchwały, których nie poprawia żadna nowsza rewizja. Każda ma
// `history` — wcześniejsze rewizje od najstarszej.
export function currentResolutions(resolutions = []) {
  const list = Array.isArray(resolutions) ? resolutions : [];
  const byId = new Map(list.map((item) => [item.id, item]));
  const corrected = new Set(list.map((item) => item.correctsId).filter(Boolean));
  return list
    .filter((item) => !corrected.has(item.id))
    .map((item) => {
      const history = [];
      let cursor = item.correctsId ? byId.get(item.correctsId) : null;
      while (cursor && history.length < list.length) {
        history.unshift(cursor);
        cursor = cursor.correctsId ? byId.get(cursor.correctsId) : null;
      }
      return { ...item, history };
    });
}

// Projekt edytuje się wprost; pomyłkę w zapisie wyniku poprawia nowa rewizja, ale
// tylko do zatwierdzenia protokołu. Później zmiana wymaga nowej uchwały zmieniającej
// (pole „Zmienia uchwałę nr” w formularzu uchwały innego zebrania).
export function resolutionActions(resolution, { locked }) {
  if (locked) return [];
  if (resolution.status === "draft") return ["edit"];
  if (resolution.status === "adopted" || resolution.status === "rejected") return ["correct"];
  return [];
}

// ---------- protokół ----------

export function latestMinutes(minutes = []) {
  const list = Array.isArray(minutes) ? minutes : [];
  return list.reduce((latest, item) => (!latest || item.version > latest.version ? item : latest), null);
}

// Udostępniana jest tylko najnowsza zatwierdzona wersja.
export function effectiveMinutes(minutes = []) {
  return latestMinutes((Array.isArray(minutes) ? minutes : []).filter((item) => item.status === "approved"));
}

export function canApproveMinutes(minutesItem, minutes, meeting) {
  if (!minutesItem || minutesItem.status !== "draft") return false;
  if (meeting?.status !== "held") return false;
  return latestMinutes(minutes)?.id === minutesItem.id;
}

// Role jak MANAGE_ROLES w src/pg/meetings.js (test tests/role-policy-parity.test.js pilnuje
// zgodności). „Nowe zebranie” tylko dla ról zarządzających; serwer i tak autoryzuje (#225).
export const MEETING_MANAGE_ROLES = Object.freeze(["admin", "board"]);
// Zgodne z READ_ROLES w src/pg/meetings.js (listMeetings) — jeśli się rozjadą,
// przedstawiciel znów dostanie 403 na pełnym widoku (#167).
export const MEETING_READ_ROLES = Object.freeze(["admin", "board", "audit"]);

export function canManageMeetings(grants) {
  return (Array.isArray(grants) ? grants : []).some((grant) => MEETING_MANAGE_ROLES.includes(grant?.role));
}

export function canReadMeetings(grants) {
  return (Array.isArray(grants) ? grants : []).some((grant) => MEETING_READ_ROLES.includes(grant?.role));
}

// Tryb widoku panelu Zebrania (#167): 'full' — role z MEETING_READ_ROLES widzą
// obecny widok bez zmian; 'shared' — przedstawiciel bez tych ról widzi wyłącznie
// protokoły udostępnione (GET /api/meetings/shared-minutes); 'none' — konto bez
// żadnego przydziału (np. sesja przed MFA) nie zna jeszcze swojego zakresu.
export function meetingsViewMode(grants) {
  const list = Array.isArray(grants) ? grants : [];
  if (canReadMeetings(list)) return "full";
  if (list.some((grant) => grant?.role === "representative")) return "shared";
  return "none";
}
