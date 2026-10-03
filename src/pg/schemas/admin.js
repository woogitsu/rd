// Schematy OpenAPI dla modułu `admin` (src/pg/routes/admin.js; #3, #4, #9, #78, #91, #100, #108, #133, #146, #149,
// #150, #152, #159, #176, #181, #184), #160 etap 12: konta (lista, wyłączenie, włączenie, wylogowanie, reset hasła i MFA),
// wnioski o reset kont chronionych i o nadanie roli chronionej (cztery oczy), przydziały ról i ich wygaszenie, zaproszenia
// (pojedyncze, ponowne wydanie, partie przedstawicieli z podglądem), lata szkolne i klasy, promocja uczniów z kopiowaniem
// klas i przedłużeniem przydziałów przedstawicieli, dziennik zdarzeń, dziennik odczytu danych rodzin, przegląd dostępu
// po kadencji, rejestr żądań osób (RODO) z eksportem i ograniczeniem przetwarzania, raport retencji, anonimizacja
// gospodarstwa i stan operacyjny. Pisane ręcznie na podstawie maperów w src/pg/routes/admin.js (`grantFromRow`,
// `invitationFromRow`, `dataRequestFromRow`, `auditEventForView`, `anonymizationRunFromRow`) i modułów pomocniczych
// (src/pg/grant-requests.js, account-recovery.js, invitation-batch.js, promotions.js, access-review.js,
// processing-restrictions.js, family-export.js, anonymization.js, ops-status.js) oraz testów tests/pg-admin*.test.js,
// tests/pg-grant-requests.test.js i tests/pg-access*.test.js; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * wyłącznie rola `admin` z potwierdzonym MFA, także odczyt (wariant zachowawczy D-08/D-09); inna rola → 403
//     `forbidden`, konto bez MFA → bramka routera (`mfa_enrollment_required`/`mfa_required`). Krok w górę MFA (#150,
//     `mfa_stale` po 15 min) mają: reset hasła i MFA, zatwierdzenie wniosków, nadanie roli, zaproszenie i jego ponowne
//     wydanie, partie zaproszeń (także podgląd), przedłużenie przydziałów przedstawicieli, eksport danych rodziny i
//     anonimizacja (także podgląd);
//   * rola chroniona (`admin`, `board`, `treasurer`) przy drugim aktywnym administratorze: nadanie, zaproszenie i ponowne
//     wydanie zaproszenia oraz reset hasła/MFA konta chronionego dają 202 i wniosek; wykonanie (przydział, zaproszenie
//     z tokenem, token resetu) powstaje przy zatwierdzeniu przez INNĄ osobę (nie wnioskodawcę i nie adresata);
//   * tokeny (zaproszenia, resetu hasła) wracają WYŁĄCZNIE w odpowiedzi, która je tworzy (pole `token`), jeden raz; listy,
//     odtworzenia i wnioski ich nie zawierają (baza ma tylko skrót);
//   * samonadanie roli → 409 `cannot_grant_self` (przydział, zaproszenie na własny adres, wiersz partii); przydział
//     i zaproszenie dyrekcji (`principal`) wymagają roku szkolnego (422 `school_year_required`), a przegląd dostępu pokazuje
//     dawne przydziały dyrekcji bez roku z propozycją `revoke` i powodem `year_scope_required`;
//   * moduł nie ma `Idempotency-Key` poza promocją uczniów, partią zaproszeń (wymagany, ponowienie: pole `replayed`, bez
//     nagłówka) i rejestracją żądania osoby (opcjonalny; nagłówek `Idempotency-Replayed` tylko przy kluczu). Pozostałe
//     zapisy są idempotentne po stanie (`changed: false`, `created: false`, istniejący otwarty wniosek);
//   * zły identyfikator w ścieżce → 400 `invalid_id` (po sprawdzeniu roli, przed odczytem obiektu).
import { PII_ERRORS, formatsResponse, mergeErrors, nullable, ref, requestObject, strictObject } from './common.js';

export const name = 'admin';

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const COUNT = ref('Count');
const nullableId = (description) => nullable(description ? { ...ref('EntityId'), description } : ref('EntityId'));
const nullableTime = (description) => nullable(description ? { ...ref('IsoDateTime'), description } : ref('IsoDateTime'));
const nullableString = (description) => nullable(description ? { type: 'string', description } : STRING);
const arrayOf = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
const PROTECTED_ROLE = { type: 'string', enum: ['admin', 'board', 'treasurer'], description: 'Rola chroniona (#146): nadanie wymaga drugiej osoby.' };
const TOKEN = {
  type: 'string', minLength: 32,
  description: 'Jednorazowy sekret zwracany WYŁĄCZNIE w tej odpowiedzi (baza ma tylko skrót). Operator przekazuje go osobnym, '
    + 'zaufanym kanałem; moduł nie wysyła e-maili (D-16/D-17).',
};
const LIST_PAGE = {
  nextCursor: nullable({ type: 'string', description: 'Kursor następnej strony; null na ostatniej.' }),
  truncated: { type: 'boolean', description: 'true wtedy i tylko wtedy, gdy `nextCursor` nie jest null (lista niekompletna).' },
  limit: { type: 'integer', minimum: 1, description: 'Zastosowana wielkość strony.' },
};
const limitQuery = (max, defaultValue = max) => ({ schema: { type: 'integer', minimum: 1, maximum: max, default: defaultValue } });
const CURSOR_QUERY = {
  schema: STRING,
  description: '`nextCursor` z poprzedniej strony tej samej trasy z tymi samymi filtrami (inny filtr → 400 `invalid_cursor`).',
};
const PLAN_DIGEST = { ...ref('Sha256Hex'), description: 'Skrót planu z podglądu; zmiana danych od podglądu → 409.' };
const CLASS_MAP = {
  type: 'object',
  additionalProperties: nullable(STRING),
  description: 'Jawna mapa klas (1-200 wpisów; pusta → 422 `class_map_required`): identyfikator klasy roku źródłowego → klasa roku docelowego (identyfikator; przy kopiowaniu klas — '
    + 'nazwa) albo null (klasa końcowa). Klasa spoza mapy nie jest przenoszona; serwer nie zgaduje następnika po nazwie.',
};
const PROMOTION_BASE = {
  fromSchoolYearId: ref('Id'),
  toSchoolYearId: { ...ref('Id'), description: 'Rok docelowy, późniejszy niż źródłowy (422 `invalid_year_order`), inny niż źródłowy.' },
  classMap: CLASS_MAP,
};
const DATA_REQUEST_KINDS = ['access', 'rectification', 'erasure', 'restriction', 'objection', 'portability'];
const DATA_REQUEST_STATUSES = ['received', 'identity_verified', 'in_progress', 'answered', 'rejected'];
const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'expired'];
const BATCH_ROW_ERRORS = [
  'invalid_row_format', 'invalid_email', 'class_not_found', 'duplicate_row', 'cannot_grant_self', 'invitation_pending',
  'representative_already_assigned',
];
const ACCESS_KINDS = ['class_students', 'household_card', 'print_cards', 'payment_list', 'class_roster_export', 'yearly_export', 'payment_export'];
const AUDIT_DOMAIN_NAMES = ['access', 'security', 'finance', 'email', 'documents', 'year_close', 'families', 'privacy', 'meetings', 'events', 'news'];
const PROMOTION_COUNTS = ['promote', 'graduating', 'unmapped', 'excluded', 'conflict', 'withdrawn'];
const countsObject = (keys, description) => strictObject(Object.fromEntries(keys.map((key) => [key, COUNT])), [], description ? { description } : {});
const backupStatus = (description) => strictObject({
  status: { type: 'string', enum: ['ok', 'attention', 'no_data'] },
  lastRun: nullable(strictObject({ result: STRING, finishedAt: ref('IsoDateTime') })),
}, [], { description });

