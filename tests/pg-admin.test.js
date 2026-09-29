import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { acceptInvitation } from '../src/pg/auth.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

// Wyłącznie dane syntetyczne (domeny .invalid).

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y-old', { startsOn: '2024-09-01', endsOn: '2025-08-31' });
  await seedSchoolYear(db, 'y-now', { startsOn: '2026-09-01', endsOn: '2099-08-31' });
  await seedClass(db, { id: 'c-old-1a', schoolYearId: 'y-old', name: '1A' });
  await seedClass(db, { id: 'c-now-1a', schoolYearId: 'y-now', name: '1A' });
  await seedClass(db, { id: 'c-now-2b', schoolYearId: 'y-now', name: '2B' });
  const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  await seedUser(db, { userId: 'u-target' });
  return { db, env: { db }, admin };
}

async function call(env, path, { cookie, method = 'GET', body, origin } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie, body, origin }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers };
}

const post = (env, path, cookie, body = {}) => call(env, path, { method: 'POST', cookie, body });

async function auditRows(db) {
  return (await db.query('SELECT actor_id, action, entity_type, entity_id, metadata_json::text AS metadata FROM audit_events ORDER BY occurred_at, id')).rows;
}

test('admin API refuses anonymous, non-admin, admin without MFA and cross-origin requests', async () => {
  const { db, env, admin } = await setup();
  try {
    assert.equal((await call(env, '/api/admin/users')).status, 401);

    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
    const treasurer = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer' }], mfa: true });
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-now-1a', schoolYearId: 'y-now' }], mfa: true });
    for (const cookie of [board, treasurer, rep]) {
      for (const path of ['/api/admin/users', '/api/admin/grants', '/api/admin/invitations', '/api/admin/audit', '/api/admin/school-years', '/api/admin/retention/preview']) {
        assert.equal((await call(env, path, { cookie })).status, 403, path);
      }
      const denied = await post(env, '/api/admin/grants', cookie, { userId: 'u-target', role: 'admin' });
      assert.equal(denied.status, 403);
    }

    const noMfa = await seedUserSession(db, { userId: 'u-admin-nomfa', roles: [{ role: 'admin' }], mfa: false });
    assert.equal((await call(env, '/api/admin/users', { cookie: noMfa })).status, 403);
    assert.equal((await post(env, '/api/admin/users/u-target/disable', noMfa)).status, 403);

    const expiredAdmin = await seedUserSession(db, { userId: 'u-admin-old', roles: [{ role: 'admin', expiresAt: '2020-01-01T00:00:00Z' }], mfa: true });
    assert.equal((await call(env, '/api/admin/users', { cookie: expiredAdmin })).status, 403);

    const crossOrigin = await call(env, '/api/admin/grants', {
      method: 'POST', cookie: admin, origin: 'https://evil.example', body: { userId: 'u-target', role: 'board' },
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.data.error, 'invalid_origin');
    const noOrigin = await call(env, '/api/admin/users/u-target/disable', { method: 'POST', cookie: admin, origin: false, body: {} });
    assert.equal(noOrigin.status, 403);

    const rows = (await db.query("SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-target'")).rows;
    assert.equal(rows[0].n, 0);
    assert.equal((await db.query("SELECT disabled_at FROM users WHERE id = 'u-target'")).rows[0].disabled_at, null);

    const users = await call(env, '/api/admin/users', { cookie: admin });
    assert.equal(users.status, 200);
    assert.equal(users.headers.get('Cache-Control'), 'no-store');
    const target = users.data.users.find((user) => user.id === 'u-target');
    assert.deepEqual(Object.keys(target).sort(),
      ['activeGrants', 'activeSessions', 'createdAt', 'disabledAt', 'displayName', 'email', 'id', 'mfaEnrolled']);
  } finally {
    await db.close();
  }
});

test('grant creation validates scope, blocks duplicates and is audited without PII', async () => {
  const { db, env, admin } = await setup();
  try {
    const missingClass = await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'representative', classId: 'c-missing' });
    assert.equal(missingClass.status, 422);
    assert.equal(missingClass.data.error, 'class_not_found');
    const missingYear = await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'board', schoolYearId: 'y-missing' });
    assert.equal(missingYear.data.error, 'school_year_not_found');
    const wrongYear = await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'representative', classId: 'c-now-1a', schoolYearId: 'y-old' });
    assert.equal(wrongYear.data.error, 'class_not_in_school_year');
    const noClass = await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'representative', schoolYearId: 'y-now' });
    assert.equal(noClass.data.error, 'class_required');
    const badRole = await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'superuser' });
    assert.equal(badRole.data.error, 'invalid_role');
    const pastExpiry = await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'board', expiresAt: '2020-01-01T00:00:00Z' });
    assert.equal(pastExpiry.data.error, 'invalid_expires_at');
    const noUser = await post(env, '/api/admin/grants', admin, { userId: 'u-nobody', role: 'board' });
    assert.equal(noUser.status, 404);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM role_grants WHERE user_id = $1', ['u-target'])).rows[0].n, 0);

    const created = await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'representative', classId: 'c-now-1a' });
    assert.equal(created.status, 201);
    assert.equal(created.data.grant.schoolYearId, 'y-now', 'rok dziedziczony z klasy');
    assert.equal(created.data.grant.grantedBy, 'u-admin');
    const again = await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'representative', classId: 'c-now-1a' });
    assert.equal(again.status, 200);
    assert.equal(again.data.created, false);
    assert.equal(again.data.grant.id, created.data.grant.id);

    // Drugi opiekun tej samej klasy i ta sama osoba w innej klasie to osobne przydziały.
    await seedUser(db, { userId: 'u-second' });
    assert.equal((await post(env, '/api/admin/grants', admin, { userId: 'u-second', role: 'representative', classId: 'c-now-1a' })).status, 201);
    assert.equal((await post(env, '/api/admin/grants', admin, { userId: 'u-target', role: 'representative', classId: 'c-now-2b' })).status, 201);

    const filtered = await call(env, '/api/admin/grants?classId=c-now-1a&role=representative', { cookie: admin });
    assert.deepEqual(filtered.data.grants.map((grant) => grant.userId).sort(), ['u-second', 'u-target']);
    assert.equal((await call(env, '/api/admin/grants?status=bogus', { cookie: admin })).status, 400);

    await seedUser(db, { userId: 'u-off', disabled: true });
    assert.equal((await post(env, '/api/admin/grants', admin, { userId: 'u-off', role: 'board' })).data.error, 'user_disabled');

    const events = (await auditRows(db)).filter((row) => row.action === 'role_grant.created');
    assert.equal(events.length, 3);
    for (const event of events) {
      assert.equal(event.actor_id, 'u-admin');
      assert.doesNotMatch(event.metadata, /@|example\.invalid|Test u-/);
    }
  } finally {
    await db.close();
  }
});

