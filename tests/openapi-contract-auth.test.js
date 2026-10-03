// Kontrakt API (#160, etap 11): prawdziwe odpowiedzi modułów `login` i `mfa` (PGlite, dane syntetyczne
// `@example.invalid`, hasła generowane w teście) walidowane schematami z docs/openapi.json (src/pg/schemas/login.js,
// src/pg/schemas/mfa.js) przez tests/helpers/contract-client.js. Rejestr pokrycia i katalog kodów sprawdza
// tests/openapi-contract.test.js (wspólnie dla wszystkich pokrytych modułów).
//
// ŻADNEJ SIECI I ŻADNEJ WYSYŁKI: trasy logowania i MFA niczego nie wysyłają (reset hasła to token od administratora,
// bez e-maila — D-16/D-17), więc nie ma nawet atrapy transportu; globalna pułapka sieci musi zostać na zerze.
// Kody TOTP liczy test z sekretu zwróconego przy zapisie (RFC 6238, jak tests/pg-mfa.test.js).
//
// Przebieg: logowanie (sukces, jedna odpowiedź dla nieznanego konta, złego hasła, konta wyłączonego i bez hasła, limit
// prób pary i IP z Retry-After, pełna kolejka scrypt, okno serwisowe), stan sesji i zmiana hasła (bramka MFA routera,
// polityka haseł, limit), zaproszenia (podgląd bez zużycia, przyjęcie raz, ponowne użycie, wygasłe, istniejące konto,
// dyrekcja bez roku), reset hasła tokenem (polityka bez zużycia tokenu, użyty, wygasły, zastąpiony, limit IP), MFA (zapis,
// potwierdzenie z kodami odzyskiwania, ponowne użycie tego samego kodu odrzucone, kod odzyskiwania jednorazowy, blokada,
// wymiana czynnika z krokiem w górę, brak klucza), sesje własne (lista, cofnięcie własnej, cudza = nieistniejąca,
// cofnięcie wszystkich) oraz obcy Origin i błędy 400/401/403/404/409/413/415/422/429/503. Żadna odpowiedź poza
// jednorazowym zapisem MFA i potwierdzeniem nie zawiera sekretu, a żadna nie zawiera hasła ani tokenu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSessionSecret } from '../src/auth.js';
import { handlePgRequest } from '../src/pg/app.js';
import { createInvitation } from '../src/pg/auth.js';
import { issuePasswordReset, LOGIN_POLICY } from '../src/pg/login.js';
import { base32Decode, MFA_POLICY, totp } from '../src/pg/mfa.js';
import { hashPassword, MAX_CONCURRENT, MAX_WAITING, withSlot } from '../src/pg/password.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS, SCHEMA_MODULES } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import { createTestDb, networkGuardCalls, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;

const YEAR = 'y-2026';
const FOREIGN = 'https://obcy.example.invalid';
// Najniższy dozwolony koszt scrypt (N = 2^15) — szybsze testy; domyślnie 2^17.
const FAST = { SCRYPT_COST_LOG2: '15' };
const KEY_1 = randomBytes(32).toString('base64');
const KEY_2 = randomBytes(32).toString('base64');
const baseEnv = (db) => ({ db, MFA_ENCRYPTION_KEYS: `1:${KEY_1}`, LOGIN_EMAIL_DELAY_MS: '0', ...FAST });

let ipCounter = 0;
const nextIp = () => `198.51.100.${(++ipCounter % 250) + 1}`;
let ipBlock = 0;
// Osobny blok adresów dla scenariuszy limitu (192.0.2.0/24 — TEST-NET-1), żeby nie dzielić licznika IP z resztą.
const limitIp = () => `192.0.2.${++ipBlock}`;
const newPassword = () => `Syntetyczne haslo ${randomBytes(6).toString('hex')}`;
const codeAt = (secret, offsetSteps = 0) => totp(base32Decode(secret), Date.now() + offsetSteps * 30_000);
const cookieFrom = (response) => {
  const header = response.headers.get('Set-Cookie');
  assert.ok(header, 'oczekiwano Set-Cookie');
  return header.split(';', 1)[0];
};

// Klient kontraktu z adresem IP klienta (nagłówek ustawiany w produkcji przez serwer Node) i rejestrem treści
// odpowiedzi — do sprawdzenia, że żadna odpowiedź nie zawiera hasła ani tokenu.
function authWorld(db, env = baseEnv(db)) {
  const client = createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
  const bodies = [];
  async function call(method, path, { ip = nextIp(), headers = {}, ...options }) {
    const response = await client.call(method, path, { ...options, headers: { 'x-rd-client-ip': ip, ...headers } });
    bodies.push({ route: `${method} ${response.template} ${response.status}`, text: JSON.stringify(response.body) });
    return response;
  }
  return { env, client, call, bodies };
}

// Odpowiedzi nie zawierają żadnej z tajnych wartości (hasła, tokeny); sekret TOTP i kody odzyskiwania — tylko
// w odpowiedziach z listy `allowed` (jednorazowy zapis i potwierdzenie).
function assertNoSecrets(bodies, secrets, allowed = []) {
  assert.ok(bodies.length > 0 && secrets.length > 0, 'są odpowiedzi i sekrety do sprawdzenia');
  const leaks = [];
  for (const { route, text } of bodies) {
    if (allowed.some((prefix) => route.startsWith(prefix))) continue;
    for (const secret of secrets) if (text.includes(secret)) leaks.push(`${route} zawiera sekret`);
  }
  assert.deepEqual(leaks, []);
}

async function seedPasswordUser(db, { userId, password = newPassword(), disabled = false, roles = [] }) {
  await seedUser(db, { userId, disabled });
  for (const grant of roles) {
    await db.query('INSERT INTO role_grants (id, user_id, role, class_id, school_year_id) VALUES ($1, $2, $3, $4, $5)',
      [crypto.randomUUID(), userId, grant.role, grant.classId ?? null, grant.schoolYearId ?? null]);
  }
  await db.query("INSERT INTO user_passwords (user_id, hash, set_reason) VALUES ($1, $2, 'invitation')",
    [userId, await hashPassword(password, { env: FAST })]);
  return { userId, email: `${userId}@example.invalid`, password };
}

async function seedWorld() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedUser(db, { userId: 'u-admin-auth' });
  return db;
}

// Odpowiedzi sukcesu, które waliduje każdy scenariusz (każdy test ma własną bazę i klienta). Test specyfikacji niżej
// sprawdza, że suma list to dokładnie wszystkie odpowiedzi sukcesu ze schematów modułów `login` i `mfa`.
const SUCCESS_BY_SCENARIO = {
  login: ['POST /api/login 200'],
  change: ['GET /api/auth/state 200', 'POST /api/password/change 200'],
  invitations: ['POST /api/invitations/preview 200', 'POST /api/invitations/accept 201'],
  reset: ['POST /api/password/reset 200'],
  mfa: ['POST /api/mfa/enroll 201', 'POST /api/mfa/confirm 200', 'POST /api/mfa/verify 200', 'POST /api/mfa/recovery 200'],
  sessions: ['GET /api/sessions 200', 'POST /api/sessions/{id}/revoke 200', 'POST /api/sessions/revoke-all 200'],
};

