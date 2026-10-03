// Schematy OpenAPI dla modułu `guardian-updates` (src/pg/routes/guardian-updates.js; #140, #94, #133, #150, #152, #159),
// #160 etap 13: jednorazowy link dla opiekuna, publiczny podgląd i formularz wniosku o aktualizację kontaktu, kolejka
// wniosków z decyzją zarządu, publiczne potwierdzenie kodu weryfikacyjnego nowego adresu (#140 pkt 5, migracja 0184) i
// szablon wiadomości z kodem (szkic, zatwierdzenie przez drugą osobę z zarządu). Pisane ręcznie na podstawie kodu trasy
// (`issueLink`, `previewLink`, `submitUpdate`, `listRequests`, `decideRequest`, `confirmCode`, `templateView`),
// `verificationStatus` (src/email/guardian-verify.js) i testów tests/pg-guardian-updates.test.js,
// tests/pg-guardian-update-verify.test.js; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * trasy administracyjne: admin i zarząd z przydziałem BEZ klasy (SR-01); przedstawiciel, skarbnik, Komisja Rewizyjna,
//     dyrekcja i zarząd zawężony do klasy → 403 `forbidden`. Trasa NIE wymaga MFA sama (`requireBoardContext` bez
//     `requireMfa`) — MFA wymusza wyłącznie bramka routera dla ról z `MFA_REQUIRED_ROLES` (`mfa_enrollment_required`,
//     `mfa_required`); zatwierdzenie szablonu ma krok w górę MFA (`mfa_required`/`mfa_stale`, #150);
//   * trasy `/api/public/*` działają bez sesji (bez 401) i są zwolnione z bramki MFA; token linku jest jedynym
//     uwierzytelnieniem: zły, wygasły i zużyty token w podglądzie dają tę samą odpowiedź 404 `invalid_or_expired_link`,
//     a zły token, zły lub wygasły kod, wyczerpany limit prób i rozstrzygnięty wniosek przy potwierdzeniu — 400
//     `invalid_or_expired_code` (bez wyroczni). Ponowne wysłanie formularza tym samym tokenem → 409 `link_used`;
//   * formularz NIE zmienia `guardians`: tworzy wniosek `pending`; zmianę stosuje dopiero zatwierdzenie (ten sam
//     mechanizm historii co PATCH /api/guardians/{id}/contact); rozstrzygnięty wniosek → 200 z `changed: false`
//     i bieżącym stanem (idempotentne, bez drugiego zdarzenia);
//   * token linku jest w odpowiedzi WYŁĄCZNIE przy wydaniu (baza ma tylko skrót SHA-256); moduł nie wysyła linku —
//     przekazuje go zarząd. Kod weryfikacyjny nie jest w żadnej odpowiedzi; kolejka pokazuje tylko jego stan;
//   * moduł nie ma `Idempotency-Key`; zatwierdzenie szablonu przez tę samą osobę ponownie → 200 z nagłówkiem
//     `Idempotency-Replayed: true` (przy pierwszym zatwierdzeniu nagłówka nie ma).
import { PII_ERRORS, mergeErrors, nullable, ref, replayedOnRetry, requestObject, strictObject } from './common.js';

export const name = 'guardian-updates';

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const arrayOf = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
const nullableString = (description) => nullable(description ? { type: 'string', description } : STRING);
const nullableTime = (description) => nullable(description ? { ...ref('IsoDateTime'), description } : ref('IsoDateTime'));
const LINK_TOKEN = {
  type: 'string', pattern: '^[0-9a-f]{32,128}$', writeOnly: true,
  description: 'Jednorazowy token z linku (szesnastkowy); zły format → 404 `invalid_or_expired_link`.',
};
const LIST_PAGE = {
  nextCursor: nullable({ type: 'string', description: 'Kursor następnej strony; null na ostatniej.' }),
  truncated: { type: 'boolean', description: 'true wtedy i tylko wtedy, gdy `nextCursor` nie jest null (lista niekompletna).' },
  limit: { type: 'integer', minimum: 1, description: 'Zastosowana wielkość strony.' },
};
const CURSOR_QUERY = {
  schema: STRING,
  description: '`nextCursor` z poprzedniej strony tej samej listy z tym samym filtrem (inny filtr → 400 `invalid_cursor`).',
};
const VERIFICATION_STATUS = ['none', 'sent', 'confirmed', 'expired', 'failed'];

