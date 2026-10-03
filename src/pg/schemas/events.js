// Schematy OpenAPI dla modułu `events` (src/pg/routes/events.js → src/pg/events.js; #12, #116, #122, #142, #150,
// #152, #159), #160 etap 9: wydarzenia (szkic → zgłoszenie → zatwierdzenie → publikacja, odwołanie), historia
// wersji, zadania wolontariuszy z limitem miejsc, zapisy opiekunów i kont, opiekunowie klasy do formularza zapisu
// oraz publiczna lista wydarzeń z polem `volunteerTasks`. Pisane ręcznie na podstawie maperów wierszy
// w src/pg/events.js (`internalEvent`, `revisionFromRow`, `publicEvent`, `toTask`, `toSignup`, `publicTasksFor`)
// i testów tests/pg-event*.test.js; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * `Idempotency-Key` (wymagany) mają: utworzenie wydarzenia, zadania i zapisu. Tylko utworzenie wydarzenia
//     wysyła nagłówek `Idempotency-Replayed` (201 + `false`, ponowienie 200 + `true`, ciało `{ event }` bez pola
//     `replayed`); zadanie i zapis odpowiadają 201/200 BEZ nagłówka, z polem `replayed` w treści (jak dokumenty,
//     etap 8). Zapis tej samej osoby do tego samego zadania jest bezpieczną powtórką niezależnie od klucza;
//   * `PATCH`, przejścia stanu (`submit`, `approve`, `publish`, `cancel`), odwołanie zadania i wycofanie zapisu nie
//     mają klucza: zawsze 200 bez nagłówka, ponowienie sygnalizuje `replayed: true` w treści;
//   * `PATCH` i przejścia stanu wymagają `revision` (400 `invalid_revision`, 409 `revision_conflict`); czasy
//     wejściowe to czas lokalny Europe/Brussels `RRRR-MM-DDTGG:MM[:SS][przesunięcie]` (godzina powtórzona wymaga
//     przesunięcia), odpowiedzi niosą czas lokalny z przesunięciem i chwilę UTC;
//   * wydarzenie spoza zakresu podglądu: każdy odczyt i zapis wydarzenia, jego zadań i zapisów → 404 `event_not_found`
//     jak nieznany identyfikator (SR-07); 403 `forbidden` — widoczne, ale bez prawa do kroku (zatwierdzenie,
//     publikacja, odwołanie opublikowanego), lista roku i utworzenie poza zakresem;
//   * zły identyfikator w ścieżce (także zadania i zapisu) → 400 `invalid_event_id`;
//   * zapisy wydarzenia nie są stronicowane (lista roku, zadania); kursor ma wyłącznie publiczna lista
//     (`limit` 1-200, `cursor` → `nextCursor`, `truncated`, kursor związany z filtrem);
//   * publiczny widok czyta wyłącznie widok `public_events` (ostatnia OPUBLIKOWANA wersja z odbiorcami `public`):
//     bez autorów, klas, numerów wersji i powodu odwołania; `volunteerTasks` zawiera tylko zadania jawnie
//     oznaczone `isPublic`, nieodwołane, z liczbą „potrzebni jeszcze” (bez osób).
import { PII_ERRORS, mergeErrors, nullable, ref, replayed, requestObject, strictObject } from './common.js';

export const name = 'events';

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const nullableId = (description) => nullable(description ? { ...ref('EntityId'), description } : ref('EntityId'));
const nullableTime = (description) => nullable(description ? { ...ref('IsoDateTime'), description } : ref('IsoDateTime'));
const nullableString = (description) => nullable(description ? { type: 'string', description } : STRING);
const LOCAL_INPUT_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?(Z|[+-]\\d{2}:\\d{2})?$';

