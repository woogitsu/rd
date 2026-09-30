// Przegląd #16 (rozszerzony w #112): renderuje strony przy 320, 640 (≈ zoom 200%) i 1280 px,
// sprawdza poziome przewijanie strony, rozmiar celów (< 24 px), obrys fokusu po klawiszu Tab
// i obsługę okna dialogowego klawiaturą. Dane wyłącznie syntetyczne.
//
// Tryb 1 (domyślny, bez sesji): zbudowane strony z dist/ przez serwer statyczny, /api/* zwraca 401.
//   npm run build
//   printf 'ID rodziny;Imię ucznia;Nazwisko ucznia;Klasa;Wpłaty netto EUR\nH-1;Ala;Testowa;3a;\n' > /tmp/rodziny.csv
//   node docs/a11y/audit.mjs "$PWD/dist" "$PWD/docs/a11y" /tmp [import,panel,ledger,print]
// Tryb 2 (#112): działający serwer demo (docs/DEMO.md, `npm run demo:seed` + `npm run demo:start`)
// i zapisana sesja Playwright (storageState JSON, np. po zalogowaniu kontem
// przedstawiciel@example.invalid). Wtedy panele z danymi (families/, documents/, events/…)
// renderują się jak u użytkownika:
//   AUDIT_BASE_URL=http://127.0.0.1:3000 AUDIT_STORAGE_STATE=/tmp/sesja.json \
//     node docs/a11y/audit.mjs "$PWD/dist" "$PWD/docs/a11y" /tmp families,families:gospodarstwo,documents,events
// Bez listy aplikacji audytowane są wszystkie z STATIC_PREFIXES (src/node-app.js).
// Playwright pochodzi z devDependencies (@playwright/test); PLAYWRIGHT_MODULE wskazuje inny moduł,
// AUDIT_CHROMIUM — plik wykonywalny Chromium (np. /opt/pw-browsers/chromium).
// To samo sprawdzenie dla families/, documents/, events/ w CI: tests/e2e/a11y-layout.spec.js.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import http from 'node:http'; import { readFile } from 'node:fs/promises'; import { extname, join } from 'node:path';
import { STATIC_PREFIXES } from '../../src/node-app.js';
const ROOT = process.argv[2], OUT = process.argv[3], SP = process.argv[4];
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.csv':'text/csv' };
let server = null, base = process.env.AUDIT_BASE_URL?.replace(/\/$/, '');
if (!base) {
  server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    if (p.startsWith('/api/')) { res.writeHead(401, {'content-type':'application/json'}); return res.end('{"error":{"message":"Brak sesji (serwer testowy)."}}'); }
    try { const b = await readFile(join(ROOT, p)); res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); res.end(b); }
    catch { res.writeHead(404); res.end(); }
  }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}
