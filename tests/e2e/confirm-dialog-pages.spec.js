// E2E (#136): wspólne okno potwierdzenia na prawdziwych stronach paneli —
// panel/ („Zapisz wpłatę”) i events/ („Opublikuj”). Sprawdza: anulowanie bez
// żądania do API i bez utraty danych formularza, powrót fokusu, podwójne
// kliknięcie = jedno żądanie, ponowienie po błędzie sieci z tym samym kluczem
// idempotencji i komunikat „operacja była już wykonana”, cele >= 44 px przy 320 px.
// Serwer testowy: PGlite w pamięci, dane wyłącznie syntetyczne (tests/e2e/support/server.js).
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

async function pageAs(browser, cookie, viewport) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  await context.addCookies([{
    name: 'rd_session', value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
  }]);
  return { context, page: await context.newPage() };
}

// Liczy żądania zapisu (POST) pod danym wzorcem ścieżki.
function countPosts(page, pattern) {
  const requests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && pattern.test(new URL(request.url()).pathname)) requests.push(request);
  });
  return requests;
}

async function openPaymentForm(page, { amount, reference }) {
  await page.goto('/panel/');
  await expect(page.locator('#school-year-id')).not.toHaveValue('');
  await expect(page.locator('#loading')).toBeHidden();
  await page.locator('#open-payment').click();
  await expect(page.locator('#payment-dialog')).toBeVisible();
  await page.locator('#payment-form input[name=amount]').fill(amount);
  await page.locator('#payment-form input[name=reference]').fill(reference);
}

const confirmDialog = (page) => page.locator('#shared-confirm-dialog');

async function paymentsWithReference(page, reference) {
  const response = await page.request.get(`/api/payments?schoolYearId=${encodeURIComponent(runtime.schoolYearId)}`, {
    headers: { Cookie: `rd_session=${runtime.treasurer.cookie}` },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  return body.payments.filter((payment) => payment.reference === reference);
}

test('panel/: „Anuluj” w podsumowaniu wraca do formularza bez żądania; podwójne „Zapisz wpłatę” = jeden zapis', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.treasurer.cookie, { width: 320, height: 720 });
  const posts = countPosts(page, /^\/api\/payments$/);
  const reference = `e2e-potwierdzenie-${Date.now()}`;
  await openPaymentForm(page, { amount: '12,50', reference });

  const submit = page.locator('#payment-form button[value=submit]');
  await submit.click();
  await expect(confirmDialog(page)).toBeVisible();
  await expect(confirmDialog(page).locator('#shared-confirm-title')).toHaveText('Zapisać wpłatę?');
  await expect(confirmDialog(page).locator('#shared-confirm-body')).toContainText('12,50');
  await expect(confirmDialog(page).locator('#shared-confirm-body')).toContainText('Rok szkolny:');
  await expect(confirmDialog(page).locator('[data-role=confirm]')).toHaveText('Zapisz wpłatę');

  // 320 px: okno mieści się w ekranie, przyciski mają co najmniej 44 px wysokości.
  const box = await confirmDialog(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  for (const role of ['cancel', 'confirm']) {
    const button = await confirmDialog(page).locator(`[data-role=${role}]`).boundingBox();
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.x + button.width).toBeLessThanOrEqual(320);
  }
  expect(await confirmDialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  // Anulowanie: brak żądania, formularz wpłaty nadal otwarty z wpisanymi danymi, fokus wraca.
  await confirmDialog(page).locator('[data-role=cancel]').click();
  await expect(confirmDialog(page)).toBeHidden();
  await expect(page.locator('#payment-dialog')).toBeVisible();
  await expect(page.locator('#payment-form input[name=amount]')).toHaveValue('12,50');
  await expect(page.locator('#payment-form input[name=reference]')).toHaveValue(reference);
  await expect(submit).toBeFocused();
  expect(posts).toHaveLength(0);

  // Podwójne kliknięcie w „Zapisz wpłatę” w oknie potwierdzenia: jedno żądanie.
  await submit.click();
  await expect(confirmDialog(page)).toBeVisible();
  await confirmDialog(page).locator('[data-role=confirm]').dblclick();
  await expect(page.locator('#payment-dialog')).toBeHidden();
  await expect(page.locator('#message')).toHaveText('Zapisano wpłatę.');
  expect(posts).toHaveLength(1);
  expect(await paymentsWithReference(page, reference)).toHaveLength(1);

  // Korekta: podsumowanie pokazuje kwotę netto przed i po korekcie; „Anuluj” nic nie wysyła.
  const correctionPosts = countPosts(page, /^\/api\/payments\/[^/]+\/corrections$/);
  const row = page.locator('#payments-body tr', { hasText: reference });
  const correct = row.locator('button[data-action=correct]');
  await correct.click();
  await expect(page.locator('#correction-dialog')).toBeVisible();
  await page.locator('#correction-form input[name=amount]').fill('2,50');
  await page.locator('#correction-form textarea[name=reason]').fill('Test e2e korekty');
  const correctionSubmit = page.locator('#correction-form button[value=submit]');
  await correctionSubmit.click();
  await expect(confirmDialog(page).locator('#shared-confirm-title')).toHaveText('Dodać korektę?');
  await expect(confirmDialog(page).locator('#shared-confirm-body')).toContainText(/Netto wpłaty: 12,50\s€ → po korekcie 10,00\s€/);
  await confirmDialog(page).locator('[data-role=cancel]').click();
  await expect(correctionSubmit).toBeFocused();
  await expect(page.locator('#correction-form input[name=amount]')).toHaveValue('2,50');
  expect(correctionPosts).toHaveLength(0);
  await context.close();
});

test('panel/: ponowienie po błędzie sieci wysyła ten sam klucz i pokazuje „operacja była już wykonana”', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.treasurer.cookie);
  const reference = `e2e-ponowienie-${Date.now()}`;
  await openPaymentForm(page, { amount: '20,00', reference });

  // Pierwsze żądanie dociera do serwera (wpłata zapisana), ale odpowiedź „ginie”
  // w sieci — przeglądarka widzi błąd połączenia.
  const keys = [];
  let dropped = false;
  await page.route('**/api/payments', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    keys.push(request.headers()['idempotency-key']);
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort('failed');
  });

  const submit = page.locator('#payment-form button[value=submit]');
  await submit.click();
  await confirmDialog(page).locator('[data-role=confirm]').click();
  await expect(page.locator('#payment-error')).not.toBeEmpty();
  await expect(page.locator('#payment-dialog')).toBeVisible();
  expect(await paymentsWithReference(page, reference)).toHaveLength(1);

  // Ponowienie z tego samego formularza: to samo podsumowanie i ten sam klucz.
  await submit.click();
  await expect(confirmDialog(page)).toBeVisible();
  await confirmDialog(page).locator('[data-role=confirm]').click();
  await expect(page.locator('#payment-dialog')).toBeHidden();
  await expect(page.locator('#message')).toContainText('operacja była już wykonana');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(await paymentsWithReference(page, reference)).toHaveLength(1);
  await context.close();
});

