// Testy czystych funkcji wyboru klasy z listy (issue #128).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classChoiceOptionsHtml, classesOfYear, classesUrl, fillClassSelect } from '../shared/class-choice.js';

const classes = [
  { id: 'c-1a', name: '1A', schoolYearId: '2026-2027' },
  { id: 'c-2b', name: '2B <b>', schoolYearId: '2026-2027' },
  { id: 'c-old', name: '3C', schoolYearId: '2025-2026' },
];

test('classesOfYear zostawia tylko klasy wskazanego roku', () => {
  assert.deepEqual(classesOfYear(classes, '2025-2026').map((c) => c.id), ['c-old']);
  assert.deepEqual(classesOfYear(undefined, '2026-2027'), []);
});

test('classChoiceOptionsHtml: escapowanie, zaznaczenie i opcja pusta dla pola opcjonalnego', () => {
  const html = classChoiceOptionsHtml(classesOfYear(classes, '2026-2027'), { selected: 'c-1a', optional: true, emptyLabel: 'Ogólnoszkolne' });
  assert.match(html, /^<option value="">Ogólnoszkolne<\/option>/);
  assert.match(html, /<option value="c-1a" selected>1A<\/option>/);
  assert.ok(html.includes('2B &lt;b&gt;'));
  assert.equal(html.includes('<b>'), false);
});

test('classChoiceOptionsHtml: brak klas i pole wymagane', () => {
  assert.equal(classChoiceOptionsHtml([], {}), '<option value="">Brak klas w Twoim zakresie</option>');
  assert.equal(classChoiceOptionsHtml([], { optional: true, emptyLabel: 'Wszystkie klasy' }), '<option value="">Wszystkie klasy</option>');
  assert.match(classChoiceOptionsHtml(classes, {}), /^<option value="">Wybierz klasę…<\/option>/);
});

test('classesUrl koduje rok szkolny', () => {
  assert.equal(classesUrl('2026-2027'), '/api/classes?schoolYearId=2026-2027');
  assert.equal(classesUrl('a b&c'), '/api/classes?schoolYearId=a%20b%26c');
});

test('fillClassSelect: klasy z API, tylko wybranego roku; błąd API (403) daje pustą listę', async () => {
  const select = { innerHTML: '', value: '' };
  const seen = [];
  const ok = await fillClassSelect(select, async (url) => { seen.push(url); return { classes }; }, '2026-2027', { selected: 'c-2b' });
  assert.deepEqual(seen, ['/api/classes?schoolYearId=2026-2027']);
  assert.deepEqual(ok.map((c) => c.id), ['c-1a', 'c-2b']);
  assert.equal(select.value, 'c-2b');
  const denied = await fillClassSelect(select, async () => { throw Object.assign(new Error('x'), { status: 403 }); }, '2026-2027');
  assert.deepEqual(denied, []);
  assert.match(select.innerHTML, /Brak klas/);
  // Bez roku nie ma żądania.
  let called = false;
  await fillClassSelect(select, async () => { called = true; return { classes }; }, '');
  assert.equal(called, false);
});
