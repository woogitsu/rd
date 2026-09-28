// Statyczny przegląd dostępności (WCAG 2.2 AA) wszystkich aplikacji Vite z panelem.
// Test nie zastępuje sprawdzenia z czytnikiem ekranu — zob. docs/ACCESSIBILITY.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APPS = ['import', 'panel', 'ledger', 'print'];
// Issue #85: wspólna powłoka. Te aplikacje dostały tę samą nawigację i blok konta,
// ale nie miały wcześniej pełnego przeglądu WCAG z listy wyżej (osobny zakres audytu) —
// sprawdzamy tu wyłącznie spójność nawigacji/konta, którą wprowadza ta zmiana.
const SHELL_APPS = [...APPS, 'families', 'events', 'meetings', 'documents', 'admin'];
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = Object.fromEntries(SHELL_APPS.map((app) => [app, read(`${app}/index.html`)]));
const css = Object.fromEntries(APPS.map((app) => [app, read(`${app}/styles.css`)]));

function tags(source) {
  const body = source.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const out = [];
  for (const match of body.matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>/gi)) {
    const attrs = {};
    for (const a of match[3].matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) attrs[a[1].toLowerCase()] = a[2] ?? '';
    out.push({ close: match[1] === '/', name: match[2].toLowerCase(), attrs });
  }
  return out;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255]
    .map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

