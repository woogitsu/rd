// Kontrakt API (#160, etap 9): prawdziwe odpowiedzi modułu `events` (PGlite, dane syntetyczne `@example.invalid`,
// imiona opiekunów syntetyczne) walidowane schematami z docs/openapi.json (src/pg/schemas/events.js) przez
// tests/helpers/contract-client.js. Rejestr pokrycia i katalog kodów sprawdza tests/openapi-contract.test.js
// (wspólnie dla wszystkich pokrytych modułów).
//
// ŻADNEJ SIECI I ŻADNEJ WYSYŁKI: moduł wydarzeń niczego nie wysyła, a globalna pułapka sieci
// (tests/helpers/network-guard.js) liczy próby połączeń — licznik musi być 0.
//
// Przebieg: wydarzenie klasowe przedstawiciela i ogólnoszkolne zarządu (utworzenie z kluczem, ponowienie
// z nagłówkiem `Idempotency-Replayed`, konflikt klucza, błędy treści i czasu Europe/Brussels), zmiana z wersją
// (podwójne kliknięcie, `revision_conflict`), zgłoszenie, zatwierdzenie (cztery oczy, MFA), publikacja (tylko
// odbiorcy `public`), zmiana po publikacji i odwołanie; zadania wolontariuszy z limitem miejsc (`task_full`), zapisy
// dwojga opiekunów jednego dziecka, rodzeństwo w dwóch klasach (przedstawiciel zapisuje tylko opiekuna dziecka swojej
// klasy), wycofanie i ponowny zapis, zadania poza czasem wydarzenia po jego zmianie (`outsideEventTime`), odwołanie
// zadania; publiczny widok wyłącznie z opublikowanymi danymi i `volunteerTasks` tylko z zadań `isPublic`, lista
// publiczna z kursorem; granice ról (401; przedstawiciel klasy przy własnej i obcej klasie; zarząd z przydziałem
// klasy; Komisja Rewizyjna; dyrekcja; skarbnik; brak MFA w bramce routera i w module; obcy Origin), błędy
// 400/404/409/413/415/422 i zamknięty rok osiągnięty trasami year-close (bez obchodzenia triggerów).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import {
  createTestDb, networkGuardCalls, request, seedClass, seedSchoolYear, seedUserSession,
} from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;

const YEAR = 'y-2026';
const NEXT = 'y-2027';
const FOREIGN = 'https://obcy.example.invalid';

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

function newClient(env) {
  return createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
}

// Każda odpowiedź sukcesu opisana w schemacie modułu została zwalidowana na prawdziwej odpowiedzi.
function assertSuccessCoverage(validated) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (entry.module !== 'events') continue;
    for (const status of Object.keys(entry.responses)) expected.push(`${routeId} ${status}`);
  }
  assert.ok(expected.length >= 18, `oczekiwane odpowiedzi: ${expected.length}`);
  assert.deepEqual(expected.filter((item) => !validated.has(item)), [], 'odpowiedzi sukcesu opisane w schemacie bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje błąd i w schemacie, i na serwerze (400).
async function assertRequiredFieldsEnforced(client, cookie, method, path, validBody, componentName, { withKey = false } = {}) {
  const requiredFields = components[componentName].required;
  assert.ok(requiredFields.length > 0, `${componentName}: schemat ma wymagane pola`);
  for (const field of requiredFields) {
    const { [field]: omitted, ...body } = validBody;
    assert.notEqual(omitted, undefined, `${field}: ciało testowe ma to pole`);
    const response = await client.call(method, path, {
      cookie, body, key: withKey ? key('req') : undefined, expect: 400, invalidRequest: true,
    });
    assert.equal(typeof response.body.error, 'string', `${componentName}.${field}: kod błędu`);
  }
}

// Rodzina: dzieci zapisane do wskazanych klas i opiekunowie z relacją do każdego dziecka (imiona syntetyczne).
async function family(db, householdId, { classes, guardians }) {
  await db.query('INSERT INTO households (id) VALUES ($1)', [householdId]);
  const studentIds = [];
  for (const [index, classId] of classes.entries()) {
    const id = `${householdId}-s${index + 1}`;
    studentIds.push(id);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Syntetyczny')", [id, householdId]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, id, classId, YEAR]);
  }
  for (const [index, [firstName, lastName]] of guardians.entries()) {
    const id = `${householdId}-g${index + 1}`;
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [id, householdId, firstName, lastName, `${id}@example.invalid`],
    );
    for (const studentId of studentIds) {
      await db.query(
        'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, $3)',
        [studentId, id, index === 0],
      );
    }
  }
}

async function world() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  await seedClass(db, { id: 'c-2a', schoolYearId: NEXT, name: '2A' });
  const year = (role, extra = {}) => [{ role, schoolYearId: YEAR, ...extra }];
  const both = (role) => [{ role, schoolYearId: YEAR }, { role, schoolYearId: NEXT }];
  const cookies = {
    boardA: await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: both('board') }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', mfa: true, roles: both('board') }),
    // Przydział zarządu bez roku: zapisy po zamknięciu roku (przydziały roku wygasają przy zamknięciu).
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', mfa: true, roles: [{ role: 'board' }] }),
    boardClass: await seedUserSession(db, { userId: 'u-board-class', mfa: true, roles: year('board', { classId: 'c-1a' }) }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', mfa: false, roles: year('board') }),
    admin: await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: year('admin') }),
    repA: await seedUserSession(db, { userId: 'u-rep-a', mfa: false, roles: year('representative', { classId: 'c-1a' }) }),
    repB: await seedUserSession(db, { userId: 'u-rep-b', mfa: false, roles: year('representative', { classId: 'c-1b' }) }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: year('treasurer') }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: year('audit') }),
    principal: await seedUserSession(db, { userId: 'u-principal', mfa: false, roles: year('principal') }),
  };
  // h1: rodzeństwo w 1A i 1B, dwoje opiekunów obu dzieci; h2: jedno dziecko w 1B.
  await family(db, 'h1', { classes: ['c-1a', 'c-1b'], guardians: [['Zenobia', 'Testowa'], ['Bonifacy', 'Testowy']] });
  await family(db, 'h2', { classes: ['c-1b'], guardians: [['Teodora', 'Przykładowa']] });
  const env = { db, APP_ENV: 'development' };
  return { db, env, cookies, client: newClient(env) };
}

