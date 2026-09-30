// E2E (przegląd demo 5, propozycje 2 i 3): nagłówek wszystkich paneli wygląda tak samo
// przy przełączaniu ekranów — ta sama wysokość, marka i nazwa konta bez łamania,
// jeden krój tytułu <h1> — a linki w treści mają kolor projektu, nie domyślny
// niebieski przeglądarki. Mierzone przy 1280 i 390 px dla członka zarządu
// (13 paneli w nawigacji — najdłuższy pasek). Dane syntetyczne (support/server.js).
// Test statyczny tych samych reguł: tests/panel-header-static.test.js.
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

const PANELS = ['/families/', '/panel/', '/ledger/', '/email/', '/reconciliation/', '/print/', '/events/', '/meetings/',
  '/documents/', '/import/', '/year-close/', '/data-export/', '/news/'];

function measure() {
  const header = document.querySelector('header.shell-header');
  const brand = header?.querySelector('.brand .brand-name');
  const name = header?.querySelector('.shell-account-name');
  const h1 = document.querySelector('main h1');
  const lineCount = (el) => (el ? Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) : 0);
  const links = [...document.querySelectorAll('main a, dialog a')].filter((a) => a.getBoundingClientRect().width > 0);
  return {
    header: Math.round(header?.getBoundingClientRect().height ?? 0),
    brandLines: lineCount(brand),
    nameLines: lineCount(name),
    h1Font: h1 ? getComputedStyle(h1).fontFamily : null,
    defaultBlueLinks: links.map((a) => getComputedStyle(a).color).filter((c) => c === 'rgb(0, 0, 238)' || c === 'rgb(85, 26, 139)').length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

for (const width of [1280, 390]) {
  test(`nagłówek paneli przy ${width} px: jedna wysokość, marka i konto w jednej linii, jeden krój tytułu, linki w stylu projektu`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'pl-PL', timezoneId: 'Europe/Brussels' });
    await context.addCookies([{ name: 'rd_session', value: runtime.boardDocs.cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const results = {};
    for (const path of PANELS) {
      await page.goto(path);
      await expect(page.locator('#shell-nav a').first()).toBeVisible();
      await expect(page.locator('.shell-account-name')).toBeVisible();
      results[path] = await page.evaluate(measure);
    }
    const heights = new Set(Object.values(results).map((r) => r.header));
    expect(heights.size, JSON.stringify(results)).toBe(1);
    const fonts = new Set(Object.values(results).map((r) => r.h1Font));
    expect(fonts.size, JSON.stringify(results)).toBe(1);
    expect([...fonts][0]).not.toMatch(/Georgia/);
    for (const [path, r] of Object.entries(results)) {
      expect(r.brandLines, `${path}: marka`).toBe(1);
      // Na telefonie długa nazwa konta może się złamać (bez poziomego przewijania).
      if (width === 1280) expect(r.nameLines, `${path}: nazwa konta`).toBe(1);
      expect(r.defaultBlueLinks, `${path}: domyślny niebieski link`).toBe(0);
      expect(r.overflow, `${path}: poziome przewijanie`).toBeLessThanOrEqual(0);
    }
    // Przy 1280 px nagłówek mieści się w dwóch wierszach (marka + konto, nawigacja).
    if (width === 1280) expect([...heights][0]).toBeLessThanOrEqual(120);
    await context.close();
  });
}