// Odpowiedzi sukcesu scenariusza zostały zwalidowane na prawdziwych odpowiedziach.
function assertSuccessCoverage(validated, scenario) {
  const expected = SUCCESS_BY_SCENARIO[scenario];
  assert.ok(expected.length > 0, scenario);
  assert.deepEqual(expected.filter((item) => !validated.has(item)), [], 'odpowiedzi sukcesu bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje 400 (schemat i serwer zgodnie).
async function assertRequiredFieldsEnforced(call, path, validBody, schemaName, options = {}) {
  const { required } = components[schemaName];
  assert.ok(required.length > 0, `${schemaName}: schemat ma wymagane pola`);
  for (const field of required) {
    const { [field]: omitted, ...body } = validBody;
    assert.notEqual(omitted, undefined, `${field}: ciało testowe ma to pole`);
    const response = await call('POST', path, { ...options, body, expect: 400, invalidRequest: true });
    assert.equal(response.body.error, 'invalid_json', `${schemaName}.${field}`);
  }
}

// Błędy wspólne ciała JSON: obcy Origin, zły typ treści, ciało za duże, niepoprawny JSON (także tablica).
async function assertBodyErrors(call, path, validBody, options = {}) {
  assert.equal((await call('POST', path, { ...options, body: validBody, origin: FOREIGN, expect: 403 })).body.error, 'invalid_origin');
  assert.equal((await call('POST', path, { ...options, body: validBody, origin: false, expect: 403 })).body.error, 'invalid_origin');
  const text = { 'Content-Type': 'text/plain' };
  assert.equal((await call('POST', path, { ...options, body: JSON.stringify(validBody), headers: text, expect: 415, invalidRequest: true })).body.error,
    'invalid_content_type');
  assert.equal((await call('POST', path, { ...options, body: { ...validBody, padding: 'x'.repeat(5000) }, expect: 413 })).body.error,
    'request_too_large');
  const json = { 'Content-Type': 'application/json' };
  for (const raw of ['{', '[]', 'null', '']) {
    assert.equal((await call('POST', path, { ...options, body: raw, headers: json, expect: 400, invalidRequest: true })).body.error,
      'invalid_json', `ciało ${JSON.stringify(raw)}`);
  }
}

// Atrapa zajmuje wszystkie trwające i oczekujące miejsca kolejki scrypt (#203) na czas `fn`.
async function withFullScryptQueue(fn) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const occupied = Array.from({ length: MAX_CONCURRENT + MAX_WAITING }, () => withSlot(() => held).catch(() => {}));
  try {
    return await fn();
  } finally {
    release();
    await Promise.all(occupied);
  }
}

// --- Specyfikacja: pola tajne -----------------------------------------------------------

// Nazwy pól, które mogłyby nieść wartość tajną. Flagi logiczne (`hasPassword`, `mustChangePassword`) mówią tylko o
// stanie konta, więc nie są tu liczone.
const SECRET_NAME = /pass|hash|token|secret|otpauth|recovery|cookie|ip|agent/i;

// Nazwy pól (z zagnieżdżonymi) schematu odpowiedzi, poza flagami logicznymi.
function propertyNames(schema, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    if (seen.has(name)) return [];
    seen.add(name);
    return propertyNames(components[name], seen);
  }
  const names = [];
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    if (child.type !== 'boolean') names.push(name);
    names.push(...propertyNames(child, seen));
  }
  for (const key of ['items', 'additionalProperties']) if (typeof schema[key] === 'object') names.push(...propertyNames(schema[key], seen));
  for (const key of ['anyOf', 'oneOf', 'allOf']) for (const part of schema[key] ?? []) names.push(...propertyNames(part, seen));
  return names;
}

test('specyfikacja login/mfa: odpowiedzi bez pól tajnych (poza jednorazowym zapisem i potwierdzeniem MFA), pola tajne żądań writeOnly', () => {
  const modules = SCHEMA_MODULES.filter((module) => ['login', 'mfa'].includes(module.name));
  assert.equal(modules.length, 2);
  const secretFields = [];
  let responses = 0;
  for (const module of modules) {
    for (const [routeId, entry] of Object.entries(module.routes)) {
      for (const [status, response] of Object.entries(entry.responses)) {
        responses += 1;
        for (const name of propertyNames(response.schema)) if (SECRET_NAME.test(name)) secretFields.push(`${routeId} ${status}: ${name}`);
      }
    }
  }
  assert.equal(responses, 13);
  // Jedyne pola tajne w odpowiedziach: sekret TOTP (z URI do kodu QR) przy zapisie i kody odzyskiwania przy potwierdzeniu.
  assert.deepEqual(secretFields.sort(), [
    'POST /api/mfa/confirm 200: recoveryCodes', 'POST /api/mfa/enroll 201: otpauthUri', 'POST /api/mfa/enroll 201: secret',
  ]);
  // Pola z hasłem, tokenem i kodem w żądaniach są oznaczone writeOnly.
  const requestSecrets = [];
  for (const name of ['LoginRequest', 'InvitationPreviewRequest', 'InvitationAcceptRequest', 'PasswordResetRequest',
    'PasswordChangeRequest', 'MfaCodeRequest', 'MfaRecoveryRequest']) {
    for (const [field, schema] of Object.entries(components[name].properties)) {
      if (/pass|token|code/i.test(field)) requestSecrets.push(`${name}.${field}:${schema.writeOnly === true}`);
    }
  }
  assert.equal(requestSecrets.length, 11);
  assert.deepEqual(requestSecrets.filter((item) => !item.endsWith(':true')), []);
  // Trasy publiczne bez sesji, trasy z sesją z cookie; 401 logowania opisuje złe dane, nie brak sesji.
  for (const path of ['/api/login', '/api/invitations/preview', '/api/invitations/accept', '/api/password/reset']) {
    assert.deepEqual(spec.paths[path].post.security, [], path);
  }
  assert.deepEqual(spec.paths['/api/password/change'].post.security, [{ sessionCookie: [] }]);
  assert.deepEqual(spec.paths['/api/login'].post.responses['401']['x-rd-error-codes'], ['invalid_credentials']);
  assert.equal(spec.paths['/api/mfa/verify'].post.responses['401'].$ref, '#/components/responses/Unauthenticated');
  // Scenariusze niżej walidują razem każdą odpowiedź sukcesu ze schematów obu modułów.
  const described = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (['login', 'mfa'].includes(entry.module)) for (const status of Object.keys(entry.responses)) described.push(`${routeId} ${status}`);
  }
  assert.deepEqual(Object.values(SUCCESS_BY_SCENARIO).flat().sort(), described.sort());
  // Żaden zapis modułów nie używa Idempotency-Key.
  const withKey = [...ROUTE_SCHEMAS].filter(([, entry]) => ['login', 'mfa'].includes(entry.module) && entry.idempotencyKey).map(([id]) => id);
  assert.deepEqual(withKey, []);
});

