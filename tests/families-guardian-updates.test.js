// Ekran wniosków opiekunów o zmianę kontaktu (#140): czyste funkcje families/guardian-updates-core.js
// oraz statyczne sprawdzenie okablowania widoku. Dane wyłącznie syntetyczne (@example.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PAGE_LIMIT, buildListUrl, canDecide, confirmationText, decisionUrl, describeConsentChange,
  describeEmailChange, mergePage, pageState, resultMessage, suppressionWarning, summaryText, toRow,
} from '../families/guardian-updates-core.js';
import { parseRoute } from '../families/core.js';

const request = (over = {}) => ({
  id: 'req-1', guardianFirstName: 'Anna', classNames: ['1A', '3B'], proposedEmail: 'nowy@example.invalid',
  proposedContactAllowed: true, proposedEmailSuppression: null, note: 'Zmiana adresu', createdAt: '2026-09-29T10:00:00Z', ...over,
});

test('trasa i adresy: filtr statusu, kursor i identyfikator są walidowane i kodowane', () => {
  assert.deepEqual(parseRoute('#/guardian-updates'), { view: 'guardianUpdates' });
  assert.equal(buildListUrl('pending'), `/api/admin/guardian-update-requests?status=pending&limit=${PAGE_LIMIT}`);
  const url = new URL(buildListUrl('approved', 'a+b/c=', 20), 'https://x.invalid');
  assert.equal(url.searchParams.get('cursor'), 'a+b/c=');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.throws(() => buildListUrl('deleted'));
  assert.equal(decisionUrl('req-1', 'approve'), '/api/admin/guardian-update-requests/req-1/approve');
  assert.throws(() => decisionUrl('../x', 'approve'));
  assert.throws(() => decisionUrl('req-1', 'delete'));
});

test('zmiana: brak pola to „bez zmiany”, null to usunięcie adresu, wycofanie zgody jest nazwane wprost', () => {
  assert.equal(describeEmailChange({}).kind, 'none');
  assert.equal(describeEmailChange({ proposedEmail: null }).kind, 'clear');
  assert.deepEqual(describeEmailChange({ proposedEmail: 'a@example.invalid' }), { kind: 'set', text: 'a@example.invalid' });
  assert.equal(describeConsentChange({}).kind, 'none');
  assert.equal(describeConsentChange({ proposedContactAllowed: false }).kind, 'withdraw');
  assert.equal(describeConsentChange({ proposedContactAllowed: true }).kind, 'allow');
});

test('ostrzeżenie o liście wyłączeń (#94) tylko przy aktywnej blokadzie, bez skrótu adresu', () => {
  assert.equal(suppressionWarning(request()), null);
  const text = suppressionWarning(request({ proposedEmailSuppression: 'complaint' }));
  assert.match(text, /skarga/);
  assert.match(text, /nie zdejmuje blokady/);
  assert.match(suppressionWarning(request({ proposedEmailSuppression: 'inny_kod' })), /aktywna blokada/);
});

test('wiersz: klasy po przecinku, brak klas i imienia to „—”, data w formacie panelu', () => {
  const row = toRow(request());
  assert.equal(row.classes, '1A, 3B');
  assert.equal(row.guardian, 'Anna');
  assert.match(row.createdAt, /29\.09\.2026/);
  const empty = toRow(request({ guardianFirstName: null, classNames: [], createdAt: 'zły' }));
  assert.equal(empty.guardian, '—');
  assert.equal(empty.classes, '—');
  assert.equal(empty.createdAt, '—');
});

test('dociąganie stron: kolejność serwera, bez duplikatów, kursor i obcięcie z odpowiedzi', () => {
  const first = [request({ id: 'a' }), request({ id: 'b' })];
  const merged = mergePage(first, { requests: [request({ id: 'b' }), request({ id: 'c' })] });
  assert.deepEqual(merged.map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual(mergePage([], null), []);
  assert.deepEqual(pageState({ nextCursor: 'abc', truncated: true }), { nextCursor: 'abc', truncated: true });
  assert.deepEqual(pageState({ nextCursor: null, truncated: false }), { nextCursor: null, truncated: false });
  assert.match(summaryText('pending', 2, true), /są kolejne/);
  assert.match(summaryText('pending', 0, false), /brak wniosków/);
});

test('decyzja: tylko oczekujące; potwierdzenie opisuje skutek; wynik idempotentny', () => {
  assert.equal(canDecide('pending'), true);
  assert.equal(canDecide('approved'), false);
  const row = toRow(request());
  assert.match(confirmationText('approve', row), /historii zmian/);
  assert.match(confirmationText('reject', row), /nie zmieni danych/);
  assert.match(resultMessage('approve', { status: 'approved', changed: true }), /zaktualizowany/);
  assert.match(resultMessage('approve', { status: 'approved', changed: false }), /bez zmiany/);
  assert.match(resultMessage('reject', { status: 'rejected', changed: false }), /odrzucony/);
  // podwójne kliknięcie albo decyzja drugiej osoby: serwer zwraca stan, nie błąd
  assert.match(resultMessage('approve', { status: 'rejected', changed: false }), /już rozstrzygnięty/);
});

test('okablowanie: widok i okno w index.html, przyciski blokowane na czas żądania, bez innerHTML', () => {
  const html = readFileSync(new URL('../families/index.html', import.meta.url), 'utf8');
  for (const id of ['guardian-updates-view', 'gu-status', 'gu-body', 'gu-more', 'gu-dialog', 'gu-dialog-error']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  const ui = readFileSync(new URL('../families/guardian-updates.js', import.meta.url), 'utf8');
  assert.match(ui, /state\.busy\.has\(id\)/);
  assert.doesNotMatch(ui, /innerHTML/);
});
