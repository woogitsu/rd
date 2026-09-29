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
  const board2 = await seedUserSession(db, { userId: 'u-bd2', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
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
  return { db, env, treasurer, board, board2, representative, admin, classBoard, call, count, close: () => db.close() };
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

// --- Bramka „test przed zatwierdzeniem” (#104 pkt 5, D-16) ------------------

// Jedna rodzina syntetyczna z jednym opiekunem (adres @example.invalid),
// żeby migawka miała odbiorcę i zatwierdzenie mogło dojść do bramki.
async function seedFamily(t) {
  await t.db.query("INSERT INTO households (id) VALUES ('h-gate')");
  await t.db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s-gate', 'h-gate', 'Uczeń', 'Testowy')");
  await t.db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', ['e-gate', 's-gate', 'c1', YEAR]);
  await t.db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ('g-gate', 'h-gate', 'Opiekun', 'Testowy', 'opiekun-gate@example.invalid', true)`,
  );
  await t.db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES (\'s-gate\', \'g-gate\', true, true)');
}

async function snapshotAndApprove(t, id) {
  const snap = await t.call(t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
  assert.equal(snap.status, 200, JSON.stringify(snap.body));
  const preview = await t.call(t.board, `/api/email/campaigns/${id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  return t.call(t.board2, `/api/email/campaigns/${id}/approve`, {
    method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
  });
}

async function editBody(t, id, bodyText) {
  const res = await t.call(t.treasurer, `/api/email/campaigns/${id}`, {
    method: 'PUT',
    body: { title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.campaign;
}

test('approve gate: flag on — no test send -> 409 campaign_test_send_required, then test unlocks approval', async () => {
  const t = await setup({ EMAIL_PREVIEW_REQUIRED_BEFORE_APPROVAL: 'true' });
  try {
    await seedFamily(t);
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    const blocked = await snapshotAndApprove(t, campaign.id);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, 'campaign_test_send_required');
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}`)).body.campaign.status, 'draft');
    assert.equal(await t.count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.campaign.approved'`), 0);

    const sent = await testSendCall(t, campaign.id);
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const approved = await snapshotAndApprove(t, campaign.id);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.campaign.status, 'approved');
    // Wyłącznie transport wstrzyknięty: jedna wiadomość testowa, żadna do opiekuna.
    assert.equal(t.env.emailTransport.calls.length, 1);
    assert.equal(t.env.emailTransport.calls[0].to, PREVIEW_ADDRESS);
  } finally { await t.close(); }
});

test('approve gate: content changed after the test requires a new test', async () => {
  const t = await setup({ EMAIL_PREVIEW_REQUIRED_BEFORE_APPROVAL: 'true' });
  try {
    await seedFamily(t);
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    assert.equal((await testSendCall(t, campaign.id)).status, 201);
    const edited = await editBody(t, campaign.id, `${BODY} Dodatkowe zdanie po teście.`);
    assert.notEqual(edited.contentHash, campaign.contentHash);

    const stale = await snapshotAndApprove(t, campaign.id);
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error, 'campaign_test_send_required');

    assert.equal((await testSendCall(t, campaign.id)).status, 201);
    const approved = await snapshotAndApprove(t, campaign.id);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(t.env.emailTransport.calls.length, 2);
  } finally { await t.close(); }
});

test('approve gate: a test attempt rejected by the provider does not satisfy the gate', async () => {
  const t = await setup({ EMAIL_PREVIEW_REQUIRED_BEFORE_APPROVAL: 'true' });
  try {
    await seedFamily(t);
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport({ fail: new EmailTransportError('delivery_unknown', { uncertain: true }) });
    assert.equal((await testSendCall(t, campaign.id)).status, 502);
    const blocked = await snapshotAndApprove(t, campaign.id);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, 'campaign_test_send_required');
  } finally { await t.close(); }
});

test('approve gate: flag off (default, D-16 undecided) — approval works without a test send', async () => {
  const t = await setup();
  try {
    await seedFamily(t);
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    const approved = await snapshotAndApprove(t, campaign.id);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(t.env.emailTransport.calls.length, 0);
  } finally { await t.close(); }
});

test('test-send audit: contentHash and recipient index, never the address', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    const res = await testSendCall(t, campaign.id, { recipientEmail: 'biuro@rada.example.invalid' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { rows } = await t.db.query(
      `SELECT actor_id, entity_id, metadata_json AS metadata FROM audit_events WHERE action = 'email.preview.sent'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_id, 'u-tr');
    assert.equal(rows[0].entity_id, campaign.id);
    const metadata = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    assert.equal(metadata.contentHash, campaign.contentHash);
    assert.equal(metadata.recipientIndex, 1);
    assert.equal(metadata.schoolYearId, YEAR);
    assert.equal(metadata.ok, true);
    assert.doesNotMatch(JSON.stringify(rows[0]), /example\.invalid/);
  } finally { await t.close(); }
});