// --- Logowanie ----------------------------------------------------------------------------

test('kontrakt logowania: sukces, jedna odpowiedź dla nieznanego konta, złego hasła i konta wyłączonego, limit prób, kolejka scrypt', async () => {
  const guardBefore = networkGuardCalls();
  const db = await seedWorld();
  try {
    const { env, client, call, bodies } = authWorld(db);
    const rep = await seedPasswordUser(db, { userId: 'u-login-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] });
    const board = await seedPasswordUser(db, { userId: 'u-login-board', roles: [{ role: 'board', schoolYearId: YEAR }] });
    const disabled = await seedPasswordUser(db, { userId: 'u-login-off', disabled: true });
    await seedUser(db, { userId: 'u-login-nopass' });

    // Sukces: sesja bez MFA w cookie HttpOnly, bez identyfikatora konta i ról w treści.
    const ok = await call('POST', '/api/login', { body: { email: rep.email, password: rep.password }, expect: 200 });
    assert.deepEqual(ok.body, { ...ok.body, mfaRequired: false, mfaEnrolled: false, mfaRequiredByRole: false, mustChangePassword: false, mfaVerified: false });
    assert.match(ok.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
    const boardLogin = await call('POST', '/api/login', { body: { email: `  ${board.email.toUpperCase()} `, password: board.password }, expect: 200 });
    assert.deepEqual([boardLogin.body.mfaRequired, boardLogin.body.mfaRequiredByRole, boardLogin.body.mfaEnrolled], [true, true, false]);

    // Nieznany adres, złe hasło, konto wyłączone, konto bez hasła i adres w złym formacie: ta sama odpowiedź (status,
    // treść, nagłówki) — bez wyroczni istnienia konta.
    const failures = [
      { email: 'nieznany@example.invalid', password: 'Zle haslo syntetyczne' },
      { email: rep.email, password: 'Zle haslo syntetyczne' },
      { email: disabled.email, password: disabled.password },
      { email: 'u-login-nopass@example.invalid', password: 'Zle haslo syntetyczne' },
      { email: 'to-nie-jest-adres', password: 'Zle haslo syntetyczne' },
    ];
    const shapes = [];
    for (const body of failures) {
      const response = await call('POST', '/api/login', { body, expect: 401 });
      assert.equal(response.headers.get('Set-Cookie'), null);
      shapes.push(JSON.stringify([response.body, [...response.headers].filter(([name]) => name !== 'date')]));
    }
    assert.equal(new Set(shapes).size, 1, `różne odpowiedzi odmowy: ${shapes.join(' | ')}`);
    assert.equal(JSON.parse(shapes[0])[0].error, 'invalid_credentials');

    // Limit pary (adres, IP): istniejące i nieistniejące konto dają tę samą sekwencję statusów; Retry-After w sekundach.
    const sequence = async (email) => {
      const ip = limitIp();
      const statuses = [];
      for (let attempt = 0; attempt <= LOGIN_POLICY.pairMaxFailures; attempt += 1) {
        const response = await call('POST', '/api/login', { ip, body: { email, password: `Zle haslo numer ${attempt}` }, expect: attempt < LOGIN_POLICY.pairMaxFailures - 1 ? 401 : 429 });
        statuses.push(response.status);
        if (response.status === 429) {
          assert.equal(response.body.error, 'too_many_attempts');
          assert.ok(Number(response.headers.get('Retry-After')) > 0);
        }
      }
      return { ip, statuses };
    };
    const known = await sequence(rep.email);
    const ghost = await sequence('ghost-limit@example.invalid');
    assert.deepEqual(known.statuses, [401, 401, 401, 401, 429, 429]);
    assert.deepEqual(ghost.statuses, known.statuses);
    // W czasie blokady pary poprawne hasło z tego IP też dostaje 429 (hasło nie jest sprawdzane); z innego IP — 200.
    await call('POST', '/api/login', { ip: known.ip, body: { email: rep.email, password: rep.password }, expect: 429 });
    await call('POST', '/api/login', { body: { email: rep.email, password: rep.password }, expect: 200 });
    // Limit samego IP (20 błędów z różnych adresów).
    const ip = limitIp();
    for (let attempt = 0; attempt < LOGIN_POLICY.ipMaxFailures; attempt += 1) {
      await call('POST', '/api/login', { ip, body: { email: `ip-${attempt}@example.invalid`, password: 'Zle haslo syntetyczne' }, expect: attempt < LOGIN_POLICY.ipMaxFailures - 1 ? 401 : 429 });
    }
    await call('POST', '/api/login', { ip, body: { email: board.email, password: board.password }, expect: 429 });

    // Pełna kolejka scrypt: 503 login_busy z Retry-After: 5, bez liczenia próby (potem logowanie z tego IP działa).
    const busyIp = limitIp();
    await withFullScryptQueue(async () => {
      const busy = await call('POST', '/api/login', { ip: busyIp, body: { email: rep.email, password: rep.password }, expect: 503 });
      assert.deepEqual([busy.body.error, busy.headers.get('Retry-After')], ['login_busy', '5']);
    });
    await call('POST', '/api/login', { ip: busyIp, body: { email: rep.email, password: rep.password }, expect: 200 });

    // Okno serwisowe: logowanie zostaje możliwe (zwolnione z trybu tylko do odczytu).
    env.APP_WRITE_MODE = 'read_only';
    await call('POST', '/api/login', { body: { email: rep.email, password: rep.password }, expect: 200 });
    delete env.APP_WRITE_MODE;

    // Błędy wejścia: obcy/brak Origin, 415, 413, niepoprawny JSON, brak pól, hasło ponad 1024 bajty, adres ponad 320 znaków.
    const valid = { email: rep.email, password: rep.password };
    await assertBodyErrors(call, '/api/login', valid);
    await assertRequiredFieldsEnforced(call, '/api/login', valid, 'LoginRequest');
    assert.equal((await call('POST', '/api/login', { body: { email: rep.email, password: 'ą'.repeat(513) }, expect: 400 })).body.error, 'password_too_long');
    assert.equal((await call('POST', '/api/login', { body: { email: `${'a'.repeat(321)}@example.invalid`, password: 'x' }, expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    assert.equal((await call('POST', '/api/login', { body: { email: rep.email, password: 12345678901234 }, expect: 400, invalidRequest: true })).body.error, 'invalid_json');

    assertNoSecrets(bodies, [rep.password, board.password, disabled.password, cookieFrom(ok).split('=')[1]]);
    assertSuccessCoverage(client.validated, 'login');
    assert.equal(networkGuardCalls(), guardBefore, 'logowanie nie łączy się z siecią');
  } finally {
    await db.close();
  }
});

// --- Stan sesji i zmiana hasła ----------------------------------------------------------------

test('kontrakt zmiany hasła i stanu sesji: bramka MFA routera, polityka haseł, limit prób, rotacja sesji', async () => {
  const db = await seedWorld();
  try {
    const { call, client, bodies } = authWorld(db);
    const account = await seedPasswordUser(db, { userId: 'u-change' });
    const loginOf = async (who, password = who.password) => cookieFrom(await call('POST', '/api/login', { body: { email: who.email, password }, expect: 200 }));
    const cookie = await loginOf(account);
    const other = await loginOf(account);

    // Stan sesji dla ekranu logowania: bez sesji 401; dla konta z hasłem bez czynnika — hasło jest, MFA nie.
    await call('GET', '/api/auth/state', { expect: 401 });
    const state = await call('GET', '/api/auth/state', { cookie, expect: 200 });
    assert.deepEqual(state.body, { ...state.body, authenticated: true, mfaVerified: false, mfaEnrolled: false, hasPassword: true, mustChangePassword: false });
    const noPassword = await seedUserSession(db, { userId: 'u-change-nopass' });
    assert.equal((await call('GET', '/api/auth/state', { cookie: noPassword, expect: 200 })).body.hasPassword, false);

    // Błędy: brak sesji 401, wejście, obecne hasło, polityka nowego hasła, to samo hasło.
    const valid = { currentPassword: account.password, newPassword: newPassword() };
    await call('POST', '/api/password/change', { body: valid, expect: 401 });
    await assertBodyErrors(call, '/api/password/change', valid, { cookie });
    await assertRequiredFieldsEnforced(call, '/api/password/change', valid, 'PasswordChangeRequest', { cookie });
    const refused = [
      [{ currentPassword: 'Zle obecne haslo syntetyczne', newPassword: newPassword() }, 'invalid_current_password'],
      [{ currentPassword: account.password, newPassword: 'krotkie' }, 'password_too_short'],
      [{ currentPassword: account.password, newPassword: 'x'.repeat(129) }, 'password_too_long'],
      [{ currentPassword: account.password, newPassword: 'qwerty123456' }, 'password_common'],
      [{ currentPassword: account.password, newPassword: `${account.email} 2026` }, 'password_contains_email'],
      [{ currentPassword: account.password, newPassword: account.password }, 'password_unchanged'],
    ];
    for (const [body, code] of refused) assert.equal((await call('POST', '/api/password/change', { cookie, body, expect: 400 })).body.error, code);

    // Sukces: inne sesje wycofane, bieżąca zrotowana (stare cookie przestaje działać), nowe hasło działa.
    const changed = await call('POST', '/api/password/change', { cookie, body: valid, expect: 200 });
    assert.equal(changed.body.revokedSessions, 1);
    const rotated = cookieFrom(changed);
    await call('GET', '/api/auth/state', { cookie, expect: 401 });
    await call('GET', '/api/auth/state', { cookie: other, expect: 401 });
    await call('GET', '/api/auth/state', { cookie: rotated, expect: 200 });
    // Podwójne kliknięcie „Zmień” (to samo ciało): obecne hasło już nie pasuje.
    assert.equal((await call('POST', '/api/password/change', { cookie: rotated, body: valid, expect: 400 })).body.error, 'invalid_current_password');
    await loginOf(account, valid.newPassword);

    // Limit: błędne obecne hasło liczy się na parę (adres konta, IP) — piąty błąd daje 429 z Retry-After.
    const ip = limitIp();
    for (let attempt = 0; attempt < LOGIN_POLICY.pairMaxFailures; attempt += 1) {
      const response = await call('POST', '/api/password/change', {
        ip, cookie: rotated, body: { currentPassword: `Zle obecne haslo ${attempt}`, newPassword: newPassword() },
        expect: attempt < LOGIN_POLICY.pairMaxFailures - 1 ? 400 : 429,
      });
      if (response.status === 429) assert.ok(Number(response.headers.get('Retry-After')) > 0);
    }

    // Bramka MFA routera (trasa nie jest zwolniona): zarząd bez czynnika i konto z czynnikiem bez potwierdzenia w sesji.
    const board = await seedPasswordUser(db, { userId: 'u-change-board', roles: [{ role: 'board', schoolYearId: YEAR }] });
    const boardCookie = await loginOf(board);
    const boardBody = { currentPassword: board.password, newPassword: newPassword() };
    assert.equal((await call('POST', '/api/password/change', { cookie: boardCookie, body: boardBody, expect: 403 })).body.error, 'mfa_enrollment_required');
    const enrolled = await call('POST', '/api/mfa/enroll', { cookie: boardCookie, expect: 201 });
    const confirmed = await call('POST', '/api/mfa/confirm', { cookie: boardCookie, body: { code: codeAt(enrolled.body.secret) }, expect: 200 });
    const passwordOnly = await loginOf(board);
    assert.equal((await call('POST', '/api/password/change', { cookie: passwordOnly, body: boardBody, expect: 403 })).body.error, 'mfa_required');
    // Stan sesji jest zwolniony z bramki: sesja po samym haśle widzi, że trzeba potwierdzić MFA.
    const gated = await call('GET', '/api/auth/state', { cookie: passwordOnly, expect: 200 });
    assert.deepEqual([gated.body.mfaVerified, gated.body.mfaEnrolled, gated.body.mfaRequired], [false, true, true]);
    await call('POST', '/api/password/change', { cookie: cookieFrom(confirmed), body: boardBody, expect: 200 });

    assertNoSecrets(bodies, [account.password, valid.newPassword, board.password, boardBody.newPassword], ['POST /api/mfa/']);
    assertSuccessCoverage(client.validated, 'change');
  } finally {
    await db.close();
  }
});

// --- Zaproszenia ------------------------------------------------------------------------------

test('kontrakt zaproszeń: podgląd bez zużycia, przyjęcie raz, ponowne użycie, wygasłe, istniejące konto, dyrekcja bez roku, limit IP', async () => {
  const db = await seedWorld();
  try {
    const { env, call, client, bodies } = authWorld(db);
    const invite = (email, role = 'representative', extra = { classId: 'c-1a' }) => createInvitation(env, {
      actorId: 'u-admin-auth', email, role, schoolYearId: YEAR, ...extra,
    });
    const email = 'nowy.przedstawiciel@example.invalid';
    const { secret: token } = await invite(email);

    // Podgląd: zamaskowany adres, rola, klasa, rok, termin; bez sesji; token nie jest zużyty (dwa razy to samo).
    const preview = await call('POST', '/api/invitations/preview', { body: { token }, expect: 200 });
    assert.deepEqual({ ...preview.body, expiresAt: undefined }, {
      email: 'n…@example.invalid', role: 'representative', className: '1A', schoolYear: preview.body.schoolYear,
      expiresAt: undefined, accountExists: false,
    });
    assert.equal(preview.headers.get('Set-Cookie'), null);
    assert.deepEqual((await call('POST', '/api/invitations/preview', { body: { token }, expect: 200 })).body, preview.body);
    await assertBodyErrors(call, '/api/invitations/preview', { token });
    await assertRequiredFieldsEnforced(call, '/api/invitations/preview', { token }, 'InvitationPreviewRequest');
    for (const bad of ['x'.repeat(43), 'zly token']) {
      assert.equal((await call('POST', '/api/invitations/preview', { body: { token: bad }, expect: 400, invalidRequest: bad.length !== 43 })).body.error, 'invalid_invitation');
    }

    // Przyjęcie: powtórzenie hasła, polityka, nazwa wyświetlana — każda odmowa przed zapisem (token dalej ważny).
    const password = newPassword();
    const valid = { token, password, passwordRepeat: password, displayName: 'Przedstawiciel Syntetyczny' };
    await assertBodyErrors(call, '/api/invitations/accept', valid);
    await assertRequiredFieldsEnforced(call, '/api/invitations/accept', valid, 'InvitationAcceptRequest');
    const refused = [
      [{ ...valid, passwordRepeat: 'inne haslo syntetyczne' }, 'password_mismatch', false],
      [{ token, password }, 'password_mismatch', false],
      [{ ...valid, password: 'krotkie', passwordRepeat: 'krotkie' }, 'password_too_short', false],
      [{ ...valid, password: 'x'.repeat(129), passwordRepeat: 'x'.repeat(129) }, 'password_too_long', false],
      [{ ...valid, password: 'qwerty123456', passwordRepeat: 'qwerty123456' }, 'password_common', false],
      [{ ...valid, password: `${email} 1`, passwordRepeat: `${email} 1` }, 'password_contains_email', false],
      [{ ...valid, password: 'ą'.repeat(513) }, 'password_too_long', false],
      [{ ...valid, displayName: 'x'.repeat(101) }, 'invalid_display_name', true],
      [{ ...valid, displayName: '   ' }, 'invalid_display_name', false],
      [{ ...valid, displayName: 7 }, 'invalid_display_name', true],
    ];
    for (const [body, code, invalidRequest] of refused) {
      assert.equal((await call('POST', '/api/invitations/accept', { body, expect: 400, invalidRequest })).body.error, code);
    }
    const accepted = await call('POST', '/api/invitations/accept', { body: valid, expect: 201 });
    assert.deepEqual(accepted.body, { ...accepted.body, created: true, mfaVerified: false, mfaEnrolled: false });
    assert.match(accepted.headers.get('Set-Cookie'), /HttpOnly/);
    await call('GET', '/api/auth/state', { cookie: cookieFrom(accepted), expect: 200 });

    // Ponowne użycie tego samego tokenu (podwójne kliknięcie) i podgląd po przyjęciu: ten sam 400 invalid_invitation
    // co token nieznany (kod `already_used` nie istnieje — brak rozróżnienia stanów tokenu).
    assert.equal((await call('POST', '/api/invitations/accept', { body: valid, expect: 400 })).body.error, 'invalid_invitation');
    assert.equal((await call('POST', '/api/invitations/preview', { body: { token }, expect: 400 })).body.error, 'invalid_invitation');
    await call('POST', '/api/login', { body: { email, password }, expect: 200 });

    // Wygasłe zaproszenie: ten sam kod, konto nie powstaje.
    const expired = await createSessionSecret();
    await db.query(
      `INSERT INTO invitations (id, email, token_hash, role, school_year_id, created_by, created_at, expires_at)
       VALUES ($1, 'wygasle@example.invalid', $2, 'board', $3, 'u-admin-auth', now() - interval '4 days', now() - interval '1 day')`,
      [crypto.randomUUID(), expired.tokenHash, YEAR],
    );
    const expiredPassword = newPassword();
    assert.equal((await call('POST', '/api/invitations/accept', { body: { token: expired.secret, password: expiredPassword, passwordRepeat: expiredPassword }, expect: 400 })).body.error, 'invalid_invitation');
    assert.equal((await call('POST', '/api/invitations/preview', { body: { token: expired.secret }, expect: 400 })).body.error, 'invalid_invitation');

    // Istniejące konto z hasłem: podgląd mówi accountExists, przyjęcie wymaga OBECNEGO hasła (złe → 401), rola dopisana.
    const existing = await seedPasswordUser(db, { userId: 'u-invite-existing' });
    const second = await invite(existing.email, 'board', {});
    assert.equal((await call('POST', '/api/invitations/preview', { body: { token: second.secret }, expect: 200 })).body.accountExists, true);
    const wrong = await call('POST', '/api/invitations/accept', { body: { token: second.secret, password: 'Inne haslo niz obecne' }, expect: 401 });
    assert.equal(wrong.body.error, 'invalid_credentials');
    const joined = await call('POST', '/api/invitations/accept', { body: { token: second.secret, password: existing.password }, expect: 201 });
    assert.deepEqual([joined.body.created, joined.body.mfaRequiredByRole], [false, true]);

    // Dyrekcja bez roku szkolnego (zaproszenie sprzed wymogu): 422, zaproszenie nie zostaje zużyte.
    const principal = await createSessionSecret();
    const principalId = crypto.randomUUID();
    await db.query(
      `INSERT INTO invitations (id, email, token_hash, role, school_year_id, created_by, expires_at)
       VALUES ($1, 'dyrekcja.bez.roku@example.invalid', $2, 'principal', NULL, 'u-admin-auth', now() + interval '1 day')`,
      [principalId, principal.tokenHash],
    );
    const principalPassword = newPassword();
    const noYear = await call('POST', '/api/invitations/accept', {
      body: { token: principal.secret, password: principalPassword, passwordRepeat: principalPassword }, expect: 422,
    });
    assert.equal(noYear.body.error, 'school_year_required');
    assert.equal((await db.query('SELECT accepted_at FROM invitations WHERE id = $1', [principalId])).rows[0].accepted_at, null);

    // Limit IP: 20 błędnych tokenów (podgląd i przyjęcie liczą się razem) → 429 z Retry-After, także dla ważnego tokenu.
    const ip = limitIp();
    for (let attempt = 0; attempt < LOGIN_POLICY.ipMaxFailures; attempt += 1) {
      const path = attempt % 2 ? '/api/invitations/preview' : '/api/invitations/accept';
      const body = attempt % 2 ? { token: 'y'.repeat(43) } : { token: 'y'.repeat(43), password: 'Zle haslo syntetyczne' };
      await call('POST', path, { ip, body, expect: attempt < LOGIN_POLICY.ipMaxFailures - 1 ? 400 : 429 });
    }
    const third = await invite('limit.ip@example.invalid');
    const blocked = await call('POST', '/api/invitations/preview', { ip, body: { token: third.secret }, expect: 429 });
    assert.deepEqual([blocked.body.error, Number(blocked.headers.get('Retry-After')) > 0], ['too_many_attempts', true]);
    const thirdPassword = newPassword();
    await call('POST', '/api/invitations/accept', { ip, body: { token: third.secret, password: thirdPassword, passwordRepeat: thirdPassword }, expect: 429 });

    assertNoSecrets(bodies, [token, password, expired.secret, existing.password, second.secret, principal.secret, third.secret]);
    assertSuccessCoverage(client.validated, 'invitations');
  } finally {
    await db.close();
  }
});

// --- Reset hasła tokenem ------------------------------------------------------------------------

test('kontrakt resetu hasła: polityka bez zużycia tokenu, sukces bez sesji, token użyty, wygasły i zastąpiony, limit IP', async () => {
  const db = await seedWorld();
  try {
    const { env, call, client, bodies } = authWorld(db);
    const account = await seedPasswordUser(db, { userId: 'u-reset' });
    const cookie = cookieFrom(await call('POST', '/api/login', { body: { email: account.email, password: account.password }, expect: 200 }));
    const issue = () => issuePasswordReset(env, { actorId: 'u-admin-auth', userId: account.userId });
    const superseded = await issue();
    const { secret: token } = await issue();

    const valid = { token, newPassword: newPassword() };
    await assertBodyErrors(call, '/api/password/reset', valid);
    await assertRequiredFieldsEnforced(call, '/api/password/reset', valid, 'PasswordResetRequest');
    const refused = [
      [{ token, newPassword: 'krotkie' }, 'password_too_short'],
      [{ token, newPassword: 'x'.repeat(129) }, 'password_too_long'],
      [{ token, newPassword: 'ą'.repeat(513) }, 'password_too_long'],
      [{ token, newPassword: 'qwerty123456' }, 'password_common'],
      [{ token, newPassword: `${account.email} 7` }, 'password_contains_email'],
      // Token zastąpiony nowszym, nieznany i w złym formacie — ten sam kod.
      [{ token: superseded.secret, newPassword: newPassword() }, 'invalid_token'],
      [{ token: 'z'.repeat(43), newPassword: newPassword() }, 'invalid_token'],
    ];
    for (const [body, code] of refused) assert.equal((await call('POST', '/api/password/reset', { body, expect: 400 })).body.error, code);
    assert.equal((await call('POST', '/api/password/reset', { body: { token: 'zly', newPassword: newPassword() }, expect: 400, invalidRequest: true })).body.error, 'invalid_token');

    // Sukces: { ok: true }, bez cookie; wszystkie sesje konta wycofane; token jednorazowy.
    const done = await call('POST', '/api/password/reset', { body: valid, expect: 200 });
    assert.equal(done.headers.get('Set-Cookie'), null);
    await call('GET', '/api/auth/state', { cookie, expect: 401 });
    assert.equal((await call('POST', '/api/password/reset', { body: { token, newPassword: newPassword() }, expect: 400 })).body.error, 'invalid_token');
    await call('POST', '/api/login', { body: { email: account.email, password: account.password }, expect: 401 });
    await call('POST', '/api/login', { body: { email: account.email, password: valid.newPassword }, expect: 200 });

    // Token wygasły.
    const expired = await createSessionSecret();
    await db.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, 'u-admin-auth', now() - interval '3 hours', now() - interval '1 hour')`,
      [crypto.randomUUID(), account.userId, expired.tokenHash],
    );
    assert.equal((await call('POST', '/api/password/reset', { body: { token: expired.secret, newPassword: newPassword() }, expect: 400 })).body.error, 'invalid_token');

    // Pełna kolejka scrypt: 503 login_busy, token nie jest zużyty — ponowienie działa.
    const { secret: busyToken } = await issue();
    const busyBody = { token: busyToken, newPassword: newPassword() };
    await withFullScryptQueue(async () => {
      const busy = await call('POST', '/api/password/reset', { body: busyBody, expect: 503 });
      assert.deepEqual([busy.body.error, busy.headers.get('Retry-After')], ['login_busy', '5']);
    });
    await call('POST', '/api/password/reset', { body: busyBody, expect: 200 });

    // Limit IP błędnych tokenów → 429 także dla ważnego tokenu.
    const ip = limitIp();
    for (let attempt = 0; attempt < LOGIN_POLICY.ipMaxFailures; attempt += 1) {
      await call('POST', '/api/password/reset', { ip, body: { token: 'w'.repeat(43), newPassword: newPassword() }, expect: attempt < LOGIN_POLICY.ipMaxFailures - 1 ? 400 : 429 });
    }
    const { secret: lastToken } = await issue();
    assert.equal((await call('POST', '/api/password/reset', { ip, body: { token: lastToken, newPassword: newPassword() }, expect: 429 })).body.error, 'too_many_attempts');

    assertNoSecrets(bodies, [token, superseded.secret, expired.secret, busyToken, lastToken, account.password, valid.newPassword]);
    assertSuccessCoverage(client.validated, 'reset');
  } finally {
    await db.close();
  }
});

// --- MFA ----------------------------------------------------------------------------------------

test('kontrakt MFA: zapis, potwierdzenie z kodami odzyskiwania, ponowne użycie kodu odrzucone, kod odzyskiwania jednorazowy, blokada', async () => {
  const db = await seedWorld();
  try {
    const { env, call, client, bodies } = authWorld(db);
    const account = await seedPasswordUser(db, { userId: 'u-mfa', roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    const login = async () => cookieFrom(await call('POST', '/api/login', { body: { email: account.email, password: account.password }, expect: 200 }));
    const passwordCookie = await login();

    // Bez sesji: 401 na każdej trasie modułu.
    for (const path of ['/api/mfa/enroll', '/api/mfa/confirm', '/api/mfa/verify', '/api/mfa/recovery', '/api/sessions/revoke-all']) {
      await call('POST', path, { body: path.includes('enroll') || path.includes('revoke') ? undefined : { code: '000000' }, expect: 401 });
    }
    await call('GET', '/api/sessions', { expect: 401 });

    // Przed zapisem: brak oczekującego i potwierdzonego czynnika (409).
    assert.equal((await call('POST', '/api/mfa/confirm', { cookie: passwordCookie, body: { code: '123456' }, expect: 409 })).body.error, 'mfa_enrollment_not_found');
    assert.equal((await call('POST', '/api/mfa/verify', { cookie: passwordCookie, body: { code: '123456' }, expect: 409 })).body.error, 'mfa_not_enrolled');
    assert.equal((await call('POST', '/api/mfa/recovery', { cookie: passwordCookie, body: { code: 'AAAA-BBBB-CCCC-DDDD' }, expect: 409 })).body.error, 'mfa_not_enrolled');

    // Brak klucza szyfrowania: zapis i weryfikacja 503 mfa_unavailable (jawnie puste zmienne — bez wartości z procesu).
    const keyless = authWorld(db, { ...env, MFA_ENCRYPTION_KEYS: '', MFA_ENCRYPTION_KEY: '' });
    assert.equal((await keyless.call('POST', '/api/mfa/enroll', { cookie: passwordCookie, expect: 503 })).body.error, 'mfa_unavailable');
    assert.equal((await keyless.call('POST', '/api/mfa/confirm', { cookie: passwordCookie, body: { code: '123456' }, expect: 503 })).body.error, 'mfa_unavailable');
    assert.equal((await call('POST', '/api/mfa/enroll', { cookie: passwordCookie, origin: FOREIGN, expect: 403 })).body.error, 'invalid_origin');

    // Zapis: sekret i URI zwracane jeden raz; ponowny zapis zastępuje oczekujący czynnik.
    const first = await call('POST', '/api/mfa/enroll', { cookie: passwordCookie, expect: 201 });
    const enrolled = await call('POST', '/api/mfa/enroll', { cookie: passwordCookie, expect: 201 });
    assert.notEqual(enrolled.body.secret, first.body.secret);
    assert.ok(enrolled.body.otpauthUri.includes(`secret=${enrolled.body.secret}`));
    const { secret } = enrolled.body;

    // Potwierdzenie: błędy wejścia i błędny kod (stary oczekujący sekret), potem poprawny kod → 10 kodów, rotacja sesji.
    const confirmBody = { code: codeAt(secret) };
    await assertBodyErrors(call, '/api/mfa/confirm', confirmBody, { cookie: passwordCookie });
    await assertRequiredFieldsEnforced(call, '/api/mfa/confirm', confirmBody, 'MfaCodeRequest', { cookie: passwordCookie });
    assert.equal((await call('POST', '/api/mfa/confirm', { cookie: passwordCookie, body: { code: 7 }, expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    assert.equal((await call('POST', '/api/mfa/confirm', { cookie: passwordCookie, body: { code: codeAt(first.body.secret, 3) }, expect: 400 })).body.error, 'invalid_code');
    const confirmed = await call('POST', '/api/mfa/confirm', { cookie: passwordCookie, body: confirmBody, expect: 200 });
    const { recoveryCodes } = confirmed.body;
    assert.equal(new Set(recoveryCodes).size, 10);
    const mfaCookie = cookieFrom(confirmed);
    await call('GET', '/api/auth/state', { cookie: passwordCookie, expect: 401 });
    assert.equal((await call('GET', '/api/auth/state', { cookie: mfaCookie, expect: 200 })).body.mfaVerified, true);

    // Weryfikacja w nowej sesji: TEN SAM kod co przy potwierdzeniu jest odrzucony (krok już użyty), następny przyjęty,
    // a ten następny w kolejnej sesji — znów odrzucony.
    const second = await login();
    assert.equal((await call('POST', '/api/mfa/verify', { cookie: second, body: confirmBody, expect: 400 })).body.error, 'invalid_code');
    const nextCode = codeAt(secret, 1);
    const verified = await call('POST', '/api/mfa/verify', { cookie: second, body: { code: nextCode }, expect: 200 });
    assert.deepEqual(Object.keys(verified.body).sort(), ['expiresAt', 'mfaVerified']);
    await call('GET', '/api/auth/state', { cookie: second, expect: 401 });
    const third = await login();
    assert.equal((await call('POST', '/api/mfa/verify', { cookie: third, body: { code: nextCode }, expect: 400 })).body.error, 'invalid_code');
    await assertBodyErrors(call, '/api/mfa/verify', { code: nextCode }, { cookie: third });

    // Kod odzyskiwania: wielkość liter i myślniki bez znaczenia; jednorazowy (druga sesja → invalid_code).
    const recoveryBody = { code: recoveryCodes[0].toLowerCase().replaceAll('-', '') };
    await assertBodyErrors(call, '/api/mfa/recovery', recoveryBody, { cookie: third });
    await assertRequiredFieldsEnforced(call, '/api/mfa/recovery', recoveryBody, 'MfaRecoveryRequest', { cookie: third });
    await call('POST', '/api/mfa/recovery', { cookie: third, body: recoveryBody, expect: 200 });
    const fourth = await login();
    assert.equal((await call('POST', '/api/mfa/recovery', { cookie: fourth, body: { code: recoveryCodes[0] }, expect: 400 })).body.error, 'invalid_code');
    const fifth = await login();

    // Blokada: piąty błąd w sesji → 429 mfa_locked z Retry-After; w czasie blokady poprawny kod też jest odrzucony.
    const statuses = [];
    for (let attempt = 0; attempt < MFA_POLICY.maxFailures - 1; attempt += 1) {
      statuses.push((await call('POST', '/api/mfa/verify', { cookie: fifth, body: { code: 'abcdef' }, expect: 400 })).status);
    }
    const locked = await call('POST', '/api/mfa/verify', { cookie: fifth, body: { code: '00000x' }, expect: 429 });
    assert.deepEqual([statuses.length, locked.body.error, Number(locked.headers.get('Retry-After')) > 0], [4, 'mfa_locked', true]);
    assert.equal((await call('POST', '/api/mfa/verify', { cookie: fifth, body: { code: codeAt(secret, 1) }, expect: 429 })).body.error, 'mfa_locked');
    assert.equal((await call('POST', '/api/mfa/recovery', { cookie: fifth, body: { code: recoveryCodes[1] }, expect: 429 })).body.error, 'mfa_locked');

    // Sesja bez MFA nie zapisuje nowego czynnika (403 mfa_required); sesja z MFA sprzed ponad 15 min — 403 mfa_stale.
    const passwordOnly = await login();
    assert.equal((await call('POST', '/api/mfa/enroll', { cookie: passwordOnly, expect: 403 })).body.error, 'mfa_required');
    const stale = await seedUserSession(db, {
      userId: account.userId, mfa: true, createdAt: new Date(Date.now() - 20 * 60 * 1000), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.equal((await call('POST', '/api/mfa/enroll', { cookie: stale, expect: 403 })).body.error, 'mfa_stale');

    // Wymiana czynnika: świeża sesja z MFA zapisuje nowy; sesja po samym haśle nie może go potwierdzić (403 mfa_required);
    // potwierdzenie świeżą sesją unieważnia stare kody odzyskiwania.
    const fresh = await login();
    const freshVerified = cookieFrom(await call('POST', '/api/mfa/recovery', { cookie: fresh, body: { code: recoveryCodes[2] }, expect: 200 }));
    const replacement = await call('POST', '/api/mfa/enroll', { cookie: freshVerified, expect: 201 });
    const replacementBody = { code: codeAt(replacement.body.secret) };
    assert.equal((await call('POST', '/api/mfa/confirm', { cookie: passwordOnly, body: replacementBody, expect: 403 })).body.error, 'mfa_required');
    const replaced = await call('POST', '/api/mfa/confirm', { cookie: freshVerified, body: replacementBody, expect: 200 });
    assert.equal(replaced.body.recoveryCodes.filter((code) => recoveryCodes.includes(code)).length, 0);
    const afterReplace = await login();
    assert.equal((await call('POST', '/api/mfa/recovery', { cookie: afterReplace, body: { code: recoveryCodes[3] }, expect: 400 })).body.error, 'invalid_code');

    // Sekret TOTP i kody odzyskiwania tylko w odpowiedziach zapisu i potwierdzenia; hasło nigdzie.
    assertNoSecrets(bodies, [secret, replacement.body.secret, ...recoveryCodes, account.password], ['POST /api/mfa/enroll 201', 'POST /api/mfa/confirm 200']);
    assertNoSecrets(bodies, [account.password]);
    assertSuccessCoverage(client.validated, 'mfa');
  } finally {
    await db.close();
  }
});

test('kontrakt MFA: rotacja klucza — czynnik zaszyfrowany kluczem spoza pierścienia daje 503 mfa_key_missing, kod odzyskiwania działa bez klucza', async () => {
  const db = await seedWorld();
  try {
    const ring = authWorld(db, { ...baseEnv(db), MFA_ENCRYPTION_KEYS: `2:${KEY_2},1:${KEY_1}` });
    const oldRing = authWorld(db, { ...baseEnv(db), MFA_ENCRYPTION_KEYS: `1:${KEY_1}` });
    const keyless = authWorld(db, { ...baseEnv(db), MFA_ENCRYPTION_KEYS: '', MFA_ENCRYPTION_KEY: '' });
    const cookie = await seedUserSession(db, { userId: 'u-mfa-ring' });
    const enrolled = await ring.call('POST', '/api/mfa/enroll', { cookie, expect: 201 });
    const confirmed = await ring.call('POST', '/api/mfa/confirm', { cookie, body: { code: codeAt(enrolled.body.secret) }, expect: 200 });
    const mfaCookie = cookieFrom(confirmed);
    const missing = await oldRing.call('POST', '/api/mfa/verify', { cookie: mfaCookie, body: { code: codeAt(enrolled.body.secret, 1) }, expect: 503 });
    assert.equal(missing.body.error, 'mfa_key_missing');
    assert.equal((await keyless.call('POST', '/api/mfa/verify', { cookie: mfaCookie, body: { code: '123456' }, expect: 503 })).body.error, 'mfa_unavailable');
    await keyless.call('POST', '/api/mfa/recovery', { cookie: mfaCookie, body: { code: confirmed.body.recoveryCodes[0] }, expect: 200 });
  } finally {
    await db.close();
  }
});

// --- Sesje własne -------------------------------------------------------------------------------

test('kontrakt sesji własnych: lista, cofnięcie własnej, cudza i nieistniejąca jak brak, cofnięcie bieżącej i wszystkich', async () => {
  const db = await seedWorld();
  try {
    const { call, client } = authWorld(db);
    const account = await seedPasswordUser(db, { userId: 'u-sessions' });
    const login = async () => cookieFrom(await call('POST', '/api/login', { body: { email: account.email, password: account.password }, expect: 200 }));
    const [a, b, c] = [await login(), await login(), await login()];
    const stranger = await seedUserSession(db, { userId: 'u-sessions-other' });

    // Lista: wyłącznie sesje wołającego, bieżąca oznaczona; bez adresu IP i User-Agent (schemat ścisły).
    const listed = await call('GET', '/api/sessions', { cookie: a, expect: 200 });
    assert.equal(listed.body.sessions.length, 3);
    assert.deepEqual(listed.body.sessions.filter((item) => item.current).length, 1);
    const own = (await call('GET', '/api/sessions', { cookie: b, expect: 200 })).body.sessions;
    const idOfA = listed.body.sessions.find((item) => item.current).id;
    const idOfB = own.find((item) => item.current).id;
    const strangerId = (await call('GET', '/api/sessions', { cookie: stranger, expect: 200 })).body.sessions[0].id;
    assert.equal(listed.body.sessions.some((item) => item.id === strangerId), false, 'lista nie pokazuje cudzych sesji');

    // Cudza, nieistniejąca i już cofnięta sesja: identyczne 404 (bez wyroczni istnienia); obcy Origin 403.
    assert.equal((await call('POST', `/api/sessions/${idOfB}/revoke`, { cookie: a, origin: FOREIGN, expect: 403 })).body.error, 'invalid_origin');
    const revokedB = await call('POST', `/api/sessions/${idOfB}/revoke`, { cookie: a, expect: 200 });
    assert.equal(revokedB.headers.get('Set-Cookie'), null, 'cofnięcie innego urządzenia nie zmienia cookie tego żądania');
    await call('GET', '/api/sessions', { cookie: b, expect: 401 });
    const notFound = [];
    for (const id of [strangerId, crypto.randomUUID(), idOfB]) {
      const response = await call('POST', `/api/sessions/${id}/revoke`, { cookie: a, expect: 404 });
      notFound.push(JSON.stringify(response.body));
    }
    assert.deepEqual(new Set(notFound), new Set(['{"error":"not_found"}']));
    await call('GET', '/api/sessions', { cookie: stranger, expect: 200 });

    // Cofnięcie bieżącej: cookie wyczyszczone, sesja nie działa, ponowienie → 401.
    const self = await call('POST', `/api/sessions/${idOfA}/revoke`, { cookie: a, expect: 200 });
    assert.match(self.headers.get('Set-Cookie') ?? '', /Max-Age=0/i);
    await call('POST', `/api/sessions/${idOfA}/revoke`, { cookie: a, expect: 401 });

    // Cofnięcie wszystkich: konto bez czynnika — `all`; obcy Origin 403; ponowienie po wylogowaniu → 401.
    const d = await login();
    assert.equal((await call('POST', '/api/sessions/revoke-all', { cookie: c, origin: FOREIGN, expect: 403 })).body.error, 'invalid_origin');
    const all = await call('POST', '/api/sessions/revoke-all', { cookie: c, expect: 200 });
    assert.deepEqual(all.body, { revoked: 2, scope: 'all' });
    assert.match(all.headers.get('Set-Cookie') ?? '', /Max-Age=0/i);
    await call('GET', '/api/sessions', { cookie: d, expect: 401 });
    await call('POST', '/api/sessions/revoke-all', { cookie: c, expect: 401 });

    // Konto z czynnikiem: sesja po samym haśle wycofuje wyłącznie siebie (#189) — `current`.
    const e = await login();
    const enrolled = await call('POST', '/api/mfa/enroll', { cookie: e, expect: 201 });
    const verified = cookieFrom(await call('POST', '/api/mfa/confirm', { cookie: e, body: { code: codeAt(enrolled.body.secret) }, expect: 200 }));
    const passwordOnly = await login();
    assert.deepEqual((await call('POST', '/api/sessions/revoke-all', { cookie: passwordOnly, expect: 200 })).body, { revoked: 1, scope: 'current' });
    const remaining = await call('GET', '/api/sessions', { cookie: verified, expect: 200 });
    assert.deepEqual(remaining.body.sessions.map((item) => [item.current, item.mfaVerified]), [[true, true]]);

    assertSuccessCoverage(client.validated, 'sessions');
  } finally {
    await db.close();
  }
});
