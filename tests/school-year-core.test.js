// Testy czystych funkcji wyboru roku szkolnego z listy (issue #128).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultYear,
  fillYearSelect,
  heuristicSchoolYearId,
  initialSchoolYearId,
  panelYearState,
  selectYearValue,
  yearChoices,
  yearOptionsHtml,
  yearsFromGrants,
} from '../shared/school-year.js';
import { filtersFromQuery, filtersToQuery } from '../shared/query-filters.js';

test('yearsFromGrants: unikalne lata, malejąco, pomija przydziały bez roku', () => {
  const grants = [
    { role: 'treasurer', schoolYearId: '2025-2026' },
    { role: 'representative', classId: '1A', schoolYearId: '2026-2027' },
    { role: 'representative', classId: '2B', schoolYearId: '2026-2027' },
    { role: 'admin' },
  ];
  assert.deepEqual(yearsFromGrants(grants), ['2026-2027', '2025-2026']);
  assert.deepEqual(yearsFromGrants([]), []);
  assert.deepEqual(yearsFromGrants(undefined), []);
});

test('defaultYear: zachowuje ostatnio wybrany rok, jeśli nadal w zakresie', () => {
  assert.equal(defaultYear(['2026-2027', '2025-2026'], '2025-2026'), '2025-2026');
});

test('defaultYear: rok spoza zakresu (np. cofnięty przydział) → najnowszy dostępny', () => {
  assert.equal(defaultYear(['2026-2027', '2025-2026'], '2019-2020'), '2026-2027');
});

test('defaultYear: brak lat → pusty string', () => {
  assert.equal(defaultYear([], 'cokolwiek'), '');
});

test('yearOptionsHtml: brak lat pokazuje czytelny komunikat zamiast pustej listy', () => {
  assert.match(yearOptionsHtml([], ''), /Brak lat w Twoim zakresie/);
});

test('yearOptionsHtml: zaznacza wybrany rok, koduje bezpiecznie', () => {
  const html = yearOptionsHtml(['2026-2027', '2025-2026'], '2025-2026');
  assert.match(html, /<option value="2025-2026" selected>2025\/2026<\/option>/);
  assert.match(html, /<option value="2026-2027">2026\/2027<\/option>/);
});

test('filtersToQuery: pomija puste wartości, koduje resztę', () => {
  assert.equal(filtersToQuery({ schoolYearId: '2026-2027', status: '' }), 'schoolYearId=2026-2027');
  assert.equal(filtersToQuery({}), '');
});

test('filtersFromQuery: odczytuje tylko znane pola, ignoruje resztę adresu', () => {
  assert.deepEqual(filtersFromQuery('?schoolYearId=2026-2027&evil=<script>', ['schoolYearId', 'status']),
    { schoolYearId: '2026-2027' });
});

// Panele: puste ekrany dopóki użytkownik nie wpisze roku i nie kliknie „Pokaż” —
// domyślny rok ma się ładować od razu. Ta sama heurystyka co site/core.js
// #defaultSchoolYearId (patrz tests/site-core.test.js), wspólna funkcja w shared/.
test('heuristicSchoolYearId: rok zaczyna się 1 września (Europe/Brussels)', () => {
  assert.equal(heuristicSchoolYearId(new Date('2026-09-01T00:00:00Z')), '2026-2027');
  assert.equal(heuristicSchoolYearId(new Date('2026-08-31T12:00:00Z')), '2025-2026');
  // 1.09 lokalnie w Brukseli (UTC+2 latem), mimo że UTC to jeszcze 31.08.
  assert.equal(heuristicSchoolYearId(new Date('2026-08-31T22:30:00Z')), '2026-2027');
});

test('initialSchoolYearId: zachowuje przekazany rok, jeśli nadal w zakresie przydziałów', () => {
  const grants = [{ role: 'treasurer', schoolYearId: '2025-2026' }, { role: 'treasurer', schoolYearId: '2026-2027' }];
  assert.equal(initialSchoolYearId(grants, { previous: '2025-2026' }), '2025-2026');
});

test('initialSchoolYearId: bez poprzedniego roku bierze najnowszy z przydziałów', () => {
  const grants = [{ role: 'treasurer', schoolYearId: '2025-2026' }, { role: 'treasurer', schoolYearId: '2026-2027' }];
  assert.equal(initialSchoolYearId(grants), '2026-2027');
});

