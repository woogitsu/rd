// Logowanie e-mailem i hasłem + TOTP (issue #3, D-10). Wyłącznie dane syntetyczne
// (domeny .invalid), hasła wygenerowane w teście.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSessionSecret } from '../src/auth.js';
import { handlePgRequest } from '../src/pg/app.js';
import { createInvitation } from '../src/pg/auth.js';
import { base32Decode, totp } from '../src/pg/mfa.js';
import {
  checkPasswordPolicy, hashPassword, MAX_CONCURRENT, MAX_WAITING, needsRehash, parseHash, verifyPassword,
  verifyPasswordOrDummy, withSlot,
} from '../src/pg/password.js';
import { LOGIN_POLICY, scopeHash } from '../src/pg/login.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const KEY = randomBytes(32).toString('base64');
// Najniższy dozwolony koszt scrypt (N = 2^15) — szybsze testy; domyślnie 2^17.
const FAST = { SCRYPT_COST_LOG2: '15' };

let db;
let env;
before(async () => {
  db = await createTestDb();
  env = { db, MFA_ENCRYPTION_KEY: KEY, ...FAST };
  await seedSchoolYear(db, 'y-test');
});
after(async () => { await db?.close(); });

let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq}`;
const newPassword = () => `Syntetyczne haslo ${randomBytes(6).toString('hex')}`;

function cookieFrom(response) {
  const header = response.headers.get('Set-Cookie');
  assert.ok(header, 'Set-Cookie expected');
  return header.split(';', 1)[0];
}

function post(path, body, { cookie, ip = '203.0.113.250', origin, headers = {}, useEnv = env } = {}) {
  return handlePgRequest(request(path, { method: 'POST', body, cookie, origin, headers: { 'x-rd-client-ip': ip, ...headers } }), useEnv);
}
const get = (path, cookie, useEnv = env) => handlePgRequest(request(path, { cookie }), useEnv);

async function seedPasswordUser({ userId, roles = [], password = newPassword(), disabled = false } = {}) {
  await seedUser(db, { userId, disabled });
  for (const grant of roles) {
    if (grant.classId) await seedClass(db, { id: grant.classId, schoolYearId: grant.schoolYearId ?? 'y-test' });
    await db.query(
      'INSERT INTO role_grants (id, user_id, role, class_id, school_year_id) VALUES ($1, $2, $3, $4, $5)',
      [crypto.randomUUID(), userId, grant.role, grant.classId ?? null, grant.schoolYearId ?? null],
    );
  }
  await db.query(
    "INSERT INTO user_passwords (user_id, hash, set_reason) VALUES ($1, $2, 'invitation')",
    [userId, await hashPassword(password, { env: FAST })],
  );
  return { userId, email: `${userId}@example.invalid`, password };
}

async function login(account, { ip = nextIp(), password = account.password } = {}) {
  return post('/api/login', { email: account.email, password }, { ip });
}

const codeAt = (secretB32, offsetSteps = 0) => totp(base32Decode(secretB32), Date.now() + offsetSteps * 30_000);

async function enrollAndConfirm(cookie) {
  const enrolled = await post('/api/mfa/enroll', undefined, { cookie });
  assert.equal(enrolled.status, 201);
  const { secret } = await enrolled.json();
  const confirmed = await post('/api/mfa/confirm', { code: codeAt(secret) }, { cookie });
  assert.equal(confirmed.status, 200);
  const data = await confirmed.json();
  assert.equal(data.recoveryCodes.length, 10);
  return { secret, cookie: cookieFrom(confirmed), recoveryCodes: data.recoveryCodes };
}

async function auditRows(action) {
  const { rows } = await db.query('SELECT * FROM audit_events WHERE action = $1 ORDER BY occurred_at, id', [action]);
  return rows;
}

// --- password.js ---------------------------------------------------------------

test('hash scrypt: format z parametrami, poprawne i błędne hasło, unikalna sól', async () => {
  const password = 'poprawna bateria konia zszywka';
  const hash = await hashPassword(password, { env: FAST });
  assert.match(hash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(`${password} `, hash), false);
  assert.equal(await verifyPassword('Poprawna bateria konia zszywka', hash), false);
  assert.notEqual(await hashPassword(password, { env: FAST }), hash, 'sól musi być losowa');
  // NFKC: znak złożony i rozłożony dają ten sam wynik.
  const composed = await hashPassword('zażółć gęślą jaźń 12', { env: FAST });
  assert.equal(await verifyPassword('zażółć gęślą jaźń 12', composed), true);
  assert.equal(needsRehash(hash, FAST), false);
  assert.equal(needsRehash(hash, {}), true, 'domyślny koszt 2^17 wymaga przeliczenia');
  assert.equal(parseHash('scrypt$1024$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), null, 'zbyt słaby koszt odrzucony');
  assert.equal(parseHash('md5$abc'), null);
  // #203: N=2^20, r=16 z bazy (dopuszczone samym zakresem log2/r wcześniej) dają
  // 128·N·r ≈ 2 GiB na jedno obliczenie — traktowane jak nieprawidłowy hash
  // (fikcyjna weryfikacja niżej), bez próby alokacji tej pamięci.
  assert.equal(
    parseHash('scrypt$1048576$16$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    null,
    'koszt pamięciowy 128·N·r > budżetu jest odrzucony',
  );
  assert.equal(await verifyPasswordOrDummy('cokolwiek', 'scrypt$1048576$16$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', FAST), false);
  assert.equal(await verifyPasswordOrDummy('cokolwiek dluzszego', null, FAST), false);
});

test('polityka haseł NIST: długość, popularne hasła, adres e-mail, bez reguł składu', () => {
  assert.equal(checkPasswordPolicy('krotkie1!'), 'password_too_short');
  assert.equal(checkPasswordPolicy('x'.repeat(129)), 'password_too_long');
  assert.equal(checkPasswordPolicy('ą'.repeat(11)), 'password_too_short', 'liczone znaki, nie bajty');
  for (const common of ['password1234', 'Qwerty123456', 'haslo1234567', 'aaaaaaaaaaaa', 'abcabcabcabc', 'abcdefghijklmn', 'RadaRodzicow2026', 'haslohaslo12']) {
    assert.equal(checkPasswordPolicy(common), 'password_common', common);
  }
  assert.equal(checkPasswordPolicy('jan.kowalski2026', { email: 'jan.kowalski@example.invalid' }), 'password_contains_email');
  assert.equal(checkPasswordPolicy('tylko male litery i spacje'), null, 'bez wymogu cyfr i znaków specjalnych');
  assert.equal(checkPasswordPolicy('x'.repeat(10) + 'yz'), null);
});

// --- POST /api/login -----------------------------------------------------------

test('logowanie tworzy sesję bez MFA; ten sam błąd dla nieznanego e-maila i złego hasła', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-rep', roles: [{ role: 'representative', classId: 'c-login-1a', schoolYearId: 'y-test' }] });
  const ok = await login(account);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.mfaRequired, false);
  assert.equal(body.mfaEnrolled, false);
  assert.equal(body.mfaVerified, false);
  const cookie = cookieFrom(ok);
  assert.match(ok.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const session = await (await get('/api/session', cookie)).json();
  assert.equal(session.user.id, account.userId);
  assert.equal(session.mfaVerified, false);
  const { rows } = await db.query('SELECT mfa_verified_at FROM sessions WHERE id = $1', [session.sessionId]);
  assert.equal(rows[0].mfa_verified_at, null);

  // Wielkość liter i spacje w adresie nie mają znaczenia.
  const upper = await post('/api/login', { email: `  ${account.email.toUpperCase()} `, password: account.password }, { ip: nextIp() });
  assert.equal(upper.status, 200);

  const time = async (body) => {
    const started = process.hrtime.bigint();
    const response = await post('/api/login', body, { ip: nextIp() });
    return { response, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  };
  const wrong = await time({ email: account.email, password: 'zle haslo ale dlugie' });
  const unknown = await time({ email: 'nieznany-login@example.invalid', password: 'zle haslo ale dlugie' });
  const malformed = await time({ email: 'to-nie-jest-adres', password: 'zle haslo ale dlugie' });
  for (const { response } of [wrong, unknown, malformed]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid_credentials' });
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
  // Nieznany adres też liczy scrypt (fikcyjny hash): czas tego samego rzędu.
  assert.ok(unknown.ms > wrong.ms * 0.4, `nieznany e-mail ${unknown.ms.toFixed(1)} ms vs złe hasło ${wrong.ms.toFixed(1)} ms`);
  assert.ok(malformed.ms > wrong.ms * 0.4, `zły format ${malformed.ms.toFixed(1)} ms vs złe hasło ${wrong.ms.toFixed(1)} ms`);

  const succeeded = (await auditRows('auth.login_succeeded')).filter((row) => row.actor_id === account.userId);
  assert.ok(succeeded.length >= 2);
  const failed = await auditRows('auth.login_failed');
  assert.ok(failed.some((row) => row.entity_id === account.userId && row.metadata_json.reason === 'invalid_password' && row.actor_id === null));
  assert.ok(failed.some((row) => row.entity_type === 'login_attempt' && row.metadata_json.reason === 'unknown_account'));
});

test('limit prób: 5 błędów na e-mail i 20 na IP → 429 z Retry-After; poprawne hasło też czeka', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-limit' });
  const statuses = [];
  for (let attempt = 0; attempt < LOGIN_POLICY.emailMaxFailures; attempt += 1) {
    statuses.push((await login(account, { password: `zle haslo numer ${attempt}` })).status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  const blocked = await login(account);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: 'too_many_attempts' });
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  // Blokada dotyczy adresu, nie konta w bazie: nieznany adres zachowuje się tak samo.
  const ghost = { email: 'ghost-limit@example.invalid', password: 'x'.repeat(12) };
  const ghostStatuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) ghostStatuses.push((await post('/api/login', ghost, { ip: nextIp() })).status);
  assert.deepEqual(ghostStatuses, [401, 401, 401, 401, 429, 429]);
  // Po upływie blokady (symulacja) poprawne hasło działa i zeruje licznik e-maila.
  await db.query("UPDATE login_rate_limits SET locked_until = now() - interval '1 second' WHERE scope_hash = $1", [scopeHash('email', account.email)]);
  assert.equal((await login(account)).status, 200);
  const { rows } = await db.query('SELECT 1 FROM login_rate_limits WHERE scope_hash = $1', [scopeHash('email', account.email)]);
  assert.equal(rows.length, 0);

  // IP: 20 błędów z różnych adresów e-mail.
  const ip = '192.0.2.77';
  const ipStatuses = [];
  for (let attempt = 0; attempt < LOGIN_POLICY.ipMaxFailures; attempt += 1) {
    ipStatuses.push((await post('/api/login', { email: `ip-${attempt}@example.invalid`, password: 'y'.repeat(12) }, { ip })).status);
  }
  assert.equal(ipStatuses.at(-1), 429);
  assert.ok(ipStatuses.slice(0, -1).every((status) => status === 401));
  const fromIp = await login(account, { ip });
  assert.equal(fromIp.status, 429);
  assert.equal((await login(account, { ip: nextIp() })).status, 200, 'inny adres IP nie jest blokowany');

  // W tabeli limitów są tylko skróty — bez e-maili i adresów IP.
  const all = await db.query('SELECT scope_type, scope_hash FROM login_rate_limits');
  const dump = JSON.stringify(all.rows);
  assert.ok(!dump.includes('@') && !dump.includes(ip));
  assert.ok(all.rows.every((row) => /^[0-9a-f]{64}$/.test(row.scope_hash)));
});

// --- #186: atomowość limitu prób --------------------------------------------------------
// PGlite wykonuje zapytania i transakcje po kolei (jedno połączenie), ale scrypt liczy się poza
// bazą, więc równoległe żądania i tak przeplatają się między sprawdzeniem limitu a zapisem błędu.
// Testy odtwarzają ten przeplot; nie sprawdzają rywalizacji dwóch połączeń PostgreSQL o ten sam
// wiersz — tę zapewnia SELECT … FOR UPDATE w transakcji rezerwacji (test zapytań niżej).

async function limitRow(type, value) {
  const { rows } = await db.query(
    'SELECT failure_count, locked_until, locked_until > now() AS locked FROM login_rate_limits WHERE scope_type = $1 AND scope_hash = $2',
    [type, scopeHash(type, value)],
  );
  return rows[0] ?? null;
}
const failedFor = async (action, userId) => (await auditRows(action)).filter((row) => row.entity_id === userId).length;

test('#186: 30 równoległych błędnych haseł — najwyżej 5 sprawdzeń, reszta 429, blokada trwa', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-par30' });
  const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => login(account, { password: `zle haslo rownolegle ${i}` })));
  const statuses = responses.map((response) => response.status);
  assert.ok(statuses.every((status) => status === 401 || status === 429), statuses.join(','));
  assert.ok(await failedFor('auth.login_failed', account.userId) <= LOGIN_POLICY.emailMaxFailures,
    `sprawdzono ${await failedFor('auth.login_failed', account.userId)} haseł przy limicie ${LOGIN_POLICY.emailMaxFailures}`);
  assert.equal(statuses.filter((status) => status === 401).length <= LOGIN_POLICY.emailMaxFailures - 1, true);
  assert.equal((await limitRow('email', account.email)).locked, true);
  assert.equal((await login(account)).status, 429, 'poprawne hasło czeka na koniec blokady');
});

test('#186: 4 błędy po kolei + 2 równoległe — spóźniony błąd nie zdejmuje blokady', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-late' });
  for (let i = 0; i < 4; i += 1) assert.equal((await login(account, { password: `zle haslo ${i}` })).status, 401);
  const pair = await Promise.all([login(account, { password: 'zle haslo 5' }), login(account, { password: 'zle haslo 6' })]);
  assert.deepEqual(pair.map((response) => response.status).sort(), [429, 429]);
  const row = await limitRow('email', account.email);
  assert.equal(row.locked, true, `blokada zdjęta: ${JSON.stringify(row)}`);
  assert.equal(await failedFor('auth.login_failed', account.userId), 5);
  // Kolejne błędne próby w czasie blokady nie skracają jej i nie zerują licznika.
  const before = row.locked_until;
  assert.equal((await login(account, { password: 'zle haslo 7' })).status, 429);
  assert.deepEqual((await limitRow('email', account.email)).locked_until, before);
});

test('#186: błąd zapisany w trakcie trwającej blokady jej nie nadpisuje (logika SQL)', async () => {
  // Odtworzenie przeplotu: próba przeszła rezerwację (licznik 4 → 5), zanim inna założyła blokadę.
  const account = await seedPasswordUser({ userId: 'u-login-sql' });
  for (let i = 0; i < 4; i += 1) await login(account, { password: `zle haslo ${i}` });
  const slow = login(account, { password: 'zle haslo wolne' });
  // Gdy wolna próba liczy scrypt, ktoś (np. administrator) zakłada blokadę na 10 minut.
  await new Promise((resolve) => setImmediate(resolve));
  await db.query(
    "UPDATE login_rate_limits SET locked_until = now() + interval '10 minutes' WHERE scope_type = 'email' AND scope_hash = $1",
    [scopeHash('email', account.email)],
  );
  assert.equal((await slow).status, 429);
  const row = await limitRow('email', account.email);
  assert.equal(row.locked, true, 'zapis błędu nie może zdjąć trwającej blokady');
  assert.ok(row.failure_count >= 5);
});

test('#186: po wygaśnięciu blokady pierwsza próba liczona od 1; nieznany e-mail jak istniejący', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-expire' });
  for (let i = 0; i < 5; i += 1) await login(account, { password: `zle haslo ${i}` });
  assert.equal((await limitRow('email', account.email)).locked, true);
  await db.query("UPDATE login_rate_limits SET locked_until = now() - interval '1 second' WHERE scope_hash = $1", [scopeHash('email', account.email)]);
  assert.equal((await login(account, { password: 'zle haslo po blokadzie' })).status, 401);
  const row = await limitRow('email', account.email);
  assert.equal(row.failure_count, 1);
  assert.equal(row.locked_until, null);

  const ghost = 'ghost-rownolegly@example.invalid';
  const ghostStatuses = (await Promise.all(Array.from({ length: 12 }, () => post('/api/login', { email: ghost, password: 'z'.repeat(12) }, { ip: nextIp() }))))
    .map((response) => response.status);
  const realStatuses = (await Promise.all(Array.from({ length: 12 }, (_, i) => login(
    { email: 'u-login-ghostcmp@example.invalid', password: 'x' }, { password: `zle ${i} haslo` },
  )))).map((response) => response.status);
  assert.equal(ghostStatuses.filter((status) => status === 401).length, realStatuses.filter((status) => status === 401).length);
  assert.equal((await limitRow('email', ghost)).locked, true);
});

test('#186: podwójne kliknięcie „Zaloguj” z poprawnym hasłem przy liczniku 4 — 200/429, bez zdjęcia blokady', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-dbl' });
  for (let i = 0; i < 4; i += 1) await login(account, { password: `zle haslo ${i}` });
  const statuses = (await Promise.all([login(account), login(account)])).map((response) => response.status).sort();
  assert.ok(['200,200', '200,429'].includes(statuses.join(',')), statuses.join(','));
  const row = await limitRow('email', account.email);
  assert.ok(!row?.locked, 'udane logowanie nie zostawia blokady');
});

test('#186: limit IP przy równoległych błędnych tokenach resetu i zaproszenia (najwyżej 20 sprawdzeń)', async () => {
  const ip = '192.0.2.186';
  const before = (await auditRows('auth.password_reset_failed')).length;
  const tokens = Array.from({ length: 30 }, () => randomBytes(32).toString('base64url'));
  const statuses = (await Promise.all(tokens.map((token) => post('/api/password/reset', { token, newPassword: newPassword() }, { ip }))))
    .map((response) => response.status);
  assert.ok(statuses.every((status) => status === 400 || status === 429), statuses.join(','));
  assert.ok((await auditRows('auth.password_reset_failed')).length - before <= LOGIN_POLICY.ipMaxFailures);
  assert.equal((await limitRow('ip', ip)).locked, true);
  const accept = await post('/api/invitations/accept', { token: tokens[0], password: newPassword() }, { ip });
  assert.equal(accept.status, 429, 'ten sam zakres IP obejmuje przyjęcie zaproszenia');
});

test('#186: równoległe błędne hasła przy zmianie hasła i przyjęciu zaproszenia istniejącego konta', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-parchg' });
  const cookie = cookieFrom(await login(account));
  const change = (await Promise.all(Array.from({ length: 12 }, (_, i) => post('/api/password/change',
    { currentPassword: `zle obecne haslo ${i}`, newPassword: newPassword() }, { cookie, ip: nextIp() }))))
    .map((response) => response.status);
  assert.ok(change.every((status) => status === 400 || status === 429), change.join(','));
  assert.ok(await failedFor('auth.password_change_failed', account.userId) <= LOGIN_POLICY.emailMaxFailures);

  const invited = await seedPasswordUser({ userId: 'u-login-parinv' });
  const { secret } = await invite(invited.email, 'representative', { classId: 'c-login-1a' });
  const accept = (await Promise.all(Array.from({ length: 12 }, (_, i) => post('/api/invitations/accept',
    { token: secret, password: `zle haslo zaproszenia ${i}` }, { ip: nextIp() }))))
    .map((response) => response.status);
  assert.ok(accept.every((status) => status === 401 || status === 429), accept.join(','));
  assert.ok(await failedFor('auth.invitation_accept_failed', invited.userId) <= LOGIN_POLICY.emailMaxFailures);
});

test('#186: sprawdzenie limitu i rezerwacja próby w jednej transakcji z FOR UPDATE, przed scrypt', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-txlog' });
  const log = [];
  let txSeq = 0;
  const wrap = (executor, tag) => ({
    query: (sql, params) => { log.push({ tag, sql: String(sql) }); return executor.query(sql, params); },
  });
  const tracedDb = {
    query: (sql, params) => { log.push({ tag: null, sql: String(sql) }); return db.query(sql, params); },
    transaction: (fn) => db.transaction((tx) => { const tag = ++txSeq; const traced = wrap(tx, tag); return fn({ ...traced, transaction: (inner) => inner(traced) }); }),
  };
  const response = await post('/api/login', { email: account.email, password: 'zle haslo sledzone' }, { ip: nextIp(), useEnv: { ...env, db: tracedDb } });
  assert.equal(response.status, 401);
  const limitQueries = log.filter((entry) => /login_rate_limits/.test(entry.sql));
  const lockRead = limitQueries.find((entry) => /FOR UPDATE/.test(entry.sql));
  assert.ok(lockRead, 'odczyt limitu z blokadą wiersza');
  assert.ok(lockRead.tag, 'odczyt w transakcji');
  const increment = limitQueries.find((entry) => entry.tag === lockRead.tag && /failure_count\s*=/.test(entry.sql) && /UPDATE|ON CONFLICT/.test(entry.sql));
  assert.ok(increment, 'zapis licznika w tej samej transakcji co odczyt');
  const firstUser = log.findIndex((entry) => /FROM users u LEFT JOIN user_passwords/.test(entry.sql));
  assert.ok(log.indexOf(increment) < firstUser, 'rezerwacja przed wyszukaniem konta i scrypt');
  // Żadne zapytanie nie zeruje trwającej blokady.
  assert.ok(limitQueries.every((entry) => !/locked_until = NULL/.test(entry.sql) || /locked_until\s*<=\s*now\(\)|locked_until > now\(\) THEN/.test(entry.sql)));
});

test('konto wyłączone i konto bez hasła: ten sam błąd invalid_credentials', async () => {
  const disabled = await seedPasswordUser({ userId: 'u-login-disabled', disabled: true });
  const response = await login(disabled);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_credentials' });
  await seedUser(db, { userId: 'u-login-nopass' });
  const nopass = await post('/api/login', { email: 'u-login-nopass@example.invalid', password: 'jakies dlugie haslo' }, { ip: nextIp() });
  assert.equal(nopass.status, 401);
  const reasons = (await auditRows('auth.login_failed')).filter((row) => ['u-login-disabled', 'u-login-nopass'].includes(row.entity_id)).map((row) => row.metadata_json.reason);
  assert.deepEqual(reasons.sort(), ['no_password', 'user_disabled']);
});

test('logowanie z obcej domeny lub bez nagłówka Origin jest odrzucane; walidacja wejścia', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-csrf' });
  const evil = await post('/api/login', { email: account.email, password: account.password }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.deepEqual(await evil.json(), { error: 'invalid_origin' });
  const none = await post('/api/login', { email: account.email, password: account.password }, { origin: false });
  assert.equal(none.status, 403);
  const text = await handlePgRequest(request('/api/login', {
    method: 'POST', body: 'email=a&password=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }), env);
  assert.equal(text.status, 415);
  assert.equal((await post('/api/login', { email: account.email })).status, 400);
  assert.equal((await post('/api/login', { email: account.email, password: 'x'.repeat(2000) })).status, 400);
  assert.equal((await get('/api/login')).status, 405);
  const { rows } = await db.query("SELECT 1 FROM sessions WHERE user_id = 'u-login-csrf'");
  assert.equal(rows.length, 0);
});

// --- MFA po haśle ----------------------------------------------------------------

test('trasa finansowa: 403 po samym haśle, 200 po /api/mfa/verify (rotacja sesji)', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-treasurer', roles: [{ role: 'treasurer', schoolYearId: 'y-test' }] });
  const first = await login(account);
  assert.deepEqual(await first.json().then(({ mfaRequired, mfaEnrolled }) => ({ mfaRequired, mfaEnrolled })), { mfaRequired: true, mfaEnrolled: false });
  const firstCookie = cookieFrom(first);
  const beforeEnroll = await get('/api/payments?schoolYearId=y-test', firstCookie);
  assert.equal(beforeEnroll.status, 403);
  assert.deepEqual(await beforeEnroll.json(), { error: 'mfa_enrollment_required' });
  const { secret } = await enrollAndConfirm(firstCookie);

  const second = await login(account);
  const state = await second.json();
  assert.equal(state.mfaRequired, true);
  assert.equal(state.mfaEnrolled, true);
  const cookie = cookieFrom(second);
  const denied = await get('/api/payments?schoolYearId=y-test', cookie);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: 'mfa_required' });
  const auth = await (await get('/api/auth/state', cookie)).json();
  assert.equal(auth.mfaVerified, false);
  assert.equal(auth.mfaEnrolled, true);

  const verified = await post('/api/mfa/verify', { code: codeAt(secret, 1) }, { cookie });
  assert.equal(verified.status, 200);
  const verifiedCookie = cookieFrom(verified);
  assert.equal((await get('/api/session', cookie)).status, 401, 'stara sesja wycofana (rotacja)');
  assert.equal((await get('/api/payments?schoolYearId=y-test', verifiedCookie)).status, 200);
});

test('wymóg zapisu MFA dla zarządu bez czynnika; konfigurowalny MFA_REQUIRED_ROLES', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-board', roles: [{ role: 'board', schoolYearId: 'y-test' }] });
  const response = await login(account);
  const body = await response.json();
  assert.equal(body.mfaRequired, true);
  assert.equal(body.mfaEnrolled, false);
  assert.equal(body.mfaRequiredByRole, true);
  const cookie = cookieFrom(response);
  const events = await get('/api/events?schoolYearId=y-test', cookie);
  assert.equal(events.status, 403);
  assert.deepEqual(await events.json(), { error: 'mfa_enrollment_required' });
  // Zwolnione: sesja, stan, przydziały, zapis MFA.
  assert.equal((await get('/api/session', cookie)).status, 200);
  assert.equal((await get('/api/access', cookie)).status, 200);
  assert.equal((await get('/api/auth/state', cookie)).status, 200);
  // Zmiana hasła przed zapisem MFA też jest zablokowana.
  const change = await post('/api/password/change', { currentPassword: account.password, newPassword: newPassword() }, { cookie });
  assert.equal(change.status, 403);

  // Bez wymogu dla zarządu (MFA_REQUIRED_ROLES=admin) ta sama sesja przechodzi.
  const relaxed = { ...env, MFA_REQUIRED_ROLES: 'admin' };
  assert.equal((await get('/api/events?schoolYearId=y-test', cookie, relaxed)).status, 200);

  const { cookie: mfaCookie } = await enrollAndConfirm(cookie);
  assert.equal((await get('/api/events?schoolYearId=y-test', mfaCookie)).status, 200);

  // Przedstawiciel bez czynnika nie musi zapisywać MFA (rola spoza listy).
  const rep = await seedPasswordUser({ userId: 'u-login-rep2', roles: [{ role: 'representative', classId: 'c-login-1b', schoolYearId: 'y-test' }] });
  const repLogin = await login(rep);
  assert.equal((await repLogin.json()).mfaRequired, false);
  assert.equal((await get('/api/events?schoolYearId=y-test&classId=c-login-1b', cookieFrom(repLogin))).status, 200);
});

// --- Zaproszenia ---------------------------------------------------------------------

async function invite(email, role = 'board', extra = {}) {
  await seedUser(db, { userId: 'u-login-inviter' });
  return createInvitation(env, { actorId: 'u-login-inviter', email, role, schoolYearId: 'y-test', ...extra });
}

test('przyjęcie zaproszenia: nowe konto z adresem z zaproszenia, rola, sesja; jednorazowe', async () => {
  const email = 'nowa.osoba@example.invalid';
  const { secret, invitationId } = await invite(email);
  // #164: nowe konto wymaga zgodnego powtórzenia — sprawdzane przed polityką hasła.
  const mismatch = await post('/api/invitations/accept', { token: secret, password: 'krotkie', passwordRepeat: 'inne haslo' });
  assert.equal(mismatch.status, 400);
  assert.deepEqual(await mismatch.json(), { error: 'password_mismatch' });
  const noRepeat = await post('/api/invitations/accept', { token: secret, password: 'krotkie' });
  assert.equal(noRepeat.status, 400);
  assert.deepEqual(await noRepeat.json(), { error: 'password_mismatch' }, 'brak powtórzenia też jest odrzucany');

  const weak = await post('/api/invitations/accept', { token: secret, password: 'krotkie', passwordRepeat: 'krotkie' });
  assert.equal(weak.status, 400);
  assert.deepEqual(await weak.json(), { error: 'password_too_short' });

  const password = newPassword();
  const accepted = await post('/api/invitations/accept',
    { token: secret, password, passwordRepeat: password, displayName: 'Nowa Osoba' });
  assert.equal(accepted.status, 201);
  const body = await accepted.json();
  assert.equal(body.created, true);
  assert.equal(body.mfaRequired, true, 'zarząd musi zapisać MFA');
  assert.equal(body.mfaEnrolled, false);
  const session = await (await get('/api/session', cookieFrom(accepted))).json();
  assert.equal(session.user.email, email);
  assert.equal(session.mfaVerified, false);
  const grants = await db.query('SELECT role, school_year_id, source_invitation_id FROM role_grants WHERE user_id = $1', [session.user.id]);
  assert.deepEqual(grants.rows, [{ role: 'board', school_year_id: 'y-test', source_invitation_id: invitationId }]);

  const again = await post('/api/invitations/accept', { token: secret, password: newPassword() });
  assert.equal(again.status, 400);
  assert.deepEqual(await again.json(), { error: 'invalid_invitation' });
  assert.equal((await post('/api/login', { email, password }, { ip: nextIp() })).status, 200);
  assert.equal((await post('/api/invitations/accept', { token: 'x'.repeat(43), password })).status, 400);
});

test('przyjęcie zaproszenia: wygasłe odrzucone; istniejące konto wymaga obecnego hasła', async () => {
  await seedUser(db, { userId: 'u-login-inviter' });
  const { secret, tokenHash } = await createSessionSecret();
  await db.query(
    `INSERT INTO invitations (id, email, token_hash, role, school_year_id, created_by, created_at, expires_at)
     VALUES ($1, 'wygasle@example.invalid', $2, 'board', 'y-test', 'u-login-inviter', now() - interval '4 days', now() - interval '1 day')`,
    [crypto.randomUUID(), tokenHash],
  );
  const expired = await post('/api/invitations/accept', { token: secret, password: newPassword() });
  assert.equal(expired.status, 400);
  assert.deepEqual(await expired.json(), { error: 'invalid_invitation' });
  const { rows } = await db.query("SELECT 1 FROM users WHERE email = 'wygasle@example.invalid'");
  assert.equal(rows.length, 0, 'wygasłe zaproszenie nie tworzy konta');

  const existing = await seedPasswordUser({ userId: 'u-login-existing' });
  const second = await invite(existing.email, 'representative', { classId: 'c-login-1a' });
  const wrong = await post('/api/invitations/accept', { token: second.secret, password: 'inne haslo niz obecne' });
  assert.equal(wrong.status, 401);
  const right = await post('/api/invitations/accept', { token: second.secret, password: existing.password });
  assert.equal(right.status, 201);
  assert.equal((await right.json()).created, false);
  const grants = await db.query("SELECT role FROM role_grants WHERE user_id = 'u-login-existing'");
  assert.deepEqual(grants.rows.map((row) => row.role), ['representative']);
});

// --- Zmiana i reset hasła ---------------------------------------------------------------

test('zmiana hasła wymaga obecnego hasła, wycofuje inne sesje i rotuje bieżącą', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-change' });
  const cookieA = cookieFrom(await login(account));
  const cookieB = cookieFrom(await login(account));
  const next = newPassword();
  const wrong = await post('/api/password/change', { currentPassword: 'to nie jest haslo', newPassword: next }, { cookie: cookieA });
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: 'invalid_current_password' });
  const weak = await post('/api/password/change', { currentPassword: account.password, newPassword: 'password1234' }, { cookie: cookieA });
  assert.deepEqual(await weak.json(), { error: 'password_common' });
  assert.equal((await post('/api/password/change', { currentPassword: account.password, newPassword: next })).status, 401);

  const changed = await post('/api/password/change', { currentPassword: account.password, newPassword: next }, { cookie: cookieA });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).revokedSessions, 1);
  const cookieA2 = cookieFrom(changed);
  assert.equal((await get('/api/session', cookieB)).status, 401, 'inna sesja wycofana');
  assert.equal((await get('/api/session', cookieA)).status, 401, 'bieżąca sesja zrotowana');
  assert.equal((await get('/api/session', cookieA2)).status, 200);
  assert.equal((await login(account)).status, 401, 'stare hasło nie działa');
  assert.equal((await login(account, { password: next })).status, 200);
  const reasons = await db.query("SELECT revoked_reason FROM sessions WHERE user_id = 'u-login-change' AND revoked_at IS NOT NULL ORDER BY revoked_reason");
  assert.deepEqual(reasons.rows.map((row) => row.revoked_reason), ['password_changed', 'rotated']);
  assert.equal((await auditRows('auth.password_changed')).filter((row) => row.actor_id === 'u-login-change').length, 1);
});

test('reset hasła: token tylko od administratora (admin + MFA), jednorazowy, nowy unieważnia stary', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-reset' });
  const userCookie = cookieFrom(await login(account));
  const admin = await seedUserSession(db, { userId: 'u-login-admin', roles: [{ role: 'admin' }], mfa: true });
  const adminNoMfa = await seedUserSession(db, { userId: 'u-login-admin2', roles: [{ role: 'admin' }], mfa: false });
  const board = await seedUserSession(db, { userId: 'u-login-board2', roles: [{ role: 'board' }], mfa: true });
  const path = `/api/admin/users/${account.userId}/password-reset`;
  assert.equal((await post(path, {}, { cookie: board })).status, 403);
  assert.equal((await post(path, {}, { cookie: adminNoMfa })).status, 403);
  assert.equal((await post(path, {})).status, 401);

  const first = await post(path, {}, { cookie: admin });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.match(firstBody.token, /^[A-Za-z0-9_-]{43}$/);
  const second = await post(path, { ttlHours: 1 }, { cookie: admin });
  const { token } = await second.json();
  assert.equal((await post(path, { ttlHours: 48 }, { cookie: admin })).status, 400);
  // Trzecie wywołanie (błędne) niczego nie zmienia; drugi token jest ważny, pierwszy nie.
  const stale = await post('/api/password/reset', { token: firstBody.token, newPassword: newPassword() });
  assert.equal(stale.status, 400);
  assert.deepEqual(await stale.json(), { error: 'invalid_token' });
  const weak = await post('/api/password/reset', { token, newPassword: 'qwerty123456' });
  assert.deepEqual(await weak.json(), { error: 'password_common' });

  const fresh = newPassword();
  const done = await post('/api/password/reset', { token, newPassword: fresh });
  assert.equal(done.status, 200);
  assert.equal(done.headers.get('Set-Cookie'), null, 'reset nie loguje — potem hasło i MFA');
  assert.equal((await post('/api/password/reset', { token, newPassword: newPassword() })).status, 400, 'token jednorazowy');
  assert.equal((await get('/api/session', userCookie)).status, 401, 'reset wylogowuje wszystkie sesje');
  assert.equal((await login(account)).status, 401);
  assert.equal((await login(account, { password: fresh })).status, 200);

  // Token wygasły.
  const third = await (await post(path, {}, { cookie: admin })).json();
  assert.ok(third.reset.id);
  const { secret: expiredToken, tokenHash } = await createSessionSecret();
  await db.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, 'u-login-admin', now() - interval '3 hours', now() - interval '1 hour')`,
    [crypto.randomUUID(), account.userId, tokenHash],
  );
  assert.equal((await post('/api/password/reset', { token: expiredToken, newPassword: newPassword() })).status, 400);
  // Tokenów nie da się usunąć ani użyć ponownie w SQL.
  await assert.rejects(db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [account.userId]), /password_reset_token_immutable/);
  const issued = await auditRows('auth.password_reset_issued');
  assert.ok(issued.filter((row) => row.actor_id === 'u-login-admin').length >= 3);
  assert.equal((await auditRows('auth.password_reset_revoked')).filter((row) => row.metadata_json.userId === account.userId).length >= 1, true);
});

