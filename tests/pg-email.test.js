// Kampanie e-mail, kolejka i webhook Brevo na PostgreSQL (issues #10, #40).
// Wyłącznie dane syntetyczne (.invalid/.test). Żaden test nie łączy się z siecią:
// globalny fetch jest podmieniony na pułapkę, a wysyłka używa fałszywego transportu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createBrevoTransport, emailConfig, EmailTransportError, matchesAllowlist, recipientRefusal } from '../src/email/brevo.js';
import { normalizeEmail, emailHash, parseCampaignContent } from '../src/email/content.js';
import { campaignDailyCap, recordOtherSends, runEmailBatch } from '../src/email/worker.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error('network_forbidden_in_tests');
};
test.after(() => { globalThis.fetch = realFetch; });

const YEAR = 'y2026';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const WEBHOOK_SECRET = 'w'.repeat(48);
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

function fakeTransport({ fail } = {}) {
  const calls = [];
  return {
    calls,
    name: 'fake',
    async send(message) {
      calls.push(message);
      const error = fail?.(message, calls.length);
      if (error) throw error;
      return { messageId: `fake-${calls.length}-${message.outboxId}` };
    },
  };
}

async function setup(extraEnv = {}) {
  const db = await createTestDb();
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const board2 = await seedUserSession(db, { userId: 'u-bd2', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const env = {
    db,
    APP_ENV: 'development',
    EMAIL_SENDING_ENABLED: 'true',
    EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid',
    BREVO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...extraEnv,
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  return { db, env, treasurer, board, board2, call, count, close: () => db.close() };
}

// Rodzina: dzieci zapisane do klasy c1 i opiekunowie z relacjami do każdego dziecka.
async function family(db, householdId, { students = 1, guardians = [{}] } = {}) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT DO NOTHING', [householdId]);
  const studentIds = [];
  for (let i = 1; i <= students; i += 1) {
    const id = `${householdId}-s${i}`;
    studentIds.push(id);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [id, householdId]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, id, 'c1', YEAR]);
  }
  for (const [index, guardian] of guardians.entries()) {
    const id = guardian.id ?? `${householdId}-g${index + 1}`;
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, 'Opiekun', 'Testowy', $3, $4) ON CONFLICT (id) DO NOTHING`,
      [id, guardian.household ?? householdId, guardian.email === undefined ? `${id}@example.invalid` : guardian.email, guardian.allowed ?? true],
    );
    for (const studentId of studentIds) {
      await db.query(
        'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, $3, $4)',
        [studentId, id, guardian.relation ?? true, guardian.primary ?? false],
      );
    }
  }
}

async function createDraft(t, { cookie = t.treasurer, audience = 'all_households', subject = 'Dobrowolna składka {rok}', bodyText = BODY, key = crypto.randomUUID() } = {}) {
  const res = await t.call(cookie, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': key },
    body: { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience, subject, bodyText },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.campaign;
}

async function snapshot(t, id, cookie = t.treasurer) {
  const res = await t.call(cookie, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function approve(t, id, cookie = t.board) {
  const preview = await t.call(cookie, `/api/email/campaigns/${id}/preview`);
  assert.equal(preview.status, 200);
  return t.call(cookie, `/api/email/campaigns/${id}/approve`, {
    method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
  });
}

async function readyCampaign(t, options = {}) {
  const campaign = await createDraft(t, options);
  await snapshot(t, campaign.id);
  const approved = await approve(t, campaign.id);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const queued = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/queue`, { method: 'POST' });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  return campaign;
}

