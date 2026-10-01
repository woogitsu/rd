// Prywatne dokumenty (issue #39). Wyłącznie syntetyczne pliki i dane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { handlePgRequest } from '../src/pg/app.js';
import { revokeRoleGrant } from '../src/pg/authorization.js';
import { assertNoPii } from '../src/pg/audit.js';
import {
  bodyLimitFor, DEFAULT_BODY_LIMIT_BYTES, DEFAULT_MAX_CONCURRENT_UPLOADS, detectType, maxUploadBytes,
  activeUploadSlots, DOCUMENT_VALIDATION_VERSION, HARD_MAX_UPLOAD_BYTES, resetUploadSlotsForTests, tryAcquireUploadSlot,
} from '../src/documents.js';
import { createMemoryStorage, createS3Storage, sha256Hex, signRequest, storageFromEnv } from '../src/storage.js';
import { resolveRuntime } from '../src/server.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const YEAR = 'y-2026';
const HOUR = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
import { syntheticJpeg, syntheticPng } from './helpers/synthetic-images.js';
const encoder = new TextEncoder();
const PDF = encoder.encode('%PDF-1.4\n% syntetyczny dokument testowy\n1 0 obj <<>> endobj\n%%EOF\n');
const PNG = syntheticPng();
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

// #185 pkt 3: piąty równoczesny upload dostaje 503 upload_busy BEZ dotknięcia
// magazynu ani bazy — sprawdzone bezpośrednio (semafor to stan procesu,
// PGlite i tak serializuje transakcje, więc nie da się tego odtworzyć przez
// prawdziwą równoległość żądań tutaj, patrz tests/pg-reconciliation-race.test.js).
test('a fifth concurrent upload gets 503 upload_busy with Retry-After, before the body is touched (licznik w procesie Node, nie transakcje bazy)', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  resetUploadSlotsForTests();
  const releases = Array.from({ length: DEFAULT_MAX_CONCURRENT_UPLOADS }, () => tryAcquireUploadSlot());
  assertEvery(releases, (release) => typeof release === 'function');
  try {
    const busy = await upload(env, { cookie });
    assert.equal(busy.response.status, 503);
    assert.equal(busy.data.error, 'upload_busy');
    assert.ok(busy.response.headers.get('retry-after'));
    assert.equal(storage.keys().length, 0, 'ciało nie zostało zapisane do magazynu');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM document_uploads')).rows[0].n, 0, 'ciało nie zostało nawet odczytane');
  } finally {
    for (const release of releases) release();
  }
  // Po zwolnieniu miejsc kolejny upload przebiega normalnie.
  assert.equal((await upload(env, { cookie })).response.status, 201);
  resetUploadSlotsForTests();
}));

// #185: ciało jest strumieniem, z którego trasa NIE może nic pobrać, zanim
// sprawdzi sesję, uprawnienie do rodzaju i typ. Atrapa strumienia liczy
// każdy pobrany bajt (highWaterMark 0 — nic nie jest pobierane z wyprzedzeniem).
function countingUpload(options, totalBytes = 10 * 1024 * 1024) {
  const base = uploadRequest(options);
  const counter = { pulled: 0 };
  const chunk = new Uint8Array(64 * 1024);
  chunk.set(PDF.subarray(0, 5));
  const body = new ReadableStream({
    pull(controller) {
      if (counter.pulled >= totalBytes) { controller.close(); return; }
      counter.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const headers = new Headers(base.headers);
  headers.set('Content-Length', String(totalBytes));
  return { counter, request: new Request(base.url, { method: 'POST', headers, body, duplex: 'half' }) };
}

test('#185: bez sesji, przedstawiciel z kind=financial i niedozwolony typ — odmowa bez odczytu ani jednego bajtu ciała', async () => withEnv(async (db, env, storage) => {
  resetUploadSlotsForTests();
  const rep = await repA(db);
  const cases = [
    { options: {}, status: 401, error: 'unauthenticated' },
    { options: { cookie: rep, kind: 'financial' }, status: 403, error: 'forbidden' },
    { options: { cookie: await treasurer(db), type: 'text/html' }, status: 415, error: 'unsupported_media_type' },
  ];
  for (const { options, status, error } of cases) {
    const { counter, request: req } = countingUpload(options);
    const response = await handlePgRequest(req, env);
    assert.equal(response.status, status, error);
    assert.equal((await response.json()).error, error);
    assert.equal(counter.pulled, 0, `${error}: trasa nie może czytać ciała przed odmową`);
  }
  assert.equal(storage.keys().length, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM document_uploads')).rows[0].n, 0);
}, { documentMaxBytes: 25 * 1024 * 1024 }));

test('#185: ten sam użytkownik ma najwyżej 2 uploady naraz; inny użytkownik nadal wysyła (licznik w procesie Node, nie transakcje bazy)', async () => withEnv(async (db, env) => {
  resetUploadSlotsForTests();
  const cookie = await treasurer(db);
  const own = [tryAcquireUploadSlot(undefined, 'u-treasurer'), tryAcquireUploadSlot(undefined, 'u-treasurer')];
  try {
    const { counter, request: req } = countingUpload({ cookie });
    const busy = await handlePgRequest(req, env);
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).error, 'upload_busy');
    assert.ok(busy.headers.get('retry-after'));
    assert.equal(counter.pulled, 0, 'ciało trzeciego uploadu nie jest czytane');
    const other = await seedUserSession(db, { userId: 'u-treasurer-2', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    assert.equal((await upload(env, { cookie: other })).response.status, 201, 'limit dotyczy użytkownika, nie wszystkich');
  } finally {
    for (const release of own) release();
  }
  assert.equal((await upload(env, { cookie })).response.status, 201);
  resetUploadSlotsForTests();
}));

// Podwójne kliknięcie dużego pliku: dwa równoległe żądania z tym samym kluczem
// idempotencji mieszczą się w limicie na użytkownika, a na końcu jest jeden dokument.
test('#185: podwójne kliknięcie (ten sam klucz, równolegle) daje jeden dokument', async () => withEnv(async (db, env, storage) => {
  resetUploadSlotsForTests();
  const cookie = await treasurer(db);
  const key = `double-click-${Date.now()}`;
  const [first, second] = await Promise.all([upload(env, { cookie, key }), upload(env, { cookie, key })]);
  assert.deepEqual([first.response.status, second.response.status].sort(), [200, 201]);
  assert.equal(first.data.document.id, second.data.document.id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 1);
  assert.equal(storage.keys().length, 1);
  assert.equal(activeUploadSlots(), 0, 'oba miejsca zwolnione');
}));

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

// --- Wersje i unieważnienie dokumentu (issue #82) -----------------------------------

function statusRequest({ cookie, id, action, key, body, origin, headers = {} }) {
  return request(`/api/documents/${id}/${action}`, {
    method: 'POST', cookie, origin,
    headers: { 'Idempotency-Key': key ?? `status-key-${++keyCounter}-${Date.now()}`, ...headers },
    body: body ?? { reason: 'Poprawka po pomyłce w kwocie' },
  });
}

async function changeStatus(env, options) {
  const response = await handlePgRequest(statusRequest(options), env);
  return { response, data: await response.json().catch(() => null) };
}

test('treasurer supersedes a financial document with another of the same kind/year; old one leaves the active list but stays downloadable', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const original = await upload(env, { cookie });
  const replacement = await upload(env, { cookie });

  const result = await changeStatus(env, {
    cookie, id: original.data.document.id, action: 'supersede',
    body: { replacementDocumentId: replacement.data.document.id, reason: 'Faktura korygująca — zła kwota' },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.statusEvent.action, 'superseded');

  const meta = await get(env, `/api/documents/${original.data.document.id}`, cookie);
  const metaData = await meta.json();
  assert.equal(metaData.document.status, 'superseded');
  assert.equal(metaData.document.replacementDocumentId, replacement.data.document.id);

  const replacementMeta = await (await get(env, `/api/documents/${replacement.data.document.id}`, cookie)).json();
  assert.equal(replacementMeta.supersedes, original.data.document.id);

  // Download still works — the file stays in the archive.
  assert.equal((await get(env, `/api/documents/${original.data.document.id}/content`, cookie)).status, 200);

  const activeList = await (await get(env, `/api/documents?schoolYearId=${YEAR}`, cookie)).json();
  assert.equal(activeList.documents.some((d) => d.id === original.data.document.id), false);
  const allList = await (await get(env, `/api/documents?schoolYearId=${YEAR}&status=all`, cookie)).json();
  assert.equal(allList.documents.some((d) => d.id === original.data.document.id), true);

  const rows = await auditRows(db, 'document.superseded');
  assert.equal(rows.length, 1);
  await assertNoPii(rows.map((row) => row.metadata_json));
  assert.equal(JSON.stringify(rows[0].metadata_json).includes('korygująca'), false);
}));

test('void a document: it disappears from the default list, but content stays downloadable', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const result = await changeStatus(env, { cookie, id: data.document.id, action: 'void' });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.statusEvent.action, 'voided');

  const activeList = await (await get(env, `/api/documents?schoolYearId=${YEAR}`, cookie)).json();
  assert.equal(activeList.documents.length, 0);
  assert.equal((await get(env, `/api/documents/${data.document.id}/content`, cookie)).status, 200);

  const rows = await auditRows(db, 'document.voided');
  assert.equal(rows.length, 1);
}));

