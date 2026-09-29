// Przegląd demo 3 (docs/DEMO.md, krok 10): Chromium blokuje PDF w <iframe sandbox="">
// („This page has been blocked by Chromium”, sprawdzone Playwrightem z oknem). Ramka
// zostaje bez zmian (izolacja z #89), a obok jest link do TEGO SAMEGO adresu podglądu
// jako osobna karta. Odpowiedź podglądu ma nadal CSP `sandbox` (bez skryptów).
// Statyczny przegląd kodu źródłowego, wzorem tests/print-validation-timing.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../documents/index.html', import.meta.url), 'utf8');
const mainJs = readFileSync(new URL('../documents/main.js', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../src/pg/routes/documents.js', import.meta.url), 'utf8');

test('ramka podglądu PDF zachowuje sandbox="" (bez skryptów i dostępu do originu panelu)', () => {
  assert.match(html, /<iframe id="preview-frame"[^>]*\ssandbox=""/);
});

test('link „Otwórz podgląd w nowej karcie” otwiera nową kartę z rel="noopener", domyślnie ukryty', () => {
  const link = html.match(/<a id="preview-open-tab"[^>]*>([^<]*)<\/a>/);
  assert.ok(link, 'brak linku preview-open-tab');
  assert.equal(link[1], 'Otwórz podgląd w nowej karcie');
  assert.match(link[0], /target="_blank"/);
  assert.match(link[0], /rel="noopener noreferrer"/);
  assert.match(link[0], /\shidden[\s>]/);
});

test('link wskazuje ten sam adres co ramka (previewUrl) i tylko dla PDF; czyszczenie podglądu go ukrywa', () => {
  assert.match(mainJs, /if \(kind === "pdf"\) \{\s*\n\s*previewOpenTab\.setAttribute\("href", previewUrl\(id\)\);\s*\n\s*previewOpenTab\.hidden = false;/);
  const clear = mainJs.slice(mainJs.indexOf('function clearPreview()'), mainJs.indexOf('detailsPreview.addEventListener'));
  assert.match(clear, /previewOpenTab\.hidden = true;/);
});

test('odpowiedź podglądu nadal ma CSP sandbox — nowa karta nie uruchamia skryptów z pliku', () => {
  assert.match(routes, /const PREVIEW_HEADERS = Object\.freeze\(\{[\s\S]*'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'self'"/);
});
