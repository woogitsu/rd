// Wspólny klient API paneli (issue #99): mapowanie statusów, walidacja `next`,
// polskie komunikaty i test statyczny, że panele nie wołają fetch bezpośrednio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ApiError, MESSAGES, authAction, createApiClient, errorMessage, isRetryable, loginUrl, safeNextPath,
} from '../shared/api.js';
import { nextFromFragment } from '../login/core.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PANELS = ['panel', 'admin', 'families', 'ledger', 'events', 'meetings', 'documents', 'print', 'import', 'email', 'reconciliation'];

function fakeLocation(pathname, search = '', hash = '') {
  return { pathname, search, hash };
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => (body === undefined ? Promise.reject(new SyntaxError('no body')) : body),
  };
}

function client({ status = 200, body = {}, location = fakeLocation('/panel/'), throws = false } = {}) {
  const calls = [];
  const navigations = [];
  const api = createApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (throws) throw new TypeError('Failed to fetch');
      return jsonResponse(status, body);
    },
    getLocation: () => location,
    navigate: (url) => navigations.push(url),
  });
  return { ...api, calls, navigations };
}

// --- next -------------------------------------------------------------------------

test('safeNextPath przyjmuje tylko ścieżkę względną tego samego origin', () => {
  assert.equal(safeNextPath('/panel/'), '/panel/');
  assert.equal(safeNextPath('/families/#class=1a'), '/families/#class=1a');
  assert.equal(safeNextPath('/ledger/?schoolYearId=2026-2027'), '/ledger/?schoolYearId=2026-2027');
  for (const bad of [
    '//example.invalid/panel/', 'https://example.invalid/', 'http:/example.invalid', '/\\example.invalid',
    '\\\\example.invalid', 'javascript:alert(1)', 'panel/', '', null, undefined, 42, '/panel/\n',
    ' /panel/', '/login/', '/login', '/api/session', '/panel/../api/session', '/panel/../login/',
    `/${'a'.repeat(600)}`,
  ]) assert.equal(safeNextPath(bad), null, String(bad));
});

test('loginUrl koduje powrót, a zły cel daje sam /login/', () => {
  assert.equal(loginUrl('/panel/'), '/login/#next=%2Fpanel%2F');
  assert.equal(loginUrl('/families/#household=h1'), '/login/#next=%2Ffamilies%2F%23household%3Dh1');
  assert.equal(loginUrl('//example.invalid'), '/login/');
  assert.equal(loginUrl('https://example.invalid/panel/'), '/login/');
});

test('login/ odczytuje next z części #… i odrzuca adresy zewnętrzne', () => {
  assert.equal(nextFromFragment('#next=%2Fpanel%2F'), '/panel/');
  assert.equal(nextFromFragment(loginUrl('/families/#household=h1').slice('/login/'.length)), '/families/#household=h1');
  assert.equal(nextFromFragment('#next=%2F%2Fexample.invalid'), null);
  assert.equal(nextFromFragment('#next=https%3A%2F%2Fexample.invalid'), null);
  assert.equal(nextFromFragment('#next=%2Flogin%2F'), null);
  assert.equal(nextFromFragment(''), null);
  assert.equal(nextFromFragment('#invite=abc'), null);
});

test('login/main.js wraca na next po zakończeniu logowania, ale nie w pętli przy wejściu', () => {
  const main = readFileSync(join(ROOT, 'login/main.js'), 'utf8');
  assert.match(main, /view === "start" && returnTo && !initial/);
  assert.match(main, /window\.location\.replace\(returnTo\)/);
  assert.match(main, /goNext\(state, \{ initial: true \}\)/);
});

// --- mapowanie statusów ------------------------------------------------------------