// #146: samonadanie roli omijałoby zasadę czterech oczu (admin nadaje sobie
// treasurer/board bez udziału drugiej osoby).
test('an admin cannot grant themselves a role, but another admin can grant it to them', async () => {
  const { db, env, admin } = await setup();
  try {
    const selfGrant = await post(env, '/api/admin/grants', admin, { userId: 'u-admin', role: 'treasurer' });
    assert.equal(selfGrant.status, 409);
    assert.equal(selfGrant.data.error, 'cannot_grant_self');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-admin' AND role = 'treasurer'")).rows[0].n, 0);
    assert.equal((await auditRows(db)).filter((row) => row.action === 'role_grant.created').length, 0);

    // Podwójne kliknięcie tego samego (odrzuconego) żądania: nadal 409, nic nie powstaje.
    const repeat = await post(env, '/api/admin/grants', admin, { userId: 'u-admin', role: 'treasurer' });
    assert.equal(repeat.status, 409);
    assert.equal(repeat.data.error, 'cannot_grant_self');

    // Samonadanie własnej roli reprezentanta (nie tylko ról merytorycznych) jest tak samo odrzucane.
    assert.equal((await post(env, '/api/admin/grants', admin, { userId: 'u-admin', role: 'representative', classId: 'c-now-1a' })).data.error, 'cannot_grant_self');

    // Obejście przez zaproszenie na własny adres: odrzucone przy tworzeniu (bez
    // wiersza i zdarzenia) — także z inną wielkością liter i spacjami.
    const selfInvite = await post(env, '/api/admin/invitations', admin, { email: ' U-Admin@Example.invalid ', role: 'treasurer' });
    assert.equal(selfInvite.status, 409);
    assert.equal(selfInvite.data.error, 'cannot_grant_self');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM invitations WHERE lower(email) = 'u-admin@example.invalid'")).rows[0].n, 0);
    assert.equal((await auditRows(db)).filter((row) => row.action === 'invitation.created').length, 0);

    // Zaproszenie wystawione przez to samo konto innym sposobem (np. zapis
    // sprzed poprawki) nie nadaje roli przy przyjęciu.
    const { hashSecret } = await import('../src/auth.js');
    const token = 'S'.repeat(43);
    await db.query(
      `INSERT INTO invitations (id, email, token_hash, role, created_by, expires_at)
       VALUES ('inv-self', 'u-admin@example.invalid', $1, 'treasurer', 'u-admin', now() + interval '1 hour')`,
      [await hashSecret(token)],
    );
    const accepted = await acceptInvitation(env, { token, userId: 'u-admin' });
    assert.equal(accepted.ok, false);
    assert.equal(accepted.reason, 'self_invitation');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-admin' AND role = 'treasurer'")).rows[0].n, 0);

    // Druga osoba z rolą admina może nadać przydział pierwszej.
    const second = await seedUserSession(db, { userId: 'u-admin2', roles: [{ role: 'admin' }], mfa: true });
    const granted = await post(env, '/api/admin/grants', second, { userId: 'u-admin', role: 'treasurer' });
    assert.equal(granted.status, 201);
    assert.equal(granted.data.grant.grantedBy, 'u-admin2');
  } finally {
    await db.close();
  }
});

