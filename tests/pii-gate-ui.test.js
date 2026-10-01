// #152: klient — podpowiedź przy polach wolnego tekstu i potwierdzenie zapisu
// (ponowienie z tym samym kluczem idempotencji). Logika czysta, bez DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApiClient } from '../shared/api.js';
import { describeCategories } from '../shared/pii-confirm.js';
import { buildActionRequest } from '../events/core.js';
import { postUrl } from '../news/core.js';

const read = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

// Pola formularzy paneli, które zapisują wolny tekst do tabel niezmiennych.
const FIELDS = {
  'panel/index.html': ['reference', 'reason'],
  'ledger/index.html': ['description', 'reason', 'note'],
  'reconciliation/index.html': ['notes', 'reason', 'confirmationNote'],
  'meetings/index.html': ['description', 'body', 'changeNote', 'approvalNote', 'reason'],
  'year-close/index.html': ['note'],
  'families/index.html': ['reason'],
  'documents/index.html': ['title', 'description', 'reason'],
  'events/index.html': ['title', 'reason'],
  // #146 (0159): okno „Odrzuć” wniosku o nadanie roli — opcjonalny powód.
  'admin/index.html': ['reason'],
  // Powód wycofania aktualności (news_posts.withdrawal_reason); odwołanie wydarzenia jest w events/.
  'news/index.html': ['reason'],
};