test('authAction: 401 → logowanie, 403 MFA → krok kodu lub konfiguracji, inne 403 bez akcji', () => {
  assert.equal(authAction(401, 'unauthenticated'), 'login');
  assert.equal(authAction(401, ''), 'login');
  assert.equal(authAction(403, 'mfa_required'), 'mfa');
  assert.equal(authAction(403, 'mfa_enrollment_required'), 'enroll');
  assert.equal(authAction(403, 'forbidden'), null);
  assert.equal(authAction(403, 'invalid_origin'), null);
  assert.equal(authAction(404, 'not_found'), null);
  assert.equal(authAction(500, 'mfa_required'), null);
});

test('401 przekierowuje na /login/ z powrotem na bieżący panel — raz przy wielu żądaniach', async () => {
  const api = client({ status: 401, body: { error: 'unauthenticated' }, location: fakeLocation('/ledger/', '?y=2026-2027') });
  const results = await Promise.allSettled([api.request('/api/ledger'), api.request('/api/ledger/categories')]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.ok(result.reason instanceof ApiError);
    assert.equal(result.reason.status, 401);
    assert.equal(result.reason.authAction, 'login');
    assert.equal(result.reason.message, MESSAGES.unauthenticated);
  }
  assert.deepEqual(api.navigations, ['/login/#next=%2Fledger%2F%3Fy%3D2026-2027']);
});

test('403 mfa_required i mfa_enrollment_required prowadzą na /login/ z osobnymi komunikatami', async () => {
  const mfa = client({ status: 403, body: { error: 'mfa_required' } });
  await assert.rejects(mfa.request('/api/payments'), (error) => error.authAction === 'mfa' && error.message === MESSAGES.mfa_required);
  assert.deepEqual(mfa.navigations, ['/login/#next=%2Fpanel%2F']);

  const enroll = client({ status: 403, body: { error: 'mfa_enrollment_required' }, location: fakeLocation('/admin/') });
  await assert.rejects(enroll.request('/api/admin/users'), (error) => error.authAction === 'enroll' && error.message === MESSAGES.mfa_enrollment_required);
  assert.deepEqual(enroll.navigations, ['/login/#next=%2Fadmin%2F']);
  assert.notEqual(MESSAGES.mfa_required, MESSAGES.mfa_enrollment_required);
});

test('zwykłe 403 (granica roli) nie przekierowuje i nie jest „Błędem serwera”', async () => {
  const api = client({ status: 403, body: { error: 'forbidden' } });
  await assert.rejects(api.request('/api/payments?schoolYearId=2026-2027'), (error) => {
    assert.equal(error.code, 'forbidden');
    assert.equal(error.authAction, null);
    assert.equal(error.message, MESSAGES.forbidden);
    assert.doesNotMatch(error.message, /Błąd serwera|forbidden/);
    return true;
  });
  assert.deepEqual(api.navigations, []);
});

test('bez przekierowania na samej stronie logowania i przy redirect: false', async () => {
  const onLogin = client({ status: 401, body: { error: 'unauthenticated' }, location: fakeLocation('/login/') });
  await assert.rejects(onLogin.request('/api/auth/state'));
  assert.deepEqual(onLogin.navigations, []);
  const optOut = client({ status: 401, body: { error: 'unauthenticated' } });
  await assert.rejects(optOut.request('/api/session', { redirect: false }));
  assert.deepEqual(optOut.navigations, []);
});

test('handleAuthFailure dla XMLHttpRequest używa tych samych reguł', () => {
  const api = client({ location: fakeLocation('/documents/') });
  assert.equal(api.handleAuthFailure(403, 'forbidden'), null);
  assert.equal(api.handleAuthFailure(403, 'mfa_required'), 'mfa');
  assert.equal(api.handleAuthFailure(401, 'unauthenticated'), 'login');
  assert.deepEqual(api.navigations, ['/login/#next=%2Fdocuments%2F']);
});

// --- żądanie -------------------------------------------------------------------------