test('revoking grants keeps history and an admin cannot remove their own last admin grant', async () => {
  const { db, env, admin } = await setup();
  try {
    const own = (await call(env, '/api/admin/grants?userId=u-admin', { cookie: admin })).data.grants;
    assert.equal(own.length, 1);
    const lockout = await post(env, `/api/admin/grants/${own[0].id}/revoke`, admin);
    assert.equal(lockout.status, 409);
    assert.equal(lockout.data.error, 'last_admin_grant');
    assert.equal((await db.query('SELECT revoked_at FROM role_grants WHERE id = $1', [own[0].id])).rows[0].revoked_at, null);
    assert.equal((await auditRows(db)).filter((row) => row.action === 'role_grant.revoked').length, 0, 'wycofana transakcja nie zostawia audytu');

    assert.equal((await post(env, '/api/admin/users/u-admin/disable', admin)).data.error, 'cannot_disable_self');

    // Z drugim przydziałem admina wycofanie pierwszego jest dozwolone. Samonadanie jest
    // zabronione (#146), więc drugi przydział wydaje inny administrator.
    const grantor = await seedUserSession(db, { userId: 'u-admin-grantor', roles: [{ role: 'admin' }], mfa: true });
    const second = await post(env, '/api/admin/grants', grantor, { userId: 'u-admin', role: 'admin', schoolYearId: 'y-now' });
    assert.equal(second.status, 201);
    const ok = await post(env, `/api/admin/grants/${own[0].id}/revoke`, admin);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.changed, true);
    assert.equal(ok.data.grant.status, 'revoked');
    const repeat = await post(env, `/api/admin/grants/${own[0].id}/revoke`, admin);
    assert.equal(repeat.data.changed, false, 'podwójne kliknięcie nie tworzy drugiego zdarzenia');
    assert.equal((await post(env, '/api/admin/grants/g-missing/revoke', admin)).status, 404);

    const history = await call(env, '/api/admin/grants?userId=u-admin&status=all', { cookie: admin });
    assert.equal(history.data.grants.length, 2);
    const revokedEvents = (await auditRows(db)).filter((row) => row.action === 'role_grant.revoked');
    assert.equal(revokedEvents.length, 1);
    assert.equal(revokedEvents[0].entity_id, own[0].id);

    // Wycofanie przydziału innej osoby działa od razu (przydziały są czytane przy każdym żądaniu).
    const boardCookie = await seedUserSession(db, { userId: 'u-board2', roles: [{ role: 'admin' }], mfa: true });
    const boardGrant = (await call(env, '/api/admin/grants?userId=u-board2', { cookie: admin })).data.grants[0];
    assert.equal((await post(env, `/api/admin/grants/${boardGrant.id}/revoke`, admin)).status, 200);
    assert.equal((await call(env, '/api/admin/users', { cookie: boardCookie })).status, 403);
  } finally {
    await db.close();
  }
});