const LOCAL_INPUT = {
  type: 'string', pattern: LOCAL_INPUT_PATTERN,
  description: 'Czas lokalny Europe/Brussels `RRRR-MM-DDTGG:MM` (opcjonalnie sekundy i przesunięcie). Godzina powtórzona '
    + 'przy zmianie czasu wymaga przesunięcia (400 `ambiguous_local_time`), nieistniejąca → 400 `nonexistent_local_time`, '
    + 'przesunięcie niezgodne ze strefą → 400 `offset_not_valid_in_europe_brussels`, inny zapis → 400 `invalid_datetime`.',
};
const TITLE = { type: 'string', minLength: 3, maxLength: 200, description: 'Tytuł (3-200 znaków po przycięciu spacji; bramka danych osobowych, #152).' };
const REVISION = {
  type: 'integer', minimum: 1,
  description: 'Numer wersji widziany przez użytkownika; brak → 400 `invalid_revision`, niezgodny → 409 `revision_conflict`.',
};
const REASON = {
  type: 'string', minLength: 3, maxLength: 500,
  description: 'Powód (3-500 znaków po przycięciu spacji); wewnętrzny, nie trafia na stronę publiczną ani do dziennika. '
    + 'Bramka danych osobowych (#152); inna długość → 400 `invalid_reason`.',
};
const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};
const LOCAL_OUTPUT = {
  type: 'string', format: 'date-time',
  description: 'Czas lokalny Europe/Brussels z przesunięciem (`RRRR-MM-DDTGG:MM:SS+01:00`).',
};

// Pola treści wspólne dla utworzenia i zmiany wydarzenia.
const CONTENT_FIELDS = {
  title: TITLE,
  description: nullable({ type: 'string', maxLength: 4000, description: 'Opis (do 4000 znaków; bramka danych osobowych).' }),
  startsAt: LOCAL_INPUT,
  endsAt: nullable({ ...LOCAL_INPUT, description: 'Koniec (opcjonalny, nie wcześniej niż początek: 400 `ends_before_start`); pusty ciąg = brak.' }),
  location: nullable({ type: 'string', maxLength: 200 }),
  organizer: nullable({ type: 'string', maxLength: 200 }),
  audience: { type: 'string', enum: ['internal', 'public'], description: 'Domyślnie `internal`; publikować można tylko `public`.' },
  confirmPersonalData: CONFIRM,
};

const TASK_PROPERTIES = {
  id: ref('EntityId'),
  eventId: ref('EntityId'),
  title: STRING,
  startsAtUtc: nullableTime('Początek zadania (UTC); null = bez czasu.'),
  endsAtUtc: nullableTime('Koniec zadania (UTC); null = bez czasu.'),
  slotsNeeded: { type: 'integer', minimum: 1, maximum: 200, description: 'Liczba potrzebnych miejsc (limit zapisów `confirmed`).' },
  isPublic: { type: 'boolean', description: 'true: liczba „potrzebni jeszcze” trafia na stronę publiczną (`volunteerTasks`).' },
  cancelledAt: nullableTime('Odwołanie zadania (stan końcowy).'),
  cancellationReason: nullableString('Powód odwołania (wewnętrzny).'),
  createdBy: ref('EntityId'),
  createdAt: ref('IsoDateTime'),
};