test('reset MFA przez administratora: wyłącza czynnik i kody, wylogowuje; potwierdzenie i ochrona przed samym sobą', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-lostphone', roles: [{ role: 'board', schoolYearId: 'y-test' }] });
  const { cookie: mfaCookie } = await enrollAndConfirm(cookieFrom(await login(account)));
  const admin = await seedUserSession(db, { userId: 'u-login-admin3', roles: [{ role: 'admin' }], mfa: true });
  const path = `/api/admin/users/${account.userId}/mfa-reset`;
  assert.equal((await post(path, {}, { cookie: admin })).status, 400, 'wymaga confirm');
  assert.equal((await post(path, { confirm: account.userId }, { cookie: mfaCookie })).status, 403, 'zarząd nie resetuje MFA');
  const selfReset = await post('/api/admin/users/u-login-admin3/mfa-reset', { confirm: 'u-login-admin3' }, { cookie: admin });
  assert.equal(selfReset.status, 409);

  const reset = await post(path, { confirm: account.userId }, { cookie: admin });
  assert.equal(reset.status, 200);
  const body = await reset.json();
  assert.equal(body.changed, true);
  assert.equal(body.disabledFactors, 1);
  assert.equal(body.invalidatedRecoveryCodes, 10);
  assert.ok(body.revokedSessions >= 1);
  assert.equal((await get('/api/session', mfaCookie)).status, 401);
  const again = await (await post(path, { confirm: account.userId }, { cookie: admin })).json();
  assert.equal(again.changed, false);

  const relogin = await (await login(account)).json();
  assert.equal(relogin.mfaEnrolled, false);
  assert.equal(relogin.mfaRequired, true, 'zarząd musi zapisać nowy czynnik');
  const events = await auditRows('mfa.reset');
  assert.equal(events.filter((row) => row.entity_id === account.userId).length, 1);
  assert.equal(events[0].actor_id, 'u-login-admin3');
});