export const components = {
  AdminUser: strictObject({
    id: ref('EntityId'),
    email: { type: 'string', description: 'Adres logowania — pokazywany wyłącznie administratorowi.' },
    displayName: nullableString('Nazwa wyświetlana konta.'),
    disabledAt: nullableTime('Wyłączenie konta; null — konto aktywne.'),
    createdAt: ref('IsoDateTime'),
    mfaEnrolled: { type: 'boolean', description: 'Konto ma potwierdzony, niewyłączony czynnik MFA.' },
    activeGrants: COUNT,
    activeSessions: COUNT,
  }, [], { description: 'Konto bez danych rodzin, skrótu hasła i sekretu MFA.' }),
  AdminGrant: strictObject({
    id: ref('EntityId'),
    userId: ref('EntityId'),
    role: ref('Role'),
    classId: nullableId('Klasa przydziału przedstawiciela; null — przydział bez klasy.'),
    schoolYearId: nullableId('Rok przydziału; null — przydział bez roku (dyrekcja: tylko dawne przydziały sprzed wymogu roku).'),
    expiresAt: nullableTime(),
    grantedAt: ref('IsoDateTime'),
    grantedBy: nullableId('Nadający (przy zatwierdzeniu wniosku — zatwierdzający); null — przydział sprzed modułu.'),
    revokedAt: nullableTime(),
    revokedBy: nullableId(),
    invitationId: nullableId('Zaproszenie, z którego powstał przydział.'),
    status: { type: 'string', enum: ['active', 'expired', 'revoked'] },
  }, [], { description: 'Przydział roli; cofnięcie i wygaśnięcie nie usuwają wiersza (historia zostaje).' }),
  AdminInvitation: strictObject({
    id: ref('EntityId'),
    email: STRING,
    role: ref('Role'),
    classId: nullableId(),
    schoolYearId: nullableId(),
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    expiresAt: ref('IsoDateTime'),
    acceptedAt: nullableTime(),
    revokedAt: nullableTime(),
    status: { type: 'string', enum: ['pending', 'accepted', 'revoked', 'expired'] },
  }, [], { description: 'Zaproszenie na liście — bez tokenu.' }),
  AdminIssuedInvitation: strictObject({
    id: ref('EntityId'),
    email: STRING,
    role: ref('Role'),
    classId: nullableId(),
    schoolYearId: nullableId(),
    expiresAt: ref('IsoDateTime'),
    status: { const: 'pending' },
    replacesInvitationId: { ...ref('EntityId'), description: 'Wycofane zaproszenie zastąpione nowym (ponowne wydanie).' },
  }, ['replacesInvitationId']),
  AdminInvitationWithToken: strictObject({ invitation: ref('AdminIssuedInvitation'), token: TOKEN }),
  AdminGrantRequest: strictObject({
    id: ref('EntityId'),
    kind: { type: 'string', enum: ['grant', 'invitation'] },
    role: PROTECTED_ROLE,
    userId: nullableId('Adresat przydziału (`kind: grant`).'),
    email: nullableString('Adres zaproszenia (`kind: invitation`).'),
    schoolYearId: nullableId(),
    grantExpiresAt: nullableTime(),
    ttlHours: { type: 'integer', minimum: 1, description: 'Ważność zaproszenia w godzinach; tylko gdy ją podano.' },
    replacesInvitationId: nullableId('Zaproszenie wycofywane przy zatwierdzeniu ponownego wydania.'),
    requestedBy: ref('EntityId'),
    status: { type: 'string', enum: REQUEST_STATUSES },
    createdAt: ref('IsoDateTime'),
    expiresAt: { ...ref('IsoDateTime'), description: 'Wniosek ważny 72 h.' },
    decidedBy: nullableId(),
    decidedAt: nullableTime(),
    resultId: nullableId('Przydział albo zaproszenie powstałe przy zatwierdzeniu.'),
    rejectReason: nullableString('Powód odrzucenia (0159), po bramce danych osobowych.'),
  }, ['ttlHours'], { description: 'Wniosek o nadanie roli chronionej (#146); bez tokenów.' }),
  AdminGrantRequestPending: strictObject({
    request: ref('AdminGrantRequest'),
    created: { type: 'boolean', description: 'false: istniał już otwarty wniosek o ten sam zakres (podwójne kliknięcie, drugi administrator).' },
  }, [], { description: 'Rola chroniona przy drugim administratorze: tylko wniosek, bez przydziału i bez tokenu.' }),
  AdminRecoveryRequest: strictObject({
    id: ref('EntityId'),
    kind: { type: 'string', enum: ['password_reset', 'mfa_reset'] },
    userId: ref('EntityId'),
    requestedBy: ref('EntityId'),
    status: { type: 'string', enum: REQUEST_STATUSES },
    createdAt: ref('IsoDateTime'),
    expiresAt: { ...ref('IsoDateTime'), description: 'Wniosek ważny 24 h.' },
    decidedBy: nullableId(),
    decidedAt: nullableTime(),
    ttlHours: { type: 'integer', minimum: 1, description: 'Ważność tokenu resetu hasła (tylko `password_reset`).' },
  }, ['ttlHours'], { description: 'Wniosek o reset hasła/MFA konta chronionego (#146); bez tokenów i e-maili.' }),
  AdminRecoveryRequestPending: strictObject({
    request: ref('AdminRecoveryRequest'),
    created: { type: 'boolean', description: 'false: istniał już otwarty wniosek tego rodzaju dla konta.' },
  }, [], { description: 'Konto chronione: tylko wniosek, token albo reset MFA powstaje przy zatwierdzeniu przez drugą osobę.' }),
  AdminPasswordResetTicket: strictObject({ id: ref('EntityId'), userId: ref('EntityId'), expiresAt: ref('IsoDateTime') }, [], {
    description: 'Wydany token resetu hasła — bez samego tokenu (ten jest osobnym polem `token`).',
  }),
  AdminPasswordReset: strictObject({
    reset: ref('AdminPasswordResetTicket'),
    token: TOKEN,
  }, [], { description: 'Token resetu hasła (nowy unieważnia poprzedni).' }),
  AdminMfaReset: strictObject({
    userId: ref('EntityId'),
    changed: { type: 'boolean', description: 'false: konto nie miało czynnika ani kodów (ponowienie).' },
    disabledFactors: COUNT,
    invalidatedRecoveryCodes: COUNT,
    revokedSessions: COUNT,
  }),
  AdminAuditEvent: strictObject({
    id: ref('EntityId'),
    actorId: nullableId('Aktor; null — zdarzenie systemowe albo bez sesji (`actorKind`, `source`).'),
    action: STRING,
    domain: nullable({
      type: 'string',
      enum: AUDIT_DOMAIN_NAMES,
      description: 'Domena akcji ze słownika shared/audit-actions.js; null — akcja spoza słownika.',
    }),
    actorKind: { type: 'string', enum: ['user', 'system', 'anonymous'] },
    source: nullable({
      type: 'string', enum: ['email_worker', 'brevo_webhook', 'unsubscribe_link', 'login', 'bootstrap', 'system'],
      description: 'Pochodzenie zdarzenia bez aktora; null dla zdarzeń użytkownika.',
    }),
    entityType: STRING,
    entityId: STRING,
    denialCount: { type: 'integer', minimum: 1, description: '`access.denied`: odmowy tego aktora dla metody i ścieżki w oknie 5 minut.' },
    occurredAt: ref('IsoDateTime'),
    metadata: {
      type: 'object',
      description: 'Metadane bez wolnego tekstu i danych osobowych (auditMetadataForView): liczby, wartości logiczne i napisy w '
        + 'kształcie identyfikatora/kodu/daty.',
    },
    redactedFields: arrayOf(STRING, 'Ścieżki pominiętych pól metadanych (bez wartości).'),
  }, ['denialCount'], { description: 'Zdarzenie dziennika w widoku administratora (#181).' }),
  AdminAccessLogEntry: strictObject({
    id: ref('EntityId'),
    actorId: ref('EntityId'),
    actorRoles: arrayOf(ref('Role'), 'Bieżące aktywne role aktora (nie role z chwili odczytu); bez e-maili.'),
    accessKind: { type: 'string', enum: ACCESS_KINDS },
    schoolYearId: nullableId(),
    classId: nullableId(),
    householdId: nullableId(),
    outcome: { type: 'string', enum: ['ok', 'not_found'] },
    rowCount: COUNT,
    hitCount: { type: 'integer', minimum: 1, description: 'Liczba odczytów scalonych w ten wpis.' },
    occurredAt: ref('IsoDateTime'),
    lastSeenAt: ref('IsoDateTime'),
  }, [], { description: 'Wpis dziennika odczytu danych dzieci i opiekunów (#133) — identyfikatory i liczby, bez danych osobowych.' }),
  AdminAccessReviewGrant: strictObject({
    grantId: ref('EntityId'),
    userId: ref('EntityId'),
    role: ref('Role'),
    classId: nullableId(),
    schoolYearId: nullableId('null — dawny przydział dyrekcji bez roku (sprzed wymogu roku, 2026-10-02), pokazywany w przeglądzie każdego roku.'),
    status: { type: 'string', enum: ['active', 'expired', 'revoked'] },
    grantedAt: ref('IsoDateTime'),
    expiresAt: nullableTime(),
    revokedAt: nullableTime(),
    lastReadAt: nullableTime('Ostatni odczyt danych rodzin przez konto (dowolny zakres).'),
    readsInScope: COUNT,
    readsWithoutValidGrant: COUNT,
    proposal: { type: 'string', enum: ['revoke', 'review', 'keep'], description: 'Tylko propozycja — nic nie jest odbierane automatycznie.' },
    reason: nullable({ type: 'string', enum: ['year_scope_required', 'school_year_ended', 'reads_without_valid_grant'] }),
  }),
  AdminAccessReview: strictObject({
    informational: { const: true },
    automaticRevocation: { const: false },
    schoolYear: strictObject({ id: ref('EntityId'), endsOn: ref('IsoDate'), closed: BOOLEAN, ended: BOOLEAN }),
    summary: strictObject({ grants: COUNT, active: COUNT, proposedRevoke: COUNT, proposedReview: COUNT }),
    truncated: { type: 'boolean', description: 'true: przydziałów jest więcej niż 500 (lista niekompletna).' },
    grants: arrayOf(ref('AdminAccessReviewGrant'), 'Najpierw aktywne, potem wg konta, roli i identyfikatora; najwyżej 500.'),
  }, [], { description: 'Przegląd dostępu po kadencji (#133): tylko odczyt; odebranie to jawne POST /api/admin/grants/{id}/revoke.' }),
  AdminDataRequest: strictObject({
    id: ref('EntityId'),
    kind: { type: 'string', enum: DATA_REQUEST_KINDS },
    householdId: nullableId(),
    guardianId: nullableId(),
    studentId: nullableId(),
    receivedOn: ref('IsoDate'),
    dueOn: nullable(ref('IsoDate')),
    status: { type: 'string', enum: DATA_REQUEST_STATUSES },
    handledBy: nullableId(),
    decisionNoteRef: nullableString('Odwołanie do notatki z rozstrzygnięcia (bez treści).'),
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    updatedAt: ref('IsoDateTime'),
  }, [], { description: 'Żądanie osoby, której dane dotyczą (RODO, #100) — identyfikatory, bez danych osobowych.' }),
  AdminRestrictionChange: strictObject({
    restricted: { type: 'boolean', description: 'Stan po operacji.' },
    changed: { type: 'boolean', description: 'false: ten sam stan już obowiązywał (ponowienie, bez nowego zapisu i zdarzenia).' },
    subjectType: { type: 'string', enum: ['household', 'guardian'] },
  }),
  AdminFamilyExport: strictObject({
    format: { const: 'rd-family-export' },
    formatVersion: { type: 'integer', minimum: 1 },
    request: strictObject({ id: ref('EntityId'), kind: { type: 'string', enum: ['access', 'portability'] }, receivedOn: ref('IsoDate') }),
    subject: strictObject({ type: { type: 'string', enum: ['household', 'guardian', 'student'] }, id: ref('EntityId') }),
    tables: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object' } }, description: 'Wiersze tabel rodziny (dane osobowe).' },
    lookups: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object' } } },
    paymentTotals: arrayOf({ type: 'object' }),
    auditEvents: arrayOf({ type: 'object' }, 'Zdarzenia obiektów rodziny — bez aktora i szczegółów.'),
    rowCounts: { type: 'object', additionalProperties: COUNT },
    sha256: { ...ref('Sha256Hex'), description: 'SHA-256 paczki (bez tego pola); ten sam co w nagłówku `X-Export-Manifest-Sha256`.' },
  }, [], {
    description: 'Paczka danych jednej rodziny (#100) — ZAWIERA DANE OSOBOWE; nie jest zapisywana na serwerze, przekazywana wyłącznie '
      + 'wnioskodawcy po weryfikacji tożsamości.',
  }),
  AdminAnonymizationRun: strictObject({
    id: ref('EntityId'),
    householdId: ref('EntityId'),
    reasonCode: { type: 'string', enum: ['retention_policy', 'data_subject_request'] },
    dataSubjectRequestId: nullableId(),
    retentionPolicyIds: arrayOf(STRING),
    planSha256: ref('Sha256Hex'),
    counts: { type: 'object', additionalProperties: COUNT },
    totalChanged: COUNT,
    executedBy: ref('EntityId'),
    executedAt: ref('IsoDateTime'),
  }),
  AdminOpsStatus: strictObject({
    migrations: strictObject({
      appliedCount: nullable(COUNT),
      pendingCount: nullable(COUNT),
      pending: arrayOf(STRING, 'Najwyżej 20 nazw plików migracji.'),
    }),
    emailWorker: nullable(strictObject({
      mode: STRING, finishedAt: ref('IsoDateTime'), sent: COUNT, retried: COUNT, failed: COUNT, stoppedReason: nullableString(),
    })),
    emailQueue: nullable(strictObject({ pending: COUNT, failed: COUNT, oldestPendingAt: nullableTime() })),
    guardianVerifyQueue: nullable(strictObject({ queued: COUNT, sending: COUNT, oldestPendingAt: nullableTime(), overdue: BOOLEAN })),
    backup: backupStatus('Ostatnia kopia zapasowa bazy (#90).'),
    storageBackup: backupStatus('Ostatnia kopia magazynu plików (#103).'),
    restoreDrill: backupStatus('Ostatnia próba odtworzenia.'),
    lastExport: nullable(strictObject({ kind: STRING, createdAt: ref('IsoDateTime') })),
    loginPressure: nullable(strictObject({
      thresholdFailures: { type: 'integer', minimum: 1 },
      windowSeconds: { type: 'integer', minimum: 1 },
      accounts: arrayOf(strictObject({
        accountId: ref('EntityId'), failures: COUNT, estimatedMinSources: COUNT, windowStartedAt: ref('IsoDateTime'),
      }), 'Identyfikatory kont i liczby — bez e-maili i adresów IP (#126).'),
      unmatchedTargets: COUNT,
    })),
    writeMode: { type: 'string', enum: ['normal', 'read_only'] },
    appVersion: nullableString('Commit wdrożenia (RAILWAY_GIT_COMMIT_SHA).'),
    generatedAt: ref('IsoDateTime'),
  }, [], { description: 'Stan techniczny (#149): wyłącznie liczby, znaczniki czasu i kody — bez adresów, nazw rodzin i treści.' }),

  AdminGrantCreateRequest: requestObject({
    userId: ref('Id'),
    role: { ...ref('Role'), description: 'Inna wartość → 400 `invalid_role`.' },
    classId: nullable({ ...ref('Id'), description: 'Wymagana dla `representative` (400 `class_required`); dla innych ról → 422 `class_scope_not_supported`.' }),
    schoolYearId: nullable({ ...ref('Id'), description: 'Wymagany dla `principal` (422 `school_year_required`); klasa bez roku dziedziczy rok klasy.' }),
    expiresAt: nullable({ ...ref('IsoDateTime'), description: 'W przyszłości, najwyżej 3 lata (400 `invalid_expires_at`).' }),
  }, ['userId', 'role'], { description: 'Nadanie roli innemu kontu (samonadanie → 409 `cannot_grant_self`).' }),
  AdminInvitationCreateRequest: requestObject({
    email: { type: 'string', maxLength: 254, description: 'Adres zapraszanej osoby (400 `invalid_email`); własny adres → 409 `cannot_grant_self`.' },
    role: ref('Role'),
    classId: nullable(ref('Id')),
    schoolYearId: nullable({ ...ref('Id'), description: 'Wymagany dla `principal` (422 `school_year_required`).' }),
    ttlHours: nullable({ type: 'integer', minimum: 1, maximum: 336, description: 'Ważność (domyślnie 72 h, najwyżej 14 dni; 400 `invalid_ttl`).' }),
  }, ['email', 'role']),
  AdminPasswordResetRequest: requestObject({
    ttlHours: nullable({ type: 'integer', minimum: 1, maximum: 24, description: 'Ważność tokenu (domyślnie 2 h; 400 `invalid_ttl`).' }),
  }, [], { description: 'Ciało może być puste (`{}`), ale z `Content-Type: application/json`.' }),
  AdminConfirmIdRequest: requestObject({
    confirm: { type: 'string', description: 'Identyfikator wskazany w ścieżce (konto albo rok); inny → 400 `confirmation_required`.' },
  }, ['confirm']),
  AdminGrantRejectRequest: requestObject({
    reason: nullable({
      type: 'string', maxLength: 500,
      description: 'Opcjonalny powód (3-500 znaków po przycięciu spacji, 400 `invalid_reason`); bramka danych osobowych (#152).',
    }),
    confirmPersonalData: { type: 'boolean', description: 'Potwierdza ostrzeżenie 422 `possible_personal_data`.' },
  }, [], { description: 'Ciało opcjonalne: żądanie bez treści i bez `Content-Type` odrzuca wniosek bez powodu.' }),
  AdminSchoolYearCreateRequest: requestObject({
    id: ref('Id'),
    label: { type: 'string', minLength: 1, maxLength: 200 },
    startsOn: ref('IsoDate'),
    endsOn: { ...ref('IsoDate'), description: 'Nie wcześniej niż `startsOn` (400 `invalid_date_range`).' },
  }, ['id', 'label', 'startsOn', 'endsOn']),
  AdminClassesCreateRequest: requestObject({
    names: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 60 }, description: 'Nazwy bez powtórzeń (400 `duplicate_name`).' },
  }, ['names']),
  AdminInvitationBatchPreviewRequest: requestObject({
    schoolYearId: ref('Id'),
    text: {
      type: 'string', maxLength: 24576,
      description: 'Wiersze „klasa; e-mail” (także przecinek lub tabulator), najwyżej 100 (400 `too_many_rows`); puste wiersze, `#…` '
        + 'i nagłówek arkusza pomijane.',
    },
    ttlHours: nullable({ type: 'integer', minimum: 1, maximum: 336 }),
  }, ['schoolYearId', 'text']),
  AdminInvitationBatchApplyRequest: requestObject({
    schoolYearId: ref('Id'),
    text: { type: 'string', maxLength: 24576 },
    ttlHours: nullable({ type: 'integer', minimum: 1, maximum: 336 }),
    planDigest: PLAN_DIGEST,
  }, ['schoolYearId', 'text', 'planDigest']),
  AdminPromotionClassesRequest: requestObject(PROMOTION_BASE, ['fromSchoolYearId', 'toSchoolYearId', 'classMap']),
  AdminPromotionRequest: requestObject({
    ...PROMOTION_BASE,
    exclusions: { type: 'array', items: ref('Id'), maxItems: 2000, description: 'Uczniowie bez przypisania w roku docelowym (np. powtarzają klasę).' },
    overrides: { type: 'object', additionalProperties: ref('Id'), description: 'Uczeń → inna klasa docelowa.' },
  }, ['fromSchoolYearId', 'toSchoolYearId', 'classMap']),
  AdminPromotionApplyRequest: requestObject({
    ...PROMOTION_BASE,
    exclusions: { type: 'array', items: ref('Id'), maxItems: 2000 },
    overrides: { type: 'object', additionalProperties: ref('Id') },
    planDigest: PLAN_DIGEST,
  }, ['fromSchoolYearId', 'toSchoolYearId', 'classMap', 'planDigest']),
  AdminRepresentativesApplyRequest: requestObject({
    ...PROMOTION_BASE,
    planDigest: PLAN_DIGEST,
    confirm: { type: 'string', description: 'Identyfikator roku docelowego (400 `confirmation_required`).' },
  }, ['fromSchoolYearId', 'toSchoolYearId', 'classMap', 'planDigest', 'confirm']),
  AdminDataRequestCreateRequest: requestObject({
    kind: { type: 'string', enum: DATA_REQUEST_KINDS },
    householdId: nullable(ref('Id')),
    guardianId: nullable(ref('Id')),
    studentId: nullable(ref('Id')),
    receivedOn: ref('IsoDate'),
    dueOn: nullable(ref('IsoDate')),
  }, ['kind', 'receivedOn'], { description: 'Co najmniej jeden podmiot: gospodarstwo, opiekun albo uczeń (400 `subject_required`).' }),
  AdminDataRequestStatusRequest: requestObject({
    status: { type: 'string', enum: DATA_REQUEST_STATUSES, description: 'Przejście tylko do przodu (409 `data_request_status_cannot_go_back`).' },
    decisionNoteRef: nullable({ type: 'string', minLength: 1, maxLength: 200 }),
  }, ['status']),
  AdminAnonymizationRequest: requestObject({
    householdId: ref('Id'),
    reasonCode: { type: 'string', enum: ['retention_policy', 'data_subject_request'] },
    dataRequestId: nullable({ ...ref('Id'), description: 'Wymagane dla `data_subject_request`, zakazane dla `retention_policy`.' }),
    dryRun: { type: 'boolean', description: 'Domyślnie true (podgląd, nic nie zmienia).' },
    confirm: { type: 'string', description: 'Wykonanie (`dryRun: false`): identyfikator gospodarstwa.' },
    expectedPlanSha256: { ...ref('Sha256Hex'), description: 'Wykonanie: `planSha256` z podglądu (zmiana planu → 409 `anonymization_plan_changed`).' },
  }, ['householdId', 'reasonCode']),
};

