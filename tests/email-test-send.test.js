// Wysyłka testowa kampanii (issue #104). Wyłącznie dane syntetyczne
// (.invalid/.test). Transport jest wstrzyknięty przez `env.emailTransport` —
// żaden test nie łączy się z siecią (globalny fetch jest pułapką, helpers/pg.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { EmailTransportError } from '../src/email/brevo.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const YEAR = 'y2026';
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';
const PREVIEW_ADDRESS = 'skarbnik-test@rada.example.invalid';

function fakeTransport({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async send(message) {
      calls.push(message);
      if (fail) throw fail;
      return { messageId: `<m${calls.length}@example.invalid>` };
    },
  };
}

async function setup(extraEnv = {}) {
  const db = await createTestDb();
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const representative = await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] });
  const admin = await seedUserSession(db, { userId: 'u-admin', mfa: true, roles: [{ role: 'admin' }] });
  const classBoard = await seedUserSession(db, { userId: 'u-cbd', mfa: true, roles: [{ role: 'board', classId: 'c1', schoolYearId: YEAR }] });
  const env = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true',
    EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    EMAIL_PREVIEW_RECIPIENTS: `${PREVIEW_ADDRESS}, biuro@rada.example.invalid`,
    BREVO_FROM_EMAIL: 'rada@example.invalid',
    ...extraEnv,
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  return { db, env, treasurer, board, representative, admin, classBoard, call, count, close: () => db.close() };
}

async function createDraft(t, { cookie = t.treasurer, key = crypto.randomUUID() } = {}) {
  const res = await t.call(cookie, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': key },
    body: { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.campaign;
}

function testSendCall(t, campaignId, { cookie = t.treasurer, key = crypto.randomUUID(), recipientEmail = PREVIEW_ADDRESS } = {}) {
  return t.call(cookie, `/api/email/campaigns/${campaignId}/test-send`, {
    method: 'POST', headers: { 'Idempotency-Key': key }, body: { recipientEmail },
  });
}

test('test-send: only EMAIL_PREVIEW_RECIPIENTS, never a guardian address', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    const notAllowed = await testSendCall(t, campaign.id, { recipientEmail: 'ktos@example.invalid' });
    assert.equal(notAllowed.status, 403);
    assert.equal(notAllowed.body.error, 'preview_recipient_not_allowed');

    // Dane syntetyczne: adres z listy testowej równy adresowi opiekuna w bazie -> odmowa.
    await t.db.query(
      `INSERT INTO households (id) VALUES ('h1') ON CONFLICT DO NOTHING`,
    );
    await t.db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ('g1', 'h1', 'Opiekun', 'Testowy', $1, true)`,
      [PREVIEW_ADDRESS],
    );
    const guardianClash = await testSendCall(t, campaign.id, { recipientEmail: PREVIEW_ADDRESS });
    assert.equal(guardianClash.status, 403);
    assert.equal(guardianClash.body.error, 'preview_recipient_not_allowed');
    assert.equal(t.env.emailTransport.calls.length, 0);
  } finally { await t.close(); }
});

test('test-send: role boundaries — representative, admin and class board get 403', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    for (const cookie of [t.representative, t.admin, t.classBoard]) {
      const res = await testSendCall(t, campaign.id, { cookie });
      assert.equal(res.status, 403, JSON.stringify(res.body));
    }
    assert.equal(t.env.emailTransport.calls.length, 0);
  } finally { await t.close(); }
});

test('test-send: double click with the same Idempotency-Key sends one message', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    const key = crypto.randomUUID();
    const first = await testSendCall(t, campaign.id, { key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const replay = await testSendCall(t, campaign.id, { key });
    assert.equal(replay.status, 200);
    assert.equal(t.env.emailTransport.calls.length, 1);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preview_sends'), 1);
    assert.equal(await t.count(`SELECT count(*)::int AS n FROM email_send_ledger WHERE source = 'preview'`), 1);
    // Temat ma prefiks [TEST] i {rodzina} = PRZYKLAD, jak w podglądzie.
    assert.match(t.env.emailTransport.calls[0].subject, /^\[TEST\] /);
    assert.match(t.env.emailTransport.calls[0].text, /PRZYKLAD/);
  } finally { await t.close(); }
});

test('test-send: EMAIL_SENDING_ENABLED≠true refuses without any network call', async () => {
  const t = await setup({ EMAIL_SENDING_ENABLED: 'false' });
  try {
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    const res = await testSendCall(t, campaign.id);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'sending_disabled');
    assert.equal(t.env.emailTransport.calls.length, 0);
  } finally { await t.close(); }
});

test('test-send: campaign and account daily limits (429)', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    for (let i = 0; i < 5; i += 1) {
      const res = await testSendCall(t, campaign.id);
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    const sixth = await testSendCall(t, campaign.id);
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.error, 'preview_campaign_limit');
  } finally { await t.close(); }
});

test('test-send: provider 429/5xx is recorded as delivery_unknown-like failure, no automatic retry', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport({ fail: new EmailTransportError('delivery_unknown', { uncertain: true }) });
    const res = await testSendCall(t, campaign.id);
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'delivery_unknown');
    assert.equal(t.env.emailTransport.calls.length, 1);
    // Próba zużywa pulę dnia mimo błędu dostawcy (to była prawdziwa próba wysyłki).
    assert.equal(await t.count(`SELECT count(*)::int AS n FROM email_send_ledger WHERE source = 'preview'`), 1);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preview_sends WHERE provider_message_id IS NULL'), 1);
  } finally { await t.close(); }
});

test('test-send: invalid address on the allowlist is rejected while parsing configuration', async () => {
  const t = await setup({ EMAIL_PREVIEW_RECIPIENTS: 'not-an-address, *@wildcard.invalid, ok@rada.example.invalid' });
  try {
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    assert.deepEqual(t.env.emailTransport.calls, []);
    const allowedOk = await testSendCall(t, campaign.id, { recipientEmail: 'ok@rada.example.invalid' });
    assert.equal(allowedOk.status, 201, JSON.stringify(allowedOk.body));
    const wildcardRejected = await testSendCall(t, campaign.id, { recipientEmail: 'anything@wildcard.invalid' });
    assert.equal(wildcardRejected.status, 403);
  } finally { await t.close(); }
});

test('test-send does not change campaign status, snapshot or approval', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    await testSendCall(t, campaign.id);
    const status = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.campaign.status, 'draft');
    assert.equal(status.body.campaign.recipientsHash, null);
  } finally { await t.close(); }
});