test('repeated void of an already-voided document replays instead of erroring', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const first = await changeStatus(env, { cookie, id: data.document.id, action: 'void', key: 'void-key-1' });
  const retry = await changeStatus(env, { cookie, id: data.document.id, action: 'void', key: 'void-key-2' });
  assert.equal(first.response.status, 201);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.statusEvent.id, first.data.statusEvent.id);
  const count = await db.query('SELECT count(*)::int AS n FROM document_status_events WHERE document_id = $1', [data.document.id]);
  assert.equal(count.rows[0].n, 1);
}));

test('a voided document cannot be superseded, and a superseded one cannot be voided again', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const voided = await upload(env, { cookie });
  await changeStatus(env, { cookie, id: voided.data.document.id, action: 'void' });
  const replacement = await upload(env, { cookie });
  const attempt = await changeStatus(env, {
    cookie, id: voided.data.document.id, action: 'supersede', body: { replacementDocumentId: replacement.data.document.id, reason: 'proba' },
  });
  assert.equal(attempt.response.status, 409);
  assert.equal(attempt.data.error, 'document_status_conflict');

  const supersededOriginal = await upload(env, { cookie });
  const supersededReplacement = await upload(env, { cookie });
  await changeStatus(env, {
    cookie, id: supersededOriginal.data.document.id, action: 'supersede',
    body: { replacementDocumentId: supersededReplacement.data.document.id, reason: 'zastapienie' },
  });
  const voidAttempt = await changeStatus(env, { cookie, id: supersededOriginal.data.document.id, action: 'void' });
  assert.equal(voidAttempt.response.status, 409);
  assert.equal(voidAttempt.data.error, 'document_status_conflict');
}));

test('cycle A -> B -> A is rejected: B cannot be superseded by A once A is already superseded by B', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const a = await upload(env, { cookie });
  const b = await upload(env, { cookie });
  const first = await changeStatus(env, {
    cookie, id: a.data.document.id, action: 'supersede', body: { replacementDocumentId: b.data.document.id, reason: 'A do B' },
  });
  assert.equal(first.response.status, 201);
  const cycle = await changeStatus(env, {
    cookie, id: b.data.document.id, action: 'supersede', body: { replacementDocumentId: a.data.document.id, reason: 'B do A' },
  });
  assert.equal(cycle.response.status, 409);
  assert.equal(cycle.data.error, 'document_status_replacement_not_active');
}));

test('replacement from a different year or class is rejected with 400', async () => withEnv(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  const classA = await upload(env, { cookie, kind: 'class', classId: 'c-1a' });
  const classB = await upload(env, { cookie, kind: 'class', classId: 'c-1b' });
  const attempt = await changeStatus(env, {
    cookie, id: classA.data.document.id, action: 'supersede', body: { replacementDocumentId: classB.data.document.id, reason: 'zla klasa' },
  });
  assert.equal(attempt.response.status, 400);
  assert.equal(attempt.data.error, 'invalid_replacement_document');
}));

test('class representative cannot supersede or void a document of another class (404, no oracle)', async () => withEnv(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  const docA = await upload(env, { cookie, kind: 'class', classId: 'c-1a' });
  const repBCookie = await repB(db);
  const denied = await changeStatus(env, { cookie: repBCookie, id: docA.data.document.id, action: 'void' });
  assert.equal(denied.response.status, 404);
}));

test('treasurer without MFA cannot void a financial document (global MFA gate, 403 mfa_enrollment_required)', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const noMfa = await seedUserSession(db, { userId: 'u-treasurer-no-mfa', roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const attempt = await changeStatus(env, { cookie: noMfa, id: data.document.id, action: 'void' });
  // Jak reszta API dokumentów (src/pg/app.js: globalna bramka MFA przed
  // dotarciem do trasy) — nie 404, bo to sesja bez potwierdzonego MFA, a nie
  // nieautoryzowany dostęp do konkretnego dokumentu. Konto bez zarejestrowanego
  // czynnika dostaje mfa_enrollment_required (mfa-policy.js), nie mfa_required
  // (to drugie jest dla czynnika zarejestrowanego, ale niepotwierdzonego w tej sesji).
  assert.equal(attempt.response.status, 403);
  assert.equal(attempt.data.error, 'mfa_enrollment_required');
}));

test('double click on supersede with the same Idempotency-Key reuses the row; different content conflicts', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const original = await upload(env, { cookie });
  const replacement = await upload(env, { cookie });
  const key = 'supersede-double-click';
  const first = await changeStatus(env, {
    cookie, id: original.data.document.id, action: 'supersede', key, body: { replacementDocumentId: replacement.data.document.id, reason: 'powod r1' },
  });
  const retry = await changeStatus(env, {
    cookie, id: original.data.document.id, action: 'supersede', key, body: { replacementDocumentId: replacement.data.document.id, reason: 'powod r1' },
  });
  assert.equal(first.response.status, 201);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.replayed, true);

  const other = await upload(env, { cookie });
  const conflict = await changeStatus(env, {
    cookie, id: original.data.document.id, action: 'supersede', key, body: { replacementDocumentId: other.data.document.id, reason: 'powod r2' },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.error, 'idempotency_conflict');
}));

test('invalid reason and unknown or malformed replacement id are rejected', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  assert.equal((await changeStatus(env, { cookie, id: data.document.id, action: 'void', body: { reason: 'ab' } })).response.status, 400);
  assert.equal((await changeStatus(env, {
    cookie, id: data.document.id, action: 'supersede', body: { replacementDocumentId: 'not-a-uuid', reason: 'poprawny powod' },
  })).response.status, 400);
  assert.equal((await changeStatus(env, {
    cookie, id: data.document.id, action: 'supersede',
    body: { replacementDocumentId: '00000000-0000-4000-8000-000000000000', reason: 'poprawny powod' },
  })).response.status, 400);
}));

test('document_status_events rows are immutable', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  await changeStatus(env, { cookie, id: data.document.id, action: 'void' });
  await assert.rejects(
    db.query("UPDATE document_status_events SET action = 'superseded' WHERE document_id = $1", [data.document.id]),
    /document_status_events_are_immutable/,
  );
  await assert.rejects(
    db.query('DELETE FROM document_status_events WHERE document_id = $1', [data.document.id]),
    /document_status_events_are_immutable/,
  );
}));

test('cross-origin status change request is refused before touching the database', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const response = await handlePgRequest(statusRequest({ cookie, id: data.document.id, action: 'void', origin: 'https://evil.example' }), env);
  assert.equal(response.status, 403);
  const count = await db.query('SELECT count(*)::int AS n FROM document_status_events');
  assert.equal(count.rows[0].n, 0);
}));
// --- #82: brakujące przypadki z listy „Testy do dodania” ---------------------------

async function statusEventCount(db, id) {
  return (await db.query('SELECT count(*)::int AS n FROM document_status_events WHERE document_id = $1', [id])).rows[0].n;
}

