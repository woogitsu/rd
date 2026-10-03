// Promocja uczniów na nowy rok i kopiowanie klas (#78, część 2/4). Dane wyłącznie
// syntetyczne (.invalid). Baza własna (PGlite), wyłącznie handlePgRequest.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { perTestDb, request, seedClass, seedRoleGrant, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const Y1 = 'y-2026';
const Y2 = 'y-2027';
const KEY = 'promocja-klucz-0001';

// #111: każdy test zakłada własną bazę w setup(); perTestDb() zamyka ją zaraz po teście
// (wcześniej 25 niezamkniętych baz do końca pliku dawało 5,6 GB RSS procesu).
const createDb = perTestDb();

async function setup() {
  const db = await createDb();
  await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, Y2, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  for (const [id, name] of [['c-1a', '1A'], ['c-2b', '2B'], ['c-6f', '6F']]) await seedClass(db, { id, schoolYearId: Y1, name });
  for (const [id, name] of [['d-2a', '2A'], ['d-3b', '3B'], ['d-1a', '1A']]) await seedClass(db, { id, schoolYearId: Y2, name });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3');
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ala', 'Testowa'),
      ('s-2', 'h-2', 'Ola', 'Nowakowska'),
      ('s-3', 'h-2', 'Jan', 'Nowakowski'),
      ('s-4', 'h-3', 'Ewa', 'Odchodzaca'),
      ('s-5', 'h-3', 'Adam', 'Powtarzajacy'),
      ('s-6', 'h-1', 'Zofia', 'Absolwentka'),
      ('s-7', 'h-1', 'Igor', 'Konflikt'),
      ('s-8', 'h-1', 'Nina', 'Bezmapy');
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-1a', '${Y1}'), ('e-2', 's-2', 'c-1a', '${Y1}'),
      ('e-3', 's-3', 'c-2b', '${Y1}'), ('e-4', 's-4', 'c-1a', '${Y1}'),
      ('e-5', 's-5', 'c-1a', '${Y1}'), ('e-6', 's-6', 'c-6f', '${Y1}'),
      ('e-7', 's-7', 'c-1a', '${Y1}');
    UPDATE enrollments SET ended_on = '2027-01-10', ended_reason = 'Zmiana szkoly', ended_at = now(), ended_by = NULL
     WHERE id = 'e-4';
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-7n', 's-7', 'd-1a', '${Y2}');
  `);
  const cookies = {
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
    adminNoMfa: await seedUserSession(db, { userId: 'u-admin2', roles: [{ role: 'admin' }], mfa: false }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer' }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }], mfa: true }),
    rep: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y1 }], mfa: true }),
  };
  const env = { db };
  const call = async (path, { cookie, body, key } = {}) => {
    const response = await handlePgRequest(request(path, {
      method: 'POST', cookie, body, headers: key ? { 'Idempotency-Key': key } : {},
    }), env);
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  return { db, env, cookies, call };
}

// Rok oznaczony jako zamknięty bez przebiegu zamknięcia (to testuje tests/pg-year-close*.test.js).
async function markYearClosed(db, { id, yearId, nextYearId, carriedId }) {
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('${id}', '${yearId}', '${nextYearId}', 'closed', 'u-a', 'u-b', now(), 0, 0, 0, 0, '${carriedId}', 0);
    SET session_replication_role = origin;
  `);
}

const MAP = { 'c-1a': 'd-2a', 'c-2b': 'd-3b', 'c-6f': null };
const body = (extra = {}) => ({ fromSchoolYearId: Y1, toSchoolYearId: Y2, classMap: MAP, ...extra });
const statusOf = (plan) => Object.fromEntries(plan.students.map((s) => [s.studentId, s.status]));

async function snapshot(db) {
  const tables = ['enrollments', 'enrollment_history', 'audit_events', 'promotion_runs', 'students', 'guardians', 'student_guardians', 'households', 'classes'];
  const out = {};
  // #184: odmowa 403 zostawia wyłącznie ślad access.denied — to nie jest zmiana danych.
  for (const t of tables) {
    const where = t === 'audit_events' ? " WHERE action <> 'access.denied'" : '';
    out[t] = (await db.query(`SELECT count(*)::int AS n FROM ${t}${where}`)).rows[0].n;
  }
  return out;
}

