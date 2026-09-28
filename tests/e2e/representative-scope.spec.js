// E2E: przedstawiciel klasy widzi w /families/ wyłącznie przypisaną klasę
// (SR-01b — granica ról egzekwowana po stronie serwera, nie tylko w UI).
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

test.use({ viewport: { width: 1280, height: 900 } });

test('przedstawiciel klasy widzi wyłącznie swoją klasę w families/', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([{
    name: 'rd_session',
    value: runtime.representative.cookie,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  await page.goto('/families/');

  await expect(page.locator('#classes-view')).toBeVisible();
  const classLinks = page.locator('#years a');
  await expect(classLinks).toHaveCount(1);
  await expect(classLinks.first()).toContainText('1A');
  await expect(page.locator('#years')).not.toContainText('2B');

  // Kontrola po stronie serwera, nie tylko ukryty element w UI (AGENTS.md):
  // API też nie zwraca drugiej klasy, a bezpośrednie żądanie o niej daje 403/404.
  // Nagłówek Cookie jawnie (zamiast polegać na współdzielonym cookie jar
  // page.request) — cookie sesji jest HttpOnly+Secure i tak nadany ręcznie w teście.
  const authHeaders = { Cookie: `rd_session=${runtime.representative.cookie}` };
  const access = await page.request.get('/api/access', { headers: authHeaders });
  expect(access.status()).toBe(200);
  const accessBody = await access.json();
  const classIds = accessBody.grants.map((grant) => grant.classId).filter(Boolean);
  expect(classIds).toContain(runtime.classRepId);
  expect(classIds).not.toContain(runtime.classOtherId);

  const otherClass = await page.request.get(
    `/api/classes/${encodeURIComponent(runtime.classOtherId)}/students`,
    { headers: authHeaders },
  );
  expect([403, 404]).toContain(otherClass.status());

  await context.close();
});
