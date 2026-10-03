// Schematy OpenAPI dla modułu `email` (src/pg/routes/email.js, #10, #40, #84, #94, #104, #110, #130,
// #139, #209), #160 etap 6: kampanie (szkic, edycja, migawka odbiorców, podgląd, zatwierdzenie, kolejka,
// pauza, wznowienie, anulowanie, wysyłka testowa), raport doręczeń i lista „do sprawdzenia”
// z rozstrzygnięciami (cztery oczy) i kampanią uzupełniającą, lista wyłączeń adresów ze zdjęciem
// blokady, pauza konta dostawcy, stan zadania, dzienny limit Brevo z ewidencją wiadomości spoza
// kolejki, webhook Brevo i publiczne wypisanie jednym kliknięciem. Pisane ręcznie na podstawie
// parserów (`parseCampaignContent` w src/email/content.js, `readJson` trasy), widoków (`campaignView`,
// `providerPauseView`, `ledgerView`, `computeWorkerStatus`, `quotaOverview`) i testów
// tests/pg-email*.test.js; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * `Idempotency-Key` mają tylko: szkic kampanii, kampania uzupełniająca, wysyłka testowa i wpis
//     ewidencji limitu (201 + `Idempotency-Replayed: false`, ponowienie 200 + `true`);
//   * zatwierdzenie, kolejka, pauza, wznowienie, anulowanie i zdjęcie pauzy dostawcy NIE mają klucza:
//     pierwsze wykonanie zwraca 200 BEZ nagłówka, ponowienie (rozpoznane po stanie obiektu) — 200
//     z `Idempotency-Replayed: true` (`replayedOnRetry`); rozstrzygnięcie i jego zatwierdzenie:
//     201 bez nagłówka, ponowienie 200 z `true`; wniosek o zdjęcie blokady: 201, ponowienie 200, bez nagłówka;
//   * ponowienie szkicu uzupełniającego zwraca samo `campaign` (bez `eligibleHouseholds` i `pendingApprovals`);
//   * migawka: jedna wiadomość na rodzinę (klucz kolejki kampania + rodzina, dla kont kampania + konto);
//     lista odbiorców zawiera pełny adres (podgląd zatwierdzającego, każdy odczyt w dzienniku), lista
//     „do sprawdzenia” i lista wyłączeń — wyłącznie adres maskowany;
//   * żadna trasa nie wysyła poczty do rodzin; wysyłka testowa idzie wyłącznie na adres z
//     EMAIL_PREVIEW_RECIPIENTS. Jej błąd transportu (502 z kodem dostawcy) NIE jest tu opisany: kody
//     transportu (src/email/brevo.js) nie należą do katalogu docs/API_ERRORS.md;
//   * webhook i wypisanie są publiczne (bez sesji i bez kontroli Origin); webhook uwierzytelnia wspólny sekret.
import {
  CSV_CONTENT_TYPE, PII_ERRORS, formatsResponse, mergeErrors, nullable, ref, replayed, replayedOnRetry, requestObject,
  strictObject,
} from './common.js';

export const name = 'email';

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const nullableId = (description) => nullable(description ? { ...ref('EntityId'), description } : ref('EntityId'));
const nullableTime = (description) => nullable(description ? { ...ref('IsoDateTime'), description } : ref('IsoDateTime'));

// Mapa „kod → liczba” z zamkniętym słownikiem kodów: każdy klucz opcjonalny, inne klucze zabronione.
function countMap(keys, description) {
  return strictObject(Object.fromEntries(keys.map((key) => [key, ref('Count')])), keys, { description });
}

const CAMPAIGN_STATUSES = ['draft', 'approved', 'sending', 'paused', 'done', 'cancelled'];
const AUDIENCES = ['all_households', 'no_payment_record', 'class_households', 'meeting_invitees'];
const OUTBOX_STATES = ['queued', 'sending', 'sent', 'failed', 'bounced', 'suppressed', 'skipped', 'cancelled'];
const EXCLUSION_REASONS = [
  'no_consent', 'no_valid_email', 'duplicate_address', 'suppressed', 'payment_recorded', 'opted_out',
  'followup_already_covered', 'no_payment_reference', 'processing_restricted', 'account_disabled',
];
const STALE_REASONS = [
  'processing_restricted', 'guardian_relation_ended', 'student_withdrawn', 'student_left_class', 'consent_or_address_changed',
  'account_disabled', 'role_grant_inactive', 'account_address_changed',
];
const WEBHOOK_EVENTS = [
  'request', 'delivered', 'hard_bounce', 'soft_bounce', 'blocked', 'spam', 'complaint', 'invalid_email',
  'deferred', 'error', 'unsubscribed', 'click', 'opened', 'unique_opened', 'proxy_open', 'loaded_by_proxy',
];
const REPORT_CATEGORIES = ['queued', 'sending', 'sent', 'delivered', 'bounced', 'delivery_unknown', 'failed', 'suppressed', 'skipped', 'cancelled'];
const RESOLUTIONS = ['confirmed_delivered', 'confirmed_not_sent'];
const RELEASE_REASONS = ['address_corrected', 'provider_unblocked', 'bounce_reviewed', 'parent_request'];
const QUOTA_REASON_CODES = ['manual_brevo_panel', 'invitation', 'audit_committee', 'other', 'correction'];
const PREVIEW_WARNINGS = [
  'missing_skip_if_paid_sentence', 'missing_payment_reference', 'household_id_as_payment_reference',
  'template_requires_board_decision_d16', 'payment_instructions_changed', 'payment_instructions_missing',
  'privacy_notice_missing', 'notice_outdated',
];
const WORKER_ALARMS = ['worker_never_ran', 'worker_stale', 'worker_dry_run_only', 'guardian_verify_queue_stale'];