async function outboxStates(t, campaignId) {
  const { rows } = await t.db.query('SELECT household_id, state, last_error FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [campaignId]);
  return rows;
}

// --- Klient Brevo i bariery -----------------------------------------------

test('real Brevo transport refuses in APP_ENV=test and under node --test without calling fetch', async () => {
  let calls = 0;
  const spy = async () => { calls += 1; return new Response('{}', { status: 201 }); };
  const inTest = createBrevoTransport({ apiKey: 'synthetic-key', appEnv: 'test', fetchImpl: spy, processEnv: {} });
  await assert.rejects(inTest.send({ to: 'a@example.invalid' }), { code: 'transport_disabled_in_test' });
  const underRunner = createBrevoTransport({ apiKey: 'synthetic-key', appEnv: 'development', fetchImpl: spy });
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets NODE_TEST_CONTEXT');
  await assert.rejects(underRunner.send({ to: 'a@example.invalid' }), { code: 'transport_disabled_in_test' });
  assert.equal(calls, 0);
  assert.equal(networkCalls, 0);
});

test('Brevo client sends one recipient per request with api-key header (injected fetch only)', async () => {
  const requests = [];
  const statuses = [201, 429, 503, 400];
  const spy = async (url, init) => {
    requests.push({ url, init });
    const status = statuses[requests.length - 1];
    return new Response(status === 201 ? JSON.stringify({ messageId: '<m1@example.invalid>' }) : '{}', { status });
  };
  const transport = createBrevoTransport({ apiKey: 'synthetic-key', appEnv: 'development', fetchImpl: spy, processEnv: {} });
  const message = { to: 'a@example.invalid', sender: { email: 'rada@example.invalid', name: 'Rada' }, subject: 'S', text: 'T', outboxId: 'o1', idempotencyKey: 'campaign:c:household:h' };
  assert.deepEqual(await transport.send(message), { messageId: '<m1@example.invalid>' });
  const sent = JSON.parse(requests[0].init.body);
  assert.equal(requests[0].init.headers['api-key'], 'synthetic-key');
  assert.deepEqual(sent.to, [{ email: 'a@example.invalid' }]);
  assert.equal(sent.headers['X-RD-Idempotency-Key'], 'campaign:c:household:h');
  assert.equal(sent.headers['X-Mailin-custom'], 'o1');
  await assert.rejects(transport.send(message), (e) => e instanceof EmailTransportError && e.retryable && !e.uncertain);
  await assert.rejects(transport.send(message), (e) => e.code === 'delivery_unknown' && e.uncertain && !e.retryable);
  await assert.rejects(transport.send(message), (e) => e.code === 'provider_rejected_400' && !e.retryable);
  await assert.rejects(transport.send({ ...message, to: ['a@example.invalid', 'b@example.invalid'] }), { code: 'single_recipient_required' });
  assert.equal(networkCalls, 0);
});

test('allowlist guard outside production and configuration defaults', () => {
  const config = emailConfig({ APP_ENV: 'staging', EMAIL_TEST_ALLOWLIST: '*@example.invalid, ops@example.test, bad pattern' });
  assert.deepEqual(config.allowlist, ['*@example.invalid', 'ops@example.test']);
  assert.equal(recipientRefusal(config, 'x@example.invalid'), null);
  assert.equal(recipientRefusal(config, 'ops@example.test'), null);
  assert.equal(recipientRefusal(config, 'other@example.test'), 'recipient_not_allowlisted');
  assert.equal(recipientRefusal(emailConfig({ APP_ENV: 'development' }), 'x@example.invalid'), 'recipient_not_allowlisted');
  assert.equal(matchesAllowlist(['*@example.invalid'], 'x@sub.example.invalid'), false);
  const defaults = emailConfig({});
  assert.equal(defaults.sendingEnabled, false);
  assert.equal(defaults.dailyLimit, 300);
  assert.equal(defaults.minDays, 7);
  assert.equal(emailConfig({ EMAIL_SENDING_ENABLED: 'TRUE' }).sendingEnabled, false);
  assert.equal(campaignDailyCap(2000, defaults), 286);
  assert.equal(campaignDailyCap(10, defaults), 50);
});

test('content validation rejects debt wording, unknown placeholders and invalid e-mails', async () => {
  assert.throws(() => parseCampaignContent({ title: 'Test', audience: 'all_households', subject: 'Zaległość {rok}', bodyText: BODY }), { code: 'forbidden_wording' });
  assert.throws(() => parseCampaignContent({ title: 'Test', audience: 'all_households', subject: 'Składka', bodyText: `${BODY} lista dłużników` }), { code: 'forbidden_wording' });
  assert.throws(() => parseCampaignContent({ title: 'Test', audience: 'all_households', subject: 'Składka', bodyText: `${BODY} {imie_dziecka}` }), { code: 'invalid_placeholder' });
  assert.throws(() => parseCampaignContent({ title: 'Test', audience: 'all_households', subject: 'Składka {rodzina}', bodyText: BODY }), { code: 'invalid_placeholder' });
  assert.throws(() => parseCampaignContent({ title: 'Test', audience: 'debtors', subject: 'Składka', bodyText: BODY }), { code: 'invalid_audience' });
  assert.equal(normalizeEmail(' Opiekun@Example.INVALID '), 'opiekun@example.invalid');
  for (const bad of ['brak-malpy', 'a@b', 'a..b@example.invalid', 'a@example.invalid, b@example.invalid', '<a@example.invalid>', 'a b@example.invalid', null]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }

  const t = await setup();
  try {
    const res = await t.call(t.treasurer, '/api/email/campaigns', {
      method: 'POST', headers: { 'Idempotency-Key': 'campaign-key-1' },
      body: { schoolYearId: YEAR, title: 'Test', audience: 'all_households', subject: 'Składka', bodyText: `${BODY} Wezwanie do zapłaty.` },
    });
    assert.deepEqual(res, { status: 400, body: { error: 'forbidden_wording' } });
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_campaigns'), 0);
  } finally { await t.close(); }
});

// --- Uprawnienia i zatwierdzanie ------------------------------------------

test('access: MFA and board/treasurer role required; admin and representative denied; Origin enforced', async () => {
  const t = await setup();
  try {
    const noMfa = await seedUserSession(t.db, { userId: 'u-nomfa', roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    const rep = await seedUserSession(t.db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] });
    const admin = await seedUserSession(t.db, { userId: 'u-adm', mfa: true, roles: [{ role: 'admin' }] });
    const otherYear = await seedUserSession(t.db, { userId: 'u-oy', mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y2025' }] });
    const body = { schoolYearId: YEAR, title: 'Test', audience: 'all_households', subject: 'Składka', bodyText: BODY };
    const post = (cookie, extra = {}) => t.call(cookie, '/api/email/campaigns', { method: 'POST', headers: { 'Idempotency-Key': 'campaign-key-2' }, body, ...extra });
    assert.equal((await post(null)).status, 401);
    for (const cookie of [noMfa, rep, admin, otherYear]) assert.equal((await post(cookie)).status, 403);
    assert.deepEqual((await post(t.treasurer, { origin: 'https://evil.example' })).body, { error: 'invalid_origin' });
    assert.equal((await post(t.treasurer)).status, 201);
    const replay = await post(t.treasurer);
    assert.equal(replay.status, 200, 'double click replays');
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_campaigns'), 1);
  } finally { await t.close(); }
});

test('no send before approval; author and snapshot builder cannot self-approve; stale hashes rejected', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    const campaign = await createDraft(t);
    await snapshot(t, campaign.id);
    const transport = fakeTransport();

    const early = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/queue`, { method: 'POST' });
    assert.deepEqual(early, { status: 409, body: { error: 'approval_required' } });
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.sent, 0);
    assert.equal(transport.calls.length, 0);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_outbox'), 0);

    // Treasurer nie ma roli zatwierdzającej.
    const preview = (await t.call(t.board, `/api/email/campaigns/${campaign.id}/preview`)).body;
    const hashes = { contentHash: preview.contentHash, recipientsHash: preview.recipientsHash };
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/approve`, { method: 'POST', body: hashes })).status, 403);

    // Członek zarządu, który zbudował listę, jest współautorem.
    await snapshot(t, campaign.id, t.board);
    const selfPreview = (await t.call(t.board, `/api/email/campaigns/${campaign.id}/preview`)).body;
    const self = await t.call(t.board, `/api/email/campaigns/${campaign.id}/approve`, {
      method: 'POST', body: { contentHash: selfPreview.contentHash, recipientsHash: selfPreview.recipientsHash },
    });
    assert.deepEqual(self, { status: 403, body: { error: 'self_approval_forbidden' } });

    const stale = await t.call(t.board2, `/api/email/campaigns/${campaign.id}/approve`, {
      method: 'POST', body: { contentHash: selfPreview.contentHash, recipientsHash: 'f'.repeat(64) },
    });
    assert.deepEqual(stale, { status: 409, body: { error: 'approval_stale' } });

    const ok = await approve(t, campaign.id, t.board2);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.campaign.status, 'approved');
    assert.equal(ok.body.campaign.approvedBy, 'u-bd2');
    const again = await approve(t, campaign.id, t.board2);
    assert.equal(again.status, 200, 'double click on approve is idempotent');

    // Baza też pilnuje zasady czterech oczu.
    await assert.rejects(t.db.query("UPDATE email_campaigns SET status = 'draft', approved_by = NULL, approved_at = NULL, approved_content_hash = NULL, approved_recipients_hash = NULL WHERE id = $1", [campaign.id]).then(() =>
      t.db.query("UPDATE email_campaigns SET status = 'approved', approved_by = created_by, approved_at = now(), approved_content_hash = content_hash, approved_recipients_hash = recipients_hash WHERE id = $1", [campaign.id])), /four_eyes/);
  } finally { await t.close(); }
});