test('#82 wyścig: dwa równoległe zastąpienia tego samego dokumentu RÓŻNYMI wersjami — jedno 201, drugie 409 (nie powtórka) (PGlite: po kolei, nie wyścig)', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const original = await upload(env, { cookie });
  const first = await upload(env, { cookie });
  const second = await upload(env, { cookie });
  const results = await Promise.all([first, second].map((replacement) => changeStatus(env, {
    cookie, id: original.data.document.id, action: 'supersede',
    body: { replacementDocumentId: replacement.data.document.id, reason: 'Równoległa poprawka' },
  })));
  assert.deepEqual(results.map((r) => r.response.status).sort(), [201, 409]);
  const lost = results.find((r) => r.response.status === 409);
  assert.equal(lost.data.error, 'document_status_conflict');
  assert.equal(lost.data.statusEvent, undefined, 'przegrany nie dostaje cudzego zdarzenia jako sukcesu');
  assert.equal(await statusEventCount(db, original.data.document.id), 1);
  assert.equal((await auditRows(db, 'document.superseded')).length, 1);

  // Już po fakcie (sekwencyjnie, nowy klucz): zastąpienie inną wersją nadal 409,
  // tą samą — bezpieczna powtórka.
  const won = results.find((r) => r.response.status === 201).data.statusEvent.replacementDocumentId;
  const loserId = won === first.data.document.id ? second.data.document.id : first.data.document.id;
  const later = await changeStatus(env, {
    cookie, id: original.data.document.id, action: 'supersede', body: { replacementDocumentId: loserId, reason: 'Późniejsza próba' },
  });
  assert.deepEqual([later.response.status, later.data.error], [409, 'document_status_conflict']);
  const same = await changeStatus(env, {
    cookie, id: original.data.document.id, action: 'supersede', body: { replacementDocumentId: won, reason: 'Powtórka po błędzie sieci' },
  });
  assert.deepEqual([same.response.status, same.data.replayed], [200, true]);
  assert.equal(await statusEventCount(db, original.data.document.id), 1);
}));

test('#82 podwójne kliknięcie „Unieważnij” (ten sam klucz, równolegle): jedno zdarzenie i jeden wpis audytu', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const results = await Promise.all([0, 1].map(() => changeStatus(env, { cookie, id: data.document.id, action: 'void', key: 'void-double-click-82' })));
  assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 201]);
  assert.equal(results[0].data.statusEvent.id, results[1].data.statusEvent.id);
  assert.equal(await statusEventCount(db, data.document.id), 1);
  assert.equal((await auditRows(db, 'document.voided')).length, 1);
}));

test('#82 granice ról: przedstawiciel unieważnia dokument własnej klasy, a dokument innej klasy, zarządu i finansowy daje 404 bez zapisu', async () => withEnv(async (db, env) => {
  const board = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  const own = await upload(env, { cookie: board, kind: 'class', classId: 'c-1a' });
  const otherClass = await upload(env, { cookie: board, kind: 'class', classId: 'c-1b' });
  const boardDoc = await upload(env, { cookie: board, kind: 'board' });
  const financial = await upload(env, { cookie: await treasurer(db) });
  const repACookie = await repA(db);

  for (const doc of [otherClass, boardDoc, financial]) {
    const id = doc.data.document.id;
    const voided = await changeStatus(env, { cookie: repACookie, id, action: 'void' });
    assert.deepEqual([voided.response.status, voided.data.error], [404, 'not_found']);
    const superseded = await changeStatus(env, {
      cookie: repACookie, id, action: 'supersede', body: { replacementDocumentId: own.data.document.id, reason: 'Próba spoza klasy' },
    });
    assert.deepEqual([superseded.response.status, superseded.data.error], [404, 'not_found']);
    assert.equal(await statusEventCount(db, id), 0);
  }
  // Zastąpienie własnego dokumentu wersją z innej klasy nie ujawnia jej istnienia inaczej niż zwykłe 400.
  const crossReplacement = await changeStatus(env, {
    cookie: repACookie, id: own.data.document.id, action: 'supersede',
    body: { replacementDocumentId: otherClass.data.document.id, reason: 'Wersja z innej klasy' },
  });
  assert.deepEqual([crossReplacement.response.status, crossReplacement.data.error], [400, 'invalid_replacement_document']);

  const ownVoid = await changeStatus(env, { cookie: repACookie, id: own.data.document.id, action: 'void' });
  assert.equal(ownVoid.response.status, 201);
  assert.equal((await auditRows(db, 'document.voided'))[0].actor_id, 'u-rep-a');
}));

