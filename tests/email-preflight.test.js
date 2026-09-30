// Skrypt npm run email:preflight (issue #148). Nie łączy się z siecią: DNS jest
// wstrzyknięty (fałszywy resolver), globalny fetch pozostaje pułapką (helpers/pg.js
// nie jest importowany tutaj celowo — nie ma żadnego wywołania sieciowego do złapania).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../scripts/email-preflight.js';

const BASE_ENV = {
  BREVO_FROM_EMAIL: 'rada@rada.example.invalid',
  BREVO_REPLY_TO: 'kontakt@rada.example.invalid',
  BREVO_WEBHOOK_SECRET: 'w'.repeat(40),
  EMAIL_TEST_ALLOWLIST: '*@example.invalid',
  EMAIL_DKIM_HOSTS: 'mail._domainkey.rada.example.invalid',
};

function fakeResolvers({ txt = {}, cname = {} } = {}) {
  const resolveTxt = async (host) => {
    if (txt[host]) return txt[host].map((line) => [line]);
    const err = new Error('not found'); err.code = 'ENOTFOUND'; throw err;
  };
  const resolveCname = async (host) => {
    if (cname[host]) return cname[host];
    const err = new Error('not found'); err.code = 'ENOTFOUND'; throw err;
  };
  return { resolveTxt, resolveCname };
}

function statusOf(checks, code) {
  return checks.filter((c) => c.code === code).map((c) => c.status);
}

test('email:preflight never touches BREVO_API_KEY and reports missing DMARC', async () => {
  const checks = await runPreflight({ ...BASE_ENV }, fakeResolvers());
  assert.deepEqual(statusOf(checks, 'dmarc'), ['missing']);
  assert.deepEqual(statusOf(checks, 'sender_email'), ['ok']);
  assert.deepEqual(statusOf(checks, 'reply_to'), ['ok']);
  assert.deepEqual(statusOf(checks, 'webhook_secret'), ['ok']);
  assert.deepEqual(statusOf(checks, 'dkim'), ['missing']);
});

test('email:preflight: DMARC p=none is a warning, a stricter policy is ok', async () => {
  const lax = await runPreflight(BASE_ENV, fakeResolvers({ txt: { '_dmarc.rada.example.invalid': ['v=DMARC1; p=none; rua=mailto:dmarc@rada.example.invalid'] } }));
  assert.deepEqual(statusOf(lax, 'dmarc'), ['warning']);
  const strict = await runPreflight(BASE_ENV, fakeResolvers({ txt: { '_dmarc.rada.example.invalid': ['v=DMARC1; p=quarantine; rua=mailto:dmarc@rada.example.invalid'] } }));
  assert.deepEqual(statusOf(strict, 'dmarc'), ['ok']);
});

test('email:preflight: DKIM host found via TXT or CNAME is ok', async () => {
  const viaTxt = await runPreflight(BASE_ENV, fakeResolvers({ txt: { 'mail._domainkey.rada.example.invalid': ['v=DKIM1; k=rsa; p=AAA'] } }));
  assert.deepEqual(statusOf(viaTxt, 'dkim'), ['ok']);
  const viaCname = await runPreflight(BASE_ENV, fakeResolvers({ cname: { 'mail._domainkey.rada.example.invalid': ['b1.dkim.brevo.com'] } }));
  assert.deepEqual(statusOf(viaCname, 'dkim'), ['ok']);
});

test('email:preflight: missing sender, short webhook secret and no test recipients are flagged', async () => {
  const checks = await runPreflight({ BREVO_WEBHOOK_SECRET: 'short' }, fakeResolvers());
  assert.deepEqual(statusOf(checks, 'sender_email'), ['missing']);
  assert.deepEqual(statusOf(checks, 'reply_to'), ['missing']);
  assert.deepEqual(statusOf(checks, 'webhook_secret'), ['missing']);
  assert.deepEqual(statusOf(checks, 'test_recipients'), ['warning']);
});

test('email:preflight: free sender domain is a warning, never a network call', async () => {
  const checks = await runPreflight({ ...BASE_ENV, BREVO_FROM_EMAIL: 'ktos@gmail.com' }, fakeResolvers());
  assert.deepEqual(statusOf(checks, 'sender_email'), ['warning']);
});

test('email:preflight is deterministic on repeated calls (no state written)', async () => {
  const resolvers = fakeResolvers({ txt: { '_dmarc.rada.example.invalid': ['v=DMARC1; p=reject'] } });
  const first = await runPreflight(BASE_ENV, resolvers);
  const second = await runPreflight(BASE_ENV, resolvers);
  assert.deepEqual(first, second);
});

// --- #209: opcjonalne sprawdzenie klucza (GET /v3/account), tylko z fetchImpl ---

function accountStub(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, apiKey: init.headers['api-key'], body: init.body });
    const answer = respond();
    if (answer instanceof Error) throw answer;
    return new Response('{"email":"konto@example.invalid","companyName":"Syntetyczna"}', { status: answer });
  };
  return { calls, fetchImpl };
}

test('email:preflight bez --check-account nie łączy się z Brevo nawet z kluczem', async () => {
  const stub = accountStub(() => 200);
  const checks = await runPreflight({ ...BASE_ENV, BREVO_API_KEY: 'synthetic-key' }, { ...fakeResolvers(), fetchImpl: stub.fetchImpl, processEnv: {} });
  assert.equal(stub.calls.length, 0);
  assert.deepEqual(statusOf(checks, 'brevo_account'), []);
});

test('email:preflight --check-account: jedno zapytanie GET /v3/account; 401/402/403 = missing, 200 = ok, brak połączenia = warning', async () => {
  for (const [answer, expected, pattern] of [
    [200, 'ok', /przyjęło klucz/],
    [401, 'missing', /401/],
    [402, 'missing', /402/],
    [403, 'missing', /403/],
    [500, 'warning', /provider_status_500/],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'warning', /nie udało się połączyć/],
  ]) {
    const stub = accountStub(() => answer);
    const checks = await runPreflight({ ...BASE_ENV, BREVO_API_KEY: 'synthetic-key' }, {
      ...fakeResolvers(), checkAccount: true, fetchImpl: stub.fetchImpl, processEnv: {},
    });
    const [check] = checks.filter((c) => c.code === 'brevo_account');
    assert.equal(check.status, expected, String(answer));
    assert.match(check.detail, pattern);
    assert.doesNotMatch(check.detail, /synthetic-key|konto@example\.invalid|Syntetyczna/, 'bez sekretu i treści odpowiedzi');
    assert.equal(stub.calls.length, 1);
    assert.deepEqual([stub.calls[0].url, stub.calls[0].method, stub.calls[0].apiKey, stub.calls[0].body],
      ['https://api.brevo.com/v3/account', 'GET', 'synthetic-key', undefined]);
  }
});

test('email:preflight --check-account: brak klucza = missing bez zapytania; pod node --test odmawia bez fetch', async () => {
  const stub = accountStub(() => 200);
  const noKey = await runPreflight({ ...BASE_ENV }, { ...fakeResolvers(), checkAccount: true, fetchImpl: stub.fetchImpl, processEnv: {} });
  assert.deepEqual(statusOf(noKey, 'brevo_account'), ['missing']);
  assert.ok(process.env.NODE_TEST_CONTEXT);
  const underRunner = await runPreflight({ ...BASE_ENV, BREVO_API_KEY: 'synthetic-key' }, { ...fakeResolvers(), checkAccount: true, fetchImpl: stub.fetchImpl });
  assert.deepEqual(statusOf(underRunner, 'brevo_account'), ['warning']);
  assert.equal(stub.calls.length, 0);
});