test('closing a finished school year expires its grants and audits each one', async () => {
  const { db, env, admin } = await setup();
  try {
    await seedUserSession(db, { userId: 'u-rep-old', roles: [{ role: 'representative', classId: 'c-old-1a' }] });
    // Przydział klasy bez wpisanego roku też należy do kadencji klasy.
    await db.query("INSERT INTO role_grants (id, user_id, role, class_id) VALUES ('g-classonly', 'u-target', 'representative', 'c-old-1a')");
    await db.query("INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ('g-board-old', 'u-target', 'board', 'y-old')");
    await db.query("INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ('g-board-now', 'u-target', 'board', 'y-now')");
    await db.query("INSERT INTO role_grants (id, user_id, role, school_year_id, revoked_at, revoked_by) VALUES ('g-revoked-old', 'u-target', 'board', 'y-old', now(), 'u-admin')");

    assert.equal((await post(env, '/api/admin/school-years/y-old/expire-grants', admin, {})).data.error, 'confirmation_required');
    const notFinished = await post(env, '/api/admin/school-years/y-now/expire-grants', admin, { confirm: 'y-now' });
    assert.equal(notFinished.status, 409);
    assert.equal(notFinished.data.error, 'school_year_not_finished');

    const closed = await post(env, '/api/admin/school-years/y-old/expire-grants', admin, { confirm: 'y-old' });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.expired, 3);
    assert.ok(closed.data.grantIds.includes('g-classonly'));

    const statuses = Object.fromEntries((await call(env, '/api/admin/grants?userId=u-target&status=all', { cookie: admin }))
      .data.grants.map((grant) => [grant.id, grant.status]));
    assert.equal(statuses['g-classonly'], 'expired');
    assert.equal(statuses['g-board-old'], 'expired');
    assert.equal(statuses['g-board-now'], 'active');
    assert.equal(statuses['g-revoked-old'], 'revoked');

    const again = await post(env, '/api/admin/school-years/y-old/expire-grants', admin, { confirm: 'y-old' });
    assert.equal(again.data.expired, 0, 'ponowienie niczego nie zmienia');

    const events = await auditRows(db);
    assert.equal(events.filter((row) => row.action === 'role_grant.expired').length, 3);
    assert.equal(events.filter((row) => row.action === 'school_year.grants_expired').length, 2);
    for (const event of events) assert.doesNotMatch(event.metadata, /@/);

    // Admin, którego jedyny przydział należy do zamykanego roku, nie może się zablokować.
    await seedSchoolYear(db, 'y-older', { startsOn: '2023-09-01', endsOn: '2024-08-31' });
    const yearAdmin = await seedUserSession(db, { userId: 'u-year-admin', roles: [{ role: 'admin', schoolYearId: 'y-older' }], mfa: true });
    const lockout = await post(env, '/api/admin/school-years/y-older/expire-grants', yearAdmin, { confirm: 'y-older' });
    assert.equal(lockout.status, 409);
    assert.equal(lockout.data.error, 'last_admin_grant');
    assert.equal((await call(env, '/api/admin/users', { cookie: yearAdmin })).status, 200);
  } finally {
    await db.close();
  }
});

test('disabling a user revokes all their sessions; enable restores login ability only', async () => {
  const { db, env, admin } = await setup();
  try {
    const first = await seedUserSession(db, { userId: 'u-victim', roles: [{ role: 'board' }], mfa: true });
    const second = await seedUserSession(db, { userId: 'u-victim' });
    assert.equal((await call(env, '/api/session', { cookie: first })).status, 200);

    const disabled = await post(env, '/api/admin/users/u-victim/disable', admin);
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.revokedSessions, 2);
    for (const cookie of [first, second]) assert.equal((await call(env, '/api/session', { cookie })).status, 401);
    const sessions = (await db.query("SELECT revoked_at, revoked_reason FROM sessions WHERE user_id = 'u-victim'")).rows;
    assert.ok(sessions.every((row) => row.revoked_at && row.revoked_reason === 'user_disabled'));

    const repeat = await post(env, '/api/admin/users/u-victim/disable', admin);
    assert.equal(repeat.data.changed, false);
    assert.equal(repeat.data.revokedSessions, 0);

    const enabled = await post(env, '/api/admin/users/u-victim/enable', admin);
    assert.equal(enabled.data.changed, true);
    for (const cookie of [first, second]) assert.equal((await call(env, '/api/session', { cookie })).status, 401, 'wycofane sesje nie wracają');
    assert.equal((await post(env, '/api/admin/users/u-nobody/disable', admin)).status, 404);

    const third = await seedUserSession(db, { userId: 'u-victim' });
    const revoked = await post(env, '/api/admin/users/u-victim/revoke-sessions', admin);
    assert.equal(revoked.data.revokedSessions, 1);
    assert.equal((await call(env, '/api/session', { cookie: third })).status, 401);

    const events = await auditRows(db);
    assert.deepEqual(events.filter((row) => row.entity_type === 'user').map((row) => row.action), ['user.disabled', 'user.enabled']);
    assert.equal(events.filter((row) => row.action === 'session.revoked').length, 3);
    for (const event of events) {
      assert.equal(event.actor_id, 'u-admin');
      assert.doesNotMatch(event.metadata, /@/);
    }
  } finally {
    await db.close();
  }
});

