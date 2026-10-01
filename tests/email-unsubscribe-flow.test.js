// Wypisanie jednym kliknięciem — przepływ od podglądu do wysyłki (issue #110).
// Uzupełnia tests/email-preferences.test.js. Wyłącznie dane syntetyczne
// (.invalid), fałszywy transport albo wstrzyknięty fetch; żadna wiadomość nie
// wychodzi (globalny fetch jest pułapką, helpers/pg.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createBrevoTransport } from '../src/email/brevo.js';
import { emailHash, preferencesToken, verifyPreferencesToken } from '../src/email/content.js';
import { runEmailBatch } from '../src/email/worker.js';
import { redactString, sanitizePath } from '../src/log.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const YEAR = 'y2026';
const SECRET = 'u'.repeat(40);
const BASE_URL = 'https://rada.example.invalid';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';
const PREVIEW_ADDRESS = 'skarbnik-test@rada.example.invalid';

function fakeTransport() {
  const calls = [];
  return { calls, async send(message) { calls.push(message); return { messageId: `<m${calls.length}@example.invalid>` }; } };
}

async function setup(extraEnv = {}) {
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const env = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true',
    EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    EMAIL_PREVIEW_RECIPIENTS: PREVIEW_ADDRESS,
    BREVO_FROM_EMAIL: 'rada@example.invalid',
    EMAIL_UNSUBSCRIBE_SECRET: SECRET,
    PUBLIC_BASE_URL: BASE_URL,
    ...extraEnv,
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  return { db, env, treasurer, board, call, count, close: () => db.close() };
}

async function family(db, householdId, email) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT DO NOTHING', [householdId]);
  const studentId = `${householdId}-s1`;
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [studentId, householdId]);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${studentId}`, studentId, 'c1', YEAR]);
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true)`, [`${householdId}-g1`, householdId, email],
  );
  await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, true)', [studentId, `${householdId}-g1`]);
}

async function createDraft(t, category = 'contribution_reminder') {
  const res = await t.call(t.treasurer, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', category, subject: 'Dobrowolna składka {rok}', bodyText: BODY },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.campaign;
}

async function readyCampaign(t, category) {
  const campaign = await createDraft(t, category);
  assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/snapshot`, { method: 'POST' })).status, 200);
  const preview = await t.call(t.board, `/api/email/campaigns/${campaign.id}/preview`);
  assert.equal(preview.status, 200);
  const approved = await t.call(t.board, `/api/email/campaigns/${campaign.id}/approve`, {
    method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const queued = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/queue`, { method: 'POST' });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  return campaign;
}

function tokenPath(campaign, address, category = campaign.category) {
  const token = preferencesToken(SECRET, { campaignId: campaign.id, category, emailHash: emailHash(address) });
  return `/api/email/preferences?t=${encodeURIComponent(token)}`;
}

test('worker: opt-out between queueing and sending suppresses only that row (category_opted_out), nothing goes out for it', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', 'rodzic1@example.invalid');
    await family(t.db, 'h2', 'rodzic2@example.invalid');
    const campaign = await readyCampaign(t);
    assert.equal(await t.count(`SELECT count(*)::int AS n FROM email_outbox WHERE campaign_id = $1 AND state = 'queued'`, [campaign.id]), 2);

    // Wypisanie po zakolejkowaniu, przed przebiegiem workera.
    const optOut = await t.call(null, tokenPath(campaign, 'rodzic1@example.invalid'), { method: 'POST' });
    assert.equal(optOut.status, 200);

    const transport = fakeTransport();
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.sent, 1);
    assert.equal(run.suppressed, 1);
    assert.deepEqual(transport.calls.map((m) => m.to), ['rodzic2@example.invalid']);
    const { rows } = await t.db.query('SELECT household_id, state, last_error, send_started_at FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [campaign.id]);
    assert.deepEqual(rows.map((r) => [r.household_id, r.state, r.last_error]), [['h1', 'suppressed', 'category_opted_out'], ['h2', 'sent', null]]);
    assert.equal(rows[0].send_started_at, null, 'wiersz wypisany nie zaczął wysyłki');
    // Kolejny przebieg niczego nie wznawia.
    const again = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 60_000) });
    assert.equal(again.sent, 0);
    assert.equal(transport.calls.length, 1);
  } finally { await t.close(); }
});

