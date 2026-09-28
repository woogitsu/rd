// Testy czystych funkcji ekranu kampanii e-mail (issue #147, część 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  APPROVER_ROLES,
  EDITOR_ROLES,
  buildCampaignsUrl,
  campaignActionUrl,
  campaignUrl,
  canOfferApproval,
  describeApiError,
  formatDayPlan,
  formatExclusions,
  formatWarnings,
  hasApproverAccess,
  hasEditorAccess,
  isLikelyOwnCampaign,
  isValidId,
  makeIdempotencyKey,
  maskEmail,
} from '../email/core.js';

// Role muszą być identyczne z serwerem (src/pg/routes/email.js) — tak jak
// tests/role-policy-parity.test.js dla ról finansowych panelu/księgi.
test('role panelu odpowiadają EDITOR_ROLES/APPROVER_ROLES na serwerze', () => {
  const source = readFileSync(new URL('../src/pg/routes/email.js', import.meta.url), 'utf8');
  const editor = source.match(/const EDITOR_ROLES = \[([^\]]*)\]/)[1];
  const approver = source.match(/const APPROVER_ROLES = \[([^\]]*)\]/)[1];
  const parse = (text) => [...text.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...EDITOR_ROLES], parse(editor));
  assert.deepEqual([...APPROVER_ROLES], parse(approver));
});

test('isValidId: identyfikatory jak na serwerze', () => {
  assert.equal(isValidId('cmp-1'), true);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('../etc'), false);
  assert.equal(isValidId(undefined), false);
});

test('buildCampaignsUrl: wymaga poprawnego roku', () => {
  assert.equal(buildCampaignsUrl('y2026'), '/api/email/campaigns?schoolYearId=y2026');
  assert.throws(() => buildCampaignsUrl(''), /szkolnego/);
  assert.throws(() => buildCampaignsUrl('../x'), /szkolnego/);
});

test('campaignUrl / campaignActionUrl: budują poprawne ścieżki, odrzucają zły id', () => {
  assert.equal(campaignUrl('cmp-1'), '/api/email/campaigns/cmp-1');
  assert.equal(campaignActionUrl('cmp-1', 'approve'), '/api/email/campaigns/cmp-1/approve');
  assert.throws(() => campaignUrl(''), /identyfikator/);
});

test('maskEmail: pierwsza litera + domena, bez ujawniania reszty lokalnej części', () => {
  assert.equal(maskEmail('jan.kowalski@example.invalid'), 'j***@example.invalid');
  assert.equal(maskEmail('a@example.invalid'), 'a***@example.invalid');
  assert.equal(maskEmail(''), '***');
  assert.equal(maskEmail(null), '***');
});

test('makeIdempotencyKey: prefiks + losowy UUID, wymaga crypto.randomUUID', () => {
  const key = makeIdempotencyKey('email-create', () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(key, 'email-create-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.throws(() => makeIdempotencyKey('x', null), /bezpiecznych identyfikatorów/);
});

// Serwer (approve()) sprawdza createdBy/updatedBy/snapshotBuiltBy — GET zwraca
// tylko createdBy, więc to jest przybliżenie widoczności przycisku, nigdy kontrola dostępu.
test('isLikelyOwnCampaign: porównuje wyłącznie createdBy (przybliżenie widoczności)', () => {
  assert.equal(isLikelyOwnCampaign({ createdBy: 'u1' }, 'u1'), true);
  assert.equal(isLikelyOwnCampaign({ createdBy: 'u1' }, 'u2'), false);
  assert.equal(isLikelyOwnCampaign(null, 'u1'), false);
  assert.equal(isLikelyOwnCampaign({ createdBy: 'u1' }, null), false);
});

test('canOfferApproval: wymaga szkicu, aktualnej migawki z odbiorcami i innej osoby', () => {
  const base = { status: 'draft', recipientsHash: 'h', recipientsCount: 3, createdBy: 'u1' };
  assert.equal(canOfferApproval(base, 'u2'), true);
  assert.equal(canOfferApproval(base, 'u1'), false, 'autor nie może zatwierdzić własnej kampanii');
  assert.equal(canOfferApproval({ ...base, status: 'approved' }, 'u2'), false);
  assert.equal(canOfferApproval({ ...base, recipientsHash: null }, 'u2'), false, 'bez migawki');
  assert.equal(canOfferApproval({ ...base, recipientsCount: 0 }, 'u2'), false, 'zero odbiorców');
  assert.equal(canOfferApproval(null, 'u2'), false);
});

test('formatExclusions: etykiety po polsku, pomija zera, sortuje po kodzie', () => {
  const lines = formatExclusions({ no_consent: 2, payment_recorded: 0, suppressed: 1 });
  assert.deepEqual(lines, [
    'brak zgody na kontakt: 2',
    'adres wykluczony (odbicie lub rezygnacja): 1',
  ]);
  assert.deepEqual(formatExclusions(undefined), []);
});

test('formatDayPlan: jeden dzień vs kilka dni, pokazuje limit dzienny', () => {
  assert.match(formatDayPlan({ days: ['2026-01-01'], dailyCap: 50 }), /jednym dniu/);
  assert.match(formatDayPlan({ days: ['a', 'b', 'c'], dailyCap: 50, reservedForOtherMail: 10 }), /3 dni/);
  assert.equal(formatDayPlan(null), '');
});

test('formatWarnings: etykiety po polsku, nieznany kod bez zmian', () => {
  const lines = formatWarnings(['missing_skip_if_paid_sentence', 'unknown_code']);
  assert.match(lines[0], /pominąć/);
  assert.equal(lines[1], 'unknown_code');
  assert.deepEqual(formatWarnings(undefined), []);
});

test('hasEditorAccess / hasApproverAccess: tylko przydział bez klasy, właściwa rola i rok', () => {
  assert.equal(hasEditorAccess([{ role: 'treasurer', schoolYearId: 'y1' }], 'y1'), true);
  assert.equal(hasEditorAccess([{ role: 'treasurer', classId: 'c1', schoolYearId: 'y1' }], 'y1'), false, 'przydział klasowy nie wystarcza');
  assert.equal(hasEditorAccess([{ role: 'representative', schoolYearId: 'y1' }], 'y1'), false);
  assert.equal(hasApproverAccess([{ role: 'treasurer', schoolYearId: 'y1' }], 'y1'), false, 'skarbnik nie zatwierdza');
  assert.equal(hasApproverAccess([{ role: 'board', schoolYearId: 'y1' }], 'y1'), true);
  assert.equal(hasEditorAccess(undefined), false);
});

test('describeApiError: komunikaty po polsku dla typowych kodów', () => {
  assert.match(describeApiError(401, 'unauthenticated'), /Zaloguj/);
  assert.match(describeApiError(403, 'mfa_required'), /MFA/);
  assert.match(describeApiError(403, 'forbidden'), /Nie masz uprawnień/);
  assert.match(describeApiError(403, 'self_approval_forbidden'), /inna osoba/);
  assert.equal(describeApiError(500, null), null);
});
