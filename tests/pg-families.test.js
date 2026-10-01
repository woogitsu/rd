// Katalog rodzin na PostgreSQL (issue #5): zakres klas, wiele gospodarstw,
// historia kontaktu i klasy. Wyłącznie dane syntetyczne (.invalid).
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { handlePgRequest } from '../src/pg/app.js';
import { buildClassRoster } from '../src/pg/export.js';
import { computeSnapshot } from '../src/pg/routes/email.js';
import { DEFAULT_CATEGORY } from '../src/email/content.js';
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

// #214: osobna baza PGlite na KAŻDY test — testy nie dzielą stanu, więc ich
// kolejność (także losowa, --test-shuffle) ani dopisanie nowego testu nie zmienia
// wyników. Baza jest zamykana w `t.after`, więc naraz żyje jedna instancja
// (każda zajmuje kilkaset MB).
async function setup(t) {
  const db = await createTestDb();
  t.after(() => db.close());
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
  return { db, call, cookies };
}

describe('katalog rodzin (osobna baza na test)', () => {
  test('przedstawiciel klasy A widzi tylko klasę A, także przy zgadywaniu identyfikatorów', async (t) => {
    const { db, call, cookies } = await setup(t);
    const classes = await call('/api/classes', { cookie: cookies.repA });
    assert.equal(classes.status, 200);
    assert.deepEqual(classes.body.classes.map((c) => c.id), ['c-1a']);
    assert.equal(classes.body.classes[0].studentCount, 1);

    const own = await call('/api/classes/c-1a/students', { cookie: cookies.repA });
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.students.map((s) => s.id), ['s-1']);
    // #95: tylko gospodarstwa kontaktowe (opiekun z obiema zgodami), bez
    // oznaczenia głównego. h-2 (g-2 bez zgody) nie jest ujawniane.
    assert.deepEqual(own.body.students[0].households, [{ householdId: 'h-1' }]);
    assert.equal(JSON.stringify(own.body).includes('h-2'), false);

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

    assert.equal('isPrimaryHousehold' in household.body.students[0], false);
    assert.deepEqual(household.body.students[0].otherHouseholds, []);

    // Drugie gospodarstwo dziecka (opieka dzielona) bez opiekuna ze zgodą na
    // kontakt: przedstawiciel dostaje 404 jak dla nieistniejącego (#95, D-08).
    assert.deepEqual(await call('/api/households/h-2', { cookie: cookies.repA }), other);

    // Filtr roku nie poszerza zakresu.
    const year = await call(`/api/classes?schoolYearId=${Y1}`, { cookie: cookies.repA });
    assert.deepEqual(year.body.classes.map((c) => c.id), ['c-1a']);
    assert.equal((await call('/api/classes?schoolYearId=bad%20id', { cookie: cookies.repA })).status, 400);
  });

  test('zarząd widzi wszystkie klasy i rodzeństwo; audyt i dyrekcja nie mają dostępu (D-09)', async (t) => {
    const { db, call, cookies } = await setup(t);
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
    // #535: identyfikatory zapisów potrzebne trasom „zakończ …” (same identyfikatory, bez danych osobowych).
    const ids = (sql) => db.query(sql).then((r) => r.rows.map((row) => row.id).sort());
    assert.deepEqual(household.body.students.map((s) => s.membershipId).sort(),
      await ids(`SELECT id FROM student_households WHERE household_id = 'h-1' AND ends_on IS NULL`));
    assert.deepEqual(household.body.students.flatMap((s) => s.classes.map((c) => c.enrollmentId)).sort(),
      await ids(`SELECT id FROM enrollments WHERE student_id IN ('s-1','s-2') AND ended_on IS NULL AND class_id IN ('c-1a','c-2b')`));
    assert.deepEqual(household.body.guardians.map((g) => g.membershipId).sort(),
      await ids(`SELECT id FROM guardian_households WHERE household_id = 'h-1' AND ends_on IS NULL`));
    // Brak danych o wpłatach bez MFA: sesja zarządu bez MFA nie przechodzi już bramki
    // MFA routera (sprawdzane niżej dla skarbnika); przedstawiciel nie widzi ich nigdy.

    // Skarbnik roku Y1 widzi klasy tylko tego roku.
    const treasurerClasses = await call('/api/classes', { cookie: cookies.treasurer });
    assert.deepEqual(treasurerClasses.body.classes.map((c) => c.id), ['c-1a', 'c-2b']);
  });

  test('lista klas do wyboru w panelach (#128): filtr roku nie poszerza zakresu roli', async (t) => {
    const { call, cookies } = await setup(t);
    // Przedstawiciel 1A: rok bez jego przydziału → pusta lista, nie klasy innych.
    assert.deepEqual((await call(`/api/classes?schoolYearId=${Y2}`, { cookie: cookies.repA })).body.classes, []);
    // Skarbnik roku Y1 pytający o Y2: pusta lista (bez ujawniania istnienia klas).
    assert.deepEqual((await call(`/api/classes?schoolYearId=${Y2}`, { cookie: cookies.treasurer })).body.classes, []);
    // Zarząd bez zawężenia widzi klasy wskazanego roku, z etykietą roku do listy wyboru.
    const board = await call(`/api/classes?schoolYearId=${Y2}`, { cookie: cookies.board });
    assert.deepEqual(board.body.classes.map((c) => [c.id, c.name, c.schoolYearId]), [['c-2a-27', '2A', Y2]]);
    // Odpowiedź wyboru nie zawiera danych rodzin (e-maili, opiekunów).
    assert.equal(/@|guardian|email/i.test(JSON.stringify(board.body)), false);
    // Nieprawidłowy identyfikator roku: 400.
    assert.equal((await call('/api/classes?schoolYearId=a%25b', { cookie: cookies.board })).status, 400);
  });

  test('sumy wpłat netto tylko dla ról finansowych z MFA, bez pól zadłużenia', async (t) => {
    const { db, call, cookies } = await setup(t);
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

  test('zmiana kontaktu opiekuna: tylko zarząd/admin, historia i audyt bez danych osobowych', async (t) => {
    const { db, call, cookies } = await setup(t);
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

    // Zgoda globalna włączona, zgoda relacji s-1/g-2 nadal wyłączona:
    // przedstawiciel dalej nie widzi gospodarstwa ani e-maila (#95); zarząd widzi.
    assert.equal((await call('/api/households/h-2', { cookie: cookies.repA })).status, 404);
    assert.equal(JSON.stringify((await call('/api/classes/c-1a/students', { cookie: cookies.repA })).body).includes('h-2'), false);
    const boardCard = await call('/api/households/h-2', { cookie: cookies.board });
    assert.equal(boardCard.body.guardians[0].email, 'nowy.opiekun2@example.invalid');
    // Po włączeniu zgody relacji przedstawiciel widzi gospodarstwo i e-mail.
    await db.query(`UPDATE student_guardians SET contact_allowed = true WHERE student_id = 's-1' AND guardian_id = 'g-2'`);
    const card = await call('/api/households/h-2', { cookie: cookies.repA });
    assert.equal(card.status, 200);
    assert.equal(card.body.guardians[0].email, 'nowy.opiekun2@example.invalid');
    assert.deepEqual(card.body.students[0].otherHouseholds, [{ householdId: 'h-1' }]);
    await db.query(`UPDATE student_guardians SET contact_allowed = false WHERE student_id = 's-1' AND guardian_id = 'g-2'`);

    // Zarząd ograniczony do klasy nie zmieni opiekuna spoza niej (404, nie 403).
    const boardA = await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', classId: 'c-1a', schoolYearId: Y1 }], mfa: true });
    assert.equal((await call('/api/guardians/g-3/contact', { method: 'PATCH', cookie: boardA, body })).status, 404);
  });

  // #211: dwie osoby z zarządu edytują ten sam kontakt jednocześnie, obie
  // z nieaktualnego widoku (przeczytały kontakt przed jakąkolwiek zmianą).
  // `PATCH .../contact` nie ma klucza wersji ani idempotencji per-treść
  // (families.js:305-335) — SELECT ... FOR UPDATE OF g serializuje zapisy,
  // więc druga transakcja czeka i widzi już zatwierdzoną zmianę pierwszej, ale
  // mimo to nadpisuje ją swoją wartością, bez ostrzeżenia. Założenie (docs/
  // FAMILIES.md nie istnieje, brak decyzji zarządu): „ostatni zapis wygrywa”,
  // obie zmiany zostają w historii — nic nie ginie bezpowrotnie, tylko
  // bieżąca wartość gospodarstwa. Test dokumentuje dzisiejsze zachowanie.
  test('zmiana kontaktu: dwie osoby edytują ten sam kontakt jednocześnie — ostatni zapis wygrywa, obie zmiany w historii (#211, brak decyzji zarządu)', async (t) => {
    const { db, call, cookies } = await setup(t);
    const path = '/api/guardians/g-2/contact';
    // Druga osoba z zarządu (inne konto, ten sam poziom uprawnień) edytuje
    // ten sam kontakt równolegle — nie ma potrzeby konta z rolą 'admin'.
    const boardB = await seedUserSession(db, { userId: 'u-board-2', roles: [{ role: 'board' }], mfa: true });
    const before = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'guardian.contact.updated' AND entity_id = 'g-2'");
    const [a, b] = await Promise.all([
      call(path, { method: 'PATCH', cookie: cookies.board, body: { email: 'wersja-a@example.invalid', reason: 'Zapis A' } }),
      call(path, { method: 'PATCH', cookie: boardB, body: { email: 'wersja-b@example.invalid', reason: 'Zapis B' } }),
    ]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(a.body.changed, true);
    assert.equal(b.body.changed, true, 'druga transakcja czeka na blokadę i nadal widzi zmianę do wprowadzenia');
    const { rows: [current] } = await db.query('SELECT email FROM guardians WHERE id = $1', ['g-2']);
    // Ostatni zatwierdzony zapis wygrywa — który to jest, zależy od kolejności
    // transakcji na serwerze, nie od kolejności wysłania żądań przez klienta.
    assert.ok(
      current.email === a.body.guardian.email || current.email === b.body.guardian.email,
      'bieżąca wartość to jedna z dwóch wersji, nigdy mieszanka ani coś innego',
    );

    // Zakres po wartości e-maila: dokładnie dwie zmiany z tego testu.
    const history = await db.query(
      "SELECT new_email, changed_by, reason FROM guardian_contact_changes WHERE guardian_id = 'g-2' AND new_email IN ('wersja-a@example.invalid', 'wersja-b@example.invalid') ORDER BY changed_at",
    );
    assert.equal(history.rows.length, 2, 'obie zmiany zostają w historii — nic nie ginie bezpowrotnie');
    assert.deepEqual(history.rows.map((r) => r.new_email).sort(), ['wersja-a@example.invalid', 'wersja-b@example.invalid']);
    const after = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'guardian.contact.updated' AND entity_id = 'g-2'");
    assert.equal(after.rows[0].n - before.rows[0].n, 2, 'dwa nowe zdarzenia audytu, jedno na zapis');
  });

  test('zmiana klasy w roku zachowuje historię; nowy rok to nowe przypisanie', async (t) => {
    const { db, call, cookies } = await setup(t);
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

  test('model gospodarstw: jedno główne na okres, brak usuwania, synchronizacja kolumny zgodności', async (t) => {
    const { db } = await setup(t);
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

// #95: rodzina patchworkowa — rodzeństwo w klasach 1A i 3C w jednym
// gospodarstwie, opiekunowie w różnych gospodarstwach, zgody relacji.
describe('karta gospodarstwa: zakres klasowy i zgody relacji (#95)', () => {
  let db;
  after(async () => { await db?.close(); });

  test('przedstawiciel widzi tylko opiekunów i gospodarstwa wynikające z uczniów klasy; zarząd bez zmian', async () => {
    db = await createTestDb();
    await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
    await seedClass(db, { id: 'c-1a', schoolYearId: Y1, name: '1A' });
    await seedClass(db, { id: 'c-3c', schoolYearId: Y1, name: '3C' });
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-p'), ('h-q'), ('h-r');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-a', 'h-p', 'Alina', 'Wspolna', 'ga@example.invalid', true),
        ('g-c', 'h-p', 'Cezary', 'Przyrodni', 'gc@example.invalid', true),
        ('g-x', 'h-p', 'Xenia', 'Mieszana', 'gx@example.invalid', true),
        ('g-e', 'h-p', 'Edward', 'Dawny', 'ge@example.invalid', true),
        ('g-q', 'h-q', 'Quentin', 'Drugi', 'gq@example.invalid', true),
        ('g-r', 'h-r', 'Renata', 'Trzecia', 'gr@example.invalid', true);
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-a', 'h-p', 'Ada', 'Wspolna'), ('s-c', 'h-p', 'Cyryl', 'Przyrodni');
      INSERT INTO student_households (id, student_id, household_id, is_primary, source) VALUES
        ('sh-a-q', 's-a', 'h-q', false, 'api'), ('sh-a-r', 's-a', 'h-r', false, 'api');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact, ends_on) VALUES
        ('s-a', 'g-a', true, true, NULL),
        ('s-c', 'g-c', true, true, NULL),
        ('s-a', 'g-x', false, false, NULL), ('s-c', 'g-x', true, false, NULL),
        ('s-a', 'g-e', true, false, '2020-01-01'),
        ('s-a', 'g-q', false, false, NULL),
        ('s-a', 'g-r', true, false, NULL);
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
        ('e-a', 's-a', 'c-1a', '${Y1}'), ('e-c', 's-c', 'c-3c', '${Y1}');
    `);
    const env = { db };
    const call = async (path, cookie) => {
      const response = await handlePgRequest(request(path, { cookie }), env);
      return { status: response.status, body: await response.json() };
    };
    const rep1a = await seedUserSession(db, { userId: 'u-rep-1a', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: Y1 }] });
    const rep3c = await seedUserSession(db, { userId: 'u-rep-3c', roles: [{ role: 'representative', classId: 'c-3c', schoolYearId: Y1 }] });
    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
    const guardianView = (body) => body.guardians.map((g) => [g.id, g.contactAllowed, g.email]);

    // Lista klasy 1A: tylko gospodarstwa kontaktowe (h-q: opiekun bez zgody relacji).
    const list = await call('/api/classes/c-1a/students', rep1a);
    assert.deepEqual(list.body.students.map((s) => [s.id, s.households]), [['s-a', [{ householdId: 'h-p' }, { householdId: 'h-r' }]]]);
    assert.equal(JSON.stringify(list.body).includes('h-q'), false);

    // Karta h-p dla 1A: bez opiekuna rodzeństwa z 3C (g-c) i relacji zakończonej (g-e);
    // g-x ma zgodę globalną i zgodę dla dziecka z 3C, ale nie dla dziecka z 1A.
    const card = await call('/api/households/h-p', rep1a);
    assert.equal(card.status, 200);
    assert.deepEqual(card.body.students.map((s) => [s.id, s.otherHouseholds]), [['s-a', [{ householdId: 'h-r' }]]]);
    assert.equal('isPrimaryHousehold' in card.body.students[0], false);
    assert.deepEqual(guardianView(card.body), [['g-x', false, null], ['g-a', true, 'ga@example.invalid']]);
    assert.deepEqual(card.body.guardians.map((g) => g.relations.map((r) => r.studentId)), [['s-a'], ['s-a']]);
    const serialized = JSON.stringify(card.body);
    for (const hidden of ['g-c', 'Cezary', 'gc@', 'g-e', 'Edward', 'gx@', 's-c', 'Cyryl', 'h-q']) {
      assert.equal(serialized.includes(hidden), false, hidden);
    }

    // Gospodarstwo bez opiekuna ze zgodą: 404 jak nieistniejące; h-r (drugi opiekun ze zgodą) widoczne.
    const missing = await call('/api/households/h-nope', rep1a);
    assert.deepEqual(await call('/api/households/h-q', rep1a), missing);
    const third = await call('/api/households/h-r', rep1a);
    assert.deepEqual(guardianView(third.body), [['g-r', true, 'gr@example.invalid']]);
    assert.deepEqual(third.body.students[0].otherHouseholds, [{ householdId: 'h-p' }]);

    // Przedstawiciel 3C widzi to samo gospodarstwo od strony swojego ucznia.
    const card3c = await call('/api/households/h-p', rep3c);
    assert.deepEqual(card3c.body.students.map((s) => s.id), ['s-c']);
    assert.deepEqual(guardianView(card3c.body), [['g-x', true, 'gx@example.invalid'], ['g-c', true, 'gc@example.invalid']]);
    assert.equal(JSON.stringify(card3c.body).includes('ga@'), false);

    // Zarząd: pełny obraz, bez zmian (wszyscy opiekunowie, e-mail zawsze, isPrimary).
    const full = await call('/api/households/h-p', board);
    assert.deepEqual(full.body.students.map((s) => [s.id, s.isPrimaryHousehold]), [['s-c', true], ['s-a', true]]);
    assert.deepEqual(full.body.students[1].otherHouseholds, [
      { householdId: 'h-q', isPrimary: false }, { householdId: 'h-r', isPrimary: false },
    ]);
    assert.deepEqual(guardianView(full.body), [
      ['g-e', true, 'ge@example.invalid'], ['g-x', true, 'gx@example.invalid'],
      ['g-c', true, 'gc@example.invalid'], ['g-a', true, 'ga@example.invalid'],
    ]);
    const boardList = await call('/api/classes/c-1a/students', board);
    assert.deepEqual(boardList.body.students[0].households, [
      { householdId: 'h-p', isPrimary: true }, { householdId: 'h-q', isPrimary: false }, { householdId: 'h-r', isPrimary: false },
    ]);
    assert.equal((await call('/api/households/h-q', board)).status, 200);

    // Porównanie z listą klasy (eksport): opiekunowie karty są w liście klasy
    // z tym samym e-mailem (ta sama reguła zgód).
    const { roster } = await buildClassRoster(db, 'c-1a');
    const rosterEmail = new Map();
    for (const student of roster.students) {
      for (const g of student.guardians) rosterEmail.set(g.id, rosterEmail.get(g.id) ?? g.email);
    }
    for (const body of [card.body, third.body]) {
      for (const g of body.guardians) {
        assert.ok(rosterEmail.has(g.id), g.id);
        assert.equal(g.email, rosterEmail.get(g.id), g.id);
      }
    }
  });
});

describe('zmiana kontaktu opiekuna: zakres klasowy przez relację z uczniem (#200)', () => {
  let db;
  after(async () => { await db?.close(); });

  test('zarząd z przydziałem 1A zmienia tylko opiekunów z aktywną relacją do ucznia 1A', async () => {
    db = await createTestDb();
    await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
    await seedClass(db, { id: 'c-1a', schoolYearId: Y1, name: '1A' });
    await seedClass(db, { id: 'c-1b', schoolYearId: Y1, name: '1B' });
    // h-1: rodzeństwo s-a (1A) i s-b (1B). h-2: drugie gospodarstwo s-a (opieka dzielona).
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1'), ('h-2');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-1', 'h-1', 'Alina', 'Pierwsza', 'g1@example.invalid', true),
        ('g-2', 'h-1', 'Bogdan', 'Drugi', 'g2@example.invalid', true),
        ('g-4', 'h-1', 'Dorota', 'Czwarta', 'g4@example.invalid', true),
        ('g-e', 'h-1', 'Edward', 'Dawny', 'ge@example.invalid', true),
        ('g-f', 'h-1', 'Felicja', 'Przyszla', 'gf@example.invalid', true),
        ('g-q', 'h-2', 'Quentin', 'Partner', 'gq@example.invalid', true);
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-a', 'h-1', 'Ada', 'Wspolna'), ('s-b', 'h-1', 'Bartek', 'Wspolny');
      INSERT INTO student_households (id, student_id, household_id, is_primary, source) VALUES
        ('sh-a-2', 's-a', 'h-2', false, 'api');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact, starts_on, ends_on) VALUES
        ('s-a', 'g-1', true, true, NULL, NULL),
        ('s-a', 'g-2', true, false, NULL, NULL), ('s-b', 'g-2', true, true, NULL, NULL),
        ('s-b', 'g-4', true, false, NULL, NULL),
        ('s-a', 'g-e', true, false, NULL, '2020-01-01'), ('s-b', 'g-e', true, false, NULL, NULL),
        ('s-a', 'g-f', true, false, '2999-01-01', NULL);
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
        ('e-a', 's-a', 'c-1a', '${Y1}'), ('e-b', 's-b', 'c-1b', '${Y1}');
    `);
    const env = { db };
    const call = async (path, cookie, body) => {
      const response = await handlePgRequest(request(path, { method: 'PATCH', cookie, body }), env);
      return { status: response.status, body: await response.json() };
    };
    const boardA = await seedUserSession(db, { userId: 'u-board-1a', roles: [{ role: 'board', classId: 'c-1a', schoolYearId: Y1 }], mfa: true });
    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });
    const body = { email: 'przejete@example.invalid', contactAllowed: false, reason: 'test zakresu' };
    const snapshot = async () => (await db.query('SELECT id, email, contact_allowed FROM guardians ORDER BY id')).rows;
    const counts = async () => ({
      history: Number((await db.query('SELECT count(*) AS n FROM guardian_contact_changes')).rows[0].n),
      audit: Number((await db.query(`SELECT count(*) AS n FROM audit_events WHERE action = 'guardian.contact.updated'`)).rows[0].n),
    });

    // Odmowa: 404 jak nieistniejący, bez zapisu w guardians, historii i audycie.
    const missing = await call('/api/guardians/g-nope/contact', boardA, body);
    assert.deepEqual(missing, { status: 404, body: { error: 'not_found' } });
    const before = await snapshot();
    // g-4: tylko dziecko z 1B we wspólnym gospodarstwie; g-q: nowy partner w drugim
    // gospodarstwie ucznia 1A bez relacji; g-e: relacja z 1A zakończona; g-f: relacja przyszła.
    for (const id of ['g-4', 'g-q', 'g-e', 'g-f']) {
      assert.deepEqual(await call(`/api/guardians/${id}/contact`, boardA, body), missing, id);
    }
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await counts(), { history: 0, audit: 0 });

    // Dwoje opiekunów ucznia 1A: g-1 tylko z 1A (200), g-2 ma też dziecko w 1B —
    // zmiana globalnego kontaktu wymaga zakresu obejmującego wszystkie relacje (#200).
    const first = await call('/api/guardians/g-1/contact', boardA, body);
    assert.deepEqual(first, { status: 200, body: { guardian: { id: 'g-1', email: 'przejete@example.invalid', contactAllowed: false }, changed: true } });
    // Podwójne kliknięcie: bez nowej zmiany.
    assert.equal((await call('/api/guardians/g-1/contact', boardA, body)).body.changed, false);
    // g-2 (1A + 1B): 403 dla e-maila, zgody i obu naraz; bez zapisu i bez wyroczni 404 vs 403 dla własnego opiekuna.
    const shared = { status: 403, body: { error: 'guardian_shared_outside_scope' } };
    const afterFirst = await snapshot();
    const countsAfterFirst = await counts();
    for (const payload of [body, { contactAllowed: false, reason: 'test zakresu' }, { email: 'inny@example.invalid', reason: 'test zakresu' }]) {
      assert.deepEqual(await call('/api/guardians/g-2/contact', boardA, payload), shared);
    }
    // Zmiana bez efektu też jest odmowa (jedna reguła, bez zależności od treści).
    assert.deepEqual(await call('/api/guardians/g-2/contact', boardA, { contactAllowed: true, reason: 'test zakresu' }), shared);
    assert.deepEqual(await snapshot(), afterFirst);
    assert.deepEqual(await counts(), countsAfterFirst);
    // Kampania czyta e-mail i zgodę z guardians — migawka odbiorców bez zmian.
    const g2 = (await snapshot()).find((row) => row.id === 'g-2');
    assert.deepEqual(g2, { id: 'g-2', email: 'g2@example.invalid', contact_allowed: true });

    const history = await db.query('SELECT guardian_id, changed_by, reason FROM guardian_contact_changes ORDER BY guardian_id');
    assert.deepEqual(history.rows, [
      { guardian_id: 'g-1', changed_by: 'u-board-1a', reason: 'test zakresu' },
    ]);
    const audit = await db.query(`SELECT actor_id, entity_id FROM audit_events WHERE action = 'guardian.contact.updated' ORDER BY entity_id`);
    assert.deepEqual(audit.rows, [{ actor_id: 'u-board-1a', entity_id: 'g-1' }]);

    // Zarząd bez przydziału klasy: bez zmian (także opiekun spoza 1A i partner bez relacji).
    for (const id of ['g-2', 'g-4', 'g-q']) {
      const full = await call(`/api/guardians/${id}/contact`, board, body);
      assert.equal(full.status, 200, id);
      assert.equal(full.body.changed, true, id);
    }
    const byBoard = await db.query(`SELECT changed_by FROM guardian_contact_changes WHERE guardian_id IN ('g-2', 'g-4', 'g-q')`);
    assert.deepEqual(byBoard.rows.map((r) => r.changed_by), ['u-board', 'u-board', 'u-board']);
  });
});

describe('kampania e-mail po odmowie zmiany kontaktu (#200)', () => {
  let db;
  after(async () => { await db?.close(); });

  // Migawka odbiorców (computeSnapshot) tylko czyta bazę — nic nie wysyła.
  const recipientsOf = async () => {
    const { recipients, hash } = await computeSnapshot(db, { school_year_id: Y1, audience: 'all_households', category: DEFAULT_CATEGORY });
    return { recipients, hash };
  };

  test('odrzucona zmiana kontaktu (403/404) nie zmienia listy odbiorców; zmiana przez pełny zarząd — zmienia', async () => {
    db = await createTestDb();
    await seedSchoolYear(db, Y1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
    await seedClass(db, { id: 'c-1a', schoolYearId: Y1, name: '1A' });
    await seedClass(db, { id: 'c-1b', schoolYearId: Y1, name: '1B' });
    // h-1: rodzeństwo s-a (1A), s-b (1B); g-2 (kontakt główny) ma relację z obojgiem,
    // g-4 tylko z s-b. h-2: rodzina wyłącznie z 1B (opiekun poza zakresem 1A).
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1'), ('h-2');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-2', 'h-1', 'Bogdan', 'Drugi', 'g2@example.invalid', true),
        ('g-4', 'h-1', 'Dorota', 'Czwarta', 'g4@example.invalid', true),
        ('g-5', 'h-2', 'Ewa', 'Piata', 'g5@example.invalid', true);
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-a', 'h-1', 'Ada', 'Wspolna'), ('s-b', 'h-1', 'Bartek', 'Wspolny'), ('s-c', 'h-2', 'Celina', 'Osobna');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-a', 'g-2', true, true), ('s-b', 'g-2', true, true), ('s-b', 'g-4', true, false), ('s-c', 'g-5', true, true);
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
        ('e-a', 's-a', 'c-1a', '${Y1}'), ('e-b', 's-b', 'c-1b', '${Y1}'), ('e-c', 's-c', 'c-1b', '${Y1}');
    `);
    const call = async (path, cookie, body) => {
      const response = await handlePgRequest(request(path, { method: 'PATCH', cookie, body }), { db });
      return { status: response.status, body: await response.json() };
    };
    const boardA = await seedUserSession(db, { userId: 'u-board-1a', roles: [{ role: 'board', classId: 'c-1a', schoolYearId: Y1 }], mfa: true });
    const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board' }], mfa: true });

    const before = await recipientsOf();
    assert.deepEqual(before.recipients.map((r) => [r.householdId, r.guardianId, r.email]), [
      ['h-1', 'g-2', 'g2@example.invalid'], ['h-2', 'g-5', 'g5@example.invalid'],
    ]);
    const auditBefore = Number((await db.query('SELECT count(*) AS n FROM audit_events')).rows[0].n);

    // g-2 (1A + 1B): 403; g-4 i g-5 (tylko 1B): 404. Zmiana e-maila i zgody, każda osobno i razem.
    const payloads = [
      { email: 'przejete@example.invalid', reason: 'test zakresu' },
      { contactAllowed: false, reason: 'test zakresu' },
      { email: 'przejete@example.invalid', contactAllowed: false, reason: 'test zakresu' },
    ];
    for (const payload of payloads) {
      assert.deepEqual(await call('/api/guardians/g-2/contact', boardA, payload),
        { status: 403, body: { error: 'guardian_shared_outside_scope' } });
      for (const id of ['g-4', 'g-5']) {
        assert.deepEqual(await call(`/api/guardians/${id}/contact`, boardA, payload), { status: 404, body: { error: 'not_found' } }, id);
      }
    }
    assert.deepEqual(await recipientsOf(), before);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM audit_events')).rows[0].n), auditBefore);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM guardian_contact_changes')).rows[0].n), 0);

    // Kontrola czułości: ta sama zmiana wykonana przez zarząd bez przydziału klasy zmienia migawkę.
    const changed = await call('/api/guardians/g-2/contact', board, { email: 'nowy@example.invalid', reason: 'test zakresu' });
    assert.equal(changed.status, 200);
    const after = await recipientsOf();
    assert.notEqual(after.hash, before.hash);
    assert.equal(after.recipients[0].email, 'nowy@example.invalid');
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
