// Kontrakt API (#160, etapy 2-11): schematy ciał żądań i odpowiedzi w docs/openapi.json
// (src/pg/schemas/*) — wpłaty (payments, payment-references, payment-instructions) i księga
// (ledger) tutaj; rodziny (families) i sesja (session) w tests/openapi-contract-families.test.js;
// preliminarz, kasa i centra kosztów (ledger-budget, ledger-cash, ledger-cost-centers)
// w tests/openapi-contract-ledger-extra.test.js; uzgodnienia wyciągów i raport KR (reconciliation)
// w tests/openapi-contract-reconciliation.test.js; kampanie e-mail (email) w
// tests/openapi-contract-email.test.js; zebrania (meetings) w tests/openapi-contract-meetings.test.js; dokumenty
// (documents) w tests/openapi-contract-documents.test.js; wydarzenia (events) w tests/openapi-contract-events.test.js;
// aktualności i galeria (news) w tests/openapi-contract-news.test.js; logowanie hasłem i MFA (login, mfa)
// w tests/openapi-contract-auth.test.js.
// Testy rejestru poniżej obejmują wszystkie pokryte moduły.
//
//  * rejestr pokrycia: każda trasa pokrytego modułu MA schemat; moduły bez schematów
//    są wymienione jawnie (UNCOVERED_MODULES) i lista może tylko maleć;
//  * kody błędów w schematach należą do katalogu docs/API_ERRORS.md i występują w źródle;
//  * prawdziwe odpowiedzi tras (PGlite, dane syntetyczne) przechodzą walidację schematem:
//    utworzenie, ponowienie z tym samym kluczem (Idempotency-Replayed), korekta częściowa,
//    lista z kursorem, odmowy i błędy z katalogu.
// Walidator: tests/helpers/json-schema.js (bez nowej zależności).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { createMeeting, createResolution, determineQuorum, recordAttendance } from '../src/pg/meetings.js';
import { OPENAPI_PATH, parseErrorCatalog } from '../scripts/build-openapi.js';
import { COVERED_MODULES, ROUTE_SCHEMAS, SCHEMA_MODULES, UNCOVERED_MODULES } from '../src/pg/schemas/index.js';
import { ROUTE_MATRIX } from './helpers/route-matrix.js';
import { createContractClient } from './helpers/contract-client.js';
import { validateSchema } from './helpers/json-schema.js';
import { updateMeeting } from './helpers/with-revision.js';
import {
  createTestDb, seedClass, seedEnrolledHousehold, seedRoleGrant, seedSchoolYear, seedUser, seedUserSession,
} from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const errorCatalog = parseErrorCatalog(await readFile(new URL('../docs/API_ERRORS.md', import.meta.url), 'utf8')).map((row) => row.code);
const components = spec.components.schemas;

// Sufit listy niepokrytych modułów: kolejne PR-y go obniżają (razem z UNCOVERED_MODULES).
const MAX_UNCOVERED_MODULES = 12;
// Zapisy bez ciała żądania (cały zapis wynika ze ścieżki albo z sesji).
const POST_WITHOUT_BODY = new Set([
  'POST /api/ledger/categories/{categoryId}/deactivate', 'POST /api/logout',
  // Kampanie e-mail (#160 etap 6): przejścia stanu kampanii wynikają ze ścieżki; wypisanie — z tokenu w zapytaniu.
  'POST /api/email/campaigns/{campaignId}/snapshot', 'POST /api/email/campaigns/{campaignId}/queue',
  'POST /api/email/campaigns/{campaignId}/pause', 'POST /api/email/campaigns/{campaignId}/resume',
  'POST /api/email/campaigns/{campaignId}/cancel', 'POST /api/email/campaigns/{campaignId}/followup',
  'POST /api/email/campaigns/{campaignId}/resolutions/{resolutionId}/approve', 'POST /api/email/preferences',
  // Wydarzenia (#160 etap 9): wycofanie zapisu wolontariusza nie czyta ciała.
  'POST /api/events/{eventId}/tasks/{taskId}/signups/{signupId}/withdraw',
  // Aktualności (#160 etap 10): wycofanie zgody na wizerunek wynika z odwołania w ścieżce, trasa nie czyta ciała.
  'POST /api/news-photo-consents/{consentDocumentRef}/withdraw',
  // MFA i sesje własne (#160 etap 11): zapis czynnika i cofnięcie sesji wynikają z sesji i ścieżki, trasy nie czytają ciała.
  'POST /api/mfa/enroll', 'POST /api/sessions/revoke-all', 'POST /api/sessions/{id}/revoke',
]);

// Pliki pomocnicze trasy (ścieżki względem src/pg/), których kody błędów trasa zwraca bez zmiany:
// email — parser treści kampanii (ContentError), odmowa adresu wysyłki testowej (previewRecipientRefusal)
// i kursor list (parseListLimit/decodeListCursor); reconciliation — parsery wyciągów banku; meetings —
// moduł domenowy (src/pg/routes/meetings.js tylko go podpina; kody reguł bazy w DATABASE_CONFLICTS) i kursor list;
// documents — kontrola struktury pliku (validateStructure w src/documents.js: document_active_content,
// document_malformed) i kursor listy; events — moduł domenowy (src/pg/routes/events.js tylko go podpina) i kursor
// publicznej listy; news — moduł domenowy (src/pg/routes/news.js tylko go podpina; kody reguł bazy w DB_ERRORS) i kursor list;
// login — logika logowania, zaproszeń i resetu (src/pg/login.js) i polityka haseł (src/pg/password.js); mfa — TOTP, kody
// odzyskiwania i limity (src/pg/mfa.js).
const ROUTE_HELPER_SOURCES = {
  documents: ['../documents.js', 'list-cursor.js'],
  email: ['../email/content.js', '../email/brevo.js', 'list-cursor.js'],
  events: ['events.js', 'list-cursor.js'],
  login: ['login.js', 'password.js'],
  meetings: ['meetings.js', 'list-cursor.js'],
  mfa: ['mfa.js'],
  news: ['news.js', 'list-cursor.js'],
  reconciliation: ['bank/common.js', 'bank/coda.js', 'bank/camt053.js'],
};

const openApiPath = (route) => route.path.split('?')[0].replace(/:([A-Za-z]\w*)/g, '{$1}');
const routeKey = (route) => `${route.method} ${openApiPath(route)}`;

