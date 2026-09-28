// Konfiguracja nowego roku szkolnego: tworzenie roku i klas (#78, część 1/4 —
// bez kopiowania struktury klas ani masowej promocji, patrz PR). Wyłącznie
// dane syntetyczne (domeny .invalid).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedUserSession } from './helpers/pg.js';

async function setup() {
  const db = await createTestDb();
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

describe('konfiguracja roku szkolnego (#78): tworzenie roku i klas', () => {
  test('wyłącznie admin z MFA; zarząd i przedstawiciel — 403', async () => {
    const { env, board } = await setup();
    const rep = await seedUserSession(env.db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-x', schoolYearId: 'y-x' }], mfa: true,
    });
    const body = { id: 'y-2027', label: 'Rok 2027/2028', startsOn: '2027-09-01', endsOn: '2028-08-31' };
    assert.equal((await post(env, '/api/admin/school-years', board, body)).status, 403);
    assert.equal((await post(env, '/api/admin/school-years', rep, body)).status, 403);
    assert.equal((await call(env, '/api/admin/school-years', { method: 'POST', body })).status, 401);
  });

  test('tworzy rok, odrzuca zły zakres dat i duplikat, dopisuje audyt', async () => {
    const { db, env, admin } = await setup();
    const bad = await post(env, '/api/admin/school-years', admin,
      { id: 'y-2027', label: 'Rok 2027/2028', startsOn: '2028-09-01', endsOn: '2027-08-31' });
    assert.deepEqual(bad.data, { error: 'invalid_date_range' });

    const created = await post(env, '/api/admin/school-years', admin,
      { id: 'y-2027', label: 'Rok 2027/2028', startsOn: '2027-09-01', endsOn: '2028-08-31' });
    assert.equal(created.status, 201);
    assert.deepEqual(created.data, { schoolYear: { id: 'y-2027', label: 'Rok 2027/2028', startsOn: '2027-09-01', endsOn: '2028-08-31' } });

    const duplicate = await post(env, '/api/admin/school-years', admin,
      { id: 'y-2027', label: 'Inna etykieta', startsOn: '2027-09-01', endsOn: '2028-08-31' });
    assert.equal(duplicate.status, 409);

    const audit = await db.query("SELECT action, entity_id FROM audit_events WHERE action = 'school_year.created'");
    assert.deepEqual(audit.rows, [{ action: 'school_year.created', entity_id: 'y-2027' }]);
  });

  test('tworzy klasy roku, odrzuca duplikat nazwy i nieistniejący rok; bez trasy usuwania', async () => {
    const { db, env, admin } = await setup();
    await post(env, '/api/admin/school-years', admin, { id: 'y-2027', label: 'Rok 2027/2028', startsOn: '2027-09-01', endsOn: '2028-08-31' });

    const notFound = await post(env, '/api/admin/school-years/y-nope/classes', admin, { names: ['1A'] });
    assert.equal(notFound.status, 404);

    const created = await post(env, '/api/admin/school-years/y-2027/classes', admin, { names: ['1A', '2B'] });
    assert.equal(created.status, 201);
    assert.deepEqual(created.data.classes.map((c) => c.name), ['1A', '2B']);

    const deleteAttempt = await call(env, '/api/admin/school-years/y-2027/classes', { method: 'DELETE', cookie: admin });
    assert.notEqual(deleteAttempt.status, 200);

    const duplicate = await post(env, '/api/admin/school-years/y-2027/classes', admin, { names: ['1A'] });
    assert.equal(duplicate.status, 409);

    const classes = await db.query("SELECT name FROM classes WHERE school_year_id = 'y-2027' ORDER BY name");
    assert.deepEqual(classes.rows.map((r) => r.name), ['1A', '2B']);
    const audit = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'class.created'");
    assert.equal(audit.rows[0].n, 2);

    // AC #78: brak drogi do usunięcia klasy z przypisaniami — z przypisaniem
    // usunięcie odrzuca istniejące ograniczenie FK (enrollments.class_id);
    // klasa bez przypisań nie ma tej ochrony (poza zakresem tego zadania —
    // korekta pustej, błędnie utworzonej klasy zostaje wyjątkiem ręcznym).
    const classId = (await db.query("SELECT id FROM classes WHERE school_year_id = 'y-2027' AND name = '1A'")).rows[0].id;
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-2027');
      INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-2027', 'h-2027', 'Ola', 'Testowa');
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-2027', 's-2027', '${classId}', 'y-2027');
    `);
    await assert.rejects(db.query(`DELETE FROM classes WHERE id = '${classId}'`), /foreign key|violates/);
  });
});

describe('zamrożenie roku obejmuje enrollments (#78, migracja 0054)', () => {
  test('zamknięty rok odrzuca nowe i zmienione przypisania; odczyt bez zmian', async () => {
    const { CHECKLIST_ITEMS } = await import('../src/pg/routes/year-close.js');
    const db = await createTestDb();
    const OLD = 'y-closing';
    const NEW = 'y-next';
    await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
      ($1, 'Rok zamykany (test)', '2025-09-01', '2026-08-31'),
      ($2, 'Rok następny (test)', '2026-09-01', '2027-08-31')`, [OLD, NEW]);
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1');
      INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-1', 'h-1', 'Ola', 'Testowa');
      INSERT INTO classes (id, school_year_id, name) VALUES ('c-1a', '${OLD}', '1A');
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-1', 's-1', 'c-1a', '${OLD}');
    `);
    const boardA = await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true });
    const boardB = await seedUserSession(db, { userId: 'u-board-b', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true });
    const env = { db };
    const post = (path, cookie, body = {}) => handlePgRequest(request(path, { method: 'POST', cookie, body }), env);

    const started = await post(`/api/year-close/${OLD}/start`, boardA, { nextSchoolYearId: NEW });
    assert.equal(started.status, 201, await started.text());
    for (const item of CHECKLIST_ITEMS) {
      const confirmed = await post(`/api/year-close/${OLD}/checklist/${item}`, boardA, { note: `Potwierdzenie ${item}` });
      assert.equal(confirmed.status, 201, item);
    }
    const closed = await post(`/api/year-close/${OLD}/close`, boardB, {});
    assert.equal(closed.status, 200, await closed.text());

    await assert.rejects(db.query(`UPDATE enrollments SET class_id = 'c-1a' WHERE id = 'e-1'`), /school_year_closed/);
    await assert.rejects(
      db.query(`INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-2', 's-1', 'c-1a', '${OLD}')`),
      /school_year_closed/,
    );
    // Odczyt pozostaje bez zmian.
    const read = await db.query(`SELECT id FROM enrollments WHERE school_year_id = '${OLD}'`);
    assert.deepEqual(read.rows, [{ id: 'e-1' }]);
    await db.close();
  });
});
