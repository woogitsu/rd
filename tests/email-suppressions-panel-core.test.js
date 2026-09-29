// Logika czysta ekranu „Lista wyłączeń” (#94). Bez sieci i bez DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PARENT_ONLY_REASONS, RELEASE_REASONS, RELEASE_REASON_LABELS, SUPPRESSION_REASON_LABELS,
  allowedReleaseReasons, describeFamily, describeSuppressionError, formatSuppressionCount,
  parseConfirmationNote, rowAction, suppressionActionUrl, suppressionsUrl,
} from '../email/suppressions-core.js';

const HASH = 'a'.repeat(64);

test('kody powodów i reguły panelu zgadzają się z serwerem', () => {
  const server = readFileSync(new URL('../src/pg/routes/email.js', import.meta.url), 'utf8');
  const releases = server.match(/RELEASE_REASONS = Object\.freeze\(\[([^\]]+)\]/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual([...RELEASE_REASONS], releases);
  const parentOnly = server.match(/PARENT_ONLY_REASONS = new Set\(\[([^\]]+)\]/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual([...PARENT_ONLY_REASONS], parentOnly);
  const note = server.match(/NOTE_PATTERN = (\/.+\/);/)[1];
  assert.equal(note, '/^[a-z0-9_]{1,40}$/');
  for (const code of releases) assert.ok(RELEASE_REASON_LABELS[code]);
  for (const code of ['hard_bounce', 'invalid_email', 'blocked', 'complaint', 'unsubscribed']) assert.ok(SUPPRESSION_REASON_LABELS[code]);
});

test('skarga i wypisanie: tylko powód „na wniosek rodzica”', () => {
  assert.deepEqual(allowedReleaseReasons('complaint'), ['parent_request']);
  assert.deepEqual(allowedReleaseReasons('unsubscribed'), ['parent_request']);
  assert.deepEqual(allowedReleaseReasons('hard_bounce'), [...RELEASE_REASONS]);
});

test('kod potwierdzenia: krótki kod, wymagany dla parent_request', () => {
  assert.equal(parseConfirmationNote('  '), null);
  assert.equal(parseConfirmationNote('parent_email_reply'), 'parent_email_reply');
  assert.throws(() => parseConfirmationNote('', { required: true }), /kod/i);
  for (const bad of ['Ma spacje', 'a@b.invalid', 'x'.repeat(41), 'zażółć']) assert.throws(() => parseConfirmationNote(bad));
});

test('stan wiersza: zgłaszający nie zatwierdza własnego wniosku', () => {
  assert.equal(rowAction({}), 'request');
  assert.equal(rowAction({ pendingRequest: { requestedByMe: true } }), 'waiting');
  assert.equal(rowAction({ pendingRequest: { requestedByMe: false } }), 'approve');
});

test('adresy URL i opisy', () => {
  assert.equal(suppressionsUrl('y 2026'), '/api/email/suppressions?schoolYearId=y%202026');
  assert.equal(suppressionActionUrl(HASH, 'release'), `/api/email/suppressions/${HASH}/release`);
  assert.throws(() => suppressionActionUrl('zły', 'release'));
  assert.throws(() => suppressionActionUrl(HASH, 'delete'));
  assert.match(describeFamily({ householdId: 'h1', guardianId: 'g1' }), /h1.*g1/);
  assert.match(describeFamily({ householdId: null }), /Nie znaleziono/);
  assert.equal(formatSuppressionCount(1), '1 adres do sprawdzenia');
  assert.equal(formatSuppressionCount(3), '3 adresy do sprawdzenia');
  assert.equal(formatSuppressionCount(5), '5 adresów do sprawdzenia');
  assert.equal(formatSuppressionCount(12), '12 adresów do sprawdzenia');
  assert.match(describeSuppressionError(403, 'self_approval_forbidden'), /inna osoba/);
  assert.equal(describeSuppressionError(500, null), null);
});
