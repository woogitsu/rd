// Kontrakt API (#160, etap 12): prawdziwe odpowiedzi modułu `admin` (PGlite, dane syntetyczne `@example.invalid`, imiona
// syntetyczne) walidowane schematami z docs/openapi.json (src/pg/schemas/admin.js) przez tests/helpers/contract-client.js.
// Rejestr pokrycia i katalog kodów sprawdza tests/openapi-contract.test.js (wspólnie dla wszystkich pokrytych modułów).
//
// ŻADNEJ SIECI I ŻADNEJ WYSYŁKI: moduł nie wysyła e-maili (tokeny zaproszeń i resetu wracają wyłącznie w odpowiedzi),
// a globalna pułapka sieci (tests/helpers/network-guard.js) liczy próby połączeń — licznik musi być 0.
//
// Przebieg: granice ról na każdej z 46 operacji (401; 403 dla zarządu, skarbnika, przedstawiciela, Komisji Rewizyjnej
// i dyrekcji; bramka MFA routera; obcy Origin), konta (lista z kursorem, wyłączenie, włączenie, wylogowanie, reset hasła
// i MFA z wnioskiem dla konta chronionego), wnioski o reset (cztery oczy), przydziały ról z audytem i cofnięciem (zakaz
// samonadania, dyrekcja tylko z rokiem, ochrona ostatniego admina), wnioski o rolę chronioną zatwierdzane przez drugą
// osobę (przydział, zaproszenie, ponowne wydanie), zaproszenia i ich ponowne wydanie, partie zaproszeń (podgląd, zapis,
// ponowienie kluczem), lata i klasy, promocja uczniów z kopiowaniem klas i przedłużeniem przydziałów przedstawicieli,
// dziennik zdarzeń i dziennik odczytu z kursorem, przegląd dostępu (dyrekcja bez roku), żądania osób (ponowienie kluczem,
// eksport JSON/CSV, ograniczenie przetwarzania), raport retencji, anonimizacja i stan operacyjny; błędy
// 400/404/409/413/415/422 i pominięcie wymaganych pól ciała.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import {
  createTestDb, networkGuardCalls, request, seedClass, seedSchoolYear, seedUser, seedUserSession,
} from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;

const PREV = 'y-2025';
const YEAR = 'y-2026';
const FUTURE = 'y-2030';
const FOREIGN = 'https://obcy.example.invalid';
const SHA_A = 'a'.repeat(64);

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

// Każda odpowiedź sukcesu opisana w schemacie modułu została zwalidowana na prawdziwej odpowiedzi.
function assertSuccessCoverage(validated) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (entry.module !== 'admin') continue;
    for (const [status, response] of Object.entries(entry.responses)) {
      expected.push(`${routeId} ${status}`);
      for (const type of Object.keys(response.content ?? {})) expected.push(`${routeId} ${status} ${type}`);
    }
  }
  assert.ok(expected.length >= 60, `oczekiwane odpowiedzi: ${expected.length}`);
  assert.deepEqual(expected.filter((item) => !validated.has(item)), [], 'odpowiedzi sukcesu opisane w schemacie bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje błąd i w schemacie, i na serwerze (400; wyjątki — status podany w `statuses`).
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

// Rodzina: dzieci zapisane do wskazanych klas roku i opiekunowie (imiona syntetyczne).
async function family(db, householdId, { schoolYearId, classes, guardians }) {
  await db.query('INSERT INTO households (id) VALUES ($1)', [householdId]);
  const studentIds = [];
  for (const [index, classId] of classes.entries()) {
    const id = `${householdId}-s${index + 1}`;
    studentIds.push(id);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Syntetyczny')", [id, householdId]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, id, classId, schoolYearId]);
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
  await seedSchoolYear(db, PREV, { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, FUTURE, { startsOn: '2030-09-01', endsOn: '2031-08-31' });
  await seedClass(db, { id: 'c25-1a', schoolYearId: PREV, name: '1A' });
  await seedClass(db, { id: 'c25-2a', schoolYearId: PREV, name: '2A' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  await seedClass(db, { id: 'c-2a', schoolYearId: YEAR, name: '2A' });
  const admin = [{ role: 'admin' }];
  const year = (role, extra = {}) => [{ role, schoolYearId: YEAR, ...extra }];
  const cookies = {
    adminA: await seedUserSession(db, { userId: 'u-admin-a', mfa: true, roles: admin }),
    adminB: await seedUserSession(db, { userId: 'u-admin-b', mfa: true, roles: admin }),
    adminC: await seedUserSession(db, { userId: 'u-admin-c', mfa: true, roles: admin }),
    adminStale: await seedUserSession(db, { userId: 'u-admin-stale', mfa: true, roles: admin }),
    adminNoMfa: await seedUserSession(db, { userId: 'u-admin-nomfa', mfa: false, roles: admin }),
    adminFactor: await seedUserSession(db, { userId: 'u-admin-factor', mfa: false, roles: admin }),
    board: await seedUserSession(db, { userId: 'u-board', mfa: true, roles: year('board') }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: year('treasurer') }),
    repA: await seedUserSession(db, { userId: 'u-rep-a', mfa: false, roles: year('representative', { classId: 'c-1a' }) }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: year('audit') }),
    principal: await seedUserSession(db, { userId: 'u-principal', mfa: false, roles: year('principal') }),
  };
  await db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-admin-stale'");
  await addFactor(db, 'u-admin-factor');
  // Konta docelowe: bez roli (z czynnikiem MFA i sesją), z rolą chronioną, wyłączone, adresat przydziałów.
  await seedUserSession(db, { userId: 'u-target', mfa: false });
  await addFactor(db, 'u-target');
  await seedUserSession(db, { userId: 'u-board-target', mfa: true, roles: year('board') });
  await addFactor(db, 'u-board-target');
  await seedUserSession(db, { userId: 'u-board-disabled', mfa: true, roles: year('board'), disabled: true });
  await seedUser(db, { userId: 'u-disabled', disabled: true });
  await seedUser(db, { userId: 'u-grantee' });
  // Przedstawiciel klasy 1A zakończonego roku (przedłużenie przydziału) i dawny przydział dyrekcji bez roku.
  await seedUserSession(db, { userId: 'u-rep-old', mfa: false, roles: [{ role: 'representative', classId: 'c25-1a', schoolYearId: PREV }] });
  await seedUserSession(db, { userId: 'u-legacy-principal', mfa: false, roles: [{ role: 'principal' }] });
  // h1: rodzeństwo w 1A i 1B z dwojgiem opiekunów; h-erase: do anonimizacji; h-p: uczniowie zakończonego roku do promocji.
  await family(db, 'h1', { schoolYearId: YEAR, classes: ['c-1a', 'c-1b'], guardians: [['Zenobia', 'Testowa'], ['Bonifacy', 'Testowy']] });
  await family(db, 'h-erase', { schoolYearId: YEAR, classes: ['c-1a'], guardians: [['Euzebia', 'Usuwana']] });
  await family(db, 'h-p', { schoolYearId: PREV, classes: ['c25-1a', 'c25-2a'], guardians: [['Prokop', 'Promowany']] });
  // Polityka retencji (zatwierdzona przez drugą osobę) do raportu retencji.
  await db.query(
    `INSERT INTO retention_policies (id, data_category, retain_for, decision_ref, approved_by, created_by)
     VALUES ('rp-guardian-contact', 'guardian_contact', interval '5 years', 'uchwała syntetyczna 1/2026', 'u-admin-b', 'u-admin-a')`,
  );
  const env = { db, APP_ENV: 'development', SCRYPT_COST_LOG2: '15' };
  return { db, env, cookies, client: createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) }) };
}

// Przykładowa ścieżka każdej operacji modułu do odmów (obiekt nie musi istnieć: odmowa zapada przed odczytem).
// [metoda, ścieżka, ciało (undefined — trasa bez ciała)]
const DENY_SAMPLES = [
  ['GET', '/api/admin/users'],
  ['POST', '/api/admin/users/u-target/disable'],
  ['POST', '/api/admin/users/u-target/enable'],
  ['POST', '/api/admin/users/u-target/revoke-sessions'],
  ['POST', '/api/admin/users/u-target/password-reset', {}],
  ['POST', '/api/admin/users/u-target/mfa-reset', { confirm: 'u-target' }],
  ['GET', '/api/admin/account-requests'],
  ['POST', '/api/admin/account-requests/r-x/approve'],
  ['POST', '/api/admin/account-requests/r-x/reject'],
  ['GET', '/api/admin/grant-requests'],
  ['POST', '/api/admin/grant-requests/r-x/approve'],
  ['POST', '/api/admin/grant-requests/r-x/reject', {}],
  ['GET', '/api/admin/grants'],
  ['POST', '/api/admin/grants', { userId: 'u-grantee', role: 'audit', schoolYearId: YEAR }],
  ['POST', '/api/admin/grants/g-x/revoke'],
  ['POST', `/api/admin/school-years/${PREV}/expire-grants`, { confirm: PREV }],
  ['GET', '/api/admin/invitations'],
  ['POST', '/api/admin/invitations', { email: 'odmowa@example.invalid', role: 'audit', schoolYearId: YEAR }],
  ['POST', '/api/admin/invitations/i-x/revoke'],
  ['POST', '/api/admin/invitations/i-x/reissue'],
  ['POST', '/api/admin/invitation-batches/preview', { schoolYearId: YEAR, text: '1A; odmowa@example.invalid' }],
  ['POST', '/api/admin/invitation-batches/apply', { schoolYearId: YEAR, text: '1A; odmowa@example.invalid', planDigest: SHA_A }],
  ['GET', '/api/admin/school-years'],
  ['GET', `/api/admin/class-coverage?schoolYearId=${YEAR}`],
  ['POST', '/api/admin/school-years', { id: 'y-odmowa', label: 'Odmowa', startsOn: '2040-09-01', endsOn: '2041-08-31' }],
  ['POST', `/api/admin/school-years/${YEAR}/classes`, { names: ['9Z'] }],
  ['POST', '/api/admin/promotions/classes/preview', { fromSchoolYearId: PREV, toSchoolYearId: YEAR, classMap: { 'c25-1a': '9Z' } }],
  ['POST', '/api/admin/promotions/classes/apply', { fromSchoolYearId: PREV, toSchoolYearId: YEAR, classMap: { 'c25-1a': '9Z' } }],
  ['POST', '/api/admin/promotions/preview', { fromSchoolYearId: PREV, toSchoolYearId: YEAR, classMap: { 'c25-1a': 'c-2a' } }],
  ['POST', '/api/admin/promotions/apply', { fromSchoolYearId: PREV, toSchoolYearId: YEAR, classMap: { 'c25-1a': 'c-2a' }, planDigest: SHA_A }],
  ['POST', '/api/admin/promotions/representatives/preview', { fromSchoolYearId: PREV, toSchoolYearId: YEAR, classMap: { 'c25-1a': 'c-2a' } }],
  ['POST', '/api/admin/promotions/representatives/apply', {
    fromSchoolYearId: PREV, toSchoolYearId: YEAR, classMap: { 'c25-1a': 'c-2a' }, planDigest: SHA_A, confirm: YEAR,
  }],
  ['GET', '/api/admin/audit'],
  ['GET', '/api/admin/access-log'],
  ['GET', `/api/admin/access-review?schoolYearId=${YEAR}`],
  ['GET', '/api/admin/data-requests'],
  ['POST', '/api/admin/data-requests', { kind: 'access', householdId: 'h1', receivedOn: '2026-10-01' }],
  ['POST', '/api/admin/data-requests/d-x/status', { status: 'identity_verified' }],
  ['POST', '/api/admin/data-requests/d-x/export'],
  ['POST', '/api/admin/data-requests/d-x/restrict'],
  ['POST', '/api/admin/data-requests/d-x/lift-restriction'],
  ['GET', '/api/admin/data-requests/d-x/restrictions'],
  ['GET', '/api/admin/retention/preview'],
  ['GET', '/api/admin/anonymizations'],
  ['POST', '/api/admin/anonymizations', { householdId: 'h1', reasonCode: 'retention_policy' }],
  ['GET', '/api/admin/ops-status'],
];

