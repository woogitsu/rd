// E2E (#89 część 2): podgląd PDF w panelu documents/ z magazynu (dane syntetyczne,
// support/server.js, rok e2e-y-docs89). Sprawdza w Chromium: ramka bez atrybutu
// sandbox wyświetla PDF we wbudowanym czytniku (wcześniej blokowane — #539),
// odpowiedź podglądu ma CSP sandbox + nosniff, plik niezgodny z bieżącą kontrolą
// struktury daje komunikat (409 document_preview_blocked) zamiast treści, a link
// w PDF nie podmienia panelu bez potwierdzenia (beforeunload).
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();
const [clean, withLink, legacy] = runtime.boardDocs89.documents;

async function pageAs(browser, cookie) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{
    name: 'rd_session', value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
  }]);
  return { context, page: await context.newPage() };
}

async function openPreview(page, doc) {
  await page.locator(`#documents-body button[data-id="${doc.id}"]`).click();
  await expect(page.locator('#details-list')).toContainText(doc.title);
  await expect(page.locator('#details-preview')).toBeVisible();
  const response = page.waitForResponse((r) => r.url().includes(`/api/documents/${doc.id}/content?disposition=inline`));
  await page.locator('#details-preview').click();
  return response;
}

test('documents/: PDF otwiera się w ramce bez atrybutu sandbox; odpowiedź z CSP sandbox, nosniff i inline', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.boardDocs89.cookie);
  await page.goto('/documents/');
  await expect(page.locator('#documents-body tr')).toHaveCount(runtime.boardDocs89.documents.length, { timeout: 10_000 });
  const response = await openPreview(page, clean);
  expect(response.status()).toBe(200);
  // allHeaders(): headers() pomija nagłówki bezpieczeństwa (dokumentacja Playwright).
  const headers = await response.allHeaders();
  expect(headers['content-type']).toBe('application/pdf');
  expect(headers['content-disposition']).toMatch(/^inline;/);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
  const frame = page.locator('#preview-frame');
  await expect(frame).toBeVisible();
  expect(await frame.getAttribute('sandbox')).toBeNull();
  // Czytnik PDF Chromium osadza się jako ramka potomna dokumentu podglądu; przy
  // atrybucie sandbox zamiast niej była strona błędu chrome-error://.
  await expect.poll(() => page.frames().some((f) => f.url().startsWith('chrome-error://'))).toBe(false);
  await expect.poll(() => page.frames().filter((f) => f.url().includes(`/api/documents/${clean.id}/content`)).length).toBeGreaterThan(0);
  await expect(page.locator('#preview-message')).toHaveText('');
  await expect(page.locator('#preview-open-tab')).toBeVisible();
  await context.close();
});

test('documents/: plik niezgodny z bieżącą kontrolą struktury — komunikat zamiast podglądu (409)', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.boardDocs89.cookie);
  await page.goto('/documents/');
  await expect(page.locator('#documents-body tr')).toHaveCount(runtime.boardDocs89.documents.length, { timeout: 10_000 });
  const response = await openPreview(page, legacy);
  expect(response.status()).toBe(409);
  await expect(page.locator('#preview-message')).toContainText('nie przechodzi bieżącej kontroli struktury');
  await context.close();
});

test('documents/: link w PDF nie podmienia panelu bez potwierdzenia; własny link panelu działa bez pytania', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.boardDocs89.cookie);
  const dialogs = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.type()); dialog.dismiss().catch(() => {}); });
  await page.goto('/documents/');
  await expect(page.locator('#documents-body tr')).toHaveCount(runtime.boardDocs89.documents.length, { timeout: 10_000 });
  expect((await openPreview(page, withLink)).status()).toBe(200);
  const frame = page.locator('#preview-frame');
  await frame.scrollIntoViewIfNeeded();
  // Czas na inicjalizację czytnika PDF (proces rozszerzenia) przed kliknięciem linku.
  await page.waitForTimeout(2500);
  const box = await frame.boundingBox();
  const before = page.url();
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.5);
  await expect.poll(() => dialogs).toContain('beforeunload');
  expect(page.url()).toBe(before);
  // Link z nagłówka panelu to zamierzone wyjście — bez okna potwierdzenia.
  dialogs.length = 0;
  await page.locator('header a[href]').first().click();
  await page.waitForURL((url) => url.href !== before);
  expect(dialogs).toEqual([]);
  await context.close();
});