// #256: disabled_at i trwałe wycofanie sesji muszą zatwierdzić się razem.
// Przed poprawką były dwiema osobnymi transakcjami — awaria drugiej
// zostawiała disabled_at zapisane, a sesje aktywne w bazie (revoked_at IS
// NULL); ponowne włączenie konta mogło je potem znów zaakceptować.
test('#256: disable rolls back entirely when revoking sessions fails (no half-disabled account)', async () => {
  const { db, admin } = await setup();
  try {
    const victim = await seedUserSession(db, { userId: 'u-victim2' });

    let calls = 0;
    const failingOnce = {
      // Kontrakt src/db.js: query(text, params) -> { rows }, transaction(fn).
      query: (text, params) => db.query(text, params),
      transaction: (fn) => db.transaction((tx) => fn({
        query: (text, params) => {
          if (calls === 0 && typeof text === 'string' && text.includes('UPDATE sessions SET revoked_at')) {
            calls += 1;
            throw Object.assign(new Error('injected_failure'), { code: '40001' });
          }
          return tx.query(text, params);
        },
      })),
    };
    const env = { db: failingOnce };

    const disabled = await post(env, '/api/admin/users/u-victim2/disable', admin);
    assert.equal(disabled.status, 503, 'awaria wycofania sesji ujawnia się jako błąd, nie 200');
    assert.equal(calls, 1);

    // Cała transakcja (disabled_at, audyt, wycofanie sesji) poszła w jednej
    // paczce, więc awaria wycofania sesji cofa też disabled_at — konto nie
    // zostaje w stanie „wyłączone, ale z aktywną sesją”.
    const userRow = (await db.query("SELECT disabled_at FROM users WHERE id = 'u-victim2'")).rows[0];
    assert.equal(userRow.disabled_at, null, 'disabled_at nie mógł zostać zapisany bez wycofania sesji');
    const sessionRow = (await db.query("SELECT revoked_at FROM sessions WHERE user_id = 'u-victim2'")).rows[0];
    assert.equal(sessionRow.revoked_at, null, 'sesja pozostaje aktywna, tak jak disabled_at');
    assert.equal((await call({ db }, '/api/session', { cookie: victim })).status, 200, 'sesja nadal działa — konto nie jest w cichej połowicznej blokadzie');

    const eventsAfterFailure = await auditRows(db);
    assert.equal(eventsAfterFailure.filter((row) => row.entity_type === 'user' && row.entity_id === 'u-victim2').length, 0,
      'audyt user.disabled też nie mógł się zapisać bez wycofania sesji');

    // Ponowienie bez wstrzykniętej awarii jest bezpieczne i kończy się sukcesem.
    const retried = await post({ db }, '/api/admin/users/u-victim2/disable', admin);
    assert.equal(retried.status, 200);
    assert.equal(retried.data.changed, true);
    assert.equal(retried.data.revokedSessions, 1);
    assert.equal((await call({ db }, '/api/session', { cookie: victim })).status, 401);
  } finally {
    await db.close();
  }
});

// #256 (dowód atomowości bez RD_TEST_PG_URL): błąd wstrzyknięty PO wykonaniu
// UPDATE sessions i zapisie user.disabled — czyli po drugim zapytaniu
// transakcji — cofa całość: disabled_at, audyt i revoked_at sesji. Test
// wyścigu na prawdziwym PostgreSQL (pg-disable-session-race) jest w CI
// pomijany bez RD_TEST_PG_URL, a PGlite nie odtwarza przeplotu, więc to
// jest dowód, że oba zapisy tworzą jedną transakcję.
test('#256: an error after the session UPDATE rolls back disabled_at, audit and revoked_at together', async () => {
  const { db, admin } = await setup();
  try {
    const victim = await seedUserSession(db, { userId: 'u-victim3' });
    const seen = [];
    let injected = 0;
    const failingLate = {
      query: (text, params) => db.query(text, params),
      transaction: (fn) => db.transaction((tx) => fn({
        query: async (text, params) => {
          const isSessionAudit = typeof text === 'string' && Array.isArray(params) && params.includes('session.revoked');
          if (isSessionAudit && injected === 0) {
            injected += 1;
            // Zapytanie UPDATE sessions już się wykonało w tej transakcji.
            const inside = await tx.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = 'u-victim3' AND revoked_at IS NOT NULL");
            seen.push(inside.rows[0].n);
            throw Object.assign(new Error('injected_failure'), { code: '40001' });
          }
          return tx.query(text, params);
        },
      })),
    };

    const disabled = await post({ db: failingLate }, '/api/admin/users/u-victim3/disable', admin);
    assert.equal(disabled.status, 503);
    assert.equal(injected, 1, 'błąd wstrzyknięty po zapytaniu UPDATE sessions');
    assert.deepEqual(seen, [1], 'w chwili błędu sesja była już oznaczona jako wycofana (wewnątrz transakcji)');

    assert.equal((await db.query("SELECT disabled_at FROM users WHERE id = 'u-victim3'")).rows[0].disabled_at, null);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = 'u-victim3' AND revoked_at IS NOT NULL")).rows[0].n, 0,
      'revoked_at sesji też cofnięte razem z disabled_at');
    const events = (await auditRows(db)).filter((row) => row.entity_id === 'u-victim3' || row.action === 'session.revoked');
    assert.equal(events.length, 0, 'żadne zdarzenie user.disabled / session.revoked nie przetrwało');
    assert.equal((await call({ db }, '/api/session', { cookie: victim })).status, 200);
  } finally {
    await db.close();
  }
});