export const components = {
  // `EventStatus` (draft → submitted → approved → published; cancelled — stan końcowy) jest zdefiniowany wcześniej
  // w src/pg/schemas/ledger-cost-centers.js (etap 4: rozliczenie wydarzenia) — ten sam słownik, wspólny komponent.
  EventLocalDateTime: LOCAL_OUTPUT,
  Event: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    classId: nullableId('Klasa wydarzenia klasowego; null — ogólnoszkolne. Ustalone przy tworzeniu (niezmienne).'),
    status: {
      ...ref('EventStatus'),
      description: 'Zmiana treści wraca do `draft` (opublikowana wersja zostaje publiczna do następnej publikacji); `cancelled` — stan końcowy.',
    },
    visibility: { type: 'string', enum: ['internal', 'draft_public', 'published'], description: 'Pochodna odbiorców i publikacji (trigger bazy).' },
    audience: { type: 'string', enum: ['internal', 'public'] },
    revision: { type: 'integer', minimum: 1, description: 'Bieżąca wersja treści (każda zmiana treści = nowa, niezmienna wersja).' },
    title: STRING,
    description: nullableString(),
    location: nullableString(),
    organizer: nullableString(),
    timezone: { const: 'Europe/Brussels' },
    startsAt: ref('EventLocalDateTime'),
    startsAtUtc: ref('IsoDateTime'),
    endsAt: nullable(ref('EventLocalDateTime')),
    endsAtUtc: nullableTime(),
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    updatedBy: ref('EntityId'),
    updatedAt: ref('IsoDateTime'),
    submittedRevision: nullable({ type: 'integer', minimum: 1 }),
    approvedRevision: nullable({ type: 'integer', minimum: 1 }),
    approvedBy: nullableId('Zatwierdzający (inna osoba niż autor wydarzenia i autor wersji — cztery oczy).'),
    approvedAt: nullableTime(),
    publishedRevision: nullable({ type: 'integer', minimum: 1, description: 'Wersja widoczna publicznie; null — nigdy nie opublikowane.' }),
    publishedAt: nullableTime(),
    cancelledAt: nullableTime(),
    cancellationReason: nullableString('Powód odwołania (tylko wewnętrznie).'),
  }, [], { description: 'Wydarzenie w widoku wewnętrznym (osoby z prawem do szkicu wydarzenia).' }),
  EventRevision: strictObject({
    revision: { type: 'integer', minimum: 1 },
    title: STRING,
    description: nullableString(),
    location: nullableString(),
    organizer: nullableString(),
    audience: { type: 'string', enum: ['internal', 'public'] },
    startsAt: ref('EventLocalDateTime'),
    endsAt: nullable(ref('EventLocalDateTime')),
    source: { type: 'string', enum: ['app', 'legacy_d1'], description: '`legacy_d1` — wersja przeniesiona z poprzedniego systemu.' },
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
  }, [], { description: 'Niezmienna wersja treści wydarzenia (historia nie jest nadpisywana ani usuwana).' }),
  EventTask: strictObject(TASK_PROPERTIES, [], { description: 'Zadanie wolontariuszy w obrębie wydarzenia (treść niezmienna; jedyna zmiana to odwołanie).' }),
  EventTaskSignup: strictObject({
    id: ref('EntityId'),
    taskId: ref('EntityId'),
    userId: nullableId('Konto zapisane do zadania (dokładnie jedno z `userId`/`guardianId`).'),
    guardianId: nullableId('Opiekun zapisany do zadania.'),
    personName: {
      type: 'string',
      description: 'Imię i nazwisko opiekuna albo nazwa konta — WYŁĄCZNIE w liście zadań (`GET …/tasks`) dla ról z dostępem do '
        + 'wydarzenia; brak w odpowiedziach zapisu i wycofania oraz gdy nazwa jest pusta.',
    },
    status: { type: 'string', enum: ['confirmed', 'withdrawn'], description: 'Wycofanie i ponowny zapis zmieniają status tego samego wiersza.' },
    recordedBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    updatedBy: ref('EntityId'),
    updatedAt: ref('IsoDateTime'),
  }, ['personName']),
  EventTaskWithSignups: strictObject({
    ...TASK_PROPERTIES,
    outsideEventTime: {
      type: 'boolean',
      description: 'true: okno nieodwołanego zadania wykracza poza OBECNY czas wydarzenia (po zmianie czasu wydarzenia; zadanie i zapisy zostają).',
    },
    signups: { type: 'array', items: ref('EventTaskSignup'), description: 'Wszystkie zapisy (także wycofane), od najstarszego.' },
    confirmedCount: { type: 'integer', minimum: 0, description: 'Liczba zapisów `confirmed`.' },
  }),
  EventTaskOutsideTime: strictObject({ id: ref('EntityId'), title: STRING }),
  EventPublicVolunteerTask: strictObject({
    id: ref('EntityId'),
    title: STRING,
    stillNeeded: { type: 'integer', minimum: 0, description: '„Potrzebni jeszcze”: `slotsNeeded` minus zapisy `confirmed`, nie mniej niż 0.' },
  }, [], { description: 'Zadanie jawnie oznaczone `isPublic`, nieodwołane — bez osób i identyfikatorów zapisów.' }),
  EventPublic: strictObject({
    id: ref('EntityId'),
    title: STRING,
    description: nullableString(),
    location: nullableString(),
    organizer: nullableString(),
    timezone: { const: 'Europe/Brussels' },
    startsAt: ref('EventLocalDateTime'),
    startsAtUtc: ref('IsoDateTime'),
    endsAt: nullable(ref('EventLocalDateTime')),
    endsAtUtc: nullableTime(),
    status: { type: 'string', enum: ['scheduled', 'cancelled'], description: 'Odwołane opublikowane wydarzenie zostaje na liście (bez powodu).' },
    changedAfterPublication: {
      type: 'boolean',
      description: 'true po ponownej publikacji albo gdy nowsza wersja czeka na zatwierdzenie (strona pokazuje ostatnią opublikowaną).',
    },
    volunteerTasks: { type: 'array', items: ref('EventPublicVolunteerTask'), description: 'Puste dla odwołanego wydarzenia.' },
  }, [], { description: 'Publiczny wpis: wyłącznie ostatnia opublikowana wersja (bez autorów, klas, wersji i powodu odwołania).' }),

  EventCreateRequest: requestObject({
    schoolYearId: ref('Id'),
    classId: nullable({ ...ref('Id'), description: 'Klasa wydarzenia; pominięte/null — ogólnoszkolne (tylko admin i zarząd). Przedstawiciel: tylko własna klasa.' }),
    ...CONTENT_FIELDS,
  }, ['schoolYearId', 'title', 'startsAt'], { description: 'Nowy szkic wydarzenia (pierwsza wersja treści).' }),
  EventUpdateRequest: requestObject({
    revision: REVISION,
    ...CONTENT_FIELDS,
  }, ['revision'], {
    description: 'Nowa wersja treści (pominięte pola bez zmian; `classId` i `schoolYearId` są ignorowane). Ta sama treść = '
      + 'odtworzenie (`replayed: true`); ponowienie tej samej zmiany przez jej autora po nowszym numerze wersji — też.',
  }),
  EventTransitionRequest: requestObject({ revision: REVISION }, ['revision'], {
    description: 'Krok przebiegu dla wskazanej wersji (zgłoszenie, zatwierdzenie, publikacja).',
  }),
  EventCancelRequest: requestObject({ revision: REVISION, reason: REASON, confirmPersonalData: CONFIRM }, ['revision', 'reason'], {
    description: 'Odwołanie (stan końcowy); opublikowane wydarzenie odwołuje tylko zarząd.',
  }),
  EventTaskCreateRequest: requestObject({
    title: TITLE,
    slotsNeeded: { type: 'integer', minimum: 1, maximum: 200, description: 'Inna wartość → 400 `invalid_slots_needed`.' },
    startsAt: nullable({ ...LOCAL_INPUT, description: 'Opcjonalny początek; nie przed początkiem wydarzenia (400 `task_time_outside_event`).' }),
    endsAt: nullable({ ...LOCAL_INPUT, description: 'Opcjonalny koniec; nie po końcu wydarzenia, gdy wydarzenie ma koniec.' }),
    isPublic: { type: 'boolean', description: 'Domyślnie false.' },
    confirmPersonalData: CONFIRM,
  }, ['title', 'slotsNeeded'], { description: 'Nowe zadanie (treść niezmienna po utworzeniu).' }),
  EventTaskCancelRequest: requestObject({ reason: REASON, confirmPersonalData: CONFIRM }, ['reason']),
  EventSignupRequest: {
    oneOf: [
      requestObject({ guardianId: { ...ref('Id'), description: 'Istniejący opiekun (przedstawiciel: tylko z bieżącą relacją do dziecka klasy wydarzenia).' } }, ['guardianId']),
      requestObject({ userId: { ...ref('Id'), description: 'Istniejące konto.' } }, ['userId']),
    ],
    description: 'Dokładnie jedno z `guardianId` i `userId` (oba albo żadne → 400 `invalid_signup_target`). Bez nowych danych osobowych.',
  },
};

