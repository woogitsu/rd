// Wniosek rodzica o aktualizację kontaktu przez jednorazowy link (#140).
// Wyłącznie dane syntetyczne (domeny .invalid).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const Y = 'y-2026';

async function call(env, path, { cookie, method, body } = {}) {
  const response = await handlePgRequest(request(path, {
    cookie, method: method ?? (body ? 'POST' : 'GET'), body,
  }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function seedGuardian(db, { id, householdId, firstName = 'Anna', classId, schoolYearId = Y, studentId }) {
  await db.exec(`
    INSERT INTO households (id) VALUES ('${householdId}') ON CONFLICT (id) DO NOTHING;
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('${id}', '${householdId}', '${firstName}', 'Testowa', 'stary@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name)
      VALUES ('${studentId}', '${householdId}', 'Jan', 'Testowy');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact)
      VALUES ('${studentId}', '${id}', true, true);
  `);
  if (classId) {
    await seedClass(db, { id: classId, schoolYearId, name: classId });
    await db.query(
      `INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)`,
      [`e-${studentId}`, studentId, classId, schoolYearId],
    );
  }
}

describe('wniosek rodzica o aktualizację kontaktu (#140)', () => {
  test('wydanie linku: granice ról (przedstawiciel/audit → 403), gospodarstwo nieistniejące → 404', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    await seedGuardian(db, { id: 'g-1', householdId: 'h-1', studentId: 's-1', classId: 'c-1a' });
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }] });
    const audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }] });

    for (const cookie of [rep, audit]) {
      assert.equal((await call(env, '/api/admin/guardian-links', { cookie, body: { guardianId: 'g-1' } })).status, 403);
    }
    assert.equal((await call(env, '/api/admin/guardian-links', { body: { guardianId: 'g-1' } })).status, 401);
    assert.equal((await call(env, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'brak-takiej' } })).status, 404);

    const issued = await call(env, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'g-1' } });
    assert.equal(issued.status, 201);
    assert.match(issued.data.token, /^[0-9a-f]{64}$/);
    const { rows } = await db.query('SELECT token_hash FROM guardian_update_links WHERE id = $1', [issued.data.linkId]);
    assert.notEqual(rows[0].token_hash, issued.data.token, 'w bazie tylko skrót, nie surowy token');
    await db.close();
  });

  test('podgląd publiczny: zły token i nieistniejący opiekun dają ten sam komunikat (bez wyroczni istnienia)', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    await seedGuardian(db, { id: 'g-2', householdId: 'h-2', studentId: 's-2', classId: 'c-1b', firstName: 'Piotr' });
    const admin = await seedUserSession(db, { userId: 'u-admin2', roles: [{ role: 'admin' }], mfa: true });
    const issued = await call(env, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'g-2' } });
    const { token } = issued.data;

    const badToken = 'a'.repeat(64);
    const bad = await call(env, `/api/public/guardian-update?token=${badToken}`);
    assert.deepEqual(bad, { status: 404, data: { error: 'invalid_or_expired_link' } });

    const good = await call(env, `/api/public/guardian-update?token=${token}`);
    assert.equal(good.status, 200);
    assert.equal(good.data.guardianFirstName, 'Piotr');
    assert.deepEqual(good.data.classNames, ['c-1b']);
    await db.close();
  });

  test('formularz: podwójne wysłanie tym samym tokenem → 409 link_used, bez drugiego wniosku; zły e-mail → 400', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    await seedGuardian(db, { id: 'g-3', householdId: 'h-3', studentId: 's-3', classId: 'c-1a' });
    const admin = await seedUserSession(db, { userId: 'u-admin3', roles: [{ role: 'admin' }], mfa: true });
    const { data: link } = await call(env, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'g-3' } });

    const badEmail = await call(env, '/api/public/guardian-update', { body: { token: link.token, email: 'nie-email' } });
    assert.equal(badEmail.status, 400);

    const first = await call(env, '/api/public/guardian-update', {
      body: { token: link.token, email: 'nowy@example.invalid', note: 'Zmiana adresu po przeprowadzce' },
    });
    assert.equal(first.status, 201);
    assert.equal(first.data.status, 'pending');

    const second = await call(env, '/api/public/guardian-update', { body: { token: link.token, email: 'inny@example.invalid' } });
    assert.deepEqual(second, { status: 409, data: { error: 'link_used' } });

    const { rows } = await db.query('SELECT count(*) AS n FROM guardian_update_requests WHERE guardian_id = $1', ['g-3']);
    assert.equal(Number(rows[0].n), 1, 'drugie wysłanie nie tworzy drugiego wniosku');
    // Zatwierdzenie jeszcze nie nastąpiło — e-mail opiekuna bez zmian.
    const guardian = await db.query('SELECT email FROM guardians WHERE id = $1', ['g-3']);
    assert.equal(guardian.rows[0].email, 'stary@example.invalid');
    await db.close();
  });

  test('wygasły link: 404 tak samo jak zły token', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    await seedGuardian(db, { id: 'g-4', householdId: 'h-4', studentId: 's-4', classId: 'c-1a' });
    const admin = await seedUserSession(db, { userId: 'u-admin4', roles: [{ role: 'admin' }], mfa: true });
    const { data: link } = await call(env, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'g-4' } });
    // expires_at jest niezmienny po utworzeniu (trigger guardian_update_link_guard) —
    // symulacja wygaśnięcia wymaga ominięcia triggera, jak przy zamknięciu roku w innych testach.
    await db.exec(`
      SET session_replication_role = replica;
      UPDATE guardian_update_links
         SET created_at = now() - interval '20 days', expires_at = now() - interval '1 minute'
       WHERE id = '${link.linkId}';
      SET session_replication_role = origin;
    `);
    const result = await call(env, '/api/public/guardian-update', { body: { token: link.token, contactAllowed: false } });
    assert.deepEqual(result, { status: 404, data: { error: 'invalid_or_expired_link' } });
    await db.close();
  });

  test('kolejka i zatwierdzenie: przedstawiciel nie widzi kolejki (403); zatwierdzenie stosuje zmianę i jest idempotentne', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    await seedGuardian(db, { id: 'g-5', householdId: 'h-5', studentId: 's-5', classId: 'c-1a' });
    const admin = await seedUserSession(db, { userId: 'u-admin5', roles: [{ role: 'admin' }], mfa: true });
    const board = await seedUserSession(db, { userId: 'u-board5', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
    const rep = await seedUserSession(db, { userId: 'u-rep5', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y }] });

    const { data: link } = await call(env, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'g-5' } });
    await call(env, '/api/public/guardian-update', { body: { token: link.token, email: 'nowy5@example.invalid', contactAllowed: false } });

    assert.equal((await call(env, '/api/admin/guardian-update-requests', { cookie: rep })).status, 403);
    const queue = await call(env, '/api/admin/guardian-update-requests', { cookie: board });
    assert.equal(queue.status, 200);
    assert.equal(queue.data.requests.length, 1);
    assert.equal(queue.data.requests[0].guardianFirstName, 'Anna');
    const requestId = queue.data.requests[0].id;

    const approved = await call(env, `/api/admin/guardian-update-requests/${requestId}/approve`, { cookie: board, body: {} });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.status, 'approved');
    assert.equal(approved.data.changed, true);
    const guardian = await db.query('SELECT email, contact_allowed FROM guardians WHERE id = $1', ['g-5']);
    assert.equal(guardian.rows[0].email, 'nowy5@example.invalid');
    assert.equal(guardian.rows[0].contact_allowed, false);

    // Podwójne kliknięcie „Zatwierdź”: bez błędu, bez drugiego zdarzenia audytu.
    const again = await call(env, `/api/admin/guardian-update-requests/${requestId}/approve`, { cookie: board, body: {} });
    assert.deepEqual(again, { status: 200, data: { requestId, status: 'approved', changed: false } });
    const { rows: auditRows } = await db.query(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'guardian_update_request.approved' AND entity_id = $1", [requestId],
    );
    assert.equal(Number(auditRows[0].n), 1);

    const { rows: historyRows } = await db.query(
      "SELECT reason FROM guardian_contact_changes WHERE guardian_id = 'g-5' ORDER BY changed_at DESC LIMIT 1",
    );
    assert.equal(historyRows[0].reason, `parent_request:${requestId}`);
    await db.close();
  });

  test('odrzucenie: brak zmiany w guardians, zdarzenie rejected; dwoje opiekunów jednego dziecka — link A nie dotyka B', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    // Rodzeństwo/dwoje opiekunów: jeden uczeń, dwoje opiekunów w tym samym gospodarstwie.
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-6');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-6a', 'h-6', 'Ola', 'Testowa', 'olaA@example.invalid', true),
        ('g-6b', 'h-6', 'Bartek', 'Testowy', 'bartekB@example.invalid', true);
      INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-6', 'h-6', 'Kuba', 'Testowy');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-6', 'g-6a', true, true), ('s-6', 'g-6b', true, false);
    `);
    await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: 'c-1a' });
    await db.query(`INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-s6', 's-6', 'c-1a', $1)`, [Y]);

    const admin = await seedUserSession(db, { userId: 'u-admin6', roles: [{ role: 'admin' }], mfa: true });
    const { data: linkA } = await call(env, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'g-6a' } });
    const submitted = await call(env, '/api/public/guardian-update', { body: { token: linkA.token, email: 'zly@example.invalid' } });
    const requestId = submitted.data.requestId;

    const rejected = await call(env, `/api/admin/guardian-update-requests/${requestId}/reject`, { cookie: admin, body: {} });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.status, 'rejected');
    const guardianA = await db.query('SELECT email FROM guardians WHERE id = $1', ['g-6a']);
    assert.equal(guardianA.rows[0].email, 'olaA@example.invalid', 'odrzucony wniosek nie zmienia opiekuna');
    const guardianB = await db.query('SELECT email FROM guardians WHERE id = $1', ['g-6b']);
    assert.equal(guardianB.rows[0].email, 'bartekB@example.invalid', 'link opiekuna A nie dotyka opiekuna B');
    await db.close();
  });
});
