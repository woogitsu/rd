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
