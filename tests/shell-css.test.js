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
