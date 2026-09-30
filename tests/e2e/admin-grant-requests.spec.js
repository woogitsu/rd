// E2E (#146): sekcja „Wnioski o nadanie roli” w panelu „Konta i role”.
// Wnioski złożył inny administrator (tests/e2e/support/server.js); zatwierdza
// e2e-admin-grants z własnym czynnikiem TOTP. Sprawdza: listę (kto, dla kogo,
// rola, zakres, wiek), brak „Zatwierdź” przy własnym wniosku, okno potwierdzenia
// nazywające akcję, krok w górę MFA, jednorazowy link zaproszenia, odrzucenie
// i podwójne kliknięcie „Zatwierdź” = jeden przydział. Dane syntetyczne, bez e-maili.
import { expect, test } from '@playwright/test';
import { base32Decode, totp } from '../../src/pg/mfa.js';
import { readRuntime } from './support/runtime.js';

const runtime = readRuntime();
const approver = runtime.adminGrants;

async function adminPage(browser, cookie) {
  const context = await browser.newContext();
  await context.addCookies([{
    name: 'rd_session', value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  await page.goto('/admin/');
  await expect(page.locator('h1')).toHaveText('Konta i przydziały ról');
  await expect(page.locator('#grant-requests-summary')).toContainText('Oczekujące wnioski');
  return { context, page };
}

const requestRow = (page, id) => page.locator(`#grant-requests-body tr[data-request-id="${id}"]`);

async function apiJson(page, path) {
  return page.evaluate(async (url) => (await fetch(url, { credentials: 'same-origin' })).json(), path);
}

test('lista wniosków; własny bez „Zatwierdź”; zatwierdzenie zaproszenia z krokiem MFA i linkiem pokazanym raz', async ({ browser }) => {
  const { context, page } = await adminPage(browser, approver.staleCookie);
  const { requests } = runtime.adminGrants;

  // Lista: kto wnioskuje, dla kogo, rola, zakres, wiek wniosku.
  const invitationRow = requestRow(page, requests.approveInvitation);
  await expect(invitationRow).toContainText('e2e-admin');
  await expect(invitationRow).toContainText(approver.invitationEmail);
  await expect(invitationRow).toContainText('Zarząd');
  await expect(invitationRow).toContainText('rok');
  await expect(invitationRow).toContainText(/przed chwilą|min temu/);
  await expect(invitationRow).toContainText('Oczekuje');

  // Własny wniosek: brak przycisku „Zatwierdź”, jest tylko „Wycofaj wniosek”.
  const ownRow = requestRow(page, requests.own);
  await expect(ownRow).toBeVisible();
  await expect(ownRow.getByRole('button', { name: 'Zatwierdź' })).toHaveCount(0);
  await expect(ownRow.getByRole('button', { name: 'Wycofaj wniosek' })).toBeVisible();
  await expect(ownRow).toContainText('inny administrator');

  // Okno potwierdzenia nazywa akcję i skutki; anulowanie nic nie zmienia.
  const dialog = page.locator('#shared-confirm-dialog');
  const confirmButton = dialog.locator('[data-role=confirm]');
  await invitationRow.getByRole('button', { name: 'Zatwierdź' }).click();
  await expect(dialog.locator('#shared-confirm-title')).toHaveText('Zatwierdzić nadanie roli?');
  await expect(confirmButton).toHaveText('Zatwierdź i wydaj link');
  await expect(dialog).toContainText(`Adres zaproszenia: ${approver.invitationEmail}`);
  await expect(dialog).toContainText('tylko raz');
  await expect(dialog.locator('[data-role=cancel]')).toBeFocused();
  await dialog.locator('[data-role=cancel]').click();
  await expect(dialog).toBeHidden();
  await expect(invitationRow).toContainText('Oczekuje');

  // Zatwierdzenie: serwer żąda świeżego MFA (403 mfa_stale) — panel prosi o kod.
  await invitationRow.getByRole('button', { name: 'Zatwierdź' }).click();
  await confirmButton.click();
  await expect(dialog.locator('#shared-confirm-title')).toHaveText('Potwierdź kodem z aplikacji');
  await expect(page.locator('#request-token-box')).toBeHidden();
  await dialog.locator('#shared-confirm-input').fill(totp(base32Decode(approver.totpSecret), Date.now()));
  await confirmButton.click();

  await expect(page.locator('#request-token-box')).toBeVisible();
  const link = (await page.locator('#request-link').innerText()).trim();
  expect(link).toMatch(/\/login\/#invite=[A-Za-z0-9_-]{20,}$/);
  const token = link.split('#invite=')[1];
  await expect(page.locator('#global-message')).toContainText('Wniosek zatwierdzony');
  // Wniosek zniknął z listy oczekujących; zaproszenie jest na liście (bez tokenu).
  await expect(invitationRow).toHaveCount(0);
  await expect(page.locator('#invitations-body')).toContainText(approver.invitationEmail);
  await expect(page.locator('#audit-body')).toContainText('Zatwierdzenie nadania roli chronionej');
  expect(await page.locator('#audit-body').innerText()).not.toContain(token);

  // Lista wniosków (także „Wszystkie”) nigdy nie zwraca tokenu.
  const all = await apiJson(page, '/api/admin/grant-requests?status=all');
  expect(JSON.stringify(all)).not.toContain(token);
  expect(all.requests.find((item) => item.id === requests.approveInvitation).status).toBe('approved');

  // „Zamknij” usuwa link z DOM; po przeładowaniu strony też go nie ma.
  await page.locator('#hide-request-token').click();
  await expect(page.locator('#request-token-box')).toBeHidden();
  expect(await page.content()).not.toContain(token);
  await page.reload();
  await expect(page.locator('#grant-requests-summary')).toContainText('Oczekujące wnioski');
  await expect(page.locator('#request-token-box')).toBeHidden();
  expect(await page.content()).not.toContain(token);
  await context.close();
});

test('odrzucenie wniosku i podwójne kliknięcie „Zatwierdź” — jeden przydział', async ({ browser }) => {
  const { context, page } = await adminPage(browser, approver.freshCookie);
  const { requests } = runtime.adminGrants;
  const dialog = page.locator('#shared-confirm-dialog');
  const confirmButton = dialog.locator('[data-role=confirm]');

  // Odrzucenie: okno nazywa akcję; wniosek znika z oczekujących, przydziału brak.
  const rejectRow = requestRow(page, requests.reject);
  await rejectRow.getByRole('button', { name: 'Odrzuć' }).click();
  await expect(dialog.locator('#shared-confirm-title')).toHaveText('Odrzucić wniosek?');
  await expect(confirmButton).toHaveText('Odrzuć wniosek');
  await confirmButton.click();
  await expect(page.locator('#global-message')).toContainText('Wniosek odrzucony');
  await expect(rejectRow).toHaveCount(0);
  const rejectedGrants = await apiJson(page, '/api/admin/grants?userId=e2e-grant-reject&status=all');
  expect(rejectedGrants.grants).toHaveLength(0);

  // Podwójne kliknięcie „Zatwierdź” w oknie: jedno żądanie, jeden przydział.
  const approveRequests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes(`/api/admin/grant-requests/${requests.approveGrant}/approve`)) {
      approveRequests.push(request.url());
    }
  });
  const grantRow = requestRow(page, requests.approveGrant);
  await expect(grantRow).toContainText('Skarbnik');
  await grantRow.getByRole('button', { name: 'Zatwierdź' }).click();
  await expect(confirmButton).toHaveText('Zatwierdź i nadaj rolę');
  await expect(dialog).toContainText('Konto: e2e-grant-target');
  await confirmButton.dblclick();
  await expect(page.locator('#global-message')).toContainText('rola nadana');
  await expect(grantRow).toHaveCount(0);
  expect(approveRequests).toHaveLength(1);

  // Ponowienie po stronie serwera (np. druga karta): 409, nadal jeden przydział.
  const replay = await page.evaluate(async (id) => {
    const res = await fetch(`/api/admin/grant-requests/${id}/approve`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return { status: res.status, body: await res.json() };
  }, requests.approveGrant);
  expect(replay.status).toBe(409);
  expect(replay.body.error).toBe('grant_request_closed');
  const grants = await apiJson(page, '/api/admin/grants?userId=e2e-grant-target&status=all');
  expect(grants.grants).toHaveLength(1);
  expect(grants.grants[0].role).toBe('treasurer');
  const audit = await apiJson(page, '/api/admin/audit?limit=200');
  const approvals = audit.events.filter((event) => event.action === 'role_grant_request.approved' && event.entityId === requests.approveGrant);
  expect(approvals).toHaveLength(1);

  // Własny wniosek można wycofać (bez zatwierdzania).
  const ownRow = requestRow(page, requests.own);
  await ownRow.getByRole('button', { name: 'Wycofaj wniosek' }).click();
  await expect(dialog.locator('#shared-confirm-title')).toHaveText('Wycofać wniosek?');
  await confirmButton.click();
  await expect(page.locator('#global-message')).toContainText('Wniosek wycofany');
  await expect(ownRow).toHaveCount(0);

  // Filtr „Odrzucone” pokazuje oba zamknięte wnioski bez akcji.
  await page.locator('#grant-request-filters select[name=status]').selectOption('rejected');
  await page.locator('#grant-request-filters button[type=submit]').click();
  await expect(requestRow(page, requests.reject)).toContainText('Odrzucony');
  await expect(requestRow(page, requests.own)).toContainText('Odrzucony');
  await expect(page.locator('#grant-requests-body button')).toHaveCount(0);
  await context.close();
});
