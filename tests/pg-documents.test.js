// Prywatne dokumenty (issue #39). Wyłącznie syntetyczne pliki i dane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { revokeRoleGrant } from '../src/pg/authorization.js';
import { assertNoPii } from '../src/pg/audit.js';
import { bodyLimitFor, DEFAULT_BODY_LIMIT_BYTES, detectType, maxUploadBytes, HARD_MAX_UPLOAD_BYTES } from '../src/documents.js';
import { createMemoryStorage, createS3Storage, sha256Hex, signRequest, storageFromEnv } from '../src/storage.js';
import { resolveRuntime } from '../src/server.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-2026';
const HOUR = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
const PDF = encoder.encode('%PDF-1.4\n% syntetyczny dokument testowy\n1 0 obj <<>> endobj\n%%EOF\n');
// Sygnatura + IHDR (13 B danych) + IEND: minimalny, strukturalnie poprawny PNG
// (CRC nieużywany przez kontrolę struktury z issue #89 — dowolny bajt starcza).
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...new Array(13).fill(0), 0, 0, 0, 0,
  0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
]);
const HTML = encoder.encode('<html><script>alert(1)</script></html>');

async function withEnv(fn, extra = {}) {
  const db = await createTestDb();
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR });
  const storage = createMemoryStorage();
  try { return await fn(db, { db, storage, ...extra }, storage); } finally { await db.close(); }
}

const treasurer = (db, opts = {}) => seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }], ...opts });
const repA = (db) => seedUserSession(db, { userId: 'u-rep-a', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] });
const repB = (db) => seedUserSession(db, { userId: 'u-rep-b', roles: [{ role: 'representative', classId: 'c-1b', schoolYearId: YEAR }] });

let keyCounter = 0;
function uploadRequest({ cookie, bytes = PDF, type = 'application/pdf', kind = 'financial', classId, key, origin, headers = {}, extraQuery = '' }) {
  const query = new URLSearchParams({ kind, schoolYearId: YEAR });
  if (classId) query.set('classId', classId);
  return request(`/api/documents?${query}${extraQuery}`, {
    method: 'POST', cookie, origin, body: bytes,
    headers: { 'Content-Type': type, 'Idempotency-Key': key ?? `test-key-${++keyCounter}-${Date.now()}`, ...headers },
  });
}

async function upload(env, options) {
  const response = await handlePgRequest(uploadRequest(options), env);
  return { response, data: await response.json() };
}

const get = (env, path, cookie) => handlePgRequest(request(path, { cookie }), env);

async function auditRows(db, action) {
  return (await db.query('SELECT actor_id, entity_id, metadata_json FROM audit_events WHERE action = $1 ORDER BY occurred_at', [action])).rows;
}

test('treasurer uploads a synthetic PDF: opaque key, metadata in PostgreSQL, audit without PII', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const { response, data } = await upload(env, { cookie, headers: { 'Content-Disposition': 'attachment; filename="Kowalski_Jan_1A.pdf"' } });
  assert.equal(response.status, 201);
  const doc = data.document;
  assert.match(doc.id, UUID);
  assert.equal(doc.mimeType, 'application/pdf');
  assert.equal(doc.byteSize, PDF.length);
  assert.equal(doc.sha256, sha256Hex(PDF));
  assert.equal('objectKey' in doc, false);

  const [row] = (await db.query('SELECT object_key FROM documents WHERE id = $1', [doc.id])).rows;
  assert.match(row.object_key, /^docs\/[0-9a-f-]{36}$/);
  assert.notEqual(row.object_key, `docs/${doc.id}`, 'object key is independent of the public document id');
  assert.deepEqual(storage.keys(), [row.object_key]);
  // Klucz to wyłącznie docs/<uuid> (sprawdzone wyżej); losowy hex może zawierać np. „1a”,
  // więc identyfikator klasy sprawdzamy jako osobny segment, nie podciąg.
  assert.doesNotMatch(row.object_key, /kowalski|jan|pdf|y-2026|treasurer/i);
  assert.doesNotMatch(row.object_key, /(^|[/_.])1a([/_.]|$)/i);

  const [event] = await auditRows(db, 'document.uploaded');
  assert.equal(event.actor_id, 'u-treasurer');
  assert.equal(event.entity_id, doc.id);
  assertNoPii(event.metadata_json);
  assert.doesNotMatch(JSON.stringify(event.metadata_json), /kowalski|example\.invalid|docs\//i);
}));

