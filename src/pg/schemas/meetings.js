// Schematy OpenAPI dla modułu `meetings` (src/pg/routes/meetings.js → src/pg/meetings.js; #13, #81, #102, #113,
// #135, #150, #171, #215), #160 etap 7: zebrania (ogólne, zarządu, klasowe), porządek obrad z kolejnością
// i wycofaniem punktu, lista obecności, ustalenie quorum, protokoły z zatwierdzeniem i widocznością, uchwały
// z wersjami (edycja projektu, korekta rozstrzygnięcia, rejestr roku, wyszukanie po numerze, wykonanie),
// zawiadomienia z plikiem kalendarza i szkicem kampanii e-mail, odwołanie i zmiana terminu oraz trasy publiczne
// (protokoły i zawiadomienia). Pisane ręcznie na podstawie walidatorów i maperów wierszy w src/pg/meetings.js
// (`meetingFromRow`, `noticeFromRow`, `resolutionFromRow`, `registerRowToApi` …) i testów
// tests/pg-meeting*.test.js; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * `Idempotency-Key` (wymagany) mają: utworzenie zebrania, punkt porządku, ustalenie quorum, wersja protokołu,
//     widoczność protokołu, uchwała, korekta uchwały i zdarzenie wykonania uchwały (201 + `Idempotency-Replayed:
//     false`, ponowienie 200 + `true`); szkic zawiadomienia i szkic kampanii z zawiadomienia NIE mają klucza,
//     ale odpowiadają tak samo (201/`false`, ponowienie rozpoznane po stanie — 200/`true`);
//   * zatwierdzenie protokołu, odwołanie, zmiana terminu, wycofanie punktu, zmiana kolejności i zatwierdzenie
//     zawiadomienia zwracają zawsze 200 BEZ nagłówka, a ponowienie sygnalizuje pole `replayed` w treści;
//     `PATCH` zebrania i uchwały oraz zapis obecności — 200 bez nagłówka i bez `replayed` (ta sama edycja
//     jeszcze raz = odtworzenie bez błędu);
//   * `PATCH` zebrania i uchwały wymaga `revision` (= `revisionNo`, #215): brak → 400 `invalid_revision`,
//     niezgodność → 409 `revision_conflict`; odwołanie i zmiana terminu też;
//   * odmowy reguł bazy (triggery: blokada zebrania po zatwierdzeniu protokołu, odwołanie, quorum, uchwały)
//     przechodzą jako 409 z kodem reguły (`DATABASE_CONFLICTS` w src/pg/meetings.js);
//   * zebranie poza zakresem: odczyt → 404 `meeting_not_found` (jak brak zebrania, SR-07), zapis → 403 `forbidden`;
//   * przedstawiciel-gospodarz zebrania klasowego (flaga `MEETINGS_CLASS_HOST`, #171) dostaje węższy widok:
//     bez powodu odwołania i kto odwołał, bez powodów i autorów zmian terminu, bez kampanii i autorów zawiadomień
//     (pola są wtedy null — schemat ich nie usuwa);
//   * żadna trasa nie wysyła wiadomości: z zawiadomienia powstaje wyłącznie SZKIC kampanii (`sent: false`);
//   * listy zebrań i publicznych zawiadomień mają kursor (`limit`, `cursor` → `nextCursor`, `truncated`);
//     listy protokołów udostępnionych i publicznych obcinają do 200 z `truncated`, rejestr uchwał — bez limitu.
import { PII_ERRORS, mergeErrors, nullable, ref, replayed, requestObject, strictObject } from './common.js';

export const name = 'meetings';

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const nullableId = (description) => nullable(description ? { ...ref('EntityId'), description } : ref('EntityId'));
const nullableTime = (description) => nullable(description ? { ...ref('IsoDateTime'), description } : ref('IsoDateTime'));
const nullableString = (description) => nullable(description ? { type: 'string', description } : STRING);
const nullableInt = (min, description) => nullable({ type: 'integer', minimum: min, ...(description ? { description } : {}) });

const KINDS = ['plenary', 'board', 'class'];
const STATUSES = ['draft', 'scheduled', 'held', 'archived', 'cancelled'];
const QUORUM_MODES = ['not_configured', 'fraction', 'minimum_count'];
const CAPACITIES = ['representative', 'board_member', 'audit_member', 'principal', 'teacher', 'guardian', 'guest', 'other'];
const VISIBILITIES = ['internal', 'parents', 'public'];
const RESOLUTION_STATUSES = ['draft', 'adopted', 'rejected', 'withdrawn'];
const EXECUTION_STATUSES = ['not_started', 'in_progress', 'done', 'will_not_be_done'];
const NOTICE_KINDS = ['invitation', 'update', 'reschedule', 'cancellation'];
const CHECKLIST_CODES = [
  'meeting_not_held', 'open_resolutions', 'quorum_rule_missing', 'quorum_rule_source_missing', 'no_quorum_check',
  'stale_quorum_check', 'resolutions_on_stale_check',
];

const PAGE = {
  nextCursor: nullable({ type: 'string', description: 'Nieprzezroczysty kursor następnej strony; null na ostatniej stronie.' }),
  truncated: { type: 'boolean', description: 'true wtedy i tylko wtedy, gdy `nextCursor` nie jest null (lista niepełna).' },
  limit: { type: 'integer', minimum: 1, description: 'Zastosowana wielkość strony.' },
};
const pageQuery = (max) => ({
  limit: { schema: { type: 'integer', minimum: 1, maximum: max, default: max } },
  cursor: { schema: STRING, description: '`nextCursor` z poprzedniej odpowiedzi tej samej trasy i roku (docs/API.md).' },
});
const YEAR_QUERY = { schoolYearId: { required: true, schema: ref('Id') } };

