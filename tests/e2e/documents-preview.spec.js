// E2E (#89 część 2): podgląd PDF w panelu documents/ z magazynu (dane syntetyczne,
// support/server.js, rok e2e-y-docs89). Ramka podglądu zostaje z sandbox="" (decyzja
// bezpieczeństwa #89/#466); Chromium nie wyświetla w niej PDF, więc pokaz idzie przez
// „Otwórz podgląd w nowej karcie” (#539). Sprawdza: nagłówki odpowiedzi podglądu,
// PDF w nowej karcie, plik niezgodny z bieżącą kontrolą struktury = 409
// document_preview_blocked bez treści, link w PDF nie zmienia karty panelu.
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

async function openDocuments(page) {
  await page.goto('/documents/');
  await expect(page.locator('#documents-body tr')).toHaveCount(runtime.boardDocs89.documents.length, { timeout: 10_000 });
}

async function openPreview(page, doc) {
  await page.locator(`#documents-body button[data-id="${doc.id}"]`).click();
  await expect(page.locator('#details-list')).toContainText(doc.title);
  await expect(page.locator('#details-preview')).toBeVisible();
  const response = page.waitForResponse((r) => r.url().includes(`/api/documents/${doc.id}/content?disposition=inline`));
  await page.locator('#details-preview').click();
  return response;
}

// Nowa karta z linku pod ramką; zwraca kartę i odpowiedź jej dokumentu.
async function openInNewTab(context, page) {
  const link = page.locator('#preview-open-tab');
  await expect(link).toBeVisible();
  const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await popup.waitForURL((url) => url.pathname.endsWith('/content'));
  return { popup };
}

test('documents/: ramka PDF z sandbox="", odpowiedź z CSP sandbox + nosniff; PDF czytelny w nowej karcie', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.boardDocs89.cookie);
  await openDocuments(page);
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
  expect(await frame.getAttribute('sandbox')).toBe('');
  const href = await page.locator('#preview-open-tab').getAttribute('href');
  expect(href).toBe(`/api/documents/${clean.id}/content?disposition=inline`);

  const { popup } = await openInNewTab(context, page);
  expect(new URL(popup.url()).pathname).toBe(`/api/documents/${clean.id}/content`);
  // Czytnik PDF Chromium osadza się jako ramka potomna; zamiast niego byłaby strona błędu.
  await expect.poll(() => popup.frames().some((f) => f.url().startsWith('chrome-error://'))).toBe(false);
  await expect.poll(() => popup.evaluate(() => document.contentType)).toBe('application/pdf');
  await context.close();
});

test('documents/: plik niezgodny z bieżącą kontrolą struktury — 409 document_preview_blocked bez treści', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.boardDocs89.cookie);
  await openDocuments(page);
  const response = await openPreview(page, legacy);
  expect(response.status()).toBe(409);
  expect((await response.allHeaders())['content-disposition']).toBeUndefined();
  const { popup } = await openInNewTab(context, page);
  await expect(popup.locator('body')).toContainText('document_preview_blocked');
  await context.close();
});

test('documents/: link w PDF otwartym w nowej karcie zmienia tylko tę kartę, panel zostaje', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.boardDocs89.cookie);
  await openDocuments(page);
  expect((await openPreview(page, withLink)).status()).toBe(200);
  const panelUrl = page.url();
  const { popup } = await openInNewTab(context, page);
  // Czas na inicjalizację czytnika PDF (proces rozszerzenia) przed kliknięciem linku.
  await popup.waitForTimeout(2500);
  const viewport = popup.viewportSize();
  await popup.mouse.click(viewport.width * 0.6, viewport.height * 0.5);
  await popup.waitForURL((url) => url.pathname.startsWith('/site/'));
  expect(page.url()).toBe(panelUrl);
  await expect(page.locator('#details-preview')).toBeVisible();
  await context.close();
});
