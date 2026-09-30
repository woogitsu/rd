// Testy czystych funkcji wyboru gospodarstwa klasa → uczeń → gospodarstwo (issue #128).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHouseholdLabels,
  householdLabel,
  shownSummary,
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
  assert.match(html, /<option value="h-1" selected>Gospodarstwo nr h-1 \(główne\)<\/option>/);
  assert.doesNotMatch(html, /Wybierz gospodarstwo…/);
});

test('householdOptionsHtml: opieka dzielona (dwa gospodarstwa) — żadne nie jest domyślnie zaznaczone', () => {
  const households = householdsForStudent(STUDENTS, 's-2');
  const html = householdOptionsHtml(households, '');
  assert.match(html, /Wybierz gospodarstwo…/);
  assert.doesNotMatch(html, /value="h-2" selected/);
  assert.doesNotMatch(html, /value="h-3" selected/);
});

test('householdOptionsHtml: opieka dzielona z jawnym wyborem zaznacza dokładnie tę pozycję', () => {
  const households = householdsForStudent(STUDENTS, 's-2');
  const html = householdOptionsHtml(households, 'h-3');
  assert.match(html, /<option value="h-3" selected>Gospodarstwo nr h-3<\/option>/);
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

test('buildHouseholdLabels: rodzeństwo w 1A i 1B daje jedną etykietę z dwoma uczniami i klasami', () => {
  const labels = buildHouseholdLabels([
    { className: '1A', students: [{ id: 's-1', firstName: 'Anna', lastName: 'Kowalska', households: [{ householdId: 'h-1' }] }] },
    { className: '1B', students: [{ id: 's-9', firstName: 'Piotr', lastName: 'Kowalski', households: [{ householdId: 'h-1' }, { householdId: 'h-7' }] }] },
  ]);
  assert.equal(labels.get('h-1'), 'Kowalska Anna (1A), Kowalski Piotr (1B)');
  assert.equal(labels.get('h-7'), 'Kowalski Piotr (1B)');
  assert.equal(labels.size, 2);
});

test('buildHouseholdLabels: brak danych (rola bez dostępu) daje pustą mapę', () => {
  assert.equal(buildHouseholdLabels([]).size, 0);
  assert.equal(buildHouseholdLabels(undefined).size, 0);
});

test('householdLabel: etykieta, skrócony numer zamiast pełnego UUID i brak przypisania', () => {
  const labels = new Map([['h-1', 'Kowalska Anna (1A)']]);
  assert.equal(householdLabel(labels, 'h-1'), 'Rodzina: Kowalska Anna (1A)');
  assert.equal(householdLabel(labels, '0a1b2c3d-1111-2222-3333-444455556666'), 'Rodzina nr 0a1b2c3d');
  assert.equal(householdLabel(labels, null), 'Nie przypisano rodziny');
  assert.equal(householdLabel(null, 'h-1'), 'Rodzina nr h-1');
});

test('shownSummary: odmiana i informacja o kolejnych stronach', () => {
  assert.equal(shownSummary(0, false), '');
  assert.match(shownSummary(1, false), /^Pokazano 1 wpłatę — to wszystkie/);
  assert.match(shownSummary(3, true), /^Pokazano 3 wpłaty, są kolejne/);
  assert.match(shownSummary(12, true), /^Pokazano 12 wpłat,/);
  assert.match(shownSummary(22, false), /^Pokazano 22 wpłaty /);
});

// Przegląd demo 5: etykiety rodzin wspólne dla panel/ i reconciliation/ (fetchHouseholdLabels).
test('fetchHouseholdLabels: pobiera klasy roku i uczniów, buduje etykiety; błąd → pusta mapa', async () => {
  const { fetchHouseholdLabels } = await import('../shared/household-picker.js');
  const calls = [];
  const api = async (url) => {
    calls.push(url);
    if (url === '/api/classes?schoolYearId=2026-2027') return { classes: CLASSES };
    if (url === '/api/classes/c-1a/students') return { students: STUDENTS };
    if (url === '/api/classes/c-1b/students') return { students: [] };
    throw new Error(`nieoczekiwany adres ${url}`);
  };
  const labels = await fetchHouseholdLabels(api, '2026-2027');
  assert.deepEqual(calls, ['/api/classes?schoolYearId=2026-2027', '/api/classes/c-1a/students', '/api/classes/c-1b/students']);
  assert.equal(labels.get('h-1'), 'Kowalska Anna (1A)');
  assert.equal(householdLabel(labels, 'h-1'), 'Rodzina: Kowalska Anna (1A)');
  // Rola bez dostępu do rodzin (403) — pusta mapa, widok zostaje przy skróconym numerze.
  const denied = await fetchHouseholdLabels(async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); }, '2026-2027');
  assert.equal(denied.size, 0);
  assert.equal(householdLabel(denied, 'h-1234567890'), 'Rodzina nr h-123456');
});

test('householdOptionsHtml: etykieta ze skrótem numeru, pełny identyfikator tylko w value (przegląd demo 5)', () => {
  const id = '5b0f3c1e-7a93-4d66-9c1a-000000000010';
  const html = householdOptionsHtml([{ householdId: id, isPrimary: true }], '');
  assert.match(html, new RegExp(`<option value="${id}" selected>Gospodarstwo nr 5b0f3c1e \\(główne\\)</option>`));
  assert.equal(html.split(id).length - 1, 1, 'pełny identyfikator wyłącznie w atrybucie value');
});