test('any change after approval invalidates it (content or recipient snapshot)', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    const campaign = await createDraft(t);
    await snapshot(t, campaign.id);
    assert.equal((await approve(t, campaign.id)).status, 200);

    const edit = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}`, {
      method: 'PUT', body: { title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka – rok {rok}', bodyText: BODY },
    });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.approvalInvalidated, true);
    assert.equal(edit.body.campaign.status, 'draft');
    assert.equal(edit.body.campaign.approvedBy, null);
    assert.deepEqual(await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/queue`, { method: 'POST' }), { status: 409, body: { error: 'approval_required' } });

    assert.equal((await approve(t, campaign.id)).status, 200);
    await family(t.db, 'h2');
    const rebuilt = await snapshot(t, campaign.id);
    assert.equal(rebuilt.approvalInvalidated, true);
    assert.equal(rebuilt.recipientsCount, 2);
    assert.equal((await t.call(t.board, `/api/email/campaigns/${campaign.id}`)).body.campaign.status, 'draft');

    // Bezpośrednia zmiana treści zatwierdzonej kampanii w bazie jest odrzucana.
    assert.equal((await approve(t, campaign.id)).status, 200);
    await assert.rejects(t.db.query("UPDATE email_campaigns SET subject = 'Inny temat' WHERE id = $1", [campaign.id]), /email_campaign_change_requires_reapproval/);
    const queued = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/queue`, { method: 'POST' });
    assert.equal(queued.status, 200);
    assert.equal(queued.body.queued, 2);
    const locked = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}`, {
      method: 'PUT', body: { title: 'X y z', audience: 'all_households', subject: 'Nowy temat', bodyText: BODY },
    });
    assert.deepEqual(locked, { status: 409, body: { error: 'campaign_locked' } });
    await assert.rejects(t.db.query('DELETE FROM email_campaign_recipients WHERE campaign_id = $1', [campaign.id]), /email_snapshot_locked/);
  } finally { await t.close(); }
});

// --- Migawka odbiorców ------------------------------------------------------

