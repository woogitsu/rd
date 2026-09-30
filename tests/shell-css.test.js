// Przegląd demo: przy 12–13 linkach nawigacji (zarząd) nagłówek panelu miał ok. 1770 px
// przy ekranie 1280 px, a „Wyloguj” lądował poza ekranem. Test sprawdza, że zawijanie
// linków i możliwość skurczenia <nav> działają na WSZYSTKICH szerokościach, nie tylko
// w regule @media (max-width: 480px) (tam nawigacja przewija się w sobie).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function blocks(css) {
  const found = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css))) found.push({ selector: match[1].trim(), body: match[2] });
  return found;
}

test('shell.css: #shell-nav zawija linki, a <nav> może się skurczyć poza @media (przegląd demo, 1280 px)', async () => {
  const css = (await readFile(new URL('../shared/shell.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const mediaStart = css.indexOf('@media');
  assert.ok(mediaStart > 0, 'plik ma blok @media dla telefonu');
  const base = blocks(css.slice(0, mediaStart));
  const nav = base.find((rule) => rule.selector === '#shell-nav');
  assert.ok(nav, 'reguła #shell-nav poza @media');
  assert.match(nav.body, /flex-wrap:\s*wrap/);
  const shrink = base.find((rule) => rule.selector === 'nav:has(> #shell-nav)');
  assert.ok(shrink, 'reguła nav:has(> #shell-nav) poza @media');
  assert.match(shrink.body, /min-width:\s*0/);
  const links = base.find((rule) => rule.selector === '#shell-nav a');
  assert.ok(links, 'linki jako bloki, żeby znacznik aktywnej pozycji nie zachodził na kolejny wiersz');
  assert.match(links.body, /display:\s*block/);
});

test('shell.css: na telefonie nawigacja nadal przewija się w sobie (bez zawijania)', async () => {
  const css = (await readFile(new URL('../shared/shell.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const media = css.slice(css.indexOf('@media'));
  const nav = blocks(media.slice(media.indexOf('{') + 1)).find((rule) => rule.selector === '#shell-nav');
  assert.ok(nav);
  assert.match(nav.body, /flex-wrap:\s*nowrap/);
  assert.match(nav.body, /overflow-x:\s*auto/);
});

test('shell.css: rok szkolny w bloku konta nie łamie się na wiele linii (przegląd demo)', async () => {
  const css = (await readFile(new URL('../shared/shell.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = blocks(css).find((r) => r.selector === '#shell-account .shell-account-year');
  assert.ok(rule);
  assert.match(rule.body, /white-space:\s*nowrap/);
});

// Tryb wysokiego kontrastu (forced-colors): box-shadow aktywnej pozycji znika, a kolor
// czerwony zastępuje kolor systemowy. Reguła zastępcza musi mieć co najmniej tę samą
// szczegółowość co `header.shell-header #shell-nav a` (border: 0, text-decoration: none),
// inaczej — jak reguły `nav a.active` w styles.css paneli — nie działa w nagłówku.
test('shell.css: aktywny link #shell-nav odróżnialny w forced-colors (obramowanie i podkreślenie kolorami systemowymi)', async () => {
  const css = (await readFile(new URL('../shared/shell.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const start = css.indexOf('@media (forced-colors: active)');
  assert.ok(start > 0, 'brak @media (forced-colors: active) w shared/shell.css');
  const inner = css.slice(css.indexOf('{', start) + 1);
  const end = inner.search(/\}\s*\}/);
  const rules = blocks(inner.slice(0, end + 1));
  const active = rules.find((rule) => rule.selector.split(',').map((s) => s.trim()).includes('header.shell-header #shell-nav a.active'));
  assert.ok(active, 'reguła header.shell-header #shell-nav a.active w bloku forced-colors');
  assert.match(active.body, /border-bottom:\s*\d+px solid (Highlight|LinkText|CanvasText)/);
  assert.match(active.body, /text-decoration:\s*underline/);
  assert.match(active.body, /box-shadow:\s*none/);
  // Bez polegania na tle: reguła nie ustawia tła ani kolorów spoza palety systemowej.
  assert.doesNotMatch(active.body, /background/);
  assert.doesNotMatch(active.body, /#[0-9a-f]{3,6}\b/i);
  // Reguła bazowa nadal oznacza aktywną pozycję (poza forced-colors) — reguła zastępcza
  // dotyczy tego samego selektora.
  const base = blocks(css.slice(0, start)).find((rule) => rule.selector === 'header.shell-header #shell-nav a.active');
  assert.ok(base, 'bazowa reguła aktywnej pozycji');
  assert.match(base.body, /box-shadow:/);
});