// --- Brak danych jawnych w audycie i logach ---------------------------------------------

test('hasło i e-mail nie trafiają do audytu, logów konsoli ani tabel pomocniczych', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-privacy' });
  const captured = [];
  const originals = { out: process.stdout.write, err: process.stderr.write, log: console.log, error: console.error, warn: console.warn, info: console.info };
  const capture = (chunk) => { captured.push(String(chunk)); return true; };
  process.stdout.write = capture; process.stderr.write = capture;
  console.log = console.error = console.warn = console.info = (...args) => captured.push(args.map(String).join(' '));
  let next;
  try {
    await login(account, { password: 'zle haslo prywatne 123' });
    await post('/api/login', { email: 'prywatny-nieznany@example.invalid', password: 'zle haslo prywatne 123' });
    const cookie = cookieFrom(await login(account));
    next = newPassword();
    await post('/api/password/change', { currentPassword: account.password, newPassword: next }, { cookie });
    const { secret } = await invite('prywatne.zaproszenie@example.invalid', 'representative', { classId: 'c-login-1a' });
    await post('/api/invitations/accept', { token: secret, password: 'prywatne haslo zaproszenia' });
  } finally {
    process.stdout.write = originals.out; process.stderr.write = originals.err;
    Object.assign(console, { log: originals.log, error: originals.error, warn: originals.warn, info: originals.info });
  }
  const secrets = [account.password, next, 'zle haslo prywatne 123', 'prywatne haslo zaproszenia', account.email,
    'prywatny-nieznany@example.invalid', 'prywatne.zaproszenie@example.invalid'];
  const logs = captured.join('\n');
  const audit = JSON.stringify((await db.query('SELECT * FROM audit_events')).rows);
  const helpers = JSON.stringify((await db.query('SELECT * FROM login_rate_limits')).rows)
    + JSON.stringify((await db.query('SELECT * FROM user_passwords')).rows)
    + JSON.stringify((await db.query('SELECT * FROM password_reset_tokens')).rows);
  for (const value of secrets) {
    assert.ok(!logs.includes(value), `log zawiera: ${value}`);
    assert.ok(!audit.includes(value), `audyt zawiera: ${value}`);
    assert.ok(!helpers.includes(value), `tabele pomocnicze zawierają: ${value}`);
  }
  assert.ok(!audit.includes('@'), 'audyt bez adresów e-mail');
});

