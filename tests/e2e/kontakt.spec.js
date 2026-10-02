// E2E: publiczna strona /kontakt/ (#140 pkt 5) — wniosek rodzica z nowym adresem, pole 8-cyfrowego
// kodu weryfikacyjnego i ta sama treść dla każdej porażki potwierdzenia. Odpowiedzi API są
// podstawione przez page.route (strona jest sprawdzana jako zbudowany plik z dist/kontakt), więc
// nic nie trafia do bazy i żadna wiadomość nie wychodzi. Dane wyłącznie syntetyczne.
import { expect, test } from '@playwright/test';
import { VERIFY_FAILURE_TEXT, VERIFY_SUCCESS_TEXT } from '../../kontakt/core.js';

const TOKEN = 'ab'.repeat(32);
const PATH = '/api/public/guardian-update';

// Podstawia trasy publiczne; zwraca dziennik żądań do asercji.
async function stubApi(page, { previewStatus = 200, emailVerification = 'requested', verifyResponses = [] } = {}) {
  const log = { preview: [], submit: [], verify: [] };
  const verifyQueue = [...verifyResponses];
  await page.route((url) => url.pathname.startsWith(PATH), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === `${PATH}/verify`) {
      log.verify.push({ url: request.url(), body: request.postDataJSON() });
      const next = verifyQueue.shift() ?? { status: 400, body: { error: 'invalid_or_expired_code' } };
      await route.fulfill({ status: next.status, headers: next.headers ?? {}, json: next.body });
      return;
    }
    if (request.method() === 'GET') {
      log.preview.push(request.url());
      await route.fulfill(previewStatus === 200
        ? { status: 200, json: { guardianFirstName: 'Anna', classNames: ['1A'] } }
        : { status: previewStatus, json: { error: 'invalid_or_expired_link' } });
      return;
    }
    log.submit.push({ url: request.url(), body: request.postDataJSON() });
    await route.fulfill({ status: 201, json: { requestId: 'req-e2e-1', status: 'pending', emailVerification } });
  });
  return log;
}

test('kontakt/: nowy adres → pole kodu → ta sama treść dla każdej porażki → potwierdzenie', async ({ page }) => {
  const log = await stubApi(page, {
    verifyResponses: [
      { status: 400, body: { error: 'invalid_or_expired_code' } },
      { status: 404, body: { error: 'invalid_or_expired_link' } },
      { status: 429, headers: { 'Retry-After': '30' }, body: { error: 'rate_limited' } },
      { status: 200, body: { verification: 'confirmed' } },
    ],
  });
  await page.goto(`/kontakt/#token=${TOKEN}`);

  await expect(page.locator('#view-form')).toBeVisible();
  await expect(page.locator('#form-summary')).toHaveText('Opiekun: Anna; klasa: 1A');
  await expect(page.locator('#view-code')).toBeHidden();
  // Pusty formularz niczego nie wysyła.
  await page.getByRole('button', { name: 'Wyślij wniosek' }).click();
  await expect(page.locator('#update-error')).not.toHaveText('');
  expect(log.submit).toHaveLength(0);

  await page.getByLabel('Nowy adres e-mail (opcjonalnie)').fill('nowy@example.invalid');
  await page.getByRole('button', { name: 'Wyślij wniosek' }).click();

  await expect(page.locator('#view-done')).toBeVisible();
  await expect(page.locator('#view-form')).toBeHidden();
  await expect(page.locator('#view-code')).toBeVisible();
  expect(log.submit).toHaveLength(1);
  expect(log.submit[0].body).toEqual({ token: TOKEN, email: 'nowy@example.invalid' });
  // Strona nie wyświetla ponownie wpisanego adresu.
  await expect(page.locator('main')).not.toContainText('nowy@example.invalid');

  const input = page.getByLabel('Kod z wiadomości (8 cyfr)');
  const confirm = page.getByRole('button', { name: 'Potwierdź adres' });
  await expect(input).toHaveAttribute('inputmode', 'numeric');
  // Zły format nie wychodzi z przeglądarki, a treść jest ta sama co przy odmowie serwera.
  await input.fill('1234');
  await confirm.click();
  await expect(page.locator('#code-error')).toHaveText(VERIFY_FAILURE_TEXT);
  expect(log.verify).toHaveLength(0);

  const texts = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await input.fill('1234 5678');
    await confirm.click();
    await expect.poll(() => log.verify.length).toBe(attempt + 1);
    await expect(page.locator('#code-error')).toHaveText(VERIFY_FAILURE_TEXT);
    texts.push(await page.locator('#code-error').innerText());
  }
  expect(new Set(texts).size).toBe(1);
  expect(log.verify[0].body).toEqual({ token: TOKEN, code: '12345678' });
  expect(log.verify[0].url).not.toContain(TOKEN);
  await expect(page.locator('#code-success')).toHaveText('');

  await input.fill('12345678');
  await confirm.click();
  await expect(page.locator('#code-success')).toHaveText(VERIFY_SUCCESS_TEXT);
  await expect(page.locator('#code-error')).toHaveText('');
});

test('kontakt/: odpowiedź bez emailVerification: requested nie pokazuje pola kodu', async ({ page }) => {
  const log = await stubApi(page, { emailVerification: 'none' });
  await page.goto(`/kontakt/#token=${TOKEN}`);
  await page.getByLabel('Wyrażam zgodę na kontakt').check();
  await page.getByRole('button', { name: 'Wyślij wniosek' }).click();
  await expect(page.locator('#view-done')).toBeVisible();
  await expect(page.locator('#view-code')).toBeHidden();
  expect(log.submit[0].body).toEqual({ token: TOKEN, contactAllowed: true });
});

test('kontakt/: link zużyty lub zły to jedna treść, a bez tokenu strona nie pyta serwera', async ({ page }) => {
  const used = await stubApi(page, { previewStatus: 404 });
  await page.goto(`/kontakt/#token=${TOKEN}`);
  await expect(page.locator('#view-invalid')).toBeVisible();
  await expect(page.locator('#view-form')).toBeHidden();
  // Kod z wiadomości wpisuje się nawet po zużyciu linku (wiadomość przychodzi po złożeniu wniosku).
  await expect(page.locator('#view-code')).toBeVisible();
  expect(used.preview).toHaveLength(1);

  const bare = await stubApi(page);
  await page.goto('/kontakt/#token=nie-hex');
  await expect(page.locator('#view-invalid')).toBeVisible();
  await expect(page.locator('#view-code')).toBeHidden();
  expect(bare.preview).toHaveLength(0);
});