const PAGE = {
  nextCursor: nullable({ type: 'string', description: 'Nieprzezroczysty kursor następnej strony; null na ostatniej stronie.' }),
  truncated: { type: 'boolean', description: 'true wtedy i tylko wtedy, gdy `nextCursor` nie jest null (lista niepełna).' },
  limit: { type: 'integer', minimum: 1, description: 'Zastosowana wielkość strony.' },
};
const pageQuery = (max, fallback) => ({
  limit: { schema: { type: 'integer', minimum: 1, maximum: max, default: fallback } },
  cursor: { schema: STRING, description: '`nextCursor` z poprzedniej odpowiedzi tej samej trasy i filtrów (docs/API.md).' },
});

const CONTENT_FIELDS = {
  title: { type: 'string', minLength: 3, maxLength: 200, description: 'Tytuł wewnętrzny (3-200 znaków po przycięciu, jedna linia); nie trafia do rodziców.' },
  category: { type: 'string', enum: ['contribution_reminder', 'organizational'], default: 'contribution_reminder', description: 'Kategoria komunikatu (#110); wchodzi do zatwierdzanego skrótu treści.' },
  subject: {
    type: 'string', minLength: 3, maxLength: 200,
    description: 'Temat (3-200 znaków, jedna linia); jedyny znacznik: `{rok}`. Słownictwo sugerujące zadłużenie → 400 `forbidden_wording`.',
  },
  bodyText: {
    type: 'string', minLength: 20, maxLength: 10000,
    description: 'Treść (20-10000 znaków); znaczniki `{rok}`, `{rodzina}`, `{komunikat}`, `{rachunek}`, `{odbiorca}` '
      + '(kampania do kont: tylko `{rok}`); nieznany znacznik → 400 `invalid_placeholder`.',
  },
};

const QUOTA_ENTRY = {
  id: ref('EntityId'),
  day: ref('IsoDate'),
  count: { type: 'integer', minimum: -10000, maximum: 10000, description: 'Liczba wiadomości; korekta ujemna.' },
  reasonCode: { type: 'string', enum: QUOTA_REASON_CODES },
  correctsId: nullableId('Wpis korygowany (dla `correction`).'),
  recordedBy: ref('EntityId'),
  recordedAt: ref('IsoDateTime'),
};

