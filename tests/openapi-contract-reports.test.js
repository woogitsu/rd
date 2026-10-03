// Kontrakt API (#160, etap 13): prawdziwe odpowiedzi modułów `audit-history`, `audit-reviews`, `financial-reports`,
// `exports`, `print`, `board` i `representative` (PGlite, dane syntetyczne `@example.invalid`, imiona syntetyczne)
// walidowane schematami z docs/openapi.json (src/pg/schemas/*.js) przez tests/helpers/contract-client.js. Rejestr pokrycia
// i katalog kodów sprawdza tests/openapi-contract.test.js (wspólnie dla wszystkich pokrytych modułów).
//
// ŻADNEJ SIECI I ŻADNEJ WYSYŁKI: kampania e-mail powstaje wyłącznie jako szkic (obiekt historii), nic nie trafia do kolejki;
// globalna pułapka sieci (tests/helpers/network-guard.js) liczy próby połączeń — licznik musi być 0.
//
// Przebieg: granice ról na każdej z 22 operacji (401; 403 dla ról bez dostępu — przedstawiciel tylko własna klasa,
// Komisja Rewizyjna i dyrekcja wyłącznie w swoich zakresach odczytu; bramka MFA routera; obcy Origin), historia obiektu
// (cztery rodzaje, rok spoza przydziału = 404), ścieżka kontroli KR (pytanie → odpowiedź → zamknięcie, cztery oczy,
// ponowienie kluczem), sprawozdanie i przepływy (JSON, HTML), migawki (łańcuch korekt, zatwierdzenie drugą osobą, krok
// w górę MFA), eksport roczny i lista klasy (JSON, CSV, XLSX, e-mail tylko przy zgodzie), kartki (kwoty tylko rola
// finansowa z MFA, rodzeństwo, ograniczenie przetwarzania), pulpity zarządu i przedstawiciela; błędy
// 400/404/409/413/415/422; osobny świat — zamknięty rok (409 zapisów, eksport archiwum przez zarząd roku następnego).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import {
  createTestDb, networkGuardCalls, request, seedClass, seedPublishedPrivacyNotice, seedSchoolYear, seedUserSession,
} from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;

const MODULES = ['audit-history', 'audit-reviews', 'financial-reports', 'exports', 'print', 'board', 'representative'];
const YEAR = 'y-2026';
const NEXT = 'y-2027';
const MISSING = 'y-brak';
const FOREIGN = 'https://obcy.example.invalid';
const CAMPAIGN_BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. '
  + 'Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

// Każda odpowiedź sukcesu opisana w schematach modułów etapu została zwalidowana na prawdziwej odpowiedzi.
function assertSuccessCoverage(validated) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (!MODULES.includes(entry.module)) continue;
    for (const [status, response] of Object.entries(entry.responses)) {
      expected.push(`${routeId} ${status}`);
      for (const type of Object.keys(response.content ?? {})) expected.push(`${routeId} ${status} ${type}`);
    }
  }
  assert.ok(expected.length >= 30, `oczekiwane odpowiedzi: ${expected.length}`);
  assert.deepEqual(expected.filter((item) => !validated.has(item)), [], 'odpowiedzi sukcesu opisane w schemacie bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje błąd i w schemacie, i na serwerze.
async function assertRequiredFieldsEnforced(client, cookie, path, validBody, componentName, { withKey = false, statuses = {} } = {}) {
  const requiredFields = components[componentName].required;
  assert.ok(requiredFields.length > 0, `${componentName}: schemat ma wymagane pola`);
  for (const field of requiredFields) {
    const { [field]: omitted, ...body } = validBody;
    assert.notEqual(omitted, undefined, `${field}: ciało testowe ma to pole`);
    const response = await client.call('POST', path, {
      cookie, body, key: withKey ? key('req') : undefined, expect: statuses[field] ?? 400, invalidRequest: true,
    });
    assert.equal(typeof response.body.error, 'string', `${componentName}.${field}: kod błędu`);
  }
}

async function addFactor(db, userId) {
  await db.query(
    `INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, confirmed_at)
     VALUES ($1, $2, 'totp', 'AAAAAAAAAA', 'BBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCCCC', now())`,
    [`f-${userId}`, userId],
  );
}

// Rodzina: dzieci zapisane do wskazanych klas roku i opiekunowie [imię, nazwisko, zgoda na kontakt].
async function family(db, householdId, { classes, guardians = [], schoolYearId = YEAR }) {
  await db.query('INSERT INTO households (id) VALUES ($1)', [householdId]);
  const studentIds = [];
  for (const [index, classId] of classes.entries()) {
    const id = `${householdId}-s${index + 1}`;
    studentIds.push(id);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', $3)", [id, householdId, `Syntetyczny${householdId}`]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, id, classId, schoolYearId]);
  }
  for (const [index, [firstName, lastName, consent]] of guardians.entries()) {
    const id = `${householdId}-g${index + 1}`;
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, householdId, firstName, lastName, `${id}@example.invalid`, consent],
    );
    for (const studentId of studentIds) {
      await db.query(
        'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, $3, $4)',
        [studentId, id, consent, index === 0],
      );
    }
  }
}

// Żądanie spoza kontraktu tych modułów (przygotowanie danych innymi trasami) — bez walidacji schematem.
async function raw(env, method, path, { cookie, body, idempotencyKey } = {}) {
  const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
  const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function world() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  await seedClass(db, { id: 'c-2a', schoolYearId: NEXT, name: '2A' });
  const year = (role, extra = {}) => [{ role, schoolYearId: YEAR, ...extra }];
  const session = (userId, roles, mfa = true) => seedUserSession(db, { userId, roles, mfa });
  const cookies = {
    admin: await session('u-admin', [{ role: 'admin' }]),
    board: await session('u-board', year('board')),
    board2: await session('u-board2', year('board')),
    boardAll: await session('u-board-all', [{ role: 'board' }]),
    boardStale: await seedUserSession(db, { userId: 'u-board-stale', mfa: true, roles: year('board'), createdAt: new Date(Date.now() - 20 * 60 * 1000) }),
    boardNoMfa: await session('u-board-nomfa', year('board'), false),
    boardClass: await session('u-board-class', year('board', { classId: 'c-1a' })),
    boardNext: await session('u-board-next', [{ role: 'board', schoolYearId: NEXT }]),
    treasurer: await session('u-treasurer', year('treasurer')),
    audit: await session('u-audit', year('audit')),
    auditAll: await session('u-audit-all', [{ role: 'audit' }]),
    auditNoMfa: await session('u-audit-nomfa', year('audit'), false),
    auditFactor: await session('u-audit-factor', year('audit'), false),
    // Konflikt ról (D-09): ta sama osoba w KR i jako skarbnik — nie odpowiada na własne pytanie.
    both: await session('u-both', [...year('audit'), ...year('treasurer')]),
    principal: await session('u-principal', year('principal')),
    principalNoMfa: await session('u-principal-nomfa', year('principal'), false),
    repA: await session('u-rep-a', year('representative', { classId: 'c-1a' }), false),
    repAMfa: await session('u-rep-a-mfa', year('representative', { classId: 'c-1a' })),
    repAFactor: await session('u-rep-a-factor', year('representative', { classId: 'c-1a' }), false),
    repB: await session('u-rep-b', year('representative', { classId: 'c-1b' }), false),
    repNext: await session('u-rep-next', [{ role: 'representative', classId: 'c-2a', schoolYearId: NEXT }], false),
    noGrant: await session('u-nogrant', [], false),
  };
  await addFactor(db, 'u-audit-factor');
  await addFactor(db, 'u-rep-a-factor');
  // h1: rodzeństwo w 1A i 1B, opiekun ze zgodą i opiekun bez zgody; h2, h4-h6: 1B (5 gospodarstw — odsetek liczbowy);
  // h3: 1A (ograniczenie przetwarzania niżej); h7: klasa roku następnego.
  await family(db, 'h1', { classes: ['c-1a', 'c-1b'], guardians: [['Zenobia', 'Testowa', true], ['Bonifacy', 'Testowy', false]] });
  for (const id of ['h2', 'h4', 'h5', 'h6']) await family(db, id, { classes: ['c-1b'], guardians: [['Teodora', `Przykładowa${id}`, true]] });
  await family(db, 'h3', { classes: ['c-1a'], guardians: [['Prokop', 'Ograniczony', true]] });
  await family(db, 'h7', { classes: ['c-2a'], schoolYearId: NEXT, guardians: [['Eulalia', 'Przyszła', true]] });
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-treasurer'),
    ('cat-out', $1, 'expense', 'Dofinansowanie wycieczek', 'u-treasurer')`, [YEAR]);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, cash_cents, created_by, idempotency_key)
    VALUES ('ob-1', $1, 100000, 5000, 'u-treasurer', 'ob-key-0001')`, [YEAR]);
  const env = { db, APP_ENV: 'development' };
  return { db, env, cookies, client: createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) }) };
}