const storageState = process.env.AUDIT_STORAGE_STATE || undefined;
const browser = await chromium.launch({ executablePath: process.env.AUDIT_CHROMIUM || undefined, args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer'] });
const report = [];

async function prepare(page, app, view) {
  // families/: widoki klasy i karty gospodarstwa są pod tym samym adresem (routing po #).
  if (app === 'families' && view) {
    await page.locator('#years a').first().click(); await page.waitForSelector('#class-view:not([hidden]) table a');
    if (view === 'gospodarstwo') { await page.locator('#class-view table a').first().click(); await page.waitForSelector('#household-view:not([hidden])'); }
  }
  if (app === 'import') { await page.setInputFiles('#file', join(ROOT, 'import/template.csv')); await page.waitForSelector('#mapping-section:not([hidden])'); await page.$eval('#preview', (b) => b.click()); }
  if (app === 'print') {
    await page.fill('input[name=schoolYear]', '2026/2027'); await page.fill('input[name=contact]', 'rada@example.test');
    await page.setInputFiles('#file-input', join(SP, 'rodziny.csv')); await page.waitForSelector('#select-section:not([hidden])');
    await page.$eval('#select-visible', (b) => b.click());
  }
  if (app === 'panel' || app === 'ledger') {
    await page.evaluate(() => document.querySelectorAll('[hidden]').forEach((el) => { if (!el.closest('dialog') && el.id !== 'loading') el.hidden = false; }));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}
const only = process.argv[5] ? process.argv[5].split(',') : [...STATIC_PREFIXES];
for (const entry of only) {
  const [app, view] = entry.split(':');
  for (const width of [320, 640, 1280]) {
   for (let attempt = 0; attempt < 3; attempt++) {
    const page = await browser.newPage({ storageState, reducedMotion: 'reduce', viewport: { width, height: width === 320 ? 640 : 800 } });
    try {
    console.error(entry, width); await page.goto(`${base}/${app}/`); await page.waitForLoadState('networkidle'); if (new URL(page.url()).pathname.startsWith(`/${app}/`)) await prepare(page, app, view);
    const r = await page.evaluate(() => {
      const doc = document.documentElement;
      const overflow = doc.scrollWidth - doc.clientWidth;
      const wide = [...document.querySelectorAll('body *')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && b.right > doc.clientWidth + 1 && !el.closest('.tablewrap,.table-wrap,dialog,.skip-link,#shell-nav') && !el.classList.contains('skip-link') && !el.classList.contains('sr-only'); }).slice(0, 5).map((el) => el.tagName + (el.id ? '#' + el.id : '') + '.' + el.className);
      const small = [...document.querySelectorAll('button, input, select, textarea, nav a, a.brand')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.width < 24 || b.height < 24); }).map((el) => el.tagName + (el.id ? '#' + el.id : '') + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height));
      return { overflow, wide, small };
    });
    const noOutline = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return null; const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return { tag: el.tagName + (el.id ? '#' + el.id : ''), outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2, visible: b.bottom > 0 && b.top < innerHeight }; });
      if (f && (!f.outline || !f.visible)) noOutline.push(f.tag + (f.outline ? '' : ' brak-obrysu') + (f.visible ? '' : ' poza-ekranem'));
    }
    // Bez sesji (tryb 1) panele wymagające logowania przekierowują na /login/ — wtedy wynik dotyczy
    // ekranu logowania, nie panelu; `redirectedTo` to jawnie pokazuje (użyj trybu 2).
    const path = new URL(page.url()).pathname;
    report.push({ app: entry, width, ...(path.startsWith(`/${app}/`) ? {} : { redirectedTo: path }), ...r, noOutline: [...new Set(noOutline)] });
    if (width !== 640 && path.startsWith(`/${app}/`)) { await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); }); await page.screenshot({ path: join(OUT, `${entry.replace(':', '-')}-${width}.png`) }); }
      await page.close(); break;
    } catch (e) { console.error('retry', entry, width, e.message.split('\n')[0]); await page.close().catch(() => {}); }
   }
  }
}
for (const [app, opener] of [['panel', '#open-payment']].filter(([a]) => only.includes(a))) {
  const page = await browser.newPage({ storageState, viewport: { width: 320, height: 640 } });
  await page.goto(`${base}/${app}/`); await page.waitForLoadState('networkidle');
  if (!new URL(page.url()).pathname.startsWith(`/${app}/`) || !(await page.isVisible(opener))) { report.push({ app, dialog: 'pominięte: brak sesji lub przycisku (tryb 2 z kontem skarbnika)' }); await page.close(); continue; }
  await page.focus(opener); await page.keyboard.press('Enter');
  const inDialog = await page.evaluate(() => document.activeElement.closest('dialog')?.id + ':' + document.activeElement.name);
  const dlgOverflow = await page.evaluate(() => { const d = document.querySelector('dialog[open]'); return d.scrollWidth - d.clientWidth; });
  await page.keyboard.press('Escape');
  const back = await page.evaluate(() => document.activeElement.id);
  report.push({ app, dialog: { inDialog, dlgOverflow, focusAfterEsc: back } });
}
await browser.close(); server?.close();
console.log(JSON.stringify(report));