// Zamknięcie roku przez trasy zamknięcia (lista kontrolna, druga osoba zarządu) — bez obchodzenia triggerów.
async function closeYear(env, cookies) {
  const call = async (path, cookie, body) => {
    const response = await handlePgRequest(request(path, { method: 'POST', cookie, body }), env);
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call(`/api/year-close/${YEAR}/start`, cookies.boardA, { nextSchoolYearId: NEXT })).status, 201);
  for (const item of CHECKLIST_ITEMS) {
    assert.equal((await call(`/api/year-close/${YEAR}/checklist/${item}`, cookies.boardA, { note: `Potwierdzenie ${item}` })).status, 201);
  }
  const closed = await call(`/api/year-close/${YEAR}/close`, cookies.boardB, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
}

test('specyfikacja wydarzeń: nagłówek ponowienia tylko przy utworzeniu wydarzenia, zadania i zapisy z polem `replayed`', () => {
  const operation = (method, path) => spec.paths[path][method];
  const hasKey = (op) => (op.parameters ?? []).some((p) => p.in === 'header' && p.name === 'Idempotency-Key' && p.required === true);
  const replayedEnum = (op, status) => op.responses[status].headers?.['Idempotency-Replayed']?.schema.enum ?? null;
  const create = operation('post', '/api/events');
  assert.equal(hasKey(create), true);
  assert.deepEqual([replayedEnum(create, '201'), replayedEnum(create, '200')], [['false'], ['true']]);
  for (const path of ['/api/events/{eventId}/tasks', '/api/events/{eventId}/tasks/{taskId}/signups']) {
    const op = operation('post', path);
    assert.equal(hasKey(op), true, path);
    assert.deepEqual([replayedEnum(op, '201'), replayedEnum(op, '200')], [null, null], path);
    const field = (status) => op.responses[status].content['application/json'].schema.properties.replayed;
    assert.deepEqual([field('201'), field('200')], [{ const: false }, { const: true }], path);
  }
  for (const [method, path] of [
    ['patch', '/api/events/{eventId}'], ['post', '/api/events/{eventId}/submit'], ['post', '/api/events/{eventId}/approve'],
    ['post', '/api/events/{eventId}/publish'], ['post', '/api/events/{eventId}/cancel'],
    ['post', '/api/events/{eventId}/tasks/{taskId}/cancel'], ['post', '/api/events/{eventId}/tasks/{taskId}/signups/{signupId}/withdraw'],
  ]) {
    const op = operation(method, path);
    assert.equal(hasKey(op), false, path);
    assert.equal(replayedEnum(op, '200'), null, path);
    assert.ok(op.responses['200'].content['application/json'].schema.required.includes('replayed'), path);
  }
  assert.deepEqual(spec.paths['/api/public/events'].get.security, []);
  assert.equal(spec.paths['/api/events/{eventId}/tasks/{taskId}/signups/{signupId}/withdraw'].post.requestBody, undefined);
});

