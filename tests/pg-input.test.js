// Testy wspólnego modułu wejścia HTTP (issue #154). Wyłącznie dane syntetyczne.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError, createJsonReader, decodeCursor, decodePathId, encodeCursor, isUniqueError, isValidDate, readBodyText, readIdempotencyKey, readJsonObject,
} from '../src/pg/input.js';

function jsonRequest(body, headers = {}) {
  return new Request('https://rd.test/api/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

test('readJsonObject: parsuje poprawny obiekt', async () => {
  const data = await readJsonObject(jsonRequest(JSON.stringify({ a: 1 })));
  assert.deepEqual(data, { a: 1 });
});

test('readJsonObject: brak Content-Type -> 415 invalid_content_type', async () => {
  const req = new Request('https://rd.test/api/x', { method: 'POST', body: '{}' });
  await assert.rejects(readJsonObject(req), (error) => error instanceof ApiError && error.code === 'invalid_content_type' && error.status === 415);
});

test('readJsonObject: text/plain -> 415 invalid_content_type', async () => {
  const req = new Request('https://rd.test/api/x', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  await assert.rejects(readJsonObject(req), (error) => error instanceof ApiError && error.code === 'invalid_content_type');
});

test('readJsonObject: puste ciało -> 400 invalid_json (domyślnie)', async () => {
  await assert.rejects(readJsonObject(jsonRequest('')), (error) => error instanceof ApiError && error.code === 'invalid_json');
});

test('readJsonObject: puste ciało z allowEmpty -> {}', async () => {
  const data = await readJsonObject(jsonRequest(''), { allowEmpty: true });
  assert.deepEqual(data, {});
});

test('readJsonObject: [] -> invalid_json (musi być obiektem)', async () => {
  await assert.rejects(readJsonObject(jsonRequest('[]')), (error) => error instanceof ApiError && error.code === 'invalid_json');
});

test('readJsonObject: null -> invalid_json', async () => {
  await assert.rejects(readJsonObject(jsonRequest('null')), (error) => error instanceof ApiError && error.code === 'invalid_json');
});

test('readJsonObject: "x" (poprawny JSON, nie obiekt) -> invalid_json', async () => {
  await assert.rejects(readJsonObject(jsonRequest('"x"')), (error) => error instanceof ApiError && error.code === 'invalid_json');
});

test('readJsonObject: niepoprawny JSON -> invalid_json', async () => {
  await assert.rejects(readJsonObject(jsonRequest('{not json')), (error) => error instanceof ApiError && error.code === 'invalid_json');
});

test('readJsonObject: ciało > limit bez zgodnego Content-Length -> 413 request_too_large', async () => {
  await assert.rejects(
    readJsonObject(jsonRequest(JSON.stringify({ a: 'x'.repeat(100) })), { maxBytes: 10 }),
    (error) => error instanceof ApiError && error.code === 'request_too_large' && error.status === 413,
  );
});

test('readJsonObject: zawyżony deklarowany Content-Length odrzucany przed odczytem ciała', async () => {
  await assert.rejects(
    readJsonObject(jsonRequest(JSON.stringify({ a: 1 }), { 'Content-Length': '999999' }), { maxBytes: 10 }),
    (error) => error instanceof ApiError && error.code === 'request_too_large' && error.status === 413,
  );
});

test('readIdempotencyKey: brak lub zły format -> invalid_idempotency_key', () => {
  const req = new Request('https://rd.test/api/x', { method: 'POST' });
  assert.throws(() => readIdempotencyKey(req), (error) => error instanceof ApiError && error.code === 'invalid_idempotency_key');
  const bad = new Request('https://rd.test/api/x', { method: 'POST', headers: { 'Idempotency-Key': '!!' } });
  assert.throws(() => readIdempotencyKey(bad), (error) => error instanceof ApiError && error.code === 'invalid_idempotency_key');
});

test('readIdempotencyKey: poprawny klucz', () => {
  const req = new Request('https://rd.test/api/x', { method: 'POST', headers: { 'Idempotency-Key': 'payment-2026-h-1' } });
  assert.equal(readIdempotencyKey(req), 'payment-2026-h-1');
});

test('decodePathId: dekoduje i waliduje wzorcem', () => {
  assert.equal(decodePathId('h-1'), 'h-1');
  assert.throws(() => decodePathId('../etc'), (error) => error instanceof ApiError && error.code === 'not_found' && error.status === 404);
  assert.throws(() => decodePathId('%'), (error) => error instanceof ApiError && error.code === 'not_found');
});

test('decodePathId: pozwala nadpisać błąd (np. innym kodem modułu)', () => {
  assert.throws(
    () => decodePathId('../etc', { notFound: () => new ApiError('invalid_household', 400) }),
    (error) => error instanceof ApiError && error.code === 'invalid_household' && error.status === 400,
  );
});

test('isValidDate', () => {
  assert.equal(isValidDate('2026-09-15'), true);
  assert.equal(isValidDate('2026-13-01'), false, 'nieistniejący miesiąc');
  assert.equal(isValidDate('2026-02-30'), false, 'nieistniejący dzień');
  assert.equal(isValidDate('15-09-2026'), false, 'zły format');
  assert.equal(isValidDate(null), false);
});

test('encodeCursor/decodeCursor: kursor przechodzi kolej tam i z powrotem', () => {
  const schema = ['receivedOn', 'id'];
  const cursor = encodeCursor(schema, { receivedOn: '2026-09-15', id: 'p-9' });
  assert.deepEqual(decodeCursor(schema, cursor), { receivedOn: '2026-09-15', id: 'p-9' });
});

test('decodeCursor: brak kursora -> null', () => {
  assert.equal(decodeCursor(['a'], undefined), null);
  assert.equal(decodeCursor(['a'], null), null);
  assert.equal(decodeCursor(['a'], ''), null);
});

test('decodeCursor: niepoprawny kursor -> 400 invalid_cursor (nie 500/503)', () => {
  assert.throws(() => decodeCursor(['a'], 'not-base64-json'), (error) => error instanceof ApiError && error.code === 'invalid_cursor' && error.status === 400);
});

test('decodeCursor: kursor z innego modułu (inny schemat) -> invalid_cursor, nie dane pomieszane', () => {
  const ledgerCursor = encodeCursor(['occurredAt', 'id', 'amountCents'], { occurredAt: '2026-09-15', id: 'l-1', amountCents: 500 });
  assert.throws(() => decodeCursor(['receivedOn', 'id'], ledgerCursor), (error) => error instanceof ApiError && error.code === 'invalid_cursor');
});

// --- createJsonReader: zachowanie dotychczasowych kopii readJson w trasach (#154) ---

class TestError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const make = (code, status) => new TestError(code, status);
const postJson = (body, headers = {}) => new Request('https://rd.test/api/x', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
});
const rejectsWith = (promise, code, status) => assert.rejects(promise, (e) => e instanceof TestError && e.code === code && e.status === status);

test('createJsonReader (domyślnie): rzuca błąd trasy, puste ciało to invalid_json, tablica odrzucona', async () => {
  const read = createJsonReader({ maxBytes: 20, error: make });
  assert.deepEqual(await read(postJson('{"a":1}')), { a: 1 });
  await rejectsWith(read(new Request('https://rd.test/x', { method: 'POST', body: '{}' })), 'invalid_content_type', 415);
  await rejectsWith(read(postJson('')), 'invalid_json', 400);
  await rejectsWith(read(postJson('[]')), 'invalid_json', 400);
  await rejectsWith(read(postJson('null')), 'invalid_json', 400);
  await rejectsWith(read(postJson(JSON.stringify({ a: 'x'.repeat(30) }))), 'request_too_large', 413);
});

test('createJsonReader: Content-Length sprawdzany tylko z declaredLength, i dopiero po typie', async () => {
  const strict = createJsonReader({ maxBytes: 10, error: make, declaredLength: true });
  const lax = createJsonReader({ maxBytes: 10, error: make });
  await rejectsWith(strict(postJson('{}', { 'Content-Length': '999' })), 'request_too_large', 413);
  assert.deepEqual(await lax(postJson('{}', { 'Content-Length': '999' })), {});
  const wrongType = new Request('https://rd.test/x', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'Content-Length': '999' }, body: '{}' });
  await rejectsWith(strict(wrongType), 'invalid_content_type', 415);
});