test('specyfikacja administracji: klucz idempotencji, nagłówek ponowienia, ciało opcjonalne i tokeny tylko przy utworzeniu', () => {
  const adminOperations = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item)
    .filter(([, operation]) => operation.tags.includes('admin'))
    .map(([method, operation]) => [`${method.toUpperCase()} ${path}`, operation]));
  assert.equal(adminOperations.length, 46);
  const keyed = adminOperations.filter(([, op]) => op.parameters?.some((p) => p.name === 'Idempotency-Key'))
    .map(([id, op]) => [id, op.parameters.find((p) => p.name === 'Idempotency-Key').required]);
  assert.deepEqual(keyed.sort(), [
    ['POST /api/admin/data-requests', false],
    ['POST /api/admin/invitation-batches/apply', true],
    ['POST /api/admin/promotions/apply', true],
  ]);
  const replayedHeaders = adminOperations.flatMap(([id, op]) => Object.entries(op.responses)
    .filter(([, response]) => response.headers?.['Idempotency-Replayed'])
    .map(([status, response]) => [`${id} ${status}`, response.headers['Idempotency-Replayed'].schema.enum, response.headers['Idempotency-Replayed'].required ?? true]));
  assert.deepEqual(replayedHeaders.sort(), [
    ['POST /api/admin/data-requests 200', ['true'], true],
    ['POST /api/admin/data-requests 201', ['false'], false],
  ]);
  const reject = spec.paths['/api/admin/grant-requests/{requestId}/reject'].post;
  assert.equal(reject.requestBody.required, false, 'odrzucenie wniosku przyjmuje żądanie bez treści');
  assert.equal(spec.paths['/api/admin/grants'].post.requestBody.required, true);
  // Token wyłącznie w odpowiedziach, które go tworzą: listy, wnioski i odtworzenie partii go nie mają.
  for (const name of ['AdminInvitation', 'AdminGrantRequest', 'AdminRecoveryRequest', 'AdminUser', 'AdminGrant']) {
    assert.equal(Object.hasOwn(components[name].properties, 'token'), false, `${name} bez tokenu`);
  }
  assert.equal(Object.hasOwn(components.AdminUser.properties, 'passwordHash'), false);
  const batchReplay = spec.paths['/api/admin/invitation-batches/apply'].post.responses['200'].content['application/json'].schema;
  assert.equal(Object.hasOwn(batchReplay.properties.invitations.items.properties, 'token'), false, 'odtworzenie partii bez tokenów');
  // Kroki w górę MFA: `mfa_stale` w 403 tylko przy trasach wymagających świeżego MFA.
  const stale = adminOperations.filter(([, op]) => op.responses['403']?.['x-rd-error-codes']?.includes('mfa_stale')).map(([id]) => id).sort();
  assert.deepEqual(stale, [
    'POST /api/admin/account-requests/{requestId}/approve', 'POST /api/admin/anonymizations', 'POST /api/admin/data-requests/{requestId}/export',
    'POST /api/admin/grant-requests/{requestId}/approve', 'POST /api/admin/grants', 'POST /api/admin/invitation-batches/apply',
    'POST /api/admin/invitation-batches/preview', 'POST /api/admin/invitations', 'POST /api/admin/invitations/{invitationId}/reissue',
    'POST /api/admin/promotions/representatives/apply', 'POST /api/admin/users/{userId}/mfa-reset', 'POST /api/admin/users/{userId}/password-reset',
  ]);
  assert.deepEqual(DENY_SAMPLES.map(([method, path]) => {
    const { path: template } = createContractClient({ spec, fetch: null }).findOperation(method, path.split('?')[0]);
    return `${method} ${template}`;
  }).sort(), adminOperations.map(([id]) => id).sort(), 'próbki odmów obejmują każdą operację modułu');
});

