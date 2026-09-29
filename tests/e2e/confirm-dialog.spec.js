// E2E: interakcje wspólnego okna potwierdzenia (issue #136) — Esc, fokus,
// anulowanie, podsumowanie skutków, podwójne kliknięcie. Moduł
// shared/confirm-dialog.js jest ładowany na pustej stronie (bez serwera
// aplikacji i bez żadnych danych), więc test sprawdza wyłącznie zachowanie
// okna; wywołania API liczy atrapa `window.__requests`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const source = readFileSync(fileURLToPath(new URL('../../shared/confirm-dialog.js', import.meta.url)), 'utf8')
  .replace(/^export /gm, '');

async function openHost(page) {
  await page.goto('about:blank');
  await page.setContent(`
    <button id="invoker" type="button">Opublikuj</button>
    <button id="other" type="button">Inny</button>`);
  await page.addScriptTag({ content: `${source}\nwindow.confirmAction = confirmAction;` });
  await page.evaluate(() => {
    window.__requests = 0;
    window.__results = [];
    // Zachowanie wywołującego: żądanie do API dopiero po potwierdzeniu.
    document.getElementById('invoker').addEventListener('click', async () => {
      const ok = await window.confirmAction(window.__options);
      window.__results.push(ok);
      if (ok) window.__requests += 1;
    });
  });
}

const setOptions = (page, options) => page.evaluate((o) => { window.__options = o; }, options);
const dialog = (page) => page.locator('#shared-confirm-dialog');

test('podsumowanie skutków, tytuł i ostrzeżenie są widoczne, treść jest zakodowana', async ({ page }) => {
  await openHost(page);
  await setOptions(page, {
    title: 'Opublikować wydarzenie?',
    effects: ['Wydarzenie zobaczą rodzice', '<b>nie pogrubiaj</b>'],
    warning: 'Publikacja jest widoczna publicznie.',
    confirmLabel: 'Opublikuj',
  });
  await page.locator('#invoker').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute('aria-labelledby', 'shared-confirm-title');
  await expect(dialog(page)).toHaveAttribute('aria-describedby', 'shared-confirm-body');
  await expect(dialog(page).locator('#shared-confirm-title')).toHaveText('Opublikować wydarzenie?');
  await expect(dialog(page).locator('#shared-confirm-body li')).toHaveText(['Wydarzenie zobaczą rodzice', '<b>nie pogrubiaj</b>']);
  await expect(dialog(page).locator('#shared-confirm-body b')).toHaveCount(0);
  await expect(dialog(page).locator('#shared-confirm-warning')).toHaveText('Publikacja jest widoczna publicznie.');
  await expect(dialog(page).locator('[data-role=confirm]')).toHaveText('Opublikuj');
  await expect(dialog(page).locator('[data-role=cancel]')).toHaveText('Anuluj');
});

test('bez ostrzeżenia pole ostrzeżenia jest ukryte', async ({ page }) => {
  await openHost(page);
  await setOptions(page, { title: 'Zapisać?', effects: ['Skutek'] });
  await page.locator('#invoker').click();
  await expect(dialog(page).locator('#shared-confirm-warning')).toBeHidden();
});

test('Esc anuluje: brak żądania, okno zamknięte, fokus wraca do przycisku wywołującego', async ({ page }) => {
  await openHost(page);
  await setOptions(page, { title: 'Zapisać wpłatę?', effects: ['Skutek'] });
  await page.locator('#invoker').click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#invoker')).toBeFocused();
  expect(await page.evaluate(() => window.__results)).toEqual([false]);
  expect(await page.evaluate(() => window.__requests)).toBe(0);
});

test('przycisk Anuluj: brak żądania i powrót fokusu', async ({ page }) => {
  await openHost(page);
  await setOptions(page, { title: 'Zapisać wpłatę?', effects: ['Skutek'] });
  await page.locator('#invoker').click();
  await dialog(page).locator('[data-role=cancel]').click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#invoker')).toBeFocused();
  expect(await page.evaluate(() => window.__results)).toEqual([false]);
  expect(await page.evaluate(() => window.__requests)).toBe(0);
});

test('akcja nieodwracalna: fokus startuje na „Anuluj”, zwykła: na „Potwierdź”', async ({ page }) => {
  await openHost(page);
  await setOptions(page, { title: 'Usunąć?', effects: ['Nieodwracalne'], destructive: true, confirmLabel: 'Usuń' });
  await page.locator('#invoker').click();
  await expect(dialog(page).locator('[data-role=cancel]')).toBeFocused();
  await expect(dialog(page)).toHaveClass(/destructive/);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  await setOptions(page, { title: 'Zapisać?', effects: ['Skutek'] });
  await page.locator('#invoker').click();
  await expect(dialog(page).locator('[data-role=confirm]')).toBeFocused();
  await expect(dialog(page)).not.toHaveClass(/destructive/);
});

test('okno modalne: elementy strony pod spodem nie łapią fokusu (Tab)', async ({ page }) => {
  await openHost(page);
  await setOptions(page, { title: 'Usunąć?', effects: ['Nieodwracalne'], destructive: true });
  await page.locator('#invoker').click();
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => document.activeElement?.id ?? '');
    expect(['invoker', 'other']).not.toContain(id);
  }
  await expect(dialog(page)).toBeVisible();
});

test('Potwierdź: jedno rozstrzygnięcie także przy podwójnym kliknięciu', async ({ page }) => {
  await openHost(page);
  await setOptions(page, { title: 'Zapisać wpłatę?', effects: ['Skutek'], confirmLabel: 'Zapisz' });
  await page.locator('#invoker').click();
  // Dwa kliknięcia w tym samym przycisku w jednym zadaniu (prawdziwe drugie
  // kliknięcie trafiłoby już w stronę pod zamkniętym oknem).
  await page.evaluate(() => {
    const button = document.querySelector('#shared-confirm-dialog [data-role=confirm]');
    button.click();
    button.click();
  });
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#invoker')).toBeFocused();
  expect(await page.evaluate(() => window.__results)).toEqual([true]);
  expect(await page.evaluate(() => window.__requests)).toBe(1);
});

test('okno można otworzyć ponownie po anulowaniu i ma świeżą treść', async ({ page }) => {
  await openHost(page);
  await setOptions(page, { title: 'Pierwsze', effects: ['A'] });
  await page.locator('#invoker').click();
  await page.keyboard.press('Escape');
  await setOptions(page, { title: 'Drugie', effects: ['B'] });
  await page.locator('#invoker').click();
  await expect(dialog(page).locator('#shared-confirm-title')).toHaveText('Drugie');
  await expect(dialog(page).locator('#shared-confirm-body li')).toHaveText(['B']);
  await expect(page.locator('#shared-confirm-dialog')).toHaveCount(1);
  await dialog(page).locator('[data-role=confirm]').click();
  expect(await page.evaluate(() => window.__results)).toEqual([false, true]);
});
