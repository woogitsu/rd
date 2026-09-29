// Czyste funkcje ekranu logowania (login/core.js) i statyczne wymagania HTML/CSS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  PANELS, SECRET_INPUT_IDS, canOfferVoluntaryMfaEnrollment, clearSensitiveViews, enrollIntroText,
  enrollReasonFromFragment, enrollmentConfirmError, errorMessage, formatSecret, isRecoveryFormat,
  isTotpFormat, logoutOutcome, nextView, normalizeRecoveryCode, normalizeTotp,
  parseFragment, parseOtpauthUri, passwordLength, qrMatrix, qrSvgPath, shouldShowNoAccessNotice,
  validateEmail, validateNewPassword,
} from '../login/core.js';
import { generateRecoveryCodes, totpMethod } from '../src/pg/mfa.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('login/index.html');
const css = read('login/styles.css');
const TOKEN = 'A'.repeat(21) + '_-' + 'b'.repeat(20);

test('walidacja e-maila i nowego hasła (12–128 znaków, bez reguł składu)', () => {
  assert.equal(validateEmail(''), 'Podaj adres e-mail.');
  assert.match(validateEmail('bez-malpy'), /formacie/);
  assert.equal(validateEmail('  osoba@example.invalid '), null);
  assert.match(validateNewPassword('krotkie'), /12 znaków/);
  assert.match(validateNewPassword('x'.repeat(129)), /128/);
  assert.equal(validateNewPassword('tylko male litery', 'tylko male litery'), null);
  assert.equal(validateNewPassword('tylko male litery', 'inne'), 'Hasła nie są takie same.');
  assert.equal(passwordLength('zażółć'), 6, 'znaki, nie bajty');
});

test('kody: TOTP z odstępem, kod odzyskiwania w formacie serwera', () => {
  assert.equal(normalizeTotp(' 123 456 '), '123456');
  assert.equal(isTotpFormat('123 456'), true);
  assert.equal(isTotpFormat('12345'), false);
  assert.equal(isTotpFormat('12345a'), false);
  const [code] = generateRecoveryCodes(1);
  assert.equal(isRecoveryFormat(code), true);
  assert.equal(isRecoveryFormat(code.toLowerCase().replaceAll('-', ' ')), true);
  assert.equal(normalizeRecoveryCode('abcd-efgh ijkl-mnop'), 'ABCDEFGHIJKLMNOP');
  assert.equal(isRecoveryFormat('ABCD-EFGH-IJKL-MNO1'), false, 'cyfra 1 nie należy do base32');
});

test('token zaproszenia i resetu tylko w części „#”', () => {
  assert.deepEqual(parseFragment(`#invite=${TOKEN}`), { view: 'invite', token: TOKEN });
  assert.deepEqual(parseFragment(`#reset=${TOKEN}`), { view: 'reset', token: TOKEN });
  assert.deepEqual(parseFragment('#invite=zly<token>'), { view: 'invite', token: null });
  assert.deepEqual(parseFragment('#reset'), { view: 'reset', token: null });
  assert.deepEqual(parseFragment('#change'), { view: 'change' });
  assert.deepEqual(parseFragment(''), { view: null });
});

test('następny widok po logowaniu', () => {
  assert.equal(nextView({ authenticated: false }), 'login');
  assert.equal(nextView({ authenticated: true, mfaVerified: false, mfaEnrolled: true, mfaRequired: true }), 'mfa');
  assert.equal(nextView({ authenticated: true, mfaVerified: false, mfaEnrolled: false, mfaRequired: true, mfaRequiredByRole: true }), 'enroll');
  assert.equal(nextView({ authenticated: true, mfaVerified: false, mfaEnrolled: false, mfaRequired: false }), 'start');
  assert.equal(nextView({ authenticated: true, mfaVerified: true, mfaEnrolled: true }), 'start');
  assert.equal(nextView({ authenticated: true, mfaVerified: true, mustChangePassword: true }), 'change');
});

test('dobrowolne włączenie MFA: dowolna zalogowana rola bez czynnika (#161)', () => {
  assert.equal(canOfferVoluntaryMfaEnrollment({ authenticated: true, mfaEnrolled: false }), true);
  assert.equal(canOfferVoluntaryMfaEnrollment({ authenticated: true, mfaEnrolled: true }), false, 'czynnik już jest');
  assert.equal(canOfferVoluntaryMfaEnrollment({ authenticated: false, mfaEnrolled: false }), false, 'trzeba być zalogowanym');
  assert.equal(canOfferVoluntaryMfaEnrollment(null), false);
  assert.notEqual(enrollIntroText(true), enrollIntroText(false), 'inny tekst dla wymogu roli i wyboru własnego');
  assert.match(enrollIntroText(true), /rola wymaga/);
});