test('#82 zastąpienie dokumentem z innego roku szkolnego — 400 invalid_replacement_document', async () => withEnv(async (db, env) => {
  await seedSchoolYear(db, 'y-2025', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  const cookie = await treasurer(db, { roles: [{ role: 'treasurer', schoolYearId: YEAR }, { role: 'treasurer', schoolYearId: 'y-2025' }] });
  const original = await upload(env, { cookie });
  const otherYearId = '00000000-0000-4000-8000-0000000082a1';
  await db.query(
    `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
     VALUES ($1, 'docs/' || $1, 'application/pdf', 10, 'financial', 'u-treasurer', 'y-2025', repeat('c', 64), 'doc-82-other-year')`,
    [otherYearId],
  );
  const attempt = await changeStatus(env, {
    cookie, id: original.data.document.id, action: 'supersede', body: { replacementDocumentId: otherYearId, reason: 'Wersja z zeszłego roku' },
  });
  assert.deepEqual([attempt.response.status, attempt.data.error], [400, 'invalid_replacement_document']);
  assert.equal(await statusEventCount(db, original.data.document.id), 0);
}));

test('#82 zamknięty rok: nowej wersji nie da się przesłać ani wskazać (409 school_year_closed); unieważnienie pozostaje możliwe', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const original = await upload(env, { cookie });
  // Wersja zastępująca przesłana jeszcze przed zamknięciem roku.
  const replacement = await upload(env, { cookie });
  const mistaken = await upload(env, { cookie });
  // Zastąpienie zapisane przed zamknięciem — jego ponowienie po zamknięciu to powtórka.
  const earlier = await upload(env, { cookie });
  const earlierReplacement = await upload(env, { cookie });
  const earlierBody = { replacementDocumentId: earlierReplacement.data.document.id, reason: 'Przed zamknięciem' };
  const beforeClose = await changeStatus(env, { cookie, id: earlier.data.document.id, action: 'supersede', key: 'supersede-before-close', body: earlierBody });
  assert.equal(beforeClose.response.status, 201);

  await seedSchoolYear(db, 'y-2027-next', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-doc-status', '${YEAR}', 'y-2027-next', 'closed', 'u-a', 'u-b', now(), 0, 0, 0, 0, 'ob-next', 0);
    SET session_replication_role = origin;
  `);

  const lateUpload = await upload(env, { cookie });
  assert.deepEqual([lateUpload.response.status, lateUpload.data.error], [409, 'school_year_closed']);

  const supersede = await changeStatus(env, {
    cookie, id: original.data.document.id, action: 'supersede',
    body: { replacementDocumentId: replacement.data.document.id, reason: 'Korekta po zamknięciu roku' },
  });
  assert.deepEqual([supersede.response.status, supersede.data.error], [409, 'school_year_closed']);
  assert.equal(await statusEventCount(db, original.data.document.id), 0);
  assert.equal((await auditRows(db, 'document.superseded')).length, 1, 'tylko zastąpienie sprzed zamknięcia');

  const retry = await changeStatus(env, { cookie, id: earlier.data.document.id, action: 'supersede', key: 'supersede-before-close', body: earlierBody });
  assert.deepEqual([retry.response.status, retry.data.replayed], [200, true]);

  // Wariant zachowawczy (D-04/D-07): omyłkowo wgrany plik można ukryć z domyślnej listy
  // także w zamkniętym roku; plik i wpis documents zostają.
  const voided = await changeStatus(env, { cookie, id: mistaken.data.document.id, action: 'void', body: { reason: 'Plik wgrany omyłkowo' } });
  assert.equal(voided.response.status, 201);
  assert.equal((await get(env, `/api/documents/${mistaken.data.document.id}/content`, cookie)).status, 200);
}));

// --- Tytuł, kategoria i wyszukiwanie (issue #76) ------------------------------------

function describeRequest({ cookie, id, key, body, origin, headers = {} }) {
  return request(`/api/documents/${id}/description`, {
    method: 'POST', cookie, origin,
    headers: { 'Idempotency-Key': key ?? `desc-key-${++keyCounter}-${Date.now()}`, ...headers },
    body: body ?? { title: 'Faktura — wynajem sali, październik', category: 'faktura', documentDate: '2026-10-05' },
  });
}

async function describe(env, options) {
  const response = await handlePgRequest(describeRequest(options), env);
  return { response, data: await response.json().catch(() => null) };
}

test('treasurer adds a title and category to a financial document; history keeps the previous version', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const id = data.document.id;

  const first = await describe(env, { cookie, id });
  assert.equal(first.response.status, 201);
  assert.equal(first.data.description.revisionNo, 1);
  assert.equal(first.data.description.title, 'Faktura — wynajem sali, październik');

  const second = await describe(env, {
    cookie, id, body: { title: 'Faktura — wynajem sali, poprawiona data', category: 'faktura', documentDate: '2026-10-06' },
  });
  assert.equal(second.response.status, 201);
  assert.equal(second.data.description.revisionNo, 2);

  const meta = await get(env, `/api/documents/${id}`, cookie);
  const metaData = await meta.json();
  assert.equal(metaData.document.title, 'Faktura — wynajem sali, poprawiona data');
  assert.equal(metaData.descriptionHistory.length, 2);
  assert.equal(metaData.descriptionHistory[0].revisionNo, 2);
  assert.equal(metaData.descriptionHistory[1].revisionNo, 1);
  assert.equal(metaData.descriptionHistory[1].title, 'Faktura — wynajem sali, październik');

  const rows = await auditRows(db, 'document.described');
  assert.equal(rows.length, 2);
  await assertNoPii(rows.map((row) => row.metadata_json));
  assert.equal(JSON.stringify(rows[0].metadata_json).includes('Faktura'), false);
}));

test('class representative can only describe documents of their own class', async () => withEnv(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  const { data } = await upload(env, { cookie, kind: 'class', classId: 'c-1a' });
  const id = data.document.id;

  const repACookie = await repA(db);
  const okResponse = await describe(env, { cookie: repACookie, id });
  assert.equal(okResponse.response.status, 201);

  const repBCookie = await repB(db);
  const denied = await describe(env, { cookie: repBCookie, id, key: `desc-key-${++keyCounter}` });
  assert.equal(denied.response.status, 404);
}));

test('unknown document id gives the same 404 as an inaccessible one (no existence oracle)', async () => withEnv(async (db, env) => {
  const repBCookie = await repB(db);
  const missing = await describe(env, { cookie: repBCookie, id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(missing.response.status, 404);
}));

test('double click and network retry with the same Idempotency-Key reuse the row; different content conflicts', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const id = data.document.id;
  const key = 'describe-double-click';

  const first = await describe(env, { cookie, id, key });
  const retry = await describe(env, { cookie, id, key });
  assert.equal(first.response.status, 201);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.description.revisionNo, 1);

  const conflict = await describe(env, { cookie, id, key, body: { title: 'Inny tytuł, ten sam klucz', category: 'inne' } });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.error, 'idempotency_conflict');

  const count = await db.query('SELECT count(*)::int AS n FROM document_descriptions WHERE document_id = $1', [id]);
  assert.equal(count.rows[0].n, 1);
}));

test('description validation: title length, unknown category, malformed date and oversize description', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const id = data.document.id;

  assert.equal((await describe(env, { cookie, id, body: { title: 'ab', category: 'faktura' } })).response.status, 400);
  assert.equal((await describe(env, { cookie, id, body: { title: 'Poprawny tytuł', category: 'nieznana' } })).response.status, 400);
  assert.equal((await describe(env, { cookie, id, body: { title: 'Poprawny tytuł', category: 'faktura', documentDate: '2026-13-40' } })).response.status, 400);
  assert.equal((await describe(env, { cookie, id, body: { title: 'Poprawny tytuł', category: 'faktura', description: 'x'.repeat(1001) } })).response.status, 400);
  assert.equal((await describe(env, { cookie, id, key: 'no-body-key' })).response.status, 201);
}));

test('search finds a title within scope, but never a document from another class or from board (no oracle)', async () => withEnv(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  const uploadA = await upload(env, { cookie, kind: 'class', classId: 'c-1a' });
  const uploadB = await upload(env, { cookie, kind: 'class', classId: 'c-1b' });
  const uploadBoard = await upload(env, { cookie, kind: 'board' });
  await describe(env, { cookie, id: uploadA.data.document.id, body: { title: 'Regulamin wycieczki klasowej', category: 'regulamin' } });
  await describe(env, { cookie, id: uploadB.data.document.id, body: { title: 'Regulamin świetlicy', category: 'regulamin' } });
  await describe(env, { cookie, id: uploadBoard.data.document.id, body: { title: 'Regulamin Rady Rodziców', category: 'regulamin' } });

  const repACookie = await repA(db);
  const response = await get(env, `/api/documents?schoolYearId=${YEAR}&q=Regulamin`, repACookie);
  const listData = await response.json();
  assert.equal(response.status, 200);
  assert.equal(listData.documents.length, 1);
  assert.equal(listData.documents[0].title, 'Regulamin wycieczki klasowej');
}));

test('category filter narrows the list in SQL', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const invoice = await upload(env, { cookie });
  const bankStatement = await upload(env, { cookie });
  await describe(env, { cookie, id: invoice.data.document.id, body: { title: 'Faktura za wynajem', category: 'faktura' } });
  await describe(env, { cookie, id: bankStatement.data.document.id, body: { title: 'Wyciąg bankowy wrzesień', category: 'wyciag' } });

  const response = await get(env, `/api/documents?schoolYearId=${YEAR}&category=wyciag`, cookie);
  const listData = await response.json();
  assert.equal(listData.documents.length, 1);
  assert.equal(listData.documents[0].category, 'wyciag');
}));

test('document without any description shows title: null (panel renders "Bez tytułu")', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const meta = await get(env, `/api/documents/${data.document.id}`, cookie);
  const metaData = await meta.json();
  assert.equal(metaData.document.title, null);
  assert.equal(metaData.descriptionHistory.length, 0);
}));

test('document_descriptions rows are immutable', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  await describe(env, { cookie, id: data.document.id });
  await assert.rejects(
    db.query("UPDATE document_descriptions SET title = 'x' WHERE document_id = $1", [data.document.id]),
    /document_descriptions_are_immutable/,
  );
  await assert.rejects(
    db.query('DELETE FROM document_descriptions WHERE document_id = $1', [data.document.id]),
    /document_descriptions_are_immutable/,
  );
}));

test('cross-origin describe request is refused before touching the database', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const response = await handlePgRequest(describeRequest({ cookie, id: data.document.id, origin: 'https://evil.example' }), env);
  assert.equal(response.status, 403);
  const count = await db.query('SELECT count(*)::int AS n FROM document_descriptions');
  assert.equal(count.rows[0].n, 0);
}));

// Zamrożenie roku (follow-up #76/#313, 0106_document_descriptions_year_freeze.sql):
// document_descriptions nie ma własnej kolumny school_year_id — rok ustala
// dokument-rodzic. Zamknięcie "na skróty" (jak w tests/pg-year-close-finance-freeze.test.js)
// wyłącznie wstawia wiersz zamknięcia, bez wygaszania przydziałów ról ani
// prawdziwej procedury /close — interesuje nas wyłącznie trigger a0_year_freeze.
test('opis dokumentu: w otwartym roku działa, po zamknięciu roku dokumentu-rodzica 409 school_year_closed', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const id = data.document.id;

  const open = await describe(env, { cookie, id });
  assert.equal(open.response.status, 201);

  await seedSchoolYear(db, 'y-2027-next', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-doc-desc', '${YEAR}', 'y-2027-next', 'closed', 'u-a', 'u-b', now(), 0, 0, 0, 0, 'ob-next', 0);
    SET session_replication_role = origin;
  `);

  const closed = await describe(env, { cookie, id, key: 'desc-key-closed-year' });
  assert.equal(closed.response.status, 409);
  assert.equal(closed.data.error, 'school_year_closed');

  // Odrzucenie triggera cofa transakcję — żadnej nowej wersji opisu.
  const count = await db.query('SELECT count(*)::int AS n FROM document_descriptions WHERE document_id = $1', [id]);
  assert.equal(count.rows[0].n, 1);
}));