for (const app of APPS) {
  test(`${app}: język, skip link i punkty orientacyjne`, () => {
    assert.match(html[app], /<html lang="pl">/);
    assert.match(html[app], /<a class="skip-link" href="#main">Przejdź do treści<\/a>/);
    assert.match(html[app], /<main id="main">/);
    assert.match(html[app], /<header[\s>]/);
    assert.match(html[app], /<nav aria-label="Panel">/);
    assert.match(html[app], /<h1[\s>]/);
    assert.equal((html[app].match(/<h1[\s>]/g) || []).length, 1);
  });

  test(`${app}: tabele mają caption i th scope`, () => {
    const t = tags(html[app]);
    const tables = t.filter((x) => x.name === 'table' && !x.close).length;
    const captions = t.filter((x) => x.name === 'caption' && !x.close).length;
    assert.equal(captions, tables);
    for (const th of t.filter((x) => x.name === 'th' && !x.close)) assert.ok(th.attrs.scope, 'th bez scope');
  });

  test(`${app}: każde pole ma etykietę, odwołania ARIA istnieją`, () => {
    const t = tags(html[app]);
    const ids = new Set(t.filter((x) => x.attrs.id).map((x) => x.attrs.id));
    const labelFor = new Set(t.filter((x) => x.name === 'label' && x.attrs.for).map((x) => x.attrs.for));
    let depth = 0;
    for (const tag of t) {
      if (tag.name === 'label') depth += tag.close ? -1 : 1;
      if (tag.close || !['input', 'select', 'textarea'].includes(tag.name)) continue;
      if (tag.attrs.type === 'hidden') continue;
      const named = depth > 0 || labelFor.has(tag.attrs.id) || tag.attrs['aria-label'] || tag.attrs['aria-labelledby'];
      assert.ok(named, `pole bez etykiety: ${JSON.stringify(tag.attrs)}`);
    }
    for (const tag of t) {
      for (const attr of ['aria-describedby', 'aria-labelledby']) {
        if (!tag.attrs[attr]) continue;
        for (const id of tag.attrs[attr].split(/\s+/)) assert.ok(ids.has(id), `${attr} wskazuje brakujące id ${id}`);
      }
    }
  });

  test(`${app}: okna dialogowe mają nazwę, komunikaty błędów są ogłaszane`, () => {
    const t = tags(html[app]);
    for (const dialog of t.filter((x) => x.name === 'dialog' && !x.close)) assert.ok(dialog.attrs['aria-labelledby']);
    for (const box of t.filter((x) => /(^| )form-error( |$)/.test(x.attrs.class || ''))) {
      assert.ok(box.attrs.id, 'form-error bez id');
      assert.ok(box.attrs.role === 'alert' || box.attrs.role === 'status', 'form-error bez roli live');
    }
  });

  test(`${app}: widoczny fokus, minimalny rozmiar przycisków, ograniczony ruch`, () => {
    assert.match(css[app], /:focus-visible\s*\{\s*outline:\s*3px solid/);
    assert.doesNotMatch(css[app], /outline:\s*(none|0)\b/);
    assert.match(css[app], /button\s*\{[^}]*min-height:\s*44px/);
    assert.match(css[app], /prefers-reduced-motion:\s*reduce/);
  });
}

for (const app of SHELL_APPS) {
  test(`${app}: wspólna nawigacja i blok konta (issue #85, WCAG 3.2.3)`, () => {
    // Nawigacja jest teraz identyczna we wszystkich panelach: jeden pusty <ul>
    // wypełniany w czasie działania przez shared/shell.js na podstawie GET /api/access
    // (visiblePanels — testowane bez DOM w tests/shell-core.test.js). Ukrycie linku nie
    // jest kontrolą dostępu — o tym nadal decyduje wyłącznie serwer (bez zmian tutaj).
    assert.match(html[app], /<html lang="pl">/);
    assert.match(html[app], /<a class="skip-link" href="#main">Przejdź do treści<\/a>/);
    assert.match(html[app], /<main[^>]*\bid="main"/);
    const nav = html[app].match(/<nav aria-label="Panel">([\s\S]*?)<\/nav>/)[1];
    assert.match(nav, /<ul id="shell-nav" aria-live="polite"><\/ul>/);
    assert.match(html[app], /<div id="shell-account"><\/div>/);
  });
}

// Pary kolorów faktycznie użyte w CSS (tekst / tło). Tekst ≥ 4,5:1, obramowania pól ≥ 3:1.
const TEXT_PAIRS = [
  ['#282c2f', '#ffffff', 'tekst podstawowy'],
  ['#b3262d', '#ffffff', 'czerwony akcent (link, eyebrow, aktywna zakładka)'],
  ['#b3262d', '#fafafa', 'czerwony akcent na jasnym tle'],
  ['#ffffff', '#b3262d', 'biały tekst na przycisku głównym'],
  ['#ffffff', '#8e2026', 'biały tekst na przycisku głównym (hover)'],
  ['#8e2026', '#ffffff', 'ciemna czerwień (skip link, błędy)'],
  ['#9b1a23', '#ffffff', 'komunikat błędu'],
  ['#9b1a23', '#fff5f4', 'błąd w wierszu importu'],
  ['#5d6266', '#ffffff', 'tekst pomocniczy'],
  ['#5d6266', '#fafafa', 'tekst pomocniczy na jasnym tle'],
  ['#3e4347', '#ffffff', 'nawigacja'],
  ['#6e6864', '#ffffff', 'panel: opisy'],
  ['#625c57', '#faf9f8', 'panel: nagłówki tabel'],
  ['#79716c', '#ffffff', 'panel: opis rodziny w tabeli'],
  ['#23613e', '#e9f5ed', 'panel: status przypisana'],
  ['#8a5411', '#fff3dc', 'panel: status do przypisania'],
  ['#276447', '#e5f2ea', 'księga: przychód'],
  ['#9d1723', '#f8e7e9', 'księga: wydatek'],
  ['#68635e', '#ffffff', 'księga: podsumowanie'],
  ['#6b6661', '#ffffff', 'księga: nagłówki tabel'],
];
const UI_PAIRS = [
  ['#767676', '#ffffff', 'obramowanie pól formularza'],
  ['#8e2026', '#ffffff', 'obrys fokusu'],
];

test('kontrast kolorów tekstu ≥ 4,5:1 (WCAG 1.4.3)', () => {
  const allCss = Object.values(css).join('\n').toLowerCase();
  for (const [fg, bg, name] of TEXT_PAIRS) {
    assert.ok(allCss.includes(fg) || allCss.includes(fg.replace(/^#(.)\1(.)\2(.)\3$/, '#$1$2$3')), `kolor ${fg} (${name}) nie występuje w CSS — zaktualizuj listę`);
    assert.ok(contrast(fg, bg) >= 4.5, `${name}: ${fg} na ${bg} = ${contrast(fg, bg).toFixed(2)}`);
  }
});

test('kontrast elementów interfejsu ≥ 3:1 (WCAG 1.4.11)', () => {
  for (const [fg, bg, name] of UI_PAIRS) assert.ok(contrast(fg, bg) >= 3, `${name}: ${contrast(fg, bg).toFixed(2)}`);
});

test('w CSS nie zostały kolory tekstu poniżej progu', () => {
  // Kolory wycofane w przeglądzie #16 (za niski kontrast na białym tle).
  for (const [app, source] of Object.entries(css)) {
    for (const bad of ['#8a817c', '#777;', '#777}', '#f4c8ca', '#bbb3ae', '#acb3b8']) {
      assert.ok(!source.includes(bad), `${app}: niski kontrast ${bad}`);
    }
  }
});
