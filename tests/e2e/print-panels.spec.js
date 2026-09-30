// E2E (#151): wydruk z paneli ledger/, panel/, meetings/ i families/ w Chromium
// (emulacja mediów „print”). Dane syntetyczne z tests/e2e/support/server.js:
// osobny rok e2e-y-print z 300 wpłatami (co 50. z korektą częściową) i 300
// wpisami księgi, zebranie zarządu z projektem protokołu i listą obecności.
// window.print jest podmieniane na licznik — test nie otwiera okna drukowania.
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();
// Obszar treści A4 pionowo przy marginesie 15 mm (shared/print.css): 210 mm − 30 mm ≈ 680 px CSS.
const A4_CONTENT = { width: 680, height: 1009 };

async function sessionPage(browser, cookie) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pl-PL', timezoneId: 'Europe/Brussels' });
  await context.addCookies([{ name: 'rd_session', value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  await page.addInitScript(() => { window.__printCalls = 0; window.print = () => { window.__printCalls += 1; }; });
  return { context, page };
}

// Na wydruku nie ma nawigacji, przycisków, filtrów ani okien, a tabela mieści się w szerokości A4.
async function expectCleanPrint(page) {
  await page.setViewportSize(A4_CONTENT);
  await page.emulateMedia({ media: 'print' });
  const result = await page.evaluate(() => {
    const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    const doc = document.documentElement;
    return {
      visibleControls: [...document.querySelectorAll('nav, button, dialog, .row-actions, .filters, form input, form select')].filter(visible).map((el) => el.tagName + (el.id ? `#${el.id}` : '')),
      overflow: doc.scrollWidth - doc.clientWidth,
      tooWide: [...document.querySelectorAll('table')].filter(visible).filter((table) => table.getBoundingClientRect().right > doc.clientWidth + 1).length,
      theadRepeats: [...document.querySelectorAll('thead')].filter(visible).every((thead) => getComputedStyle(thead).display === 'table-header-group'),
      rowsUnbroken: [...document.querySelectorAll('tbody tr')].slice(0, 5).every((tr) => getComputedStyle(tr).breakInside === 'avoid'),
    };
  });
  expect(result.visibleControls).toEqual([]);
  expect(result.overflow).toBeLessThanOrEqual(0);
  expect(result.tooWide).toBe(0);
  expect(result.theadRepeats).toBe(true);
  expect(result.rowsUnbroken).toBe(true);
}

for (const panel of [
  { app: 'panel', button: '#print-payments', body: '#payments-body', view: 'Dobrowolne wpłaty' },
  { app: 'ledger', button: '#print-ledger', body: '#entries-body', view: 'Księga przychodów i wydatków' },
]) {
  test(`${panel.app}/: „Drukuj zestawienie” pobiera wszystkie ${runtime.treasurerPrint.rows} wpisów raz, mimo podwójnego kliknięcia`, async ({ browser }) => {
    const { context, page } = await sessionPage(browser, runtime.treasurerPrint.cookie);
    const listRequests = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === (panel.app === 'panel' ? '/api/payments' : '/api/ledger')) listRequests.push(url.searchParams.get('cursor'));
    });
    await page.goto(`/${panel.app}/`);
    await expect(page.locator(`${panel.body} tr`)).toHaveCount(50);
    // Przed pobraniem całości wydruk jawnie mówi, że jest niepełny.
    await expect(page.locator('#print-meta')).toContainText('Wydruk niepełny — pokazano 50 wpisów.');

    await page.locator(panel.button).dblclick();
    await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
    await expect(page.locator(`${panel.body} tr`)).toHaveCount(runtime.treasurerPrint.rows);
    const texts = await page.locator(`${panel.body} tr td:nth-child(2)`).allTextContents();
    expect(new Set(texts).size).toBe(runtime.treasurerPrint.rows);
    // Każda strona listy pobrana dokładnie raz (bez duplikatów kursora przy podwójnym kliknięciu).
    const cursors = listRequests.filter(Boolean);
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(await page.evaluate(() => window.__printCalls)).toBe(1);

    const meta = page.locator('#print-meta');
    await expect(meta).not.toContainText('Wydruk niepełny');
    await expect(meta).toContainText(panel.view);
    await expect(meta).toContainText(/Wydrukowano: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} przez e2e-treasurer-print/);
    // Daty w tabeli w zapisie polskim dd.mm.rrrr (ekran i wydruk to ten sam DOM).
    await expect(page.locator(`${panel.body} tr`).first().locator('td').first()).toHaveText(/^\d{2}\.\d{2}\.\d{4}$/);

    if (panel.app === 'panel') {
      // Wpłata częściowo skorygowana: kolumny „Wpłata”, „Korekty”, „Netto” na wydruku jak na ekranie.
      const corrected = page.locator(`${panel.body} tr`, { hasText: 'Wpłata syntetyczna 001' });
      const screenCells = await corrected.locator('td.amount').allTextContents();
      expect(screenCells.map((text) => text.replace(/\s/g, ' '))).toEqual(['1 234,57 €', '10,00 €', '1 224,57 €']);
      const screenTexts = await corrected.locator('td.amount').allInnerTexts();
      await page.emulateMedia({ media: 'print' });
      await expect(corrected.locator('td.amount').nth(1)).toBeVisible();
      expect(await corrected.locator('td.amount').allInnerTexts()).toEqual(screenTexts);
      await page.emulateMedia({ media: 'screen' });
    } else {
      // Bilans otwarcia/zamknięcia w nagłówku każdej strony (pole marginesu @page).
      const runningCss = await page.evaluate(() => document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join('\n'));
      expect(runningCss).toContain('Bilans otwarcia');
      expect(runningCss).toContain('Bilans zamknięcia');
    }

    await expectCleanPrint(page);
    await expect(meta).toBeVisible();
    await context.close();
  });
}