test('#176: komunikat o braku uprawnień tylko gdy serwer jawnie mówi hasActiveRole:false', () => {
  assert.equal(shouldShowNoAccessNotice({ grants: [], hasActiveRole: false }), true);
  assert.equal(shouldShowNoAccessNotice({ grants: [{ role: 'representative' }], hasActiveRole: true }), false);
  // Nieznany stan (błąd sieci, mfaRequired bez jawnego hasActiveRole) → nie ukrywamy paneli.
  assert.equal(shouldShowNoAccessNotice(null), false);
  assert.equal(shouldShowNoAccessNotice({ grants: [], mfaRequired: true }), false, 'hasActiveRole nieobecne');
});

test('kod QR: URI otpauth z serwera, macierz zgodna z normą, ścieżka SVG z marginesem', () => {
  const secret = randomBytes(20);
  const uri = totpMethod.provisioningUri({ secret, account: 'osoba@example.invalid' });
  const parsed = parseOtpauthUri(uri);
  assert.equal(parsed.issuer, 'RD');
  assert.equal(parsed.account, 'osoba@example.invalid');
  assert.equal(parsed.digits, 6);
  assert.equal(parsed.period, 30);
  assert.equal(parsed.algorithm, 'SHA1');
  assert.match(parsed.secret, /^[A-Z2-7]{32}$/);
  assert.equal(parseOtpauthUri('https://example.invalid/?secret=ABC'), null);
  assert.equal(parseOtpauthUri('otpauth://hotp/RD:x?secret=JBSWY3DPEHPK3PXP'), null);
  assert.throws(() => qrMatrix('https://evil.example/'), /invalid_otpauth_uri/);

  const matrix = qrMatrix(uri);
  const size = matrix.length;
  assert.equal((size - 17) % 4, 0, 'rozmiar = 4 × wersja + 17');
  assert.ok(size >= 41, `URI (${uri.length} znaków) wymaga co najmniej wersji 6`);
  assert.ok(matrix.every((row) => row.length === size));
  // Wzorce wyszukiwania w trzech narożnikach: ciemna ramka 7×7 i ciemny środek 3×3.
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let i = 0; i < 7; i += 1) {
      assert.ok(matrix[top][left + i] && matrix[top + 6][left + i] && matrix[top + i][left] && matrix[top + i][left + 6]);
    }
    assert.equal(matrix[top + 1][left + 1], false);
    assert.ok(matrix[top + 3][left + 3]);
  }
  // Deterministyczne dla tego samego URI.
  assert.deepEqual(qrMatrix(uri), matrix);

  const { size: box, d } = qrSvgPath(matrix);
  assert.equal(box, size + 8);
  const dark = matrix.flat().filter(Boolean).length;
  const covered = [...d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)].reduce((sum, match) => sum + Number(match[3]), 0);
  assert.equal(covered, dark, 'każdy ciemny moduł jest w ścieżce dokładnie raz');
  assert.ok(!d.includes('M0 ') && !/M\d+ [0-3] /.test(d), 'margines 4 modułów');
  assert.equal(formatSecret('JBSWY3DPEHPK3PXP'), 'JBSW Y3DP EHPK 3PXP');
});

test('komunikaty błędów po polsku, bez rozróżnienia nieznanego konta i złego hasła', () => {
  assert.equal(errorMessage('invalid_credentials', 401), 'Nieprawidłowy adres e-mail lub hasło.');
  assert.match(errorMessage('too_many_attempts', 429), /Zbyt wiele/);
  assert.match(errorMessage(undefined, 429), /Zbyt wiele/);
  assert.match(errorMessage('mfa_enrollment_required', 403), /aplikację uwierzytelniającą/);
  assert.match(errorMessage('nieznany_kod', 503), /niedostępna/);
  assert.ok(PANELS.every((panel) => panel.href.startsWith('/') && panel.href.endsWith('/')));
  assert.ok(PANELS.some((panel) => panel.href === '/site/'));
});

