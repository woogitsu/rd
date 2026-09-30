// E2E (przegląd demo 5, propozycja 4; #99/#568): anonim otwierający panel dostawał 3–4
// odpowiedzi 401 w konsoli (powłoka i panel pytały /api/access i /api/session równolegle),
// zanim nastąpiło przekierowanie na /login/. Teraz pierwsze żądanie strony to jedno
// GET /api/session (shared/shell.js mountShell → checkSession w shared/api.js); pozostałe
// czekają na jego wynik, a po 401 nie wychodzą z przeglądarki. Serwer nadal rozstrzyga
// o sesji — ten test sprawdza tylko liczbę żądań i cel przekierowania.
// Nieaktualna wskazówka sesji: to samo jedno 401, a /login/ po nim już nie pyta /api/auth/state.
// Zalogowany (sesja przez cookie, bez wskazówki w localStorage): panel działa jak dotąd.
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

const PANELS = ['/families/', '/panel/', '/ledger/', '/email/', '/reconciliation/', '/print/', '/events/', '/meetings/',
  '/documents/', '/import/', '/year-close/', '/audit/', '/data-export/', '/news/', '/admin/'];

// Wszystkie żądania API w tej karcie: panel i ekran logowania (który bez wskazówki sesji
// nie pyta serwera — #568), więc każde policzone żądanie pochodzi z panelu.
function trackApi(page) {
  const requests = [];
  const failures = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname);
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  return { requests, failures };
}

for (const path of PANELS) {
  test(`anonim na ${path}: najwyżej jedno żądanie API (401) i przekierowanie na /login/ z next`, async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const api = trackApi(page);
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/login/#next=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await expect(page.locator('#view-login')).toBeVisible();
    // Czas na ewentualne spóźnione żądania z panelu (np. po .then()).
    await page.waitForTimeout(300);
    // Dokładnie jedno sprawdzenie sesji (401); nic więcej z panelu ani z /login/.
    expect(api.requests).toEqual(['/api/session']);
    expect(api.failures).toEqual(['401 /api/session']);
    expect(pageErrors).toEqual([]);
  });
}

test('nieaktualna wskazówka sesji w przeglądarce (sesja wygasła na serwerze): jedno 401 na /panel/, /login/ już nie pyta', async ({ page }) => {
  // Wskazówka z shared/session-hint.js (#568): sam czas wygaśnięcia, bez sekretu i danych konta.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-hint-set')) {
      sessionStorage.setItem('e2e-hint-set', '1');
      localStorage.setItem('rd.sessionExpiresAt', new Date(Date.now() + 60 * 60 * 1000).toISOString());
    }
  });
  const api = trackApi(page);
  await page.goto('/panel/');
  await expect(page).toHaveURL(/\/login\/#next=%2Fpanel%2F$/);
  await expect(page.locator('#view-login')).toBeVisible();
  await page.waitForTimeout(300);
  expect(api.requests).toEqual(['/api/session']);
  expect(api.failures).toEqual(['401 /api/session']);
  expect(await page.evaluate(() => localStorage.getItem('rd.sessionExpiresAt'))).toBeNull();
});

test('zalogowany (sesja przez cookie): panele działają bez 401 i bez przekierowania', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Brussels' });
  await context.addCookies([{ name: 'rd_session', value: runtime.boardDocs.cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const unauthorized = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() === 401) unauthorized.push(new URL(response.url()).pathname);
  });
  for (const path of ['/families/', '/panel/', '/ledger/', '/documents/', '/news/']) {
    await page.goto(path);
    await expect(page.locator('#shell-nav a').first()).toBeVisible();
    await expect(page.locator('.shell-account-name')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path);
  }
  expect(unauthorized).toEqual([]);
  await context.close();
});
