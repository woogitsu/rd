import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContactPatch,
  canEditFamilies,
  filterStudentsByName,
  groupClassesByYear,
  parseRoute,
  sortStudentsByName,
} from '../families/core.js';

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

// issue #128: wyszukiwanie i sortowanie na już wczytanej liście uczniów klasy.
test('filterStudentsByName: puste zapytanie zwraca całą listę bez kopiowania kolejności', () => {
  const students = [{ firstName: 'Anna', lastName: 'Kowalska' }, { firstName: 'Jan', lastName: 'Nowak' }];
  assert.deepEqual(filterStudentsByName(students, ''), students);
  assert.deepEqual(filterStudentsByName(students, '   '), students);
  assert.deepEqual(filterStudentsByName(undefined, 'a'), []);
});

test('filterStudentsByName: dopasowanie bez rozróżniania wielkości liter i polskich znaków diakrytycznych', () => {
  const students = [
    { firstName: 'Łukasz', lastName: 'Zięba' },
    { firstName: 'Ola', lastName: 'Kowalska' },
    { firstName: 'Piotr', lastName: 'Nowicki' },
  ];
  assert.deepEqual(filterStudentsByName(students, 'zieba').map((s) => s.lastName), ['Zięba']);
  assert.deepEqual(filterStudentsByName(students, 'KOWAL').map((s) => s.lastName), ['Kowalska']);
  assert.deepEqual(filterStudentsByName(students, 'nowic').map((s) => s.lastName), ['Nowicki']);
});

test('filterStudentsByName: znaki % i _ nie mają specjalnego znaczenia (brak wstrzyknięcia w filtrze klienta)', () => {
  const students = [{ firstName: 'A', lastName: '100%' }, { firstName: 'B', lastName: 'Zwykły' }];
  assert.deepEqual(filterStudentsByName(students, '%').map((s) => s.lastName), ['100%']);
  assert.deepEqual(filterStudentsByName(students, '_').length, 0);
});

test('sortStudentsByName: sortuje po nazwisku, potem imieniu, wg polskiego alfabetu', () => {
  const students = [
    { firstName: 'Ola', lastName: 'Żurek' },
    { firstName: 'Jan', lastName: 'Adamski' },
    { firstName: 'Ala', lastName: 'Adamski' },
  ];
  const sorted = sortStudentsByName(students).map((s) => `${s.lastName} ${s.firstName}`);
  assert.deepEqual(sorted, ['Adamski Ala', 'Adamski Jan', 'Żurek Ola']);
});
