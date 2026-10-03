// #208 (inwentaryzacja blokad, scripts/lock-inventory.js): testy z barierą na PRAWDZIWYM
// PostgreSQL dla blokad MFA, które do tej pory były wyjątkami „luka”: lockUser i
// activeFactors w src/pg/mfa.js, rotateOneAccount w src/pg/mfa-key-rotation.js oraz
// blokada konta w adminResetMfaInTx (src/pg/login.js).
//
// Kolejność blokad: każda operacja na czynnikach MFA blokuje najpierw wiersz konta, potem
// wiersz czynnika — weryfikacja i zapis czynnika (lockUser, potem activeFactors), reset MFA
// (adminResetMfaInTx) i rotacja klucza (lockAccount, potem czynnik w rotateOneAccount).
// Blokady czynnika są przez to drugą warstwą (wyjątki „zagnieżdżona” w LOCK_EXCEPTIONS),
// a punktem serializacji jest blokada konta:
//  - lockUser: pierwszy zapis czynnika (brak wierszy do zablokowania w activeFactors) —
//    podwójne „Włącz MFA” bez blokady konta kończy się 23505 na indeksie
//    user_mfa_factors_one_pending zamiast zastąpienia czynnika oczekującego;
//  - lockAccount (rotacja): rotacja staje po wyłączeniu starego wiersza, przed wstawieniem
//    nowego; weryfikacja, zapis czynnika i reset MFA czekają na blokadę konta i po
//    zatwierdzeniu rotacji widzą nowy wiersz. Bez blokady konta rotacja trzyma tylko wiersz
//    czynnika: drugie żądanie bierze konto i czeka na wiersz, a INSERT rotacji (klucz obcy →
//    FOR KEY SHARE na users) czeka na konto — zakleszczenie 40P01 (przy `retries: 0` w
//    barierze: 503 retry_later; src/db.js ponawia je w zwykłym trybie, ale operacja traci
//    ok. 1 s, `deadlock_timeout`). Tak działał kod przed ujednoliceniem kolejności (#723).
// Przy dwóch weryfikacjach TEGO SAMEGO kodu i przy rotacji w trakcie weryfikacji każda z blokad
// (konta albo czynnika) osobno serializuje odczyt last_used_step; usunięcie obu naraz pokazują
// kontrole pozytywne (rewrite bariery): ten sam kod przyjęty dwa razy.
//
// Schemat jak w pg-real-record-locks (tests/helpers/pg-race.js): pierwsze żądanie staje W
// TRANSAKCJI, drugie startuje osobnym połączeniem i musi czekać w bazie na zapytanie z
// blokadą z kodu (`pg_stat_activity`); dopiero potem pierwsze zatwierdza. Każdy test sprawdza
// też skutek, który bez blokady jest inny (sprawdzone z wyłączonymi asercjami miejsca czekania).
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Wyłącznie dane syntetyczne (@example.invalid), klucze szyfrowania losowane w teście.
// Kontrola mutacyjna: scripts/check-lock-mutations.js (mutanty mfa-lock-user,
// mfa-key-rotation-account, mfa-admin-reset).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { base32Decode, hotp, totpStep } from '../src/pg/mfa.js';
import { rotateMfaKeys } from '../src/pg/mfa-key-rotation.js';
import { seedUserSession } from './helpers/pg.js';
import { callApi, countRows, dropForUpdate } from './helpers/pg-barrier.js';
import { assertWaitsOn, auditCount, race, withReal } from './helpers/pg-race.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('base64');
const SINGLE = { MFA_ENCRYPTION_KEY: KEY_V1 };
const RING = { MFA_ENCRYPTION_KEYS: `2:${KEY_V2},1:${KEY_V1}` };
const USER = 'u-mfa';

const LOCK_USER_SQL = /^SELECT id FROM users WHERE id = \$1 AND disabled_at IS NULL FOR UPDATE/;
// Blokada konta w adminResetMfaInTx i w lockAccount (rotacja klucza), bez warunku disabled_at.
const ACCOUNT_LOCK_SQL = /^SELECT id FROM users WHERE id = \$1 FOR UPDATE/;

