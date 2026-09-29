// #133: przegląd dziennika odczytu (GET /api/admin/access-log), granice ról,
// brak danych osobowych, rodzeństwo w dwóch klasach, przydział wygasły,
// gwarancja zapisu (eksport strict, lista best effort). Dane syntetyczne (.invalid).
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const Y1 = 'y-2026';
const PII = ['Ola', 'Testowa', 'Jan', 'opiekun1@example.invalid', 'opiekun2@example.invalid', 'Anna'];

let db;
let env;
const cookies = {};
const call = async (path, options = {}) => {
  const response = await handlePgRequest(request(path, options), env);
  const text = await response.text();
  return { status: response.status, text, body: text && response.headers.get('Content-Type')?.includes('json') ? JSON.parse(text) : null };
};
const kinds = async (actor) => (await db.query(
  'SELECT access_kind, class_id, household_id, outcome, hit_count FROM data_access_log WHERE actor_id = $1 ORDER BY occurred_at, id', [actor],
)).rows;

describe('przegląd dziennika odczytu danych rodzin (#133)', () => {
  before(async () => {
    db = await createTestDb();
    env = { db };
    await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
    await seedClass(db, { id: 'c-1a', schoolYearId: Y1, name: '1A' });
    await seedClass(db, { id: 'c-2b', schoolYearId: Y1, name: '2B' });
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1'), ('h-sib');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-1', 'h-1', 'Anna', 'Testowa', 'opiekun1@example.invalid', true),
        ('g-2', 'h-sib', 'Piotr', 'Rodzenstwo', 'opiekun2@example.invalid', true);
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-1', 'h-1', 'Ola', 'Testowa'),
        ('s-sib-a', 'h-sib', 'Ola', 'Rodzenstwo'),
        ('s-sib-b', 'h-sib', 'Jan', 'Rodzenstwo');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-1', 'g-1', true, true), ('s-sib-a', 'g-2', true, true), ('s-sib-b', 'g-2', true, true);
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
        ('e-1', 's-1', 'c-1a', '${Y1}'), ('e-sa', 's-sib-a', 'c-1a', '${Y1}'), ('e-sb', 's-sib-b', 'c-2b', '${Y1}');
    `);
    const grants = {
      admin: [{ role: 'admin', schoolYearId: Y1 }],
      board: [{ role: 'board', schoolYearId: Y1 }],
      treasurer: [{ role: 'treasurer', schoolYearId: Y1 }],
      audit: [{ role: 'audit', schoolYearId: Y1 }],
      principal: [{ role: 'principal', schoolYearId: Y1 }],
      repA: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y1 }],
    };
    for (const [key, roles] of Object.entries(grants)) {
      cookies[key] = await seedUserSession(db, { userId: `u-${key}`, roles, mfa: true });
    }
    cookies.adminNoMfa = await seedUserSession(db, { userId: 'u-admin-nomfa', roles: grants.admin, mfa: false });
    cookies.expired = await seedUserSession(db, {
      userId: 'u-expired', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y1, expiresAt: '2020-01-01T00:00:00Z' }], mfa: true,
    });
  });
  after(async () => { await db?.close(); });

  test('granice ról: tylko admin z MFA czyta dziennik; reszta 403, anonim 401', async () => {
    assert.equal((await call('/api/admin/access-log')).status, 401);
    for (const key of ['board', 'treasurer', 'audit', 'principal', 'repA', 'adminNoMfa']) {
      const res = await call('/api/admin/access-log', { cookie: cookies[key] });
      assert.equal(res.status, 403, key);
      assert.ok(!res.text.includes('entries'), `${key}: brak wycieku`);
    }
    assert.equal((await call('/api/admin/access-log', { cookie: cookies.admin })).status, 200);
    // tylko GET
    assert.equal((await call('/api/admin/access-log', { method: 'POST', cookie: cookies.admin, body: {} })).status, 405);
  });

  test('przedstawiciel 1A: karta w zakresie zapisuje wpis; karta spoza zakresu i nieistniejąca — ten sam wpis not_found', async () => {
    assert.equal((await call('/api/households/h-1', { cookie: cookies.repA })).status, 200);
    const missing = await call('/api/households/h-nie-ma', { cookie: cookies.repA });
    assert.equal(missing.status, 404);
    // gospodarstwo spoza zakresu przedstawiciela 1A: dodatkowa rodzina tylko w 2B
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-2b');
      INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-2b', 'h-2b', 'Ewa', 'Inna');
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-2b', 's-2b', 'c-2b', '${Y1}');
    `);
    const other = await call('/api/households/h-2b', { cookie: cookies.repA });
    assert.equal(other.status, 404);
    assert.equal(other.text, missing.text.replace('h-nie-ma', 'h-2b'));
    const rows = (await kinds('u-repA')).filter((r) => r.access_kind === 'household_card');
    assert.deepEqual(rows.map((r) => [r.household_id, r.outcome]).sort(), [['h-1', 'ok'], ['h-2b', 'not_found'], ['h-nie-ma', 'not_found']]);
  });

  test('rodzeństwo w dwóch klasach: wpis ma household_id, ale nie identyfikator ucznia spoza zakresu', async () => {
    const res = await call('/api/households/h-sib', { cookie: cookies.repA });
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('s-sib-b'), 'odpowiedź nie pokazuje dziecka z 2B');
    const { rows } = await db.query(`SELECT * FROM data_access_log WHERE household_id = 'h-sib'`);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).filter((k) => /student/.test(k)), []);
    assert.ok(!JSON.stringify(rows).includes('s-sib'), 'brak identyfikatorów uczniów w wierszu');
    assert.equal(Number(rows[0].row_count), 1, 'row_count liczy tylko uczniów w zakresie');
  });

  test('przydział wygasły: brak dostępu i brak wpisu ok', async () => {
    const res = await call('/api/households/h-1', { cookie: cookies.expired });
    assert.ok([401, 403].includes(res.status));
    const list = await call('/api/classes/c-1a/students', { cookie: cookies.expired });
    assert.ok([401, 403, 404].includes(list.status));
    assert.deepEqual((await kinds('u-expired')).filter((r) => r.outcome === 'ok'), []);
  });

  test('odświeżanie tej samej karty 10 razy w oknie 5 minut = 1 wiersz z licznikiem', async () => {
    for (let i = 0; i < 10; i += 1) await call('/api/classes/c-1a/students', { cookie: cookies.board });
    const rows = (await kinds('u-board')).filter((r) => r.access_kind === 'class_students' && r.class_id === 'c-1a');
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].hit_count), 10);
  });

  test('przegląd: filtry, brak danych osobowych, kursor bez duplikatów i luk, ślad access_log.viewed', async () => {
    await call('/api/print/cards?schoolYearId=' + Y1, { cookie: cookies.board });
    const all = await call('/api/admin/access-log?limit=500', { cookie: cookies.admin });
    assert.equal(all.status, 200);
    for (const marker of PII) assert.ok(!all.text.includes(marker), `PII w odpowiedzi: ${marker}`);
    assert.ok(!all.text.includes('@'), 'brak e-maili (także członków Rady)');
    const total = all.body.entries.length;
    assert.ok(total >= 5);
    const first = all.body.entries[0];
    assert.deepEqual(Object.keys(first).sort(), [
      'accessKind', 'actorId', 'actorRoles', 'classId', 'hitCount', 'householdId', 'id', 'lastSeenAt', 'occurredAt',
      'outcome', 'rowCount', 'schoolYearId',
    ]);
    assert.deepEqual(all.body.entries.find((e) => e.actorId === 'u-repA').actorRoles, ['representative']);

    const byKind = await call('/api/admin/access-log?kind=household_card&actorId=u-repA', { cookie: cookies.admin });
    assert.ok(byKind.body.entries.length >= 3 && byKind.body.entries.every((e) => e.accessKind === 'household_card' && e.actorId === 'u-repA'));
    const byHousehold = await call('/api/admin/access-log?householdId=h-sib', { cookie: cookies.admin });
    assert.equal(byHousehold.body.entries.length, 1);
    const notFound = await call('/api/admin/access-log?outcome=not_found', { cookie: cookies.admin });
    assert.ok(notFound.body.entries.length >= 2 && notFound.body.entries.every((e) => e.outcome === 'not_found'));
    const future = await call('/api/admin/access-log?from=2999-01-01T00:00:00Z', { cookie: cookies.admin });
    assert.deepEqual(future.body.entries, []);

    const seen = [];
    let cursor = '';
    for (let page = 0; page < total + 2; page += 1) {
      const res = await call(`/api/admin/access-log?limit=2${cursor}`, { cookie: cookies.admin });
      assert.equal(res.status, 200);
      seen.push(...res.body.entries.map((e) => e.id));
      if (!res.body.nextCursor) break;
      cursor = `&cursor=${encodeURIComponent(res.body.nextCursor)}`;
    }
    assert.equal(new Set(seen).size, seen.length, 'bez duplikatów');
    assert.equal(seen.length, total, 'bez luk');
    assert.deepEqual(seen, all.body.entries.map((e) => e.id), 'ta sama kolejność co bez kursora');

    const audit = await db.query(`SELECT metadata_json, entity_id FROM audit_events WHERE action = 'access_log.viewed' AND actor_id = 'u-admin'`);
    assert.ok(audit.rows.length >= 1);
    assert.ok(audit.rows.every((r) => JSON.stringify(r.metadata_json ?? {}) === '{}'));
  });

  test('błędne parametry: 400 z kodem', async () => {
    for (const [query, code] of [
      ['kind=nope', 'invalid_access_kind'], ['outcome=x', 'invalid_outcome'], ['limit=0', 'invalid_limit'],
      ['cursor=!!!', 'invalid_cursor'], ['from=jutro', 'invalid_from'], ['to=kiedys', 'invalid_to'],
      ['householdId=a%20b', 'invalid_household_id'],
    ]) {
      const res = await call(`/api/admin/access-log?${query}`, { cookie: cookies.admin });
      assert.equal(res.status, 400, query);
      assert.equal(res.body.error, code, query);
    }
  });

  test('gwarancja zapisu: eksport listy klasy jest wycofany, gdy wpis dziennika się nie zapisze', async () => {
    await db.exec(`
      CREATE FUNCTION rd_test_fail_roster() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.access_kind = 'class_roster_export' THEN RAISE EXCEPTION 'test_access_log_down'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER rd_test_fail_roster BEFORE INSERT ON data_access_log FOR EACH ROW EXECUTE FUNCTION rd_test_fail_roster();
    `);
    try {
      const before = (await db.query(`SELECT count(*)::int AS n FROM export_runs`)).rows[0].n;
      const res = await call('/api/exports/class-roster?classId=c-1a', { cookie: cookies.board });
      assert.notEqual(res.status, 200);
      for (const marker of PII) assert.ok(!res.text.includes(marker));
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM export_runs`)).rows[0].n, before, 'brak export_runs');
    } finally {
      await db.exec('DROP TRIGGER rd_test_fail_roster ON data_access_log; DROP FUNCTION rd_test_fail_roster();');
    }
  });

  test('gwarancja zapisu: awaria dziennika nie blokuje listy/karty (access_log_failed bez danych)', async () => {
    await db.exec(`
      CREATE FUNCTION rd_test_fail_card() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.access_kind = 'household_card' THEN RAISE EXCEPTION 'test_access_log_down'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER rd_test_fail_card BEFORE INSERT ON data_access_log FOR EACH ROW EXECUTE FUNCTION rd_test_fail_card();
    `);
    const logged = [];
    const original = console.error;
    console.error = (...args) => { logged.push(args); };
    try {
      const res = await call('/api/households/h-1', { cookie: cookies.board });
      assert.equal(res.status, 200);
    } finally {
      console.error = original;
      await db.exec('DROP TRIGGER rd_test_fail_card ON data_access_log; DROP FUNCTION rd_test_fail_card();');
    }
    const event = logged.find((args) => args[0] === 'access_log_failed');
    assert.ok(event);
    const text = JSON.stringify(event);
    for (const marker of [...PII, 'h-1']) assert.ok(!text.includes(marker), `PII w logu serwera: ${marker}`);
  });
});