// ---------- kody błędów ----------

// Bramka modułu (rola admin + MFA) i bramka MFA routera; krok w górę MFA (#150) dokłada `mfa_stale`.
const GATE = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
const STEP_UP = { 403: ['mfa_stale'] };
// Zapis bez ciała (zmiana wynika ze ścieżki): wyłącznie kontrola Origin routera.
const POST = mergeErrors(GATE, { 403: ['invalid_origin'] });
// Zapis z ciałem JSON (czytnik modułu: 8 KiB; promocje i partie zaproszeń — własne limity).
const BODY = mergeErrors(POST, { 400: ['invalid_json'], 413: ['request_too_large'], 415: ['invalid_content_type'] });
const PATH_ID = { 400: ['invalid_id'] };
const LIST = { 400: ['invalid_cursor', 'invalid_limit'] };
const PROMOTION_INPUT = {
  400: ['invalid_class_map', 'invalid_school_year_id'],
  404: ['school_year_not_found'],
  422: ['class_map_required', 'invalid_year_order', 'same_school_year', 'unknown_source_class'],
};
const SCOPE_ERRORS = {
  400: ['class_required', 'invalid_class_id', 'invalid_role', 'invalid_school_year_id'],
  422: ['class_not_found', 'class_not_in_school_year', 'class_scope_not_supported', 'school_year_not_found', 'school_year_required'],
};
const DATA_REQUEST_ID = mergeErrors(PATH_ID, { 404: ['data_request_not_found'] });

