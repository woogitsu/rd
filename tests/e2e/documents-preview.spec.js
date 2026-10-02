// E2E (#89, PDF.js): podgląd PDF w panelu documents/ z magazynu (dane syntetyczne,
// support/server.js, rok e2e-y-docs89). PDF jest rysowany biblioteką PDF.js dołączoną do
// panelu (worker z własnego originu, bez CDN) do <canvas>, bez <iframe>. Bajty idą z
// `?purpose=preview` (załącznik, document.viewed); `disposition=inline` dla PDF to 400
// pdf_inline_not_allowed. Sprawdza: render strony, stronicowanie Poprzednia/Następna
// z „Strona N z M”, brak naruszeń CSP, link w PDF nie działa (brak warstwy adnotacji),
// plik niezgodny z bieżącą kontrolą struktury = 409 document_preview_blocked bez treści.
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();
const [clean, withLink, legacy, twoPages] = runtime.boardDocs89.documents;

async function pageAs(browser, cookie) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{
    name: 'rd_session', value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  const violations = [];
  page.on('console', (message) => {
    if (/content security policy|refused to|Warning:/i.test(message.text())) violations.push(message.text());
  });
  page.on('pageerror', (error) => violations.push(`pageerror: ${error.message}`));
  return { context, page, violations };
}

async function openDocuments(page) {
  await page.goto('/documents/');
  await expect(page.locator('#documents-body tr')).toHaveCount(runtime.boardDocs89.documents.length, { timeout: 10_000 });
}

async function openPreview(page, doc) {
  await page.locator(`#documents-body button[data-id="${doc.id}"]`).click();
  await expect(page.locator('#details-list')).toContainText(doc.title);
  await expect(page.locator('#details-preview')).toBeVisible();
  const response = page.waitForResponse((r) => r.url().includes(`/api/documents/${doc.id}/content?`));
  await page.locator('#details-preview').click();
  return response;
}

// Czy płótno ma jakąkolwiek niebiałą treść (strona faktycznie narysowana).
const hasInk = (page) => page.locator('#preview-pdf canvas').evaluate((canvas) => {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) return true;
  return false;
});

test('documents/: PDF rysowany przez PDF.js na canvas (bez iframe), bajty z purpose=preview jako załącznik z nagłówkami bezpieczeństwa', async ({ browser }) => {
  const { context, page, violations } = await pageAs(browser, runtime.boardDocs89.cookie);
  await openDocuments(page);
  const response = await openPreview(page, clean);
  expect(response.url()).toContain('purpose=preview');
  expect(response.status()).toBe(200);
  // allHeaders(): headers() pomija nagłówki bezpieczeństwa (dokumentacja Playwright).
  const headers = await response.allHeaders();
  expect(headers['content-type']).toBe('application/pdf');
  expect(headers['content-disposition']).toMatch(/^attachment;/);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
  const canvas = page.locator('#preview-pdf canvas');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await expect(canvas).toHaveAttribute('data-rendered-page', '1', { timeout: 15_000 });
  expect(await hasInk(page)).toBe(true);
  await expect(canvas).toHaveAttribute('aria-label', 'Strona 1 z 1');
  await expect(page.locator('#preview-pdf .pdf-status')).toHaveText('Strona 1 z 1');
  await expect(page.getByRole('button', { name: 'Poprzednia strona' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Następna strona' })).toBeDisabled();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.locator('#preview-message')).toHaveText('');
  expect(violations).toEqual([]);
  await context.close();
});

test('documents/: stronicowanie Poprzednia/Następna, „Strona N z M” jako tekst alternatywny', async ({ browser }) => {
  const { context, page, violations } = await pageAs(browser, runtime.boardDocs89.cookie);
  await openDocuments(page);
  await openPreview(page, twoPages);
  const canvas = page.locator('#preview-pdf canvas');
  await expect(canvas).toHaveAttribute('data-rendered-page', '1', { timeout: 15_000 });
  await expect(canvas).toHaveAttribute('aria-label', 'Strona 1 z 2');
  const previous = page.getByRole('button', { name: 'Poprzednia strona' });
  const next = page.getByRole('button', { name: 'Następna strona' });
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  const firstPage = await canvas.evaluate((el) => el.toDataURL());
  await next.click();
  await expect(canvas).toHaveAttribute('data-rendered-page', '2', { timeout: 15_000 });
  await expect(canvas).toHaveAttribute('aria-label', 'Strona 2 z 2');
  await expect(page.locator('#preview-pdf .pdf-status')).toHaveText('Strona 2 z 2');
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
  expect(await canvas.evaluate((el) => el.toDataURL())).not.toBe(firstPage);
  await previous.click();
  await expect(canvas).toHaveAttribute('data-rendered-page', '1', { timeout: 15_000 });
  await expect(canvas).toHaveAttribute('aria-label', 'Strona 1 z 2');
  expect(violations).toEqual([]);
  await context.close();
});

test('documents/: disposition=inline dla PDF to 400 pdf_inline_not_allowed (sesja panelu, bez treści)', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.boardDocs89.cookie);
  await openDocuments(page);
  // fetch z kontekstu strony: ciasteczko sesji jest `secure`, a localhost jest „bezpieczny” tylko w przeglądarce.
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'same-origin' });
    return { status: response.status, body: await response.json(), disposition: response.headers.get('content-disposition') };
  }, `/api/documents/${clean.id}/content?disposition=inline`);
  expect(result.status).toBe(400);
  expect(result.body).toEqual({ error: 'pdf_inline_not_allowed' });
  expect(result.disposition).toBeNull();
  await context.close();
});

test('documents/: plik niezgodny z bieżącą kontrolą struktury — 409 document_preview_blocked, komunikat i brak canvas', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.boardDocs89.cookie);
  await openDocuments(page);
  const response = await openPreview(page, legacy);
  expect(response.status()).toBe(409);
  expect((await response.allHeaders())['content-disposition']).toBeUndefined();
  await expect(page.locator('#preview-message')).toContainText('nie przechodzi bieżącej kontroli struktury');
  await expect(page.locator('#preview-pdf canvas')).toHaveCount(0);
  await context.close();
});

test('documents/: link w PDF nie działa w podglądzie (brak warstwy adnotacji) — panel zostaje na swoim adresie', async ({ browser }) => {
  const { context, page, violations } = await pageAs(browser, runtime.boardDocs89.cookie);
  await openDocuments(page);
  expect((await openPreview(page, withLink)).status()).toBe(200);
  const canvas = page.locator('#preview-pdf canvas');
  await expect(canvas).toHaveAttribute('data-rendered-page', '1', { timeout: 15_000 });
  const panelUrl = page.url();
  const popups = [];
  context.on('page', (popup) => popups.push(popup));
  await canvas.click({ position: { x: 50, y: 50 } });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(panelUrl);
  expect(popups).toHaveLength(0);
  await expect(page.locator('#preview-pdf a')).toHaveCount(0);
  await expect(page.locator('#details-preview')).toBeVisible();
  expect(violations).toEqual([]);
  await context.close();
});
