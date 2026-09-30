// Przegląd demo 3 (docs/DEMO.md, krok 10): Chromium blokuje PDF w <iframe sandbox="">
// (także z dowolnymi tokenami bez skryptów) i jednocześnie NIE stosuje dyrektywy CSP
// `sandbox` do dokumentu PDF — sprawdzone Playwrightem na Chromium 141 i Chrome for
// Testing 153 (#89 część 2, model zagrożeń w docs/DOCUMENTS.md). Ramka podglądu PDF
// jest więc bez atrybutu sandbox; izolację dają nagłówki odpowiedzi (CSP sandbox +
// default-src 'none', nosniff, ponowna kontrola struktury) i CSP panelu. Obok ramki
// zostaje link do TEGO SAMEGO adresu w nowej karcie (większy widok).
// Statyczny przegląd kodu źródłowego, wzorem tests/print-validation-timing.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../documents/index.html', import.meta.url), 'utf8');
const mainJs = readFileSync(new URL('../documents/main.js', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../src/pg/routes/documents.js', import.meta.url), 'utf8');

test('ramka podglądu PDF bez atrybutu sandbox (Chromium blokuje w niej PDF), bez allow-* i bez obcego adresu', () => {
  const frame = html.match(/<iframe id="preview-frame"[^>]*>/);
  assert.ok(frame, 'brak ramki preview-frame');
  assert.doesNotMatch(frame[0], /\ssandbox[\s=>]/);
  assert.doesNotMatch(frame[0], /allow-scripts|allow-same-origin|\ssrc=/);
  assert.match(frame[0], /referrerpolicy="no-referrer"/);
});

test('CSP paneli bez zmian: ramka tylko z własnego originu, bez object-src i obcych skryptów', async () => {
  const nodeApp = readFileSync(new URL('../src/node-app.js', import.meta.url), 'utf8');
  const csp = nodeApp.match(/const STATIC_SECURITY_HEADERS = \{\s*'Content-Security-Policy': "([^"]+)"/)[1];
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /frame-src|child-src/, 'ramka dziedziczy default-src \'self\'');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
});

test('otwarty podgląd PDF prosi o potwierdzenie opuszczenia panelu (link /URI w PDF nawiguje całą kartę)', () => {
  assert.match(mainJs, /window\.addEventListener\("beforeunload", \(event\) => \{\s*\n\s*if \(!pdfPreviewActive \|\| Date\.now\(\) < panelNavigationUntil\) return;\s*\n\s*event\.preventDefault\(\);/);
  const clear = mainJs.slice(mainJs.indexOf('function clearPreview()'), mainJs.indexOf('detailsPreview.addEventListener'));
  assert.match(clear, /pdfPreviewActive = false;/);
  assert.match(mainJs, /if \(kind === "pdf"\) \{\s*\n\s*pdfPreviewActive = true;/);
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
  assert.match(mainJs, /if \(kind === "pdf"\) \{\s*\n\s*pdfPreviewActive = true;\s*\n\s*previewOpenTab\.setAttribute\("href", previewUrl\(id\)\);\s*\n\s*previewOpenTab\.hidden = false;/);
  const clear = mainJs.slice(mainJs.indexOf('function clearPreview()'), mainJs.indexOf('detailsPreview.addEventListener'));
  assert.match(clear, /previewOpenTab\.hidden = true;/);
});

test('odpowiedź podglądu nadal ma CSP sandbox + default-src none — skrypty zablokowane, gdyby plik nie był renderowany jako PDF', () => {
  assert.match(routes, /const PREVIEW_HEADERS = Object\.freeze\(\{[\s\S]*'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'self'"/);
});