describe('promocja (#78): granice ról', () => {
  test('wyłącznie admin z MFA; pozostałe role i brak sesji nie mają dostępu do żadnej trasy', async () => {
    const { db, call, cookies } = await setup();
    const before = await snapshot(db);
    const routes = ['/api/admin/promotions/preview', '/api/admin/promotions/apply',
      '/api/admin/promotions/classes/preview', '/api/admin/promotions/classes/apply',
      '/api/admin/promotions/representatives/preview', '/api/admin/promotions/representatives/apply'];
    for (const path of routes) {
      assert.equal((await call(path, { body: body(), key: KEY })).status, 401, path);
      for (const who of ['board', 'treasurer', 'audit', 'rep', 'adminNoMfa']) {
        const result = await call(path, { cookie: cookies[who], body: body({ planDigest: 'a'.repeat(64) }), key: KEY });
        assert.equal(result.status, 403, `${who} ${path}`);
      }
    }
    assert.deepEqual(await snapshot(db), before);
    // #184: każda odmowa roli (poza bramką MFA routera dla admina bez MFA) — jedno
    // access.denied na aktora i trasę; anonim (401) bez zdarzenia.
    const { rows } = await db.query(
      "SELECT actor_id, entity_id FROM audit_events WHERE action = 'access.denied' ORDER BY actor_id, entity_id",
    );
    assert.equal(rows.length, 4 * routes.length);
    assert.deepEqual([...new Set(rows.map((row) => row.actor_id))].sort(), ['u-audit', 'u-board', 'u-rep', 'u-treasurer']);
  });
});

describe('promocja (#78): podgląd', () => {
  test('bez jawnej mapy klas nie ma promocji (wariant zachowawczy)', async () => {
    const { call, cookies } = await setup();
    for (const classMap of [undefined, {}, []]) {
      const result = await call('/api/admin/promotions/preview', { cookie: cookies.admin, body: { fromSchoolYearId: Y1, toSchoolYearId: Y2, classMap } });
      assert.equal(result.status, 422);
      assert.equal(result.data.error, 'class_map_required');
    }
  });

  test('walidacja: te same lata, zła kolejność, nieznane klasy i uczniowie', async () => {
    const { call, cookies } = await setup();
    const preview = (b) => call('/api/admin/promotions/preview', { cookie: cookies.admin, body: b });
    assert.equal((await preview(body({ toSchoolYearId: Y1 }))).data.error, 'same_school_year');
    assert.equal((await preview(body({ fromSchoolYearId: Y2, toSchoolYearId: Y1, classMap: { 'd-2a': 'c-1a' } }))).data.error, 'invalid_year_order');
    assert.equal((await preview(body({ toSchoolYearId: 'y-brak' }))).status, 404);
    assert.equal((await preview(body({ classMap: { 'c-nie-ma': 'd-2a' } }))).data.error, 'unknown_source_class');
    assert.equal((await preview(body({ classMap: { 'c-1a': 'c-2b' } }))).data.error, 'unknown_target_class');
    assert.equal((await preview(body({ overrides: { 's-1': 'c-2b' } }))).data.error, 'unknown_target_class');
    assert.equal((await preview(body({ exclusions: ['s-nie-ma'] }))).data.error, 'unknown_student');
  });

  test('plan: przenoszeni, klasa końcowa, odchodzący, konflikt, klasa bez następnika; nic nie zapisuje', async () => {
    const { db, call, cookies } = await setup();
    await db.exec(`INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-8', 's-8', 'c-1a', '${Y1}')`);
    const before = await snapshot(db);
    const partialMap = { 'c-1a': 'd-2a', 'c-6f': null };
    const result = await call('/api/admin/promotions/preview', { cookie: cookies.admin, body: body({ classMap: partialMap }) });
    assert.equal(result.status, 200);
    const plan = result.data;
    assert.deepEqual(statusOf(plan), {
      's-1': 'promote', 's-2': 'promote', 's-3': 'unmapped', 's-4': 'withdrawn',
      's-5': 'promote', 's-6': 'graduating', 's-7': 'conflict', 's-8': 'promote',
    });
    assert.deepEqual(plan.counts, { promote: 4, graduating: 1, unmapped: 1, excluded: 0, conflict: 1, withdrawn: 1 });
    const c1a = plan.classes.find((c) => c.fromClassId === 'c-1a');
    assert.equal(c1a.toClassId, 'd-2a');
    assert.equal(c1a.promote, 4);
    assert.equal(c1a.conflict, 1);
    assert.equal(plan.classes.find((c) => c.fromClassId === 'c-2b').mapped, false);
    assert.equal(plan.students.find((s) => s.studentId === 's-7').existingClassId, 'd-1a');
    assert.deepEqual(plan.missingRepresentative, [{ classId: 'd-2a', name: '2A' }]);
    assert.match(plan.planDigest, /^[0-9a-f]{64}$/);
    // Podgląd nie zawiera imion ani nazwisk.
    assert.doesNotMatch(JSON.stringify(plan), /Testowa|Nowakowsk|Odchodzaca|Konflikt/);
    assert.deepEqual(await snapshot(db), before);
  });

  test('wykluczenie (powtarzanie klasy) i inna klasa docelowa zmieniają plan i skrót', async () => {
    const { call, cookies } = await setup();
    const preview = (b) => call('/api/admin/promotions/preview', { cookie: cookies.admin, body: body(b) });
    const base = (await preview({})).data;
    const changed = (await preview({ exclusions: ['s-5'], overrides: { 's-2': 'd-3b', 's-3': 'd-3b' } })).data;
    assert.equal(statusOf(changed)['s-5'], 'excluded');
    assert.equal(changed.students.find((s) => s.studentId === 's-2').toClassId, 'd-3b');
    assert.equal(changed.counts.excluded, 1);
    assert.notEqual(base.planDigest, changed.planDigest);
    assert.equal((await preview({ exclusions: ['s-5'], overrides: { 's-3': 'd-3b', 's-2': 'd-3b' } })).data.planDigest, changed.planDigest);
  });
});