test('każde pole wolnego tekstu z niezmiennej tabeli ma w panelu krótką podpowiedź o danych osobowych', () => {
  const missing = [];
  for (const [file, names] of Object.entries(FIELDS)) {
    const html = read(file);
    for (const name of names) {
      const labels = [...html.matchAll(new RegExp(`<label[^>]*>(?:(?!</label>)[\\s\\S])*?name="${name}"[\\s\\S]*?</label>`, 'g'))];
      assert.ok(labels.length > 0, `${file}: brak pola ${name}`);
      for (const label of labels) {
        if (!label[0].includes('class="pii-hint"')) missing.push(`${file}:${name}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('podpowiedź nie wymienia konkretnych danych ani nie obiecuje wykrycia nazwisk', () => {
  const hint = read('panel/index.html').match(/<small class="pii-hint">([^<]+)<\/small>/)[1];
  assert.match(hint, /niezmienny/);
  assert.match(hint, /nie wpisuj/i);
});

test('opis kategorii do okna potwierdzenia nie zawiera treści tekstu', () => {
  assert.deepEqual(describeCategories(['phone', 'known_name']).length, 2);
  assert.deepEqual(describeCategories(['email', 'nieznana']), [], 'e-mail nie jest potwierdzalny — brak opisu');
  assert.deepEqual(describeCategories(undefined), []);
});

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  };
  return { fetchImpl, calls };
}

test('422 possible_personal_data: po potwierdzeniu to samo żądanie wraca z confirmPersonalData i tym samym kluczem', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 422, body: { error: 'possible_personal_data', categories: ['phone'] } },
    { status: 201, body: { ok: true } },
  ]);
  const asked = [];
  const client = createApiClient({
    fetchImpl, getLocation: () => ({ pathname: '/panel/' }), navigate: () => {},
    confirmPersonalData: async (info) => { asked.push(info); return true; },
  });
  const result = await client.request('/api/payments/p1/corrections', {
    method: 'POST', headers: { 'Idempotency-Key': 'key-0001-abcd' }, body: JSON.stringify({ amountCents: 100, reason: 'Zwrot, tel. +32 470 12 34 56' }),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(asked, [{ categories: ['phone'] }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers['Idempotency-Key'], 'key-0001-abcd');
  assert.equal(JSON.parse(calls[0].init.body).confirmPersonalData, undefined);
  assert.equal(JSON.parse(calls[1].init.body).confirmPersonalData, true);
});

test('anulowanie potwierdzenia nie ponawia żądania; personal_data_forbidden nigdy nie jest ponawiane', async () => {
  const cancelled = fakeFetch([{ status: 422, body: { error: 'possible_personal_data', categories: ['phone'] } }]);
  const clientCancel = createApiClient({
    fetchImpl: cancelled.fetchImpl, getLocation: () => ({ pathname: '/panel/' }), navigate: () => {},
    confirmPersonalData: async () => false,
  });
  await assert.rejects(clientCancel.request('/api/x', { method: 'POST', body: { reason: 'abc' } }), { code: 'possible_personal_data', status: 422 });
  assert.equal(cancelled.calls.length, 1);

  const forbidden = fakeFetch([{ status: 422, body: { error: 'personal_data_forbidden', categories: ['email'] } }]);
  let asked = false;
  const clientForbidden = createApiClient({
    fetchImpl: forbidden.fetchImpl, getLocation: () => ({ pathname: '/panel/' }), navigate: () => {},
    confirmPersonalData: async () => { asked = true; return true; },
  });
  await assert.rejects(clientForbidden.request('/api/x', { method: 'POST', body: { reason: 'abc' } }), (error) => {
    assert.equal(error.code, 'personal_data_forbidden');
    assert.match(error.message, /nie można tego potwierdzić/);
    return true;
  });
  assert.equal(asked, false);
  assert.equal(forbidden.calls.length, 1);
});

test('drugi 422 po potwierdzeniu nie wpada w pętlę', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 422, body: { error: 'possible_personal_data', categories: ['phone'] } },
    { status: 422, body: { error: 'personal_data_forbidden', categories: ['phone', 'email'] } },
  ]);
  const client = createApiClient({
    fetchImpl, getLocation: () => ({ pathname: '/panel/' }), navigate: () => {}, confirmPersonalData: async () => true,
  });
  await assert.rejects(client.request('/api/x', { method: 'POST', body: { reason: 'abc' } }), { code: 'personal_data_forbidden' });
  assert.equal(calls.length, 2);
});

// Odwołanie wydarzenia i wycofanie aktualności: panele używają wspólnego klienta,
// więc 422 possible_personal_data kończy się potwierdzeniem i ponowieniem z confirmPersonalData.
test('odwołanie wydarzenia: 422 possible_personal_data → potwierdzenie → ponowienie z tym samym powodem', async () => {
  const request = buildActionRequest('evt-1', 'cancel', 3, 'Odwołane, kontakt +32 470 12 34 56');
  const { fetchImpl, calls } = fakeFetch([
    { status: 422, body: { error: 'possible_personal_data', categories: ['phone'] } },
    { status: 200, body: { ok: true } },
  ]);
  const asked = [];
  const client = createApiClient({
    fetchImpl, getLocation: () => ({ pathname: '/events/' }), navigate: () => {},
    confirmPersonalData: async (info) => { asked.push(info); return true; },
  });
  await client.request(request.url, { method: request.method, headers: request.headers, body: request.body });
  assert.deepEqual(asked, [{ categories: ['phone'] }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/events/evt-1/cancel');
  const first = JSON.parse(calls[0].init.body);
  const retry = JSON.parse(calls[1].init.body);
  assert.equal(first.confirmPersonalData, undefined);
  assert.deepEqual(retry, { ...first, confirmPersonalData: true });
  assert.equal(retry.revision, 3);
});

test('wycofanie aktualności: 422 possible_personal_data → potwierdzenie → ponowienie; odmowa nie ponawia', async () => {
  const body = { revision: 2, reason: 'Wycofane, tel. +32 470 12 34 56' };
  const accepted = fakeFetch([
    { status: 422, body: { error: 'possible_personal_data', categories: ['phone', 'known_name'] } },
    { status: 200, body: { ok: true } },
  ]);
  const client = createApiClient({
    fetchImpl: accepted.fetchImpl, getLocation: () => ({ pathname: '/news/' }), navigate: () => {},
    confirmPersonalData: async () => true,
  });
  await client.request(postUrl('post-1', 'withdraw'), { method: 'POST', body });
  assert.equal(accepted.calls.length, 2);
  assert.equal(accepted.calls[1].url, '/api/news/post-1/withdraw');
  assert.deepEqual(JSON.parse(accepted.calls[1].init.body), { ...body, confirmPersonalData: true });

  const declined = fakeFetch([{ status: 422, body: { error: 'possible_personal_data', categories: ['phone'] } }]);
  const clientDecline = createApiClient({
    fetchImpl: declined.fetchImpl, getLocation: () => ({ pathname: '/news/' }), navigate: () => {},
    confirmPersonalData: async () => false,
  });
  await assert.rejects(clientDecline.request(postUrl('post-1', 'withdraw'), { method: 'POST', body }), { code: 'possible_personal_data' });
  assert.equal(declined.calls.length, 1);
});

test('panele wydarzeń i aktualności wywołują akcje przez wspólny klient bez własnego obejścia bramki', () => {
  for (const file of ['events/main.js', 'news/main.js']) {
    const source = read(file);
    assert.match(source, /import \{ api as apiRequest \} from "\.\.\/shared\/api\.js"/, `${file}: wspólny klient`);
    assert.doesNotMatch(source, /createApiClient|confirmPersonalData\s*:/, `${file}: bramka tylko we wspólnym kliencie`);
  }
  assert.match(read('events/main.js'), /runAction\("cancel", checked\.reason\)/);
  assert.match(read('news/main.js'), /postUrl\(post\.id, "withdraw"\), \{ method: "POST", body: \{ revision: post\.revision, reason \}/);
});
