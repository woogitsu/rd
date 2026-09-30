// Testy czystych funkcji ekranu zamknięcia roku szkolnego (issue #147, część 3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHECKLIST_ITEMS,
  CHECKLIST_ROLES,
  CLOSE_ROLES,
  READ_ROLES,
  WARNING_CODES,
  WARNING_LABELS,
  accessReviewSummary,
  canOfferClose,
  canOfferStart,
  checklistProgress,
  checklistUrl,
  closeUrl,
  describeApiError,
  handoverUrl,
  hasChecklistAccess,
  hasCloseAccess,
  hasReadAccess,
  isLikelyOwnClosure,
  isValidId,
  startConfirmation,
  startUrl,
  statusUrl,
  warningRows,
} from '../year-close/core.js';

// Role muszą być identyczne z serwerem (src/pg/routes/year-close.js) — tak jak
// tests/email-panel-core.test.js dla email/core.js.
test('role panelu odpowiadają READ_ROLES/CHECKLIST_ROLES/CLOSE_ROLES na serwerze', () => {
  const source = readFileSync(new URL('../src/pg/routes/year-close.js', import.meta.url), 'utf8');
  const read = source.match(/const READ_ROLES = \[([^\]]*)\]/)[1];
  const checklist = source.match(/const CHECKLIST_ROLES = \[([^\]]*)\]/)[1];
  const close = source.match(/const CLOSE_ROLES = \[([^\]]*)\]/)[1];
  const parse = (text) => [...text.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...READ_ROLES], parse(read));
  assert.deepEqual([...CHECKLIST_ROLES], parse(checklist));
  assert.deepEqual([...CLOSE_ROLES], parse(close));
});

test('CHECKLIST_ITEMS odpowiada CHECKLIST_ITEMS na serwerze', () => {
  const source = readFileSync(new URL('../src/pg/routes/year-close.js', import.meta.url), 'utf8');
  const match = source.match(/export const CHECKLIST_ITEMS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1];
  const parse = (text) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...CHECKLIST_ITEMS], parse(match));
});

test('isValidId: identyfikatory jak na serwerze', () => {
  assert.equal(isValidId('y2026-2027'), true);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('../etc'), false);
  assert.equal(isValidId(undefined), false);
});

test('statusUrl / startUrl / closeUrl / handoverUrl: budują poprawne ścieżki, odrzucają zły rok', () => {
  assert.equal(statusUrl('y2026'), '/api/year-close/y2026');
  assert.equal(startUrl('y2026'), '/api/year-close/y2026/start');
  assert.equal(closeUrl('y2026'), '/api/year-close/y2026/close');
  assert.equal(handoverUrl('y2026'), '/api/year-close/y2026/handover');
  assert.throws(() => statusUrl(''), /szkolnego/);
  assert.throws(() => statusUrl('../x'), /szkolnego/);
});

test('checklistUrl: wymaga znanego punktu listy kontrolnej', () => {
  assert.equal(checklistUrl('y2026', 'financial_report'), '/api/year-close/y2026/checklist/financial_report');
  assert.throws(() => checklistUrl('y2026', 'unknown_item'), /listy kontrolnej/);
});

test('hasReadAccess / hasChecklistAccess / hasCloseAccess: tylko przydział bez klasy, właściwa rola i rok', () => {
  assert.equal(hasReadAccess([{ role: 'treasurer', schoolYearId: 'y1' }], 'y1'), true);
  assert.equal(hasReadAccess([{ role: 'treasurer', classId: 'c1', schoolYearId: 'y1' }], 'y1'), false, 'przydział klasowy nie wystarcza');
  assert.equal(hasReadAccess([{ role: 'representative', schoolYearId: 'y1' }], 'y1'), false);
  assert.equal(hasChecklistAccess([{ role: 'treasurer', schoolYearId: 'y1' }], 'y1'), true);
  assert.equal(hasCloseAccess([{ role: 'treasurer', schoolYearId: 'y1' }], 'y1'), false, 'skarbnik nie zamyka roku');
  assert.equal(hasCloseAccess([{ role: 'board', schoolYearId: 'y1' }], 'y1'), true);
  assert.equal(hasReadAccess(undefined), false);
});

// Serwer (closeYear()) sprawdza closure.initiated_by === actorId — GET zwraca
// tylko initiatedBy, więc to jest przybliżenie widoczności przycisku, nigdy kontrola dostępu.
test('isLikelyOwnClosure: porównuje wyłącznie initiatedBy (przybliżenie widoczności)', () => {
  assert.equal(isLikelyOwnClosure({ initiatedBy: 'u1' }, 'u1'), true);
  assert.equal(isLikelyOwnClosure({ initiatedBy: 'u1' }, 'u2'), false);
  assert.equal(isLikelyOwnClosure(null, 'u1'), false);
  assert.equal(isLikelyOwnClosure({ initiatedBy: 'u1' }, null), false);
});

test('canOfferClose: wymaga stanu "closing", pustej listy braków i innej osoby', () => {
  const base = { status: 'closing', missingChecklistItems: [], initiatedBy: 'u1' };
  assert.equal(canOfferClose(base, 'u2'), true);
  assert.equal(canOfferClose(base, 'u1'), false, 'autor rozpoczęcia nie może zamknąć roku');
  assert.equal(canOfferClose({ ...base, status: 'open' }, 'u2'), false);
  assert.equal(canOfferClose({ ...base, status: 'closed' }, 'u2'), false);
  assert.equal(canOfferClose({ ...base, missingChecklistItems: ['financial_report'] }, 'u2'), false, 'braki na liście kontrolnej');
  assert.equal(canOfferClose(null, 'u2'), false);
});

