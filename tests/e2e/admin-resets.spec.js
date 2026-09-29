// E2E (#224): administrator w panelu „Konta i role” wydaje kod resetu hasła
// (z krokiem w górę MFA po `mfa_stale`), użytkownik ustawia nowe hasło przez
// /login/#reset=…, a reset MFA wymaga wpisania identyfikatora konta i po
// zalogowaniu prowadzi do zapisu nowego czynnika. Konta i sekrety są syntetyczne
// (tests/e2e/support/server.js); brak wysyłki e-maili.
import { expect, test } from '@playwright/test';
import { base32Decode, totp } from '../../src/pg/mfa.js';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();
const admin = runtime.adminReset;

async function adminPage(browser, cookie) {
  const context = await browser.newContext();
  await context.addCookies([{
    name: 'rd_session', value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  await page.goto('/admin/');
  await expect(page.locator('h1')).toHaveText('Konta i przydziały ról');
  await expect(page.locator('#users-body tr', { hasText: admin.userId })).toBeVisible();
  return { context, page };
}

const rowFor = (page, userId) => page.locator('#users-body tr', { hasText: userId });

test('reset hasła ze starym MFA: krok w górę kodem, link jednorazowy, nowe hasło w /login/', async ({ browser }) => {
  const target = admin.targets[0];
  const { context, page } = await adminPage(browser, admin.staleCookie);

  // Własne konto: akcje resetu są niedostępne.
  await expect(rowFor(page, admin.userId).getByRole('button', { name: 'Wydaj kod resetu hasła' })).toBeDisabled();
  await expect(rowFor(page, admin.userId).getByRole('button', { name: 'Zresetuj MFA' })).toBeDisabled();

  await rowFor(page, target.userId).getByRole('button', { name: 'Wydaj kod resetu hasła' }).click();
  const confirmDialog = page.locator('#shared-confirm-dialog');
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.locator('[data-role=confirm]').click();

  // Serwer odpowiada 403 mfa_stale — panel prosi o kod z aplikacji.
  await expect(confirmDialog.locator('#shared-confirm-title')).toHaveText('Potwierdź kodem z aplikacji');
  await expect(page.locator('#reset-token-box')).toBeHidden();
  const confirmButton = confirmDialog.locator('[data-role=confirm]');
  await expect(confirmButton).toBeDisabled();
  await confirmDialog.locator('#shared-confirm-input').fill(totp(base32Decode(admin.totpSecret), Date.now()));
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(page.locator('#reset-token-box')).toBeVisible();
  const link = (await page.locator('#reset-link').innerText()).trim();
  expect(link).toMatch(/\/login\/#reset=[A-Za-z0-9_-]{43}$/);
  const token = link.split('#reset=')[1];

  // Dziennik zdarzeń pokazuje wydanie resetu, bez tokenu i adresu e-mail.
  await expect(page.locator('#audit-body')).toContainText('Wydanie kodu resetu hasła');
  expect(await page.locator('#audit-body').innerText()).not.toContain(token);
  expect(await page.locator('#audit-body').innerText()).not.toContain('@');

  // Użytkownik otwiera link, ustawia nowe hasło i loguje się nim.
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  await userPage.goto(link);
  await expect(userPage.locator('#view-reset')).toBeVisible();
  await expect(userPage.locator('#reset-token')).toHaveValue(token);
  const newPassword = `Nowe syntetyczne haslo ${Date.now()}`;
  await userPage.locator('#reset-password').fill(newPassword);
  await userPage.locator('#reset-repeat').fill(newPassword);
  await userPage.locator('#reset-form button[type=submit]').click();
  await expect(userPage.locator('#view-login')).toBeVisible();

  await userPage.locator('#login-email').fill(target.email);
  await userPage.locator('#login-password').fill(newPassword);
  await userPage.locator('#login-form button[type=submit]').click();
  // Konto ma czynnik MFA — po haśle prosi o kod (ekran kodu), nie o zapis nowego.
  await expect(userPage.locator('#view-mfa')).toBeVisible();

  // Kod resetu jest jednorazowy: drugie użycie tego samego tokenu nie działa.
  const reuse = await userPage.evaluate(async ({ resetToken }) => {
    const res = await fetch('/api/password/reset', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: resetToken, password: 'Inne syntetyczne haslo 123456' }),
    });
    return res.status;
  }, { resetToken: token });
  expect(reuse).toBeGreaterThanOrEqual(400);

  await userContext.close();
  await context.close();
});

test('reset MFA: identyfikator konta wymagany, po resecie logowanie nie prosi już o kod (konto bez roli chronionej)', async ({ browser }) => {
  const target = admin.targets[1];
  const { context, page } = await adminPage(browser, admin.freshCookie);
  const confirmDialog = page.locator('#shared-confirm-dialog');
  const confirmButton = confirmDialog.locator('[data-role=confirm]');

  // Anulowanie i błędny identyfikator nic nie zmieniają.
  await rowFor(page, target.userId).getByRole('button', { name: 'Zresetuj MFA' }).click();
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.locator('[data-role=cancel]')).not.toBeFocused(); // pole tekstowe dostaje fokus
  await expect(confirmDialog.locator('#shared-confirm-input')).toBeFocused();
  await expect(confirmButton).toBeDisabled();
  await confirmDialog.locator('#shared-confirm-input').fill('e2e-inny-identyfikator');
  await expect(confirmButton).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(confirmDialog).toBeHidden();
  await expect(rowFor(page, target.userId).getByRole('button', { name: 'Zresetuj MFA' })).toBeVisible();

  // Poprawny identyfikator odblokowuje potwierdzenie.
  await rowFor(page, target.userId).getByRole('button', { name: 'Zresetuj MFA' }).click();
  await confirmDialog.locator('#shared-confirm-input').fill(target.userId);
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(page.locator('#global-message')).toContainText('Zresetowano weryfikację dwuetapową');
  await expect(page.locator('#audit-body')).toContainText('Reset weryfikacji dwuetapowej');
  // Czynnik zniknął: przycisk resetu MFA nie jest już oferowany dla tego konta.
  await expect(rowFor(page, target.userId).getByRole('button', { name: 'Zresetuj MFA' })).toHaveCount(0);

  // Konto bez roli wymagającej MFA (role chronione idą przez wniosek, patrz test
  // niżej): po resecie logowanie hasłem nie prosi o kod (brak czynnika), a ekran
  // startowy oferuje dobrowolny zapis nowego czynnika (#161). Rola wymagająca MFA
  // trafiłaby do obowiązkowego zapisu (view-enroll) — nextView w login/core.js.
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  await userPage.goto('/login/');
  await userPage.locator('#login-email').fill(target.email);
  await userPage.locator('#login-password').fill(target.password);
  await userPage.locator('#login-form button[type=submit]').click();
  await expect(userPage.locator('#view-start')).toBeVisible();
  await expect(userPage.locator('#view-mfa')).toBeHidden();

  await userContext.close();
  await context.close();
});

