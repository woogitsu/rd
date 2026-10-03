// Kontrakt API (#160, etap 7): prawdziwe odpowiedzi modułu `meetings` (PGlite, dane syntetyczne
// `@example.invalid`) walidowane schematami z docs/openapi.json (src/pg/schemas/meetings.js) przez
// tests/helpers/contract-client.js. Rejestr pokrycia i katalog kodów sprawdza
// tests/openapi-contract.test.js (wspólnie dla wszystkich pokrytych modułów).
//
// ŻADNEJ SIECI I ŻADNEJ WYSYŁKI: z zawiadomienia powstaje wyłącznie szkic kampanii e-mail (`sent: false`),
// test nie zatwierdza ani nie kolejkuje kampanii, a globalna pułapka sieci (tests/helpers/network-guard.js)
// liczy próby połączeń — licznik musi być 0.
//
// Przebieg: zebranie ogólne, zarządu i klasowe (utworzenie z kluczem, ponowienie, lista z kursorem), edycja
// z rewizją (`revision_conflict`), porządek obrad z kolejnością i wycofaniem punktu, zawiadomienia (cztery oczy,
// szkic kampanii bez wysyłki dla rodzin, klasy i kont zarządu, plik kalendarza, `notice_outdated` po zmianie
// terminu i kolejności, publiczne zawiadomienia z kursorem), zmiana terminu i odwołanie z powodem, lista obecności
// z dwojgiem opiekunów jednego dziecka, quorum (także nieaktualne po zmianie obecności), uchwały z wersjami
// (edycja projektu, rozstrzygnięcie, korekta jako nowa rewizja, uchwała zmieniająca, rejestr, wyszukanie po
// numerze, wykonanie), protokół (cztery oczy, otwarte projekty, nie najnowsza wersja, blokada zebrania,
// widoczność, publiczne protokoły), granice ról (401; przedstawiciel klasy przy zebraniu innej klasy; zarząd
// z przydziałem klasy; Komisja Rewizyjna i dyrekcja — odczyt z listą obecności jak KR, bez zapisu; brak MFA
// w bramce routera i w module; obcy Origin), błędy 400/404/409/413/415/422 i zamknięty rok osiągnięty trasami
// year-close (bez obchodzenia triggerów).
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
const DAY = 86400000;
// Terminy względem zegara testu: zawiadomienie odnotowuje liczbę dni do zebrania.
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();
const QUORUM = { quorumMode: 'minimum_count', quorumMinCount: 2, quorumRuleSource: 'Regulamin syntetyczny, par. 5' };
const MINUTES_BODY = 'Protokół zebrania ogólnego: omówiono plan wydarzeń szkolnych i budżet roku.';

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

function newClient(env) {
  return createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
}

// Każda odpowiedź sukcesu opisana w schemacie modułu została zwalidowana na prawdziwej odpowiedzi.
function assertSuccessCoverage(validated) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (entry.module !== 'meetings') continue;
    for (const status of Object.keys(entry.responses)) expected.push(`${routeId} ${status}`);
  }
  assert.ok(expected.length >= 38, `oczekiwane odpowiedzi: ${expected.length}`);
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
  // Podpowiedź numeru uchwały (D-15 nie jest rozstrzygnięte; wzorzec syntetyczny tylko w teście).
  await db.query("UPDATE school_years SET resolution_number_pattern = 'U-{seq}/{year}' WHERE id = $1", [YEAR]);
  const year = (role, extra = {}) => [{ role, schoolYearId: YEAR, ...extra }];
  const both = (role) => [{ role, schoolYearId: YEAR }, { role, schoolYearId: NEXT }];
  const cookies = {
    boardA: await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: both('board') }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', mfa: true, roles: both('board') }),
    // Przydział zarządu bez roku: zapisy po zamknięciu roku (przydziały roku wygasają przy zamknięciu).
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', mfa: true, roles: [{ role: 'board' }] }),
    boardClass: await seedUserSession(db, { userId: 'u-board-class', mfa: true, roles: year('board', { classId: 'c-1a' }) }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', mfa: false, roles: year('board') }),
    repA: await seedUserSession(db, { userId: 'u-rep-a', mfa: true, roles: year('representative', { classId: 'c-1a' }) }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: year('treasurer') }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: year('audit') }),
    // Dyrekcja: odczyt jak Komisja Rewizyjna, bez MFA (docs/DECISIONS.md, wskazanie 2026-10-02, D-09).
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

test('specyfikacja zebrań: klucz idempotencji tylko przy zapisach z kluczem, przejścia stanu bez nagłówka ponowienia', () => {
  const operation = (method, path) => spec.paths[path][method];
  const hasKey = (op) => op.parameters.some((p) => p.in === 'header' && p.name === 'Idempotency-Key' && p.required === true);
  const replayedEnum = (op, status) => op.responses[status].headers?.['Idempotency-Replayed']?.schema.enum ?? null;
  const keyed = [
    '/api/meetings', '/api/meetings/{meetingId}/agenda-items', '/api/meetings/{meetingId}/quorum-checks',
    '/api/meetings/{meetingId}/minutes', '/api/meetings/{meetingId}/minutes/{minutesId}/visibility',
    '/api/meetings/{meetingId}/resolutions', '/api/meetings/{meetingId}/resolutions/{resolutionId}/corrections',
    '/api/meetings/resolutions/{resolutionId}/execution',
  ];
  for (const path of keyed) {
    const op = operation('post', path);
    assert.equal(hasKey(op), true, path);
    assert.deepEqual([replayedEnum(op, '201'), replayedEnum(op, '200')], [['false'], ['true']], path);
  }
  // Szkic zawiadomienia i kampanii: bez klucza, ale z nagłówkiem (stan obiektu rozpoznaje ponowienie).
  for (const path of ['/api/meetings/{meetingId}/notices', '/api/meetings/{meetingId}/notices/{noticeId}/campaign-draft']) {
    const op = operation('post', path);
    assert.equal(hasKey(op), false, path);
    assert.deepEqual([replayedEnum(op, '201'), replayedEnum(op, '200')], [['false'], ['true']], path);
  }
  // Przejścia stanu: 200 bez nagłówka, ponowienie w polu `replayed` treści.
  for (const path of [
    '/api/meetings/{meetingId}/cancellation', '/api/meetings/{meetingId}/reschedule', '/api/meetings/{meetingId}/agenda-order',
    '/api/meetings/{meetingId}/agenda-items/{itemId}/withdrawal', '/api/meetings/{meetingId}/notices/{noticeId}/approval',
    '/api/meetings/{meetingId}/minutes/{minutesId}/approval',
  ]) {
    const op = operation('post', path);
    assert.equal(hasKey(op), false, path);
    assert.equal(replayedEnum(op, '200'), null, path);
    const schema = op.responses['200'].content['application/json'].schema;
    assert.ok(schema.required.includes('replayed'), path);
  }
  assert.deepEqual(Object.keys(operation('get', '/api/meetings/{meetingId}/notices/{noticeId}/calendar').responses['200'].content), ['text/calendar; charset=utf-8']);
  assert.deepEqual(spec.paths['/api/meetings/public-notices'].get.security, []);
  assert.deepEqual(spec.paths['/api/meetings/public-minutes'].get.security, []);
});

