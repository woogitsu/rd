// Schematy OpenAPI dla modułu `login` (src/pg/routes/login.js → src/pg/login.js, src/pg/password.js; #3, #126, #146,
// #164, #186, #193, #196, #203), #160 etap 11: logowanie hasłem, stan sesji dla ekranu logowania, podgląd i przyjęcie
// zaproszenia, reset hasła tokenem od administratora i zmiana hasła. Pisane ręcznie na podstawie `loginResponse`
// (trasa), `sessionPayload`, `authState`, `previewInvitation` i testów tests/pg-login*.test.js; trasy się nie zmieniają.
//
// Cechy modułu, które schemat odwzorowuje (opis stanu, nie zmiana tras):
//   * BEZPIECZEŃSTWO: żadna odpowiedź nie zawiera hasła, hasha, tokenu zaproszenia ani tokenu resetu — pola tajne są
//     wyłącznie w ciałach żądań (`writeOnly: true`). Sekret sesji trafia tylko do cookie HttpOnly (`Set-Cookie`),
//     nigdy do treści JSON. Podgląd zaproszenia zwraca adres zamaskowany (`j…@example.invalid`);
//   * nieznany adres, złe hasło, konto wyłączone i konto bez hasła dają ten sam `401 invalid_credentials` (ta sama
//     treść, ten sam koszt scrypt przez fikcyjny hash) — odpowiedź nie ujawnia istnienia konta. Każda odmowa podglądu
//     i przyjęcia zaproszenia (zły format, nieznany, wygasły, wycofany, wykorzystany, konto wyłączone) to ten sam
//     `400 invalid_invitation`, a resetu — `400 invalid_token`;
//   * limity (#126, #186): 5 błędów na parę (adres, IP) i 20 na IP w 15 min → `429 too_many_attempts` z `Retry-After`;
//     sam adres nie blokuje. Pełna kolejka scrypt (#203) → `503 login_busy` z `Retry-After: 5`, bez liczenia próby;
//   * zapisy nie mają `Idempotency-Key`: ponowione logowanie tworzy nową sesję, a ponowione przyjęcie zaproszenia
//     albo reset tym samym tokenem kończy się `invalid_invitation`/`invalid_token` (token jednorazowy);
//   * logowanie, podgląd i przyjęcie zaproszenia oraz reset działają bez sesji (cookie jest ignorowane) i są
//     zwolnione z bramki MFA; `POST /api/password/change` wymaga sesji i NIE jest zwolnione (`403 mfa_required` albo
//     `mfa_enrollment_required` z bramki routera). Zgodny `Origin` sprawdza router (`403 invalid_origin`).
import { mergeErrors, ref, requestObject, strictObject } from './common.js';

export const name = 'login';

const BOOLEAN = { type: 'boolean' };

// Wspólne błędy ciała JSON tras modułu (czytnik `createJsonReader`, limit 4 KiB) i odmowa obcego Origin.
const BODY_ERRORS = {
  400: ['invalid_json'],
  403: ['invalid_origin'],
  413: ['request_too_large'],
  415: ['invalid_content_type'],
};
// Polityka nowego hasła (src/pg/password.js, NIST SP 800-63B, #196) i limit bajtów pola hasła trasy.
const NEW_PASSWORD_ERRORS = { 400: ['password_common', 'password_contains_email', 'password_too_long', 'password_too_short'] };
const ATTEMPT_LIMIT = { 429: ['too_many_attempts'] };
const SCRYPT_BUSY = { 503: ['login_busy'] };