test('snapshot: consent required, invalid e-mail excluded, siblings and two guardians deduplicated', async () => {
  const t = await setup();
  try {
    // Rodzeństwo i dwoje opiekunów w jednej rodzinie → jedna wiadomość do kontaktu głównego.
    await family(t.db, 'h1', { students: 2, guardians: [{}, { primary: true }] });
    await family(t.db, 'h2', { guardians: [{ allowed: false }] });           // brak zgody opiekuna
    await family(t.db, 'h3', { guardians: [{ relation: false }] });          // brak zgody w relacji
    await family(t.db, 'h4', { guardians: [{ email: 'niepoprawny@@example' }] });
    await family(t.db, 'h5', { guardians: [{ email: null }] });
    // Opiekun h1-g2 jest też opiekunem dziecka z h6 (inne gospodarstwo) — adres się nie powtarza.
    await family(t.db, 'h6', { guardians: [{ id: 'h1-g2', household: 'h1', primary: true }, {}] });
    await family(t.db, 'h7', { guardians: [{ id: 'h1-g2', household: 'h1', primary: true }] });
    await t.db.query("INSERT INTO households (id) VALUES ('h8')");                // brak dzieci w roku
    const campaign = await createDraft(t);
    const result = await snapshot(t, campaign.id);
    assert.equal(result.recipientsCount, 2);
    assert.deepEqual(result.exclusions, { no_consent: 2, no_valid_email: 2, duplicate_address: 1 });
    const { rows } = await t.db.query('SELECT household_id, guardian_id FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY household_id', [campaign.id]);
    assert.deepEqual(rows, [{ household_id: 'h1', guardian_id: 'h1-g2' }, { household_id: 'h6', guardian_id: 'h6-g2' }]);
    await assert.rejects(t.db.query(
      "INSERT INTO email_campaign_recipients (id, campaign_id, household_id, guardian_id, email, email_hash) VALUES ('dup', $1, 'h1', 'h1-g1', 'h1-g1@example.invalid', $2)",
      [campaign.id, emailHash('h1-g1@example.invalid')],
    ), /duplicate key/);

    const preview = await t.call(t.board, `/api/email/campaigns/${campaign.id}/preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.sends, false);
    assert.equal(preview.body.recipientsCount, 2);
    assert.equal(preview.body.sample.subject, 'Dobrowolna składka test y2026');
    assert.match(preview.body.sample.text, /Tytuł przelewu: h1\./);
    assert.equal(preview.body.sample.recipient, 'h***@example.invalid');
    assert.equal(preview.body.plan.days, 1);

    const list = await t.call(t.board, `/api/email/campaigns/${campaign.id}/recipients`);
    assert.equal(list.body.recipients.length, 2);
    const viewed = await t.count("SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.recipients.viewed'");
    assert.equal(viewed, 1);
  } finally { await t.close(); }
});

// --- Worker ---------------------------------------------------------------

test('dry-run renders and records a run but sends nothing and changes no queue state', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await family(t.db, 'h2');
    const campaign = await readyCampaign(t);
    const transport = fakeTransport();
    const run = await runEmailBatch(t.env, { transport, dryRun: true, now: DAY1 });
    assert.equal(run.mode, 'dry_run');
    assert.equal(run.planned, 2);
    assert.equal(run.sent, 0);
    assert.equal(run.sample.subject, 'Dobrowolna składka test y2026');
    assert.equal(transport.calls.length, 0);
    assert.deepEqual((await outboxStates(t, campaign.id)).map((r) => r.state), ['queued', 'queued']);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_send_ledger'), 0);
    assert.equal(await t.count("SELECT count(*)::int AS n FROM email_worker_runs WHERE mode = 'dry_run' AND planned = 2"), 1);
  } finally { await t.close(); }
});

test('live run requires EMAIL_SENDING_ENABLED=true and a configured sender', async () => {
  const t = await setup({ EMAIL_SENDING_ENABLED: 'false' });
  try {
    await family(t.db, 'h1');
    const campaign = await readyCampaign(t);
    const transport = fakeTransport();
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.stoppedReason, 'sending_disabled');
    const noSender = await runEmailBatch({ ...t.env, EMAIL_SENDING_ENABLED: 'true', BREVO_FROM_EMAIL: '' }, { transport, dryRun: false, now: DAY1 });
    assert.equal(noSender.stoppedReason, 'sender_not_configured');
    assert.equal(transport.calls.length, 0);
    assert.deepEqual((await outboxStates(t, campaign.id)).map((r) => r.state), ['queued']);
  } finally { await t.close(); }
});

test('live run sends each message separately; rerun and double queue never duplicate', async () => {
  const t = await setup();
  try {
    for (const id of ['h1', 'h2', 'h3']) await family(t.db, id);
    const campaign = await readyCampaign(t);
    const replay = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/queue`, { method: 'POST' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.queued, 0);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_outbox'), 3);

    const transport = fakeTransport();
    const first = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    const second = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 60_000) });
    assert.equal(first.sent, 3);
    assert.equal(second.sent, 0);
    assert.equal(transport.calls.length, 3);
    assert.equal(new Set(transport.calls.map((m) => m.to)).size, 3);
    assert.ok(transport.calls.every((m) => typeof m.to === 'string'));
    assert.deepEqual(transport.calls.map((m) => m.idempotencyKey).sort(), ['h1', 'h2', 'h3'].map((h) => `campaign:${campaign.id}:household:${h}`));
    assert.match(transport.calls[0].text, /dobrowolnej składki na rok test y2026/);
    assert.equal(await t.count("SELECT count(*)::int AS n FROM email_outbox WHERE state = 'sent' AND provider_message_id IS NOT NULL"), 3);
    assert.equal((await t.call(t.board, `/api/email/campaigns/${campaign.id}`)).body.campaign.status, 'done');
    await assert.rejects(t.db.query("UPDATE email_outbox SET state = 'queued' WHERE campaign_id = $1", [campaign.id]), /email_outbox_invalid_transition/);
    await assert.rejects(t.db.query('DELETE FROM email_outbox'), /email_outbox_cannot_be_deleted/);

    // Audyt bez adresów e-mail.
    const { rows } = await t.db.query("SELECT metadata_json::text AS m FROM audit_events WHERE action LIKE 'email.%'");
    assert.ok(rows.length >= 6);
    assert.ok(rows.every((row) => !row.m.includes('@')));
  } finally { await t.close(); }
});

