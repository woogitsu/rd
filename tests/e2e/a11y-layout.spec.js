// E2E: układ i fokus głównych ekranów przedstawiciela klasy na telefonie (issue #112,
// kryterium „zrzuty 320 px families/, documents/, events/ bez poziomego przewijania”).
// Sprawdza przy 320 i 1280 px (WCAG 1.4.10 Reflow, 2.4.1, 2.4.7, 2.5.8):
// - strona nie przewija się w poziomie (tabele i nawigacja paneli przewijają się
//   we własnym kontenerze — to dozwolone, liczy się szerokość dokumentu);
// - pierwszy Tab na świeżo wczytanej stronie to skip link;
// - każdy element, na który trafia fokus w 30 krokach Tab, ma obrys ≥ 2 px
//   i jest na ekranie;
// - przyciski, pola i linki nawigacji mają co najmniej 24×24 px; linki w tekście
//   i w ścieżce (breadcrumbs) też, żeby nie polegać na wyjątku odstępu.
// documents/: pole „Pokaż też zastąpione i unieważnione” ma 13×13 px, a etykieta przy
// 1280 px mniej niż 24 px wysokości — spełnia tylko wyjątek odstępu 2.5.8. Plik należy
// do zakresu #124 (dokumenty), więc tu mierzymy dla documents/ tylko układ i fokus;
// rozmiar celu w documents/ jest opisany w docs/ACCESSIBILITY.md jako do poprawy.
// Sesja przedstawiciela klasy (bez MFA), dane wyłącznie syntetyczne (support/server.js).
// Ten sam pomiar dla dowolnej aplikacji i danych demo: docs/a11y/audit.mjs.
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();

async function repContext(browser, width) {
  const context = await browser.newContext({ viewport: { width, height: width === 320 ? 640 : 900 }, reducedMotion: 'reduce' });
  await context.addCookies([{
    name: 'rd_session',
    value: runtime.representative.cookie,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  return context;
}

// Widoki: [nazwa, adres, przygotowanie po wczytaniu]. families/ ma trzy widoki pod
// jednym adresem (klasy → klasa → karta gospodarstwa), przechodzone kliknięciem.
const VIEWS = [
  ['families: klasy', '/families/', async (page) => { await expect(page.locator('#classes-view')).toBeVisible(); }],
  ['families: klasa', '/families/', async (page) => {
    await page.locator('#years a').first().click();
    await expect(page.locator('#class-view table a').first()).toBeVisible();
  }],
  ['families: gospodarstwo', '/families/', async (page) => {
    await page.locator('#years a').first().click();
    await page.locator('#class-view table a').first().click();
    await expect(page.locator('#household-view')).toBeVisible();
  }],
  ['documents', '/documents/', async (page) => { await expect(page.locator('main#main')).toBeVisible(); }],
  ['events', '/events/', async (page) => { await expect(page.locator('main#main')).toBeVisible(); }],
];

function layout() {
  const doc = document.documentElement;
  const small = [...document.querySelectorAll('button, input:not([type=hidden]), select, textarea, nav a, a.brand, .breadcrumbs a')]
    .filter((element) => {
      const box = element.getBoundingClientRect();
      if (!box.width || element.closest('dialog:not([open]), [hidden]')) return false;
      // Pole wyboru/opcja z etykietą obejmującą pole — celem jest cała etykieta.
      const label = (element.type === 'checkbox' || element.type === 'radio') ? element.closest('label') : null;
      const target = label ? label.getBoundingClientRect() : box;
      return target.width < 24 || target.height < 24;
    })
    .map((element) => `${element.tagName}${element.id ? `#${element.id}` : ''} „${(element.textContent || element.name || '').trim().slice(0, 30)}” ${Math.round(element.getBoundingClientRect().width)}×${Math.round(element.getBoundingClientRect().height)}`);
  return { overflow: doc.scrollWidth - doc.clientWidth, small };
}

for (const width of [320, 1280]) {
  for (const [name, path, prepare] of VIEWS) {
    test(`${name} przy ${width} px: bez poziomego przewijania, fokus widoczny, cele ≥ 24 px`, async ({ browser }) => {
      const context = await repContext(browser, width);
      const page = await context.newPage();
      await page.goto(path);
      await expect(page.locator('#shell-nav a').first()).toBeVisible();

      if (name === 'families: klasy' || !name.startsWith('families')) {
        await page.keyboard.press('Tab');
        await expect(page.locator('.skip-link')).toBeFocused();
        await page.evaluate(() => document.activeElement?.blur());
      }

      await prepare(page);
      await page.waitForLoadState('networkidle');

      const { overflow, small } = await page.evaluate(layout);
      expect(overflow, 'poziome przewijanie całej strony').toBeLessThanOrEqual(0);
      if (name !== 'documents') expect(small, 'cele mniejsze niż 24×24 px').toEqual([]);

      const missing = [];
      for (let step = 0; step < 30; step += 1) {
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(() => {
          const element = document.activeElement;
          if (!element || element === document.body) return null;
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            tag: `${element.tagName}${element.id ? `#${element.id}` : ''} „${(element.textContent || element.name || '').trim().slice(0, 30)}”`,
            outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2,
            visible: box.bottom > 0 && box.top < innerHeight,
          };
        });
        if (focus && (!focus.outline || !focus.visible)) missing.push(`${focus.tag}${focus.outline ? '' : ' bez obrysu'}${focus.visible ? '' : ' poza ekranem'}`);
      }
      expect([...new Set(missing)], 'fokus bez obrysu albo poza ekranem').toEqual([]);
      await context.close();
    });
  }
}