const TITLE = { type: 'string', minLength: 3, maxLength: 200, description: 'Tytuł zebrania (3-200 znaków po przycięciu spacji).' };
const SCHEDULED_AT = {
  ...ref('IsoDateTime'),
  description: 'Termin z jawną strefą (`Z` albo `±hh:mm`), do 40 znaków; odpowiedź zawsze w UTC.',
};
const REASON = {
  type: 'string', minLength: 3, maxLength: 500,
  description: 'Powód (3-500 znaków po przycięciu spacji); wewnętrzny, nie trafia do dziennika ani na stronę publiczną. '
    + 'Bramka danych osobowych (#152); inna długość → 400 `invalid_reason`.',
};
const REVISION = {
  type: 'integer', minimum: 1, maximum: 1000000000,
  description: '`revisionNo` widziany przez edytującego (#215); brak → 400 `invalid_revision`, niezgodny → 409 `revision_conflict`.',
};
const CONFIRM = {
  type: 'boolean',
  description: 'true potwierdza ostrzeżenie bramki danych osobowych (#152), np. 422 `possible_personal_data`.',
};
const VOTES = (description) => nullable({ type: 'integer', minimum: 0, maximum: 10000, ...(description ? { description } : {}) });

// Pola reguły quorum i reguły terminu zawiadomienia wspólne dla utworzenia i edycji zebrania.
const RULE_FIELDS = {
  quorumMode: { type: 'string', enum: QUORUM_MODES, description: 'Domyślnie `not_configured` (ustalenie quorum niemożliwe).' },
  quorumNumerator: nullable({ type: 'integer', minimum: 1, maximum: 1000, description: 'Licznik ułamka (tryb `fraction`).' }),
  quorumDenominator: nullable({ type: 'integer', minimum: 1, maximum: 1000, description: 'Mianownik ułamka (tryb `fraction`).' }),
  quorumInclusive: nullable({ type: 'boolean', description: 'true — „co najmniej”, false — „więcej niż” (tryb `fraction`).' }),
  quorumMinCount: nullable({ type: 'integer', minimum: 1, maximum: 10000, description: 'Minimalna liczba obecnych uprawnionych (tryb `minimum_count`).' }),
  votingBodySize: nullable({ type: 'integer', minimum: 1, maximum: 10000, description: 'Liczebność składu uprawnionego (wpisywana ręcznie, D-21); wymagana dla `fraction`.' }),
  quorumRuleSource: nullable({
    type: 'string', minLength: 3, maxLength: 200,
    description: 'Źródło reguły (np. paragraf regulaminu); obowiązkowe dla `fraction` i `minimum_count` (400 `quorum_rule_source_required`).',
  }),
  noticeMinDays: nullable({ type: 'integer', minimum: 0, maximum: 365, description: 'Minimalna liczba dni zawiadomienia (D-21); razem z `noticeRuleSource` albo żadne (400 `invalid_notice_rule`).' }),
  noticeRuleSource: nullable({ type: 'string', minLength: 3, maxLength: 200, description: 'Źródło reguły terminu zawiadomienia.' }),
};

const EMPTY_BODY = requestObject({}, [], {
  description: 'Bez pól: zapis wynika ze ścieżki. Ciało musi być poprawnym obiektem JSON (np. `{}`); puste ciało → 400 `invalid_json`.',
});