test('invitations return the token once, block duplicates, can be revoked and never log the address', async () => {
  const { db, env, admin } = await setup();
  try {
    const bad = await post(env, '/api/admin/invitations', admin, { email: 'not-an-email', role: 'board' });
    assert.equal(bad.data.error, 'invalid_email');
    const noClass = await post(env, '/api/admin/invitations', admin, { email: 'rep@example.invalid', role: 'representative', classId: 'c-missing' });
    assert.equal(noClass.data.error, 'class_not_found');

    const created = await post(env, '/api/admin/invitations', admin, { email: 'Rep@Example.invalid', role: 'representative', classId: 'c-now-1a', ttlHours: 24 });
    assert.equal(created.status, 201);
    assert.match(created.data.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(created.data.invitation.schoolYearId, 'y-now');
    assert.equal(created.headers.get('Cache-Control'), 'no-store');

    const duplicate = await post(env, '/api/admin/invitations', admin, { email: 'rep@example.invalid', role: 'representative', classId: 'c-now-1a' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.error, 'invitation_pending');

    const list = await call(env, '/api/admin/invitations', { cookie: admin });
    assert.equal(list.data.invitations.length, 1);
    assert.equal(list.data.invitations[0].status, 'pending');
    assert.ok(!JSON.stringify(list.data).includes(created.data.token), 'token nie wraca w liście');
    const stored = (await db.query('SELECT token_hash FROM invitations')).rows[0].token_hash;
    assert.notEqual(stored, created.data.token);

    const revoked = await post(env, `/api/admin/invitations/${created.data.invitation.id}/revoke`, admin);
    assert.equal(revoked.data.changed, true);
    assert.equal((await post(env, `/api/admin/invitations/${created.data.invitation.id}/revoke`, admin)).data.changed, false);
    assert.equal((await post(env, '/api/admin/invitations/i-missing/revoke', admin)).status, 404);

    // Przyjęcie (funkcja danych; trasa HTTP czeka na D-10) — zaakceptowanego nie da się wycofać.
    const next = await post(env, '/api/admin/invitations', admin, { email: 'board@example.invalid', role: 'board' });
    await seedUser(db, { userId: 'u-new', email: 'board@example.invalid' });
    assert.equal((await acceptInvitation(env, { token: next.data.token, userId: 'u-new' })).ok, true);
    assert.equal((await post(env, `/api/admin/invitations/${next.data.invitation.id}/revoke`, admin)).data.error, 'invitation_already_accepted');

    const audit = await call(env, '/api/admin/audit?limit=50', { cookie: admin });
    const actions = audit.data.events.map((event) => event.action);
    assert.ok(actions.includes('invitation.created') && actions.includes('invitation.revoked') && actions.includes('role_grant.created'));
    const allAudit = JSON.stringify(await auditRows(db));
    assert.doesNotMatch(allAudit, /example\.invalid/i);
    assert.ok(!allAudit.includes(created.data.token));
  } finally {
    await db.close();
  }
});

// #224: panel admina otrzymał akcje resetu hasła i resetu MFA (API istniało
// wcześniej, #238) — testy przechodzą przez trasę HTTP, nie przez funkcje login.js.
test('password reset and MFA reset: single valid token, self-reset blocked, disabled accounts refused', async () => {
  const { db, env, admin } = await setup();
  try {
    // Podwójne kliknięcie „Wydaj kod resetu”: drugi token unieważnia pierwszy.
    const first = await post(env, '/api/admin/users/u-target/password-reset', admin, {});
    assert.equal(first.status, 201);
    assert.match(first.data.token, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(first.data.reset.userId, 'u-target');
    const second = await post(env, '/api/admin/users/u-target/password-reset', admin, {});
    assert.equal(second.status, 201);
    assert.notEqual(second.data.token, first.data.token);
    const tokens = (await db.query(
      "SELECT used_at, revoked_at FROM password_reset_tokens WHERE user_id = 'u-target' ORDER BY created_at",
    )).rows;
    assert.equal(tokens.length, 2);
    assert.ok(tokens[0].revoked_at, 'pierwszy nieużyty token jest unieważniony przez drugi');
    assert.equal(tokens[1].revoked_at, null);

    // Nieprawidłowy ttlHours jest odrzucony, ważny mieści się w limicie.
    assert.equal((await post(env, '/api/admin/users/u-target/password-reset', admin, { ttlHours: 1000 })).data.error, 'invalid_ttl');
    assert.equal((await post(env, '/api/admin/users/u-target/password-reset', admin, { ttlHours: 24 })).status, 201);

    // Admin nie może wydać resetu ani zresetować MFA własnego konta.
    assert.equal((await post(env, '/api/admin/users/u-admin/password-reset', admin, {})).status, 201, 'reset hasła własnego konta jest dozwolony');
    const ownMfa = await post(env, '/api/admin/users/u-admin/mfa-reset', admin, { confirm: 'u-admin' });
    assert.equal(ownMfa.status, 409);
    assert.equal(ownMfa.data.error, 'cannot_reset_own_mfa');

    // Konto wyłączone: reset hasła niedostępny.
    await seedUser(db, { userId: 'u-off', disabled: true });
    const offReset = await post(env, '/api/admin/users/u-off/password-reset', admin, {});
    assert.equal(offReset.status, 409);
    assert.equal(offReset.data.error, 'user_disabled');

    // Reset MFA bez potwierdzenia identyfikatora konta jest odrzucony.
    const noConfirm = await post(env, '/api/admin/users/u-target/mfa-reset', admin, {});
    assert.equal(noConfirm.data.error, 'confirmation_required');
    const wrongConfirm = await post(env, '/api/admin/users/u-target/mfa-reset', admin, { confirm: 'u-inny' });
    assert.equal(wrongConfirm.data.error, 'confirmation_required');

    // Konto bez zapisanego czynnika ani kodów odzyskiwania: reset nic nie zmienia.
    const untouched = await post(env, '/api/admin/users/u-target/mfa-reset', admin, { confirm: 'u-target' });
    assert.equal(untouched.status, 200);
    assert.equal(untouched.data.changed, false);

    // Konto z potwierdzonym czynnikiem: reset wyłącza czynnik, wylogowuje i loguje zdarzenie bez PII.
    const victim = await seedUserSession(db, { userId: 'u-mfa-victim', roles: [{ role: 'board' }], mfa: true });
    await db.query(
      `INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, confirmed_at)
       VALUES ('f-victim', 'u-mfa-victim', 'totp', 'AAAAAAAAAA', 'BBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCCCC', now())`,
    );
    const reset = await post(env, '/api/admin/users/u-mfa-victim/mfa-reset', admin, { confirm: 'u-mfa-victim' });
    assert.equal(reset.status, 200);
    assert.equal(reset.data.changed, true);
    assert.equal(reset.data.disabledFactors, 1);
    assert.equal(
      (await db.query("SELECT disabled_at FROM user_mfa_factors WHERE id = 'f-victim'")).rows[0].disabled_at !== null,
      true,
    );
    assert.equal((await call(env, '/api/session', { cookie: victim })).status, 401, 'reset MFA wylogowuje konto');

    const users = await call(env, '/api/admin/users', { cookie: admin });
    const target = users.data.users.find((user) => user.id === 'u-mfa-victim');
    assert.equal(target.mfaEnrolled, false, 'po resecie czynnik nie jest już aktywny');
    const stillEnrolled = await seedUserSession(db, { userId: 'u-mfa-ok', mfa: true });
    await db.query(
      `INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, confirmed_at)
       VALUES ('f-ok', 'u-mfa-ok', 'totp', 'DDDDDDDDDD', 'EEEEEEEEEEEEEEEE', 'FFFFFFFFFFFFFFFFFFFFFF', now())`,
    );
    void stillEnrolled;
    const usersAfter = await call(env, '/api/admin/users', { cookie: admin });
    assert.equal(usersAfter.data.users.find((user) => user.id === 'u-mfa-ok').mfaEnrolled, true);

    const events = (await auditRows(db)).filter((row) => row.action.startsWith('auth.password_reset') || row.action === 'mfa.reset');
    assert.ok(events.length >= 5);
    for (const event of events) assert.doesNotMatch(event.metadata, /@|example\.invalid/);
  } finally {
    await db.close();
  }
});

// #150 (SR-10, krok w górę): reset hasła, reset MFA i nadanie roli — operacje
// nieodwracalne na cudzym koncie — wymagają MFA potwierdzonego od niedawna
// (15 min), nie tylko kiedyś w bieżącej sesji. Sprawdzane PO roli admina
// (SR-07): konto bez dostępu w ogóle dostaje zwykłe `forbidden` (patrz test
// wyżej), niezależnie od wieku MFA.
test('password reset, MFA reset and role grant require FRESH MFA (step-up)', async () => {
  const { db, env } = await setup();
  try {
    const stale = await seedUserSession(db, { userId: 'u-admin-stale', roles: [{ role: 'admin' }], mfa: true });
    await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-admin-stale'");

    const staleReset = await post(env, '/api/admin/users/u-target/password-reset', stale, {});
    assert.equal(staleReset.status, 403);
    assert.equal(staleReset.data.error, 'mfa_stale');

    const staleMfaReset = await post(env, '/api/admin/users/u-target/mfa-reset', stale, { confirm: 'u-target' });
    assert.equal(staleMfaReset.status, 403);
    assert.equal(staleMfaReset.data.error, 'mfa_stale');

    const staleGrant = await post(env, '/api/admin/grants', stale, { userId: 'u-target', role: 'board' });
    assert.equal(staleGrant.status, 403);
    assert.equal(staleGrant.data.error, 'mfa_stale');

    // Zaproszenie nadaje rolę przy przyjęciu — ten sam krok w górę co /grants
    // (inaczej przejęta sesja ze starym MFA zapraszała dowolny adres do roli admin).
    const staleInvite = await post(env, '/api/admin/invitations', stale, { email: 'stale-invite@example.invalid', role: 'admin' });
    assert.equal(staleInvite.status, 403);
    assert.equal(staleInvite.data.error, 'mfa_stale');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM invitations WHERE email = 'stale-invite@example.invalid'")).rows[0].n, 0);
    await db.query("UPDATE sessions SET mfa_verified_at = now() WHERE user_id = 'u-admin-stale'");
    const freshInvite = await post(env, '/api/admin/invitations', stale, { email: 'stale-invite@example.invalid', role: 'board' });
    assert.equal(freshInvite.status, 201);
    await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-admin-stale'");
    const staleReissue = await post(env, `/api/admin/invitations/${freshInvite.data.invitation.id}/reissue`, stale, {});
    assert.equal(staleReissue.status, 403);
    assert.equal(staleReissue.data.error, 'mfa_stale');

    // Trasy poza zakresem #150 część 2 (lista, wyłączenie/włączenie konta,
    // cofnięcie sesji, cofnięcie przydziału) nadal działają z MFA "kiedyś w sesji".
    await seedUser(db, { userId: 'u-other-target' });
    assert.equal((await call(env, '/api/admin/users', { cookie: stale })).status, 200);
    assert.equal((await post(env, '/api/admin/users/u-other-target/disable', stale, {})).status, 200);

    assert.equal(
      (await db.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action IN ('auth.password_reset_issued', 'mfa.reset', 'role_grant.created', 'invitation.reissued')",
      )).rows[0].n,
      0,
      'odmowa mfa_stale nic nie zapisuje',
    );

    // Po ponownym potwierdzeniu kodu (mfa_verified_at znów świeże) żądanie przechodzi.
    await db.query("UPDATE sessions SET mfa_verified_at = now() WHERE user_id = 'u-admin-stale'");
    assert.equal((await post(env, '/api/admin/users/u-target/password-reset', stale, {})).status, 201);
    assert.equal((await post(env, '/api/admin/grants', stale, { userId: 'u-target', role: 'board' })).status, 201);
  } finally {
    await db.close();
  }
});

test('reference data lists years with finished flag and classes', async () => {
  const { db, env, admin } = await setup();
  try {
    const result = await call(env, '/api/admin/school-years', { cookie: admin });
    const old = result.data.schoolYears.find((year) => year.id === 'y-old');
    assert.equal(old.finished, true);
    assert.deepEqual(old.classes, [{ id: 'c-old-1a', name: '1A' }]);
    assert.equal((await call(env, '/api/admin/unknown', { cookie: admin })).status, 404);
    assert.equal((await call(env, '/api/admin/users', { cookie: admin, method: 'DELETE', body: {} })).status, 405);
  } finally {
    await db.close();
  }
});