// Dokumenty przywrócone bez school_year_id (np. z D1) nie są objęte
// zamrożeniem — school_year_assert_open() pomija NULL, ten sam wzorzec co
// przy samym documents (0036). Sprawdzenie na poziomie bazy (bez API): sam
// canAccessDocument już i tak odmawia dostępu do dokumentu bez roku
// (niezależnie od zamrożenia), więc tu weryfikujemy wyłącznie trigger.
test('trigger a0_year_freeze na document_descriptions pomija dokument bez school_year_id', async () => {
  const db = await createTestDb();
  try {
    await db.query(
      `INSERT INTO users (id, email, display_name) VALUES ('u-legacy', 'u-legacy@example.invalid', 'Legacy')`,
    );
    const legacyId = '00000000-0000-4000-8000-0000000000d1';
    await db.query(
      `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
       VALUES ($1, 'legacy/obj', 'application/pdf', 10, 'board', 'u-legacy', NULL, repeat('a', 64), 'legacy-doc-key')`,
      [legacyId],
    );
    await db.query(
      `INSERT INTO document_descriptions (document_id, revision_no, title, category, created_by)
       VALUES ($1, 1, 'Tytuł dokumentu bez roku', 'inne', 'u-legacy')`,
      [legacyId],
    );
    const count = await db.query('SELECT count(*)::int AS n FROM document_descriptions WHERE document_id = $1', [legacyId]);
    assert.equal(count.rows[0].n, 1);
  } finally {
    await db.close();
  }
});

// --- Podgląd inline (issue #89) -----------------------------------------------------

const SVG = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
// PDF 1.5: akcja JavaScript schowana w skompresowanym strumieniu obiektów — niewidoczna
// w surowych bajtach (kontrola sprzed #89 część 2 przepuszczała taki plik).
function pdfWithHiddenScript() {
  const payload = deflateSync(Buffer.from('5 0 << /S /JavaScript /JS (app.alert(1)) >>', 'latin1'));
  return new Uint8Array(Buffer.concat([
    Buffer.from(`%PDF-1.5\n1 0 obj << /Type /Catalog /OpenAction 5 0 R >> endobj\n9 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${payload.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    payload,
    Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]));
}

// Dokument „sprzed kontroli struktury” (#301) albo sprzed jej zaostrzenia: wiersz i obiekt
// zapisane z pominięciem trasy (tak jak przywrócone/zmigrowane dane), z poprawnym skrótem.
// validationVersion: domyślnie NULL (wiersz sprzed 0161 — wersja reguł nieznana).
async function insertLegacyDocument(db, storage, {
  bytes, mimeType = 'application/pdf', createdBy = 'u-treasurer', validationVersion = null,
}) {
  const id = crypto.randomUUID();
  const objectKey = `docs/${crypto.randomUUID()}`;
  await storage.putObject(objectKey, bytes, mimeType);
  await db.query(
    `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key,
                            validation_version)
     VALUES ($1, $2, $3, $4, 'financial', $5, $6, $7, $8, $9)`,
    [id, objectKey, mimeType, bytes.length, createdBy, YEAR, sha256Hex(bytes), `legacy-${id}`, validationVersion],
  );
  return id;
}

const JPEG = syntheticJpeg();
const preview = (env, id, cookie, extra = '') => get(env, `/api/documents/${id}/content?disposition=inline${extra}`, cookie);

test('inline preview of PDF, PNG and JPEG: safe headers, byte-identical body, audited as document.viewed only', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const samples = [[PDF, 'application/pdf', 'pdf'], [PNG, 'image/png', 'png'], [JPEG, 'image/jpeg', 'jpg']];
  for (const [bytes, type, extension] of samples) {
    const { data } = await upload(env, { cookie, bytes, type });
    const response = await preview(env, data.document.id, cookie);
    assert.equal(response.status, 200, type);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal(response.headers.get('Content-Type'), type);
    assert.equal(response.headers.get('Content-Disposition'), `inline; filename="dokument-${data.document.id}.${extension}"`);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
    const csp = response.headers.get('Content-Security-Policy');
    assert.match(csp, /^sandbox;/);
    assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/);
    assert.match(csp, /default-src 'none'/);
    assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  }
  const viewed = await auditRows(db, 'document.viewed');
  assert.equal(viewed.length, 3);
  assertEvery(viewed, (event) => event.actor_id === 'u-treasurer');
  viewed.forEach((event) => assertNoPii(event.metadata_json));
  assert.equal((await auditRows(db, 'document.downloaded')).length, 0);
  // Pobranie nadal jest załącznikiem, bez zgody na ramkę i osobnym zdarzeniem.
  const { data } = await upload(env, { cookie });
  const download = await get(env, `/api/documents/${data.document.id}/content`, cookie);
  assert.match(download.headers.get('Content-Disposition'), /^attachment;/);
  assert.equal(download.headers.get('X-Frame-Options'), null);
  assert.equal((await auditRows(db, 'document.downloaded')).length, 1);
  assert.equal((await auditRows(db, 'document.viewed')).length, 3);
}));

test('explicit disposition=attachment behaves as a download; unknown values are 400 without touching the bucket or the log', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const attachment = await get(env, `/api/documents/${data.document.id}/content?disposition=attachment`, cookie);
  assert.equal(attachment.status, 200);
  assert.match(attachment.headers.get('Content-Disposition'), /^attachment;/);
  for (const value of ['', 'INLINE', 'inline;x', 'script', 'inline%00']) {
    const response = await get(env, `/api/documents/${data.document.id}/content?disposition=${value}`, cookie);
    assert.equal(response.status, 400, value);
    assert.equal((await response.json()).error, 'invalid_disposition');
  }
  assert.equal((await auditRows(db, 'document.viewed')).length, 0);
}));

test('preview without a session is 401, unknown id is 404, nothing is logged as viewed', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  assert.equal((await preview(env, data.document.id)).status, 401);
  assert.equal((await preview(env, crypto.randomUUID(), cookie)).status, 404);
  assert.equal((await preview(env, '../x', cookie)).status, 404);
  assert.equal((await auditRows(db, 'document.viewed')).length, 0);
}));

test('preview role boundaries: class rep only sees own class; board and financial documents give 404 (+ access_denied); no MFA is stopped', async () => withEnv(async (db, env) => {
  const owner = await treasurer(db);
  const board = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const financial = (await upload(env, { cookie: owner })).data.document.id;
  const boardDoc = (await upload(env, { cookie: board, kind: 'board' })).data.document.id;
  const classDoc = (await upload(env, { cookie: board, kind: 'class', classId: 'c-1a', bytes: PNG, type: 'image/png' })).data.document.id;
  const rep = await repA(db);

  assert.equal((await preview(env, boardDoc, rep)).status, 404);
  assert.equal((await preview(env, financial, rep)).status, 404);
  assert.equal((await preview(env, classDoc, await repB(db))).status, 404);
  assert.equal((await preview(env, classDoc, rep)).status, 200);
  const denied = await auditRows(db, 'document.access_denied');
  assert.deepEqual(denied.map((event) => event.entity_id).sort(), [boardDoc, classDoc, financial].sort());

  // Skarbnik bez MFA nie otwiera podglądu dokumentu finansowego (bramka MFA routera),
  // a skarbnik z MFA — nie widzi dokumentu zarządu.
  const noMfa = await seedUserSession(db, { userId: 'u-nomfa', roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  assert.equal((await preview(env, financial, noMfa)).status, 403);
  assert.equal((await preview(env, boardDoc, owner)).status, 404);
  assert.equal((await preview(env, financial, owner)).status, 200);
  // Tylko udane podglądy trafiają do dziennika jako „viewed”.
  assert.deepEqual((await auditRows(db, 'document.viewed')).map((event) => event.entity_id).sort(), [classDoc, financial].sort());
}));

test('preview access expires with the grant and with the session (no reusable link)', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const id = data.document.id;
  assert.equal((await preview(env, id, cookie)).status, 200);
  // Ten sam adres bez ciasteczka sesji nic nie wydaje: URL nie niesie uprawnienia.
  assert.equal((await preview(env, id)).status, 401);
  const expiredGrant = await seedUserSession(db, { userId: 'u-expired', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR, expiresAt: new Date(Date.now() - HOUR) }] });
  assert.equal((await preview(env, id, expiredGrant)).status, 404);
  const expiredSession = await treasurer(db, { userId: 'u-t2', expiresAt: new Date(Date.now() - HOUR) });
  assert.equal((await preview(env, id, expiredSession)).status, 401);
  const [grant] = (await db.query("SELECT id FROM role_grants WHERE user_id = 'u-treasurer'")).rows;
  assert.equal(await revokeRoleGrant(env, { grantId: grant.id, actorId: 'u-treasurer' }), true);
  assert.equal((await preview(env, id, cookie)).status, 404);
}));

test('preview of a tampered or missing object is not served and not logged as viewed', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const { data } = await upload(env, { cookie });
  const [key] = storage.keys();
  storage.raw(key).body[10] ^= 0xff;
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await preview(env, data.document.id, cookie)).status, 503);
  } finally { console.error = original; }
  await storage.deleteObject(key);
  assert.equal((await preview(env, data.document.id, cookie)).status, 409);
  assert.equal((await auditRows(db, 'document.viewed')).length, 0);
}));

test('malicious synthetic files are refused with 415 before putObject, also on retry (#89)', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const pdfWith = (body) => encoder.encode(`%PDF-1.4\n1 0 obj << ${body} >> endobj\n%%EOF\n`);
  const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  const polyglot = new Uint8Array([...PDF, ...new Uint8Array(1500).fill(0x20), ...zip]);
  const pngTrailer = new Uint8Array([...PNG, ...encoder.encode('<script>x</script>')]);
  const jpegTrailer = new Uint8Array([...JPEG, ...encoder.encode('<html>')]);
  const cases = [
    ['pdf /JavaScript', pdfWith('/S /JavaScript /JS (app.alert(1))'), 'application/pdf', 'document_active_content'],
    ['pdf hex-escaped name', pdfWith('/S /J#61vaScript'), 'application/pdf', 'document_active_content'],
    ['pdf /Launch', pdfWith('/S /Launch'), 'application/pdf', 'document_active_content'],
    ['pdf /EmbeddedFile', pdfWith('/Type /EmbeddedFile'), 'application/pdf', 'document_active_content'],
    ['pdf encrypted', pdfWith('/Encrypt 9 0 R'), 'application/pdf', 'document_active_content'],
    ['pdf inline OpenAction', pdfWith('/OpenAction << /S /URI /URI (x) >>'), 'application/pdf', 'document_active_content'],
    ['pdf+zip polyglot', polyglot, 'application/pdf', 'document_malformed'],
    ['png with data after IEND', pngTrailer, 'image/png', 'document_malformed'],
    ['jpeg with data after FFD9', jpegTrailer, 'image/jpeg', 'document_malformed'],
    ['pdf /JavaScript hidden in a compressed object stream', pdfWithHiddenScript(), 'application/pdf', 'document_active_content'],
    ['pdf /SubmitForm', pdfWith('/S /SubmitForm /F (https://example.invalid/x)'), 'application/pdf', 'document_active_content'],
    ['png with zero width in IHDR', syntheticPng({ width: 0 }), 'image/png', 'document_malformed'],
    ['png with oversized dimensions', syntheticPng({ width: 20000, height: 20000 }), 'image/png', 'document_malformed'],
    ['png without IDAT', syntheticPng({ idat: false }), 'image/png', 'document_malformed'],
    ['jpeg with zero height in SOF', syntheticJpeg({ height: 0 }), 'image/jpeg', 'document_malformed'],
    ['svg declared as svg', SVG, 'image/svg+xml', 'unsupported_media_type'],
    ['svg declared as png', SVG, 'image/png', 'unsupported_media_type'],
  ];
  for (const [label, bytes, type, code] of cases) {
    const key = `malicious-${label}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { response, data } = await upload(env, { cookie, bytes, type, key });
      assert.equal(response.status, 415, `${label} #${attempt}`);
      assert.equal(data.error, code, label);
    }
  }
  // Magic bytes niezgodne z deklarowanym typem: PNG deklarowany jako PDF i odwrotnie.
  assert.equal((await upload(env, { cookie, bytes: PNG, type: 'application/pdf' })).response.status, 415);
  assert.equal((await upload(env, { cookie, bytes: PDF, type: 'image/png' })).response.status, 415);
  assert.equal(storage.keys().length, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 0);
}));