test('checklistProgress: liczy potwierdzone punkty', () => {
  const status = { checklist: [{ confirmed: true }, { confirmed: false }, { confirmed: true }] };
  assert.deepEqual(checklistProgress(status), { confirmed: 2, total: 3 });
  assert.deepEqual(checklistProgress({}), { confirmed: 0, total: CHECKLIST_ITEMS.length });
});

test('describeApiError: komunikaty po polsku dla typowych kodów', () => {
  assert.match(describeApiError(401, 'unauthenticated'), /Zaloguj/);
  assert.match(describeApiError(403, 'mfa_required'), /MFA/);
  assert.match(describeApiError(409, 'four_eyes_required'), /inna osoba/);
  assert.match(describeApiError(409, 'checklist_incomplete'), /listy kontrolnej/);
  assert.match(describeApiError(409, 'school_year_closed'), /zamknięty/);
  assert.match(describeApiError(403, 'forbidden'), /Nie masz uprawnień/);
  assert.equal(describeApiError(500, null), null);
});

test('canOfferStart: tylko rola zamykająca i rok w stanie open; lista kontrolna nie blokuje rozpoczęcia', () => {
  const board = [{ role: 'board', schoolYearId: 'y1' }];
  const treasurer = [{ role: 'treasurer', schoolYearId: 'y1' }];
  // 0/6 punktów listy kontrolnej: rozpoczęcie musi być możliwe (punkty potwierdza się dopiero po nim).
  const open = { status: 'open', checklist: [], missingChecklistItems: [...CHECKLIST_ITEMS] };
  assert.equal(canOfferStart(open, board, 'y1'), true);
  assert.equal(canOfferStart(open, treasurer, 'y1'), false, 'serwer: POST /start tylko dla CLOSE_ROLES');
  assert.equal(canOfferStart(open, [], 'y1'), false);
  assert.equal(canOfferStart({ status: 'closing' }, board, 'y1'), false);
  assert.equal(canOfferStart({ status: 'closed' }, board, 'y1'), false);
  assert.equal(canOfferStart(null, board, 'y1'), false);
  assert.equal(canOfferStart(open, [{ role: 'board', schoolYearId: 'y2' }], 'y1'), false);
});

test('startConfirmation: okno destrukcyjne z opisem nieodwracalności i rokiem docelowym', () => {
  const dialog = startConfirmation('2026-2027', '2027-2028');
  assert.equal(dialog.destructive, true);
  const text = dialog.effects.join(' ');
  assert.match(text, /2026\/2027/);
  assert.match(text, /2027\/2028/);
  assert.match(text, /nie da się cofnąć/);
  assert.match(text, /lista kontrolna|listy kontrolnej/);
});

test('panel: rozpoczęcie zamknięcia przechodzi przez confirmAction przed żądaniem POST', () => {
  const main = readFileSync(new URL('../year-close/main.js', import.meta.url), 'utf8');
  assert.match(main, /from "\.\.\/shared\/confirm-dialog\.js"/);
  const confirmAt = main.indexOf('await confirmAction(startConfirmation(');
  const postAt = main.indexOf('await api(startUrl(');
  assert.ok(confirmAt > 0 && postAt > confirmAt, 'confirmAction musi poprzedzać POST /start');
  assert.match(main, /byId\("open-start"\)\.hidden = !canOfferStart\(status, state\.grants, state\.schoolYearId\)/);
});

test('WARNING_CODES odpowiada CLOSE_WARNING_CODES na serwerze i każdy kod ma etykietę', () => {
  const source = readFileSync(new URL('../src/pg/routes/year-close.js', import.meta.url), 'utf8');
  const match = source.match(/export const CLOSE_WARNING_CODES = Object\.freeze\(\[([\s\S]*?)\]\)/)[1];
  const parse = (text) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...WARNING_CODES], parse(match));
  for (const code of WARNING_CODES) assert.ok(WARNING_LABELS[code], code);
});

test('warningRows: kolejność serwera, kwoty opcjonalne, nieznany kod nie znika, brak pola = pusta lista', () => {
  assert.deepEqual(warningRows({}), []);
  assert.deepEqual(warningRows(null), []);
  const rows = warningRows({ warnings: [
    { code: 'open_email_campaigns', count: 2, amountCents: null },
    { code: 'future_code', count: 1, amountCents: 5 },
    { code: 'unallocated_payments', count: 1, amountCents: 1500 },
  ] });
  assert.deepEqual(rows.map((row) => row.code), ['unallocated_payments', 'open_email_campaigns', 'future_code']);
  assert.equal(rows[0].amountCents, 1500);
  assert.equal(rows[1].amountCents, null);
  assert.equal(rows[2].label, 'future_code');
});

test('accessReviewSummary: sumy odczytów, odczyty bez ważnego przydziału, brak danych = null', () => {
  assert.equal(accessReviewSummary({}), null);
  const summary = accessReviewSummary({ accessReview: {
    reads: [{ accessKind: 'class_students', entries: 2, hits: 5, actors: 1 }, { accessKind: 'other', entries: 1, hits: 1, actors: 1 }],
    readsWithoutValidGrant: { entries: 1, hits: 2, actors: 1 }, activeGrantsInScope: 4,
  } });
  assert.equal(summary.total, 6);
  assert.deepEqual(summary.byKind.map((row) => row.label), ['Lista klasy', 'other']);
  assert.equal(summary.withoutValidGrant, 2);
  assert.equal(summary.activeGrants, 4);
});