test('worker: opt-out from another category does not block this campaign', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', 'rodzic1@example.invalid');
    const campaign = await readyCampaign(t, 'contribution_reminder');
    const res = await t.call(null, tokenPath(campaign, 'rodzic1@example.invalid', 'organizational'), { method: 'POST' });
    assert.equal(res.status, 200);
    const transport = fakeTransport();
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.sent, 1);
    assert.equal(transport.calls.length, 1);
  } finally { await t.close(); }
});

test('preview shows the unsubscribe footer with an opaque link for both categories (conservative variant, D-06)', async () => {
  const t = await setup();
  try {
    for (const category of ['contribution_reminder', 'organizational']) {
      await family(t.db, `h-${category}`, `${category.slice(0, 5)}@example.invalid`);
      const campaign = await createDraft(t, category);
      const preview = await t.call(t.board, `/api/email/campaigns/${campaign.id}/preview`);
      assert.equal(preview.status, 200);
      const { text } = preview.body.sample;
      const link = text.match(/otwórz: (https:\/\/\S+)$/);
      assert.ok(link, `stopka w podglądzie (${category})`);
      const url = new URL(link[1]);
      assert.equal(url.origin, BASE_URL);
      assert.equal(url.pathname, '/api/email/preferences');
      const payload = verifyPreferencesToken(SECRET, url.searchParams.get('t'));
      assert.equal(payload.campaignId, campaign.id);
      assert.equal(payload.category, category);
      assert.doesNotMatch(url.search, /@|example\.invalid/, "w parametrze nie ma adresu");
      assert.equal(preview.body.sends, false);
    }
  } finally { await t.close(); }
});

test('preview without EMAIL_UNSUBSCRIBE_SECRET / PUBLIC_BASE_URL has no footer (documented behaviour)', async () => {
  const t = await setup({ EMAIL_UNSUBSCRIBE_SECRET: '', PUBLIC_BASE_URL: '' });
  try {
    const campaign = await createDraft(t);
    const preview = await t.call(t.board, `/api/email/campaigns/${campaign.id}/preview`);
    assert.doesNotMatch(preview.body.sample.text, /zrezygnować|preferences/);
  } finally { await t.close(); }
});

