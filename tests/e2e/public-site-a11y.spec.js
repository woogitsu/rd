// E2E dostępności strony publicznej site/ (issue #124) na danych syntetycznych
// z support/server.js: 20 opublikowanych aktualności (limit listy publicznej),
// w tym tytuł jednym słowem bez spacji i tytuł z próbą wstrzyknięcia HTML, oraz
// szkic, który nie może się pojawić. Sprawdza w renderowanej stronie (a nie tylko
// w CSS — tests/site-a11y.test.js): brak poziomego przewijania przy 320/390/1280 px,
// tekst zamiast HTML, strukturę nagłówków, rozmiar celów i obsługę klawiaturą.
// Nie zastępuje testu z czytnikiem ekranu (docs/ACCESSIBILITY.md).
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

async function openSite(page) {
  await page.goto('/site/');
  await expect(page.locator('#aktualnosci')).not.toHaveAttribute('aria-busy', 'true', { timeout: 10_000 });
  await expect(page.locator('#news-status')).toBeHidden();
}

for (const width of [320, 390, 1280]) {
  test(`site/ przy ${width} px: 20 wpisów z długimi tytułami bez poziomego przewijania`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openSite(page);

    const entries = page.locator('#news-list li.news');
    await expect(entries).toHaveCount(20);
    await expect(page.locator('#news-list')).not.toContainText(runtime.draftNewsTitle);

    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const outside = [...document.querySelectorAll('main *, header *, footer *')]
        .filter((el) => !el.closest('.skip-link, .sr-only'))
        .filter((el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.right > root.clientWidth + 1; })
        .map((el) => `${el.tagName}.${el.className}`);
      return { overflow: root.scrollWidth - root.clientWidth, outside: [...new Set(outside)].slice(0, 5) };
    });
    expect(layout.overflow, 'poziome przewijanie strony').toBeLessThanOrEqual(0);
    expect(layout.outside, 'elementy poza szerokością ekranu').toEqual([]);

    // Tytuł jednym słowem łamie się w granicach wpisu (overflow-wrap: anywhere).
    const longTitle = page.locator('h3.news-title', { hasText: runtime.newsLongWord });
    const [titleBox, entryBox] = await Promise.all([
      longTitle.boundingBox(),
      longTitle.locator('xpath=ancestor::li[1]').boundingBox(),
    ]);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(entryBox.x + entryBox.width + 1);
  });
}

test('site/: tytuł z <img onerror> jest tekstem, strona ma poprawny język i układ nagłówków', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openSite(page);

  await expect(page.locator('h3.news-title', { hasText: runtime.newsInjectionTitle })).toHaveCount(1);
  await expect(page.locator('#news-list img')).toHaveCount(0); // brak zdjęć w danych = żadnego <img>
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  await expect(page.locator('html')).toHaveAttribute('lang', 'pl');
  await expect(page.locator('h1')).toHaveCount(1);
  const levels = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((nodes) => nodes
    .filter((node) => node.getClientRects().length > 0)
    .map((node) => Number(node.tagName[1])));
  expect(levels[0]).toBe(1);
  for (let i = 1; i < levels.length; i += 1) {
    expect(levels[i], `przeskok poziomu nagłówka h${levels[i - 1]} → h${levels[i]}`).toBeLessThanOrEqual(levels[i - 1] + 1);
  }
  // Nawigacja jest stała (WCAG 3.2.3): pięć pozycji (z „Informacja o danych”, #145) także po wczytaniu.
  await expect(page.locator('header nav a')).toHaveCount(5);
});

test('site/ przy 320 px: klawiatura — skip link, widoczny fokus, cele co najmniej 24 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openSite(page);

  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await expect(page.locator('.skip-link')).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  const problems = [];
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    const state = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return {
        name: `${el.tagName} ${(el.textContent || '').trim().slice(0, 30)}`,
        outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2,
        visible: box.bottom > 0 && box.top < window.innerHeight,
      };
    });
    if (state && (!state.outline || !state.visible)) problems.push(state);
  }
  expect(problems, 'element z fokusem bez obrysu albo poza ekranem').toEqual([]);

  // Samodzielne linki (nie w zdaniu): nawigacja, archiwum, stały link do wpisu, .ics wydarzenia (WCAG 2.5.8).
  const small = await page.locator('header nav a, .news-archive a, a.news-permalink, .event-calendar a').evaluateAll((links) => links
    .map((link) => ({ text: link.textContent.trim(), height: link.getBoundingClientRect().height }))
    .filter((link) => link.height > 0 && link.height < 24));
  expect(small).toEqual([]);
});
