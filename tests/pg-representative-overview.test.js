// Pulpit przedstawiciela klasy (#118): jedna trasa zbiorcza. Wyłącznie dane
// syntetyczne (domeny .invalid).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const Y = 'y-2026';
const Y_OLD = 'y-2025';

async function call(env, path, { cookie } = {}) {
  const response = await handlePgRequest(request(path, { cookie }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

describe('pulpit przedstawiciela (#118)', () => {
  test('granice ról: brak przydziału representative → 403; brak sesji → 401', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
    const audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }], mfa: true });
    const principal = await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal' }] });
    for (const cookie of [board, audit, principal]) {
      assert.equal((await call(env, `/api/representative/overview?schoolYearId=${Y}`, { cookie })).status, 403);
    }
    assert.equal((await call(env, `/api/representative/overview?schoolYearId=${Y}`)).status, 401);
    await db.close();
  });

  test('przedstawiciel z przydziałem zeszłego roku nie widzi klas bieżącego roku (bez 403)', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    await seedClass(db, { id: 'c-old', schoolYearId: Y_OLD, name: '1A (stary rok)' });
    const env = { db };
    const rep = await seedUserSession(db, { userId: 'u-rep-old', roles: [{ role: 'representative', classId: 'c-old', schoolYearId: Y_OLD }] });
    const result = await call(env, `/api/representative/overview?schoolYearId=${Y}`, { cookie: rep });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { schoolYearId: Y, classes: [] });
  });

  test('przedstawiciel dwóch klas widzi obie; rodzeństwo liczone w obu bez ujawnienia drugiego dziecka; kontakt i wydarzenia', async () => {
    const db = await createTestDb();
    await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
    await seedClass(db, { id: 'c-1b', schoolYearId: Y, name: '1B' });
    const env = { db };
    const rep = await seedUserSession(db, {
      userId: 'u-rep', roles: [
        { role: 'representative', classId: 'c-1a', schoolYearId: Y },
        { role: 'representative', classId: 'c-1b', schoolYearId: Y },
      ],
    });
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-1', 'h-1', 'Anna', 'Testowa', 'g1@example.invalid', true),
        ('g-2', 'h-2', 'Piotr', 'Testowy', NULL, true),
        ('g-3', 'h-3', 'Ewa', 'Inna', 'g3@example.invalid', false);
      -- s-1 i s-2: rodzeństwo w dwóch różnych klasach, jedno gospodarstwo (h-1), z pełną zgodą.
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-1', 'h-1', 'Ola', 'Testowa'),
        ('s-2', 'h-1', 'Jan', 'Testowy'),
        -- s-3: opiekun bez e-maila -> do kartki.
        ('s-3', 'h-2', 'Kuba', 'Inny'),
        -- s-4: opiekun z e-mailem, ale bez zgody -> do kartki.
        ('s-4', 'h-3', 'Zosia', 'Nowak');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-1', 'g-1', true, true), ('s-2', 'g-1', true, true),
        ('s-3', 'g-2', true, true), ('s-4', 'g-3', true, true);
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
        ('e-1', 's-1', 'c-1a', '${Y}'), ('e-2', 's-2', 'c-1b', '${Y}'),
        ('e-3', 's-3', 'c-1a', '${Y}'), ('e-4', 's-4', 'c-1b', '${Y}');
      INSERT INTO events (id, school_year_id, title, begins_at, created_by, class_id, audience, status, revision_no, updated_by) VALUES
        ('ev-1', '${Y}', 'Robocze 1A', '2026-11-01T10:00:00Z', 'u-rep', 'c-1a', 'internal', 'draft', 1, 'u-rep'),
        ('ev-2', '${Y}', 'Zgłoszone 1A', '2026-11-05T10:00:00Z', 'u-rep', 'c-1a', 'internal', 'draft', 1, 'u-rep');
      UPDATE events SET status = 'submitted', submitted_revision_no = 1, submitted_by = 'u-rep', submitted_at = now()
        WHERE id = 'ev-2';
    `);
    const result = await call(env, `/api/representative/overview?schoolYearId=${Y}`, { cookie: rep });
    assert.equal(result.status, 200);
    const byId = Object.fromEntries(result.data.classes.map((c) => [c.id, c]));
    assert.deepEqual(Object.keys(byId).sort(), ['c-1a', 'c-1b']);

    assert.equal(byId['c-1a'].studentCount, 2, 's-1 i s-3');
    assert.equal(byId['c-1a'].householdCount, 2, 'h-1 i h-2 — rodzeństwo w h-1 liczone raz');
    assert.equal(byId['c-1a'].needsPaperCardCount, 1, 's-3 (opiekun bez e-maila)');
    assert.deepEqual(byId['c-1a'].events, { draftCount: 1, submittedCount: 1 });

    assert.equal(byId['c-1b'].studentCount, 2, 's-2 i s-4');
    assert.equal(byId['c-1b'].needsPaperCardCount, 1, 's-4 (opiekun bez zgody)');
    assert.deepEqual(byId['c-1b'].events, { draftCount: 0, submittedCount: 0 });

    // Bez decyzji D-08: pole payments w ogóle nie istnieje w odpowiedzi.
    assert.equal(Object.hasOwn(result.data, 'payments'), false);
    for (const klass of result.data.classes) assert.equal(Object.hasOwn(klass, 'payments'), false);
    // Zakaz słów z AGENTS.md/D-08 w całej odpowiedzi.
    assert.doesNotMatch(JSON.stringify(result.data), /dłużnik|zaległoś|brak wpłaty|example\.invalid/i);

    await db.close();
  });

  test('nieprawidłowy schoolYearId — 400', async () => {
    const db = await createTestDb();
    const env = { db };
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-x', schoolYearId: Y }] });
    assert.equal((await call(env, '/api/representative/overview', { cookie: rep })).status, 400);
    assert.equal((await call(env, '/api/representative/overview?schoolYearId=', { cookie: rep })).status, 400);
    await db.close();
  });
});