const verify = (env, cookie, code) => callApi(env, 'POST', '/api/mfa/verify', cookie, { code });
const accepted = (db) => countRows(db, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'mfa.verified' AND metadata_json->>'kind' = 'verify'");
const activeFactors = (db, userId = USER) => db.query(
  'SELECT id, confirmed_at, last_used_step FROM user_mfa_factors WHERE user_id = $1 AND disabled_at IS NULL ORDER BY created_at', [userId],
).then((result) => result.rows);

// Konto z potwierdzonym czynnikiem (klucz w wersji 1). Zwraca sekret, krok potwierdzenia
// i kod NASTĘPNEGO kroku (mieści się w oknie ±1, a jest nowszy niż last_used_step).
async function enrolled(db) {
  const env = { db, ...SINGLE };
  const cookie = await seedUserSession(db, { userId: USER });
  const started = await callApi(env, 'POST', '/api/mfa/enroll', cookie);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const secret = base32Decode(started.body.secret);
  const confirmStep = totpStep(Date.now());
  const confirmed = await callApi(env, 'POST', '/api/mfa/confirm', cookie, { code: hotp(secret, confirmStep) });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return { confirmStep, nextStep: confirmStep + 1, nextCode: hotp(secret, confirmStep + 1) };
}

test('#208 (bariera, MFA): podwójne „Włącz MFA” przy pierwszym zapisie czynnika — drugie czeka na blokadę konta i zastępuje czynnik oczekujący pierwszego; jeden aktywny', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await seedUserSession(db, { userId: USER });
    const r = await race(db, {
      pauseAfter: /INSERT INTO user_mfa_factors/,
      first: (env) => callApi(env, 'POST', '/api/mfa/enroll', cookie),
      second: (env) => callApi(env, 'POST', '/api/mfa/enroll', cookie),
      extra: SINGLE,
    });
    assertWaitsOn(r, LOCK_USER_SQL, 'drugi zapis czynnika czeka na blokadę wiersza konta');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    // Konto nie ma jeszcze żadnego czynnika, więc activeFactors nie ma czego zablokować.
    // Bez blokady konta drugie żądanie wstawia własny czynnik oczekujący, czeka na indeks
    // unikalny user_mfa_factors_one_pending i kończy się 23505 zamiast zastąpienia.
    assert.equal(r.b.status, 201, JSON.stringify(r.b.body));
    assert.deepEqual(r.errors, []);
    const active = await activeFactors(db);
    assert.deepEqual(active.map((row) => row.id), [r.b.body.factorId]);
    const { rows } = await db.query(
      "SELECT metadata_json->>'replacedPendingId' AS replaced FROM audit_events WHERE action = 'mfa.enrollment_started' AND entity_id = $1",
      [r.b.body.factorId],
    );
    assert.deepEqual(rows.map((row) => row.replaced), [r.a.body.factorId]);
  });
});

test('#208 (bariera, MFA): ten sam kod TOTP w dwóch sesjach naraz — druga weryfikacja czeka na blokadę konta i dostaje 400 (zużyty krok); kod przyjęty raz', { skip }, async () => {
  await withReal(async (db) => {
    const { nextStep, nextCode } = await enrolled(db);
    const first = await seedUserSession(db, { userId: USER });
    const second = await seedUserSession(db, { userId: USER });
    const r = await race(db, {
      pauseAfter: /UPDATE user_mfa_factors SET last_used_step/,
      first: (env) => verify(env, first, nextCode),
      second: (env) => verify(env, second, nextCode),
      extra: SINGLE,
    });
    assertWaitsOn(r, LOCK_USER_SQL, 'druga weryfikacja czeka na blokadę wiersza konta');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    assert.deepEqual([r.b.status, r.b.body.error], [400, 'invalid_code']);
    assert.equal(await accepted(db), 1);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'mfa.failed' AND metadata_json->>'reason' = 'replay'"), 1);
    assert.deepEqual((await activeFactors(db)).map((row) => Number(row.last_used_step)), [nextStep]);
  });
});

