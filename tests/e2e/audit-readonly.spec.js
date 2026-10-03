// E2E (D-09, #137): widok tylko do odczytu Komisji Rewizyjnej (rola `audit`) w panelach ledger/ i
// documents/, gdy serwer ma włączoną flagę AUDIT_LEDGER_READ (tests/e2e/support/server.js ustawia ją
// na 1; rok e2e-y-auditro, dane syntetyczne). Sprawdza, że panel nie renderuje żadnej akcji zapisu
// (ukrycie przycisku NIE jest kontrolą dostępu — serwer odmawia zapisów: tests/pg-audit-ledger-read.test.js),
// nie woła tras zapisu ani tras, których audit nie ma, oraz że wpisy powiązane z wpłatą rodziny mają
// zredagowany opis. Kontrast: skarbnik tego samego roku ma pełny widok z formularzami.
import { expect, test } from '@playwright/test';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();
const { audit } = runtime;
const [invoice] = audit.documents;
const REDACTED = 'Wpłata rodziny (opis i źródło zredagowane)';
// Znaczniki wolnego tekstu rodzin i dokumentów niewidocznych dla audit — nie mogą trafić do żadnego panelu.
const HIDDEN_MARKERS = ['MRK-OPIS-RODZINY', 'MRK-ZRODLO-RODZINY', 'MRK-UCHWALA-RODZINY', 'MRK-NIEWIDOCZNE', 'MRK-OPIS-WOLNY-TEKST'];

async function pageAs(browser, cookie) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{
    name: 'rd_session', value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  const violations = [];
  const apiCalls = [];
  page.on('console', (message) => {
    if (/content security policy|refused to|Warning:/i.test(message.text())) violations.push(message.text());
  });
  page.on('pageerror', (error) => violations.push(`pageerror: ${error.message}`));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiCalls.push(`${request.method()} ${url.pathname}`);
  });
  return { context, page, violations, apiCalls };
}

// Żądanie z ciasteczkiem sesji, jak kliknięcie linku w panelu (ciasteczko Secure działa w przeglądarce
// także na http://127.0.0.1, ale nie w kliencie żądań Playwright).
function fetchInPage(page, url) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: 'same-origin' });
    const text = response.headers.get('content-type')?.startsWith('application/pdf') ? '' : await response.text();
    return { status: response.status, type: response.headers.get('content-type') ?? '', text };
  }, url);
}

async function expectNoHiddenMarkers(page) {
  const text = await page.locator('body').innerText();
  for (const marker of HIDDEN_MARKERS) expect(text, marker).not.toContain(marker);
}

test('GET /api/session: capabilities.auditLedgerRead dla audit, bez pola dla skarbnika', async ({ browser }) => {
  const auditPage = await pageAs(browser, audit.cookie);
  await auditPage.page.goto('/site/');
  const asAudit = JSON.parse((await fetchInPage(auditPage.page, '/api/session')).text);
  expect(asAudit.capabilities).toEqual({ auditLedgerRead: true });
  const treasurerPage = await pageAs(browser, audit.treasurerCookie);
  await treasurerPage.page.goto('/site/');
  const asTreasurer = JSON.parse((await fetchInPage(treasurerPage.page, '/api/session')).text);
  expect(asTreasurer).not.toHaveProperty('capabilities');
  await auditPage.context.close();
  await treasurerPage.context.close();
});

