// Schematy OpenAPI dla modułu `mfa` (src/pg/routes/mfa.js → src/pg/mfa.js, src/pg/auth.js; #3, #134, #150, #189),
// #160 etap 11: zapis czynnika TOTP (`enroll` → `confirm` z kodami odzyskiwania), potwierdzenie sesji kodem TOTP
// (`verify`) albo kodem odzyskiwania (`recovery`), lista własnych sesji, cofnięcie jednej własnej sesji i wszystkich.
// Pisane ręcznie na podstawie `enrollFactor`, `attemptFactor`, `revokeAllOwnSessions`, `listOwnSessions` i testów
// tests/pg-mfa*.test.js, tests/pg-sessions.test.js; trasy się nie zmieniają. Metoda TOTP i jej parametry (6 cyfr,
// krok 30 s, 10 kodów odzyskiwania) to założenia D-10.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * BEZPIECZEŃSTWO: sekret czynnika (base32 i URI `otpauth://`) zwraca WYŁĄCZNIE `POST /api/mfa/enroll`, jeden raz —
//     baza ma tylko szyfrogram; kody odzyskiwania zwraca wyłącznie `POST /api/mfa/confirm`, jeden raz — baza ma tylko
//     SHA-256. Kod TOTP i kod odzyskiwania są tylko w ciałach żądań (`writeOnly: true`); nowy sekret sesji po rotacji
//     trafia wyłącznie do cookie `Set-Cookie`. Lista sesji nie ma adresu IP, User-Agent ani sekretu;
//   * każda trasa wymaga sesji (także bez potwierdzonego MFA — zwolnione z bramki routera) i zgodnego `Origin`;
//   * kod z kroku już użytego (także w innej sesji) jest odrzucany jak błędny (`400 invalid_code`) i liczy się do limitu:
//     5 błędów w sesji / 20 na konto w 15 min → `429 mfa_locked` z `Retry-After`; kod odzyskiwania jest jednorazowy;
//   * cudza albo nieistniejąca sesja w `POST /api/sessions/{id}/revoke` → identyczne `404 not_found` (SR-07);
//   * zapisy nie mają `Idempotency-Key`: ponowione potwierdzenie tym samym kodem to `invalid_code`, ponowione cofnięcie
//     sesji — `401` (sesja już nie działa) albo `404` (inna sesja już cofnięta).
import { ref, requestObject, strictObject } from './common.js';

export const name = 'mfa';

const BOOLEAN = { type: 'boolean' };