test('initialSchoolYearId: brak lat w przydziałach (np. rola globalna admin/board) → heurystyka daty', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  assert.equal(initialSchoolYearId([{ role: 'admin' }], { now }), '2026-2027');
  assert.equal(initialSchoolYearId([], { now }), '2026-2027');
  assert.equal(initialSchoolYearId(undefined, { now }), '2026-2027');
});

test('yearChoices: lata z przydziałów, dodatkowa wartość z linku, awaryjnie rok z heurystyki', () => {
  const grants = [{ role: 'treasurer', schoolYearId: '2025-2026' }, { role: 'board', schoolYearId: '2026-2027' }];
  assert.deepEqual(yearChoices(grants), ['2026-2027', '2025-2026']);
  assert.deepEqual(yearChoices(grants, ['2024-2025', '2026-2027']), ['2026-2027', '2025-2026', '2024-2025']);
  assert.deepEqual(yearChoices([{ role: 'admin' }], [], new Date('2026-10-05T10:00:00Z')), ['2026-2027']);
  assert.deepEqual(yearChoices(undefined, [], new Date('2027-03-05T10:00:00Z')), ['2026-2027']);
});

test('fillYearSelect: wypełnia listę i zwraca rok; poprzedni wybór zachowany, spoza zakresu ignorowany', () => {
  const grants = [{ schoolYearId: '2025-2026' }, { schoolYearId: '2026-2027' }];
  const select = { innerHTML: '', value: '' };
  assert.equal(fillYearSelect(select, grants), '2026-2027');
  assert.match(select.innerHTML, /<option value="2026-2027" selected>/);
  assert.equal(fillYearSelect(select, grants, { value: '2025-2026' }), '2025-2026');
  assert.equal(select.value, '2025-2026');
  // Rok z linku spoza przydziałów trafia na listę (serwer i tak autoryzuje żądanie).
  assert.equal(fillYearSelect(select, grants, { value: '2019-2020' }), '2019-2020');
  assert.match(select.innerHTML, /2019-2020/);
});

test('selectYearValue dodaje brakującą opcję i nie robi nic dla pustej wartości', () => {
  const added = [];
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
  const select = { options: [{ value: 'a' }], value: 'a', add(o) { added.push(o.value); this.options.push(o); } };
  selectYearValue(select, 'a');
  assert.deepEqual(added, []);
  selectYearValue(select, 'b');
  assert.deepEqual(added, ['b']);
  assert.equal(select.value, 'b');
  selectYearValue(select, '');
  assert.equal(select.value, 'b');
  delete globalThis.Option;
});

test('panelYearState: admin z przydziałem bez roku dostaje rok z heurystyki zamiast „Brak lat” (Wpłaty, Księga)', () => {
  const now = new Date('2026-09-29T10:00:00Z');
  const admin = panelYearState([{ role: 'admin' }], '', now);
  assert.deepEqual(admin, { years: ['2026-2027'], year: '2026-2027' });
  assert.match(yearOptionsHtml(admin.years, admin.year), /<option value="2026-2027" selected>/);
  assert.doesNotMatch(yearOptionsHtml(admin.years, admin.year), /Brak lat/);
  assert.deepEqual(panelYearState(undefined, '', now), { years: ['2026-2027'], year: '2026-2027' });
});

test('panelYearState: lata z przydziałów mają pierwszeństwo, rok z adresu tylko gdy jest na liście', () => {
  const grants = [{ role: 'treasurer', schoolYearId: '2025-2026' }, { role: 'board', schoolYearId: '2026-2027' }];
  assert.deepEqual(panelYearState(grants, '2025-2026'), { years: ['2026-2027', '2025-2026'], year: '2025-2026' });
  assert.equal(panelYearState(grants, '2019-2020').year, '2026-2027');
});

test('panele Wpłaty i Księga wybierają rok przez panelYearState (nie przez samo yearsFromGrants)', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['../panel/main.js', '../ledger/main.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /panelYearState\(/, file);
    assert.doesNotMatch(source, /yearsFromGrants\(/, file);
  }
});

test('option w liście ma wartość-identyfikator i etykietę „RRRR/RRRR” (formatSchoolYear)', () => {
  const html = yearOptionsHtml(['2026-2027'], '');
  assert.match(html, /value="2026-2027"/);
  assert.doesNotMatch(html, />2026-2027</);
});