test('HTML logowania: autouzupełnianie, wklejanie, brak CAPTCHA i zewnętrznych skryptów (WCAG 3.3.8)', () => {
  assert.match(html, /<html lang="pl">/);
  assert.match(html, /<a class="skip-link" href="#main">Przejdź do treści<\/a>/);
  assert.match(html, /<main id="main">/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /id="login-email"[^>]*autocomplete="username"/);
  assert.match(html, /id="login-password"[^>]*type="password"[^>]*autocomplete="current-password"/);
  assert.match(html, /id="totp-code"[^>]*inputmode="numeric"[^>]*autocomplete="one-time-code"/);
  assert.match(html, /id="enroll-code"[^>]*autocomplete="one-time-code"/);
  assert.equal((html.match(/autocomplete="new-password"/g) || []).length, 6);
  assert.ok((html.match(/class="toggle-password"/g) || []).length >= 4, 'przycisk „Pokaż hasło” przy polach hasła');
  assert.match(html, /Zapisałem kody/);
  assert.doesNotMatch(html, /onpaste|captcha|recaptcha|hcaptcha/i);
  assert.doesNotMatch(html, /<script[^>]+src="https?:/i);
  assert.doesNotMatch(html, /style="/, 'CSP style-src self: bez atrybutów style');
  // Każde pole ma etykietę; każdy komunikat błędu ma rolę live.
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]));
  const labelled = new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((match) => match[1]));
  for (const [, id] of html.matchAll(/<input[^>]* id="([^"]+)"/g)) assert.ok(labelled.has(id), `pole bez etykiety: ${id}`);
  for (const [, refs] of html.matchAll(/aria-(?:describedby|labelledby|controls)="([^"]+)"/g)) {
    for (const ref of refs.split(/\s+/)) assert.ok(ids.has(ref), `brak id ${ref}`);
  }
  for (const [tag] of html.matchAll(/<p class="form-error"[^>]*>/g)) assert.match(tag, /role="alert"/);
});