test('retry: 429 is retried with backoff exactly once; uncertain delivery is never retried', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await family(t.db, 'h2');
    const campaign = await readyCampaign(t);
    let h1Attempts = 0;
    const transport = fakeTransport({
      fail: (message) => {
        if (message.idempotencyKey.endsWith('h1') && (h1Attempts += 1) === 1) return new EmailTransportError('provider_rate_limited', { retryable: true });
        if (message.idempotencyKey.endsWith('h2')) return new EmailTransportError('delivery_unknown', { uncertain: true });
        return null;
      },
    });
    const first = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(first.retried, 1);
    assert.equal(first.failed, 1);
    const tooEarly = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 60_000) });
    assert.equal(tooEarly.sent, 0);
    const later = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 10 * 60_000) });
    assert.equal(later.sent, 1);
    await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 24 * 3600_000) });
    assert.deepEqual(await outboxStates(t, campaign.id), [
      { household_id: 'h1', state: 'sent', last_error: null },
      { household_id: 'h2', state: 'failed', last_error: 'delivery_unknown' },
    ]);
    assert.equal(transport.calls.filter((m) => m.idempotencyKey.endsWith('h2')).length, 1);
  } finally { await t.close(); }
});

test('stale sending row (crash after claim) is marked delivery_unknown and not resent', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    const campaign = await readyCampaign(t);
    await t.db.query("UPDATE email_outbox SET state = 'sending', attempts = 1, claimed_at = $2 WHERE campaign_id = $1", [campaign.id, DAY1.toISOString()]);
    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
    assert.equal(transport.calls.length, 0);
    assert.deepEqual((await outboxStates(t, campaign.id))[0], { household_id: 'h1', state: 'failed', last_error: 'delivery_unknown' });
  } finally { await t.close(); }
});

test('daily limit is shared with other account mail and EMAIL_DAILY_RESERVED', async () => {
  const t = await setup({ EMAIL_CAMPAIGN_MIN_DAILY: '100' });
  try {
    for (let i = 1; i <= 20; i += 1) await family(t.db, `h${String(i).padStart(2, '0')}`);
    await readyCampaign(t);
    await recordOtherSends(t.db, { day: '2026-10-05', count: 295 });
    const transport = fakeTransport();
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.remainingQuota, 5);
    assert.equal(run.sent, 5);
    assert.equal(run.stoppedReason, 'daily_quota_reached');
    assert.equal((await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 })).sent, 0);

    const reservedEnv = { ...t.env, EMAIL_DAILY_RESERVED: '290' };
    await recordOtherSends(t.db, { day: '2026-10-06', count: 5 });
    const day2 = await runEmailBatch(reservedEnv, { transport, dryRun: false, now: new Date('2026-10-06T08:00:00Z') });
    assert.equal(day2.sent, 5);
    assert.equal(transport.calls.length, 10);
  } finally { await t.close(); }
});

test('about 2000 recipients are spread over at least 7 days, each exactly once', { timeout: 300_000 }, async () => {
  const t = await setup({ EMAIL_BATCH_SIZE: '500' });
  try {
    const db = t.db;
    await db.query("INSERT INTO households (id) SELECT 'h' || lpad(i::text, 4, '0') FROM generate_series(1, 2000) i");
    await db.query(`INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      SELECT 'g' || lpad(i::text, 4, '0'), 'h' || lpad(i::text, 4, '0'), 'Opiekun', 'Testowy', 'g' || i || '@example.invalid', true FROM generate_series(1, 2000) i`);
    await db.query(`INSERT INTO students (id, household_id, first_name, last_name)
      SELECT 's' || lpad(i::text, 4, '0'), 'h' || lpad(i::text, 4, '0'), 'Uczeń', 'Testowy' FROM generate_series(1, 2000) i`);
    await db.query(`INSERT INTO enrollments (id, student_id, class_id, school_year_id)
      SELECT 'e' || lpad(i::text, 4, '0'), 's' || lpad(i::text, 4, '0'), 'c1', '${YEAR}' FROM generate_series(1, 2000) i`);
    await db.query(`INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact)
      SELECT 's' || lpad(i::text, 4, '0'), 'g' || lpad(i::text, 4, '0'), true, true FROM generate_series(1, 2000) i`);
    const campaign = await readyCampaign(t);
    assert.equal((await t.call(t.board, `/api/email/campaigns/${campaign.id}`)).body.campaign.dailyCap, 286);

    const transport = fakeTransport();
    const perDay = [];
    for (let day = 0; day < 14; day += 1) {
      const base = new Date(DAY1.getTime() + day * 24 * 3600_000);
      let sentToday = 0;
      for (let hour = 0; hour < 8; hour += 1) {
        const run = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(base.getTime() + hour * 3600_000) });
        sentToday += run.sent;
        if (!run.sent) break;
      }
      if (!sentToday) break;
      perDay.push(sentToday);
    }
    assert.ok(perDay.length >= 7, `days: ${perDay.length}`);
    assert.ok(perDay.every((n) => n <= 286 && n <= 300));
    assert.equal(perDay.reduce((a, b) => a + b, 0), 2000);
    assert.equal(transport.calls.length, 2000);
    assert.equal(new Set(transport.calls.map((m) => m.idempotencyKey)).size, 2000);
  } finally { await t.close(); }
});