test('authorized download streams through the server with safe headers and is audited', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const response = await get(env, `/api/documents/${data.document.id}/content`, cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PDF);
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');
  assert.equal(response.headers.get('Content-Disposition'), `attachment; filename="dokument-${data.document.id}.pdf"`);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Security-Policy'), /^sandbox/);

  const events = await auditRows(db, 'document.downloaded');
  assert.equal(events.length, 1);
  assert.equal(events[0].actor_id, 'u-treasurer');
  assert.equal(events[0].entity_id, data.document.id);
  assertNoPii(events[0].metadata_json);

  const meta = await get(env, `/api/documents/${data.document.id}`, cookie);
  assert.equal(meta.status, 200);
  assert.equal((await meta.json()).document.id, data.document.id);
}));

test('guessing another document id gives the same 404 as an unknown id', async () => withEnv(async (db, env) => {
  const owner = await treasurer(db);
  const { data } = await upload(env, { cookie: owner });
  const id = data.document.id;
  const intruders = [
    await repA(db),
    await seedUserSession(db, { userId: 'u-noroles' }),
    await seedUserSession(db, { userId: 'u-principal', mfa: true, roles: [{ role: 'principal' }] }),
    await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit' }] }),
    await seedUserSession(db, { userId: 'u-nomfa', roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    await seedUserSession(db, { userId: 'u-other-year', mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y-2025' }] }),
    await seedUserSession(db, { userId: 'u-board-class', mfa: true, roles: [{ role: 'board', classId: 'c-1a', schoolYearId: YEAR }] }),
  ];
  const unknown = crypto.randomUUID();
  // Skarbnik bez sesji z MFA zatrzymuje się na bramce MFA routera (403
  // mfa_enrollment_required) — przed trasą, więc tak samo dla znanego i nieznanego id.
  const noMfa = intruders[4];
  for (const cookie of intruders) {
    for (const path of [`/api/documents/${id}`, `/api/documents/${id}/content`]) {
      const denied = await get(env, path, cookie);
      const missing = await get(env, path.replace(id, unknown), cookie);
      const expected = cookie === noMfa ? 403 : 404;
      assert.equal(denied.status, expected, path);
      assert.equal(missing.status, expected);
      assert.deepEqual(await denied.json(), await missing.json());
    }
  }
  for (const bad of ['1', '..%2F..%2Fetc', 'docs%2Fx', `${id}x`]) {
    assert.equal((await get(env, `/api/documents/${bad}/content`, owner)).status, 404);
  }
  assert.equal((await get(env, `/api/documents/${id}/content`)).status, 401);
  // Odmowa dla istniejącego dokumentu trafia do dziennika (bez treści i PII).
  // (Sesja zatrzymana na bramce MFA nie dociera do trasy dokumentów.)
  const denied = await auditRows(db, 'document.access_denied');
  assert.equal(denied.length, intruders.length - 1);
  denied.forEach((event) => assertNoPii(event.metadata_json));
  assert.equal((await auditRows(db, 'document.downloaded')).length, 0);
}));

test('representative sees only documents of the assigned class', async () => withEnv(async (db, env) => {
  const cookieA = await repA(db);
  const cookieB = await repB(db);
  const { response, data } = await upload(env, { cookie: cookieA, kind: 'class', classId: 'c-1a' });
  assert.equal(response.status, 201);
  const id = data.document.id;

  assert.equal((await get(env, `/api/documents/${id}/content`, cookieA)).status, 200);
  assert.equal((await get(env, `/api/documents/${id}/content`, cookieB)).status, 404);
  assert.equal((await get(env, `/api/documents/${id}`, cookieB)).status, 404);

  const listA = await (await get(env, `/api/documents?schoolYearId=${YEAR}`, cookieA)).json();
  const listB = await (await get(env, `/api/documents?schoolYearId=${YEAR}`, cookieB)).json();
  assert.deepEqual(listA.documents.map((doc) => doc.id), [id]);
  assert.deepEqual(listB.documents, []);
  const filtered = await (await get(env, `/api/documents?schoolYearId=${YEAR}&classId=c-1a`, cookieB)).json();
  assert.deepEqual(filtered.documents, []);

  // Przedstawiciel nie przesyła do cudzej klasy ani dowodów finansowych.
  assert.equal((await upload(env, { cookie: cookieA, kind: 'class', classId: 'c-1b' })).response.status, 403);
  assert.equal((await upload(env, { cookie: cookieA, kind: 'financial' })).response.status, 403);
  assert.equal((await upload(env, { cookie: cookieA, kind: 'board' })).response.status, 403);
}));

test('list is scoped: financial documents hidden from class roles, board sees all classes', async () => withEnv(async (db, env) => {
  const tCookie = await treasurer(db);
  const board = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  const fin = (await upload(env, { cookie: tCookie })).data.document.id;
  const cls = (await upload(env, { cookie: board, kind: 'class', classId: 'c-1b' })).data.document.id;
  const brd = (await upload(env, { cookie: board, kind: 'board' })).data.document.id;

  const ids = async (cookie, query = '') => (await (await get(env, `/api/documents?schoolYearId=${YEAR}${query}`, cookie)).json()).documents.map((d) => d.id).sort();
  assert.deepEqual(await ids(board), [fin, cls, brd].sort());
  assert.deepEqual(await ids(tCookie), [fin]);
  assert.deepEqual(await ids(await repB(db)), [cls]);
  assert.deepEqual(await ids(board, '&kind=board'), [brd]);
  assert.equal((await get(env, `/api/documents?schoolYearId=${YEAR}`, await seedUserSession(db, { userId: 'u-none' }))).status, 403);
  assert.equal((await get(env, '/api/documents', board)).status, 400);
  assert.equal((await get(env, `/api/documents?schoolYearId=${YEAR}&kind=secret`, board)).status, 400);
}));

test('DOC-01: class grant of one school year gives 403 (not an empty list) for another year', async () => withEnv(async (db, env) => {
  const cookieA = await repA(db);
  assert.equal((await get(env, `/api/documents?schoolYearId=${YEAR}`, cookieA)).status, 200);
  const other = await get(env, '/api/documents?schoolYearId=y-2027', cookieA);
  assert.equal(other.status, 403);
  assert.deepEqual(await other.json(), { error: 'forbidden' });
  // Zarząd z przydziałem klasy roku 1 — tak samo.
  const boardA = await seedUserSession(db, { userId: 'u-board-a', mfa: true, roles: [{ role: 'board', classId: 'c-1a', schoolYearId: YEAR }] });
  assert.equal((await get(env, '/api/documents?schoolYearId=y-2027', boardA)).status, 403);
  // Przydział klasowy bez roku dostaje rok klasy (trigger z 0022, #201),
  // więc nie obejmuje już innych lat.
  const anyYear = await seedUserSession(db, { userId: 'u-rep-any', roles: [{ role: 'representative', classId: 'c-1a' }] });
  assert.equal((await get(env, `/api/documents?schoolYearId=${YEAR}`, anyYear)).status, 200);
  assert.equal((await get(env, '/api/documents?schoolYearId=y-2027', anyYear)).status, 403);
}));

test('wrong declared type or wrong magic bytes are refused with 415 and nothing is stored', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const cases = [
    { bytes: HTML, type: 'application/pdf' },
    { bytes: HTML, type: 'text/html' },
    { bytes: PDF, type: 'image/png' },
    { bytes: PNG, type: 'application/pdf' },
    { bytes: encoder.encode('imie;nazwisko\nA;B\n'), type: 'text/csv' },
    { bytes: PDF, type: 'application/octet-stream' },
    { bytes: encoder.encode('  %PDF-1.4'), type: 'application/pdf' },
  ];
  for (const item of cases) {
    const { response, data } = await upload(env, { cookie, ...item });
    assert.equal(response.status, 415, item.type);
    assert.equal(data.error, 'unsupported_media_type');
  }
  assert.equal((await upload(env, { cookie, bytes: new Uint8Array(0) })).response.status, 400);
  assert.equal((await upload(env, { cookie, bytes: PNG, type: 'image/png' })).response.status, 201);
  assert.equal(storage.keys().length, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 1);
}));

test('too large upload is refused with 413 (streamed and declared length)', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const big = new Uint8Array(2048);
  big.set(PDF.subarray(0, 5));
  const streamed = await upload(env, { cookie, bytes: big });
  assert.equal(streamed.response.status, 413);
  assert.equal(streamed.data.error, 'document_too_large');
  const declared = await handlePgRequest(uploadRequest({ cookie, bytes: PDF, headers: { 'Content-Length': '999999' } }), env);
  assert.equal(declared.status, 413);
  assert.equal((await upload(env, { cookie, bytes: PDF })).response.status, 201);
  assert.equal(storage.keys().length, 1);
}, { documentMaxBytes: 1024 }));