test('events/: „Opublikuj” pokazuje podgląd; Esc bez żądania i z powrotem fokusu; podwójne kliknięcie = jedno żądanie', async ({ browser }) => {
  const { context, page } = await pageAs(browser, runtime.boardDocs.cookie);
  const posts = countPosts(page, /^\/api\/events\/[^/]+\/publish$/);
  await page.goto('/events/');
  const eventButton = page.locator('#events-body button[data-event-id]', { hasText: runtime.approvedEventTitle });
  await expect(eventButton).toBeVisible();
  await eventButton.click();

  const publish = page.locator('#detail-actions button[data-action=publish]');
  await expect(publish).toBeVisible();
  await publish.click();
  await expect(confirmDialog(page)).toBeVisible();
  await expect(confirmDialog(page).locator('#shared-confirm-title')).toHaveText('Opublikować wydarzenie?');
  const body = confirmDialog(page).locator('#shared-confirm-body');
  await expect(body).toContainText(runtime.approvedEventTitle);
  await expect(body).toContainText('Sala gimnastyczna');
  await expect(body).toContainText('Strona publiczna pokaże tę wersję');
  await expect(confirmDialog(page).locator('[data-role=confirm]')).toHaveText('Opublikuj');

  await page.keyboard.press('Escape');
  await expect(confirmDialog(page)).toBeHidden();
  await expect(publish).toBeFocused();
  expect(posts).toHaveLength(0);

  await publish.click();
  await expect(confirmDialog(page)).toBeVisible();
  await confirmDialog(page).locator('[data-role=confirm]').dblclick();
  await expect(page.locator('#detail-message')).toContainText('Opublikowano.');
  expect(posts).toHaveLength(1);
  await context.close();
});