test('preview of an image accepted under rules v1 but failing the image-header checks is 409; current-version image opens (#89)', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const zeroWidth = await insertLegacyDocument(db, storage, { bytes: syntheticPng({ width: 0 }), mimeType: 'image/png', validationVersion: 1 });
  const fine = await insertLegacyDocument(db, storage, { bytes: PNG, mimeType: 'image/png', validationVersion: DOCUMENT_VALIDATION_VERSION });
  const blocked = await preview(env, zeroWidth, cookie);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'document_preview_blocked');
  assert.equal((await preview(env, fine, cookie)).status, 200);
  assert.deepEqual((await auditRows(db, 'document.preview_blocked')).map((event) => `${event.entity_id}:${event.metadata_json.reason}`), [`${zeroWidth}:document_malformed`]);
}));

test('preview re-checks stored bytes with current rules: legacy file failing them is 409 document_preview_blocked, still downloadable (#89)', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const hidden = await insertLegacyDocument(db, storage, { bytes: pdfWithHiddenScript() });
  const mismatched = await insertLegacyDocument(db, storage, { bytes: PNG, mimeType: 'application/pdf' });
  const clean = await insertLegacyDocument(db, storage, { bytes: PDF });

  for (const [id, reason] of [[hidden, 'document_active_content'], [mismatched, 'unsupported_media_type']]) {
    const response = await preview(env, id, cookie);
    assert.equal(response.status, 409, reason);
    assert.equal((await response.json()).error, 'document_preview_blocked');
    assert.equal(response.headers.get('Content-Disposition'), null, 'no file content in a blocked preview');
    // Ponowienie daje to samo (stan pliku, nie awaria).
    assert.equal((await preview(env, id, cookie)).status, 409);
  }
  const blocked = await auditRows(db, 'document.preview_blocked');
  assert.equal(blocked.length, 4);
  assertEvery(blocked, (event) => event.actor_id === 'u-treasurer');
  assert.deepEqual([...new Set(blocked.map((event) => `${event.entity_id}:${event.metadata_json.reason}`))].sort(),
    [`${hidden}:document_active_content`, `${mismatched}:unsupported_media_type`].sort());
  blocked.forEach((event) => assertNoPii(event.metadata_json));
  assert.equal((await auditRows(db, 'document.viewed')).length, 0);

  // Pobranie (załącznik, CSP sandbox) zostaje — dowód w archiwum — z własnym śladem.
  const download = await get(env, `/api/documents/${hidden}/content`, cookie);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('Content-Disposition'), /^attachment;/);
  assert.match(download.headers.get('Content-Security-Policy'), /^sandbox/);
  assert.deepEqual((await auditRows(db, 'document.downloaded')).map((event) => event.entity_id), [hidden]);

  // Plik zgodny z bieżącymi regułami otwiera się normalnie.
  assert.equal((await preview(env, clean, cookie)).status, 200);
  assert.deepEqual((await auditRows(db, 'document.viewed')).map((event) => event.entity_id), [clean]);
  // Odmowa roli przed kontrolą treści: przedstawiciel klasy dostaje 404, bez preview_blocked.
  assert.equal((await preview(env, hidden, await repA(db))).status, 404);
  assert.equal((await auditRows(db, 'document.preview_blocked')).length, 4);
}));