test('CSS logowania: białe tło, paleta DESIGN.md, fokus, rozmiar celów, ograniczony ruch', () => {
  assert.match(css, /background: #ffffff/);
  assert.match(css, /#b3262d/);
  assert.match(css, /:focus-visible \{ outline: 3px solid #8e2026/);
  assert.match(css, /button \{[^}]*min-height: 44px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /outline:\s*(none|0)\b/);
  assert.doesNotMatch(css, /@import|url\(\s*["']?https?:/, 'bez zewnętrznych czcionek i obrazów');
});

// --- #197: dane wrażliwe w DOM, wylogowanie, „Pokaż hasło”, wygasła konfiguracja --------------

// Minimalna atrapa dokumentu: elementy o id z login/index.html, tekst „body” to suma treści.
function fakeDocument() {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const elements = new Map();
  const make = (id) => {
    const tag = html.match(new RegExp(`<(\\w+)[^>]*\\sid="${id}"[^>]*>`))?.[0] ?? '';
    const element = {
      id, textContent: '', value: '', children: [], attributes: {},
      type: tag.match(/type="([^"]+)"/)?.[1] ?? null,
      dataset: {},
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
    };
    elements.set(id, element);
    return element;
  };
  ids.forEach(make);
  const toggles = [...html.matchAll(/<button[^>]*class="toggle-password"[^>]*data-target="([^"]+)"[^>]*>/g)].map((match, index) => {
    const toggle = make(`toggle-${index}`);
    toggle.dataset.target = match[1];
    toggle.textContent = 'Pokaż hasło';
    toggle.attributes['aria-pressed'] = 'false';
    return toggle;
  });
  return {
    elements, toggles,
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: (selector) => (selector === '.toggle-password' ? toggles : []),
    bodyText: () => [...elements.values()].map((el) => [el.textContent, el.value, ...el.children.map((child) => child.textContent ?? '')].join(' ')).join(' '),
  };
}

test('#197: clearSensitiveViews usuwa klucz, QR, kody odzyskiwania i hasła; przywraca „Pokaż hasło”', () => {
  const doc = fakeDocument();
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const codes = generateRecoveryCodes(10);
  doc.getElementById('manual-key').textContent = formatSecret(secret);
  doc.getElementById('qr-code').replaceChildren({ textContent: `otpauth://totp/RD:osoba@example.invalid?secret=${secret}` });
  doc.getElementById('recovery-codes').replaceChildren(...codes.map((code) => ({ textContent: code })));
  for (const id of SECRET_INPUT_IDS) doc.getElementById(id).value = 'haslo syntetyczne 123';
  doc.getElementById('login-email').value = 'osoba@example.invalid';
  doc.getElementById('login-password').type = 'text';
  doc.toggles[0].setAttribute('aria-pressed', 'true');
  doc.toggles[0].textContent = 'Ukryj hasło';

  clearSensitiveViews(doc);
  const text = doc.bodyText();
  assert.ok(!text.includes(secret.slice(0, 8)) && !text.includes('JBSW Y3DP'), 'sekret TOTP w DOM');
  assert.ok(!text.includes('otpauth'), 'URI otpauth w DOM');
  for (const code of codes) assert.ok(!text.includes(code), 'kod odzyskiwania w DOM');
  assert.ok(!text.includes('haslo syntetyczne'), 'hasło w polu');
  for (const toggle of doc.toggles) {
    assert.equal(doc.getElementById(toggle.dataset.target).type, 'password');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(toggle.textContent, 'Pokaż hasło');
  }
  // Każde pole hasła i kodu z HTML jest na liście czyszczonych.
  for (const [, id] of html.matchAll(/<input id="([^"]+)"[^>]*type="password"/g)) assert.ok(SECRET_INPUT_IDS.includes(id), id);
  for (const id of ['totp-code', 'recovery-code', 'enroll-code']) assert.ok(SECRET_INPUT_IDS.includes(id));
});

test('#197: token zaproszenia/resetu zostaje przy keepTokens (hashchange przenosi go do pola)', () => {
  const doc = fakeDocument();
  doc.getElementById('invite-token').value = TOKEN;
  clearSensitiveViews(doc, { keepTokens: true });
  assert.equal(doc.getElementById('invite-token').value, TOKEN);
  clearSensitiveViews(doc);
  assert.equal(doc.getElementById('invite-token').value, '');
});

test('#197: „Wylogowano” tylko po 204 albo 401; błąd sieci i 503 mówią, że sesja może trwać', () => {
  assert.deepEqual(logoutOutcome(204), { loggedOut: true, message: 'Wylogowano.' });
  assert.equal(logoutOutcome(401).loggedOut, true);
  for (const status of [503, 500, 403, 429]) {
    const outcome = logoutOutcome(status);
    assert.equal(outcome.loggedOut, false, String(status));
    assert.match(outcome.message, /Nie udało się wylogować/);
    assert.ok(!/^Wylogowano/.test(outcome.message));
  }
});

test('#197: mfa_enrollment_not_found wraca do rozpoczęcia konfiguracji; invalid_code podpowiada nowszy QR', () => {
  const expired = enrollmentConfirmError('mfa_enrollment_not_found', 409);
  assert.equal(expired.restart, true);
  assert.match(expired.message, /ponownie/);
  const wrong = enrollmentConfirmError('invalid_code', 400);
  assert.equal(wrong.restart, false);
  assert.match(wrong.message, /innej karcie/);
  assert.equal(enrollmentConfirmError('mfa_locked', 429).restart, false);
});

test('#197: main.js czyści dane przy wylogowaniu, powrocie, hashchange i pagehide; wylogowanie sprawdza wynik', () => {
  const main = read('login/main.js');
  const logoutHandler = main.slice(main.indexOf('querySelectorAll(".logout")'), main.indexOf('byId("logout-all")'));
  assert.match(logoutHandler, /clearSensitiveViews\(document\)/);
  assert.match(logoutHandler, /logoutOutcome\(/);
  assert.doesNotMatch(logoutHandler, /catch \{ \/\* sesja mogła już wygasnąć \*\/ \}/);
  assert.match(main, /addEventListener\("pagehide"[\s\S]{0,120}clearSensitiveViews\(document\)/);
  assert.match(main, /addEventListener\("hashchange"[\s\S]{0,160}clearSensitiveViews\(document, \{ keepTokens: false \}\)/);
  assert.match(main.slice(main.indexOf('.back-to-login')), /clearSensitiveViews\(document\)/);
  assert.match(main.slice(main.indexOf('"enroll-confirm-form"')), /enrollmentConfirmError\(/);
});

test('#161: powrót z panelu po 403 mfa_enrollment_required prowadzi do zapisu MFA z wyjaśnieniem, nie do listy paneli', () => {
  assert.equal(enrollReasonFromFragment('#next=%2Faudit%2F&reason=enroll'), true);
  assert.equal(enrollReasonFromFragment('#next=%2Faudit%2F'), false);
  assert.equal(enrollReasonFromFragment('#reason=inne'), false);
  // Rola spoza MFA_REQUIRED_ROLES: nextView nadal daje „start” (lista ról bez zmian, D-10),
  // a decyzję o widoku enroll podejmuje login/main.js na podstawie powodu z adresu.
  const rep = { authenticated: true, mfaVerified: false, mfaEnrolled: false, mfaRequiredByRole: false, mfaRequired: false };
  assert.equal(nextView(rep), 'start');
  assert.equal(canOfferVoluntaryMfaEnrollment(rep), true);
  assert.match(enrollIntroText(false, { page: true }), /wymaga weryfikacji dwuetapowej/);
  assert.match(enrollIntroText(false, { page: true }), /wrócisz do tej strony/);
  assert.notEqual(enrollIntroText(false, { page: true }), enrollIntroText(false));
  const main = read('login/main.js');
  assert.match(main, /view === "start" && initial && returnTo && enrollReason && canOfferVoluntaryMfaEnrollment\(state\)/);
});