const passwordField = (description) => ({ type: 'string', minLength: 1, writeOnly: true, description });
const tokenField = (description) => ({ type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', writeOnly: true, description });

export const components = {
  LoginRequest: requestObject({
    email: {
      type: 'string', minLength: 1, maxLength: 320,
      description: 'Adres konta (wielkość liter bez znaczenia). Dłuższy niż 320 znaków → 400 `invalid_json`; adres w złym formacie '
        + 'daje ten sam 401 `invalid_credentials` co nieznany.',
    },
    password: passwordField('Hasło (najwyżej 1024 bajty UTF-8, inaczej 400 `password_too_long`). Nie trafia do logów, audytu ani odpowiedzi.'),
  }, ['email', 'password']),
  LoginResult: strictObject({
    mfaRequired: { ...BOOLEAN, description: 'true, gdy konto ma czynnik albo rolę z `MFA_REQUIRED_ROLES` — następny krok to `/api/mfa/verify` albo zapis MFA.' },
    mfaEnrolled: { ...BOOLEAN, description: 'Konto ma potwierdzony czynnik TOTP.' },
    mfaRequiredByRole: { ...BOOLEAN, description: 'Aktywny przydział roli z `MFA_REQUIRED_ROLES` (założenie D-10).' },
    mustChangePassword: { ...BOOLEAN, description: 'Hasło oznaczone do zmiany.' },
    mfaVerified: { const: false, description: 'Sesja po samym haśle nigdy nie ma potwierdzonego MFA.' },
    expiresAt: { ...ref('IsoDateTime'), description: 'Koniec sesji (najwyżej 24 h). Sekret sesji jest wyłącznie w cookie `Set-Cookie`.' },
  }, [], { description: 'Wynik logowania hasłem. Bez identyfikatora konta, ról i sekretu sesji.' }),
  AuthState: strictObject({
    authenticated: { const: true },
    mfaVerified: { ...BOOLEAN, description: 'Bieżąca sesja ma potwierdzone MFA.' },
    mfaEnrolled: BOOLEAN,
    mfaRequired: BOOLEAN,
    mfaRequiredByRole: BOOLEAN,
    hasPassword: { ...BOOLEAN, description: 'Konto ma ustawione hasło (sam fakt, bez hasha).' },
    mustChangePassword: BOOLEAN,
    expiresAt: ref('IsoDateTime'),
  }, [], { description: 'Stan MFA i hasła bieżącej sesji dla ekranu logowania (#99).' }),
  InvitationPreviewRequest: requestObject({
    token: tokenField('Jednorazowy token z linku zaproszenia (część `#invite=…`, 43 znaki base64url). Podgląd go nie zużywa.'),
  }, ['token']),
  InvitationPreview: strictObject({
    email: {
      type: 'string', pattern: '^[^@]{1,2}…@[^@]+$',
      description: 'Adres zaproszenia zamaskowany: pierwszy znak, wielokropek, domena (#164).',
    },
    role: ref('Role'),
    className: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Nazwa klasy przydziału klasowego.' },
    schoolYear: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Etykieta roku szkolnego przydziału.' },
    expiresAt: ref('IsoDateTime'),
    accountExists: {
      ...BOOLEAN,
      description: 'true = konto z tym adresem ma już hasło: przyjęcie wymaga obecnego hasła, rola zostanie dopisana. '
        + 'Widzi to wyłącznie posiadacz ważnego tokenu (#164).',
    },
  }, [], { description: 'Podgląd zaproszenia przed przyjęciem: bez zapraszającego, identyfikatorów i pełnego adresu.' }),
  InvitationAcceptRequest: requestObject({
    token: tokenField('Jednorazowy token z linku zaproszenia (43 znaki base64url).'),
    password: passwordField('Nowe konto: nowe hasło (polityka 12-128 znaków po NFKC, bez popularnych haseł i adresu e-mail). '
      + 'Konto z hasłem: jego OBECNE hasło (błędne → 401 `invalid_credentials`). Najwyżej 1024 bajty UTF-8.'),
    passwordRepeat: passwordField('Powtórzenie hasła; wymagane przy tworzeniu konta (#164), inaczej 400 `password_mismatch`.'),
    displayName: {
      anyOf: [{ type: 'string', maxLength: 100 }, { type: 'null' }],
      description: 'Nazwa wyświetlana nowego konta (do 100 znaków po usunięciu znaków sterujących); brak = część lokalna adresu.',
    },
  }, ['token', 'password']),
  InvitationAcceptResult: strictObject({
    mfaRequired: BOOLEAN,
    mfaEnrolled: BOOLEAN,
    mfaRequiredByRole: BOOLEAN,
    created: { ...BOOLEAN, description: 'true = powstało nowe konto; false = rola dopisana do istniejącego konta.' },
    mfaVerified: { const: false },
    expiresAt: { ...ref('IsoDateTime'), description: 'Koniec nowej sesji (sekret wyłącznie w cookie `Set-Cookie`).' },
  }, [], { description: 'Zaproszenie przyjęte: konto (nowe albo istniejące), przydział roli i sesja bez MFA.' }),
  PasswordResetRequest: requestObject({
    token: tokenField('Jednorazowy token resetu wydany przez administratora (`POST /api/admin/users/{id}/password-reset`), 43 znaki base64url.'),
    newPassword: passwordField('Nowe hasło (polityka 12-128 znaków po NFKC; najwyżej 1024 bajty UTF-8).'),
  }, ['token', 'newPassword']),
  PasswordResetResult: strictObject({ ok: { const: true } }, [], {
    description: 'Hasło ustawione, wszystkie sesje konta wycofane; reset nie tworzy sesji (dalej logowanie hasłem i MFA).',
  }),
  PasswordChangeRequest: requestObject({
    currentPassword: passwordField('Obecne hasło (błędne → 400 `invalid_current_password`, liczone do limitu prób).'),
    newPassword: passwordField('Nowe hasło (polityka 12-128 znaków po NFKC, inne niż obecne).'),
  }, ['currentPassword', 'newPassword']),
  PasswordChangeResult: strictObject({
    revokedSessions: { ...ref('Count'), description: 'Liczba wycofanych INNYCH sesji konta.' },
    expiresAt: { ...ref('IsoDateTime'), description: 'Koniec zrotowanej bieżącej sesji (nowy sekret w cookie, termin bez przedłużenia).' },
  }, [], { description: 'Hasło zmienione; bieżąca sesja zrotowana z tym samym stanem MFA, inne wycofane.' }),
};

/** Klucz: `METODA /ścieżka-openapi` (jak w docs/openapi.json). */
export const routes = {
  'POST /api/login': {
    body: ref('LoginRequest'),
    responses: {
      200: { description: 'Sesja bez MFA (cookie `Set-Cookie`) i stan kolejnego kroku.', schema: ref('LoginResult') },
    },
    errors: mergeErrors(BODY_ERRORS, ATTEMPT_LIMIT, SCRYPT_BUSY, {
      400: ['password_too_long'],
      401: ['invalid_credentials'],
    }),
    errorDescriptions: {
      401: 'Nieznany adres, złe hasło, konto wyłączone albo bez hasła — jedna, ta sama odpowiedź (bez wyroczni istnienia konta).',
      429: 'Limit prób pary (adres, IP) albo adresu IP — nagłówek Retry-After (sekundy).',
      503: 'Kolejka obliczeń scrypt pełna — nagłówek Retry-After: 5; próba nie jest liczona.',
    },
  },
  'GET /api/auth/state': {
    responses: {
      200: { description: 'Stan MFA i hasła bieżącej sesji.', schema: ref('AuthState') },
    },
    // Macierz przypisuje trasie odmowę 403, ale trasa jest dostępna dla każdego zalogowanego i zwolniona z bramki MFA.
    errors: { 403: [] },
  },
  'POST /api/invitations/preview': {
    body: ref('InvitationPreviewRequest'),
    responses: {
      200: { description: 'Podgląd zaproszenia; token nie jest zużywany, sesja nie powstaje.', schema: ref('InvitationPreview') },
    },
    errors: mergeErrors(BODY_ERRORS, ATTEMPT_LIMIT, { 400: ['invalid_invitation'] }),
    errorDescriptions: {
      429: 'Limit błędnych tokenów na adres IP (wspólny z przyjęciem zaproszenia i resetem) — nagłówek Retry-After.',
    },
  },
  'POST /api/invitations/accept': {
    body: ref('InvitationAcceptRequest'),
    responses: {
      201: { description: 'Zaproszenie przyjęte, sesja bez MFA w cookie `Set-Cookie`.', schema: ref('InvitationAcceptResult') },
    },
    errors: mergeErrors(BODY_ERRORS, NEW_PASSWORD_ERRORS, ATTEMPT_LIMIT, SCRYPT_BUSY, {
      400: ['invalid_display_name', 'invalid_invitation', 'password_mismatch'],
      401: ['invalid_credentials'],
      409: ['conflict'],
      422: ['school_year_required'],
    }),
    errorDescriptions: {
      401: 'Zaproszenie na adres konta z hasłem, a podane hasło nie jest jego obecnym hasłem.',
      409: 'Stan konta zmienił się między sprawdzeniem hasła a zapisem — ponów żądanie.',
      422: 'Zaproszenie dyrekcji bez roku szkolnego (sprzed wymogu roku): nie zostaje zużyte; administrator wystawia nowe.',
      429: 'Limit błędnych tokenów na IP albo błędnych haseł istniejącego konta — nagłówek Retry-After.',
      503: 'Kolejka obliczeń scrypt pełna — nagłówek Retry-After: 5; token nie jest zużyty, ponowienie jest bezpieczne.',
    },
  },
  'POST /api/password/reset': {
    body: ref('PasswordResetRequest'),
    responses: {
      200: { description: 'Hasło ustawione, sesje konta wycofane; bez sesji i bez cookie.', schema: ref('PasswordResetResult') },
    },
    errors: mergeErrors(BODY_ERRORS, NEW_PASSWORD_ERRORS, ATTEMPT_LIMIT, SCRYPT_BUSY, { 400: ['invalid_token'] }),
    errorDescriptions: {
      429: 'Limit błędnych tokenów na adres IP — nagłówek Retry-After.',
      503: 'Kolejka obliczeń scrypt pełna — nagłówek Retry-After: 5; token nie jest zużyty.',
    },
  },
  'POST /api/password/change': {
    body: ref('PasswordChangeRequest'),
    responses: {
      200: { description: 'Hasło zmienione; nowy sekret bieżącej sesji w cookie `Set-Cookie`.', schema: ref('PasswordChangeResult') },
    },
    errors: mergeErrors(BODY_ERRORS, NEW_PASSWORD_ERRORS, ATTEMPT_LIMIT, SCRYPT_BUSY, {
      400: ['invalid_current_password', 'password_unchanged'],
      403: ['mfa_enrollment_required', 'mfa_required'],
      409: ['conflict'],
    }),
    errorDescriptions: {
      409: 'Hasło zmieniło się w międzyczasie (np. drugie kliknięcie) — odśwież i spróbuj ponownie.',
      429: 'Limit błędnych obecnych haseł (para adres konta i IP, adres IP) — nagłówek Retry-After.',
      503: 'Kolejka obliczeń scrypt pełna — nagłówek Retry-After: 5; hasło i sesje bez zmian.',
    },
  },
};
