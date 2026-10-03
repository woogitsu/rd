// Publiczna strona „Aktualizacja kontaktu” (#140 pkt 5, kontakt/): czyste funkcje core.js oraz
// statyczne wymagania okablowania. Dane wyłącznie syntetyczne (@example.invalid); żadne żądanie
// nie wychodzi (klient API dostaje podstawiony fetch), żadna wiadomość nie jest wysyłana.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, createApiClient } from '../shared/api.js';
import {
  KONTAKT_MESSAGES, SUBMIT_URL, VERIFY_FAILURE_TEXT, VERIFY_SUCCESS_TEXT, VERIFY_URL,
  buildSubmitBody, buildVerifyBody, isCodeFormat, normalizeCode, previewSummary, previewUrl, submitOutcome,
  tokenFromFragment, validateEmail, verifyFailureText,
} from '../kontakt/core.js';
import { assertEvery } from './helpers/assertions.js';

const TOKEN = 'ab'.repeat(32);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('token tylko z części # adresu i tylko w poprawnym formacie', () => {
  assert.equal(tokenFromFragment(`#token=${TOKEN}`), TOKEN);
  assert.equal(tokenFromFragment(`token=${TOKEN}&x=1`), TOKEN);
  for (const bad of ['', '#', '#token=', '#token=XYZ', `#token=${'AB'.repeat(32)}`, `#token=${'a'.repeat(31)}`, `#token=${'a'.repeat(129)}`, `#t=${TOKEN}`, null, undefined, 7]) {
    assert.equal(tokenFromFragment(bad), null, String(bad));
  }
  assert.equal(previewUrl(TOKEN), `${SUBMIT_URL}?token=${TOKEN}`);
  assert.throws(() => previewUrl('../x'));
  assert.equal(VERIFY_URL, '/api/public/guardian-update/verify');
});

test('kod: spacje i myślniki z wiadomości są pomijane, format to dokładnie 8 cyfr', () => {
  assert.equal(normalizeCode(' 1234 5678 '), '12345678');
  assert.equal(normalizeCode('1234-5678'), '12345678');
  assert.equal(normalizeCode('1234 5678'), '12345678');
  assert.equal(isCodeFormat('12345678'), true);
  for (const bad of ['', '1234567', '123456789', '1234567a', '１２３４５６７８', ' 12345678', null]) assert.equal(isCodeFormat(bad), false, String(bad));
  assert.deepEqual(buildVerifyBody(TOKEN, '1234 5678'), { token: TOKEN, code: '12345678' });
  assert.equal(buildVerifyBody(TOKEN, '1234567'), null);
  assert.equal(buildVerifyBody('zly', '12345678'), null);
  assert.equal(buildVerifyBody(null, '12345678'), null);
});

test('jedna treść dla każdej porażki potwierdzenia, także gdy klient API zwraca różne błędy', async () => {
  const responses = [
    { status: 400, body: { error: 'invalid_or_expired_code' } },
    { status: 404, body: { error: 'invalid_or_expired_link' } },
    { status: 400, body: { error: 'cokolwiek_innego' } },
    { status: 409, body: { error: 'link_used' } },
    { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '30' } },
    { status: 503, body: { error: 'service_unavailable' } },
    { network: true },
  ];
  const texts = [];
  for (const spec of responses) {
    const client = createApiClient({
      fetchImpl: async () => {
        if (spec.network) throw new TypeError('Failed to fetch');
        return {
          status: spec.status, ok: false,
          headers: { get: (name) => spec.headers?.[name] ?? null },
          json: async () => spec.body,
        };
      },
      getLocation: () => ({ pathname: '/kontakt/', search: '', hash: `#token=${TOKEN}` }),
      navigate: () => assert.fail('strona publiczna nie przekierowuje na logowanie'),
      hasUnsavedChanges: () => false, warnUnsaved: () => {}, clearWarning: () => {},
    });
    await assert.rejects(
      client.request(VERIFY_URL, { method: 'POST', body: { token: TOKEN, code: '12345678' }, messages: KONTAKT_MESSAGES, redirect: false }),
      (error) => {
        assert.ok(error instanceof ApiError);
        texts.push(verifyFailureText(error));
        return true;
      },
    );
  }
  assert.equal(texts.length, responses.length);
  assertEvery(texts, (text) => text === VERIFY_FAILURE_TEXT, 'ta sama treść dla każdej porażki');
  // Bez wyroczni: brak liczby prób, adresu, kodu i przyczyny.
  assert.doesNotMatch(VERIFY_FAILURE_TEXT, /@|limit|zablokowan|wyczerpan|rozpatrzon|pozostał/i);
  assert.notEqual(VERIFY_FAILURE_TEXT, VERIFY_SUCCESS_TEXT);
});

