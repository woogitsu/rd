// Odejście ze szkoły w trakcie roku (#86): zakończenie przypisania zamiast
// usuwania. Baza własna (nie współdzielona), żeby nie zależeć od kolejności
// z tests/pg-families.test.js. Wyłącznie dane syntetyczne (.invalid).
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { buildClassRoster } from '../src/pg/export.js';
import { computeSnapshot } from '../src/pg/routes/email.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const Y1 = 'y-2026';

async function seed(db) {
  await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: Y1, name: '1A' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Testowa', 'opiekun1@example.invalid', true),
      ('g-2', 'h-2', 'Piotr', 'Testowy', 'opiekun2@example.invalid', true);
    -- Rodzeństwo w tej samej klasie: s-1 odchodzi, s-2 zostaje.
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'Testowa'),
      ('s-2', 'h-2', 'Jan', 'Testowy');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-1', 'g-1', true, true), ('s-2', 'g-2', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-1a', '${Y1}'), ('e-2', 's-2', 'c-1a', '${Y1}');
  `);
}

async function setup() {
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db); // #145: kampanie i kartki wymagają opublikowanej informacji
  await seed(db);
  const env = { db };
  const call = async (path, options = {}) => {
    const response = await handlePgRequest(request(path, options), env);
    return { status: response.status, body: await response.json() };
  };
  const cookies = {
    repA: await seedUserSession(db, { userId: 'u-rep-a', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y1 }] }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true }),
  };
  return { db, env, call, cookies };
}

describe('zakończenie przypisania (odejście ze szkoły, #86)', () => {
  test('przedstawiciel nie może zakończyć przypisania; zarząd może, powód wymagany', async () => {
    const { db, call, cookies } = await setup();
    const path = '/api/students/s-1/enrollments/e-1/end';
    const body = { endedOn: '2026-10-15', reason: 'Zmiana szkoły' };
    assert.equal((await call(path, { method: 'POST', cookie: cookies.repA, body })).status, 403);
    assert.equal((await call(path, { method: 'POST', cookie: cookies.board, body: { endedOn: '2026-10-15', reason: 'x' } })).status, 400);
    assert.equal((await call('/api/students/s-1/enrollments/e-nope/end', { method: 'POST', cookie: cookies.board, body })).status, 404);

    const ended = await call(path, { method: 'POST', cookie: cookies.board, body });
    assert.deepEqual(ended.body, { enrollment: { id: 'e-1', studentId: 's-1', endedOn: '2026-10-15' }, changed: true });

    const history = await db.query(
      `SELECT kind, from_class_id, to_class_id, to_char(effective_on, 'YYYY-MM-DD') AS effective_on, reason, changed_by, source
         FROM enrollment_history WHERE student_id = 's-1' AND kind = 'withdrawn'`,
    );
    assert.deepEqual(history.rows, [
      { kind: 'withdrawn', from_class_id: 'c-1a', to_class_id: 'c-1a', effective_on: '2026-10-15', reason: 'Zmiana szkoły', changed_by: 'u-board', source: 'api' },
    ]);
    const audit = await db.query(`SELECT action, entity_id FROM audit_events WHERE action = 'enrollment.withdrawn'`);
    assert.deepEqual(audit.rows, [{ action: 'enrollment.withdrawn', entity_id: 'e-1' }]);
    assert.doesNotMatch(JSON.stringify(audit.rows), /Ola|Testowa|@/);
  });

  test('podwójne kliknięcie: bez drugiego wpisu historii, wynik ten sam', async () => {
    const { db, call, cookies } = await setup();
    const path = '/api/students/s-1/enrollments/e-1/end';
    const body = { endedOn: '2026-10-15', reason: 'Zmiana szkoły' };
    await call(path, { method: 'POST', cookie: cookies.board, body });
    const repeat = await call(path, { method: 'POST', cookie: cookies.board, body: { endedOn: '2027-01-01', reason: 'Inny powód' } });
    assert.deepEqual(repeat.body, { enrollment: { id: 'e-1', studentId: 's-1', endedOn: '2026-10-15' }, changed: false });
    const history = await db.query(`SELECT count(*)::int AS n FROM enrollment_history WHERE student_id = 's-1' AND kind = 'withdrawn'`);
    assert.equal(history.rows[0].n, 1);
  });

  test('po zakończeniu przypisanie jest niezmienne (zmiana klasy odrzucona)', async () => {
    const { db } = await setup();
    await db.query(`UPDATE enrollments SET ended_on = '2026-10-15', ended_reason = 'test', ended_by = 'u-board', ended_at = now() WHERE id = 'e-1'`);
    await assert.rejects(db.query(`UPDATE enrollments SET class_id = 'c-1a' WHERE id = 'e-1'`), /enrollment_already_ended/);
    await assert.rejects(db.query(`DELETE FROM enrollments WHERE id = 'e-1'`), /cannot_be_deleted/);
  });

  test('rodzeństwo: uczeń, który odszedł, znika z listy klasy, kartek, kampanii i eksportu — drugie dziecko zostaje', async () => {
    const { db, env, call, cookies } = await setup();
    // Data w przeszłości — student ma już nie być widoczny dziś (enrollments_current).
    await call('/api/students/s-1/enrollments/e-1/end', {
      method: 'POST', cookie: cookies.board, body: { endedOn: '2020-01-01', reason: 'Zmiana szkoły' },
    });

    const roster = await call('/api/classes/c-1a/students', { cookie: cookies.board });
    assert.deepEqual(roster.body.students.map((s) => s.id), ['s-2']);
    const classes = await call('/api/classes', { cookie: cookies.board });
    assert.equal(classes.body.classes.find((c) => c.id === 'c-1a').studentCount, 1);

    const cards = await call(`/api/print/cards?schoolYearId=${Y1}&classId=c-1a`, { cookie: cookies.board });
    assert.deepEqual(cards.body.rows.map((r) => r.householdId), ['h-2']);

    const roster2 = await buildClassRoster(db, 'c-1a');
    assert.deepEqual(roster2.roster.students.map((s) => s.id), ['s-2']);

    const snapshot = await computeSnapshot(env.db, { school_year_id: Y1, audience: 'all' });
    assert.deepEqual(snapshot.recipients.map((r) => r.householdId).sort(), ['h-2']);
  });

  test('data zakończenia w przyszłości: uczeń widoczny do tej daty', async () => {
    const { call, cookies } = await setup();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await call('/api/students/s-1/enrollments/e-1/end', {
      method: 'POST', cookie: cookies.board, body: { endedOn: future, reason: 'Zmiana szkoły' },
    });
    const roster = await call('/api/classes/c-1a/students', { cookie: cookies.board });
    assert.deepEqual(roster.body.students.map((s) => s.id).sort(), ['s-1', 's-2']);
  });
});
