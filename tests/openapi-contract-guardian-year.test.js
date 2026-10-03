// Kontrakt API (#160, etap 13): prawdziwe odpowiedzi modułów `guardian-updates`, `import`, `privacy-notice` i `year-close`
// (PGlite, dane syntetyczne `@example.invalid`, imiona syntetyczne) walidowane schematami z docs/openapi.json
// (src/pg/schemas/guardian-updates.js, import.js, privacy-notice.js, year-close.js) przez tests/helpers/contract-client.js.
// Rejestr pokrycia i katalog kodów sprawdza tests/openapi-contract.test.js (wspólnie dla wszystkich pokrytych modułów).
//
// ŻADNEJ SIECI I ŻADNEJ WYSYŁKI: kod weryfikacyjny nowego adresu opiekuna wysyła worker z transportem-atrapą (prawdziwy
// transport Brevo odmawia pod `node --test`), adresy wyłącznie `@example.invalid`; globalna pułapka sieci
// (tests/helpers/network-guard.js) liczy próby połączeń — licznik musi być 0.
//
// Przebieg (osobna baza na moduł): granice ról na każdej z 23 operacji (401 na każdej trasie z sesją; 403 dla ról bez
// dostępu; bramka MFA routera; obcy Origin), sukcesy walidowane schematami, ponowienia (podwójne kliknięcie, ten sam klucz
// idempotencji, rozstrzygnięty wniosek, zatwierdzona/opublikowana wersja), dwoje opiekunów rodzeństwa i inna rodzina bez
// zmian, import z kluczem i bez informacji o przetwarzaniu danych, zamknięcie roku z czterema oczami i listą kontrolną,
// import do zamkniętego roku (409 `school_year_closed`), błędy 400/404/409/413/415/422 i pominięcie wymaganych pól ciała.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { emailConfig } from '../src/email/brevo.js';
import { runEmailBatch } from '../src/email/worker.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import {
  createTestDb, networkGuardCalls, seedClass, seedPublishedPrivacyNotice, seedSchoolYear, seedUserSession,
} from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;
const MODULES = ['guardian-updates', 'import', 'privacy-notice', 'year-close'];

const YEAR = 'y-2026';
const FOREIGN = 'https://obcy.example.invalid';
const ZERO_SHA = '0'.repeat(64);
const PHONE_NOTE = 'Proszę zadzwonić: 0470 12 34 56';
const EMAIL_NOTE = 'Kontakt: rodzic@example.invalid';

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

function newClient(env) {
  return createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
}

// Każda odpowiedź sukcesu opisana w schematach wskazanych modułów została zwalidowana na prawdziwej odpowiedzi.
function assertSuccessCoverage(validated, moduleNames, minimum) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (!moduleNames.includes(entry.module)) continue;
    for (const status of Object.keys(entry.responses)) expected.push(`${routeId} ${status}`);
  }
  assert.ok(expected.length >= minimum, `oczekiwane odpowiedzi: ${expected.length}`);
  assert.deepEqual(expected.filter((item) => !validated.has(item)), [], 'odpowiedzi sukcesu opisane w schemacie bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje błąd i w schemacie, i na serwerze (400; wyjątki — status w `statuses`).
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

// Role spoza zakresu modułów (odmowa 403 `forbidden`) i konta admina bez MFA (bramka routera).
async function commonActors(db, schoolYearId) {
  const year = (role, extra = {}) => [{ role, schoolYearId, ...extra }];
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: year('treasurer') }),
    rep: await seedUserSession(db, { userId: 'u-rep', mfa: false, roles: year('representative', { classId: 'c-1a' }) }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: year('audit') }),
    principal: await seedUserSession(db, { userId: 'u-principal', mfa: false, roles: year('principal') }),
    classBoard: await seedUserSession(db, { userId: 'u-board-class', mfa: true, roles: year('board', { classId: 'c-1a' }) }),
    adminNoMfa: await seedUserSession(db, { userId: 'u-admin-nomfa', mfa: false, roles: [{ role: 'admin' }] }),
    adminFactor: await seedUserSession(db, { userId: 'u-admin-factor', mfa: false, roles: [{ role: 'admin' }] }),
  };
  await addFactor(db, 'u-admin-factor');
  return cookies;
}

