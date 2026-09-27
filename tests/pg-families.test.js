// Katalog rodzin na PostgreSQL (issue #5): zakres klas, wiele gospodarstw,
// historia kontaktu i klasy. Wyłącznie dane syntetyczne (.invalid).
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { handlePgRequest } from '../src/pg/app.js';
import { loadMigrations } from '../src/postgres-migrations.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const Y1 = 'y-2026';
const Y2 = 'y-2027';

async function seedFamilies(db) {
  await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, Y2, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: Y1, name: '1A' });
  await seedClass(db, { id: 'c-2b', schoolYearId: Y1, name: '2B' });
  await seedClass(db, { id: 'c-2a-27', schoolYearId: Y2, name: '2A' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Testowa', 'opiekun1@example.invalid', true),
      ('g-2', 'h-2', 'Piotr', 'Testowy', 'opiekun2@example.invalid', false),
      ('g-3', 'h-3', 'Ewa', 'Inna', 'opiekun3@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'Testowa'),
      ('s-2', 'h-1', 'Jan', 'Testowy'),
      ('s-3', 'h-3', 'Kuba', 'Inny');
    -- s-1 ma drugie gospodarstwo (opieka dzielona): h-2, nie główne.
    INSERT INTO student_households (id, student_id, household_id, is_primary, source)
      VALUES ('sh-s1-h2', 's-1', 'h-2', false, 'api');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-1', 'g-1', true, true), ('s-1', 'g-2', false, false),
      ('s-2', 'g-1', true, true), ('s-3', 'g-3', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-1a', '${Y1}'), ('e-2', 's-2', 'c-2b', '${Y1}'), ('e-3', 's-3', 'c-2b', '${Y1}');
  `);
}

// Jedna baza PGlite na grupę testów (każda instancja zajmuje kilkaset MB).
// Testy w grupie wykonują się po kolei; kolejność ma znaczenie.
let shared;
async function setup() {
  if (shared) return shared;
  const db = await createTestDb();
  await seedFamilies(db);
  const env = { db };
  const call = async (path, options = {}) => {
    const response = await handlePgRequest(request(path, options), env);
    return { status: response.status, body: await response.json() };
  };
  const cookies = {
    repA: await seedUserSession(db, { userId: 'u-rep-a', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y1 }] }),
    // Zarząd z sesją MFA: bramka MFA routera wymaga jej od ról z MFA_REQUIRED_ROLES.
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: Y1 }], mfa: true }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-treasurer2', roles: [{ role: 'treasurer', schoolYearId: Y1 }] }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }], mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal' }] }),
  };
  shared = { db, call, cookies };
  return shared;
}

describe('katalog rodzin na wspólnej bazie', () => {
  after(async () => { await shared?.db.close(); shared = null; });

  test('przedstawiciel klasy A widzi tylko klasę A, także przy zgadywaniu identyfikatorów', async () => {
    const { db, call, cookies } = await setup();
    const classes = await call('/api/classes', { cookie: cookies.repA });
    assert.equal(classes.status, 200);
    assert.deepEqual(classes.body.classes.map((c) => c.id), ['c-1a']);
    assert.equal(classes.body.classes[0].studentCount, 1);

    const own = await call('/api/classes/c-1a/students', { cookie: cookies.repA });
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.students.map((s) => s.id), ['s-1']);
    assert.deepEqual(own.body.students[0].households, [
      { householdId: 'h-1', isPrimary: true }, { householdId: 'h-2', isPrimary: false },
    ]);

    // Klasa poza zakresem i klasa nieistniejąca: identyczna odpowiedź.
    const other = await call('/api/classes/c-2b/students', { cookie: cookies.repA });
    const unknown = await call('/api/classes/c-nope/students', { cookie: cookies.repA });
    assert.deepEqual(other, { status: 404, body: { error: 'not_found' } });
    assert.deepEqual(unknown, other);
    assert.deepEqual(await call('/api/classes/..%2Fx/students', { cookie: cookies.repA }), other);

    // Gospodarstwo tylko z uczniem klasy B oraz nieistniejące: 404.
    assert.deepEqual(await call('/api/households/h-3', { cookie: cookies.repA }), other);
    assert.deepEqual(await call('/api/households/h-nope', { cookie: cookies.repA }), other);

    // Gospodarstwo z rodzeństwem w dwóch klasach: widoczne tylko dziecko z klasy A.
    const household = await call('/api/households/h-1', { cookie: cookies.repA });
    assert.equal(household.status, 200);
    assert.deepEqual(household.body.students.map((s) => s.id), ['s-1']);
    assert.deepEqual(household.body.students[0].classes.map((c) => c.classId), ['c-1a']);
    assert.equal(JSON.stringify(household.body).includes('s-2'), false);
    assert.equal(JSON.stringify(household.body).includes('Jan'), false);
    assert.equal(household.body.paymentTotals, undefined);
    // Relacje opiekuna pokazują tylko widocznych uczniów.
    assert.deepEqual(household.body.guardians[0].relations.map((r) => r.studentId), ['s-1']);

    // Drugie gospodarstwo dziecka (opieka dzielona) też jest widoczne, a e-mail
    // opiekuna bez zgody na kontakt jest ukryty przed przedstawicielem.
    const second = await call('/api/households/h-2', { cookie: cookies.repA });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.guardians.map((g) => [g.id, g.contactAllowed, g.email]), [['g-2', false, null]]);
    assert.deepEqual(second.body.students[0].otherHouseholds, [{ householdId: 'h-1', isPrimary: true }]);
    assert.equal(second.body.students[0].isPrimaryHousehold, false);

    // Filtr roku nie poszerza zakresu.
    const year = await call(`/api/classes?schoolYearId=${Y1}`, { cookie: cookies.repA });
    assert.deepEqual(year.body.classes.map((c) => c.id), ['c-1a']);
    assert.equal((await call('/api/classes?schoolYearId=bad%20id', { cookie: cookies.repA })).status, 400);
  });

  test('zarząd widzi wszystkie klasy i rodzeństwo; audyt i dyrekcja nie mają dostępu (D-09)', async () => {
    const { db, call, cookies } = await setup();
    assert.equal((await call('/api/classes')).status, 401);
    for (const cookie of [cookies.audit, cookies.principal]) {
      assert.deepEqual(await call('/api/classes', { cookie }), { status: 403, body: { error: 'forbidden' } });
      assert.equal((await call('/api/classes/c-1a/students', { cookie })).status, 403);
      assert.equal((await call('/api/households/h-1', { cookie })).status, 403);
    }

    const classes = await call('/api/classes', { cookie: cookies.board });
    assert.deepEqual(classes.body.classes.map((c) => c.id), ['c-2a-27', 'c-1a', 'c-2b']);
    const household = await call('/api/households/h-1', { cookie: cookies.board });
    assert.deepEqual(household.body.students.map((s) => [s.id, s.classes.map((c) => c.classId)]), [
      ['s-1', ['c-1a']], ['s-2', ['c-2b']],
    ]);
    assert.equal(household.body.guardians[0].email, 'opiekun1@example.invalid');
    // Brak danych o wpłatach bez MFA: sesja zarządu bez MFA nie przechodzi już bramki
    // MFA routera (sprawdzane niżej dla skarbnika); przedstawiciel nie widzi ich nigdy.

    // Skarbnik roku Y1 widzi klasy tylko tego roku.
    const treasurerClasses = await call('/api/classes', { cookie: cookies.treasurer });
    assert.deepEqual(treasurerClasses.body.classes.map((c) => c.id), ['c-1a', 'c-2b']);
  });

  test('sumy wpłat netto tylko dla ról finansowych z MFA, bez pól zadłużenia', async () => {
    const { db, call, cookies } = await setup();
    await seedUser(db, { userId: 'u-writer' });
    await db.exec(`
      INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
      VALUES ('p-1', 'h-1', '${Y1}', 5000, '2026-10-01', 'bank', 'recorded', 'u-writer', 'families-pay-1'),
             ('p-2', 'h-1', '${Y2}', 7000, '2027-10-01', 'bank', 'recorded', 'u-writer', 'families-pay-2');
      INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
      VALUES ('pc-1', 'p-1', 1500, 'Korekta syntetyczna', 'u-writer', 'families-corr-1');
    `);
    const withMfa = await call('/api/households/h-1', { cookie: cookies.treasurer });
    assert.equal(withMfa.status, 200);
    // Przydział skarbnika ograniczony do Y1: tylko suma z Y1.
    assert.deepEqual(withMfa.body.paymentTotals, [{ schoolYearId: Y1, netAmountCents: 3500, paymentCount: 1 }]);
    const keys = [];
    JSON.stringify(withMfa.body, (key, value) => { keys.push(key); return value; });
    assert.doesNotMatch(keys.join(' '), /debt|due|outstanding|arrears|balance|dłużn|zaleg/i);

    // Skarbnik bez sesji z MFA zatrzymuje się na bramce MFA routera (przed trasą).
    const withoutMfa = await call('/api/households/h-1', { cookie: cookies.treasurerNoMfa });
    assert.deepEqual(withoutMfa, { status: 403, body: { error: 'mfa_enrollment_required' } });
    const rep = await call('/api/households/h-1', { cookie: cookies.repA });
    assert.equal(rep.body.paymentTotals, undefined);
  });

  test('zmiana kontaktu opiekuna: tylko zarząd/admin, historia i audyt bez danych osobowych', async () => {
    const { db, call, cookies } = await setup();
    const path = '/api/guardians/g-2/contact';
    const body = { email: '  Nowy.Opiekun2@Example.INVALID ', contactAllowed: true, reason: 'Prośba opiekuna' };
    assert.deepEqual(await call(path, { method: 'PATCH', cookie: cookies.repA, body }), { status: 403, body: { error: 'forbidden' } });
    assert.equal((await call(path, { method: 'PATCH', cookie: cookies.treasurer, body })).status, 403);
    assert.equal((await call(path, { method: 'PATCH', cookie: cookies.board, body, origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(path, { method: 'PATCH', cookie: cookies.board, body, origin: null })).status, 403);
    assert.deepEqual(await call(path, { method: 'PATCH', cookie: cookies.board, body: { ...body, email: 'zly-adres' } }),
      { status: 400, body: { error: 'invalid_email' } });
    assert.deepEqual(await call(path, { method: 'PATCH', cookie: cookies.board, body: { email: null } }),
      { status: 400, body: { error: 'invalid_reason' } });
    assert.equal((await call('/api/guardians/g-nope/contact', { method: 'PATCH', cookie: cookies.board, body })).status, 404);

    const first = await call(path, { method: 'PATCH', cookie: cookies.board, body });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { guardian: { id: 'g-2', email: 'nowy.opiekun2@example.invalid', contactAllowed: true }, changed: true });
    // Podwójne kliknięcie / ponowienie: brak nowej zmiany.
    const second = await call(path, { method: 'PATCH', cookie: cookies.board, body });
    assert.equal(second.body.changed, false);

    const history = await db.query('SELECT * FROM guardian_contact_changes WHERE guardian_id = $1', ['g-2']);
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].previous_email, 'opiekun2@example.invalid');
    assert.equal(history.rows[0].new_email, 'nowy.opiekun2@example.invalid');
    assert.equal(history.rows[0].previous_contact_allowed, false);
    assert.equal(history.rows[0].changed_by, 'u-board');
    assert.equal(history.rows[0].reason, 'Prośba opiekuna');
    assert.equal(history.rows[0].source, 'api');
    await assert.rejects(db.query('DELETE FROM guardian_contact_changes'), /append_only/);

    const audit = await db.query(`SELECT actor_id, entity_id, metadata_json FROM audit_events WHERE action = 'guardian.contact.updated'`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_id, 'u-board');
    assert.equal(audit.rows[0].entity_id, 'g-2');
    const serialized = JSON.stringify(audit.rows[0].metadata_json);
    assert.doesNotMatch(serialized, /@|Piotr|Testowy|Prośba/);
    assert.deepEqual(audit.rows[0].metadata_json, { fields: ['email', 'contactAllowed'] });

    // Przedstawiciel widzi teraz e-mail (zgoda na kontakt).
    const card = await call('/api/households/h-2', { cookie: cookies.repA });
    assert.equal(card.body.guardians[0].email, 'nowy.opiekun2@example.invalid');

    // Zarząd ograniczony do klasy nie zmieni opiekuna spoza niej (404, nie 403).
    const boardA = await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', classId: 'c-1a', schoolYearId: Y1 }], mfa: true });
    assert.equal((await call('/api/guardians/g-3/contact', { method: 'PATCH', cookie: boardA, body })).status, 404);
  });

  test('zmiana klasy w roku zachowuje historię; nowy rok to nowe przypisanie', async () => {
    const { db, call, cookies } = await setup();
    const path = '/api/students/s-1/enrollments';
    const body = { schoolYearId: Y1, classId: 'c-2b', effectiveOn: '2026-11-03', reason: 'Decyzja szkoły' };
    assert.equal((await call(path, { method: 'POST', cookie: cookies.repA, body })).status, 403);
    assert.equal((await call(path, { method: 'POST', cookie: cookies.board, body, origin: 'https://evil.example' })).status, 403);
    assert.deepEqual(await call(path, { method: 'POST', cookie: cookies.board, body: { ...body, classId: 'c-2a-27' } }),
      { status: 400, body: { error: 'class_year_mismatch' } });
    assert.deepEqual(await call(path, { method: 'POST', cookie: cookies.board, body: { ...body, effectiveOn: '2026-13-01' } }),
      { status: 400, body: { error: 'invalid_effective_on' } });
    assert.equal((await call('/api/students/s-nope/enrollments', { method: 'POST', cookie: cookies.board, body })).status, 404);

    const moved = await call(path, { method: 'POST', cookie: cookies.board, body });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body, { enrollment: { id: 'e-1', studentId: 's-1', schoolYearId: Y1, classId: 'c-2b' }, changed: true });
    const repeat = await call(path, { method: 'POST', cookie: cookies.board, body });
    assert.equal(repeat.body.changed, false);

    const history = await db.query(
      `SELECT kind, from_class_id, to_class_id, to_char(effective_on, 'YYYY-MM-DD') AS effective_on, changed_by, source
         FROM enrollment_history WHERE student_id = 's-1' ORDER BY changed_at, kind DESC`,
    );
    assert.deepEqual(history.rows, [
      { kind: 'enrolled', from_class_id: null, to_class_id: 'c-1a', effective_on: null, changed_by: null, source: 'direct' },
      { kind: 'class_changed', from_class_id: 'c-1a', to_class_id: 'c-2b', effective_on: '2026-11-03', changed_by: 'u-board', source: 'api' },
    ]);
    await assert.rejects(db.query(`DELETE FROM enrollments WHERE id = 'e-1'`), /cannot_be_deleted/);
    await assert.rejects(db.query(`UPDATE enrollment_history SET reason = 'x'`), /append_only/);

    // Po zmianie przedstawiciel klasy A traci wgląd w ucznia i jego rodzinę.
    const own = await call('/api/classes/c-1a/students', { cookie: cookies.repA });
    assert.deepEqual(own.body.students, []);
    assert.equal((await call('/api/households/h-1', { cookie: cookies.repA })).status, 404);

    // Nowy rok: nowy wiersz przypisania, stary zostaje.
    const next = await call(path, { method: 'POST', cookie: cookies.board, body: { ...body, schoolYearId: Y2, classId: 'c-2a-27' } });
    assert.equal(next.status, 201);
    const enrollments = await db.query(`SELECT school_year_id, class_id FROM enrollments WHERE student_id = 's-1' ORDER BY school_year_id`);
    assert.deepEqual(enrollments.rows, [{ school_year_id: Y1, class_id: 'c-2b' }, { school_year_id: Y2, class_id: 'c-2a-27' }]);

    const audit = await db.query(`SELECT action, metadata_json FROM audit_events WHERE entity_type = 'enrollment' ORDER BY occurred_at`);
    assert.deepEqual(audit.rows.map((row) => row.action), ['enrollment.class_changed', 'enrollment.created']);
    assert.doesNotMatch(JSON.stringify(audit.rows), /Ola|Testowa|@/);
  });

  test('model gospodarstw: jedno główne na okres, brak usuwania, synchronizacja kolumny zgodności', async () => {
    const { db } = await setup();
    await assert.rejects(db.query(
      `INSERT INTO student_households (id, student_id, household_id, is_primary) VALUES ('x', 's-1', 'h-3', true)`,
    ), /overlap|unique/);
    await assert.rejects(db.query(
      `INSERT INTO student_households (id, student_id, household_id) VALUES ('x2', 's-1', 'h-2')`,
    ), /overlap/);
    await assert.rejects(db.query(`DELETE FROM student_households WHERE id = 'sh-s1-h2'`), /cannot_be_deleted/);
    await assert.rejects(db.query(`UPDATE student_households SET household_id = 'h-3' WHERE id = 'sh-s1-h2'`), /immutable/);

    // Zmiana głównego gospodarstwa: zamknięcie starego wiersza i nowy wiersz.
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE student_households SET ends_on = CURRENT_DATE, ended_at = now()
                       WHERE student_id = 's-3' AND is_primary AND ends_on IS NULL`);
      await tx.query(`INSERT INTO student_households (id, student_id, household_id, is_primary, starts_on)
                      VALUES ('sh-s3-h2', 's-3', 'h-2', true, CURRENT_DATE)`);
    });
    const student = await db.query(`SELECT household_id FROM students WHERE id = 's-3'`);
    assert.equal(student.rows[0].household_id, 'h-2');
    const rows = await db.query(`SELECT household_id, is_primary, ends_on IS NOT NULL AS ended FROM student_households WHERE student_id = 's-3' ORDER BY created_at, id`);
    assert.deepEqual(rows.rows, [
      { household_id: 'h-3', is_primary: true, ended: true },
      { household_id: 'h-2', is_primary: true, ended: false },
    ]);
    await assert.rejects(db.query(`UPDATE student_households SET ends_on = NULL, ended_at = NULL WHERE student_id = 's-3' AND household_id = 'h-3'`), /already_ended/);

    // Bezpośrednia zmiana starej kolumny tworzy nowe główne członkostwo.
    await db.query(`UPDATE students SET household_id = 'h-3' WHERE id = 's-2'`);
    const s2 = await db.query(`SELECT household_id, source FROM student_households_current WHERE student_id = 's-2' AND is_primary`);
    assert.deepEqual(s2.rows, [{ household_id: 'h-3', source: 'household_id_update' }]);

    // Opiekun w dwóch gospodarstwach.
    await db.query(`INSERT INTO guardian_households (id, guardian_id, household_id) VALUES ('gh-g1-h2', 'g-1', 'h-2')`);
    const g1 = await db.query(`SELECT household_id FROM guardian_households_current WHERE guardian_id = 'g-1' ORDER BY household_id`);
    assert.deepEqual(g1.rows.map((row) => row.household_id), ['h-1', 'h-2']);
  });

});