export const components = {
  GuardianUpdateLink: strictObject({
    linkId: ref('EntityId'),
    token: {
      type: 'string', pattern: '^[0-9a-f]{64}$',
      description: 'Jednorazowy token linku zwracany WYŁĄCZNIE w tej odpowiedzi (baza ma tylko skrót SHA-256). Zarząd '
        + 'przekazuje link sam (kartka, zatwierdzona kampania); moduł niczego nie wysyła.',
    },
    expiresAt: { ...ref('IsoDateTime'), description: 'Ważność 14 dni od wydania (propozycja #140, do zatwierdzenia).' },
  }),
  GuardianUpdatePreview: strictObject({
    guardianFirstName: { type: 'string', description: 'Imię opiekuna, do którego wydano link (bez nazwiska i adresu).' },
    classNames: arrayOf(STRING, 'Nazwy klas bieżących dzieci opiekuna (bez nazwisk, innych opiekunów i wpłat).'),
  }, [], { description: 'Publiczny podgląd formularza — dla posiadacza ważnego, nieużytego tokenu.' }),
  GuardianUpdateSubmitted: strictObject({
    requestId: ref('EntityId'),
    status: { const: 'pending' },
    emailVerification: {
      type: 'string', enum: ['requested', 'none'],
      description: '`requested`: powstał wiersz weryfikacji nowego adresu (kod wyśle worker); `none`: kodu nie będzie. '
        + 'Odpowiedź nie odróżnia adresu z listy wyłączeń od zleconej wysyłki (#94).',
    },
  }),
  GuardianUpdateRequest: strictObject({
    id: ref('EntityId'),
    guardianFirstName: nullableString('Imię opiekuna; null — opiekuna nie ma już w bazie.'),
    classNames: arrayOf(STRING),
    proposedEmail: nullableString('Proponowany adres (null — usunięcie adresu); pole tylko, gdy wniosek zmienia adres.'),
    proposedContactAllowed: { type: 'boolean', description: 'Proponowana zgoda na kontakt; pole tylko, gdy wniosek ją zmienia.' },
    proposedEmailSuppression: nullableString('Powód aktywnej blokady proponowanego adresu na liście wyłączeń (#94); bez skrótu adresu.'),
    verification: { type: 'string', enum: VERIFICATION_STATUS, description: 'Stan kodu weryfikacyjnego nowego adresu (#140 pkt 5).' },
    verificationReason: nullable({ type: 'string', pattern: '^[a-z0-9_]{1,60}$', description: 'Kod powodu stanu (np. `verification_disabled`).' }),
    verificationDelivery: nullable({ type: 'string', enum: ['skipped', 'queued', 'sending', 'sent', 'failed', 'cancelled'] }),
    verificationExpiresAt: nullableTime('Termin ważności wysłanego kodu.'),
    note: nullableString('Uwaga opiekuna (do 500 znaków; po bramce danych osobowych #152).'),
    createdAt: ref('IsoDateTime'),
  }, ['proposedEmail', 'proposedContactAllowed'], {
    description: 'Wniosek w kolejce — dane osobowe (imię, proponowany adres) wyłącznie dla admina i zarządu; bez kodu i bez skrótów.',
  }),
  GuardianUpdateDecision: strictObject({
    requestId: ref('EntityId'),
    status: {
      type: 'string', enum: ['approved', 'rejected'],
      description: 'Stan wniosku po żądaniu; dla wniosku już rozstrzygniętego — dotychczasowy stan (także inny niż żądany).',
    },
    changed: { type: 'boolean', description: 'true: zatwierdzenie zmieniło kontakt opiekuna; false: odrzucenie, brak różnicy albo ponowienie.' },
    verification: { type: 'string', enum: VERIFICATION_STATUS, description: 'Stan weryfikacji w chwili decyzji; tylko przy wniosku z nowym adresem.' },
  }, ['verification']),
  GuardianVerifyTemplate: strictObject({
    id: ref('EntityId'),
    version: { type: 'integer', minimum: 1 },
    subject: STRING,
    bodyText: STRING,
    contentHash: ref('Sha256Hex'),
    status: { type: 'string', enum: ['draft', 'approved'] },
    createdBy: ref('EntityId'),
    createdAt: ref('IsoDateTime'),
    approvedBy: nullable(ref('EntityId')),
    approvedAt: nullableTime(),
  }, [], { description: 'Wersja szablonu wiadomości z kodem (treść wpisuje zarząd, D-16); zatwierdzona wersja jest niezmienna.' }),

  GuardianLinkIssueRequest: requestObject({
    guardianId: { ...ref('Id'), description: 'Opiekun (zły format → 400 `invalid_request`, nieistniejący → 404 `guardian_not_found`).' },
  }, ['guardianId']),
  GuardianUpdateSubmitRequest: requestObject({
    token: LINK_TOKEN,
    email: nullable({
      type: 'string', maxLength: 254,
      description: 'Nowy adres (po przycięciu i zmianie na małe litery musi przejść normalizację kolejki wysyłek; 400 '
        + '`invalid_email`); null albo pusty — usunięcie adresu.',
    }),
    contactAllowed: { type: 'boolean', description: 'Zgoda na kontakt (inny typ → 400 `invalid_request`).' },
    note: nullable({ type: 'string', maxLength: 500, description: 'Uwaga (bramka danych osobowych #152).' }),
    confirmPersonalData: { type: 'boolean', description: 'Potwierdza ostrzeżenie 422 `possible_personal_data`.' },
  }, ['token'], {
    anyOf: [{ required: ['email'] }, { required: ['contactAllowed'] }],
    description: 'Co najmniej jedno z pól `email`, `contactAllowed` (inaczej 400 `invalid_request`); brak lub zły token → 404.',
  }),
  GuardianVerifyCodeRequest: requestObject({
    token: LINK_TOKEN,
    code: { type: 'string', pattern: '^\\d{8}$', writeOnly: true, description: 'Kod z wiadomości (8 cyfr).' },
  }, ['token', 'code'], { description: 'Brak pola, zły format albo zły kod → ta sama odpowiedź 400 `invalid_or_expired_code`.' }),
  GuardianVerifyTemplateCreateRequest: requestObject({
    subject: {
      type: 'string', minLength: 3, maxLength: 200,
      description: 'Po przycięciu 3-200 znaków, bez nowej linii, nawiasów klamrowych i znaków sterujących (400 `invalid_verify_template`).',
    },
    bodyText: {
      type: 'string', minLength: 20, maxLength: 4000,
      description: 'Po przycięciu 20-4000 znaków; wyłącznie znaczniki `{kod}` (wymagany, 400 `verify_code_placeholder_required`) i '
        + '`{waznosc}`; zakazane sformułowania → 400 `forbidden_wording`.',
    },
  }, ['subject', 'bodyText']),
  GuardianVerifyTemplateApproveRequest: requestObject({
    contentHash: { ...ref('Sha256Hex'), description: 'Skrót treści, którą zatwierdzający widział (inny → 409 `verify_template_changed`).' },
  }, [], { description: 'Ciało JSON wymagane (może być `{}`).' }),
};