test('#208 (bariera, MFA, kontrola pozytywna): bez obu blokad (lockUser i activeFactors) ten sam kod TOTP przechodzi w dwóch sesjach', { skip }, async () => {
  await withReal(async (db) => {
    const { nextCode } = await enrolled(db);
    const first = await seedUserSession(db, { userId: USER });
    const second = await seedUserSession(db, { userId: USER });
    const r = await race(db, {
      pauseAfter: /UPDATE user_mfa_factors SET last_used_step/,
      first: (env) => verify(env, first, nextCode),
      second: (env) => verify(env, second, nextCode),
      extra: SINGLE,
      // Mutacja obu zapytań naraz: każda z blokad osobno wystarcza (test wyżej), razem są
      // jedynym punktem serializacji odczytu last_used_step.
      rewrite: dropForUpdate(/FROM users WHERE id = \$1 AND disabled_at IS NULL|FROM user_mfa_factors\s+WHERE user_id = \$1 AND disabled_at IS NULL/),
    });
    // Druga weryfikacja czeka dopiero na UPDATE last_used_step pierwszej, a po jej
    // zatwierdzeniu zapisuje ten sam krok (wyzwalacz 0013 odrzuca tylko krok WSTECZ).
    assertWaitsOn(r, /^UPDATE user_mfa_factors SET last_used_step/, 'bez blokad druga weryfikacja czeka dopiero na zapis kroku');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    assert.equal(r.b.status, 200, JSON.stringify(r.b.body));
    assert.equal(await accepted(db), 2);
  });
});

test('#208 (bariera, MFA): rotacja klucza w trakcie weryfikacji kodu — rotacja czeka na blokadę konta i przenosi zużyty krok; powtórzenie kodu odrzucone', { skip }, async () => {
  await withReal(async (db) => {
    const { nextStep, nextCode } = await enrolled(db);
    const cookie = await seedUserSession(db, { userId: USER });
    const r = await race(db, {
      pauseAfter: /UPDATE user_mfa_factors SET last_used_step/,
      first: (env) => verify(env, cookie, nextCode),
      second: (env) => rotateMfaKeys(env, { apply: true }),
      extra: RING,
    });
    assertWaitsOn(r, ACCOUNT_LOCK_SQL, 'rotacja czeka na blokadę wiersza konta');
    assert.deepEqual(r.errors, []);
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    assert.equal(r.b.rotated, 1);
    // Rotacja czyta czynnik dopiero po zatwierdzeniu weryfikacji i przenosi zużyty krok.
    // Ten sam skutek daje sama blokada czynnika (rotacja czeka wtedy na wiersz czynnika);
    // bez obu (kontrola pozytywna niżej) ten sam kod przechodzi drugi raz.
    const [current] = await activeFactors(db);
    assert.equal(Number(current.last_used_step), nextStep);
    const replay = await verify({ db, ...RING }, await seedUserSession(db, { userId: USER }), nextCode);
    assert.deepEqual([replay.status, replay.body.error], [400, 'invalid_code']);
    assert.equal(await accepted(db), 1);
    assert.equal(await auditCount(db, 'mfa.key_rotated'), 1);
  });
});