test('createJsonReader: emptyBody blank/exact różnią się białymi znakami', async () => {
  const blank = createJsonReader({ maxBytes: 100, error: make, emptyBody: 'blank' });
  const exact = createJsonReader({ maxBytes: 100, error: make, emptyBody: 'exact' });
  assert.deepEqual(await blank(postJson('')), {});
  assert.deepEqual(await blank(postJson('  \n')), {});
  assert.deepEqual(await exact(postJson('')), {});
  await rejectsWith(exact(postJson('  ')), 'invalid_json', 400);
});

test('createJsonReader: typeAfterEmpty przepuszcza puste ciało bez Content-Type, ale sprawdza rozmiar przed typem', async () => {
  const read = createJsonReader({ maxBytes: 10, error: make, emptyBody: 'blank', typeAfterEmpty: true });
  assert.deepEqual(await read(new Request('https://rd.test/x', { method: 'POST' })), {});
  await rejectsWith(read(new Request('https://rd.test/x', { method: 'POST', body: '{"a":1}' })), 'invalid_content_type', 415);
  await rejectsWith(read(new Request('https://rd.test/x', { method: 'POST', body: 'x'.repeat(50) })), 'request_too_large', 413);
});

test('createJsonReader: nadpisanie limitu, własny test typu i brak wymogu obiektu (import)', async () => {
  const read = createJsonReader({
    maxBytes: 5, error: make, requireObject: false,
    isJsonType: (raw) => /^application\/json\b/i.test(raw ?? ''), typeError: ['unsupported_media_type', 415],
  });
  assert.deepEqual(await read(postJson('[1,2]'), 50), [1, 2]);
  await rejectsWith(read(postJson('[1,2,3,4]')), 'request_too_large', 413);
  await rejectsWith(read(new Request('https://rd.test/x', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })), 'unsupported_media_type', 415);
  await rejectsWith(read(postJson('{x')), 'invalid_json', 400);
});

test('readBodyText i isUniqueError', async () => {
  await rejectsWith(readBodyText(postJson('x', { 'Content-Length': '99' }), 5, make), 'request_too_large', 413);
  await rejectsWith(readBodyText(postJson('x'.repeat(9)), 5, make), 'request_too_large', 413);
  assert.equal(await readBodyText(postJson('abc'), 5, make), 'abc');
  assert.equal(isUniqueError({ code: '23505' }), true);
  assert.equal(isUniqueError({ code: '23503' }), false);
  assert.equal(isUniqueError(null), false);
});