test('ledger/: audit widzi listę, podsumowanie i eksport; nie ma żadnej akcji zapisu ani sekcji preliminarza', async ({ browser }) => {
  const { context, page, violations, apiCalls } = await pageAs(browser, audit.cookie);
  await page.goto('/ledger/');
  await expect(page.locator('#entries-body tr')).toHaveCount(2, { timeout: 10_000 });

  // Nawigacja: Księga i Dokumenty pojawiają się dla audit dopiero przy fladze serwera.
  const nav = page.locator('#shell-nav');
  await expect(nav.getByRole('link', { name: 'Księga' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Dokumenty' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Wpłaty' })).toHaveCount(0);

  // Widok tylko do odczytu: komunikat o zakresie, brak komunikatu „To konto nie ma dostępu”.
  await expect(page.locator('#audit-notice')).toBeVisible();
  await expect(page.locator('#audit-notice')).toContainText('Widok tylko do odczytu');
  await expect(page.locator('#access-notice')).toBeHidden();
  await expect(page.locator('#filters-form')).toBeVisible();

  // Podsumowanie: przychody 50,00 EUR, wydatki 120,00 EUR.
  await expect(page.locator('#income-total')).toContainText('50,00');
  await expect(page.locator('#expense-total')).toContainText('120,00');

  // Wpis niepowiązany z wpłatą: opis bez zmian. Wpis powiązany z wpłatą rodziny: stały, zredagowany opis
  // i znacznik „wpłata rodziny”, bez wolnego tekstu (opis, źródło, uchwała).
  await expect(page.locator('#entries-body')).toContainText('Wynajem sali na spotkanie Rady (syntetyczny)');
  const linked = page.locator('#entries-body tr', { hasText: REDACTED });
  await expect(linked).toHaveCount(1);
  await expect(linked.locator('.badge.payment-linked')).toHaveText('wpłata rodziny');
  await expectNoHiddenMarkers(page);

  // Żadnych akcji zapisu w DOM (usunięte, nie tylko ukryte): przyciski, okna, formularze, kolumna akcji.
  for (const selector of ['#open-entry', '#open-entry-hint', 'dialog', '.row-actions', '#col-actions-head', '#budget-actions', '#opening-actions',
    '#budget-section', '#history-section', '#events-section', '#open-category', '#open-copy', '#open-deactivate', '#open-line', '#open-revision',
    '#open-adoption', '#open-opening', 'input[type="file"]']) {
    await expect(page.locator(selector), selector).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: /Korekta|Dodaj wpis|Zapisz|Przeksięg/ })).toHaveCount(0);
  // Zostają odczyt: filtry, wydruk i eksport całego roku.
  await expect(page.locator('#print-ledger')).toBeVisible();
  const csv = page.locator('#export-csv');
  const xlsx = page.locator('#export-xlsx');
  await expect(csv).toBeVisible();
  await expect(xlsx).toBeVisible();
  await expect(csv).toHaveAttribute('href', `/api/ledger/export.csv?schoolYearId=${audit.schoolYearId}`);
  await expect(xlsx).toHaveAttribute('href', `/api/ledger/export.xlsx?schoolYearId=${audit.schoolYearId}`);

  // Eksport (jak kliknięcie linku: żądanie z ciasteczkiem sesji): wpis powiązany z wpłatą ze znacznikiem, bez wolnego tekstu.
  const csvResponse = await fetchInPage(page, await csv.getAttribute('href'));
  expect(csvResponse.status).toBe(200);
  expect(csvResponse.type).toMatch(/text\/csv/);
  expect(csvResponse.text).toContain('wplata');
  for (const marker of HIDDEN_MARKERS) expect(csvResponse.text, marker).not.toContain(marker);
  const xlsxResponse = await fetchInPage(page, await xlsx.getAttribute('href'));
  expect(xlsxResponse.status).toBe(200);
  expect(xlsxResponse.type).toMatch(/spreadsheetml/);

  // Sieć: wyłącznie odczyt, tylko trasy dostępne dla audit (lista, kategorie, podsumowanie, eksport).
  const ledgerCalls = apiCalls.filter((call) => call.includes('/api/ledger'));
  expect(ledgerCalls.length).toBeGreaterThan(0);
  expect(ledgerCalls.every((call) => /^GET \/api\/ledger(\/categories|\/summary|\/export\.csv|\/export\.xlsx)?$/.test(call))).toBe(true);
  expect(apiCalls.filter((call) => !call.startsWith('GET '))).toEqual([]);
  expect(violations).toEqual([]);
  await context.close();
});

test('ledger/: skarbnik tego samego roku ma pełny widok (formularze, korekta, preliminarz) — kontrast dla widoku audit', async ({ browser }) => {
  const { context, page, violations } = await pageAs(browser, audit.treasurerCookie);
  await page.goto('/ledger/');
  await expect(page.locator('#entries-body tr')).toHaveCount(2, { timeout: 10_000 });
  await expect(page.locator('#audit-notice')).toBeHidden();
  await expect(page.locator('#audit-export')).toBeHidden();
  await expect(page.locator('#open-entry')).toBeVisible();
  await expect(page.locator('#budget-section')).toBeVisible();
  await expect(page.locator('dialog')).toHaveCount(9);
  await expect(page.getByRole('button', { name: 'Korekta' })).toHaveCount(2);
  // Skarbnik widzi pełny opis wpisu powiązanego z wpłatą (wolny tekst — jego dane).
  await expect(page.locator('#entries-body')).toContainText('MRK-OPIS-RODZINY');
  expect(violations).toEqual([]);
  await context.close();
});