const userChange = strictObject({
  userId: ref('EntityId'),
  disabled: BOOLEAN,
  changed: { type: 'boolean', description: 'false: konto już było w tym stanie (ponowienie, bez zdarzenia).' },
  revokedSessions: COUNT,
});
const grantResult = (created) => strictObject({ grant: ref('AdminGrant'), created: { const: created } });
const invitationBatchRow = strictObject({
  row: { type: 'integer', minimum: 1, description: 'Numer linii wklejonego tekstu.' },
  classRef: nullableString('Klasa z wiersza (nazwa albo identyfikator).'),
  classId: nullableId(),
  className: nullableString(),
  email: nullableString('Adres z wiersza (znormalizowany, gdy poprawny).'),
  existingAccount: { type: 'boolean', description: 'Adres ma już konto (przyjęcie obecnym hasłem).' },
  error: nullable({ type: 'string', enum: BATCH_ROW_ERRORS }),
});
const batchInvitation = (withToken) => strictObject({
  ...(withToken ? { row: { type: 'integer', minimum: 1 } } : {}),
  id: ref('EntityId'),
  email: STRING,
  classId: ref('EntityId'),
  className: STRING,
  expiresAt: ref('IsoDateTime'),
  status: withToken ? { const: 'pending' } : { type: 'string', enum: ['pending', 'accepted', 'revoked', 'expired'] },
  ...(withToken ? { token: TOKEN } : {}),
});
const promotionApplied = (replayedValue) => strictObject({
  runId: ref('EntityId'),
  fromSchoolYearId: ref('EntityId'),
  toSchoolYearId: ref('EntityId'),
  planDigest: ref('Sha256Hex'),
  counts: countsObject(PROMOTION_COUNTS),
  replayed: { const: replayedValue },
});
const classCopyPlan = (withCount) => strictObject({
  fromSchoolYearId: ref('EntityId'),
  toSchoolYearId: ref('EntityId'),
  classes: arrayOf(strictObject({
    fromClassId: ref('EntityId'),
    fromName: STRING,
    action: { type: 'string', enum: ['unmapped', 'final', 'exists', 'create', 'created'], description: '`created` tylko w odpowiedzi zapisu.' },
    toName: nullableString(),
    toClassId: nullableId(),
  })),
  ...(withCount ? { createdCount: COUNT } : {}),
});
const representativesApplied = strictObject({
  fromSchoolYearId: ref('EntityId'),
  toSchoolYearId: ref('EntityId'),
  planDigest: ref('Sha256Hex'),
  created: COUNT,
  alreadyGranted: COUNT,
  skipped: { ...COUNT, description: 'Pominięte wiersze bez przydziału: konta wyłączone i własne konto admina (#745).' },
  skippedSelf: { ...COUNT, description: 'Wiersze własnego konta admina — zasada drugiej osoby (#146, #745); rolę nada inny administrator.' },
  replayed: { type: 'boolean', description: 'true, gdy nic nie powstało (powtórzenie zapisu).' },
});
const restrictionRoute = (description) => ({
  responses: { 200: { description, schema: ref('AdminRestrictionChange') } },
  errors: mergeErrors(POST, DATA_REQUEST_ID, {
    409: ['data_request_closed', 'data_request_identity_not_verified', 'data_request_kind_not_restrictable', 'data_request_subject_not_restrictable'],
  }),
});