test('meetings/: protokół do druku z listą obecności, kolumną podpisu i znakiem PROJEKT', async ({ browser }) => {
  const { context, page } = await sessionPage(browser, runtime.boardDocs.cookie);
  await page.goto(`/meetings/?zebranie=${encodeURIComponent(runtime.printMeeting.id)}`);
  await page.locator('#minutes-body button[data-action=view]').first().click();
  await page.locator('#print-minutes-button').click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
  await expect(page.locator('body')).toHaveAttribute('data-print-target', 'minutes');

  await expectCleanPrint(page);
  const section = page.locator('#print-minutes');
  await expect(section).toBeVisible();
  await expect(page.locator('#detail')).toBeHidden();
  await expect(section).toContainText('PROJEKT — dokument niezatwierdzony');
  await expect(section).toContainText(runtime.printMeeting.title);
  await expect(page.locator('#print-minutes-info')).toContainText(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
  await expect(page.locator('#print-attendance-body tr')).toHaveCount(2);
  await expect(page.locator('#print-attendance-body td.signature')).toHaveCount(2);
  await expect(page.locator('#print-attendance-body td.name-blank').first()).toHaveText('');
  await expect(page.locator('#print-quorum-result')).toContainText('Quorum osiągnięte');
  await expect(page.locator('#print-signatures')).toBeVisible();
  // Długa linia protokołu zawija się w obrębie A4.
  const bodyBox = await page.locator('#print-minutes-body').boundingBox();
  expect(bodyBox.width).toBeLessThanOrEqual(A4_CONTENT.width);
  await context.close();
});

test('families/: przedstawiciel 1A drukuje wyłącznie swoją klasę, ze znacznikiem poufności', async ({ browser }) => {
  const { context, page } = await sessionPage(browser, runtime.representative.cookie);
  await page.goto('/families/');
  await page.locator('#years a').first().click();
  await expect(page.locator('#class-view')).toBeVisible();
  await page.locator('#print-class').click();
  await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);

  await expectCleanPrint(page);
  const meta = page.locator('#print-meta');
  await expect(meta).toBeVisible();
  await expect(meta).toContainText('Lista klasy 1A');
  await expect(meta).toContainText('Dane poufne Rady Rodziców');
  await expect(meta).toContainText('przez e2e-rep');
  await expect(page.locator('body')).not.toContainText('2B');
  await expect(page.locator('body')).not.toContainText('opiekun-2b@example.invalid');
  // Lista klasy na wydruku bez adresów e-mail opiekunów.
  await expect(page.locator('#class-view')).not.toContainText('@example.invalid');
  await context.close();
});