// Ciało kodu (`readCode`, limit 1 KiB) czytane po sprawdzeniu sesji.
const CODE_BODY_ERRORS = {
  400: ['invalid_code', 'invalid_json'],
  403: ['invalid_origin'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
  429: ['mfa_locked'],
};
const CODE_ERROR_TEXT = {
  400: 'Błędne ciało albo kod nieprawidłowy, spoza okna ±1 krok lub już użyty (ponowne użycie liczy się jako błąd).',
  429: 'Za dużo błędnych kodów w sesji albo na koncie — nagłówek Retry-After (sekundy); w czasie blokady kod nie jest sprawdzany.',
};

const codeField = (description) => ({ type: 'string', maxLength: 64, writeOnly: true, description });

export const components = {
  MfaEnrollment: strictObject({
    factorId: { ...ref('EntityId'), description: 'Identyfikator oczekującego czynnika (nie jest sekretem).' },
    method: { const: 'totp', description: 'Metoda MFA (TOTP, RFC 6238) — założenie D-10.' },
    secret: {
      type: 'string', pattern: '^[A-Z2-7]{32}$',
      description: 'Sekret TOTP (160 bitów, base32) do ręcznego wpisania. Zwracany JEDEN raz, przy zapisie; baza ma tylko szyfrogram.',
    },
    otpauthUri: {
      type: 'string', pattern: '^otpauth://totp/',
      description: 'URI do kodu QR (zawiera ten sam sekret i adres konta); generowany lokalnie, nie trafia do zewnętrznych usług.',
    },
    digits: { const: 6 },
    period: { const: 30, description: 'Krok w sekundach.' },
  }, [], { description: 'Rozpoczęty zapis czynnika; potwierdzenie pierwszym kodem: `POST /api/mfa/confirm`.' }),
  MfaCodeRequest: requestObject({
    code: codeField('Sześciocyfrowy kod z aplikacji uwierzytelniającej (inny format → 400 `invalid_code`, liczony do limitu).'),
  }, ['code']),
  MfaRecoveryRequest: requestObject({
    code: codeField('Jednorazowy kod odzyskiwania `XXXX-XXXX-XXXX-XXXX`; wielkość liter, spacje i myślniki bez znaczenia.'),
  }, ['code']),
  MfaVerified: strictObject({
    mfaVerified: { const: true },
    expiresAt: { ...ref('IsoDateTime'), description: 'Koniec zrotowanej sesji (bez przedłużenia limitu 24 h od pierwszego logowania).' },
  }, [], { description: 'Sesja potwierdzona i zrotowana; nowy sekret wyłącznie w cookie `Set-Cookie`, stary przestaje działać.' }),
  MfaConfirmed: strictObject({
    mfaVerified: { const: true },
    expiresAt: ref('IsoDateTime'),
    recoveryCodes: {
      type: 'array', minItems: 10, maxItems: 10,
      items: { type: 'string', pattern: '^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$' },
      description: 'Dziesięć kodów odzyskiwania (80 bitów każdy), zwracanych JEDEN raz; baza ma tylko SHA-256.',
    },
  }, [], { description: 'Czynnik potwierdzony (poprzedni wyłączony, jego kody unieważnione), sesja potwierdzona i zrotowana.' }),
  OwnSession: strictObject({
    id: { ...ref('EntityId'), description: 'Identyfikator sesji (nie sekret) — do `POST /api/sessions/{id}/revoke`.' },
    createdAt: ref('IsoDateTime'),
    lastSeenAt: { anyOf: [ref('IsoDateTime'), { type: 'null' }], description: 'Ostatnia aktywność (zapis najwyżej co 5 min); null przed pierwszym zapisem.' },
    mfaVerified: BOOLEAN,
    current: { ...BOOLEAN, description: 'true dla sesji tego żądania.' },
  }),
  OwnSessions: strictObject({
    sessions: { type: 'array', items: ref('OwnSession'), description: 'Aktywne sesje WYŁĄCZNIE wołającego, od najnowszej.' },
  }),
  OwnSessionRevoked: strictObject({ revoked: { const: true } }),
  OwnSessionsRevoked: strictObject({
    revoked: { ...ref('Count'), description: 'Liczba wycofanych sesji (z bieżącą).' },
    scope: {
      type: 'string', enum: ['all', 'current'],
      description: '`current` — konto z czynnikiem, sesja bez potwierdzonego MFA wycofuje tylko siebie (#189).',
    },
  }),
};

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'POST /api/mfa/enroll': {
    responses: {
      201: { description: 'Oczekujący czynnik z sekretem (jeden raz); poprzedni niepotwierdzony wyłączony.', schema: ref('MfaEnrollment') },
    },
    errors: {
      403: ['invalid_origin', 'mfa_required', 'mfa_stale'],
      503: ['mfa_unavailable'],
    },
    errorDescriptions: {
      403: 'Obcy Origin albo wymiana potwierdzonego czynnika bez MFA w tej sesji (`mfa_required`) lub z MFA starszym niż próg kroku w górę (`mfa_stale`).',
      503: 'Brak poprawnego klucza szyfrowania sekretów (`MFA_ENCRYPTION_KEY`/`MFA_ENCRYPTION_KEYS`).',
    },
  },
  'POST /api/mfa/confirm': {
    body: ref('MfaCodeRequest'),
    responses: {
      200: { description: 'Czynnik potwierdzony, kody odzyskiwania (jeden raz), sesja zrotowana.', schema: ref('MfaConfirmed') },
    },
    errors: {
      ...CODE_BODY_ERRORS,
      403: ['invalid_origin', 'mfa_required'],
      409: ['mfa_enrollment_not_found'],
      503: ['mfa_key_missing', 'mfa_unavailable'],
    },
    errorDescriptions: {
      ...CODE_ERROR_TEXT,
      403: 'Obcy Origin albo wymiana potwierdzonego czynnika z sesji bez potwierdzonego MFA.',
      409: 'Brak oczekującego czynnika (zapis nie rozpoczęty albo zastąpiony) — rozpocznij `enroll` ponownie.',
      503: 'Brak klucza szyfrowania albo klucza w wersji zapisanej przy czynniku (rotacja, #134).',
    },
  },
  'POST /api/mfa/verify': {
    body: ref('MfaCodeRequest'),
    responses: {
      200: { description: 'Bieżąca sesja potwierdzona kodem TOTP i zrotowana.', schema: ref('MfaVerified') },
    },
    errors: {
      ...CODE_BODY_ERRORS,
      409: ['mfa_not_enrolled'],
      503: ['mfa_key_missing', 'mfa_unavailable'],
    },
    errorDescriptions: {
      ...CODE_ERROR_TEXT,
      409: 'Konto nie ma potwierdzonego czynnika.',
      503: 'Brak klucza szyfrowania albo klucza w wersji zapisanej przy czynniku (rotacja, #134).',
    },
  },
  'POST /api/mfa/recovery': {
    body: ref('MfaRecoveryRequest'),
    responses: {
      200: { description: 'Bieżąca sesja potwierdzona jednorazowym kodem odzyskiwania i zrotowana.', schema: ref('MfaVerified') },
    },
    errors: { ...CODE_BODY_ERRORS, 409: ['mfa_not_enrolled'] },
    errorDescriptions: { ...CODE_ERROR_TEXT, 409: 'Konto nie ma potwierdzonego czynnika.' },
  },
  'GET /api/sessions': {
    responses: {
      200: { description: 'Aktywne sesje wołającego (bez adresu IP, User-Agent i sekretów).', schema: ref('OwnSessions') },
    },
    // Macierz przypisuje odmowę 403, ale trasa jest dostępna dla każdego zalogowanego i zwolniona z bramki MFA.
    errors: { 403: [] },
  },
  'POST /api/sessions/{id}/revoke': {
    responses: {
      200: {
        description: 'Własna sesja cofnięta; cofnięcie bieżącej czyści cookie (jak wylogowanie). Trasa nie czyta ciała.',
        schema: ref('OwnSessionRevoked'),
      },
    },
    errors: { 403: ['invalid_origin'], 404: ['not_found'] },
    errorDescriptions: {
      404: 'Cudza, nieistniejąca albo już cofnięta sesja — ta sama odpowiedź (zakres „tylko własne”, SR-07).',
    },
  },
  'POST /api/sessions/revoke-all': {
    responses: {
      200: {
        description: 'Wycofane sesje własnego konta (z bieżącą); cookie wyczyszczone. Trasa nie czyta ciała.',
        schema: ref('OwnSessionsRevoked'),
      },
    },
    errors: { 403: ['invalid_origin'] },
  },
};
