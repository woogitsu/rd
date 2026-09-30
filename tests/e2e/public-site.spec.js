// E2E: strona publiczna site/ pokazuje wyłącznie zatwierdzone (opublikowane)
// dane — szkic wydarzenia, który nigdy nie przeszedł zgłoszenia/zatwierdzenia,
// nie może się tam pojawić (AGENTS.md: „Widok publiczny używa wyłącznie
// zatwierdzonych danych”). Bez sesji — dokładnie tak, jak widzi to rodzic.
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

test('site/ nie pokazuje danych niezatwierdzonych', async ({ page }) => {
  await page.goto('/site/');

  await expect(page.locator('#events-status')).toBeHidden({ timeout: 10_000 });
  const eventsList = page.locator('#events-list');
  await expect(eventsList).toContainText(runtime.publishedEventTitle);
  await expect(eventsList).not.toContainText(runtime.draftEventTitle);

  // Kontrola po stronie API, nie tylko w DOM: /api/public/events działa bez
  // sesji i nie wycieka szkiców ani danych autorów (patrz scripts/smoke-postgres.js).
  const response = await page.request.get('/api/public/events');
  expect(response.status()).toBe(200);
  const text = await response.text();
  expect(text).toContain(runtime.publishedEventTitle);
  expect(text).not.toContain(runtime.draftEventTitle);
  expect(text).not.toMatch(/authorId|author_id|createdBy|created_by/i);
});

// #116: strona renderowana po stronie serwera — treść jest w HTML także bez
// JavaScriptu (podglądy linków, wyszukiwarki, przeglądarki bez JS), a stały
// adres wpisu prowadzi do osobnej strony z tytułem i Open Graph bez obrazu.
test('site/ bez JavaScriptu: aktualności i wydarzenia w HTML, stały adres wpisu, kanał Atom', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('/site/');
    await expect(page.locator('#news-list li.news')).toHaveCount(20);
    await expect(page.locator('#news-list')).not.toContainText(runtime.draftNewsTitle);
    await expect(page.locator('h3.news-title', { hasText: runtime.newsInjectionTitle })).toHaveCount(1);
    await expect(page.locator('#news-list img')).toHaveCount(0);
    await expect(page.locator('#events-list')).toContainText(runtime.publishedEventTitle);
    await expect(page.locator('#events-list')).not.toContainText(runtime.draftEventTitle);
    await expect(page.locator('#news-status')).toBeHidden();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/site\/$/);

    const permalink = page.locator('#news-list li.news', { hasText: runtime.newsInjectionTitle }).locator('a.news-permalink');
    await permalink.click();
    await expect(page).toHaveURL(/\/site\/aktualnosci\/[^/]+$/);
    await expect(page.locator('h1')).toHaveText(runtime.newsInjectionTitle);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', new RegExp(`^${runtime.newsInjectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);

    const missing = await page.request.get('/site/aktualnosci/brak-takiego-wpisu');
    expect(missing.status()).toBe(404);
    expect(missing.headers()['x-robots-tag']).toBe('noindex, nofollow');

    const feed = await page.request.get('/site/feed.xml');
    expect(feed.status()).toBe(200);
    expect(feed.headers()['content-type']).toBe('application/atom+xml; charset=utf-8');
    const xml = await feed.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(xml).not.toContain(runtime.draftNewsTitle);
    expect(xml).not.toContain('<img');
  } finally {
    await context.close();
  }
});