// Granice ról: 401 bez sesji, 403 dla ról bez dostępu, bramka MFA routera i obcy Origin na zapisach.
async function assertDenied(client, cookies, samples, deniedRoles) {
  for (const [method, path, body, extraDenied = []] of samples) {
    const options = { body, invalidRequest: true };
    assert.equal((await client.call(method, path, { ...options, expect: 401 })).body.error, 'unauthenticated', `${method} ${path}`);
    for (const role of [...deniedRoles, ...extraDenied]) {
      assert.equal((await client.call(method, path, { ...options, cookie: cookies[role], expect: 403 })).body.error, 'forbidden', `${role}: ${method} ${path}`);
    }
    assert.equal((await client.call(method, path, { ...options, cookie: cookies.adminNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required', `${method} ${path}`);
    assert.equal((await client.call(method, path, { ...options, cookie: cookies.adminFactor, expect: 403 })).body.error, 'mfa_required', `${method} ${path}`);
    if (method === 'POST') {
      const allowed = cookies.allowed;
      assert.equal((await client.call(method, path, { ...options, cookie: allowed, origin: FOREIGN, expect: 403 })).body.error, 'invalid_origin', `${method} ${path}`);
    }
  }
}

const operationsOf = (moduleName) => Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item)
  .filter(([, operation]) => operation.tags.includes(moduleName))
  .map(([method, operation]) => [`${method.toUpperCase()} ${path}`, operation]));
const templateOf = (method, path) => `${method} ${createContractClient({ spec, fetch: null }).findOperation(method, path.split('?')[0]).path}`;

// Próbki odmów: [metoda, ścieżka, ciało, dodatkowe role z odmową]. Obiekt nie musi istnieć: odmowa zapada przed odczytem.
const TEMPLATE = {
  subject: 'Potwierdzenie adresu e-mail (syntetyczne)',
  bodyText: 'Kod potwierdzający nowy adres: {kod}. Kod jest ważny {waznosc} godzin (wiadomość syntetyczna).',
};
const GUARDIAN_DENY = [
  ['POST', '/api/admin/guardian-links', { guardianId: 'g-1' }],
  ['GET', '/api/admin/guardian-update-requests'],
  ['POST', '/api/admin/guardian-update-requests/r-x/approve'],
  ['POST', '/api/admin/guardian-update-requests/r-x/reject'],
  ['GET', '/api/admin/guardian-verify-templates'],
  ['POST', '/api/admin/guardian-verify-templates', TEMPLATE],
  ['POST', '/api/admin/guardian-verify-templates/t-x/approve', {}, ['admin']],
];
const GUARDIAN_PUBLIC = [
  ['GET', '/api/public/guardian-update?token=00'],
  ['POST', '/api/public/guardian-update', { token: '00' }],
  ['POST', '/api/public/guardian-update/verify', { token: '00', code: '00000000' }],
];
const IMPORT_COLUMNS = ['studentId', 'firstName', 'lastName', 'className', 'householdId', 'guardian1', 'email1', 'guardian2', 'email2'];
const importBody = (rows, extra = {}) => ({ version: 1, schoolYearId: YEAR, columns: [...IMPORT_COLUMNS], rows, ...extra });
const SIBLINGS = [
  ['imp-s1', 'Ola', 'Importowana', '1A', 'imp-h1', 'Anna Importowa', 'anna.imp@example.invalid', 'Jan Importowy', 'jan.imp@example.invalid'],
  ['imp-s2', 'Ela', 'Importowana', '1B', 'imp-h1', 'Anna Importowa', 'anna.imp@example.invalid', 'Jan Importowy', 'jan.imp@example.invalid'],
];
const IMPORT_DENY = [
  ['GET', '/api/import/options'],
  ['POST', '/api/import/preview', importBody(SIBLINGS)],
  ['POST', '/api/import/commit', importBody(SIBLINGS, { fingerprint: ZERO_SHA, planDigest: ZERO_SHA })],
];
const PRIVACY_DENY = [
  ['GET', '/api/admin/privacy-notices'],
  ['POST', '/api/admin/privacy-notices', { bodyText: 'Treść syntetyczna (odmowa).', decisionRef: 'D-06/odmowa' }],
  ['POST', '/api/admin/privacy-notices/pn-x/approve'],
  ['POST', '/api/admin/privacy-notices/pn-x/publish'],
];
const OLD = 'y-2026';
const NEW = 'y-2027';
const YEAR_CLOSE_DENY = [
  ['GET', `/api/year-close/${OLD}`],
  ['POST', `/api/year-close/${OLD}/start`, { nextSchoolYearId: NEW }, ['treasurer']],
  ['POST', `/api/year-close/${OLD}/checklist/financial_report`, {}],
  ['GET', `/api/year-close/${OLD}/handover`],
  ['POST', `/api/year-close/${OLD}/close`, {}, ['treasurer']],
];

test('specyfikacja etapu 13: klucz idempotencji, nagłówek ponowienia, ciała opcjonalne, trasy publiczne i tokeny', () => {
  const operations = MODULES.flatMap(operationsOf);
  assert.equal(operations.length, 23);
  assert.deepEqual(MODULES.map((name) => operationsOf(name).length), [10, 3, 5, 5]);
  const keyed = operations.filter(([, op]) => op.parameters?.some((p) => p.name === 'Idempotency-Key'))
    .map(([id, op]) => [id, op.parameters.find((p) => p.name === 'Idempotency-Key').required]);
  assert.deepEqual(keyed, [['POST /api/import/commit', true]]);
  const replayedHeaders = operations.flatMap(([id, op]) => Object.entries(op.responses)
    .filter(([, response]) => response.headers?.['Idempotency-Replayed'])
    .map(([status, response]) => [`${id} ${status}`, response.headers['Idempotency-Replayed'].schema.enum, response.headers['Idempotency-Replayed'].required ?? true]));
  assert.deepEqual(replayedHeaders.sort(), [
    ['POST /api/admin/guardian-verify-templates/{templateId}/approve 200', ['true'], false],
    ['POST /api/admin/privacy-notices/{id}/approve 200', ['true'], false],
    ['POST /api/admin/privacy-notices/{id}/publish 200', ['true'], false],
  ]);
  const optionalBodies = operations.filter(([, op]) => op.requestBody && op.requestBody.required === false).map(([id]) => id).sort();
  assert.deepEqual(optionalBodies, ['POST /api/year-close/{schoolYearId}/checklist/{item}', 'POST /api/year-close/{schoolYearId}/close']);
  // Trasy publiczne: bez sesji (bez 401 i bez security), wyłącznie podgląd, formularz, potwierdzenie kodu i informacja.
  const publicOps = operations.filter(([, op]) => op['x-rd-access'] === 'public').map(([id, op]) => {
    assert.equal(op.responses['401'], undefined, `${id}: trasa publiczna bez 401`);
    assert.deepEqual(op.security, []);
    return id;
  }).sort();
  assert.deepEqual(publicOps, [
    'GET /api/public/guardian-update', 'GET /api/public/privacy-notice', 'POST /api/public/guardian-update',
    'POST /api/public/guardian-update/verify',
  ]);
  // Token linku wyłącznie w odpowiedzi wydania; publiczne schematy bez identyfikatorów kont; import bez imion i adresów.
  assert.ok(Object.hasOwn(components.GuardianUpdateLink.properties, 'token'));
  for (const name of ['GuardianUpdateRequest', 'GuardianUpdatePreview', 'GuardianUpdateSubmitted', 'GuardianUpdateDecision']) {
    assert.equal(Object.hasOwn(components[name].properties, 'token'), false, `${name} bez tokenu`);
    assert.equal(Object.hasOwn(components[name].properties, 'code'), false, `${name} bez kodu`);
  }
  assert.deepEqual(Object.keys(components.PrivacyNoticePublic.properties).sort(), ['bodyText', 'publishedAt', 'version']);
  for (const shape of components.ImportPlanRow.oneOf) {
    assert.deepEqual(Object.keys(shape.properties).filter((name) => /name|email|guardian/i.test(name)), []);
  }
  // Krok w górę MFA: zatwierdzenie szablonu i zamknięcie roku.
  const stale = operations.filter(([, op]) => op.responses['403']?.['x-rd-error-codes']?.includes('mfa_stale')).map(([id]) => id).sort();
  assert.deepEqual(stale, ['POST /api/admin/guardian-verify-templates/{templateId}/approve', 'POST /api/year-close/{schoolYearId}/close']);
  // Próbki odmów i tras publicznych obejmują każdą operację modułów.
  const samples = [...GUARDIAN_DENY, ...GUARDIAN_PUBLIC, ...IMPORT_DENY, ...PRIVACY_DENY, ...YEAR_CLOSE_DENY,
    ['GET', '/api/public/privacy-notice']];
  assert.deepEqual(samples.map(([method, path]) => templateOf(method, path)).sort(), operations.map(([id]) => id).sort());
});

// ---------- guardian-updates ----------

const VERIFY_ENV = { GUARDIAN_VERIFY_EMAIL_ENABLED: 'true' };
const WORKER_ENV = {
  APP_ENV: 'test', EMAIL_SENDING_ENABLED: 'true', BREVO_FROM_EMAIL: 'rada@rada.example.invalid',
  EMAIL_TEST_ALLOWLIST: '*@example.invalid', ...VERIFY_ENV,
};

function fakeTransport() {
  const sent = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return { messageId: `fx-contract-${sent.length}` };
    },
  };
}