// Trasy macierzy pokrytych modułów, którym brakuje schematu w rejestrze.
function routesWithoutSchema(matrix, coveredModules, schemaKeys) {
  return matrix.filter((route) => coveredModules.includes(route.module) && !schemaKeys.has(routeKey(route))).map(routeKey);
}

// --- Walidator schematów ----------------------------------------------------------

test('walidator: zgodna wartość przechodzi, a każde naruszenie jest zgłoszone (kontrola pozytywna)', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      amountCents: { $ref: '#/components/schemas/Cents' },
      on: { type: 'string', format: 'date' },
      at: { type: 'string', format: 'date-time' },
      note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      kind: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    },
    required: ['id', 'amountCents'],
    additionalProperties: false,
  };
  const options = { components: { Cents: { type: 'integer', minimum: 1 } } };
  const good = { id: 'x', amountCents: 5, on: '2026-10-03', at: '2026-10-03T10:00:00.000Z', note: null, kind: 'a', tags: ['t'] };
  assert.deepEqual(validateSchema(schema, good, options), []);
  const bad = [
    [{ amountCents: 5 }, /brak wymaganego pola/],
    [{ ...good, amountCents: 0 }, /minimum/],
    [{ ...good, amountCents: 1.5 }, /oczekiwano integer/],
    [{ ...good, extra: 1 }, /pole spoza schematu/],
    [{ ...good, on: '2026-02-30' }, /zły format date/],
    [{ ...good, at: '2026-10-03' }, /zły format date-time/],
    [{ ...good, note: 5 }, /anyOf/],
    [{ ...good, kind: 'c' }, /spoza enum/],
    [{ ...good, tags: ['a', 'b', 'c'] }, /za dużo elementów/],
    [{ ...good, id: '' }, /za krótki/],
  ];
  for (const [value, pattern] of bad) {
    const problems = validateSchema(schema, value, options);
    assert.ok(problems.length > 0 && pattern.test(problems.join('; ')), `${JSON.stringify(value)} -> ${problems.join('; ')}`);
  }
});

test('walidator: nieznane słowo kluczowe i brakujący $ref są błędem, nie ciche przepuszczenie', () => {
  assert.throws(() => validateSchema({ type: 'string', patternProperties: {} }, 'x'), /nieobsługiwane słowo kluczowe/);
  assert.throws(() => validateSchema({ $ref: '#/components/schemas/Brak' }, 1, { components: {} }), /brak schematu/);
  assert.throws(() => validateSchema({ type: 'string', format: 'uuid' }, 'x'), /nieobsługiwany format/);
});

// --- Rejestr pokrycia -----------------------------------------------------------------

test('rejestr: moduły macierzy = pokryte + jawnie niepokryte, a lista niepokrytych nie rośnie', () => {
  const matrixModules = [...new Set(ROUTE_MATRIX.map((route) => route.module))].sort();
  assert.deepEqual([...COVERED_MODULES, ...UNCOVERED_MODULES].sort(), matrixModules);
  assert.deepEqual(COVERED_MODULES.filter((name) => UNCOVERED_MODULES.includes(name)), []);
  assert.ok(COVERED_MODULES.length >= 4, 'pierwsze moduły: payments, payment-references, payment-instructions, ledger');
  assert.ok(UNCOVERED_MODULES.length <= MAX_UNCOVERED_MODULES, `lista niepokrytych modułów urosła ponad ${MAX_UNCOVERED_MODULES}`);
  assert.equal(spec['x-rd-schema-coverage'].covered.length, COVERED_MODULES.length);
  assert.deepEqual(spec['x-rd-schema-coverage'].uncovered, [...UNCOVERED_MODULES].sort());
});

test('rejestr: każda trasa pokrytego modułu ma schemat, a każdy schemat ma trasę w macierzy', () => {
  const keys = new Set(ROUTE_SCHEMAS.keys());
  assert.deepEqual(routesWithoutSchema(ROUTE_MATRIX, COVERED_MODULES, keys), []);
  const matrixKeys = new Set(ROUTE_MATRIX.filter((route) => COVERED_MODULES.includes(route.module)).map(routeKey));
  assert.deepEqual([...keys].filter((key) => !matrixKeys.has(key)), []);
  const modulesByKey = new Map(ROUTE_MATRIX.map((route) => [routeKey(route), route.module]));
  assert.deepEqual([...ROUTE_SCHEMAS].filter(([key, entry]) => modulesByKey.get(key) !== entry.module).map(([key]) => key), []);
  assert.ok(ROUTE_SCHEMAS.size >= 32, `pokryte trasy: ${ROUTE_SCHEMAS.size}`);
});

test('rejestr: detektor wskazuje trasę pokrytego modułu bez schematu (kontrola pozytywna)', () => {
  const fake = { id: 'payments.nowa', module: 'payments', method: 'POST', path: '/api/payments/:paymentId/nowa' };
  const keys = new Set(ROUTE_SCHEMAS.keys());
  assert.deepEqual(routesWithoutSchema([...ROUTE_MATRIX, fake], COVERED_MODULES, keys), ['POST /api/payments/{paymentId}/nowa']);
  const uncovered = { id: 'x.y', module: UNCOVERED_MODULES[0], method: 'GET', path: '/api/x' };
  assert.deepEqual(routesWithoutSchema([uncovered], COVERED_MODULES, keys), []);
});

test('rejestr: operacje pokrytych modułów mają kształt dla każdego statusu sukcesu i ciało zapisu', () => {
  const problems = [];
  let checked = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!operation.tags.some((tag) => COVERED_MODULES.includes(tag))) continue;
      checked += 1;
      const key = `${method.toUpperCase()} ${path}`;
      for (const status of operation['x-rd-ok-status']) {
        const hasContent = Boolean(operation.responses[String(status)]?.content);
        // 204 nie ma treści; każdy inny status sukcesu musi mieć kształt.
        if (status === 204 ? hasContent : !hasContent) problems.push(`${key}: ${status === 204 ? 'treść przy 204' : 'brak kształtu odpowiedzi'} ${status}`);
      }
      if (method === 'post' && !operation.requestBody && !POST_WITHOUT_BODY.has(key)) problems.push(`${key}: brak requestBody`);
      if (method === 'get' && operation.requestBody) problems.push(`${key}: GET z requestBody`);
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) >= 400 && Number(status) !== 401 && !response['x-rd-error-codes']) problems.push(`${key}: status ${status} bez x-rd-error-codes`);
      }
    }
  }
  assert.ok(checked >= 32, `sprawdzone operacje: ${checked}`);
  assert.deepEqual(problems, []);
});