export const components = {
  MeetingKind: { type: 'string', enum: KINDS, description: '`plenary` — ogólne, `board` — zarządu, `class` — klasowe (wymaga `classId` z tego roku).' },
  MeetingStatus: {
    type: 'string', enum: STATUSES,
    description: 'draft → scheduled → held → archived; scheduled może wrócić do draft; draft i scheduled → cancelled (stan końcowy, tylko trasą odwołania).',
  },
  Meeting: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    kind: ref('MeetingKind'),
    classId: nullableId('Klasa zebrania klasowego; null dla zebrania ogólnego i zarządu.'),
    title: STRING,
    scheduledAt: ref('IsoDateTime'),
    location: nullableString(),
    status: ref('MeetingStatus'),
    revisionNo: { type: 'integer', minimum: 1, description: 'Wersja wiersza (#215); `PATCH`, odwołanie i zmiana terminu wymagają zgodnego `revision`.' },
    cancelledAt: nullableTime(),
    cancelledBy: nullableId('Kto odwołał; null także w widoku przedstawiciela-gospodarza (#171).'),
    cancellationReason: nullableString('Powód odwołania (wewnętrzny); null także w widoku przedstawiciela-gospodarza.'),
    noticeRule: strictObject({
      minDays: nullable({ type: 'integer', minimum: 0, maximum: 365 }),
      source: nullableString(),
    }, [], { description: 'Reguła terminu zawiadomienia (D-21); serwer tylko odnotowuje spóźnienie.' }),
    quorumRule: strictObject({
      mode: { type: 'string', enum: QUORUM_MODES },
      numerator: nullableInt(1),
      denominator: nullableInt(1),
      inclusive: nullable(BOOLEAN),
      minCount: nullableInt(1),
      votingBodySize: nullableInt(1),
      source: nullableString(),
    }, [], { description: 'Reguła quorum wpisana dla tego zebrania (aplikacja nie koduje regulaminu, D-21).' }),
  }),
  MeetingAgendaItem: strictObject({
    id: ref('EntityId'),
    meetingId: ref('EntityId'),
    position: { type: 'integer', minimum: 1, maximum: 200 },
    title: STRING,
    description: nullableString(),
    withdrawnAt: nullableTime('Wycofanie punktu (nieodwracalne; wiersz zostaje, #113).'),
  }),
  MeetingAgendaVersion: strictObject({
    id: ref('EntityId'),
    meetingId: ref('EntityId'),
    version: { type: 'integer', minimum: 1 },
    contentHash: ref('Sha256Hex'),
    items: {
      type: 'array',
      description: 'Niezmienna migawka niewycofanych punktów w kolejności pozycji.',
      items: strictObject({ position: { type: 'integer', minimum: 1, maximum: 200 }, title: STRING, description: nullableString() }),
    },
    createdAt: ref('IsoDateTime'),
    createdBy: ref('EntityId'),
  }),
  MeetingReschedule: strictObject({
    id: ref('EntityId'),
    meetingId: ref('EntityId'),
    fromScheduledAt: ref('IsoDateTime'),
    toScheduledAt: ref('IsoDateTime'),
    reason: nullableString('Powód zmiany; null w widoku przedstawiciela-gospodarza.'),
    actorId: nullableId('Kto zmienił; null w widoku przedstawiciela-gospodarza.'),
    createdAt: ref('IsoDateTime'),
  }),
  MeetingNotice: strictObject({
    id: ref('EntityId'),
    meetingId: ref('EntityId'),
    version: { type: 'integer', minimum: 1 },
    kind: { type: 'string', enum: NOTICE_KINDS, description: '`reschedule` i `cancellation` powstają automatycznie jako szkic po zatwierdzonym zawiadomieniu.' },
    title: STRING,
    scheduledAt: ref('IsoDateTime'),
    previousScheduledAt: nullableTime('Poprzedni termin (tylko `reschedule`).'),
    location: nullableString(),
    agendaVersionId: nullableId('Wersja porządku obrad (null dla `cancellation`).'),
    contentHash: ref('Sha256Hex'),
    status: { type: 'string', enum: ['draft', 'approved'] },
    createdAt: ref('IsoDateTime'),
    approvedAt: nullableTime(),
    noticeDaysBefore: nullable({ type: 'integer', description: 'Dni od zatwierdzenia do terminu (odnotowanie przy zatwierdzeniu).' }),
    noticeLate: nullable({ type: 'boolean', description: 'true, gdy zatwierdzono później niż `noticeRule.minDays` (tylko odnotowanie).' }),
    isLatest: { type: 'boolean', description: 'Najnowsza wersja zawiadomienia zebrania.' },
    outdated: { type: 'boolean', description: 'true: tytuł, termin, miejsce albo porządek obrad zmieniły się po sporządzeniu tej wersji.' },
    campaignId: nullableId('Szkic kampanii e-mail z tej wersji; null w widoku przedstawiciela-gospodarza.'),
    createdBy: nullableId('null w widoku przedstawiciela-gospodarza.'),
    approvedBy: nullableId('null w widoku przedstawiciela-gospodarza.'),
  }),
  MeetingAttendee: strictObject({
    id: ref('EntityId'),
    meetingId: ref('EntityId'),
    userId: nullableId('Konto (dokładnie jedno z `userId` i `guardianId`).'),
    guardianId: nullableId('Opiekun (dokładnie jedno z `userId` i `guardianId`).'),
    capacity: { type: 'string', enum: CAPACITIES },
    votingEligible: BOOLEAN,
    present: BOOLEAN,
  }, [], { description: 'Wpis listy obecności: wyłącznie identyfikatory i funkcja, bez imion, nazwisk i adresów.' }),
  MeetingQuorumCheck: strictObject({
    id: ref('EntityId'),
    meetingId: ref('EntityId'),
    mode: { type: 'string', enum: ['fraction', 'minimum_count'] },
    numerator: nullableInt(1),
    denominator: nullableInt(1),
    inclusive: nullable(BOOLEAN),
    minCount: nullableInt(1),
    votingBodySize: nullableInt(1),
    presentEligible: { ...ref('Count'), description: 'Obecni z prawem głosu w chwili ustalenia.' },
    requiredCount: { type: 'integer', minimum: 1 },
    met: BOOLEAN,
    determinedAt: ref('IsoDateTime'),
    current: { type: 'boolean', description: 'false: lista obecności zmieniła się po ustaleniu (#81) — nie może być podstawą nowego rozstrzygnięcia.' },
  }, [], { description: 'Niezmienna migawka ustalenia quorum (ponowne ustalenie = nowy wpis).' }),
  MeetingMinutes: strictObject({
    id: ref('EntityId'),
    meetingId: ref('EntityId'),
    version: { type: 'integer', minimum: 1 },
    supersedesId: nullableId('Poprzednia wersja.'),
    body: STRING,
    changeNote: nullableString(),
    status: { type: 'string', enum: ['draft', 'approved'] },
    approvedAt: nullableTime(),
    approvalNote: nullableString(),
    visibility: { type: 'string', enum: VISIBILITIES, description: 'Nowa wersja i wersja zatwierdzona startują jako `internal`.' },
  }),
  MeetingResolutionStatus: { type: 'string', enum: RESOLUTION_STATUSES },
  MeetingResolution: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    meetingId: ref('EntityId'),
    number: nullableString('Numer nadany przez sekretarza (D-15); obowiązkowy dla przyjętej.'),
    revision: { type: 'integer', minimum: 1, description: 'Rewizja w łańcuchu korekt (korekta = nowy wiersz z `revision` + 1).' },
    revisionNo: {
      type: 'integer', minimum: 1,
      description: 'Wersja wiersza do edycji projektu (#215), osobna od `revision`. Brak w wyszukaniu po numerze '
        + '(`…/resolutions/lookup` czyta widok `resolution_current`, który tej kolumny nie ma).',
    },
    correctsId: nullableId('Poprawiana rewizja.'),
    correctionReason: nullableString(),
    amendsResolutionId: nullableId('Uchwała zmieniana albo uchylana (#102).'),
    relationKind: nullable({ type: 'string', enum: ['amends', 'repeals'] }),
    relationCrossYear: BOOLEAN,
    title: STRING,
    body: STRING,
    status: ref('MeetingResolutionStatus'),
    votesFor: VOTES(),
    votesAgainst: VOTES(),
    votesAbstain: VOTES(),
    quorumCheckId: nullableId('Ustalenie quorum, na którym oparto rozstrzygnięcie.'),
    decidedAt: nullableTime(),
    effectiveStatus: {
      type: 'string', enum: ['in_force', 'amended', 'repealed'],
      description: 'Status obowiązywania (tylko w wyszukaniu po numerze).',
    },
  }, ['revisionNo', 'effectiveStatus']),
  MeetingView: strictObject({
    meeting: ref('Meeting'),
    agenda: { type: 'array', items: ref('MeetingAgendaItem'), description: 'Wszystkie punkty (także wycofane) w kolejności pozycji.' },
    attendees: { type: 'array', items: ref('MeetingAttendee') },
    quorumChecks: { type: 'array', items: ref('MeetingQuorumCheck') },
    minutes: { type: 'array', items: ref('MeetingMinutes'), description: 'Wszystkie wersje protokołu, także projekty.' },
    resolutions: { type: 'array', items: ref('MeetingResolution'), description: 'Wszystkie rewizje uchwał zebrania.' },
    agendaVersions: { type: 'array', items: ref('MeetingAgendaVersion') },
    reschedules: { type: 'array', items: ref('MeetingReschedule') },
    notices: { type: 'array', items: ref('MeetingNotice') },
  }),
  MeetingApprovalChecklist: strictObject({
    meetingId: ref('EntityId'),
    minutesId: nullableId('Najnowsza wersja protokołu.'),
    minutesStatus: nullable({ type: 'string', enum: ['draft', 'approved'] }),
    ready: { type: 'boolean', description: 'false, gdy którakolwiek pozycja blokuje (serwer i tak odrzuci zatwierdzenie).' },
    items: {
      type: 'array',
      description: 'Wyłącznie kody i liczby, bez tytułów i treści uchwał.',
      items: strictObject({
        code: { type: 'string', enum: CHECKLIST_CODES },
        blocking: BOOLEAN,
        count: { type: 'integer', minimum: 1 },
      }, ['count']),
    },
  }, [], { description: 'Lista kontrolna przed zatwierdzeniem protokołu (#81); tylko odczyt, bez wpisu w dzienniku.' }),
  MeetingSharedMinutes: strictObject({
    minutesId: ref('EntityId'),
    meetingId: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    kind: ref('MeetingKind'),
    classId: nullableId(),
    title: STRING,
    scheduledAt: ref('IsoDateTime'),
    version: { type: 'integer', minimum: 1 },
    approvedAt: ref('IsoDateTime'),
    visibility: { type: 'string', enum: ['parents', 'public'] },
    body: STRING,
  }, [], { description: 'Najnowsza zatwierdzona wersja protokołu udostępniona rodzicom albo publicznie.' }),
  MeetingPublicNotice: strictObject({
    id: ref('EntityId'),
    kind: { type: 'string', enum: NOTICE_KINDS },
    cancelled: { type: 'boolean', description: 'true dla zawiadomienia o odwołaniu.' },
    title: STRING,
    scheduledAt: ref('IsoDateTime'),
    previousScheduledAt: nullableTime(),
    location: nullableString(),
    agenda: {
      type: 'array', description: 'Tytuły punktów bez opisów (pusta lista przy odwołaniu).',
      items: strictObject({ position: { type: 'integer', minimum: 1, maximum: 200 }, title: STRING }),
    },
    approvedAt: ref('IsoDateTime'),
  }, [], { description: 'Najnowsze zatwierdzone zawiadomienie zebrania ogólnego (bez powodów i opisów punktów).' }),
  MeetingResolutionRegisterEntry: strictObject({
    id: ref('EntityId'),
    number: nullableString(),
    title: STRING,
    status: ref('MeetingResolutionStatus'),
    effectiveStatus: {
      type: 'string', enum: ['in_force', 'amended', 'repealed', 'draft', 'rejected', 'withdrawn'],
      description: 'Uchwała przyjęta: `in_force`, `amended` albo `repealed` (widok `resolution_effective_status`); '
        + 'pozostałe — kopia `status` (projekt, odrzucona, wycofana).',
    },
    revision: { type: 'integer', minimum: 1 },
    votesFor: VOTES(),
    votesAgainst: VOTES(),
    votesAbstain: VOTES(),
    decidedAt: nullableTime(),
    meetingId: ref('EntityId'),
    meetingTitle: STRING,
    meetingScheduledAt: ref('IsoDateTime'),
    amendsResolutionId: nullableId(),
    relationKind: nullable({ type: 'string', enum: ['amends', 'repeals'] }),
    relationCrossYear: BOOLEAN,
    amendedBy: nullable(strictObject({ id: ref('EntityId'), number: nullableString() })),
    repealedBy: nullable(strictObject({ id: ref('EntityId'), number: nullableString() })),
    execution: strictObject({
      status: nullable({ type: 'string', enum: EXECUTION_STATUSES }),
      dueOn: nullable(ref('IsoDate')),
      responsibleUserId: nullableId(),
      recordedAt: nullableTime(),
    }, [], { description: 'Bieżący stan wykonania (najnowsze zdarzenie); same null bez zdarzeń.' }),
  }, [], { description: 'Bieżąca rewizja uchwały w rejestrze roku (#102).' }),
  MeetingResolutionExecution: strictObject({
    id: ref('EntityId'),
    resolutionId: ref('EntityId'),
    status: { type: 'string', enum: EXECUTION_STATUSES },
    responsibleUserId: nullableId('Konto odpowiedzialne (nie opiekun ani nazwisko w tekście).'),
    dueOn: nullable(ref('IsoDate')),
    note: nullableString(),
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
  }, [], { description: 'Zdarzenie wykonania uchwały (tylko dopisywanie; korekta = nowe zdarzenie).' }),

  // ---------- żądania ----------
  MeetingCreateRequest: requestObject({
    schoolYearId: ref('Id'),
    kind: ref('MeetingKind'),
    classId: nullable({ ...ref('Id'), description: 'Wymagane wtedy i tylko wtedy, gdy `kind` = `class`.' }),
    title: TITLE,
    scheduledAt: SCHEDULED_AT,
    location: nullable({ type: 'string', minLength: 1, maxLength: 200 }),
    status: { type: 'string', enum: ['draft', 'scheduled'], default: 'draft' },
    ...RULE_FIELDS,
  }, ['schoolYearId', 'kind', 'title', 'scheduledAt'], { description: 'Nowe zebranie (szkic albo zaplanowane).' }),
  MeetingUpdateRequest: requestObject({
    revision: REVISION,
    title: TITLE,
    scheduledAt: { ...SCHEDULED_AT, description: 'Po zatwierdzonym zawiadomieniu zmiana terminu tylko przez `…/reschedule` (409 `use_reschedule_endpoint`).' },
    location: nullable({ type: 'string', minLength: 1, maxLength: 200 }),
    status: { type: 'string', enum: ['draft', 'scheduled', 'held', 'archived'], description: 'Odwołanie wyłącznie trasą `…/cancellation`.' },
    ...RULE_FIELDS,
  }, ['revision'], {
    description: 'Zmiana danych zebrania: pola pominięte bez zmian; reguła quorum scalana z zapisaną (jawne null czyści pole). '
      + 'Co najmniej jedno pole poza `revision`.',
  }),
  MeetingAgendaItemRequest: requestObject({
    title: { type: 'string', minLength: 3, maxLength: 300 },
    description: nullable({ type: 'string', minLength: 1, maxLength: 2000, description: 'Bramka danych osobowych (#152).' }),
    position: nullable({ type: 'integer', minimum: 1, maximum: 200, description: 'Pominięte = na końcu porządku.' }),
    confirmPersonalData: CONFIRM,
  }, ['title']),
  MeetingAgendaOrderRequest: requestObject({
    itemIds: {
      type: 'array', minItems: 1, maxItems: 200, items: ref('Id'),
      description: 'Dokładnie wszystkie niewycofane punkty w nowej kolejności, każdy raz (inaczej 400 `invalid_agenda_order`).',
    },
  }, ['itemIds']),
  MeetingCancellationRequest: requestObject({
    reason: REASON, revision: REVISION, confirmPersonalData: CONFIRM,
  }, ['reason', 'revision'], { description: 'Odwołanie zebrania `draft` albo `scheduled` (stan końcowy).' }),
  MeetingRescheduleRequest: requestObject({
    scheduledAt: SCHEDULED_AT, reason: REASON, revision: REVISION, confirmPersonalData: CONFIRM,
  }, ['scheduledAt', 'reason', 'revision'], { description: 'Nowy termin z powodem (zebranie `draft` albo `scheduled`).' }),
  MeetingEmptyRequest: EMPTY_BODY,
  MeetingAttendanceRequest: requestObject({
    userId: nullable({ ...ref('Id'), description: 'Konto z aktywnym przydziałem w roku zebrania.' }),
    guardianId: nullable({ ...ref('Id'), description: 'Opiekun z aktywną relacją z uczniem klasy zebrania (klasowe) albo roku.' }),
    capacity: { type: 'string', enum: CAPACITIES },
    votingEligible: { type: 'boolean', description: 'Prawo głosu wpisywane jawnie (bez wartości domyślnej).' },
    present: BOOLEAN,
  }, ['capacity', 'votingEligible', 'present'], {
    description: 'Wpis albo poprawka obecności (po odniesieniu do osoby). Dokładnie jedno z `userId` i `guardianId`; '
      + 'odniesienie spoza zakresu i nieistniejące → 400 `invalid_reference` (#205).',
  }),
  MeetingMinutesRequest: requestObject({
    body: { type: 'string', minLength: 10, maxLength: 200000, description: 'Treść wersji (bramka danych osobowych, #152).' },
    changeNote: nullable({ type: 'string', minLength: 3, maxLength: 500 }),
    confirmPersonalData: CONFIRM,
  }, ['body'], { description: 'Nowa, niezmienna wersja protokołu (projekt).' }),
  MeetingMinutesApprovalRequest: requestObject({
    approvalNote: nullable({ type: 'string', minLength: 3, maxLength: 500 }),
    confirmPersonalData: CONFIRM,
  }, [], { description: 'Zatwierdzenie najnowszej wersji przez inną osobę niż autor (MFA).' }),
  MeetingMinutesVisibilityRequest: requestObject({
    visibility: { type: 'string', enum: VISIBILITIES },
    reason: nullable({ type: 'string', minLength: 3, maxLength: 500 }),
    confirmPersonalData: CONFIRM,
  }, ['visibility'], { description: 'Widoczność zatwierdzonej wersji (nowy zapis); `public` blokowane przy możliwych danych osobowych w treści.' }),
  MeetingResolutionCreateRequest: requestObject({
    title: { type: 'string', minLength: 3, maxLength: 300 },
    body: { type: 'string', minLength: 3, maxLength: 20000, description: 'Bramka danych osobowych (#152).' },
    number: nullable({ type: 'string', minLength: 3, maxLength: 64, description: 'Wymagany dla `adopted` (400 `resolution_number_required`).' }),
    status: { ...ref('MeetingResolutionStatus'), default: 'draft' },
    votesFor: VOTES('Rozstrzygnięcie wymaga wszystkich trzech liczb i `quorumCheckId` (400 `vote_record_required`).'),
    votesAgainst: VOTES(),
    votesAbstain: VOTES(),
    quorumCheckId: nullable(ref('Id')),
    amendsResolutionId: nullable({ ...ref('Id'), description: 'Bieżąca rewizja przyjętej uchwały; wymaga `relationKind`.' }),
    relationKind: nullable({ type: 'string', enum: ['amends', 'repeals'] }),
    relationCrossYear: { type: 'boolean', description: 'Jawna zgoda na uchwałę z innego roku.' },
    confirmPersonalData: CONFIRM,
  }, ['title', 'body']),
  MeetingResolutionUpdateRequest: requestObject({
    revision: REVISION,
    number: nullable({ type: 'string', minLength: 3, maxLength: 64 }),
    title: { type: 'string', minLength: 3, maxLength: 300 },
    body: { type: 'string', minLength: 3, maxLength: 20000 },
    status: ref('MeetingResolutionStatus'),
    votesFor: VOTES(),
    votesAgainst: VOTES(),
    votesAbstain: VOTES(),
    quorumCheckId: nullable(ref('Id')),
    confirmPersonalData: CONFIRM,
  }, ['revision'], { description: 'Edycja projektu albo zapis rozstrzygnięcia (`adopted`, `rejected`) lub wycofania (`withdrawn`).' }),
  MeetingResolutionCorrectionRequest: requestObject({
    reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Powód korekty (bramka danych osobowych).' },
    status: { type: 'string', enum: ['adopted', 'rejected'], description: 'Pominięte = status poprawianej rewizji.' },
    title: { type: 'string', minLength: 3, maxLength: 300 },
    body: { type: 'string', minLength: 3, maxLength: 20000 },
    votesFor: VOTES(),
    votesAgainst: VOTES(),
    votesAbstain: VOTES(),
    quorumCheckId: nullable(ref('Id')),
    confirmPersonalData: CONFIRM,
  }, ['reason'], { description: 'Korekta zapisu rozstrzygniętej uchwały jako nowa rewizja z tym samym numerem (tylko przed zatwierdzeniem protokołu).' }),
  MeetingResolutionExecutionRequest: requestObject({
    status: { type: 'string', enum: EXECUTION_STATUSES },
    responsibleUserId: nullable(ref('Id')),
    dueOn: nullable(ref('IsoDate')),
    note: nullable({ type: 'string', minLength: 3, maxLength: 500, description: 'Bramka danych osobowych (#152).' }),
    confirmPersonalData: CONFIRM,
  }, ['status']),
};