// --- #189: sesja po samym haśle nie działa przeciw właścicielowi ------------------------------

test('#189: sesja bez TOTP nie wylogowuje właściciela, nie blokuje mu MFA i nie widzi ról', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-189', roles: [{ role: 'treasurer', schoolYearId: 'y-test' }] });
  const { secret, cookie: enrolled, recoveryCodes } = await enrollAndConfirm(cookieFrom(await login(account)));
  // Właściciel: nowa sesja po haśle i drugim składniku (kod odzyskiwania — krok TOTP zostaje na później).
  const ownerLogin = cookieFrom(await login(account));
  const ownerVerify = await post('/api/mfa/recovery', { code: recoveryCodes[0] }, { cookie: ownerLogin });
  assert.equal(ownerVerify.status, 200);
  const owner = cookieFrom(ownerVerify);
  assert.equal((await get('/api/payments', owner)).status !== 403, true);

  // Napastnik zna hasło, nie ma telefonu.
  const attacker = cookieFrom(await login(account));
  assert.equal((await get('/api/payments', attacker)).status, 403);
  const access = await get('/api/access', attacker);
  assert.equal(access.status, 200);
  const accessBody = await access.json();
  assert.deepEqual(accessBody.grants, [], 'przydziały ukryte do potwierdzenia MFA');
  assert.equal(accessBody.mfaRequired, true);
  assert.ok(!JSON.stringify(accessBody).includes('treasurer'));

  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await post('/api/mfa/verify', { code: '000000' }, { cookie: attacker })).status);
  assert.equal(statuses.at(-1), 429, 'sesja napastnika zablokowana');

  const revoke = await post('/api/sessions/revoke-all', undefined, { cookie: attacker });
  assert.equal(revoke.status, 200);
  const revokeBody = await revoke.json();
  assert.equal(revokeBody.revoked, 1);
  assert.equal(revokeBody.scope, 'current');
  assert.equal((await get('/api/session', attacker)).status, 401, 'bieżąca sesja wylogowana');
  assert.equal((await get('/api/session', owner)).status, 200, 'sesja właściciela po MFA działa');
  assert.equal((await get('/api/session', enrolled)).status, 200);

  // Właściciel loguje się ponownie i podaje poprawny kod — blokada sesji napastnika go nie dotyczy.
  const again = cookieFrom(await login(account));
  assert.equal((await post('/api/mfa/verify', { code: codeAt(secret, 1) }, { cookie: again })).status, 200);

  // Z sesji po MFA „Wyloguj wszędzie” wycofuje wszystkie; podwójne kliknięcie → 401.
  const all = await post('/api/sessions/revoke-all', undefined, { cookie: owner });
  assert.equal(all.status, 200);
  const allBody = await all.json();
  assert.equal(allBody.scope, 'all');
  assert.ok(allBody.revoked >= 2);
  assert.equal((await get('/api/session', enrolled)).status, 401);
  assert.equal((await post('/api/sessions/revoke-all', undefined, { cookie: owner })).status, 401);
});

