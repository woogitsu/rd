// Testy czystych funkcji wyboru roku szkolnego z listy (issue #128).
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultYear, yearOptionsHtml, yearsFromGrants } from '../shared/school-year.js';
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
  assert.match(html, /<option value="2025-2026" selected>2025-2026<\/option>/);
  assert.match(html, /<option value="2026-2027">2026-2027<\/option>/);
});

test('filtersToQuery: pomija puste wartości, koduje resztę', () => {
  assert.equal(filtersToQuery({ schoolYearId: '2026-2027', status: '' }), 'schoolYearId=2026-2027');
  assert.equal(filtersToQuery({}), '');
});

test('filtersFromQuery: odczytuje tylko znane pola, ignoruje resztę adresu', () => {
  assert.deepEqual(filtersFromQuery('?schoolYearId=2026-2027&evil=<script>', ['schoolYearId', 'status']),
    { schoolYearId: '2026-2027' });
});
