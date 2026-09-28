// E2E: skarbnik zapisuje dobrowolną wpłatę w panel/ i widzi ją na liście
// (bez przypisania do rodziny — trafia do „Do przypisania”, zgodnie z AGENTS.md:
// żadnego automatycznego statusu „dłużnik”, składki są dobrowolne).
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

test('skarbnik zapisuje wpłatę w panel/ i widzi ją na liście', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([{
    name: 'rd_session',
    value: runtime.treasurer.cookie,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  await page.goto('/panel/');

  // Poczekaj, aż filtr roku wczyta się automatycznie i lista przestanie ładować.
  await expect(page.locator('#school-year-id')).not.toHaveValue('');
  await expect(page.locator('#loading')).toBeHidden();

  const reference = `e2e-wplata-${Date.now()}`;
  await page.locator('#open-payment').click();
  await expect(page.locator('#payment-dialog')).toBeVisible();

  await page.locator('#payment-form input[name=amount]').fill('75,00');
  // receivedOn jest ustawiane automatycznie na dziś przez main.js.
  await page.locator('#payment-form input[name=reference]').fill(reference);

  await page.locator('#payment-form button[value=submit]').click();

  // Okno potwierdzenia skutków trwałej operacji (issue #136).
  const confirmDialog = page.locator('#shared-confirm-dialog');
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.locator('[data-role=confirm]').click();

  await expect(page.locator('#payment-dialog')).toBeHidden();
  await expect(page.locator('#message')).toContainText('Zapisano wpłatę');

  const row = page.locator('#payments-body tr', { hasText: reference });
  await expect(row).toBeVisible();
  await expect(row).toContainText('75,00');

  // Kontrola po stronie API: wpłata jest naprawdę w bazie, nie tylko w DOM.
  const list = await page.request.get(`/api/payments?schoolYearId=${encodeURIComponent(runtime.schoolYearId)}`, {
    headers: { Cookie: `rd_session=${runtime.treasurer.cookie}` },
  });
  expect(list.status()).toBe(200);
  const body = await list.json();
  expect(body.payments.some((payment) => payment.reference === reference)).toBe(true);

  await context.close();
});