test('#189: konto bez czynnika — revoke-all jak dotąd; rola wymagająca MFA bez czynnika nie widzi przydziałów', async () => {
  const rep = await seedPasswordUser({ userId: 'u-login-189rep', roles: [{ role: 'representative', classId: 'c-login-189', schoolYearId: 'y-test' }] });
  const a = cookieFrom(await login(rep));
  const b = cookieFrom(await login(rep));
  const repAccess = await (await get('/api/access', a)).json();
  assert.equal(repAccess.grants.length, 1, 'przedstawiciel bez wymogu MFA widzi własny przydział');
  const revoke = await post('/api/sessions/revoke-all', undefined, { cookie: a });
  assert.equal((await revoke.json()).revoked, 2);
  assert.equal((await get('/api/session', b)).status, 401);

  const board = await seedPasswordUser({ userId: 'u-login-189brd', roles: [{ role: 'board', schoolYearId: 'y-test' }] });
  const boardCookie = cookieFrom(await login(board));
  const boardAccess = await (await get('/api/access', boardCookie)).json();
  assert.deepEqual(boardAccess.grants, []);
  assert.equal(boardAccess.mfaRequired, true);
  // Ekran logowania korzysta z /api/auth/state — ten działa bez MFA.
  const state = await (await get('/api/auth/state', boardCookie)).json();
  assert.equal(state.mfaRequired, true);
  assert.equal(state.mfaEnrolled, false);
});