export const components = {
  Sha256Hex: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Skrót SHA-256 (64 znaki szesnastkowe, małe litery).' },
  EmailCampaignStatus: {
    type: 'string', enum: CAMPAIGN_STATUSES,
    description: 'draft → approved → sending ⇄ paused → done; anulowanie z każdego stanu poza done.',
  },
  EmailAudience: {
    type: 'string', enum: AUDIENCES,
    description: '`class_households` i `meeting_invitees` powstają wyłącznie ze szkicu zawiadomienia o zebraniu (#113).',
  },
  EmailCampaign: strictObject({
    id: ref('EntityId'),
    schoolYearId: ref('EntityId'),
    title: STRING,
    audience: ref('EmailAudience'),
    category: CONTENT_FIELDS.category,
    subject: STRING,
    bodyText: STRING,
    status: ref('EmailCampaignStatus'),
    revisionNo: { type: 'integer', minimum: 1, description: 'Wersja wiersza (#215); `PUT` wymaga zgodnego `revision`.' },
    contentHash: ref('Sha256Hex'),
    recipientsHash: nullable({ ...ref('Sha256Hex'), description: 'Skrót migawki odbiorców; null bez migawki.' }),
    recipientsCount: nullable(ref('Count')),
    createdBy: ref('EntityId'),
    approvedBy: nullableId(),
    approvedAt: nullableTime(),
    dailyCap: nullable({ type: 'integer', minimum: 1, description: 'Dzienny przydział kampanii ustalony przy kolejce.' }),
    queuedAt: nullableTime(),
    completedAt: nullableTime(),
    cancelledAt: nullableTime(),
    sendNotBefore: nullableTime('Start wysyłki nie wcześniej niż (#130).'),
    pausedBy: nullableId(),
    pausedAt: nullableTime(),
    resumedBy: nullableId(),
    resumedAt: nullableTime(),
    meetingId: nullableId('Zebranie, z którego zawiadomienia powstał szkic (#113).'),
    meetingNoticeId: nullableId(),
    classId: nullableId('Klasa zebrania dla `class_households`.'),
    kind: { type: 'string', enum: ['standard', 'followup'], description: '`followup` = kampania uzupełniająca (#139).' },
    sourceCampaignId: nullableId('Kampania źródłowa uzupełnienia.'),
    approvedPaymentInstructionsId: nullableId('Wersja danych do wpłaty zatwierdzona z kampanią (#92, bez IBAN).'),
    privacyNoticeId: nullableId('Wersja informacji o przetwarzaniu danych zapamiętana przy zatwierdzeniu (#145).'),
  }, [], { description: 'Kampania e-mail (bez adresów odbiorców).' }),
  EmailExclusionCounts: countMap(EXCLUSION_REASONS, 'Wykluczenia migawki: powód → liczba rodzin (kont).'),
  EmailOutboxCounts: countMap(OUTBOX_STATES, 'Wiersze kolejki: stan → liczba.'),
  EmailStaleRecipientCounts: countMap(STALE_REASONS, 'Adresaci, którzy po migawce przestali się kwalifikować (#86, 0183): powód → liczba.'),
  EmailProviderPause: strictObject({
    id: ref('EntityId'),
    reason: { type: 'string', enum: ['account_rejected'] },
    errorCode: { type: 'string', description: 'Kod odmowy dostawcy (np. `provider_rejected_401`).' },
    campaignId: nullableId(),
    createdAt: ref('IsoDateTime'),
    liftedBy: nullableId(),
    liftedAt: nullableTime(),
  }, [], { description: 'Pauza konta dostawcy po odmowie 401/402/403 (#209); dotyczy wszystkich kampanii.' }),
  EmailRecipient: strictObject({
    householdId: nullableId('Rodzina; null dla kampanii do kont.'),
    guardianId: nullableId('Opiekun-adresat; null dla kampanii do kont.'),
    userId: { ...ref('EntityId'), description: 'Konto-adresat (kampania `meeting_invitees`, 0183); pole tylko wtedy.' },
    email: { type: 'string', description: 'Pełny adres z migawki (weryfikacja przed zatwierdzeniem; odczyt trafia do dziennika).' },
  }, ['userId']),
  EmailAttentionRow: strictObject({
    outboxId: { ...ref('EntityId'), description: '= `X-Mailin-custom` do wyszukania w logach Brevo.' },
    state: { type: 'string', enum: OUTBOX_STATES },
    lastError: nullable(STRING),
    providerMessageId: nullable(STRING),
    email: { type: 'string', description: 'Adres maskowany (nigdy pełny).' },
    softBounceCount: ref('Count'),
    resolution: nullable({ type: 'string', enum: RESOLUTIONS }),
    resolutionId: nullableId(),
    resolutionApproval: nullable({ type: 'string', enum: ['pending', 'approved'], description: 'Tylko dla `confirmed_not_sent` (cztery oczy).' }),
    resolvedByMe: BOOLEAN,
  }),
  EmailResolution: strictObject({
    id: ref('EntityId'), outboxId: ref('EntityId'), resolution: { type: 'string', enum: RESOLUTIONS }, evidenceCode: STRING,
  }, [], { description: 'Rozstrzygnięcie wiersza `failed` (tylko dopisywanie; historia wiersza bez zmian).' }),
  EmailResolutionApproval: strictObject({
    id: ref('EntityId'), resolutionId: ref('EntityId'), outboxId: ref('EntityId'),
    resolution: { type: 'string', enum: ['confirmed_not_sent'] }, approvedBy: ref('EntityId'), approvedAt: ref('IsoDateTime'),
  }, [], { description: 'Zatwierdzenie „nie wyszła” przez inną osobę z zarządu (#139, 0156).' }),
  EmailSuppression: strictObject({
    emailHash: ref('Sha256Hex'),
    reason: { type: 'string', enum: ['hard_bounce', 'invalid_email', 'complaint', 'unsubscribed', 'blocked'] },
    createdAt: ref('IsoDateTime'),
    events: { ...ref('Count'), description: 'Liczba zdarzeń blokady tego adresu w historii.' },
    guardianId: nullableId('Opiekun z bieżącym adresem o tym skrócie (dopasowanie po stronie serwera).'),
    householdId: nullableId(),
    email: nullable({ type: 'string', description: 'Adres maskowany; null bez dopasowanego opiekuna.' }),
    pendingRequest: nullable(strictObject({
      requestId: ref('EntityId'),
      releaseReason: { type: 'string', enum: RELEASE_REASONS },
      confirmationNote: nullable(STRING),
      createdAt: ref('IsoDateTime'),
      requestedByMe: BOOLEAN,
    }, [], { description: 'Otwarty wniosek o zdjęcie blokady (zatwierdza inna osoba).' })),
  }),
  EmailQuotaEntry: strictObject(QUOTA_ENTRY, [], { description: 'Wpis ewidencji wiadomości spoza kolejki (#84; tylko dopisywanie).' }),
  EmailQuotaListEntry: strictObject({
    ...QUOTA_ENTRY,
    corrected: { type: 'boolean', description: 'Wpis dodatni ma już co najmniej jedną korektę.' },
    correctedCount: { ...ref('Count'), description: 'Suma korekt tego wpisu.' },
    correctableCount: { ...ref('Count'), description: 'Ile można jeszcze skorygować (0 dla korekt).' },
  }, [], { description: 'Wpis ewidencji z licznikami korekt (lista do wyboru wpisu korygowanego).' }),
  EmailQuotaDayUsage: strictObject({
    day: ref('IsoDate'), campaign: ref('Count'), other: ref('Count'), total: ref('Count'),
  }, [], { description: 'Zużycie jednej doby: kampanie, inne (ręczne, testy, kody weryfikacyjne) i razem.' }),
  EmailQuota: strictObject({
    dailyLimit: ref('Count'),
    dailyReserved: ref('Count'),
    inFlight: ref('Count'),
    remaining: { ...ref('Count'), description: 'Pula najbliższego przebiegu (limit − rezerwa − zużycie − w locie, nie mniej niż 0).' },
    windows: strictObject({
      utc: strictObject({ today: ref('EmailQuotaDayUsage'), tomorrow: ref('EmailQuotaDayUsage') }),
      account: strictObject({ timezone: STRING, today: ref('EmailQuotaDayUsage'), tomorrow: ref('EmailQuotaDayUsage') }),
    }),
    generatedAt: ref('IsoDateTime'),
    queuedCampaigns: strictObject({ campaigns: ref('Count'), queuedMessages: ref('Count') }, [], {
      description: 'Kampanie roku w `sending`/`paused` i ich wiadomości w kolejce.',
    }),
  }, [], { description: 'Stan dziennego limitu Brevo (#84): same liczby.' }),
  EmailWorkerStatus: strictObject({
    lastRun: nullable(strictObject({
      mode: { type: 'string', enum: ['dry_run', 'live'] }, finishedAt: ref('IsoDateTime'), stoppedReason: nullable(STRING),
    })),
    lastLiveRun: nullable(strictObject({ finishedAt: ref('IsoDateTime'), stoppedReason: nullable(STRING) })),
    campaigns: strictObject({ due: ref('Count'), scheduled: ref('Count'), paused: ref('Count') }),
    guardianVerifications: nullable(strictObject({
      enabled: BOOLEAN, queued: ref('Count'), sending: ref('Count'), oldestQueuedAt: nullableTime(),
    }, [], { description: 'Kolejka kodów weryfikacyjnych (#140 pkt 5); null bez tabeli (baza sprzed 0184).' })),
    alarmAfterHours: { type: 'number', description: 'Próg alarmu w godzinach (EMAIL_WORKER_ALARM_HOURS).' },
    alarms: { type: 'array', items: { type: 'string', enum: WORKER_ALARMS } },
    generatedAt: ref('IsoDateTime'),
    sendWindowEnabled: BOOLEAN,
  }, [], { description: 'Stan zadania wysyłki (#130): liczby, znaczniki czasu i kody.' }),
  EmailPreview: strictObject({
    campaign: ref('EmailCampaign'),
    contentHash: ref('Sha256Hex'),
    recipientsHash: nullable(ref('Sha256Hex')),
    snapshotCurrent: nullable({ type: 'boolean', description: 'null bez migawki; false, gdy zapisani odbiorcy nie zgadzają się ze skrótem.' }),
    recipientsCount: ref('Count'),
    exclusions: ref('EmailExclusionCounts'),
    sample: strictObject({
      householdId: nullable({ type: 'string', description: 'Rodzina próbki (bez migawki: `PRZYKLAD`); null dla kampanii do kont.' }),
      userId: nullable({ type: 'string', description: 'Konto próbki; pole tylko dla kampanii do kont.' }),
      recipient: nullable({ type: 'string', description: 'Adres maskowany pierwszego odbiorcy; null bez migawki.' }),
      subject: STRING,
      text: { type: 'string', description: 'Spersonalizowana treść ze stopką (czysty tekst).' },
    }, ['userId']),
    plan: strictObject({
      dailyCap: { type: 'integer', minimum: 0 },
      days: nullable({ type: 'integer', minimum: 0, description: 'Liczba dni wysyłki; null, gdy pula dzienna wynosi 0.' }),
      accountDailyLimit: ref('Count'),
      reservedForOtherMail: ref('Count'),
    }),
    schedule: strictObject({
      sendNotBefore: nullableTime(),
      window: strictObject({
        enabled: BOOLEAN, timezone: STRING,
        days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'Dni tygodnia ISO (1 = poniedziałek).' },
        startMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
        endMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
      }),
      timezone: STRING,
      estimated: { const: true },
      windowEnabled: BOOLEAN,
      startsAt: nullableTime(),
      endsAt: nullableTime(),
      startsAtLocal: nullable(STRING),
      endsAtLocal: nullable(STRING),
    }, [], { description: 'Szacowany start i koniec wysyłki w strefie okna (#130); szacunek, nie harmonogram.' }),
    warnings: { type: 'array', items: { type: 'string', enum: PREVIEW_WARNINGS } },
    privacyNotice: nullable(strictObject({ id: ref('EntityId'), version: { type: 'integer', minimum: 1 } })),
    paymentInstructions: nullable(strictObject({ id: ref('EntityId'), approvedAt: ref('IsoDateTime') }, [], {
      description: 'Wersja danych do wpłaty użyta w podglądzie (bez IBAN); `POST …/approve` musi przesłać to `id`.',
    })),
    staleRecipients: ref('EmailStaleRecipientCounts'),
    sends: { const: false, description: 'Podgląd niczego nie wysyła.' },
  }, [], { description: 'Podgląd kampanii: skróty do zatwierdzenia, liczby, próbka i plan dni (bez wysyłki).' }),
  EmailReport: strictObject({
    campaign: ref('EmailCampaign'),
    summary: strictObject(Object.fromEntries(REPORT_CATEGORIES.map((key) => [key, ref('Count')])), [], {
      description: 'Rozłączny podział wierszy kolejki (każdy wiersz w jednej kategorii).',
    }),
    deliveryUnknownUnresolved: { type: 'integer', description: '`delivery_unknown` bez rozstrzygnięcia.' },
    outbox: ref('EmailOutboxCounts'),
    lastProviderEvent: countMap([...WEBHOOK_EVENTS, 'none'], 'Ostatnie zdarzenie dostawcy per wiersz (`none` = brak zdarzenia) → liczba.'),
    resolutions: countMap(RESOLUTIONS, 'Rozstrzygnięcia → liczba.'),
    exclusions: ref('EmailExclusionCounts'),
  }, [], { description: 'Raport doręczeń (#139): same liczby i kody, bez adresów i identyfikatorów rodzin.' }),

  EmailCampaignCreateRequest: requestObject({
    schoolYearId: ref('Id'),
    title: CONTENT_FIELDS.title,
    audience: {
      type: 'string', enum: ['all_households', 'no_payment_record'],
      description: '`no_payment_record` = „brak wpisu wpłaty” (lista może być nieaktualna; bez statusu „dłużnik”).',
    },
    category: CONTENT_FIELDS.category,
    subject: CONTENT_FIELDS.subject,
    bodyText: CONTENT_FIELDS.bodyText,
  }, ['schoolYearId', 'title', 'audience', 'subject', 'bodyText'], { description: 'Szkic kampanii (powstaje wyłącznie jako szkic).' }),
  EmailCampaignUpdateRequest: requestObject({
    title: CONTENT_FIELDS.title,
    audience: { ...ref('EmailAudience'), description: 'Odbiorców kampanii z zawiadomienia i uzupełnienia nie da się zmienić (409 `campaign_audience_locked`).' },
    category: CONTENT_FIELDS.category,
    subject: CONTENT_FIELDS.subject,
    bodyText: CONTENT_FIELDS.bodyText,
    revision: { type: 'integer', minimum: 1, description: 'Bieżące `revisionNo` (#215); niezgodne → 409 `revision_conflict`.' },
    sendNotBefore: nullable({ ...ref('IsoDateTime'), description: 'Pominięte = bez zmian, null = usunięcie terminu; zmiana cofa do szkicu.' }),
  }, ['title', 'audience', 'subject', 'bodyText', 'revision'], {
    description: 'Pełna treść kampanii; każda zmiana cofa kampanię do szkicu i unieważnia zatwierdzenie.',
  }),
  EmailApproveRequest: requestObject({
    contentHash: { ...ref('Sha256Hex'), description: '`contentHash` widziany w podglądzie.' },
    recipientsHash: { ...ref('Sha256Hex'), description: '`recipientsHash` widziany w podglądzie.' },
    paymentInstructionsId: nullable({ type: 'string', maxLength: 128, description: '`paymentInstructions.id` z podglądu (treść z `{rachunek}`/`{odbiorca}`).' }),
  }, ['contentHash', 'recipientsHash'], { description: 'Jawne zatwierdzenie dokładnej treści i listy odbiorców z podglądu.' }),
  EmailTestSendRequest: requestObject({
    recipientEmail: { type: 'string', description: 'Adres z EMAIL_PREVIEW_RECIPIENTS (nie adres opiekuna).' },
  }, ['recipientEmail']),
  EmailResolutionRequest: requestObject({
    outboxId: ref('Id'),
    resolution: { type: 'string', enum: RESOLUTIONS, description: '`confirmed_not_sent` wymaga roli zarządu.' },
    evidenceCode: { type: 'string', pattern: '^[a-z0-9_]{1,60}$', description: 'Kod dowodu (np. `brevo_log_delivered`), bez wolnego tekstu.' },
  }, ['outboxId', 'resolution', 'evidenceCode']),
  EmailWebhookEvent: requestObject({
    event: { type: 'string', description: 'Typ zdarzenia Brevo; nieznany typ jest liczony w `ignored`.' },
    email: STRING,
    'message-id': STRING,
    'X-Mailin-custom': { type: 'string', description: 'Identyfikator wiersza kolejki z nagłówka wiadomości.' },
    id: { type: ['string', 'integer'] },
    ts_event: { type: 'number', description: 'Czas zdarzenia (sekundy epoki).' },
    date: STRING,
  }, [], { description: 'Zdarzenie transakcyjne Brevo (nieznane pola są ignorowane).' }),
  EmailSuppressionReleaseRequestBody: requestObject({
    schoolYearId: ref('Id'),
    releaseReason: { type: 'string', enum: RELEASE_REASONS, description: 'Blokadę po skardze lub wypisaniu zdejmuje wyłącznie `parent_request`.' },
    confirmationNote: nullable({ type: 'string', pattern: '^[a-z0-9_]{1,40}$', description: 'Krótki kod potwierdzenia, bez treści rozmowy; bramka danych osobowych (#152).' }),
    confirmPersonalData: { type: 'boolean', description: 'true potwierdza ostrzeżenie bramki danych osobowych (422 `possible_personal_data`).' },
  }, ['schoolYearId', 'releaseReason']),
  EmailSuppressionReleaseBody: requestObject({
    schoolYearId: ref('Id'), requestId: ref('Id'),
  }, ['schoolYearId', 'requestId'], { description: 'Zatwierdzenie wniosku przez inną osobę niż zgłaszająca.' }),
  EmailProviderPauseLiftRequest: requestObject({
    schoolYearId: ref('Id'), pauseId: ref('Id'),
  }, ['schoolYearId', 'pauseId']),
  EmailQuotaOtherSendRequest: requestObject({
    schoolYearId: ref('Id'),
    day: { ...ref('IsoDate'), description: 'Bieżąca doba UTC albo strefy konta; wstecz tylko korekta (doba wpisu korygowanego).' },
    count: { type: 'integer', minimum: -10000, maximum: 10000, description: 'Różna od zera; ujemna wtedy i tylko wtedy, gdy `reasonCode` = `correction`.' },
    reasonCode: { type: 'string', enum: QUOTA_REASON_CODES },
    correctsId: nullable({ ...ref('Id'), description: 'Wymagane dla `correction`, zabronione dla pozostałych.' }),
  }, ['schoolYearId', 'day', 'count', 'reasonCode']),
};

