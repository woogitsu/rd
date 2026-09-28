// E2E: logowanie administratora hasłem, zapis weryfikacji dwuetapowej (TOTP)
// przez prawdziwy ekran /login/ i otwarcie panelu /admin/. Kod TOTP jest
// liczony w tym teście (RFC 6238) z sekretu odczytanego z ekranu — dokładnie
// tak, jak zrobiłaby to aplikacja uwierzytelniająca na telefonie.
import { expect, test } from '@playwright/test';
import { base32Decode, totp } from '../../src/pg/mfa.js';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

test('admin: logowanie hasłem, konfiguracja MFA w przeglądarce i otwarcie panelu admin/', async ({ page }) => {
  await page.goto('/login/');

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

  // Panel startowy z linkami do paneli, w tym admin/.
  await expect(page.locator('#view-start')).toBeVisible();
  const adminLink = page.locator('#panel-list a[href="/admin/"]');
  await expect(adminLink).toBeVisible();
  await adminLink.click();

  await expect(page).toHaveURL(/\/admin\/$/);
  await expect(page.locator('h1')).toHaveText('Konta i przydziały ról');

  // Sesja jest naprawdę zweryfikowana MFA po stronie serwera (nie tylko UI).
  const session = await page.request.get('/api/session');
  expect(session.status()).toBe(200);
  const body = await session.json();
  expect(body.mfaVerified).toBe(true);
  expect(body.user.id).toBe(runtime.admin.userId);
});
