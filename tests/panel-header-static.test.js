// Przegląd demo 5 (propozycje 2, 3, 5, 7): spójny wygląd paneli widoczny przy
// przełączaniu ekranów. Test statyczny pilnuje, że:
// - każdy panel z nawigacją powłoki (#shell-nav) ma ten sam nagłówek (klasa
//   .shell-header, ta sama marka) — wygląd nagłówka i tytułu daje wyłącznie
//   shared/shell.css, więc wysokość i krój są wszędzie takie same;
// - shared/shell.css ustala układ nagłówka, jeden krój tytułu <h1> i kolor linków
//   w treści (nie domyślny niebieski przeglądarki) z widocznym fokusem;
// - filtr roku nie powtarza „Rok szkolny” w nagłówku sekcji i w widocznej etykiecie;
// - na wydruku (shared/print.css) kolumna akcji znika razem z nagłówkiem.
// Pomiar w przeglądarce (wysokość nagłówka, krój, kolor linków): tests/e2e/panel-header.spec.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const panels = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/index.html`, root)))
  .map((entry) => entry.name)
  .filter((name) => read(`${name}/index.html`).includes('id="shell-nav"'));

const BRAND = '<a class="brand" href="../"><span class="brand-name">Rada Rodziców</span><small data-school-name></small></a>';

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rules(css) {
  const found = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css))) found.push({ selector: match[1].trim().replace(/\s+/g, ' '), body: match[2] });
  return found;
}