// Obiekty historii i ścieżki kontroli tworzone prawdziwymi trasami (zdarzenia dziennika jak w produkcji).
async function seedFinance(env, cookies) {
  const T = cookies.treasurer;
  const payment = await raw(env, 'POST', '/api/payments', {
    cookie: T, idempotencyKey: key('pay'),
    body: { schoolYearId: YEAR, householdId: 'h2', amountCents: 5000, receivedOn: '2026-09-20', method: 'bank', reference: 'Wpłata syntetyczna' },
  });
  assert.equal(payment.status, 201, JSON.stringify(payment.body));
  const unmatched = await raw(env, 'POST', '/api/payments', {
    cookie: T, idempotencyKey: key('pay'),
    body: { schoolYearId: YEAR, householdId: null, amountCents: 700, receivedOn: '2026-09-21', method: 'cash', reference: null },
  });
  assert.equal(unmatched.status, 201, JSON.stringify(unmatched.body));
  const entry = await raw(env, 'POST', '/api/ledger', {
    cookie: T, idempotencyKey: key('led'),
    body: { schoolYearId: YEAR, direction: 'income', amountCents: 5000, categoryId: 'cat-in', description: 'Składki syntetyczne', occurredOn: '2026-09-20', method: 'bank' },
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  const reconciliation = await raw(env, 'POST', '/api/reconciliations', {
    cookie: T, idempotencyKey: key('rec'),
    body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 105000, notes: 'Wyciąg wrześniowy (syntetyczny)' },
  });
  assert.equal(reconciliation.status, 201, JSON.stringify(reconciliation.body));
  const campaign = await raw(env, 'POST', '/api/email/campaigns', {
    cookie: T, idempotencyKey: key('camp'),
    body: { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: CAMPAIGN_BODY },
  });
  assert.equal(campaign.status, 201, JSON.stringify(campaign.body));
  return {
    paymentId: payment.body.payment.id, ledgerEntryId: entry.body.entry.id,
    reconciliationId: reconciliation.body.reconciliation.id, campaignId: campaign.body.campaign.id,
  };
}

// Odmowy na każdej operacji: [metoda, ścieżka, ciało, role z 403 `forbidden`, z kluczem idempotencji].
const H = (type) => `/api/audit/entity/${type}/obiekt-1`;
const HISTORY_DENIED = ['admin', 'audit', 'principal', 'repA', 'boardClass', 'noGrant'];
const AR = `/api/audit-reviews/${YEAR}`;
const SNAP = '/api/reports/annual/snapshots';
const DENY_SAMPLES = [
  ['GET', H('payment_entry'), undefined, HISTORY_DENIED],
  ['GET', H('ledger_entry'), undefined, HISTORY_DENIED],
  ['GET', H('reconciliation'), undefined, HISTORY_DENIED],
  ['GET', H('email_campaign'), undefined, HISTORY_DENIED],
  ['GET', AR, undefined, ['admin', 'principal', 'repA', 'boardClass', 'noGrant']],
  ['POST', `${AR}/notes`, { kind: 'question', targetType: 'year', targetId: YEAR, body: 'Pytanie syntetyczne.' },
    ['admin', 'board', 'treasurer', 'principal', 'repA', 'noGrant'], true],
  ['POST', `${AR}/notes/arn-x/answers`, { body: 'Odpowiedź syntetyczna.' }, ['admin', 'audit', 'principal', 'repA', 'noGrant'], true],
  ['POST', `${AR}/notes/arn-x/closure`, {}, ['admin', 'board', 'treasurer', 'principal', 'repA', 'noGrant'], true],
  ['POST', `${AR}/conclusion`, { body: 'Wniosek syntetyczny.' }, ['admin', 'board', 'treasurer', 'principal', 'repA', 'noGrant'], true],
  ['GET', `/api/reports/annual?schoolYearId=${YEAR}`, undefined, ['admin', 'audit', 'repA', 'boardClass', 'noGrant']],
  ['GET', `/api/reports/cash-flow?schoolYearId=${YEAR}`, undefined, ['admin', 'audit', 'repA', 'boardClass', 'noGrant']],
  ['GET', `${SNAP}?schoolYearId=${YEAR}`, undefined, ['admin', 'audit', 'principal', 'repA', 'boardClass', 'noGrant']],
  ['POST', SNAP, { schoolYearId: YEAR }, ['admin', 'audit', 'principal', 'repA', 'boardClass', 'noGrant']],
  ['GET', `${SNAP}/frs-x`, undefined, ['admin', 'audit', 'principal', 'repA', 'boardClass', 'noGrant']],
  ['POST', `${SNAP}/frs-x/approve`, {}, ['admin', 'treasurer', 'audit', 'principal', 'repA', 'boardClass', 'noGrant']],
  ['POST', '/api/exports', { schoolYearId: YEAR }, ['treasurer', 'audit', 'principal', 'repA', 'boardClass', 'noGrant']],
  ['GET', '/api/exports/class-roster?classId=c-1a', undefined, ['treasurer', 'audit', 'principal', 'repB', 'noGrant']],
  ['GET', `/api/print/cards?schoolYearId=${YEAR}&classId=c-1a`, undefined, ['audit', 'principal', 'repB', 'noGrant']],
  ['GET', `/api/board/overview?schoolYearId=${YEAR}`, undefined, ['treasurer', 'audit', 'principal', 'repA', 'noGrant']],
  ['GET', `/api/board/overview/export.csv?schoolYearId=${YEAR}`, undefined, ['treasurer', 'audit', 'principal', 'repA', 'noGrant']],
  ['GET', `/api/board/overview/export.xlsx?schoolYearId=${YEAR}`, undefined, ['treasurer', 'audit', 'principal', 'repA', 'noGrant']],
  ['GET', `/api/representative/overview?schoolYearId=${YEAR}`, undefined,
    ['admin', 'board', 'boardClass', 'treasurer', 'audit', 'principal', 'noGrant']],
];

const stageOperations = () => Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item)
  .filter(([, operation]) => MODULES.includes(operation.tags[0]))
  .map(([method, operation]) => [`${method.toUpperCase()} ${path}`, operation]));

