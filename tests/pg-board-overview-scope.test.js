// #131: pulpit zarządu — zakres klasowy, zgodność z pulpitem przedstawiciela
// i listą klasy, migawka odczytu. Dane wyłącznie syntetyczne (.invalid).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const Y = 'y-2026';

async function call(env, path, cookie) {
  const response = await handlePgRequest(request(path, { cookie }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function seed(db) {
  await seedSchoolYear(db, Y);
  await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: Y, name: '1B' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Testowa', 'g1@example.invalid', true),
      ('g-2', 'h-2', 'Piotr', 'Testowy', NULL, true),
      ('g-3', 'h-3', 'Ewa', 'Inna', 'g3@example.invalid', true);
    -- s-1 i s-2: rodzeństwo z h-1 w dwóch klasach; s-3 (h-2) bez e-maila; s-4 (h-3) odszedł ze szkoły.
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'Testowa'), ('s-2', 'h-1', 'Jan', 'Testowy'),
      ('s-3', 'h-2', 'Kuba', 'Inny'), ('s-4', 'h-3', 'Zosia', 'Odeszła');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-1', 'g-1', true, true), ('s-2', 'g-1', true, true), ('s-3', 'g-2', true, true), ('s-4', 'g-3', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-1a', '${Y}'), ('e-2', 's-3', 'c-1a', '${Y}'), ('e-3', 's-2', 'c-1b', '${Y}');
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-4', 's-4', 'c-1a', '${Y}');
    UPDATE enrollments SET ended_on = '2020-01-01', ended_reason = 'zmiana szkoły', ended_at = now() WHERE id = 'e-4';
  `);
}

describe('pulpit zarządu: zakres klasowy i spójność (#131)', () => {
  test('zarząd klasowy widzi tylko swoje klasy, bez kolumny wpłat; suma tylko z jego klas', async () => {
    const db = await createTestDb();
    await seed(db);
    const env = { db };
    const classBoard = await seedUserSession(db, { userId: 'u-cb', roles: [{ role: 'board', classId: 'c-1b', schoolYearId: Y }], mfa: true });
    const result = await call(env, `/api/board/overview?schoolYearId=${Y}`, classBoard);
    assert.equal(result.status, 200);
    assert.equal(result.data.scope, 'classes');
    assert.deepEqual(result.data.classes.map((c) => c.id), ['c-1b']);
    assert.equal(result.data.totals.studentCount, 1);
    assert.equal(result.data.totals.householdCount, 1);
    assert.equal(Object.hasOwn(result.data.totals, 'paymentEntryRatePercent'), false);
    assert.equal(Object.hasOwn(result.data.totals, 'unmatchedPaymentsCount'), false);
    assert.equal(Object.hasOwn(result.data.classes[0], 'paymentEntryRatePercent'), false);
    assert.doesNotMatch(JSON.stringify(result.data), /1A|c-1a|example\.invalid|Testow/);
    await db.close();
  });

  test('zarząd klasowy: przydział innego roku i cudzej klasy nie otwiera tego roku (404); przedstawiciel 403', async () => {
    const db = await createTestDb();
    await seed(db);
    await seedSchoolYear(db, 'y-2025');
    await seedClass(db, { id: 'c-old', schoolYearId: 'y-2025', name: '9Z' });
    const env = { db };
    const oldBoard = await seedUserSession(db, { userId: 'u-old', roles: [{ role: 'board', classId: 'c-old', schoolYearId: 'y-2025' }], mfa: true });
    assert.equal((await call(env, `/api/board/overview?schoolYearId=${Y}`, oldBoard)).status, 404);
    assert.equal((await call(env, '/api/board/overview?schoolYearId=y-2025', oldBoard)).status, 200);
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }] });
    assert.equal((await call(env, `/api/board/overview?schoolYearId=${Y}`, rep)).status, 403);
    await db.close();
  });

  test('liczby zgodne z listą klasy i pulpitem przedstawiciela; uczeń, który odszedł, poza licznikami', async () => {
    const db = await createTestDb();
    await seed(db);
    const env = { db };
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [
      { role: 'representative', classId: 'c-1a', schoolYearId: Y }, { role: 'representative', classId: 'c-1b', schoolYearId: Y },
    ] });
    const board = (await call(env, `/api/board/overview?schoolYearId=${Y}`, admin)).data;
    const repView = (await call(env, `/api/representative/overview?schoolYearId=${Y}`, rep)).data;
    const list = (await call(env, '/api/classes', admin)).data;
    for (const item of board.classes) {
      const fromRep = repView.classes.find((c) => c.id === item.id);
      const fromList = list.classes.find((c) => c.id === item.id);
      assert.equal(item.studentCount, fromRep.studentCount);
      assert.equal(item.householdCount, fromRep.householdCount);
      assert.equal(item.noContactCount, fromRep.needsPaperCardCount, 'Do kartki = pulpit przedstawiciela');
      assert.equal(item.contactEmailCount + item.noContactCount, item.studentCount);
      assert.equal(item.studentCount, fromList.studentCount);
    }
    const a = board.classes.find((c) => c.id === 'c-1a');
    assert.equal(a.studentCount, 2, 's-4 z ended_on w przeszłości nie jest liczony');
    assert.equal(a.noContactCount, 1);
    assert.equal(board.totals.householdCount, 2, 'rodzeństwo h-1 w dwóch klasach liczone raz w sumie');
    assert.equal(board.classes.reduce((sum, c) => sum + c.studentCount, 0), board.totals.studentCount);
    await db.close();
  });

  test('odpowiedź jest składana w jednej migawce REPEATABLE READ (readSnapshot)', async () => {
    const db = await createTestDb();
    await seed(db);
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const seen = [];
    const original = db.transaction.bind(db);
    db.transaction = (fn) => original((tx) => fn({
      ...tx,
      query: async (sql, params) => { seen.push(String(sql).trim()); return tx.query(sql, params); },
    }));
    const env = { db };
    const result = await call(env, `/api/board/overview?schoolYearId=${Y}`, admin);
    assert.equal(result.status, 200);
    assert.ok(seen.length > 0 && seen.some((sql) => /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ/.test(sql)), 'migawka ustawia REPEATABLE READ');
    assert.ok(seen.filter((sql) => /^SELECT/.test(sql)).length >= 3, 'wszystkie zapytania w transakcji');
    await db.close();
  });
});