async function guardianWorld() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR);
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  await seedPublishedPrivacyNotice(db);
  const cookies = {
    ...await commonActors(db, YEAR),
    admin: await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] }),
    boardA: await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    boardC: await seedUserSession(db, { userId: 'u-board-c', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    boardStale: await seedUserSession(db, { userId: 'u-board-stale', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
  };
  cookies.allowed = cookies.admin;
  await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-board-stale'");
  // h1: rodzeństwo w 1A i 1B, dwoje opiekunów przy obojgu dzieciach; h2: inna rodzina (nie może się zmienić).
  for (const householdId of ['h1', 'h2']) await db.query('INSERT INTO households (id) VALUES ($1)', [householdId]);
  const students = [['s1', 'h1', 'c-1a'], ['s2', 'h1', 'c-1b'], ['s3', 'h2', 'c-1a']];
  for (const [id, householdId, classId] of students) {
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Syntetyczny')", [id, householdId]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, id, classId, YEAR]);
  }
  const guardians = [['g1', 'h1', 'Zenobia', ['s1', 's2']], ['g2', 'h1', 'Bonifacy', ['s1', 's2']], ['g3', 'h2', 'Euzebia', ['s3']]];
  for (const [id, householdId, firstName, studentIds] of guardians) {
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, $3, 'Testowa', $4, true)`,
      [id, householdId, firstName, `stary-${id}@example.invalid`],
    );
    for (const [index, studentId] of studentIds.entries()) {
      await db.query(
        'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, $3)',
        [studentId, id, id === 'g1' || (id === 'g3' && index === 0)],
      );
    }
  }
  const env = { db, ...VERIFY_ENV };
  return { db, env, cookies, client: newClient(env) };
}

test('kontrakt modułu guardian-updates: link, formularz publiczny, kod weryfikacyjny, kolejka z decyzją i szablon zgodne ze schematami', async () => {
  const { db, env, cookies, client } = await guardianWorld();
  const { admin: A, boardA, boardB } = cookies;
  try {
    // ---------- granice ról na każdej operacji z sesją ----------
    await assertDenied(client, cookies, GUARDIAN_DENY, ['treasurer', 'rep', 'audit', 'principal', 'classBoard']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM guardian_update_links')).rows[0].n, 0, 'odmowy niczego nie zapisały');

    // ---------- szablon wiadomości z kodem (cztery oczy, krok w górę MFA) ----------
    const emptyTemplates = (await client.call('GET', '/api/admin/guardian-verify-templates', { cookie: A, expect: 200 })).body;
    assert.deepEqual([emptyTemplates.templates, emptyTemplates.currentTemplateId, emptyTemplates.enabled], [[], null, true]);
    const draft = (await client.call('POST', '/api/admin/guardian-verify-templates', { cookie: boardA, body: TEMPLATE, expect: 201 })).body.template;
    assert.deepEqual([draft.status, draft.createdBy, draft.approvedBy], ['draft', 'u-board-a', null]);
    const second = (await client.call('POST', '/api/admin/guardian-verify-templates', { cookie: A, body: TEMPLATE, expect: 201 })).body.template;
    assert.equal(second.version, draft.version + 1);
    for (const [body, code] of [
      [{ ...TEMPLATE, subject: 'ab' }, 'invalid_verify_template'],
      [{ ...TEMPLATE, bodyText: 'Treść bez znacznika, ważna {waznosc} godzin.' }, 'verify_code_placeholder_required'],
      [{ ...TEMPLATE, bodyText: 'Kod {kod} i nieznany znacznik {imie} w treści.' }, 'invalid_verify_template'],
      [{ ...TEMPLATE, subject: 'Zaległa składka (syntetyczne)' }, 'forbidden_wording'],
    ]) {
      assert.equal((await client.call('POST', '/api/admin/guardian-verify-templates', { cookie: A, body, expect: 400, invalidRequest: true })).body.error, code);
    }
    await assertRequiredFieldsEnforced(client, A, '/api/admin/guardian-verify-templates', TEMPLATE, 'GuardianVerifyTemplateCreateRequest');
    const approvePath = `/api/admin/guardian-verify-templates/${draft.id}/approve`;
    assert.equal((await client.call('POST', approvePath, { cookie: boardA, body: {}, expect: 403 })).body.error, 'self_approval_forbidden');
    assert.equal((await client.call('POST', approvePath, { cookie: cookies.boardStale, body: {}, expect: 403 })).body.error, 'mfa_stale');
    assert.equal((await client.call('POST', approvePath, { cookie: boardB, body: { contentHash: ZERO_SHA }, expect: 409 })).body.error, 'verify_template_changed');
    assert.equal((await client.call('POST', approvePath, { cookie: boardB, body: '', expect: 400, invalidRequest: true, headers: { 'Content-Type': 'application/json' } })).body.error, 'invalid_json');
    const approved = await client.call('POST', approvePath, { cookie: boardB, body: { contentHash: draft.contentHash }, expect: 200 });
    assert.equal(approved.headers.get('Idempotency-Replayed'), null, 'pierwsze zatwierdzenie bez nagłówka');
    assert.deepEqual([approved.body.template.status, approved.body.template.approvedBy], ['approved', 'u-board-b']);
    const approvedAgain = await client.call('POST', approvePath, { cookie: boardB, body: {}, expect: 200 });
    assert.equal(approvedAgain.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(approvedAgain.body, approved.body, 'podwójne kliknięcie: ten sam stan');
    assert.equal((await client.call('POST', approvePath, { cookie: cookies.boardC, body: {}, expect: 409 })).body.error, 'verify_template_not_draft');
    assert.equal((await client.call('POST', '/api/admin/guardian-verify-templates/t-brak/approve', { cookie: boardB, body: {}, expect: 404 })).body.error, 'verify_template_not_found');
    assert.equal((await client.call('POST', '/api/admin/guardian-verify-templates/-zly/approve', { cookie: boardB, body: {}, expect: 400 })).body.error, 'invalid_request');
    // Wersje od najnowszej z kursorem; obowiązuje najnowsza zatwierdzona (także spoza strony).
    const page1 = (await client.call('GET', '/api/admin/guardian-verify-templates?limit=1', { cookie: A, expect: 200 })).body;
    assert.deepEqual([page1.templates.map((t) => t.id), page1.truncated, page1.currentTemplateId], [[second.id], true, draft.id]);
    const page2 = (await client.call('GET', `/api/admin/guardian-verify-templates?limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`, { cookie: A, expect: 200 })).body;
    assert.deepEqual([page2.templates.map((t) => t.id), page2.nextCursor], [[draft.id], null]);
    for (const [query, code] of [['limit=0', 'invalid_limit'], ['limit=101', 'invalid_limit'], ['cursor=zepsuty', 'invalid_cursor']]) {
      assert.equal((await client.call('GET', `/api/admin/guardian-verify-templates?${query}`, { cookie: A, expect: 400, invalidRequest: true })).body.error, code, query);
    }

    // ---------- wydanie linku (token raz) ----------
    const linkG1 = (await client.call('POST', '/api/admin/guardian-links', { cookie: boardA, body: { guardianId: 'g1' }, expect: 201 })).body;
    assert.match(linkG1.token, /^[0-9a-f]{64}$/);
    const { rows: [stored] } = await db.query('SELECT token_hash FROM guardian_update_links WHERE id = $1', [linkG1.linkId]);
    assert.notEqual(stored.token_hash, linkG1.token, 'baza trzyma tylko skrót tokenu');
    const linkG2 = (await client.call('POST', '/api/admin/guardian-links', { cookie: A, body: { guardianId: 'g2' }, expect: 201 })).body;
    assert.equal((await client.call('POST', '/api/admin/guardian-links', { cookie: A, body: { guardianId: 'g-brak' }, expect: 404 })).body.error, 'guardian_not_found');
    assert.equal((await client.call('POST', '/api/admin/guardian-links', { cookie: A, body: { guardianId: '-zly' }, expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('POST', '/api/admin/guardian-links', { cookie: A, body: '{', expect: 400, invalidRequest: true, headers: { 'Content-Type': 'application/json' } })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', '/api/admin/guardian-links', { cookie: A, body: '{}', expect: 415, invalidRequest: true, headers: { 'Content-Type': 'text/plain' } })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', '/api/admin/guardian-links', { cookie: A, body: { guardianId: 'g1', pad: 'x'.repeat(5000) }, expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    await assertRequiredFieldsEnforced(client, A, '/api/admin/guardian-links', { guardianId: 'g1' }, 'GuardianLinkIssueRequest');

    // ---------- publiczny podgląd i formularz ----------
    const preview = (await client.call('GET', `/api/public/guardian-update?token=${linkG1.token}`, { expect: 200 })).body;
    assert.deepEqual(preview, { guardianFirstName: 'Zenobia', classNames: ['1A', '1B'] }, 'imię i klasy rodzeństwa, bez nazwisk i adresów');
    for (const token of ['', 'zly-token', 'ab'.repeat(32)]) {
      assert.equal((await client.call('GET', `/api/public/guardian-update?token=${token}`, { expect: 404, invalidRequest: true })).body.error, 'invalid_or_expired_link');
    }
    const submitBody = { token: linkG1.token, email: 'Nowy.G1@Example.invalid', contactAllowed: true, note: 'Zmiana adresu (syntetyczna).' };
    const submitted = (await client.call('POST', '/api/public/guardian-update', { body: submitBody, expect: 201 })).body;
    assert.deepEqual([submitted.status, submitted.emailVerification], ['pending', 'requested']);
    assert.equal((await client.call('POST', '/api/public/guardian-update', { body: submitBody, expect: 409 })).body.error, 'link_used', 'podwójne wysłanie: bez drugiego wniosku');
    assert.equal((await client.call('GET', `/api/public/guardian-update?token=${linkG1.token}`, { expect: 404 })).body.error, 'invalid_or_expired_link', 'zużyty link');
    assert.equal((await db.query("SELECT email FROM guardians WHERE id = 'g1'")).rows[0].email, 'stary-g1@example.invalid', 'formularz nie zmienia opiekuna');
    // Drugi opiekun tego samego dziecka: błędy formularza nie zużywają linku.
    const g2Path = '/api/public/guardian-update';
    for (const [body, status, code] of [
      [{ token: linkG2.token }, 400, 'invalid_request'],
      [{ token: linkG2.token, email: 'zly-adres' }, 400, 'invalid_email'],
      [{ token: linkG2.token, contactAllowed: 'tak' }, 400, 'invalid_request'],
      [{ token: linkG2.token, contactAllowed: false, note: 'x'.repeat(501) }, 400, 'invalid_request'],
      [{ token: linkG2.token, contactAllowed: false, note: EMAIL_NOTE }, 422, 'personal_data_forbidden'],
      [{ token: linkG2.token, contactAllowed: false, note: PHONE_NOTE }, 422, 'possible_personal_data'],
      [{ token: 'ab'.repeat(32), contactAllowed: false }, 404, 'invalid_or_expired_link'],
    ]) {
      assert.equal((await client.call('POST', g2Path, { body, expect: status, invalidRequest: true })).body.error, code, JSON.stringify(body));
    }
    assert.equal((await client.call('POST', g2Path, { body: '{', expect: 400, invalidRequest: true, headers: { 'Content-Type': 'application/json' } })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', g2Path, { body: '{}', expect: 415, invalidRequest: true, headers: { 'Content-Type': 'text/plain' } })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', g2Path, { body: { token: linkG2.token, note: 'x'.repeat(5000) }, expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', g2Path, { body: { token: linkG2.token, contactAllowed: false }, origin: FOREIGN, expect: 403, invalidRequest: true })).body.error, 'invalid_origin');
    await assertRequiredFieldsEnforced(client, undefined, g2Path, { token: linkG2.token, contactAllowed: false }, 'GuardianUpdateSubmitRequest', {
      statuses: { token: 404 },
    });
    const g2Submitted = (await client.call('POST', g2Path, {
      body: { token: linkG2.token, contactAllowed: false, note: PHONE_NOTE, confirmPersonalData: true }, expect: 201,
    })).body;
    assert.equal(g2Submitted.emailVerification, 'none', 'sama zgoda: bez kodu');

    // ---------- kod weryfikacyjny (worker z transportem-atrapą, adres @example.invalid) ----------
    const transport = fakeTransport();
    await runEmailBatch(env, { dryRun: false, transport, now: new Date(), config: emailConfig(WORKER_ENV) });
    assert.equal(transport.sent.length, 1, 'jedna wiadomość z kodem — wyłącznie na nowy adres z wniosku');
    assert.equal(transport.sent[0].to, 'nowy.g1@example.invalid');
    const code = /\b(\d{8})\b/.exec(transport.sent[0].text)[1];
    const wrong = code === '00000000' ? '11111111' : '00000000';
    const verifyPath = '/api/public/guardian-update/verify';
    assert.equal((await client.call('POST', verifyPath, { body: { token: linkG1.token, code: wrong }, expect: 400 })).body.error, 'invalid_or_expired_code');
    assert.equal((await client.call('POST', verifyPath, { body: { token: linkG2.token, code }, expect: 400 })).body.error, 'invalid_or_expired_code', 'kod innego wniosku (drugi opiekun) nie pasuje');
    assert.equal((await client.call('POST', verifyPath, { body: { token: 'zly', code }, expect: 400, invalidRequest: true })).body.error, 'invalid_or_expired_code');
    await assertRequiredFieldsEnforced(client, undefined, verifyPath, { token: linkG1.token, code }, 'GuardianVerifyCodeRequest');
    assert.deepEqual((await client.call('POST', verifyPath, { body: { token: linkG1.token, code }, expect: 200 })).body, { verification: 'confirmed' });
    assert.deepEqual((await client.call('POST', verifyPath, { body: { token: linkG1.token, code }, expect: 200 })).body, { verification: 'confirmed' }, 'ponowienie');
    assert.equal((await client.call('POST', verifyPath, { body: '{', expect: 400, invalidRequest: true, headers: { 'Content-Type': 'application/json' } })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', verifyPath, { body: '{}', expect: 415, invalidRequest: true, headers: { 'Content-Type': 'text/plain' } })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', verifyPath, { body: { token: linkG1.token, code, pad: 'x'.repeat(5000) }, expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', verifyPath, { body: { token: linkG1.token, code }, origin: FOREIGN, expect: 403, invalidRequest: true })).body.error, 'invalid_origin');

    // ---------- kolejka wniosków z kursorem ----------
    const queue = (await client.call('GET', '/api/admin/guardian-update-requests', { cookie: boardA, expect: 200 })).body;
    const byId = new Map(queue.requests.map((item) => [item.id, item]));
    assert.deepEqual(queue.requests.map((item) => item.id), [submitted.requestId, g2Submitted.requestId]);
    const g1Entry = byId.get(submitted.requestId);
    assert.deepEqual([g1Entry.proposedEmail, g1Entry.proposedContactAllowed, g1Entry.verification, g1Entry.verificationDelivery], ['nowy.g1@example.invalid', true, 'confirmed', 'sent']);
    const g2Entry = byId.get(g2Submitted.requestId);
    assert.deepEqual([Object.hasOwn(g2Entry, 'proposedEmail'), g2Entry.proposedContactAllowed, g2Entry.verification, g2Entry.verificationReason], [false, false, 'none', 'no_new_email']);
    const firstPage = (await client.call('GET', '/api/admin/guardian-update-requests?status=pending&limit=1', { cookie: A, expect: 200 })).body;
    assert.deepEqual([firstPage.requests.length, firstPage.truncated, firstPage.limit], [1, true, 1]);
    const nextPage = (await client.call('GET', `/api/admin/guardian-update-requests?status=pending&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { cookie: A, expect: 200 })).body;
    assert.deepEqual([...firstPage.requests, ...nextPage.requests].map((item) => item.id), queue.requests.map((item) => item.id));
    assert.equal((await client.call('GET', `/api/admin/guardian-update-requests?status=approved&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { cookie: A, expect: 400 })).body.error, 'invalid_cursor', 'kursor związany ze statusem');
    for (const [query, code] of [['status=wszystkie', 'invalid_request'], ['limit=0', 'invalid_limit'], ['limit=201', 'invalid_limit'], ['cursor=zepsuty', 'invalid_cursor']]) {
      assert.equal((await client.call('GET', `/api/admin/guardian-update-requests?${query}`, { cookie: A, expect: 400, invalidRequest: true })).body.error, code, query);
    }

    // ---------- decyzja: zatwierdzenie, odrzucenie, podwójne kliknięcie ----------
    const approveG1 = `/api/admin/guardian-update-requests/${submitted.requestId}/approve`;
    const decided = (await client.call('POST', approveG1, { cookie: boardA, expect: 200 })).body;
    assert.deepEqual(decided, { requestId: submitted.requestId, status: 'approved', changed: true, verification: 'confirmed' });
    assert.deepEqual((await client.call('POST', approveG1, { cookie: boardB, expect: 200 })).body, { requestId: submitted.requestId, status: 'approved', changed: false });
    const rejectG1 = `/api/admin/guardian-update-requests/${submitted.requestId}/reject`;
    assert.deepEqual((await client.call('POST', rejectG1, { cookie: A, expect: 200 })).body, { requestId: submitted.requestId, status: 'approved', changed: false }, 'rozstrzygnięty wniosek zostaje zatwierdzony');
    const rejected = (await client.call('POST', `/api/admin/guardian-update-requests/${g2Submitted.requestId}/reject`, { cookie: A, expect: 200 })).body;
    assert.deepEqual(rejected, { requestId: g2Submitted.requestId, status: 'rejected', changed: false });
    for (const action of ['approve', 'reject']) {
      assert.equal((await client.call('POST', `/api/admin/guardian-update-requests/r-brak/${action}`, { cookie: A, expect: 404 })).body.error, 'request_not_found');
      assert.equal((await client.call('POST', `/api/admin/guardian-update-requests/-zly/${action}`, { cookie: A, expect: 400 })).body.error, 'invalid_request');
    }
    const contacts = (await db.query('SELECT id, email, contact_allowed FROM guardians ORDER BY id')).rows;
    assert.deepEqual(contacts.map((row) => [row.id, row.email, row.contact_allowed]), [
      ['g1', 'nowy.g1@example.invalid', true],
      ['g2', 'stary-g2@example.invalid', true],
      ['g3', 'stary-g3@example.invalid', true],
    ], 'zmiana tylko u opiekuna z zatwierdzonego wniosku; drugi opiekun i inna rodzina bez zmian');
    const approvedList = (await client.call('GET', '/api/admin/guardian-update-requests?status=approved', { cookie: A, expect: 200 })).body;
    assert.deepEqual(approvedList.requests.map((item) => item.id), [submitted.requestId]);
    const events = (await db.query("SELECT action FROM audit_events WHERE entity_type = 'guardian_update_request' ORDER BY occurred_at, id")).rows.map((row) => row.action);
    assert.ok(events.includes('guardian_update_request.approved') && events.includes('guardian_update_request.rejected'), 'decyzje w dzienniku');
    assert.equal(events.filter((action) => action === 'guardian_update_request.approved').length, 1, 'ponowienie bez drugiego zdarzenia');

    assert.equal(networkGuardCalls(), 0, 'żadnej próby połączenia z siecią');
    assertSuccessCoverage(client.validated, ['guardian-updates'], 10);
  } finally {
    await db.close();
  }
});

// ---------- import i informacja o przetwarzaniu danych ----------

async function importWorld() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR);
  await seedSchoolYear(db, 'y-2030', { startsOn: '2030-09-01', endsOn: '2031-08-31' });
  await seedSchoolYear(db, 'y-pusty', { startsOn: '2032-09-01', endsOn: '2033-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  await seedClass(db, { id: 'c30-1a', schoolYearId: 'y-2030', name: '1A' });
  const cookies = {
    ...await commonActors(db, YEAR),
    adminA: await seedUserSession(db, { userId: 'u-admin-a', mfa: true, roles: [{ role: 'admin' }] }),
    adminB: await seedUserSession(db, { userId: 'u-admin-b', mfa: true, roles: [{ role: 'admin' }] }),
    board: await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
  };
  cookies.allowed = cookies.adminA;
  // Import działa bez IMPORT_ENABLED wyłącznie przy jawnym APP_ENV development/test/staging (#166).
  const env = { db, APP_ENV: 'test' };
  return { db, env, cookies, client: newClient(env) };
}

test('kontrakt modułów import i privacy-notice: opcje, podgląd, zapis z kluczem, wersje informacji i publikacja zgodne ze schematami', async () => {
  const { db, cookies, client } = await importWorld();
  const { adminA: A, adminB: B, board } = cookies;
  try {
    // ---------- granice ról ----------
    await assertDenied(client, cookies, IMPORT_DENY, ['treasurer', 'rep', 'audit', 'principal', 'classBoard']);
    await assertDenied(client, cookies, PRIVACY_DENY, ['treasurer', 'rep', 'audit', 'principal', 'classBoard']);
    // Zarząd z przydziałem roku 2026 nie importuje do innego roku (odmowa po odczycie ciała).
    const foreignYear = importBody([['imp-x1', 'Ola', 'Obca', '1A', 'imp-hx', '', '', '', '']], { schoolYearId: 'y-2030' });
    assert.equal((await client.call('POST', '/api/import/preview', { cookie: board, body: foreignYear, expect: 403 })).body.error, 'forbidden');
    assert.equal((await client.call('POST', '/api/import/commit', {
      cookie: board, body: { ...foreignYear, fingerprint: ZERO_SHA, planDigest: ZERO_SHA }, key: key('imp'), expect: 403,
    })).body.error, 'forbidden');
    // Poza środowiskiem testowym bez IMPORT_ENABLED=true import jest wyłączony.
    const productionClient = newClient({ db, APP_ENV: 'production' });
    assert.equal((await productionClient.call('GET', '/api/import/options', { cookie: A, expect: 403 })).body.error, 'import_disabled');
    assert.equal((await productionClient.call('POST', '/api/import/preview', { cookie: A, body: importBody(SIBLINGS), expect: 403 })).body.error, 'import_disabled');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM students WHERE source_ref LIKE 'imp-%'")).rows[0].n, 0, 'odmowy niczego nie zapisały');

    // ---------- opcje ----------
    const adminOptions = (await client.call('GET', '/api/import/options', { cookie: A, expect: 200 })).body;
    assert.deepEqual(adminOptions.schoolYears.map((year) => [year.id, year.classes]), [['y-pusty', []], ['y-2030', ['1A']], [YEAR, ['1A', '1B']]]);
    const boardOptions = (await client.call('GET', '/api/import/options', { cookie: board, expect: 200 })).body;
    assert.deepEqual(boardOptions.schoolYears.map((year) => year.id), [YEAR], 'zarząd widzi tylko rok przydziału');

    // ---------- informacja o przetwarzaniu danych: przed publikacją ----------
    assert.equal((await client.call('GET', '/api/public/privacy-notice', { expect: 404 })).body.error, 'privacy_notice_not_found');
    assert.deepEqual((await client.call('GET', '/api/admin/privacy-notices', { cookie: A, expect: 200 })).body, { notices: [] });

    // ---------- podgląd: rodzeństwo z dwojgiem opiekunów ----------
    const preview = (await client.call('POST', '/api/import/preview', { cookie: board, body: importBody(SIBLINGS), expect: 200 })).body;
    assert.deepEqual([preview.written, preview.commitAllowed, preview.rows.map((row) => row.action)], [false, true, ['add', 'add']]);
    assert.deepEqual(
      [preview.counts.householdsCreated, preview.counts.studentsCreated, preview.counts.guardiansCreated, preview.counts.linksCreated],
      [1, 2, 2, 4], 'jedna rodzina, dwoje dzieci, dwoje opiekunów przy obojgu dzieciach',
    );
    assert.ok(!JSON.stringify(preview).includes('Importowa') && !JSON.stringify(preview).includes('@'), 'podgląd bez imion i adresów');
    const commitBody = importBody(SIBLINGS, { fingerprint: preview.fingerprint, planDigest: preview.planDigest });
    const commitKey = key('imp');
    // Bez opublikowanej informacji o przetwarzaniu danych zapis jest zablokowany (D-06).
    assert.equal((await client.call('POST', '/api/import/commit', { cookie: board, body: commitBody, key: commitKey, expect: 409 })).body.error, 'privacy_notice_missing');

    // ---------- wersje informacji: szkic, cztery oczy, publikacja ----------
    const noticeBody = { bodyText: 'Treść informacji o przetwarzaniu danych (syntetyczna).', decisionRef: 'D-06/kontrakt' };
    const draft = (await client.call('POST', '/api/admin/privacy-notices', { cookie: A, body: noticeBody, expect: 201 })).body.notice;
    assert.deepEqual([draft.status, draft.createdBy, draft.schoolYearId, draft.approvedBy], ['draft', 'u-admin-a', null, null]);
    const noticePath = (id, action) => `/api/admin/privacy-notices/${id}/${action}`;
    assert.equal((await client.call('POST', noticePath(draft.id, 'approve'), { cookie: A, expect: 403 })).body.error, 'forbidden', 'autor nie zatwierdza');
    assert.equal((await client.call('POST', noticePath(draft.id, 'publish'), { cookie: A, expect: 409 })).body.error, 'privacy_notice_not_approved');
    const approved = await client.call('POST', noticePath(draft.id, 'approve'), { cookie: board, expect: 200 });
    assert.equal(approved.headers.get('Idempotency-Replayed'), null);
    assert.deepEqual([approved.body.notice.status, approved.body.notice.approvedBy], ['approved', 'u-board']);
    const approvedAgain = await client.call('POST', noticePath(draft.id, 'approve'), { cookie: B, expect: 200 });
    assert.equal(approvedAgain.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(approvedAgain.body, approved.body, 'ponowienie bez zmiany zatwierdzającego');
    const published = await client.call('POST', noticePath(draft.id, 'publish'), { cookie: A, expect: 200 });
    assert.equal(published.headers.get('Idempotency-Replayed'), null);
    assert.deepEqual([published.body.notice.status, published.body.notice.publishedBy], ['published', 'u-admin-a']);
    const publishedAgain = await client.call('POST', noticePath(draft.id, 'publish'), { cookie: B, expect: 200 });
    assert.equal(publishedAgain.headers.get('Idempotency-Replayed'), 'true');
    const publicNotice = await client.call('GET', '/api/public/privacy-notice', { expect: 200 });
    assert.deepEqual([publicNotice.body.version, publicNotice.body.bodyText], [draft.version, noticeBody.bodyText]);
    assert.equal(publicNotice.headers.get('Cache-Control'), 'public, max-age=60');
    // Nowa wersja zastępuje poprzednią; publikacja zastąpionej to ponowienie.
    const v2 = (await client.call('POST', '/api/admin/privacy-notices', { cookie: board, body: { ...noticeBody, schoolYearId: YEAR }, expect: 201 })).body.notice;
    await client.call('POST', noticePath(v2.id, 'approve'), { cookie: A, expect: 200 });
    await client.call('POST', noticePath(v2.id, 'publish'), { cookie: B, expect: 200 });
    const superseded = await client.call('POST', noticePath(draft.id, 'publish'), { cookie: A, expect: 200 });
    assert.deepEqual([superseded.body.notice.status, superseded.headers.get('Idempotency-Replayed')], ['superseded', 'true']);
    const versions = (await client.call('GET', '/api/admin/privacy-notices', { cookie: board, expect: 200 })).body.notices;
    assert.deepEqual(versions.map((notice) => [notice.version, notice.status]), [[v2.version, 'published'], [draft.version, 'superseded']]);
    assert.equal((await client.call('GET', '/api/public/privacy-notice', { expect: 200 })).body.version, v2.version);
    // Błędy wersji.
    for (const [body, code] of [
      [{ ...noticeBody, bodyText: '   ' }, 'invalid_body_text'],
      [{ ...noticeBody, decisionRef: '' }, 'invalid_decision_ref'],
      [{ ...noticeBody, schoolYearId: '-zly' }, 'invalid_school_year'],
      [{ ...noticeBody, schoolYearId: 'y-brak' }, 'invalid_reference'],
    ]) {
      assert.equal((await client.call('POST', '/api/admin/privacy-notices', { cookie: A, body, expect: 400, invalidRequest: true })).body.error, code, JSON.stringify(body));
    }
    assert.equal((await client.call('POST', '/api/admin/privacy-notices', { cookie: A, body: '{', expect: 400, invalidRequest: true, headers: { 'Content-Type': 'application/json' } })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', '/api/admin/privacy-notices', { cookie: A, body: '{}', expect: 415, invalidRequest: true, headers: { 'Content-Type': 'text/plain' } })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', '/api/admin/privacy-notices', { cookie: A, body: { ...noticeBody, bodyText: 'x'.repeat(9000) }, expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    await assertRequiredFieldsEnforced(client, A, '/api/admin/privacy-notices', noticeBody, 'PrivacyNoticeCreateRequest');
    for (const action of ['approve', 'publish']) {
      assert.equal((await client.call('POST', noticePath('pn-brak', action), { cookie: A, expect: 404 })).body.error, 'privacy_notice_not_found');
      assert.equal((await client.call('POST', noticePath('%E0%A4%A', action), { cookie: A, expect: 400 })).body.error, 'invalid_id');
    }

    // ---------- zapis z kluczem: utworzenie, ponowienie, te same dane z nowym kluczem ----------
    const created = await client.call('POST', '/api/import/commit', { cookie: board, body: commitBody, key: commitKey, expect: 201 });
    assert.deepEqual([created.body.replayed, created.body.counts.studentsCreated, created.headers.get('Idempotency-Replayed')], [false, 2, null]);
    const replay = await client.call('POST', '/api/import/commit', { cookie: board, body: commitBody, key: commitKey, expect: 200 });
    assert.deepEqual([replay.body.replayed, replay.body.batchId], [true, created.body.batchId], 'podwójne kliknięcie: zapisany wynik');
    const sameData = await client.call('POST', '/api/import/commit', { cookie: A, body: commitBody, key: key('imp'), expect: 200 });
    assert.deepEqual([sameData.body.replayed, sameData.body.batchId], [true, created.body.batchId], 'te same dane bez nowych zapisów');
    const imported = (await db.query(
      `SELECT count(DISTINCT s.id)::int AS students, count(DISTINCT sg.guardian_id)::int AS guardians, count(*)::int AS links
         FROM students s JOIN student_guardians sg ON sg.student_id = s.id WHERE s.source_ref LIKE 'imp-%'`,
    )).rows[0];
    assert.deepEqual(imported, { students: 2, guardians: 2, links: 4 }, 'bez duplikatów po ponowieniach');
    const batch = (await db.query('SELECT privacy_notice_id FROM import_batches WHERE id = $1', [created.body.batchId])).rows[0];
    assert.equal(batch.privacy_notice_id, v2.id, 'partia wskazuje wersję obowiązującą w chwili zapisu');

    // ---------- konflikty, zmiana od podglądu, ten sam klucz z innymi danymi ----------
    const mixed = [
      ['imp-s3', 'Piotr', 'Bezrodzinny', '1A', '', 'Ewa Testowa', 'ewa.imp@example.invalid', '', ''],
      ['imp-s4', 'Ida', 'Nowa', '1A', 'imp-h2', 'Olga Nowa', 'olga.imp@example.invalid', '', ''],
    ];
    const mixedPreview = (await client.call('POST', '/api/import/preview', { cookie: A, body: importBody(mixed, { rowNumbers: [7, 9] }), expect: 200 })).body;
    assert.deepEqual([mixedPreview.commitAllowed, mixedPreview.rows.map((row) => [row.row, row.action])], [false, [[7, 'conflict'], [9, 'add']]]);
    assert.deepEqual(mixedPreview.missingFromFile, { count: 2, refs: ['imp-s1', 'imp-s2'] }, 'uczniowie roku spoza pliku — tylko identyfikatory');
    const mixedCommit = importBody(mixed, { rowNumbers: [7, 9], fingerprint: mixedPreview.fingerprint, planDigest: mixedPreview.planDigest });
    const mixedKey = key('imp');
    assert.equal((await client.call('POST', '/api/import/commit', { cookie: A, body: mixedCommit, key: mixedKey, expect: 422 })).body.error, 'import_has_conflicts');
    assert.equal((await client.call('POST', '/api/import/commit', { cookie: A, body: mixedCommit, key: commitKey, expect: 409 })).body.error, 'idempotency_key_reused');
    assert.equal((await client.call('POST', '/api/import/commit', {
      cookie: A, body: { ...commitBody, fingerprint: mixedPreview.fingerprint }, key: key('imp'), expect: 409,
    })).body.error, 'fingerprint_mismatch');
    assert.equal((await client.call('POST', '/api/import/commit', {
      cookie: A, body: { ...mixedCommit, planDigest: ZERO_SHA }, key: key('imp'), expect: 409,
    })).body.error, 'preview_stale');
    const skipped = (await client.call('POST', '/api/import/commit', {
      cookie: A, body: { ...mixedCommit, options: { skipConflicts: true } }, key: mixedKey, expect: 201,
    })).body;
    assert.deepEqual([skipped.counts.rowsConflict, skipped.counts.studentsCreated], [1, 1], 'wiersz w konflikcie pominięty jawnie');

    // ---------- błędy treści ----------
    const previewError = async (body, status, code, extra = {}) => {
      const response = await client.call('POST', '/api/import/preview', { cookie: A, body, expect: status, invalidRequest: true, ...extra });
      assert.equal(response.body.error, code, JSON.stringify(body).slice(0, 120));
    };
    await previewError(importBody(SIBLINGS, { version: 2 }), 400, 'unsupported_version');
    await previewError(importBody(SIBLINGS, { schoolYearId: 'rok 2026' }), 400, 'invalid_school_year');
    await previewError(importBody(SIBLINGS, { columns: IMPORT_COLUMNS.slice(1) }), 400, 'invalid_columns');
    await previewError(importBody([]), 400, 'invalid_rows');
    await previewError(importBody([SIBLINGS[0].slice(1)]), 400, 'invalid_rows');
    await previewError(importBody([[...SIBLINGS[0].slice(0, 8), { e: 1 }]]), 400, 'invalid_cell');
    await previewError(importBody([[...SIBLINGS[0].slice(0, 8), 'x'.repeat(1001)]]), 400, 'invalid_cell');
    await previewError(importBody(SIBLINGS, { rowNumbers: [1] }), 400, 'invalid_row_numbers');
    await previewError(importBody(SIBLINGS, { options: { skipConflicts: 'tak' } }), 400, 'invalid_options');
    await previewError('[]', 400, 'invalid_payload', { headers: { 'Content-Type': 'application/json' } });
    await previewError('{', 400, 'invalid_json', { headers: { 'Content-Type': 'application/json' } });
    await previewError('{}', 415, 'unsupported_media_type', { headers: { 'Content-Type': 'text/csv' } });
    await previewError(importBody(Array.from({ length: 5001 }, () => SIBLINGS[0].map(() => ''))), 413, 'too_many_rows');
    await previewError(importBody(SIBLINGS, { pad: 'x'.repeat(1024 * 1024 + 1) }), 413, 'request_too_large');
    await previewError(importBody(SIBLINGS, { schoolYearId: 'y-brak' }), 422, 'unknown_school_year');
    await previewError(importBody(SIBLINGS, { schoolYearId: 'y-pusty' }), 422, 'no_classes_in_school_year');
    await assertRequiredFieldsEnforced(client, A, '/api/import/preview', importBody(SIBLINGS), 'ImportPreviewRequest');
    await assertRequiredFieldsEnforced(client, A, '/api/import/commit', commitBody, 'ImportCommitRequest', { withKey: true });
    assert.equal((await client.call('POST', '/api/import/commit', { cookie: A, body: commitBody, expect: 400 })).body.error, 'idempotency_key_required');
    assert.equal((await client.call('POST', '/api/import/commit', {
      cookie: A, body: commitBody, expect: 400, invalidRequest: true, headers: { 'Idempotency-Key': 'krotki' },
    })).body.error, 'idempotency_key_required');
    assert.equal((await client.call('POST', '/api/import/commit', {
      cookie: A, body: importBody(SIBLINGS, { fingerprint: 'abc', planDigest: preview.planDigest }), key: key('imp'), expect: 400, invalidRequest: true,
    })).body.error, 'preview_required');

    assert.equal(networkGuardCalls(), 0, 'żadnej próby połączenia z siecią');
    assertSuccessCoverage(client.validated, ['import', 'privacy-notice'], 9);
  } finally {
    await db.close();
  }
});

// ---------- year-close ----------

const EARLY = 'y-2025';
const X1 = 'y-2040';
const X2 = 'y-2041';

async function yearCloseWorld() {
  const db = await createTestDb();
  await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
    ($1, '2025/26 test', '2025-09-01', '2026-08-31'),
    ($2, '2026/27 test', '2026-09-01', '2027-08-31'),
    ($3, '2027/28 test', '2027-09-01', '2028-08-31'),
    ($4, '2040/41 test', '2040-09-01', '2041-08-31'),
    ($5, '2041/42 test', '2041-09-01', '2042-08-31')`, [EARLY, OLD, NEW, X1, X2]);
  await seedClass(db, { id: 'c-1a', schoolYearId: OLD, name: '1A' });
  await seedClass(db, { id: 'c-2a', schoolYearId: NEW, name: '2A' });
  const old = (role) => [{ role, schoolYearId: OLD }];
  const cookies = {
    ...await commonActors(db, OLD),
    admin: await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] }),
    boardA: await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: old('board') }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', mfa: true, roles: old('board') }),
    boardStale: await seedUserSession(db, { userId: 'u-board-stale', mfa: true, roles: old('board') }),
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', mfa: true, roles: [{ role: 'board' }] }),
    boardGlobal2: await seedUserSession(db, { userId: 'u-board-global-2', mfa: true, roles: [{ role: 'board' }] }),
    boardNew: await seedUserSession(db, { userId: 'u-board-new', mfa: true, roles: [{ role: 'board', schoolYearId: NEW }] }),
  };
  cookies.allowed = cookies.boardA;
  await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-board-stale'");
  // Księga roku: bilans otwarcia 500,00, przychód 1200,00, wydatek 300,00 z korektą 50,00; wpłata nieprzypisana 15,00.
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-treasurer'), ('cat-out', $1, 'expense', 'Wydarzenia', 'u-treasurer')`, [OLD]);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, created_by, idempotency_key)
    VALUES ('ob-old', $1, 50000, 'u-treasurer', 'ob-old-key-1')`, [OLD]);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key) VALUES
    ('le-in', $1, 'income', 120000, 'cat-in', 'Wpływy syntetyczne', '2026-10-01', 'bank', 'u-treasurer', 'le-in-key-1'),
    ('le-out', $1, 'expense', 30000, 'cat-out', 'Wydatek syntetyczny', '2026-11-01', 'bank', 'u-treasurer', 'le-out-key-1')`, [OLD]);
  await db.query(`INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
    VALUES ('lc-out', 'le-out', 5000, 'Zwrot części kosztu', 'u-treasurer', 'lc-out-key-1')`);
  await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
    VALUES ('p-un', NULL, $1, 1500, '2026-10-03', 'bank', 'unmatched', 'u-treasurer', 'p-un-key-001')`, [OLD]);
  // Import działa bez IMPORT_ENABLED wyłącznie przy jawnym APP_ENV development/test/staging (#166).
  const env = { db, APP_ENV: 'test' };
  return { db, env, cookies, client: newClient(env) };
}

test('kontrakt modułu year-close: stan, rozpoczęcie, lista kontrolna, zamknięcie z czterema oczami, przekazanie i import do zamkniętego roku', async () => {
  const { db, cookies, client } = await yearCloseWorld();
  const { boardA, boardB, boardGlobal, treasurer } = cookies;
  const path = (suffix = '', year = OLD) => `/api/year-close/${year}${suffix}`;
  try {
    // ---------- granice ról (admin techniczny bez dostępu; skarbnik nie rozpoczyna i nie zamyka) ----------
    await assertDenied(client, cookies, YEAR_CLOSE_DENY, ['admin', 'rep', 'audit', 'principal', 'classBoard']);
    assert.equal((await client.call('GET', path(), { cookie: cookies.boardNew, expect: 403 })).body.error, 'forbidden', 'zarząd innego roku');
    assert.equal((await client.call('GET', path('/handover'), { cookie: cookies.boardNew, expect: 403 })).body.error, 'forbidden', 'przekazanie otwartego roku tylko dla Rady roku');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM school_year_closures')).rows[0].n, 0, 'odmowy niczego nie zapisały');

    // ---------- stan otwartego roku ----------
    const open = (await client.call('GET', path(), { cookie: treasurer, expect: 200 })).body;
    assert.deepEqual([open.status, open.closureId, open.missingChecklistItems.length], ['open', null, 6]);
    assert.deepEqual([open.balance.source, open.balance.openingBalanceCents, open.balance.closingBalanceCents], ['live', 50000, 50000 + 120000 - 25000]);
    assert.equal(open.yearEndCheck.ok, true);
    assert.deepEqual(open.warnings, [
      { code: 'unallocated_payments', count: 1, amountCents: 1500 },
      { code: 'expenses_without_evidence', count: 1, amountCents: 25000 },
      { code: 'reconciliation_missing', count: 1, amountCents: null },
    ], 'ostrzeżenia: liczby i kwoty, bez identyfikatorów; nie blokują zamknięcia');
    assert.deepEqual(open.expenseReviews.unverified, { count: 1, netCents: 25000 });
    const handoverOpen = (await client.call('GET', path('/handover'), { cookie: treasurer, expect: 200 })).body;
    assert.deepEqual([handoverOpen.final, handoverOpen.finance.nextYearOpeningBalance, handoverOpen.payments.unmatchedCount], [false, null, 1]);
    assert.ok(!JSON.stringify(handoverOpen).includes('@'), 'przekazanie bez adresów');
    for (const [method, suffix, body] of [['GET', ''], ['GET', '/handover'], ['POST', '/start', { nextSchoolYearId: NEW }], ['POST', '/checklist/financial_report', {}], ['POST', '/close', {}]]) {
      assert.equal((await client.call(method, `/api/year-close/-zly${suffix}`, { cookie: boardGlobal, body, expect: 400, invalidRequest: true })).body.error, 'invalid_school_year_id');
      assert.equal((await client.call(method, path(suffix, 'y-brak'), { cookie: boardGlobal, body, expect: 404 })).body.error, 'school_year_not_found', `${method} ${suffix}`);
    }

    // ---------- przed rozpoczęciem ----------
    assert.equal((await client.call('POST', path('/checklist/financial_report'), { cookie: boardA, expect: 409 })).body.error, 'year_close_not_started');
    assert.equal((await client.call('POST', path('/close'), { cookie: boardB, expect: 409 })).body.error, 'year_close_not_started');

    // ---------- rozpoczęcie ----------
    const startPath = path('/start');
    assert.equal((await client.call('POST', startPath, { cookie: boardA, body: { nextSchoolYearId: 'y-brak' }, expect: 404 })).body.error, 'next_school_year_not_found');
    assert.equal((await client.call('POST', startPath, { cookie: boardA, body: { nextSchoolYearId: EARLY }, expect: 409 })).body.error, 'invalid_next_school_year');
    assert.equal((await client.call('POST', startPath, { cookie: boardA, body: { nextSchoolYearId: '-zly' }, expect: 400, invalidRequest: true })).body.error, 'invalid_next_school_year');
    assert.equal((await client.call('POST', startPath, { cookie: boardA, body: '{', expect: 400, invalidRequest: true, headers: { 'Content-Type': 'application/json' } })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', startPath, { cookie: boardA, body: '{}', expect: 415, invalidRequest: true, headers: { 'Content-Type': 'text/plain' } })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', startPath, { cookie: boardA, body: { nextSchoolYearId: NEW, pad: 'x'.repeat(9000) }, expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    await assertRequiredFieldsEnforced(client, boardA, startPath, { nextSchoolYearId: NEW }, 'YearCloseStartRequest');
    const started = (await client.call('POST', startPath, { cookie: boardA, body: { nextSchoolYearId: NEW }, expect: 201 })).body;
    assert.deepEqual([started.status, started.initiatedBy, started.nextSchoolYearId, started.replayed], ['closing', 'u-board-a', NEW, false]);
    const startedAgain = (await client.call('POST', startPath, { cookie: boardB, body: { nextSchoolYearId: NEW }, expect: 200 })).body;
    assert.deepEqual([startedAgain.closureId, startedAgain.initiatedBy, startedAgain.replayed], [started.closureId, 'u-board-a', true]);
    assert.equal((await client.call('POST', startPath, { cookie: boardB, body: { nextSchoolYearId: X1 }, expect: 409 })).body.error, 'year_close_already_started');

    // ---------- lista kontrolna ----------
    const item = (name) => path(`/checklist/${name}`);
    assert.equal((await client.call('POST', item('nieznany_punkt'), { cookie: boardA, body: {}, expect: 404 })).body.error, 'invalid_checklist_item');
    for (const [body, status, code] of [
      [{ note: 'ab' }, 400, 'invalid_note'],
      [{ documentId: 'doc-brak' }, 400, 'invalid_document_id'],
      [{ documentId: '-zly' }, 400, 'invalid_document_id'],
      [{ reportSnapshotId: 'snap-1' }, 400, 'invalid_report_snapshot'],
      [{ note: EMAIL_NOTE }, 422, 'personal_data_forbidden'],
      [{ note: PHONE_NOTE }, 422, 'possible_personal_data'],
    ]) {
      assert.equal((await client.call('POST', item('minutes_approved'), { cookie: treasurer, body, expect: status, invalidRequest: status === 400 })).body.error, code, JSON.stringify(body));
    }
    assert.equal((await client.call('POST', item('financial_report'), { cookie: treasurer, body: { reportSnapshotId: 'snap-brak' }, expect: 400 })).body.error, 'invalid_report_snapshot');
    const first = (await client.call('POST', item('financial_report'), { cookie: treasurer, body: { note: 'Sprawozdanie przyjęte (syntetyczne).' }, expect: 201 })).body;
    assert.deepEqual([first.replayed, first.checklist[0].confirmedBy, first.checklist[0].note], [false, 'u-treasurer', 'Sprawozdanie przyjęte (syntetyczne).']);
    const firstAgain = (await client.call('POST', item('financial_report'), { cookie: boardA, body: { note: 'Inna uwaga (syntetyczna).' }, expect: 200 })).body;
    assert.deepEqual([firstAgain.replayed, firstAgain.checklist[0].note], [true, 'Sprawozdanie przyjęte (syntetyczne).'], 'ponowienie nie nadpisuje uwagi');
    // Bez treści i bez Content-Type (ciało opcjonalne); uwaga z potwierdzonym ostrzeżeniem o danych osobowych.
    await client.call('POST', item('audit_commission_report'), { cookie: boardA, expect: 201 });
    await client.call('POST', item('minutes_approved'), { cookie: treasurer, body: { note: PHONE_NOTE, confirmPersonalData: true }, expect: 201 });
    await client.call('POST', item('resolutions_archived'), { cookie: boardA, body: {}, expect: 201 });
    await client.call('POST', item('reconciliation_confirmed'), { cookie: treasurer, body: {}, expect: 201 });
    const incomplete = await client.call('POST', path('/close'), { cookie: boardB, expect: 409 });
    assert.deepEqual([incomplete.body.error, incomplete.body.missingChecklistItems], ['checklist_incomplete', ['documents_handed_over']]);
    await client.call('POST', item('documents_handed_over'), { cookie: boardA, body: {}, expect: 201 });

    // ---------- zamknięcie: cztery oczy, krok w górę MFA, potwierdzenie rozbieżności ----------
    const closePath = path('/close');
    assert.equal((await client.call('POST', closePath, { cookie: boardA, expect: 409 })).body.error, 'four_eyes_required');
    assert.equal((await client.call('POST', closePath, { cookie: cookies.boardStale, expect: 403 })).body.error, 'mfa_stale');
    assert.equal((await client.call('POST', closePath, { cookie: boardB, body: { confirmYearEndDiscrepancy: { reason: 'inny' } }, expect: 400, invalidRequest: true })).body.error, 'invalid_year_end_confirmation');
    assert.equal((await client.call('POST', closePath, { cookie: boardB, body: '{', expect: 400, invalidRequest: true, headers: { 'Content-Type': 'application/json' } })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', closePath, { cookie: boardB, body: '{}', expect: 415, invalidRequest: true, headers: { 'Content-Type': 'text/plain' } })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', closePath, { cookie: boardB, body: { pad: 'x'.repeat(9000) }, expect: 413, invalidRequest: true })).body.error, 'request_too_large');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_opening_balances WHERE school_year_id = $1', [NEW])).rows[0].n, 0, 'odmowy zamknięcia niczego nie zapisały');
    const closed = (await client.call('POST', closePath, { cookie: boardB, body: {}, expect: 200 })).body;
    assert.deepEqual([closed.status, closed.closedBy, closed.replayed, closed.balance.source], ['closed', 'u-board-b', false, 'closed']);
    assert.ok(closed.expiredGrantCount >= 1 && closed.carriedOpeningBalanceId, 'wygaszone przydziały roku i bilans otwarcia roku następnego');
    // Ponowienie: osoba, której przydział wygasł tym zamknięciem — 409; zarząd bez zakresu roku — ten sam stan.
    assert.equal((await client.call('POST', closePath, { cookie: boardB, expect: 409 })).body.error, 'school_year_closed');
    const closedAgain = (await client.call('POST', closePath, { cookie: boardGlobal, expect: 200 })).body;
    assert.deepEqual([closedAgain.replayed, closedAgain.closureId, closedAgain.closedBy], [true, closed.closureId, 'u-board-b']);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'year_close.closed'")).rows[0].n, 1, 'jedno zdarzenie zamknięcia');
    assert.equal((await client.call('POST', startPath, { cookie: boardGlobal, body: { nextSchoolYearId: NEW }, expect: 409 })).body.error, 'school_year_closed');
    assert.equal((await client.call('POST', item('financial_report'), { cookie: boardGlobal, body: {}, expect: 409 })).body.error, 'school_year_closed');

    // ---------- przekazanie: zarząd roku i nowa Rada (odczyt archiwum) ----------
    const handover = (await client.call('GET', path('/handover'), { cookie: boardGlobal, expect: 200 })).body;
    assert.deepEqual([handover.final, handover.finance.nextYearOpeningBalance.carriedFromClosure, handover.finance.nextYearOpeningBalance.amountCents], [true, true, 145000]);
    const archive = (await client.call('GET', path('/handover'), { cookie: cookies.boardNew, expect: 200 })).body;
    assert.equal(archive.closureId, closed.closureId, 'Rada roku następnego czyta przekazanie zamkniętego roku');

    // ---------- bilans otwarcia roku następnego już istnieje (osobna para lat) ----------
    assert.equal((await client.call('POST', path('/start', X1), { cookie: boardGlobal, body: { nextSchoolYearId: X2 }, expect: 201 })).body.status, 'closing');
    for (const name of ['financial_report', 'audit_commission_report', 'minutes_approved', 'resolutions_archived', 'reconciliation_confirmed', 'documents_handed_over']) {
      await client.call('POST', path(`/checklist/${name}`, X1), { cookie: boardGlobal, body: {}, expect: 201 });
    }
    await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, created_by, idempotency_key)
      VALUES ('ob-x2', $1, 100, 'u-treasurer', 'ob-x2-key-1')`, [X2]);
    assert.equal((await client.call('POST', path('/close', X1), { cookie: cookies.boardGlobal2, expect: 409 })).body.error, 'next_year_opening_balance_exists');

    // ---------- import do zamkniętego roku: trigger zamrożenia przez router → 409 ----------
    await seedPublishedPrivacyNotice(db);
    const closedRows = [['imp-z1', 'Ola', 'Zamknieta', '1A', 'imp-hz', 'Anna Testowa', 'anna.z@example.invalid', '', '']];
    const closedPreview = (await client.call('POST', '/api/import/preview', { cookie: cookies.admin, body: { ...importBody(closedRows), schoolYearId: OLD }, expect: 200 })).body;
    assert.equal(closedPreview.commitAllowed, true, 'podgląd nic nie zapisuje, więc działa także dla zamkniętego roku');
    const closedCommit = await client.call('POST', '/api/import/commit', {
      cookie: cookies.admin, key: key('imp'), expect: 409,
      body: { ...importBody(closedRows), schoolYearId: OLD, fingerprint: closedPreview.fingerprint, planDigest: closedPreview.planDigest },
    });
    assert.equal(closedCommit.body.error, 'school_year_closed');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM students WHERE source_ref = 'imp-z1'")).rows[0].n, 0, 'cała transakcja wycofana');

    assert.equal(networkGuardCalls(), 0, 'żadnej próby połączenia z siecią');
    assertSuccessCoverage(client.validated, ['year-close'], 7);
  } finally {
    await db.close();
  }
});