// ---------- kody błędów ----------

// Bramka MFA routera (każda trasa poza publiczną).
const GATE = { 403: ['mfa_enrollment_required', 'mfa_required'] };
const WRITE = mergeErrors(GATE, {
  400: ['invalid_json'],
  403: ['invalid_origin'],
  409: ['school_year_closed'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
});
const EVENT_PATH = { 400: ['invalid_event_id'], 404: ['event_not_found'] };
const TIME_ERRORS = {
  400: ['ambiguous_local_time', 'ends_before_start', 'invalid_datetime', 'nonexistent_local_time', 'offset_not_valid_in_europe_brussels'],
};
const CONTENT_ERRORS = mergeErrors(TIME_ERRORS, {
  400: ['invalid_audience', 'invalid_description', 'invalid_location', 'invalid_organizer', 'invalid_title'],
});
const TRANSITION = mergeErrors(WRITE, EVENT_PATH, {
  400: ['invalid_revision'],
  409: ['event_cancelled', 'invalid_transition', 'revision_conflict'],
});

const eventOnly = strictObject({ event: ref('Event') });
const withReplayed = (properties) => strictObject({
  ...properties,
  replayed: { type: 'boolean', description: 'true: ponowienie rozpoznane po stanie obiektu (bez nowego zapisu i wpisu w dzienniku).' },
});
// Zapis z kluczem, ale bez nagłówka `Idempotency-Replayed`: ponowienie sygnalizuje pole `replayed`.
const keyedBody = (createdText, replayText, property, component) => ({
  201: { description: createdText, schema: strictObject({ [property]: ref(component), replayed: { const: false } }) },
  200: { description: replayText, schema: strictObject({ [property]: ref(component), replayed: { const: true } }) },
});

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/public/events': {
    query: {
      schoolYearId: { schema: ref('Id'), description: 'Filtr roku szkolnego (400 `invalid_school_year`).' },
      from: { schema: ref('IsoDate'), description: 'Wydarzenia kończące się (albo zaczynające) od tego dnia, czas Europe/Brussels.' },
      limit: { schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
      cursor: { schema: STRING, description: '`nextCursor` z poprzedniej strony tego samego filtru (inny filtr → 400 `invalid_cursor`).' },
    },
    responses: {
      200: {
        description: 'Publiczne (bez logowania): opublikowane wydarzenia od najbliższego (`begins_at`, `id`), kursor keyset; '
          + '`Cache-Control: public, max-age=60`.',
        schema: strictObject({
          timezone: { const: 'Europe/Brussels' },
          events: { type: 'array', items: ref('EventPublic') },
          nextCursor: nullable({ type: 'string', description: 'Kursor następnej strony; null na ostatniej.' }),
          truncated: { type: 'boolean', description: 'true wtedy i tylko wtedy, gdy `nextCursor` nie jest null.' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        }),
      },
    },
    errors: { 400: ['invalid_cursor', 'invalid_date', 'invalid_datetime', 'invalid_limit', 'invalid_school_year'] },
  },
  'GET /api/events': {
    query: { schoolYearId: { required: true, schema: ref('Id') } },
    responses: {
      200: {
        description: 'Wydarzenia roku (bez stronicowania), od najwcześniejszego; przedstawiciel widzi tylko wydarzenia swoich klas.',
        schema: strictObject({ events: { type: 'array', items: ref('Event') } }),
      },
    },
    errors: mergeErrors(GATE, { 400: ['invalid_school_year'], 403: ['forbidden'] }),
  },
  'POST /api/events': {
    idempotencyKey: true,
    body: ref('EventCreateRequest'),
    responses: {
      201: replayed('false', 'Szkic wydarzenia utworzony (nic nie jest publikowane).', eventOnly),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji (ta sama osoba, zakres i treść; bez nowego zapisu).', eventOnly),
    },
    errors: mergeErrors(WRITE, CONTENT_ERRORS, PII_ERRORS, {
      400: ['invalid_class', 'invalid_idempotency_key', 'invalid_reference', 'invalid_school_year'],
      403: ['forbidden'],
      409: ['idempotency_conflict'],
    }),
  },
  'GET /api/events/{eventId}': {
    responses: {
      200: {
        description: 'Wydarzenie z pełną historią wersji (od pierwszej).',
        schema: strictObject({ event: ref('Event'), revisions: { type: 'array', items: ref('EventRevision'), minItems: 1 } }),
      },
    },
    errors: mergeErrors(GATE, EVENT_PATH),
  },
  'PATCH /api/events/{eventId}': {
    body: ref('EventUpdateRequest'),
    responses: {
      200: {
        description: 'Nowa wersja treści (wydarzenie wraca do szkicu) albo odtworzenie (`replayed: true`). `tasksOutsideEventTime` '
          + 'wymienia nieodwołane zadania, których okno wykracza poza nowy czas wydarzenia (nie są odwoływane).',
        schema: withReplayed({ event: ref('Event'), tasksOutsideEventTime: { type: 'array', items: ref('EventTaskOutsideTime') } }),
      },
    },
    errors: mergeErrors(WRITE, EVENT_PATH, CONTENT_ERRORS, PII_ERRORS, {
      400: ['invalid_revision'],
      409: ['event_cancelled', 'revision_conflict'],
    }),
  },
  'POST /api/events/{eventId}/submit': {
    body: ref('EventTransitionRequest'),
    responses: { 200: { description: 'Zgłoszenie wersji do zatwierdzenia; ponowienie: `replayed: true`.', schema: withReplayed({ event: ref('Event') }) } },
    errors: TRANSITION,
  },
  'POST /api/events/{eventId}/approve': {
    body: ref('EventTransitionRequest'),
    responses: {
      200: {
        description: 'Zatwierdzenie zgłoszonej wersji przez zarząd (MFA, cztery oczy); ponowienie: `replayed: true`.',
        schema: withReplayed({ event: ref('Event') }),
      },
    },
    errors: mergeErrors(TRANSITION, { 403: ['forbidden', 'mfa_required'], 409: ['four_eyes_required'] }),
  },
  'POST /api/events/{eventId}/publish': {
    body: ref('EventTransitionRequest'),
    responses: {
      200: {
        description: 'Publikacja zatwierdzonej wersji z odbiorcami `public` przez zarząd (MFA); ponowienie: `replayed: true`.',
        schema: withReplayed({ event: ref('Event') }),
      },
    },
    errors: mergeErrors(TRANSITION, { 403: ['forbidden', 'mfa_required'], 409: ['event_not_public'] }),
  },
  'POST /api/events/{eventId}/cancel': {
    body: ref('EventCancelRequest'),
    responses: {
      200: {
        description: 'Odwołanie z powodem (stan końcowy; opublikowane zostaje publicznie ze statusem `cancelled`); ponowienie: `replayed: true`.',
        schema: withReplayed({ event: ref('Event') }),
      },
    },
    errors: mergeErrors(TRANSITION, PII_ERRORS, { 400: ['invalid_reason'], 403: ['forbidden'] }),
  },
  'GET /api/events/{eventId}/tasks': {
    responses: {
      200: {
        description: 'Zadania wydarzenia (także odwołane) z zapisami i imieniem i nazwiskiem zapisanych osób; odczyt nazwisk opiekunów '
          + 'trafia do dziennika (liczba, bez nazwisk).',
        schema: strictObject({ tasks: { type: 'array', items: ref('EventTaskWithSignups') } }),
      },
    },
    errors: mergeErrors(GATE, EVENT_PATH),
  },
  'GET /api/events/{eventId}/tasks/candidates': {
    query: {
      classId: {
        schema: ref('Id'),
        description: 'Klasa (z roku wydarzenia) — wymagana dla wydarzenia ogólnoszkolnego (400 `class_required`); dla klasowego musi być '
          + 'klasą wydarzenia (400 `invalid_class`).',
      },
    },
    responses: {
      200: {
        description: 'Opiekunowie z bieżącą relacją do dziecka bieżąco przypisanego do klasy: tylko identyfikator i imię z nazwiskiem '
          + '(bez e-maili, dzieci i gospodarstw); odczyt w `data_access_log`.',
        schema: strictObject({
          classId: ref('EntityId'),
          guardians: { type: 'array', items: strictObject({ id: ref('EntityId'), name: STRING }) },
        }),
      },
    },
    errors: mergeErrors(GATE, EVENT_PATH, { 400: ['class_required', 'invalid_class'], 404: ['class_not_found'] }),
  },
  'POST /api/events/{eventId}/tasks': {
    idempotencyKey: true,
    body: ref('EventTaskCreateRequest'),
    responses: keyedBody('Zadanie utworzone (bez nagłówka `Idempotency-Replayed`).',
      'Ten sam klucz i treść: istniejące zadanie, `replayed: true` (także po odwołaniu wydarzenia).', 'task', 'EventTask'),
    errors: mergeErrors(WRITE, EVENT_PATH, TIME_ERRORS, PII_ERRORS, {
      400: ['invalid_idempotency_key', 'invalid_slots_needed', 'invalid_title', 'task_time_outside_event'],
      409: ['event_cancelled', 'idempotency_conflict'],
    }),
  },
  'POST /api/events/{eventId}/tasks/{taskId}/cancel': {
    body: ref('EventTaskCancelRequest'),
    responses: {
      200: {
        description: 'Zadanie odwołane (zapisy zostają, nowe zablokowane); ponowienie: `replayed: true`.',
        schema: withReplayed({ task: ref('EventTask') }),
      },
    },
    errors: mergeErrors(GATE, EVENT_PATH, PII_ERRORS, {
      400: ['invalid_json', 'invalid_reason'],
      403: ['invalid_origin'],
      404: ['event_task_not_found'],
      // Zamknięty rok: trigger a0_year_freeze na UPDATE event_tasks (0186, #80).
      409: ['school_year_closed'],
      413: ['request_too_large'],
      415: ['invalid_content_type'],
    }),
  },
  'POST /api/events/{eventId}/tasks/{taskId}/signups': {
    idempotencyKey: true,
    body: ref('EventSignupRequest'),
    responses: keyedBody('Zapis utworzony albo ponowny zapis wycofanej osoby (ten sam wiersz, status `confirmed`).',
      'Osoba już zapisana: istniejący zapis, `replayed: true` (niezależnie od klucza).', 'signup', 'EventTaskSignup'),
    errors: mergeErrors(WRITE, EVENT_PATH, {
      400: ['guardian_outside_class', 'invalid_idempotency_key', 'invalid_reference', 'invalid_signup_target'],
      404: ['event_task_not_found'],
      409: ['event_cancelled', 'task_full'],
    }),
  },
  'POST /api/events/{eventId}/tasks/{taskId}/signups/{signupId}/withdraw': {
    responses: {
      200: {
        description: 'Zapis wycofany (ten sam wiersz, status `withdrawn`; zwalnia miejsce); ponowienie: `replayed: true`. Trasa nie czyta ciała.',
        schema: withReplayed({ signup: ref('EventTaskSignup') }),
      },
    },
    errors: mergeErrors(GATE, EVENT_PATH, {
      403: ['invalid_origin'],
      404: ['event_task_signup_not_found'],
      409: ['school_year_closed'],
    }),
  },
};
