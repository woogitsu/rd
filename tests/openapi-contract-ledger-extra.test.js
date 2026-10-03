// Kontrakt API (#160, etap 4): prawdziwe odpowiedzi modułów `ledger-budget`, `ledger-cash`
// i `ledger-cost-centers` (PGlite, dane syntetyczne) walidowane schematami z docs/openapi.json
// (src/pg/schemas/ledger-budget.js, ledger-cash.js, ledger-cost-centers.js) przez
// tests/helpers/contract-client.js. Rejestr pokrycia i katalog kodów sprawdza
// tests/openapi-contract.test.js (wspólnie dla wszystkich pokrytych modułów).
//
// Preliminarz: linie, rewizje (wersje), przyjęcie z uchwałą i bez, historia, wykonanie w czterech
// formatach, wyłączenie kategorii. Kasa: bilans otwarcia pierwszego roku, poprawki,
// `cash_below_zero`, przeniesienia ze stornem. Centra kosztów: przypisanie wpisu do wydarzenia
// i klas, wersje, `allocation_exceeds_net`, `allocation_version_conflict`, raport w trzech
// formatach i rozliczenie wydarzenia. Do tego: ponowienie z kluczem idempotencji
// (`Idempotency-Replayed`), granice ról (401, 403 dla przedstawiciela klasy, Komisji Rewizyjnej
// i braku MFA), błędy 400/404/409/413/415/422 oraz zamknięty rok (409 `school_year_closed`)
// osiągnięty przez trasy zamknięcia roku (bez obchodzenia triggerów).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { createMeeting, createResolution, determineQuorum, recordAttendance } from '../src/pg/meetings.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import { updateMeeting } from './helpers/with-revision.js';
import {
  createTestDb, request, seedClass, seedRoleGrant, seedSchoolYear, seedUser, seedUserSession,
} from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;

const MODULES = ['ledger-budget', 'ledger-cash', 'ledger-cost-centers'];
const YEAR = 'y-2026';
const NEXT = 'y-2027';
const MISSING_YEAR = 'y-2099';
const meetingAdmin = { userId: 'u-meet-admin', grants: [{ role: 'admin', classId: null, schoolYearId: null }], mfaVerified: true };

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

function newClient(env) {
  return createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
}

// Każda odpowiedź sukcesu opisana w schematach modułów (i każdy jej format) została zwalidowana
// na prawdziwej odpowiedzi.
function assertSuccessCoverage(client, moduleNames) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (!moduleNames.includes(entry.module)) continue;
    for (const [status, response] of Object.entries(entry.responses)) {
      expected.push(`${routeId} ${status}`);
      for (const type of Object.keys(response.content ?? {})) expected.push(`${routeId} ${status} ${type}`);
    }
  }
  assert.ok(expected.length >= 30, `oczekiwane odpowiedzi: ${expected.length}`);
  assert.deepEqual(expected.filter((item) => !client.validated.has(item)), [], 'odpowiedzi sukcesu opisane w schematach bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje błąd i w schemacie, i na serwerze (400).
async function assertRequiredFieldsEnforced(client, cookie, path, validBody, requiredFields) {
  assert.ok(requiredFields.length > 0, 'schemat ma wymagane pola');
  for (const field of requiredFields) {
    const { [field]: omitted, ...body } = validBody;
    assert.notEqual(omitted, undefined, `${field}: ciało testowe ma to pole`);
    const response = await client.call('POST', path, { cookie, body, key: key('req'), expect: 400, invalidRequest: true });
    assert.equal(typeof response.body.error, 'string', `${field}: kod błędu`);
  }
}

async function adoptedResolution(db) {
  const { meeting } = await createMeeting(db, meetingAdmin, {
    idempotencyKey: key('meeting'), schoolYearId: YEAR, kind: 'plenary', classId: null,
    title: 'Zebranie syntetyczne', scheduledAt: '2026-10-01T17:00:00Z', status: 'scheduled',
    quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Założenie testowe',
  });
  await updateMeeting(db, meetingAdmin, { meetingId: meeting.id, status: 'held' });
  await seedRoleGrant(db, { userId: meetingAdmin.userId, role: 'admin' });
  await recordAttendance(db, meetingAdmin, { meetingId: meeting.id, userId: meetingAdmin.userId, capacity: 'board_member', votingEligible: true, present: true });
  const { quorumCheck } = await determineQuorum(db, meetingAdmin, { idempotencyKey: key('quorum'), meetingId: meeting.id });
  const { resolution } = await createResolution(db, meetingAdmin, {
    idempotencyKey: key('res'), meetingId: meeting.id, title: 'Preliminarz syntetyczny', body: 'Treść syntetyczna uchwały',
    status: 'adopted', number: 'P-1/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
  });
  return resolution;
}

// Rok YEAR jest pierwszym rokiem w systemie (ręczny bilans otwarcia), NEXT — następnym.
async function world() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  await seedUser(db, { userId: meetingAdmin.userId });
  const both = (role) => [{ role, schoolYearId: YEAR }, { role, schoolYearId: NEXT }];
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: both('treasurer') }),
    boardA: await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: both('board') }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', mfa: true, roles: both('board') }),
    // Przydział bez roku: odczyt i zapis roku spoza przydziałów pozostałych kont (404 nieistniejącego roku, rok zamknięty).
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', mfa: true, roles: [{ role: 'board' }] }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', mfa: false, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] }),
    rep: await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-inc', $1, 'income', 'Kiermasz', 'u-treasurer'),
    ('cat-exp', $1, 'expense', 'Materiały', 'u-treasurer'),
    ('cat-trip', $1, 'expense', 'Wycieczki', 'u-treasurer'),
    ('cat-old', $1, 'expense', 'Kategoria do wyłączenia', 'u-treasurer')`, [YEAR]);
  const entry = (id, direction, cents, category, date) => db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on,
       method, created_by, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, 'bank', 'u-treasurer', $8)`,
    [id, YEAR, direction, cents, category, `Wpis syntetyczny ${id}`, date, `seed-entry-${id}`]);
  await entry('le-in', 'income', 40000, 'cat-inc', '2026-10-10');
  await entry('le-out', 'expense', 15000, 'cat-exp', '2026-10-05');
  await entry('le-trip', 'expense', 9000, 'cat-trip', '2026-11-06');
  await db.query(`INSERT INTO events (id, school_year_id, title, begins_at, visibility, created_by) VALUES
    ('ev-fair', $1, 'Kiermasz syntetyczny', '2026-10-10T10:00:00Z', 'internal', 'u-board-a'),
    ('ev-ball', $1, 'Bal syntetyczny', '2027-02-10T18:00:00Z', 'internal', 'u-board-a')`, [YEAR]);
  await db.query(`INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
    VALUES ('d1', 'docs/00000000-0000-4000-8000-00000000d001', 'application/pdf', 1200, 'financial', 'u-treasurer', $1, $2, 'seed-document-0001')`,
  [YEAR, 'a'.repeat(64)]);
  const env = { db };
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

