// #151: wspólny arkusz druku (shared/print.css) i blok metadanych wydruku
// (shared/print-meta.js). Statyczny przegląd — bez przeglądarki; podgląd
// wydruku wymaga ręcznego sprawdzenia w Chrome/Firefox/Safari (docs/a11y/).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const printCss = read('shared/print.css');
const APPS = ['ledger', 'panel', 'meetings', 'families'];
const mainJs = Object.fromEntries(APPS.map((app) => [app, read(`${app}/main.js`)]));
const html = Object.fromEntries(APPS.map((app) => [app, read(`${app}/index.html`)]));

test('shared/print.css ukrywa nawigację, filtry, dialogi i akcje wiersza na wydruku', () => {
  const printBlock = printCss.match(/@media print \{[\s\S]*/)[0];
  for (const selector of ['header.site-header', 'nav', '.toolbar', '.filters', '.row-actions', '.load-more', 'dialog', 'button']) {
    assert.ok(printBlock.includes(selector), `brak reguły dla ${selector}`);
  }
});

test('shared/print.css: nagłówek tabeli powtarza się, wiersz nie jest dzielony, A4 z marginesem 15mm', () => {
  assert.match(printCss, /thead\s*\{\s*display:\s*table-header-group/);
  assert.match(printCss, /tr\s*\{[^}]*break-inside:\s*avoid/);
  assert.match(printCss, /@page\s*\{\s*size:\s*A4;\s*margin:\s*15mm/);
  assert.match(printCss, /\.table-wrap\s*\{[^}]*overflow:\s*visible/);
});

test('shared/print.css: .print-meta niewidoczny na ekranie, widoczny na wydruku', () => {
  assert.match(printCss, /^\.print-meta \{ display: none; \}/m);
  assert.match(printCss, /@media print \{[\s\S]*\.print-meta \{ display: block;/);
});

for (const app of APPS) {
  test(`${app}: ładuje shared/print.css`, () => {
    assert.match(mainJs[app], /import ["']\.\.\/shared\/print\.css["'];/);
  });
  test(`${app}: ma kontener .print-meta w <main>`, () => {
    assert.match(html[app], /<div class="print-meta" id="print-meta"/);
  });
}

test('families: wydruk listy klasy ma znacznik poufności', () => {
  assert.match(mainJs.families, /confidential:\s*true/);
});

test('meetings: wydruk protokołu nie drukuje z okna <dialog> — kopiuje treść do #print-minutes', () => {
  assert.match(html.meetings, /<section id="print-minutes" class="print-only"/);
  assert.match(mainJs.meetings, /print-minutes-button/);
  assert.match(mainJs.meetings, /document\.body\.dataset\.printTarget = "minutes"/);
  assert.match(mainJs.meetings, /window\.print\(\)/);
});

test('meetings: protokół niezatwierdzony dostaje znacznik PROJEKT na wydruku', () => {
  assert.match(mainJs.meetings, /draft = item\.status !== "approved"/);
});

test('ledger i panel: przycisk „Drukuj zestawienie” dociąga wszystkie strony przed drukiem', () => {
  for (const app of ['ledger', 'panel']) {
    assert.match(mainJs[app], /Drukuj zestawienie|print-(ledger|payments)/);
    assert.match(mainJs[app], /state\.printing/);
    assert.match(mainJs[app], /window\.print\(\)/);
  }
});

const printMeta = read('shared/print-meta.js');
const { printMetaLines, formatPrintedAt } = await import('../shared/print-meta.js');

test('printMetaLines: znacznik poufności i PROJEKT tylko na żądanie', () => {
  const plain = printMetaLines({ view: 'X' });
  assert.ok(!plain.some((l) => l.confidential));
  assert.ok(!plain.some((l) => /PROJEKT/.test(l.text)));
  const confidential = printMetaLines({ confidential: true });
  assert.ok(confidential.some((l) => l.confidential && /Dane poufne Rady Rodziców/.test(l.text)));
  const draft = printMetaLines({ draft: true });
  assert.ok(draft.some((l) => /PROJEKT/.test(l.text)));
});

test('printMetaLines: wydruk niepełny pokazuje liczbę wpisów', () => {
  const lines = printMetaLines({ incompleteCount: 42 });
  assert.ok(lines.some((l) => /Wydruk niepełny — pokazano 42 wpisów\./.test(l.text)));
});

test('formatPrintedAt: data po polsku, godzina Europe/Brussels', () => {
  const text = formatPrintedAt(new Date('2026-01-15T10:30:00Z'));
  assert.match(text, /15 stycznia 2026/);
  assert.match(text, /\d{2}:\d{2}/);
});

test('printMeta.js nie odwołuje się do sieci ani DOM poza mountPrintMeta', () => {
  assert.ok(!/fetch\(/.test(printMeta));
});
