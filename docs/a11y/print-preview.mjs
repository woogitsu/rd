// Podgląd wydruku paneli (#151): meetings/ (protokół z listą obecności), ledger/
// (zestawienie księgi), panel/ (lista wpłat) i families/ (lista klasy) w Chromium
// z emulacją mediów „print”. Dane wyłącznie syntetyczne — serwer testowy E2E
// (tests/e2e/support/server.js: PGlite w pamięci, 300 wpłat i 300 wpisów księgi
// w roku e2e-y-print, zebranie zarządu z projektem protokołu).
//
//   npm run build
//   E2E_PORT=4391 node tests/e2e/support/server.js &      # zapisuje .runtime.json z sesjami
//   CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//     node docs/a11y/print-preview.mjs "$PWD/docs/a11y" [--pdf]
//
// Wynik: print-preview-<panel>.png — pierwsza strona A4 pionowo (obszar treści przy
// marginesie 15 mm, 680 × 1009 px CSS). Zrzut nie pokazuje pól marginesu @page
// (nagłówek strony, „Strona N z M”); pokazuje je dopiero PDF (--pdf → print-preview-<panel>.pdf,
// pliki PDF nie trafiają do repozytorium). window.print jest podmieniane — skrypt nie
// otwiera okna drukowania.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
const withPdf = process.argv.includes('--pdf');
const runtime = JSON.parse(readFileSync(new URL('../../tests/e2e/support/.runtime.json', import.meta.url), 'utf8'));
const base = runtime.baseUrl;
const A4_CONTENT = { width: 680, height: 1009 };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'] });

async function open(cookie) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pl-PL', timezoneId: 'Europe/Brussels' });
  await context.addCookies([{ name: 'rd_session', value: cookie, domain: new URL(base).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  await page.addInitScript(() => { window.__printCalls = 0; window.print = () => { window.__printCalls += 1; }; });
  return { context, page };
}

const views = [
  { name: 'meetings', cookie: runtime.boardDocs.cookie, async prepare(page) {
    await page.goto(`${base}/meetings/?zebranie=${encodeURIComponent(runtime.printMeeting.id)}`);
    await page.locator('#minutes-body button[data-action=view]').first().click();
    await page.locator('#print-minutes-button').click();
  } },
  { name: 'ledger', cookie: runtime.treasurerPrint.cookie, async prepare(page) {
    await page.goto(`${base}/ledger/`);
    await page.locator('#entries-body tr').first().waitFor();
    await page.locator('#print-ledger').click();
  } },
  { name: 'panel', cookie: runtime.treasurerPrint.cookie, async prepare(page) {
    await page.goto(`${base}/panel/`);
    await page.locator('#payments-body tr').first().waitFor();
    await page.locator('#print-payments').click();
  } },
  { name: 'families', cookie: runtime.representative.cookie, async prepare(page) {
    await page.goto(`${base}/families/`);
    await page.locator('#years a').first().click();
    await page.locator('#class-view:not([hidden]) table a').first().waitFor();
    await page.locator('#print-class').click();
  } },
];

const report = [];
for (const view of views) {
  const { context, page } = await open(view.cookie);
  await view.prepare(page);
  await page.waitForFunction(() => window.__printCalls > 0, null, { timeout: 60_000 });
  await page.emulateMedia({ media: 'print' });
  if (withPdf) await page.pdf({ path: join(OUT, `print-preview-${view.name}.pdf`), format: 'A4', preferCSSPageSize: true });
  await page.setViewportSize(A4_CONTENT);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(OUT, `print-preview-${view.name}.png`) });
  report.push({ view: view.name, rows: await page.locator('main tbody tr').count(), overflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) });
  await context.close();
}
await browser.close();
console.log(JSON.stringify(report));
