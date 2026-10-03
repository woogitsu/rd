// #133: przegląd dostępu po kadencji (GET /api/admin/access-review): granice
// ról, propozycja odebrania bez automatycznego odbierania, brak danych
// osobowych, ślad access_review.viewed. Dane syntetyczne (.invalid).
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const OLD = 'y-old';
const FUTURE = 'y-future';

let db;
let env;
const cookies = {};
const call = async (path, options = {}) => {
  const response = await handlePgRequest(request(path, options), env);
  const text = await response.text();
  return { status: response.status, text, body: text && response.headers.get('Content-Type')?.includes('json') ? JSON.parse(text) : null };
};
const review = (yearId, key = 'admin') => call(`/api/admin/access-review?schoolYearId=${yearId}`, { cookie: cookies[key] });
const insertRead = (actor, { classId = null, schoolYearId = null, hits = 1, outcome = 'ok', at = null } = {}) => db.query(
  `INSERT INTO data_access_log (id, actor_id, access_kind, school_year_id, class_id, outcome, hit_count, occurred_at, last_seen_at)
   VALUES ($1, $2, 'class_students', $3, $4, $5, $6, COALESCE($7::timestamptz, now()), COALESCE($7::timestamptz, now()))`,
  [crypto.randomUUID(), actor, schoolYearId, classId, outcome, hits, at],
);

