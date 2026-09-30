// E2E: logowanie administratora hasłem, zapis weryfikacji dwuetapowej (TOTP)
// przez prawdziwy ekran /login/ i otwarcie panelu /admin/. Kod TOTP jest
// liczony w tym teście (RFC 6238) z sekretu odczytanego z ekranu — dokładnie
// tak, jak zrobiłaby to aplikacja uwierzytelniająca na telefonie.
import { expect, test } from '@playwright/test';
import { base32Decode, totp } from '../../src/pg/mfa.js';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

test('admin: logowanie hasłem, konfiguracja MFA w przeglądarce i otwarcie panelu admin/', async ({ page }) => {
  // #99 (przegląd demo 4): wejście na /login/ bez sesji nie może dawać 401 z /api/auth/state
  // (czerwony wpis w konsoli przy każdym logowaniu) — ekran bez wskazówki sesji nie pyta.
  const failedApi = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) failedApi.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.goto('/login/');
  await expect(page.locator('#view-login')).toBeVisible();
  expect(failedApi).toEqual([]);

  await page.locator('#login-email').fill(runtime.admin.email);
  await page.locator('#login-password').fill(runtime.admin.password);
  await page.locator('#login-form button[type=submit]').click();

  // Rola admin wymaga MFA i konto go jeszcze nie ma — ekran konfiguracji.
  await expect(page.locator('#view-enroll')).toBeVisible();
  await page.locator('#enroll-start').click();

  // #enroll-start woła POST /api/mfa/enroll i dopiero po odpowiedzi wypełnia
  // #manual-key — poczekaj, aż sekcja ze skanowaniem kodu QR stanie się widoczna.
  await expect(page.locator('#enroll-scan')).toBeVisible();
  await expect(page.locator('#manual-key')).not.toHaveText('');
  const manualKey = await page.locator('#manual-key').innerText();
  const secretB32 = manualKey.replace(/\s+/g, '');
  expect(secretB32).toMatch(/^[A-Z2-7]{16,}$/);

  const code = totp(base32Decode(secretB32), Date.now());
  await page.locator('#enroll-code').fill(code);
  await page.locator('#enroll-confirm-form button[type=submit]').click();

  // Kody odzyskiwania (10 sztuk) — trzeba zaznaczyć "zapisałem" przed dalej.
  await expect(page.locator('#enroll-codes')).toBeVisible();
  await expect(page.locator('#recovery-codes li')).toHaveCount(10);
  await page.locator('#codes-saved').check();
  await page.locator('#codes-done').click();

  expect(failedApi).toEqual([]);

  // Panel startowy z linkami do paneli, w tym admin/.
  await expect(page.locator('#view-start')).toBeVisible();
  const adminLink = page.locator('#panel-list a[href="/admin/"]');
  await expect(adminLink).toBeVisible();
  await adminLink.click();

  await expect(page).toHaveURL(/\/admin\/$/);
  await expect(page.locator('h1')).toHaveText('Konta i przydziały ról');

  // Sesja jest naprawdę zweryfikowana MFA po stronie serwera (nie tylko UI).
  // page.evaluate (fetch w kontekście strony) zamiast page.request — cookie
  // sesji jest HttpOnly, więc leci automatycznie tylko z prawdziwego żądania
  // przeglądarki, nie z osobnego jar-a APIRequestContext.
  const session = await page.evaluate(async () => {
    const res = await fetch('/api/session', { credentials: 'same-origin' });
    return { status: res.status, body: await res.json() };
  });
  expect(session.status).toBe(200);
  expect(session.body.mfaVerified).toBe(true);
  expect(session.body.user.id).toBe(runtime.admin.userId);

  // Ponowne wejście na /login/ z działającą sesją (wskazówka zapisana po zalogowaniu):
  // ekran pyta o stan i pokazuje listę paneli, nie formularz logowania.
  await page.goto('/login/');
  await expect(page.locator('#view-start')).toBeVisible();
  expect(failedApi).toEqual([]);
});