describe('promocja (#78): zatwierdzenie', () => {
  async function planAndApply(ctx, extra = {}, key = KEY) {
    const plan = (await ctx.call('/api/admin/promotions/preview', { cookie: ctx.cookies.admin, body: body(extra) })).data;
    const applied = await ctx.call('/api/admin/promotions/apply', {
      cookie: ctx.cookies.admin, body: body({ ...extra, planDigest: plan.planDigest }), key,
    });
    return { plan, applied };
  }

  test('wymaga Idempotency-Key i poprawnego planDigest', async () => {
    const ctx = await setup();
    const path = '/api/admin/promotions/apply';
    const before = await snapshot(ctx.db);
    assert.equal((await ctx.call(path, { cookie: ctx.cookies.admin, body: body({ planDigest: 'a'.repeat(64) }) })).data.error, 'invalid_idempotency_key');
    assert.equal((await ctx.call(path, { cookie: ctx.cookies.admin, body: body(), key: KEY })).data.error, 'invalid_plan_digest');
    assert.equal((await ctx.call(path, { cookie: ctx.cookies.admin, body: body({ planDigest: 'a'.repeat(64) }), key: KEY })).data.error, 'plan_stale');
    assert.deepEqual(await snapshot(ctx.db), before);
  });

  test('zapisuje tylko nowe przypisania: historia z powodem promotion, audyt bez nazwisk, rodzeństwo, gospodarstwa bez zmian', async () => {
    const ctx = await setup();
    const { db } = ctx;
    const oldEnrollments = (await db.query(`SELECT id, student_id, class_id, ended_on::text FROM enrollments WHERE school_year_id = '${Y1}' ORDER BY id`)).rows;
    const households = (await db.query('SELECT id, student_id FROM (SELECT id, id AS student_id FROM households) h ORDER BY id')).rows;
    const studentHouseholds = (await db.query('SELECT id, household_id FROM students ORDER BY id')).rows;
    const { plan, applied } = await planAndApply(ctx, { exclusions: ['s-5'] });
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    // s-2 i s-3 to rodzeństwo z jednego gospodarstwa w dwóch klasach: oba przypisania powstają.
    assert.deepEqual(applied.data.counts, { promote: 3, graduating: 1, unmapped: 0, excluded: 1, conflict: 1, withdrawn: 1 });
    assert.equal(applied.data.replayed, false);
    assert.equal(applied.data.planDigest, plan.planDigest);

    const created = (await db.query(`SELECT student_id, class_id FROM enrollments WHERE school_year_id = '${Y2}' ORDER BY student_id`)).rows;
    assert.deepEqual(created, [
      { student_id: 's-1', class_id: 'd-2a' }, { student_id: 's-2', class_id: 'd-2a' },
      { student_id: 's-3', class_id: 'd-3b' }, { student_id: 's-7', class_id: 'd-1a' },
    ]);
    // Historia starego roku nietknięta, konflikt (s-7) nie nadpisany, rodziny bez zmian.
    assert.deepEqual((await db.query(`SELECT id, student_id, class_id, ended_on::text FROM enrollments WHERE school_year_id = '${Y1}' ORDER BY id`)).rows, oldEnrollments);
    assert.equal((await db.query("SELECT class_id FROM enrollments WHERE id = 'e-7n'")).rows[0].class_id, 'd-1a');
    assert.deepEqual((await db.query('SELECT id FROM households ORDER BY id')).rows.map((r) => ({ id: r.id, student_id: r.id })), households);
    assert.deepEqual((await db.query('SELECT id, household_id FROM students ORDER BY id')).rows, studentHouseholds);

    const history = (await db.query(
      `SELECT h.student_id, h.kind, h.reason, h.source, h.changed_by, h.effective_on::text AS effective_on
         FROM enrollment_history h JOIN enrollments e ON e.id = h.enrollment_id
        WHERE e.school_year_id = $1 ORDER BY h.student_id`, [Y2],
    )).rows.filter((r) => r.student_id !== 's-7');
    assert.equal(history.length, 3);
    for (const row of history) {
      assert.deepEqual({ kind: row.kind, reason: row.reason, source: row.source, by: row.changed_by, on: row.effective_on },
        { kind: 'enrolled', reason: 'promotion', source: 'api', by: 'u-admin', on: '2027-09-01' });
    }

    const audit = (await db.query("SELECT action, entity_type, metadata_json AS metadata FROM audit_events WHERE action IN ('promotion.applied', 'enrollment.promoted') ORDER BY action")).rows;
    assert.equal(audit.filter((a) => a.action === 'enrollment.promoted').length, 3);
    const summary = audit.find((a) => a.action === 'promotion.applied');
    assert.equal(summary.metadata.promote, 3);
    assert.equal(summary.metadata.schoolYearId, Y2);
    assert.doesNotMatch(JSON.stringify(audit), /Testowa|Nowakowsk|Absolwentka|@/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM promotion_runs')).rows[0].n, 1);
  });

  test('podwójne kliknięcie równolegle i ponowienie z tym samym kluczem: jeden zapis, ten sam wynik', async () => {
    const ctx = await setup();
    const plan = (await ctx.call('/api/admin/promotions/preview', { cookie: ctx.cookies.admin, body: body() })).data;
    const send = () => ctx.call('/api/admin/promotions/apply', { cookie: ctx.cookies.admin, body: body({ planDigest: plan.planDigest }), key: KEY });
    const [a, b] = await Promise.all([send(), send()]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    const replayed = [a, b].find((r) => r.status === 200);
    assert.equal(replayed.data.replayed, true);
    const created = [a, b].find((r) => r.status === 201);
    assert.deepEqual({ ...replayed.data, replayed: false }, created.data);
    const later = await send();
    assert.equal(later.status, 200);
    assert.equal(later.data.runId, created.data.runId);
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM enrollments WHERE school_year_id = '${Y2}'`)).rows[0].n, 5);
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'promotion.applied'")).rows[0].n, 1);
  });

  test('ten sam klucz z innym planem: 409; nowy klucz po zapisie: plan_stale (konflikty), nic nie dubluje', async () => {
    const ctx = await setup();
    const { plan, applied } = await planAndApply(ctx);
    assert.equal(applied.status, 201);
    const other = await ctx.call('/api/admin/promotions/apply', {
      cookie: ctx.cookies.admin, body: body({ exclusions: ['s-1'], planDigest: 'b'.repeat(64) }), key: KEY,
    });
    assert.equal(other.status, 409);
    assert.equal(other.data.error, 'idempotency_key_reused');
    const again = await ctx.call('/api/admin/promotions/apply', {
      cookie: ctx.cookies.admin, body: body({ planDigest: plan.planDigest }), key: 'promocja-klucz-0002',
    });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'plan_stale');
    assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM promotion_runs')).rows[0].n, 1);
  });

  test('ręczna zmiana klasy w roku źródłowym po podglądzie: 409 plan_stale, bez zapisu', async () => {
    const ctx = await setup();
    const plan = (await ctx.call('/api/admin/promotions/preview', { cookie: ctx.cookies.admin, body: body() })).data;
    await ctx.db.query("UPDATE enrollments SET class_id = 'c-2b' WHERE id = 'e-1'");
    const before = await snapshot(ctx.db);
    const result = await ctx.call('/api/admin/promotions/apply', {
      cookie: ctx.cookies.admin, body: body({ planDigest: plan.planDigest }), key: KEY,
    });
    assert.equal(result.status, 409);
    assert.equal(result.data.error, 'plan_stale');
    assert.deepEqual(await snapshot(ctx.db), before);
  });

  test('przypisanie w roku docelowym dodane po podglądzie: 409 plan_stale', async () => {
    const ctx = await setup();
    const plan = (await ctx.call('/api/admin/promotions/preview', { cookie: ctx.cookies.admin, body: body() })).data;
    await ctx.db.query(`INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-1n', 's-1', 'd-3b', '${Y2}')`);
    const result = await ctx.call('/api/admin/promotions/apply', {
      cookie: ctx.cookies.admin, body: body({ planDigest: plan.planDigest }), key: KEY,
    });
    assert.equal(result.data.error, 'plan_stale');
  });

  test('zamknięty rok docelowy: 409 school_year_closed; zamknięty rok źródłowy: promocja działa', async () => {
    const ctx = await setup();
    const plan = (await ctx.call('/api/admin/promotions/preview', { cookie: ctx.cookies.admin, body: body() })).data;
    await markYearClosed(ctx.db, { id: 'clo-2027', yearId: Y2, nextYearId: 'y-2028', carriedId: 'ob-x' });
    const before = await snapshot(ctx.db);
    const closed = await ctx.call('/api/admin/promotions/apply', {
      cookie: ctx.cookies.admin, body: body({ planDigest: plan.planDigest }), key: KEY,
    });
    assert.equal(closed.status, 409);
    assert.equal(closed.data.error, 'school_year_closed');
    assert.deepEqual(await snapshot(ctx.db), before);

    const source = await setup();
    await markYearClosed(source.db, { id: 'clo-2026', yearId: Y1, nextYearId: `${Y2}`, carriedId: 'ob-y' });
    const { applied } = await planAndApply(source);
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    // Zmiana klasy w zamkniętym roku źródłowym pozostaje zablokowana (0054).
    await assert.rejects(source.db.query("UPDATE enrollments SET class_id = 'c-2b' WHERE id = 'e-1'"), /school_year_closed/);
  });

  test('nic do promowania: 422 nothing_to_promote', async () => {
    const ctx = await setup();
    const map = { 'c-6f': null };
    const plan = (await ctx.call('/api/admin/promotions/preview', { cookie: ctx.cookies.admin, body: body({ classMap: map }) })).data;
    const result = await ctx.call('/api/admin/promotions/apply', {
      cookie: ctx.cookies.admin, body: body({ classMap: map, planDigest: plan.planDigest }), key: KEY,
    });
    assert.equal(result.status, 422);
    assert.equal(result.data.error, 'nothing_to_promote');
  });
});

describe('przedłużenie przedstawicieli klas (#78)', () => {
  const REPS = '/api/admin/promotions/representatives';
  const repBody = (extra = {}) => ({ fromSchoolYearId: Y1, toSchoolYearId: Y2, classMap: MAP, ...extra });

  // Klasa 1A ma dwóch przedstawicieli (dwie osoby opiekujące się jedną klasą), 2B jednego
  // wyłączonego konta, 6F (klasa końcowa) jednego — bez następnika.
  async function repSetup() {
    const ctx = await setup();
    await seedRoleGrant(ctx.db, { userId: 'u-rep2', role: 'representative', classId: 'c-1a', schoolYearId: Y1 });
    await seedUser(ctx.db, { userId: 'u-rep-off', disabled: true });
    await ctx.db.query("INSERT INTO role_grants (id, user_id, role, class_id, school_year_id) VALUES ('rg-off', 'u-rep-off', 'representative', 'c-2b', $1)", [Y1]);
    await seedRoleGrant(ctx.db, { userId: 'u-rep-final', role: 'representative', classId: 'c-6f', schoolYearId: Y1 });
    return ctx;
  }
  const preview = (ctx, extra) => ctx.call(`${REPS}/preview`, { cookie: ctx.cookies.admin, body: repBody(extra) });
  const apply = (ctx, digest, extra = {}) => ctx.call(`${REPS}/apply`, {
    cookie: ctx.cookies.admin, body: repBody({ planDigest: digest, confirm: Y2, ...extra }),
  });
  const grantsOn = async (db, classId) => (await db.query(
    "SELECT user_id FROM role_grants WHERE role = 'representative' AND class_id = $1 AND revoked_at IS NULL ORDER BY user_id", [classId],
  )).rows.map((row) => row.user_id);

  test('podgląd nic nie zapisuje: propozycje, konto wyłączone, klasa końcowa bez następnika', async () => {
    const ctx = await repSetup();
    const before = await snapshot(ctx.db);
    const grantsBefore = (await ctx.db.query('SELECT count(*)::int AS n FROM role_grants')).rows[0].n;
    const { status, data } = await preview(ctx);
    assert.equal(status, 200);
    assert.deepEqual(data.proposals.map((p) => [p.userId, p.fromClassId, p.toClassId, p.status]), [
      ['u-rep', 'c-1a', 'd-2a', 'propose'],
      ['u-rep2', 'c-1a', 'd-2a', 'propose'],
      ['u-rep-off', 'c-2b', 'd-3b', 'user_disabled'],
    ]);
    assert.deepEqual(data.counts, { propose: 2, already_granted: 0, user_disabled: 1 });
    assert.deepEqual(data.withoutRepresentative.map((c) => c.classId), ['d-3b']);
    assert.match(data.planDigest, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(data), /Testowa|Nowak|example\.invalid/);
    assert.deepEqual(await snapshot(ctx.db), before);
    assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM role_grants')).rows[0].n, grantsBefore);
  });

  test('zapis: nowe przydziały klasy docelowej, stare nietknięte, audyt bez danych osobowych', async () => {
    const ctx = await repSetup();
    const plan = (await preview(ctx)).data;
    const oldBefore = (await ctx.db.query("SELECT id, expires_at, revoked_at FROM role_grants WHERE class_id = 'c-1a' ORDER BY id")).rows;
    const result = await apply(ctx, plan.planDigest);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.deepEqual({ created: result.data.created, alreadyGranted: result.data.alreadyGranted, skipped: result.data.skipped, replayed: result.data.replayed },
      { created: 2, alreadyGranted: 0, skipped: 1, replayed: false });
    assert.deepEqual(await grantsOn(ctx.db, 'd-2a'), ['u-rep', 'u-rep2']);
    assert.deepEqual(await grantsOn(ctx.db, 'd-3b'), []);
    assert.deepEqual((await ctx.db.query("SELECT id, expires_at, revoked_at FROM role_grants WHERE class_id = 'c-1a' ORDER BY id")).rows, oldBefore);
    const created = (await ctx.db.query("SELECT school_year_id, granted_by, expires_at FROM role_grants WHERE class_id = 'd-2a'")).rows;
    assert.equal(created.length > 0 && created.every((row) => row.school_year_id === Y2 && row.granted_by === 'u-admin' && row.expires_at === null), true);
    const audit = (await ctx.db.query(
      "SELECT action, metadata_json AS metadata FROM audit_events WHERE action IN ('role_grant.created', 'promotion.representatives_extended') ORDER BY action",
    )).rows;
    assert.deepEqual(audit.map((row) => row.action), ['promotion.representatives_extended', 'role_grant.created', 'role_grant.created']);
    assert.deepEqual(audit[0].metadata, { schoolYearId: Y2, fromSchoolYearId: Y1, created: 2, alreadyGranted: 0, skipped: 1 });
    assert.equal(audit.filter((row) => row.metadata.source === 'promotion').length, 2);
    assert.doesNotMatch(JSON.stringify(audit), /example\.invalid|Test u-/);
  });

  test('podwójne kliknięcie i ponowienie po kolei (PGlite): jeden zestaw przydziałów, drugi zapis created 0', async () => {
    const ctx = await repSetup();
    const plan = (await preview(ctx)).data;
    const first = await apply(ctx, plan.planDigest);
    const second = await apply(ctx, plan.planDigest);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.deepEqual({ created: second.data.created, alreadyGranted: second.data.alreadyGranted, replayed: second.data.replayed },
      { created: 0, alreadyGranted: 2, replayed: true });
    assert.deepEqual(await grantsOn(ctx.db, 'd-2a'), ['u-rep', 'u-rep2']);
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'promotion.representatives_extended'")).rows[0].n, 1);
    // Nowy podgląd widzi już przydziały jako istniejące; skrót zamiaru się nie zmienia.
    const after = (await preview(ctx)).data;
    assert.deepEqual(after.counts, { propose: 0, already_granted: 2, user_disabled: 1 });
    assert.equal(after.planDigest, plan.planDigest);
  });

  test('wymaga confirm i poprawnego planDigest; cofnięcie przydziału po podglądzie: 409 plan_stale', async () => {
    const ctx = await repSetup();
    const plan = (await preview(ctx)).data;
    const noConfirm = await ctx.call(`${REPS}/apply`, { cookie: ctx.cookies.admin, body: repBody({ planDigest: plan.planDigest }) });
    assert.deepEqual([noConfirm.status, noConfirm.data.error], [400, 'confirmation_required']);
    const wrongConfirm = await apply(ctx, plan.planDigest, { confirm: Y1 });
    assert.equal(wrongConfirm.data.error, 'confirmation_required');
    assert.equal((await apply(ctx, 'xyz')).data.error, 'invalid_plan_digest');
    assert.equal((await apply(ctx, 'a'.repeat(64))).data.error, 'plan_stale');
    await ctx.db.query("UPDATE role_grants SET revoked_at = now(), revoked_by = 'u-admin' WHERE user_id = 'u-rep2' AND class_id = 'c-1a'");
    const stale = await apply(ctx, plan.planDigest);
    assert.deepEqual([stale.status, stale.data.error], [409, 'plan_stale']);
    assert.deepEqual(await grantsOn(ctx.db, 'd-2a'), []);
  });

  test('walidacja: bez mapy 422, nieznana klasa docelowa, nic do przedłużenia, zamknięty rok docelowy', async () => {
    const ctx = await repSetup();
    assert.equal((await ctx.call(`${REPS}/preview`, { cookie: ctx.cookies.admin, body: repBody({ classMap: {} }) })).data.error, 'class_map_required');
    assert.equal((await preview(ctx, { classMap: { 'c-1a': 'd-nie-ma' } })).data.error, 'unknown_target_class');
    const none = await preview(ctx, { classMap: { 'c-6f': null } });
    assert.deepEqual(none.data.proposals, []);
    const empty = await apply(ctx, none.data.planDigest, { classMap: { 'c-6f': null } });
    assert.deepEqual([empty.status, empty.data.error], [422, 'nothing_to_extend']);
    const plan = (await preview(ctx)).data;
    await markYearClosed(ctx.db, { id: 'clo-2027', yearId: Y2, nextYearId: 'y-2028', carriedId: 'ob-x' });
    const closed = await apply(ctx, plan.planDigest);
    assert.deepEqual([closed.status, closed.data.error], [409, 'school_year_closed']);
    assert.deepEqual(await grantsOn(ctx.db, 'd-2a'), []);
  });

  test('przydział wygasły przy zamknięciu roku źródłowego jest nadal podstawą propozycji; cofnięty nie', async () => {
    const ctx = await repSetup();
    await ctx.db.query("UPDATE role_grants SET expires_at = now() - interval '1 day' WHERE user_id = 'u-rep' AND class_id = 'c-1a'");
    await ctx.db.query("UPDATE role_grants SET revoked_at = now(), revoked_by = 'u-admin' WHERE user_id = 'u-rep2' AND class_id = 'c-1a'");
    const { data } = await preview(ctx);
    assert.deepEqual(data.proposals.filter((p) => p.status === 'propose').map((p) => p.userId), ['u-rep']);
  });
});

describe('kopiowanie klas roku (#78)', () => {
  const copy = (ctx, action, classMap, cookie = ctx.cookies.admin) => ctx.call(`/api/admin/promotions/classes/${action}`, {
    cookie, body: { fromSchoolYearId: Y1, toSchoolYearId: Y2, classMap },
  });

  test('podgląd nic nie zapisuje; zapis tworzy brakujące klasy, ponowienie nie dubluje', async () => {
    const ctx = await setup();
    const map = { 'c-1a': '2a', 'c-2b': '3C', 'c-6f': null };
    const before = await snapshot(ctx.db);
    const preview = await copy(ctx, 'preview', map);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.data.classes.map((c) => [c.fromClassId, c.action, c.toName]), [
      ['c-1a', 'exists', '2A'], ['c-2b', 'create', '3C'], ['c-6f', 'final', null],
    ]);
    assert.deepEqual(await snapshot(ctx.db), before);

    const applied = await copy(ctx, 'apply', map);
    assert.equal(applied.status, 201);
    assert.equal(applied.data.createdCount, 1);
    const created = applied.data.classes.find((c) => c.fromClassId === 'c-2b');
    assert.equal(created.action, 'created');
    const names = (await ctx.db.query(`SELECT name FROM classes WHERE school_year_id = '${Y2}' ORDER BY name`)).rows.map((r) => r.name);
    assert.deepEqual(names, ['1A', '2A', '3B', '3C']);
    assert.equal((await ctx.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'class.created'")).rows[0].n, 1);

    const again = await copy(ctx, 'apply', map);
    assert.equal(again.status, 200);
    assert.equal(again.data.createdCount, 0);
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM classes WHERE school_year_id = '${Y2}'`)).rows[0].n, 4);
  });

  test('bez mapy nic nie powstaje; duplikat nazwy docelowej i zamknięty rok odrzucone', async () => {
    const ctx = await setup();
    assert.equal((await copy(ctx, 'apply', {})).data.error, 'class_map_required');
    assert.equal((await copy(ctx, 'apply', { 'c-1a': '5A', 'c-2b': '5a' })).data.error, 'duplicate_name');
    assert.equal((await copy(ctx, 'apply', { 'c-nie-ma': '5A' })).data.error, 'unknown_source_class');
    await markYearClosed(ctx.db, { id: 'clo-2027', yearId: Y2, nextYearId: 'y-2028', carriedId: 'ob-x' });
    const closed = await copy(ctx, 'apply', { 'c-2b': '5A' });
    assert.equal(closed.status, 409);
    assert.equal(closed.data.error, 'school_year_closed');
    assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM classes WHERE school_year_id = '${Y2}'`)).rows[0].n, 3);
  });
});