test('wszystkie panele z nawigacją powłoki mają ten sam nagłówek (.shell-header i marka)', () => {
  // Lista musi objąć wszystkie panele z shared/shell.js (PANELS) — 15 ekranów.
  assert.ok(panels.length >= 15, `znaleziono ${panels.length} paneli: ${panels.join(', ')}`);
  const offenders = [];
  for (const panel of panels) {
    const html = read(`${panel}/index.html`);
    const header = /<header([^>]*)>([\s\S]*?)<\/header>/.exec(html);
    if (!header) { offenders.push(`${panel}: brak <header>`); continue; }
    if (!/class="site-header shell-header"/.test(header[1])) offenders.push(`${panel}: <header${header[1]}>`);
    if (!header[2].includes(BRAND)) offenders.push(`${panel}: marka inna niż wspólna`);
    if (!/<nav aria-label="Panel">\s*<ul id="shell-nav" aria-live="polite"><\/ul>\s*<\/nav>/.test(header[2])) offenders.push(`${panel}: nawigacja`);
    if (!header[2].includes('<div id="shell-account"></div>')) offenders.push(`${panel}: blok konta`);
    // Nagłówek musi być bezpośrednio w <body> (reguła tytułu: body:has(> header.shell-header)).
    if (!/<body>\s*<a class="skip-link"[^>]*>[^<]*<\/a>\s*<header/.test(html)) offenders.push(`${panel}: nagłówek nie jest dzieckiem <body> po skip linku`);
    const main = read(`${panel}/main.js`);
    if (!/import ["']\.\.\/shared\/shell\.css["']/.test(main)) offenders.push(`${panel}: main.js nie ładuje shared/shell.css`);
  }
  assert.deepEqual(offenders, []);
});

test('shared/shell.css: wspólny układ nagłówka, jeden krój tytułu i linki w stylu projektu', () => {
  const css = stripComments(read('shared/shell.css'));
  const mediaStart = css.indexOf('@media');
  const base = rules(css.slice(0, mediaStart));
  const find = (selector) => base.find((rule) => rule.selector === selector);

  const header = find('header.site-header.shell-header');
  assert.ok(header, 'reguła nagłówka poza @media');
  assert.match(header.body, /display:\s*grid/);
  assert.match(header.body, /grid-template-areas:\s*"brand account"\s*"nav nav"/);
  assert.match(header.body, /height:\s*auto/, 'nadpisuje stałe height:72px z families/');
  assert.match(header.body, /background:\s*#fff/);

  const brand = find('header.shell-header > .brand');
  assert.ok(brand);
  assert.match(brand.body, /white-space:\s*nowrap/, 'marka nie łamie się na 3–4 linie przy 1280 px');
  const name = find('header.shell-header #shell-account .shell-account-name');
  assert.ok(name);
  assert.match(name.body, /white-space:\s*nowrap/, 'nazwa konta w jednej linii');

  const h1 = find('body:has(> header.shell-header) main h1');
  assert.ok(h1, 'jedna reguła tytułu dla wszystkich paneli');
  assert.match(h1.body, /font-family:\s*Inter, ui-sans-serif/);
  assert.doesNotMatch(h1.body, /Georgia/, 'Georgia tylko w nagłówku strony publicznej (docs/DESIGN.md)');

  const link = find(':where(main, dialog) a');
  assert.ok(link, 'linki w treści mają kolor projektu');
  assert.match(link.body, /color:\s*#b3262d/i);
  const visited = find(':where(main, dialog) a:where(:visited)');
  assert.ok(visited && /color:\s*#b3262d/i.test(visited.body), 'odwiedzony link bez fioletu przeglądarki');
  const focus = find(':where(main, dialog) a:focus-visible');
  assert.ok(focus && /outline:\s*3px solid/.test(focus.body), 'widoczny fokus linków');

  const media = css.slice(mediaStart);
  assert.match(media, /header\.site-header\.shell-header\s*\{[^}]*grid-template-areas:\s*"brand"\s*"account"\s*"nav"/, 'telefon: marka, konto, nawigacja');
});

test('filtr roku: „Rok szkolny” nie powtarza się w nagłówku sekcji i widocznej etykiecie', () => {
  const offenders = [];
  for (const panel of panels) {
    const html = read(`${panel}/index.html`);
    const section = /<h2 id="filters-title">([^<]*)<\/h2>([\s\S]*?)<\/section>/.exec(html);
    if (!section) continue;
    const heading = section[1].trim();
    for (const label of section[2].matchAll(/<label[^>]*>\s*([^<]+?)\s*</g)) {
      if (label[1].trim() === heading) offenders.push(`${panel}: „${heading}” / „${label[1].trim()}”`);
    }
    // Eyebrow „Rok szkolny” nad listą powtarzał to samo po raz trzeci.
    if (html.includes('<p class="eyebrow">Rok szkolny</p>')) offenders.push(`${panel}: eyebrow „Rok szkolny”`);
  }
  assert.deepEqual(offenders, []);
  // Etykieta pola zostaje dla czytnika ekranu (nazwa dostępna pola wyboru).
  assert.match(read('reconciliation/index.html'), /<label><span class="sr-only">Rok szkolny<\/span> <select id="school-year-id"/);
});

test('wydruk: kolumna akcji znika razem z nagłówkiem w panelach z shared/print.css', () => {
  const printCss = stripComments(read('shared/print.css'));
  const media = printCss.slice(printCss.indexOf('@media print'));
  const hidden = /([^{}]+)\{\s*display:\s*none\s*!important;\s*\}/.exec(media);
  assert.ok(hidden, 'reguła ukrywania elementów na wydruku');
  const selectors = hidden[1].split(',').map((s) => s.trim());
  assert.ok(selectors.includes('.col-actions'), 'nagłówek kolumny akcji');
  assert.ok(selectors.includes('td:has(> .row-actions)'), 'komórka z grupą przycisków (panel/)');
  const users = panels.filter((panel) => /import ["']\.\.\/shared\/print\.css["']/.test(read(`${panel}/main.js`)));
  assert.deepEqual(users.sort(), ['families', 'ledger', 'meetings', 'panel']);
  const offenders = [];
  for (const panel of users) {
    for (const th of read(`${panel}/index.html`).matchAll(/<th[^>]*>\s*<span class="sr-only">Akcje<\/span>\s*<\/th>/g)) {
      if (!/class="col-actions"/.test(th[0])) offenders.push(`${panel}: ${th[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
