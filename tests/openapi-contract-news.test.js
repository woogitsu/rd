// Kontrakt API (#160, etap 10): prawdziwe odpowiedzi modułu `news` (PGlite, dane syntetyczne `@example.invalid`, imiona
// opiekunów syntetyczne) walidowane schematami z docs/openapi.json (src/pg/schemas/news.js) przez
// tests/helpers/contract-client.js. Rejestr pokrycia i katalog kodów sprawdza tests/openapi-contract.test.js
// (wspólnie dla wszystkich pokrytych modułów).
//
// ZDJĘCIA WYŁĄCZNIE SYNTETYCZNE: bajty PNG/JPEG generuje `sharp` z jednolitego koloru (bez wizerunków, bez EXIF),
// odwołania do zgód i dokumentów są fikcyjnymi identyfikatorami. Magazyn plików w pamięci (createMemoryStorage),
// ŻADNEJ SIECI — globalna pułapka sieci (tests/helpers/network-guard.js) liczy próby połączeń, licznik musi być 0.
//
// Przebieg: rejestr zdjęć (utworzenie z kluczem, ponowienie z `Idempotency-Replayed`, konflikt klucza, `alt_text` wymagany
// — 422, zdjęcie dekoracyjne, publiczna kopia bez licencji, błędy pól, bramka danych osobowych), odwołania do zgód
// (rodzeństwo na jednej zgodzie, ponowienie, konflikt, blokada po weryfikacji), weryfikacja (cztery oczy, brak zgody
// dziecka, zgody nie pokrywają osób), plik zdjęcia (PNG i JPEG, ponowienie, konflikt, 400/404/409/413/415/503); wpisy
// (szkic przedstawiciela i zarządu, zmiana z wersją, zgłoszenie, zatwierdzenie z czterema oczami i MFA, publikacja,
// wycofanie); widok publiczny wyłącznie z zatwierdzonymi danymi (zdjęcie niezweryfikowane blokuje zatwierdzenie,
// zdjęcie ze zgodą bez zakresu strony Rady, wycofana zgoda i cofnięte prawa znikają z listy i z publicznego pliku);
// listy z kursorem (publiczna i rejestr zdjęć); granice ról (401; przedstawiciel; zarząd z przydziałem klasy; Komisja
// Rewizyjna; dyrekcja; skarbnik; brak MFA w bramce routera i w module; obcy Origin), błędy 400/404/409/413/415/422 i
// zamknięty rok osiągnięty trasami year-close (bez obchodzenia triggerów).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { PHOTO_UPLOAD_MAX_BYTES } from '../src/pg/news.js';
import { resetUploadSlotsForTests, tryAcquireUploadSlot } from '../src/documents.js';
import { createMemoryStorage } from '../src/storage.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import {
  createTestDb, networkGuardCalls, request, seedClass, seedDocument, seedSchoolYear, seedUserSession,
} from './helpers/pg.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;

const YEAR = 'y-2026';
const NEXT = 'y-2027';
const FOREIGN = 'https://obcy.example.invalid';
const SOURCE_DOCUMENT = 'dok-galeria-syntetyczny';

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

function newClient(env) {
  return createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
}

// Syntetyczny obraz z jednolitego koloru (bez wizerunku i bez metadanych).
async function syntheticImage(format, shade) {
  const image = sharp({ create: { width: 24, height: 16, channels: 3, background: { r: shade, g: 60, b: 120 } } });
  return new Uint8Array(await (format === 'png' ? image.png() : image.jpeg()).toBuffer());
}

// Każda odpowiedź sukcesu opisana w schemacie modułu została zwalidowana na prawdziwej odpowiedzi.
function assertSuccessCoverage(validated) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (entry.module !== 'news') continue;
    for (const status of Object.keys(entry.responses)) expected.push(`${routeId} ${status}`);
  }
  assert.ok(expected.length >= 25, `oczekiwane odpowiedzi: ${expected.length}`);
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

// Rodzina: dzieci zapisane do wskazanych klas i opiekunowie (imiona syntetyczne — bramka zna je jako „znane nazwiska”).
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
  // h1: rodzeństwo w 1A i 1B, dwoje opiekunów obu dzieci (imiona syntetyczne).
  await family(db, 'h1', { classes: ['c-1a', 'c-1b'], guardians: [['Zenobia', 'Testowa'], ['Bonifacy', 'Testowy']] });
  // 0143: dokument źródłowy zdjęcia (dokument zarządu) musi istnieć.
  await seedDocument(db, { id: SOURCE_DOCUMENT, createdBy: 'u-admin' });
  const storage = createMemoryStorage();
  const env = { db, storage, APP_ENV: 'development' };
  return { db, env, storage, cookies, client: newClient(env) };
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