test('expired and revoked grants lose access from the next request', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const expired = await seedUserSession(db, { userId: 'u-expired', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR, expiresAt: new Date(Date.now() - HOUR) }] });
  assert.equal((await get(env, `/api/documents/${data.document.id}/content`, expired)).status, 404);
  assert.equal((await upload(env, { cookie: expired })).response.status, 403);
  const revokedSeed = await seedUserSession(db, { userId: 'u-revoked-seed', mfa: true, roles: [{ role: 'treasurer', revoked: true }] });
  assert.equal((await get(env, `/api/documents/${data.document.id}/content`, revokedSeed)).status, 404);

  const [grant] = (await db.query("SELECT id FROM role_grants WHERE user_id = 'u-treasurer'")).rows;
  assert.equal(await revokeRoleGrant(env, { grantId: grant.id, actorId: 'u-treasurer' }), true);
  assert.equal((await get(env, `/api/documents/${data.document.id}/content`, cookie)).status, 404);
  assert.equal((await upload(env, { cookie })).response.status, 403);
  const expiredSession = await treasurer(db, { userId: 'u-t2', expiresAt: new Date(Date.now() - HOUR) });
  assert.equal((await get(env, `/api/documents/${data.document.id}/content`, expiredSession)).status, 401);
}));

test('cross-origin or origin-less upload is refused before touching storage', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  for (const origin of ['https://evil.example', false]) {
    const response = await handlePgRequest(uploadRequest({ cookie, origin }), env);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'invalid_origin');
  }
  assert.equal(storage.keys().length, 0);
}));