test('wniosek: pusty formularz niczego nie wysyła, zgoda wymaga jawnego wyboru, adres jest normalizowany', () => {
  assert.deepEqual(buildSubmitBody({ token: TOKEN, email: '', consent: 'keep', note: '' }), { error: 'invalid_request' });
  assert.deepEqual(buildSubmitBody({ token: TOKEN, email: '  ', consent: 'keep' }), { error: 'invalid_request' });
  assert.deepEqual(buildSubmitBody({ token: TOKEN, email: 'Nowy@Example.invalid ', consent: 'keep' }).body, { token: TOKEN, email: 'nowy@example.invalid' });
  assert.deepEqual(buildSubmitBody({ token: TOKEN, email: '', consent: 'allow' }).body, { token: TOKEN, contactAllowed: true });
  assert.deepEqual(buildSubmitBody({ token: TOKEN, email: '', consent: 'withdraw', note: ' Proszę o kontakt ' }).body, { token: TOKEN, contactAllowed: false, note: 'Proszę o kontakt' });
  assert.deepEqual(buildSubmitBody({ token: TOKEN, email: 'bez-malpy', consent: 'keep' }), { error: 'invalid_email' });
  assert.deepEqual(buildSubmitBody({ token: TOKEN, email: `${'a'.repeat(250)}@example.invalid` }), { error: 'invalid_email' });
  assert.deepEqual(buildSubmitBody({ token: TOKEN, email: '', consent: 'cokolwiek' }), { error: 'invalid_request' });
  assert.deepEqual(buildSubmitBody({ token: TOKEN, email: 'a@example.invalid', note: 'x'.repeat(501) }), { error: 'invalid_request' });
  assert.deepEqual(buildSubmitBody({ token: 'zly', email: 'a@example.invalid' }), { error: 'invalid_or_expired_link' });
  assert.deepEqual(validateEmail(''), { ok: true, email: null });
  assertEvery(['invalid_email', 'invalid_request', 'invalid_or_expired_link'], (code) => typeof KONTAKT_MESSAGES[code] === 'string' && KONTAKT_MESSAGES[code].length > 10, 'komunikaty błędów formularza');
});

test('po złożeniu wniosku pole kodu tylko przy emailVerification: requested; tekst nie obiecuje dostarczenia', () => {
  const requested = submitOutcome({ requestId: 'r1', status: 'pending', emailVerification: 'requested' });
  assert.equal(requested.verification, 'requested');
  assert.match(requested.text, /może dotrzeć/);
  assert.match(requested.text, /decyzję Rady|po jej zatwierdzeniu/);
  for (const response of [{ emailVerification: 'none' }, {}, null, undefined, { emailVerification: 'sent' }]) {
    const outcome = submitOutcome(response);
    assert.equal(outcome.verification, 'none');
    assert.doesNotMatch(outcome.text, /kod/i);
  }
  assert.equal(previewSummary({ guardianFirstName: 'Anna', classNames: ['1A', '3B'] }), 'Opiekun: Anna; klasa: 1A, 3B');
  assert.equal(previewSummary({}), '');
});

test('kontakt/main.js: wspólny klient bez fetch i przekierowań, token tylko w pamięci, ta sama treść porażki kodu', () => {
  const main = read('kontakt/main.js');
  assert.doesNotMatch(main, /\bfetch\s*\(/, 'kontakt/main.js woła fetch bezpośrednio');
  assert.match(main, /from "\.\.\/shared\/api\.js"/);
  assert.match(main, /createApiClient\(/);
  assert.match(main, /messages: KONTAKT_MESSAGES, redirect: false/);
  assert.doesNotMatch(main, /localStorage|sessionStorage|innerHTML|document\.cookie|history\.(replace|push)State/);
  assert.doesNotMatch(main, /mountShell|checkSession/, 'strona publiczna nie pyta o sesję');
  assert.match(main, /VERIFY_URL/);
  // Obsługa formularza kodu: porażka tylko przez fail() z jedną treścią, bez odczytu błędu serwera.
  const handler = main.slice(main.indexOf('byId("code-form")'), main.indexOf('window.addEventListener("hashchange"'));
  assert.ok(handler.length > 200, 'znaleziono obsługę formularza kodu');
  assert.match(handler, /catch \{\s*fail\(\);/);
  assert.doesNotMatch(handler, /\berror\.(message|code|status|data)\b/);
  assert.match(handler, /verifyFailureText\(\)/);
});

test('kontakt/index.html: biała strona bez inline, jeden formularz wniosku i jedno pole 8-cyfrowego kodu', () => {
  const html = read('kontakt/index.html');
  assert.match(html, /<meta name="referrer" content="no-referrer"/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  assert.match(html, /<script type="module" src="\/main\.js"><\/script>/);
  assert.match(html, /id="code-input"[^>]*inputmode="numeric"[^>]*autocomplete="one-time-code"/);
  assert.match(html, /<label for="code-input">/);
  assert.match(html, /id="update-form"/);
  assert.doesNotMatch(html, /<img|<svg|<canvas/i, 'bez ikon i grafik dekoracyjnych');
  const css = read('kontakt/styles.css');
  assert.match(css, /background: #ffffff/);
  assert.doesNotMatch(css, /@import|url\(/);
});
