// Wniosek rodzica o aktualizację kontaktu przez jednorazowy link (#140).
// Wyłącznie dane syntetyczne (domeny .invalid).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { emailHash } from '../src/email/content.js';

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
    // #184: zużycie linku (used_at) ma ślad — zdarzenie wniosku niesie id linku.
    const created = await db.query("SELECT metadata_json FROM audit_events WHERE action = 'guardian_update_request.created'");
    assert.equal(created.rows.length, 1);
    assert.equal(created.rows[0].metadata_json.linkId, link.linkId);
    // Zatwierdzenie jeszcze nie nastąpiło — e-mail opiekuna bez zmian.
    const guardian = await db.query('SELECT email FROM guardians WHERE id = $1', ['g-3']);
    assert.equal(guardian.rows[0].email, 'stary@example.invalid');
    await db.close();
  });

  test('wygasły link (wstrzykiwany zegar env.now): ważny do końca terminu, potem 404 tak samo jak zły token', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    await seedGuardian(db, { id: 'g-4', householdId: 'h-4', studentId: 's-4', classId: 'c-1a' });
    const admin = await seedUserSession(db, { userId: 'u-admin4', roles: [{ role: 'admin' }], mfa: true });
    // Zegar żądania zamiast przestawiania niezmiennego expires_at z wyłączonym
    // strażnikiem (follow-up #214) — prawdziwy trigger guardian_update_link_guard
    // pozostaje włączony przez cały test.
    let now = new Date();
    const env = { db, now: () => now };
    const issuedAt = now;
    const { data: link } = await call(env, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'g-4' } });
    assert.equal(Date.parse(link.expiresAt) - issuedAt.getTime(), 14 * 24 * 60 * 60 * 1000, 'domyślna ważność 14 dni');
    await assert.rejects(
      db.query("UPDATE guardian_update_links SET expires_at = now() - interval '1 minute' WHERE id = $1", [link.linkId]),
      /guardian_update_link_immutable_fields/,
      'termin linku jest niezmienny — test nie może go przestawić',
    );

    now = new Date(Date.parse(link.expiresAt) - 60_000);
    assert.equal((await call(env, `/api/public/guardian-update?token=${link.token}`)).status, 200, 'minutę przed terminem link działa');

    now = new Date(Date.parse(link.expiresAt));
    const atExpiry = await call(env, `/api/public/guardian-update?token=${link.token}`);
    assert.deepEqual(atExpiry, { status: 404, data: { error: 'invalid_or_expired_link' } }, 'w chwili terminu link już nie działa');

    now = new Date(Date.parse(link.expiresAt) + 24 * 60 * 60 * 1000);
    const result = await call(env, '/api/public/guardian-update', { body: { token: link.token, contactAllowed: false } });
    assert.deepEqual(result, { status: 404, data: { error: 'invalid_or_expired_link' } });
    const { rows } = await db.query('SELECT used_at FROM guardian_update_links WHERE id = $1', [link.linkId]);
    assert.equal(rows[0].used_at, null, 'wygasły link nie zostaje oznaczony jako zużyty');
    const count = await db.query('SELECT count(*) AS n FROM guardian_update_requests WHERE guardian_id = $1', ['g-4']);
    assert.equal(Number(count.rows[0].n), 0, 'wygasły link nie tworzy wniosku');
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

  test('rodzeństwo w dwóch klasach: jeden opiekun, jeden link, jeden wniosek; zmiana dotyczy opiekuna (obojga dzieci)', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-7');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
        VALUES ('g-7', 'h-7', 'Ewa', 'Testowa', 'ewa.stary@example.invalid', true);
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-7a', 'h-7', 'Zosia', 'Testowa'), ('s-7b', 'h-7', 'Tomek', 'Testowy');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-7a', 'g-7', true, true), ('s-7b', 'g-7', true, true);
    `);
    await seedClass(db, { id: 'c-2a', schoolYearId: Y, name: 'Klasa 2A' });
    await seedClass(db, { id: 'c-5b', schoolYearId: Y, name: 'Klasa 5B' });
    await db.query(`INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-s7a', 's-7a', 'c-2a', $1), ('e-s7b', 's-7b', 'c-5b', $1)`, [Y]);
    const env = { db };
    const admin = await seedUserSession(db, { userId: 'u-admin7', roles: [{ role: 'admin' }], mfa: true });

    const { data: link } = await call(env, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'g-7' } });
    const preview = await call(env, `/api/public/guardian-update?token=${link.token}`);
    assert.deepEqual(preview, { status: 200, data: { guardianFirstName: 'Ewa', classNames: ['Klasa 2A', 'Klasa 5B'] } },
      'podgląd: imię opiekuna i obie klasy, bez nazwisk i imion dzieci');

    const submitted = await call(env, '/api/public/guardian-update', { body: { token: link.token, email: 'ewa.nowy@example.invalid' } });
    assert.equal(submitted.status, 201);
    const queue = await call(env, '/api/admin/guardian-update-requests', { cookie: admin });
    assert.equal(queue.data.requests.length, 1, 'jeden wniosek na opiekuna, nie na każde dziecko');
    assert.deepEqual(queue.data.requests[0].classNames, ['Klasa 2A', 'Klasa 5B']);

    const approved = await call(env, `/api/admin/guardian-update-requests/${submitted.data.requestId}/approve`, { cookie: admin, body: {} });
    assert.equal(approved.data.changed, true);
    const guardian = await db.query('SELECT email FROM guardians WHERE id = $1', ['g-7']);
    assert.equal(guardian.rows[0].email, 'ewa.nowy@example.invalid');
    const { rows: history } = await db.query(
      'SELECT count(*) AS n FROM guardian_contact_changes WHERE guardian_id = $1 AND reason = $2',
      ['g-7', `parent_request:${submitted.data.requestId}`],
    );
    assert.equal(Number(history[0].n), 1, 'jedna zmiana w historii opiekuna, nie po jednej na dziecko');
    await db.close();
  });

  test('lista wyłączeń (#94): kolejka ostrzega zatwierdzającego o zablokowanym adresie, bez ujawniania skrótu', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    await seedGuardian(db, { id: 'g-8', householdId: 'h-8', studentId: 's-8', classId: 'c-1a' });
    await seedGuardian(db, { id: 'g-9', householdId: 'h-9', studentId: 's-9', firstName: 'Marek' });
    const board = await seedUserSession(db, { userId: 'u-board8', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
    const blocked = 'odbity@example.invalid';
    await db.query("INSERT INTO email_suppressions (id, email_hash, reason) VALUES ('sup-8', $1, 'hard_bounce')", [emailHash(blocked)]);

    const { data: link8 } = await call(env, '/api/admin/guardian-links', { cookie: board, body: { guardianId: 'g-8' } });
    const { data: link9 } = await call(env, '/api/admin/guardian-links', { cookie: board, body: { guardianId: 'g-9' } });
    // Wielkie litery i spacje: wniosek normalizuje adres, ostrzeżenie i tak działa.
    assert.equal((await call(env, '/api/public/guardian-update', { body: { token: link8.token, email: '  Odbity@Example.invalid ' } })).status, 201);
    assert.equal((await call(env, '/api/public/guardian-update', { body: { token: link9.token, email: 'czysty@example.invalid' } })).status, 201);

    const queue = await call(env, '/api/admin/guardian-update-requests', { cookie: board });
    const byName = Object.fromEntries(queue.data.requests.map((r) => [r.guardianFirstName, r]));
    assert.equal(byName.Anna.proposedEmail, blocked);
    assert.equal(byName.Anna.proposedEmailSuppression, 'hard_bounce');
    assert.equal(byName.Marek.proposedEmailSuppression, null);
    assert.equal(JSON.stringify(queue.data).includes(emailHash(blocked)), false, 'skrót adresu nie trafia do odpowiedzi');

    // Zatwierdzenie zapisuje adres, ale NIE zdejmuje blokady (osobna procedura dwóch osób).
    await call(env, `/api/admin/guardian-update-requests/${byName.Anna.id}/approve`, { cookie: board, body: {} });
    const { rows } = await db.query('SELECT reason FROM email_active_suppressions WHERE email_hash = $1', [emailHash(blocked)]);
    assert.deepEqual(rows.map((r) => r.reason), ['hard_bounce']);
    await db.close();
  });

  test('błędny e-mail: adres odrzucany przez kolejkę wysyłek → 400 invalid_email, link pozostaje nieużyty', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    await seedGuardian(db, { id: 'g-10', householdId: 'h-10', studentId: 's-10', classId: 'c-1a' });
    const admin = await seedUserSession(db, { userId: 'u-admin10', roles: [{ role: 'admin' }], mfa: true });
    const { data: link } = await call(env, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'g-10' } });

    for (const email of ['jan..kowal@example.invalid', 'a,b@example.invalid', 'x@-zla.invalid', 42]) {
      const result = await call(env, '/api/public/guardian-update', { body: { token: link.token, email } });
      assert.deepEqual(result, { status: 400, data: { error: 'invalid_email' } }, `odrzucony: ${email}`);
    }
    const { rows } = await db.query('SELECT used_at FROM guardian_update_links WHERE id = $1', [link.linkId]);
    assert.equal(rows[0].used_at, null, 'literówka nie zużywa linku');
    const fixed = await call(env, '/api/public/guardian-update', { body: { token: link.token, email: 'jan.kowal@example.invalid' } });
    assert.equal(fixed.status, 201, 'poprawiony adres przechodzi tym samym linkiem');
    await db.close();
  });

  test('ponowienie po przerwaniu połączenia: zerwanie przed zapisem nie zużywa linku; po zapisie ponowienie → 409, jeden wniosek', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    await seedGuardian(db, { id: 'g-11', householdId: 'h-11', studentId: 's-11', classId: 'c-1a' });
    const admin = await seedUserSession(db, { userId: 'u-admin11', roles: [{ role: 'admin' }], mfa: true });
    const { data: link } = await call({ db }, '/api/admin/guardian-links', { cookie: admin, body: { guardianId: 'g-11' } });

    // Baza zrywa połączenie w chwili zapisu wniosku (po oznaczeniu linku jako
    // zużytego w tej samej transakcji) — transakcja musi się wycofać w całości.
    let dropOnce = true;
    const flakyDb = {
      query: (sql, params) => db.query(sql, params),
      transaction: (fn) => db.transaction((tx) => fn({
        query: async (sql, params) => {
          if (dropOnce && /INSERT INTO guardian_update_requests/.test(sql)) {
            dropOnce = false;
            throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
          }
          return tx.query(sql, params);
        },
      })),
    };
    const body = { token: link.token, email: 'nowy11@example.invalid' };
    let interrupted;
    try {
      interrupted = await call({ db: flakyDb }, '/api/public/guardian-update', { body });
    } catch (error) {
      interrupted = { status: 'thrown', error };
    }
    assert.equal(dropOnce, false, 'awaria została wstrzyknięta');
    assert.notEqual(interrupted.status, 201, 'przerwany zapis nie jest potwierdzony');
    const afterDrop = await db.query('SELECT used_at FROM guardian_update_links WHERE id = $1', [link.linkId]);
    assert.equal(afterDrop.rows[0].used_at, null, 'wycofana transakcja nie zużywa linku');

    // Rodzic klika „Wyślij” ponownie — zapis przechodzi.
    const retried = await call({ db }, '/api/public/guardian-update', { body });
    assert.equal(retried.status, 201);
    // Odpowiedź zginęła po zapisie i przeglądarka ponawia — 409, bez drugiego wniosku.
    const lostResponse = await call({ db }, '/api/public/guardian-update', { body });
    assert.deepEqual(lostResponse, { status: 409, data: { error: 'link_used' } });
    const { rows } = await db.query('SELECT count(*) AS n FROM guardian_update_requests WHERE guardian_id = $1', ['g-11']);
    assert.equal(Number(rows[0].n), 1);
    await db.close();
  });
});
