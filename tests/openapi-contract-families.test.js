// Kontrakt API (#160, etap 3): prawdziwe odpowiedzi modułów `families` i `session`
// (PGlite, dane syntetyczne @example.invalid) walidowane schematami z docs/openapi.json
// (src/pg/schemas/families.js, src/pg/schemas/session.js) przez tests/helpers/contract-client.js.
// Rejestr pokrycia i katalog kodów sprawdza tests/openapi-contract.test.js (wspólnie dla
// wszystkich pokrytych modułów).
//
// Rodziny: karta gospodarstwa z rodzeństwem w dwóch klasach i dwojgiem opiekunów (kryterium
// #160), opieka dzielona (dziecko w dwóch gospodarstwach), wąski kształt karty dla
// przedstawiciela klasy, ponowienie zapisu (`changed: false` — moduł nie używa Idempotency-Key),
// odmowy 401/403/404 i błędy 400/409/415/422. Listy modułu nie mają kursora (pełne listy).
// Sesja: logowanie hasłem, stan sesji przed i po MFA, przydziały, okno serwisowe,
// capabilities Komisji Rewizyjnej, wylogowanie (204) i odmowa obcego Origin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { base32Decode, totp } from '../src/pg/mfa.js';
import { hashPassword } from '../src/pg/password.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;

const YEAR = 'y-2026';
const NEXT = 'y-2027';
const REASON = 'Korekta ewidencji (syntetyczne)';
// Daty zakończeń w przeszłości (poza latami testu): wynik nie zależy od zegara.
const PAST = '2020-01-01';

function assertSuccessCoverage(client, moduleName) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (entry.module !== moduleName) continue;
    for (const status of Object.keys(entry.responses)) expected.push(`${routeId} ${status}`);
  }
  assert.ok(expected.length >= 3, `oczekiwane odpowiedzi: ${expected.length}`);
  assert.deepEqual(expected.filter((item) => !client.validated.has(item)), [],
    'odpowiedzi sukcesu opisane w schematach bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje błąd i w schemacie, i na serwerze (400).
async function assertRequiredFieldsEnforced(client, cookie, method, path, validBody, schemaName) {
  const { required } = components[schemaName];
  assert.ok(required.length > 0, `${schemaName}: schemat ma wymagane pola`);
  for (const field of required) {
    const { [field]: omitted, ...body } = validBody;
    assert.notEqual(omitted, undefined, `${field}: ciało testowe ma to pole`);
    const response = await client.call(method, path, { cookie, body, expect: 400, invalidRequest: true });
    assert.equal(typeof response.body.error, 'string', `${field}: kod błędu`);
  }
}

// --- Rodziny ---------------------------------------------------------------------------

// h-1: rodzeństwo s-1 (1A) i s-2 (2B), opiekunowie g-1 i g-2 (oboje przy obojgu dzieci).
// h-2: drugie gospodarstwo s-1 (opieka dzielona, nie główne), opiekun g-3 ze zgodami.
// h-3: s-3 (2B) z opiekunem g-4 — poza zakresem przedstawiciela 1A.
// h-4: s-4 bez przypisania do klasy (nowe przypisanie 201) i cel dodania członkostwa.
async function familiesWorld() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-2b', schoolYearId: YEAR, name: '2B' });
  await seedClass(db, { id: 'c-3c', schoolYearId: YEAR, name: '3C' });
  await seedClass(db, { id: 'c-1a-27', schoolYearId: NEXT, name: '1A' });
  await db.exec(`
    INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3'), ('h-4');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
      ('g-1', 'h-1', 'Anna', 'Syntetyczna', 'opiekun1@example.invalid', true),
      ('g-2', 'h-1', 'Piotr', 'Syntetyczny', 'opiekun2@example.invalid', true),
      ('g-3', 'h-2', 'Ewa', 'Syntetyczna', 'opiekun3@example.invalid', true),
      ('g-4', 'h-3', 'Jan', 'Testowy', 'opiekun4@example.invalid', true);
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s-1', 'h-1', 'Ola', 'Syntetyczna'), ('s-2', 'h-1', 'Kuba', 'Syntetyczny'),
      ('s-3', 'h-3', 'Ala', 'Testowa'), ('s-4', 'h-4', 'Ida', 'Testowa');
    INSERT INTO student_households (id, student_id, household_id, is_primary, source)
      VALUES ('sh-s1-h2', 's-1', 'h-2', false, 'api');
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
      ('s-1', 'g-1', true, true), ('s-1', 'g-2', true, false), ('s-2', 'g-1', true, true), ('s-2', 'g-2', true, false),
      ('s-1', 'g-3', true, false), ('s-3', 'g-4', true, true);
    INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
      ('e-1', 's-1', 'c-1a', '${YEAR}'), ('e-2', 's-2', 'c-2b', '${YEAR}'), ('e-3', 's-3', 'c-2b', '${YEAR}');
  `);
  const cookies = {
    admin: await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] }),
    board: await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] }),
    boardA: await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: [{ role: 'board', classId: 'c-1a', schoolYearId: YEAR }] }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    repA: await seedUserSession(db, { userId: 'u-rep-a', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit' }] }),
  };
  const client = createContractClient({ spec, fetch: (req) => handlePgRequest(req, { db }) });
  return { db, cookies, client };
}