test('migracja 0014 przepisuje istniejące wiersze z kolumn zgodności', async () => {
  const db = new PGlite();
  try {
    const migrations = await loadMigrations(fileURLToPath(new URL('../postgres/migrations/', import.meta.url)));
    const index = migrations.findIndex((migration) => migration.name.startsWith('0014_'));
    assert.ok(index > 0);
    for (const migration of migrations.slice(0, index)) await db.exec(migration.sql);
    await db.exec(`
      INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ('y-old', 'old', '2025-09-01', '2026-08-31');
      INSERT INTO classes (id, school_year_id, name) VALUES ('c-old', 'y-old', '1A');
      INSERT INTO households (id) VALUES ('h-old');
      INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ('g-old', 'h-old', 'A', 'B');
      INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-old', 'h-old', 'C', 'D');
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-old', 's-old', 'c-old', 'y-old');
    `);
    for (const migration of migrations.slice(index)) await db.exec(migration.sql);
    const sh = await db.query(`SELECT household_id, is_primary, source FROM student_households WHERE student_id = 's-old'`);
    assert.deepEqual(sh.rows, [{ household_id: 'h-old', is_primary: true, source: 'legacy_backfill' }]);
    const gh = await db.query(`SELECT household_id, source FROM guardian_households WHERE guardian_id = 'g-old'`);
    assert.deepEqual(gh.rows, [{ household_id: 'h-old', source: 'legacy_backfill' }]);
    const eh = await db.query(`SELECT kind, to_class_id, source FROM enrollment_history WHERE enrollment_id = 'e-old'`);
    assert.deepEqual(eh.rows, [{ kind: 'enrolled', to_class_id: 'c-old', source: 'legacy_backfill' }]);
  } finally {
    await db.close();
  }
});