test('test-send message carries the footer and one-click headers like a real one', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    t.env.emailTransport = fakeTransport();
    const res = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/test-send`, {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { recipientEmail: PREVIEW_ADDRESS },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const [sent] = t.env.emailTransport.calls;
    assert.match(sent.text, /Aby zrezygnować z tej kategorii wiadomości, otwórz: https:\/\/rada\.example\.invalid\/api\/email\/preferences\?t=/);
    assert.ok(sent.unsubscribeUrl?.startsWith(`${BASE_URL}/api/email/preferences?t=`));
    // Token testu nie wskazuje adresu odbiorcy testu.
    const payload = verifyPreferencesToken(SECRET, new URL(sent.unsubscribeUrl).searchParams.get('t'));
    assert.notEqual(payload.emailHash, emailHash(PREVIEW_ADDRESS));
  } finally { await t.close(); }
});

test('Brevo request from the worker has List-Unsubscribe and List-Unsubscribe-Post (RFC 8058); fetch is a stub', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', 'rodzic1@example.invalid');
    const campaign = await readyCampaign(t);
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ messageId: '<m1@example.invalid>' }), { status: 201 });
    };
    const transport = createBrevoTransport({ apiKey: 'synthetic-key', appEnv: 'development', fetchImpl, processEnv: {} });
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.sent, 1);
    assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0].init.body);
    const link = body.headers['List-Unsubscribe'];
    assert.match(link, /^<https:\/\/rada\.example\.invalid\/api\/email\/preferences\?t=[^>]+>$/);
    assert.equal(body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.ok(body.textContent.includes(link.slice(1, -1)), 'ten sam link w stopce i w nagłówku');
    const payload = verifyPreferencesToken(SECRET, new URL(link.slice(1, -1)).searchParams.get('t'));
    assert.equal(payload.campaignId, campaign.id);
    assert.equal(payload.emailHash, emailHash('rodzic1@example.invalid'));
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('Brevo transport omits unsubscribe headers when the message has no unsubscribe link', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push(JSON.parse(init.body)); return new Response('{}', { status: 201 }); };
  const transport = createBrevoTransport({ apiKey: 'synthetic-key', appEnv: 'development', fetchImpl, processEnv: {} });
  await transport.send({ to: 'a@example.invalid', sender: { email: 'rada@example.invalid', name: 'Rada' }, subject: 'S', text: 'T', outboxId: 'o1', idempotencyKey: 'k' });
  assert.equal(requests[0].headers['List-Unsubscribe'], undefined);
  assert.equal(requests[0].headers['List-Unsubscribe-Post'], undefined);
});

test('one-click POST needs no session and no same-origin Origin (mail provider POST); GET changes nothing', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    const path = tokenPath(campaign, 'rodzic1@example.invalid');
    // Bez ciasteczka, z obcym Origin i bez Origin — jak POST od dostawcy poczty.
    const cross = await t.call(null, path, { method: 'POST', origin: 'https://mail.example.invalid', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(cross.status, 200, JSON.stringify(cross.body));
    assert.equal(cross.body.optedOut, true);
    const noOrigin = await t.call(null, path, { method: 'POST', origin: null, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(noOrigin.status, 200);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preferences_events'), 1);
    // GET po wypisaniu nadal tylko pokazuje kategorię i nie dopisuje zdarzeń.
    const show = await t.call(null, path);
    assert.equal(show.status, 200);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preferences_events'), 1);
    // Obce Origin nie otwiera innych tras POST (np. tworzenia kampanii).
    const other = await t.call(null, '/api/email/campaigns', { method: 'POST', origin: 'https://mail.example.invalid', body: {} });
    assert.ok([401, 403].includes(other.status), String(other.status));
  } finally { await t.close(); }
});

test('token: single effect per (address, category), no expiry, cannot be reused for another address; audit has no address', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    const path = tokenPath(campaign, 'rodzic1@example.invalid');
    for (let i = 0; i < 3; i += 1) assert.equal((await t.call(null, path, { method: 'POST' })).status, 200);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preferences_events'), 1, 'jedno zdarzenie mimo trzech kliknięć');
    assert.equal(await t.count(`SELECT count(*)::int AS n FROM email_preferences_events WHERE email_hash = $1`, [emailHash('rodzic1@example.invalid')]), 1);
    assert.equal(await t.count(`SELECT count(*)::int AS n FROM email_preferences_events WHERE email_hash = $1`, [emailHash('rodzic2@example.invalid')]), 0);
    // Token jest bezstanowy i nie ma terminu ważności (świadomie: link w starej wiadomości ma działać); tabela jest append-only, więc czasu nie cofamy.
    assert.equal((await t.call(null, path, { method: 'POST' })).status, 200);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preferences_events'), 1);
    // Audyt: kategoria i źródło, bez adresu i jego skrótu.
    const { rows } = await t.db.query(`SELECT metadata_json AS metadata FROM audit_events WHERE action = 'email.preference.opt_out'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metadata.category, 'contribution_reminder');
    assert.equal(rows[0].metadata.source, 'link');
    const serialized = JSON.stringify(rows[0].metadata);
    assert.doesNotMatch(serialized, /example\.invalid|@/);
    assert.ok(!serialized.includes(emailHash('rodzic1@example.invalid')));
  } finally { await t.close(); }
});

test('token signed with another secret, truncated or malformed is rejected with the same 400', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    const hash = emailHash('rodzic1@example.invalid');
    const foreign = preferencesToken('x'.repeat(40), { campaignId: campaign.id, category: 'contribution_reminder', emailHash: hash });
    const good = preferencesToken(SECRET, { campaignId: campaign.id, category: 'contribution_reminder', emailHash: hash });
    for (const token of [foreign, good.split('.')[0], `${good}x`, '', 'a.b', 'a'.repeat(2500)]) {
      const res = await t.call(null, `/api/email/preferences?t=${encodeURIComponent(token)}`, { method: 'POST' });
      assert.equal(res.status, 400, token.slice(0, 20));
      assert.deepEqual(res.body, { error: 'invalid_token' });
    }
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preferences_events'), 0);
  } finally { await t.close(); }
});

test('log redaction drops the ?t= unsubscribe token from URLs', () => {
  const token = preferencesToken(SECRET, { campaignId: 'c-1', category: 'contribution_reminder', emailHash: emailHash('rodzic1@example.invalid') });
  const url = `${BASE_URL}/api/email/preferences?t=${encodeURIComponent(token)}`;
  assert.ok(!redactString(`POST ${url} 200`).includes(token.slice(0, 20)));
  assert.equal(sanitizePath(`/api/email/preferences?t=${token}`), '/api/email/preferences');
});