test('double click and retry reuse the idempotency key; different content conflicts', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const first = await upload(env, { cookie, key: 'same-key-12345' });
  const retry = await upload(env, { cookie, key: 'same-key-12345' });
  assert.equal(first.response.status, 201);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.document.id, first.data.document.id);
  const conflict = await upload(env, { cookie, key: 'same-key-12345', bytes: PNG, type: 'image/png' });
  assert.equal(conflict.response.status, 409);

  const parallel = await Promise.all([1, 2, 3].map(() => upload(env, { cookie, key: 'parallel-key-123' })));
  const statuses = parallel.map((item) => item.response.status).sort();
  assert.deepEqual(statuses, [200, 200, 201]);
  assert.equal(new Set(parallel.map((item) => item.data.document.id)).size, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 2);
  assert.equal(storage.keys().length, 2, 'orphaned objects of lost races are cleaned up');
  assert.equal((await auditRows(db, 'document.uploaded')).length, 2);
  assert.equal((await upload(env, { cookie, key: 'short' })).response.status, 400);
}));

test('invalid scope, class and link parameters are refused', async () => withEnv(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  assert.equal((await upload(env, { cookie, kind: 'other' })).response.status, 400);
  assert.equal((await upload(env, { cookie, kind: 'class' })).response.status, 400);
  assert.equal((await upload(env, { cookie, kind: 'financial', classId: 'c-1a' })).response.status, 400);
  assert.equal((await upload(env, { cookie, kind: 'class', classId: 'c-missing' })).response.status, 400);
  assert.equal((await upload(env, { cookie, extraQuery: '&linkedEntityType=ledger_entry&linkedEntityId=nope' })).response.status, 400);
  assert.equal((await upload(env, { cookie, extraQuery: '&linkedEntityType=household&linkedEntityId=h1' })).response.status, 400);
  assert.equal((await upload(env, { cookie, kind: 'board', extraQuery: '&linkedEntityType=ledger_entry&linkedEntityId=x' })).response.status, 400);
}));