test('#208 (bariera, MFA, kontrola pozytywna): rotacja bez obu blokad (konta i czynnika) przenosi krok sprzed weryfikacji — ten sam kod przechodzi drugi raz', { skip }, async () => {
  await withReal(async (db) => {
    const { nextCode } = await enrolled(db);
    const cookie = await seedUserSession(db, { userId: USER });
    const r = await race(db, {
      pauseAfter: /UPDATE user_mfa_factors SET last_used_step/,
      first: (env) => verify(env, cookie, nextCode),
      second: (env) => rotateMfaKeys(env, { apply: true }),
      extra: RING,
      // Mutacja obu blokad rotateOneAccount naraz (zapytania weryfikacji mają inny tekst:
      // lockUser z `AND disabled_at IS NULL`, activeFactors bez `confirmed_at IS NOT NULL`).
      rewrite: dropForUpdate(/^SELECT id FROM users WHERE id = \$1 FOR UPDATE|confirmed_at IS NOT NULL AND disabled_at IS NULL/),
    });
    // Rotacja czyta czynnik bez blokady i czeka dopiero na UPDATE disabled_at (wiersz trzyma weryfikacja).
    assertWaitsOn(r, /^UPDATE user_mfa_factors SET disabled_at/, 'bez blokad rotacja czeka dopiero na wyłączenie wiersza');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    assert.equal(r.b.rotated, 1);
    const replay = await verify({ db, ...RING }, await seedUserSession(db, { userId: USER }), nextCode);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(await accepted(db), 2);
  });
});

// Rotacja pierwsza: staje po wyłączeniu starego wiersza, przed wstawieniem nowego (trzyma
// blokadę konta i wiersza czynnika). Drugie żądanie czeka na blokadę konta i po zatwierdzeniu
// rotacji widzi już nowy wiersz. Bez blokady konta w rotateOneAccount (mutant
// mfa-key-rotation-account) drugie żądanie bierze konto, czeka na wiersz czynnika, a INSERT
// rotacji (klucz obcy → FOR KEY SHARE na users) czeka na konto — zakleszczenie 40P01; przy
// `retries: 0` w barierze jedna z transakcji jest przerywana (API: 503 retry_later).
const ROTATION_DISABLES_OLD_ROW = /^UPDATE user_mfa_factors SET disabled_at = now\(\) WHERE id = \$1$/;

async function rotationFirst(db, second) {
  const r = await race(db, {
    pauseAfter: ROTATION_DISABLES_OLD_ROW,
    first: (env) => rotateMfaKeys(env, { apply: true }),
    second,
    extra: RING,
  });
  assert.deepEqual(r.errors, [], 'bez zakleszczenia (40P01) i innych błędów transakcji');
  assert.equal(r.a.rotated, 1);
  assert.equal(await auditCount(db, 'mfa.key_rotated'), 1);
  return r;
}

test('#208 (bariera, MFA): weryfikacja kodu w trakcie rotacji klucza — weryfikacja czeka na blokadę konta i przyjmuje kod na nowym wierszu; bez zakleszczenia', { skip }, async () => {
  await withReal(async (db) => {
    const { nextStep, nextCode } = await enrolled(db);
    const cookie = await seedUserSession(db, { userId: USER });
    const r = await rotationFirst(db, (env) => verify(env, cookie, nextCode));
    assertWaitsOn(r, LOCK_USER_SQL, 'weryfikacja czeka na blokadę wiersza konta');
    // Weryfikacja czyta czynniki nowym zapytaniem po zatwierdzeniu rotacji, więc widzi nowy
    // wiersz (a nie 409 mfa_not_enrolled, które daje czekanie na wiersz czynnika: stary
    // wiersz jest już wyłączony, a nowego nie ma w migawce czekającego zapytania).
    assert.equal(r.b.status, 200, JSON.stringify(r.b.body));
    const [current] = await activeFactors(db);
    assert.equal(Number(current.last_used_step), nextStep);
    const { rows } = await db.query("SELECT metadata_json->>'factorId' AS factor FROM audit_events WHERE action = 'mfa.verified' AND metadata_json->>'kind' = 'verify'");
    assert.deepEqual(rows.map((row) => row.factor), [current.id]);
  });
});

