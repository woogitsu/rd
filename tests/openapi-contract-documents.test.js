// Kontrakt API (#160, etap 8): prawdziwe odpowiedzi modułu `documents` (PGlite, magazyn plików w pamięci
// `createMemoryStorage`, pliki i dane syntetyczne) walidowane schematami z docs/openapi.json
// (src/pg/schemas/documents.js) przez tests/helpers/contract-client.js. Rejestr pokrycia i katalog kodów
// sprawdza tests/openapi-contract.test.js (wspólnie dla wszystkich pokrytych modułów).
//
// ŻADNEJ SIECI: bucket to atrapa w pamięci, a globalna pułapka sieci (tests/helpers/network-guard.js) liczy próby
// połączeń — licznik musi być 0.
//
// Macierz tras rozdziela `/api/documents/{id}` na cztery rodzaje (`{financialDocumentId}`, `{boardDocumentId}`,
// `{classDocumentId}`, `{council_sharedDocumentId}`), więc odczyty i zapisy dokumentu wskazują szablon operacji wprost
// (opcja `template` klienta kontraktu), a schemat metadanych przypina `document.kind` do rodzaju ścieżki.
//
// Przebieg: przesłanie surowych bajtów (PDF, PNG, JPEG) każdego rodzaju z ponowieniem klucza i konfliktem, dowody
// powiązane z wpisem księgi i wpłatą, walidacja pliku (413/415/400, aktywna treść i uszkodzony plik), lista z filtrami
// i kursorem, metadane z historią opisu, treść po autoryzacji każdego żądania (pobranie, podgląd obrazu inline, bajty
// PDF z `purpose=preview`, PDF inline → 400, plik niezgodny z bieżącymi regułami → 409, brak obiektu → 409, niezgodna
// suma → 503, wygasła sesja → 401), opis z wersjami, zastąpienie i unieważnienie z ponowieniem i konfliktami, granice
// ról (401; przedstawiciel klasy wobec dokumentu zarządu i innej klasy; zarząd z przydziałem klasy; Komisja Rewizyjna
// z flagą AUDIT_LEDGER_READ i bez niej; dyrekcja; brak MFA w bramce routera i w module; obcy Origin) oraz zamknięty rok
// osiągnięty trasami year-close (bez obchodzenia triggerów).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { DOCUMENT_VALIDATION_VERSION, tryAcquireUploadSlot } from '../src/documents.js';
import { createMemoryStorage, sha256Hex } from '../src/storage.js';
import { OPENAPI_PATH } from '../scripts/build-openapi.js';
import { ROUTE_SCHEMAS } from '../src/pg/schemas/index.js';
import { createContractClient } from './helpers/contract-client.js';
import {
  createTestDb, networkGuardCalls, request, seedClass, seedSchoolYear, seedUserSession,
} from './helpers/pg.js';
import { syntheticJpeg, syntheticPng } from './helpers/synthetic-images.js';

const spec = JSON.parse(await readFile(OPENAPI_PATH, 'utf8'));
const components = spec.components.schemas;

const YEAR = 'y-2026';
const NEXT = 'y-2027';
const KINDS = ['financial', 'board', 'class', 'council_shared'];
const TYPES = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg' };
const encoder = new TextEncoder();
const pdfBytes = (marker) => encoder.encode(`%PDF-1.4\n% syntetyczny dokument ${marker}\n1 0 obj <<>> endobj\n%%EOF\n`);
const BYTES = { pdf: pdfBytes('kontrakt'), png: syntheticPng(), jpeg: syntheticJpeg() };
const ACTIVE_PDF = encoder.encode('%PDF-1.4\n1 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj\n%%EOF\n');
const MALFORMED_PDF = encoder.encode('%PDF-1.4\n% syntetyczny dokument bez znacznika konca\n');
const HTML = encoder.encode('<html><script>alert(1)</script></html>');
const FOREIGN = 'https://obcy.example.invalid';

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;
// Szablon operacji dla rodzaju dokumentu (macierz tras ma osobną ścieżkę na rodzaj).
const tpl = (kind, suffix = '') => `/api/documents/{${kind}DocumentId}${suffix}`;

function newClient(env) {
  return createContractClient({ spec, fetch: (req) => handlePgRequest(req, env) });
}

// Każda odpowiedź sukcesu opisana w schemacie modułu (także każdy typ treści pliku) została zwalidowana.
function assertSuccessCoverage(validated) {
  const expected = [];
  for (const [routeId, entry] of ROUTE_SCHEMAS) {
    if (entry.module !== 'documents') continue;
    for (const [status, response] of Object.entries(entry.responses)) {
      expected.push(`${routeId} ${status}`);
      for (const type of Object.keys(response.content ?? {})) expected.push(`${routeId} ${status} ${type}`);
    }
  }
  assert.ok(expected.length >= 47, `oczekiwane odpowiedzi: ${expected.length}`);
  assert.deepEqual(expected.filter((item) => !validated.has(item)), [], 'odpowiedzi sukcesu opisane w schemacie bez walidacji na prawdziwej odpowiedzi');
}

// Pominięcie każdego wymaganego pola ciała daje błąd i w schemacie, i na serwerze (400).
async function assertRequiredFieldsEnforced(client, cookie, path, template, validBody, componentName) {
  const requiredFields = components[componentName].required;
  assert.ok(requiredFields.length > 0, `${componentName}: schemat ma wymagane pola`);
  for (const field of requiredFields) {
    const { [field]: omitted, ...body } = validBody;
    assert.notEqual(omitted, undefined, `${field}: ciało testowe ma to pole`);
    const response = await client.call('POST', path, { cookie, body, key: key('req'), template, expect: 400, invalidRequest: true });
    assert.equal(typeof response.body.error, 'string', `${componentName}.${field}: kod błędu`);
  }
}