// Wynik anonimizacji (src/pg/anonymization.js): podgląd i przebieg bez zmian (200) albo wykonanie (201).
const anonymizationResult = (status, runId) => strictObject({
  status,
  runId,
  householdId: ref('EntityId'),
  reasonCode: { type: 'string', enum: ['retention_policy', 'data_subject_request'] },
  planSha256: ref('Sha256Hex'),
  counts: { type: 'object', additionalProperties: COUNT, description: 'Liczba wierszy do zmiany per tabela (bez danych osobowych).' },
  retained: strictObject({ guardians: COUNT, students: COUNT }, [], { description: 'Osoby zachowane (należą też do innego gospodarstwa).' }),
});

// Nagłówek `Idempotency-Replayed` przy opcjonalnym kluczu (rejestracja żądania osoby): `false` tylko z kluczem.
const replayedWithOptionalKey = (description, schema) => ({ description, schema, replayed: 'false', replayedOptional: true });

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  // ---------- konta ----------
  'GET /api/admin/users': {
    query: { limit: limitQuery(500), cursor: CURSOR_QUERY },
    responses: {
      200: {
        description: 'Konta wg `lower(email)`, `id`; kursor niesie tylko identyfikator konta (adres nie trafia do URL-a).',
        schema: strictObject({ ...LIST_PAGE, users: arrayOf(ref('AdminUser')) }),
      },
    },
    errors: mergeErrors(GATE, LIST),
  },
  'POST /api/admin/users/{userId}/disable': {
    responses: { 200: { description: 'Wyłączenie konta z wycofaniem sesji i tokenów resetu w jednej transakcji.', schema: userChange } },
    errors: mergeErrors(POST, PATH_ID, { 404: ['user_not_found'], 409: ['cannot_disable_self'] }),
  },
  'POST /api/admin/users/{userId}/enable': {
    responses: { 200: { description: 'Ponowne włączenie (sesje nie wracają, przydziały bez zmian); `revokedSessions` zawsze 0.', schema: userChange } },
    errors: mergeErrors(POST, PATH_ID, { 404: ['user_not_found'] }),
  },
  'POST /api/admin/users/{userId}/revoke-sessions': {
    responses: {
      200: {
        description: 'Wylogowanie ze wszystkich urządzeń.',
        schema: strictObject({ userId: ref('EntityId'), revokedSessions: COUNT }),
      },
    },
    errors: mergeErrors(POST, PATH_ID, { 404: ['user_not_found'] }),
  },
  'POST /api/admin/users/{userId}/password-reset': {
    body: ref('AdminPasswordResetRequest'),
    responses: {
      201: { description: 'Token resetu (konto bez roli chronionej albo własne konto) — jeden raz.', schema: ref('AdminPasswordReset') },
      202: { description: 'Konto z rolą chronioną: wniosek do zatwierdzenia przez drugą osobę, bez tokenu.', schema: ref('AdminRecoveryRequestPending') },
    },
    errors: mergeErrors(BODY, STEP_UP, PATH_ID, { 400: ['invalid_ttl'], 404: ['user_not_found'], 409: ['user_disabled'] }),
  },
  'POST /api/admin/users/{userId}/mfa-reset': {
    body: ref('AdminConfirmIdRequest'),
    responses: {
      200: { description: 'Wyłączenie czynników i kodów odzyskiwania, wylogowanie; ponowienie: `changed: false`.', schema: ref('AdminMfaReset') },
      202: { description: 'Konto z rolą chronioną: wniosek do zatwierdzenia przez drugą osobę.', schema: ref('AdminRecoveryRequestPending') },
    },
    errors: mergeErrors(BODY, STEP_UP, PATH_ID, {
      400: ['confirmation_required'], 404: ['user_not_found'], 409: ['cannot_reset_own_mfa', 'user_disabled'],
    }),
  },

  // ---------- wnioski o reset kont chronionych (#146) ----------
  'GET /api/admin/account-requests': {
    query: {
      status: { schema: { type: 'string', enum: [...REQUEST_STATUSES, 'all'], default: 'pending' } },
      limit: limitQuery(200),
      cursor: CURSOR_QUERY,
    },
    responses: {
      200: {
        description: 'Wnioski od najnowszego; kursor związany ze statusem.',
        schema: strictObject({ requests: arrayOf(ref('AdminRecoveryRequest')), ...LIST_PAGE }),
      },
    },
    errors: mergeErrors(GATE, LIST, { 400: ['invalid_status'] }),
  },
  'POST /api/admin/account-requests/{requestId}/approve': {
    responses: {
      200: {
        description: 'Zatwierdzenie przez INNEGO administratora (nie wnioskodawcę, nie właściciela konta) i wykonanie w tej samej '
          + 'transakcji: token resetu hasła (jeden raz, dla zatwierdzającego) albo wynik resetu MFA.',
        schema: {
          oneOf: [
            strictObject({ request: ref('AdminRecoveryRequest'), reset: ref('AdminPasswordResetTicket'), token: TOKEN }),
            strictObject({ request: ref('AdminRecoveryRequest'), mfa: ref('AdminMfaReset') }),
          ],
        },
      },
    },
    errors: mergeErrors(POST, STEP_UP, PATH_ID, {
      403: ['recovery_four_eyes_required'],
      404: ['recovery_request_not_found'],
      409: ['recovery_request_closed', 'recovery_request_expired', 'user_disabled'],
    }),
  },
  'POST /api/admin/account-requests/{requestId}/reject': {
    responses: {
      200: { description: 'Odrzucenie albo wycofanie wniosku (dowolny administrator).', schema: strictObject({ request: ref('AdminRecoveryRequest') }) },
    },
    errors: mergeErrors(POST, PATH_ID, { 404: ['recovery_request_not_found'], 409: ['recovery_request_closed'] }),
  },

  // ---------- wnioski o nadanie roli chronionej (#146) ----------
  'GET /api/admin/grant-requests': {
    query: {
      status: { schema: { type: 'string', enum: [...REQUEST_STATUSES, 'all'], default: 'pending' } },
      limit: limitQuery(200),
      cursor: CURSOR_QUERY,
    },
    responses: {
      200: {
        description: 'Wnioski od najnowszego; wniosek o zaproszenie zawiera adres adresata, bez tokenów.',
        schema: strictObject({ requests: arrayOf(ref('AdminGrantRequest')), ...LIST_PAGE }),
      },
    },
    errors: mergeErrors(GATE, LIST, { 400: ['invalid_status'] }),
  },
  'POST /api/admin/grant-requests/{requestId}/approve': {
    responses: {
      200: {
        description: 'Zatwierdzenie przez INNEGO administratora (nie wnioskodawcę, nie adresata) i wykonanie w tej samej transakcji: '
          + 'przydział (`granted_by` = zatwierdzający) albo zaproszenie z tokenem (jeden raz; przy ponownym wydaniu stare jest wycofywane).',
        schema: {
          oneOf: [
            strictObject({ request: ref('AdminGrantRequest'), grant: ref('AdminGrant'), created: BOOLEAN }),
            strictObject({ request: ref('AdminGrantRequest'), invitation: ref('AdminIssuedInvitation'), token: TOKEN }),
          ],
        },
      },
    },
    errors: mergeErrors(POST, STEP_UP, PATH_ID, {
      403: ['grant_four_eyes_required'],
      404: ['grant_request_not_found', 'user_not_found'],
      409: ['grant_request_closed', 'grant_request_expired', 'invalid_expires_at', 'invitation_not_pending', 'invitation_pending',
        'school_year_closed', 'user_disabled'],
    }),
  },
  'POST /api/admin/grant-requests/{requestId}/reject': {
    body: ref('AdminGrantRejectRequest'),
    bodyOptional: true,
    responses: {
      200: { description: 'Odrzucenie albo wycofanie wniosku; dziennik dostaje tylko `reasonGiven`, nie treść powodu.', schema: strictObject({ request: ref('AdminGrantRequest') }) },
    },
    errors: mergeErrors(BODY, PATH_ID, PII_ERRORS, { 400: ['invalid_reason'], 404: ['grant_request_not_found'], 409: ['grant_request_closed'] }),
  },

  // ---------- przydziały ról ----------
  'GET /api/admin/grants': {
    query: {
      userId: { schema: ref('Id') },
      role: { schema: ref('Role') },
      schoolYearId: { schema: ref('Id') },
      classId: { schema: ref('Id') },
      status: { schema: { type: 'string', enum: ['active', 'expired', 'revoked', 'all'], default: 'active' } },
      limit: limitQuery(500),
      cursor: CURSOR_QUERY,
    },
    responses: {
      200: {
        description: 'Przydziały wg `granted_at` malejąco, `id`; kursor związany z filtrem.',
        schema: strictObject({ grants: arrayOf(ref('AdminGrant')), ...LIST_PAGE }),
      },
    },
    errors: mergeErrors(GATE, LIST, {
      400: ['invalid_class_id', 'invalid_role', 'invalid_school_year_id', 'invalid_status', 'invalid_user_id'],
    }),
  },
  'POST /api/admin/grants': {
    body: ref('AdminGrantCreateRequest'),
    responses: {
      201: { description: 'Przydział zapisany ze zdarzeniem `role_grant.created` (rola chroniona bez drugiego administratora — też '
        + '`role_grant.four_eyes_waived`).', schema: grantResult(true) },
      200: { description: 'Identyczny aktywny przydział już istnieje (podwójne kliknięcie): bez nowego zdarzenia.', schema: grantResult(false) },
      202: { description: 'Rola chroniona przy drugim administratorze: wniosek, bez przydziału.', schema: ref('AdminGrantRequestPending') },
    },
    errors: mergeErrors(BODY, STEP_UP, SCOPE_ERRORS, {
      400: ['invalid_expires_at', 'invalid_user_id'],
      404: ['user_not_found'],
      409: ['cannot_grant_self', 'school_year_closed', 'user_disabled'],
    }),
  },
  'POST /api/admin/grants/{grantId}/revoke': {
    responses: {
      200: {
        description: 'Cofnięcie (wiersz zostaje, zdarzenie `role_grant.revoked`); ponowienie: `changed: false`.',
        schema: strictObject({ grant: ref('AdminGrant'), changed: BOOLEAN }),
      },
    },
    errors: mergeErrors(POST, PATH_ID, { 404: ['grant_not_found'], 409: ['last_admin_grant'] }),
  },
  'POST /api/admin/school-years/{schoolYearId}/expire-grants': {
    body: ref('AdminConfirmIdRequest'),
    responses: {
      200: {
        description: 'Wygaszenie kadencji zakończonego roku: `expires_at = now()` dla aktywnych przydziałów roku i jego klas; ponowienie: 0.',
        schema: strictObject({ schoolYearId: ref('EntityId'), expired: COUNT, grantIds: arrayOf(ref('EntityId')) }),
      },
    },
    errors: mergeErrors(BODY, PATH_ID, {
      400: ['confirmation_required'], 404: ['school_year_not_found'], 409: ['last_admin_grant', 'school_year_not_finished'],
    }),
  },

  // ---------- zaproszenia ----------
  'GET /api/admin/invitations': {
    query: { limit: limitQuery(500), cursor: CURSOR_QUERY },
    responses: {
      200: { description: 'Zaproszenia od najnowszego, bez tokenów.', schema: strictObject({ invitations: arrayOf(ref('AdminInvitation')), ...LIST_PAGE }) },
    },
    errors: mergeErrors(GATE, LIST),
  },
  'POST /api/admin/invitations': {
    body: ref('AdminInvitationCreateRequest'),
    responses: {
      201: { description: 'Zaproszenie z tokenem — jeden raz (`Cache-Control: no-store`).', schema: ref('AdminInvitationWithToken') },
      202: { description: 'Rola chroniona przy drugim administratorze: wniosek, bez zaproszenia i tokenu.', schema: ref('AdminGrantRequestPending') },
    },
    errors: mergeErrors(BODY, STEP_UP, SCOPE_ERRORS, {
      400: ['invalid_email', 'invalid_ttl'],
      409: ['cannot_grant_self', 'invitation_pending', 'school_year_closed'],
      422: ['role_pending_decision'],
    }),
  },
  'POST /api/admin/invitations/{invitationId}/revoke': {
    responses: {
      200: {
        description: 'Wycofanie zaproszenia; ponowienie: `changed: false`.',
        schema: strictObject({ invitationId: ref('EntityId'), changed: BOOLEAN }),
      },
    },
    errors: mergeErrors(POST, PATH_ID, { 404: ['invitation_not_found'], 409: ['invitation_already_accepted'] }),
  },
  'POST /api/admin/invitations/{invitationId}/reissue': {
    responses: {
      201: {
        description: '„Wyślij ponownie”: wycofuje oczekujące zaproszenie i tworzy nowe o tym samym zakresie (nowy token, jeden raz).',
        schema: ref('AdminInvitationWithToken'),
      },
      202: {
        description: 'Zaproszenie do roli chronionej przy drugim administratorze: wniosek (`replacesInvitationId`); stare zaproszenie działa do zatwierdzenia.',
        schema: ref('AdminGrantRequestPending'),
      },
    },
    errors: mergeErrors(POST, STEP_UP, PATH_ID, {
      404: ['invitation_not_found'],
      409: ['invitation_not_pending', 'invitation_pending', 'school_year_closed'],
      422: ['school_year_required'],
    }),
  },
  'POST /api/admin/invitation-batches/preview': {
    body: ref('AdminInvitationBatchPreviewRequest'),
    responses: {
      200: {
        description: 'Podgląd partii przedstawicieli (nic nie zapisuje): wiersze z kodami błędów, liczniki i `planDigest`.',
        schema: strictObject({
          schoolYearId: ref('EntityId'),
          ttlHours: nullable({ type: 'integer', minimum: 1 }),
          rows: arrayOf(invitationBatchRow),
          counts: strictObject({ total: COUNT, valid: COUNT, invalid: COUNT }),
          planDigest: ref('Sha256Hex'),
        }),
      },
    },
    errors: mergeErrors(BODY, STEP_UP, {
      400: ['invalid_invitation_batch_text', 'invalid_school_year_id', 'invalid_ttl', 'too_many_rows'],
      404: ['school_year_not_found'],
      422: ['invitation_batch_empty'],
    }),
  },
  'POST /api/admin/invitation-batches/apply': {
    idempotencyKey: true,
    body: ref('AdminInvitationBatchApplyRequest'),
    responses: {
      201: {
        description: 'Cała partia w jednej transakcji: osobne zaproszenie na wiersz, tokeny wyłącznie tutaj (bez nagłówka `Idempotency-Replayed`).',
        schema: strictObject({
          batchId: ref('EntityId'), schoolYearId: ref('EntityId'), planDigest: ref('Sha256Hex'), replayed: { const: false },
          invitations: arrayOf(batchInvitation(true)),
        }),
      },
      200: {
        description: 'Ten sam klucz i plan: zaproszenia partii BEZ tokenów (utracony kod wydaje „Wyślij ponownie”).',
        schema: strictObject({
          batchId: ref('EntityId'), schoolYearId: nullableId(), planDigest: ref('Sha256Hex'), replayed: { const: true },
          invitations: arrayOf(batchInvitation(false)),
        }),
      },
    },
    errors: mergeErrors(BODY, STEP_UP, {
      400: ['invalid_idempotency_key', 'invalid_invitation_batch_text', 'invalid_plan_digest', 'invalid_school_year_id', 'invalid_ttl', 'too_many_rows'],
      404: ['school_year_not_found'],
      409: ['idempotency_key_reused', 'invitation_batch_stale'],
      422: ['invitation_batch_empty', 'invitation_batch_invalid'],
    }),
  },

  // ---------- lata szkolne, klasy, promocja ----------
  'GET /api/admin/school-years': {
    responses: {
      200: {
        description: 'Lata szkolne od najnowszego z klasami (do formularzy).',
        schema: strictObject({
          schoolYears: arrayOf(strictObject({
            id: ref('EntityId'), label: STRING, startsOn: ref('IsoDate'), endsOn: ref('IsoDate'),
            finished: { type: 'boolean', description: '`ends_on` minął (dzień Europe/Brussels).' },
            classes: arrayOf(strictObject({ id: ref('EntityId'), name: STRING })),
          })),
        }),
      },
    },
    errors: GATE,
  },
  'GET /api/admin/class-coverage': {
    query: { schoolYearId: { required: true, schema: ref('Id') } },
    responses: {
      200: {
        description: 'Obsada klas roku (#108): wyłącznie liczby i daty, bez e-maili i identyfikatorów osób.',
        schema: strictObject({
          schoolYearId: ref('EntityId'),
          representativeMfaRequired: { type: 'boolean', description: 'Polityka serwera `MFA_REQUIRED_ROLES` obejmuje przedstawicieli.' },
          classes: arrayOf(strictObject({
            id: ref('EntityId'),
            name: STRING,
            neverLoggedInRepresentativeCount: COUNT,
            mfaEnrolledRepresentativeCount: COUNT,
            activeRepresentativeCount: COUNT,
            pendingInvitationCount: COUNT,
            nextInvitationExpiresAt: nullableTime(),
            lastRepresentativeLoginOn: nullable({ ...ref('IsoDate'), description: 'Dzień ostatniego logowania (bez godziny).' }),
          })),
        }),
      },
    },
    errors: mergeErrors(GATE, { 400: ['invalid_school_year_id'], 404: ['school_year_not_found'] }),
  },
  'POST /api/admin/school-years': {
    body: ref('AdminSchoolYearCreateRequest'),
    responses: {
      201: {
        description: 'Nowy rok szkolny (#78).',
        schema: strictObject({ schoolYear: strictObject({ id: ref('EntityId'), label: STRING, startsOn: ref('IsoDate'), endsOn: ref('IsoDate') }) }),
      },
    },
    errors: mergeErrors(BODY, { 400: ['invalid_date', 'invalid_date_range', 'invalid_id', 'invalid_label'], 409: ['school_year_exists'] }),
  },
  'POST /api/admin/school-years/{schoolYearId}/classes': {
    body: ref('AdminClassesCreateRequest'),
    responses: {
      201: {
        description: 'Nowe klasy roku (bez usuwania istniejących).',
        schema: strictObject({ classes: arrayOf(strictObject({ id: ref('EntityId'), name: STRING, schoolYearId: ref('EntityId') }), 'Utworzone klasy.') }),
      },
    },
    errors: mergeErrors(BODY, PATH_ID, {
      400: ['duplicate_name', 'invalid_names'], 404: ['school_year_not_found'], 409: ['class_exists'],
    }),
  },
  'POST /api/admin/promotions/classes/preview': {
    body: ref('AdminPromotionClassesRequest'),
    responses: { 200: { description: 'Plan kopiowania klas wg jawnej mapy (nic nie zapisuje).', schema: classCopyPlan(false) } },
    errors: mergeErrors(BODY, PROMOTION_INPUT, { 400: ['duplicate_name'] }),
  },
  'POST /api/admin/promotions/classes/apply': {
    body: ref('AdminPromotionClassesRequest'),
    responses: {
      201: { description: 'Utworzone brakujące klasy roku docelowego (`action: created`).', schema: classCopyPlan(true) },
      200: { description: 'Nic do utworzenia (klasy już istnieją; ponowienie): `createdCount: 0`.', schema: classCopyPlan(true) },
    },
    errors: mergeErrors(BODY, PROMOTION_INPUT, { 400: ['duplicate_name'], 409: ['school_year_closed'] }),
  },
  'POST /api/admin/promotions/preview': {
    body: ref('AdminPromotionRequest'),
    responses: {
      200: {
        description: 'Plan promocji uczniów (nic nie zapisuje): statusy, liczniki per klasa, klasy docelowe bez przedstawiciela i `planDigest`.',
        schema: strictObject({
          fromSchoolYearId: ref('EntityId'),
          toSchoolYearId: ref('EntityId'),
          counts: countsObject(PROMOTION_COUNTS),
          classes: arrayOf(strictObject({
            fromClassId: ref('EntityId'), fromName: STRING, toClassId: nullableId(), toName: nullableString(), mapped: BOOLEAN, total: COUNT,
            ...Object.fromEntries(PROMOTION_COUNTS.map((key) => [key, COUNT])),
          })),
          students: arrayOf(strictObject({
            studentId: ref('EntityId'),
            enrollmentId: ref('EntityId'),
            fromClassId: ref('EntityId'),
            toClassId: nullableId(),
            existingClassId: nullableId('Przypisanie już istniejące w roku docelowym (`conflict`).'),
            status: { type: 'string', enum: PROMOTION_COUNTS },
          })),
          missingRepresentative: arrayOf(strictObject({ classId: ref('EntityId'), name: STRING })),
          planDigest: ref('Sha256Hex'),
        }),
      },
    },
    errors: mergeErrors(BODY, PROMOTION_INPUT, {
      400: ['invalid_exclusions', 'invalid_overrides'], 422: ['plan_too_large', 'unknown_student', 'unknown_target_class'],
    }),
  },
  'POST /api/admin/promotions/apply': {
    idempotencyKey: true,
    body: ref('AdminPromotionApplyRequest'),
    responses: {
      201: { description: 'Nowe przypisania w roku docelowym (historia starego roku nietknięta); bez nagłówka `Idempotency-Replayed`.', schema: promotionApplied(false) },
      200: { description: 'Ten sam klucz i plan: zapisany wynik, bez nowych wierszy (`replayed: true`).', schema: promotionApplied(true) },
    },
    errors: mergeErrors(BODY, PROMOTION_INPUT, {
      400: ['invalid_exclusions', 'invalid_idempotency_key', 'invalid_overrides', 'invalid_plan_digest'],
      409: ['idempotency_key_reused', 'plan_stale', 'school_year_closed'],
      422: ['nothing_to_promote', 'plan_too_large', 'unknown_student', 'unknown_target_class'],
    }),
  },
  'POST /api/admin/promotions/representatives/preview': {
    body: ref('AdminPromotionClassesRequest'),
    responses: {
      200: {
        description: 'Propozycja przedłużenia przydziałów przedstawicieli na klasy roku docelowego (nic nie zapisuje).',
        schema: strictObject({
          fromSchoolYearId: ref('EntityId'),
          toSchoolYearId: ref('EntityId'),
          counts: countsObject(['propose', 'already_granted', 'user_disabled', 'cannot_grant_self']),
          proposals: arrayOf(strictObject({
            userId: ref('EntityId'), fromClassId: ref('EntityId'), toClassId: ref('EntityId'),
            status: { type: 'string', enum: ['propose', 'already_granted', 'user_disabled', 'cannot_grant_self'] },
          })),
          withoutRepresentative: arrayOf(strictObject({ classId: ref('EntityId'), name: STRING })),
          planDigest: ref('Sha256Hex'),
        }),
      },
    },
    errors: mergeErrors(BODY, PROMOTION_INPUT, { 422: ['plan_too_large', 'unknown_target_class'] }),
  },
  'POST /api/admin/promotions/representatives/apply': {
    body: ref('AdminRepresentativesApplyRequest'),
    responses: {
      201: { description: 'Nowe przydziały przedstawicieli (bez daty wygaśnięcia; wygasną z rokiem docelowym).', schema: representativesApplied },
      200: { description: 'Nic nie powstało (powtórzenie zapisu): `created: 0`, `replayed: true`.', schema: representativesApplied },
    },
    errors: mergeErrors(BODY, STEP_UP, PROMOTION_INPUT, {
      400: ['confirmation_required', 'invalid_plan_digest'],
      409: ['plan_stale', 'school_year_closed'],
      422: ['nothing_to_extend', 'plan_too_large', 'unknown_target_class'],
    }),
  },

  // ---------- dzienniki i przegląd dostępu ----------
  'GET /api/admin/audit': {
    query: {
      domain: {
        schema: { type: 'string', enum: AUDIT_DOMAIN_NAMES },
        description: 'Bez `domain` — zmiany kont i ról (domeny `access` i `security`).',
      },
      actorId: { schema: ref('Id') },
      schoolYearId: { schema: ref('Id'), description: 'Rok z metadanych; starsze zdarzenia — wg roku obiektu (#174).' },
      from: { schema: ref('IsoDateTime') },
      to: { schema: ref('IsoDateTime') },
      limit: limitQuery(500, 100),
      cursor: CURSOR_QUERY,
    },
    responses: {
      200: {
        description: 'Zdarzenia od najnowszego; każdy odczyt (także kolejna strona) zapisuje `audit.viewed` bez parametrów zapytania.',
        schema: strictObject({ ...LIST_PAGE, events: arrayOf(ref('AdminAuditEvent')) }),
      },
    },
    errors: mergeErrors(GATE, LIST, {
      400: ['invalid_actor_id', 'invalid_domain', 'invalid_from', 'invalid_school_year_id', 'invalid_to'],
    }),
  },
  'GET /api/admin/access-log': {
    query: {
      kind: { schema: { type: 'string', enum: ACCESS_KINDS }, description: 'Rodzaj odczytu (inny → 400 `invalid_access_kind`).' },
      outcome: { schema: { type: 'string', enum: ['ok', 'not_found'] } },
      actorId: { schema: ref('Id') },
      householdId: { schema: ref('Id') },
      classId: { schema: ref('Id') },
      schoolYearId: { schema: ref('Id') },
      from: { schema: ref('IsoDateTime') },
      to: { schema: ref('IsoDateTime') },
      limit: limitQuery(500, 100),
      cursor: { schema: STRING, description: '`nextCursor` z poprzedniej strony (kursor nie jest związany z filtrem).' },
    },
    responses: {
      200: {
        description: 'Dziennik odczytu od najnowszego (`occurred_at`, `id` malejąco); sam zapisuje `access_log.viewed`. Odpowiedź nie ma '
          + '`truncated` ani `limit` — koniec listy to `nextCursor: null`.',
        schema: strictObject({ entries: arrayOf(ref('AdminAccessLogEntry')), nextCursor: nullable(STRING) }),
      },
    },
    errors: mergeErrors(GATE, {
      400: ['invalid_access_kind', 'invalid_actor_id', 'invalid_class_id', 'invalid_cursor', 'invalid_from', 'invalid_household_id', 'invalid_limit',
        'invalid_outcome', 'invalid_school_year_id', 'invalid_to'],
    }),
  },
  'GET /api/admin/access-review': {
    query: { schoolYearId: { required: true, schema: ref('Id'), description: 'Brak → 400 `invalid_school_year_id`.' } },
    responses: { 200: { description: 'Przegląd dostępu roku; sam zapisuje `access_review.viewed`.', schema: ref('AdminAccessReview') } },
    errors: mergeErrors(GATE, { 400: ['invalid_school_year_id'], 404: ['school_year_not_found'] }),
  },

  // ---------- żądania osób (RODO, #100) ----------
  'GET /api/admin/data-requests': {
    query: {
      status: { schema: { type: 'string', enum: DATA_REQUEST_STATUSES } },
      kind: { schema: { type: 'string', enum: DATA_REQUEST_KINDS } },
      limit: limitQuery(500),
      cursor: CURSOR_QUERY,
    },
    responses: {
      200: {
        description: 'Rejestr wg `received_on`, `created_at`, `id` rosnąco; kursor związany z filtrem.',
        schema: strictObject({ requests: arrayOf(ref('AdminDataRequest')), ...LIST_PAGE }),
      },
    },
    errors: mergeErrors(GATE, LIST, { 400: ['invalid_kind', 'invalid_status'] }),
  },
  'POST /api/admin/data-requests': {
    idempotencyKey: 'optional',
    body: ref('AdminDataRequestCreateRequest'),
    responses: {
      201: replayedWithOptionalKey('Żądanie zarejestrowane; nagłówek `Idempotency-Replayed: false` tylko z kluczem.', strictObject({ request: ref('AdminDataRequest') })),
      200: {
        description: 'Ten sam klucz i ta sama treść: zapisane żądanie, bez nowego wiersza.',
        schema: strictObject({ request: ref('AdminDataRequest') }),
        replayed: 'true',
      },
    },
    errors: mergeErrors(BODY, {
      400: ['invalid_due_on', 'invalid_guardian_id', 'invalid_household_id', 'invalid_idempotency_key', 'invalid_kind', 'invalid_received_on',
        'invalid_student_id', 'subject_required'],
      404: ['guardian_not_found', 'household_not_found', 'student_not_found'],
      409: ['idempotency_conflict'],
    }),
  },
  'POST /api/admin/data-requests/{requestId}/status': {
    body: ref('AdminDataRequestStatusRequest'),
    responses: {
      200: {
        description: 'Przejście stanu (bez cofania); ten sam stan: `changed: false` bez zdarzenia.',
        schema: strictObject({ request: ref('AdminDataRequest'), changed: BOOLEAN }),
      },
    },
    errors: mergeErrors(BODY, DATA_REQUEST_ID, {
      400: ['invalid_decision_note_ref', 'invalid_status'], 409: ['data_request_status_cannot_go_back'],
    }),
  },
  'POST /api/admin/data-requests/{requestId}/export': {
    query: { format: { schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } } },
    responses: {
      200: formatsResponse(
        'Eksport danych jednej rodziny (żądanie `access`/`portability` po weryfikacji tożsamości): JSON albo CSV do wydruku, nagłówki '
          + '`X-Export-Manifest-Sha256`, `X-Data-Export-Omitted-Guardians`, `X-Data-Export-Omitted-Households`; wpis w dzienniku odczytu.',
        { 'application/json': ref('AdminFamilyExport'), 'text/csv; charset=utf-8': STRING },
      ),
    },
    errors: mergeErrors(POST, STEP_UP, DATA_REQUEST_ID, {
      400: ['invalid_format'],
      409: ['data_request_closed', 'data_request_export_in_progress', 'data_request_identity_not_verified', 'data_request_kind_not_exportable',
        'data_request_subject_mismatch'],
    }),
  },
  'POST /api/admin/data-requests/{requestId}/restrict': restrictionRoute(
    'Ograniczenie przetwarzania (art. 18) podmiotu żądania `restriction`/`objection` jako nowy zapis; ponowienie: `changed: false`.',
  ),
  'POST /api/admin/data-requests/{requestId}/lift-restriction': restrictionRoute(
    'Zdjęcie ograniczenia jako nowy zapis (historia zostaje); ponowienie: `changed: false`.',
  ),
  'GET /api/admin/data-requests/{requestId}/restrictions': {
    responses: {
      200: {
        description: 'Historia ograniczeń podmiotu żądania od najstarszego; żądanie samego ucznia: `subjectType: null`, pusta historia.',
        schema: strictObject({
          subjectType: nullable({ type: 'string', enum: ['household', 'guardian'] }),
          restricted: BOOLEAN,
          events: arrayOf(strictObject({
            id: ref('EntityId'), requestId: ref('EntityId'), action: { type: 'string', enum: ['restrict', 'lift'] },
            createdBy: ref('EntityId'), createdAt: ref('IsoDateTime'),
          })),
        }),
      },
    },
    errors: mergeErrors(GATE, DATA_REQUEST_ID),
  },

  // ---------- retencja i anonimizacja ----------
  'GET /api/admin/retention/preview': {
    responses: {
      200: {
        description: 'Raport kandydatów do retencji (D-04, #91): liczności per kategoria i rok, polityki — nic nie jest usuwane.',
        schema: strictObject({
          generatedAt: ref('IsoDateTime'),
          candidates: arrayOf(strictObject({
            category: STRING, schoolYearId: nullableId(), schoolYearLabel: nullableString(),
            periodYear: nullable({ type: 'integer' }), count: COUNT, hasPolicy: BOOLEAN,
          })),
          policies: arrayOf(strictObject({
            id: ref('EntityId'), category: STRING, retainFor: nullableString(), retainUntilRule: nullableString(), decisionRef: STRING,
            effectiveFrom: ref('IsoDateTime'), approvedBy: nullableId(), createdBy: ref('EntityId'), createdAt: ref('IsoDateTime'), current: BOOLEAN,
          })),
        }),
      },
    },
    errors: GATE,
  },
  'GET /api/admin/anonymizations': {
    query: { limit: limitQuery(500), cursor: CURSOR_QUERY },
    responses: {
      200: {
        description: 'Przebiegi anonimizacji od najnowszego — identyfikatory i liczniki, bez danych osobowych.',
        schema: strictObject({ runs: arrayOf(ref('AdminAnonymizationRun')), ...LIST_PAGE }),
      },
    },
    errors: mergeErrors(GATE, LIST),
  },
  'POST /api/admin/anonymizations': {
    body: ref('AdminAnonymizationRequest'),
    responses: {
      200: {
        description: 'Podgląd (`dry_run`, ślad `household.anonymization_previewed`) albo przebieg bez zmian (`replayed`: nic do zmiany).',
        schema: anonymizationResult({ type: 'string', enum: ['dry_run', 'replayed'] }, { type: 'null' }),
      },
      201: {
        description: 'Wykonanie zatwierdzonego planu (`applied`) z zachowaniem księgi i sum wpłat.',
        schema: anonymizationResult({ const: 'applied' }, ref('EntityId')),
      },
    },
    errors: mergeErrors(BODY, STEP_UP, {
      400: ['confirmation_required', 'invalid_data_request_id', 'invalid_dry_run', 'invalid_household_id', 'invalid_plan_sha256', 'invalid_reason_code'],
      404: ['data_request_not_found', 'household_not_found'],
      409: ['anonymization_plan_changed', 'anonymization_row_mismatch', 'data_request_closed', 'data_request_identity_not_verified',
        'data_request_kind_not_erasable', 'data_request_subject_mismatch', 'retention_period_not_elapsed', 'retention_policy_missing',
        'retention_policy_not_approved', 'retention_rule_not_evaluable'],
    }),
  },
  'GET /api/admin/ops-status': {
    responses: { 200: { description: 'Stan operacyjny (`Cache-Control: no-store`).', schema: ref('AdminOpsStatus') } },
    errors: GATE,
  },
};