describe('przegląd dostępu po kadencji (#133)', () => {
  before(async () => {
    db = await createTestDb();
    env = { db };
    await seedSchoolYear(db, OLD, { startsOn: '1999-09-01', endsOn: '2000-08-31' });
    await seedSchoolYear(db, FUTURE, { startsOn: '2998-09-01', endsOn: '2999-08-31' });
    await seedClass(db, { id: 'c-old', schoolYearId: OLD, name: '1A' });
    await seedClass(db, { id: 'c-future', schoolYearId: FUTURE, name: '1A' });
    const roles = (role, extra = {}) => [{ role, schoolYearId: OLD, ...extra }];
    cookies.admin = await seedUserSession(db, { userId: 'u-admin', roles: roles('admin'), mfa: true });
    cookies.adminNoMfa = await seedUserSession(db, { userId: 'u-admin-nomfa', roles: roles('admin'), mfa: false });
    for (const key of ['board', 'treasurer', 'audit', 'principal']) {
      cookies[key] = await seedUserSession(db, { userId: `u-${key}`, roles: roles(key), mfa: true });
    }
    cookies.repOld = await seedUserSession(db, { userId: 'u-repOld', roles: roles('representative', { classId: 'c-old' }), mfa: true });
    cookies.repFuture = await seedUserSession(db, {
      userId: 'u-repFuture', roles: [{ role: 'representative', classId: 'c-future', schoolYearId: FUTURE }], mfa: true,
    });
    // Konto z przydziałem, który już wygasł, a po wygaśnięciu ma odczyt (np. wpis sprzed poprawki).
    await seedUserSession(db, {
      userId: 'u-gone', roles: roles('representative', { classId: 'c-old', expiresAt: '2020-01-01T00:00:00Z' }), mfa: true,
    });
    await insertRead('u-repOld', { classId: 'c-old', schoolYearId: OLD, hits: 7 });
    await insertRead('u-repOld', { classId: 'c-old', schoolYearId: OLD, outcome: 'not_found', hits: 50 });
    await insertRead('u-gone', { classId: 'c-old', schoolYearId: OLD, hits: 3 });
    await insertRead('u-repFuture', { classId: 'c-future', schoolYearId: FUTURE, hits: 2 });
  });
  after(async () => { await db?.close(); });

  test('granice ról: tylko admin z MFA; reszta 403, anonim 401, tylko GET', async () => {
    assert.equal((await call(`/api/admin/access-review?schoolYearId=${OLD}`)).status, 401);
    for (const key of ['board', 'treasurer', 'audit', 'principal', 'repOld', 'adminNoMfa']) {
      const res = await review(OLD, key);
      assert.equal(res.status, 403, key);
      assert.ok(!res.text.includes('grants'), `${key}: brak wycieku`);
    }
    assert.equal((await review(OLD)).status, 200);
    const post = await call(`/api/admin/access-review?schoolYearId=${OLD}`, { method: 'POST', cookie: cookies.admin, body: {} });
    assert.equal(post.status, 405);
  });

  test('rok po końcu: aktywne przydziały dostają propozycję revoke, z ostatnim odczytem; nic nie jest odbierane', async () => {
    const before = (await db.query('SELECT count(*) AS n FROM role_grants WHERE revoked_at IS NULL')).rows[0].n;
    const res = await review(OLD);
    assert.equal(res.status, 200);
    assert.equal(res.body.informational, true);
    assert.equal(res.body.automaticRevocation, false);
    assert.equal(res.body.schoolYear.ended, true);
    const byUser = (id) => res.body.grants.filter((g) => g.userId === id);
    const rep = byUser('u-repOld');
    assert.equal(rep.length, 1);
    assert.equal(rep[0].status, 'active');
    assert.equal(rep[0].proposal, 'revoke');
    assert.equal(rep[0].reason, 'school_year_ended');
    assert.equal(rep[0].readsInScope, 7, 'liczone tylko odczyty z wynikiem ok');
    assert.ok(rep[0].lastReadAt);
    const quiet = byUser('u-board');
    assert.equal(quiet.length, 1);
    assert.equal(quiet[0].lastReadAt, null);
    assert.equal(quiet[0].proposal, 'revoke');
    assert.ok(res.body.summary.proposedRevoke >= 2);
    const after = (await db.query('SELECT count(*) AS n FROM role_grants WHERE revoked_at IS NULL')).rows[0].n;
    assert.equal(after, before, 'przegląd niczego nie odbiera');
  });

  test('przydział wygasły z odczytem po wygaśnięciu: propozycja review, bez revoke', async () => {
    const res = await review(OLD);
    const gone = res.body.grants.filter((g) => g.userId === 'u-gone');
    assert.equal(gone.length, 1);
    assert.equal(gone[0].status, 'expired');
    assert.equal(gone[0].readsWithoutValidGrant, 3);
    assert.equal(gone[0].proposal, 'review');
    assert.equal(gone[0].reason, 'reads_without_valid_grant');
    assert.equal(res.body.summary.proposedReview, 1);
  });

  test('rok w toku: przydziały tylko keep; zakres roku nie miesza kont innego roku', async () => {
    const res = await review(FUTURE);
    assert.equal(res.status, 200);
    assert.equal(res.body.schoolYear.ended, false);
    assert.deepEqual(res.body.grants.map((g) => g.userId), ['u-repFuture']);
    assert.ok(res.body.grants.length > 0);
    assertEvery(res.body.grants, (g) => g.proposal === 'keep');
    assert.equal(res.body.summary.proposedRevoke, 0);
  });

  test('odpowiedź bez imion i e-maili, tylko identyfikatory; ślad access_review.viewed bez parametrów zapytania poza rokiem', async () => {
    const res = await review(OLD);
    assert.ok(!res.text.includes('@'), 'brak e-maili');
    const keys = Object.keys(res.body.grants[0]).sort();
    assert.deepEqual(keys, [
      'classId', 'expiresAt', 'grantId', 'grantedAt', 'lastReadAt', 'proposal', 'readsInScope', 'readsWithoutValidGrant',
      'reason', 'revokedAt', 'role', 'schoolYearId', 'status', 'userId',
    ]);
    const audit = await db.query(`SELECT metadata_json, entity_id FROM audit_events WHERE action = 'access_review.viewed' AND actor_id = 'u-admin' AND entity_id = '${OLD}'`);
    assert.ok(audit.rows.length >= 1);
    assertEvery(audit.rows, (r) => JSON.stringify(r.metadata_json) === JSON.stringify({ schoolYearId: OLD }));
  });

  test('błędne parametry: brak roku i zły identyfikator 400, nieznany rok 404', async () => {
    const missing = await call('/api/admin/access-review', { cookie: cookies.admin });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'invalid_school_year_id');
    const bad = await call('/api/admin/access-review?schoolYearId=a%20b', { cookie: cookies.admin });
    assert.equal(bad.status, 400);
    const unknown = await review('y-nie-ma');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'school_year_not_found');
  });
});