test('kontrakt modułu admin: prawdziwe odpowiedzi kont, ról, wniosków, zaproszeń, promocji, dzienników i RODO zgodne ze schematami', async () => {
  const { db, env, cookies, client } = await world();
  const { validated } = client;
  const A = cookies.adminA;
  const B = cookies.adminB;
  try {
    // ---------- granice ról na każdej operacji ----------
    for (const [method, path, body] of DENY_SAMPLES) {
      const options = { body, invalidRequest: true };
      assert.equal((await client.call(method, path, { ...options, expect: 401 })).body.error, 'unauthenticated', `${method} ${path}`);
      for (const role of ['board', 'treasurer', 'repA', 'audit', 'principal']) {
        assert.equal((await client.call(method, path, { ...options, cookie: cookies[role], expect: 403 })).body.error, 'forbidden', `${role}: ${method} ${path}`);
      }
      assert.equal((await client.call(method, path, { ...options, cookie: cookies.adminNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required');
      assert.equal((await client.call(method, path, { ...options, cookie: cookies.adminFactor, expect: 403 })).body.error, 'mfa_required');
      if (method === 'POST') {
        assert.equal((await client.call(method, path, { ...options, cookie: A, origin: FOREIGN, expect: 403 })).body.error, 'invalid_origin');
      }
    }
    assert.equal((await db.query("SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-grantee'")).rows[0].n, 0, 'odmowy niczego nie zapisały');

    // ---------- konta ----------
    const allUsers = (await client.call('GET', '/api/admin/users', { cookie: A, expect: 200 })).body;
    assert.equal(allUsers.truncated, false);
    const pagedUsers = [];
    let cursor = null;
    do {
      const page = (await client.call('GET', `/api/admin/users?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: A, expect: 200 })).body;
      pagedUsers.push(...page.users.map((user) => user.id));
      assert.equal(page.truncated, page.nextCursor !== null);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(pagedUsers, allUsers.users.map((user) => user.id), 'strony kursora = jedna strona');
    const targetRow = allUsers.users.find((user) => user.id === 'u-target');
    assert.equal(targetRow.mfaEnrolled, true);
    assert.equal(targetRow.email, 'u-target@example.invalid');
    assert.equal((await client.call('GET', '/api/admin/users?limit=0', { cookie: A, expect: 400 })).body.error, 'invalid_limit');
    assert.equal((await client.call('GET', '/api/admin/users?cursor=zepsuty', { cookie: A, expect: 400 })).body.error, 'invalid_cursor');

    const disabled = (await client.call('POST', '/api/admin/users/u-target/disable', { cookie: A, expect: 200 })).body;
    assert.deepEqual([disabled.disabled, disabled.changed], [true, true]);
    assert.ok(disabled.revokedSessions >= 1, 'wyłączenie wycofuje sesje');
    assert.equal((await client.call('POST', '/api/admin/users/u-target/disable', { cookie: A, expect: 200 })).body.changed, false, 'podwójne kliknięcie');
    assert.equal((await client.call('POST', '/api/admin/users/u-target/enable', { cookie: A, expect: 200 })).body.changed, true);
    assert.equal((await client.call('POST', '/api/admin/users/u-target/enable', { cookie: A, expect: 200 })).body.changed, false);
    assert.equal((await client.call('POST', '/api/admin/users/u-admin-a/disable', { cookie: A, expect: 409 })).body.error, 'cannot_disable_self');
    assert.equal((await client.call('POST', '/api/admin/users/u-brak/disable', { cookie: A, expect: 404 })).body.error, 'user_not_found');
    assert.equal((await client.call('POST', '/api/admin/users/u-brak/enable', { cookie: A, expect: 404 })).body.error, 'user_not_found');
    assert.equal((await client.call('POST', '/api/admin/users/-zly/disable', { cookie: A, expect: 400 })).body.error, 'invalid_id');
    assert.equal((await client.call('POST', '/api/admin/users/%E0%A4%A/enable', { cookie: A, expect: 400 })).body.error, 'invalid_id');
    await seedUserSession(db, { userId: 'u-target', mfa: false });
    assert.equal((await client.call('POST', '/api/admin/users/u-target/revoke-sessions', { cookie: A, expect: 200 })).body.revokedSessions, 1);
    assert.equal((await client.call('POST', '/api/admin/users/u-brak/revoke-sessions', { cookie: A, expect: 404 })).body.error, 'user_not_found');

    // Reset hasła: konto bez roli chronionej — token raz; konto chronione — wniosek (202) bez tokenu.
    const reset = (await client.call('POST', '/api/admin/users/u-target/password-reset', { cookie: A, body: {}, expect: 201 })).body;
    assert.equal(reset.reset.userId, 'u-target');
    const reset3h = (await client.call('POST', '/api/admin/users/u-target/password-reset', { cookie: A, body: { ttlHours: 3 }, expect: 201 })).body;
    assert.notEqual(reset3h.token, reset.token, 'nowy token unieważnia poprzedni');
    const recovery = (await client.call('POST', '/api/admin/users/u-board-target/password-reset', { cookie: A, body: {}, expect: 202 })).body;
    assert.deepEqual([recovery.request.kind, recovery.request.status, recovery.created], ['password_reset', 'pending', true]);
    assert.equal((await client.call('POST', '/api/admin/users/u-board-target/password-reset', { cookie: A, body: {}, expect: 202 })).body.created, false, 'otwarty wniosek');
    assert.equal((await client.call('POST', '/api/admin/users/u-target/password-reset', { cookie: A, body: { ttlHours: 25 }, expect: 400, invalidRequest: true })).body.error, 'invalid_ttl');
    assert.equal((await client.call('POST', '/api/admin/users/u-disabled/password-reset', { cookie: A, body: {}, expect: 409 })).body.error, 'user_disabled');
    assert.equal((await client.call('POST', '/api/admin/users/u-brak/password-reset', { cookie: A, body: {}, expect: 404 })).body.error, 'user_not_found');
    assert.equal((await client.call('POST', '/api/admin/users/u-target/password-reset', { cookie: cookies.adminStale, body: {}, expect: 403 })).body.error, 'mfa_stale');
    assert.equal((await client.call('POST', '/api/admin/users/u-target/password-reset', { cookie: A, body: '{', expect: 400, invalidRequest: true, headers: { 'Content-Type': 'application/json' } })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', '/api/admin/users/u-target/password-reset', { cookie: A, body: '{}', expect: 415, invalidRequest: true, headers: { 'Content-Type': 'text/plain' } })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', '/api/admin/users/u-target/password-reset', { cookie: A, body: { pad: 'x'.repeat(9000) }, expect: 413, invalidRequest: true })).body.error, 'request_too_large');

    // Reset MFA: konto bez roli chronionej — od razu (ponowienie changed: false); chronione — wniosek; własne — 409.
    const mfaReset = (await client.call('POST', '/api/admin/users/u-target/mfa-reset', { cookie: A, body: { confirm: 'u-target' }, expect: 200 })).body;
    assert.deepEqual([mfaReset.changed, mfaReset.disabledFactors], [true, 1]);
    assert.equal((await client.call('POST', '/api/admin/users/u-target/mfa-reset', { cookie: A, body: { confirm: 'u-target' }, expect: 200 })).body.changed, false);
    const mfaRecovery = (await client.call('POST', '/api/admin/users/u-board-target/mfa-reset', { cookie: A, body: { confirm: 'u-board-target' }, expect: 202 })).body;
    assert.equal(mfaRecovery.request.kind, 'mfa_reset');
    assert.equal((await client.call('POST', '/api/admin/users/u-target/mfa-reset', { cookie: A, body: { confirm: 'u-inny' }, expect: 400 })).body.error, 'confirmation_required');
    assert.equal((await client.call('POST', '/api/admin/users/u-admin-a/mfa-reset', { cookie: A, body: { confirm: 'u-admin-a' }, expect: 409 })).body.error, 'cannot_reset_own_mfa');
    assert.equal((await client.call('POST', '/api/admin/users/u-board-disabled/mfa-reset', { cookie: A, body: { confirm: 'u-board-disabled' }, expect: 409 })).body.error, 'user_disabled');
    assert.equal((await client.call('POST', '/api/admin/users/u-brak/mfa-reset', { cookie: A, body: { confirm: 'u-brak' }, expect: 404 })).body.error, 'user_not_found');
    assert.equal((await client.call('POST', '/api/admin/users/u-target/mfa-reset', { cookie: cookies.adminStale, body: { confirm: 'u-target' }, expect: 403 })).body.error, 'mfa_stale');
    await assertRequiredFieldsEnforced(client, A, '/api/admin/users/u-target/mfa-reset', { confirm: 'u-target' }, 'AdminConfirmIdRequest');

    // ---------- wnioski o reset kont chronionych: cztery oczy ----------
    const pendingRecovery = (await client.call('GET', '/api/admin/account-requests', { cookie: A, expect: 200 })).body;
    assert.deepEqual(pendingRecovery.requests.map((item) => item.kind).sort(), ['mfa_reset', 'password_reset']);
    const firstRecovery = (await client.call('GET', '/api/admin/account-requests?limit=1', { cookie: A, expect: 200 })).body;
    assert.equal(firstRecovery.truncated, true);
    const secondRecovery = (await client.call('GET', `/api/admin/account-requests?limit=1&cursor=${encodeURIComponent(firstRecovery.nextCursor)}`, { cookie: A, expect: 200 })).body;
    assert.equal(secondRecovery.nextCursor, null);
    assert.equal((await client.call('GET', `/api/admin/account-requests?status=all&cursor=${encodeURIComponent(firstRecovery.nextCursor)}`, { cookie: A, expect: 400 })).body.error, 'invalid_cursor', 'kursor innego statusu');
    assert.equal((await client.call('GET', '/api/admin/account-requests?status=inny', { cookie: A, expect: 400, invalidRequest: true })).body.error, 'invalid_status');
    const resetRequestId = recovery.request.id;
    assert.equal((await client.call('POST', `/api/admin/account-requests/${resetRequestId}/approve`, { cookie: A, expect: 403 })).body.error, 'recovery_four_eyes_required', 'wnioskodawca nie zatwierdza');
    assert.equal((await client.call('POST', `/api/admin/account-requests/${resetRequestId}/approve`, { cookie: cookies.adminStale, expect: 403 })).body.error, 'mfa_stale');
    const approvedReset = (await client.call('POST', `/api/admin/account-requests/${resetRequestId}/approve`, { cookie: B, expect: 200 })).body;
    assert.deepEqual([approvedReset.request.status, approvedReset.request.decidedBy, approvedReset.reset.userId], ['approved', 'u-admin-b', 'u-board-target']);
    assert.equal((await client.call('POST', `/api/admin/account-requests/${resetRequestId}/approve`, { cookie: B, expect: 409 })).body.error, 'recovery_request_closed', 'podwójne kliknięcie');
    const approvedMfa = (await client.call('POST', `/api/admin/account-requests/${mfaRecovery.request.id}/approve`, { cookie: B, expect: 200 })).body;
    assert.deepEqual([approvedMfa.mfa.userId, approvedMfa.mfa.changed], ['u-board-target', true]);
    assert.equal((await client.call('POST', '/api/admin/account-requests/r-brak/approve', { cookie: B, expect: 404 })).body.error, 'recovery_request_not_found');
    const toReject = (await client.call('POST', '/api/admin/users/u-board-target/password-reset', { cookie: A, body: {}, expect: 202 })).body.request.id;
    assert.equal((await client.call('POST', `/api/admin/account-requests/${toReject}/reject`, { cookie: A, expect: 200 })).body.request.status, 'rejected', 'wnioskodawca może wycofać');
    assert.equal((await client.call('POST', `/api/admin/account-requests/${toReject}/reject`, { cookie: A, expect: 409 })).body.error, 'recovery_request_closed');
    assert.equal((await client.call('POST', '/api/admin/account-requests/r-brak/reject', { cookie: A, expect: 404 })).body.error, 'recovery_request_not_found');

    // ---------- przydziały ról z audytem; zakaz samonadania; dyrekcja tylko z rokiem ----------
    const repGrant = (await client.call('POST', '/api/admin/grants', { cookie: A, body: { userId: 'u-grantee', role: 'representative', classId: 'c-1a' }, expect: 201 })).body;
    assert.deepEqual([repGrant.grant.schoolYearId, repGrant.grant.grantedBy, repGrant.grant.status], [YEAR, 'u-admin-a', 'active'], 'klasa bez roku dziedziczy rok klasy');
    const repGrantAgain = (await client.call('POST', '/api/admin/grants', { cookie: A, body: { userId: 'u-grantee', role: 'representative', classId: 'c-1a' }, expect: 200 })).body;
    assert.equal(repGrantAgain.grant.id, repGrant.grant.id, 'podwójne kliknięcie: ten sam przydział');
    for (const [body, status, code] of [
      [{ userId: 'u-admin-a', role: 'board', schoolYearId: YEAR }, 409, 'cannot_grant_self'],
      [{ userId: 'u-admin-a', role: 'representative', classId: 'c-1a' }, 409, 'cannot_grant_self'],
      [{ userId: 'u-grantee', role: 'principal' }, 422, 'school_year_required'],
      [{ userId: 'u-grantee', role: 'audit', classId: 'c-1a' }, 422, 'class_scope_not_supported'],
      [{ userId: 'u-grantee', role: 'representative' }, 400, 'class_required'],
      [{ userId: 'u-grantee', role: 'representative', classId: 'c-brak' }, 422, 'class_not_found'],
      [{ userId: 'u-grantee', role: 'representative', classId: 'c-1a', schoolYearId: PREV }, 422, 'class_not_in_school_year'],
      [{ userId: 'u-grantee', role: 'audit', schoolYearId: 'y-brak' }, 422, 'school_year_not_found'],
      [{ userId: 'u-grantee', role: 'audit', schoolYearId: YEAR, expiresAt: '2020-01-01T00:00:00.000Z' }, 400, 'invalid_expires_at'],
      [{ userId: 'u-brak', role: 'audit', schoolYearId: YEAR }, 404, 'user_not_found'],
      [{ userId: 'u-disabled', role: 'audit', schoolYearId: YEAR }, 409, 'user_disabled'],
    ]) {
      assert.equal((await client.call('POST', '/api/admin/grants', { cookie: A, body, expect: status })).body.error, code, JSON.stringify(body));
    }
    assert.equal((await client.call('POST', '/api/admin/grants', { cookie: A, body: { userId: 'u-grantee', role: 'superadmin' }, expect: 400, invalidRequest: true })).body.error, 'invalid_role');
    assert.equal((await client.call('POST', '/api/admin/grants', { cookie: A, body: { userId: '-zly', role: 'audit' }, expect: 400, invalidRequest: true })).body.error, 'invalid_user_id');
    assert.equal((await client.call('POST', '/api/admin/grants', { cookie: A, body: { userId: 'u-grantee', role: 'audit', classId: '-zla' }, expect: 400, invalidRequest: true })).body.error, 'invalid_class_id');
    assert.equal((await client.call('POST', '/api/admin/grants', { cookie: cookies.adminStale, body: { userId: 'u-grantee', role: 'audit', schoolYearId: YEAR }, expect: 403 })).body.error, 'mfa_stale');
    await assertRequiredFieldsEnforced(client, A, '/api/admin/grants', { userId: 'u-grantee', role: 'audit' }, 'AdminGrantCreateRequest');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM role_grants WHERE user_id IN ('u-grantee', 'u-admin-a') AND role <> 'admin' AND id <> $1", [repGrant.grant.id])).rows[0].n, 0, 'odmowy bez przydziału');
    const principalGrant = (await client.call('POST', '/api/admin/grants', { cookie: A, body: { userId: 'u-grantee', role: 'principal', schoolYearId: YEAR }, expect: 201 })).body;
    assert.equal(principalGrant.grant.schoolYearId, YEAR, 'dyrekcja z rokiem');
    // Rola chroniona przy drugim administratorze: wniosek (202), bez przydziału; ponowienie zwraca ten sam wniosek.
    const boardRequest = (await client.call('POST', '/api/admin/grants', { cookie: A, body: { userId: 'u-grantee', role: 'board', schoolYearId: YEAR }, expect: 202 })).body;
    assert.deepEqual([boardRequest.request.kind, boardRequest.request.userId, boardRequest.created], ['grant', 'u-grantee', true]);
    assert.equal((await client.call('POST', '/api/admin/grants', { cookie: A, body: { userId: 'u-grantee', role: 'board', schoolYearId: YEAR }, expect: 202 })).body.request.id, boardRequest.request.id);
    // Audyt: zdarzenie nadania z aktorem i identyfikatorem obiektu.
    const accessEvents = (await client.call('GET', '/api/admin/audit?domain=access', { cookie: A, expect: 200 })).body.events;
    const created = accessEvents.find((event) => event.action === 'role_grant.created' && event.entityId === repGrant.grant.id);
    assert.deepEqual([created?.actorId, created?.metadata.userId, created?.domain], ['u-admin-a', 'u-grantee', 'access']);
    // Cofnięcie z audytem; ponowienie bez zmiany; ostatni przydział admina chroniony.
    const revoked = (await client.call('POST', `/api/admin/grants/${repGrant.grant.id}/revoke`, { cookie: A, expect: 200 })).body;
    assert.deepEqual([revoked.changed, revoked.grant.status, revoked.grant.revokedBy], [true, 'revoked', 'u-admin-a']);
    assert.equal((await client.call('POST', `/api/admin/grants/${repGrant.grant.id}/revoke`, { cookie: A, expect: 200 })).body.changed, false);
    const revokeEvents = (await client.call('GET', `/api/admin/audit?domain=access&actorId=u-admin-a&schoolYearId=${YEAR}`, { cookie: A, expect: 200 })).body.events;
    assert.ok(revokeEvents.some((event) => event.action === 'role_grant.revoked' && event.entityId === repGrant.grant.id), 'zdarzenie cofnięcia');
    const ownAdmin = (await client.call('GET', '/api/admin/grants?userId=u-admin-a&role=admin', { cookie: A, expect: 200 })).body.grants;
    assert.equal(ownAdmin.length, 1);
    assert.equal((await client.call('POST', `/api/admin/grants/${ownAdmin[0].id}/revoke`, { cookie: A, expect: 409 })).body.error, 'last_admin_grant');
    assert.equal((await client.call('POST', '/api/admin/grants/g-brak/revoke', { cookie: A, expect: 404 })).body.error, 'grant_not_found');
    // Lista przydziałów z kursorem związanym z filtrem.
    const allGrants = (await client.call('GET', '/api/admin/grants?status=all', { cookie: A, expect: 200 })).body.grants.map((grant) => grant.id);
    const grantPages = [];
    cursor = null;
    do {
      const page = (await client.call('GET', `/api/admin/grants?status=all&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: A, expect: 200 })).body;
      grantPages.push(...page.grants.map((grant) => grant.id));
      cursor = page.nextCursor;
      if (cursor) assert.equal((await client.call('GET', `/api/admin/grants?status=active&cursor=${encodeURIComponent(cursor)}`, { cookie: A, expect: 400 })).body.error, 'invalid_cursor');
    } while (cursor);
    assert.deepEqual(grantPages, allGrants);
    assert.ok((await client.call('GET', `/api/admin/grants?classId=c-1a&schoolYearId=${YEAR}&status=revoked`, { cookie: A, expect: 200 })).body.grants.some((grant) => grant.id === repGrant.grant.id));
    for (const [query, code] of [['role=superadmin', 'invalid_role'], ['status=inny', 'invalid_status'], ['userId=-zly', 'invalid_user_id'],
      ['classId=-zla', 'invalid_class_id'], ['schoolYearId=-zly', 'invalid_school_year_id'], ['limit=501', 'invalid_limit']]) {
      assert.equal((await client.call('GET', `/api/admin/grants?${query}`, { cookie: A, expect: 400, invalidRequest: true })).body.error, code, query);
    }

    // ---------- wnioski o rolę chronioną: zatwierdza druga osoba (nie wnioskodawca, nie adresat) ----------
    const listedRequests = (await client.call('GET', '/api/admin/grant-requests', { cookie: A, expect: 200 })).body;
    assert.deepEqual(listedRequests.requests.map((item) => item.id), [boardRequest.request.id]);
    assert.equal((await client.call('POST', `/api/admin/grant-requests/${boardRequest.request.id}/approve`, { cookie: A, expect: 403 })).body.error, 'grant_four_eyes_required');
    assert.equal((await client.call('POST', `/api/admin/grant-requests/${boardRequest.request.id}/approve`, { cookie: cookies.adminStale, expect: 403 })).body.error, 'mfa_stale');
    const approvedGrant = (await client.call('POST', `/api/admin/grant-requests/${boardRequest.request.id}/approve`, { cookie: B, expect: 200 })).body;
    assert.deepEqual([approvedGrant.request.status, approvedGrant.grant.role, approvedGrant.grant.grantedBy, approvedGrant.created], ['approved', 'board', 'u-admin-b', true]);
    assert.equal(approvedGrant.request.resultId, approvedGrant.grant.id);
    assert.equal((await client.call('POST', `/api/admin/grant-requests/${boardRequest.request.id}/approve`, { cookie: B, expect: 409 })).body.error, 'grant_request_closed', 'podwójne kliknięcie: jeden przydział');
    const forB = (await client.call('POST', '/api/admin/grants', { cookie: A, body: { userId: 'u-admin-b', role: 'treasurer', schoolYearId: YEAR }, expect: 202 })).body.request.id;
    assert.equal((await client.call('POST', `/api/admin/grant-requests/${forB}/approve`, { cookie: B, expect: 403 })).body.error, 'grant_four_eyes_required', 'adresat nie zatwierdza');
    assert.equal((await client.call('POST', `/api/admin/grant-requests/${forB}/approve`, { cookie: cookies.adminC, expect: 200 })).body.grant.userId, 'u-admin-b');
    assert.equal((await client.call('POST', '/api/admin/grant-requests/r-brak/approve', { cookie: B, expect: 404 })).body.error, 'grant_request_not_found');
    // Zaproszenie do roli chronionej: wniosek; zatwierdzenie zwraca token zatwierdzającemu, raz.
    const boardInvite = (await client.call('POST', '/api/admin/invitations', { cookie: A, body: { email: 'zarzad-a@example.invalid', role: 'board', schoolYearId: YEAR }, expect: 202 })).body;
    assert.deepEqual([boardInvite.request.kind, boardInvite.request.email], ['invitation', 'zarzad-a@example.invalid']);
    const boardInvitation = (await client.call('POST', `/api/admin/grant-requests/${boardInvite.request.id}/approve`, { cookie: B, expect: 200 })).body;
    assert.deepEqual([boardInvitation.invitation.role, boardInvitation.invitation.status], ['board', 'pending']);
    const boardReissue = (await client.call('POST', `/api/admin/invitations/${boardInvitation.invitation.id}/reissue`, { cookie: A, expect: 202 })).body;
    assert.equal(boardReissue.request.replacesInvitationId, boardInvitation.invitation.id);
    const reissuedBoard = (await client.call('POST', `/api/admin/grant-requests/${boardReissue.request.id}/approve`, { cookie: B, expect: 200 })).body;
    assert.equal(reissuedBoard.invitation.replacesInvitationId, boardInvitation.invitation.id);
    assert.notEqual(reissuedBoard.token, boardInvitation.token);
    // Odrzucenie z powodem, bramka danych osobowych, bez treści; lista wniosków bez tokenów.
    const rejectable = async (email) => (await client.call('POST', '/api/admin/invitations', { cookie: A, body: { email, role: 'treasurer', schoolYearId: YEAR }, expect: 202 })).body.request.id;
    const r1 = await rejectable('skarbnik-1@example.invalid');
    assert.equal((await client.call('POST', `/api/admin/grant-requests/${r1}/reject`, { cookie: B, body: { reason: 'kontakt: ktos@example.invalid' }, expect: 422 })).body.error, 'personal_data_forbidden');
    const phone = await client.call('POST', `/api/admin/grant-requests/${r1}/reject`, { cookie: B, body: { reason: 'Proszę zadzwonić: 0470 12 34 56' }, expect: 422 });
    assert.equal(phone.body.error, 'possible_personal_data');
    assert.equal((await client.call('POST', `/api/admin/grant-requests/${r1}/reject`, { cookie: B, body: { reason: 'ab' }, expect: 400 })).body.error, 'invalid_reason');
    const rejected = (await client.call('POST', `/api/admin/grant-requests/${r1}/reject`, { cookie: B, body: { reason: 'Brak uchwały zarządu w tej sprawie' }, expect: 200 })).body;
    assert.deepEqual([rejected.request.status, rejected.request.rejectReason], ['rejected', 'Brak uchwały zarządu w tej sprawie']);
    assert.equal((await client.call('POST', `/api/admin/grant-requests/${r1}/reject`, { cookie: B, expect: 409 })).body.error, 'grant_request_closed');
    const r2 = await rejectable('skarbnik-2@example.invalid');
    assert.equal((await client.call('POST', `/api/admin/grant-requests/${r2}/reject`, { cookie: A, expect: 200 })).body.request.rejectReason, null, 'bez treści — bez powodu');
    assert.equal((await client.call('POST', '/api/admin/grant-requests/r-brak/reject', { cookie: A, expect: 404 })).body.error, 'grant_request_not_found');
    const allRequestsText = JSON.stringify((await client.call('GET', '/api/admin/grant-requests?status=all&limit=200', { cookie: A, expect: 200 })).body);
    assert.ok(!allRequestsText.includes(boardInvitation.token) && !allRequestsText.includes(reissuedBoard.token), 'lista wniosków bez tokenów');
    const firstRequests = (await client.call('GET', '/api/admin/grant-requests?status=all&limit=2', { cookie: A, expect: 200 })).body;
    const nextRequests = (await client.call('GET', `/api/admin/grant-requests?status=all&cursor=${encodeURIComponent(firstRequests.nextCursor)}`, { cookie: A, expect: 200 })).body;
    assert.ok(nextRequests.requests.length > 0 && !nextRequests.requests.some((item) => firstRequests.requests.some((seen) => seen.id === item.id)), 'druga strona bez powtórzeń');
    assert.equal((await client.call('GET', '/api/admin/grant-requests?status=inny', { cookie: A, expect: 400, invalidRequest: true })).body.error, 'invalid_status');

    // ---------- zaproszenia i ich ponowne wydanie ----------
    const repInvite = (await client.call('POST', '/api/admin/invitations', { cookie: A, body: { email: 'Rep-1A@Example.invalid', role: 'representative', classId: 'c-1a' }, expect: 201 })).body;
    assert.deepEqual([repInvite.invitation.email, repInvite.invitation.schoolYearId], ['rep-1a@example.invalid', YEAR]);
    assert.equal((await client.call('POST', '/api/admin/invitations', { cookie: A, body: { email: 'rep-1a@example.invalid', role: 'representative', classId: 'c-1a' }, expect: 409 })).body.error, 'invitation_pending', 'token nie wraca drugi raz');
    const principalInvite = (await client.call('POST', '/api/admin/invitations', { cookie: A, body: { email: 'dyrekcja@example.invalid', role: 'principal', schoolYearId: YEAR, ttlHours: 48 }, expect: 201 })).body;
    assert.equal(principalInvite.invitation.schoolYearId, YEAR);
    for (const [body, status, code] of [
      [{ email: 'u-admin-a@example.invalid', role: 'audit', schoolYearId: YEAR }, 409, 'cannot_grant_self'],
      [{ email: 'dyrekcja-2@example.invalid', role: 'principal' }, 422, 'school_year_required'],
      [{ email: 'nie-adres', role: 'audit', schoolYearId: YEAR }, 400, 'invalid_email'],
      [{ email: 'kr@example.invalid', role: 'audit', classId: 'c-1a' }, 422, 'class_scope_not_supported'],
      [{ email: 'rep@example.invalid', role: 'representative' }, 400, 'class_required'],
      [{ email: 'rep@example.invalid', role: 'representative', classId: 'c-brak' }, 422, 'class_not_found'],
    ]) {
      assert.equal((await client.call('POST', '/api/admin/invitations', { cookie: A, body, expect: status })).body.error, code, JSON.stringify(body));
    }
    assert.equal((await client.call('POST', '/api/admin/invitations', { cookie: A, body: { email: 'kr@example.invalid', role: 'audit', ttlHours: 0 }, expect: 400, invalidRequest: true })).body.error, 'invalid_ttl');
    assert.equal((await client.call('POST', '/api/admin/invitations', { cookie: A, body: { email: 'kr@example.invalid', role: 'superadmin' }, expect: 400, invalidRequest: true })).body.error, 'invalid_role');
    assert.equal((await client.call('POST', '/api/admin/invitations', { cookie: cookies.adminStale, body: { email: 'kr@example.invalid', role: 'audit', schoolYearId: YEAR }, expect: 403 })).body.error, 'mfa_stale');
    await assertRequiredFieldsEnforced(client, A, '/api/admin/invitations', { email: 'kr-2@example.invalid', role: 'audit' }, 'AdminInvitationCreateRequest');
    const reissued = (await client.call('POST', `/api/admin/invitations/${repInvite.invitation.id}/reissue`, { cookie: A, expect: 201 })).body;
    assert.deepEqual([reissued.invitation.replacesInvitationId, reissued.invitation.classId], [repInvite.invitation.id, 'c-1a']);
    assert.equal((await client.call('POST', `/api/admin/invitations/${repInvite.invitation.id}/reissue`, { cookie: A, expect: 409 })).body.error, 'invitation_not_pending');
    assert.equal((await client.call('POST', '/api/admin/invitations/i-brak/reissue', { cookie: A, expect: 404 })).body.error, 'invitation_not_found');
    assert.equal((await client.call('POST', `/api/admin/invitations/${principalInvite.invitation.id}/reissue`, { cookie: cookies.adminStale, expect: 403 })).body.error, 'mfa_stale');
    // Dawne zaproszenie dyrekcji bez roku (sprzed wymogu) nie jest wydawane ponownie bez roku.
    await db.query(
      `INSERT INTO invitations (id, email, token_hash, role, created_by, expires_at)
       VALUES ('inv-legacy-principal', 'dyrekcja-dawna@example.invalid', $1, 'principal', 'u-admin-b', now() + interval '1 day')`,
      ['f'.repeat(64)],
    );
    assert.equal((await client.call('POST', '/api/admin/invitations/inv-legacy-principal/reissue', { cookie: A, expect: 422 })).body.error, 'school_year_required');
    // Wycofanie: ponowienie bez zmiany, przyjęte zaproszenie — 409.
    assert.equal((await client.call('POST', `/api/admin/invitations/${reissued.invitation.id}/revoke`, { cookie: A, expect: 200 })).body.changed, true);
    assert.equal((await client.call('POST', `/api/admin/invitations/${reissued.invitation.id}/revoke`, { cookie: A, expect: 200 })).body.changed, false);
    assert.equal((await client.call('POST', '/api/admin/invitations/i-brak/revoke', { cookie: A, expect: 404 })).body.error, 'invitation_not_found');
    const toAccept = (await client.call('POST', '/api/admin/invitations', { cookie: A, body: { email: 'przyjmie@example.invalid', role: 'representative', classId: 'c-1b' }, expect: 201 })).body;
    const accepted = await handlePgRequest(request('/api/invitations/accept', {
      method: 'POST', body: { token: toAccept.token, password: 'Syntetyczne haslo przyjecia 2026', passwordRepeat: 'Syntetyczne haslo przyjecia 2026' }, headers: { 'x-rd-client-ip': '203.0.113.7' },
    }), env);
    assert.ok([200, 201].includes(accepted.status), `przyjęcie zaproszenia: ${accepted.status} ${await accepted.clone().text()}`);
    assert.equal((await client.call('POST', `/api/admin/invitations/${toAccept.invitation.id}/revoke`, { cookie: A, expect: 409 })).body.error, 'invitation_already_accepted');
    const invitationList = (await client.call('GET', '/api/admin/invitations', { cookie: A, expect: 200 })).body;
    assert.ok(!JSON.stringify(invitationList).includes(toAccept.token) && !JSON.stringify(invitationList).includes(reissued.token), 'lista zaproszeń bez tokenów');
    assert.ok(invitationList.invitations.some((item) => item.id === toAccept.invitation.id && item.status === 'accepted'));
    const invitationPages = [];
    cursor = null;
    do {
      const page = (await client.call('GET', `/api/admin/invitations?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: A, expect: 200 })).body;
      invitationPages.push(...page.invitations.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(invitationPages, invitationList.invitations.map((item) => item.id));
    assert.equal((await client.call('GET', '/api/admin/invitations?cursor=zepsuty', { cookie: A, expect: 400 })).body.error, 'invalid_cursor');

    // ---------- partie zaproszeń przedstawicieli: podgląd, zapis, ponowienie kluczem ----------
    const batchPath = '/api/admin/invitation-batches';
    const batchText = 'klasa; e-mail\n1A; partia-1@example.invalid\n# komentarz\n1B; partia-2@example.invalid';
    const batchPreview = (await client.call('POST', `${batchPath}/preview`, { cookie: A, body: { schoolYearId: YEAR, text: batchText }, expect: 200 })).body;
    assert.deepEqual([batchPreview.counts, batchPreview.rows.map((row) => row.row)], [{ total: 2, valid: 2, invalid: 0 }, [2, 4]]);
    const batchKey = key('batch');
    const batchBody = { schoolYearId: YEAR, text: batchText, planDigest: batchPreview.planDigest };
    const batch = (await client.call('POST', `${batchPath}/apply`, { cookie: A, key: batchKey, body: batchBody, expect: 201 })).body;
    assert.deepEqual([batch.batchId, batch.replayed, batch.invitations.length], [batchKey, false, 2]);
    assert.notEqual(batch.invitations[0].token, batch.invitations[1].token, 'osobne zaproszenie i token na wiersz');
    const batchReplay = await client.call('POST', `${batchPath}/apply`, { cookie: A, key: batchKey, body: batchBody, expect: 200 });
    assert.deepEqual(batchReplay.body.invitations.map((item) => item.id), batch.invitations.map((item) => item.id), 'ponowienie: te same zaproszenia');
    assert.ok(!JSON.stringify(batchReplay.body).includes(batch.invitations[0].token), 'odtworzenie bez tokenów');
    assert.equal((await client.call('POST', `${batchPath}/apply`, { cookie: A, key: batchKey, body: { ...batchBody, planDigest: SHA_A }, expect: 409 })).body.error, 'idempotency_key_reused');
    assert.equal((await client.call('POST', `${batchPath}/apply`, { cookie: A, key: key('batch'), body: batchBody, expect: 409 })).body.error, 'invitation_batch_stale', 'adresy mają już oczekujące zaproszenia');
    const badText = ['zly wiersz', '1A; nie-adres', '9Z; ktos@example.invalid', '1A; dubel@example.invalid', '1A; dubel@example.invalid',
      '1A; u-admin-a@example.invalid', '1A; u-rep-a@example.invalid', '1B; przyjmie@example.invalid', '1A; partia-1@example.invalid'].join('\n');
    const badPreview = (await client.call('POST', `${batchPath}/preview`, { cookie: A, body: { schoolYearId: YEAR, text: badText }, expect: 200 })).body;
    assert.deepEqual(badPreview.rows.map((row) => row.error), [
      'invalid_row_format', 'invalid_email', 'class_not_found', null, 'duplicate_row', 'cannot_grant_self', 'representative_already_assigned',
      'representative_already_assigned', 'invitation_pending',
    ]);
    assert.equal((await client.call('POST', `${batchPath}/apply`, { cookie: A, key: key('batch'), body: { schoolYearId: YEAR, text: badText, planDigest: badPreview.planDigest }, expect: 422 })).body.error, 'invitation_batch_invalid');
    for (const [body, status, code] of [
      [{ schoolYearId: YEAR, text: '# tylko komentarz' }, 422, 'invitation_batch_empty'],
      [{ schoolYearId: YEAR, text: Array.from({ length: 101 }, (_, index) => `1A; wiersz-${index}@example.invalid`).join('\n') }, 400, 'too_many_rows'],
      [{ schoolYearId: 'y-brak', text: batchText }, 404, 'school_year_not_found'],
    ]) {
      assert.equal((await client.call('POST', `${batchPath}/preview`, { cookie: A, body, expect: status })).body.error, code);
    }
    for (const [body, code] of [[{ schoolYearId: '-zly', text: batchText }, 'invalid_school_year_id'], [{ schoolYearId: YEAR, text: 5 }, 'invalid_invitation_batch_text'],
      [{ schoolYearId: YEAR, text: batchText, ttlHours: 0 }, 'invalid_ttl']]) {
      assert.equal((await client.call('POST', `${batchPath}/preview`, { cookie: A, body, expect: 400, invalidRequest: true })).body.error, code);
    }
    assert.equal((await client.call('POST', `${batchPath}/apply`, { cookie: A, key: key('batch'), body: { ...batchBody, planDigest: 'x' }, expect: 400, invalidRequest: true })).body.error, 'invalid_plan_digest');
    assert.equal((await client.call('POST', `${batchPath}/apply`, { cookie: A, body: batchBody, expect: 400 })).body.error, 'invalid_idempotency_key');
    assert.equal((await client.call('POST', `${batchPath}/preview`, { cookie: cookies.adminStale, body: { schoolYearId: YEAR, text: batchText }, expect: 403 })).body.error, 'mfa_stale');
    await assertRequiredFieldsEnforced(client, A, `${batchPath}/preview`, { schoolYearId: YEAR, text: batchText }, 'AdminInvitationBatchPreviewRequest');
    await assertRequiredFieldsEnforced(client, A, `${batchPath}/apply`, batchBody, 'AdminInvitationBatchApplyRequest', { withKey: true });

    // ---------- lata szkolne i klasy ----------
    const years = (await client.call('GET', '/api/admin/school-years', { cookie: A, expect: 200 })).body.schoolYears;
    assert.deepEqual(years.map((item) => [item.id, item.finished]), [[FUTURE, false], [YEAR, false], [PREV, true]]);
    const yearBody = { id: 'y-2031', label: 'Rok syntetyczny 2031/2032', startsOn: '2031-09-01', endsOn: '2032-08-31' };
    assert.deepEqual((await client.call('POST', '/api/admin/school-years', { cookie: A, body: yearBody, expect: 201 })).body.schoolYear, yearBody);
    assert.equal((await client.call('POST', '/api/admin/school-years', { cookie: A, body: yearBody, expect: 409 })).body.error, 'school_year_exists');
    for (const [patch, code] of [[{ id: '-zly' }, 'invalid_id'], [{ label: '' }, 'invalid_label'], [{ startsOn: '2031-02-30' }, 'invalid_date'],
      [{ id: 'y-2032', label: 'Rok odwrócony', endsOn: '2031-01-01' }, 'invalid_date_range']]) {
      assert.equal((await client.call('POST', '/api/admin/school-years', { cookie: A, body: { ...yearBody, ...patch }, expect: 400, invalidRequest: true })).body.error, code);
    }
    await assertRequiredFieldsEnforced(client, A, '/api/admin/school-years', { ...yearBody, id: 'y-2033', label: 'Rok syntetyczny 2033' }, 'AdminSchoolYearCreateRequest');
    const newClasses = (await client.call('POST', '/api/admin/school-years/y-2031/classes', { cookie: A, body: { names: ['1A', '1B'] }, expect: 201 })).body.classes;
    assert.deepEqual(newClasses.map((item) => [item.name, item.schoolYearId]), [['1A', 'y-2031'], ['1B', 'y-2031']]);
    assert.equal((await client.call('POST', '/api/admin/school-years/y-2031/classes', { cookie: A, body: { names: ['1a'] }, expect: 409 })).body.error, 'class_exists');
    assert.equal((await client.call('POST', '/api/admin/school-years/y-2031/classes', { cookie: A, body: { names: ['2A', '2a'] }, expect: 400 })).body.error, 'duplicate_name');
    assert.equal((await client.call('POST', '/api/admin/school-years/y-2031/classes', { cookie: A, body: { names: [] }, expect: 400, invalidRequest: true })).body.error, 'invalid_names');
    assert.equal((await client.call('POST', '/api/admin/school-years/y-brak/classes', { cookie: A, body: { names: ['1A'] }, expect: 404 })).body.error, 'school_year_not_found');
    assert.equal((await client.call('POST', '/api/admin/school-years/-zly/classes', { cookie: A, body: { names: ['1A'] }, expect: 400 })).body.error, 'invalid_id');
    await assertRequiredFieldsEnforced(client, A, '/api/admin/school-years/y-2031/classes', { names: ['3A'] }, 'AdminClassesCreateRequest');

    // ---------- promocja: kopiowanie klas, uczniowie (klucz idempotencji), przedłużenie przydziałów przedstawicieli ----------
    const promo = '/api/admin/promotions';
    const copyBody = { fromSchoolYearId: PREV, toSchoolYearId: YEAR, classMap: { 'c25-1a': '3A', 'c25-2a': null } };
    assert.deepEqual((await client.call('POST', `${promo}/classes/preview`, { cookie: A, body: copyBody, expect: 200 })).body.classes.map((item) => item.action), ['create', 'final']);
    const copied = (await client.call('POST', `${promo}/classes/apply`, { cookie: A, body: copyBody, expect: 201 })).body;
    assert.deepEqual([copied.createdCount, copied.classes[0].action], [1, 'created']);
    const copiedAgain = (await client.call('POST', `${promo}/classes/apply`, { cookie: A, body: copyBody, expect: 200 })).body;
    assert.deepEqual([copiedAgain.createdCount, copiedAgain.classes[0].action, copiedAgain.classes[0].toClassId], [0, 'exists', copied.classes[0].toClassId], 'ponowienie bez nowej klasy');
    for (const [body, status, code] of [
      [{ ...copyBody, toSchoolYearId: PREV }, 422, 'same_school_year'],
      [{ ...copyBody, classMap: {} }, 422, 'class_map_required'],
      [{ ...copyBody, classMap: { '-zla': '1A' } }, 400, 'invalid_class_map'],
      [{ ...copyBody, classMap: { 'c-1a': '1A' } }, 422, 'unknown_source_class'],
      [{ ...copyBody, fromSchoolYearId: 'y-brak' }, 404, 'school_year_not_found'],
      [{ fromSchoolYearId: YEAR, toSchoolYearId: PREV, classMap: { 'c-1a': '1A' } }, 422, 'invalid_year_order'],
      [{ ...copyBody, classMap: { 'c25-1a': '4A', 'c25-2a': '4a' } }, 400, 'duplicate_name'],
    ]) {
      assert.equal((await client.call('POST', `${promo}/classes/preview`, { cookie: A, body, expect: status })).body.error, code, JSON.stringify(body));
    }
    assert.equal((await client.call('POST', `${promo}/classes/preview`, { cookie: A, body: { ...copyBody, fromSchoolYearId: '-zly' }, expect: 400, invalidRequest: true })).body.error, 'invalid_school_year_id');
    await assertRequiredFieldsEnforced(client, A, `${promo}/classes/preview`, copyBody, 'AdminPromotionClassesRequest', { statuses: { classMap: 422 } });

    const promotionBody = { fromSchoolYearId: PREV, toSchoolYearId: YEAR, classMap: { 'c25-1a': 'c-2a', 'c25-2a': null } };
    const plan = (await client.call('POST', `${promo}/preview`, { cookie: A, body: promotionBody, expect: 200 })).body;
    assert.deepEqual([plan.counts.promote, plan.counts.graduating, plan.missingRepresentative.map((item) => item.classId)], [1, 1, ['c-2a']]);
    const promotionKey = key('promo');
    const promoted = (await client.call('POST', `${promo}/apply`, { cookie: A, key: promotionKey, body: { ...promotionBody, planDigest: plan.planDigest }, expect: 201 })).body;
    assert.deepEqual([promoted.replayed, promoted.counts.promote], [false, 1]);
    const promotedAgain = (await client.call('POST', `${promo}/apply`, { cookie: A, key: promotionKey, body: { ...promotionBody, planDigest: plan.planDigest }, expect: 200 })).body;
    assert.deepEqual([promotedAgain.replayed, promotedAgain.runId], [true, promoted.runId], 'ponowienie kluczem: bez nowych przypisań');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM enrollments WHERE school_year_id = $1 AND student_id = 'h-p-s1'", [YEAR])).rows[0].n, 1);
    assert.equal((await client.call('POST', `${promo}/apply`, { cookie: A, key: promotionKey, body: { ...promotionBody, planDigest: SHA_A }, expect: 409 })).body.error, 'idempotency_key_reused');
    assert.equal((await client.call('POST', `${promo}/apply`, { cookie: A, key: key('promo'), body: { ...promotionBody, planDigest: plan.planDigest }, expect: 409 })).body.error, 'plan_stale');
    const afterPlan = (await client.call('POST', `${promo}/preview`, { cookie: A, body: promotionBody, expect: 200 })).body;
    assert.equal(afterPlan.counts.conflict, 1, 'uczeń już przypisany w roku docelowym');
    assert.equal((await client.call('POST', `${promo}/apply`, { cookie: A, key: key('promo'), body: { ...promotionBody, planDigest: afterPlan.planDigest }, expect: 422 })).body.error, 'nothing_to_promote');
    assert.equal((await client.call('POST', `${promo}/preview`, { cookie: A, body: { ...promotionBody, classMap: { 'c25-1a': 'c-brak' } }, expect: 422 })).body.error, 'unknown_target_class');
    assert.equal((await client.call('POST', `${promo}/preview`, { cookie: A, body: { ...promotionBody, exclusions: ['s-brak'] }, expect: 422 })).body.error, 'unknown_student');
    assert.equal((await client.call('POST', `${promo}/preview`, { cookie: A, body: { ...promotionBody, exclusions: 'h-p-s1' }, expect: 400, invalidRequest: true })).body.error, 'invalid_exclusions');
    assert.equal((await client.call('POST', `${promo}/preview`, { cookie: A, body: { ...promotionBody, overrides: { 'h-p-s1': '-zla' } }, expect: 400, invalidRequest: true })).body.error, 'invalid_overrides');
    assert.equal((await client.call('POST', `${promo}/apply`, { cookie: A, key: key('promo'), body: { ...promotionBody, planDigest: 'x' }, expect: 400, invalidRequest: true })).body.error, 'invalid_plan_digest');
    assert.equal((await client.call('POST', `${promo}/apply`, { cookie: A, body: { ...promotionBody, planDigest: plan.planDigest }, expect: 400 })).body.error, 'invalid_idempotency_key');
    await assertRequiredFieldsEnforced(client, A, `${promo}/preview`, promotionBody, 'AdminPromotionRequest', { statuses: { classMap: 422 } });
    await assertRequiredFieldsEnforced(client, A, `${promo}/apply`, { ...promotionBody, planDigest: plan.planDigest }, 'AdminPromotionApplyRequest', { withKey: true, statuses: { classMap: 422 } });

    const repsBody = { fromSchoolYearId: PREV, toSchoolYearId: YEAR, classMap: { 'c25-1a': 'c-2a' } };
    const repsPlan = (await client.call('POST', `${promo}/representatives/preview`, { cookie: A, body: repsBody, expect: 200 })).body;
    assert.deepEqual(repsPlan.proposals, [{ userId: 'u-rep-old', fromClassId: 'c25-1a', toClassId: 'c-2a', status: 'propose' }]);
    const repsApply = { ...repsBody, planDigest: repsPlan.planDigest, confirm: YEAR };
    assert.equal((await client.call('POST', `${promo}/representatives/apply`, { cookie: cookies.adminStale, body: repsApply, expect: 403 })).body.error, 'mfa_stale');
    assert.equal((await client.call('POST', `${promo}/representatives/apply`, { cookie: A, body: { ...repsApply, confirm: PREV }, expect: 400 })).body.error, 'confirmation_required');
    assert.equal((await client.call('POST', `${promo}/representatives/apply`, { cookie: A, body: { ...repsApply, planDigest: SHA_A }, expect: 409 })).body.error, 'plan_stale');
    const extended = (await client.call('POST', `${promo}/representatives/apply`, { cookie: A, body: repsApply, expect: 201 })).body;
    assert.deepEqual([extended.created, extended.alreadyGranted, extended.replayed], [1, 0, false]);
    const extendedAgain = (await client.call('POST', `${promo}/representatives/apply`, { cookie: A, body: repsApply, expect: 200 })).body;
    assert.deepEqual([extendedAgain.created, extendedAgain.alreadyGranted, extendedAgain.replayed], [0, 1, true], 'powtórzenie bez nowego przydziału');
    const emptyPlan = (await client.call('POST', `${promo}/representatives/preview`, { cookie: A, body: { ...repsBody, classMap: { 'c25-2a': 'c-1b' } }, expect: 200 })).body;
    assert.equal((await client.call('POST', `${promo}/representatives/apply`, { cookie: A, body: { ...repsBody, classMap: { 'c25-2a': 'c-1b' }, planDigest: emptyPlan.planDigest, confirm: YEAR }, expect: 422 })).body.error, 'nothing_to_extend');
    assert.equal((await client.call('POST', `${promo}/representatives/preview`, { cookie: A, body: { ...repsBody, classMap: { 'c25-1a': 'c-brak' } }, expect: 422 })).body.error, 'unknown_target_class');
    await assertRequiredFieldsEnforced(client, A, `${promo}/representatives/apply`, repsApply, 'AdminRepresentativesApplyRequest', { statuses: { classMap: 422 } });
    const coverage = (await client.call('GET', `/api/admin/class-coverage?schoolYearId=${YEAR}`, { cookie: A, expect: 200 })).body;
    assert.deepEqual(coverage.classes.filter((item) => ['c-1a', 'c-2a'].includes(item.id)).map((item) => [item.id, item.activeRepresentativeCount]), [['c-1a', 1], ['c-2a', 1]]);
    assert.ok(coverage.classes.find((item) => item.id === 'c-1a').pendingInvitationCount >= 1, 'oczekujące zaproszenie partii');
    assert.equal((await client.call('GET', '/api/admin/class-coverage', { cookie: A, expect: 400 })).body.error, 'invalid_school_year_id');
    assert.equal((await client.call('GET', '/api/admin/class-coverage?schoolYearId=y-brak', { cookie: A, expect: 404 })).body.error, 'school_year_not_found');

    // ---------- żądania osób (RODO): ponowienie kluczem, przejścia stanu, eksport, ograniczenie przetwarzania ----------
    const dsr = '/api/admin/data-requests';
    const accessKey = key('dsr');
    const accessBody = { kind: 'access', householdId: 'h1', receivedOn: '2026-10-01', dueOn: '2026-10-31' };
    const accessCreated = await client.call('POST', dsr, { cookie: A, key: accessKey, body: accessBody, expect: 201 });
    assert.equal(accessCreated.headers.get('Idempotency-Replayed'), 'false');
    const accessId = accessCreated.body.request.id;
    const accessReplay = await client.call('POST', dsr, { cookie: A, key: accessKey, body: accessBody, expect: 200 });
    assert.deepEqual([accessReplay.headers.get('Idempotency-Replayed'), accessReplay.body.request.id], ['true', accessId]);
    assert.equal((await client.call('POST', dsr, { cookie: A, key: accessKey, body: { ...accessBody, receivedOn: '2026-10-02' }, expect: 409 })).body.error, 'idempotency_conflict');
    const createRequest = async (body) => {
      const response = await client.call('POST', dsr, { cookie: A, body: { receivedOn: '2026-10-01', ...body }, expect: 201 });
      assert.equal(response.headers.get('Idempotency-Replayed'), null, 'bez klucza — bez nagłówka');
      return response.body.request.id;
    };
    const setStatus = async (id, status) => (await client.call('POST', `${dsr}/${id}/status`, { cookie: A, body: { status }, expect: 200 })).body;
    for (const [body, status, code] of [
      [{ kind: 'access', receivedOn: '2026-10-01' }, 400, 'subject_required'],
      [{ kind: 'access', householdId: 'h-brak', receivedOn: '2026-10-01' }, 404, 'household_not_found'],
      [{ kind: 'access', guardianId: 'g-brak', receivedOn: '2026-10-01' }, 404, 'guardian_not_found'],
      [{ kind: 'access', studentId: 's-brak', receivedOn: '2026-10-01' }, 404, 'student_not_found'],
    ]) {
      assert.equal((await client.call('POST', dsr, { cookie: A, body, expect: status })).body.error, code);
    }
    for (const [patch, code] of [[{ kind: 'inna' }, 'invalid_kind'], [{ householdId: '-zly' }, 'invalid_household_id'], [{ guardianId: '-zly' }, 'invalid_guardian_id'],
      [{ studentId: '-zly' }, 'invalid_student_id'], [{ receivedOn: '2026-02-30' }, 'invalid_received_on'], [{ dueOn: 'jutro' }, 'invalid_due_on']]) {
      assert.equal((await client.call('POST', dsr, { cookie: A, body: { ...accessBody, ...patch }, expect: 400, invalidRequest: true })).body.error, code);
    }
    assert.equal((await client.call('POST', dsr, { cookie: A, key: 'krotki', body: accessBody, expect: 400, invalidRequest: true })).body.error, 'invalid_idempotency_key');
    await assertRequiredFieldsEnforced(client, A, dsr, accessBody, 'AdminDataRequestCreateRequest');
    // Przejścia stanu tylko do przodu; eksport po weryfikacji tożsamości.
    assert.equal((await client.call('POST', `${dsr}/${accessId}/export`, { cookie: A, expect: 409 })).body.error, 'data_request_identity_not_verified');
    assert.equal((await setStatus(accessId, 'identity_verified')).changed, true);
    assert.equal((await setStatus(accessId, 'identity_verified')).changed, false, 'podwójne kliknięcie');
    assert.equal((await client.call('POST', `${dsr}/${accessId}/status`, { cookie: A, body: { status: 'received' }, expect: 409 })).body.error, 'data_request_status_cannot_go_back');
    assert.equal((await client.call('POST', `${dsr}/${accessId}/status`, { cookie: A, body: { status: 'inny' }, expect: 400, invalidRequest: true })).body.error, 'invalid_status');
    assert.equal((await client.call('POST', `${dsr}/${accessId}/status`, { cookie: A, body: { status: 'in_progress', decisionNoteRef: 'x'.repeat(201) }, expect: 400, invalidRequest: true })).body.error, 'invalid_decision_note_ref');
    assert.equal((await client.call('POST', `${dsr}/d-brak/status`, { cookie: A, body: { status: 'in_progress' }, expect: 404 })).body.error, 'data_request_not_found');
    await assertRequiredFieldsEnforced(client, A, `${dsr}/${accessId}/status`, { status: 'in_progress' }, 'AdminDataRequestStatusRequest');
    const exportJson = await client.call('POST', `${dsr}/${accessId}/export`, { cookie: A, expect: 200 });
    assert.equal(exportJson.headers.get('X-Export-Manifest-Sha256'), exportJson.body.sha256);
    assert.deepEqual([exportJson.body.subject, exportJson.body.request.id], [{ type: 'household', id: 'h1' }, accessId]);
    const exportCsv = await client.call('POST', `${dsr}/${accessId}/export?format=csv`, { cookie: A, expect: 200 });
    assert.ok(exportCsv.bytes.length > 0);
    assert.equal((await client.call('POST', `${dsr}/${accessId}/export?format=xml`, { cookie: A, expect: 400, invalidRequest: true })).body.error, 'invalid_format');
    assert.equal((await client.call('POST', `${dsr}/${accessId}/export`, { cookie: cookies.adminStale, expect: 403 })).body.error, 'mfa_stale');
    assert.equal((await client.call('POST', `${dsr}/d-brak/export`, { cookie: A, expect: 404 })).body.error, 'data_request_not_found');
    const answeredAccess = await createRequest({ kind: 'access', studentId: 'h1-s1' });
    await setStatus(answeredAccess, 'answered');
    assert.equal((await client.call('POST', `${dsr}/${answeredAccess}/export`, { cookie: A, expect: 409 })).body.error, 'data_request_closed');
    // Ograniczenie przetwarzania: nowy zapis przy nałożeniu i zdjęciu, historia zostaje.
    const restriction = await createRequest({ kind: 'restriction', householdId: 'h1' });
    assert.equal((await client.call('POST', `${dsr}/${accessId}/export`, { cookie: A, expect: 200 })).body.sha256, exportJson.body.sha256, 'ten sam eksport — ten sam skrót');
    assert.equal((await client.call('POST', `${dsr}/${restriction}/export`, { cookie: A, expect: 409 })).body.error, 'data_request_kind_not_exportable');
    assert.equal((await client.call('POST', `${dsr}/${restriction}/restrict`, { cookie: A, expect: 409 })).body.error, 'data_request_identity_not_verified');
    await setStatus(restriction, 'identity_verified');
    assert.deepEqual((await client.call('POST', `${dsr}/${restriction}/restrict`, { cookie: A, expect: 200 })).body, { restricted: true, changed: true, subjectType: 'household' });
    assert.equal((await client.call('POST', `${dsr}/${restriction}/restrict`, { cookie: A, expect: 200 })).body.changed, false);
    assert.deepEqual((await client.call('POST', `${dsr}/${restriction}/lift-restriction`, { cookie: A, expect: 200 })).body, { restricted: false, changed: true, subjectType: 'household' });
    assert.equal((await client.call('POST', `${dsr}/${restriction}/lift-restriction`, { cookie: A, expect: 200 })).body.changed, false);
    const history = (await client.call('GET', `${dsr}/${restriction}/restrictions`, { cookie: A, expect: 200 })).body;
    assert.deepEqual([history.subjectType, history.restricted, history.events.map((item) => item.action)], ['household', false, ['restrict', 'lift']]);
    assert.equal((await client.call('POST', `${dsr}/${accessId}/restrict`, { cookie: A, expect: 409 })).body.error, 'data_request_kind_not_restrictable');
    const studentRestriction = await createRequest({ kind: 'restriction', studentId: 'h1-s2' });
    await setStatus(studentRestriction, 'identity_verified');
    assert.equal((await client.call('POST', `${dsr}/${studentRestriction}/restrict`, { cookie: A, expect: 409 })).body.error, 'data_request_subject_not_restrictable');
    assert.deepEqual((await client.call('GET', `${dsr}/${studentRestriction}/restrictions`, { cookie: A, expect: 200 })).body, { subjectType: null, restricted: false, events: [] });
    const objection = await createRequest({ kind: 'objection', guardianId: 'h1-g2' });
    await setStatus(objection, 'answered');
    assert.equal((await client.call('POST', `${dsr}/${objection}/restrict`, { cookie: A, expect: 409 })).body.error, 'data_request_closed');
    for (const action of ['restrict', 'lift-restriction']) {
      assert.equal((await client.call('POST', `${dsr}/d-brak/${action}`, { cookie: A, expect: 404 })).body.error, 'data_request_not_found');
    }
    assert.equal((await client.call('GET', `${dsr}/d-brak/restrictions`, { cookie: A, expect: 404 })).body.error, 'data_request_not_found');
    assert.equal((await client.call('GET', `${dsr}/-zly/restrictions`, { cookie: A, expect: 400 })).body.error, 'invalid_id');
    // Rejestr z kursorem związanym z filtrem.
    const allRequests = (await client.call('GET', dsr, { cookie: A, expect: 200 })).body.requests.map((item) => item.id);
    const requestPages = [];
    cursor = null;
    do {
      const page = (await client.call('GET', `${dsr}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: A, expect: 200 })).body;
      requestPages.push(...page.requests.map((item) => item.id));
      cursor = page.nextCursor;
      if (cursor) assert.equal((await client.call('GET', `${dsr}?kind=access&cursor=${encodeURIComponent(cursor)}`, { cookie: A, expect: 400 })).body.error, 'invalid_cursor');
    } while (cursor);
    assert.deepEqual(requestPages, allRequests);
    const restrictionList = (await client.call('GET', `${dsr}?kind=restriction&status=identity_verified`, { cookie: A, expect: 200 })).body.requests;
    assert.deepEqual(restrictionList.map((item) => item.id).sort(), [restriction, studentRestriction].sort());
    for (const [query, code] of [['status=inny', 'invalid_status'], ['kind=inny', 'invalid_kind'], ['limit=0', 'invalid_limit']]) {
      assert.equal((await client.call('GET', `${dsr}?${query}`, { cookie: A, expect: 400, invalidRequest: true })).body.error, code);
    }

    // ---------- anonimizacja: podgląd, wykonanie, przebieg bez zmian ----------
    const anon = '/api/admin/anonymizations';
    const erasure = await createRequest({ kind: 'erasure', householdId: 'h-erase' });
    await setStatus(erasure, 'identity_verified');
    const anonBody = { householdId: 'h-erase', reasonCode: 'data_subject_request', dataRequestId: erasure };
    const anonPreview = (await client.call('POST', anon, { cookie: A, body: { ...anonBody, dryRun: true }, expect: 200 })).body;
    assert.deepEqual([anonPreview.status, anonPreview.runId], ['dry_run', null]);
    assert.ok(!JSON.stringify(anonPreview).includes('Euzebia'), 'podgląd bez danych osobowych');
    const anonApplied = (await client.call('POST', anon, { cookie: A, body: { ...anonBody, dryRun: false, confirm: 'h-erase', expectedPlanSha256: anonPreview.planSha256 }, expect: 201 })).body;
    assert.equal(anonApplied.status, 'applied');
    const anonAgain = (await client.call('POST', anon, { cookie: A, body: { ...anonBody, dryRun: false, confirm: 'h-erase', expectedPlanSha256: anonPreview.planSha256 }, expect: 200 })).body;
    assert.deepEqual([anonAgain.status, anonAgain.runId], ['replayed', null], 'ponowienie: nic do zmiany');
    const runs = (await client.call('GET', `${anon}?limit=1`, { cookie: A, expect: 200 })).body;
    assert.deepEqual([runs.runs.map((run) => run.id), runs.nextCursor], [[anonApplied.runId], null]);
    assert.equal((await client.call('GET', `${anon}?cursor=zepsuty`, { cookie: A, expect: 400 })).body.error, 'invalid_cursor');
    const erasureH1 = await createRequest({ kind: 'erasure', householdId: 'h1' });
    assert.equal((await client.call('POST', anon, { cookie: A, body: { householdId: 'h1', reasonCode: 'data_subject_request', dataRequestId: erasureH1 }, expect: 409 })).body.error, 'data_request_identity_not_verified');
    await setStatus(erasureH1, 'identity_verified');
    for (const [body, status, code] of [
      [{ householdId: 'h1', reasonCode: 'data_subject_request' }, 400, 'invalid_data_request_id'],
      [{ householdId: 'h1', reasonCode: 'data_subject_request', dataRequestId: erasureH1, dryRun: false, expectedPlanSha256: SHA_A }, 400, 'confirmation_required'],
      [{ householdId: 'h-brak', reasonCode: 'retention_policy' }, 404, 'household_not_found'],
      [{ householdId: 'h1', reasonCode: 'data_subject_request', dataRequestId: 'd-brak' }, 404, 'data_request_not_found'],
      [{ householdId: 'h1', reasonCode: 'data_subject_request', dataRequestId: accessId }, 409, 'data_request_kind_not_erasable'],
      [{ householdId: 'h1', reasonCode: 'data_subject_request', dataRequestId: erasure }, 409, 'data_request_subject_mismatch'],
      [{ householdId: 'h1', reasonCode: 'retention_policy' }, 409, 'retention_policy_missing'],
      [{ householdId: 'h1', reasonCode: 'data_subject_request', dataRequestId: erasureH1, dryRun: false, confirm: 'h1', expectedPlanSha256: SHA_A }, 409, 'anonymization_plan_changed'],
    ]) {
      assert.equal((await client.call('POST', anon, { cookie: A, body, expect: status })).body.error, code, JSON.stringify(body));
    }
    for (const [patch, code] of [[{ reasonCode: 'inny' }, 'invalid_reason_code'], [{ dryRun: 'tak' }, 'invalid_dry_run'],
      [{ dryRun: false, confirm: 'h-erase', expectedPlanSha256: 'x' }, 'invalid_plan_sha256'], [{ householdId: '-zly' }, 'invalid_household_id']]) {
      assert.equal((await client.call('POST', anon, { cookie: A, body: { ...anonBody, ...patch }, expect: 400, invalidRequest: true })).body.error, code);
    }
    assert.equal((await client.call('POST', anon, { cookie: cookies.adminStale, body: anonBody, expect: 403 })).body.error, 'mfa_stale');
    const closedErasure = await createRequest({ kind: 'erasure', householdId: 'h1' });
    await setStatus(closedErasure, 'rejected');
    assert.equal((await client.call('POST', anon, { cookie: A, body: { householdId: 'h1', reasonCode: 'data_subject_request', dataRequestId: closedErasure }, expect: 409 })).body.error, 'data_request_closed');
    await assertRequiredFieldsEnforced(client, A, anon, anonBody, 'AdminAnonymizationRequest');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM guardians WHERE household_id = 'h1' AND first_name = 'Zenobia'")).rows[0].n, 1, 'odmowy niczego nie zanonimizowały');

    // ---------- dziennik odczytu danych rodzin z kursorem ----------
    assert.equal((await handlePgRequest(request('/api/households/h1', { cookie: cookies.repA }), env)).status, 200);
    assert.equal((await handlePgRequest(request('/api/households/h-brak', { cookie: cookies.repA }), env)).status, 404);
    const accessLog = (await client.call('GET', '/api/admin/access-log', { cookie: A, expect: 200 })).body;
    assert.ok(accessLog.entries.length >= 3, `wpisy dziennika odczytu: ${accessLog.entries.length}`);
    const logText = JSON.stringify(accessLog);
    for (const marker of ['Zenobia', 'Bonifacy', 'h1-g1@example.invalid', 'u-rep-a@example.invalid']) assert.ok(!logText.includes(marker), `dziennik bez danych osobowych: ${marker}`);
    const logPages = [];
    cursor = null;
    do {
      const page = (await client.call('GET', `/api/admin/access-log?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: A, expect: 200 })).body;
      assert.ok(page.entries.length <= 1);
      logPages.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(logPages, accessLog.entries.map((entry) => entry.id), 'strony kursora = jedna strona');
    const repEntries = (await client.call('GET', '/api/admin/access-log?actorId=u-rep-a&kind=household_card', { cookie: A, expect: 200 })).body.entries;
    assert.deepEqual(repEntries.map((entry) => entry.outcome).sort(), ['not_found', 'ok']);
    assert.deepEqual(repEntries[0].actorRoles, ['representative'], 'bieżące role aktora, bez e-maila');
    assert.ok((await client.call('GET', '/api/admin/access-log?outcome=ok&householdId=h1', { cookie: A, expect: 200 })).body.entries.length >= 2, 'odczyt przedstawiciela i eksport');
    const windowed = (await client.call('GET', `/api/admin/access-log?schoolYearId=${YEAR}&classId=c-1a&from=2020-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`, { cookie: A, expect: 200 })).body;
    assert.equal(windowed.nextCursor, null);
    for (const [query, code] of [['kind=inny', 'invalid_access_kind'], ['outcome=inny', 'invalid_outcome'], ['limit=0', 'invalid_limit'], ['limit=501', 'invalid_limit'],
      ['cursor=zepsuty', 'invalid_cursor'], ['from=wczoraj', 'invalid_from'], ['to=jutro', 'invalid_to'], ['actorId=-zly', 'invalid_actor_id'],
      ['householdId=-zly', 'invalid_household_id'], ['classId=-zla', 'invalid_class_id'], ['schoolYearId=-zly', 'invalid_school_year_id']]) {
      assert.equal((await client.call('GET', `/api/admin/access-log?${query}`, { cookie: A, expect: 400, invalidRequest: true })).body.error, code, query);
    }

    // ---------- przegląd dostępu: przydziały roku i dawne przydziały dyrekcji bez roku ----------
    const reviewPrev = (await client.call('GET', `/api/admin/access-review?schoolYearId=${PREV}`, { cookie: A, expect: 200 })).body;
    assert.deepEqual([reviewPrev.informational, reviewPrev.automaticRevocation, reviewPrev.schoolYear.ended], [true, false, true]);
    const proposalOf = (review, userId) => review.grants.filter((grant) => grant.userId === userId).map((grant) => [grant.role, grant.schoolYearId, grant.proposal, grant.reason]);
    assert.deepEqual(proposalOf(reviewPrev, 'u-rep-old'), [['representative', PREV, 'revoke', 'school_year_ended']]);
    assert.deepEqual(proposalOf(reviewPrev, 'u-legacy-principal'), [['principal', null, 'revoke', 'year_scope_required']]);
    const reviewYear = (await client.call('GET', `/api/admin/access-review?schoolYearId=${YEAR}`, { cookie: A, expect: 200 })).body;
    assert.deepEqual(proposalOf(reviewYear, 'u-legacy-principal'), [['principal', null, 'revoke', 'year_scope_required']], 'dyrekcja bez roku w przeglądzie każdego roku');
    assert.deepEqual(proposalOf(reviewYear, 'u-principal'), [['principal', YEAR, 'keep', null]]);
    assert.ok(reviewYear.summary.proposedRevoke >= 1);
    assert.equal((await client.call('GET', '/api/admin/access-review', { cookie: A, expect: 400 })).body.error, 'invalid_school_year_id');
    assert.equal((await client.call('GET', '/api/admin/access-review?schoolYearId=y-brak', { cookie: A, expect: 404 })).body.error, 'school_year_not_found');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-legacy-principal' AND revoked_at IS NULL")).rows[0].n, 1, 'przegląd niczego nie odbiera');

    // ---------- wygaszenie kadencji zakończonego roku ----------
    const expireBody = { confirm: PREV };
    const expired = (await client.call('POST', `/api/admin/school-years/${PREV}/expire-grants`, { cookie: A, body: expireBody, expect: 200 })).body;
    assert.ok(expired.expired >= 1 && expired.grantIds.length === expired.expired, 'wygaszone przydziały roku');
    assert.deepEqual((await client.call('POST', `/api/admin/school-years/${PREV}/expire-grants`, { cookie: A, body: expireBody, expect: 200 })).body.grantIds, [], 'ponowienie: nic');
    assert.equal((await client.call('POST', `/api/admin/school-years/${PREV}/expire-grants`, { cookie: A, body: { confirm: YEAR }, expect: 400 })).body.error, 'confirmation_required');
    assert.equal((await client.call('POST', `/api/admin/school-years/${FUTURE}/expire-grants`, { cookie: A, body: { confirm: FUTURE }, expect: 409 })).body.error, 'school_year_not_finished');
    assert.equal((await client.call('POST', '/api/admin/school-years/y-brak/expire-grants', { cookie: A, body: { confirm: 'y-brak' }, expect: 404 })).body.error, 'school_year_not_found');
    await assertRequiredFieldsEnforced(client, A, `/api/admin/school-years/${PREV}/expire-grants`, expireBody, 'AdminConfirmIdRequest');

    // ---------- dziennik zdarzeń z kursorem i filtrami ----------
    const defaultAudit = (await client.call('GET', '/api/admin/audit', { cookie: A, expect: 200 })).body;
    assert.ok(defaultAudit.events.length > 0 && defaultAudit.events.every((event) => ['access', 'security'].includes(event.domain)), 'widok domyślny: konta i role');
    const denied = (await client.call('GET', '/api/admin/audit?domain=access&limit=500', { cookie: A, expect: 200 })).body.events.find((event) => event.action === 'access.denied');
    assert.ok(denied && denied.denialCount >= 1, 'odmowa dostępu z licznikiem okna');
    const auditPages = [];
    cursor = null;
    const auditFilter = 'domain=access&actorId=u-admin-a&from=2020-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z';
    const auditAll = (await client.call('GET', `/api/admin/audit?${auditFilter}&limit=500`, { cookie: A, expect: 200 })).body.events.map((event) => event.id);
    do {
      const page = (await client.call('GET', `/api/admin/audit?${auditFilter}&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: A, expect: 200 })).body;
      auditPages.push(...page.events.map((event) => event.id));
      cursor = page.nextCursor;
      if (cursor) assert.equal((await client.call('GET', `/api/admin/audit?domain=security&cursor=${encodeURIComponent(cursor)}`, { cookie: A, expect: 400 })).body.error, 'invalid_cursor');
    } while (cursor);
    assert.deepEqual(auditPages, auditAll);
    const privacy = (await client.call('GET', '/api/admin/audit?domain=privacy&limit=500', { cookie: A, expect: 200 })).body.events.map((event) => event.action);
    assert.ok(privacy.includes('access_log.viewed') && privacy.includes('access_review.viewed') && privacy.includes('audit.viewed'), 'odczyty dzienników zostawiają ślad');
    for (const [query, code] of [['domain=inna', 'invalid_domain'], ['actorId=-zly', 'invalid_actor_id'], ['schoolYearId=-zly', 'invalid_school_year_id'],
      ['from=wczoraj', 'invalid_from'], ['to=jutro', 'invalid_to'], ['limit=0', 'invalid_limit']]) {
      assert.equal((await client.call('GET', `/api/admin/audit?${query}`, { cookie: A, expect: 400, invalidRequest: true })).body.error, code, query);
    }

    // ---------- raport retencji i stan operacyjny ----------
    const retention = (await client.call('GET', '/api/admin/retention/preview', { cookie: A, expect: 200 })).body;
    assert.deepEqual(retention.policies.map((policy) => [policy.id, policy.current, policy.approvedBy]), [['rp-guardian-contact', true, 'u-admin-b']]);
    assert.ok(retention.candidates.some((item) => item.category === 'student_identity' && item.schoolYearId === YEAR && item.count > 0));
    const ops = await client.call('GET', '/api/admin/ops-status', { cookie: A, expect: 200 });
    assert.equal(ops.body.writeMode, 'normal');
    assert.ok(!JSON.stringify(ops.body).includes('@'), 'stan operacyjny bez adresów');

    assert.equal(networkGuardCalls(), 0, 'żadnej próby połączenia z siecią');
    assertSuccessCoverage(validated);
  } finally {
    await db.close();
  }
});
