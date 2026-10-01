// Dostępność strony publicznej (site/) i widoku aktualności/galerii — issue #124.
// Uzupełnia tests/a11y-static.test.js (ogólne kryteria dla wszystkich aplikacji)
// o rzeczy specyficzne dla strony publicznej: kontrast tokenów z site/styles.css,
// zabezpieczenia układu przy 320 px, tekst alternatywny wyłącznie z zatwierdzonych
// danych oraz obsługę dużej liczby wpisów z długimi tytułami. Test statyczny nie
// zastępuje sprawdzenia z czytnikiem ekranu (docs/ACCESSIBILITY.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newsItems, normalizePhotos } from '../site/core.js';
import { assertEvery } from './helpers/assertions.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [html, css, main] = await Promise.all([read('site/index.html'), read('site/styles.css'), read('site/main.js')]);

function token(name) {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `brak tokenu --${name} w site/styles.css`);
  return m[1];
}
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('site/: kontrast tokenów z CSS — tekst ≥ 4,5:1 na białym i jasnoszarym tle, obrys fokusu ≥ 3:1', () => {
  const white = '#ffffff';
  const soft = token('soft');
  for (const name of ['text', 'muted', 'red', 'red-dark']) {
    for (const bg of [white, soft]) {
      assert.ok(contrast(token(name), bg) >= 4.5, `--${name} na ${bg}: ${contrast(token(name), bg).toFixed(2)}`);
    }
  }
  assert.ok(contrast(token('red-dark'), white) >= 3, 'obrys fokusu (--red-dark) na białym < 3:1');
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--red-dark\)/);
});

test('site/: język, skip link, jeden h1, punkty orientacyjne, nagłówki sekcji', () => {
  assert.match(html, /<html lang="pl">/);
  assert.match(html, /<a class="skip-link" href="#main">/);
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /<header[\s\S]*<nav aria-label="[^"]+">[\s\S]*<\/header>/);
  assert.match(html, /<footer/);
  // Każda sekcja ma nazwę z własnego nagłówka h2 i każdy link nawigacji prowadzi do istniejącej sekcji.
  for (const [, id, labelledby] of html.matchAll(/<section id="([^"]+)" aria-labelledby="([^"]+)"/g)) {
    assert.match(html, new RegExp(`<h2 id="${labelledby}">`), `sekcja #${id}: brak h2#${labelledby}`);
  }
  for (const [, target] of html.matchAll(/<a href="#([^"]+)">/g)) {
    if (target === 'main') continue;
    assert.match(html, new RegExp(`<section id="${target}"`), `link #${target} bez sekcji`);
  }
  // Żaden element nawigacji ani sekcji nie jest ukryty do czasu wczytania (WCAG 3.2.3).
  assert.doesNotMatch(html, /<(li|section)[^>]*\bhidden\b/);
  // Lupa i zoom: brak blokady skalowania.
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale/);
});

test('site/: zabezpieczenia układu przy 320 px — długie tytuły się łamią, obrazy i treści nie wychodzą poza ekran', () => {
  assert.match(css, /body\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.news-photo img\s*\{[^}]*max-width:\s*100%[^}]*height:\s*auto/);
  assert.match(css, /\.minutes-text\s*\{[^}]*white-space:\s*pre-wrap/); // pre-wrap łamie wiersze, w przeciwieństwie do pre
  assert.doesNotMatch(css.replace(/\.sr-only[^}]*\}/, ''), /white-space:\s*(pre|nowrap)\s*[;}]/); // .sr-only jest poza układem
  assert.doesNotMatch(css, /(?<![-\w])(min-)?width:\s*\d{3,}px/); // brak sztywnych szerokości ≥ 100 px (max-width dozwolone)
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('site/: galeria — alt wyłącznie z zatwierdzonych danych, dekoracyjne z pustym alt, podpis w figcaption', () => {
  // Alt jest przypisywany zawsze i bez zastępczego opisu (żadnego „Zdjęcie: …” ani nazw plików).
  assert.match(main, /img\.alt = photo\.alt;/);
  assert.doesNotMatch(main, /alt\s*=\s*[^;]*(\|\||\?\?)/);
  assert.match(main, /el\("figure", null, "news-photo"\)/);
  assert.match(main, /el\("figcaption", photo\.caption/);
  // Zdjęcia bez opisu i bez znacznika decorative nie są pokazywane; podpis nie wymyśla opisu.
  const photos = normalizePhotos([
    { id: 'a', altText: 'Stoły na dziedzińcu', author: 'Autor Testowy' },
    { id: 'b', altText: '', decorative: true, author: 'Autor Testowy' },
    { id: 'c', altText: null, author: 'Autor Testowy', source: 'Archiwum', license: 'Zgoda' },
    { id: 'd', author: 'Autor Testowy' },
  ]);
  assert.deepEqual(photos.map((p) => [p.id, p.alt]), [['a', 'Stoły na dziedzińcu'], ['b', '']]);
  assert.equal(photos[1].decorative, true);
  // Alt to dokładnie tekst z bazy (bez dopisków), a nazwa pliku ani adres nie trafiają do alt.
  assertEvery(photos, (p) => !p.alt.includes('/api/') && !/\.(jpe?g|png|webp)/i.test(p.alt));
});

test('site/: 20 wpisów z długimi tytułami — komplet, od najnowszego, tytuł ograniczony i tylko jako tekst', () => {
  const long = 'Bardzo-długi-tytuł-bez-spacji-'.repeat(30);
  const payload = { posts: Array.from({ length: 20 }, (_, i) => ({
    id: `p${i}`,
    title: i === 0 ? '<img src=x onerror=alert(1)>' : `${long}${i}`,
    body: 'Treść wpisu.',
    publishedAt: new Date(Date.UTC(2026, 8, 1 + i, 10)).toISOString(),
    photos: [],
  })) };
  const items = newsItems(payload);
  assert.equal(items.length, 20);
  assert.equal(items[0].id, 'p19');
  assert.equal(items.at(-1).title, '<img src=x onerror=alert(1)>'); // zostaje zwykłym tekstem (renderowany przez textContent)
  assertEvery(items, (n) => n.title.length <= 300);
  assertEvery(items.slice(0, -1), (n) => n.title.endsWith('…'));
});

test('site/: komunikaty stanu — błąd wczytywania jest role="alert", stan pusty role="status"', () => {
  assert.match(main, /setAttribute\("role", isError \? "alert" : "status"\)/);
  for (const id of ['news-status', 'events-status', 'minutes-status', 'notices-status', 'privacy-status']) {
    assert.match(html, new RegExp(`id="${id}" role="status"`));
  }
  assert.equal((main.match(/Nie udało się wczytać[^"]*", true\)/g) || []).length, 5);
});