// Wskazanie 2026-10-02: przydział `principal` wymaga roku. Przydziały sprzed wymogu (bez
// school_year_id) działają we wszystkich latach — przegląd je wskazuje, niczego nie odbiera.
describe('przegląd dostępu: przydziały dyrekcji bez roku szkolnego (sprzed wymogu roku)', () => {
  const post = (path, key = 'admin') => call(path, { method: 'POST', cookie: cookies[key], body: {} });
  const grantRows = async () => (await db.query('SELECT id, user_id, role, school_year_id, expires_at, revoked_at FROM role_grants ORDER BY id')).rows;

  before(async () => {
    db = await createTestDb();
    env = { db };
    await seedSchoolYear(db, OLD, { startsOn: '1999-09-01', endsOn: '2000-08-31' });
    await seedSchoolYear(db, FUTURE, { startsOn: '2998-09-01', endsOn: '2999-08-31' });
    cookies.admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin', schoolYearId: OLD }], mfa: true });
    // Dyrekcja bez roku (sprzed wymogu), dyrekcja z rokiem, dyrekcja bez roku już cofnięta i wygasła,
    // oraz audit bez roku (inna rola — bez wymogu roku, nie jest oznaczany).
    await seedUserSession(db, { userId: 'u-legacy', roles: [{ role: 'principal' }], mfa: true });
    await seedUserSession(db, { userId: 'u-dated', roles: [{ role: 'principal', schoolYearId: FUTURE }], mfa: true });
    await seedUserSession(db, { userId: 'u-legacy-revoked', roles: [{ role: 'principal', revoked: true }], mfa: true });
    await seedUserSession(db, { userId: 'u-legacy-expired', roles: [{ role: 'principal', expiresAt: '2020-01-01T00:00:00Z' }], mfa: true });
    await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }], mfa: true });
  });
  after(async () => { await db?.close(); });

  test('aktywny principal bez roku: propozycja revoke z powodem year_scope_required w przeglądzie każdego roku', async () => {
    for (const yearId of [OLD, FUTURE]) {
      const res = await review(yearId);
      assert.equal(res.status, 200, yearId);
      const rows = res.body.grants.filter((g) => g.userId === 'u-legacy');
      assert.equal(rows.length, 1, `${yearId}: jeden wiersz przydziału`);
      assert.equal(rows[0].role, 'principal');
      assert.equal(rows[0].schoolYearId, null);
      assert.equal(rows[0].status, 'active');
      assert.equal(rows[0].proposal, 'revoke');
      assert.equal(rows[0].reason, 'year_scope_required');
      assert.equal(res.body.automaticRevocation, false);
    }
    const future = await review(FUTURE);
    assert.equal(future.body.schoolYear.ended, false);
    assert.equal(future.body.summary.proposedRevoke, 1, 'rok w toku: tylko przydział bez roku');
  });

  test('principal z rokiem, cofnięty i wygasły bez roku oraz audit bez roku nie dostają year_scope_required', async () => {
    const res = await review(FUTURE);
    const dated = res.body.grants.find((g) => g.userId === 'u-dated');
    assert.equal(dated.proposal, 'keep');
    assert.equal(dated.reason, null);
    // Cofnięte i wygasłe przydziały bez roku nie są ważne w żadnym roku — nie trafiają do przeglądu.
    assert.equal(res.body.grants.some((g) => g.userId === 'u-legacy-revoked'), false);
    assert.equal(res.body.grants.some((g) => g.userId === 'u-legacy-expired'), false);
    // audit bez roku: inna rola, bez wymogu roku — poza przeglądem roku, jak dotąd.
    assert.equal(res.body.grants.some((g) => g.userId === 'u-audit'), false);
    const flagged = res.body.grants.filter((g) => g.reason === 'year_scope_required');
    assert.deepEqual(flagged.map((g) => g.userId), ['u-legacy']);
    assert.ok(!res.text.includes('@'), 'brak e-maili');
  });

  test('przegląd niczego nie odbiera; odebranie to jawna trasa POST /api/admin/grants/{id}/revoke i znika z propozycji', async () => {
    const legacyId = (await review(FUTURE)).body.grants.find((g) => g.userId === 'u-legacy').grantId;
    const before = await grantRows();
    await review(OLD);
    await review(FUTURE);
    assert.deepEqual(await grantRows(), before, 'przegląd nie zmienia role_grants');

    assert.equal((await post(`/api/admin/grants/${legacyId}/revoke`)).status, 200);
    assert.notEqual((await grantRows()).find((g) => g.id === legacyId).revoked_at, null);
    const audit = await db.query("SELECT actor_id, entity_id FROM audit_events WHERE action = 'role_grant.revoked'");
    assert.deepEqual(audit.rows, [{ actor_id: 'u-admin', entity_id: legacyId }]);

    const res = await review(FUTURE);
    assert.equal(res.body.grants.some((g) => g.userId === 'u-legacy'), false, 'cofnięty przydział bez roku poza przeglądem roku');
    assert.equal(res.body.summary.proposedRevoke, 0);
  });
});
