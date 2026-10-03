// E2E: wyszukiwanie ucznia na liście klasy w families/ przy 320 px (issue #128, kryterium
// „wyszukiwanie w klasie działa na telefonie 320 px, wynik ogłaszany (aria-live=polite),
// pusty wynik ma komunikat »Brak uczniów pasujących do …«”). Wcześniej tylko funkcje
// filtra (tests/families-core.test.js) i układ (a11y-layout.spec.js) — bez wpisywania.
// Przedstawiciel jedynej klasy 3C z ośmioma wymyślonymi uczniami (support/server.js,
// osobny rok e2e-y-search); sesja bez MFA, dane wyłącznie syntetyczne.
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();
const { classSearch } = runtime;
// Panel pokazuje „Nazwisko Imię”, posortowane po nazwisku wg alfabetu polskiego.
const displayName = ({ firstName, lastName }) => `${lastName} ${firstName}`;
const ALL = classSearch.students.map(displayName);
const WIDTH = 320;

async function openClass(browser) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: 640 }, hasTouch: true, reducedMotion: 'reduce' });
  await context.addCookies([{
    name: 'rd_session',
    value: classSearch.cookie,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  await page.goto('/families/');
  await page.locator('#years a').first().click();
  await expect(page.locator('#class-view')).toBeVisible();
  await expect(page.locator('#class-title')).toHaveText(`Klasa ${classSearch.className}`);
  return { context, page };
}

const names = (page) => page.locator('#students-body tr td:first-child').allTextContents();
const horizontalOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function type(page, text) {
  const input = page.getByLabel('Szukaj ucznia');
  await input.fill('');
  await input.click();
  await input.pressSequentially(text);
}

test('klasa przy 320 px: pole wyszukiwania mieści się na ekranie, ma etykietę i ogłasza liczbę uczniów', async ({ browser }) => {
  const { context, page } = await openClass(browser);
  const input = page.getByLabel('Szukaj ucznia');
  await expect(input).toBeVisible();
  const box = await input.boundingBox();
  expect(box.x, 'pole zaczyna się w ekranie').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'pole kończy się w ekranie').toBeLessThanOrEqual(WIDTH);
  expect(box.height, 'wysokość celu dotykowego (WCAG 2.5.8)').toBeGreaterThanOrEqual(24);

  const status = page.locator('#student-search-count');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect(input).toHaveAttribute('aria-describedby', 'student-search-count');
  await expect(status).toHaveText(`${ALL.length} uczniów`);
  expect((await names(page)).sort()).toEqual([...ALL].sort());
  expect(await horizontalOverflow(page), 'poziome przewijanie całej strony').toBeLessThanOrEqual(0);
  await context.close();
});

test('klasa przy 320 px: wpisanie nazwiska zawęża listę, licznik w regionie status, Enter nie przeładowuje widoku', async ({ browser }) => {
  const { context, page } = await openClass(browser);
  await type(page, 'testowy');
  await expect(page.locator('#student-search-count')).toHaveText(`2 z ${ALL.length} uczniów`);
  expect((await names(page)).sort()).toEqual(['Testowy Jan', 'Testowy Łukasz']);
  await expect(page.locator('#students-empty')).toBeHidden();

  // Wielkość liter i fragment nazwiska nie mają znaczenia.
  await type(page, 'PRZYKŁAD');
  await expect(page.locator('#student-search-count')).toHaveText(`2 z ${ALL.length} uczniów`);
  expect((await names(page)).sort()).toEqual(['Przykładowa Maja', 'Przykładowa Żaneta']);

  // Enter w polu wyszukiwania nie wysyła formularza ani nie zmienia widoku.
  const urlBefore = page.url();
  await page.getByLabel('Szukaj ucznia').press('Enter');
  expect(page.url()).toBe(urlBefore);
  await expect(page.locator('#class-view')).toBeVisible();
  expect((await names(page)).sort()).toEqual(['Przykładowa Maja', 'Przykładowa Żaneta']);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await context.close();
});

test('klasa przy 320 px: polskie litery można wpisać bez znaków diakrytycznych, także „ł”', async ({ browser }) => {
  const { context, page } = await openClass(browser);
  await type(page, 'lukasz');
  expect((await names(page)).sort()).toEqual(['Testowy Łukasz', 'Łukaszewska-Próbna Zofia'].sort());
  await type(page, 'zaneta');
  expect(await names(page)).toEqual(['Przykładowa Żaneta']);
  await type(page, 'probn');
  expect((await names(page)).sort()).toEqual(['Próbna Helena', 'Próbny Ignacy', 'Łukaszewska-Próbna Zofia'].sort());
  await context.close();
});

test('klasa przy 320 px: pusty wynik pokazuje komunikat z wpisanym tekstem, a po wyczyszczeniu wraca cała lista', async ({ browser }) => {
  const { context, page } = await openClass(browser);
  await type(page, 'xyz');
  await expect(page.locator('#students-body tr')).toHaveCount(0);
  const empty = page.locator('#students-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toHaveText('Brak uczniów pasujących do „xyz”.');
  await expect(page.locator('#student-search-count')).toHaveText(`0 z ${ALL.length} uczniów`);
  const box = await empty.boundingBox();
  expect(box.x + box.width, 'komunikat mieści się w ekranie').toBeLessThanOrEqual(WIDTH);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.getByLabel('Szukaj ucznia').fill('');
  await expect(empty).toBeHidden();
  await expect(page.locator('#student-search-count')).toHaveText(`${ALL.length} uczniów`);
  expect((await names(page)).sort()).toEqual([...ALL].sort());
  await context.close();
});

test('klasa przy 320 px: wpisany tekst jest pokazany jako tekst (bez znaczników), a długi ciąg nie poszerza strony', async ({ browser }) => {
  const { context, page } = await openClass(browser);
  await type(page, '<b>x</b>');
  await expect(page.locator('#students-empty')).toHaveText('Brak uczniów pasujących do „<b>x</b>”.');
  await expect(page.locator('#students-empty b')).toHaveCount(0);

  await page.getByLabel('Szukaj ucznia').fill('a'.repeat(150));
  await expect(page.locator('#students-empty')).toBeVisible();
  expect(await horizontalOverflow(page), 'długie zapytanie w komunikacie nie przewija strony w poziomie').toBeLessThanOrEqual(0);
  const box = await page.locator('#students-empty').boundingBox();
  expect(box.x + box.width, 'komunikat mieści się w ekranie').toBeLessThanOrEqual(WIDTH);
  await context.close();
});