test('kontrakt modułu events: prawdziwe odpowiedzi wydarzeń, przebiegu, zadań, zapisów i widoku publicznego zgodne ze schematami', async () => {
  const { db, env, cookies, client } = await world();
  const A = cookies.boardA;
  const B = cookies.boardB;
  const R = cookies.repA;
  const validated = client.validated;
  try {
    const createEvent = async (cookie, body) => (await client.call('POST', '/api/events', { cookie, body, key: key('evt'), expect: 201 })).body.event;
    const step = async (cookie, id, action, revision, extra = {}) => (await client.call('POST', `/api/events/${id}/${action}`, {
      cookie, body: { revision, ...extra }, expect: 200,
    })).body;
    const publicIds = async (query = '') => (await client.call('GET', `/api/public/events${query}`, { expect: 200 })).body.events.map((event) => event.id);

    // ---------- Wydarzenie klasowe przedstawiciela: utworzenie, ponowienie, konflikt klucza, błędy ----------
    const classBody = {
      schoolYearId: YEAR, classId: 'c-1a', title: 'Piknik klasy 1A', description: 'Spotkanie na boisku szkolnym.',
      startsAt: '2026-11-12T10:00', endsAt: '2026-11-12T14:00', location: 'Boisko', organizer: 'Rada klasy 1A', audience: 'internal',
    };
    const classKey = key('evt');
    const created = await client.call('POST', '/api/events', { cookie: R, body: classBody, key: classKey, expect: 201 });
    assert.equal(created.headers.get('Idempotency-Replayed'), 'false');
    const classEvent = created.body.event;
    assert.deepEqual([classEvent.status, classEvent.revision, classEvent.classId, classEvent.visibility, classEvent.createdBy],
      ['draft', 1, 'c-1a', 'internal', 'u-rep-a']);
    assert.deepEqual([classEvent.startsAt, classEvent.startsAtUtc], ['2026-11-12T10:00:00+01:00', '2026-11-12T09:00:00.000Z']);
    const replay = await client.call('POST', '/api/events', { cookie: R, body: classBody, key: classKey, expect: 200 });
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(replay.body, created.body);
    assert.equal((await client.call('POST', '/api/events', { cookie: R, body: { ...classBody, title: 'Inny piknik klasy' }, key: classKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', '/api/events', { cookie: R, body: classBody, expect: 400 })).body.error, 'invalid_idempotency_key');
    // Przedstawiciel: wyłącznie wydarzenie własnej klasy.
    for (const classId of ['c-1b', null]) {
      assert.equal((await client.call('POST', '/api/events', { cookie: R, body: { ...classBody, classId }, key: key('evt'), expect: 403 })).body.error, 'forbidden', String(classId));
    }
    const contentErrors = [
      [{ startsAt: '2026-10-25T02:30' }, 'ambiguous_local_time'],
      [{ startsAt: '2027-03-28T02:30', endsAt: null }, 'nonexistent_local_time'],
      [{ startsAt: '2026-11-12T10:00+02:00' }, 'offset_not_valid_in_europe_brussels'],
      [{ startsAt: '2026-11-31T10:00' }, 'invalid_datetime'],
      [{ endsAt: '2026-11-12T09:00' }, 'ends_before_start'],
    ];
    for (const [patch, code] of contentErrors) {
      assert.equal((await client.call('POST', '/api/events', { cookie: R, body: { ...classBody, ...patch }, key: key('evt'), expect: 400 })).body.error, code);
    }
    const schemaErrors = [
      [{ title: 'ab' }, 'invalid_title'],
      [{ description: 'x'.repeat(4001) }, 'invalid_description'],
      [{ location: 'x'.repeat(201) }, 'invalid_location'],
      [{ organizer: 'x'.repeat(201) }, 'invalid_organizer'],
      [{ audience: 'all' }, 'invalid_audience'],
      [{ startsAt: '12.11.2026 10:00' }, 'invalid_datetime'],
      [{ schoolYearId: '!' }, 'invalid_school_year'],
      [{ classId: '!' }, 'invalid_class'],
    ];
    for (const [patch, code] of schemaErrors) {
      assert.equal((await client.call('POST', '/api/events', {
        cookie: R, body: { ...classBody, ...patch }, key: key('evt'), expect: 400, invalidRequest: true,
      })).body.error, code);
    }
    // Klasa z innego roku albo nieistniejąca (zarząd ma zakres roku): odmowa klucza obcego bazy.
    for (const classId of ['c-2a', 'c-brak']) {
      assert.equal((await client.call('POST', '/api/events', { cookie: A, body: { ...classBody, classId }, key: key('evt'), expect: 400 })).body.error, 'invalid_reference');
    }
    assert.equal((await client.call('POST', '/api/events', {
      cookie: R, body: { ...classBody, description: 'Kontakt: rodzic@example.invalid' }, key: key('evt'), expect: 422,
    })).body.error, 'personal_data_forbidden');
    const phone = { ...classBody, title: 'Dyżur telefoniczny', description: 'Zadzwonić pod 0471 23 45 67' };
    assert.equal((await client.call('POST', '/api/events', { cookie: R, body: phone, key: key('evt'), expect: 422 })).body.error, 'possible_personal_data');
    await createEvent(R, { ...phone, confirmPersonalData: true });
    await assertRequiredFieldsEnforced(client, R, 'POST', '/api/events', classBody, 'EventCreateRequest', { withKey: true });

    // ---------- Wydarzenie ogólnoszkolne zarządu (publiczne), szczegóły i lista ----------
    const schoolBody = {
      schoolYearId: YEAR, title: 'Kiermasz szkolny', description: 'Kiermasz Rady Rodziców.', startsAt: '2026-11-14T10:00',
      endsAt: '2026-11-14T16:00', location: 'Aula', audience: 'public',
    };
    const school = await createEvent(A, schoolBody);
    assert.deepEqual([school.classId, school.visibility, school.audience], [null, 'draft_public', 'public']);
    const base = `/api/events/${school.id}`;
    const detail = await client.call('GET', base, { cookie: A, expect: 200 });
    assert.deepEqual(detail.body.revisions.map((revision) => [revision.revision, revision.source, revision.title]), [[1, 'app', 'Kiermasz szkolny']]);
    const boardList = await client.call('GET', `/api/events?schoolYearId=${YEAR}`, { cookie: A, expect: 200 });
    assert.ok(boardList.body.events.some((event) => event.id === school.id) && boardList.body.events.some((event) => event.id === classEvent.id));
    const repList = await client.call('GET', `/api/events?schoolYearId=${YEAR}`, { cookie: R, expect: 200 });
    assert.ok(repList.body.events.length > 0 && repList.body.events.every((event) => event.classId === 'c-1a'), 'przedstawiciel widzi tylko swoją klasę');
    assert.equal((await client.call('GET', '/api/events?schoolYearId=%21', { cookie: A, expect: 400 })).body.error, 'invalid_school_year');

    // ---------- Zmiana z wersją: nowa wersja, podwójne kliknięcie, konflikt ----------
    const edit = { revision: 1, title: 'Kiermasz szkolny jesienny' };
    const edited = await client.call('PATCH', base, { cookie: A, body: edit, expect: 200 });
    assert.deepEqual([edited.body.event.revision, edited.body.replayed, edited.body.tasksOutsideEventTime], [2, false, []]);
    assert.equal(edited.headers.get('Idempotency-Replayed'), null);
    assert.equal((await client.call('PATCH', base, { cookie: A, body: edit, expect: 200 })).body.replayed, true, 'ta sama zmiana jeszcze raz (podwójne kliknięcie)');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 2, title: 'Kiermasz szkolny jesienny' }, expect: 200 })).body.replayed, true);
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 1, title: 'Zmiana na starej wersji' }, expect: 409 })).body.error, 'revision_conflict');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { title: 'Bez wersji' }, expect: 400, invalidRequest: true })).body.error, 'invalid_revision');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 2, endsAt: '2026-11-14T09:00' }, expect: 400 })).body.error, 'ends_before_start');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 2, description: 'Kontakt: rodzic@example.invalid' }, expect: 422 })).body.error, 'personal_data_forbidden');
    await assertRequiredFieldsEnforced(client, A, 'PATCH', base, { revision: 2, title: 'Kiermasz szkolny jesienny' }, 'EventUpdateRequest');
    const versions = await client.call('GET', base, { cookie: B, expect: 200 });
    assert.deepEqual(versions.body.revisions.map((revision) => revision.revision), [1, 2]);

    // ---------- Przebieg: zgłoszenie, zatwierdzenie (cztery oczy), publikacja ----------
    assert.equal((await client.call('POST', `${base}/approve`, { cookie: B, body: { revision: 2 }, expect: 409 })).body.error, 'invalid_transition', 'zatwierdzenie szkicu');
    assert.equal((await client.call('POST', `${base}/submit`, { cookie: A, body: { revision: 1 }, expect: 409 })).body.error, 'revision_conflict');
    const submitted = await step(A, school.id, 'submit', 2);
    assert.deepEqual([submitted.event.status, submitted.event.submittedRevision, submitted.replayed], ['submitted', 2, false]);
    assert.equal((await step(A, school.id, 'submit', 2)).replayed, true);
    await assertRequiredFieldsEnforced(client, A, 'POST', `${base}/submit`, { revision: 2 }, 'EventTransitionRequest');
    assert.equal((await client.call('POST', `${base}/approve`, { cookie: A, body: { revision: 2 }, expect: 409 })).body.error, 'four_eyes_required');
    assert.equal((await client.call('POST', `${base}/approve`, { cookie: cookies.admin, body: { revision: 2 }, expect: 403 })).body.error, 'forbidden', 'admin techniczny nie zatwierdza');
    assert.equal((await client.call('POST', `${base}/publish`, { cookie: B, body: { revision: 2 }, expect: 409 })).body.error, 'invalid_transition', 'publikacja przed zatwierdzeniem');
    const approved = await step(B, school.id, 'approve', 2);
    assert.deepEqual([approved.event.status, approved.event.approvedBy, approved.event.approvedRevision], ['approved', 'u-board-b', 2]);
    assert.equal((await step(B, school.id, 'approve', 2)).replayed, true);
    assert.deepEqual(await publicIds(), [], 'zatwierdzone, ale nieopublikowane — poza stroną publiczną');
    const published = await step(A, school.id, 'publish', 2);
    assert.deepEqual([published.event.status, published.event.visibility, published.event.publishedRevision, published.replayed], ['published', 'published', 2, false]);
    assert.equal((await step(A, school.id, 'publish', 2)).replayed, true);

    // Wydarzenie wewnętrzne nie trafia na stronę publiczną (zatwierdzone przez inną osobę niż autor).
    await step(R, classEvent.id, 'submit', 1);
    assert.equal((await client.call('POST', `/api/events/${classEvent.id}/approve`, { cookie: R, body: { revision: 1 }, expect: 403 })).body.error, 'forbidden');
    await step(B, classEvent.id, 'approve', 1);
    assert.equal((await client.call('POST', `/api/events/${classEvent.id}/publish`, { cookie: B, body: { revision: 1 }, expect: 409 })).body.error, 'event_not_public');

    // ---------- Zadania wolontariuszy i zapisy z limitem ----------
    const tasksPath = `${base}/tasks`;
    const taskBody = { title: 'Stoisko z ciastami', slotsNeeded: 2, startsAt: '2026-11-14T10:00', endsAt: '2026-11-14T12:00', isPublic: true };
    const taskKey = key('task');
    const taskCreated = await client.call('POST', tasksPath, { cookie: A, body: taskBody, key: taskKey, expect: 201 });
    const task = taskCreated.body.task;
    assert.deepEqual([taskCreated.body.replayed, taskCreated.headers.get('Idempotency-Replayed'), task.isPublic, task.startsAtUtc], [false, null, true, '2026-11-14T09:00:00.000Z']);
    const taskReplay = await client.call('POST', tasksPath, { cookie: A, body: taskBody, key: taskKey, expect: 200 });
    assert.deepEqual([taskReplay.body.task.id, taskReplay.body.replayed, taskReplay.headers.get('Idempotency-Replayed')], [task.id, true, null]);
    assert.equal((await client.call('POST', tasksPath, { cookie: A, body: { ...taskBody, slotsNeeded: 3 }, key: taskKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', tasksPath, { cookie: A, body: taskBody, expect: 400 })).body.error, 'invalid_idempotency_key');
    const internalTask = (await client.call('POST', tasksPath, { cookie: A, body: { title: 'Sprzątanie sali', slotsNeeded: 5 }, key: key('task'), expect: 201 })).body.task;
    assert.deepEqual([internalTask.isPublic, internalTask.startsAtUtc], [false, null]);
    const taskErrors = [
      [{ startsAt: '2026-11-14T09:00' }, 'task_time_outside_event'],
      [{ endsAt: '2026-11-14T17:00' }, 'task_time_outside_event'],
      [{ endsAt: '2026-11-14T09:30' }, 'ends_before_start'],
      [{ startsAt: '2026-10-25T02:30' }, 'ambiguous_local_time'],
    ];
    for (const [patch, code] of taskErrors) {
      assert.equal((await client.call('POST', tasksPath, { cookie: A, body: { ...taskBody, ...patch }, key: key('task'), expect: 400 })).body.error, code);
    }
    for (const [patch, code] of [[{ slotsNeeded: 0 }, 'invalid_slots_needed'], [{ slotsNeeded: 201 }, 'invalid_slots_needed'], [{ title: 'ab' }, 'invalid_title']]) {
      assert.equal((await client.call('POST', tasksPath, { cookie: A, body: { ...taskBody, ...patch }, key: key('task'), expect: 400, invalidRequest: true })).body.error, code);
    }
    assert.equal((await client.call('POST', tasksPath, { cookie: A, body: { ...taskBody, title: 'Pomoc: rodzic@example.invalid' }, key: key('task'), expect: 422 })).body.error, 'personal_data_forbidden');
    await assertRequiredFieldsEnforced(client, A, 'POST', tasksPath, taskBody, 'EventTaskCreateRequest', { withKey: true });

    // Opiekunowie do formularza: wydarzenie ogólnoszkolne wymaga klasy.
    assert.equal((await client.call('GET', `${tasksPath}/candidates`, { cookie: A, expect: 400 })).body.error, 'class_required');
    const candidatesA = await client.call('GET', `${tasksPath}/candidates?classId=c-1a`, { cookie: A, expect: 200 });
    // Kolejność: nazwisko, imię (Testowa przed Testowy).
    assert.deepEqual(candidatesA.body, { classId: 'c-1a', guardians: [{ id: 'h1-g1', name: 'Zenobia Testowa' }, { id: 'h1-g2', name: 'Bonifacy Testowy' }] });
    const candidatesB = await client.call('GET', `${tasksPath}/candidates?classId=c-1b`, { cookie: A, expect: 200 });
    assert.deepEqual(candidatesB.body.guardians.map((guardian) => guardian.id).sort(), ['h1-g1', 'h1-g2', 'h2-g1'], 'rodzeństwo: opiekunowie h1 także w klasie 1B');
    assert.equal((await client.call('GET', `${tasksPath}/candidates?classId=c-brak`, { cookie: A, expect: 404 })).body.error, 'class_not_found');
    assert.equal((await client.call('GET', `${tasksPath}/candidates?classId=%21`, { cookie: A, expect: 400 })).body.error, 'invalid_class');

    // Zapisy: dwoje opiekunów jednego dziecka to dwa wiersze; trzeci zapis przekracza limit.
    const signupsPath = `${tasksPath}/${task.id}/signups`;
    const first = await client.call('POST', signupsPath, { cookie: A, body: { guardianId: 'h1-g1' }, key: key('sign'), expect: 201 });
    assert.deepEqual([first.body.replayed, first.body.signup.status, first.body.signup.guardianId, first.body.signup.userId, 'personName' in first.body.signup],
      [false, 'confirmed', 'h1-g1', null, false]);
    const again = await client.call('POST', signupsPath, { cookie: A, body: { guardianId: 'h1-g1' }, key: key('sign'), expect: 200 });
    assert.deepEqual([again.body.signup.id, again.body.replayed, again.headers.get('Idempotency-Replayed')], [first.body.signup.id, true, null], 'podwójny zapis tej samej osoby innym kluczem');
    const second = (await client.call('POST', signupsPath, { cookie: A, body: { guardianId: 'h1-g2' }, key: key('sign'), expect: 201 })).body.signup;
    assert.notEqual(second.id, first.body.signup.id);
    assert.equal((await client.call('POST', signupsPath, { cookie: A, body: { guardianId: 'h2-g1' }, key: key('sign'), expect: 409 })).body.error, 'task_full');
    // Wycofanie zwalnia miejsce; ponowny zapis tej samej osoby to ten sam wiersz.
    const withdrawPath = `${signupsPath}/${second.id}/withdraw`;
    const withdrawn = await client.call('POST', withdrawPath, { cookie: A, expect: 200 });
    assert.deepEqual([withdrawn.body.signup.status, withdrawn.body.replayed], ['withdrawn', false]);
    assert.equal((await client.call('POST', withdrawPath, { cookie: A, expect: 200 })).body.replayed, true);
    const resigned = await client.call('POST', signupsPath, { cookie: A, body: { guardianId: 'h1-g2' }, key: key('sign'), expect: 201 });
    assert.deepEqual([resigned.body.signup.id, resigned.body.signup.status], [second.id, 'confirmed']);
    await client.call('POST', withdrawPath, { cookie: A, expect: 200 });
    // Zapis konta (userId) i błędy celu zapisu.
    await client.call('POST', `${tasksPath}/${internalTask.id}/signups`, { cookie: A, body: { userId: 'u-rep-a' }, key: key('sign'), expect: 201 });
    assert.equal((await client.call('POST', signupsPath, { cookie: A, body: { guardianId: 'h2-g1', userId: 'u-rep-a' }, key: key('sign'), expect: 400, invalidRequest: true })).body.error, 'invalid_signup_target');
    assert.equal((await client.call('POST', signupsPath, { cookie: A, body: {}, key: key('sign'), expect: 400, invalidRequest: true })).body.error, 'invalid_signup_target');
    assert.equal((await client.call('POST', signupsPath, { cookie: A, body: { guardianId: 'g-brak' }, key: key('sign'), expect: 400 })).body.error, 'invalid_reference');
    assert.equal((await client.call('POST', signupsPath, { cookie: A, body: { guardianId: 'h2-g1' }, expect: 400 })).body.error, 'invalid_idempotency_key');
    assert.equal((await client.call('POST', `${tasksPath}/brak-zadania/signups`, { cookie: A, body: { guardianId: 'h2-g1' }, key: key('sign'), expect: 404 })).body.error, 'event_task_not_found');
    assert.equal((await client.call('POST', `${signupsPath}/brak-zapisu/withdraw`, { cookie: A, expect: 404 })).body.error, 'event_task_signup_not_found');

    // Lista zadań: zapisani z imieniem i nazwiskiem, liczba potwierdzonych.
    const taskList = await client.call('GET', tasksPath, { cookie: A, expect: 200 });
    const listed = Object.fromEntries(taskList.body.tasks.map((item) => [item.id, item]));
    assert.deepEqual([listed[task.id].confirmedCount, listed[task.id].signups.map((signup) => [signup.personName, signup.status])],
      [1, [['Zenobia Testowa', 'confirmed'], ['Bonifacy Testowy', 'withdrawn']]]);
    assert.deepEqual([listed[internalTask.id].signups[0].personName, listed[task.id].outsideEventTime], ['Test u-rep-a', false]);

    // ---------- Widok publiczny: tylko opublikowane dane, `volunteerTasks` tylko z zadań `isPublic` ----------
    const publicView = await client.call('GET', '/api/public/events', { expect: 200 });
    assert.equal(publicView.headers.get('Cache-Control'), 'public, max-age=60');
    assert.deepEqual(publicView.body.events.map((event) => [event.id, event.title, event.status, event.changedAfterPublication]),
      [[school.id, 'Kiermasz szkolny jesienny', 'scheduled', false]]);
    assert.deepEqual(publicView.body.events[0].volunteerTasks, [{ id: task.id, title: 'Stoisko z ciastami', stillNeeded: 1 }]);
    assert.doesNotMatch(JSON.stringify(publicView.body), /u-board|h1-g|Zenobia|Sprzątanie/, 'bez autorów, osób i zadań niepublicznych');
    // Zmiana po publikacji: strona pokazuje ostatnią opublikowaną wersję ze znacznikiem zmiany.
    const changed = await client.call('PATCH', base, { cookie: A, body: { revision: 2, title: 'Kiermasz szkolny (nowy termin)' }, expect: 200 });
    assert.deepEqual([changed.body.event.status, changed.body.event.publishedRevision, changed.body.event.revision], ['draft', 2, 3]);
    const afterChange = (await client.call('GET', '/api/public/events', { expect: 200 })).body.events[0];
    assert.deepEqual([afterChange.title, afterChange.changedAfterPublication], ['Kiermasz szkolny jesienny', true]);

    // Odwołanie zadania: znika z widoku publicznego, nowe zapisy zablokowane.
    const internalCancelPath = `${tasksPath}/${internalTask.id}/cancel`;
    const taskCancelled = await client.call('POST', `${tasksPath}/${task.id}/cancel`, { cookie: A, body: { reason: 'Brak stoiska w tym roku' }, expect: 200 });
    assert.deepEqual([taskCancelled.body.replayed, Boolean(taskCancelled.body.task.cancelledAt), taskCancelled.body.task.cancellationReason], [false, true, 'Brak stoiska w tym roku']);
    assert.equal((await client.call('POST', `${tasksPath}/${task.id}/cancel`, { cookie: A, body: { reason: 'Inny powód odwołania' }, expect: 200 })).body.replayed, true);
    assert.equal((await client.call('POST', signupsPath, { cookie: A, body: { guardianId: 'h2-g1' }, key: key('sign'), expect: 409 })).body.error, 'event_cancelled');
    assert.deepEqual((await client.call('GET', '/api/public/events', { expect: 200 })).body.events[0].volunteerTasks, []);
    assert.equal((await client.call('POST', internalCancelPath, { cookie: A, body: { reason: 'Kontakt: rodzic@example.invalid' }, expect: 422 })).body.error, 'personal_data_forbidden');
    assert.equal((await client.call('POST', internalCancelPath, { cookie: A, body: { reason: 'ab' }, expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    assert.equal((await client.call('POST', `${tasksPath}/brak-zadania/cancel`, { cookie: A, body: { reason: 'Odwołanie syntetyczne' }, expect: 404 })).body.error, 'event_task_not_found');
    await assertRequiredFieldsEnforced(client, A, 'POST', internalCancelPath, { reason: 'Odwołanie syntetyczne' }, 'EventTaskCancelRequest');

    // ---------- Wydarzenie klasowe: zapisy przedstawiciela, rodzeństwo, czas poza wydarzeniem ----------
    const classBase = `/api/events/${classEvent.id}`;
    const classTask = (await client.call('POST', `${classBase}/tasks`, {
      cookie: R, body: { title: 'Dyżur przy grillu', slotsNeeded: 3, startsAt: '2026-11-12T12:00', endsAt: '2026-11-12T14:00' }, key: key('task'), expect: 201,
    })).body.task;
    const classCandidates = await client.call('GET', `${classBase}/tasks/candidates`, { cookie: R, expect: 200 });
    assert.deepEqual([classCandidates.body.classId, classCandidates.body.guardians.length], ['c-1a', 2]);
    assert.equal((await client.call('GET', `${classBase}/tasks/candidates?classId=c-1b`, { cookie: R, expect: 400 })).body.error, 'invalid_class');
    const classSignups = `${classBase}/tasks/${classTask.id}/signups`;
    // h1-g1: rodzeństwo w 1A i 1B — opiekun dziecka z klasy 1A; h2-g1: tylko dziecko z 1B.
    await client.call('POST', classSignups, { cookie: R, body: { guardianId: 'h1-g1' }, key: key('sign'), expect: 201 });
    assert.equal((await client.call('POST', classSignups, { cookie: R, body: { guardianId: 'h2-g1' }, key: key('sign'), expect: 400 })).body.error, 'guardian_outside_class');
    assert.equal((await client.call('POST', `${classBase}/tasks/${task.id}/signups`, { cookie: R, body: { guardianId: 'h1-g1' }, key: key('sign'), expect: 404 })).body.error, 'event_task_not_found', 'zadanie innego wydarzenia');
    // Zmiana czasu wydarzenia: zadanie zostaje, ale jest wykazane jako poza czasem.
    const classRevision = (await client.call('GET', classBase, { cookie: R, expect: 200 })).body.event.revision;
    const moved = await client.call('PATCH', classBase, { cookie: R, body: { revision: classRevision, endsAt: '2026-11-12T13:00' }, expect: 200 });
    assert.deepEqual(moved.body.tasksOutsideEventTime, [{ id: classTask.id, title: 'Dyżur przy grillu' }]);
    assert.equal(moved.body.event.status, 'draft', 'zmiana treści wraca do szkicu');
    const classTasks = await client.call('GET', `${classBase}/tasks`, { cookie: R, expect: 200 });
    assert.deepEqual(classTasks.body.tasks.map((item) => [item.id, item.outsideEventTime, item.confirmedCount]), [[classTask.id, true, 1]]);

    // ---------- Odwołanie wydarzenia ----------
    const cancelBody = { revision: moved.body.event.revision, reason: 'Prognoza burzy w dniu pikniku' };
    const cancelled = await client.call('POST', `${classBase}/cancel`, { cookie: R, body: cancelBody, expect: 200 });
    assert.deepEqual([cancelled.body.event.status, cancelled.body.event.cancellationReason, cancelled.body.replayed], ['cancelled', cancelBody.reason, false]);
    assert.equal((await client.call('POST', `${classBase}/cancel`, { cookie: R, body: cancelBody, expect: 200 })).body.replayed, true);
    assert.equal((await client.call('PATCH', classBase, { cookie: R, body: { revision: cancelBody.revision, title: 'Po odwołaniu' }, expect: 409 })).body.error, 'event_cancelled');
    assert.equal((await client.call('POST', `${classBase}/submit`, { cookie: R, body: { revision: cancelBody.revision }, expect: 409 })).body.error, 'event_cancelled');
    assert.equal((await client.call('POST', `${classBase}/tasks`, { cookie: R, body: { title: 'Nowe zadanie', slotsNeeded: 1 }, key: key('task'), expect: 409 })).body.error, 'event_cancelled');
    assert.equal((await client.call('POST', classSignups, { cookie: R, body: { guardianId: 'h1-g2' }, key: key('sign'), expect: 409 })).body.error, 'event_cancelled');
    const classSignupId = classTasks.body.tasks[0].signups[0].id;
    assert.equal((await client.call('POST', `${classSignups}/${classSignupId}/withdraw`, { cookie: R, expect: 200 })).body.signup.status, 'withdrawn', 'wycofanie po odwołaniu wydarzenia');

    // Opublikowane wydarzenie klasowe: przedstawiciel go nie odwołuje (403), zarząd tak; zostaje publicznie jako odwołane.
    const publicClass = await createEvent(R, { ...classBody, title: 'Jasełka klasy 1A', audience: 'public', startsAt: '2026-12-18T17:00', endsAt: '2026-12-18T18:30' });
    await step(R, publicClass.id, 'submit', 1);
    await step(B, publicClass.id, 'approve', 1);
    await step(B, publicClass.id, 'publish', 1);
    const publicClassTask = (await client.call('POST', `/api/events/${publicClass.id}/tasks`, {
      cookie: R, body: { title: 'Pomoc przy dekoracjach', slotsNeeded: 2, isPublic: true }, key: key('task'), expect: 201,
    })).body.task;
    const publicClassCancel = `/api/events/${publicClass.id}/cancel`;
    assert.equal((await client.call('POST', publicClassCancel, { cookie: R, body: { revision: 1, reason: 'Odwołanie przez klasę' }, expect: 403 })).body.error, 'forbidden');
    assert.equal((await client.call('POST', publicClassCancel, { cookie: B, body: { revision: 1, reason: 'Kontakt: rodzic@example.invalid' }, expect: 422 })).body.error, 'personal_data_forbidden');
    assert.equal((await client.call('POST', publicClassCancel, { cookie: B, body: { revision: 1, reason: 'ab' }, expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    await assertRequiredFieldsEnforced(client, B, 'POST', publicClassCancel, { revision: 1, reason: 'Choroba prowadzącej' }, 'EventCancelRequest');
    const beforeCancel = (await client.call('GET', '/api/public/events', { expect: 200 })).body.events.find((event) => event.id === publicClass.id);
    assert.deepEqual(beforeCancel.volunteerTasks, [{ id: publicClassTask.id, title: 'Pomoc przy dekoracjach', stillNeeded: 2 }]);
    await step(B, publicClass.id, 'cancel', 1, { reason: 'Choroba prowadzącej' });
    const afterCancel = (await client.call('GET', '/api/public/events', { expect: 200 })).body.events.find((event) => event.id === publicClass.id);
    assert.deepEqual([afterCancel.status, afterCancel.volunteerTasks], ['cancelled', []]);
    assert.doesNotMatch(JSON.stringify(afterCancel), /Choroba/, 'powód odwołania tylko wewnętrznie');

    // ---------- Lista publiczna z kursorem ----------
    for (const [day, title] of [['01-20', 'Bal karnawałowy'], ['03-12', 'Dzień otwarty'], ['06-19', 'Festyn rodzinny']]) {
      const event = await createEvent(A, { schoolYearId: YEAR, title, startsAt: `2027-${day}T15:00`, audience: 'public' });
      await step(A, event.id, 'submit', 1);
      await step(B, event.id, 'approve', 1);
      await step(B, event.id, 'publish', 1);
    }
    const all = await client.call('GET', `/api/public/events?schoolYearId=${YEAR}`, { expect: 200 });
    assert.deepEqual([all.body.events.length, all.body.nextCursor, all.body.truncated, all.body.limit], [5, null, false, 100]);
    const pages = [];
    let cursor = null;
    let page;
    do {
      page = await client.call('GET', `/api/public/events?schoolYearId=${YEAR}&limit=2${cursor ? `&cursor=${cursor}` : ''}`, { expect: 200 });
      pages.push(...page.body.events.map((event) => event.id));
      assert.equal(page.body.truncated, page.body.nextCursor !== null);
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.deepEqual(pages, all.body.events.map((event) => event.id), 'strony po 2 = ta sama kolejność co jedna strona');
    const firstPage = await client.call('GET', `/api/public/events?schoolYearId=${YEAR}&limit=2`, { expect: 200 });
    assert.equal((await client.call('GET', `/api/public/events?limit=2&cursor=${firstPage.body.nextCursor}`, { expect: 400 })).body.error, 'invalid_cursor', 'kursor innego filtru');
    assert.deepEqual((await client.call('GET', '/api/public/events?from=2027-03-01', { expect: 200 })).body.events.map((event) => event.title), ['Dzień otwarty', 'Festyn rodzinny']);
    const publicErrors = [
      ['?limit=0', 'invalid_limit'], ['?limit=500', 'invalid_limit'], ['?limit=abc', 'invalid_limit'], ['?cursor=%21%21', 'invalid_cursor'],
      ['?from=2027-3-1', 'invalid_date'], ['?from=2027-02-30', 'invalid_datetime'], ['?schoolYearId=%21', 'invalid_school_year'],
    ];
    for (const [query, code] of publicErrors) {
      assert.equal((await client.call('GET', `/api/public/events${query}`, { expect: 400 })).body.error, code, query);
    }

    // ---------- Granice ról ----------
    const repBEvent = await createEvent(cookies.repB, { ...classBody, classId: 'c-1b', title: 'Wycieczka klasy 1B' });
    const reads = [`/api/events?schoolYearId=${YEAR}`, base, `${base}/tasks`, `${base}/tasks/candidates?classId=c-1a`];
    for (const path of reads) {
      await client.call('GET', path, { expect: 401 });
      assert.equal((await client.call('GET', path, { cookie: cookies.boardNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required', path);
    }
    // Przedstawiciel 1A: wydarzenie ogólnoszkolne i klasy 1B jak nieistniejące (SR-07).
    for (const path of [base, `${base}/tasks`, `/api/events/${repBEvent.id}`, `/api/events/${repBEvent.id}/tasks/candidates`]) {
      assert.equal((await client.call('GET', path, { cookie: R, expect: 404 })).body.error, 'event_not_found', path);
    }
    // Zarząd z przydziałem klasy, Komisja Rewizyjna, dyrekcja, skarbnik: bez dostępu wewnętrznego (D-08/D-09).
    for (const cookie of [cookies.boardClass, cookies.audit, cookies.principal, cookies.treasurer]) {
      assert.equal((await client.call('GET', `/api/events?schoolYearId=${YEAR}`, { cookie, expect: 403 })).body.error, 'forbidden');
      for (const path of [base, `${base}/tasks`, `/api/events/${repBEvent.id}`]) {
        assert.equal((await client.call('GET', path, { cookie, expect: 404 })).body.error, 'event_not_found', path);
      }
    }
    const currentRevision = (await client.call('GET', base, { cookie: A, expect: 200 })).body.event.revision;
    const writes = [
      ['POST', '/api/events', { ...schoolBody, title: 'Wydarzenie spoza zakresu' }, true, 403],
      ['PATCH', base, { revision: currentRevision, title: 'Zmiana spoza zakresu' }, false, 404],
      ['POST', `${base}/submit`, { revision: currentRevision }, false, 404],
      ['POST', `${base}/approve`, { revision: currentRevision }, false, 404],
      ['POST', `${base}/cancel`, { revision: currentRevision, reason: 'Odwołanie spoza zakresu' }, false, 404],
      ['POST', `${base}/tasks`, { title: 'Zadanie spoza zakresu', slotsNeeded: 1 }, true, 404],
      ['POST', `${base}/tasks/${internalTask.id}/signups`, { guardianId: 'h1-g1' }, true, 404],
      ['POST', `${base}/tasks/${internalTask.id}/cancel`, { reason: 'Odwołanie spoza zakresu' }, false, 404],
      ['POST', `${signupsPath}/${first.body.signup.id}/withdraw`, undefined, false, 404],
    ];
    for (const [method, path, body, keyed, denied] of writes) {
      const withKey = () => (keyed ? key('deny') : undefined);
      await client.call(method, path, { body, key: withKey(), expect: 401 });
      for (const cookie of [R, cookies.boardClass, cookies.audit, cookies.principal, cookies.treasurer]) {
        const response = await client.call(method, path, { cookie, body, key: withKey(), expect: denied });
        assert.equal(response.body.error, denied === 403 ? 'forbidden' : 'event_not_found', `${method} ${path}`);
      }
      assert.equal((await client.call(method, path, { cookie: cookies.boardNoMfa, body, key: withKey(), expect: 403 })).body.error, 'mfa_enrollment_required', path);
      assert.equal((await client.call(method, path, { cookie: A, body, key: withKey(), expect: 403, origin: FOREIGN })).body.error, 'invalid_origin', path);
    }
    // Wymóg MFA modułu (#150), gdy bramka routera nie wymaga zapisu czynnika (MFA_REQUIRED_ROLES puste):
    // szkic i zgłoszenie bez MFA działają, zatwierdzenie i publikacja — 403 mfa_required.
    const noGate = newClient({ ...env, MFA_REQUIRED_ROLES: '' });
    const noMfaEvent = (await noGate.call('POST', '/api/events', { cookie: cookies.boardNoMfa, body: { ...schoolBody, title: 'Szkic bez MFA' }, key: key('evt'), expect: 201 })).body.event;
    await noGate.call('POST', `/api/events/${noMfaEvent.id}/submit`, { cookie: cookies.boardNoMfa, body: { revision: 1 }, expect: 200 });
    for (const action of ['approve', 'publish']) {
      assert.equal((await noGate.call('POST', `/api/events/${noMfaEvent.id}/${action}`, { cookie: cookies.boardNoMfa, body: { revision: 1 }, expect: 403 })).body.error, 'mfa_required', action);
    }
    for (const item of noGate.validated) validated.add(item);

    // ---------- Błędy 400/404/413/415 ----------
    assert.equal((await client.call('GET', '/api/events/%21', { cookie: A, expect: 400 })).body.error, 'invalid_event_id');
    assert.equal((await client.call('GET', '/api/events/brak-wydarzenia', { cookie: A, expect: 404 })).body.error, 'event_not_found');
    assert.equal((await client.call('GET', '/api/events/brak-wydarzenia/tasks', { cookie: A, expect: 404 })).body.error, 'event_not_found');
    assert.equal((await client.call('PATCH', '/api/events/brak-wydarzenia', { cookie: A, body: { revision: 1, title: 'Brak wydarzenia' }, expect: 404 })).body.error, 'event_not_found');
    assert.equal((await client.call('POST', '/api/events/%21/submit', { cookie: A, body: { revision: 1 }, expect: 400 })).body.error, 'invalid_event_id');
    assert.equal((await client.call('POST', `${tasksPath}/%21/cancel`, { cookie: A, body: { reason: 'Odwołanie syntetyczne' }, expect: 400 })).body.error, 'invalid_event_id', 'zły identyfikator zadania');
    assert.equal((await client.call('POST', `${signupsPath}/%21/withdraw`, { cookie: A, expect: 400 })).body.error, 'invalid_event_id', 'zły identyfikator zapisu');
    const json = { 'Content-Type': 'application/json' };
    assert.equal((await client.call('POST', '/api/events', { cookie: A, headers: json, body: '{"title":', key: key('evt'), expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', `${base}/submit`, { cookie: A, headers: json, body: '', expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', '/api/events', {
      cookie: A, body: { ...schoolBody, description: 'x'.repeat(17 * 1024) }, key: key('evt'), expect: 413, invalidRequest: true,
    })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', tasksPath, { cookie: A, body: 'title=x', key: key('task'), expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: 'title=x', expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');

    // ---------- Zamknięty rok: zamknięcie przez trasy year-close, potem 409 ----------
    // Zamknięcie wygasza przydziały roku; zapisy próbuje zarząd z przydziałem bez roku.
    const openTask = (await client.call('POST', `/api/events/${repBEvent.id}/tasks`, { cookie: A, body: { title: 'Opieka w autokarze', slotsNeeded: 2 }, key: key('task'), expect: 201 })).body.task;
    const openSignup = (await client.call('POST', `/api/events/${repBEvent.id}/tasks/${openTask.id}/signups`, { cookie: A, body: { guardianId: 'h2-g1' }, key: key('sign'), expect: 201 })).body.signup;
    await closeYear(env, cookies);
    const G = cookies.boardGlobal;
    const openBase = `/api/events/${repBEvent.id}`;
    const closedWrites = [
      ['POST', '/api/events', { ...schoolBody, title: 'Wydarzenie w zamkniętym roku' }, true],
      ['PATCH', openBase, { revision: 1, title: 'Zmiana w zamkniętym roku' }, false],
      ['POST', `${openBase}/submit`, { revision: 1 }, false],
      ['POST', `${openBase}/cancel`, { revision: 1, reason: 'Odwołanie w zamkniętym roku' }, false],
      ['POST', `${openBase}/tasks`, { title: 'Zadanie w zamkniętym roku', slotsNeeded: 1 }, true],
      ['POST', `${openBase}/tasks/${openTask.id}/signups`, { guardianId: 'h1-g1' }, true],
      ['POST', `${openBase}/tasks/${openTask.id}/signups/${openSignup.id}/withdraw`, undefined, false],
    ];
    for (const [method, path, body, keyed] of closedWrites) {
      const response = await client.call(method, path, { cookie: G, body, key: keyed ? key('closed') : undefined, expect: 409 });
      assert.equal(response.body.error, 'school_year_closed', `${method} ${path}`);
    }
    // Stan obecny (rozbieżność opisana w docs/API.md, etap 9): trigger zamrożenia roku obejmuje tylko INSERT do event_tasks,
    // więc odwołanie zadania (UPDATE) w zamkniętym roku przechodzi.
    const lateCancel = await client.call('POST', `${openBase}/tasks/${openTask.id}/cancel`, { cookie: G, body: { reason: 'Odwołanie po zamknięciu roku' }, expect: 200 });
    assert.deepEqual([lateCancel.body.replayed, Boolean(lateCancel.body.task.cancelledAt)], [false, true]);
    assert.equal((await client.call('GET', `${openBase}/tasks`, { cookie: G, expect: 200 })).body.tasks[0].confirmedCount, 1, 'odczyt w zamkniętym roku działa');
    assert.ok((await publicIds(`?schoolYearId=${YEAR}`)).includes(school.id), 'publiczny kalendarz zamkniętego roku nadal działa');
    assert.equal((await client.call('GET', `/api/events?schoolYearId=${YEAR}`, { cookie: A, expect: 403 })).body.error, 'forbidden', 'przydział roku wygasł');

    assert.equal(networkGuardCalls(), 0, 'żadnej próby połączenia z siecią');
    assertSuccessCoverage(validated);
  } finally {
    await db.close();
  }
});