async function world() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  const year = (role, extra = {}) => [{ role, schoolYearId: YEAR, ...extra }];
  const both = (role) => [{ role, schoolYearId: YEAR }, { role, schoolYearId: NEXT }];
  const cookies = {
    boardA: await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: both('board') }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', mfa: true, roles: both('board') }),
    // Przydział zarządu bez roku: zapisy po zamknięciu roku (przydziały roku wygasają przy zamknięciu).
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', mfa: true, roles: [{ role: 'board' }] }),
    boardClass: await seedUserSession(db, { userId: 'u-board-class', mfa: true, roles: year('board', { classId: 'c-1a' }) }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', mfa: false, roles: year('board') }),
    boardEnrolled: await seedUserSession(db, { userId: 'u-board-enrolled', mfa: false, roles: year('board') }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: year('treasurer') }),
    repA: await seedUserSession(db, { userId: 'u-rep-a', mfa: false, roles: year('representative', { classId: 'c-1a' }) }),
    repB: await seedUserSession(db, { userId: 'u-rep-b', mfa: false, roles: year('representative', { classId: 'c-1b' }) }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: year('audit') }),
    auditNoMfa: await seedUserSession(db, { userId: 'u-audit-nomfa', mfa: false, roles: year('audit') }),
    principal: await seedUserSession(db, { userId: 'u-principal', mfa: false, roles: year('principal') }),
    expired: await seedUserSession(db, {
      userId: 'u-treasurer-expired', mfa: true, roles: year('treasurer'), expiresAt: Date.now() - 60 * 1000, createdAt: Date.now() - 2 * 60 * 60 * 1000,
    }),
  };
  // Konto z potwierdzonym czynnikiem MFA, sesja bez potwierdzenia → bramka routera `mfa_required` (wartości syntetyczne).
  await db.query(
    `INSERT INTO user_mfa_factors (id, user_id, method, secret_ciphertext, secret_iv, secret_tag, confirmed_at)
     VALUES ($1, 'u-board-enrolled', 'totp', 'AAAA', $2, $3, now())`,
    [crypto.randomUUID(), 'A'.repeat(16), 'A'.repeat(22)],
  );
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-exp', $1, 'expense', 'Wydarzenia', 'u-treasurer')`, [YEAR]);
  await db.query("INSERT INTO households (id) VALUES ('h-1')");
  await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
    VALUES ('pay-1', 'h-1', $1, 5000, '2026-09-20', 'bank', 'recorded', 'u-treasurer', 'seed-payment-doc-0001')`, [YEAR]);
  const storage = createMemoryStorage();
  // Flaga Komisji Rewizyjnej włączona w głównym środowisku; drugi klient ma ją wyłączoną (ta sama baza i magazyn).
  const env = { db, storage, APP_ENV: 'test', AUDIT_LEDGER_READ: '1', MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  return { db, env, storage, cookies, client: newClient(env) };
}

// Wywołanie poza kontraktem (konfiguracja świata: wpis księgi, zamknięcie roku).
async function raw(env, path, { cookie, method = 'GET', body, headers } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
  return { status: response.status, body: await response.json() };
}

// Zamknięcie roku przez trasy zamknięcia (lista kontrolna, druga osoba zarządu) — bez obchodzenia triggerów.
async function closeYear(env, cookies) {
  const post = (path, cookie, body) => raw(env, path, { method: 'POST', cookie, body });
  const started = await post(`/api/year-close/${YEAR}/start`, cookies.boardA, { nextSchoolYearId: NEXT });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  for (const item of CHECKLIST_ITEMS) {
    assert.equal((await post(`/api/year-close/${YEAR}/checklist/${item}`, cookies.boardA, { note: `Potwierdzenie ${item}` })).status, 201);
  }
  const closed = await post(`/api/year-close/${YEAR}/close`, cookies.boardB, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
}

// Dokument „sprzed kontroli struktury” (wiersz i obiekt zapisane z pominięciem trasy, jak dane przywrócone), z poprawnym skrótem.
async function insertLegacyDocument(db, storage, bytes) {
  const id = crypto.randomUUID();
  const objectKey = `docs/${crypto.randomUUID()}`;
  await storage.putObject(objectKey, bytes, 'application/pdf');
  await db.query(
    `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
     VALUES ($1, $2, 'application/pdf', $3, 'financial', 'u-treasurer', $4, $5, $6)`,
    [id, objectKey, bytes.length, YEAR, sha256Hex(bytes), `legacy-${id}`],
  );
  return id;
}

const objectKeyOf = async (db, id) => (await db.query('SELECT object_key FROM documents WHERE id = $1', [id])).rows[0].object_key;

test('specyfikacja dokumentów: przesłanie jako surowe bajty, treść jako plik bez schematu JSON, ponowienie polem replayed', () => {
  const upload = spec.paths['/api/documents'].post;
  assert.deepEqual(Object.keys(upload.requestBody.content).sort(), Object.values(TYPES).sort());
  assert.equal(upload.requestBody.content['application/json'], undefined, 'przesłanie nie jest JSON-em');
  assert.ok(upload.parameters.some((p) => p.in === 'header' && p.name === 'Idempotency-Key' && p.required === true));
  for (const kind of KINDS) {
    const content = spec.paths[tpl(kind, '/content')].get.responses['200'].content;
    assert.deepEqual(Object.keys(content).sort(), Object.values(TYPES).sort(), kind);
    for (const media of Object.values(content)) assert.deepEqual(media.schema, { type: 'string', format: 'binary' });
    for (const suffix of ['/description', '/supersede', '/void']) {
      const op = spec.paths[tpl(kind, suffix)].post;
      assert.ok(op.parameters.some((p) => p.in === 'header' && p.name === 'Idempotency-Key' && p.required === true), `${kind}${suffix}`);
      for (const status of ['200', '201']) {
        assert.equal(op.responses[status].headers, undefined, `${kind}${suffix} ${status}: bez nagłówka Idempotency-Replayed`);
      }
    }
  }
  // Kontrola pozytywna klienta: ciało binarne z nieopisanym typem treści jest błędem przed wysłaniem żądania.
  const client = newClient({});
  return assert.rejects(client.call('POST', '/api/documents?kind=board&schoolYearId=y', {
    body: HTML, headers: { 'Content-Type': 'text/html' }, expect: 415,
  }), /typ treści żądania „text\/html” nie jest opisany/);
});

test('kontrakt dokumentów: prawdziwe odpowiedzi documents zgodne ze schematami (PGlite, magazyn w pamięci)', async () => {
  const { db, env, storage, cookies, client } = await world();
  const validated = client.validated;
  const merge = (other) => { for (const item of other.validated) validated.add(item); };
  const { boardA: A, treasurer: T, repA, repB } = cookies;
  const uploadPath = (kind, extra = '') => `/api/documents?kind=${kind}&schoolYearId=${YEAR}${kind === 'class' ? '&classId=c-1a' : ''}${extra}`;
  const writer = { financial: T, board: A, class: repA, council_shared: A };
  const reader = { financial: T, board: A, class: repA, council_shared: repB };
  const upload = async (kind, type = 'pdf', { cookie = writer[kind], bytes = BYTES[type], extra = '', idempotencyKey = key('doc'), expect = 201 } = {}) => (
    client.call('POST', uploadPath(kind, extra), {
      cookie, body: bytes, key: idempotencyKey, headers: { 'Content-Type': TYPES[type] }, expect,
    }));
  try {
    // ---------- Przesłanie: każdy rodzaj i typ pliku, ponowienie klucza, konflikt ----------
    const docs = {};
    for (const kind of KINDS) {
      docs[kind] = {};
      for (const type of Object.keys(TYPES)) {
        const created = await upload(kind, type);
        assert.equal(created.headers.get('Idempotency-Replayed'), null);
        assert.deepEqual([created.body.document.kind, created.body.document.mimeType, created.body.document.status], [kind, TYPES[type], 'active']);
        assert.equal(created.body.document.validationVersion, DOCUMENT_VALIDATION_VERSION);
        docs[kind][type] = created.body.document.id;
      }
      // Dwa dodatkowe PDF do zastąpienia (ten sam rodzaj, rok i klasa).
      docs[kind].old = (await upload(kind)).body.document.id;
      docs[kind].next = (await upload(kind)).body.document.id;
    }
    assert.equal((await db.query('SELECT class_id FROM documents WHERE id = $1', [docs.class.pdf])).rows[0].class_id, 'c-1a');
    const replayKey = key('doc');
    const first = await upload('board', 'pdf', { idempotencyKey: replayKey });
    const replay = await upload('board', 'pdf', { idempotencyKey: replayKey, expect: 200 });
    assert.deepEqual([replay.body.replayed, replay.body.document.id], [true, first.body.document.id]);
    assert.equal(replay.headers.get('Idempotency-Replayed'), null, 'ponowienie sygnalizuje pole replayed, nie nagłówek');
    assert.equal((await upload('board', 'png', { idempotencyKey: replayKey, expect: 409 })).body.error, 'idempotency_conflict');
    const objectsBefore = storage.keys().length;
    await upload('board', 'pdf', { idempotencyKey: replayKey, expect: 200 });
    assert.equal(storage.keys().length, objectsBefore, 'ponowienie nie zapisuje drugiego obiektu');

    // Odpowiedzi nie ujawniają klucza obiektu w buckecie ani adresu do niego (dostęp wyłącznie przez serwer).
    assert.doesNotMatch(JSON.stringify(first.body), /docs\/|https?:/);

    // ---------- Dowody księgi i wpłaty ----------
    const entry = await raw(env, '/api/ledger', {
      method: 'POST', cookie: T, headers: { 'Idempotency-Key': key('led') },
      body: { schoolYearId: YEAR, direction: 'expense', amountCents: 12000, categoryId: 'cat-exp', description: 'Wydatek syntetyczny', occurredOn: '2026-10-02', method: 'bank' },
    });
    assert.equal(entry.status, 201, JSON.stringify(entry.body));
    const ledgerEvidence = (await upload('financial', 'pdf', { extra: `&linkedEntityType=ledger_entry&linkedEntityId=${entry.body.entry.id}` })).body.document;
    assert.deepEqual([ledgerEvidence.linkedEntityType, ledgerEvidence.linkedEntityId], ['ledger_entry', entry.body.entry.id]);
    const paymentEvidence = (await upload('financial', 'pdf', { extra: '&linkedEntityType=payment_entry&linkedEntityId=pay-1' })).body.document;
    assert.equal(paymentEvidence.linkedEntityType, 'payment_entry');
    assert.equal((await upload('financial', 'pdf', { extra: '&linkedEntityType=ledger_entry&linkedEntityId=brak-wpisu', expect: 400 })).body.error, 'invalid_link');
    assert.equal((await upload('financial', 'pdf', { extra: '&linkedEntityType=ledger_entry', expect: 400 })).body.error, 'invalid_link');
    assert.equal((await upload('board', 'pdf', { extra: '&linkedEntityType=payment_entry&linkedEntityId=pay-1', expect: 400 })).body.error, 'invalid_link');

    // ---------- Walidacja pliku i parametrów przesłania ----------
    const badUpload = (path, options) => client.call('POST', path, { cookie: A, key: key('doc'), ...options });
    assert.equal((await badUpload(`/api/documents?kind=inny&schoolYearId=${YEAR}`, { body: BYTES.pdf, headers: { 'Content-Type': TYPES.pdf }, expect: 400 })).body.error, 'invalid_kind');
    assert.equal((await badUpload('/api/documents?kind=board&schoolYearId=%21', { body: BYTES.pdf, headers: { 'Content-Type': TYPES.pdf }, expect: 400 })).body.error, 'invalid_school_year');
    assert.equal((await badUpload(`/api/documents?kind=class&schoolYearId=${YEAR}`, { body: BYTES.pdf, headers: { 'Content-Type': TYPES.pdf }, expect: 400 })).body.error, 'invalid_class');
    assert.equal((await badUpload(`/api/documents?kind=class&schoolYearId=${YEAR}&classId=c-brak`, { body: BYTES.pdf, headers: { 'Content-Type': TYPES.pdf }, expect: 400 })).body.error, 'invalid_class');
    assert.equal((await client.call('POST', uploadPath('board'), { cookie: A, body: BYTES.pdf, headers: { 'Content-Type': TYPES.pdf }, expect: 400 })).body.error, 'idempotency_key_required');
    assert.equal((await badUpload(uploadPath('board'), { body: new Uint8Array(0), headers: { 'Content-Type': TYPES.pdf }, expect: 400 })).body.error, 'empty_document');
    // Typ spoza listy (HTML) i sygnatura niezgodna z nagłówkiem: 415 bez zapisu.
    assert.equal((await badUpload(uploadPath('board'), { body: HTML, headers: { 'Content-Type': 'text/html' }, expect: 415, invalidRequest: true })).body.error, 'unsupported_media_type');
    assert.equal((await badUpload(uploadPath('board'), { body: BYTES.png, headers: { 'Content-Type': TYPES.pdf }, expect: 415 })).body.error, 'unsupported_media_type');
    assert.equal((await badUpload(uploadPath('board'), { body: ACTIVE_PDF, headers: { 'Content-Type': TYPES.pdf }, expect: 415 })).body.error, 'document_active_content');
    assert.equal((await badUpload(uploadPath('board'), { body: MALFORMED_PDF, headers: { 'Content-Type': TYPES.pdf }, expect: 415 })).body.error, 'document_malformed');
    // Limit rozmiaru (DOCUMENT_MAX_BYTES) liczony przez trasę podczas odczytu ciała.
    const small = newClient({ ...env, documentMaxBytes: 32 });
    assert.equal((await small.call('POST', uploadPath('board'), {
      cookie: A, body: BYTES.pdf, key: key('doc'), headers: { 'Content-Type': TYPES.pdf }, expect: 413,
    })).body.error, 'document_too_large');
    merge(small);
    // Brak magazynu i zajęte miejsca uploadu: 503 bez odczytu ciała.
    const noStorage = newClient({ ...env, storage: undefined });
    assert.equal((await noStorage.call('POST', uploadPath('board'), {
      cookie: A, body: BYTES.pdf, key: key('doc'), headers: { 'Content-Type': TYPES.pdf }, expect: 503,
    })).body.error, 'storage_unavailable');
    const busy = newClient({ ...env, maxConcurrentUploads: 1 });
    const release = tryAcquireUploadSlot(1, 'u-inna-osoba');
    assert.ok(release, 'test zajmuje jedyne miejsce uploadu');
    try {
      const refused = await busy.call('POST', uploadPath('board'), {
        cookie: A, body: BYTES.pdf, key: key('doc'), headers: { 'Content-Type': TYPES.pdf }, expect: 503,
      });
      assert.deepEqual([refused.body.error, refused.headers.get('Retry-After')], ['upload_busy', '2']);
    } finally {
      release();
    }
    merge(busy);

    // ---------- Lista z filtrami i kursorem ----------
    const listPath = (query = '') => `/api/documents?schoolYearId=${YEAR}${query}`;
    const everything = await client.call('GET', listPath('&limit=100'), { cookie: A, expect: 200 });
    assert.deepEqual([everything.body.nextCursor, everything.body.truncated], [null, false]);
    const pagedIds = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await client.call('GET', listPath(`&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), { cookie: A, expect: 200 });
      pagedIds.push(...page.body.documents.map((doc) => doc.id));
      assert.equal(page.body.truncated, page.body.nextCursor !== null);
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor);
    assert.ok(pages > 2, `stron: ${pages}`);
    assert.deepEqual(pagedIds, everything.body.documents.map((doc) => doc.id), 'kursor przechodzi tę samą listę bez powtórzeń');
    const kinds = new Set(everything.body.documents.map((doc) => doc.kind));
    assert.deepEqual([...kinds].sort(), [...KINDS].sort(), 'zarząd z MFA widzi wszystkie rodzaje');
    const onlyClass = await client.call('GET', listPath('&kind=class&classId=c-1a&status=all'), { cookie: A, expect: 200 });
    assert.ok(onlyClass.body.documents.length >= 5 && onlyClass.body.documents.every((doc) => doc.kind === 'class' && doc.classId === 'c-1a'));
    const offsetPage = await client.call('GET', listPath('&limit=2&offset=2'), { cookie: A, expect: 200 });
    assert.deepEqual(offsetPage.body.documents.map((doc) => doc.id), everything.body.documents.slice(2, 4).map((doc) => doc.id));
    assert.equal(offsetPage.body.offset, 2);
    for (const [query, code] of [
      ['&kind=inny', 'invalid_kind'], ['&classId=%21', 'invalid_class'], ['&status=usuniete', 'invalid_status'],
      ['&category=paragon', 'invalid_category'], ['&from=2026-02-30', 'invalid_document_date'], ['&from=2026-12-01&to=2026-11-01', 'invalid_request'],
      ['&sort=title', 'invalid_request'], ['&validation=all', 'invalid_request'], [`&q=${'x'.repeat(201)}`, 'invalid_request'],
      ['&limit=0', 'invalid_limit'], ['&limit=101', 'invalid_limit'], ['&cursor=%21%21', 'invalid_cursor'],
      ['&sort=documentDate&cursor=abc', 'invalid_request'],
    ]) {
      assert.equal((await client.call('GET', listPath(query), { cookie: A, expect: 400 })).body.error, code, query);
    }
    assert.equal((await client.call('GET', '/api/documents', { cookie: A, expect: 400 })).body.error, 'invalid_school_year');
    const otherFilterCursor = (await client.call('GET', listPath('&limit=1'), { cookie: A, expect: 200 })).body.nextCursor;
    assert.equal((await client.call('GET', listPath(`&kind=board&limit=1&cursor=${encodeURIComponent(otherFilterCursor)}`), { cookie: A, expect: 400 })).body.error, 'invalid_cursor');

    // ---------- Opis z wersjami (każdy rodzaj), wyszukiwanie i filtry po opisie ----------
    for (const kind of KINDS) {
      const path = `/api/documents/${docs[kind].pdf}/description`;
      const body = { title: `Dokument syntetyczny ${kind}`, category: kind === 'financial' ? 'faktura' : 'protokol', documentDate: '2026-10-15' };
      const descKey = key('desc');
      const created = await client.call('POST', path, { cookie: writer[kind], body, key: descKey, template: tpl(kind, '/description'), expect: 201 });
      assert.deepEqual([created.body.description.revisionNo, created.body.description.description], [1, null]);
      const again = await client.call('POST', path, { cookie: writer[kind], body, key: descKey, template: tpl(kind, '/description'), expect: 200 });
      assert.deepEqual([again.body.replayed, again.body.description.revisionNo], [true, 1]);
      const second = await client.call('POST', path, {
        cookie: writer[kind], key: key('desc'), template: tpl(kind, '/description'), expect: 201,
        body: { ...body, title: `Dokument syntetyczny ${kind} (wersja 2)`, description: 'Opis syntetyczny dokumentu', documentDate: null },
      });
      assert.equal(second.body.description.revisionNo, 2);
      assert.equal((await client.call('POST', path, {
        cookie: writer[kind], body: { ...body, title: 'Inny tytuł syntetyczny' }, key: descKey, template: tpl(kind, '/description'), expect: 409,
      })).body.error, 'idempotency_conflict');
    }
    const searched = await client.call('GET', listPath('&q=wersja%202&category=faktura'), { cookie: A, expect: 200 });
    assert.deepEqual(searched.body.documents.map((doc) => doc.id), [docs.financial.pdf]);
    assert.deepEqual([searched.body.documents[0].title, searched.body.documents[0].documentDate], ['Dokument syntetyczny financial (wersja 2)', null]);
    // Opis z datą dokumentu: filtr dat i sortowanie po dacie (bez kursora, stronicuje offset).
    await client.call('POST', `/api/documents/${docs.board.png}/description`, {
      cookie: A, key: key('desc'), template: tpl('board', '/description'), expect: 201,
      body: { title: 'Protokół syntetyczny z datą', category: 'protokol', documentDate: '2026-11-05' },
    });
    const dated = await client.call('GET', listPath('&from=2026-11-01&to=2026-11-30'), { cookie: A, expect: 200 });
    assert.deepEqual(dated.body.documents.map((doc) => doc.id), [docs.board.png]);
    const byDate = await client.call('GET', listPath('&sort=documentDate&limit=1'), { cookie: A, expect: 200 });
    assert.deepEqual([byDate.body.documents[0].id, byDate.body.nextCursor, byDate.body.truncated], [docs.board.png, null, true]);
    // Błędy opisu (dokument zarządu; osobny dokument, żeby historia opisu PDF wyżej została bez zmian).
    const descPath = `/api/documents/${docs.board.old}/description`;
    const descOptions = { cookie: A, template: tpl('board', '/description') };
    const descBody = { title: 'Protokół syntetyczny', category: 'protokol' };
    for (const [body, code] of [
      [{ ...descBody, title: 'ab' }, 'invalid_title'], [{ ...descBody, category: 'paragon' }, 'invalid_category'],
      [{ ...descBody, documentDate: '2026-02-30' }, 'invalid_document_date'], [{ ...descBody, description: 'x'.repeat(1001) }, 'invalid_description'],
    ]) {
      assert.equal((await client.call('POST', descPath, { ...descOptions, body, key: key('desc'), expect: 400, invalidRequest: true })).body.error, code);
    }
    await assertRequiredFieldsEnforced(client, A, descPath, tpl('board', '/description'), descBody, 'DocumentDescriptionRequest');
    const jsonHeaders = { 'Content-Type': 'application/json' };
    assert.equal((await client.call('POST', descPath, { ...descOptions, body: 'null', headers: jsonHeaders, key: key('desc'), expect: 400, invalidRequest: true })).body.error, 'invalid_request');
    assert.equal((await client.call('POST', descPath, { ...descOptions, body: '{"title":', headers: jsonHeaders, key: key('desc'), expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', descPath, { ...descOptions, body: 'title=x', key: key('desc'), expect: 400, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', descPath, { ...descOptions, body: descBody, expect: 400 })).body.error, 'idempotency_key_required');
    assert.equal((await client.call('POST', descPath, {
      ...descOptions, body: { ...descBody, description: 'x'.repeat(5000) }, key: key('desc'), expect: 413, invalidRequest: true,
    })).body.error, 'request_too_large');
    assert.equal((await client.call('POST', descPath, { ...descOptions, body: { ...descBody, title: 'Kontakt rodzic@example.invalid' }, key: key('desc'), expect: 422 })).body.error, 'personal_data_forbidden');
    const phone = { ...descBody, description: 'Zadzwonić pod 0471 23 45 67' };
    assert.equal((await client.call('POST', descPath, { ...descOptions, body: phone, key: key('desc'), expect: 422 })).body.error, 'possible_personal_data');
    await client.call('POST', descPath, { ...descOptions, body: { ...phone, confirmPersonalData: true }, key: key('desc'), expect: 201 });

    // ---------- Metadane z historią opisu (każdy rodzaj; czytelnik bez prawa zapisu dla `council_shared`) ----------
    for (const kind of KINDS) {
      const meta = await client.call('GET', `/api/documents/${docs[kind].pdf}`, { cookie: reader[kind], template: tpl(kind), expect: 200 });
      assert.deepEqual(meta.body.descriptionHistory.map((item) => item.revisionNo), [2, 1], kind);
      assert.equal(meta.body.document.title, `Dokument syntetyczny ${kind} (wersja 2)`);
    }
    // Kontrola pozytywna: schemat metadanych przypina rodzaj do szablonu ścieżki.
    await assert.rejects(client.call('GET', `/api/documents/${docs.board.pdf}`, { cookie: A, template: tpl('class'), expect: 200 }), /niezgodna ze schematem/);

    // ---------- Treść po autoryzacji: pobranie każdego typu, podgląd obrazu, bajty PDF do PDF.js ----------
    for (const kind of KINDS) {
      for (const type of Object.keys(TYPES)) {
        const file = await client.call('GET', `/api/documents/${docs[kind][type]}/content`, { cookie: reader[kind], template: tpl(kind, '/content'), expect: 200 });
        assert.deepEqual(file.bytes, BYTES[type], `${kind} ${type}`);
        assert.match(file.headers.get('Content-Disposition'), /^attachment; filename="dokument-[0-9a-f-]{36}\.(pdf|png|jpg)"$/);
        assert.deepEqual([file.headers.get('Cache-Control'), file.headers.get('X-Content-Type-Options')], ['no-store', 'nosniff']);
      }
      const inline = await client.call('GET', `/api/documents/${docs[kind].png}/content?disposition=inline`, { cookie: reader[kind], template: tpl(kind, '/content'), expect: 200 });
      assert.match(inline.headers.get('Content-Disposition'), /^inline;/);
      const previewPdf = await client.call('GET', `/api/documents/${docs[kind].pdf}/content?purpose=preview`, { cookie: reader[kind], template: tpl(kind, '/content'), expect: 200 });
      assert.match(previewPdf.headers.get('Content-Disposition'), /^attachment;/);
      // #705: PDF nigdy inline (wbudowany czytnik przeglądarki nie jest używany).
      assert.equal((await client.call('GET', `/api/documents/${docs[kind].pdf}/content?disposition=inline`, {
        cookie: reader[kind], template: tpl(kind, '/content'), expect: 400,
      })).body.error, 'pdf_inline_not_allowed');
    }
    const contentPath = (kind, id) => [`/api/documents/${id}/content`, tpl(kind, '/content')];
    const [boardContent, boardContentTpl] = contentPath('board', docs.board.pdf);
    for (const query of ['?disposition=download', '?purpose=print']) {
      assert.equal((await client.call('GET', `${boardContent}${query}`, { cookie: A, template: boardContentTpl, expect: 400 })).body.error, 'invalid_disposition');
    }
    const viewed = (await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'document.viewed'")).rows[0].n;
    assert.equal(viewed, KINDS.length * 2, 'podgląd obrazu i bajty PDF zapisują document.viewed');
    // Dostęp krótkotrwały: każde żądanie liczy sesję; wygasła sesja i brak sesji → 401, bez treści.
    assert.equal((await client.call('GET', boardContent, { template: boardContentTpl, expect: 401 })).body.error, 'unauthenticated');
    assert.equal((await client.call('GET', `/api/documents/${docs.financial.pdf}/content`, { cookie: cookies.expired, template: tpl('financial', '/content'), expect: 401 })).body.error, 'unauthenticated');
    // Plik sprzed bieżących reguł z aktywną treścią: podgląd 409, pobranie (dowód w archiwum) nadal działa.
    const legacy = await insertLegacyDocument(db, storage, ACTIVE_PDF);
    const [legacyContent, financialContentTpl] = contentPath('financial', legacy);
    assert.equal((await client.call('GET', `${legacyContent}?purpose=preview`, { cookie: T, template: financialContentTpl, expect: 409 })).body.error, 'document_preview_blocked');
    await client.call('GET', legacyContent, { cookie: T, template: financialContentTpl, expect: 200 });
    const outdated = await client.call('GET', listPath('&validation=outdated'), { cookie: T, expect: 200 });
    assert.deepEqual(outdated.body.documents.map((doc) => [doc.id, doc.validationVersion, doc.validationCurrent]), [[legacy, null, false]]);
    // Brak obiektu w buckecie: 409 przy pobraniu i przy ponowieniu przesłania (nie „sukces” bez treści).
    const missingKey = key('doc');
    const missing = (await upload('board', 'pdf', { idempotencyKey: missingKey })).body.document.id;
    await storage.deleteObject(await objectKeyOf(db, missing));
    assert.equal((await client.call('GET', `/api/documents/${missing}/content`, { cookie: A, template: boardContentTpl, expect: 409 })).body.error, 'document_content_missing');
    assert.equal((await upload('board', 'pdf', { idempotencyKey: missingKey, expect: 409 })).body.error, 'document_content_missing');
    // Obiekt niezgodny z zapisaną sumą kontrolną: 503 bez treści.
    const tampered = (await upload('board', 'pdf')).body.document.id;
    const stored = storage.raw(await objectKeyOf(db, tampered));
    stored.body = pdfBytes('podmieniony');
    assert.equal((await client.call('GET', `/api/documents/${tampered}/content`, { cookie: A, template: boardContentTpl, expect: 503 })).body.error, 'service_unavailable');
    assert.equal((await noStorage.call('GET', boardContent, { cookie: A, template: boardContentTpl, expect: 503 })).body.error, 'storage_unavailable');
    merge(noStorage);
    assert.equal((await client.call('GET', `/api/documents/${crypto.randomUUID()}`, { cookie: A, template: tpl('board'), expect: 404 })).body.error, 'not_found');

    // ---------- Zastąpienie i unieważnienie (każdy rodzaj), ponowienia i konflikty ----------
    for (const kind of KINDS) {
      const cookie = writer[kind];
      const supersedePath = `/api/documents/${docs[kind].old}/supersede`;
      const body = { replacementDocumentId: docs[kind].next, reason: 'Nowsza wersja dokumentu (syntetyczna)' };
      const supersedeKey = key('sup');
      const created = await client.call('POST', supersedePath, { cookie, body, key: supersedeKey, template: tpl(kind, '/supersede'), expect: 201 });
      assert.deepEqual([created.body.statusEvent.action, created.body.statusEvent.replacementDocumentId], ['superseded', docs[kind].next]);
      const again = await client.call('POST', supersedePath, { cookie, body, key: supersedeKey, template: tpl(kind, '/supersede'), expect: 200 });
      assert.deepEqual([again.body.replayed, again.body.statusEvent.id], [true, created.body.statusEvent.id]);
      const voidPath = `/api/documents/${docs[kind].jpeg}/void`;
      const voidBody = { reason: 'Plik wgrany omyłkowo (syntetyczny)' };
      const voided = await client.call('POST', voidPath, { cookie, body: voidBody, key: key('void'), template: tpl(kind, '/void'), expect: 201 });
      assert.equal(voided.body.statusEvent.action, 'voided');
      // Podwójne kliknięcie innym kluczem: ta sama zmiana → 200 replayed z tym samym zdarzeniem.
      const twice = await client.call('POST', voidPath, { cookie, body: voidBody, key: key('void'), template: tpl(kind, '/void'), expect: 200 });
      assert.deepEqual([twice.body.replayed, twice.body.statusEvent.id], [true, voided.body.statusEvent.id]);
      const meta = await client.call('GET', `/api/documents/${docs[kind].next}`, { cookie: reader[kind], template: tpl(kind), expect: 200 });
      assert.deepEqual([meta.body.supersedes, meta.body.document.status], [docs[kind].old, 'active']);
      const old = await client.call('GET', `/api/documents/${docs[kind].old}`, { cookie: reader[kind], template: tpl(kind), expect: 200 });
      assert.deepEqual([old.body.document.status, old.body.document.replacementDocumentId], ['superseded', docs[kind].next]);
      // Unieważniony dokument zostaje w archiwum: treść nadal do pobrania.
      await client.call('GET', `/api/documents/${docs[kind].jpeg}/content`, { cookie: reader[kind], template: tpl(kind, '/content'), expect: 200 });
    }
    const boardStatus = (id, action) => [`/api/documents/${id}/${action}`, { cookie: A, template: tpl('board', `/${action}`) }];
    const [supersedeOld, supersedeOptions] = boardStatus(docs.board.old, 'supersede');
    assert.equal((await client.call('POST', supersedeOld, {
      ...supersedeOptions, body: { replacementDocumentId: docs.board.png, reason: 'Inne zastępstwo (syntetyczne)' }, key: key('sup'), expect: 409,
    })).body.error, 'document_status_conflict');
    const [voidOld, voidOptions] = boardStatus(docs.board.old, 'void');
    assert.equal((await client.call('POST', voidOld, { ...voidOptions, body: { reason: 'Próba unieważnienia (syntetyczna)' }, key: key('void'), expect: 409 })).body.error, 'document_status_conflict');
    const [supersedePng, pngOptions] = boardStatus(docs.board.png, 'supersede');
    assert.equal((await client.call('POST', supersedePng, {
      ...pngOptions, body: { replacementDocumentId: docs.board.old, reason: 'Zastępstwo nieaktywne (syntetyczne)' }, key: key('sup'), expect: 409,
    })).body.error, 'document_status_replacement_not_active');
    for (const replacementDocumentId of [docs.class.pdf, docs.board.png, 'nie-uuid']) {
      assert.equal((await client.call('POST', supersedePng, {
        ...pngOptions, body: { replacementDocumentId, reason: 'Złe zastępstwo (syntetyczne)' }, key: key('sup'), expect: 400, invalidRequest: replacementDocumentId === 'nie-uuid',
      })).body.error, 'invalid_replacement_document');
    }
    const supersedeBody = { replacementDocumentId: docs.board.next, reason: 'Zastąpienie syntetyczne' };
    const sharedKey = key('sup');
    await client.call('POST', `/api/documents/${docs.board.pdf}/void`, { cookie: A, template: tpl('board', '/void'), body: { reason: 'Unieważnienie syntetyczne' }, key: sharedKey, expect: 201 });
    assert.equal((await client.call('POST', supersedePng, { ...pngOptions, body: supersedeBody, key: sharedKey, expect: 409 })).body.error, 'idempotency_conflict');
    assert.equal((await client.call('POST', supersedePng, { ...pngOptions, body: { ...supersedeBody, reason: 'ab' }, key: key('sup'), expect: 400, invalidRequest: true })).body.error, 'invalid_reason');
    assert.equal((await client.call('POST', supersedePng, { ...pngOptions, body: { ...supersedeBody, reason: 'Kontakt rodzic@example.invalid' }, key: key('sup'), expect: 422 })).body.error, 'personal_data_forbidden');
    assert.equal((await client.call('POST', supersedePng, { ...pngOptions, body: supersedeBody, expect: 400 })).body.error, 'idempotency_key_required');
    assert.equal((await client.call('POST', supersedePng, { ...pngOptions, body: '{"reason":', headers: jsonHeaders, key: key('sup'), expect: 400, invalidRequest: true })).body.error, 'invalid_json');
    assert.equal((await client.call('POST', supersedePng, { ...pngOptions, body: 'reason=x', key: key('sup'), expect: 400, invalidRequest: true })).body.error, 'invalid_content_type');
    assert.equal((await client.call('POST', supersedePng, {
      ...pngOptions, body: { ...supersedeBody, reason: 'x'.repeat(5000) }, key: key('sup'), expect: 413, invalidRequest: true,
    })).body.error, 'request_too_large');
    await assertRequiredFieldsEnforced(client, A, supersedePng, tpl('board', '/supersede'), supersedeBody, 'DocumentSupersedeRequest');
    const [voidPng, voidPngOptions] = boardStatus(docs.board.png, 'void');
    await assertRequiredFieldsEnforced(client, A, voidPng, tpl('board', '/void'), { reason: 'Unieważnienie syntetyczne' }, 'DocumentVoidRequest');
    assert.equal((await client.call('POST', voidPng, { ...voidPngOptions, body: { reason: 'Telefon 0471 23 45 67' }, key: key('void'), expect: 422 })).body.error, 'possible_personal_data');
    assert.equal((await client.call('POST', `/api/documents/${crypto.randomUUID()}/void`, { ...voidPngOptions, body: { reason: 'Brak dokumentu' }, key: key('void'), expect: 404 })).body.error, 'not_found');

    // ---------- Granice ról ----------
    // Brak sesji: 401 na każdej trasie.
    await client.call('GET', listPath(), { expect: 401 });
    await client.call('POST', uploadPath('board'), { body: BYTES.pdf, key: key('doc'), headers: { 'Content-Type': TYPES.pdf }, expect: 401 });
    for (const kind of KINDS) {
      const id = docs[kind].png;
      await client.call('GET', `/api/documents/${id}`, { template: tpl(kind), expect: 401 });
      await client.call('GET', `/api/documents/${id}/content`, { template: tpl(kind, '/content'), expect: 401 });
      await client.call('POST', `/api/documents/${id}/description`, { body: descBody, key: key('desc'), template: tpl(kind, '/description'), expect: 401 });
      await client.call('POST', `/api/documents/${id}/supersede`, { body: supersedeBody, key: key('sup'), template: tpl(kind, '/supersede'), expect: 401 });
      await client.call('POST', `/api/documents/${id}/void`, { body: { reason: 'Brak sesji' }, key: key('void'), template: tpl(kind, '/void'), expect: 401 });
    }
    // Odczyt i zapis dokumentu poza zakresem: 404 jak nieistniejący (brak wyroczni istnienia).
    const denied = [
      [repA, 'financial'], [repA, 'board'], [repA, 'council_shared', ['description', 'supersede', 'void']],
      [repB, 'class'], [cookies.boardClass, 'board'], [cookies.boardClass, 'financial'], [cookies.principal, 'board'],
      [cookies.principal, 'class'], [cookies.audit, 'board'], [cookies.audit, 'council_shared'],
    ];
    for (const [cookie, kind, only] of denied) {
      const id = docs[kind].png;
      if (!only) {
        assert.equal((await client.call('GET', `/api/documents/${id}`, { cookie, template: tpl(kind), expect: 404 })).body.error, 'not_found', kind);
        assert.equal((await client.call('GET', `/api/documents/${id}/content`, { cookie, template: tpl(kind, '/content'), expect: 404 })).body.error, 'not_found', kind);
      }
      if (!only || only.includes('description')) {
        await client.call('POST', `/api/documents/${id}/description`, { cookie, body: descBody, key: key('desc'), template: tpl(kind, '/description'), expect: 404 });
      }
      if (!only || only.includes('void')) {
        await client.call('POST', `/api/documents/${id}/void`, { cookie, body: { reason: 'Poza zakresem' }, key: key('void'), template: tpl(kind, '/void'), expect: 404 });
      }
      if (!only || only.includes('supersede')) {
        await client.call('POST', `/api/documents/${id}/supersede`, {
          cookie, body: { replacementDocumentId: docs[kind].pdf, reason: 'Poza zakresem' }, key: key('sup'), template: tpl(kind, '/supersede'), expect: 404,
        });
      }
    }
    assert.ok((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'document.access_denied'")).rows[0].n > 0, 'odmowa pobrania w dzienniku');
    // Przesłanie poza zakresem: 403 forbidden.
    for (const [cookie, kind, extra] of [
      [repA, 'board', ''], [repA, 'council_shared', ''], [repB, 'class', ''], [cookies.boardClass, 'board', ''],
      [cookies.principal, 'board', ''], [cookies.audit, 'financial', ''],
    ]) {
      assert.equal((await upload(kind, 'pdf', { cookie, extra, expect: 403 })).body.error, 'forbidden', kind);
    }
    assert.equal((await client.call('POST', `/api/documents?kind=class&schoolYearId=${YEAR}&classId=c-1b`, {
      cookie: repA, body: BYTES.pdf, key: key('doc'), headers: { 'Content-Type': TYPES.pdf }, expect: 403,
    })).body.error, 'forbidden', 'przedstawiciel 1A nie przesyła do 1B');
    // Listy: przedstawiciel widzi tylko swoją klasę i dokumenty Rady; zarząd z przydziałem klasy — tylko klasę.
    const repList = await client.call('GET', listPath('&limit=100'), { cookie: repA, expect: 200 });
    assert.ok(repList.body.documents.length > 0 && repList.body.documents.every((doc) => (doc.kind === 'class' && doc.classId === 'c-1a') || doc.kind === 'council_shared'));
    const repBList = await client.call('GET', listPath('&kind=class'), { cookie: repB, expect: 200 });
    assert.deepEqual(repBList.body.documents, [], 'przedstawiciel 1B nie widzi materiałów 1A');
    const classBoardList = await client.call('GET', listPath('&limit=100'), { cookie: cookies.boardClass, expect: 200 });
    assert.ok(classBoardList.body.documents.length > 0 && classBoardList.body.documents.every((doc) => doc.kind === 'class' && doc.classId === 'c-1a'));
    assert.equal((await client.call('GET', listPath(), { cookie: cookies.principal, expect: 403 })).body.error, 'forbidden');

    // Komisja Rewizyjna z flagą AUDIT_LEDGER_READ: wyłącznie dowody `financial` z kategorii bez danych płatników.
    await client.call('POST', `/api/documents/${ledgerEvidence.id}/description`, {
      cookie: T, key: key('desc'), template: tpl('financial', '/description'), expect: 201,
      body: { title: 'Faktura syntetyczna za salę', category: 'faktura', description: 'Wolny tekst opisu (syntetyczny)' },
    });
    await client.call('POST', `/api/documents/${paymentEvidence.id}/description`, {
      cookie: T, key: key('desc'), template: tpl('financial', '/description'), expect: 201, body: { title: 'Faktura powiązana z wpłatą', category: 'faktura' },
    });
    const auditList = await client.call('GET', listPath('&status=all&limit=100'), { cookie: cookies.audit, expect: 200 });
    assert.deepEqual(auditList.body.documents.map((doc) => doc.id).sort(), [docs.financial.pdf, ledgerEvidence.id].sort());
    const auditMeta = await client.call('GET', `/api/documents/${ledgerEvidence.id}`, { cookie: cookies.audit, template: tpl('financial'), expect: 200 });
    assert.deepEqual(auditMeta.body.descriptionHistory.map((item) => item.description), [null], 'wolny tekst opisu nie jest wydawany KR');
    const auditFile = await client.call('GET', `/api/documents/${ledgerEvidence.id}/content`, { cookie: cookies.audit, template: tpl('financial', '/content'), expect: 200 });
    assert.deepEqual(auditFile.bytes, BYTES.pdf);
    for (const id of [paymentEvidence.id, docs.financial.png]) {
      await client.call('GET', `/api/documents/${id}`, { cookie: cookies.audit, template: tpl('financial'), expect: 404 });
    }
    for (const [suffix, body] of [['/description', descBody], ['/void', { reason: 'Próba KR' }]]) {
      await client.call('POST', `/api/documents/${ledgerEvidence.id}${suffix}`, { cookie: cookies.audit, body, key: key('kr'), template: tpl('financial', suffix), expect: 404 });
    }
    assert.equal((await client.call('GET', listPath(), { cookie: cookies.auditNoMfa, expect: 403 })).body.error, 'mfa_enrollment_required');
    // Ta sama Komisja Rewizyjna bez flagi: brak dostępu (lista 403, dokument 404).
    const noFlag = newClient({ ...env, AUDIT_LEDGER_READ: '0' });
    assert.equal((await noFlag.call('GET', listPath(), { cookie: cookies.audit, expect: 403 })).body.error, 'forbidden');
    await noFlag.call('GET', `/api/documents/${ledgerEvidence.id}`, { cookie: cookies.audit, template: tpl('financial'), expect: 404 });
    await noFlag.call('GET', `/api/documents/${ledgerEvidence.id}/content`, { cookie: cookies.audit, template: tpl('financial', '/content'), expect: 404 });
    merge(noFlag);

    // Brak MFA: bramka routera (zarząd bez czynnika → mfa_enrollment_required, z czynnikiem → mfa_required).
    for (const [cookie, code] of [[cookies.boardNoMfa, 'mfa_enrollment_required'], [cookies.boardEnrolled, 'mfa_required']]) {
      assert.equal((await client.call('GET', listPath(), { cookie, expect: 403 })).body.error, code);
      assert.equal((await upload('board', 'pdf', { cookie, expect: 403 })).body.error, code);
      for (const kind of KINDS) {
        const id = docs[kind].png;
        assert.equal((await client.call('GET', `/api/documents/${id}`, { cookie, template: tpl(kind), expect: 403 })).body.error, code);
        assert.equal((await client.call('GET', `/api/documents/${id}/content`, { cookie, template: tpl(kind, '/content'), expect: 403 })).body.error, code);
        assert.equal((await client.call('POST', `/api/documents/${id}/description`, { cookie, body: descBody, key: key('desc'), template: tpl(kind, '/description'), expect: 403 })).body.error, code);
        assert.equal((await client.call('POST', `/api/documents/${id}/supersede`, { cookie, body: supersedeBody, key: key('sup'), template: tpl(kind, '/supersede'), expect: 403 })).body.error, code);
        assert.equal((await client.call('POST', `/api/documents/${id}/void`, { cookie, body: { reason: 'Bez MFA' }, key: key('void'), template: tpl(kind, '/void'), expect: 403 })).body.error, code);
      }
    }
    // Skarbnik bez wymogu zapisu MFA w routerze: dowód finansowy wymaga MFA modułu → 404 jak brak dokumentu.
    const noGate = newClient({ ...env, MFA_REQUIRED_ROLES: '' });
    const treasurerNoMfa = await seedUserSession(db, { userId: 'u-treasurer-nomfa', mfa: false, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    await noGate.call('GET', `/api/documents/${docs.financial.png}`, { cookie: treasurerNoMfa, template: tpl('financial'), expect: 404 });
    assert.equal((await noGate.call('POST', uploadPath('financial'), {
      cookie: treasurerNoMfa, body: BYTES.pdf, key: key('doc'), headers: { 'Content-Type': TYPES.pdf }, expect: 403,
    })).body.error, 'forbidden');
    merge(noGate);
    // Obcy Origin: każdy zapis 403 invalid_origin przed trasą.
    assert.equal((await client.call('POST', uploadPath('board'), {
      cookie: A, body: BYTES.pdf, key: key('doc'), headers: { 'Content-Type': TYPES.pdf }, origin: FOREIGN, expect: 403,
    })).body.error, 'invalid_origin');
    for (const kind of KINDS) {
      const id = docs[kind].png;
      for (const [suffix, body] of [['/description', descBody], ['/supersede', supersedeBody], ['/void', { reason: 'Obcy origin' }]]) {
        assert.equal((await client.call('POST', `/api/documents/${id}${suffix}`, {
          cookie: writer[kind], body, key: key('org'), template: tpl(kind, suffix), origin: FOREIGN, expect: 403,
        })).body.error, 'invalid_origin');
      }
    }

    // ---------- Zamknięty rok: zamknięcie przez trasy year-close, potem 409 ----------
    // Zamknięcie wygasza przydziały roku; zapisy próbuje zarząd z przydziałem bez roku.
    await closeYear(env, cookies);
    const G = cookies.boardGlobal;
    assert.equal((await upload('board', 'pdf', { cookie: G, expect: 409 })).body.error, 'school_year_closed');
    assert.equal((await client.call('POST', `/api/documents/${docs.board.png}/description`, {
      cookie: G, body: descBody, key: key('desc'), template: tpl('board', '/description'), expect: 409,
    })).body.error, 'school_year_closed');
    assert.equal((await client.call('POST', supersedePng, { ...pngOptions, cookie: G, body: supersedeBody, key: key('sup'), expect: 409 })).body.error, 'school_year_closed');
    // Unieważnienie w zamkniętym roku pozostaje możliwe (wariant zachowawczy do D-04/D-07); plik zostaje do pobrania.
    const closedVoid = await client.call('POST', voidPng, { ...voidPngOptions, cookie: G, body: { reason: 'Plik wgrany omyłkowo po zamknięciu' }, key: key('void'), expect: 201 });
    assert.equal(closedVoid.body.statusEvent.action, 'voided');
    await client.call('GET', `/api/documents/${docs.board.png}/content`, { cookie: G, template: tpl('board', '/content'), expect: 200 });
    assert.equal((await client.call('GET', listPath(), { cookie: A, expect: 403 })).body.error, 'forbidden', 'przydział roku wygasł');

    assert.equal(networkGuardCalls(), 0, 'żadnej próby połączenia z siecią');
    assertSuccessCoverage(validated);
  } finally {
    await db.close();
  }
});