test('rejestr: kody błędów w schematach są w katalogu docs/API_ERRORS.md i w źródle trasy', async () => {
  const shared = await Promise.all(['input.js', 'authorization.js', 'app.js', 'pii-gate.js', 'db-errors.js']
    .map((file) => readFile(new URL(`../src/pg/${file}`, import.meta.url), 'utf8')));
  const problems = [];
  let codesChecked = 0;
  for (const module of SCHEMA_MODULES) {
    // Moduły z kodami poza plikiem trasy (ROUTE_HELPER_SOURCES: reconciliation — parsery CODA/CAMT.053, email — treść i Brevo,
    // meetings, events i news — moduły domenowe src/pg/meetings.js, src/pg/events.js i src/pg/news.js, documents — kontrola struktury
    // pliku w src/documents.js, login — src/pg/login.js i polityka haseł src/pg/password.js, mfa — src/pg/mfa.js).
    const helpers = await Promise.all((ROUTE_HELPER_SOURCES[module.name] ?? [])
      .map((file) => readFile(new URL(`../src/pg/${file}`, import.meta.url), 'utf8')));
    const source = [await readFile(new URL(`../src/pg/routes/${module.name}.js`, import.meta.url), 'utf8'), ...helpers, ...shared].join('\n');
    for (const [key, entry] of Object.entries(module.routes)) {
      for (const [status, codes] of Object.entries(entry.errors ?? {})) {
        for (const code of codes) {
          codesChecked += 1;
          if (!errorCatalog.includes(code)) problems.push(`${key} ${status}: ${code} spoza katalogu`);
          if (!source.includes(`'${code}'`)) problems.push(`${key} ${status}: ${code} nie występuje w źródle ${module.name}`);
        }
      }
    }
  }
  assert.ok(codesChecked > 150, `sprawdzone kody: ${codesChecked}`);
  assert.deepEqual(problems, []);
});

test('specyfikacja: każde $ref wskazuje istniejący schemat lub odpowiedź', () => {
  const targets = [];
  JSON.stringify(spec, (key, value) => { if (key === '$ref' && typeof value === 'string') targets.push(value); return value; });
  assert.ok(targets.length > 300, `odwołania $ref: ${targets.length}`);
  const missing = targets.filter((target) => {
    const match = /^#\/components\/(schemas|responses)\/(.+)$/.exec(target);
    return !match || !spec.components[match[1]]?.[match[2]];
  });
  assert.deepEqual([...new Set(missing)], []);
});

// --- Świat testowy -------------------------------------------------------------------

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

function newClient(env) {
  return createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
}

// Wszystkie odpowiedzi sukcesu opisane w schematach modułów zostały zwalidowane na prawdziwych odpowiedziach.
function assertSuccessCoverage(client, moduleNames) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (!moduleNames.includes(entry.module)) continue;
    for (const status of Object.keys(entry.responses)) expected.push(`${routeId} ${status}`);
  }
  assert.ok(expected.length >= 10, `oczekiwane odpowiedzi: ${expected.length}`);
  assert.deepEqual(expected.filter((item) => !client.validated.has(item)), [], 'odpowiedzi sukcesu opisane w schematach bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje błąd i w schemacie, i na serwerze (400).
async function assertRequiredFieldsEnforced(client, cookie, method, path, validBody, requiredFields) {
  assert.ok(requiredFields.length > 0, 'schemat ma wymagane pola');
  for (const field of requiredFields) {
    const { [field]: omitted, ...body } = validBody;
    assert.notEqual(omitted, undefined, `${field}: ciało testowe ma to pole`);
    const response = await client.call(method, path, { cookie, body, key: key('req'), expect: 400, invalidRequest: true });
    assert.equal(typeof response.body.error, 'string', `${field}: kod błędu`);
  }
}

// --- Wpłaty -------------------------------------------------------------------------------

async function paymentsWorld() {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y2025', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, 'y2026');
  for (const householdId of ['h1', 'h2', 'h3']) await seedEnrolledHousehold(db, householdId, ['y2025', 'y2026']);
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y2026' }] }),
    board: await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board', schoolYearId: 'y2026' }] }),
    rep: await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: 'y2026' }] }),
  };
  return { db, cookies, client: newClient({ db }) };
}

