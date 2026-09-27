import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContactPatch, canEditFamilies, groupClassesByYear, parseRoute } from '../families/core.js';

test('trasy widoku rodzin i odrzucenie niepoprawnych identyfikatorów', () => {
  assert.deepEqual(parseRoute('#/classes/c-1a'), { view: 'class', id: 'c-1a' });
  assert.deepEqual(parseRoute('#/households/h-1'), { view: 'household', id: 'h-1' });
  assert.deepEqual(parseRoute('#/households/..%2F..'), { view: 'classes' });
  assert.deepEqual(parseRoute(''), { view: 'classes' });
});

test('grupowanie klas po roku i przyciski edycji tylko dla admina/zarządu', () => {
  const groups = groupClassesByYear([
    { id: 'a', schoolYearId: 'y2', schoolYearLabel: '2027/28' },
    { id: 'b', schoolYearId: 'y1', schoolYearLabel: '2026/27' },
    { id: 'c', schoolYearId: 'y2', schoolYearLabel: '2027/28' },
  ]);
  assert.deepEqual(groups.map((g) => [g.schoolYearId, g.classes.map((c) => c.id)]), [['y2', ['a', 'c']], ['y1', ['b']]]);
  assert.equal(canEditFamilies([{ role: 'representative', classId: 'c' }]), false);
  assert.equal(canEditFamilies([{ role: 'board' }]), true);
});

test('formularz kontaktu wysyła tylko zmienione pola z powodem', () => {
  const current = { email: 'a@example.invalid', contactAllowed: false };
  assert.deepEqual(buildContactPatch({ email: ' A@example.invalid ', contactAllowed: true, reason: 'Prośba' }, current),
    { patch: { reason: 'Prośba', contactAllowed: true } });
  assert.ok(buildContactPatch({ email: 'zly', contactAllowed: false, reason: 'Prośba' }, current).error);
  assert.ok(buildContactPatch({ email: 'a@example.invalid', contactAllowed: false, reason: 'Prośba' }, current).error);
  assert.ok(buildContactPatch({ email: '', contactAllowed: false, reason: 'x' }, current).error);
  assert.deepEqual(buildContactPatch({ email: '', contactAllowed: false, reason: 'Brak adresu' }, current),
    { patch: { reason: 'Brak adresu', email: null } });
});