// --- #193: cykl życia tokenu resetu hasła --------------------------------------------------------

test('#193: token resetu unieważniany po zmianie hasła, logowaniu, wyłączeniu konta, resecie MFA i udanym resecie', async () => {
  const admin = await seedUserSession(db, { userId: 'u-login-193adm', roles: [{ role: 'admin' }], mfa: true });
  const issue = async (userId) => {
    const response = await post(`/api/admin/users/${userId}/password-reset`, {}, { cookie: admin });
    assert.equal(response.status, 201);
    return (await response.json()).token;
  };
  const resetWith = (token) => post('/api/password/reset', { token, newPassword: newPassword() }, { ip: nextIp() });
  const revokedReasons = async (userId) => (await auditRows('auth.password_reset_revoked'))
    .filter((row) => row.metadata_json.userId === userId).map((row) => row.metadata_json.reason);

  // Scenariusz z odtworzenia: token → właściciel pamięta hasło, zmienia je → disable/enable → stary token.
  const rep = await seedPasswordUser({ userId: 'u-login-193rep' });
  const token = await issue(rep.userId);
  const cookie = cookieFrom(await login(rep));
  const next = newPassword();
  assert.equal((await post('/api/password/change', { currentPassword: rep.password, newPassword: next }, { cookie })).status, 200);
  assert.equal((await post(`/api/admin/users/${rep.userId}/disable`, {}, { cookie: admin })).status, 200);
  assert.equal((await post(`/api/admin/users/${rep.userId}/enable`, {}, { cookie: admin })).status, 200);
  const stale = await resetWith(token);
  assert.equal(stale.status, 400);
  assert.deepEqual(await stale.json(), { error: 'invalid_token' });
  assert.equal((await login(rep, { password: next })).status, 200, 'hasło właściciela nienaruszone');
  assert.ok((await revokedReasons(rep.userId)).includes('login_succeeded'));

  // Zmiana hasła.
  const changer = await seedPasswordUser({ userId: 'u-login-193chg' });
  const changerCookie = cookieFrom(await login(changer));
  const t1 = await issue(changer.userId);
  assert.equal((await post('/api/password/change', { currentPassword: changer.password, newPassword: newPassword() }, { cookie: changerCookie })).status, 200);
  assert.equal((await resetWith(t1)).status, 400);
  assert.ok((await revokedReasons(changer.userId)).includes('password_changed'));
  // Token wydany PO zmianie hasła działa.
  assert.equal((await resetWith(await issue(changer.userId))).status, 200);

  // Wyłączenie konta.
  const off = await seedPasswordUser({ userId: 'u-login-193off' });
  const t2 = await issue(off.userId);
  await post(`/api/admin/users/${off.userId}/disable`, {}, { cookie: admin });
  await post(`/api/admin/users/${off.userId}/enable`, {}, { cookie: admin });
  assert.equal((await resetWith(t2)).status, 400);
  assert.ok((await revokedReasons(off.userId)).includes('user_disabled'));

  // Reset MFA.
  const lost = await seedPasswordUser({ userId: 'u-login-193mfa', roles: [{ role: 'board', schoolYearId: 'y-test' }] });
  await enrollAndConfirm(cookieFrom(await login(lost)));
  const t3 = await issue(lost.userId);
  assert.equal((await post(`/api/admin/users/${lost.userId}/mfa-reset`, { confirm: lost.userId }, { cookie: admin })).status, 200);
  assert.equal((await resetWith(t3)).status, 400);
  assert.ok((await revokedReasons(lost.userId)).includes('mfa_reset'));
  // Nowy token + hasło nadal wymaga zapisu MFA dla zarządu.
  const fresh = newPassword();
  assert.equal((await post('/api/password/reset', { token: await issue(lost.userId), newPassword: fresh }, { ip: nextIp() })).status, 200);
  const relogin = await (await login(lost, { password: fresh })).json();
  assert.equal(relogin.mfaRequired, true);
  assert.equal(relogin.mfaEnrolled, false);

  // Audyt bez tokenów i e-maili; wiersze tokenów zostają (historia).
  const audit = JSON.stringify(await auditRows('auth.password_reset_revoked'));
  assert.ok(!audit.includes('@') && !audit.includes(token));
  const { rows } = await db.query("SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = 'u-login-193rep'");
  assert.equal(rows[0].n, 1);
});