test('kontrakt wpłat: prawdziwe odpowiedzi payments, payment-references i payment-instructions zgodne ze schematami', async () => {
  const { db, cookies, client } = await paymentsWorld();
  const T = cookies.treasurer;
  try {
    // Utworzenie, ponowienie z tym samym kluczem i wpłata nieprzypisana.
    const bankBody = { schoolYearId: 'y2026', householdId: 'h1', amountCents: 5000, receivedOn: '2026-09-20', method: 'bank', reference: 'Wpłata syntetyczna' };
    const bankKey = key('pay');
    const created = await client.call('POST', '/api/payments', { cookie: T, body: bankBody, key: bankKey, expect: 201 });
    assert.equal(created.headers.get('Idempotency-Replayed'), 'false');
    assert.equal(created.body.payment.status, 'recorded');
    const replay = await client.call('POST', '/api/payments', { cookie: T, body: bankBody, key: bankKey, expect: 200 });
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(replay.body, created.body);
    const paymentId = created.body.payment.id;

    const unmatched = (await client.call('POST', '/api/payments', {
      cookie: T, key: key('pay'), expect: 201,
      body: { schoolYearId: 'y2026', householdId: null, amountCents: 6000, receivedOn: '2026-09-21', method: 'cash', reference: null },
    })).body.payment;
    assert.deepEqual([unmatched.status, unmatched.householdId, unmatched.reference], ['unmatched', null, null]);
    const toAssign = (await client.call('POST', '/api/payments', {
      cookie: T, key: key('pay'), expect: 201,
      body: { schoolYearId: 'y2026', amountCents: 2000, receivedOn: '2026-09-22', method: 'other' },
    })).body.payment;

    // Korekta częściowa i ponowienie.
    const correctionBody = { amountCents: 1000, reason: 'Korekta częściowa (syntetyczna)' };
    const correctionKey = key('cor');
    const correction = await client.call('POST', `/api/payments/${paymentId}/corrections`, { cookie: T, body: correctionBody, key: correctionKey, expect: 201 });
    assert.equal(correction.body.correction.amountCents, 1000);
    const correctionReplay = await client.call('POST', `/api/payments/${paymentId}/corrections`, { cookie: T, body: correctionBody, key: correctionKey, expect: 200 });
    assert.deepEqual(correctionReplay.body, correction.body);

    // Zwrot i ponowne przypisanie (każde z ponowieniem).
    const refundBody = { amountCents: 500, refundedOn: '2026-09-25', method: 'cash', reason: 'Zwrot syntetyczny' };
    const refundKey = key('ref');
    const refund = await client.call('POST', `/api/payments/${paymentId}/refunds`, { cookie: T, body: refundBody, key: refundKey, expect: 201 });
    assert.deepEqual([refund.body.refund.refundedOn, refund.body.refund.method], ['2026-09-25', 'cash']);
    await client.call('POST', `/api/payments/${paymentId}/refunds`, { cookie: T, body: refundBody, key: refundKey, expect: 200 });
    const reassignBody = { householdId: 'h2', reason: 'Wpłata od innej rodziny (syntetyczna)' };
    const reassignKey = key('rea');
    const reassigned = await client.call('POST', `/api/payments/${paymentId}/reassignment`, { cookie: T, body: reassignBody, key: reassignKey, expect: 201 });
    assert.deepEqual([reassigned.body.reassignment.oldHouseholdId, reassigned.body.reassignment.newHouseholdId], ['h1', 'h2']);
    await client.call('POST', `/api/payments/${paymentId}/reassignment`, { cookie: T, body: reassignBody, key: reassignKey, expect: 200 });

    // Przypisanie wpłaty nieprzypisanej (z ponowieniem).
    const assignKey = key('asg');
    const assigned = await client.call('POST', `/api/payments/${toAssign.id}/assignment`, { cookie: T, body: { householdId: 'h3' }, key: assignKey, expect: 201 });
    assert.equal(assigned.body.assignment.householdId, 'h3');
    await client.call('POST', `/api/payments/${toAssign.id}/assignment`, { cookie: T, body: { householdId: 'h3' }, key: assignKey, expect: 200 });

    // Podział wpłaty nieprzypisanej: dwie części, cofnięcie jednej.
    const partKey = key('alo');
    const part = await client.call('POST', `/api/payments/${unmatched.id}/allocations`, { cookie: T, body: { householdId: 'h1', amountCents: 2000 }, key: partKey, expect: 201 });
    await client.call('POST', `/api/payments/${unmatched.id}/allocations`, { cookie: T, body: { householdId: 'h1', amountCents: 2000 }, key: partKey, expect: 200 });
    await client.call('POST', `/api/payments/${unmatched.id}/allocations`, { cookie: T, body: { householdId: 'h2', amountCents: 1000 }, key: key('alo'), expect: 201 });
    const before = await client.call('GET', `/api/payments/${unmatched.id}/allocations`, { cookie: T, expect: 200 });
    assert.deepEqual(
      [before.body.status, before.body.netAmountCents, before.body.allocatedCents, before.body.unallocatedCents, before.body.allocations.length],
      ['unmatched', 6000, 3000, 3000, 2],
    );
    assert.deepEqual(before.body.allocations.map((item) => item.reversal), [null, null]);
    const reversalBody = { reason: 'Cofnięcie podziału (syntetyczne)' };
    const reversalKey = key('rev');
    const reversal = await client.call('POST', `/api/payments/${unmatched.id}/allocations/${part.body.allocation.id}/reversal`, { cookie: T, body: reversalBody, key: reversalKey, expect: 201 });
    assert.equal(reversal.body.reversal.allocationId, part.body.allocation.id);
    await client.call('POST', `/api/payments/${unmatched.id}/allocations/${part.body.allocation.id}/reversal`, { cookie: T, body: reversalBody, key: reversalKey, expect: 200 });
    const after = await client.call('GET', `/api/payments/${unmatched.id}/allocations`, { cookie: T, expect: 200 });
    const reversedItem = after.body.allocations.find((item) => item.id === part.body.allocation.id);
    assert.deepEqual([after.body.allocatedCents, after.body.unallocatedCents, reversedItem.reversal.reason], [1000, 5000, reversalBody.reason]);

    // Lista: filtry, netto po korekcie i zwrocie, kursor.
    const filtered = await client.call('GET', '/api/payments?schoolYearId=y2026&status=recorded&method=bank&householdId=h2&dateFrom=2026-09-01&dateTo=2026-09-30&q=syntetyczna&limit=50', { cookie: T, expect: 200 });
    const listed = filtered.body.payments.find((item) => item.id === paymentId);
    assert.deepEqual([listed.correctedCents, listed.netAmountCents, filtered.body.nextCursor], [1000, 3500, null]);
    const firstPage = await client.call('GET', '/api/payments?schoolYearId=y2026&limit=2', { cookie: T, expect: 200 });
    assert.equal(firstPage.body.payments.length, 2);
    assert.equal(typeof firstPage.body.nextCursor, 'string');
    const secondPage = await client.call('GET', `/api/payments?schoolYearId=y2026&limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`, { cookie: T, expect: 200 });
    assert.equal(secondPage.body.payments.length, 1);
    assert.equal(secondPage.body.nextCursor, null);

    // Eksporty: pliki z zadeklarowanym typem.
    const csv = await client.call('GET', '/api/payments/export.csv?schoolYearId=y2026&from=2026-09-01&to=2026-09-30&method=bank', { cookie: T, expect: 200 });
    assert.match(new TextDecoder().decode(csv.bytes), /Składki są dobrowolne/);
    await client.call('GET', '/api/payments/export.xlsx?schoolYearId=y2026', { cookie: T, expect: 200 });

    // Błędy z katalogu: kod należy do x-rd-error-codes danego statusu.
    await client.call('POST', '/api/payments', { cookie: T, body: bankBody, expect: 400 });
    await client.call('POST', '/api/payments', { cookie: T, body: { ...bankBody, amountCents: 0 }, key: key('pay'), expect: 400, invalidRequest: true });
    await client.call('POST', '/api/payments', { cookie: T, body: { ...bankBody, amountCents: 5001 }, key: bankKey, expect: 409 });
    await client.call('POST', '/api/payments', { cookie: T, body: { ...bankBody, householdId: 'h-nieznane' }, key: key('pay'), expect: 400 });
    await client.call('POST', '/api/payments', { cookie: T, body: { ...bankBody, reference: 'Kontakt: jan@example.invalid' }, key: key('pay'), expect: 422 });
    await client.call('POST', '/api/payments', { cookie: T, body: bankBody, key: key('pay'), expect: 403, origin: 'https://obcy.example' });
    await client.call('POST', `/api/payments/${paymentId}/corrections`, { cookie: T, body: { amountCents: 9000, reason: 'Za duża korekta' }, key: key('cor'), expect: 409 });
    await client.call('POST', '/api/payments/nie-ma-takiej/corrections', { cookie: T, body: correctionBody, key: key('cor'), expect: 404 });
    await client.call('POST', `/api/payments/${toAssign.id}/assignment`, { cookie: T, body: { householdId: 'h1' }, key: key('asg'), expect: 409 });
    await client.call('POST', `/api/payments/${unmatched.id}/allocations/${part.body.allocation.id}/reversal`, { cookie: T, body: reversalBody, key: key('rev'), expect: 409 });
    await client.call('GET', '/api/payments?schoolYearId=y2026&limit=0', { cookie: T, expect: 400 });
    await client.call('GET', '/api/payments?schoolYearId=y2026&cursor=nie-kursor', { cookie: T, expect: 400 });
    await client.call('GET', '/api/payments?schoolYearId=y2026', { cookie: cookies.rep, expect: 403 });
    await client.call('GET', '/api/payments?schoolYearId=y2026', { expect: 401 });
    await assertRequiredFieldsEnforced(client, T, 'POST', '/api/payments', bankBody, components.PaymentCreateRequest.required);
    await assertRequiredFieldsEnforced(client, T, 'POST', `/api/payments/${paymentId}/corrections`, correctionBody, components.PaymentCorrectionRequest.required);
    await assertRequiredFieldsEnforced(client, T, 'POST', `/api/payments/${paymentId}/refunds`, refundBody, components.PaymentRefundRequest.required);

    // Komunikat strukturalny: utworzenie, ponowienie, konflikt, unieważnienie.
    const referenceBody = { schoolYearId: 'y2026', householdId: 'h1' };
    const referenceKey = key('ogm');
    const generated = await client.call('POST', '/api/payment-references', { cookie: T, body: referenceBody, key: referenceKey, expect: 201 });
    assert.equal(generated.body.paymentReference.active, true);
    await client.call('POST', '/api/payment-references', { cookie: T, body: referenceBody, key: referenceKey, expect: 200 });
    await client.call('POST', '/api/payment-references', { cookie: T, body: referenceBody, key: key('ogm'), expect: 409 });
    const referenceId = generated.body.paymentReference.id;
    const revokeBody = { reason: 'Unieważnienie syntetyczne' };
    const revokeKey = key('rvk');
    const revoked = await client.call('POST', `/api/payment-references/${referenceId}/revoke`, { cookie: T, body: revokeBody, key: revokeKey, expect: 201 });
    assert.deepEqual([revoked.body.paymentReference.active, revoked.body.paymentReference.revokeReason], [false, revokeBody.reason]);
    await client.call('POST', `/api/payment-references/${referenceId}/revoke`, { cookie: T, body: revokeBody, key: revokeKey, expect: 200 });
    await client.call('POST', `/api/payment-references/${referenceId}/revoke`, { cookie: T, body: revokeBody, key: key('rvk'), expect: 409 });
    await client.call('POST', '/api/payment-references/nie-ma-takiej/revoke', { cookie: T, body: revokeBody, key: key('rvk'), expect: 404 });
    const references = await client.call('GET', '/api/payment-references?schoolYearId=y2026&householdId=h1', { cookie: T, expect: 200 });
    assert.deepEqual(references.body.paymentReferences.map((item) => item.active), [false]);
    await client.call('GET', '/api/payment-references?schoolYearId=y2026&householdId=h1', { cookie: cookies.rep, expect: 403 });

    // Dane do wpłaty: brak, zatwierdzenie (zarząd), ponowienie, błędy.
    const none = await client.call('GET', '/api/payment-instructions?schoolYearId=y2026', { cookie: T, expect: 200 });
    assert.equal(none.body.paymentInstructions, null);
    const instructionsBody = { schoolYearId: 'y2026', iban: 'BE68 5390 0754 7034', bic: 'GEBABEBB', payeeName: 'Rada Rodziców (dane testowe)' };
    const instructionsKey = key('ins');
    const approved = await client.call('POST', '/api/payment-instructions', { cookie: cookies.board, body: instructionsBody, key: instructionsKey, expect: 201 });
    assert.deepEqual([approved.body.paymentInstructions.iban, approved.body.paymentInstructions.bic], ['BE68539007547034', 'GEBABEBB']);
    await client.call('POST', '/api/payment-instructions', { cookie: cookies.board, body: instructionsBody, key: instructionsKey, expect: 200 });
    const current = await client.call('GET', '/api/payment-instructions?schoolYearId=y2026', { cookie: T, expect: 200 });
    assert.equal(current.body.paymentInstructions.id, approved.body.paymentInstructions.id);
    await client.call('POST', '/api/payment-instructions', { cookie: T, body: instructionsBody, key: key('ins'), expect: 403 });
    await client.call('POST', '/api/payment-instructions', { cookie: cookies.board, body: { ...instructionsBody, iban: 'BE00000000000000' }, key: key('ins'), expect: 400 });
    await client.call('POST', '/api/payment-instructions', { cookie: cookies.board, body: { ...instructionsBody, bic: null }, key: instructionsKey, expect: 409 });

    assertSuccessCoverage(client, ['payments', 'payment-references', 'payment-instructions']);
  } finally {
    await db.close();
  }
});