const MFA_DENY = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
const YEAR_READ = mergeErrors(MFA_DENY, { 400: ['invalid_request'] });
const LIST_ERRORS = { 400: ['invalid_cursor', 'invalid_limit'] };
const CAMPAIGN_READ = mergeErrors(MFA_DENY, { 400: ['invalid_campaign_id'], 404: ['campaign_not_found'] });
const CAMPAIGN_WRITE = mergeErrors(CAMPAIGN_READ, { 403: ['invalid_origin'], 409: ['school_year_closed'] });
const JSON_BODY = { 400: ['invalid_json'], 413: ['request_too_large'], 415: ['invalid_content_type'] };
const YEAR_WRITE = mergeErrors(MFA_DENY, JSON_BODY, { 400: ['invalid_request'], 403: ['invalid_origin'] });
const CONTENT_ERRORS = {
  400: ['forbidden_wording', 'invalid_audience', 'invalid_body', 'invalid_category', 'invalid_placeholder', 'invalid_subject', 'invalid_title'],
};
const RELEASE_GATES = {
  409: ['notice_outdated', 'payment_instructions_changed', 'payment_instructions_missing', 'privacy_notice_missing'],
};

const YEAR_QUERY = { schoolYearId: { required: true, schema: ref('Id') } };
const campaignOnly = strictObject({ campaign: ref('EmailCampaign') });
const RETRY = 'Ponowienie (podwójne kliknięcie) rozpoznane po stanie kampanii: 200 z `Idempotency-Replayed: true`, bez nowego zapisu.';

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'GET /api/email/campaigns': {
    query: { ...YEAR_QUERY, ...pageQuery(100, 100) },
    responses: {
      200: {
        description: 'Kampanie roku od najnowszych (kursor keyset, #159).',
        schema: strictObject({ campaigns: { type: 'array', items: ref('EmailCampaign') }, ...PAGE }),
      },
    },
    errors: mergeErrors(YEAR_READ, LIST_ERRORS),
  },
  'POST /api/email/campaigns': {
    idempotencyKey: true,
    body: ref('EmailCampaignCreateRequest'),
    responses: {
      201: replayed('false', 'Szkic kampanii (nic nie jest wysyłane).', campaignOnly),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji (bez nowego zapisu).', campaignOnly),
    },
    errors: mergeErrors(YEAR_WRITE, CONTENT_ERRORS, {
      400: ['invalid_idempotency_key', 'invalid_reference'],
      409: ['idempotency_conflict', 'school_year_closed'],
    }),
  },
  'GET /api/email/campaigns/{campaignId}': {
    responses: {
      200: {
        description: 'Stan kampanii z licznikami kolejki i wykluczeń; `providerPause` tylko dla kampanii w toku.',
        schema: strictObject({
          campaign: ref('EmailCampaign'),
          outbox: ref('EmailOutboxCounts'),
          exclusions: ref('EmailExclusionCounts'),
          providerPause: nullable(ref('EmailProviderPause')),
        }),
      },
    },
    errors: CAMPAIGN_READ,
  },
  'PUT /api/email/campaigns/{campaignId}': {
    body: ref('EmailCampaignUpdateRequest'),
    responses: {
      200: {
        description: 'Treść po zmianie (zmiana cofa do szkicu); ta sama treść jeszcze raz = odtworzenie bez błędu, '
          + '`approvalInvalidated: false`. Bez `Idempotency-Key`.',
        schema: strictObject({
          campaign: ref('EmailCampaign'),
          approvalInvalidated: { type: 'boolean', description: 'true, gdy zmiana unieważniła zatwierdzenie.' },
        }),
      },
    },
    errors: mergeErrors(CAMPAIGN_WRITE, JSON_BODY, CONTENT_ERRORS, {
      400: ['invalid_revision', 'invalid_send_not_before'],
      409: ['campaign_audience_locked', 'campaign_locked', 'revision_conflict'],
    }),
  },
  'POST /api/email/campaigns/{campaignId}/snapshot': {
    responses: {
      200: {
        description: 'Nowa migawka odbiorców (jedna wiadomość na rodzinę albo konto); kampania wraca do szkicu.',
        schema: strictObject({
          recipientsHash: ref('Sha256Hex'),
          recipientsCount: ref('Count'),
          exclusions: ref('EmailExclusionCounts'),
          approvalInvalidated: BOOLEAN,
        }),
      },
    },
    errors: mergeErrors(CAMPAIGN_WRITE, { 409: ['campaign_locked'] }),
  },
  'GET /api/email/campaigns/{campaignId}/preview': {
    responses: { 200: { description: 'Podgląd kampanii (niczego nie wysyła).', schema: ref('EmailPreview') } },
    errors: CAMPAIGN_READ,
  },
  'GET /api/email/campaigns/{campaignId}/recipients': {
    query: pageQuery(200, 200),
    responses: {
      200: {
        description: 'Odbiorcy z migawki (kursor keyset; każdy odczyt trafia do dziennika).',
        schema: strictObject({ recipients: { type: 'array', items: ref('EmailRecipient') }, ...PAGE }),
      },
    },
    errors: mergeErrors(CAMPAIGN_READ, LIST_ERRORS),
  },
  'GET /api/email/campaigns/{campaignId}/report': {
    query: { format: { schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } } },
    responses: {
      200: formatsResponse('Raport doręczeń: JSON (domyślnie) albo CSV UTF-8 z BOM (sekcja;kod;liczba; pobranie trafia do dziennika).', {
        'application/json': ref('EmailReport'),
        [CSV_CONTENT_TYPE]: { type: 'string' },
      }),
    },
    errors: mergeErrors(CAMPAIGN_READ, { 400: ['invalid_format'] }),
  },
  'GET /api/email/campaigns/{campaignId}/attention': {
    query: pageQuery(200, 200),
    responses: {
      200: {
        description: 'Lista „do sprawdzenia”: wiersze `failed` i adresy z ≥ 3 `soft_bounce` (adres maskowany; odczyt w dzienniku).',
        schema: strictObject({ rows: { type: 'array', items: ref('EmailAttentionRow') }, ...PAGE }),
      },
    },
    errors: mergeErrors(CAMPAIGN_READ, LIST_ERRORS),
  },
  'POST /api/email/campaigns/{campaignId}/resolutions': {
    body: ref('EmailResolutionRequest'),
    responses: {
      201: { description: 'Rozstrzygnięcie zapisane (tylko dopisywanie).', schema: strictObject({ resolution: ref('EmailResolution') }) },
      200: replayed('true', 'Wiersz ma już rozstrzygnięcie: zwraca istniejące, bez drugiego zapisu.', strictObject({ resolution: ref('EmailResolution') })),
    },
    errors: mergeErrors(CAMPAIGN_WRITE, JSON_BODY, {
      400: ['invalid_request'],
      404: ['outbox_not_found'],
      409: ['not_resolvable'],
    }),
  },
  'POST /api/email/campaigns/{campaignId}/resolutions/{resolutionId}/approve': {
    responses: {
      201: { description: 'Zatwierdzenie „nie wyszła” przez inną osobę z zarządu (świeże MFA).', schema: strictObject({ approval: ref('EmailResolutionApproval') }) },
      200: replayed('true', 'Rozstrzygnięcie ma już zatwierdzenie: zwraca istniejące.', strictObject({ approval: ref('EmailResolutionApproval') })),
    },
    errors: mergeErrors(CAMPAIGN_WRITE, {
      400: ['invalid_request'],
      403: ['mfa_stale', 'self_approval_forbidden'],
      404: ['outbox_resolution_not_found'],
      409: ['resolution_not_approvable'],
    }),
  },
  'POST /api/email/campaigns/{campaignId}/followup': {
    idempotencyKey: true,
    responses: {
      201: replayed('false', 'Szkic kampanii uzupełniającej (tylko rodziny z zatwierdzonym „nie wyszła”).', strictObject({
        campaign: ref('EmailCampaign'),
        eligibleHouseholds: { type: 'integer', minimum: 1 },
        pendingApprovals: { ...ref('Count'), description: '„Nie wyszła” czekające jeszcze na zatwierdzenie (poza uzupełnieniem).' },
      })),
      200: replayed('true', 'Odtworzenie po tym samym kluczu: samo `campaign` (bez liczników z utworzenia).', campaignOnly),
    },
    errors: mergeErrors(CAMPAIGN_WRITE, {
      400: ['invalid_idempotency_key'],
      409: ['followup_no_households', 'followup_source_not_eligible', 'idempotency_conflict'],
    }),
  },
  'POST /api/email/campaigns/{campaignId}/approve': {
    body: ref('EmailApproveRequest'),
    responses: {
      200: replayedOnRetry('Kampania zatwierdzona przez zarząd (inna osoba niż autor, świeże MFA). ' + RETRY, campaignOnly),
    },
    errors: mergeErrors(CAMPAIGN_WRITE, JSON_BODY, RELEASE_GATES, {
      400: ['invalid_request'],
      403: ['mfa_stale', 'self_approval_forbidden'],
      409: [
        'approval_stale', 'campaign_not_draft', 'campaign_test_send_required', 'content_hash_mismatch', 'no_recipients',
        'recipients_hash_mismatch', 'snapshot_required',
      ],
    }),
  },
  'POST /api/email/campaigns/{campaignId}/queue': {
    responses: {
      200: replayedOnRetry('Kolejka: jeden wiersz na rodzinę (klucz `campaign:<id>:household:<id>`) albo konto. '
        + 'Ponowienie: `queued: 0`, nagłówek `true`, bez duplikatów.', strictObject({
        campaign: ref('EmailCampaign'),
        queued: { ...ref('Count'), description: 'Nowe wiersze kolejki w tym wywołaniu.' },
      })),
    },
    errors: mergeErrors(CAMPAIGN_WRITE, RELEASE_GATES, {
      409: ['approval_required', 'campaign_locked', 'content_hash_mismatch', 'recipients_hash_mismatch', 'snapshot_required'],
    }),
  },
  'POST /api/email/campaigns/{campaignId}/pause': {
    responses: { 200: replayedOnRetry(`Wysyłka wstrzymana (#130). ${RETRY}`, campaignOnly) },
    errors: mergeErrors(CAMPAIGN_WRITE, { 409: ['campaign_locked'] }),
  },
  'POST /api/email/campaigns/{campaignId}/resume': {
    responses: { 200: replayedOnRetry(`Wysyłka wznowiona (bez ponownego zatwierdzenia). ${RETRY}`, campaignOnly) },
    errors: mergeErrors(CAMPAIGN_WRITE, RELEASE_GATES, { 409: ['campaign_locked'] }),
  },
  'POST /api/email/campaigns/{campaignId}/cancel': {
    responses: {
      200: replayedOnRetry(`Kampania anulowana; wiersze w kolejce → cancelled. ${RETRY}`, strictObject({
        campaign: ref('EmailCampaign'),
        cancelledMessages: ref('Count'),
        inFlight: { ...ref('Count'), description: 'Wiadomości, których przekazanie do dostawcy już trwa (mogą wyjść).' },
      })),
    },
    errors: mergeErrors(CAMPAIGN_WRITE, { 409: ['campaign_locked'] }),
  },
  'POST /api/email/campaigns/{campaignId}/test-send': {
    idempotencyKey: true,
    body: ref('EmailTestSendRequest'),
    responses: {
      201: replayed('false', 'Jedna wiadomość testowa na adres techniczny Rady (temat z `[TEST] `).', strictObject({
        sent: { const: true }, providerMessageId: nullable(STRING),
      })),
      200: replayed('true', 'Odtworzenie po tym samym kluczu (bez drugiej wiadomości).', strictObject({
        sent: { const: true }, providerMessageId: nullable(STRING),
      })),
    },
    errors: mergeErrors(CAMPAIGN_READ, JSON_BODY, {
      400: ['invalid_idempotency_key', 'invalid_request'],
      403: ['invalid_origin', 'preview_recipient_not_allowed'],
      409: ['payment_instructions_changed', 'payment_instructions_missing', 'privacy_notice_missing', 'sending_disabled'],
      429: ['preview_account_limit', 'preview_campaign_limit'],
    }),
  },
  'POST /api/email/webhooks/brevo': {
    body: { anyOf: [ref('EmailWebhookEvent'), { type: 'array', items: ref('EmailWebhookEvent'), minItems: 1, maxItems: 100 }] },
    responses: {
      200: {
        description: 'Zdarzenia przyjęte (duplikaty i nieznane typy bez skutku; bounce/skarga blokuje adres).',
        schema: strictObject({
          received: ref('Count'),
          recorded: { ...ref('Count'), description: 'Nowe zdarzenia (powtórzone zdarzenie nie jest zapisywane drugi raz).' },
          suppressed: { ...ref('Count'), description: 'Zdarzenia, które zablokowały adres albo zapisały wypisanie.' },
          ignored: { ...ref('Count'), description: 'Nieznane typy zdarzeń.' },
        }),
      },
    },
    errors: {
      400: ['invalid_json', 'invalid_request'],
      401: ['invalid_signature'],
      413: ['request_too_large'],
      415: ['invalid_content_type'],
      503: ['webhook_not_configured'],
    },
  },
  'GET /api/email/suppressions': {
    query: { ...YEAR_QUERY, ...pageQuery(500, 500) },
    responses: {
      200: {
        description: 'Aktywne blokady adresów (skrót, powód, adres maskowany; odczyt w dzienniku).',
        schema: strictObject({ suppressions: { type: 'array', items: ref('EmailSuppression') }, ...PAGE }),
      },
    },
    errors: mergeErrors(YEAR_READ, LIST_ERRORS),
  },
  'POST /api/email/suppressions/{emailHash}/release-request': {
    body: ref('EmailSuppressionReleaseRequestBody'),
    responses: {
      201: { description: 'Wniosek o zdjęcie blokady (zatwierdza inna osoba).', schema: strictObject({ requestId: ref('EntityId') }) },
      200: { description: 'Ten sam autor ma już otwarty wniosek o ten powód: zwraca go (bez nagłówka ponowienia).', schema: strictObject({ requestId: ref('EntityId') }) },
    },
    errors: mergeErrors(YEAR_WRITE, PII_ERRORS, {
      400: ['invalid_confirmation_note', 'invalid_release_reason'],
      404: ['suppression_not_active'],
      409: ['release_reason_not_allowed'],
    }),
  },
  'POST /api/email/suppressions/{emailHash}/release': {
    body: ref('EmailSuppressionReleaseBody'),
    responses: {
      201: { description: 'Blokada zdjęta: nowy, niezmienny zapis zwolnienia (dwie różne osoby).', schema: strictObject({ releaseId: ref('EntityId') }) },
    },
    errors: mergeErrors(YEAR_WRITE, {
      403: ['self_approval_forbidden'],
      404: ['request_not_found'],
      409: ['release_reason_not_allowed', 'request_already_consumed', 'suppression_not_active'],
    }),
  },
  'GET /api/email/provider-pause': {
    query: YEAR_QUERY,
    responses: {
      200: { description: 'Aktywna pauza konta dostawcy albo null.', schema: strictObject({ pause: nullable(ref('EmailProviderPause')) }) },
    },
    errors: YEAR_READ,
  },
  'POST /api/email/provider-pause/lift': {
    body: ref('EmailProviderPauseLiftRequest'),
    responses: {
      200: replayedOnRetry('Pauza zdjęta przez zarząd (świeże MFA); ponowienie dla zdjętej pauzy: 200 z nagłówkiem `true`, bez nowego zdarzenia.',
        strictObject({ pause: ref('EmailProviderPause') })),
    },
    errors: mergeErrors(YEAR_WRITE, {
      400: ['invalid_provider_pause_id'],
      403: ['mfa_stale'],
      404: ['provider_pause_not_found'],
    }),
  },
  'GET /api/email/worker-status': {
    query: YEAR_QUERY,
    responses: { 200: { description: 'Ostatni przebieg zadania i alarmy (`Cache-Control: no-store`).', schema: strictObject({ workerStatus: ref('EmailWorkerStatus') }) } },
    errors: YEAR_READ,
  },
  'GET /api/email/quota': {
    query: YEAR_QUERY,
    responses: { 200: { description: 'Stan dziennego limitu Brevo: dziś i jutro w dobie UTC i w strefie konta.', schema: strictObject({ quota: ref('EmailQuota') }) } },
    errors: YEAR_READ,
  },
  'GET /api/email/quota/other-sends': {
    query: { ...YEAR_QUERY, day: { schema: ref('IsoDate'), description: 'Filtr doby (RRRR-MM-DD).' }, ...pageQuery(100, 50) },
    responses: {
      200: {
        description: 'Wpisy ręczne i korekty (od najnowszych, kursor keyset).',
        schema: strictObject({
          entries: { type: 'array', items: ref('EmailQuotaListEntry') },
          ...PAGE,
        }),
      },
    },
    errors: mergeErrors(YEAR_READ, LIST_ERRORS, { 400: ['invalid_quota_day'] }),
  },
  'POST /api/email/quota/other-sends': {
    idempotencyKey: true,
    body: ref('EmailQuotaOtherSendRequest'),
    responses: {
      201: replayed('false', 'Wpis ewidencji (nowy zapis; pomyłkę poprawia korekta ujemna).', strictObject({ entry: ref('EmailQuotaEntry') })),
      200: replayed('true', 'Odtworzenie po tym samym kluczu idempotencji.', strictObject({ entry: ref('EmailQuotaEntry') })),
    },
    errors: mergeErrors(YEAR_WRITE, {
      400: ['invalid_idempotency_key', 'invalid_quota_count', 'invalid_quota_day', 'invalid_quota_reason'],
      404: ['quota_correction_target_not_found'],
      409: ['idempotency_conflict', 'quota_correction_exceeds'],
    }),
  },
  'GET /api/email/preferences': {
    query: { t: { required: true, schema: { type: 'string', minLength: 1, maxLength: 2000 }, description: 'Podpisany token z linku wypisania (#110).' } },
    responses: {
      200: {
        description: 'Kategoria z tokenu; GET nie ma skutku (skanery linków).',
        schema: strictObject({ category: CONTENT_FIELDS.category, action: { const: 'opt_out' } }),
      },
    },
    errors: { 400: ['invalid_token'], 429: ['rate_limited'] },
  },
  'POST /api/email/preferences': {
    query: { t: { required: true, schema: { type: 'string', minLength: 1, maxLength: 2000 }, description: 'Podpisany token z linku wypisania (#110).' } },
    responses: {
      200: {
        description: 'Wypisanie z kategorii (idempotentne: drugie kliknięcie bez drugiego zdarzenia).',
        schema: strictObject({ category: CONTENT_FIELDS.category, optedOut: { const: true } }),
      },
    },
    errors: { 400: ['invalid_token'], 429: ['rate_limited'] },
  },
};