// ---------- kody błędów ----------

// Bramka trasy (admin/zarząd bez klasy) i bramka MFA routera.
const GATE = { 403: ['forbidden', 'mfa_enrollment_required', 'mfa_required'] };
// Czytnik JSON modułu (4 KiB, wymagany `Content-Type: application/json`).
const BODY = { 400: ['invalid_json'], 403: ['invalid_origin'], 413: ['request_too_large'], 415: ['invalid_content_type'] };
const LIST = { 400: ['invalid_cursor', 'invalid_limit'] };

const decision = (description, extra = {}) => ({
  responses: { 200: { description, schema: ref('GuardianUpdateDecision') } },
  errors: mergeErrors(GATE, { 400: ['invalid_request'], 403: ['invalid_origin'], 404: ['request_not_found'] }, extra),
});

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'POST /api/admin/guardian-links': {
    body: ref('GuardianLinkIssueRequest'),
    responses: {
      201: { description: 'Nowy jednorazowy link (token tylko tutaj, raz); zdarzenie `guardian_update_link.created`.', schema: ref('GuardianUpdateLink') },
    },
    errors: mergeErrors(GATE, BODY, { 400: ['invalid_request'], 404: ['guardian_not_found'] }),
  },
  'GET /api/public/guardian-update': {
    query: {
      token: {
        required: true, schema: { type: 'string', pattern: '^[0-9a-f]{32,128}$' },
        description: 'Token z linku; brak, zły format, nieznany, wygasły i zużyty → ta sama odpowiedź 404.',
      },
    },
    responses: { 200: { description: 'Podgląd formularza (bez sesji).', schema: ref('GuardianUpdatePreview') } },
    errors: { 404: ['invalid_or_expired_link'] },
  },
  'POST /api/public/guardian-update': {
    body: ref('GuardianUpdateSubmitRequest'),
    responses: {
      201: {
        description: 'Wniosek `pending` (bez zmiany `guardians`); token zostaje zużyty. Nowy adres: wiersz weryfikacji, gdy włączona '
          + 'flaga, jest zatwierdzony szablon i opublikowana informacja o przetwarzaniu danych.',
        schema: ref('GuardianUpdateSubmitted'),
      },
    },
    errors: mergeErrors(BODY, PII_ERRORS, {
      400: ['invalid_email', 'invalid_request'],
      404: ['invalid_or_expired_link'],
      409: ['link_used'],
    }),
  },
  'GET /api/admin/guardian-update-requests': {
    query: {
      status: { schema: { type: 'string', enum: ['pending', 'approved', 'rejected'], default: 'pending' }, description: 'Inna wartość → 400 `invalid_request`.' },
      limit: { schema: { type: 'integer', minimum: 1, maximum: 200, default: 200 } },
      cursor: CURSOR_QUERY,
    },
    responses: {
      200: {
        description: 'Wnioski od najstarszego (`created_at`, `id`), kursor keyset; odczyt zostawia ślad `guardian_update_request.list_viewed` '
          + '(stan filtra i liczba, #133).',
        schema: strictObject({ requests: arrayOf(ref('GuardianUpdateRequest')), ...LIST_PAGE }),
      },
    },
    errors: mergeErrors(GATE, LIST, { 400: ['invalid_request'] }),
  },
  'POST /api/admin/guardian-update-requests/{requestId}/approve': decision(
    'Zatwierdzenie: zmiana kontaktu opiekuna (historia `parent_request:{id}`), także z niepotwierdzonym nowym adresem (audyt '
      + '`unverifiedContactChange`); niewysłany kod zostaje anulowany; rozstrzygnięty wniosek → bieżący stan, `changed: false`.',
    { 404: ['guardian_not_found'] },
  ),
  'POST /api/admin/guardian-update-requests/{requestId}/reject': decision(
    'Odrzucenie bez zmiany `guardians`; rozstrzygnięty wniosek → bieżący stan, `changed: false`.',
  ),
  'POST /api/public/guardian-update/verify': {
    body: ref('GuardianVerifyCodeRequest'),
    responses: {
      200: {
        description: 'Kod potwierdzony (także ponowienie tym samym poprawnym kodem — bez drugiego zdarzenia).',
        schema: strictObject({ verification: { const: 'confirmed' } }),
      },
    },
    errors: mergeErrors(BODY, { 400: ['invalid_or_expired_code'] }),
  },
  'GET /api/admin/guardian-verify-templates': {
    query: { limit: { schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } }, cursor: CURSOR_QUERY },
    responses: {
      200: {
        description: 'Wersje szablonu od najnowszej (kursor po wersji); obowiązuje najnowsza zatwierdzona.',
        schema: strictObject({
          templates: arrayOf(ref('GuardianVerifyTemplate')),
          currentTemplateId: nullable({ ...ref('EntityId'), description: 'Najnowsza zatwierdzona wersja (także spoza bieżącej strony); null — brak.' }),
          enabled: { type: 'boolean', description: 'Flaga `GUARDIAN_VERIFY_EMAIL_ENABLED=true`.' },
          ...LIST_PAGE,
        }),
      },
    },
    errors: mergeErrors(GATE, LIST),
  },
  'POST /api/admin/guardian-verify-templates': {
    body: ref('GuardianVerifyTemplateCreateRequest'),
    responses: { 201: { description: 'Nowy szkic (kolejny numer wersji).', schema: strictObject({ template: ref('GuardianVerifyTemplate') }) } },
    errors: mergeErrors(GATE, BODY, { 400: ['forbidden_wording', 'invalid_verify_template', 'verify_code_placeholder_required'] }),
  },
  'POST /api/admin/guardian-verify-templates/{templateId}/approve': {
    body: ref('GuardianVerifyTemplateApproveRequest'),
    responses: {
      200: replayedOnRetry(
        'Zatwierdzenie szkicu przez zarząd — inną osobę niż autor, ze świeżym MFA (#150); ponowienie przez tę samą osobę: ten sam stan '
          + 'z nagłówkiem `Idempotency-Replayed: true`, bez drugiego zdarzenia.',
        strictObject({ template: ref('GuardianVerifyTemplate') }),
      ),
    },
    errors: mergeErrors(GATE, BODY, {
      400: ['invalid_request'],
      403: ['mfa_stale', 'self_approval_forbidden'],
      404: ['verify_template_not_found'],
      409: ['verify_template_changed', 'verify_template_not_draft'],
    }),
  },
};