test('document rows are immutable and tampered objects are not served', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  await assert.rejects(db.query("UPDATE documents SET kind = 'board' WHERE id = $1", [data.document.id]), /documents_are_immutable/);
  await assert.rejects(db.query('DELETE FROM documents WHERE id = $1', [data.document.id]), /documents_are_immutable/);

  const [key] = storage.keys();
  storage.raw(key).body[10] ^= 0xff;
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try {
    assert.equal((await get(env, `/api/documents/${data.document.id}/content`, cookie)).status, 503);
  } finally { console.error = original; }
  assert.match(errors.join('\n'), /"code":"document_integrity_mismatch"/);
  assert.equal((await auditRows(db, 'document.downloaded')).length, 0);
}));

test('without a configured bucket documents return 503', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const noStorage = { db: env.db };
  assert.equal((await upload(noStorage, { cookie })).response.status, 503);
  assert.equal((await get(noStorage, `/api/documents/${crypto.randomUUID()}/content`, cookie)).status, 503);
}));

test('SigV4 signer matches published AWS test vectors', () => {
  // AWS SigV4 test suite: get-vanilla.
  const vanilla = signRequest({
    method: 'GET', url: 'https://example.amazonaws.com/', service: 'service', region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', now: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(vanilla.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  // Amazon S3 API Reference, "Signature Calculations for the Authorization Header": GET Object.
  const s3Credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z') };
  const getObject = signRequest({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' }, ...s3Credentials });
  assert.equal(getObject.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(getObject.headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
  // Ten sam dokument: PUT Object.
  const payloadHash = sha256Hex('Welcome to Amazon S3.');
  const putObject = signRequest({
    method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test%24file.text', payloadHash,
    headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, ...s3Credentials,
  });
  assert.equal(putObject.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('S3 storage signs requests, uses virtual-hosted or path URLs and hides provider errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'GET' && url.endsWith('missing-0000')) return new Response('<Error>NoSuchKey</Error>', { status: 404 });
    if (init.method === 'GET') return new Response(PDF, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    return new Response('', { status: 200 });
  };
  const config = { endpoint: 'https://storage.example.test', region: 'auto', bucket: 'rd-staging-abc123', accessKeyId: 'AKIDSYNTHETIC', secretAccessKey: 'synthetic-secret', fetchImpl };
  const storage = createS3Storage(config);
  const key = `docs/${crypto.randomUUID()}`;
  await storage.putObject(key, PDF, 'application/pdf');
  assert.equal(calls[0].url, `https://rd-staging-abc123.storage.example.test/${key}`);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers['x-amz-content-sha256'], sha256Hex(PDF));
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDSYNTHETIC\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal('host' in calls[0].init.headers, false);
  assert.doesNotMatch(JSON.stringify(calls[0].init.headers), /synthetic-secret/);
  const object = await storage.getObject(key);
  assert.deepEqual(object.body, PDF);
  await assert.rejects(storage.getObject('docs/missing-0000'), (error) => error.code === 'storage_object_not_found' && !/NoSuchKey/.test(error.message));
  await assert.rejects(storage.putObject('../etc/passwd', PDF, 'application/pdf'), /storage_invalid_key/);
  await assert.rejects(storage.putObject('docs/Jan Kowalski.pdf', PDF, 'application/pdf'), /storage_invalid_key/);

  const pathStyle = createS3Storage({ ...config, urlStyle: 'path' });
  await pathStyle.getObject(key);
  assert.equal(calls.at(-1).url, `https://storage.example.test/rd-staging-abc123/${key}`);

  assert.throws(() => createS3Storage({ ...config, endpoint: 'http://storage.example.test' }), /https/);
  assert.equal(storageFromEnv({}), null);
  assert.throws(() => storageFromEnv({ BUCKET_NAME: 'rd-x' }), /storage_config_incomplete/);
  const fromEnv = storageFromEnv({
    BUCKET_ENDPOINT: config.endpoint, BUCKET_REGION: 'auto', BUCKET_NAME: config.bucket,
    BUCKET_ACCESS_KEY_ID: 'AKIDSYNTHETIC', BUCKET_SECRET_ACCESS_KEY: 'synthetic-secret',
  }, { fetchImpl });
  assert.equal(fromEnv.kind, 's3');
});

test('type detection, size limits and runtime wiring', () => {
  assert.equal(detectType(PDF), 'application/pdf');
  assert.equal(detectType(PNG), 'image/png');
  assert.equal(detectType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectType(HTML), null);
  assert.equal(maxUploadBytes(undefined), 10 * 1024 * 1024);
  assert.equal(maxUploadBytes(10 ** 12), HARD_MAX_UPLOAD_BYTES);
  const limit = bodyLimitFor(5 * 1024 * 1024);
  assert.equal(limit(new URL('https://rd.test/api/documents'), 'POST'), 5 * 1024 * 1024);
  assert.equal(limit(new URL('https://rd.test/api/documents'), 'GET'), DEFAULT_BODY_LIMIT_BYTES);
  assert.equal(limit(new URL('https://rd.test/api/ledger'), 'POST'), DEFAULT_BODY_LIMIT_BYTES);

  const fakeDb = { query: async () => ({ rows: [] }), transaction: async () => {}, close: async () => {} };
  const fakeStorage = createMemoryStorage();
  const runtime = resolveRuntime(
    { DATABASE_URL: 'postgres://synthetic.invalid/rd', DOCUMENT_MAX_BYTES: '2048' },
    { createDatabase: () => fakeDb, createStorage: () => fakeStorage },
  );
  assert.equal(runtime.env.storage, fakeStorage);
  assert.equal(runtime.env.documentMaxBytes, 2048);
  assert.equal(runtime.bodyLimit(new URL('https://rd.test/api/documents'), 'POST'), 2048);
  assert.equal(JSON.stringify(Object.keys(runtime.env)).includes('BUCKET'), false);
});

// --- Utracone potwierdzenie COMMIT przy uploadzie (#168) --------------------

async function silencedRouteError(fn) {
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try { return { result: await fn(), errors }; } finally { console.error = original; }
}

// Owija db tak, by transaction() NAPRAWDĘ się zatwierdziła (prawdziwy BEGIN/
// COMMIT na PGlite), ale zwróciła wywołującemu błąd połączenia — tak jak przy
// utraconym potwierdzeniu COMMIT (reset TCP, failover) opisanym w #168.
function lostCommitAckOnce(db) {
  let armed = true;
  return {
    query: (...args) => db.query(...args),
    async transaction(fn) {
      const result = await db.transaction(fn);
      if (armed) {
        armed = false;
        const error = new Error('read ECONNRESET');
        error.code = 'ECONNRESET';
        throw error;
      }
      return result;
    },
  };
}

// Owija db tak, że transaction() uruchamia prawdziwą transakcję, ale jedno
// zapytanie wewnątrz niej rzuca błąd, więc PGlite naprawdę wykonuje ROLLBACK
// (odtwarza „zapisz obiekt i rzuć” z niepowodzeniem samego zapisu w bazie —
// obiekt trafił do bucketu, ale wiersz documents nie powstał).
function failInsideTransaction(db, matchText) {
  return {
    query: (...args) => db.query(...args),
    transaction: (fn) => db.transaction(async (tx) => fn({
      query: async (text, params) => {
        if (text.includes(matchText)) {
          const error = new Error('synthetic_test_failure');
          error.code = 'ETEST';
          throw error;
        }
        return tx.query(text, params);
      },
    })),
  };
}

test('lost COMMIT acknowledgement: object stays, exactly one document, download works', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const wrapped = { ...env, db: lostCommitAckOnce(db) };
  const { result: { response, data } } = await silencedRouteError(() => upload(wrapped, { cookie }));
  // Transakcja się zatwierdziła; upload() to wykrywa świeżym zapytaniem i
  // zwraca sukces zamiast usuwać obiekt, który ma już wiersz w documents.
  assert.equal(response.status, 201);
  assert.match(data.document.id, UUID);

  assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 1);
  assert.equal((await db.query("SELECT state FROM document_uploads")).rows[0].state, 'committed');
  const download = await get(env, `/api/documents/${data.document.id}/content`, cookie);
  assert.equal(download.status, 200);
}));

test('genuine rollback (object written, insert rolled back): object is deleted, upload marked abandoned, retry creates exactly one document', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const wrapped = { ...env, db: failInsideTransaction(db, 'UPDATE document_uploads') };
  const key = 'lost-write-key-1';
  const { result: { response }, errors } = await silencedRouteError(() => upload(wrapped, { cookie, key }));
  assert.equal(response.status, 503);
  assert.match(errors.join('\n'), /"code":"ETEST"/);

  // Wykryte od razu (baza jest osiągalna): obiekt usunięty, upload porzucony.
  assert.equal(storage.keys().length, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 0);
  const [uploadRow] = (await db.query('SELECT state, resolution FROM document_uploads')).rows;
  assert.equal(uploadRow.state, 'abandoned');
  assert.equal(uploadRow.resolution, 'insert_rolled_back');

  // Ponowienie tym samym kluczem: żaden wiersz documents nie istnieje, więc to
  // nie jest replay — powstaje dokładnie jeden nowy dokument i jeden obiekt.
  const { response: retryResponse, data } = await upload(env, { cookie, key });
  assert.equal(retryResponse.status, 201);
  assert.equal(data.replayed, undefined);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 1);
  assert.equal(storage.keys().length, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM document_uploads WHERE state = 'committed'")).rows[0].n, 1);
}));

test('database unreachable through the whole attempt (transaction and confirm both fail): object and pending row are left for the cleanup job', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  // Baza niedostępna przez CAŁĄ próbę: transakcja nie zdąża nic zapisać
  // (BEGIN/INSERT nigdy nie doszły), a potwierdzający SELECT też pada —
  // dziś nie da się rozstrzygnąć, więc nic nie ruszamy.
  // Zapytania przed próbą transakcji (sesja, wpis 'pending') idą normalnie;
  // dopiero PO nieudanej transakcji (BEGIN/INSERT nigdy nie doszły do bazy)
  // baza przestaje odpowiadać — to właśnie wtedy pada potwierdzający SELECT.
  let down = false;
  const wrapped = {
    ...env,
    db: {
      async query(text, params) {
        if (down) { const e = new Error('read ECONNRESET'); e.code = 'ECONNRESET'; throw e; }
        return db.query(text, params);
      },
      async transaction() {
        down = true;
        const error = new Error('connect ETIMEDOUT'); error.code = 'ETIMEDOUT';
        throw error;
      },
    },
  };
  const { result: { response } } = await silencedRouteError(() => upload(wrapped, { cookie }));
  assert.equal(response.status, 503);
  // Ani obiekt, ani wiersz uploadu nie zostały ruszone — nie wiadomo, co się stało.
  assert.equal(storage.keys().length, 1);
  assert.equal((await db.query("SELECT state FROM document_uploads")).rows[0].state, 'pending');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 0);
}));