test('krok w górę MFA: anulowanie okna z kodem nie wydaje resetu', async ({ browser }) => {
  const target = admin.targets[1];
  const { context, page } = await adminPage(browser, admin.staleCookie2);
  const issuedBefore = await page.evaluate(async () => {
    const res = await fetch('/api/admin/audit?limit=200', { credentials: 'same-origin' });
    return ((await res.json()).events ?? []).filter((event) => event.action === 'auth.password_reset_issued').length;
  });
  await rowFor(page, target.userId).getByRole('button', { name: 'Wydaj kod resetu hasła' }).click();
  const confirmDialog = page.locator('#shared-confirm-dialog');
  await confirmDialog.locator('[data-role=confirm]').click();
  await expect(confirmDialog.locator('#shared-confirm-title')).toHaveText('Potwierdź kodem z aplikacji');
  await confirmDialog.locator('[data-role=cancel]').click();
  await expect(confirmDialog).toBeHidden();
  await expect(page.locator('#global-message')).toContainText('Nic nie zmieniono');
  await expect(page.locator('#reset-token-box')).toBeHidden();
  // Błędny kod: serwer odrzuca, nadal brak tokenu.
  await rowFor(page, target.userId).getByRole('button', { name: 'Wydaj kod resetu hasła' }).click();
  await confirmDialog.locator('[data-role=confirm]').click();
  await confirmDialog.locator('#shared-confirm-input').fill('000000');
  await confirmDialog.locator('[data-role=confirm]').click();
  await expect(page.locator('#global-message')).toContainText('Kod jest nieprawidłowy');
  await expect(page.locator('#reset-token-box')).toBeHidden();
  const issuedAfter = await page.evaluate(async () => {
    const res = await fetch('/api/admin/audit?limit=200', { credentials: 'same-origin' });
    return ((await res.json()).events ?? []).filter((event) => event.action === 'auth.password_reset_issued').length;
  });
  expect(issuedAfter).toBe(issuedBefore);
  await context.close();
});

test('konto z rolą chronioną: reset hasła i MFA tylko zapisują wniosek (202), bez tokenu i bez zmiany czynnika', async ({ browser }) => {
  const target = admin.targets[2];
  const { context, page } = await adminPage(browser, admin.freshCookie);
  const confirmDialog = page.locator('#shared-confirm-dialog');
  const countEvents = (action) => page.evaluate(async (name) => {
    const res = await fetch('/api/admin/audit?limit=200', { credentials: 'same-origin' });
    return ((await res.json()).events ?? []).filter((event) => event.action === name).length;
  }, action);
  const issuedBefore = await countEvents('auth.password_reset_issued');

  await rowFor(page, target.userId).getByRole('button', { name: 'Wydaj kod resetu hasła' }).click();
  await confirmDialog.locator('[data-role=confirm]').click();
  await expect(page.locator('#global-message')).toContainText('zapisano wniosek');
  await expect(page.locator('#global-message')).toContainText('innego administratora');
  await expect(page.locator('#reset-token-box')).toBeHidden();

  await rowFor(page, target.userId).getByRole('button', { name: 'Zresetuj MFA' }).click();
  await confirmDialog.locator('#shared-confirm-input').fill(target.userId);
  await confirmDialog.locator('[data-role=confirm]').click();
  await expect(confirmDialog).toBeHidden();
  await expect(page.locator('#global-message')).toContainText('zapisano wniosek');
  await expect(page.locator('#global-message')).not.toContainText('nic nie zmieniono.');
  // Czynnik nadal istnieje, token nie został wydany, wnioski są w dzienniku.
  await expect(rowFor(page, target.userId).getByRole('button', { name: 'Zresetuj MFA' })).toBeVisible();
  expect(await countEvents('auth.password_reset_issued')).toBe(issuedBefore);
  expect(await countEvents('account_recovery.requested')).toBeGreaterThanOrEqual(2);
  await context.close();
});
