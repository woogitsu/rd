// #208 (inwentaryzacja blokad, scripts/lock-inventory.js): testy z barierą na PRAWDZIWYM
// PostgreSQL dla blokad wierszy kont i limitu logowania, których brak daje realny wyścig:
// dwa ważne tokeny resetu hasła po podwójnym „Wydaj token”, próba hasła ponad limit
// pary e-mail + IP przy dwóch równoległych logowaniach oraz przydział roli na koncie
// wyłączanym w tej samej chwili.
//
// Schemat jak w pg-real-record-locks (tests/helpers/pg-race.js): pierwsze żądanie staje
// W TRANSAKCJI, drugie startuje osobnym połączeniem i musi czekać w bazie na zapytanie z
// blokadą z kodu (`pg_stat_activity`); dopiero potem pierwsze zatwierdza.
//
// Plik działa wyłącznie z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Wyłącznie dane syntetyczne (@example.invalid); nic nie wysyła wiadomości.
// Kontrola mutacyjna: scripts/check-lock-mutations.js (mutanty password-reset-issue,
// login-attempt-reserve, grant-target-lock); każdy pada także na samym skutku (sprawdzone
// z wyłączonymi asercjami miejsca czekania).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOGIN_POLICY } from '../src/pg/login.js';
import { seedClass, seedUser, seedUserSession } from './helpers/pg.js';
import { callApi, countRows } from './helpers/pg-barrier.js';
import { assertWaitsOn, auditCount, race, withReal } from './helpers/pg-race.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';

test('#208 (bariera, konta): dwóch administratorów naraz wydaje token resetu hasła — drugi czeka na blokadę konta i unieważnia pierwszy; jeden ważny token', { skip }, async () => {
  await withReal(async (db) => {
    await seedUser(db, { userId: 'u-target' });
    const adminA = await seedUserSession(db, { userId: 'u-admin-1', mfa: true, roles: [{ role: 'admin' }] });
    const adminB = await seedUserSession(db, { userId: 'u-admin-2', mfa: true, roles: [{ role: 'admin' }] });
    const path = '/api/admin/users/u-target/password-reset';
    const r = await race(db, {
      pauseAfter: /INSERT INTO password_reset_tokens/,
      first: (env) => callApi(env, 'POST', path, adminA, {}),
      second: (env) => callApi(env, 'POST', path, adminB, {}),
    });
    assertWaitsOn(r, /^SELECT id, disabled_at FROM users WHERE id = \$1 FOR UPDATE/, 'drugie wydanie czeka na blokadę wiersza konta');
    assert.equal(r.a.status, 201, JSON.stringify(r.a.body));
    assert.equal(r.b.status, 201, JSON.stringify(r.b.body));
    // Bez blokady UPDATE „unieważnij poprzednie” drugiego żądania nie widzi niezatwierdzonego
    // tokenu pierwszego, więc zostają dwa ważne tokeny (podwójne kliknięcie = jeden token).
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = 'u-target' AND used_at IS NULL AND revoked_at IS NULL"), 1);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = 'u-target' AND revoked_at IS NOT NULL"), 1);
    assert.equal(await auditCount(db, 'auth.password_reset_issued'), 2);
  });
});

test('#208 (bariera, logowanie): dwie równoległe próby przy jednej wolnej w oknie pary e-mail + IP — druga czeka na blokadę limitu i dostaje 429 bez sprawdzania hasła', { skip }, async () => {
  await withReal(async (db) => {
    const body = { email: 'brak-konta@example.invalid', password: 'Niepoprawne-haslo-1' };
    const env = { db };
    for (let i = 1; i < LOGIN_POLICY.pairMaxFailures; i += 1) {
      const failed = await callApi(env, 'POST', '/api/login', null, body);
      assert.equal(failed.status, 401, JSON.stringify(failed.body));
    }
    const r = await race(db, {
      // A staje po odczycie wierszy limitu (SELECT … FOR UPDATE), przed rezerwacją próby.
      // Wzorzec nie zawiera samego FOR UPDATE, żeby mutant bez blokady też dochodził do bariery.
      pauseAfter: /^\s*SELECT scope_type, scope_hash, failure_count/,
      first: (gated) => callApi(gated, 'POST', '/api/login', null, body),
      second: (plain) => callApi(plain, 'POST', '/api/login', null, body),
    });
    assertWaitsOn(r, /^SELECT scope_type, scope_hash, failure_count/, 'druga próba czeka na blokadę wierszy limitu');
    // Pierwsza próba wyczerpuje okno: błędne hasło i blokada pary (429).
    assert.deepEqual([r.a.status, r.a.body.error], [429, 'too_many_attempts']);
    assert.deepEqual([r.b.status, r.b.body.error], [429, 'too_many_attempts']);
    // Bez blokady druga próba czyta licznik sprzed rezerwacji pierwszej, przechodzi
    // sprawdzenie i liczy hasło ponad limit pary (inny licznik i dodatkowe „login_failed”).
    assert.equal(await countRows(db, "SELECT max(failure_count)::int AS n FROM login_rate_limits WHERE scope_type = 'pair'"), LOGIN_POLICY.pairMaxFailures);
    assert.equal(await auditCount(db, 'auth.login_failed'), LOGIN_POLICY.pairMaxFailures);
  });
});

test('#208 (bariera, konta): nadanie roli w trakcie wyłączania konta — czeka na blokadę konta i dostaje 409 user_disabled; bez przydziału na wyłączonym koncie', { skip }, async () => {
  await withReal(async (db) => {
    await seedClass(db, { id: 'c-1a', schoolYearId: 'y-2026', name: '1A' });
    await seedUser(db, { userId: 'u-target' });
    const adminA = await seedUserSession(db, { userId: 'u-admin-1', mfa: true, roles: [{ role: 'admin' }] });
    const adminB = await seedUserSession(db, { userId: 'u-admin-2', mfa: true, roles: [{ role: 'admin' }] });
    const r = await race(db, {
      pauseAfter: /UPDATE users SET disabled_at = now\(\)/,
      first: (env) => callApi(env, 'POST', '/api/admin/users/u-target/disable', adminA, {}),
      second: (env) => callApi(env, 'POST', '/api/admin/grants', adminB, { userId: 'u-target', role: 'representative', classId: 'c-1a', schoolYearId: 'y-2026' }),
    });
    assertWaitsOn(r, /^SELECT id, disabled_at FROM users WHERE id = \$1 FOR UPDATE/, 'nadanie roli czeka na blokadę wiersza konta');
    assert.equal(r.a.status, 200, JSON.stringify(r.a.body));
    // Bez blokady nadanie czyta konto jako aktywne, a klucz obcy przydziału nie czeka na
    // UPDATE disabled_at (różne tryby blokady), więc przydział powstaje na koncie wyłączanym.
    assert.deepEqual([r.b.status, r.b.body.error], [409, 'user_disabled']);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-target'"), 0);
    assert.equal(await auditCount(db, 'role_grant.created'), 0);
  });
});
