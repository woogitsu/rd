// #151: wspólny arkusz druku (shared/print.css) i blok metadanych wydruku
// (shared/print-meta.js). Statyczny przegląd — bez przeglądarki. Podgląd wydruku
// w Chromium: tests/e2e/print-panels.spec.js i zrzuty docs/a11y/print-preview-*.png
// (docs/a11y/print-preview.mjs); Firefox i Safari — przegląd ręczny.
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
const { printMetaLines, formatPrintedAt, formatPrintDate, runningHeadText, runningPageCss, cssString } = await import('../shared/print-meta.js');

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

test('formatPrintedAt: zapis dd.mm.rrrr i godzina Europe/Brussels (decyzja 30.09, #563)', () => {
  assert.equal(formatPrintedAt(new Date('2026-01-15T10:30:00Z')), '15.01.2026 11:30');
  // Czas letni: +02:00, bez stałego przesunięcia.
  assert.equal(formatPrintedAt(new Date('2026-07-01T22:15:00Z')), '02.07.2026 00:15');
  assert.equal(formatPrintDate('2026-10-20'), '20.10.2026');
  assert.equal(formatPrintDate(''), '');
  assert.equal(formatPrintDate(null), '');
});

test('printMetaLines: „Wydrukowano … przez <nazwa>” w zapisie polskim', () => {
  const lines = printMetaLines({ printedBy: 'Skarbnik testowy', now: new Date('2026-10-20T14:05:00Z') });
  assert.ok(lines.some((l) => l.text === 'Wydrukowano: 20.10.2026 16:05 przez Skarbnik testowy'));
});

test('runningHeadText i runningPageCss: nagłówek każdej strony bez danych osobowych, bezpieczny literał CSS', () => {
  assert.equal(runningHeadText({ view: 'Księga', schoolYear: '2025-2026', summary: 'Bilans zamknięcia 1,00 €' }),
    'Księga · Rok szkolny 2025/2026 · Bilans zamknięcia 1,00 €');
  assert.equal(runningHeadText({ view: 'Protokół', draft: true }), 'PROJEKT · Protokół');
  const css = runningPageCss({ view: 'X"; } body { color: red } @page { content: "', confidential: true });
  // Cudzysłów, ukośnik, nowa linia i „<” nie mogą zamknąć literału ani reguły.
  assert.equal(cssString('a"b\\c\n</style>'), '"a\\"b\\\\c \\3c /style>"');
  const inner = cssString('X"; } body { color: red }').slice(1, -1);
  assert.ok(!/(^|[^\\])"/.test(inner), 'każdy cudzysłów w środku literału jest poprzedzony ukośnikiem');
  assert.ok(css.includes(cssString('X"; } body { color: red } @page { content: "')), 'widok trafia do CSS wyłącznie jako literał');
  assert.match(css, /@bottom-left \{ content: "Dane poufne Rady Rodziców"; \}/);
  assert.match(runningPageCss({}), /@bottom-left \{ content: ""; \}/);
});

test('shared/print.css: numeracja stron i pola marginesu, ukryta wyszukiwarka i link CSV, daty i kwoty bez łamania', () => {
  assert.match(printCss, /@bottom-right \{ content: "Strona " counter\(page\) " z " counter\(pages\)/);
  const printBlock = printCss.match(/@media print \{[\s\S]*/)[0];
  for (const selector of ['#student-search-form', '#events-csv', '.print-hide']) assert.ok(printBlock.includes(selector), selector);
  assert.match(printBlock, /td\.date, td\.amount[^{]*\{ white-space: nowrap; \}/);
  assert.match(printBlock, /\.badge \{ background: none !important; color: #000 !important;/);
});

test('shared/print-meta.js: nagłówek strony przez adoptedStyleSheets (CSP style-src \'self\' blokuje <style>)', () => {
  assert.match(printMeta, /adoptedStyleSheets/);
  assert.ok(!/createElement\("style"\)/.test(printMeta));
});

test('ledger i panel: daty w tabeli w zapisie polskim, filtry dat w metadanych wydruku też', () => {
  assert.match(mainJs.ledger, /textCell\(formatPrintDate\(entry\.occurredOn\), "date"\)/);
  assert.match(mainJs.panel, /textCell\(formatPrintDate\(payment\.receivedOn\), "date"\)/);
  for (const app of ['ledger', 'panel']) {
    assert.match(mainJs[app], /`od \$\{formatPrintDate\(/);
    assert.match(mainJs[app], /`do \$\{formatPrintDate\(/);
  }
  assert.match(mainJs.ledger, /summary: ledgerBalanceSummary\(\)/);
});

test('panele: „przez <nazwa>” z GET /api/session ({ user: { displayName } }) przez sessionDisplayName', () => {
  for (const app of APPS) {
    assert.match(mainJs[app], /printedBy = sessionDisplayName\(result\?\.session\)/);
    assert.ok(!/session\?\.displayName/.test(mainJs[app]), `${app}: płaskie session.displayName nie istnieje w odpowiedzi API`);
  }
});

test('printMeta.js nie odwołuje się do sieci ani DOM poza mountPrintMeta', () => {
  assert.ok(!/fetch\(/.test(printMeta));
});

// #151 (reszta): układ podpisów (D-21, wariant zachowawczy) i granica danych wydruku.
test('meetings: protokół do druku ma dwa puste pola podpisu (D-21, założenie) i wiersze listy z komórką podpisu', () => {
  const section = html.meetings.match(/<section id="print-minutes"[\s\S]*?<\/section>/)[0];
  assert.equal((section.match(/<div><span>[^<]*podpis, data<\/span><\/div>/g) ?? []).length, 2);
  assert.match(printCss, /\.print-signatures\s*\{[^}]*break-inside:\s*avoid/);
  assert.match(mainJs.meetings, /className: "signature"/);
});

test('meetings: wydruk protokołu bierze dane wyłącznie z już pobranego state.detail (bez nowych tras i pól osobowych)', () => {
  const fn = mainJs.meetings.match(/function fillPrintMinutes\(item\) \{[\s\S]*?\n\}\n/)[0];
  assert.ok(!/api\(|fetch\(/.test(fn), 'wydruk nie woła sieci');
  for (const forbidden of ['email', 'displayName', 'userId', 'guardian', 'phone', 'address']) {
    assert.ok(!fn.includes(forbidden), `wydruk protokołu nie może używać pola ${forbidden}`);
  }
  assert.match(fn, /attendee\.capacity/);
});

test('ledger i panel: wydruk używa tego samego formatu kwot co ekran („1 234,56 €”)', async () => {
  const { formatEur } = await import('../panel/money.js');
  assert.equal(formatEur(123456), '1\u00a0234,56\u00a0€');
  assert.equal(formatEur(-5000), '−50,00\u00a0€');
  const ledger = await import('../ledger/core.js');
  assert.equal(ledger.formatCents(123456), '1\u00a0234,56\u00a0€');
});

test('raport KR (GET /api/reports/audit?format=html) ma własny arkusz druku i pola podpisów', () => {
  const report = read('src/pg/audit-report.js');
  assert.match(report, /@page \{ size: A4/);
  assert.match(report, /tr \{ break-inside: avoid; \}/);
  assert.match(report, /\.signatures/);
});