test('documents/: audit widzi tylko dowody z dozwolonych kategorii, szczegóły bez opisu, podgląd i pobranie; bez przesyłania, opisu, zastąpienia i unieważnienia', async ({ browser }) => {
  const { context, page, violations, apiCalls } = await pageAs(browser, audit.cookie);
  await page.goto('/documents/');
  // Z trzech dokumentów roku widoczna jest wyłącznie faktura niepowiązana z wpłatą.
  await expect(page.locator('#documents-body tr')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('#documents-body')).toContainText(invoice.title);
  await expect(page.locator('#audit-notice')).toBeVisible();
  await expect(page.locator('#shell-nav').getByRole('link', { name: 'Dokumenty' })).toBeVisible();
  await expectNoHiddenMarkers(page);

  // Filtry zawężone do zakresu audit: rodzaj tylko „Dowód finansowy”, kategorie bez danych płatników.
  await expect(page.locator('#filter-kind option')).toHaveText(['Dowód finansowy']);
  const categories = await page.locator('#filter-category option').allTextContents();
  expect(categories).toContain('Faktura');
  for (const hidden of ['Potwierdzenie przelewu', 'Wyciąg bankowy', 'Inne']) expect(categories).not.toContain(hidden);

  // Brak akcji zapisu w DOM.
  for (const selector of ['#upload-section', '#upload-form', '#upload-file', '#description-form', '#description-block', '#status-block', '#status-form',
    '#status-supersede', '#status-void', '#filter-class', '#filter-search']) {
    await expect(page.locator(selector), selector).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: /Prześlij|Zapisz opis|Zastąp|Unieważnij/ })).toHaveCount(0);

  // Szczegóły: metadane bez opisu, podgląd i pobranie.
  await page.locator(`#documents-body button[data-id="${invoice.id}"]`).click();
  await expect(page.locator('#details-list')).toContainText(invoice.title);
  await expect(page.locator('#details-list')).toContainText('Faktura');
  await expect(page.locator('#details-download')).toHaveAttribute('href', `/api/documents/${invoice.id}/content`);
  await expect(page.locator('#details-preview')).toBeVisible();
  await expectNoHiddenMarkers(page);
  const preview = page.waitForResponse((r) => r.url().includes(`/api/documents/${invoice.id}/content?`));
  await page.locator('#details-preview').click();
  expect((await preview).status()).toBe(200);
  await expect(page.locator('#preview-pdf canvas')).toBeVisible({ timeout: 15_000 });
  const download = await fetchInPage(page, `/api/documents/${invoice.id}/content`);
  expect(download.status).toBe(200);
  expect(download.type).toBe('application/pdf');

  // Sieć: wyłącznie odczyt; bez listy klas i bez sąsiednich odczytów łańcucha wersji.
  expect(apiCalls.filter((call) => !call.startsWith('GET '))).toEqual([]);
  expect(apiCalls.filter((call) => call.includes('/api/classes'))).toEqual([]);
  const metadataCalls = apiCalls.filter((call) => /^GET \/api\/documents\/[0-9a-f-]{36}$/.test(call));
  expect(metadataCalls).toEqual([`GET /api/documents/${invoice.id}`]);
  expect(violations).toEqual([]);
  await context.close();
});

test('documents/: skarbnik tego samego roku widzi wszystkie trzy dokumenty i formularze zapisu — kontrast dla widoku audit', async ({ browser }) => {
  const { context, page, violations } = await pageAs(browser, audit.treasurerCookie);
  await page.goto('/documents/');
  await expect(page.locator('#documents-body tr')).toHaveCount(audit.documents.length, { timeout: 10_000 });
  await expect(page.locator('#audit-notice')).toBeHidden();
  await expect(page.locator('#upload-form')).toBeVisible();
  await expect(page.locator('#description-form')).toBeAttached();
  await expect(page.locator('#filter-search')).toBeVisible();
  expect(violations).toEqual([]);
  await context.close();
});