test('payment recorded after queueing → message skipped (brak wpisu wpłaty may be outdated)', async () => {
  const t = await setup();
  try {
    for (const id of ['h1', 'h2', 'h3']) await family(t.db, id);
    const payment = (id, household) => t.db.query(
      `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
       VALUES ($1, $2, $3, 1000, '2026-10-01', 'bank', 'recorded', 'u-tr', $4)`,
      [id, household, YEAR, `payment-key-${id}`],
    );
    await payment('p1', 'h1');
    const campaign = await readyCampaign(t, { audience: 'no_payment_record' });
    const preview = await t.call(t.board, `/api/email/campaigns/${campaign.id}/preview`);
    assert.deepEqual(preview.body.exclusions, { payment_recorded: 1 });
    await payment('p2', 'h2');   // wpłata dotarła po zatwierdzeniu listy
    const transport = fakeTransport();
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.sent, 1);
    assert.equal(run.skipped, 1);
    assert.deepEqual(await outboxStates(t, campaign.id), [
      { household_id: 'h2', state: 'skipped', last_error: 'payment_recorded' },
      { household_id: 'h3', state: 'sent', last_error: null },
    ]);
  } finally { await t.close(); }
});

test('withdrawn consent after queueing blocks the message', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    const campaign = await readyCampaign(t);
    await t.db.query("UPDATE student_guardians SET contact_allowed = false WHERE guardian_id = 'h1-g1'");
    const transport = fakeTransport();
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.suppressed, 1);
    assert.equal(transport.calls.length, 0);
    assert.deepEqual((await outboxStates(t, campaign.id))[0].state, 'suppressed');
  } finally { await t.close(); }
});

test('non-production allowlist refuses real-looking addresses before the transport', async () => {
  const t = await setup({ APP_ENV: 'staging', EMAIL_TEST_ALLOWLIST: 'tech@example.invalid' });
  try {
    await family(t.db, 'h1', { guardians: [{ email: 'tech@example.invalid' }] });
    await family(t.db, 'h2', { guardians: [{ email: 'rodzic@example.test' }] });
    const campaign = await readyCampaign(t);
    const transport = fakeTransport();
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.sent, 1);
    assert.deepEqual(transport.calls.map((m) => m.to), ['tech@example.invalid']);
    assert.deepEqual(await outboxStates(t, campaign.id), [
      { household_id: 'h1', state: 'sent', last_error: null },
      { household_id: 'h2', state: 'failed', last_error: 'recipient_not_allowlisted' },
    ]);
  } finally { await t.close(); }
});

test('cancel stops queued messages', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await family(t.db, 'h2');
    const campaign = await readyCampaign(t);
    const cancelled = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.cancelledMessages, 2);
    const transport = fakeTransport();
    assert.equal((await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 })).sent, 0);
    assert.equal(transport.calls.length, 0);
    const status = await t.call(t.board, `/api/email/campaigns/${campaign.id}`);
    assert.deepEqual(status.body.outbox, { cancelled: 2 });
  } finally { await t.close(); }
});

// --- Potwierdzenie przed każdą wysyłką (#210) i token dzierżawy (#177) -------
// PGlite szereguje zapytania, więc przeplot wymuszamy w atrapie transportu:
// akcja „z drugiego okna” wykonuje się w trakcie pierwszego wywołania send.
// Kolejność przejęcia zależy od losowych id wierszy, więc akcja dotyczy
// gospodarstwa innego niż to, którego wiadomość właśnie wychodzi.

const householdOf = (message) => message.idempotencyKey.split(':household:')[1];
const otherThan = (message, candidates) => candidates.find((id) => id !== householdOf(message));

function interleavingTransport(onFirstSend) {
  const transport = fakeTransport();
  const send = transport.send.bind(transport);
  let fired = false;
  transport.send = async (message) => {
    const result = await send(message);
    if (!fired) { fired = true; await onFirstSend(message); }
    return result;
  };
  return transport;
}

async function auditFor(t, outboxId) {
  const { rows } = await t.db.query(
    "SELECT action, metadata_json->>'reason' AS reason FROM audit_events WHERE entity_type = 'email_outbox' AND entity_id = $1 ORDER BY occurred_at, id",
    [outboxId],
  );
  return rows;
}

async function outboxIds(t, campaignId) {
  const { rows } = await t.db.query('SELECT household_id, id FROM email_outbox WHERE campaign_id = $1', [campaignId]);
  return Object.fromEntries(rows.map((row) => [row.household_id, row.id]));
}