test('#193: udany reset unieważnia pozostałe otwarte tokeny konta', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-193two' });
  const admin = await seedUserSession(db, { userId: 'u-login-193adm2', roles: [{ role: 'admin' }], mfa: true });
  const { token } = await (await post(`/api/admin/users/${account.userId}/password-reset`, {}, { cookie: admin })).json();
  // Drugi otwarty token wstawiony bezpośrednio (np. wyścig dwóch administratorów).
  const { secret, tokenHash } = await createSessionSecret();
  await db.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, 'u-login-193adm2', now() + interval '1 hour')`,
    [crypto.randomUUID(), account.userId, tokenHash],
  );
  assert.equal((await post('/api/password/reset', { token, newPassword: newPassword() }, { ip: nextIp() })).status, 200);
  assert.equal((await post('/api/password/reset', { token: secret, newPassword: newPassword() }, { ip: nextIp() })).status, 400);
});

// #203: kolejka scrypt pełna (np. zalew żądań logowania z jednego IP) — /api/login
// odpowiada 503 login_busy z Retry-After, BEZ liczenia scrypt dla tego żądania,
// bez wpisu do licznika prób (login_rate_limits) i bez zdarzenia audytu.
test('#203: pełna kolejka scrypt daje 503 login_busy z Retry-After, bez wpływu na licznik prób i audyt', async () => {
  const account = await seedPasswordUser({ userId: 'u-login-203busy' });
  const ip = nextIp();
  // Zajmujemy wszystkie trwające i oczekujące miejsca atrapą, która czeka aż test ją zwolni.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const occupied = Array.from({ length: MAX_CONCURRENT + MAX_WAITING }, () => withSlot(() => held).catch(() => {}));
  try {
    const busy = await login(account, { ip });
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).error, 'login_busy');
    assert.equal(busy.headers.get('Retry-After'), '5');
    // Rezerwacja jest tworzona i od razu zwalniana (GREATEST(-1, 0) na świeżym wierszu
    // zostaje przy 0) — licznik prób nie rośnie, tak jak przy udanym logowaniu.
    const after = (await db.query(
      "SELECT failure_count FROM login_rate_limits WHERE scope_type = 'ip' AND scope_hash = $1",
      [scopeHash('ip', ip)],
    )).rows;
    assert.deepEqual(after.map((r) => r.failure_count), [0], 'login_busy nie liczy się jako próba');
    assert.equal((await auditRows('auth.login_failed')).filter((row) => JSON.stringify(row).includes(ip)).length, 0);
  } finally {
    release();
    await Promise.all(occupied);
  }
});