// Ciało rejestracji zdjęcia; pole z wartością `undefined` w `overrides` jest pomijane (np. zdjęcie dekoracyjne bez opisu).
function photoBody(overrides = {}) {
  const body = {
    documentId: SOURCE_DOCUMENT, author: 'Fotograf syntetyczny', source: 'own_work', takenOn: '2026-10-10',
    licenseText: 'Zdjęcie własne autora, udostępnione Radzie do publikacji (syntetyczne).',
    altText: 'Stół kiermaszowy z ciastami', depictsChildren: false, ...overrides,
  };
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

test('specyfikacja aktualności: klucz i nagłówek ponowienia tylko przy szkicu, rejestracji zdjęcia i pliku; alt_text wymagany w schemacie', () => {
  const operation = (method, path) => spec.paths[path][method];
  const hasKey = (op) => (op.parameters ?? []).some((p) => p.in === 'header' && p.name === 'Idempotency-Key' && p.required === true);
  const replayedEnum = (op, status) => op.responses[status].headers?.['Idempotency-Replayed']?.schema.enum ?? null;
  for (const path of ['/api/news', '/api/news-photos', '/api/news-photos/{photoId}/file']) {
    const op = operation('post', path);
    assert.equal(hasKey(op), true, path);
    assert.deepEqual([replayedEnum(op, '201'), replayedEnum(op, '200')], [['false'], ['true']], path);
  }
  const consents = operation('post', '/api/news-photos/{photoId}/consents');
  assert.equal(hasKey(consents), false);
  assert.deepEqual([replayedEnum(consents, '201'), replayedEnum(consents, '200')], [null, null]);
  const field = (status) => consents.responses[status].content['application/json'].schema.properties.replayed;
  assert.deepEqual([field('201'), field('200')], [{ const: false }, { const: true }]);
  for (const [method, path] of [
    ['patch', '/api/news/{postId}'], ['post', '/api/news/{postId}/submit'], ['post', '/api/news/{postId}/approve'],
    ['post', '/api/news/{postId}/publish'], ['post', '/api/news/{postId}/withdraw'], ['post', '/api/news-photos/{photoId}/verify'],
    ['post', '/api/news-photos/{photoId}/revoke'], ['post', '/api/news-photo-consents/{consentDocumentRef}/withdraw'],
  ]) {
    const op = operation(method, path);
    assert.equal(hasKey(op), false, path);
    assert.equal(replayedEnum(op, '200'), null, path);
  }
  for (const path of ['/api/public/news', '/api/public/news/{postId}', '/api/public/school-years',
    '/api/public/news-photos/{photoId}/web', '/api/public/news-photos/{photoId}/thumb']) {
    assert.deepEqual(operation('get', path).security, [], path);
  }
  assert.deepEqual(Object.keys(operation('get', '/api/public/news-photos/{photoId}/web').responses['200'].content), ['image/jpeg']);
  assert.deepEqual(Object.keys(operation('post', '/api/news-photos/{photoId}/file').requestBody.content).sort(), ['image/jpeg', 'image/png']);
  assert.equal(operation('post', '/api/news-photo-consents/{consentDocumentRef}/withdraw').requestBody, undefined);
  // Tekst alternatywny (#124): schemat żądania wymaga `altText` albo `decorative: true`.
  assert.equal(components.NewsPhotoRegisterRequest.anyOf.length, 2);
  assert.deepEqual(operation('post', '/api/news-photos').responses['422']['x-rd-error-codes'],
    ['alt_text_required', 'personal_data_forbidden', 'possible_personal_data', 'public_copy_requires_license']);
});

test('kontrakt modułu news: prawdziwe odpowiedzi wpisów, zdjęć, zgód, plików i widoku publicznego zgodne ze schematami', async () => {
  const { db, env, storage, cookies, client } = await world();
  const A = cookies.boardA;
  const B = cookies.boardB;
  const R = cookies.repA;
  const ADM = cookies.admin;
  const validated = client.validated;
  const merge = (other) => { for (const item of other.validated) validated.add(item); };
  resetUploadSlotsForTests();
  try {
    const register = async (cookie, overrides = {}) => (await client.call('POST', '/api/news-photos', {
      cookie, body: photoBody(overrides), key: key('photo'), expect: 201,
    })).body.photo;
    const verify = async (photoId, cookie = A) => (await client.call('POST', `/api/news-photos/${photoId}/verify`, { cookie, body: {}, expect: 200 })).body;
    const upload = async (photoId, bytes, type, expect = 201, uploadKey = key('file'), cookie = ADM) => client.call('POST', `/api/news-photos/${photoId}/file`, {
      cookie, body: bytes, key: uploadKey, headers: { 'Content-Type': type }, expect,
    });
    const createPost = async (cookie, body) => (await client.call('POST', '/api/news', { cookie, body, key: key('news'), expect: 201 })).body.post;
    const step = async (cookie, id, action, revision, extra = {}) => (await client.call('POST', `/api/news/${id}/${action}`, {
      cookie, body: { revision, ...extra }, expect: 200,
    })).body;
    const publishFlow = async (id, revision, author = A) => {
      await step(author, id, 'submit', revision);
      await step(B, id, 'approve', revision);
      return (await step(B, id, 'publish', revision)).post;
    };
    const publicPost = async (id) => (await client.call('GET', `/api/public/news/${id}`, { expect: 200 })).body.post;
    const publicFile = async (photoId, variant, expect) => client.call('GET', `/api/public/news-photos/${photoId}/${variant}`, { expect });

    // ---------- Rejestr zdjęć: utworzenie, ponowienie, konflikt klucza, alt_text, błędy pól ----------
    const photoKey = key('photo');
    const registered = await client.call('POST', '/api/news-photos', { cookie: ADM, body: photoBody(), key: photoKey, expect: 201 });
    assert.equal(registered.headers.get('Idempotency-Replayed'), 'false');
    const p1 = registered.body.photo;
    assert.deepEqual([p1.rightsStatus, p1.uploadedBy, p1.altText, p1.decorative, p1.takenOn], ['pending', 'u-admin', 'Stół kiermaszowy z ciastami', false, '2026-10-10']);
    const photoReplay = await client.call('POST', '/api/news-photos', { cookie: ADM, body: photoBody(), key: photoKey, expect: 200 });
    assert.equal(photoReplay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(photoReplay.body, registered.body);
    assert.equal((await client.call('POST', '/api/news-photos', { cookie: ADM, body: photoBody({ author: 'Inny fotograf' }), key: photoKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', '/api/news-photos', { cookie: ADM, body: photoBody(), expect: 400 })).body.error, 'invalid_idempotency_key');
    // alt_text wymagany (#124): ani opisu, ani `decorative: true` → 422 (schemat żądania też to odrzuca).
    const { altText: _omitted, ...withoutAlt } = photoBody();
    for (const body of [withoutAlt, { ...withoutAlt, decorative: false }, { ...withoutAlt, altText: null }]) {
      assert.equal((await client.call('POST', '/api/news-photos', { cookie: ADM, body, key: key('photo'), expect: 422, invalidRequest: true })).body.error, 'alt_text_required');
    }
    const decorative = await register(ADM, { altText: undefined, decorative: true, author: 'Fotograf dekoracji' });
    assert.deepEqual([decorative.altText, decorative.decorative], [null, true]);
    assert.equal((await client.call('POST', '/api/news-photos', {
      cookie: ADM, body: photoBody({ source: 'public_website_copy' }), key: key('photo'), expect: 422,
    })).body.error, 'public_copy_requires_license', 'sama publiczna dostępność nie daje prawa do kopii');
    const schemaErrors = [
      [{ source: 'internet' }, 'invalid_source'],
      [{ takenOn: '2026-02-30' }, 'invalid_taken_on'],
      [{ depictsChildren: 'tak' }, 'invalid_depicts_children'],
      [{ explicitLicenseGranted: 'tak' }, 'invalid_explicit_license'],
      [{ decorative: 'tak' }, 'invalid_decorative'],
      [{ documentId: '!' }, 'invalid_document_id'],
      [{ author: 'a' }, 'invalid_author'],
      [{ sourceDetail: 'ab' }, 'invalid_source_detail'],
      [{ licenseText: 'krótko' }, 'invalid_license_text'],
      [{ licenseDocumentRef: '!' }, 'invalid_license_document_ref'],
      [{ rightsNote: 'ab' }, 'invalid_rights_note'],
      [{ altText: 'ab' }, 'invalid_alt_text'],
      [{ identifiableChildren: 101, depictsChildren: true }, 'invalid_identifiable_children'],
      [{ identifiableAdults: -1 }, 'invalid_identifiable_adults'],
      [{ consents: [{ subjectKind: 'pet', consentDocumentRef: 'zgoda-dok-9999' }] }, 'invalid_consent'],
      [{ consents: [{ subjectKind: 'adult', consentDocumentRef: 'zgoda-dok-9999', scope: ['tv'] }] }, 'invalid_consent_scope'],
      [{ consents: [{ subjectKind: 'adult', consentDocumentRef: 'zgoda-dok-9999', validUntil: '2026-13-01' }] }, 'invalid_consent_valid_until'],
    ];
    for (const [patch, code] of schemaErrors) {
      assert.equal((await client.call('POST', '/api/news-photos', {
        cookie: ADM, body: photoBody(patch), key: key('photo'), expect: 400, invalidRequest: true,
      })).body.error, code);
    }
    // Reguły poza schematem: rozpoznawalne dzieci bez `depictsChildren` i nieistniejący dokument źródłowy.
    assert.equal((await client.call('POST', '/api/news-photos', { cookie: ADM, body: photoBody({ identifiableChildren: 1 }), key: key('photo'), expect: 400 })).body.error, 'invalid_depicts_children');
    assert.equal((await client.call('POST', '/api/news-photos', { cookie: ADM, body: photoBody({ documentId: 'dok-brak' }), key: key('photo'), expect: 400 })).body.error, 'invalid_document_id');
    // Bramka danych osobowych (#152): e-mail odrzucony zawsze, telefon wymaga potwierdzenia.
    assert.equal((await client.call('POST', '/api/news-photos', { cookie: ADM, body: photoBody({ altText: 'Kontakt rodzic@example.invalid' }), key: key('photo'), expect: 422 })).body.error, 'personal_data_forbidden');
    const phoneNote = photoBody({ rightsNote: 'Zgoda przekazana telefonicznie 0471 23 45 67' });
    const piiWarning = await client.call('POST', '/api/news-photos', { cookie: ADM, body: phoneNote, key: key('photo'), expect: 422 });
    assert.deepEqual([piiWarning.body.error, piiWarning.body.categories], ['possible_personal_data', ['phone']]);
    await register(ADM, { ...phoneNote, confirmPersonalData: true });
    await assertRequiredFieldsEnforced(client, ADM, 'POST', '/api/news-photos', photoBody(), 'NewsPhotoRegisterRequest', { withKey: true });

    // ---------- Zgody: rodzeństwo na jednej zgodzie, ponowienie, konflikt, weryfikacja (cztery oczy), blokada ----------
    const childPhoto = await register(ADM, {
      altText: 'Dzieci przy stole z ciastami', depictsChildren: true, identifiableChildren: 2,
      consents: [{ subjectKind: 'child', consentDocumentRef: 'zgoda-dok-0001' }],
    });
    const consentsPath = `/api/news-photos/${childPhoto.id}/consents`;
    assert.equal((await client.call('POST', `/api/news-photos/${childPhoto.id}/verify`, { cookie: A, body: {}, expect: 409 })).body.error, 'consent_missing', 'jedna zgoda na dwoje rozpoznawalnych dzieci');
    const sibling = { subjectNo: 2, subjectKind: 'child', consentDocumentRef: 'zgoda-dok-0001' };
    const added = await client.call('POST', consentsPath, { cookie: ADM, body: sibling, expect: 201 });
    assert.deepEqual([added.body, added.headers.get('Idempotency-Replayed')], [{ replayed: false }, null]);
    assert.deepEqual((await client.call('POST', consentsPath, { cookie: ADM, body: sibling, expect: 200 })).body, { replayed: true }, 'podwójne kliknięcie');
    assert.equal((await client.call('POST', consentsPath, { cookie: ADM, body: { ...sibling, consentDocumentRef: 'zgoda-dok-0002' }, expect: 409 })).body.error, 'consent_conflict');
    const consentErrors = [
      [{ ...sibling, subjectNo: 0 }, 'invalid_consent'],
      [{ ...sibling, subjectKind: 'pet' }, 'invalid_consent'],
      [{ ...sibling, scope: [] }, 'invalid_consent_scope'],
      [{ ...sibling, validUntil: '31.12.2027' }, 'invalid_consent_valid_until'],
    ];
    for (const [body, code] of consentErrors) {
      assert.equal((await client.call('POST', consentsPath, { cookie: ADM, body, expect: 400, invalidRequest: true })).body.error, code);
    }
    await assertRequiredFieldsEnforced(client, ADM, 'POST', consentsPath, { ...sibling, subjectNo: 3 }, 'NewsPhotoConsentRequest');
    assert.equal((await client.call('POST', '/api/news-photos/zdjecie-brak/consents', { cookie: ADM, body: sibling, expect: 404 })).body.error, 'photo_not_found');
    const detail = await client.call('GET', `/api/news-photos/${childPhoto.id}`, { cookie: A, expect: 200 });
    assert.deepEqual(detail.body.photo.consents.map((c) => [c.subjectNo, c.subjectKind, c.consentDocumentRef, c.scope, c.validUntil]),
      [[1, 'child', 'zgoda-dok-0001', ['rada_website'], null], [2, 'child', 'zgoda-dok-0001', ['rada_website'], null]]);
    // Cztery oczy: weryfikuje inna osoba niż rejestrująca; admin techniczny nie weryfikuje praw.
    const ownPhoto = await register(A, { author: 'Fotograf zarządu' });
    assert.equal((await client.call('POST', `/api/news-photos/${ownPhoto.id}/verify`, { cookie: A, body: {}, expect: 409 })).body.error, 'four_eyes_required');
    assert.equal((await client.call('POST', `/api/news-photos/${childPhoto.id}/verify`, { cookie: ADM, body: {}, expect: 403 })).body.error, 'forbidden');
    const childVerified = await verify(childPhoto.id);
    assert.deepEqual([childVerified.photo.rightsStatus, childVerified.photo.rightsVerifiedBy, childVerified.replayed], ['verified', 'u-board-a', false]);
    assert.equal((await verify(childPhoto.id)).replayed, true);
    assert.equal((await client.call('POST', consentsPath, { cookie: ADM, body: { ...sibling, subjectNo: 3 }, expect: 409 })).body.error, 'consents_locked');
    const noChildConsent = await register(ADM, { altText: 'Dziecko przy tablicy', depictsChildren: true });
    assert.equal((await client.call('POST', `/api/news-photos/${noChildConsent.id}/verify`, { cookie: A, body: {}, expect: 409 })).body.error, 'child_consent_required');
    // Zdjęcie z osobą dorosłą, której zgoda NIE obejmuje strony Rady (tylko druk): weryfikowalne, ale niepubliczne.
    const printOnly = await register(ADM, {
      altText: 'Prowadząca przy stoisku', identifiableAdults: 1,
      consents: [{ subjectKind: 'adult', consentDocumentRef: 'zgoda-druk-0001', scope: ['print'] }],
    });
    await verify(printOnly.id);
    await verify(p1.id);
    await verify(decorative.id);
    const pending = await register(ADM, { altText: 'Sala gimnastyczna przed festynem' });

    // ---------- Plik zdjęcia: PNG i JPEG, ponowienie, konflikt, błędy ----------
    const png = await syntheticImage('png', 200);
    const fileKey = key('file');
    const firstUpload = await upload(p1.id, png, 'image/png', 201, fileKey);
    assert.equal(firstUpload.headers.get('Idempotency-Replayed'), 'false');
    assert.deepEqual(firstUpload.body.files.map((file) => [file.variant, file.mimeType, file.width, file.height]).sort(),
      [['thumb', 'image/jpeg', 24, 16], ['web', 'image/jpeg', 24, 16]]);
    const fileReplay = await upload(p1.id, png, 'image/png', 200, fileKey);
    assert.equal(fileReplay.headers.get('Idempotency-Replayed'), 'true');
    assert.equal((await upload(p1.id, await syntheticImage('png', 10), 'image/png', 409)).body.error, 'photo_file_exists', 'korekta = nowe zdjęcie');
    await upload(decorative.id, await syntheticImage('jpeg', 90), 'image/jpeg');
    await upload(printOnly.id, await syntheticImage('png', 30), 'image/png');
    await upload(childPhoto.id, await syntheticImage('png', 40), 'image/png');
    await upload(pending.id, await syntheticImage('png', 50), 'image/png');
    assert.equal((await upload(ownPhoto.id, png, 'image/jpeg', 415)).body.error, 'unsupported_media_type', 'typ niezgodny z sygnaturą');
    assert.equal((await client.call('POST', `/api/news-photos/${ownPhoto.id}/file`, {
      cookie: ADM, body: new TextEncoder().encode('%PDF-1.4\n%%EOF\n'), key: key('file'), headers: { 'Content-Type': 'application/pdf' }, expect: 415, invalidRequest: true,
    })).body.error, 'unsupported_media_type');
    const brokenPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal((await upload(ownPhoto.id, brokenPng, 'image/png', 415)).body.error, 'photo_file_malformed');
    assert.equal((await upload(ownPhoto.id, new Uint8Array(0), 'image/png', 400)).body.error, 'empty_photo_file');
    assert.equal((await upload(ownPhoto.id, new Uint8Array(PHOTO_UPLOAD_MAX_BYTES + 1), 'image/png', 413)).body.error, 'photo_file_too_large');
    assert.equal((await upload('zdjecie-brak', png, 'image/png', 404)).body.error, 'photo_not_found');
    assert.equal((await upload('%21', png, 'image/png', 400)).body.error, 'invalid_photo_id');
    assert.equal((await client.call('POST', `/api/news-photos/${ownPhoto.id}/file`, {
      cookie: ADM, body: png, headers: { 'Content-Type': 'image/png' }, expect: 400,
    })).body.error, 'invalid_idempotency_key');
    assert.equal((await upload(ownPhoto.id, png, 'image/png', 403, key('file'), R)).body.error, 'forbidden');
    // Limit równoczesnych uploadów na użytkownika (wspólny z dokumentami, #185) — sloty zajęte wprost, po kolei.
    const held = [tryAcquireUploadSlot(undefined, 'u-admin'), tryAcquireUploadSlot(undefined, 'u-admin')];
    try {
      const busy = await upload(ownPhoto.id, png, 'image/png', 503);
      assert.deepEqual([busy.body.error, busy.headers.get('Retry-After')], ['upload_busy', '2']);
    } finally {
      for (const release of held) release();
    }
    const noStorage = newClient({ db, APP_ENV: 'development' });
    assert.equal((await noStorage.call('POST', `/api/news-photos/${ownPhoto.id}/file`, {
      cookie: ADM, body: png, key: key('file'), headers: { 'Content-Type': 'image/png' }, expect: 503,
    })).body.error, 'storage_unavailable');

    // ---------- Wpis klasowy przedstawiciela: szkic, ponowienie, granice, błędy treści, bramka ----------
    const classBody = { schoolYearId: YEAR, classId: 'c-1a', title: 'Wycieczka klasy 1A', body: 'Zbiórka o ósmej przed szkołą.' };
    const classKey = key('news');
    const created = await client.call('POST', '/api/news', { cookie: R, body: classBody, key: classKey, expect: 201 });
    assert.equal(created.headers.get('Idempotency-Replayed'), 'false');
    const classPost = created.body.post;
    assert.deepEqual([classPost.status, classPost.revision, classPost.classId, classPost.createdBy, classPost.publishedRevision],
      ['draft', 1, 'c-1a', 'u-rep-a', null]);
    const createdReplay = await client.call('POST', '/api/news', { cookie: R, body: classBody, key: classKey, expect: 200 });
    assert.equal(createdReplay.headers.get('Idempotency-Replayed'), 'true');
    assert.deepEqual(createdReplay.body, created.body);
    assert.equal((await client.call('POST', '/api/news', { cookie: R, body: { ...classBody, title: 'Inna wycieczka' }, key: classKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', '/api/news', { cookie: R, body: classBody, expect: 400 })).body.error, 'invalid_idempotency_key');
    for (const classId of ['c-1b', null]) {
      assert.equal((await client.call('POST', '/api/news', { cookie: R, body: { ...classBody, classId }, key: key('news'), expect: 403 })).body.error, 'forbidden', String(classId));
    }
    assert.equal((await client.call('POST', '/api/news', { cookie: R, body: { ...classBody, photoIds: [p1.id] }, key: key('news'), expect: 403 })).body.error, 'photos_require_school_wide_role');
    const postSchemaErrors = [
      [{ title: 'ab' }, 'invalid_title'],
      [{ body: '' }, 'invalid_body'],
      [{ photoIds: 'p1' }, 'invalid_photos'],
      [{ schoolYearId: '!' }, 'invalid_school_year'],
      [{ classId: '!' }, 'invalid_class'],
    ];
    for (const [patch, code] of postSchemaErrors) {
      assert.equal((await client.call('POST', '/api/news', { cookie: A, body: { ...classBody, ...patch }, key: key('news'), expect: 400, invalidRequest: true })).body.error, code);
    }
    assert.equal((await client.call('POST', '/api/news', { cookie: A, body: { ...classBody, classId: null, photoIds: [p1.id, p1.id] }, key: key('news'), expect: 400 })).body.error, 'duplicate_photo');
    assert.equal((await client.call('POST', '/api/news', { cookie: A, body: { ...classBody, classId: null, photoIds: ['zdjecie-brak'] }, key: key('news'), expect: 422 })).body.error, 'photo_not_found');
    for (const classId of ['c-2a', 'c-brak']) {
      assert.equal((await client.call('POST', '/api/news', { cookie: A, body: { ...classBody, classId }, key: key('news'), expect: 400 })).body.error, 'invalid_reference', classId);
    }
    assert.equal((await client.call('POST', '/api/news', { cookie: R, body: { ...classBody, title: 'Kontakt rodzic@example.invalid' }, key: key('news'), expect: 422 })).body.error, 'personal_data_forbidden');
    const knownName = { ...classBody, body: 'Gratulacje dla Zenobia Testowa za pomoc przy kiermaszu.' };
    const nameWarning = await client.call('POST', '/api/news', { cookie: R, body: knownName, key: key('news'), expect: 422 });
    assert.deepEqual([nameWarning.body.error, nameWarning.body.categories], ['possible_personal_data', ['known_name']]);
    await createPost(R, { ...knownName, confirmPersonalData: true });
    await assertRequiredFieldsEnforced(client, R, 'POST', '/api/news', classBody, 'NewsPostCreateRequest', { withKey: true });

    // ---------- Wpis ogólnoszkolny zarządu ze zdjęciami: szczegóły, lista, zmiana z wersją ----------
    const schoolBody = { schoolYearId: YEAR, title: 'Kiermasz – podsumowanie', body: 'Dziękujemy za udział.\nRozliczenie podamy osobno.', photoIds: [p1.id, decorative.id] };
    const school = await createPost(A, schoolBody);
    const base = `/api/news/${school.id}`;
    const postDetail = await client.call('GET', base, { cookie: A, expect: 200 });
    assert.deepEqual(postDetail.body.revisions.map((r) => [r.revision, r.title, r.photoIds.length]), [[1, 'Kiermasz – podsumowanie', 2]]);
    const boardList = await client.call('GET', `/api/news?schoolYearId=${YEAR}`, { cookie: A, expect: 200 });
    assert.ok(boardList.body.posts.some((post) => post.id === school.id) && boardList.body.posts.some((post) => post.id === classPost.id));
    const repList = await client.call('GET', `/api/news?schoolYearId=${YEAR}`, { cookie: R, expect: 200 });
    assert.ok(repList.body.posts.length > 0 && repList.body.posts.every((post) => post.classId === 'c-1a'), 'przedstawiciel widzi tylko swoją klasę');
    assert.equal((await client.call('GET', '/api/news?schoolYearId=%21', { cookie: A, expect: 400 })).body.error, 'invalid_school_year');
    assert.equal((await client.call('GET', '/api/news', { cookie: A, expect: 400, invalidRequest: true })).body.error, 'invalid_school_year');
    const edit = { revision: 1, title: 'Kiermasz – podsumowanie i podziękowania', photoIds: [p1.id, decorative.id, printOnly.id] };
    const edited = await client.call('PATCH', base, { cookie: A, body: edit, expect: 200 });
    assert.deepEqual([edited.body.post.revision, edited.body.post.status, edited.body.replayed], [2, 'draft', false]);
    assert.equal(edited.headers.get('Idempotency-Replayed'), null);
    assert.equal((await client.call('PATCH', base, { cookie: A, body: edit, expect: 200 })).body.replayed, true, 'ta sama zmiana jeszcze raz (podwójne kliknięcie)');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { ...edit, revision: 2 }, expect: 200 })).body.replayed, true);
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 1, title: 'Zmiana na starej wersji' }, expect: 409 })).body.error, 'revision_conflict');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { title: 'Bez wersji' }, expect: 400, invalidRequest: true })).body.error, 'invalid_revision');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 2, photoIds: ['zdjecie-brak'] }, expect: 422 })).body.error, 'photo_not_found');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 2, photoIds: [p1.id, p1.id] }, expect: 400 })).body.error, 'duplicate_photo');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 2, body: 'Kontakt: rodzic@example.invalid' }, expect: 422 })).body.error, 'personal_data_forbidden');
    assert.equal((await client.call('PATCH', `/api/news/${classPost.id}`, { cookie: R, body: { revision: 1, photoIds: [p1.id] }, expect: 403 })).body.error, 'photos_require_school_wide_role');
    await assertRequiredFieldsEnforced(client, A, 'PATCH', base, { revision: 2, title: 'Kiermasz – podsumowanie i podziękowania' }, 'NewsPostUpdateRequest');

    // ---------- Przebieg: zgłoszenie, zatwierdzenie (cztery oczy, MFA), publikacja ----------
    assert.equal((await client.call('POST', `${base}/approve`, { cookie: B, body: { revision: 2 }, expect: 409 })).body.error, 'invalid_transition', 'zatwierdzenie szkicu');
    assert.equal((await client.call('POST', `${base}/submit`, { cookie: A, body: { revision: 1 }, expect: 409 })).body.error, 'revision_conflict');
    const submitted = await step(A, school.id, 'submit', 2);
    assert.deepEqual([submitted.post.status, submitted.post.submittedRevision, submitted.replayed], ['submitted', 2, false]);
    assert.equal((await step(A, school.id, 'submit', 2)).replayed, true);
    await assertRequiredFieldsEnforced(client, A, 'POST', `${base}/submit`, { revision: 2 }, 'NewsPostTransitionRequest');
    assert.equal((await client.call('POST', `${base}/approve`, { cookie: A, body: { revision: 2 }, expect: 409 })).body.error, 'four_eyes_required');
    assert.equal((await client.call('POST', `${base}/approve`, { cookie: ADM, body: { revision: 2 }, expect: 403 })).body.error, 'forbidden', 'admin techniczny nie zatwierdza');
    assert.equal((await client.call('POST', `${base}/publish`, { cookie: B, body: { revision: 2 }, expect: 409 })).body.error, 'invalid_transition', 'publikacja przed zatwierdzeniem');
    const approved = await step(B, school.id, 'approve', 2);
    assert.deepEqual([approved.post.status, approved.post.approvedBy, approved.post.approvedRevision], ['approved', 'u-board-b', 2]);
    assert.equal((await step(B, school.id, 'approve', 2)).replayed, true);
    assert.equal((await client.call('GET', `/api/public/news/${school.id}`, { expect: 404 })).body.error, 'post_not_found', 'zatwierdzony, ale nieopublikowany');
    const published = await step(B, school.id, 'publish', 2);
    assert.deepEqual([published.post.status, published.post.publishedRevision, published.replayed], ['published', 2, false]);
    assert.equal((await step(B, school.id, 'publish', 2)).replayed, true);

    // ---------- Widok publiczny: tylko zatwierdzone dane i zdjęcia z prawami i zgodą na stronę Rady ----------
    const publicList = await client.call('GET', '/api/public/news', { expect: 200 });
    assert.equal(publicList.headers.get('Cache-Control'), 'public, max-age=60');
    assert.deepEqual(publicList.body.posts.map((post) => post.id), [school.id]);
    const shown = publicList.body.posts[0];
    assert.deepEqual(shown.photos.map((photo) => [photo.id, photo.altText, photo.decorative]),
      [[p1.id, 'Stół kiermaszowy z ciastami', false], [decorative.id, '', true]], 'zdjęcie ze zgodą tylko na druk nie trafia na stronę');
    assert.doesNotMatch(JSON.stringify(publicList.body), /u-board|u-admin|zgoda-|dok-galeria|c-1a|y-2026/, 'bez autorów, zgód, dokumentów, klas i roku');
    assert.deepEqual(await publicPost(school.id), shown);
    for (const id of [classPost.id, 'wpis-brak', '%21', '%E0%A4%A']) {
      assert.equal((await client.call('GET', `/api/public/news/${id}`, { expect: 404 })).body.error, 'post_not_found', id);
    }
    const webFile = await publicFile(p1.id, 'web', 200);
    assert.deepEqual([webFile.headers.get('Content-Type'), webFile.headers.get('Cache-Control')], ['image/jpeg', 'public, max-age=60']);
    assert.equal((await sharp(webFile.bytes).metadata()).exif, undefined, 'wariant publiczny bez EXIF');
    await publicFile(decorative.id, 'thumb', 200);
    for (const photoId of [printOnly.id, pending.id, 'zdjecie-brak']) {
      assert.equal((await publicFile(photoId, 'web', 404)).body.error, 'photo_not_found', photoId);
    }
    const years = await client.call('GET', '/api/public/school-years', { expect: 200 });
    assert.deepEqual(years.body.schoolYears, [{ id: YEAR }]);

    // Zdjęcie niezweryfikowane blokuje zatwierdzenie (nie trafi do widoku publicznego).
    const withPending = await createPost(A, { schoolYearId: YEAR, title: 'Festyn – zapowiedź', body: 'Zapraszamy.', photoIds: [pending.id] });
    await step(A, withPending.id, 'submit', 1);
    assert.equal((await client.call('POST', `/api/news/${withPending.id}/approve`, { cookie: B, body: { revision: 1 }, expect: 409 })).body.error, 'photo_rights_unverified');

    // ---------- Wycofanie zgody (rodzeństwo na jednej zgodzie) i cofnięcie praw (`photo_revoked`) ----------
    const withChild = await client.call('PATCH', base, { cookie: A, body: { revision: 2, photoIds: [p1.id, decorative.id, childPhoto.id] }, expect: 200 });
    assert.equal(withChild.body.post.revision, 3);
    assert.deepEqual((await publicPost(school.id)).photos.map((photo) => photo.id), [p1.id, decorative.id], 'nowa wersja czeka; publiczna zostaje opublikowana');
    await publishFlow(school.id, 3);
    assert.deepEqual((await publicPost(school.id)).photos.map((photo) => photo.id), [p1.id, decorative.id, childPhoto.id]);
    await publicFile(childPhoto.id, 'web', 200);
    const consentWithdraw = '/api/news-photo-consents/zgoda-dok-0001/withdraw';
    const withdrawnConsent = await client.call('POST', consentWithdraw, { cookie: A, expect: 200 });
    assert.deepEqual(withdrawnConsent.body, { replayed: false, affectedPhotos: 1 });
    assert.deepEqual((await client.call('POST', consentWithdraw, { cookie: A, expect: 200 })).body, { replayed: true, affectedPhotos: 1 });
    assert.deepEqual((await publicPost(school.id)).photos.map((photo) => photo.id), [p1.id, decorative.id], 'wycofana zgoda ukrywa zdjęcie');
    assert.equal((await publicFile(childPhoto.id, 'web', 404)).body.error, 'photo_not_found');
    assert.equal((await client.call('POST', '/api/news-photo-consents/zgoda-brak/withdraw', { cookie: A, expect: 404 })).body.error, 'consent_not_found');
    assert.equal((await client.call('POST', '/api/news-photo-consents/%21/withdraw', { cookie: A, expect: 400 })).body.error, 'invalid_consent');

    const revokePath = `/api/news-photos/${p1.id}/revoke`;
    assert.equal((await client.call('POST', revokePath, { cookie: A, body: { reason: 'ab' }, expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    assert.equal((await client.call('POST', revokePath, { cookie: A, body: { reason: 'Kontakt: rodzic@example.invalid' }, expect: 422 })).body.error, 'personal_data_forbidden');
    await assertRequiredFieldsEnforced(client, A, 'POST', revokePath, { reason: 'Wycofanie zgody autora' }, 'NewsPhotoRevokeRequest');
    const revoked = await client.call('POST', revokePath, { cookie: A, body: { reason: 'Wycofanie zgody autora' }, expect: 200 });
    assert.deepEqual([revoked.body.photo.rightsStatus, revoked.body.photo.revocationReason, revoked.body.replayed], ['revoked', 'Wycofanie zgody autora', false]);
    assert.equal((await client.call('POST', revokePath, { cookie: A, body: { reason: 'Inny powód cofnięcia' }, expect: 200 })).body.replayed, true);
    assert.deepEqual((await publicPost(school.id)).photos.map((photo) => photo.id), [decorative.id], 'cofnięte prawa ukrywają zdjęcie natychmiast');
    assert.equal((await publicFile(p1.id, 'web', 404)).body.error, 'photo_not_found');
    assert.equal((await client.call('POST', `/api/news-photos/${p1.id}/verify`, { cookie: A, body: {}, expect: 409 })).body.error, 'photo_revoked');
    assert.equal((await upload(p1.id, png, 'image/png', 409)).body.error, 'photo_revoked');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: { revision: 3, title: 'Kiermasz – po cofnięciu zgody' }, expect: 409 })).body.error, 'photo_revoked');
    assert.equal((await client.call('POST', '/api/news', { cookie: A, body: { ...schoolBody, photoIds: [p1.id] }, key: key('news'), expect: 409 })).body.error, 'photo_revoked');
    assert.equal((await client.call('POST', '/api/news-photos/zdjecie-brak/revoke', { cookie: A, body: { reason: 'Brak zdjęcia' }, expect: 404 })).body.error, 'photo_not_found');
    // Zmiana z usunięciem cofniętego zdjęcia przechodzi; publikacja wymaga ponownego zatwierdzenia.
    const cleaned = await client.call('PATCH', base, { cookie: A, body: { revision: 3, photoIds: [decorative.id] }, expect: 200 });
    assert.equal(cleaned.body.post.revision, 4);

    // ---------- Rejestr zdjęć: lista z kursorem ----------
    const allPhotos = await client.call('GET', '/api/news-photos', { cookie: A, expect: 200 });
    assert.deepEqual([allPhotos.body.nextCursor, allPhotos.body.truncated, allPhotos.body.limit], [null, false, 200]);
    assert.doesNotMatch(JSON.stringify(allPhotos.body), /consentDocumentRef/, 'lista bez odwołań do zgód');
    const photoPages = [];
    let photoCursor = null;
    do {
      const page = await client.call('GET', `/api/news-photos?limit=2${photoCursor ? `&cursor=${photoCursor}` : ''}`, { cookie: A, expect: 200 });
      photoPages.push(...page.body.photos.map((photo) => photo.id));
      assert.equal(page.body.truncated, page.body.nextCursor !== null);
      photoCursor = page.body.nextCursor;
    } while (photoCursor);
    assert.deepEqual(photoPages, allPhotos.body.photos.map((photo) => photo.id), 'strony po 2 = ta sama kolejność co jedna strona');
    const revokedOnly = await client.call('GET', '/api/news-photos?status=revoked', { cookie: A, expect: 200 });
    assert.deepEqual(revokedOnly.body.photos.map((photo) => photo.id), [p1.id]);
    const firstPhotoPage = await client.call('GET', '/api/news-photos?status=verified&limit=1', { cookie: A, expect: 200 });
    assert.equal((await client.call('GET', `/api/news-photos?status=pending&cursor=${firstPhotoPage.body.nextCursor}`, { cookie: A, expect: 400 })).body.error, 'invalid_cursor', 'kursor innego filtru');
    for (const [query, code] of [['?status=zly', 'invalid_status'], ['?limit=0', 'invalid_limit'], ['?limit=201', 'invalid_limit'], ['?cursor=%21', 'invalid_cursor']]) {
      assert.equal((await client.call('GET', `/api/news-photos${query}`, { cookie: A, expect: 400 })).body.error, code, query);
    }
    assert.equal((await client.call('GET', '/api/news-photos/%21', { cookie: A, expect: 400 })).body.error, 'invalid_photo_id');
    assert.equal((await client.call('GET', '/api/news-photos/zdjecie-brak', { cookie: A, expect: 404 })).body.error, 'photo_not_found');

    // ---------- Wycofanie wpisu ----------
    await step(R, classPost.id, 'submit', 1);
    assert.equal((await client.call('POST', `/api/news/${classPost.id}/approve`, { cookie: R, body: { revision: 1 }, expect: 403 })).body.error, 'forbidden', 'przedstawiciel nie zatwierdza');
    await step(B, classPost.id, 'approve', 1);
    await step(B, classPost.id, 'publish', 1);
    const classWithdraw = `/api/news/${classPost.id}/withdraw`;
    const withdrawBody = { revision: 1, reason: 'Zmiana terminu wycieczki' };
    assert.equal((await client.call('POST', classWithdraw, { cookie: R, body: withdrawBody, expect: 403 })).body.error, 'forbidden', 'opublikowany wycofuje tylko zarząd');
    assert.equal((await client.call('POST', classWithdraw, { cookie: B, body: { ...withdrawBody, reason: 'ab' }, expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    assert.equal((await client.call('POST', classWithdraw, { cookie: B, body: { ...withdrawBody, reason: 'Kontakt: rodzic@example.invalid' }, expect: 422 })).body.error, 'personal_data_forbidden');
    assert.equal((await client.call('POST', classWithdraw, { cookie: B, body: { ...withdrawBody, revision: 2 }, expect: 409 })).body.error, 'revision_conflict');
    await assertRequiredFieldsEnforced(client, B, 'POST', classWithdraw, withdrawBody, 'NewsPostWithdrawRequest');
    await publicPost(classPost.id);
    const withdrawn = await step(B, classPost.id, 'withdraw', 1, { reason: withdrawBody.reason });
    assert.deepEqual([withdrawn.post.status, withdrawn.post.withdrawalReason, withdrawn.replayed], ['withdrawn', withdrawBody.reason, false]);
    assert.equal((await step(B, classPost.id, 'withdraw', 1, { reason: withdrawBody.reason })).replayed, true);
    assert.equal((await client.call('GET', `/api/public/news/${classPost.id}`, { expect: 404 })).body.error, 'post_not_found', 'wycofany znika publicznie');
    assert.equal((await client.call('PATCH', `/api/news/${classPost.id}`, { cookie: B, body: { revision: 1, title: 'Po wycofaniu' }, expect: 409 })).body.error, 'post_withdrawn');
    assert.equal((await client.call('POST', `/api/news/${classPost.id}/submit`, { cookie: B, body: { revision: 1 }, expect: 409 })).body.error, 'post_withdrawn');
    // Nieopublikowany szkic wycofuje także jego autor-przedstawiciel.
    const repDraft = await createPost(R, { ...classBody, title: 'Szkic do wycofania' });
    assert.equal((await step(R, repDraft.id, 'withdraw', 1, { reason: 'Szkic zbędny' })).post.status, 'withdrawn');

    // ---------- Lista publiczna z kursorem ----------
    for (const title of ['Dzień otwarty', 'Bal karnawałowy', 'Festyn rodzinny']) {
      const post = await createPost(A, { schoolYearId: YEAR, title, body: `Zapowiedź: ${title}.` });
      await publishFlow(post.id, 1);
    }
    const all = await client.call('GET', `/api/public/news?schoolYearId=${YEAR}`, { expect: 200 });
    assert.deepEqual([all.body.posts.length, all.body.nextCursor, all.body.truncated, all.body.limit], [4, null, false, 20]);
    const pages = [];
    let cursor = null;
    do {
      const page = await client.call('GET', `/api/public/news?schoolYearId=${YEAR}&limit=2${cursor ? `&cursor=${cursor}` : ''}`, { expect: 200 });
      pages.push(...page.body.posts.map((post) => post.id));
      assert.equal(page.body.truncated, page.body.nextCursor !== null);
      cursor = page.body.nextCursor;
    } while (cursor);
    assert.deepEqual(pages, all.body.posts.map((post) => post.id), 'strony po 2 = ta sama kolejność co jedna strona');
    const firstPage = await client.call('GET', `/api/public/news?schoolYearId=${YEAR}&limit=2`, { expect: 200 });
    assert.equal((await client.call('GET', `/api/public/news?limit=2&cursor=${firstPage.body.nextCursor}`, { expect: 400 })).body.error, 'invalid_cursor', 'kursor innego filtru');
    assert.deepEqual((await client.call('GET', `/api/public/news?schoolYearId=${NEXT}`, { expect: 200 })).body.posts, []);
    const publicErrors = [
      ['?limit=0', 'invalid_limit'], ['?limit=51', 'invalid_limit'], ['?limit=100', 'invalid_limit'], ['?limit=abc', 'invalid_limit'],
      ['?cursor=%21%21', 'invalid_cursor'], ['?schoolYearId=%21', 'invalid_school_year'], ['?schoolYearId=', 'invalid_school_year'],
    ];
    for (const [query, code] of publicErrors) {
      assert.equal((await client.call('GET', `/api/public/news${query}`, { expect: 400 })).body.error, code, query);
    }

    // ---------- Publiczny plik: naruszona integralność i brak magazynu ----------
    const { rows: [decorativeWeb] } = await db.query("SELECT object_key FROM news_photo_files WHERE photo_id = $1 AND variant = 'web'", [decorative.id]);
    await storage.putObject(decorativeWeb.object_key, await syntheticImage('jpeg', 250), 'image/jpeg');
    assert.equal((await publicFile(decorative.id, 'web', 409)).body.error, 'photo_file_integrity_mismatch');
    assert.equal((await noStorage.call('GET', `/api/public/news-photos/${decorative.id}/thumb`, { expect: 503 })).body.error, 'service_unavailable');
    merge(noStorage);

    // ---------- Granice ról ----------
    const repBPost = await createPost(cookies.repB, { ...classBody, classId: 'c-1b', title: 'Wycieczka klasy 1B' });
    const reads = [`/api/news?schoolYearId=${YEAR}`, base, '/api/news-photos', `/api/news-photos/${decorative.id}`];
    for (const path of reads) {
      await client.call('GET', path, { expect: 401 });
      assert.equal((await client.call('GET', path, { cookie: cookies.boardNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required', path);
    }
    // Przedstawiciel 1A: wpis ogólnoszkolny i klasy 1B jak nieistniejące (SR-07); rejestr zdjęć — 403.
    for (const path of [base, `/api/news/${repBPost.id}`]) {
      assert.equal((await client.call('GET', path, { cookie: R, expect: 404 })).body.error, 'post_not_found', path);
    }
    // Zarząd z przydziałem klasy, Komisja Rewizyjna, dyrekcja, skarbnik: bez dostępu (D-08/D-09).
    for (const cookie of [cookies.boardClass, cookies.audit, cookies.principal, cookies.treasurer]) {
      assert.equal((await client.call('GET', `/api/news?schoolYearId=${YEAR}`, { cookie, expect: 403 })).body.error, 'forbidden');
      assert.equal((await client.call('GET', base, { cookie, expect: 404 })).body.error, 'post_not_found');
    }
    for (const cookie of [R, cookies.boardClass, cookies.audit, cookies.principal, cookies.treasurer]) {
      for (const path of ['/api/news-photos', `/api/news-photos/${decorative.id}`]) {
        assert.equal((await client.call('GET', path, { cookie, expect: 403 })).body.error, 'forbidden', path);
      }
    }
    const currentRevision = (await client.call('GET', base, { cookie: A, expect: 200 })).body.post.revision;
    const writes = [
      ['POST', '/api/news', { ...schoolBody, photoIds: [], title: 'Wpis spoza zakresu' }, true, 403, 'forbidden'],
      ['PATCH', base, { revision: currentRevision, title: 'Zmiana spoza zakresu' }, false, 404, 'post_not_found'],
      ['POST', `${base}/submit`, { revision: currentRevision }, false, 404, 'post_not_found'],
      ['POST', `${base}/approve`, { revision: currentRevision }, false, 404, 'post_not_found'],
      ['POST', `${base}/publish`, { revision: currentRevision }, false, 404, 'post_not_found'],
      ['POST', `${base}/withdraw`, { revision: currentRevision, reason: 'Wycofanie spoza zakresu' }, false, 404, 'post_not_found'],
      ['POST', '/api/news-photos', photoBody(), true, 403, 'forbidden'],
      ['POST', `/api/news-photos/${ownPhoto.id}/consents`, { subjectNo: 1, subjectKind: 'adult', consentDocumentRef: 'zgoda-dok-0003' }, false, 403, 'forbidden'],
      ['POST', `/api/news-photos/${ownPhoto.id}/verify`, {}, false, 403, 'forbidden'],
      ['POST', `/api/news-photos/${ownPhoto.id}/revoke`, { reason: 'Cofnięcie spoza zakresu' }, false, 403, 'forbidden'],
      ['POST', '/api/news-photo-consents/zgoda-druk-0001/withdraw', undefined, false, 403, 'forbidden'],
    ];
    for (const [method, path, body, keyed, denied, code] of writes) {
      const withKey = () => (keyed ? key('deny') : undefined);
      await client.call(method, path, { body, key: withKey(), expect: 401 });
      // Przedstawiciel widzi tylko wpisy swojej klasy (wpis ogólnoszkolny → 404, utworzenie → 403); zdjęcia → 403.
      for (const cookie of [R, cookies.boardClass, cookies.audit, cookies.principal, cookies.treasurer]) {
        const response = await client.call(method, path, { cookie, body, key: withKey(), expect: denied });
        assert.equal(response.body.error, code, `${method} ${path}`);
      }
      assert.equal((await client.call(method, path, { cookie: cookies.boardNoMfa, body, key: withKey(), expect: 403 })).body.error, 'mfa_enrollment_required', path);
      assert.equal((await client.call(method, path, { cookie: A, body, key: withKey(), expect: 403, origin: FOREIGN })).body.error, 'invalid_origin', path);
    }
    for (const cookie of [cookies.boardClass, cookies.audit, cookies.principal, cookies.treasurer]) {
      assert.equal((await upload(ownPhoto.id, png, 'image/png', 403, key('file'), cookie)).body.error, 'forbidden');
    }
    await client.call('POST', `/api/news-photos/${ownPhoto.id}/file`, { body: png, key: key('file'), headers: { 'Content-Type': 'image/png' }, expect: 401 });
    assert.equal((await client.call('POST', `/api/news-photos/${ownPhoto.id}/file`, {
      cookie: ADM, body: png, key: key('file'), headers: { 'Content-Type': 'image/png' }, expect: 403, origin: FOREIGN,
    })).body.error, 'invalid_origin');
    // Wymóg MFA modułu (#150), gdy bramka routera nie wymaga zapisu czynnika (MFA_REQUIRED_ROLES puste):
    // szkic i zgłoszenie bez MFA działają, zatwierdzenie i publikacja — 403 mfa_required.
    const noGate = newClient({ ...env, MFA_REQUIRED_ROLES: '' });
    const noMfaPost = (await noGate.call('POST', '/api/news', { cookie: cookies.boardNoMfa, body: { ...schoolBody, photoIds: [], title: 'Szkic bez MFA' }, key: key('news'), expect: 201 })).body.post;
    await noGate.call('POST', `/api/news/${noMfaPost.id}/submit`, { cookie: cookies.boardNoMfa, body: { revision: 1 }, expect: 200 });
    for (const action of ['approve', 'publish']) {
      assert.equal((await noGate.call('POST', `/api/news/${noMfaPost.id}/${action}`, { cookie: cookies.boardNoMfa, body: { revision: 1 }, expect: 403 })).body.error, 'mfa_required', action);
    }
    merge(noGate);

    // ---------- Błędy 400/404/413/415 ----------
    assert.equal((await client.call('GET', '/api/news/%21', { cookie: A, expect: 400 })).body.error, 'invalid_post_id');
    assert.equal((await client.call('GET', '/api/news/wpis-brak', { cookie: A, expect: 404 })).body.error, 'post_not_found');
    assert.equal((await client.call('PATCH', '/api/news/wpis-brak', { cookie: A, body: { revision: 1, title: 'Brak wpisu' }, expect: 404 })).body.error, 'post_not_found');
    assert.equal((await client.call('POST', '/api/news/%21/submit', { cookie: A, body: { revision: 1 }, expect: 400 })).body.error, 'invalid_post_id');
    assert.equal((await client.call('POST', '/api/news-photos/%21/verify', { cookie: A, body: {}, expect: 400 })).body.error, 'invalid_photo_id');
    assert.equal((await client.call('POST', '/api/news-photos/zdjecie-brak/verify', { cookie: A, body: {}, expect: 404 })).body.error, 'photo_not_found');
    const json = { 'Content-Type': 'application/json' };
    assert.equal((await client.call('POST', '/api/news', { cookie: A, headers: json, body: '{"title":', key: key('news'), expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', `/api/news-photos/${ownPhoto.id}/verify`, { cookie: A, headers: json, body: '', expect: 400, invalidRequest: true })).body.error, 'invalid_json', 'weryfikacja wymaga ciała `{}`');
    assert.equal((await client.call('POST', '/api/news', {
      cookie: A, body: { ...schoolBody, photoIds: [], body: 'x'.repeat(70 * 1024) }, key: key('news'), expect: 413, invalidRequest: true,
    })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', '/api/news-photos', { cookie: ADM, body: 'author=x', key: key('photo'), expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('PATCH', base, { cookie: A, body: 'title=x', expect: 415, invalidRequest: true })).body.error, 'invalid_content_type');

    // ---------- Zamknięty rok: zamknięcie przez trasy year-close, potem 409 dla nowego wpisu ----------
    // Trigger a0_year_freeze (0130) blokuje wyłącznie nowy wpis zamkniętego roku; zmiana, przebieg i wycofanie istniejącego
    // wpisu zostają możliwe (wycofanie publikacji, np. po wycofaniu zgody na wizerunek, musi działać zawsze). Zdjęcia nie
    // należą do roku. Zamknięcie wygasza przydziały roku, więc zapisy próbuje zarząd z przydziałem bez roku.
    await closeYear(env, cookies);
    const G = cookies.boardGlobal;
    assert.equal((await client.call('POST', '/api/news', { cookie: G, body: { ...schoolBody, photoIds: [] }, key: key('closed'), expect: 409 })).body.error, 'school_year_closed');
    const lateEdit = await client.call('PATCH', base, { cookie: G, body: { revision: currentRevision, title: 'Kiermasz – wersja archiwalna' }, expect: 200 });
    assert.equal(lateEdit.body.post.revision, currentRevision + 1);
    const lateWithdraw = await step(G, school.id, 'withdraw', currentRevision + 1, { reason: 'Wycofanie po zamknięciu roku' });
    assert.equal(lateWithdraw.post.status, 'withdrawn');
    assert.equal((await client.call('GET', `/api/public/news/${school.id}`, { expect: 404 })).body.error, 'post_not_found');
    assert.equal((await client.call('GET', `/api/public/news?schoolYearId=${YEAR}`, { expect: 200 })).body.posts.length, 3, 'archiwum zamkniętego roku nadal działa');
    await register(G, { author: 'Fotograf po zamknięciu' });
    assert.equal((await client.call('GET', `/api/news?schoolYearId=${YEAR}`, { cookie: A, expect: 403 })).body.error, 'forbidden', 'przydział roku wygasł');

    assert.equal(networkGuardCalls(), 0, 'żadnej próby połączenia z siecią');
    assertSuccessCoverage(validated);
  } finally {
    resetUploadSlotsForTests();
    await db.close();
  }
});
