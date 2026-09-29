// E2E: obsługa samą klawiaturą okna „Edytuj kontakt" w families/ (issue #112,
// WCAG 2.1.1, 2.4.3, 2.4.7): Enter otwiera okno, fokus trafia do okna i zostaje
// w nim przy Tab, Esc zamyka okno i przywraca fokus na przycisk wywołujący.
// Edycja kontaktu wymaga roli admin/board (przedstawiciel klasy tylko czyta), więc
// test używa sesji administratora z MFA. Dane wyłącznie syntetyczne (support/server.js).
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

test.use({ viewport: { width: 1280, height: 900 } });

test('okno „Edytuj kontakt" w families/: Enter, Tab w oknie, Esc i powrót fokusu', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([{
    name: 'rd_session',
    value: runtime.adminReset.freshCookie,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  await page.goto('/families/');

  // Skip link jest pierwszym elementem w kolejności Tab i przenosi do treści.
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);

  // Dojście do karty gospodarstwa: linki (klasa, potem uczeń/gospodarstwo).
  await page.locator('#years a').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#class-view')).toBeVisible();
  await page.locator('#class-view table a').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#household-view')).toBeVisible();

  const trigger = page.getByRole('button', { name: 'Edytuj kontakt' }).first();
  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.locator('#contact-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName('Kontakt opiekuna');
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  // Okno modalne blokuje resztę strony: kilkanaście Tab nigdy nie ustawia fokusu
  // na elemencie poza oknem (przeglądarka może na chwilę oddać fokus swojemu
  // interfejsowi, wtedy activeElement to body).
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab');
    const outside = await dialog.evaluate((element) => {
      const active = document.activeElement;
      return active !== document.body && !element.contains(active);
    });
    expect(outside).toBe(false);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await context.close();
});