test('#208 (bariera, MFA): ponowny zapis czynnika w trakcie rotacji klucza — zapis czeka na blokadę konta i dodaje czynnik oczekujący obok obróconego; bez zakleszczenia', { skip }, async () => {
  await withReal(async (db) => {
    await enrolled(db);
    // Wymiana potwierdzonego czynnika wymaga sesji ze świeżym MFA.
    const cookie = await seedUserSession(db, { userId: USER, mfa: true });
    const r = await rotationFirst(db, (env) => callApi(env, 'POST', '/api/mfa/enroll', cookie));
    assertWaitsOn(r, LOCK_USER_SQL, 'zapis czynnika czeka na blokadę wiersza konta');
    assert.equal(r.b.status, 201, JSON.stringify(r.b.body));
    const { rows } = await db.query(
      'SELECT id, confirmed_at IS NOT NULL AS confirmed, key_version FROM user_mfa_factors WHERE user_id = $1 AND disabled_at IS NULL ORDER BY created_at', [USER],
    );
    assert.deepEqual(rows.map((row) => [row.confirmed, Number(row.key_version)]), [[true, 2], [false, 2]]);
    assert.equal(rows[1].id, r.b.body.factorId);
  });
});

test('#208 (bariera, MFA): reset MFA przez administratora w trakcie rotacji klucza — reset czeka na blokadę konta i wyłącza obrócony czynnik; bez zakleszczenia', { skip }, async () => {
  await withReal(async (db) => {
    await enrolled(db);
    const admin = await seedUserSession(db, { userId: 'u-admin-1', mfa: true, roles: [{ role: 'admin' }] });
    const r = await rotationFirst(db, (env) => callApi(env, 'POST', `/api/admin/users/${USER}/mfa-reset`, admin, { confirm: USER }));
    assertWaitsOn(r, ACCOUNT_LOCK_SQL, 'reset czeka na blokadę wiersza konta');
    assert.equal(r.b.status, 200, JSON.stringify(r.b.body));
    assert.deepEqual([r.b.body.changed, r.b.body.disabledFactors], [true, 1]);
    assert.ok(r.b.body.invalidatedRecoveryCodes > 0, JSON.stringify(r.b.body));
    assert.deepEqual(await activeFactors(db), []);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL', [USER]), 0);
    assert.equal(await auditCount(db, 'mfa.reset'), 1);
  });
});

test('#208 (bariera, MFA): reset MFA przez administratora w trakcie ponownego zapisu czynnika — reset czeka na blokadę konta i wyłącza także nowy czynnik oczekujący', { skip }, async () => {
  await withReal(async (db) => {
    const owner = await seedUserSession(db, { userId: USER });
    const admin = await seedUserSession(db, { userId: 'u-admin-1', mfa: true, roles: [{ role: 'admin' }] });
    // Czynnik oczekujący z wcześniejszego „Włącz MFA”: ponowny zapis go wyłącza i wstawia nowy.
    const earlier = await callApi({ db, ...SINGLE }, 'POST', '/api/mfa/enroll', owner);
    assert.equal(earlier.status, 201, JSON.stringify(earlier.body));
    const r = await race(db, {
      pauseAfter: /INSERT INTO user_mfa_factors/,
      first: (env) => callApi(env, 'POST', '/api/mfa/enroll', owner),
      second: (env) => callApi(env, 'POST', `/api/admin/users/${USER}/mfa-reset`, admin, { confirm: USER }),
      extra: SINGLE,
    });
    assertWaitsOn(r, ACCOUNT_LOCK_SQL, 'reset czeka na blokadę wiersza konta');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    // Bez blokady konta UPDATE resetu czeka tylko na wiersz wyłączany przez zapis czynnika,
    // a nowego czynnika nie ma w jego migawce: reset kończy się changed: false (bez wylogowania
    // i bez zdarzenia), a czynnik oczekujący przetrwa reset.
    assert.equal(r.b.status, 200, JSON.stringify(r.b.body));
    assert.deepEqual([r.b.body.changed, r.b.body.disabledFactors], [true, 1]);
    assert.ok(r.b.body.revokedSessions >= 1, JSON.stringify(r.b.body));
    assert.deepEqual(await activeFactors(db), []);
    assert.equal(await auditCount(db, 'mfa.reset'), 1);
  });
});
