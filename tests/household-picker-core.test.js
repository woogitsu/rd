// Testy czystych funkcji wyboru gospodarstwa klasa → uczeń → gospodarstwo (issue #128).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classOptionsHtml,
  householdOptionsHtml,
  householdSummary,
  householdsForStudent,
  requiresExplicitHouseholdChoice,
  studentOptionsHtml,
} from '../shared/household-picker.js';

const CLASSES = [{ id: 'c-1a', name: '1A' }, { id: 'c-1b', name: '1B' }];
const STUDENTS = [
  { id: 's-1', firstName: 'Anna', lastName: 'Kowalska', households: [{ householdId: 'h-1', isPrimary: true }] },
  {
    id: 's-2',
    firstName: 'Jan',
    lastName: 'Nowak',
    households: [{ householdId: 'h-2', isPrimary: true }, { householdId: 'h-3', isPrimary: false }],
  },
];

test('classOptionsHtml: pusta lista pokazuje komunikat zamiast pustego selecta', () => {
  assert.match(classOptionsHtml([], ''), /Brak klas w Twoim zakresie/);
});

test('classOptionsHtml: zawiera placeholder i wszystkie klasy, zaznacza wybraną', () => {
  const html = classOptionsHtml(CLASSES, 'c-1b');
  assert.match(html, /Wybierz klasę…/);
  assert.match(html, /<option value="c-1b" selected>1B<\/option>/);
  assert.match(html, /<option value="c-1a">1A<\/option>/);
});

test('studentOptionsHtml: etykieta to nazwisko i imię', () => {
  const html = studentOptionsHtml(STUDENTS, '');
  assert.match(html, /<option value="s-1">Kowalska Anna<\/option>/);
});

test('householdsForStudent: zwraca gospodarstwa konkretnego ucznia, pusta lista dla nieznanego', () => {
  assert.deepEqual(householdsForStudent(STUDENTS, 's-1'), [{ householdId: 'h-1', isPrimary: true }]);
  assert.deepEqual(householdsForStudent(STUDENTS, 'brak'), []);
});

test('requiresExplicitHouseholdChoice: jedno gospodarstwo nie wymaga wyboru, kilka — tak', () => {
  assert.equal(requiresExplicitHouseholdChoice(householdsForStudent(STUDENTS, 's-1')), false);
  assert.equal(requiresExplicitHouseholdChoice(householdsForStudent(STUDENTS, 's-2')), true);
});

test('householdOptionsHtml: jedno gospodarstwo — zaznaczone od razu (bez wymuszania wyboru)', () => {
  const html = householdOptionsHtml(householdsForStudent(STUDENTS, 's-1'), '');
  assert.match(html, /<option value="h-1" selected>h-1 \(główne\)<\/option>/);
  assert.doesNotMatch(html, /Wybierz gospodarstwo…/);
});

test('householdOptionsHtml: opieka dzielona (dwa gospodarstwa) — żadne nie jest domyślnie zaznaczone', () => {
  const households = householdsForStudent(STUDENTS, 's-2');
  const html = householdOptionsHtml(households, '');
  assert.match(html, /Wybierz gospodarstwo…/);
  assert.doesNotMatch(html, /selected>h-2/);
  assert.doesNotMatch(html, /selected>h-3/);
});

test('householdOptionsHtml: opieka dzielona z jawnym wyborem zaznacza dokładnie tę pozycję', () => {
  const households = householdsForStudent(STUDENTS, 's-2');
  const html = householdOptionsHtml(households, 'h-3');
  assert.match(html, /<option value="h-3" selected>h-3<\/option>/);
  assert.doesNotMatch(html, /value="h-2" selected/);
});

test('householdSummary: bez e-maili ani adresów, pokazuje liczbę gospodarstw', () => {
  assert.equal(householdSummary(STUDENTS[0], householdsForStudent(STUDENTS, 's-1')), 'Kowalska Anna · 1 gospodarstwo');
  assert.equal(
    householdSummary(STUDENTS[1], householdsForStudent(STUDENTS, 's-2')),
    'Nowak Jan · 2 gospodarstwa (opieka dzielona)'
  );
  assert.equal(householdSummary(null, []), '');
});
