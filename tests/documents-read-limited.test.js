// #185 pkt 2: readLimited — jedna kopia bajtów, twardy limit także bez Content-Length.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readLimited } from '../src/documents.js';

function streamOf(chunks, { onPull } = {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) { controller.close(); return; }
      onPull?.(index);
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

function requestOf(chunks, headers = {}, opts) {
  return new Request('https://rd.example.invalid/api/documents', {
    method: 'POST', body: streamOf(chunks, opts), duplex: 'half', headers,
  });
}

test('readLimited: deklarowana długość -> dokładna zawartość, także z wieloma chunkami', async () => {
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
  const bytes = await readLimited(requestOf(chunks, { 'Content-Length': '6' }), 100);
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6]);
});

test('readLimited: bez Content-Length (chunked) składa chunki', async () => {
  const bytes = await readLimited(requestOf([new Uint8Array([9, 8]), new Uint8Array([7])]), 100);
  assert.deepEqual([...bytes], [9, 8, 7]);
});

test('readLimited: chunked ponad limit -> RangeError document_too_large i przerwanie czytania', async () => {
  let pulled = 0;
  const chunks = Array.from({ length: 50 }, () => new Uint8Array(1024));
  await assert.rejects(
    () => readLimited(requestOf(chunks, {}, { onPull: () => { pulled += 1; } }), 4096),
    (error) => error instanceof RangeError && error.message === 'document_too_large',
  );
  assert.ok(pulled < 50, `czytanie powinno stanąć po przekroczeniu limitu, odczytano ${pulled} chunków`);
});

test('readLimited: Content-Length ponad limit -> odrzucenie bez odczytu ciała', async () => {
  let pulled = 0;
  const request = requestOf([new Uint8Array(10), new Uint8Array(10)], { 'Content-Length': '999999' }, { onPull: () => { pulled += 1; } });
  await assert.rejects(
    () => readLimited(request, 1024),
    (error) => error instanceof RangeError && error.message === 'document_too_large',
  );
  // Strumień może wstępnie pobrać najwyżej jeden chunk (highWaterMark); readLimited niczego nie czyta.
  assert.ok(pulled <= 1, `readLimited nie może czytać ciała po odrzuceniu na podstawie Content-Length, pobrano ${pulled}`);
});

test('readLimited: ciało dłuższe niż deklaracja, ale w limicie, nie ginie; ponad limit jest odrzucone', async () => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5, 6])];
  const bytes = await readLimited(requestOf(chunks, { 'Content-Length': '2' }), 100);
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5, 6]);
  await assert.rejects(
    () => readLimited(requestOf(chunks, { 'Content-Length': '2' }), 4),
    (error) => error.message === 'document_too_large',
  );
});

test('readLimited: krótsze ciało niż deklaracja zwraca tylko odebrane bajty', async () => {
  const bytes = await readLimited(requestOf([new Uint8Array([1, 2])], { 'Content-Length': '10' }), 100);
  assert.equal(bytes.length, 2);
});

test('readLimited: pusta treść', async () => {
  const bytes = await readLimited(new Request('https://rd.example.invalid/x', { method: 'POST' }), 100);
  assert.equal(bytes.length, 0);
});
