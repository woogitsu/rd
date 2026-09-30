// Propozycje rozstrzygnięć `npm run email:reconcile` (#139) — części bez bazy.
// Bez sieci: zapytania do Brevo idą wyłącznie przez atrapę fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupBrevoEvents, proposeFromEvents } from '../src/email/reconcile.js';
import { parseReconcileArgs } from '../scripts/email-reconcile.js';
import { networkGuardCalls } from './helpers/network-guard.js';

test('proposeFromEvents: doręczenie > odbicie > przyjęcie > brak dowodu; nigdy confirmed_not_sent', () => {
  assert.deepEqual(proposeFromEvents(['request', 'delivered'], 'webhook'), { proposal: 'confirmed_delivered', evidenceCode: 'webhook_delivered' });
  assert.deepEqual(proposeFromEvents(['opened'], 'brevo_api'), { proposal: 'confirmed_delivered', evidenceCode: 'brevo_api_delivered' });
  assert.deepEqual(proposeFromEvents(['request', 'hard_bounce'], 'webhook'), { proposal: 'review_bounced', evidenceCode: null });
  assert.deepEqual(proposeFromEvents(['request', 'soft_bounce'], 'webhook'), { proposal: 'review_accepted_by_provider', evidenceCode: null });
  assert.deepEqual(proposeFromEvents([], 'webhook'), { proposal: 'check_brevo_logs', evidenceCode: null });
  for (const events of [[], ['error'], ['blocked'], ['deferred']]) {
    assert.notEqual(proposeFromEvents(events, 'webhook').proposal, 'confirmed_not_sent');
  }
});

test('lookupBrevoEvents: brak klucza, błędy HTTP i brak połączenia dają kody, bez wyjątku', async () => {
  let calls = 0;
  const answer = (status, body = '{}') => async () => { calls += 1; return new Response(body, { status }); };
  assert.deepEqual(await lookupBrevoEvents('<m@x.invalid>', { fetchImpl: answer(200), processEnv: {} }), { code: 'api_key_missing', events: [] });
  assert.equal(calls, 0);
  assert.equal((await lookupBrevoEvents('<m@x.invalid>', { apiKey: 'k', fetchImpl: answer(401), processEnv: {} })).code, 'provider_status_401');
  assert.equal((await lookupBrevoEvents('<m@x.invalid>', { apiKey: 'k', fetchImpl: answer(200, 'nie-json'), processEnv: {} })).code, 'provider_invalid_response');
  const unreachable = async () => { calls += 1; throw new TypeError('fetch failed'); };
  assert.equal((await lookupBrevoEvents('<m@x.invalid>', { apiKey: 'k', fetchImpl: unreachable, processEnv: {} })).code, 'provider_unreachable');
  const unknownName = await lookupBrevoEvents('<m@x.invalid>', { apiKey: 'k', fetchImpl: answer(200, '{"events":[{"event":"futureKind"},{"event":"softBounces"}]}'), processEnv: {} });
  assert.deepEqual(unknownName, { code: 'ok', events: ['soft_bounce'] });
  assert.equal(calls, 4);
  // Pod node --test (domyślne process.env) odmowa przed fetch.
  assert.ok(process.env.NODE_TEST_CONTEXT);
  assert.equal((await lookupBrevoEvents('<m@x.invalid>', { apiKey: 'k', fetchImpl: answer(200) })).code, 'lookup_disabled_in_test');
  assert.equal(calls, 4);
  assert.equal(networkGuardCalls(), 0);
});

test('parseReconcileArgs: tylko --campaign <id> i --query-brevo', () => {
  assert.deepEqual(parseReconcileArgs([]), { campaignId: null, queryBrevo: false });
  assert.deepEqual(parseReconcileArgs(['--campaign', 'camp-1', '--query-brevo']), { campaignId: 'camp-1', queryBrevo: true });
  assert.throws(() => parseReconcileArgs(['--campaign']), /invalid_campaign_id/);
  assert.throws(() => parseReconcileArgs(['--campaign', "x'; DROP"]), /invalid_campaign_id/);
  assert.throws(() => parseReconcileArgs(['--send']), /unknown_argument/);
});