test('upload records the current validation_version; rows without it are reported as unknown (#89, 0161)', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const key = 'validation-version-key-1';
  const { response, data } = await upload(env, { cookie, key });
  assert.equal(response.status, 201);
  assert.equal(data.document.validationVersion, DOCUMENT_VALIDATION_VERSION);
  assert.equal(data.document.validationCurrent, true);
  const [row] = (await db.query('SELECT validation_version FROM documents WHERE id = $1', [data.document.id])).rows;
  assert.equal(row.validation_version, DOCUMENT_VALIDATION_VERSION);
  // Wersji nie da się podbić ani wyzerować później (wiersz documents jest niezmienny, 0006).
  await assert.rejects(db.query('UPDATE documents SET validation_version = NULL WHERE id = $1', [data.document.id]), /documents_are_immutable/);
  // Ponowienie z tym samym kluczem (podwójne kliknięcie) zwraca ten sam dokument i tę samą wersję.
  const replay = await upload(env, { cookie, key });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.document.id, data.document.id);
  assert.equal(replay.data.document.validationVersion, DOCUMENT_VALIDATION_VERSION);

  const legacy = await insertLegacyDocument(db, storage, { bytes: PDF });
  const meta = await (await get(env, `/api/documents/${legacy}`, cookie)).json();
  assert.equal(meta.document.validationVersion, null);
  assert.equal(meta.document.validationCurrent, false);
  // Baza odrzuca wersję spoza zakresu (CHECK z 0161).
  await assert.rejects(() => insertLegacyDocument(db, storage, { bytes: PDF, validationVersion: 0 }), /documents_validation_version_check/);
}));

test('preview skips the structure re-check only for files checked with the current rules and a matching SHA-256 (#89, 0161)', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  // Syntetyczny plik, którego bieżące reguły by nie przyjęły, zapisany jako „sprawdzony
  // bieżącą wersją” — dowodzi, że podgląd polega na zapisanej wersji i skrócie, a nie
  // przeszukuje bajtów ponownie (w praktyce taki wiersz powstaje wyłącznie przez trasę uploadu).
  const current = await insertLegacyDocument(db, storage, { bytes: pdfWithHiddenScript(), validationVersion: DOCUMENT_VALIDATION_VERSION });
  const unknown = await insertLegacyDocument(db, storage, { bytes: pdfWithHiddenScript() });
  const wrongSignature = await insertLegacyDocument(db, storage, { bytes: PNG, validationVersion: DOCUMENT_VALIDATION_VERSION });

  assert.equal((await preview(env, current, cookie)).status, 200);
  for (const id of [unknown, wrongSignature]) {
    const response = await preview(env, id, cookie);
    assert.equal(response.status, 409, id);
    assert.equal((await response.json()).error, 'document_preview_blocked');
  }
  const blocked = await auditRows(db, 'document.preview_blocked');
  assert.deepEqual(blocked.map((event) => `${event.entity_id}:${event.metadata_json.reason}`).sort(), [
    `${unknown}:document_active_content`, `${wrongSignature}:unsupported_media_type`,
  ].sort());
  assert.deepEqual((await auditRows(db, 'document.viewed')).map((event) => event.entity_id), [current]);

  // Podmieniony obiekt w buckecie (inny skrót) nie korzysta z zapisanej wersji: błąd integralności przed podglądem.
  const [row] = (await db.query('SELECT object_key FROM documents WHERE id = $1', [current])).rows;
  await storage.putObject(row.object_key, pdfWithHiddenScript().map((byte, index) => (index === 20 ? byte ^ 1 : byte)), 'application/pdf');
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try {
    assert.equal((await preview(env, current, cookie)).status, 503);
  } finally { console.error = original; }
  assert.match(errors.join('\n'), /"code":"document_integrity_mismatch"/);
  assert.equal((await auditRows(db, 'document.viewed')).length, 1);
}));

test('list validation=outdated shows only documents checked with older rules or without a version, within role scope (#89, 0161)', async () => withEnv(async (db, env, storage) => {
  const cookie = await treasurer(db);
  const fresh = (await upload(env, { cookie })).data.document.id;
  const legacyA = await insertLegacyDocument(db, storage, { bytes: PDF });
  const legacyB = await insertLegacyDocument(db, storage, { bytes: PNG, mimeType: 'image/png' });

  const all = await (await get(env, `/api/documents?schoolYearId=${YEAR}`, cookie)).json();
  assert.deepEqual(all.documents.map((doc) => doc.id).sort(), [fresh, legacyA, legacyB].sort());
  const outdated = await (await get(env, `/api/documents?schoolYearId=${YEAR}&validation=outdated`, cookie)).json();
  assert.deepEqual(outdated.documents.map((doc) => doc.id).sort(), [legacyA, legacyB].sort());
  assertEvery(outdated.documents, (doc) => doc.validationCurrent === false && doc.validationVersion === null);

  for (const bad of ['current', 'OUTDATED', '']) {
    const response = await get(env, `/api/documents?schoolYearId=${YEAR}&validation=${bad}`, cookie);
    assert.equal(response.status, 400, bad);
    assert.equal((await response.json()).error, 'invalid_request');
  }
  // Kursor listy bez filtra nie działa w liście z filtrem (inny zakres kursora).
  const firstPage = await (await get(env, `/api/documents?schoolYearId=${YEAR}&limit=1`, cookie)).json();
  assert.ok(firstPage.nextCursor);
  const crossed = await get(env, `/api/documents?schoolYearId=${YEAR}&validation=outdated&cursor=${firstPage.nextCursor}`, cookie);
  assert.equal(crossed.status, 400);
  assert.equal((await crossed.json()).error, 'invalid_cursor');
  // Stronicowanie w obrębie filtra.
  const page1 = await (await get(env, `/api/documents?schoolYearId=${YEAR}&validation=outdated&limit=1`, cookie)).json();
  const page2 = await (await get(env, `/api/documents?schoolYearId=${YEAR}&validation=outdated&limit=1&cursor=${page1.nextCursor}`, cookie)).json();
  assert.deepEqual([...page1.documents, ...page2.documents].map((doc) => doc.id).sort(), [legacyA, legacyB].sort());

  // Przedstawiciel klasy nie widzi dokumentów finansowych także przez filtr.
  const rep = await get(env, `/api/documents?schoolYearId=${YEAR}&validation=outdated`, await repA(db));
  assert.equal(rep.status, 200);
  assert.deepEqual((await rep.json()).documents, []);
}));

test('from/to filter by document date in SQL; undated documents fail the filter; sort=documentDate puts undated last', async () => withEnv(async (db, env) => {
  const cookie = await treasurer(db);
  const dated = {};
  for (const [name, date] of [['old', '2026-01-10'], ['mid', '2026-03-15'], ['new', '2026-05-20']]) {
    dated[name] = (await upload(env, { cookie })).data.document.id;
    await describe(env, { cookie, id: dated[name], body: { title: `Faktura ${name}`, category: 'faktura', documentDate: date } });
  }
  const undated = (await upload(env, { cookie })).data.document.id;
  await describe(env, { cookie, id: undated, body: { title: 'Faktura bez daty', category: 'faktura' } });

  const ids = async (query) => {
    const response = await get(env, `/api/documents?schoolYearId=${YEAR}${query}`, cookie);
    assert.equal(response.status, 200);
    return (await response.json()).documents.map((doc) => doc.id);
  };
  assert.deepEqual(await ids('&from=2026-02-01&to=2026-04-30'), [dated.mid]);
  assert.deepEqual(new Set(await ids('&from=2026-03-15')), new Set([dated.mid, dated.new]));
  assert.deepEqual(await ids('&to=2026-01-10'), [dated.old]);
  assert.deepEqual(await ids('&sort=documentDate'), [dated.new, dated.mid, dated.old, undated]);

  for (const bad of ['&from=2026-13-40', '&to=nie-data']) {
    const response = await get(env, `/api/documents?schoolYearId=${YEAR}${bad}`, cookie);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_document_date');
  }
  // Kursor keyset (#159) z filtrem daty: strona 1 daje kursor, strona 2 działa w zakresie; przy sort=documentDate kursor jest odrzucany.
  const page1 = await (await get(env, `/api/documents?schoolYearId=${YEAR}&from=2026-01-01&limit=1`, cookie)).json();
  assert.equal(page1.documents.length, 1);
  assert.ok(page1.nextCursor);
  const page2 = await get(env, `/api/documents?schoolYearId=${YEAR}&from=2026-01-01&limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`, cookie);
  assert.equal(page2.status, 200);
  assert.notEqual((await page2.json()).documents[0].id, page1.documents[0].id);
  const otherRange = await get(env, `/api/documents?schoolYearId=${YEAR}&from=2026-02-01&limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`, cookie);
  assert.equal(otherRange.status, 400);
  const sortedCursor = await get(env, `/api/documents?schoolYearId=${YEAR}&sort=documentDate&limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`, cookie);
  assert.equal(sortedCursor.status, 400);
  assert.equal((await (await get(env, `/api/documents?schoolYearId=${YEAR}&sort=documentDate&limit=1`, cookie)).json()).nextCursor, null);

  for (const bad of ['&from=2026-05-01&to=2026-04-01', '&sort=title']) {
    const response = await get(env, `/api/documents?schoolYearId=${YEAR}${bad}`, cookie);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_request');
  }
}));

