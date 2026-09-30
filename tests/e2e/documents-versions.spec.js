// E2E (#82): wersje dokumentu i unieważnienie bez usuwania w documents/.
// Członek zarządu wyłącznie w osobnym roku e2e-y-docs82 (support/server.js), trzy
// syntetyczne dokumenty zarządu (tylko metadane — zmiana stanu nie czyta treści).
// Sprawdza: okno potwierdzenia ze skutkami („plik zostaje w archiwum”), podwójne
// kliknięcie „Unieważnij dokument” = jedno żądanie, dokument znika z domyślnej listy
// i wraca po zaznaczeniu „Pokaż też zastąpione i unieważnione”, historię wersji,
// pole wyboru ≥ 24 px oraz odmowę 404 dla przedstawiciela klasy (granica ról).
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();
const docs = runtime.boardDocs82.documents;
const [v1, v2, mistaken] = docs;

async function pageAs(browser, cookie, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{
    name: 'rd_session', value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
  }]);
  return { context, page: await context.newPage() };
}

function countPosts(page, pattern) {
  const requests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && pattern.test(new URL(request.url()).pathname)) requests.push(request);
  });
  return requests;
}

const confirmDialog = (page) => page.locator('#shared-confirm-dialog');

async function metadata(page, id) {
  const response = await page.request.get(`/api/documents/${id}`, {
    headers: { Cookie: `rd_session=${runtime.boardDocs82.cookie}` },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

async function openDetails(page, doc) {
  await page.locator(`#documents-body button[data-id="${doc.id}"]`).click();
  await expect(page.locator('#details')).toBeVisible();
  await expect(page.locator('#details-list')).toContainText(doc.title);
  await expect(page.locator('#status-actions')).toBeVisible();
}

test('documents/: zastąpienie i unieważnienie z oknem skutków; plik zostaje w archiwum, historia wersji widoczna', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.boardDocs82.cookie);
  const posts = countPosts(page, /^\/api\/documents\/[^/]+\/(supersede|void)$/);
  await page.goto('/documents/');
  const rows = page.locator('#documents-body tr');
  await expect(rows).toHaveCount(docs.length, { timeout: 10_000 });

  // Pole „Pokaż też zastąpione i unieważnione”: cel co najmniej 24 × 24 px (uwaga z #569).
  const checkbox = page.locator('#filter-inactive');
  const box = await checkbox.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);

  // 1) Zastąpienie wersji 1 wersją 2. „Anuluj” w oknie nic nie wysyła.
  await openDetails(page, v1);
  await page.locator('#status-supersede').click();
  await page.locator('#status-replacement').selectOption(v2.id);
  await page.locator('#status-reason').fill('Nowa wersja regulaminu po zebraniu');
  await page.locator('#status-submit').click();
  await expect(confirmDialog(page)).toBeVisible();
  await expect(confirmDialog(page).locator('#shared-confirm-title')).toHaveText('Zastąpić dokument?');
  const body = confirmDialog(page).locator('#shared-confirm-body');
  await expect(body).toContainText(v2.title);
  await expect(body).toContainText('zostają w archiwum');
  await expect(body).toContainText('nadal mogą otworzyć plik');
  await confirmDialog(page).locator('[data-role=cancel]').click();
  await expect(confirmDialog(page)).toBeHidden();
  expect(posts).toHaveLength(0);

  await page.locator('#status-submit').click();
  await confirmDialog(page).locator('[data-role=confirm]').click();
  await expect(page.locator('#status-message')).toHaveText('Dokument zastąpiony. Plik zostaje w archiwum.');
  expect(posts).toHaveLength(1);
  await expect(page.locator('#version-history')).toContainText(v2.title);
  expect((await metadata(page, v1.id)).document.status).toBe('superseded');
  await page.keyboard.press('Escape');

  // 2) Unieważnienie pliku wgranego omyłkowo: podwójne kliknięcie = jedno żądanie.
  await expect(rows).toHaveCount(docs.length - 1);
  await openDetails(page, mistaken);
  await page.locator('#status-void').click();
  await page.locator('#status-reason').fill('Plik wgrany omyłkowo do zlej kategorii');
  await page.locator('#status-submit').click();
  await expect(confirmDialog(page).locator('#shared-confirm-title')).toHaveText('Unieważnić dokument?');
  await confirmDialog(page).locator('[data-role=confirm]').dblclick();
  await expect(page.locator('#status-message')).toHaveText('Dokument unieważniony. Plik zostaje w archiwum.');
  expect(posts).toHaveLength(2);
  expect((await metadata(page, mistaken.id)).document.status).toBe('voided');
  await page.keyboard.press('Escape');

  // 3) Domyślna lista: tylko aktualny dokument; pole wyboru pokazuje całe archiwum.
  await page.locator('#filters-form button[type="submit"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(v2.title);
  await checkbox.check();
  await page.locator('#filters-form button[type="submit"]').click();
  await expect(rows).toHaveCount(docs.length);
  await expect(page.locator('#documents-body tr', { hasText: v1.title })).toContainText('Zastąpiony');
  await expect(page.locator('#documents-body tr', { hasText: mistaken.title })).toContainText('Unieważniony');
  await context.close();
});

test('documents/: przedstawiciel klasy nie zmieni stanu dokumentu zarządu (404, jak dla nieistniejącego)', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.representative.cookie);
  await page.goto('/documents/');
  const response = await page.request.post(`/api/documents/${v2.id}/void`, {
    headers: {
      Cookie: `rd_session=${runtime.representative.cookie}`,
      Origin: runtime.baseUrl,
      'Content-Type': 'application/json',
      'Idempotency-Key': `e2e-rep-void-${Date.now()}`,
    },
    data: { reason: 'Próba spoza przydziału' },
  });
  expect(response.status()).toBe(404);
  expect((await response.json()).error).toBe('not_found');
  const meta = await metadata(page, v2.id);
  expect(meta.document.status ?? 'active').not.toBe('voided');
  await context.close();
});
