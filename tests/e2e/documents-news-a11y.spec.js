// E2E dostępności panelu dokumentów i ekranu aktualności/galerii (issue #124).
// Sesja członka zarządu z MFA i przydziałem na rok e2e; dokumenty i wpisy są
// syntetyczne (support/server.js), pliki dokumentów nie istnieją w magazynie —
// test dotyczy wyłącznie listy, szczegółów i fokusu (WCAG 2.1.1, 2.4.3, 2.4.7,
// 1.4.10, 2.5.8). Nie zastępuje testu z czytnikiem ekranu.
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

async function boardPage(browser, viewport) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{
    name: 'rd_session',
    value: runtime.boardDocs.cookie,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  return { context, page: await context.newPage() };
}

async function pageOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test('documents/: „Szczegóły” — Enter otwiera, Esc i „Zamknij” oddają fokus temu samemu przyciskowi', async ({ browser }) => {
  const { context, page } = await boardPage(browser, { width: 1280, height: 900 });
  await page.goto('/documents/');
  const rows = page.locator('#documents-body tr');
  await expect(rows).toHaveCount(runtime.documents.length, { timeout: 10_000 });

  const second = page.locator(`#documents-body button[data-id="${runtime.documents[1].id}"]`);
  await expect(second).toHaveAccessibleName(new RegExp(`^Szczegóły dokumentu: ${runtime.documents[1].title.replace(/[()]/g, '\\$&')}, dodano `));
  await second.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#details')).toBeVisible();
  await expect(page.locator('#details')).toBeFocused();
  await expect(page.locator('#details-list')).toContainText(runtime.documents[1].title);
  await page.keyboard.press('Escape');
  await expect(page.locator('#details')).toBeHidden();
  await expect(second).toBeFocused();

  // Ten sam powrót przez przycisk „Zamknij” obsłużony klawiaturą.
  await page.keyboard.press('Enter');
  await expect(page.locator('#details')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#close-details')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(second).toBeFocused();

  // Po przerysowaniu listy (odświeżenie) fokus trafia do „Szczegóły” tego samego dokumentu.
  await second.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#details')).toBeFocused();
  await page.locator('#filters-form button[type="submit"]').evaluate((button) => button.click());
  await expect(rows).toHaveCount(runtime.documents.length);
  await page.locator('#details').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator(`#documents-body button[data-id="${runtime.documents[1].id}"]`)).toBeFocused();
  await context.close();
});

for (const width of [320, 390]) {
  test(`documents/ przy ${width} px: lista bez poziomego przewijania, cele akcji ≥ 24 px`, async ({ browser }) => {
    const { context, page } = await boardPage(browser, { width, height: 800 });
    await page.goto('/documents/');
    await expect(page.locator('#documents-body tr')).toHaveCount(runtime.documents.length, { timeout: 10_000 });
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    const targets = await page.locator('#documents-body .row-actions button, #documents-body .row-actions a').evaluateAll((nodes) => nodes
      .map((node) => { const box = node.getBoundingClientRect(); return { text: node.textContent, width: box.width, height: box.height, right: box.right }; }));
    expect(targets.length).toBe(runtime.documents.length * 2);
    for (const target of targets) {
      expect(target.height, `${target.text}: wysokość celu`).toBeGreaterThanOrEqual(24);
      expect(target.width, `${target.text}: szerokość celu`).toBeGreaterThanOrEqual(24);
      expect(target.right, `${target.text}: poza ekranem`).toBeLessThanOrEqual(width);
    }
    await context.close();
  });
}

test('news/ przy 390 px: wiersze bez poziomego przewijania, „Otwórz” z nazwą wpisu przenosi fokus do szczegółów', async ({ browser }) => {
  const { context, page } = await boardPage(browser, { width: 390, height: 800 });
  await page.goto('/news/');
  const rows = page.locator('#posts-body tr');
  await expect(rows).toHaveCount(runtime.newsTitles.length + 1, { timeout: 10_000 }); // + szkic (panel wewnętrzny)
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0);

  const open = page.getByRole('button', { name: `Otwórz wpis: ${runtime.newsLongWord}` });
  await expect(open).toHaveCount(1);
  const box = await open.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.height).toBeGreaterThanOrEqual(24);

  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#detail')).toBeFocused();
  await expect(page.locator('#detail-title')).toHaveText(runtime.newsLongWord);
  expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  await context.close();
});
