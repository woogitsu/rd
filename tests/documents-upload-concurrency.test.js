// #185 pkt 3: limit współbieżnych uploadów na proces (semafor w src/documents.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_CONCURRENT_UPLOADS, resetUploadSlotsForTests, tryAcquireUploadSlot } from '../src/documents.js';

test('tryAcquireUploadSlot: piąty równoczesny upload nie dostaje miejsca, zwolnienie robi miejsce z powrotem', () => {
  resetUploadSlotsForTests();
  const releases = [];
  for (let i = 0; i < DEFAULT_MAX_CONCURRENT_UPLOADS; i += 1) {
    const release = tryAcquireUploadSlot();
    assert.ok(typeof release === 'function', `slot ${i} powinien być wolny`);
    releases.push(release);
  }
  assert.equal(tryAcquireUploadSlot(), null, 'piąte miejsce nie istnieje przy domyślnym limicie 4');

  releases[0]();
  const fifth = tryAcquireUploadSlot();
  assert.ok(typeof fifth === 'function', 'po zwolnieniu jednego miejsca kolejny upload dostaje slot');

  // Podwójne wywołanie release jest bezpieczne (np. finally + wcześniejszy błąd).
  releases[0]();
  releases[0]();
  fifth();
  for (const release of releases.slice(1)) release();
  assert.ok(typeof tryAcquireUploadSlot() === 'function', 'wszystkie miejsca zwolnione');
  resetUploadSlotsForTests();
});

test('tryAcquireUploadSlot: niestandardowy limit', () => {
  resetUploadSlotsForTests();
  const release = tryAcquireUploadSlot(1);
  assert.ok(typeof release === 'function');
  assert.equal(tryAcquireUploadSlot(1), null);
  release();
  resetUploadSlotsForTests();
});
