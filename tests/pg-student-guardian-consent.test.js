// Zgoda na kontakt w relacji opiekun–dziecko (#190): strażnik, historia i trasa
// PATCH /api/guardians/{id}/students/{studentId}. Wyłącznie dane syntetyczne (.invalid).
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { handlePgRequest } from '../src/pg/app.js';
import { buildClassRoster } from '../src/pg/export.js';
import { computeSnapshot } from '../src/pg/routes/email.js';
import { loadMigrations } from '../src/postgres-migrations.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession, assertOwnerGuard } from './helpers/pg.js';

const Y1 = 'y-2026';
const REASON = 'Zgoda złożona na zebraniu (syntetyczne)';

// Jak po imporcie (D-03): relacje bez zgody, opiekunowie ze zgodą.
async function seedFamilies(db) {
  await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: Y1, name: '1A' });
  await seedClass(db, { id: 'c-2b', schoolYearId: Y1, name: '2B' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-3');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Testowa', 'opiekun1@example.invalid', true),
      ('g-2', 'h-1', 'Piotr', 'Testowy', 'opiekun2@example.invalid', true),
      ('g-3', 'h-3', 'Ewa', 'Inna', 'opiekun3@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'Testowa'), ('s-2', 'h-1', 'Jan', 'Testowy'), ('s-3', 'h-3', 'Kuba', 'Inny');
    INSERT INTO student_guardians (student_id, guardian_id) VALUES
      ('s-1', 'g-1'), ('s-1', 'g-2'), ('s-2', 'g-1'), ('s-3', 'g-3');
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-1a', '${Y1}'), ('e-2', 's-2', 'c-2b', '${Y1}'), ('e-3', 's-3', 'c-2b', '${Y1}');
  `);
}

let shared;
async function setup() {
  if (shared) return shared;
  const db = await createTestDb();
  await seedFamilies(db);
  const env = { db };
  const patch = async (guardianId, studentId, body, cookie) => {
    const response = await handlePgRequest(request(`/api/guardians/${guardianId}/students/${studentId}`, { method: 'PATCH', cookie, body }), env);
    return { status: response.status, body: await response.json() };
  };
  const cookies = {
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true }),
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin', schoolYearId: Y1 }], mfa: true }),
    boardA: await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', classId: 'c-1a', schoolYearId: Y1 }], mfa: true }),
    repA: await seedUserSession(db, { userId: 'u-rep-a', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y1 }] }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: Y1 }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }], mfa: true }),
  };
  shared = { db, patch, cookies };
  return shared;
}

const relation = async (db, studentId, guardianId) => (await db.query(
  'SELECT contact_allowed FROM student_guardians WHERE student_id = $1 AND guardian_id = $2', [studentId, guardianId],
)).rows[0]?.contact_allowed;
const history = async (db, where = 'true', params = []) => (await db.query(
  `SELECT student_id, guardian_id, previous_contact_allowed, new_contact_allowed, reason, source, changed_by
     FROM student_guardian_changes WHERE ${where} ORDER BY changed_at, id`, params,
)).rows;
const count = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

describe('zgoda relacji opiekun–dziecko na wspólnej bazie', () => {
  after(async () => { await shared?.db.close(); shared = null; });

  test('kampania po imporcie ma 0 odbiorców; po ustawieniu zgody relacji ma odbiorców', async () => {
    const { db, patch, cookies } = await setup();
    const campaign = { school_year_id: Y1, audience: 'all_households' };
    const before = await computeSnapshot(db, campaign);
    assert.equal(before.recipients.length, 0);
    assert.deepEqual(before.exclusions.map((e) => e.reason).sort(), ['no_consent', 'no_consent']);

    const res = await patch('g-3', 's-3', { contactAllowed: true, reason: REASON }, cookies.board);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { relation: { guardianId: 'g-3', studentId: 's-3', contactAllowed: true }, guardianContactAllowed: true, changed: true });

    const afterPatch = await computeSnapshot(db, campaign);
    assert.deepEqual(afterPatch.recipients.map((r) => [r.householdId, r.guardianId]), [['h-3', 'g-3']]);
    // Lista klasy dla przedstawiciela: e-mail widoczny przy obu zgodach.
    const roster = await buildClassRoster(db, 'c-2b');
    assert.ok(JSON.stringify(roster).includes('opiekun3@example.invalid'));
  });

  test('dwoje opiekunów jednego dziecka: zmiana jednej relacji nie rusza drugiej, jeden wpis historii z aktorem', async () => {
    const { db, patch, cookies } = await setup();
    const res = await patch('g-2', 's-1', { contactAllowed: true, reason: REASON }, cookies.admin);
    assert.equal(res.status, 200);
    assert.equal(await relation(db, 's-1', 'g-2'), true);
    assert.equal(await relation(db, 's-1', 'g-1'), false);
    const rows = await history(db, "student_id = 's-1'");
    assert.deepEqual(rows, [{
      student_id: 's-1', guardian_id: 'g-2', previous_contact_allowed: false, new_contact_allowed: true,
      reason: REASON, source: 'api', changed_by: 'u-admin',
    }]);
    // Zgoda opiekuna (guardians) bez zmian i bez wpisu w jej historii.
    assert.equal(await count(db, 'SELECT count(*) AS n FROM guardian_contact_changes'), 0);
  });

  test('rodzeństwo: zgoda włączona dla dziecka z 1A i wyłączona dla dziecka z 2B to osobne wpisy', async () => {
    const { db, patch, cookies } = await setup();
    assert.equal((await patch('g-1', 's-1', { contactAllowed: true, reason: REASON }, cookies.board)).status, 200);
    assert.equal((await patch('g-1', 's-2', { contactAllowed: true, reason: REASON }, cookies.board)).status, 200);
    assert.equal((await patch('g-1', 's-2', { contactAllowed: false, reason: 'Wycofanie zgody (syntetyczne)' }, cookies.board)).status, 200);
    assert.equal(await relation(db, 's-1', 'g-1'), true);
    assert.equal(await relation(db, 's-2', 'g-1'), false);
    const rows = await history(db, "guardian_id = 'g-1'");
    assert.deepEqual(rows.map((r) => [r.student_id, r.previous_contact_allowed, r.new_contact_allowed]),
      [['s-1', false, true], ['s-2', false, true], ['s-2', true, false]]);
    // Kampania: rodzina h-1 ma adresata dzięki relacji z s-1 (ta sama reguła co w historii).
    const snapshot = await computeSnapshot(db, { school_year_id: Y1, audience: 'all_households' });
    assert.ok(snapshot.recipients.some((r) => r.householdId === 'h-1'));
  });

  test('podwójne kliknięcie i ponowienie: jedna zmiana, jeden wpis historii, jedno zdarzenie audytu', async () => {
    const { db, patch, cookies } = await setup();
    const auditBefore = await count(db, "SELECT count(*) AS n FROM audit_events WHERE action = 'student_guardian.contact.updated'");
    const historyBefore = (await history(db)).length;
    const [first, second] = await Promise.all([
      patch('g-3', 's-3', { contactAllowed: false, reason: REASON }, cookies.board),
      patch('g-3', 's-3', { contactAllowed: false, reason: REASON }, cookies.board),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual([first.body.changed, second.body.changed].sort(), [false, true]);
    const retry = await patch('g-3', 's-3', { contactAllowed: false, reason: REASON }, cookies.board);
    assert.equal(retry.body.changed, false);
    assert.equal((await history(db)).length, historyBefore + 1);
    assert.equal(await count(db, "SELECT count(*) AS n FROM audit_events WHERE action = 'student_guardian.contact.updated'"), auditBefore + 1);
  });

  test('zakres klasowy: zarząd z przydziałem 1A zmienia tylko relację z dzieckiem z 1A; poza zakresem 404', async () => {
    const { db, patch, cookies } = await setup();
    // g-1 ma aktywną relację z s-1 (1A), ale s-2 jest w 2B — relacja poza zakresem.
    const outside = await patch('g-1', 's-2', { contactAllowed: true, reason: REASON }, cookies.boardA);
    assert.equal(outside.status, 404);
    assert.deepEqual(outside.body, { error: 'not_found' });
    const other = await patch('g-3', 's-3', { contactAllowed: true, reason: REASON }, cookies.boardA);
    assert.equal(other.status, 404);
    const missing = await patch('g-3', 's-1', { contactAllowed: true, reason: REASON }, cookies.boardA);
    assert.equal(missing.status, 404, 'nieistniejąca relacja = 404, jak poza zakresem');
    assert.equal(await relation(db, 's-2', 'g-1'), false);

    const own = await patch('g-2', 's-1', { contactAllowed: false, reason: REASON }, cookies.boardA);
    assert.equal(own.status, 200);
    assert.equal(own.body.changed, true);

    // Relacja zakończona nie jest aktywna: zakres klasowy dostaje 404, zarząd szeroki 409.
    await db.query("UPDATE student_guardians SET ends_on = '2026-09-02' WHERE student_id = 's-1' AND guardian_id = 'g-2'");
    assert.equal((await patch('g-2', 's-1', { contactAllowed: true, reason: REASON }, cookies.boardA)).status, 404);
    const ended = await patch('g-2', 's-1', { contactAllowed: true, reason: REASON }, cookies.board);
    assert.equal(ended.status, 409);
    assert.deepEqual(ended.body, { error: 'relation_ended' });
  });

  test('granice ról: przedstawiciel, skarbnik i Komisja Rewizyjna nie zmieniają zgody (403); bez sesji 401', async () => {
    const { db, patch, cookies } = await setup();
    for (const cookie of [cookies.repA, cookies.treasurer, cookies.audit]) {
      const res = await patch('g-1', 's-1', { contactAllowed: false, reason: REASON }, cookie);
      assert.equal(res.status, 403);
    }
    assert.equal((await patch('g-1', 's-1', { contactAllowed: false, reason: REASON })).status, 401);
    assert.equal(await relation(db, 's-1', 'g-1'), true);
  });

  test('walidacja: brak powodu, zła wartość, obcy Origin', async () => {
    const { db, patch, cookies } = await setup();
    assert.equal((await patch('g-1', 's-1', { contactAllowed: false }, cookies.board)).body.error, 'invalid_reason');
    assert.equal((await patch('g-1', 's-1', { contactAllowed: 'no', reason: REASON }, cookies.board)).body.error, 'invalid_request');
    const foreign = await handlePgRequest(request('/api/guardians/g-1/students/s-1', {
      method: 'PATCH', cookie: cookies.board, origin: 'https://evil.invalid', body: { contactAllowed: false, reason: REASON },
    }), { db });
    assert.equal(foreign.status, 403);
    assert.equal(await relation(db, 's-1', 'g-1'), true);
  });

  test('audyt bez danych osobowych', async () => {
    const { db } = await setup();
    const { rows } = await db.query(
      "SELECT actor_id, entity_type, entity_id, metadata_json::text AS metadata FROM audit_events WHERE action = 'student_guardian.contact.updated'",
    );
    assert.ok(rows.length >= 5);
    for (const row of rows) {
      assert.equal(row.entity_type, 'student_guardian');
      assert.match(row.entity_id, /^s-\d:g-\d$/);
      assert.ok(row.actor_id);
      assert.ok(!/@|Anna|Piotr|Ewa|Testow|Inn[ya]|Ola|Jan|Kuba|zebraniu/.test(row.metadata), row.metadata);
    }
  });

  test('strażnik: DELETE, kaskada, zmiana tożsamości i ponowne zakończenie są odrzucane; historia tylko do dopisywania', async () => {
    const { db } = await setup();
    await assertOwnerGuard(db, "DELETE FROM student_guardians WHERE student_id = 's-3'", /student_guardians_cannot_be_deleted/);
    await assertOwnerGuard(db, "DELETE FROM students WHERE id = 's-3'", /foreign key|student_guardians/);
    await assertOwnerGuard(db, "DELETE FROM guardians WHERE id = 'g-3'", /foreign key|student_guardians/);
    await assert.rejects(db.query("UPDATE student_guardians SET guardian_id = 'g-1' WHERE student_id = 's-3'"), /student_guardian_identity_immutable/);
    await assert.rejects(db.query("UPDATE student_guardians SET created_at = now() - interval '1 day' WHERE student_id = 's-3'"), /identity_immutable/);
    await assert.rejects(db.query("UPDATE student_guardians SET ends_on = '2026-12-31' WHERE student_id = 's-1' AND guardian_id = 'g-2'"), /student_guardian_already_ended/);
    assert.equal(await count(db, 'SELECT count(*) AS n FROM student_guardians'), 4);

    // Bezpośredni SQL też zostawia ślad (source = 'direct', bez aktora); brak różnicy = brak wpisu.
    const before = (await history(db)).length;
    await db.query("UPDATE student_guardians SET is_primary_contact = true WHERE student_id = 's-3'");
    await db.query("UPDATE student_guardians SET is_primary_contact = true WHERE student_id = 's-3'");
    const rows = await history(db);
    assert.equal(rows.length, before + 1);
    assert.equal(rows.at(-1).source, 'direct');
    assert.equal(rows.at(-1).changed_by, null);

    await assert.rejects(db.query('UPDATE student_guardian_changes SET reason = NULL'), /family_history_is_append_only/);
    await assertOwnerGuard(db, 'DELETE FROM student_guardian_changes', /family_history_is_append_only/);
  });
});

test('migracja 0026 nie zmienia istniejących relacji; odtworzenie przez INSERT działa', async () => {
  const db = new PGlite();
  try {
    const migrations = await loadMigrations(fileURLToPath(new URL('../postgres/migrations/', import.meta.url)));
    const index = migrations.findIndex((migration) => migration.name.startsWith('0026_'));
    assert.ok(index > 0);
    for (const migration of migrations.slice(0, index)) await db.exec(migration.sql);
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-old');
      INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ('g-old', 'h-old', 'A', 'B');
      INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-old', 'h-old', 'C', 'D');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact, starts_on, ends_on)
        VALUES ('s-old', 'g-old', true, true, '2025-09-01', '2026-06-30');
    `);
    const select = "SELECT student_id, guardian_id, contact_allowed, is_primary_contact, starts_on::text, ends_on::text, created_at FROM student_guardians";
    const before = (await db.query(select)).rows;
    for (const migration of migrations.slice(index)) await db.exec(migration.sql);
    assert.deepEqual((await db.query(select)).rows, before);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM student_guardian_changes')).rows[0].n), 0);
    const fks = (await db.query(
      `SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = 'student_guardians'::regclass AND contype = 'f' ORDER BY conname`,
    )).rows;
    assert.deepEqual(fks.map((row) => row.confdeltype), ['a', 'a'], 'NO ACTION zamiast CASCADE');
    // Odtworzenie (same INSERT-y, jak snapshot D1 i eksport) przechodzi.
    await db.exec(`INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-new', 'h-old', 'E', 'F');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ('s-new', 'g-old', true);`);
  } finally {
    await db.close();
  }
});
