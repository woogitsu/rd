// Podgląd PDF w panelu dokumentów przez PDF.js dołączony do repozytorium (issue #89,
// kryterium 2; wskazanie właściciela 2026-10-02). Statyczny przegląd kodu źródłowego,
// wzorem tests/print-validation-timing.test.js: panel nie używa <iframe> dla PDF, nie ładuje
// biblioteki z CDN, wyłącza eval/XFA/adnotacje, a serwer nie wydaje PDF inline.
// Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('documents/index.html');
const mainJs = read('documents/main.js');
const viewerJs = read('documents/pdf-preview.js');
const coreJs = read('documents/core.js');
const routes = read('src/pg/routes/documents.js');
const nodeApp = read('src/node-app.js');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

test('panel nie ma <iframe> ani linku „nowa karta” dla PDF; jest kontener PDF.js', () => {
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /preview-frame|preview-open-tab|Otwórz podgląd w nowej karcie/);
  assert.match(html, /<div id="preview-pdf"[^>]*aria-label="Podgląd dokumentu PDF"/);
  assert.doesNotMatch(mainJs, /preview-frame|previewFrame|previewOpenTab/);
});

test('panel renderuje PDF przez PDF.js z bajtów pobranych po autoryzacji (purpose=preview), nie przez disposition=inline', () => {
  assert.match(mainJs, /import\("\.\/pdf-preview\.js"\)/);
  // Bajty przez wspólny klient (shared/api.js, binary) — bez bezpośredniego fetch (tests/shared-api.test.js).
  assert.match(mainJs, /getJson\(pdfPreviewUrl\(id\), \{ binary: true/);
  assert.match(coreJs, /export function pdfPreviewUrl\(id\) \{\s*\n\s*return `\$\{contentUrl\(id\)\}\?purpose=preview`;/);
  assert.match(viewerJs, /from "pdfjs-dist\/legacy\/build\/pdf\.mjs"/);
  assert.match(viewerJs, /legacy\/build\/pdf\.worker\.min\.mjs\?url/);
  assert.match(viewerJs, /GlobalWorkerOptions\.workerSrc = workerUrl/);
});

test('PDF.js: bez eval, XFA, adnotacji (linki i formularze), bez zewnętrznych adresów', () => {
  assert.match(viewerJs, /isEvalSupported: false/);
  assert.match(viewerJs, /enableXfa: false/);
  assert.match(viewerJs, /annotationMode: pdfjsLib\.AnnotationMode\.DISABLE/);
  assert.doesNotMatch(viewerJs, /https?:\/\//);
  assert.doesNotMatch(viewerJs, /AnnotationLayer|TextLayer|pdf_viewer|pdf\.sandbox|unsafe-eval/);
});

test('stronicowanie: przyciski Poprzednia/Następna, „Strona N z M” jako tekst alternatywny i komunikat', () => {
  assert.match(viewerJs, /prev\.textContent = "Poprzednia"/);
  assert.match(viewerJs, /next\.textContent = "Następna"/);
  assert.match(viewerJs, /setAttribute\("aria-label", "Poprzednia strona"\)/);
  assert.match(viewerJs, /setAttribute\("aria-label", "Następna strona"\)/);
  assert.match(viewerJs, /return `Strona \$\{page\} z \$\{total\}`/);
  assert.match(viewerJs, /canvas\.setAttribute\("aria-label", label\)/);
  assert.match(viewerJs, /status\.setAttribute\("aria-live", "polite"\)/);
});

test('serwer: PDF + disposition=inline = 400 pdf_inline_not_allowed, obrazy zostają inline, ponowna kontrola struktury i nagłówki zostają', () => {
  assert.match(routes, /if \(inline && doc\.mimeType === 'application\/pdf'\) return json\(\{ error: 'pdf_inline_not_allowed' \}, 400\)/);
  assert.match(routes, /document_preview_blocked/);
  assert.match(routes, /const PREVIEW_HEADERS = Object\.freeze\(\{[\s\S]*'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'self'"/);
  assert.match(routes, /action: 'document\.viewed'/);
});

test('zależność pdfjs-dist przypięta do dokładnej wersji w package.json i package-lock.json (licencja Apache-2.0)', () => {
  const version = pkg.dependencies['pdfjs-dist'];
  assert.match(version, /^\d+\.\d+\.\d+$/, 'dokładna wersja, bez ^ i ~');
  assert.equal(lock.packages['node_modules/pdfjs-dist'].version, version);
  assert.equal(lock.packages['node_modules/pdfjs-dist'].license, 'Apache-2.0');
  assert.equal(lock.packages[''].dependencies['pdfjs-dist'], version);
});

test('czcionki standardowe PDF.js z własnego originu (vite.config.js kopiuje je z pdfjs-dist, bez CDN)', () => {
  assert.match(viewerJs, /standardFontDataUrl: new URL\("\.\/standard_fonts\/", import\.meta\.url\)\.href/);
  const config = read('documents/vite.config.js');
  assert.match(config, /node_modules\/pdfjs-dist\/standard_fonts\//);
  assert.match(config, /assets\/standard_fonts\//);
  assert.doesNotMatch(config, /https?:\/\//);
  assert.match(nodeApp, /\['\.pfb', 'application\/octet-stream'\]/);
  assert.match(nodeApp, /\['\.ttf', 'font\/ttf'\]/);
});

test('serwer statyczny zna .mjs (worker z zasobów bundla, z własnego originu)', () => {
  assert.match(nodeApp, /\['\.mjs', 'text\/javascript; charset=utf-8'\]/);
});

test('zbudowany panel zawiera worker i czcionki PDF.js jako lokalne zasoby (bez dist/ pomijane, chyba że REQUIRE_DIST=1)', () => {
  const assets = fileURLToPath(new URL('../dist/documents/assets', import.meta.url));
  if (!existsSync(assets)) {
    if (process.env.REQUIRE_DIST === '1') assert.fail('brak dist/documents — uruchom npm run build');
    return;
  }
  const files = readdirSync(assets);
  assert.ok(files.some((name) => /^pdf\.worker\.min-.+\.mjs$/.test(name)), 'worker PDF.js w dist/documents/assets');
  assert.ok(readdirSync(`${assets}/standard_fonts`).includes('LiberationSans-Regular.ttf'), 'czcionki standardowe w dist/documents/assets/standard_fonts');
  const built = readFileSync(new URL('../dist/documents/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(built, /https?:\/\/(?!www\.w3\.org)/);
});
