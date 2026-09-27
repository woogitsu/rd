// Czyste funkcje ekranu logowania (login/core.js) i statyczne wymagania HTML/CSS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  PANELS, errorMessage, formatSecret, isRecoveryFormat, isTotpFormat, nextView, normalizeRecoveryCode, normalizeTotp,
  parseFragment, parseOtpauthUri, passwordLength, qrMatrix, qrSvgPath, validateEmail, validateNewPassword,
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