test('kontrakt modułu meetings: prawdziwe odpowiedzi zebrań, porządku, zawiadomień, obecności, uchwał i protokołów zgodne ze schematami', async () => {
  const { db, env, cookies, client } = await world();
  const A = cookies.boardA;
  const B = cookies.boardB;
  const validated = client.validated;
  try {
    const createMeeting = async (cookie, body) => (await client.call('POST', '/api/meetings', { cookie, body, key: key('mtg'), expect: 201 })).body.meeting;
    const getMeeting = async (id, cookie = A) => (await client.call('GET', `/api/meetings/${id}`, { cookie, expect: 200 })).body;
    const addItem = async (id, title, extra = {}) => (await client.call('POST', `/api/meetings/${id}/agenda-items`, {
      cookie: A, body: { title, ...extra }, key: key('item'), expect: 201,
    })).body.agendaItem;

    // ---------- Zebranie ogólne: utworzenie, ponowienie, konflikt klucza, błędy reguł ----------
    const plenaryBody = {
      schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie ogólne jesienne', scheduledAt: inDays(30), location: 'Aula',
      status: 'scheduled', noticeMinDays: 7, noticeRuleSource: 'Regulamin syntetyczny, par. 4', ...QUORUM,
    };
    const plenaryKey = key('mtg');
    const created = await client.call('POST', '/api/meetings', { cookie: A, body: plenaryBody, key: plenaryKey, expect: 201 });
    assert.equal(created.headers.get('Idempotency-Replayed'), 'false');
    const plenary = created.body.meeting;
    assert.deepEqual([plenary.kind, plenary.status, plenary.revisionNo, plenary.classId, plenary.noticeRule.minDays], ['plenary', 'scheduled', 1, null, 7]);
    const replay = await client.call('POST', '/api/meetings', { cookie: A, body: plenaryBody, key: plenaryKey, expect: 200 });
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(replay.body, created.body);
    assert.equal((await client.call('POST', '/api/meetings', { cookie: A, body: { ...plenaryBody, title: 'Inny tytuł zebrania' }, key: plenaryKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', '/api/meetings', { cookie: A, body: plenaryBody, expect: 400 })).body.error, 'invalid_idempotency_key');
    const ruleErrors = [
      [{ ...plenaryBody, quorumRuleSource: null }, 'quorum_rule_source_required'],
      [{ ...plenaryBody, quorumMode: 'fraction', quorumNumerator: 1, quorumDenominator: 2, quorumInclusive: true }, 'invalid_quorum_rule'],
      [{ ...plenaryBody, noticeRuleSource: null }, 'invalid_notice_rule'],
      [{ ...plenaryBody, kind: 'class' }, 'invalid_request'],
      [{ ...plenaryBody, kind: 'class', classId: 'c-brak' }, 'invalid_reference'],
    ];
    for (const [body, code] of ruleErrors) {
      assert.equal((await client.call('POST', '/api/meetings', { cookie: A, body, key: key('mtg'), expect: 400 })).body.error, code);
    }
    assert.equal((await client.call('POST', '/api/meetings', { cookie: A, body: { ...plenaryBody, scheduledAt: '2026-11-05 18:00' }, key: key('mtg'), expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    await assertRequiredFieldsEnforced(client, A, 'POST', '/api/meetings', plenaryBody, 'MeetingCreateRequest', { withKey: true });

    // Zebranie zarządu i zebranie klasowe 1B (zakres przedstawiciela 1A go nie obejmuje).
    const board = await createMeeting(A, { schoolYearId: YEAR, kind: 'board', title: 'Zebranie zarządu', scheduledAt: inDays(14), status: 'scheduled' });
    const classB = await createMeeting(A, { schoolYearId: YEAR, kind: 'class', classId: 'c-1b', title: 'Zebranie klasy 1B', scheduledAt: inDays(21), status: 'scheduled' });
    assert.deepEqual([board.kind, classB.classId], ['board', 'c-1b']);

    // ---------- Edycja z rewizją (#215) ----------
    const base = `/api/meetings/${plenary.id}`;
    const edited = await client.call('PATCH', base, { cookie: A, body: { revision: 1, title: 'Zebranie ogólne jesienne (sala A)', location: 'Sala A' }, expect: 200 });
    assert.equal(edited.body.meeting.revisionNo, 2);
    const sameEdit = await client.call('PATCH', base, { cookie: A, body: { revision: 1, title: 'Zebranie ogólne jesienne (sala A)', location: 'Sala A' }, expect: 200 });
    assert.equal(sameEdit.body.meeting.revisionNo, 2, 'ta sama edycja (podwójne kliknięcie) bez nowej wersji');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 1, title: 'Zmiana na starej wersji' }, expect: 409 })).body.error, 'revision_conflict');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { title: 'Bez wersji' }, expect: 400, invalidRequest: true })).body.error, 'invalid_revision');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 2 }, expect: 400 })).body.error, 'invalid_request');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 2, status: 'archived' }, expect: 409 })).body.error, 'meeting_status_transition_invalid');
    await assertRequiredFieldsEnforced(client, A, 'PATCH', base, { revision: 2, title: 'Zebranie ogólne jesienne (sala A)' }, 'MeetingUpdateRequest');

    // ---------- Porządek obrad: punkty, bramka danych osobowych, wycofanie, kolejność ----------
    const itemKey = key('item');
    const itemBody = { title: 'Sprawozdanie zarządu', description: 'Podsumowanie poprzedniego roku.' };
    const item1 = (await client.call('POST', `${base}/agenda-items`, { cookie: A, body: itemBody, key: itemKey, expect: 201 })).body.agendaItem;
    const itemReplay = await client.call('POST', `${base}/agenda-items`, { cookie: A, body: itemBody, key: itemKey, expect: 200 });
    assert.deepEqual([itemReplay.body.agendaItem.id, itemReplay.headers.get('Idempotency-Replayed')], [item1.id, 'true']);
    const item2 = await addItem(plenary.id, 'Plan wydarzeń');
    const item3 = await addItem(plenary.id, 'Wolne wnioski');
    assert.deepEqual([item1.position, item2.position, item3.position], [1, 2, 3]);
    assert.equal((await client.call('POST', `${base}/agenda-items`, {
      cookie: A, body: { title: 'Punkt z adresem', description: 'Kontakt: rodzic@example.invalid' }, key: key('item'), expect: 422,
    })).body.error, 'personal_data_forbidden');
    assert.equal((await client.call('POST', `${base}/agenda-items`, { cookie: A, body: { title: 'Pozycja zajęta', position: 1 }, key: key('item'), expect: 409 })).body.error, 'agenda_position_taken');
    await assertRequiredFieldsEnforced(client, A, 'POST', `${base}/agenda-items`, itemBody, 'MeetingAgendaItemRequest', { withKey: true });

    const withdrawn = await client.call('POST', `${base}/agenda-items/${item3.id}/withdrawal`, { cookie: A, body: {}, expect: 200 });
    assert.equal(withdrawn.body.replayed, false);
    assert.ok(withdrawn.body.agendaItem.withdrawnAt);
    assert.equal((await client.call('POST', `${base}/agenda-items/${item3.id}/withdrawal`, { cookie: A, body: {}, expect: 200 })).body.replayed, true);
    assert.equal((await client.call('POST', `${base}/agenda-items/brak-punktu/withdrawal`, { cookie: A, body: {}, expect: 404 })).body.error, 'agenda_item_not_found');
    assert.equal((await client.call('POST', `${base}/agenda-items/%21/withdrawal`, { cookie: A, body: {}, expect: 400 })).body.error, 'invalid_agenda_item_id');

    // ---------- Zawiadomienie: szkic, cztery oczy, szkic kampanii bez wysyłki, kalendarz ----------
    const noticeDraft = await client.call('POST', `${base}/notices`, { cookie: A, body: {}, expect: 201 });
    assert.equal(noticeDraft.headers.get('Idempotency-Replayed'), 'false');
    const notice1 = noticeDraft.body.notice;
    assert.deepEqual([notice1.kind, notice1.status, notice1.version, notice1.isLatest, notice1.outdated], ['invitation', 'draft', 1, true, false]);
    const noticeAgain = await client.call('POST', `${base}/notices`, { cookie: A, body: {}, expect: 200 });
    assert.deepEqual([noticeAgain.body.notice.id, noticeAgain.headers.get('Idempotency-Replayed')], [notice1.id, 'true']);
    const approvePath = (noticeId) => `${base}/notices/${noticeId}/approval`;
    assert.equal((await client.call('POST', approvePath(notice1.id), { cookie: A, body: {}, expect: 403 })).body.error, 'notice_four_eyes_required');
    assert.equal((await client.call('POST', `${base}/notices/${notice1.id}/campaign-draft`, { cookie: A, body: {}, expect: 409 })).body.error, 'notice_not_approved');
    assert.equal((await client.call('GET', `${base}/notices/${notice1.id}/calendar`, { cookie: A, expect: 409 })).body.error, 'notice_calendar_unavailable');
    const approved1 = await client.call('POST', approvePath(notice1.id), { cookie: B, body: {}, expect: 200 });
    assert.deepEqual([approved1.body.notice.status, approved1.body.notice.approvedBy, approved1.body.notice.noticeLate, approved1.body.replayed], ['approved', 'u-board-b', false, false]);
    assert.equal(approved1.headers.get('Idempotency-Replayed'), null, 'zatwierdzenie bez nagłówka ponowienia');
    assert.equal((await client.call('POST', approvePath(notice1.id), { cookie: B, body: {}, expect: 200 })).body.replayed, true);
    assert.equal((await client.call('POST', `${base}/notices`, { cookie: A, body: {}, expect: 409 })).body.error, 'notice_up_to_date');
    assert.equal((await client.call('POST', approvePath('brak-zawiadomienia'), { cookie: B, body: {}, expect: 404 })).body.error, 'notice_not_found');

    const campaignPath = `${base}/notices/${notice1.id}/campaign-draft`;
    const campaign = await client.call('POST', campaignPath, { cookie: A, body: {}, expect: 201 });
    assert.deepEqual(campaign.body, { campaign: { id: campaign.body.campaign.id, status: 'draft', audience: 'all_households', classId: null }, sent: false });
    const campaignAgain = await client.call('POST', campaignPath, { cookie: A, body: {}, expect: 200 });
    assert.deepEqual([campaignAgain.body.campaign.id, campaignAgain.headers.get('Idempotency-Replayed')], [campaign.body.campaign.id, 'true']);
    const { rows: outbox } = await db.query('SELECT count(*)::int AS n FROM email_outbox');
    assert.equal(outbox[0].n, 0, 'szkic kampanii niczego nie kolejkuje');

    const calendar = await client.call('GET', `${base}/notices/${notice1.id}/calendar`, { cookie: A, expect: 200 });
    assert.match(new TextDecoder().decode(calendar.bytes), /BEGIN:VCALENDAR[\s\S]*SEQUENCE:1/);
    assert.equal(calendar.headers.get('Cache-Control'), 'private, no-store');

    // ---------- Zmiana terminu po zatwierdzonym zawiadomieniu ----------
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 2, scheduledAt: inDays(35) }, expect: 409 })).body.error, 'use_reschedule_endpoint');
    const rescheduleBody = { scheduledAt: inDays(40), reason: 'Sala zajęta w pierwotnym terminie', revision: 2 };
    const rescheduled = await client.call('POST', `${base}/reschedule`, { cookie: A, body: rescheduleBody, expect: 200 });
    assert.deepEqual([rescheduled.body.replayed, rescheduled.body.rescheduleNotice.kind, rescheduled.body.rescheduleNotice.status], [false, 'reschedule', 'draft']);
    assert.equal(rescheduled.body.meeting.scheduledAt, rescheduleBody.scheduledAt);
    const rescheduledAgain = await client.call('POST', `${base}/reschedule`, { cookie: A, body: rescheduleBody, expect: 200 });
    assert.deepEqual([rescheduledAgain.body.replayed, rescheduledAgain.body.rescheduleNotice], [true, null]);
    assert.equal((await client.call('POST', `${base}/reschedule`, { cookie: A, body: { ...rescheduleBody, reason: 'Inny powód tej samej daty' }, expect: 409 })).body.error, 'reschedule_no_change');
    assert.equal((await client.call('POST', `${base}/reschedule`, { cookie: A, body: { ...rescheduleBody, scheduledAt: inDays(41) }, expect: 409 })).body.error, 'revision_conflict');
    assert.equal((await client.call('POST', `${base}/reschedule`, { cookie: A, body: { ...rescheduleBody, reason: 'ab' }, expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    await assertRequiredFieldsEnforced(client, A, 'POST', `${base}/reschedule`, rescheduleBody, 'MeetingRescheduleRequest');

    // Kampania z zawiadomienia v1 jest teraz nieaktualna (podgląd modułu e-mail ostrzega, nic nie wychodzi).
    const preview = await client.call('GET', `/api/email/campaigns/${campaign.body.campaign.id}/preview`, { cookie: A, expect: 200 });
    assert.ok(preview.body.warnings.includes('notice_outdated'), JSON.stringify(preview.body.warnings));

    // Kolejność punktów zmienia porządek po sporządzeniu szkicu zmiany terminu → szkic nieaktualny.
    const orderPath = `${base}/agenda-order`;
    const reordered = await client.call('POST', orderPath, { cookie: A, body: { itemIds: [item2.id, item1.id] }, expect: 200 });
    assert.equal(reordered.body.replayed, false);
    assert.deepEqual(reordered.body.agenda.map((item) => [item.id, item.position]), [[item2.id, 1], [item1.id, 2], [item3.id, 3]]);
    assert.equal((await client.call('POST', orderPath, { cookie: A, body: { itemIds: [item2.id, item1.id] }, expect: 200 })).body.replayed, true);
    for (const itemIds of [[item1.id], [item1.id, item2.id, item3.id], [item1.id, item1.id]]) {
      assert.equal((await client.call('POST', orderPath, { cookie: A, body: { itemIds }, expect: 400 })).body.error, 'invalid_agenda_order');
    }
    await assertRequiredFieldsEnforced(client, A, 'POST', orderPath, { itemIds: [item2.id, item1.id] }, 'MeetingAgendaOrderRequest');
    const notice2 = rescheduled.body.rescheduleNotice;
    assert.equal((await client.call('POST', approvePath(notice2.id), { cookie: B, body: {}, expect: 409 })).body.error, 'notice_outdated');
    assert.equal((await client.call('POST', approvePath(notice1.id), { cookie: B, body: {}, expect: 200 })).body.replayed, true, 'zatwierdzona wersja: ponowienie bez zmiany');
    const viewOutdated = await getMeeting(plenary.id);
    assert.deepEqual(viewOutdated.notices.map((notice) => [notice.version, notice.status, notice.outdated, notice.isLatest]),
      [[1, 'approved', true, false], [2, 'draft', true, true]]);
    assert.equal(viewOutdated.reschedules[0].reason, rescheduleBody.reason);
    // Aktualna wersja (update) i jej zatwierdzenie; kalendarz starszej wersji przestaje być dostępny.
    const notice3 = (await client.call('POST', `${base}/notices`, { cookie: A, body: {}, expect: 201 })).body.notice;
    assert.deepEqual([notice3.kind, notice3.version], ['update', 3]);
    assert.equal((await client.call('POST', approvePath(notice2.id), { cookie: B, body: {}, expect: 409 })).body.error, 'notice_not_latest');
    await client.call('POST', approvePath(notice3.id), { cookie: B, body: {}, expect: 200 });
    assert.equal((await client.call('GET', `${base}/notices/${notice1.id}/calendar`, { cookie: A, expect: 409 })).body.error, 'notice_calendar_unavailable');
    await client.call('GET', `${base}/notices/${notice3.id}/calendar`, { cookie: cookies.audit, expect: 200 });

    // ---------- Zawiadomienia zebrania zarządu (konta) i klasy (rodziny klasy) ----------
    const boardBase = `/api/meetings/${board.id}`;
    await addItem(board.id, 'Wydatki pierwszego okresu');
    const boardNotice = (await client.call('POST', `${boardBase}/notices`, { cookie: A, body: {}, expect: 201 })).body.notice;
    await client.call('POST', `${boardBase}/notices/${boardNotice.id}/approval`, { cookie: B, body: {}, expect: 200 });
    const boardCampaign = await client.call('POST', `${boardBase}/notices/${boardNotice.id}/campaign-draft`, { cookie: A, body: {}, expect: 201 });
    assert.deepEqual([boardCampaign.body.campaign.audience, boardCampaign.body.campaign.classId, boardCampaign.body.sent], ['meeting_invitees', null, false]);
    const classBase = `/api/meetings/${classB.id}`;
    assert.equal((await client.call('POST', `${classBase}/notices`, { cookie: A, body: {}, expect: 409 })).body.error, 'notice_requires_agenda');
    await addItem(classB.id, 'Wycieczka klasowa');
    const classNotice = (await client.call('POST', `${classBase}/notices`, { cookie: A, body: {}, expect: 201 })).body.notice;
    await client.call('POST', `${classBase}/notices/${classNotice.id}/approval`, { cookie: B, body: {}, expect: 200 });
    const classCampaign = await client.call('POST', `${classBase}/notices/${classNotice.id}/campaign-draft`, { cookie: A, body: {}, expect: 201 });
    assert.deepEqual([classCampaign.body.campaign.audience, classCampaign.body.campaign.classId], ['class_households', 'c-1b']);

    // ---------- Odwołanie z powodem (drugie zebranie ogólne z zatwierdzonym zawiadomieniem) ----------
    const second = await createMeeting(A, { schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie ogólne wiosenne', scheduledAt: inDays(60), status: 'scheduled' });
    const secondBase = `/api/meetings/${second.id}`;
    await addItem(second.id, 'Wybory uzupełniające');
    const secondNotice = (await client.call('POST', `${secondBase}/notices`, { cookie: A, body: {}, expect: 201 })).body.notice;
    await client.call('POST', `${secondBase}/notices/${secondNotice.id}/approval`, { cookie: B, body: {}, expect: 200 });

    // Publiczne zawiadomienia: wyłącznie zebrania ogólne, kursor keyset (bez zarządu i klasy).
    const pub1 = await client.call('GET', `/api/meetings/public-notices?schoolYearId=${YEAR}&limit=1`, { expect: 200 });
    assert.deepEqual([pub1.body.notices.length, pub1.body.truncated, pub1.body.limit], [1, true, 1]);
    const pub2 = await client.call('GET', `/api/meetings/public-notices?schoolYearId=${YEAR}&limit=1&cursor=${encodeURIComponent(pub1.body.nextCursor)}`, { expect: 200 });
    assert.deepEqual([pub2.body.nextCursor, pub2.body.truncated], [null, false]);
    assert.deepEqual([...pub1.body.notices, ...pub2.body.notices].map((notice) => notice.id), [notice3.id, secondNotice.id]);
    assert.deepEqual(pub1.body.notices[0].agenda, [{ position: 1, title: 'Plan wydarzeń' }, { position: 2, title: 'Sprawozdanie zarządu' }]);
    assert.equal((await client.call('GET', `/api/meetings/public-notices?schoolYearId=${YEAR}&limit=201`, { expect: 400 })).body.error, 'invalid_limit');
    assert.equal((await client.call('GET', `/api/meetings/public-notices?schoolYearId=${YEAR}&cursor=nie-kursor`, { expect: 400 })).body.error, 'invalid_cursor');
    assert.equal((await client.call('GET', '/api/meetings/public-notices', { expect: 400 })).body.error, 'invalid_request');

    const cancelBody = { reason: 'Brak sali w tym terminie', revision: 1 };
    assert.equal((await client.call('POST', `${secondBase}/cancellation`, { cookie: A, body: { ...cancelBody, reason: 'ab' }, expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    assert.equal((await client.call('POST', `${secondBase}/cancellation`, { cookie: A, body: { ...cancelBody, revision: 5 }, expect: 409 })).body.error, 'revision_conflict');
    await assertRequiredFieldsEnforced(client, A, 'POST', `${secondBase}/cancellation`, cancelBody, 'MeetingCancellationRequest');
    const cancelled = await client.call('POST', `${secondBase}/cancellation`, { cookie: A, body: cancelBody, expect: 200 });
    assert.deepEqual([cancelled.body.replayed, cancelled.body.meeting.status, cancelled.body.meeting.cancellationReason, cancelled.body.meeting.cancelledBy],
      [false, 'cancelled', cancelBody.reason, 'u-board-a']);
    assert.deepEqual([cancelled.body.cancellationNotice.kind, cancelled.body.cancellationNotice.status, cancelled.body.cancellationNotice.agendaVersionId],
      ['cancellation', 'draft', null]);
    const cancelledAgain = await client.call('POST', `${secondBase}/cancellation`, { cookie: A, body: cancelBody, expect: 200 });
    assert.deepEqual([cancelledAgain.body.replayed, cancelledAgain.body.cancellationNotice], [true, null]);
    assert.equal((await client.call('POST', `${secondBase}/cancellation`, { cookie: A, body: { ...cancelBody, reason: 'Inny powód odwołania' }, expect: 409 })).body.error, 'meeting_cancelled');
    assert.equal((await client.call('POST', `${secondBase}/agenda-items`, { cookie: A, body: { title: 'Punkt po odwołaniu' }, key: key('item'), expect: 409 })).body.error, 'meeting_cancelled');
    assert.equal((await client.call('POST', `${secondBase}/reschedule`, { cookie: A, body: { ...rescheduleBody, revision: 2 }, expect: 409 })).body.error, 'meeting_cancelled');
    await client.call('POST', `${secondBase}/notices/${cancelled.body.cancellationNotice.id}/approval`, { cookie: B, body: {}, expect: 200 });
    const pubCancelled = await client.call('GET', `/api/meetings/public-notices?schoolYearId=${YEAR}`, { expect: 200 });
    const publicCancellation = pubCancelled.body.notices.find((notice) => notice.id === cancelled.body.cancellationNotice.id);
    assert.deepEqual([publicCancellation.cancelled, publicCancellation.agenda], [true, []]);

    // ---------- Lista zebrań z kursorem ----------
    const list1 = await client.call('GET', `/api/meetings?schoolYearId=${YEAR}&limit=2`, { cookie: A, expect: 200 });
    assert.deepEqual([list1.body.meetings.length, list1.body.truncated], [2, true]);
    const list2 = await client.call('GET', `/api/meetings?schoolYearId=${YEAR}&limit=2&cursor=${encodeURIComponent(list1.body.nextCursor)}`, { cookie: A, expect: 200 });
    assert.deepEqual([list2.body.meetings.length, list2.body.nextCursor], [2, null]);
    assert.deepEqual([...list1.body.meetings, ...list2.body.meetings].map((meeting) => meeting.id).sort(), [plenary.id, board.id, classB.id, second.id].sort());
    assert.equal((await client.call('GET', `/api/meetings?schoolYearId=${YEAR}&limit=0`, { cookie: A, expect: 400 })).body.error, 'invalid_limit');
    assert.equal((await client.call('GET', `/api/meetings?schoolYearId=${YEAR}&cursor=${encodeURIComponent(pub1.body.nextCursor)}`, { cookie: A, expect: 400 })).body.error, 'invalid_cursor');
    assert.equal((await client.call('GET', '/api/meetings', { cookie: A, expect: 400 })).body.error, 'invalid_request');

    // ---------- Zebranie odbyte: obecność dwojga opiekunów jednego dziecka, quorum ----------
    const held = await createMeeting(A, { schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie ogólne sprawozdawcze', scheduledAt: inDays(-1), status: 'scheduled', ...QUORUM });
    const heldBase = `/api/meetings/${held.id}`;
    await client.call('PATCH', heldBase, { cookie: A, body: { revision: 1, status: 'held' }, expect: 200 });
    assert.equal((await client.call('POST', `${heldBase}/cancellation`, { cookie: A, body: { ...cancelBody, revision: 2 }, expect: 409 })).body.error, 'meeting_status_transition_invalid');
    assert.equal((await client.call('POST', `${heldBase}/reschedule`, { cookie: A, body: { ...rescheduleBody, revision: 2 }, expect: 409 })).body.error, 'meeting_not_reschedulable');
    const attendancePath = `${heldBase}/attendance`;
    const guardian1 = { guardianId: 'h1-g1', capacity: 'guardian', votingEligible: true, present: true };
    const att1 = await client.call('POST', attendancePath, { cookie: A, body: guardian1, expect: 200 });
    const att2 = await client.call('POST', attendancePath, { cookie: A, body: { ...guardian1, guardianId: 'h1-g2' }, expect: 200 });
    assert.notEqual(att1.body.attendee.id, att2.body.attendee.id, 'dwoje opiekunów jednego dziecka to dwa wpisy listy');
    assert.equal(att1.headers.get('Idempotency-Replayed'), null);
    await client.call('POST', attendancePath, { cookie: A, body: { userId: 'u-board-a', capacity: 'board_member', votingEligible: true, present: true }, expect: 200 });
    const att1Again = await client.call('POST', attendancePath, { cookie: A, body: guardian1, expect: 200 });
    assert.equal(att1Again.body.attendee.id, att1.body.attendee.id, 'ponowienie wpisu poprawia ten sam wiersz');
    assert.equal((await client.call('POST', attendancePath, { cookie: A, body: { ...guardian1, guardianId: 'g-brak' }, expect: 400 })).body.error, 'invalid_reference');
    assert.equal((await client.call('POST', attendancePath, { cookie: A, body: { ...guardian1, userId: 'u-board-a' }, expect: 400 })).body.error, 'invalid_request');
    await assertRequiredFieldsEnforced(client, A, 'POST', attendancePath, guardian1, 'MeetingAttendanceRequest');

    const quorumKey = key('quorum');
    const quorum = await client.call('POST', `${heldBase}/quorum-checks`, { cookie: A, body: {}, key: quorumKey, expect: 201 });
    assert.deepEqual([quorum.body.quorumCheck.presentEligible, quorum.body.quorumCheck.requiredCount, quorum.body.quorumCheck.met, quorum.body.quorumCheck.current],
      [3, 2, true, true]);
    assert.equal((await client.call('POST', `${heldBase}/quorum-checks`, { cookie: A, body: {}, key: quorumKey, expect: 200 })).headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await client.call('POST', `${base}/quorum-checks`, { cookie: A, body: {}, key: key('quorum'), expect: 409 })).body.error, 'quorum_requires_held_meeting');

    // ---------- Uchwały z wersjami ----------
    const resolutionsPath = `${heldBase}/resolutions`;
    const draftBody = { title: 'Uchwała w sprawie planu wydarzeń', body: 'Rada przyjmuje plan wydarzeń na rok szkolny.' };
    const draftKey = key('res');
    const draft = await client.call('POST', resolutionsPath, { cookie: A, body: draftBody, key: draftKey, expect: 201 });
    assert.deepEqual([draft.body.resolution.status, draft.body.resolution.revision, draft.body.resolution.revisionNo, draft.body.suggestedNumber],
      ['draft', 1, 1, 'U-1/2026']);
    assert.deepEqual((await client.call('POST', resolutionsPath, { cookie: A, body: draftBody, key: draftKey, expect: 200 })).body, draft.body);
    await assertRequiredFieldsEnforced(client, A, 'POST', resolutionsPath, draftBody, 'MeetingResolutionCreateRequest', { withKey: true });
    const resolutionId = draft.body.resolution.id;
    const resolutionPath = `${resolutionsPath}/${resolutionId}`;
    const editedResolution = await client.call('PATCH', resolutionPath, { cookie: A, body: { revision: 1, title: 'Uchwała w sprawie planu wydarzeń 2026/27' }, expect: 200 });
    assert.equal(editedResolution.body.resolution.revisionNo, 2);
    assert.equal((await client.call('PATCH', resolutionPath, { cookie: A, body: { revision: 1, title: 'Edycja na starej wersji' }, expect: 409 })).body.error, 'revision_conflict');
    await assertRequiredFieldsEnforced(client, A, 'PATCH', resolutionPath, { revision: 2, title: 'Uchwała w sprawie planu wydarzeń 2026/27' }, 'MeetingResolutionUpdateRequest');
    const votes = { votesFor: 2, votesAgainst: 0, votesAbstain: 1, quorumCheckId: quorum.body.quorumCheck.id };
    assert.equal((await client.call('PATCH', resolutionPath, { cookie: A, body: { revision: 2, status: 'adopted', ...votes }, expect: 400 })).body.error, 'resolution_number_required');
    assert.equal((await client.call('PATCH', resolutionPath, { cookie: A, body: { revision: 2, status: 'adopted', number: 'U-1/2026' }, expect: 400 })).body.error, 'vote_record_required');
    assert.equal((await client.call('PATCH', resolutionPath, { cookie: A, body: { revision: 2, status: 'adopted', number: 'U-1/2026', ...votes, votesFor: 5 }, expect: 409 })).body.error, 'resolution_votes_exceed_present_voters');
    const adopted = await client.call('PATCH', resolutionPath, { cookie: A, body: { revision: 2, status: 'adopted', number: 'U-1/2026', ...votes }, expect: 200 });
    assert.deepEqual([adopted.body.resolution.status, adopted.body.resolution.number, adopted.body.resolution.revisionNo], ['adopted', 'U-1/2026', 3]);
    assert.ok(adopted.body.resolution.decidedAt);
    assert.equal((await client.call('PATCH', resolutionPath, { cookie: A, body: { revision: 3, title: 'Zmiana przyjętej uchwały' }, expect: 409 })).body.error, 'resolution_final_immutable');

    const correctionBody = { reason: 'Pomyłka w liczbie głosów wstrzymujących', votesAbstain: 0 };
    const correctionKey = key('corr');
    const correction = await client.call('POST', `${resolutionPath}/corrections`, { cookie: A, body: correctionBody, key: correctionKey, expect: 201 });
    assert.deepEqual([correction.body.resolution.revision, correction.body.resolution.correctsId, correction.body.resolution.number, correction.body.resolution.votesAbstain],
      [2, resolutionId, 'U-1/2026', 0]);
    assert.equal((await client.call('POST', `${resolutionPath}/corrections`, { cookie: A, body: correctionBody, key: correctionKey, expect: 200 })).body.resolution.id, correction.body.resolution.id);
    assert.equal((await client.call('POST', `${resolutionPath}/corrections`, { cookie: A, body: { ...correctionBody, reason: 'Druga korekta tej samej rewizji' }, key: key('corr'), expect: 409 })).body.error, 'concurrent_version');
    await assertRequiredFieldsEnforced(client, A, 'POST', `${resolutionPath}/corrections`, correctionBody, 'MeetingResolutionCorrectionRequest', { withKey: true });
    const currentId = correction.body.resolution.id;

    // Zmiana obecności po ustaleniu quorum: ustalenie nieaktualne (#81).
    await client.call('POST', attendancePath, { cookie: A, body: { ...guardian1, guardianId: 'h1-g2', present: false }, expect: 200 });
    assert.equal((await client.call('POST', `${heldBase}/quorum-checks`, { cookie: A, body: {}, key: quorumKey, expect: 409 })).body.error, 'idempotency_conflict');
    const amendBody = {
      title: 'Uchwała zmieniająca plan wydarzeń', body: 'Rada zmienia termin kiermaszu.', status: 'adopted', number: 'U-2/2026',
      votesFor: 2, votesAgainst: 0, votesAbstain: 0, amendsResolutionId: currentId, relationKind: 'amends',
    };
    assert.equal((await client.call('POST', resolutionsPath, { cookie: A, body: { ...amendBody, quorumCheckId: quorum.body.quorumCheck.id }, key: key('res'), expect: 409 })).body.error, 'resolution_quorum_check_stale');
    const quorum2 = (await client.call('POST', `${heldBase}/quorum-checks`, { cookie: A, body: {}, key: key('quorum'), expect: 201 })).body.quorumCheck;
    assert.deepEqual([quorum2.presentEligible, quorum2.met], [2, true]);
    assert.equal((await client.call('POST', resolutionsPath, { cookie: A, body: { ...amendBody, quorumCheckId: quorum2.id, amendsResolutionId: resolutionId }, key: key('res'), expect: 409 })).body.error, 'resolution_amends_requires_adopted');
    assert.equal((await client.call('POST', resolutionsPath, { cookie: A, body: { ...amendBody, quorumCheckId: quorum2.id, relationKind: 'zmienia' }, key: key('res'), expect: 400, invalidRequest: true })).body.error, 'invalid_relation_kind');
    const amending = (await client.call('POST', resolutionsPath, { cookie: A, body: { ...amendBody, quorumCheckId: quorum2.id }, key: key('res'), expect: 201 })).body;
    assert.deepEqual([amending.resolution.relationKind, amending.suggestedNumber], ['amends', 'U-2/2026']);
    assert.equal((await client.call('POST', resolutionsPath, { cookie: A, body: { ...amendBody, quorumCheckId: quorum2.id, amendsResolutionId: null, relationKind: null }, key: key('res'), expect: 409 })).body.error, 'resolution_number_taken');

    // Wykonanie uchwały: tylko dopisywanie, ponowienie po kluczu.
    const executionPath = `/api/meetings/resolutions/${amending.resolution.id}/execution`;
    const executionBody = { status: 'in_progress', responsibleUserId: 'u-board-a', dueOn: '2026-12-15', note: 'Uzgodnić termin z dyrekcją' };
    const executionKey = key('exec');
    const execution = await client.call('POST', executionPath, { cookie: A, body: executionBody, key: executionKey, expect: 201 });
    assert.deepEqual([execution.body.execution.status, execution.body.execution.dueOn], ['in_progress', '2026-12-15']);
    assert.equal((await client.call('POST', executionPath, { cookie: A, body: executionBody, key: executionKey, expect: 200 })).body.execution.id, execution.body.execution.id);
    assert.equal((await client.call('POST', executionPath, { cookie: A, body: { status: 'gotowe' }, key: key('exec'), expect: 400, invalidRequest: true })).body.error, 'invalid_execution_status');
    await assertRequiredFieldsEnforced(client, A, 'POST', executionPath, executionBody, 'MeetingResolutionExecutionRequest', { withKey: true });

    // Projekt otwarty blokuje zatwierdzenie protokołu; wycofany projekt nie ma wykonania.
    const openDraft = (await client.call('POST', resolutionsPath, { cookie: A, body: { title: 'Projekt bez rozstrzygnięcia', body: 'Treść projektu.' }, key: key('res'), expect: 201 })).body.resolution;

    // ---------- Protokół: wersje, cztery oczy, otwarte projekty, blokada zebrania ----------
    const minutesPath = `${heldBase}/minutes`;
    const minutesBody = { body: MINUTES_BODY };
    const minutesKey = key('min');
    const minutes1 = await client.call('POST', minutesPath, { cookie: A, body: minutesBody, key: minutesKey, expect: 201 });
    assert.deepEqual([minutes1.body.minutes.version, minutes1.body.minutes.status, minutes1.body.minutes.visibility], [1, 'draft', 'internal']);
    assert.equal((await client.call('POST', minutesPath, { cookie: A, body: minutesBody, key: minutesKey, expect: 200 })).body.minutes.id, minutes1.body.minutes.id);
    await assertRequiredFieldsEnforced(client, A, 'POST', minutesPath, minutesBody, 'MeetingMinutesRequest', { withKey: true });
    const minutesApproval = (minutesId) => `${minutesPath}/${minutesId}/approval`;
    assert.equal((await client.call('POST', minutesApproval(minutes1.body.minutes.id), { cookie: A, body: {}, expect: 403 })).body.error, 'minutes_four_eyes_required');
    const openRefusal = await client.call('POST', minutesApproval(minutes1.body.minutes.id), { cookie: B, body: {}, expect: 409 });
    assert.deepEqual([openRefusal.body.error, openRefusal.body.openResolutions], ['minutes_open_resolutions', 1]);
    const checklist = await client.call('GET', `${heldBase}/approval-checklist`, { cookie: A, expect: 200 });
    assert.deepEqual([checklist.body.ready, checklist.body.items.find((item) => item.code === 'open_resolutions').count], [false, 1]);
    const withdrawnDraft = await client.call('PATCH', `${resolutionsPath}/${openDraft.id}`, { cookie: A, body: { revision: 1, status: 'withdrawn' }, expect: 200 });
    assert.equal(withdrawnDraft.body.resolution.status, 'withdrawn');
    assert.equal((await client.call('POST', `/api/meetings/resolutions/${openDraft.id}/execution`, { cookie: A, body: { status: 'done' }, key: key('exec'), expect: 409 })).body.error, 'resolution_not_decided');
    const minutes2 = (await client.call('POST', minutesPath, { cookie: A, body: { body: `${MINUTES_BODY} Uzupełnienie.`, changeNote: 'Uzupełnienie wniosków' }, key: key('min'), expect: 201 })).body.minutes;
    assert.equal(minutes2.supersedesId, minutes1.body.minutes.id);
    assert.equal((await client.call('POST', minutesApproval(minutes1.body.minutes.id), { cookie: B, body: {}, expect: 409 })).body.error, 'minutes_not_latest_version');
    assert.equal((await client.call('POST', `${minutesPath}/${minutes1.body.minutes.id}/visibility`, { cookie: A, body: { visibility: 'parents' }, key: key('vis'), expect: 409 })).body.error, 'minutes_not_approved');
    const minutesApproved = await client.call('POST', minutesApproval(minutes2.id), { cookie: B, body: { approvalNote: 'Przyjęty jednogłośnie' }, expect: 200 });
    assert.deepEqual([minutesApproved.body.minutes.status, minutesApproved.body.replayed], ['approved', false]);
    assert.equal((await client.call('POST', minutesApproval(minutes2.id), { cookie: B, body: {}, expect: 200 })).body.replayed, true);
    assert.equal((await client.call('POST', minutesApproval('brak-protokolu'), { cookie: B, body: {}, expect: 404 })).body.error, 'minutes_not_found');
    // Zebranie zablokowane: obecność, porządek i uchwały nie przyjmują zmian; wykonanie uchwały — tak.
    assert.equal((await client.call('POST', attendancePath, { cookie: A, body: guardian1, expect: 409 })).body.error, 'meeting_locked');
    assert.equal((await client.call('POST', `${heldBase}/agenda-items`, { cookie: A, body: { title: 'Punkt po zatwierdzeniu' }, key: key('item'), expect: 409 })).body.error, 'meeting_locked');
    await client.call('POST', executionPath, { cookie: A, body: { status: 'done' }, key: key('exec'), expect: 201 });

    // Widoczność: rodzice, publicznie; protokoły udostępnione i publiczne.
    const visibilityPath = `${minutesPath}/${minutes2.id}/visibility`;
    const visibilityBody = { visibility: 'parents', reason: 'Udostępnienie rodzicom' };
    const visibilityKey = key('vis');
    const shared = await client.call('POST', visibilityPath, { cookie: A, body: visibilityBody, key: visibilityKey, expect: 201 });
    assert.equal(shared.body.minutes.visibility, 'parents');
    assert.equal((await client.call('POST', visibilityPath, { cookie: A, body: visibilityBody, key: visibilityKey, expect: 200 })).headers.get('Idempotency-Replayed'), 'true');
    await assertRequiredFieldsEnforced(client, A, 'POST', visibilityPath, visibilityBody, 'MeetingMinutesVisibilityRequest', { withKey: true });
    const repShared = await client.call('GET', `/api/meetings/shared-minutes?schoolYearId=${YEAR}`, { cookie: cookies.repA, expect: 200 });
    assert.deepEqual(repShared.body.minutes.map((item) => [item.minutesId, item.visibility]), [[minutes2.id, 'parents']]);
    assert.deepEqual((await client.call('GET', `/api/meetings/public-minutes?schoolYearId=${YEAR}`, { expect: 200 })).body, { minutes: [], truncated: false });
    await client.call('POST', visibilityPath, { cookie: A, body: { visibility: 'public' }, key: key('vis'), expect: 201 });
    const publicMinutes = await client.call('GET', `/api/meetings/public-minutes?schoolYearId=${YEAR}`, { expect: 200 });
    assert.deepEqual(publicMinutes.body.minutes.map((item) => [item.minutesId, item.visibility, item.kind]), [[minutes2.id, 'public', 'plenary']]);
    assert.equal((await client.call('GET', '/api/meetings/public-minutes', { expect: 400 })).body.error, 'invalid_request');
    // Poprawiona wersja z imieniem i nazwiskiem opiekuna: zatwierdzenie tak, publikacja publiczna — nie.
    const minutes3 = (await client.call('POST', minutesPath, { cookie: A, body: { body: `${MINUTES_BODY} Wniosek zgłosiła Zenobia Testowa.` }, key: key('min'), expect: 201 })).body.minutes;
    await client.call('POST', minutesApproval(minutes3.id), { cookie: B, body: {}, expect: 200 });
    assert.equal((await client.call('POST', `${minutesPath}/${minutes3.id}/visibility`, { cookie: A, body: { visibility: 'public' }, key: key('vis'), expect: 409 })).body.error, 'minutes_contain_personal_data');

    // ---------- Rejestr uchwał i wyszukanie po numerze ----------
    const register = await client.call('GET', `/api/meetings/resolutions?schoolYearId=${YEAR}`, { cookie: A, expect: 200 });
    const registered = Object.fromEntries(register.body.resolutions.map((item) => [item.number ?? item.status, item]));
    assert.deepEqual([registered['U-1/2026'].effectiveStatus, registered['U-1/2026'].revision, registered['U-1/2026'].amendedBy.number], ['amended', 2, 'U-2/2026']);
    assert.deepEqual([registered['U-2/2026'].execution.status, registered.withdrawn.execution.status], ['done', null]);
    const filtered = await client.call('GET', `/api/meetings/resolutions?schoolYearId=${YEAR}&status=adopted&q=U-2&executionStatus=done`, { cookie: cookies.audit, expect: 200 });
    assert.deepEqual(filtered.body.resolutions.map((item) => item.number), ['U-2/2026']);
    const noExecution = await client.call('GET', `/api/meetings/resolutions?schoolYearId=${YEAR}&executionStatus=none`, { cookie: cookies.principal, expect: 200 });
    assert.deepEqual(noExecution.body.resolutions.map((item) => item.number).sort(), ['U-1/2026', null].sort());
    assert.deepEqual((await client.call('GET', `/api/meetings/resolutions?schoolYearId=${YEAR}`, { cookie: cookies.boardClass, expect: 200 })).body.resolutions, []);
    assert.equal((await client.call('GET', `/api/meetings/resolutions?schoolYearId=${YEAR}&status=nieznany`, { cookie: A, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    const lookup = await client.call('GET', `/api/meetings/resolutions/lookup?schoolYearId=${YEAR}&number=${encodeURIComponent('U-1/2026')}`, { cookie: cookies.treasurer, expect: 200 });
    assert.deepEqual([lookup.body.resolution.id, lookup.body.resolution.effectiveStatus], [currentId, 'amended']);
    assert.equal((await client.call('GET', `/api/meetings/resolutions/lookup?schoolYearId=${YEAR}&number=U-9%2F2026`, { cookie: cookies.treasurer, expect: 404 })).body.error, 'resolution_not_found');
    assert.equal((await client.call('GET', `/api/meetings/resolutions/lookup?schoolYearId=${YEAR}`, { cookie: cookies.treasurer, expect: 400, invalidRequest: true })).body.error, 'invalid_request');

    // ---------- Widok zebrania: Komisja Rewizyjna i dyrekcja widzą listę obecności (pseudonimowe identyfikatory) ----------
    const fullView = await getMeeting(held.id);
    for (const cookie of [cookies.audit, cookies.principal]) {
      const view = await getMeeting(held.id, cookie);
      assert.deepEqual(view.attendees.map((row) => [row.guardianId, row.userId]), fullView.attendees.map((row) => [row.guardianId, row.userId]));
      assert.equal(view.attendees.length, 3);
      await client.call('GET', `${heldBase}/approval-checklist`, { cookie, expect: 200 });
    }
    assert.deepEqual(fullView.resolutions.map((row) => [row.number, row.revision, row.status]),
      [['U-1/2026', 1, 'adopted'], ['U-1/2026', 2, 'adopted'], ['U-2/2026', 1, 'adopted'], [null, 1, 'withdrawn']]);

    // ---------- Granice ról ----------
    const reads = [
      `/api/meetings?schoolYearId=${YEAR}`, `/api/meetings/${held.id}`, `${heldBase}/approval-checklist`,
      `/api/meetings/shared-minutes?schoolYearId=${YEAR}`, `/api/meetings/resolutions?schoolYearId=${YEAR}`,
      `/api/meetings/resolutions/lookup?schoolYearId=${YEAR}&number=U-1%2F2026`, `${base}/notices/${notice3.id}/calendar`,
    ];
    for (const path of reads) {
      await client.call('GET', path, { expect: 401 });
      assert.equal((await client.call('GET', path, { cookie: cookies.boardNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required', path);
    }
    // Przedstawiciel 1A: zebranie klasy 1B (i każde inne) jak nieistniejące; listy i rejestr — 403.
    for (const path of [`/api/meetings/${classB.id}`, `${classBase}/approval-checklist`, `${classBase}/notices/${classNotice.id}/calendar`, `/api/meetings/${held.id}`]) {
      assert.equal((await client.call('GET', path, { cookie: cookies.repA, expect: 404 })).body.error, 'meeting_not_found', path);
    }
    for (const path of [`/api/meetings?schoolYearId=${YEAR}`, `/api/meetings/resolutions?schoolYearId=${YEAR}`, `/api/meetings/resolutions/lookup?schoolYearId=${YEAR}&number=U-1%2F2026`]) {
      assert.equal((await client.call('GET', path, { cookie: cookies.repA, expect: 403 })).body.error, 'forbidden', path);
    }
    // Zarząd z przydziałem klasy 1A: lista bez zebrań spoza klasy, zebranie 1B jak nieistniejące.
    assert.deepEqual((await client.call('GET', `/api/meetings?schoolYearId=${YEAR}`, { cookie: cookies.boardClass, expect: 200 })).body.meetings, []);
    assert.equal((await client.call('GET', `/api/meetings/${classB.id}`, { cookie: cookies.boardClass, expect: 404 })).body.error, 'meeting_not_found');
    assert.equal((await client.call('GET', `/api/meetings/shared-minutes?schoolYearId=${YEAR}`, { cookie: cookies.treasurer, expect: 403 })).body.error, 'forbidden');

    const writes = [
      ['POST', '/api/meetings', { schoolYearId: YEAR, kind: 'class', classId: 'c-1b', title: 'Zebranie klasy 1B', scheduledAt: inDays(9) }, true],
      ['PATCH', classBase, { revision: 1, title: 'Zmiana zebrania 1B' }, false],
      ['POST', `${classBase}/agenda-items`, { title: 'Punkt spoza zakresu' }, true],
      ['POST', `${classBase}/cancellation`, { reason: 'Odwołanie spoza zakresu', revision: 1 }, false],
      ['POST', `${classBase}/notices`, {}, false],
      ['POST', `${heldBase}/attendance`, guardian1, false],
      ['POST', `${resolutionsPath}/${currentId}/corrections`, correctionBody, true],
      ['POST', executionPath, { status: 'done' }, true],
    ];
    for (const [method, path, body, keyed] of writes) {
      const withKey = () => (keyed ? key('deny') : undefined);
      await client.call(method, path, { body, key: withKey(), expect: 401 });
      for (const cookie of [cookies.repA, cookies.boardClass, cookies.audit, cookies.principal, cookies.treasurer]) {
        assert.equal((await client.call(method, path, { cookie, body, key: withKey(), expect: 403 })).body.error, 'forbidden', `${method} ${path}`);
      }
      assert.equal((await client.call(method, path, { cookie: cookies.boardNoMfa, body, key: withKey(), expect: 403 })).body.error, 'mfa_enrollment_required', path);
      assert.equal((await client.call(method, path, { cookie: A, body, key: withKey(), expect: 403, origin: 'https://obcy.example.invalid' })).body.error, 'invalid_origin', path);
    }
    // Wymóg MFA modułu (#150), gdy bramka routera nie wymaga zapisu czynnika (MFA_REQUIRED_ROLES puste):
    // odczyt bez MFA działa, zarządzanie zebraniem — 403 mfa_required.
    const noGate = newClient({ ...env, MFA_REQUIRED_ROLES: '' });
    await noGate.call('GET', `/api/meetings?schoolYearId=${YEAR}`, { cookie: cookies.boardNoMfa, expect: 200 });
    assert.equal((await noGate.call('POST', '/api/meetings', { cookie: cookies.boardNoMfa, body: plenaryBody, key: key('mtg'), expect: 403 })).body.error, 'mfa_required');
    assert.equal((await noGate.call('PATCH', boardBase, { cookie: cookies.boardNoMfa, body: { revision: 1, title: 'Zebranie zarządu bez MFA' }, expect: 403 })).body.error, 'mfa_required');
    for (const item of noGate.validated) validated.add(item);

    // ---------- Błędy 400/404/413/415/422 ----------
    assert.equal((await client.call('GET', '/api/meetings/%21', { cookie: A, expect: 400 })).body.error, 'invalid_meeting_id');
    assert.equal((await client.call('GET', '/api/meetings/brak-zebrania', { cookie: A, expect: 404 })).body.error, 'meeting_not_found');
    assert.equal((await client.call('GET', '/api/meetings/brak-zebrania/approval-checklist', { cookie: A, expect: 404 })).body.error, 'meeting_not_found');
    assert.equal((await client.call('GET', `${base}/notices/brak-zawiadomienia/calendar`, { cookie: A, expect: 404 })).body.error, 'notice_not_found');
    assert.equal((await client.call('PATCH', '/api/meetings/brak-zebrania', { cookie: A, body: { revision: 1, title: 'Brak zebrania' }, expect: 404 })).body.error, 'meeting_not_found');
    assert.equal((await client.call('PATCH', `${resolutionsPath}/brak-uchwaly`, { cookie: A, body: { revision: 1, title: 'Brak uchwały' }, expect: 404 })).body.error, 'resolution_not_found');
    assert.equal((await client.call('POST', '/api/meetings/resolutions/brak-uchwaly/execution', { cookie: A, body: { status: 'done' }, key: key('exec'), expect: 404 })).body.error, 'resolution_not_found');
    assert.equal((await client.call('POST', `${resolutionsPath}/%21/corrections`, { cookie: A, body: correctionBody, key: key('corr'), expect: 400 })).body.error, 'invalid_resolution_id');
    assert.equal((await client.call('POST', `${minutesPath}/%21/approval`, { cookie: A, body: {}, expect: 400 })).body.error, 'invalid_minutes_id');
    assert.equal((await client.call('POST', `${base}/notices/%21/approval`, { cookie: B, body: {}, expect: 400 })).body.error, 'invalid_notice_id');
    assert.equal((await client.call('POST', '/api/meetings', {
      cookie: A, headers: { 'Content-Type': 'application/json' }, body: '{"title":', key: key('mtg'), expect: 400, invalidRequest: true,
    })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', `${base}/notices`, { cookie: A, headers: { 'Content-Type': 'application/json' }, body: '', expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', `${boardBase}/agenda-items`, {
      cookie: A, body: { title: 'Za długi punkt', description: 'x'.repeat(300 * 1024) }, key: key('item'), expect: 413, invalidRequest: true,
    })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', `${boardBase}/agenda-items`, { cookie: A, body: 'title=x', key: key('item'), expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', `${boardBase}/cancellation`, { cookie: A, body: { reason: 'Kontakt: rodzic@example.invalid', revision: 1 }, expect: 422 })).body.error, 'personal_data_forbidden');
    assert.equal((await client.call('POST', `${boardBase}/agenda-items`, { cookie: A, body: { title: 'Telefon do rodzica', description: 'Zadzwonić pod 0471 23 45 67' }, key: key('item'), expect: 422 })).body.error, 'possible_personal_data');
    await client.call('POST', `${boardBase}/agenda-items`, {
      cookie: A, body: { title: 'Telefon do rodzica', description: 'Zadzwonić pod 0471 23 45 67', confirmPersonalData: true }, key: key('item'), expect: 201,
    });

    // ---------- Zamknięty rok: zamknięcie przez trasy year-close, potem 409 ----------
    // Zamknięcie wygasza przydziały roku; zapisy próbuje zarząd z przydziałem bez roku.
    await closeYear(env, cookies);
    const G = cookies.boardGlobal;
    const boardRevision = (await getMeeting(board.id, G)).meeting.revisionNo;
    const closedWrites = [
      ['POST', '/api/meetings', { ...plenaryBody, title: 'Zebranie w zamkniętym roku' }, true],
      ['PATCH', boardBase, { revision: boardRevision, title: 'Zmiana w zamkniętym roku' }, false],
      ['POST', `${boardBase}/agenda-items`, { title: 'Punkt w zamkniętym roku' }, true],
      ['POST', `${boardBase}/reschedule`, { scheduledAt: inDays(70), reason: 'Zmiana w zamkniętym roku', revision: boardRevision }, false],
      ['POST', `${boardBase}/attendance`, { userId: 'u-board-b', capacity: 'board_member', votingEligible: true, present: true }, false],
    ];
    for (const [method, path, body, keyed] of closedWrites) {
      const response = await client.call(method, path, { cookie: G, body, key: keyed ? key('closed') : undefined, expect: 409 });
      assert.equal(response.body.error, 'school_year_closed', `${method} ${path}`);
    }
    assert.equal((await getMeeting(held.id, G)).minutes.length, 3, 'odczyt w zamkniętym roku działa');
    assert.equal((await client.call('GET', `/api/meetings?schoolYearId=${YEAR}`, { cookie: A, expect: 403 })).body.error, 'forbidden', 'przydział roku wygasł');

    assert.equal(networkGuardCalls(), 0, 'żadnej próby połączenia z siecią');
    assertSuccessCoverage(validated);
  } finally {
    await db.close();
  }
});
