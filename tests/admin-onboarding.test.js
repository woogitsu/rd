// Onboarding przedstawicieli w panelu admina (#108): czyste funkcje
// admin/onboarding.js i statyczne wymagania widoku. Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  batchRowError, batchSummary, canApplyBatch, coverageActivation, coverageState, coverageSummary, FIRST_LOGIN_RULES, FIRST_LOGIN_STEPS,
  invitationLinkFor, invitationsCount, newBatchKey, plural, printCardModel, schoolYearsCount, tokenListText,
} from '../admin/onboarding.js';

const fmt = (value) => `D(${value})`;
const html = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../admin/main.js', import.meta.url), 'utf8');

test('błąd wiersza podglądu: numer wiersza i polski tekst z shared/messages.js', () => {
  assert.equal(batchRowError({ row: 7, error: 'invalid_email' }), 'Wiersz 7: Podaj poprawny adres e-mail.');
  assert.match(batchRowError({ row: 2, error: 'duplicate_row' }), /^Wiersz 2: Ten sam adres i klasa/);
  assert.match(batchRowError({ row: 3, error: 'representative_already_assigned' }), /^Wiersz 3: /);
  assert.equal(batchRowError({ row: 1, error: null }), '');
});

test('zatwierdzenie tylko dla podglądu bez błędów', () => {
  assert.equal(canApplyBatch({ planDigest: 'a'.repeat(64), counts: { total: 2, valid: 2, invalid: 0 } }), true);
  assert.equal(canApplyBatch({ planDigest: 'a'.repeat(64), counts: { total: 2, valid: 1, invalid: 1 } }), false);
  assert.equal(canApplyBatch({ planDigest: 'a'.repeat(64), counts: { total: 0, valid: 0, invalid: 0 } }), false);
  assert.equal(canApplyBatch(null), false);
  assert.match(batchSummary({ counts: { total: 3, valid: 2, invalid: 1 } }), /błędnych: 1/);
  assert.match(batchSummary({ counts: { total: 2, valid: 2, invalid: 0 } }), /wszystkie naraz albo żadnego/);
});