test('cancel during a batch: no further message is sent; double click and job retry send nothing', async () => {
  const t = await setup();
  try {
    for (const id of ['h1', 'h2', 'h3', 'h4', 'h5']) await family(t.db, id);
    const campaign = await readyCampaign(t);
    const responses = [];
    const transport = interleavingTransport(async () => {
      responses.push(await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/cancel`, { method: 'POST' }));
      responses.push(await t.call(t.board, `/api/email/campaigns/${campaign.id}/cancel`, { method: 'POST' }));
    });
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    assert.equal(transport.calls.length, 1, 'only the message already in transport.send went out');
    assert.equal(run.sent, 1);
    assert.equal(run.skipped, 4);
    assert.equal(run.stoppedReason, 'campaign_cancelled');
    const states = await outboxStates(t, campaign.id);
    assert.equal(states.filter((r) => r.state === 'sent').length, 1);
    assert.equal(states.filter((r) => r.state === 'cancelled' && r.last_error === 'campaign_cancelled').length, 4);
    assert.equal(await t.count("SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.campaign.cancelled'"), 1);
    assert.equal(await t.count(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.cancelled' AND metadata_json->>'stage' = 'before_send'",
    ), 4);
    // Ponowienie zadania po anulowaniu: nic do przejęcia, 0 wysyłek.
    const retry = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 60_000) });
    assert.equal(retry.planned, 0);
    assert.equal(transport.calls.length, 1);
    assert.equal((await t.call(t.board, `/api/email/campaigns/${campaign.id}`)).body.campaign.status, 'cancelled');
  } finally { await t.close(); }
});

test('consent withdrawn during a batch: message suppressed, no switch to the second guardian', async () => {
  const t = await setup();
  try {
    // Dwoje opiekunów jednego dziecka; adresatem z migawki jest kontakt główny.
    for (const id of ['h1', 'h2', 'h3']) await family(t.db, id, { guardians: [{ primary: true }, {}] });
    const campaign = await readyCampaign(t);
    const ids = await outboxIds(t, campaign.id);
    let target;
    const transport = interleavingTransport(async (message) => {
      target = otherThan(message, ['h1', 'h2']);
      await t.db.query('UPDATE guardians SET contact_allowed = false WHERE id = $1', [`${target}-g1`]);
    });
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.sent, 2);
    assert.equal(run.suppressed, 1);
    assert.equal(transport.calls.length, 2);
    assert.ok(transport.calls.every((m) => householdOf(m) !== target && m.to.endsWith('-g1@example.invalid')),
      'no message to the withdrawn guardian and no switch to the second guardian');
    assert.deepEqual((await outboxStates(t, campaign.id)).find((r) => r.household_id === target),
      { household_id: target, state: 'suppressed', last_error: 'consent_or_address_changed' });
    assert.deepEqual(await auditFor(t, ids[target]), [{ action: 'email.suppressed', reason: 'consent_or_address_changed' }]);
  } finally { await t.close(); }
});

test('partial payment recorded during a no_payment_record batch skips only that household (siblings elsewhere still get it)', async () => {
  const t = await setup();
  try {
    for (const id of ['h1', 'h2', 'h3']) await family(t.db, id, { students: 2 });   // rodzeństwo w każdym gospodarstwie
    const campaign = await readyCampaign(t, { audience: 'no_payment_record' });
    let target;
    const transport = interleavingTransport(async (message) => {
      target = otherThan(message, ['h1', 'h2']);
      // Wpłata częściowa 5 EUR (500 centów) tylko dla jednego gospodarstwa.
      await t.db.query(
        `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
         VALUES ('p-mid', $2, $1, 500, '2026-10-05', 'bank', 'recorded', 'u-tr', 'payment-key-mid')`,
        [YEAR, target],
      );
    });
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.sent, 2);
    assert.equal(run.skipped, 1);
    assert.equal(transport.calls.filter((m) => householdOf(m) === target).length, 0);
    for (const row of await outboxStates(t, campaign.id)) {
      assert.deepEqual(row, row.household_id === target
        ? { household_id: target, state: 'skipped', last_error: 'payment_recorded' }
        : { household_id: row.household_id, state: 'sent', last_error: null });
    }
  } finally { await t.close(); }
});

test('address suppressed during a batch is not sent', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await family(t.db, 'h2');
    const campaign = await readyCampaign(t);
    let target;
    const transport = interleavingTransport(async (message) => {
      target = otherThan(message, ['h1', 'h2']);
      await t.db.query("INSERT INTO email_suppressions (email_hash, reason) VALUES ($1, 'hard_bounce')", [emailHash(`${target}-g1@example.invalid`)]);
    });
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.sent, 1);
    assert.equal(run.suppressed, 1);
    assert.deepEqual((await outboxStates(t, campaign.id)).find((r) => r.household_id === target),
      { household_id: target, state: 'suppressed', last_error: 'address_suppressed' });
  } finally { await t.close(); }
});

test('run longer than the lease: a second run takes over, every message is sent at most once, audit matches states', async () => {
  const t = await setup();
  try {
    for (const id of ['h1', 'h2', 'h3']) await family(t.db, id);
    const campaign = await readyCampaign(t);
    const ids = await outboxIds(t, campaign.id);
    const runs = {};
    const transport = interleavingTransport(async () => {
      runs.second = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 16 * 60_000) });
    });
    runs.first = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    const keys = transport.calls.map((m) => m.idempotencyKey);
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 3, 'no message sent twice');
    // Pierwszy przebieg wysłał jedną wiadomość i utracił dzierżawę; dwie pozostałe wysłał drugi.
    const lost = householdOf(transport.calls[0]);
    const rest = ['h1', 'h2', 'h3'].filter((id) => id !== lost);
    assert.equal(runs.first.sent, 0);
    assert.equal(runs.first.stoppedReason, 'lease_lost');
    assert.equal(runs.second.sent, 2);
    for (const row of await outboxStates(t, campaign.id)) {
      assert.deepEqual(row, row.household_id === lost
        ? { household_id: lost, state: 'failed', last_error: 'delivery_unknown' }
        : { household_id: row.household_id, state: 'sent', last_error: null });
    }
    const sentRows = await t.count("SELECT count(*)::int AS n FROM email_outbox WHERE state = 'sent'");
    assert.equal(runs.first.sent + runs.second.sent, sentRows);
    assert.deepEqual((await auditFor(t, ids[lost])).map((e) => e.action), ['email.delivery_unknown', 'email.sent_after_lease_lost']);
    for (const household of rest) {
      assert.deepEqual((await auditFor(t, ids[household])).map((e) => e.action),
        ['email.lease_expired_requeued', 'email.sent', 'email.send_aborted']);
    }
    assert.equal(await t.count("SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.sent'"), sentRows);
  } finally { await t.close(); }
});

test('job retried while the first run is still sending (lease valid): nothing is claimed twice', async () => {
  const t = await setup();
  try {
    for (const id of ['h1', 'h2', 'h3']) await family(t.db, id);
    const campaign = await readyCampaign(t);
    const runs = {};
    const transport = interleavingTransport(async () => {
      runs.second = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 60_000) });
    });
    runs.first = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(runs.first.sent, 3);
    assert.equal(runs.second.planned, 0);
    assert.equal(new Set(transport.calls.map((m) => m.idempotencyKey)).size, 3);
    assert.equal(transport.calls.length, 3);
    assert.ok((await outboxStates(t, campaign.id)).every((r) => r.state === 'sent'));
  } finally { await t.close(); }
});

test('database refuses to cancel or un-start a message whose send has started', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    const campaign = await readyCampaign(t);
    await t.db.query(
      "UPDATE email_outbox SET state = 'sending', attempts = 1, claimed_at = $2, claim_token = $3, send_started_at = $2 WHERE campaign_id = $1",
      [campaign.id, DAY1.toISOString(), crypto.randomUUID()],
    );
    for (const state of ['cancelled', 'skipped', 'suppressed']) {
      await assert.rejects(t.db.query('UPDATE email_outbox SET state = $2 WHERE campaign_id = $1', [campaign.id, state]), /email_outbox_invalid_transition/);
    }
    await assert.rejects(t.db.query('UPDATE email_outbox SET send_started_at = NULL WHERE campaign_id = $1', [campaign.id]), /email_outbox_send_started_immutable/);
    // Ponowienie po wygaśnięciu dzierżawy: rozpoczęta wysyłka → delivery_unknown, bez ponownej wysyłki.
    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
    assert.equal(transport.calls.length, 0);
    assert.deepEqual((await outboxStates(t, campaign.id))[0], { household_id: 'h1', state: 'failed', last_error: 'delivery_unknown' });
  } finally { await t.close(); }
});

// --- Webhook ----------------------------------------------------------------

function webhookRequest(body, authorization) {
  const headers = { 'Content-Type': 'application/json' };
  if (authorization) headers.Authorization = authorization;
  return request('/api/email/webhooks/brevo', { method: 'POST', origin: false, headers, body: JSON.stringify(body) });
}

test('webhook: missing or wrong secret is rejected; bounce suppresses the address', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await family(t.db, 'h2');
    const campaign = await readyCampaign(t);
    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    const sent = transport.calls.find((m) => m.to === 'h1-g1@example.invalid');
    const { rows: [row] } = await t.db.query('SELECT provider_message_id FROM email_outbox WHERE id = $1', [sent.outboxId]);
    const event = { event: 'hard_bounce', email: 'h1-g1@example.invalid', 'message-id': row.provider_message_id, ts_event: 1791187200, id: 1 };

    const send = async (body, auth, env = t.env) => {
      const res = await handlePgRequest(webhookRequest(body, auth), env);
      return { status: res.status, body: await res.json() };
    };
    assert.deepEqual(await send(event), { status: 401, body: { error: 'invalid_signature' } });
    assert.deepEqual(await send(event, `Bearer ${'x'.repeat(48)}`), { status: 401, body: { error: 'invalid_signature' } });
    assert.deepEqual(await send(event, `Bearer ${WEBHOOK_SECRET}x`), { status: 401, body: { error: 'invalid_signature' } });
    assert.deepEqual(await send(event, `Bearer ${WEBHOOK_SECRET}`, { ...t.env, BREVO_WEBHOOK_SECRET: '' }), { status: 503, body: { error: 'webhook_not_configured' } });
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_webhook_events'), 0);

    const ok = await send(event, `Bearer ${WEBHOOK_SECRET}`);
    assert.deepEqual(ok, { status: 200, body: { received: 1, recorded: 1, suppressed: 1 } });
    const duplicate = await send(event, `Basic ${Buffer.from(`brevo:${WEBHOOK_SECRET}`).toString('base64')}`);
    assert.deepEqual(duplicate.body, { received: 1, recorded: 0, suppressed: 0 });
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_webhook_events'), 1);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppressions WHERE email_hash = $1', [emailHash('h1-g1@example.invalid')]), 1);
    assert.equal((await outboxStates(t, campaign.id))[0].state, 'bounced');
    const { rows: stored } = await t.db.query('SELECT row_to_json(e)::text AS j FROM email_webhook_events e');
    assert.ok(!stored[0].j.includes('@example.invalid'), 'webhook log stores only address hash');

    // Nowa kampania pomija adres z listy wyłączeń.
    const next = await createDraft(t);
    const snap = await snapshot(t, next.id);
    assert.equal(snap.recipientsCount, 1);
    assert.deepEqual(snap.exclusions, { suppressed: 1 });

    // Webhook to jedyna trasa bez Origin; pozostałe nadal wymagają zgodnego Origin.
    const foreign = await handlePgRequest(request(`/api/email/campaigns/${next.id}/cancel`, { method: 'POST', cookie: t.treasurer, origin: false }), t.env);
    assert.equal(foreign.status, 403);
    assert.equal(networkCalls, 0);
  } finally { await t.close(); }
});

test('no test in this file touched the network', () => {
  assert.equal(networkCalls, 0);
});