test('żądanie: same-origin, JSON, klucz idempotencji; ciało jako obiekt albo napis', async () => {
  const api = client({ status: 201, body: { ok: true } });
  assert.deepEqual(await api.request('/api/payments', { method: 'POST', body: { amountCents: 2500 }, idempotencyKey: 'payment-1' }), { ok: true });
  await api.request('/api/ledger', { method: 'POST', body: '{"a":1}', headers: { 'Idempotency-Key': 'ledger-1' } });
  await api.request('/api/access');
  const [first, second, third] = api.calls;
  assert.equal(first.init.credentials, 'same-origin');
  assert.equal(first.init.method, 'POST');
  assert.equal(first.init.body, '{"amountCents":2500}');
  assert.equal(first.init.headers['Content-Type'], 'application/json');
  assert.equal(first.init.headers['Idempotency-Key'], 'payment-1');
  assert.equal(first.init.headers.Accept, 'application/json');
  assert.equal(second.init.body, '{"a":1}');
  assert.equal(second.init.headers['Idempotency-Key'], 'ledger-1');
  assert.equal(third.init.method, 'GET');
  assert.equal('body' in third.init, false);
  assert.equal(third.init.headers['Content-Type'], undefined);
});

test('204 i odpowiedź bez JSON dają pusty obiekt, a błąd bez JSON — tekst według statusu', async () => {
  assert.deepEqual(await client({ status: 204, body: undefined }).request('/api/x', { method: 'POST' }), {});
  await assert.rejects(client({ status: 502, body: undefined }).request('/api/x'), (error) => error.message === MESSAGES.service_unavailable && error.code === '');
});

test('błąd sieci: polski komunikat zamiast „Failed to fetch”, ponowienie dozwolone', async () => {
  const api = client({ throws: true });
  await assert.rejects(api.request('/api/payments', { method: 'POST', body: {}, idempotencyKey: 'k' }), (error) => {
    assert.equal(error.network, true);
    assert.equal(error.status, 0);
    assert.match(error.message, /Brak połączenia/);
    assert.doesNotMatch(error.message, /fetch/i);
    assert.equal(isRetryable(error), true);
    return true;
  });
  assert.equal(isRetryable(new ApiError({ status: 400, code: 'invalid_amount' })), false);
  assert.equal(isRetryable(new ApiError({ status: 503, code: 'service_unavailable' })), true);
  assert.deepEqual(api.navigations, []);
});

test('kod błędu jest napisem { error: "kod" }; obiekt lub śmieci nie trafiają do komunikatu', async () => {
  await assert.rejects(client({ status: 400, body: { error: 'invalid_amount' } }).request('/api/payments'), (error) => error.message === MESSAGES.invalid_amount);
  await assert.rejects(client({ status: 400, body: { error: { message: 'Internal detail XYZ' } } }).request('/api/payments'), (error) => error.code === '' && !error.message.includes('XYZ'));
  await assert.rejects(client({ status: 400, body: { error: '<img src=x>' } }).request('/api/payments'), (error) => error.code === '' && !error.message.includes('<img'));
});

test('słownik panelu ma pierwszeństwo przed wspólnym', async () => {
  const api = client({ status: 403, body: { error: 'forbidden' } });
  await assert.rejects(api.request('/api/admin/users', { messages: { forbidden: 'Panel wymaga roli administratora.' } }), (error) => error.message === 'Panel wymaga roli administratora.');
});

// --- komunikaty ---------------------------------------------------------------------