test('klucz partii: jeden na podgląd, zgodny ze wzorcem Idempotency-Key', () => {
  const key = newBatchKey(() => '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(key, 'invb-123e4567-e89b-12d3-a456-426614174000');
  assert.match(key, /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/);
});

test('lista tokenów i kartka: link /login/#invite=, bez tokenu w zapytaniu', () => {
  const invitations = [
    { row: 1, className: '1A', email: 'rep.a@example.invalid', token: 'tok-a', expiresAt: 'X' },
    { row: 2, className: '1B', email: 'rep.b@example.invalid', expiresAt: 'Y' },
  ];
  assert.equal(invitationLinkFor('tok-a', 'https://rd.example.invalid'), 'https://rd.example.invalid/login/#invite=tok-a');
  assert.equal(tokenListText(invitations, 'https://rd.example.invalid', fmt),
    '1A · rep.a@example.invalid · https://rd.example.invalid/login/#invite=tok-a · ważne do D(X)', 'wiersz bez tokenu (ponowienie) pominięty');
  const card = printCardModel(invitations[0], { origin: 'https://rd.example.invalid', schoolYearLabel: 'Rok 2026/2027', formatDateTime: fmt });
  assert.match(card.title, /klasy 1A$/);
  assert.equal(card.link, 'https://rd.example.invalid/login/#invite=tok-a');
  assert.equal(card.expires, 'Link ważny do D(X).');
  assert.match(card.draftNotice, /do zatwierdzenia przez zarząd/);
  const named = printCardModel({ ...invitations[0], className: 'Klasa 0-A' }, { origin: 'https://rd.example.invalid', formatDateTime: fmt });
  assert.match(named.title, /przedstawiciel klasy 0-A$/, 'bez „klasy Klasa”');
});

test('liczebniki po polsku', () => {
  assert.deepEqual([1, 2, 4, 5, 12, 14, 22, 25, 112].map(invitationsCount), [
    '1 zaproszenie', '2 zaproszenia', '4 zaproszenia', '5 zaproszeń', '12 zaproszeń', '14 zaproszeń', '22 zaproszenia', '25 zaproszeń', '112 zaproszeń',
  ]);
  assert.equal(plural(3, 'wiersz', 'wiersze', 'wierszy'), '3 wiersze');
  assert.match(batchSummary({ counts: { total: 2, valid: 2, invalid: 0 } }), /^Do utworzenia: 2 zaproszenia\./);
});

test('instrukcja pierwszego logowania: bez obietnic funkcji, których nie ma, i bez etykiety „dłużnik”', () => {
  const text = [...FIRST_LOGIN_STEPS, ...FIRST_LOGIN_RULES].join(' ');
  assert.match(text, /12 znaków/, 'polityka haseł z src/pg/password.js');
  assert.match(text, /kodów odzyskiwania/);
  assert.match(text, /nie oznacza zaległości/);
  assert.doesNotMatch(text, /dłużnik|SMS|e-mailem otrzymasz|powiadomienie e-mail/i);
  assert.doesNotMatch(text, /@|https?:\/\//, 'bez adresów rzeczywistych w treści');
});

test('obsada klasy: stan słowny', () => {
  assert.equal(coverageState({ activeRepresentativeCount: 2, lastRepresentativeLoginOn: '2026-09-10' }).label, 'Przedstawiciel aktywny');
  assert.equal(coverageState({ activeRepresentativeCount: 1, lastRepresentativeLoginOn: null }).label, 'Konto bez logowania');
  assert.equal(coverageState({ activeRepresentativeCount: 0, pendingInvitationCount: 1 }).label, 'Zaproszenie oczekuje');
  assert.equal(coverageState({ activeRepresentativeCount: 0, pendingInvitationCount: 0 }).label, 'Brak przedstawiciela');
  assert.equal(coverageSummary([
    { activeRepresentativeCount: 0, pendingInvitationCount: 0 },
    { activeRepresentativeCount: 0, pendingInvitationCount: 2 },
    { activeRepresentativeCount: 1, pendingInvitationCount: 0 },
  ]), '3 klasy: bez przedstawiciela i bez zaproszenia 1, z oczekującym zaproszeniem 1.');
});

test('obsada klasy: stan aktywacji (bez logowania, MFA)', () => {
  assert.equal(coverageActivation({ activeRepresentativeCount: 0 }, true), '—');
  assert.equal(coverageActivation({ activeRepresentativeCount: 3, neverLoggedInRepresentativeCount: 1, mfaEnrolledRepresentativeCount: 2 }, true), 'bez logowania: 1 · MFA 2/3 (wymagane)');
  assert.equal(coverageActivation({ activeRepresentativeCount: 1, neverLoggedInRepresentativeCount: 0, mfaEnrolledRepresentativeCount: 0 }, false), 'wszyscy zalogowani · MFA 0/1');
  assert.equal(coverageState({ activeRepresentativeCount: 2, neverLoggedInRepresentativeCount: 2, lastRepresentativeLoginOn: null }).label, 'Konto bez logowania');
});

test('widok: sekcje obsady i partii, kartki poza <main>, tokeny czyszczone przy pagehide', () => {
  for (const id of ['coverage-body', 'coverage-year', 'batch-form', 'batch-preview-body', 'batch-apply', 'batch-result-body', 'batch-print', 'print-sheets']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.ok(html.indexOf('id="print-sheets"') > html.indexOf('</main>'), 'kartki poza <main> (reguła druku ukrywa resztę strony)');
  assert.match(main, /invitation-batches\/apply[\s\S]{0,200}idempotencyKey: batch\.key/);
  assert.match(main, /addEventListener\("pagehide"[^\n]*hideBatchResult\(\)/);
  assert.match(main, /\/reissue`/, 'przycisk „Wyślij ponownie”');
  assert.doesNotMatch(main, /localStorage|sessionStorage/, 'tokeny wyłącznie w pamięci strony');
});

test('przegląd demo 5: liczba lat szkolnych z poprawną odmianą i data logowania w zapisie polskim', () => {
  assert.equal(schoolYearsCount(1), '1 rok szkolny');
  assert.equal(schoolYearsCount(2), '2 lata szkolne');
  assert.equal(schoolYearsCount(5), '5 lat szkolnych');
  assert.equal(schoolYearsCount(12), '12 lat szkolnych');
  assert.equal(schoolYearsCount(22), '22 lata szkolne');
  assert.doesNotMatch(main, /szkolnych w systemie/);
  assert.match(main, /formatDateOrTimestamp\(row\.lastRepresentativeLoginOn/);
});