test('from/to and search never widen scope: representative gets nothing from other class or board even with matching date', async () => withEnv(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  const own = (await upload(env, { cookie, kind: 'class', classId: 'c-1a' })).data.document.id;
  const other = (await upload(env, { cookie, kind: 'class', classId: 'c-1b' })).data.document.id;
  const board = (await upload(env, { cookie, kind: 'board' })).data.document.id;
  for (const id of [own, other, board]) {
    await describe(env, { cookie, id, body: { title: 'Protokół zebrania', category: 'protokol', documentDate: '2026-04-01' } });
  }
  const response = await get(env, `/api/documents?schoolYearId=${YEAR}&q=Protok&from=2026-04-01&to=2026-04-01&sort=documentDate`, await repA(db));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).documents.map((doc) => doc.id), [own]);
}));

test('pagination: 120 documents, 70 inaccessible to the representative — full pages of the own 50, no leaked rows', async () => withEnv(async (db, env) => {
  const insert = (count, kind, classId, prefix) => db.query(
    `INSERT INTO documents (id, object_key, kind, school_year_id, class_id, mime_type, byte_size, sha256, created_by, idempotency_key)
     SELECT $1 || g, 'docs/' || gen_random_uuid(), $2, $3, $4, 'application/pdf', 10, repeat('a', 64), 'u-rep-a', $1 || 'key-' || g
       FROM generate_series(1, $5) g`,
    [prefix, kind, YEAR, classId, count],
  );
  const rep = await repA(db);
  await insert(50, 'class', 'c-1a', 'own-');
  await insert(35, 'class', 'c-1b', 'other-');
  await insert(35, 'board', null, 'board-');

  const seen = [];
  const sizes = [];
  for (let offset = 0; offset < 60; offset += 20) {
    const response = await get(env, `/api/documents?schoolYearId=${YEAR}&limit=20&offset=${offset}`, rep);
    assert.equal(response.status, 200);
    const page = (await response.json()).documents;
    sizes.push(page.length);
    seen.push(...page.map((doc) => doc.id));
  }
  assert.deepEqual(sizes, [20, 20, 10]);
  assert.equal(new Set(seen).size, 50);
  assertEvery(seen, (id) => id.startsWith('own-'));
}));

// #167: dokumenty Rady dla przedstawicieli (`council_shared`). Zapis tylko admin/zarząd bez klasy;
// odczyt także przedstawiciel z przydziałem klasowym w roku dokumentu.
test('council_shared: zarząd przesyła, przedstawiciele wszystkich klas roku czytają, nie zapisują (#167)', async () => withEnv(async (db, env, storage) => {
  const board = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  const { response, data } = await upload(env, { cookie: board, kind: 'council_shared', key: 'council-key-0001' });
  assert.equal(response.status, 201);
  const id = data.document.id;
  assert.equal(data.document.kind, 'council_shared');
  assert.equal(data.document.classId, null);

  // Ten sam Idempotency-Key = jeden dokument i jeden obiekt w buckecie.
  const again = await upload(env, { cookie: board, kind: 'council_shared', key: 'council-key-0001' });
  assert.equal(again.data.document.id, id);
  assert.equal(storage.keys().length, 1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM documents WHERE kind = 'council_shared'")).rows[0].n, 1);

  // Przedstawiciele 1A i 1B oraz rodzeństwo (1A i 1B jednym kontem) czytają listę, metadane i treść.
  const sibling = await seedUserSession(db, {
    userId: 'u-rep-ab', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }, { role: 'representative', classId: 'c-1b', schoolYearId: YEAR }],
  });
  for (const cookie of [await repA(db), await repB(db), sibling]) {
    const list = await (await get(env, `/api/documents?schoolYearId=${YEAR}`, cookie)).json();
    assert.deepEqual(list.documents.map((doc) => doc.id), [id]);
    assert.equal((await get(env, `/api/documents?schoolYearId=${YEAR}&kind=council_shared`, cookie)).status, 200);
    assert.equal((await get(env, `/api/documents/${id}`, cookie)).status, 200);
    const content = await get(env, `/api/documents/${id}/content`, cookie);
    assert.equal(content.status, 200);
    assert.deepEqual(new Uint8Array(await content.arrayBuffer()), PDF);
  }
  assert.equal((await auditRows(db, 'document.downloaded')).length, 3);

  // Przedstawiciel nie przesyła (403), nie unieważnia ani nie opisuje (404 jak brak obiektu).
  const rep = await seedUserSession(db, { userId: 'u-rep-w', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] });
  assert.equal((await upload(env, { cookie: rep, kind: 'council_shared' })).response.status, 403);
  const post = (path, body) => handlePgRequest(request(path, { method: 'POST', cookie: rep, body, headers: { 'Idempotency-Key': `rep-write-${++keyCounter}-xx` } }), env);
  assert.equal((await post(`/api/documents/${id}/void`, { reason: 'Próba przedstawiciela' })).status, 404);
  assert.equal((await post(`/api/documents/${id}/description`, { title: 'Zmiana', category: 'inne' })).status, 404);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM document_status_events')).rows[0].n, 0);
}));

test('council_shared: przydział z innego roku, rola ograniczona do klasy i inne role dają 404 bez wyroczni istnienia (#167)', async () => withEnv(async (db, env) => {
  const board = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  const id = (await upload(env, { cookie: board, kind: 'council_shared' })).data.document.id;

  await seedSchoolYear(db, 'y-2025', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedClass(db, { id: 'c-5a', schoolYearId: 'y-2025' });
  const lastYearRep = await seedUserSession(db, { userId: 'u-rep-old', roles: [{ role: 'representative', classId: 'c-5a', schoolYearId: 'y-2025' }] });
  const boardClassOnly = await seedUserSession(db, { userId: 'u-board-class', mfa: true, roles: [{ role: 'board', classId: 'c-1a', schoolYearId: YEAR }] });
  const principal = await seedUserSession(db, { userId: 'u-principal', mfa: true, roles: [{ role: 'principal' }] });
  const audit = await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit' }] });
  const noRoles = await seedUserSession(db, { userId: 'u-noroles' });

  for (const cookie of [lastYearRep, boardClassOnly, principal, audit, noRoles]) {
    for (const path of [`/api/documents/${id}`, `/api/documents/${id}/content`]) {
      const denied = await get(env, path, cookie);
      const unknown = await get(env, path.replace(id, crypto.randomUUID()), cookie);
      assert.equal(denied.status, 404);
      assert.deepEqual(await denied.json(), await unknown.json());
    }
  }
  assert.equal((await get(env, `/api/documents?schoolYearId=${YEAR}`, lastYearRep)).status, 403);
  assert.equal((await get(env, `/api/documents?schoolYearId=${YEAR}`, principal)).status, 403);
}));

test('council_shared: zastąpiony dokument znika z domyślnej listy przedstawiciela (#167)', async () => withEnv(async (db, env) => {
  const board = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
  const first = (await upload(env, { cookie: board, kind: 'council_shared' })).data.document.id;
  const second = (await upload(env, { cookie: board, kind: 'council_shared', bytes: PNG, type: 'image/png' })).data.document.id;
  const supersede = await handlePgRequest(request(`/api/documents/${first}/supersede`, {
    method: 'POST', cookie: board, body: { replacementDocumentId: second, reason: 'Nowa wersja planu pracy' }, headers: { 'Idempotency-Key': 'council-supersede-1' },
  }), env);
  assert.equal(supersede.status, 201);
  const list = await (await get(env, `/api/documents?schoolYearId=${YEAR}`, await repA(db))).json();
  assert.deepEqual(list.documents.map((doc) => doc.id), [second]);
}));