const membershipOf = async (db, table, column, ownerId, householdId) => (await db.query(
  `SELECT id FROM ${table} WHERE ${column} = $1 AND household_id = $2 AND ends_on IS NULL`, [ownerId, householdId],
)).rows[0].id;

test('kontrakt rodzin: odczyty — rodzeństwo, dwoje opiekunów, opieka dzielona i zakres przedstawiciela', async () => {
  const { db, cookies, client } = await familiesWorld();
  try {
    // Wpłata (skarbnik) — karta pokazuje sumę netto rolom finansowym z MFA.
    await client.call('POST', '/api/payments', {
      cookie: cookies.treasurer, key: 'pay-families-000001', expect: 201,
      body: { schoolYearId: YEAR, householdId: 'h-1', amountCents: 5000, receivedOn: '2026-09-20', method: 'bank', reference: 'Składka syntetyczna' },
    });

    // Klasy: zarząd widzi wszystkie, przedstawiciel tylko 1A; filtr roku nie poszerza zakresu.
    const boardClasses = await client.call('GET', '/api/classes', { cookie: cookies.board, expect: 200 });
    assert.deepEqual(boardClasses.body.classes.map((item) => item.id).sort(), ['c-1a', 'c-1a-27', 'c-2b', 'c-3c']);
    const yearClasses = await client.call('GET', `/api/classes?schoolYearId=${YEAR}`, { cookie: cookies.board, expect: 200 });
    assert.equal(yearClasses.body.classes.length, 3);
    const repClasses = await client.call('GET', `/api/classes?schoolYearId=${YEAR}`, { cookie: cookies.repA, expect: 200 });
    assert.deepEqual(repClasses.body.classes.map((item) => [item.id, item.studentCount]), [['c-1a', 1]]);
    assert.equal(spec.paths['/api/classes'].get.parameters.some((p) => p.name === 'cursor' || p.name === 'limit'), false,
      'lista klas nie jest stronicowana');

    // Uczniowie klasy: zakres szeroki z oznaczeniem głównego gospodarstwa, przedstawiciel bez niego.
    const boardStudents = await client.call('GET', '/api/classes/c-1a/students', { cookie: cookies.board, expect: 200 });
    assert.deepEqual(boardStudents.body.students[0].households, [{ householdId: 'h-1', isPrimary: true }, { householdId: 'h-2', isPrimary: false }]);
    const repStudents = await client.call('GET', '/api/classes/c-1a/students', { cookie: cookies.repA, expect: 200 });
    assert.deepEqual(repStudents.body.students.map((item) => item.id), ['s-1']);
    assert.deepEqual(repStudents.body.students[0].households, [{ householdId: 'h-1' }, { householdId: 'h-2' }]);

    // Karta h-1 (zarząd): rodzeństwo w dwóch klasach, dwoje opiekunów przy obojgu dzieci, suma wpłat.
    const card = await client.call('GET', '/api/households/h-1', { cookie: cookies.board, expect: 200 });
    const students = Object.fromEntries(card.body.students.map((item) => [item.id, item]));
    assert.deepEqual(Object.keys(students).sort(), ['s-1', 's-2']);
    assert.deepEqual([students['s-1'].classes[0].classId, students['s-2'].classes[0].classId], ['c-1a', 'c-2b']);
    assert.deepEqual([students['s-1'].isPrimaryHousehold, students['s-2'].isPrimaryHousehold], [true, true]);
    assert.deepEqual(students['s-1'].otherHouseholds, [{ householdId: 'h-2', isPrimary: false }]);
    assert.deepEqual(card.body.guardians.map((item) => item.id).sort(), ['g-1', 'g-2']);
    for (const guardian of card.body.guardians) assert.deepEqual(guardian.relations.map((item) => item.studentId), ['s-1', 's-2']);
    assert.deepEqual(card.body.paymentTotals, [{ schoolYearId: YEAR, netAmountCents: 5000, paymentCount: 1 }]);

    // Opieka dzielona: h-2 z perspektywy zarządu (gospodarstwo nie główne, opiekun g-3).
    const shared = await client.call('GET', '/api/households/h-2', { cookie: cookies.board, expect: 200 });
    assert.deepEqual(shared.body.students.map((item) => [item.id, item.isPrimaryHousehold]), [['s-1', false]]);
    assert.deepEqual(shared.body.students[0].otherHouseholds, [{ householdId: 'h-1', isPrimary: true }]);
    assert.deepEqual(shared.body.guardians.map((item) => item.id), ['g-3']);
    assert.deepEqual(shared.body.paymentTotals, []);

    // Przedstawiciel 1A: tylko dziecko z jego klasy, bez rodzeństwa z 2B, bez głównego i bez sum wpłat.
    const repCard = await client.call('GET', '/api/households/h-1', { cookie: cookies.repA, expect: 200 });
    assert.deepEqual(repCard.body.students.map((item) => item.id), ['s-1']);
    assert.equal(JSON.stringify(repCard.body).includes('s-2'), false);
    assert.equal('isPrimaryHousehold' in repCard.body.students[0], false);
    assert.equal('paymentTotals' in repCard.body, false);
    assert.deepEqual(repCard.body.students[0].otherHouseholds, [{ householdId: 'h-2' }]);
    assert.deepEqual(repCard.body.guardians.map((item) => item.relations.map((relation) => relation.studentId)), [['s-1'], ['s-1']]);
    const repShared = await client.call('GET', '/api/households/h-2', { cookie: cookies.repA, expect: 200 });
    assert.deepEqual(repShared.body.students.map((item) => item.id), ['s-1']);
    // Skarbnik z przydziałem roku: karta z sumami tego roku.
    const treasurerCard = await client.call('GET', '/api/households/h-1', { cookie: cookies.treasurer, expect: 200 });
    assert.equal(treasurerCard.body.paymentTotals.length, 1);

    // Odmowy: poza zakresem = 404 jak nieistniejące; rola bez dostępu 403; brak sesji 401.
    await client.call('GET', '/api/classes/c-2b/students', { cookie: cookies.repA, expect: 404 });
    await client.call('GET', '/api/classes/c-nope/students', { cookie: cookies.repA, expect: 404 });
    await client.call('GET', '/api/households/h-3', { cookie: cookies.repA, expect: 404 });
    await client.call('GET', '/api/households/h-nope', { cookie: cookies.board, expect: 404 });
    await client.call('GET', '/api/classes', { cookie: cookies.audit, expect: 403 });
    await client.call('GET', '/api/households/h-1', { cookie: cookies.audit, expect: 403 });
    await client.call('GET', '/api/classes?schoolYearId=bad%20id', { cookie: cookies.board, expect: 400, invalidRequest: true });
    await client.call('GET', '/api/classes', { expect: 401 });
    await client.call('GET', '/api/households/h-1', { expect: 401 });
  } finally {
    await db.close();
  }
});