test('download when the object is missing from the bucket gives 409 document_content_missing (not 503), with audit', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const objectKey = (await db.query('SELECT object_key FROM documents WHERE id = $1', [data.document.id])).rows[0].object_key;
  await storage.deleteObject(objectKey);

  const response = await get(env, `/api/documents/${data.document.id}/content`, cookie);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'document_content_missing');
  const [event] = await auditRows(db, 'document.content_missing');
  assert.equal(event.entity_id, data.document.id);
  assertNoPii(event.metadata_json);

  // Granica ról: przedstawiciel innej klasy dostaje 404, nie 409 — bez wyroczni.
  const { data: classDoc } = await upload(env, { cookie: await repA(db), kind: 'class', classId: 'c-1a' });
  const classDocId = classDoc.document.id;
  const missingObjectKey = (await db.query('SELECT object_key FROM documents WHERE id = $1', [classDocId])).rows[0].object_key;
  await storage.deleteObject(missingObjectKey);
  assert.equal((await get(env, `/api/documents/${classDocId}/content`, await repB(db))).status, 404);
  assert.equal((await get(env, `/api/documents/${classDocId}/content`, await repA(db))).status, 409);
}));

test('replay does not report success when the object behind the idempotency key is gone', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const first = await upload(env, { cookie, key: 'replay-missing-object' });
  assert.equal(first.response.status, 201);
  const objectKey = (await db.query('SELECT object_key FROM documents WHERE id = $1', [first.data.document.id])).rows[0].object_key;
  await storage.deleteObject(objectKey);

  const retry = await upload(env, { cookie, key: 'replay-missing-object' });
  assert.equal(retry.response.status, 409);
  assert.equal(retry.data.error, 'document_content_missing');
}));