// --- Księga -------------------------------------------------------------------------------

const PREV = 'y-2025';
const YEAR = 'y-2026';
const NEXT = 'y-2027';
const meetingAdmin = { userId: 'u-meet-admin', grants: [{ role: 'admin', classId: null, schoolYearId: null }], mfaVerified: true };

// Przyjęta uchwała zebrania ogólnego (przez moduł zebrań), jak w tests/pg-ledger-review-resolution.test.js.
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
    idempotencyKey: key('res'), meetingId: meeting.id, title: 'Uchwała syntetyczna', body: 'Treść syntetyczna uchwały',
    status: 'adopted', number: 'U-1/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
  });
  return resolution;
}

async function ledgerWorld() {
  const db = await createTestDb();
  await seedSchoolYear(db, PREV, { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR });
  await seedUser(db, { userId: meetingAdmin.userId });
  const years = (role) => [PREV, YEAR, NEXT].map((schoolYearId) => ({ role, schoolYearId }));
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: years('treasurer') }),
    board: await seedUserSession(db, { userId: 'u-board', mfa: true, roles: years('board') }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] }),
    rep: await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] }),
  };
  await seedEnrolledHousehold(db, 'h1', [YEAR]);
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-exp', $1, 'expense', 'Wydarzenia', 'u-treasurer'),
    ('cat-trip', $1, 'expense', 'Wycieczki', 'u-treasurer'),
    ('cat-inc', $1, 'income', 'Składki dobrowolne', 'u-treasurer')`, [YEAR]);
  await db.query(`INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
    VALUES ('d1', 'docs/00000000-0000-4000-8000-00000000d001', 'application/pdf', 1200, 'financial', 'u-treasurer', $1, $2, 'seed-document-0001')`,
  [YEAR, 'a'.repeat(64)]);
  await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
    VALUES ('p1', 'h1', $1, 5000, '2026-09-20', 'bank', 'recorded', 'u-treasurer', 'seed-payment-0001')`, [YEAR]);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, note, created_by, idempotency_key)
    VALUES ('ob1', $1, 100000, 'Bilans syntetyczny', 'u-treasurer', 'seed-opening-0001')`, [YEAR]);
  await db.query(`INSERT INTO ledger_budget_lines (id, school_year_id, category_id, planned_cents, note, created_by, idempotency_key) VALUES
    ('bl1', $1, 'cat-exp', 20000, 'Plan początkowy', 'u-treasurer', 'seed-budget-0001')`, [YEAR]);
  await db.query(`INSERT INTO ledger_budget_lines (id, school_year_id, category_id, planned_cents, note, supersedes_id, created_by, idempotency_key)
    VALUES ('bl2', $1, 'cat-exp', 18000, NULL, 'bl1', 'u-treasurer', 'seed-budget-0002')`, [YEAR]);
  const env = { db };
  return { db, env, cookies, client: newClient(env) };
}

test('kontrakt księgi: prawdziwe odpowiedzi ledger zgodne ze schematami', async () => {
  const { db, env, cookies, client } = await ledgerWorld();
  const T = cookies.treasurer;
  const B = cookies.board;
  const expenseBody = (patch = {}) => ({
    schoolYearId: YEAR, direction: 'expense', amountCents: 25000, categoryId: 'cat-exp',
    description: 'Wydatek syntetyczny', occurredOn: '2026-10-05', method: 'bank', ...patch,
  });
  try {
    // Odczyty roku: kategorie, podsumowanie, preliminarz.
    const categories = await client.call('GET', `/api/ledger/categories?schoolYearId=${YEAR}&direction=expense`, { cookie: T, expect: 200 });
    assert.deepEqual(categories.body.categories.map((item) => item.id).sort(), ['cat-exp', 'cat-trip']);
    await client.call('GET', `/api/ledger/categories?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    const summary = await client.call('GET', `/api/ledger/summary?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.equal(summary.body.summary.openingBalanceCents, 100000);
    const budget = await client.call('GET', `/api/ledger/budget?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual(budget.body.budget.map((line) => [line.id, line.plannedCents, line.supersedesId]), [['bl2', 18000, 'bl1']]);

    // Wpis z dowodem: utworzenie i ponowienie z tym samym kluczem.
    const entryBody = expenseBody({ sourceDocumentId: 'd1', source: 'Faktura syntetyczna' });
    const entryKey = key('led');
    const created = await client.call('POST', '/api/ledger', { cookie: T, body: entryBody, key: entryKey, expect: 201 });
    assert.equal(created.headers.get('Idempotency-Replayed'), 'false');
    const replay = await client.call('POST', '/api/ledger', { cookie: T, body: entryBody, key: entryKey, expect: 200 });
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.equal(replay.body.entry.id, created.body.entry.id);
    const entryId = created.body.entry.id;
    // Przychód powiązany z wpłatą i dwa wydatki do przeksięgowania.
    const income = await client.call('POST', '/api/ledger', {
      cookie: T, key: key('led'), expect: 201,
      body: { schoolYearId: YEAR, direction: 'income', amountCents: 5000, categoryId: 'cat-inc', description: 'Składki syntetyczne', occurredOn: '2026-09-20', method: 'bank', paymentEntryId: 'p1' },
    });
    assert.equal(income.body.entry.paymentEntryId, 'p1');
    const toReplace = (await client.call('POST', '/api/ledger', { cookie: T, body: expenseBody({ amountCents: 30000, description: 'Wydatek do przeksięgowania' }), key: key('led'), expect: 201 })).body.entry;

    // Korekta częściowa i ponowienie.
    const correctionBody = { amountCents: 1000, reason: 'Korekta częściowa (syntetyczna)' };
    const correctionKey = key('cor');
    const correction = await client.call('POST', `/api/ledger/${entryId}/corrections`, { cookie: T, body: correctionBody, key: correctionKey, expect: 201 });
    assert.equal(correction.body.correction.ledgerEntryId, entryId);
    await client.call('POST', `/api/ledger/${entryId}/corrections`, { cookie: T, body: correctionBody, key: correctionKey, expect: 200 });

    // Przeksięgowanie wydatku (storno + wpis zastępczy) i ponowienie.
    const replacementBody = expenseBody({ amountCents: 28000, categoryId: 'cat-trip', description: 'Wpis zastępczy (syntetyczny)', occurredOn: '2026-10-06', method: 'cash', reason: 'Błędna kategoria' });
    const replacementKey = key('rpl');
    const replaced = await client.call('POST', `/api/ledger/${toReplace.id}/replacement`, { cookie: T, body: replacementBody, key: replacementKey, expect: 201 });
    assert.equal(replaced.body.entry.replacesEntryId, toReplace.id);
    const replacedAgain = await client.call('POST', `/api/ledger/${toReplace.id}/replacement`, { cookie: T, body: replacementBody, key: replacementKey, expect: 200 });
    assert.equal(replacedAgain.body.entry.id, replaced.body.entry.id);

    // Uchwała z upoważnieniem do wydatku (zarząd) i wydatek ponad próg z jawnym resolutionId.
    const resolution = await adoptedResolution(db);
    const resolutions = await client.call('GET', `/api/ledger/resolutions?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual(resolutions.body.resolutions.map((item) => [item.id, item.authorizationId, item.entryCount]), [[resolution.id, null, 0]]);
    const authorizationBody = { authorizedAmountCents: 400000, validUntil: '2027-06-30', note: 'Upoważnienie syntetyczne', supersedesId: null };
    const authorizationKey = key('aut');
    const authorization = await client.call('POST', `/api/ledger/resolutions/${resolution.id}/authorizations`, { cookie: B, body: authorizationBody, key: authorizationKey, expect: 201 });
    assert.deepEqual([authorization.body.authorization.authorizedAmountCents, authorization.body.authorization.supersedesId], [400000, null]);
    await client.call('POST', `/api/ledger/resolutions/${resolution.id}/authorizations`, { cookie: B, body: authorizationBody, key: authorizationKey, expect: 200 });
    const large = await client.call('POST', '/api/ledger', {
      cookie: T, key: key('led'), expect: 201, body: expenseBody({ amountCents: 350000, description: 'Duży wydatek syntetyczny', resolutionId: resolution.id }),
    });
    assert.deepEqual([large.body.entry.resolutionId, large.body.entry.resolutionReference], [resolution.id, 'U-1/2026']);
    const spending = await client.call('GET', `/api/ledger/resolutions?schoolYearId=${YEAR}`, { cookie: B, expect: 200 });
    assert.deepEqual(
      spending.body.resolutions.map((item) => [item.authorizedAmountCents, item.spentNetCents, item.remainingCents, item.entryCount]),
      [[400000, 350000, 50000, 1]],
    );

    // Weryfikacja wydatku przez drugą osobę i lista weryfikacji z kursorem.
    const reviewBody = { decision: 'verified' };
    const reviewKey = key('rvw');
    const review = await client.call('POST', `/api/ledger/${entryId}/reviews`, { cookie: B, body: reviewBody, key: reviewKey, expect: 201 });
    assert.deepEqual([review.body.review.decision, review.body.review.note], ['verified', null]);
    await client.call('POST', `/api/ledger/${entryId}/reviews`, { cookie: B, body: reviewBody, key: reviewKey, expect: 200 });
    await client.call('POST', `/api/ledger/${large.body.entry.id}/reviews`, { cookie: B, body: { decision: 'questioned', note: 'Do wyjaśnienia (syntetyczna uwaga)' }, key: key('rvw'), expect: 201 });
    const allReviews = await client.call('GET', `/api/ledger/reviews?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.deepEqual(allReviews.body.reviews.map((item) => item.reviewStatus).sort(), ['questioned', 'unverified', 'unverified', 'verified']);
    assert.deepEqual([allReviews.body.nextCursor, allReviews.body.truncated, allReviews.body.limit], [null, false, 500]);
    const reviewsPage = await client.call('GET', `/api/ledger/reviews?schoolYearId=${YEAR}&limit=1`, { cookie: T, expect: 200 });
    assert.deepEqual([reviewsPage.body.reviews.length, reviewsPage.body.truncated, typeof reviewsPage.body.nextCursor], [1, true, 'string']);
    const reviewsNext = await client.call('GET', `/api/ledger/reviews?schoolYearId=${YEAR}&limit=1&cursor=${encodeURIComponent(reviewsPage.body.nextCursor)}`, { cookie: T, expect: 200 });
    assert.equal(reviewsNext.body.reviews.length, 1);
    const verifiedOnly = await client.call('GET', `/api/ledger/reviews?schoolYearId=${YEAR}&reviewStatus=verified`, { cookie: T, expect: 200 });
    assert.deepEqual(verifiedOnly.body.reviews.map((item) => item.ledgerEntryId), [entryId]);

    // Lista wpisów: kształt wpisu z dowodem i korektą, wpis przeksięgowany, filtry, kursor.
    const list = await client.call('GET', `/api/ledger?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    const listed = list.body.entries.find((item) => item.id === entryId);
    assert.deepEqual(
      [listed.categoryName, listed.correctedCents, listed.netAmountCents, listed.attachmentIds, listed.attachments],
      ['Wydarzenia', 1000, 24000, ['d1'], [{ documentId: 'd1', status: 'active', currentDocumentId: 'd1' }]],
    );
    assert.equal(list.body.entries.find((item) => item.id === toReplace.id).replacedByEntryId, replaced.body.entry.id);
    assert.equal(list.body.entries.find((item) => item.id === replaced.body.entry.id).replacesEntryId, toReplace.id);
    assert.equal(list.body.entries.length, 5);
    await client.call('GET', `/api/ledger?schoolYearId=${YEAR}&direction=expense&category=cat-exp&dateFrom=2026-10-01&dateTo=2026-10-31&limit=100`, { cookie: T, expect: 200 });
    const firstPage = await client.call('GET', `/api/ledger?schoolYearId=${YEAR}&limit=2`, { cookie: T, expect: 200 });
    assert.deepEqual([firstPage.body.entries.length, typeof firstPage.body.nextCursor], [2, 'string']);
    const wrongFilter = await client.call('GET', `/api/ledger?schoolYearId=${YEAR}&direction=expense&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`, { cookie: T, expect: 400 });
    assert.equal(wrongFilter.body.error, 'invalid_cursor');
    const nextPage = await client.call('GET', `/api/ledger?schoolYearId=${YEAR}&limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`, { cookie: T, expect: 200 });
    assert.equal(nextPage.body.entries.length, 2);

    // Widok Komisji Rewizyjnej (D-09, za flagą): wpis powiązany z wpłatą bez opisu i identyfikatora wpłaty.
    env.AUDIT_LEDGER_READ = 'true';
    try {
      const auditList = await client.call('GET', `/api/ledger?schoolYearId=${YEAR}`, { cookie: cookies.audit, expect: 200 });
      const linked = auditList.body.entries.find((item) => item.id === income.body.entry.id);
      assert.deepEqual([linked.paymentLinked, linked.paymentEntryId, linked.source], [true, null, null]);
      await client.call('GET', `/api/ledger/categories?schoolYearId=${YEAR}`, { cookie: cookies.audit, expect: 200 });
      await client.call('GET', `/api/ledger/summary?schoolYearId=${YEAR}`, { cookie: cookies.audit, expect: 200 });
      await client.call('POST', '/api/ledger', { cookie: cookies.audit, body: expenseBody(), key: key('led'), expect: 403 });
    } finally {
      delete env.AUDIT_LEDGER_READ;
    }

    // Kategorie: utworzenie (opcjonalny klucz), odtworzenie, konflikt, dezaktywacja, kopiowanie.
    const categoryBody = { schoolYearId: YEAR, direction: 'expense', name: 'Dary rzeczowe' };
    const categoryKey = key('cat');
    const category = await client.call('POST', '/api/ledger/categories', { cookie: T, body: categoryBody, key: categoryKey, expect: 201 });
    assert.deepEqual([category.body.category.name, category.body.category.active], ['Dary rzeczowe', true]);
    await client.call('POST', '/api/ledger/categories', { cookie: T, body: categoryBody, key: categoryKey, expect: 200 });
    await client.call('POST', '/api/ledger/categories', { cookie: T, body: categoryBody, expect: 200 });
    await client.call('POST', '/api/ledger/categories', { cookie: T, body: categoryBody, key: key('cat'), expect: 409 });
    const deactivated = await client.call('POST', `/api/ledger/categories/${category.body.category.id}/deactivate`, { cookie: T, expect: 200 });
    assert.equal(deactivated.body.category.active, false);
    await client.call('POST', `/api/ledger/categories/${category.body.category.id}/deactivate`, { cookie: T, expect: 200 });
    await client.call('POST', '/api/ledger/categories/nie-ma-takiej/deactivate', { cookie: T, expect: 404 });
    const preview = await client.call('POST', '/api/ledger/categories/copy', { cookie: T, body: { fromSchoolYearId: YEAR, toSchoolYearId: NEXT, dryRun: true }, expect: 200 });
    assert.deepEqual([preview.body.dryRun, preview.body.copied.length, preview.body.skipped.length], [true, 3, 0]);
    const copied = await client.call('POST', '/api/ledger/categories/copy', { cookie: T, body: { fromSchoolYearId: YEAR, toSchoolYearId: NEXT }, expect: 200 });
    assert.deepEqual([copied.body.dryRun, copied.body.copied.length, copied.body.skippedCount], [false, 3, 0]);
    const copiedAgain = await client.call('POST', '/api/ledger/categories/copy', { cookie: T, body: { fromSchoolYearId: YEAR, toSchoolYearId: NEXT }, expect: 200 });
    assert.deepEqual([copiedAgain.body.copied.length, copiedAgain.body.skippedCount], [0, 3]);
    const emptySource = await client.call('POST', '/api/ledger/categories/copy', { cookie: T, body: { fromSchoolYearId: PREV, toSchoolYearId: YEAR }, expect: 200 });
    assert.deepEqual(emptySource.body, { dryRun: false, copied: [], skipped: [] });

    // Eksporty księgi.
    const csv = await client.call('GET', `/api/ledger/export.csv?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });
    assert.match(new TextDecoder().decode(csv.bytes), /id_wpisu/);
    await client.call('GET', `/api/ledger/export.xlsx?schoolYearId=${YEAR}`, { cookie: T, expect: 200 });

    // Błędy z katalogu: kod należy do x-rd-error-codes danego statusu.
    await client.call('POST', '/api/ledger', { cookie: T, body: entryBody, expect: 400 });
    await client.call('POST', '/api/ledger', { cookie: T, body: expenseBody({ amountCents: 350000, description: 'Bez uchwały' }), key: key('led'), expect: 400 });
    await client.call('POST', '/api/ledger', { cookie: T, body: expenseBody({ categoryId: 'cat-inc' }), key: key('led'), expect: 400 });
    await client.call('POST', '/api/ledger', { cookie: T, body: { ...entryBody, amountCents: 26000 }, key: entryKey, expect: 409 });
    await client.call('POST', '/api/ledger', { cookie: T, body: { schoolYearId: YEAR, direction: 'income', amountCents: 4000, categoryId: 'cat-inc', description: 'Zła kwota', occurredOn: '2026-09-20', method: 'bank', paymentEntryId: 'p1' }, key: key('led'), expect: 422 });
    await client.call('POST', '/api/ledger', { cookie: T, body: expenseBody({ description: 'Poza rokiem', occurredOn: '2027-12-01' }), key: key('led'), expect: 422 });
    await client.call('POST', '/api/ledger', { cookie: T, body: expenseBody({ description: 'Kontakt: jan@example.invalid' }), key: key('led'), expect: 422 });
    await client.call('POST', `/api/ledger/${entryId}/corrections`, { cookie: T, body: { amountCents: 90000, reason: 'Za duża korekta' }, key: key('cor'), expect: 409 });
    await client.call('POST', '/api/ledger/nie-ma-takiego/corrections', { cookie: T, body: correctionBody, key: key('cor'), expect: 404 });
    await client.call('POST', `/api/ledger/${toReplace.id}/replacement`, { cookie: T, body: { ...replacementBody, amountCents: 27000 }, key: key('rpl'), expect: 409 });
    await client.call('POST', `/api/ledger/${entryId}/reviews`, { cookie: T, body: reviewBody, key: key('rvw'), expect: 403 });
    await client.call('POST', `/api/ledger/${income.body.entry.id}/reviews`, { cookie: B, body: reviewBody, key: key('rvw'), expect: 409 });
    await client.call('POST', `/api/ledger/${entryId}/reviews`, { cookie: B, body: { decision: 'questioned' }, key: key('rvw'), expect: 400 });
    await client.call('POST', `/api/ledger/resolutions/${resolution.id}/authorizations`, { cookie: B, body: { ...authorizationBody, authorizedAmountCents: 500000 }, key: key('aut'), expect: 409 });
    await client.call('POST', `/api/ledger/resolutions/${resolution.id}/authorizations`, { cookie: T, body: authorizationBody, key: key('aut'), expect: 403 });
    await client.call('POST', '/api/ledger/resolutions/nie-ma-takiej/authorizations', { cookie: B, body: authorizationBody, key: key('aut'), expect: 404 });
    await client.call('GET', `/api/ledger?schoolYearId=${YEAR}&dateFrom=2026-12-01&dateTo=2026-10-01`, { cookie: T, expect: 400 });
    await client.call('GET', `/api/ledger/reviews?schoolYearId=${YEAR}&limit=0`, { cookie: T, expect: 400 });
    await client.call('GET', `/api/ledger?schoolYearId=${YEAR}`, { cookie: cookies.rep, expect: 403 });
    await client.call('GET', `/api/ledger/summary?schoolYearId=${YEAR}`, { cookie: cookies.audit, expect: 403 });
    await client.call('GET', `/api/ledger?schoolYearId=${YEAR}`, { expect: 401 });
    await assertRequiredFieldsEnforced(client, T, 'POST', '/api/ledger', entryBody, components.LedgerEntryCreateRequest.required);
    await assertRequiredFieldsEnforced(client, T, 'POST', `/api/ledger/${entryId}/corrections`, correctionBody, components.LedgerCorrectionRequest.required);

    assertSuccessCoverage(client, ['ledger']);
  } finally {
    await db.close();
  }
});