test('kontrakt rodzin: zapisy, ponowienia, granice ról i błędy z katalogu', async () => {
  const { db, cookies, client } = await familiesWorld();
  const B = cookies.board;
  try {
    // Kontakt opiekuna: zmiana i ponowienie (changed: false, ten sam stan); usunięcie e-maila.
    const contactBody = { email: 'Nowy1@Example.invalid', reason: REASON };
    const contact = await client.call('PATCH', '/api/guardians/g-1/contact', { cookie: B, body: contactBody, expect: 200 });
    assert.deepEqual(contact.body, { guardian: { id: 'g-1', email: 'nowy1@example.invalid', contactAllowed: true }, changed: true });
    const contactAgain = await client.call('PATCH', '/api/guardians/g-1/contact', { cookie: B, body: contactBody, expect: 200 });
    assert.equal(contactAgain.body.changed, false);
    const cleared = await client.call('PATCH', '/api/guardians/g-4/contact', { cookie: B, body: { email: null, contactAllowed: false, reason: REASON }, expect: 200 });
    assert.deepEqual(cleared.body.guardian, { id: 'g-4', email: null, contactAllowed: false });
    // Opiekun rodzeństwa z dwóch klas: zarząd z przydziałem 1A dostaje 403 z własnym kodem.
    const sharedOutside = await client.call('PATCH', '/api/guardians/g-1/contact', { cookie: cookies.boardA, body: { contactAllowed: false, reason: REASON }, expect: 403 });
    assert.equal(sharedOutside.body.error, 'guardian_shared_outside_scope');
    await client.call('PATCH', '/api/guardians/g-4/contact', { cookie: cookies.boardA, body: { contactAllowed: true, reason: REASON }, expect: 404 });
    await client.call('PATCH', '/api/guardians/g-1/contact', { cookie: cookies.repA, body: contactBody, expect: 403 });
    await client.call('PATCH', '/api/guardians/g-1/contact', { body: contactBody, expect: 401 });
    const badEmail = await client.call('PATCH', '/api/guardians/g-2/contact', { cookie: B, body: { email: 'bez-malpy', reason: REASON }, expect: 400 });
    assert.equal(badEmail.body.error, 'invalid_email');
    const nothing = await client.call('PATCH', '/api/guardians/g-2/contact', { cookie: B, body: { reason: REASON }, expect: 400, invalidRequest: true });
    assert.equal(nothing.body.error, 'invalid_request');
    await client.call('PATCH', '/api/guardians/g-2/contact', { cookie: B, body: 'email=x', expect: 415, invalidRequest: true });
    await client.call('PATCH', '/api/guardians/g-2/contact', { cookie: B, body: contactBody, expect: 403, origin: 'https://obcy.example' });
    const pii = await client.call('PATCH', '/api/guardians/g-2/contact', { cookie: B, body: { contactAllowed: false, reason: 'Telefon +32 470 12 34 56' }, expect: 422 });
    assert.equal(pii.body.error, 'possible_personal_data');
    await assertRequiredFieldsEnforced(client, B, 'PATCH', '/api/guardians/g-2/contact', { contactAllowed: false, reason: REASON }, 'GuardianContactRequest');

    // Sprostowanie imienia ucznia i opiekuna (#100) z ponowieniem.
    const identityBody = { firstName: 'Olga', reason: REASON };
    const identity = await client.call('PATCH', '/api/students/s-1/identity', { cookie: B, body: identityBody, expect: 200 });
    assert.deepEqual(identity.body, { student: { id: 's-1', firstName: 'Olga', lastName: 'Syntetyczna' }, changed: true });
    assert.equal((await client.call('PATCH', '/api/students/s-1/identity', { cookie: B, body: identityBody, expect: 200 })).body.changed, false);
    const guardianIdentity = await client.call('PATCH', '/api/guardians/g-3/identity', { cookie: B, body: { lastName: 'Sprostowana', reason: REASON }, expect: 200 });
    assert.equal(guardianIdentity.body.guardian.lastName, 'Sprostowana');
    const identityShared = await client.call('PATCH', '/api/guardians/g-2/identity', { cookie: cookies.boardA, body: identityBody, expect: 403 });
    assert.equal(identityShared.body.error, 'guardian_shared_outside_scope');
    await client.call('PATCH', '/api/students/s-3/identity', { cookie: cookies.boardA, body: identityBody, expect: 404 });
    const badName = await client.call('PATCH', '/api/students/s-1/identity', { cookie: B, body: { firstName: 'a@b', reason: REASON }, expect: 400, invalidRequest: true });
    assert.equal(badName.body.error, 'invalid_person_name');
    const badRequestId = await client.call('PATCH', '/api/students/s-1/identity', { cookie: B, body: { ...identityBody, dataRequestId: 'nie-uuid' }, expect: 400, invalidRequest: true });
    assert.equal(badRequestId.body.error, 'invalid_data_request_id');
    const unknownRequest = { firstName: 'Inna', reason: REASON, dataRequestId: '00000000-0000-4000-8000-000000000000' };
    await client.call('PATCH', '/api/students/s-1/identity', { cookie: B, body: unknownRequest, expect: 403 });
    const missingRequest = await client.call('PATCH', '/api/students/s-1/identity', { cookie: cookies.admin, body: unknownRequest, expect: 404 });
    assert.equal(missingRequest.body.error, 'data_request_not_found');
    await assertRequiredFieldsEnforced(client, B, 'PATCH', '/api/guardians/g-3/identity', { firstName: 'Ewa', reason: REASON }, 'IdentityRequest');

    // Zgoda w relacji opiekun–dziecko (#190): drugi opiekun rodzeństwa, ponowienie.
    const relationBody = { contactAllowed: false, reason: REASON };
    const relation = await client.call('PATCH', '/api/guardians/g-2/students/s-2', { cookie: B, body: relationBody, expect: 200 });
    assert.deepEqual(relation.body, { relation: { guardianId: 'g-2', studentId: 's-2', contactAllowed: false }, guardianContactAllowed: true, changed: true });
    assert.equal((await client.call('PATCH', '/api/guardians/g-2/students/s-2', { cookie: B, body: relationBody, expect: 200 })).body.changed, false);
    await client.call('PATCH', '/api/guardians/g-2/students/s-3', { cookie: B, body: relationBody, expect: 404 });
    await assertRequiredFieldsEnforced(client, B, 'PATCH', '/api/guardians/g-2/students/s-2', relationBody, 'RelationContactRequest');

    // Zakończenie relacji (opieka dzielona: drugi dom s-1), ponowienie i 409 przy zmianie zgody po końcu.
    const endRelationBody = { endsOn: PAST, reason: REASON };
    const ended = await client.call('POST', '/api/guardians/g-3/students/s-1/end', { cookie: B, body: endRelationBody, expect: 200 });
    assert.deepEqual(ended.body, { relation: { guardianId: 'g-3', studentId: 's-1', endsOn: PAST }, changed: true, campaignsToReview: [] });
    const endedAgain = await client.call('POST', '/api/guardians/g-3/students/s-1/end', { cookie: B, body: { endsOn: '2021-01-01', reason: REASON }, expect: 200 });
    assert.deepEqual([endedAgain.body.changed, endedAgain.body.relation.endsOn], [false, PAST]);
    const relationEnded = await client.call('PATCH', '/api/guardians/g-3/students/s-1', { cookie: B, body: relationBody, expect: 409 });
    assert.equal(relationEnded.body.error, 'relation_ended');
    const badEnd = await client.call('POST', '/api/guardians/g-1/students/s-1/end', { cookie: B, body: { endsOn: 'wczoraj', reason: REASON }, expect: 400, invalidRequest: true });
    assert.equal(badEnd.body.error, 'invalid_ended_on');
    await assertRequiredFieldsEnforced(client, B, 'POST', '/api/guardians/g-1/students/s-1/end', endRelationBody, 'MembershipEndRequest');

    // Przypisanie do klasy: nowe (201), ponowienie (200, changed: false), zmiana klasy (200), błędy.
    const enrollBody = { schoolYearId: YEAR, classId: 'c-3c', effectiveOn: '2026-09-15', reason: REASON };
    const enrolled = await client.call('POST', '/api/students/s-4/enrollments', { cookie: B, body: enrollBody, expect: 201 });
    assert.deepEqual(enrolled.body.enrollment, { id: enrolled.body.enrollment.id, studentId: 's-4', schoolYearId: YEAR, classId: 'c-3c' });
    const enrolledAgain = await client.call('POST', '/api/students/s-4/enrollments', { cookie: B, body: enrollBody, expect: 200 });
    assert.deepEqual([enrolledAgain.body.changed, enrolledAgain.body.enrollment.id], [false, enrolled.body.enrollment.id]);
    const moved = await client.call('POST', '/api/students/s-3/enrollments', { cookie: B, body: enrollBody, expect: 200 });
    assert.deepEqual([moved.body.changed, moved.body.enrollment.id], [true, 'e-3']);
    const mismatch = await client.call('POST', '/api/students/s-4/enrollments', { cookie: B, body: { ...enrollBody, classId: 'c-1a-27' }, expect: 400 });
    assert.equal(mismatch.body.error, 'class_year_mismatch');
    const noClass = await client.call('POST', '/api/students/s-4/enrollments', { cookie: B, body: { ...enrollBody, classId: 'c-nope' }, expect: 404 });
    assert.equal(noClass.body.error, 'class_not_found');
    await client.call('POST', '/api/students/s-2/enrollments', { cookie: cookies.boardA, body: enrollBody, expect: 404 });
    await client.call('POST', '/api/students/s-4/enrollments', { cookie: cookies.repA, body: enrollBody, expect: 403 });
    await assertRequiredFieldsEnforced(client, B, 'POST', '/api/students/s-4/enrollments', enrollBody, 'EnrollmentRequest');

    // Odejście ze szkoły: zakończenie przypisania i ponowienie (zapisana data bez zmian).
    const endEnrollmentBody = { endedOn: PAST, reason: REASON };
    const left = await client.call('POST', '/api/students/s-3/enrollments/e-3/end', { cookie: B, body: endEnrollmentBody, expect: 200 });
    assert.deepEqual(left.body, { enrollment: { id: 'e-3', studentId: 's-3', endedOn: PAST }, changed: true });
    const leftAgain = await client.call('POST', '/api/students/s-3/enrollments/e-3/end', { cookie: B, body: { endedOn: '2021-01-01', reason: REASON }, expect: 200 });
    assert.deepEqual([leftAgain.body.changed, leftAgain.body.enrollment.endedOn], [false, PAST]);
    await client.call('POST', '/api/students/s-1/enrollments/e-3/end', { cookie: B, body: endEnrollmentBody, expect: 404 });
    await assertRequiredFieldsEnforced(client, B, 'POST', '/api/students/s-2/enrollments/e-2/end', endEnrollmentBody, 'EnrollmentEndRequest');

    // Członkostwo ucznia: dodanie (201), ponowienie (200, ten sam identyfikator), drugie główne 409, zakres klasowy 403.
    const addBody = { householdId: 'h-4', isPrimary: false, startsOn: '2026-09-01', reason: REASON };
    const added = await client.call('POST', '/api/students/s-2/households', { cookie: B, body: addBody, expect: 201 });
    assert.deepEqual(added.body, { membership: { id: added.body.membership.id, studentId: 's-2', householdId: 'h-4', isPrimary: false, startsOn: '2026-09-01' }, changed: true });
    const addedAgain = await client.call('POST', '/api/students/s-2/households', { cookie: B, body: addBody, expect: 200 });
    assert.deepEqual(addedAgain.body, { ...added.body, changed: false });
    const overlap = await client.call('POST', '/api/students/s-2/households', { cookie: B, body: { ...addBody, householdId: 'h-3', isPrimary: true }, expect: 409 });
    assert.equal(overlap.body.error, 'student_household_overlap');
    await client.call('POST', '/api/students/s-2/households', { cookie: B, body: { ...addBody, householdId: 'h-nope' }, expect: 404 });
    await client.call('POST', '/api/students/s-1/households', { cookie: cookies.boardA, body: addBody, expect: 403 });
    const badStart = await client.call('POST', '/api/students/s-2/households', { cookie: B, body: { ...addBody, startsOn: 'jutro' }, expect: 400, invalidRequest: true });
    assert.equal(badStart.body.error, 'invalid_effective_on');
    await assertRequiredFieldsEnforced(client, B, 'POST', '/api/students/s-2/households', addBody, 'StudentHouseholdAddRequest');

    // Zakończenie członkostwa ucznia: drugi dom s-1 (opieka dzielona) — główne gospodarstwo zostaje.
    const studentMembership = await membershipOf(db, 'student_households', 'student_id', 's-1', 'h-2');
    const endMembershipBody = { endsOn: PAST, reason: REASON };
    const studentEnded = await client.call('POST', `/api/students/s-1/households/${studentMembership}/end`, { cookie: B, body: endMembershipBody, expect: 200 });
    assert.deepEqual(studentEnded.body, {
      membership: { id: studentMembership, studentId: 's-1', householdId: 'h-2', endsOn: PAST }, changed: true, withoutPrimaryHousehold: false,
    });
    assert.equal((await client.call('POST', `/api/students/s-1/households/${studentMembership}/end`, { cookie: B, body: endMembershipBody, expect: 200 })).body.changed, false);
    await client.call('POST', '/api/students/s-1/households/nie-ma-takiego/end', { cookie: B, body: endMembershipBody, expect: 404 });

    // Zakończenie członkostwa opiekuna: drugi opiekun h-1 (bez innego gospodarstwa), zakres klasowy 403.
    const guardianMembership = await membershipOf(db, 'guardian_households', 'guardian_id', 'g-2', 'h-1');
    await client.call('POST', `/api/guardians/g-2/households/${guardianMembership}/end`, { cookie: cookies.boardA, body: endMembershipBody, expect: 403 });
    const guardianEnded = await client.call('POST', `/api/guardians/g-2/households/${guardianMembership}/end`, { cookie: B, body: endMembershipBody, expect: 200 });
    assert.deepEqual(guardianEnded.body, {
      membership: { id: guardianMembership, guardianId: 'g-2', householdId: 'h-1', endsOn: PAST }, changed: true, withoutHousehold: true,
    });
    assert.equal((await client.call('POST', `/api/guardians/g-2/households/${guardianMembership}/end`, { cookie: B, body: endMembershipBody, expect: 200 })).body.changed, false);
    // Karta po zmianach nadal zgodna ze schematem: g-2 zniknął, rodzeństwo zostało.
    const after = await client.call('GET', '/api/households/h-1', { cookie: B, expect: 200 });
    assert.deepEqual([after.body.guardians.map((item) => item.id), after.body.students.length], [['g-1'], 2]);
    // Listy po zmianach: s-4 w 3C, s-3 (przeniesiony, potem odejście) już nie liczy się do klasy.
    const classes = await client.call('GET', `/api/classes?schoolYearId=${YEAR}`, { cookie: B, expect: 200 });
    assert.equal(classes.body.classes.find((item) => item.id === 'c-3c').studentCount, 1);
    const roster = await client.call('GET', '/api/classes/c-3c/students', { cookie: B, expect: 200 });
    assert.deepEqual(roster.body.students.map((item) => [item.id, item.households]), [['s-4', [{ householdId: 'h-4', isPrimary: true }]]]);

    assertSuccessCoverage(client, 'families');
  } finally {
    await db.close();
  }
});

