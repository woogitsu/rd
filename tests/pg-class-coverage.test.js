// Obsada klas i „wyślij ponownie” dla zaproszeń przedstawicieli (#108).
// Wyłącznie dane syntetyczne (domeny .invalid).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const Y = 'y-2026';

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, Y, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: Y, name: '1B' });
  const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
  return { db, env: { db }, admin, board };
}

async function call(env, path, { cookie, method = 'GET', body, origin } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie, body, origin }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}
const post = (env, path, cookie, body = {}) => call(env, path, { method: 'POST', cookie, body });

describe('tabela obsady klas (#108)', () => {
  test('wyłącznie admin — zarząd i przedstawiciel dostają 403', async () => {
    const { env, board } = await setup();
    const rep = await seedUserSession(env.db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }], mfa: true });
    assert.equal((await call(env, `/api/admin/class-coverage?schoolYearId=${Y}`, { cookie: board })).status, 403);
    assert.equal((await call(env, `/api/admin/class-coverage?schoolYearId=${Y}`, { cookie: rep })).status, 403);
    assert.equal((await call(env, `/api/admin/class-coverage?schoolYearId=${Y}`)).status, 401);
  });

  test('liczy współprzedstawicieli, przedstawiciela dwóch klas i zaproszenia oczekujące', async () => {
    const { db, env, admin } = await setup();
    await seedUser(db, { userId: 'u-rep-1a-1' });
    await seedUser(db, { userId: 'u-rep-1a-2' });
    await seedUser(db, { userId: 'u-rep-both' });
    // 1A ma dwóch współprzedstawicieli i przedstawiciela klasy 1B jednocześnie.
    await db.query(`INSERT INTO role_grants (id, user_id, role, class_id, school_year_id, granted_by) VALUES
      ('g-1', 'u-rep-1a-1', 'representative', 'c-1a', $1, 'u-admin'),
      ('g-2', 'u-rep-1a-2', 'representative', 'c-1a', $1, 'u-admin'),
      ('g-3', 'u-rep-both', 'representative', 'c-1a', $1, 'u-admin'),
      ('g-4', 'u-rep-both', 'representative', 'c-1b', $1, 'u-admin')`, [Y]);
    await db.query(`INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, confirmed_at)
      VALUES ('f-1', 'u-rep-both', 'totp', 'abc', repeat('a', 16), repeat('b', 22), now())`);
    // Logowanie: sesja u-rep-1a-1 z datą ustaloną (created_at w przeszłości).
    await db.query(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
      VALUES ('s-1', 'u-rep-1a-1', repeat('a', 64), '2026-09-10T08:00:00Z', now() + interval '1 hour')`);

    await post(env, '/api/admin/invitations', admin, { email: 'oczekuje@example.invalid', role: 'representative', classId: 'c-1b', ttlHours: 48 });

    const coverage = await call(env, `/api/admin/class-coverage?schoolYearId=${Y}`, { cookie: admin });
    assert.equal(coverage.status, 200);
    const byId = Object.fromEntries(coverage.data.classes.map((c) => [c.id, c]));
    assert.equal(byId['c-1a'].activeRepresentativeCount, 3, 'dwóch współprzedstawicieli + przedstawiciel obu klas');
    assert.equal(byId['c-1a'].lastRepresentativeLoginOn, '2026-09-10');
    assert.equal(byId['c-1a'].pendingInvitationCount, 0);
    assert.equal(byId['c-1b'].activeRepresentativeCount, 1);
    assert.equal(byId['c-1b'].pendingInvitationCount, 1);
    assert.equal(byId['c-1b'].lastRepresentativeLoginOn, null, 'przedstawiciel 1B (u-rep-both) jeszcze się nie logował');
    // Stan aktywacji: u-rep-1a-1 zalogowany, pozostali dwaj nie; MFA ma tylko u-rep-both (przedstawiciel obu klas).
    assert.equal(byId['c-1a'].neverLoggedInRepresentativeCount, 2);
    assert.equal(byId['c-1a'].mfaEnrolledRepresentativeCount, 1);
    assert.equal(byId['c-1b'].neverLoggedInRepresentativeCount, 1);
    assert.equal(byId['c-1b'].mfaEnrolledRepresentativeCount, 1);
    assert.equal(coverage.data.representativeMfaRequired, false, 'domyślnie MFA wymagają admin, zarząd, skarbnik');
    assert.doesNotMatch(JSON.stringify(coverage.data), /example\.invalid|token/i);

    assert.equal((await call(env, '/api/admin/class-coverage?schoolYearId=y-nope', { cookie: admin })).status, 404);
  });
});

describe('„wyślij ponownie” zaproszenie (#108)', () => {
  test('wycofuje stare, tworzy nowe; przyjęte lub już wycofane nie da się ponowić', async () => {
    const { db, env, admin } = await setup();
    const created = await post(env, '/api/admin/invitations', admin, { email: 'rep@example.invalid', role: 'representative', classId: 'c-1a' });
    const oldId = created.data.invitation.id;

    const reissued = await post(env, `/api/admin/invitations/${oldId}/reissue`, admin);
    assert.equal(reissued.status, 201);
    assert.notEqual(reissued.data.token, created.data.token);
    assert.equal(reissued.data.invitation.replacesInvitationId, oldId);

    const list = await call(env, '/api/admin/invitations', { cookie: admin });
    const old = list.data.invitations.find((i) => i.id === oldId);
    assert.equal(old.status, 'revoked');
    const fresh = list.data.invitations.find((i) => i.id === reissued.data.invitation.id);
    assert.equal(fresh.status, 'pending');

    // Ponowna próba na już wycofanym zaproszeniu: 409, nie tworzy trzeciego.
    assert.equal((await post(env, `/api/admin/invitations/${oldId}/reissue`, admin)).status, 409);
    assert.equal((await post(env, '/api/admin/invitations/i-missing/reissue', admin)).status, 404);

    const audit = await db.query("SELECT action, entity_id, metadata_json FROM audit_events WHERE action = 'invitation.reissued'");
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].entity_id, reissued.data.invitation.id);
    const metadata = typeof audit.rows[0].metadata_json === 'string' ? JSON.parse(audit.rows[0].metadata_json) : audit.rows[0].metadata_json;
    assert.equal(metadata.replacesInvitationId, oldId);
  });
});