test('klient kontraktu: Content-Type spoza formatów odpowiedzi jest błędem (kontrola pozytywna)', async () => {
  const fake = createContractClient({
    spec,
    fetch: async () => new Response('x', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
  });
  await assert.rejects(
    fake.call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&format=csv`, { expect: 200 }),
    /Content-Type text\/plain nie jest opisany/,
  );
  const operation = spec.paths['/api/ledger/budget/execution'].get;
  assert.deepEqual(Object.keys(operation.responses['200'].content).sort(), [
    'application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv; charset=utf-8', 'text/html; charset=utf-8',
  ]);
});

test('kontrakt preliminarza, kasy i centrów kosztów: prawdziwe odpowiedzi zgodne ze schematami', async () => {
  const { db, env, cookies, client } = await world();
  const T = cookies.treasurer;
  const A = cookies.boardA;
  const B = cookies.boardB;
  const G = cookies.boardGlobal;
  try {
    // ---------- Preliminarz: linie i wersje ----------
    const lineBody = { schoolYearId: YEAR, categoryId: 'cat-exp', plannedCents: 20000, note: 'Plan początkowy' };
    const lineKey = key('line');
    const line = await client.call('POST', '/api/ledger/budget', { cookie: T, body: lineBody, key: lineKey, expect: 201 });
    assert.equal(line.headers.get('Idempotency-Replayed'), 'false');
    assert.deepEqual([line.body.line.plannedCents, line.body.line.supersedesId, line.body.line.createdBy], [20000, null, 'u-treasurer']);
    const lineReplay = await client.call('POST', '/api/ledger/budget', { cookie: T, body: lineBody, key: lineKey, expect: 200 });
    assert.equal(lineReplay.headers.get('Idempotency-Replayed'), 'true');
    assert.equal(lineReplay.body.line.id, line.body.line.id);
    assert.equal((await client.call('POST', '/api/ledger/budget', { cookie: T, body: { ...lineBody, plannedCents: 21000 }, key: lineKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', '/api/ledger/budget', { cookie: B, body: lineBody, key: key('line'), expect: 409 })).body.error, 'budget_line_exists');
    const incomeLine = await client.call('POST', '/api/ledger/budget', { cookie: T, body: { schoolYearId: YEAR, categoryId: 'cat-inc', plannedCents: 50000 }, key: key('line'), expect: 201 });
    assert.equal(incomeLine.body.line.note, null);
    assert.equal((await client.call('POST', '/api/ledger/budget', { cookie: T, body: { schoolYearId: YEAR, categoryId: 'nie-ma-takiej', plannedCents: 100 }, key: key('line'), expect: 400 })).body.error, 'invalid_category');
    assert.equal((await client.call('POST', '/api/ledger/budget', { cookie: T, body: { ...lineBody, plannedCents: -1 }, key: key('line'), expect: 400, invalidRequest: true })).body.error, 'invalid_amount');
    assert.equal((await client.call('POST', '/api/ledger/budget', { cookie: T, body: { ...lineBody, note: 'ab' }, key: key('line'), expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('POST', '/api/ledger/budget', { cookie: T, body: lineBody, expect: 400 })).body.error, 'invalid_idempotency_key');
    assert.equal((await client.call('POST', '/api/ledger/budget', { cookie: T, body: { ...lineBody, categoryId: 'cat-trip', note: 'Kontakt: jan@example.invalid' }, key: key('line'), expect: 422 })).body.error, 'personal_data_forbidden');
    await assertRequiredFieldsEnforced(client, T, '/api/ledger/budget', lineBody, components.LedgerBudgetLineCreateRequest.required);

    const revisionBody = { plannedCents: 18000, reason: 'Mniejszy koszt materiałów' };
    const revisionKey = key('rev');
    const revision = await client.call('POST', `/api/ledger/budget/${line.body.line.id}/revisions`, { cookie: T, body: revisionBody, key: revisionKey, expect: 201 });
    assert.deepEqual([revision.body.line.supersedesId, revision.body.line.note, revision.body.line.categoryId], [line.body.line.id, revisionBody.reason, 'cat-exp']);
    await client.call('POST', `/api/ledger/budget/${line.body.line.id}/revisions`, { cookie: T, body: revisionBody, key: revisionKey, expect: 200 });
    // Druga rewizja tej samej (już zastąpionej) wersji innym kluczem: 409 ze wskazaniem bieżącej.
    const superseded = await client.call('POST', `/api/ledger/budget/${line.body.line.id}/revisions`, { cookie: B, body: { plannedCents: 17000, reason: 'Równoległa zmiana' }, key: key('rev'), expect: 409 });
    assert.deepEqual([superseded.body.error, superseded.body.currentLineId], ['budget_line_superseded', revision.body.line.id]);
    assert.equal((await client.call('POST', '/api/ledger/budget/nie-ma-takiej/revisions', { cookie: T, body: revisionBody, key: key('rev'), expect: 404 })).body.error, 'budget_line_not_found');
    assert.equal((await client.call('POST', '/api/ledger/budget/zla%20linia/revisions', { cookie: T, body: revisionBody, key: key('rev'), expect: 400 })).body.error, 'invalid_request');
    assert.equal((await client.call('POST', `/api/ledger/budget/${revision.body.line.id}/revisions`, { cookie: T, body: { plannedCents: 100, reason: 'ab' }, key: key('rev'), expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    await assertRequiredFieldsEnforced(client, T, `/api/ledger/budget/${revision.body.line.id}/revisions`, revisionBody, components.LedgerBudgetLineRevisionRequest.required);

    // ---------- Preliminarz: przyjęcie przez zebranie (wyłącznie zarząd) ----------
    const adoptionBody = { schoolYearId: YEAR, adoptedOn: '2026-10-15', note: 'Przyjęcie bez uchwały (syntetyczne)' };
    const adoptionKey = key('adopt');
    const adoption = await client.call('POST', '/api/ledger/budget/adoptions', { cookie: A, body: adoptionBody, key: adoptionKey, expect: 201 });
    assert.deepEqual(adoption.body.adoption.lineIds, [incomeLine.body.line.id, revision.body.line.id].sort());
    assert.equal(adoption.body.adoption.resolutionId, null);
    const adoptionReplay = await client.call('POST', '/api/ledger/budget/adoptions', { cookie: A, body: adoptionBody, key: adoptionKey, expect: 200 });
    assert.deepEqual(adoptionReplay.body, adoption.body);
    const resolution = await adoptedResolution(db);
    const withResolution = await client.call('POST', '/api/ledger/budget/adoptions', {
      cookie: B, key: key('adopt'), expect: 201, body: { schoolYearId: YEAR, adoptedOn: '2026-10-20', note: 'Przyjęcie uchwałą (syntetyczne)', resolutionId: resolution.id },
    });
    assert.equal(withResolution.body.adoption.resolutionId, resolution.id);
    assert.equal((await client.call('POST', '/api/ledger/budget/adoptions', { cookie: T, body: adoptionBody, key: key('adopt'), expect: 403 })).body.error, 'forbidden');
    assert.equal((await client.call('POST', '/api/ledger/budget/adoptions', { cookie: A, body: { ...adoptionBody, resolutionId: 'nie-ma-takiej' }, key: key('adopt'), expect: 404 })).body.error, 'resolution_not_found');
    assert.equal((await client.call('POST', '/api/ledger/budget/adoptions', { cookie: A, body: { ...adoptionBody, schoolYearId: NEXT, adoptedOn: '2027-10-15' }, key: key('adopt'), expect: 409 })).body.error, 'budget_empty');
    assert.equal((await client.call('POST', '/api/ledger/budget/adoptions', { cookie: G, body: { ...adoptionBody, schoolYearId: MISSING_YEAR }, key: key('adopt'), expect: 404 })).body.error, 'school_year_not_found');
    assert.equal((await client.call('POST', '/api/ledger/budget/adoptions', { cookie: A, body: { ...adoptionBody, note: 'ab' }, key: key('adopt'), expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    await assertRequiredFieldsEnforced(client, A, '/api/ledger/budget/adoptions', adoptionBody, components.LedgerBudgetAdoptionRequest.required);

    // ---------- Preliminarz: wyłączenie kategorii ----------
    const deactivationBody = { reason: 'Kategoria połączona z inną (syntetyczne)' };
    const deactivationKey = key('deact');
    const deactivation = await client.call('POST', '/api/ledger/categories/cat-old/deactivation', { cookie: B, body: deactivationBody, key: deactivationKey, expect: 201 });
    assert.deepEqual([deactivation.body.deactivation.categoryId, deactivation.body.deactivation.reason], ['cat-old', deactivationBody.reason]);
    const deactivationReplay = await client.call('POST', '/api/ledger/categories/cat-old/deactivation', { cookie: B, body: deactivationBody, key: deactivationKey, expect: 200 });
    assert.equal(deactivationReplay.body.deactivation.id, deactivation.body.deactivation.id);
    assert.equal((await client.call('POST', '/api/ledger/categories/cat-old/deactivation', { cookie: B, body: { reason: 'Inny powód' }, key: deactivationKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', '/api/ledger/categories/cat-old/deactivation', { cookie: T, body: deactivationBody, key: key('deact'), expect: 409 })).body.error, 'category_inactive');
    assert.equal((await client.call('POST', '/api/ledger/categories/nie-ma-takiej/deactivation', { cookie: T, body: deactivationBody, key: key('deact'), expect: 404 })).body.error, 'category_not_found');
    assert.equal((await client.call('POST', '/api/ledger/categories/zla%20kategoria/deactivation', { cookie: T, body: deactivationBody, key: key('deact'), expect: 400 })).body.error, 'invalid_request');
    assert.equal((await client.call('POST', '/api/ledger/categories/cat-trip/deactivation', { cookie: T, body: { reason: 'Uwaga dla jan@example.invalid' }, key: key('deact'), expect: 422 })).body.error, 'personal_data_forbidden');
    assert.equal((await client.call('POST', '/api/ledger/categories/cat-trip/deactivation', { cookie: T, body: 'reason=x', key: key('deact'), expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');
    await assertRequiredFieldsEnforced(client, T, '/api/ledger/categories/cat-trip/deactivation', deactivationBody, components.LedgerCategoryDeactivationRequest.required);

    // ---------- Preliminarz: historia i wykonanie ----------
    const history = await client.call('GET', `/api/ledger/budget/history?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual(
      history.body.lines.map((item) => [item.id, item.current, item.supersededById]).sort(),
      [[line.body.line.id, false, revision.body.line.id], [revision.body.line.id, true, null], [incomeLine.body.line.id, true, null]].sort(),
    );
    assert.deepEqual(history.body.adoptions.map((item) => item.resolutionNumber), [null, 'P-1/2026']);
    const execution = await client.call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}`, { cookie: A, expect: 200 });
    const { execution: report } = execution.body;
    assert.deepEqual([report.adoption.id, report.adoption.resolutionNumber, report.check.ok], [withResolution.body.adoption.id, 'P-1/2026', true]);
    assert.deepEqual(
      report.items.map((item) => [item.categoryId, item.currentPlanCents, item.executedNetCents, item.executionPercent, item.outsidePlan]),
      [['cat-inc', 50000, 40000, 80, false], ['cat-exp', 18000, 15000, 83.3, false], ['cat-trip', null, 9000, null, true]],
    );
    const asOf = await client.call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&asOf=2026-10-16&format=json`, { cookie: T, expect: 200 });
    assert.deepEqual([asOf.body.execution.asOf, asOf.body.execution.check, asOf.body.execution.adoption.id], ['2026-10-16', null, adoption.body.adoption.id]);
    const beforeAdoption = await client.call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&asOf=2026-09-30`, { cookie: T, expect: 200 });
    assert.deepEqual([beforeAdoption.body.execution.adoption, beforeAdoption.body.execution.totals.expense.adoptedPlanCents], [null, null]);
    const csv = await client.call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&format=csv`, { cookie: T, expect: 200 });
    assert.match(new TextDecoder().decode(csv.bytes), /plan_biezacy_eur/);
    await client.call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&format=xlsx`, { cookie: T, expect: 200 });
    const html = await client.call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&format=html`, { cookie: T, expect: 200 });
    assert.match(new TextDecoder().decode(html.bytes), /<html/i);
    assert.equal((await client.call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&format=pdf`, { cookie: T, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('GET', `/api/ledger/budget/execution?schoolYearId=${MISSING_YEAR}`, { cookie: G, expect: 404 })).body.error, 'school_year_not_found');
    assert.equal((await client.call('GET', '/api/ledger/budget/history?schoolYearId=zly%20rok', { cookie: T, expect: 400, invalidRequest: true })).body.error, 'invalid_request');

    // ---------- Kasa: bilans otwarcia pierwszego roku i poprawki (wyłącznie zarząd) ----------
    const empty = await client.call('GET', `/api/ledger/opening-balance?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual(empty.body, { schoolYearId: YEAR, openingBalance: null, adjustments: [], current: null });
    const openingBody = { schoolYearId: YEAR, bankCents: 50000, cashCents: 2500, note: 'Bilans z protokołu przekazania (syntetyczny)', sourceDocumentId: 'd1' };
    assert.equal((await client.call('POST', '/api/ledger/opening-balance', { cookie: A, body: { ...openingBody, sourceDocumentId: 'doc-brak' }, key: key('ob'), expect: 400 })).body.error, 'invalid_source_document');
    const openingKey = key('ob');
    const opening = await client.call('POST', '/api/ledger/opening-balance', { cookie: A, body: openingBody, key: openingKey, expect: 201 });
    assert.deepEqual(opening.body.current, { amountCents: 52500, cashCents: 2500, bankCents: 50000 });
    assert.deepEqual([opening.body.openingBalance.sourceDocumentId, opening.body.openingBalance.carriedFromSchoolYearId], ['d1', null]);
    const openingReplay = await client.call('POST', '/api/ledger/opening-balance', { cookie: A, body: openingBody, key: openingKey, expect: 200 });
    assert.equal(openingReplay.body.openingBalance.id, opening.body.openingBalance.id);
    assert.equal((await client.call('POST', '/api/ledger/opening-balance', { cookie: A, body: { ...openingBody, cashCents: 2600 }, key: openingKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', '/api/ledger/opening-balance', { cookie: B, body: openingBody, key: key('ob'), expect: 409 })).body.error, 'opening_balance_exists');
    assert.equal((await client.call('POST', '/api/ledger/opening-balance', { cookie: A, body: { ...openingBody, schoolYearId: NEXT, sourceDocumentId: null }, key: key('ob'), expect: 409 })).body.error, 'not_first_school_year');
    assert.equal((await client.call('POST', '/api/ledger/opening-balance', { cookie: G, body: { ...openingBody, schoolYearId: MISSING_YEAR, sourceDocumentId: null }, key: key('ob'), expect: 404 })).body.error, 'school_year_not_found');
    assert.equal((await client.call('POST', '/api/ledger/opening-balance', { cookie: A, body: { ...openingBody, cashCents: -1 }, key: key('ob'), expect: 400, invalidRequest: true })).body.error, 'invalid_amount');
    assert.equal((await client.call('POST', '/api/ledger/opening-balance', { cookie: A, body: { ...openingBody, note: 'ab' }, key: key('ob'), expect: 400, invalidRequest: true })).body.error, 'invalid_note');
    assert.equal((await client.call('POST', '/api/ledger/opening-balance', { cookie: T, body: openingBody, key: key('ob'), expect: 403 })).body.error, 'forbidden');
    await assertRequiredFieldsEnforced(client, A, '/api/ledger/opening-balance', openingBody, components.LedgerOpeningBalanceRequest.required);

    const adjustmentBody = { schoolYearId: YEAR, amountCents: 0, cashCents: -1000, reason: 'Część gotówki była już na rachunku' };
    const adjustmentKey = key('adj');
    const adjustment = await client.call('POST', '/api/ledger/opening-balance/adjustments', { cookie: B, body: adjustmentBody, key: adjustmentKey, expect: 201 });
    assert.deepEqual(adjustment.body.current, { amountCents: 52500, cashCents: 1500, bankCents: 51000 });
    assert.equal(adjustment.body.adjustments[0].id, adjustment.body.adjustmentId);
    const adjustmentReplay = await client.call('POST', '/api/ledger/opening-balance/adjustments', { cookie: B, body: adjustmentBody, key: adjustmentKey, expect: 200 });
    assert.equal(adjustmentReplay.body.adjustmentId, adjustment.body.adjustmentId);
    const below = await client.call('POST', '/api/ledger/opening-balance/adjustments', { cookie: B, body: { schoolYearId: YEAR, cashCents: -5000, reason: 'Za duża korekta kasy' }, key: key('adj'), expect: 409 });
    assert.equal(below.body.error, 'cash_below_zero');
    assert.equal((await client.call('POST', '/api/ledger/opening-balance/adjustments', { cookie: B, body: { ...adjustmentBody, cashCents: 0 }, key: key('adj'), expect: 400 })).body.error, 'invalid_amount');
    assert.equal((await client.call('POST', '/api/ledger/opening-balance/adjustments', { cookie: B, body: { ...adjustmentBody, schoolYearId: NEXT }, key: key('adj'), expect: 404 })).body.error, 'opening_balance_not_found');
    assert.equal((await client.call('POST', '/api/ledger/opening-balance/adjustments', { cookie: B, body: { ...adjustmentBody, reason: 'ab' }, key: key('adj'), expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    assert.equal((await client.call('POST', '/api/ledger/opening-balance/adjustments', { cookie: T, body: adjustmentBody, key: key('adj'), expect: 403 })).body.error, 'forbidden');
    await assertRequiredFieldsEnforced(client, B, '/api/ledger/opening-balance/adjustments', adjustmentBody, components.LedgerOpeningBalanceAdjustmentRequest.required);
    const view = await client.call('GET', `/api/ledger/opening-balance?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual([view.body.openingBalance.cashCents, view.body.adjustments.length, view.body.current.cashCents], [2500, 1, 1500]);
    assert.equal((await client.call('GET', `/api/ledger/opening-balance?schoolYearId=${MISSING_YEAR}`, { cookie: G, expect: 404 })).body.error, 'school_year_not_found');

    // ---------- Kasa: przeniesienia ze stornem ----------
    const transferBody = { schoolYearId: YEAR, direction: 'cash_to_bank', amountCents: 1000, transferredOn: '2026-10-01', description: 'Wpłata gotówki z kasy na rachunek', sourceDocumentId: 'd1' };
    const transferKey = key('tr');
    const transfer = await client.call('POST', '/api/ledger/transfers', { cookie: T, body: transferBody, key: transferKey, expect: 201 });
    assert.deepEqual([transfer.body.transfer.reversesId, transfer.body.transfer.sourceDocumentId], [null, 'd1']);
    await client.call('POST', '/api/ledger/transfers', { cookie: T, body: transferBody, key: transferKey, expect: 200 });
    const stornoBody = { schoolYearId: YEAR, reversesId: transfer.body.transfer.id, description: 'Storno: błędna kwota' };
    const storno = await client.call('POST', '/api/ledger/transfers', { cookie: A, body: stornoBody, key: key('tr'), expect: 201 });
    assert.deepEqual([storno.body.transfer.direction, storno.body.transfer.amountCents, storno.body.transfer.reversesId], ['bank_to_cash', 1000, transfer.body.transfer.id]);
    assert.equal((await client.call('POST', '/api/ledger/transfers', { cookie: T, body: stornoBody, key: key('tr'), expect: 409 })).body.error, 'transfer_already_reversed');
    assert.equal((await client.call('POST', '/api/ledger/transfers', { cookie: T, body: { ...stornoBody, reversesId: storno.body.transfer.id }, key: key('tr'), expect: 409 })).body.error, 'invalid_reversal');
    assert.equal((await client.call('POST', '/api/ledger/transfers', { cookie: T, body: { ...stornoBody, reversesId: 'nie-ma-takiego' }, key: key('tr'), expect: 404 })).body.error, 'transfer_not_found');
    assert.equal((await client.call('POST', '/api/ledger/transfers', { cookie: T, body: { ...transferBody, transferredOn: '2027-09-01' }, key: key('tr'), expect: 422 })).body.error, 'date_outside_school_year');
    assert.equal((await client.call('POST', '/api/ledger/transfers', { cookie: T, body: { ...transferBody, sourceDocumentId: 'doc-brak' }, key: key('tr'), expect: 400 })).body.error, 'invalid_source_document');
    assert.equal((await client.call('POST', '/api/ledger/transfers', { cookie: T, body: { ...transferBody, amountCents: 0 }, key: key('tr'), expect: 400, invalidRequest: true })).body.error, 'invalid_amount');
    assert.equal((await client.call('POST', '/api/ledger/transfers', { cookie: T, body: { ...transferBody, description: 'ab' }, key: key('tr'), expect: 400, invalidRequest: true })).body.error, 'invalid_description');
    assert.equal((await client.call('POST', '/api/ledger/transfers', { cookie: T, body: { ...transferBody, description: 'x'.repeat(17000) }, key: key('tr'), expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', '/api/ledger/transfers', { cookie: T, body: { ...transferBody, description: 'Gotówka od jan@example.invalid' }, key: key('tr'), expect: 422 })).body.error, 'personal_data_forbidden');
    await assertRequiredFieldsEnforced(client, T, '/api/ledger/transfers', transferBody, components.LedgerTransferRequest.required);
    const transfers = await client.call('GET', `/api/ledger/transfers?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.equal(transfers.body.transfers.length, 2);
    assert.equal((await client.call('GET', `/api/ledger/transfers?schoolYearId=${MISSING_YEAR}`, { cookie: G, expect: 404 })).body.error, 'school_year_not_found');

    // ---------- Centra kosztów: przypisanie wpisu i wersje ----------
    const none = await client.call('GET', '/api/ledger/le-out/allocations', { cookie: T, expect: 200 });
    assert.deepEqual([none.body.allocation.currentVersionId, none.body.allocation.versions, none.body.allocation.generalCents], [null, [], 15000]);
    const firstBody = { items: [{ eventId: 'ev-fair', amountCents: 15000 }] };
    const firstKey = key('alloc');
    const first = await client.call('POST', '/api/ledger/le-out/allocations', { cookie: T, body: firstBody, key: firstKey, expect: 201 });
    assert.deepEqual([first.body.allocation.allocatedCents, first.body.allocation.generalCents, first.body.versionId], [15000, 0, first.body.allocation.currentVersionId]);
    const firstReplay = await client.call('POST', '/api/ledger/le-out/allocations', { cookie: T, body: firstBody, key: firstKey, expect: 200 });
    assert.equal(firstReplay.body.versionId, first.body.versionId);
    // Druga „pierwsza” wersja innym kluczem (podwójne kliknięcie) — odrzucona ze wskazaniem bieżącej.
    const stale = await client.call('POST', '/api/ledger/le-out/allocations', { cookie: B, body: firstBody, key: key('alloc'), expect: 409 });
    assert.deepEqual([stale.body.error, stale.body.currentVersionId], ['allocation_version_conflict', first.body.versionId]);
    const splitBody = {
      items: [{ classId: 'c-1a', amountCents: 4000 }, { classId: 'c-1b', amountCents: 3000 }],
      supersedesId: first.body.versionId, reason: 'Koszt dzielony między klasy',
    };
    const split = await client.call('POST', '/api/ledger/le-out/allocations', { cookie: A, body: splitBody, key: key('alloc'), expect: 201 });
    assert.deepEqual(
      [split.body.allocation.versions.map((version) => version.versionNo), split.body.allocation.allocatedCents, split.body.allocation.generalCents],
      [[1, 2], 7000, 8000],
    );
    const exceeds = { ...splitBody, supersedesId: split.body.versionId, items: [{ eventId: 'ev-ball', amountCents: 15001 }] };
    assert.equal((await client.call('POST', '/api/ledger/le-out/allocations', { cookie: T, body: exceeds, key: key('alloc'), expect: 409 })).body.error, 'allocation_exceeds_net');
    assert.equal((await client.call('POST', '/api/ledger/le-out/allocations', { cookie: T, body: { items: [], supersedesId: split.body.versionId }, key: key('alloc'), expect: 400 })).body.error, 'allocation_reason_required');
    assert.equal((await client.call('POST', '/api/ledger/le-out/allocations', { cookie: T, body: { items: [{ eventId: 'ev-fair', classId: 'c-1a', amountCents: 100 }] }, key: key('alloc'), expect: 400, invalidRequest: true })).body.error, 'invalid_allocation');
    assert.equal((await client.call('POST', '/api/ledger/le-trip/allocations', { cookie: T, body: { items: [{ eventId: 'ev-brak', amountCents: 100 }] }, key: key('alloc'), expect: 400 })).body.error, 'invalid_cost_center');
    assert.equal((await client.call('POST', '/api/ledger/nie-ma-takiego/allocations', { cookie: T, body: firstBody, key: key('alloc'), expect: 404 })).body.error, 'ledger_entry_not_found');
    assert.equal((await client.call('POST', '/api/ledger/zly%20wpis/allocations', { cookie: T, body: firstBody, key: key('alloc'), expect: 400 })).body.error, 'invalid_id');
    assert.equal((await client.call('POST', '/api/ledger/le-trip/allocations', { cookie: T, body: { items: [], reason: 'Dla jan@example.invalid' }, key: key('alloc'), expect: 422 })).body.error, 'personal_data_forbidden');
    await assertRequiredFieldsEnforced(client, T, '/api/ledger/le-trip/allocations', firstBody, components.LedgerAllocationRequest.required);
    await client.call('POST', '/api/ledger/le-in/allocations', { cookie: T, body: { items: [{ eventId: 'ev-fair', amountCents: 40000 }] }, key: key('alloc'), expect: 201 });
    const history2 = await client.call('GET', '/api/ledger/le-out/allocations', { cookie: B, expect: 200 });
    assert.deepEqual(history2.body.allocation.versions.map((version) => [version.supersedesId, version.items.length]), [[null, 1], [first.body.versionId, 2]]);
    assert.equal((await client.call('GET', '/api/ledger/nie-ma-takiego/allocations', { cookie: T, expect: 404 })).body.error, 'ledger_entry_not_found');

    // ---------- Centra kosztów: raport i rozliczenie wydarzenia ----------
    const events = await client.call('GET', `/api/ledger/cost-centers?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual(events.body.report.centers.map((row) => [row.id, row.status, row.incomeCents, row.expenseCents, row.resultCents]), [['ev-fair', 'draft', 40000, 0, 40000]]);
    assert.deepEqual(events.body.report.totals, { incomeCents: 40000, expenseCents: 24000, resultCents: 16000 });
    const classes = await client.call('GET', `/api/ledger/cost-centers?schoolYearId=${YEAR}&type=class&format=json`, { cookie: T, expect: 200 });
    assert.deepEqual(classes.body.report.centers.map((row) => [row.id, row.status, row.expenseCents]), [['c-1a', null, 4000], ['c-1b', null, 3000]]);
    assert.deepEqual(classes.body.report.general, { incomeCents: 40000, expenseCents: 17000, resultCents: 23000 });
    const centersCsv = await client.call('GET', `/api/ledger/cost-centers?schoolYearId=${YEAR}&type=class&format=csv`, { cookie: T, expect: 200 });
    assert.match(new TextDecoder().decode(centersCsv.bytes), /klasa;c-1a;1A;;0,00;40,00;-40,00/);
    await client.call('GET', `/api/ledger/cost-centers?schoolYearId=${YEAR}&format=xlsx`, { cookie: T, expect: 200 });
    assert.equal((await client.call('GET', `/api/ledger/cost-centers?schoolYearId=${YEAR}&type=family`, { cookie: T, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('GET', `/api/ledger/cost-centers?schoolYearId=${MISSING_YEAR}`, { cookie: G, expect: 404 })).body.error, 'school_year_not_found');
    const fair = await client.call('GET', '/api/ledger/cost-centers/events/ev-fair', { cookie: T, expect: 200 });
    assert.deepEqual([fair.body.event.incomeCents, fair.body.event.expenseCents, fair.body.event.entries.map((item) => item.ledgerEntryId)], [40000, 0, ['le-in']]);
    assert.equal((await client.call('GET', '/api/ledger/cost-centers/events/ev-brak', { cookie: T, expect: 404 })).body.error, 'event_not_found');
    assert.equal((await client.call('GET', '/api/ledger/cost-centers/events/zle%20wydarzenie', { cookie: T, expect: 400 })).body.error, 'invalid_id');

    // ---------- Granice ról: brak sesji, przedstawiciel klasy, Komisja Rewizyjna, brak MFA ----------
    const reads = [
      `/api/ledger/budget/history?schoolYearId=${YEAR}`, `/api/ledger/budget/execution?schoolYearId=${YEAR}`,
      `/api/ledger/opening-balance?schoolYearId=${YEAR}`, `/api/ledger/transfers?schoolYearId=${YEAR}`,
      `/api/ledger/cost-centers?schoolYearId=${YEAR}&type=class`, '/api/ledger/le-out/allocations', '/api/ledger/cost-centers/events/ev-fair',
    ];
    for (const path of reads) {
      await client.call('GET', path, { expect: 401 });
      assert.equal((await client.call('GET', path, { cookie: cookies.rep, expect: 403 })).body.error, 'forbidden', path);
      assert.equal((await client.call('GET', path, { cookie: cookies.audit, expect: 403 })).body.error, 'forbidden', path);
      assert.equal((await client.call('GET', path, { cookie: cookies.boardNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required', path);
    }
    const writes = [
      ['/api/ledger/budget', { schoolYearId: YEAR, categoryId: 'cat-trip', plannedCents: 100 }],
      ['/api/ledger/budget/adoptions', adoptionBody],
      ['/api/ledger/categories/cat-trip/deactivation', deactivationBody],
      ['/api/ledger/opening-balance/adjustments', adjustmentBody],
      ['/api/ledger/transfers', transferBody],
      ['/api/ledger/le-trip/allocations', { items: [] }],
    ];
    for (const [path, body] of writes) {
      await client.call('POST', path, { body, key: key('auth'), expect: 401 });
      assert.equal((await client.call('POST', path, { cookie: cookies.rep, body, key: key('auth'), expect: 403 })).body.error, 'forbidden', path);
      assert.equal((await client.call('POST', path, { cookie: cookies.boardNoMfa, body, key: key('auth'), expect: 403 })).body.error, 'mfa_enrollment_required', path);
      assert.equal((await client.call('POST', path, { cookie: T, body, key: key('auth'), origin: 'https://obca.example.invalid', expect: 403 })).body.error, 'invalid_origin', path);
    }

    // ---------- Zamknięty rok: zamknięcie przez trasy year-close, potem 409 ----------
    await closeYear(env, cookies);
    const carried = await client.call('GET', `/api/ledger/opening-balance?schoolYearId=${NEXT}`, { cookie: T, expect: 200 });
    assert.equal(carried.body.openingBalance.carriedFromSchoolYearId, YEAR);
    const closedWrites = [
      ['/api/ledger/budget', { schoolYearId: YEAR, categoryId: 'cat-trip', plannedCents: 100 }],
      [`/api/ledger/budget/${revision.body.line.id}/revisions`, { plannedCents: 1000, reason: 'Po zamknięciu roku' }],
      ['/api/ledger/budget/adoptions', { ...adoptionBody, adoptedOn: '2027-08-30' }],
      ['/api/ledger/categories/cat-trip/deactivation', deactivationBody],
      ['/api/ledger/opening-balance/adjustments', { ...adjustmentBody, cashCents: 100 }],
      ['/api/ledger/transfers', { ...transferBody, transferredOn: '2027-08-01' }],
      ['/api/ledger/le-trip/allocations', { items: [{ classId: 'c-1a', amountCents: 100 }] }],
    ];
    for (const [path, body] of closedWrites) {
      assert.equal((await client.call('POST', path, { cookie: G, body, key: key('closed'), expect: 409 })).body.error, 'school_year_closed', path);
    }

    assertSuccessCoverage(client, MODULES);
  } finally {
    await db.close();
  }
});