// --- Sesja ------------------------------------------------------------------------------

const FAST_SCRYPT = { SCRYPT_COST_LOG2: '15' };

test('kontrakt sesji: logowanie, stan sesji przed i po MFA, przydziały, wylogowanie', async () => {
  const db = await createTestDb();
  const env = { db, MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), LOGIN_EMAIL_DELAY_MS: '0', ...FAST_SCRYPT };
  const client = createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
  // Trasy logowania i MFA należą do innych modułów (bez schematów) — wołane bezpośrednio.
  const post = (path, body, cookie) => handlePgRequest(request(path, { method: 'POST', body, cookie, headers: { 'x-rd-client-ip': '198.51.100.7' } }), env);
  const cookieFrom = (response) => response.headers.get('Set-Cookie').split(';', 1)[0];
  try {
    await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
    await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
    const password = `Syntetyczne haslo ${randomBytes(6).toString('hex')}`;
    await seedUser(db, { userId: 'u-board-login' });
    await db.query("INSERT INTO role_grants (id, user_id, role) VALUES ('rg-board-login', 'u-board-login', 'board')");
    await db.query("INSERT INTO user_passwords (user_id, hash, set_reason) VALUES ('u-board-login', $1, 'invitation')",
      [await hashPassword(password, { env: FAST_SCRYPT })]);

    // Logowanie hasłem: sesja bez MFA; zarząd bez czynnika — bramka MFA ukrywa role.
    const login = await post('/api/login', { email: 'u-board-login@example.invalid', password });
    assert.equal(login.status, 200, await login.clone().text());
    const passwordCookie = cookieFrom(login);
    const before = await client.call('GET', '/api/session', { cookie: passwordCookie, expect: 200 });
    assert.deepEqual([before.body.mfaVerified, before.body.writeMode, before.body.user.id], [false, 'normal', 'u-board-login']);
    assert.equal('mfaVerifiedAt' in before.body, false);
    const gated = await client.call('GET', '/api/access', { cookie: passwordCookie, expect: 200 });
    assert.deepEqual(gated.body, { grants: [], hasActiveRole: false, mfaRequired: true });

    // MFA: zapis i potwierdzenie czynnika rotuje sesję; nowa sesja ma mfaVerified i widzi role.
    const enrolled = await post('/api/mfa/enroll', undefined, passwordCookie);
    assert.equal(enrolled.status, 201);
    const { secret } = await enrolled.json();
    const confirmed = await post('/api/mfa/confirm', { code: totp(base32Decode(secret), Date.now()) }, passwordCookie);
    assert.equal(confirmed.status, 200);
    const mfaCookie = cookieFrom(confirmed);
    const afterMfa = await client.call('GET', '/api/session', { cookie: mfaCookie, expect: 200 });
    assert.equal(afterMfa.body.mfaVerified, true);
    const access = await client.call('GET', '/api/access', { cookie: mfaCookie, expect: 200 });
    assert.deepEqual(access.body, { grants: [{ role: 'board', classId: null, schoolYearId: null, expiresAt: null }], hasActiveRole: true });

    // Przydział klasowy z terminem ważności (przedstawiciel nie wymaga MFA).
    const repCookie = await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR, expiresAt: '2099-08-31T22:00:00Z' }],
    });
    const repAccess = await client.call('GET', '/api/access', { cookie: repCookie, expect: 200 });
    assert.deepEqual(repAccess.body.grants, [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR, expiresAt: '2099-08-31T22:00:00.000Z' }]);
    const noGrant = await client.call('GET', '/api/access', { cookie: await seedUserSession(db, { userId: 'u-none' }), expect: 200 });
    assert.deepEqual(noGrant.body, { grants: [], hasActiveRole: false });

    // Okno serwisowe i capabilities Komisji Rewizyjnej (tylko przy fladze, D-09).
    env.APP_WRITE_MODE = 'read_only';
    assert.equal((await client.call('GET', '/api/session', { cookie: repCookie, expect: 200 })).body.writeMode, 'read_only');
    delete env.APP_WRITE_MODE;
    const auditCookie = await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit' }] });
    assert.equal('capabilities' in (await client.call('GET', '/api/session', { cookie: auditCookie, expect: 200 })).body, false);
    env.AUDIT_LEDGER_READ = 'true';
    try {
      const withFlag = await client.call('GET', '/api/session', { cookie: auditCookie, expect: 200 });
      assert.deepEqual(withFlag.body.capabilities, { auditLedgerRead: true });
      assert.equal('capabilities' in (await client.call('GET', '/api/session', { cookie: repCookie, expect: 200 })).body, false);
    } finally {
      delete env.AUDIT_LEDGER_READ;
    }

    // Wylogowanie: 204 bez treści, sesja cofnięta (401), ponowienie i brak sesji też 204; obcy Origin 403.
    const foreign = await client.call('POST', '/api/logout', { cookie: mfaCookie, expect: 403, origin: 'https://obcy.example' });
    assert.equal(foreign.body.error, 'invalid_origin');
    const logout = await client.call('POST', '/api/logout', { cookie: mfaCookie, expect: 204 });
    assert.deepEqual([logout.body, logout.bytes.length], [null, 0]);
    assert.match(logout.headers.get('Set-Cookie') ?? '', /Max-Age=0/i);
    await client.call('GET', '/api/session', { cookie: mfaCookie, expect: 401 });
    await client.call('GET', '/api/access', { cookie: mfaCookie, expect: 401 });
    await client.call('POST', '/api/logout', { cookie: mfaCookie, expect: 204 });
    await client.call('POST', '/api/logout', { expect: 204 });
    await client.call('GET', '/api/session', { expect: 401 });

    assertSuccessCoverage(client, 'session');
  } finally {
    await db.close();
  }
});