// ---------- kody błędów ----------

const GATE = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
const READ = mergeErrors(GATE, { 400: ['invalid_request'] });
const LIST = { 400: ['invalid_cursor', 'invalid_limit'] };
const WRITE = mergeErrors(GATE, {
  400: ['invalid_json', 'invalid_request'],
  403: ['invalid_origin'],
  409: ['school_year_closed'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
});
const KEYED = { 400: ['invalid_idempotency_key'], 409: ['idempotency_conflict'] };
const MEETING_PATH = { 400: ['invalid_meeting_id'], 404: ['meeting_not_found'] };
const MEETING_WRITE = mergeErrors(WRITE, MEETING_PATH, { 409: ['meeting_cancelled', 'meeting_locked'] });
const RULE_ERRORS = { 400: ['invalid_notice_rule', 'invalid_quorum_rule', 'quorum_rule_source_required'] };
const RESOLUTION_PATH = { 400: ['invalid_resolution_id'], 404: ['resolution_not_found'] };
const DECISION_ERRORS = {
  400: ['invalid_reference', 'resolution_number_required', 'vote_record_required'],
  409: [
    'resolution_number_taken', 'resolution_quorum_check_required', 'resolution_quorum_check_stale',
    'resolution_requires_held_meeting', 'resolution_votes_exceed_present_voters',
  ],
};
const NOTICE_PATH = { 400: ['invalid_notice_id'], 404: ['notice_not_found'] };
const NOTICE_CURRENT = { 409: ['meeting_not_scheduled', 'notice_not_latest', 'notice_outdated', 'notice_requires_agenda'] };
const MINUTES_PATH = { 400: ['invalid_minutes_id'], 404: ['minutes_not_found'] };

const meetingOnly = strictObject({ meeting: ref('Meeting') });
const noticeOnly = strictObject({ notice: ref('MeetingNotice') });
const minutesOnly = strictObject({ minutes: ref('MeetingMinutes') });
const resolutionOnly = strictObject({ resolution: ref('MeetingResolution') });
const withReplayed = (properties, description) => strictObject({
  ...properties,
  replayed: { type: 'boolean', description: description ?? 'true: ponowienie rozpoznane po stanie obiektu (bez nowego zapisu i zdarzenia).' },
});
const keyed = (createdText, schema) => ({
  201: replayed('false', createdText, schema),
  200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji (bez nowego zapisu).', schema),
});

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/meetings': {
    query: { ...YEAR_QUERY, ...pageQuery(500) },
    responses: {
      200: {
        description: 'Zebrania roku od najpóźniejszego terminu (kursor keyset, #159). Przydział klasowy widzi tylko swoją klasę; '
          + 'strona może być krótsza niż `limit` — o kolejnych decyduje wyłącznie `nextCursor`.',
        schema: strictObject({ meetings: { type: 'array', items: ref('Meeting') }, ...PAGE }),
      },
    },
    errors: mergeErrors(READ, LIST),
  },
  'POST /api/meetings': {
    idempotencyKey: true,
    body: ref('MeetingCreateRequest'),
    responses: keyed('Zebranie utworzone (szkic albo zaplanowane; nic nie jest wysyłane).', meetingOnly),
    errors: mergeErrors(WRITE, KEYED, RULE_ERRORS, { 400: ['invalid_reference'] }),
  },
  'GET /api/meetings/shared-minutes': {
    query: YEAR_QUERY,
    responses: {
      200: {
        description: 'Zatwierdzone protokoły udostępnione rodzicom albo publicznie (przedstawiciel: zebrania ogólne i zarządu oraz '
          + 'własnych klas). Najwyżej 200 pozycji, `truncated` sygnalizuje obcięcie.',
        schema: strictObject({ minutes: { type: 'array', items: ref('MeetingSharedMinutes') }, truncated: BOOLEAN }),
      },
    },
    errors: READ,
  },
  'GET /api/meetings/public-minutes': {
    query: YEAR_QUERY,
    responses: {
      200: {
        description: 'Publiczne: zatwierdzone protokoły z widocznością `public` (bez logowania). Najwyżej 200 pozycji.',
        schema: strictObject({ minutes: { type: 'array', items: ref('MeetingSharedMinutes') }, truncated: BOOLEAN }),
      },
    },
    errors: { 400: ['invalid_request'] },
  },
  'GET /api/meetings/public-notices': {
    query: { ...YEAR_QUERY, ...pageQuery(200) },
    responses: {
      200: {
        description: 'Publiczne: najnowsze zatwierdzone zawiadomienia zebrań ogólnych (bez logowania), od najbliższego terminu, kursor keyset.',
        schema: strictObject({ notices: { type: 'array', items: ref('MeetingPublicNotice') }, ...PAGE }),
      },
    },
    errors: mergeErrors({ 400: ['invalid_request'] }, LIST),
  },
  'GET /api/meetings/resolutions/lookup': {
    query: {
      ...YEAR_QUERY,
      number: { required: true, schema: { type: 'string', minLength: 3, maxLength: 64 }, description: 'Dokładny numer uchwały.' },
    },
    responses: {
      200: {
        description: 'Bieżąca rewizja przyjętej uchwały o tym numerze (z `effectiveStatus`) — sprawdzenie przy wydatku > 3000 EUR.',
        schema: resolutionOnly,
      },
    },
    errors: mergeErrors(READ, { 404: ['resolution_not_found'] }),
  },
  'GET /api/meetings/resolutions': {
    query: {
      ...YEAR_QUERY,
      status: { schema: ref('MeetingResolutionStatus') },
      q: { schema: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Fragment tytułu albo numeru.' },
      executionStatus: { schema: { type: 'string', enum: [...EXECUTION_STATUSES, 'none'] }, description: '`none` — bez zdarzenia wykonania.' },
    },
    responses: {
      200: {
        description: 'Rejestr uchwał roku (bieżące rewizje, bez stronicowania); przydział klasowy widzi tylko uchwały zebrań swojej klasy.',
        schema: strictObject({ resolutions: { type: 'array', items: ref('MeetingResolutionRegisterEntry') } }),
      },
    },
    errors: READ,
  },
  'POST /api/meetings/resolutions/{resolutionId}/execution': {
    idempotencyKey: true,
    body: ref('MeetingResolutionExecutionRequest'),
    responses: keyed('Zdarzenie wykonania uchwały (dozwolone także po zatwierdzeniu protokołu).',
      strictObject({ execution: ref('MeetingResolutionExecution') })),
    errors: mergeErrors(WRITE, KEYED, RESOLUTION_PATH, PII_ERRORS, {
      400: ['invalid_execution_status', 'invalid_reference'],
      409: ['resolution_not_decided'],
    }),
  },
  'GET /api/meetings/{meetingId}': {
    responses: {
      200: {
        description: 'Zebranie z porządkiem, obecnością, quorum, protokołami (także projektami), uchwałami, wersjami porządku, '
          + 'zmianami terminu i zawiadomieniami — z jednej migawki odczytu.',
        schema: ref('MeetingView'),
      },
    },
    errors: mergeErrors(READ, MEETING_PATH),
  },
  'GET /api/meetings/{meetingId}/approval-checklist': {
    responses: { 200: { description: 'Lista kontrolna przed zatwierdzeniem protokołu (#81).', schema: ref('MeetingApprovalChecklist') } },
    errors: mergeErrors(READ, MEETING_PATH),
  },
  'PATCH /api/meetings/{meetingId}': {
    body: ref('MeetingUpdateRequest'),
    responses: {
      200: {
        description: 'Zebranie po zmianie; ta sama edycja jeszcze raz = odtworzenie bez błędu i bez nowego zdarzenia (bez nagłówka).',
        schema: meetingOnly,
      },
    },
    errors: mergeErrors(MEETING_WRITE, RULE_ERRORS, {
      400: ['invalid_revision'],
      409: [
        'meeting_archive_requires_approved_minutes', 'meeting_status_transition_invalid', 'revision_conflict', 'use_reschedule_endpoint',
      ],
    }),
  },
  'POST /api/meetings/{meetingId}/agenda-items': {
    idempotencyKey: true,
    body: ref('MeetingAgendaItemRequest'),
    responses: keyed('Punkt porządku obrad.', strictObject({ agendaItem: ref('MeetingAgendaItem') })),
    errors: mergeErrors(MEETING_WRITE, KEYED, PII_ERRORS, { 409: ['agenda_position_taken'] }),
  },
  'POST /api/meetings/{meetingId}/cancellation': {
    body: ref('MeetingCancellationRequest'),
    responses: {
      200: {
        description: 'Zebranie odwołane; po zatwierdzonym zawiadomieniu powstaje SZKIC zawiadomienia o odwołaniu (nic nie jest wysyłane). '
          + 'Ponowienie z tym samym powodem: `replayed: true`, bez drugiego zdarzenia.',
        schema: withReplayed({ meeting: ref('Meeting'), cancellationNotice: nullable(ref('MeetingNotice')) }),
      },
    },
    errors: mergeErrors(MEETING_WRITE, PII_ERRORS, {
      400: ['invalid_reason', 'invalid_revision'],
      409: ['meeting_status_transition_invalid', 'revision_conflict'],
    }),
  },
  'POST /api/meetings/{meetingId}/reschedule': {
    body: ref('MeetingRescheduleRequest'),
    responses: {
      200: {
        description: 'Nowy termin z powodem (wpis w historii zmian); po zatwierdzonym zawiadomieniu — SZKIC zawiadomienia o zmianie terminu. '
          + 'Ponowienie z tym samym terminem i powodem: `replayed: true`.',
        schema: withReplayed({ meeting: ref('Meeting'), rescheduleNotice: nullable(ref('MeetingNotice')) }),
      },
    },
    errors: mergeErrors(MEETING_WRITE, PII_ERRORS, {
      400: ['invalid_reason', 'invalid_revision'],
      409: ['meeting_not_reschedulable', 'reschedule_no_change', 'revision_conflict'],
    }),
  },
  'POST /api/meetings/{meetingId}/agenda-items/{itemId}/withdrawal': {
    body: ref('MeetingEmptyRequest'),
    responses: {
      200: {
        description: 'Punkt wycofany (wiersz zostaje, nieodwracalnie); ponowienie: `replayed: true`.',
        schema: withReplayed({ agendaItem: ref('MeetingAgendaItem') }),
      },
    },
    errors: mergeErrors(MEETING_WRITE, { 400: ['invalid_agenda_item_id'], 404: ['agenda_item_not_found'] }),
  },
  'POST /api/meetings/{meetingId}/agenda-order': {
    body: ref('MeetingAgendaOrderRequest'),
    responses: {
      200: {
        description: 'Porządek po zmianie kolejności (te same numery pozycji, nowa kolejność; wycofane zachowują numery). '
          + 'Ta sama kolejność: `replayed: true` bez zdarzenia. Zatwierdzone zawiadomienie staje się nieaktualne.',
        schema: withReplayed({ agenda: { type: 'array', items: ref('MeetingAgendaItem') } }),
      },
    },
    errors: mergeErrors(MEETING_WRITE, { 400: ['invalid_agenda_order'], 409: ['agenda_position_taken'] }),
  },
  'POST /api/meetings/{meetingId}/notices': {
    body: ref('MeetingEmptyRequest'),
    responses: {
      201: replayed('false', 'Szkic zawiadomienia (nowa wersja z migawką porządku obrad; bez klucza idempotencji).', noticeOnly),
      200: replayed('true', 'Najnowszy szkic ma już tę samą treść: zwraca go bez nowej wersji.', noticeOnly),
    },
    errors: mergeErrors(MEETING_WRITE, { 409: ['meeting_notice_closed', 'notice_requires_agenda', 'notice_up_to_date'] }),
  },
  'POST /api/meetings/{meetingId}/notices/{noticeId}/approval': {
    body: ref('MeetingEmptyRequest'),
    responses: {
      200: {
        description: 'Zawiadomienie zatwierdzone przez inną osobę niż autor (niczego nie wysyła); ponowienie: `replayed: true`.',
        schema: withReplayed({ notice: ref('MeetingNotice') }),
      },
    },
    errors: mergeErrors(MEETING_WRITE, NOTICE_PATH, NOTICE_CURRENT, { 403: ['notice_four_eyes_required'] }),
  },
  'POST /api/meetings/{meetingId}/notices/{noticeId}/campaign-draft': {
    body: ref('MeetingEmptyRequest'),
    responses: {
      201: replayed('false', 'Szkic kampanii e-mail z zatwierdzonego zawiadomienia (wyłącznie szkic: bez migawki, zatwierdzenia i kolejki).',
        strictObject({
          campaign: strictObject({
            id: ref('EntityId'),
            status: ref('EmailCampaignStatus'),
            audience: ref('EmailAudience'),
            classId: nullableId('Klasa dla `class_households`.'),
          }),
          sent: { const: false, description: 'Przypomnienie: nic nie zostało wysłane ani zakolejkowane.' },
        })),
      200: replayed('true', 'Kampania z tego zawiadomienia już istnieje: zwraca ją (bieżący status) bez drugiego szkicu.',
        strictObject({
          campaign: strictObject({
            id: ref('EntityId'),
            status: ref('EmailCampaignStatus'),
            audience: ref('EmailAudience'),
            classId: nullableId(),
          }),
          sent: { const: false },
        })),
    },
    errors: mergeErrors(MEETING_WRITE, NOTICE_PATH, NOTICE_CURRENT, { 409: ['invalid_notice_content', 'notice_not_approved'] }),
  },
  'GET /api/meetings/{meetingId}/notices/{noticeId}/calendar': {
    responses: {
      200: {
        description: 'Plik iCalendar (RFC 5545, `METHOD:PUBLISH`) najnowszego zatwierdzonego zawiadomienia; `Cache-Control: private, no-store`.',
        contentType: 'text/calendar; charset=utf-8',
        schema: { type: 'string' },
      },
    },
    errors: mergeErrors(READ, MEETING_PATH, NOTICE_PATH, { 409: ['notice_calendar_unavailable'] }),
  },
  'POST /api/meetings/{meetingId}/attendance': {
    body: ref('MeetingAttendanceRequest'),
    responses: {
      200: {
        description: 'Wpis albo poprawka obecności (naturalnie idempotentne po odniesieniu do osoby; bez nagłówka).',
        schema: strictObject({ attendee: ref('MeetingAttendee') }),
      },
    },
    errors: mergeErrors(MEETING_WRITE, { 400: ['invalid_reference'], 409: ['concurrent_version'] }),
  },
  'POST /api/meetings/{meetingId}/quorum-checks': {
    idempotencyKey: true,
    body: ref('MeetingEmptyRequest'),
    responses: keyed('Ustalenie quorum (migawka; ponowienie klucza po zmianie obecności → 409 `idempotency_conflict`).',
      strictObject({ quorumCheck: ref('MeetingQuorumCheck') })),
    errors: mergeErrors(MEETING_WRITE, KEYED, {
      409: ['quorum_attendance_exceeds_voting_body', 'quorum_requires_held_meeting', 'quorum_rule_not_configured'],
    }),
  },
  'POST /api/meetings/{meetingId}/minutes': {
    idempotencyKey: true,
    body: ref('MeetingMinutesRequest'),
    responses: keyed('Nowa wersja protokołu (projekt, widoczność `internal`).', minutesOnly),
    errors: mergeErrors(MEETING_WRITE, KEYED, PII_ERRORS, { 409: ['concurrent_version', 'minutes_require_held_meeting'] }),
  },
  'POST /api/meetings/{meetingId}/minutes/{minutesId}/approval': {
    body: ref('MeetingMinutesApprovalRequest'),
    responses: {
      200: {
        description: 'Protokół zatwierdzony (pierwsze zatwierdzenie blokuje zebranie); ponowienie dla zatwierdzonej wersji: `replayed: true`.',
        schema: withReplayed({ minutes: ref('MeetingMinutes') }),
      },
    },
    errors: mergeErrors(MEETING_WRITE, MINUTES_PATH, PII_ERRORS, {
      403: ['minutes_four_eyes_required'],
      409: ['minutes_not_latest_version', 'minutes_open_resolutions'],
    }),
  },
  'POST /api/meetings/{meetingId}/minutes/{minutesId}/visibility': {
    idempotencyKey: true,
    body: ref('MeetingMinutesVisibilityRequest'),
    responses: keyed('Nowy zapis widoczności zatwierdzonej wersji.', minutesOnly),
    errors: mergeErrors(MEETING_WRITE, KEYED, MINUTES_PATH, PII_ERRORS, {
      409: ['minutes_contain_personal_data', 'minutes_not_approved'],
    }),
  },
  'POST /api/meetings/{meetingId}/resolutions': {
    idempotencyKey: true,
    body: ref('MeetingResolutionCreateRequest'),
    responses: keyed('Uchwała (projekt albo rozstrzygnięcie) z podpowiedzią numeru.', strictObject({
      resolution: ref('MeetingResolution'),
      suggestedNumber: nullableString('Podpowiedź z wzorca roku (D-15); null bez wzorca. Nigdy nie zastępuje kontroli unikalności.'),
    })),
    errors: mergeErrors(MEETING_WRITE, KEYED, PII_ERRORS, DECISION_ERRORS, {
      400: ['invalid_relation_kind'],
      409: ['resolution_amends_cross_year_requires_flag', 'resolution_amends_requires_adopted'],
    }),
  },
  'PATCH /api/meetings/{meetingId}/resolutions/{resolutionId}': {
    body: ref('MeetingResolutionUpdateRequest'),
    responses: {
      200: {
        description: 'Uchwała po edycji projektu albo zapisie rozstrzygnięcia; ta sama edycja jeszcze raz = odtworzenie bez błędu.',
        schema: resolutionOnly,
      },
    },
    errors: mergeErrors(MEETING_WRITE, RESOLUTION_PATH, PII_ERRORS, DECISION_ERRORS, {
      400: ['invalid_revision'],
      409: ['resolution_final_immutable', 'revision_conflict'],
    }),
  },
  'POST /api/meetings/{meetingId}/resolutions/{resolutionId}/corrections': {
    idempotencyKey: true,
    body: ref('MeetingResolutionCorrectionRequest'),
    responses: keyed('Korekta zapisu: nowa rewizja z tym samym numerem i powodem.', resolutionOnly),
    errors: mergeErrors(MEETING_WRITE, KEYED, RESOLUTION_PATH, PII_ERRORS, DECISION_ERRORS, {
      409: ['concurrent_version', 'resolution_correction_mismatch'],
    }),
  },
};