test('specyfikacja etapu 13: klucz idempotencji tylko w ścieżce KR, bez nagłówka ponowienia, formaty plików i krok w górę MFA', () => {
  const operations = stageOperations();
  assert.equal(operations.length, 22);
  const keyed = operations.filter(([, op]) => op.parameters?.some((p) => p.name === 'Idempotency-Key'))
    .map(([id, op]) => [id, op.parameters.find((p) => p.name === 'Idempotency-Key').required]);
  assert.deepEqual(keyed.sort(), [
    ['POST /api/audit-reviews/{year}/conclusion', true],
    ['POST /api/audit-reviews/{year}/notes', true],
    ['POST /api/audit-reviews/{year}/notes/{id}/answers', true],
    ['POST /api/audit-reviews/{year}/notes/{id}/closure', true],
  ]);
  const replayedHeaders = operations.flatMap(([id, op]) => Object.entries(op.responses)
    .filter(([, response]) => response.headers?.['Idempotency-Replayed']).map(([status]) => `${id} ${status}`));
  assert.deepEqual(replayedHeaders, [], 'ponowienie sygnalizuje pole `replayed`, nie nagłówek');
  const optional = operations.filter(([, op]) => op.requestBody && op.requestBody.required === false).map(([id]) => id).sort();
  assert.deepEqual(optional, ['POST /api/audit-reviews/{year}/notes/{id}/closure', 'POST /api/reports/annual/snapshots/{id}/approve']);
  const stale = operations.filter(([, op]) => op.responses['403']?.['x-rd-error-codes']?.includes('mfa_stale')).map(([id]) => id).sort();
  assert.deepEqual(stale, ['POST /api/exports', 'POST /api/reports/annual/snapshots/{id}/approve']);
  const files = Object.fromEntries(operations.map(([id, op]) => [id, Object.keys(op.responses['200']?.content ?? op.responses['201']?.content ?? {}).sort()]));
  assert.deepEqual(files['GET /api/exports/class-roster'], ['application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv; charset=utf-8']);
  assert.deepEqual(files['GET /api/reports/annual'], ['application/json', 'text/html; charset=utf-8']);
  assert.deepEqual(files['GET /api/reports/annual/snapshots/{id}'], ['application/json', 'text/html; charset=utf-8']);
  assert.deepEqual(files['GET /api/board/overview/export.csv'], ['text/csv; charset=utf-8']);
  assert.deepEqual(files['GET /api/board/overview/export.xlsx'], ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
  assert.deepEqual(files['GET /api/print/cards'], ['application/json'], 'kartki: JSON dla panelu druku, nie HTML/PDF');
  // Pola wrażliwe: kartki bez danych opiekunów; pulpity bez identyfikatorów rodzin; pulpit przedstawiciela bez wpłat.
  assert.deepEqual(Object.keys(components.PrintCardRow.properties).filter((name) => /guardian|email/i.test(name)), []);
  assert.ok(Object.keys(components.PrintCardRow.properties).length > 4);
  for (const name of ['BoardOverviewClass', 'RepresentativeClassSummary']) {
    assert.deepEqual(Object.keys(components[name].properties).filter((field) => /^(householdId|households|email|payments)$/.test(field)), [], name);
  }
  assert.equal(components.PrintCardRow.required.includes('recordedNetCents'), false, 'kwota tylko przy roli finansowej z MFA');
  assert.equal(components.FinancialAnnualReportPayload.properties.generatedAt, undefined, 'treść migawki bez czasu wygenerowania');
  assert.deepEqual(DENY_SAMPLES.map(([method, path]) => {
    const { path: template } = createContractClient({ spec, fetch: null }).findOperation(method, path.split('?')[0]);
    return `${method} ${template}`;
  }).sort(), operations.map(([id]) => id).sort(), 'próbki odmów obejmują każdą operację etapu');
});

test('kontrakt etapu 13: historia obiektu, ścieżka KR, sprawozdania, eksporty, kartki i pulpity zgodne ze schematami', async () => {
  const { db, env, cookies, client } = await world();
  const { validated } = client;
  const C = cookies;
  try {
    // ---------- kartki bez opublikowanej informacji o przetwarzaniu (D-06) ----------
    assert.equal((await client.call('GET', `/api/print/cards?schoolYearId=${YEAR}`, { cookie: C.board, expect: 409 })).body.error, 'privacy_notice_missing');
    await seedPublishedPrivacyNotice(db);
    const ids = await seedFinance(env, C);

    // ---------- granice ról na każdej operacji ----------
    for (const [method, path, body, denied, withKey] of DENY_SAMPLES) {
      const options = { body, invalidRequest: true, key: withKey ? key('deny') : undefined };
      assert.equal((await client.call(method, path, { ...options, expect: 401 })).body.error, 'unauthenticated', `${method} ${path}`);
      for (const role of denied) {
        assert.equal((await client.call(method, path, { ...options, cookie: C[role], expect: 403 })).body.error, 'forbidden', `${role}: ${method} ${path}`);
      }
      // Bramka MFA routera: zarząd bez czynnika i konto z czynnikiem po samym haśle.
      assert.equal((await client.call(method, path, { ...options, cookie: C.boardNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required');
      assert.equal((await client.call(method, path, { ...options, cookie: C.auditFactor, expect: 403 })).body.error, 'mfa_required');
      if (method === 'POST') {
        assert.equal((await client.call(method, path, { ...options, cookie: C.board, origin: FOREIGN, expect: 403 })).body.error, 'invalid_origin');
      }
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_review_notes')).rows[0].n, 0, 'odmowy niczego nie zapisały');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM export_runs')).rows[0].n, 0);

    // ---------- historia obiektu (#181) ----------
    for (const [type, id] of [
      ['payment_entry', ids.paymentId], ['ledger_entry', ids.ledgerEntryId], ['reconciliation', ids.reconciliationId], ['email_campaign', ids.campaignId],
    ]) {
      for (const cookie of [C.board, C.treasurer]) {
        const history = (await client.call('GET', `/api/audit/entity/${type}/${id}`, { cookie, expect: 200 })).body;
        assert.deepEqual([history.entityType, history.entityId], [type, id]);
        assert.ok(history.events.length >= 1, `${type}: zdarzenie utworzenia`);
        assert.ok(!JSON.stringify(history).includes('@'), `${type}: bez adresów e-mail`);
      }
      // Rok obiektu bez przydziału i obiekt nieistniejący: to samo 404 (SR-07); zły identyfikator: 400.
      assert.equal((await client.call('GET', `/api/audit/entity/${type}/${id}`, { cookie: C.boardNext, expect: 404 })).body.error, 'not_found');
      assert.equal((await client.call('GET', `/api/audit/entity/${type}/brak-obiektu`, { cookie: C.board, expect: 404 })).body.error, 'not_found');
      assert.equal((await client.call('GET', `/api/audit/entity/${type}/-zly`, { cookie: C.board, expect: 400 })).body.error, 'invalid_request');
    }
    const viewed = (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'audit.viewed'")).rows[0].n;
    assert.equal(viewed, 8, 'każdy odczyt historii zapisuje audit.viewed');

    // ---------- ścieżka kontroli Komisji Rewizyjnej (#137) ----------
    const listed = async (cookie = C.audit) => (await client.call('GET', AR, { cookie, expect: 200 })).body;
    assert.deepEqual((await listed()).counts, { open: 0, answered: 0, closed: 0 });
    const questionBody = { kind: 'question', targetType: 'ledger_entry', targetId: ids.ledgerEntryId, body: 'Prosimy o fakturę do tego wpisu.' };
    const questionKey = key('arn');
    const question = await client.call('POST', `${AR}/notes`, { cookie: C.audit, body: questionBody, key: questionKey, expect: 201 });
    assert.deepEqual([question.body.replayed, question.body.note.kind, question.body.note.parentId], [false, 'question', null]);
    const replay = await client.call('POST', `${AR}/notes`, { cookie: C.audit, body: questionBody, key: questionKey, expect: 200 });
    assert.deepEqual([replay.body.replayed, replay.body.note.id], [true, question.body.note.id]);
    assert.equal(replay.headers.get('Idempotency-Replayed'), null, 'bez nagłówka ponowienia');
    assert.equal((await client.call('POST', `${AR}/notes`, { cookie: C.audit, body: { ...questionBody, body: 'Inna treść pytania.' }, key: questionKey, expect: 409 })).body.error, 'idempotency_conflict');
    const finding = (await client.call('POST', `${AR}/notes`, {
      cookie: C.audit, key: key('arn'), expect: 201, body: { kind: 'finding', targetType: 'reconciliation', targetId: ids.reconciliationId, body: 'Ustalenie do uzgodnienia.' },
    })).body.note;
    const yearNote = (await client.call('POST', `${AR}/notes`, {
      cookie: C.both, key: key('arn'), expect: 201, body: { kind: 'question', targetType: 'year', targetId: YEAR, body: 'Pytanie o rok (konflikt ról).' },
    })).body.note;
    for (const [body, status, code] of [
      [{ ...questionBody, kind: 'answer' }, 400, 'invalid_request'],
      [{ ...questionBody, targetId: '-zly' }, 400, 'invalid_request'],
      [{ ...questionBody, body: 'ab' }, 400, 'invalid_audit_review_body'],
      [{ ...questionBody, targetType: 'year', targetId: NEXT }, 404, 'audit_review_target_not_found'],
      [{ ...questionBody, targetId: 'le-brak' }, 404, 'audit_review_target_not_found'],
      [{ ...questionBody, body: 'Proszę o kontakt: rodzic.pulapka@example.invalid' }, 422, 'personal_data_forbidden'],
    ]) {
      assert.equal((await client.call('POST', `${AR}/notes`, { cookie: C.audit, body, key: key('arn'), expect: status, invalidRequest: true })).body.error, code, JSON.stringify(body));
    }
    await assertRequiredFieldsEnforced(client, C.audit, `${AR}/notes`, questionBody, 'AuditReviewNoteRequest', { withKey: true });
    assert.equal((await client.call('POST', `${AR}/notes`, { cookie: C.audit, body: questionBody, expect: 400 })).body.error, 'invalid_idempotency_key');
    assert.equal((await client.call('POST', `${AR}/notes`, { cookie: C.audit, body: '{', key: key('arn'), headers: { 'Content-Type': 'application/json' }, expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', `${AR}/notes`, { cookie: C.audit, body: '{}', key: key('arn'), headers: { 'Content-Type': 'text/plain' }, expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', `${AR}/notes`, { cookie: C.audit, body: { ...questionBody, pad: 'x'.repeat(13 * 1024) }, key: key('arn'), expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', '/api/audit-reviews/-zly/notes', { cookie: C.audit, body: questionBody, key: key('arn'), expect: 400 })).body.error, 'invalid_school_year_id');
    assert.equal((await client.call('POST', `/api/audit-reviews/${MISSING}/notes`, {
      cookie: C.auditAll, body: { ...questionBody, targetType: 'year', targetId: MISSING }, key: key('arn'), expect: 404,
    })).body.error, 'school_year_not_found');
    // Rok i rola pasują, przeszkodą jest tylko MFA sesji (#161); rok spoza przydziału — zwykła odmowa.
    assert.equal((await client.call('POST', `${AR}/notes`, { cookie: C.auditNoMfa, body: questionBody, key: key('arn'), expect: 403 })).body.error, 'mfa_enrollment_required');
    assert.equal((await client.call('POST', `/api/audit-reviews/${NEXT}/notes`, { cookie: C.audit, body: questionBody, key: key('arn'), expect: 403 })).body.error, 'forbidden');

    // Odpowiedź: skarbnik (201, ponowienie 200); autor pytania z rolą skarbnika — cztery oczy.
    const answerPath = `${AR}/notes/${question.body.note.id}/answers`;
    const answerBody = { body: 'Faktura jest w dokumentach roku.' };
    const answerKey = key('ans');
    const answer = await client.call('POST', answerPath, { cookie: C.treasurer, body: answerBody, key: answerKey, expect: 201 });
    assert.equal(answer.body.note.parentId, question.body.note.id);
    assert.equal((await client.call('POST', answerPath, { cookie: C.treasurer, body: answerBody, key: answerKey, expect: 200 })).body.replayed, true);
    assert.equal((await client.call('POST', `${AR}/notes/${yearNote.id}/answers`, { cookie: C.both, body: answerBody, key: key('ans'), expect: 403 })).body.error, 'four_eyes_required');
    assert.equal((await client.call('POST', `${AR}/notes/${yearNote.id}/answers`, { cookie: C.board, body: answerBody, key: key('ans'), expect: 201 })).body.note.kind, 'answer');
    assert.equal((await client.call('POST', `${AR}/notes/arn-brak/answers`, { cookie: C.board, body: answerBody, key: key('ans'), expect: 404 })).body.error, 'audit_review_not_found');
    assert.equal((await client.call('POST', `${AR}/notes/-zly/answers`, { cookie: C.board, body: answerBody, key: key('ans'), expect: 400 })).body.error, 'audit_review_not_found');
    assert.equal((await client.call('POST', answerPath, { cookie: C.board, body: {}, key: key('ans'), expect: 400, invalidRequest: true })).body.error, 'invalid_audit_review_body');
    await assertRequiredFieldsEnforced(client, C.board, answerPath, answerBody, 'AuditReviewBodyRequest', { withKey: true });

    // Zamknięcie: bez treści (puste ciało bez Content-Type), drugie zamknięcie i odpowiedź po zamknięciu — 409.
    const closurePath = `${AR}/notes/${question.body.note.id}/closure`;
    const closureKey = key('cls');
    const closed = await client.call('POST', closurePath, { cookie: C.audit, key: closureKey, expect: 201 });
    assert.deepEqual([closed.body.note.kind, closed.body.note.body], ['closed', null]);
    const closedReplay = await client.call('POST', closurePath, { cookie: C.audit, key: closureKey, expect: 200 });
    assert.deepEqual([closedReplay.body.replayed, closedReplay.body.note.id], [true, closed.body.note.id], 'podwójne kliknięcie zamknięcia');
    assert.equal((await client.call('POST', closurePath, { cookie: C.audit, body: { body: 'Drugie zamknięcie.' }, key: key('cls'), expect: 409 })).body.error, 'audit_review_closed');
    assert.equal((await client.call('POST', answerPath, { cookie: C.treasurer, body: answerBody, key: key('ans'), expect: 409 })).body.error, 'audit_review_closed');
    const findingClosed = await client.call('POST', `${AR}/notes/${finding.id}/closure`, { cookie: C.audit, body: { body: 'Wyjaśnione na posiedzeniu.' }, key: key('cls'), expect: 201 });
    assert.equal(findingClosed.body.note.body, 'Wyjaśnione na posiedzeniu.');
    assert.equal((await client.call('POST', `${AR}/notes/${yearNote.id}/closure`, { cookie: C.audit, body: { body: 'x' }, key: key('cls'), expect: 400, invalidRequest: true })).body.error, 'invalid_audit_review_body');

    // Wniosek końcowy: kolejny wniosek to nowy zapis, obowiązuje najnowszy.
    const conclusionBody = { body: 'Komisja nie stwierdza nieprawidłowości (syntetyczne).' };
    const conclusionKey = key('con');
    const conclusion = (await client.call('POST', `${AR}/conclusion`, { cookie: C.audit, body: conclusionBody, key: conclusionKey, expect: 201 })).body.note;
    assert.equal((await client.call('POST', `${AR}/conclusion`, { cookie: C.audit, body: conclusionBody, key: conclusionKey, expect: 200 })).body.note.id, conclusion.id);
    const conclusion2 = (await client.call('POST', `${AR}/conclusion`, { cookie: C.auditAll, body: { body: 'Wniosek uzupełniony (syntetyczne).' }, key: key('con'), expect: 201 })).body.note;
    assert.equal((await client.call('POST', `/api/audit-reviews/${MISSING}/conclusion`, { cookie: C.auditAll, body: conclusionBody, key: key('con'), expect: 404 })).body.error, 'school_year_not_found');
    await assertRequiredFieldsEnforced(client, C.audit, `${AR}/conclusion`, conclusionBody, 'AuditReviewBodyRequest', { withKey: true });
    for (const cookie of [C.audit, C.board, C.treasurer]) {
      const view = await listed(cookie);
      assert.deepEqual(view.counts, { open: 0, answered: 1, closed: 2 });
      assert.deepEqual([view.conclusions.map((note) => note.id), view.currentConclusion.id], [[conclusion.id, conclusion2.id], conclusion2.id]);
    }
    assert.equal((await client.call('GET', '/api/audit-reviews/-zly', { cookie: C.audit, expect: 400 })).body.error, 'invalid_school_year_id');
    assert.equal((await client.call('GET', `/api/audit-reviews/${MISSING}`, { cookie: C.auditAll, expect: 404 })).body.error, 'school_year_not_found');
    assert.equal((await client.call('GET', AR, { cookie: C.auditNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required');
    assert.equal((await client.call('GET', `/api/audit-reviews/${NEXT}`, { cookie: C.audit, expect: 403 })).body.error, 'forbidden');

    // ---------- sprawozdanie roczne i przepływy (#125) ----------
    for (const cookie of [C.board, C.treasurer, C.principal]) {
      const annual = (await client.call('GET', `/api/reports/annual?schoolYearId=${YEAR}`, { cookie, expect: 200 })).body.report;
      assert.deepEqual([annual.balance.openingBalanceCents, annual.income.totalCents], [100000, 5000]);
      assert.ok(!JSON.stringify(annual).includes('Składki syntetyczne'), 'bez opisów wpisów');
      const flow = (await client.call('GET', `/api/reports/cash-flow?schoolYearId=${YEAR}`, { cookie, expect: 200 })).body.report;
      assert.equal(flow.totals.closingBalanceCents, annual.balance.closingBalanceCents);
    }
    const html = await client.call('GET', `/api/reports/annual?schoolYearId=${YEAR}&format=html`, { cookie: C.principal, expect: 200 });
    assert.match(html.headers.get('Content-Security-Policy'), /default-src 'none'/);
    await client.call('GET', `/api/reports/cash-flow?schoolYearId=${YEAR}&granularity=month`, { cookie: C.board, expect: 200 });
    for (const path of ['/api/reports/annual', '/api/reports/cash-flow']) {
      assert.equal((await client.call('GET', path, { cookie: C.board, expect: 400 })).body.error, 'invalid_request');
      assert.equal((await client.call('GET', `${path}?schoolYearId=${MISSING}`, { cookie: C.boardAll, expect: 404 })).body.error, 'school_year_not_found');
      assert.equal((await client.call('GET', `${path}?schoolYearId=${NEXT}`, { cookie: C.board, expect: 403 })).body.error, 'forbidden');
      assert.equal((await client.call('GET', `${path}?schoolYearId=${YEAR}`, { cookie: C.principalNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required');
    }
    assert.equal((await client.call('GET', `/api/reports/annual?schoolYearId=${YEAR}&format=pdf`, { cookie: C.board, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('GET', `/api/reports/cash-flow?schoolYearId=${YEAR}&granularity=week`, { cookie: C.board, expect: 400, invalidRequest: true })).body.error, 'invalid_request');

    // ---------- migawki sprawozdania: łańcuch korekt i zatwierdzenie drugą osobą ----------
    const addEntry = async (amountCents) => assert.equal((await raw(env, 'POST', '/api/ledger', {
      cookie: C.treasurer, idempotencyKey: key('led'),
      body: { schoolYearId: YEAR, direction: 'income', amountCents, categoryId: 'cat-in', description: 'Składki syntetyczne', occurredOn: '2026-10-20', method: 'cash' },
    })).status, 201);
    assert.deepEqual((await client.call('GET', `${SNAP}?schoolYearId=${YEAR}`, { cookie: C.board, expect: 200 })).body.snapshots, []);
    const s1 = (await client.call('POST', SNAP, { cookie: C.treasurer, body: { schoolYearId: YEAR }, expect: 201 })).body.snapshot;
    const s1Replay = await client.call('POST', SNAP, { cookie: C.board, body: { schoolYearId: YEAR }, expect: 200 });
    assert.deepEqual([s1Replay.body.replayed, s1Replay.body.snapshot.id], [true, s1.id], 'ta sama treść = ta sama migawka');
    assert.equal((await client.call('POST', `${SNAP}/${s1.id}/approve`, { cookie: C.boardStale, body: {}, expect: 403 })).body.error, 'mfa_stale');
    const approved = await client.call('POST', `${SNAP}/${s1.id}/approve`, { cookie: C.board, expect: 201 });
    assert.equal(approved.body.snapshot.approvedBy, 'u-board');
    assert.equal((await client.call('POST', `${SNAP}/${s1.id}/approve`, { cookie: C.board2, body: {}, expect: 200 })).body.replayed, true);
    await addEntry(1200);
    assert.equal((await client.call('POST', SNAP, { cookie: C.board, body: { schoolYearId: YEAR }, expect: 409 })).body.error, 'report_snapshot_supersedes_required');
    assert.equal((await client.call('POST', SNAP, { cookie: C.board, body: { schoolYearId: YEAR, supersedesId: s1.id }, expect: 400 })).body.error, 'invalid_reason');
    assert.equal((await client.call('POST', SNAP, { cookie: C.board, body: { schoolYearId: YEAR, supersedesId: s1.id, reason: 'ab' }, expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    assert.equal((await client.call('POST', SNAP, {
      cookie: C.board, body: { schoolYearId: YEAR, supersedesId: s1.id, reason: 'Korekta po uwagach: jan.pulapka@example.invalid' }, expect: 422,
    })).body.error, 'personal_data_forbidden');
    const s2 = (await client.call('POST', SNAP, { cookie: C.board, body: { schoolYearId: YEAR, supersedesId: s1.id, reason: 'Korekta syntetyczna' }, expect: 201 })).body.snapshot;
    assert.equal(s2.supersedesId, s1.id);
    assert.equal((await client.call('POST', `${SNAP}/${s2.id}/approve`, { cookie: C.board, body: {}, expect: 403 })).body.error, 'four_eyes_required');
    await addEntry(800);
    assert.equal((await client.call('POST', SNAP, { cookie: C.treasurer, body: { schoolYearId: YEAR, supersedesId: s1.id, reason: 'Korekta syntetyczna' }, expect: 409 })).body.error, 'report_snapshot_superseded');
    const s3 = (await client.call('POST', SNAP, { cookie: C.treasurer, body: { schoolYearId: YEAR, supersedesId: s2.id, reason: 'Druga korekta syntetyczna' }, expect: 201 })).body.snapshot;
    assert.equal((await client.call('POST', `${SNAP}/${s2.id}/approve`, { cookie: C.board2, body: {}, expect: 409 })).body.error, 'report_snapshot_superseded');
    assert.equal((await client.call('POST', `${SNAP}/${s3.id}/approve`, { cookie: C.board2, body: {}, expect: 201 })).body.snapshot.approvedBy, 'u-board2');
    assert.equal((await client.call('POST', `${SNAP}/frs-brak/approve`, { cookie: C.board, body: {}, expect: 404 })).body.error, 'report_snapshot_not_found');
    assert.equal((await client.call('POST', `${SNAP}/-zly/approve`, { cookie: C.board, body: {}, expect: 400 })).body.error, 'invalid_request');
    assert.equal((await client.call('POST', `${SNAP}/${s3.id}/approve`, { cookie: C.board, body: '{', headers: { 'Content-Type': 'application/json' }, expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    const listedSnapshots = (await client.call('GET', `${SNAP}?schoolYearId=${YEAR}`, { cookie: C.treasurer, expect: 200 })).body.snapshots;
    assert.deepEqual(listedSnapshots.map((item) => [item.id, item.supersededById]), [[s1.id, s2.id], [s2.id, s3.id], [s3.id, null]]);
    const read = (await client.call('GET', `${SNAP}/${s3.id}?format=json`, { cookie: C.board, expect: 200 })).body;
    assert.deepEqual([read.snapshot.id, read.report.kind, Object.hasOwn(read.report, 'generatedAt')], [s3.id, 'annual', false]);
    await client.call('GET', `${SNAP}/${s1.id}`, { cookie: C.treasurer, expect: 200 });
    const snapshotHtml = await client.call('GET', `${SNAP}/${s3.id}?format=html`, { cookie: C.treasurer, expect: 200 });
    assert.ok(new TextDecoder().decode(snapshotHtml.bytes).includes(s3.sha256), 'wydruk migawki ze skrótem');
    assert.equal((await client.call('GET', `${SNAP}/frs-brak`, { cookie: C.board, expect: 404 })).body.error, 'report_snapshot_not_found');
    assert.equal((await client.call('GET', `${SNAP}/frs-brak`, { cookie: C.boardNext, expect: 404 })).body.error, 'report_snapshot_not_found');
    assert.equal((await client.call('GET', `${SNAP}/${s3.id}`, { cookie: C.boardNext, expect: 403 })).body.error, 'forbidden', 'migawka roku bez przydziału');
    assert.equal((await client.call('GET', `${SNAP}/-zly`, { cookie: C.board, expect: 400 })).body.error, 'invalid_request');
    assert.equal((await client.call('GET', `${SNAP}/${s3.id}?format=pdf`, { cookie: C.board, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('GET', SNAP, { cookie: C.board, expect: 400 })).body.error, 'invalid_request');
    assert.equal((await client.call('POST', SNAP, { cookie: C.boardAll, body: { schoolYearId: MISSING }, expect: 404 })).body.error, 'school_year_not_found');
    assert.equal((await client.call('POST', SNAP, { cookie: C.board, body: { schoolYearId: '-zly' }, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('POST', SNAP, { cookie: C.board, body: '{}', headers: { 'Content-Type': 'text/plain' }, expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', SNAP, { cookie: C.board, body: { schoolYearId: YEAR, pad: 'x'.repeat(9 * 1024) }, expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    await assertRequiredFieldsEnforced(client, C.board, SNAP, { schoolYearId: YEAR }, 'FinancialReportSnapshotRequest');

    // ---------- kartki (#11): zakres, kwoty tylko rola finansowa z MFA, rodzeństwo, ograniczenie przetwarzania ----------
    assert.equal((await raw(env, 'POST', '/api/payment-instructions', {
      cookie: C.board, idempotencyKey: key('ins'),
      body: { schoolYearId: YEAR, iban: 'BE68 5390 0754 7034', bic: 'GEBABEBB', payeeName: 'Rada Rodziców (dane testowe)' },
    })).status, 201);
    assert.equal((await raw(env, 'POST', '/api/payment-references', { cookie: C.treasurer, idempotencyKey: key('ogm'), body: { schoolYearId: YEAR, householdId: 'h1' } })).status, 201);
    const dsr = (await raw(env, 'POST', '/api/admin/data-requests', { cookie: C.admin, body: { kind: 'restriction', householdId: 'h3', receivedOn: '2026-10-01' } })).body.request.id;
    assert.equal((await raw(env, 'POST', `/api/admin/data-requests/${dsr}/status`, { cookie: C.admin, body: { status: 'identity_verified' } })).status, 200);
    assert.equal((await raw(env, 'POST', `/api/admin/data-requests/${dsr}/restrict`, { cookie: C.admin })).status, 200);
    const cards = async (cookie, query, expect = 200) => client.call('GET', `/api/print/cards?schoolYearId=${YEAR}${query}`, { cookie, expect });
    const full = (await cards(C.board, '')).body;
    assert.deepEqual([full.paymentInfoIncluded, full.skippedRestricted, full.paymentInstructions.iban], [true, 1, 'BE68539007547034']);
    assert.deepEqual(full.rows.map((row) => row.householdId).sort(), ['h1', 'h1', 'h2', 'h4', 'h5', 'h6'], 'h3 pominięta (ograniczenie), h7 innego roku');
    assert.equal(full.rows.find((row) => row.householdId === 'h2').recordedNetCents, 5000);
    assert.match(full.rows.find((row) => row.householdId === 'h1').structuredReference, /^\d{12}$/);
    assert.ok(!JSON.stringify(full).includes('@'), 'kartki bez adresów opiekunów');
    const fullClass = (await cards(C.treasurer, '&classId=c-1a')).body;
    assert.deepEqual(fullClass.rows.map((row) => row.className).sort(), ['1A', '1B'], 'zakres szeroki: rodzina z rodzeństwem z innej klasy');
    const own = (await cards(C.repA, '&classId=c-1a')).body;
    assert.deepEqual([own.paymentInfoIncluded, own.skippedRestricted, own.rows.map((row) => row.className)], [false, 1, ['1A']]);
    assert.ok(own.rows.length > 0 && own.rows.every((row) => !Object.hasOwn(row, 'recordedNetCents')), 'przedstawiciel bez kwot');
    const otherOwn = (await cards(C.repB, '&classId=c-1b')).body;
    assert.deepEqual([otherOwn.skippedRestricted, otherOwn.rows.length], [0, 5], 'licznik pominiętych tylko w zakresie klasy');
    assert.equal((await cards(C.boardClass, '&classId=c-1a')).body.paymentInfoIncluded, true, 'zarząd z przydziałem klasy z MFA');
    assert.equal((await cards(C.repA, '', 400)).body.error, 'class_required');
    assert.equal((await cards(C.repA, '&classId=c-1b', 403)).body.error, 'forbidden', 'przedstawiciel innej klasy');
    assert.equal((await client.call('GET', `/api/print/cards?schoolYearId=${NEXT}&classId=c-1a`, { cookie: C.repA, expect: 403 })).body.error, 'forbidden');
    assert.equal((await cards(C.board, '&classId=c-2a', 404)).body.error, 'class_not_found', 'klasa innego roku');
    assert.equal((await client.call('GET', `/api/print/cards?schoolYearId=${MISSING}`, { cookie: C.admin, expect: 404 })).body.error, 'school_year_not_found');
    assert.equal((await client.call('GET', '/api/print/cards', { cookie: C.board, expect: 400 })).body.error, 'invalid_request');
    assert.equal((await cards(C.board, '&classId=-zly', 400)).body.error, 'invalid_request');

    // ---------- lista klasy i eksport roczny (#9, #132) ----------
    const roster = async (cookie, query, expect = 200) => client.call('GET', `/api/exports/class-roster?${query}`, { cookie, expect });
    const rosterJson = await roster(C.repAMfa, 'classId=c-1a');
    assert.equal(rosterJson.headers.get('X-Export-Manifest-Sha256'), rosterJson.body.sha256);
    const h1Student = rosterJson.body.students.find((student) => student.id === 'h1-s1');
    assert.deepEqual(h1Student.guardians.map((guardian) => guardian.email), ['h1-g1@example.invalid', null], 'e-mail wyłącznie przy zgodzie');
    assert.deepEqual(rosterJson.body.students.map((student) => student.id).sort(), ['h1-s1', 'h3-s1'], 'tylko klasa 1A');
    assert.ok(!JSON.stringify(rosterJson.body).includes('"h1"'), 'bez identyfikatorów rodzin');
    assert.ok((await roster(C.repAMfa, 'classId=c-1a&format=csv')).bytes.length > 0);
    assert.ok((await roster(C.repAMfa, 'classId=c-1a&format=xlsx')).bytes.length > 0);
    await roster(C.repAMfa, 'classId=c-1a&format=json');
    for (const cookie of [C.board, C.admin, C.boardClass]) await roster(cookie, 'classId=c-1a');
    assert.equal((await roster(C.boardClass, 'classId=c-1b', 403)).body.error, 'forbidden');
    assert.equal((await roster(C.repAMfa, 'classId=c-1b', 403)).body.error, 'forbidden', 'przedstawiciel innej klasy');
    assert.equal((await roster(C.board, 'classId=c-2a', 403)).body.error, 'forbidden', 'klasa roku bez przydziału');
    assert.equal((await roster(C.repA, 'classId=c-1a', 403)).body.error, 'mfa_enrollment_required');
    assert.equal((await roster(C.repAFactor, 'classId=c-1a', 403)).body.error, 'mfa_required');
    assert.equal((await roster(C.board, 'classId=c-brak', 404)).body.error, 'class_not_found');
    // Rozbieżność z SR-07 (opis w docs/API.md): zarząd innego roku odróżnia istniejącą klasę (403) od nieistniejącej (404).
    assert.equal((await roster(C.boardNext, 'classId=c-1a', 403)).body.error, 'forbidden');
    assert.equal((await roster(C.boardNext, 'classId=c-brak', 404)).body.error, 'class_not_found');
    assert.equal((await client.call('GET', '/api/exports/class-roster', { cookie: C.board, expect: 400 })).body.error, 'invalid_class');
    assert.equal((await client.call('GET', '/api/exports/class-roster?classId=c-1a&format=pdf', { cookie: C.board, expect: 400, invalidRequest: true })).body.error, 'invalid_format');

    const yearly = await client.call('POST', '/api/exports', { cookie: C.board, body: { schoolYearId: YEAR }, expect: 200 });
    assert.equal(yearly.headers.get('X-Export-Manifest-Sha256'), yearly.body.manifestSha256);
    assert.match(yearly.headers.get('Content-Disposition'), /^attachment; filename="rd-eksport-y-2026-v2\.json"$/);
    assert.deepEqual(Object.keys(yearly.body.files).sort(), yearly.body.manifest.files.map((file) => file.path).sort());
    assert.equal(yearly.body.manifest.totals.payments.recordedNetCents, 5000);
    assert.equal((await client.call('POST', '/api/exports', { cookie: C.boardStale, body: { schoolYearId: YEAR }, expect: 403 })).body.error, 'mfa_stale');
    assert.equal((await client.call('POST', '/api/exports', { cookie: C.board, body: { schoolYearId: NEXT }, expect: 403 })).body.error, 'forbidden');
    assert.equal((await client.call('POST', '/api/exports', { cookie: C.admin, body: { schoolYearId: MISSING }, expect: 404 })).body.error, 'school_year_not_found');
    assert.equal((await client.call('POST', '/api/exports', { cookie: C.board, body: { schoolYearId: '-zly' }, expect: 400, invalidRequest: true })).body.error, 'invalid_school_year');
    assert.equal((await client.call('POST', '/api/exports', { cookie: C.board, body: '{', headers: { 'Content-Type': 'application/json' }, expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', '/api/exports', { cookie: C.board, body: '{}', headers: { 'Content-Type': 'text/plain' }, expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', '/api/exports', { cookie: C.board, body: { schoolYearId: YEAR, pad: 'x'.repeat(5 * 1024) }, expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    await assertRequiredFieldsEnforced(client, C.board, '/api/exports', { schoolYearId: YEAR }, 'YearlyExportRequest');
    const runs = (await db.query('SELECT kind, count(*)::int AS n FROM export_runs GROUP BY kind ORDER BY kind')).rows;
    assert.deepEqual(runs.map((row) => [row.kind, row.n]), [['class_roster', 7], ['yearly', 1]]);

    // ---------- pulpit zarządu (#131) ----------
    const overview = (await client.call('GET', `/api/board/overview?schoolYearId=${YEAR}`, { cookie: C.board, expect: 200 })).body;
    assert.deepEqual([overview.scope, overview.classes.map((entry) => entry.id)], ['school', ['c-1a', 'c-1b']]);
    assert.deepEqual(overview.classes.map((entry) => entry.paymentEntryRatePercent), [null, 20], '1A: 2 gospodarstwa (próg 5), 1B: 1 z 5');
    assert.deepEqual([overview.totals.householdCount, overview.totals.unmatchedPaymentsCount], [6, 1]);
    assert.ok(!JSON.stringify(overview).includes('"h1"') && !JSON.stringify(overview).includes('@'), 'bez identyfikatorów rodzin i adresów');
    const classOverview = (await client.call('GET', `/api/board/overview?schoolYearId=${YEAR}`, { cookie: C.boardClass, expect: 200 })).body;
    assert.deepEqual([classOverview.scope, classOverview.classes.map((entry) => entry.id)], ['classes', ['c-1a']]);
    assert.equal(Object.hasOwn(classOverview.totals, 'paymentEntryRatePercent'), false, 'zarząd klasowy bez kolumny wpłat');
    assert.equal((await client.call('GET', `/api/board/overview?schoolYearId=${YEAR}`, { cookie: C.admin, expect: 200 })).body.scope, 'school');
    for (const suffix of ['', '/export.csv', '/export.xlsx']) {
      const path = `/api/board/overview${suffix}`;
      assert.equal((await client.call('GET', path, { cookie: C.board, expect: 400 })).body.error, 'invalid_request');
      assert.equal((await client.call('GET', `${path}?schoolYearId=${NEXT}`, { cookie: C.board, expect: 404 })).body.error, 'school_year_not_found', 'rok poza przydziałem');
      assert.equal((await client.call('GET', `${path}?schoolYearId=${MISSING}`, { cookie: C.admin, expect: 404 })).body.error, 'school_year_not_found');
    }
    const csv = new TextDecoder().decode((await client.call('GET', `/api/board/overview/export.csv?schoolYearId=${YEAR}`, { cookie: C.boardClass, expect: 200 })).bytes);
    assert.ok(csv.includes('1A') && !csv.includes('Wpisy wpłat'), 'eksport zarządu klasowego: tylko 1A, bez kolumny wpłat');
    assert.ok((await client.call('GET', `/api/board/overview/export.xlsx?schoolYearId=${YEAR}`, { cookie: C.board, expect: 200 })).bytes.length > 0);

    // ---------- pulpit przedstawiciela (#118) ----------
    await db.query(`INSERT INTO meetings (id, school_year_id, kind, class_id, title, scheduled_at, status, created_by)
      VALUES ('m-1a', $1, 'class', 'c-1a', 'Zebranie klasowe (syntetyczne)', now() + interval '7 days', 'scheduled', 'u-board')`, [YEAR]);
    const repView = (await client.call('GET', `/api/representative/overview?schoolYearId=${YEAR}`, { cookie: C.repA, expect: 200 })).body;
    assert.deepEqual(repView.classes.map((entry) => entry.id), ['c-1a'], 'wyłącznie przypisana klasa');
    const [mine] = repView.classes;
    assert.deepEqual([mine.studentCount, mine.householdCount, mine.needsPaperCardCount], [2, 2, 0]);
    assert.ok(mine.cards.lastPrintedAt, 'data ostatniego wydruku kartek klasy');
    assert.equal(mine.nextMeeting.id, 'm-1a');
    assert.equal(Object.hasOwn(mine, 'payments'), false);
    assert.deepEqual((await client.call('GET', `/api/representative/overview?schoolYearId=${NEXT}`, { cookie: C.repA, expect: 200 })).body.classes, [], 'przydział innego roku');
    assert.deepEqual((await client.call('GET', `/api/representative/overview?schoolYearId=${NEXT}`, { cookie: C.repNext, expect: 200 })).body.classes.map((entry) => entry.id), ['c-2a']);
    assert.deepEqual((await client.call('GET', `/api/representative/overview?schoolYearId=${YEAR}`, { cookie: C.repB, expect: 200 })).body.classes.map((entry) => entry.id), ['c-1b']);
    assert.equal((await client.call('GET', '/api/representative/overview', { cookie: C.repA, expect: 400 })).body.error, 'invalid_request');

    assert.equal(networkGuardCalls(), 0, 'żadnej próby połączenia z siecią');
    assertSuccessCoverage(validated);
  } finally {
    await db.close();
  }
});

// Zamknięcie roku przez trasy zamknięcia (lista kontrolna, druga osoba zarządu) — bez obchodzenia triggerów.
async function closeYear(env, cookies) {
  const call = async (path, cookie, body) => raw(env, 'POST', path, { cookie, body });
  assert.equal((await call(`/api/year-close/${YEAR}/start`, cookies.closerA, { nextSchoolYearId: NEXT })).status, 201);
  for (const item of CHECKLIST_ITEMS) {
    assert.equal((await call(`/api/year-close/${YEAR}/checklist/${item}`, cookies.closerA, { note: `Potwierdzenie ${item}` })).status, 201);
  }
  const closed = await call(`/api/year-close/${YEAR}/close`, cookies.closerB, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
}

// Świat zamkniętego roku: przydziały bez roku przetrwają zamknięcie (wygasają tylko przydziały zamykanego roku).
async function closedWorld() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await family(db, 'h1', { classes: ['c-1a'], guardians: [['Zenobia', 'Testowa', true]] });
  const both = (role) => [{ role, schoolYearId: YEAR }, { role, schoolYearId: NEXT }];
  const cookies = {
    closerA: await seedUserSession(db, { userId: 'u-closer-a', mfa: true, roles: both('board') }),
    closerB: await seedUserSession(db, { userId: 'u-closer-b', mfa: true, roles: both('board') }),
    nextBoard: await seedUserSession(db, { userId: 'u-next-board', mfa: true, roles: [{ role: 'board', schoolYearId: NEXT }] }),
    auditAll: await seedUserSession(db, { userId: 'u-audit-all', mfa: true, roles: [{ role: 'audit' }] }),
    treasurerAll: await seedUserSession(db, { userId: 'u-treasurer-all', mfa: true, roles: [{ role: 'treasurer' }] }),
    boardAll: await seedUserSession(db, { userId: 'u-board-all', mfa: true, roles: [{ role: 'board' }] }),
  };
  const env = { db, APP_ENV: 'development' };
  return { db, env, cookies, client: createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) }) };
}

test('kontrakt etapu 13: zamknięty rok — zapisy KR i zatwierdzenie migawki 409, odczyt zostaje, eksport archiwum', async () => {
  const { db, env, cookies, client } = await closedWorld();
  try {
    const question = (await client.call('POST', `${AR}/notes`, {
      cookie: cookies.auditAll, key: key('arn'), expect: 201, body: { kind: 'question', targetType: 'year', targetId: YEAR, body: 'Pytanie przed zamknięciem.' },
    })).body.note;
    const snapshot = (await client.call('POST', SNAP, { cookie: cookies.treasurerAll, body: { schoolYearId: YEAR }, expect: 201 })).body.snapshot;
    await closeYear(env, cookies);

    for (const [path, cookie, body] of [
      [`${AR}/notes`, cookies.auditAll, { kind: 'question', targetType: 'year', targetId: YEAR, body: 'Pytanie po zamknięciu.' }],
      [`${AR}/notes/${question.id}/answers`, cookies.treasurerAll, { body: 'Odpowiedź po zamknięciu.' }],
      [`${AR}/notes/${question.id}/closure`, cookies.auditAll, { body: 'Zamknięcie po zamknięciu roku.' }],
      [`${AR}/conclusion`, cookies.auditAll, { body: 'Wniosek po zamknięciu.' }],
    ]) {
      assert.equal((await client.call('POST', path, { cookie, body, key: key('cls'), expect: 409 })).body.error, 'school_year_closed', path);
    }
    assert.equal((await client.call('GET', AR, { cookie: cookies.auditAll, expect: 200 })).body.threads.length, 1, 'odczyt zamkniętego roku');
    assert.equal((await client.call('POST', `${SNAP}/${snapshot.id}/approve`, { cookie: cookies.boardAll, body: {}, expect: 409 })).body.error, 'school_year_closed');
    // Księga zamkniętego roku się nie zmienia, więc ta sama treść to ponowienie, nie nowa migawka.
    const again = await client.call('POST', SNAP, { cookie: cookies.boardAll, body: { schoolYearId: YEAR }, expect: 200 });
    assert.deepEqual([again.body.replayed, again.body.snapshot.id], [true, snapshot.id]);
    // Zarząd roku następnego eksportuje zamknięty rok (#195); jego przydział nie obejmuje roku zamkniętego wprost.
    const archive = await client.call('POST', '/api/exports', { cookie: cookies.nextBoard, body: { schoolYearId: YEAR }, expect: 200 });
    assert.equal(archive.body.manifest.schoolYearId, YEAR);
    const archiveReads = (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'year_close.archive_read'")).rows[0].n;
    assert.equal(archiveReads, 1, 'odczyt archiwum w dzienniku');
    assert.equal(networkGuardCalls(), 0);
  } finally {
    await db.close();
  }
});

test('kontrakt etapu 13: pierwsza migawka zamkniętego roku — 409 school_year_closed', async () => {
  const { db, env, cookies, client } = await closedWorld();
  try {
    await closeYear(env, cookies);
    assert.equal((await client.call('POST', SNAP, { cookie: cookies.boardAll, body: { schoolYearId: YEAR }, expect: 409 })).body.error, 'school_year_closed');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM financial_report_snapshots')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});