test('errorMessage: polskie teksty dla statusów, surowy kod tylko jako dopisek techniczny', () => {
  assert.equal(errorMessage('forbidden', 403), MESSAGES.forbidden);
  assert.equal(errorMessage('not_found', 404), MESSAGES.not_found);
  assert.equal(errorMessage('conflict', 409), MESSAGES.conflict);
  assert.equal(errorMessage('invalid_category', 400), MESSAGES.invalid_category);
  assert.equal(errorMessage('invalid_origin', 403), MESSAGES.invalid_origin);
  assert.equal(errorMessage('mfa_required', 403), MESSAGES.mfa_required);
  assert.equal(errorMessage('mfa_enrollment_required', 403), MESSAGES.mfa_enrollment_required);
  for (const [status, pattern] of [[400, /Sprawdź pola/], [401, /Zaloguj/], [403, /Brak uprawnień/], [404, /Nie znaleziono/],
    [409, /zmieniły się/], [413, /Za dużo danych/], [415, /typ/], [429, /Zbyt wiele żądań/], [503, /niedostępna/], [0, /Brak połączenia/]]) {
    assert.match(errorMessage('', status), pattern, String(status));
  }
  assert.equal(errorMessage('rate_limited', 429), `${errorMessage('', 429)} (kod techniczny: rate_limited)`);
  assert.equal(errorMessage('something_new', 400), `${errorMessage('', 400)} (kod techniczny: something_new)`);
  for (const status of [0, 400, 401, 403, 404, 409, 413, 415, 429, 500, 503]) {
    assert.doesNotMatch(errorMessage('', status), /Błąd serwera \(|Failed|Error/);
  }
});

// Kody zwracane przez API PostgreSQL: RequestError('…'), XError(413, '…'), json({ error: '…' }), code: '…'.
function serverErrorCodes() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith('.js')) files.push(path);
    }
  };
  walk(join(ROOT, 'src/pg'));
  files.push(join(ROOT, 'src/documents.js'), join(ROOT, 'src/storage.js'));
  const pattern = /new (?!(?:Error|TypeError|RangeError|EmailTransportError)\b)[A-Z][A-Za-z]*\(\s*(?:\d{3}\s*,\s*)?['"]([a-z][a-z0-9_]*)['"]|\b(?:error|code)\s*[:=]\s*['"]([a-z][a-z0-9_]*)['"]/g;
  const codes = new Set(['mfa_required', 'mfa_enrollment_required']);
  for (const file of files) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) codes.add(match[1] ?? match[2]);
  return [...codes].sort();
}

test('każdy kod błędu z src/pg ma polski tekst we wspólnym słowniku', () => {
  const codes = serverErrorCodes();
  assert.ok(codes.length > 150, `za mało kodów: ${codes.length}`);
  const missing = codes.filter((code) => !Object.hasOwn(MESSAGES, code));
  assert.deepEqual(missing, []);
  for (const [code, text] of Object.entries(MESSAGES)) {
    assert.ok(text.length > 5 && !text.includes(code), `${code}: ${text}`);
  }
});

// --- test statyczny paneli ---------------------------------------------------------------

test('panele nie wołają fetch bezpośrednio — wszystkie żądania przez shared/api.js', () => {
  for (const panel of PANELS) {
    const sources = readdirSync(join(ROOT, panel)).filter((name) => name.endsWith('.js'));
    let importsClient = false;
    for (const name of sources) {
      const text = readFileSync(join(ROOT, panel, name), 'utf8');
      assert.doesNotMatch(text, /\bfetch\s*\(/, `${panel}/${name} woła fetch bezpośrednio`);
      if (name === 'main.js') assert.doesNotMatch(text, /Błąd serwera \(\$\{/, `${panel}/${name} ma lokalny fallback „Błąd serwera (…)”`);
      if (name === 'main.js' && /from ["']\.\.\/shared\/api\.js["']/.test(text)) importsClient = true;
    }
    assert.ok(importsClient, `${panel}/main.js nie importuje shared/api.js`);
  }
  // XMLHttpRequest (postęp przesyłania) tylko w dokumentach i z tą samą obsługą 401/403.
  const documents = readFileSync(join(ROOT, 'documents/main.js'), 'utf8');
  assert.match(documents, /handleAuthFailure\(xhr\.status/);
});

test('klient API nie używa localStorage ani sessionStorage', () => {
  for (const file of ['shared/api.js', 'shared/messages.js']) {
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8').replace(/^\s*\/\/.*$/gm, ''), /localStorage|sessionStorage|indexedDB|document\.cookie/);
  }
});
