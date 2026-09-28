// Kategorie komunikatów i wypisanie jednym kliknięciem (issue #110).
// Wyłącznie dane syntetyczne (.invalid/.test). Żaden test nie łączy się z siecią
// (globalny fetch jest pułapką, helpers/pg.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { emailHash, preferencesToken } from '../src/email/content.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const YEAR = 'y2026';
const SECRET = 's'.repeat(40);
const WEBHOOK_SECRET = 'w'.repeat(48);
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

async function setup(extraEnv = {}) {
  const db = await createTestDb();
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const env = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true',
    EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid',
    BREVO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    EMAIL_UNSUBSCRIBE_SECRET: SECRET,
    PUBLIC_BASE_URL: 'https://rada.example.invalid',
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

async function createDraft(t, { cookie = t.treasurer, category = 'contribution_reminder', key = crypto.randomUUID() } = {}) {
  const res = await t.call(cookie, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': key },
    body: { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', category, subject: 'Dobrowolna składka {rok}', bodyText: BODY },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.campaign;
}

async function snapshot(t, id, cookie = t.treasurer) {
  const res = await t.call(cookie, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

function optOutUrl(campaignId, category, hash) {
  const token = preferencesToken(SECRET, { campaignId, category, emailHash: hash });
  return `/api/email/preferences?t=${encodeURIComponent(token)}`;
}

test('campaign defaults to contribution_reminder category and includes it in the content hash', async () => {
  const t = await setup();
  try {
    const draft = await createDraft(t);
    assert.equal(draft.category, 'contribution_reminder');
  } finally { await t.close(); }
});

test('preferences GET has no effect, POST is idempotent (one event on double click)', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    await family(t.db, 'h1', { guardians: [{ email: 'rodzic1@example.invalid' }] });
    const hash = emailHash('rodzic1@example.invalid');
    const url = optOutUrl(campaign.id, 'contribution_reminder', hash);
    const show = await t.call(null, url);
    assert.equal(show.status, 200);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preferences_events'), 0);
    const first = await t.call(null, url, { method: 'POST' });
    assert.equal(first.status, 200);
    assert.equal(first.body.optedOut, true);
    const second = await t.call(null, url, { method: 'POST' });
    assert.equal(second.status, 200);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preferences_events'), 1);
  } finally { await t.close(); }
});

test('tampered or cross-campaign token is rejected without revealing the reason (400)', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    const hash = emailHash('rodzic1@example.invalid');
    const good = preferencesToken(SECRET, { campaignId: campaign.id, category: 'contribution_reminder', emailHash: hash });
    const tampered = `${good.slice(0, -1)}${good.at(-1) === 'a' ? 'b' : 'a'}`;
    const res = await t.call(null, `/api/email/preferences?t=${encodeURIComponent(tampered)}`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_token');

    // Token poprawny kryptograficznie, ale wskazujący inną kategorię tej samej
    // kampanii — opt-out dotyczy (adres, kategoria), więc to działa niezależnie.
    const otherCategoryToken = preferencesToken(SECRET, { campaignId: campaign.id, category: 'organizational', emailHash: hash });
    const res2 = await t.call(null, `/api/email/preferences?t=${encodeURIComponent(otherCategoryToken)}`, { method: 'POST' });
    assert.equal(res2.status, 200);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preferences_events'), 1);
    assert.equal(await t.count(`SELECT count(*)::int AS n FROM email_preferences_events WHERE category = 'organizational'`), 1);
  } finally { await t.close(); }
});

test('two guardians of one child: opting out one address lets the snapshot pick the other', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    await family(t.db, 'h1', { guardians: [{ email: 'rodzic1@example.invalid', primary: true }, { email: 'rodzic2@example.invalid' }] });
    const hash1 = emailHash('rodzic1@example.invalid');
    await t.call(null, optOutUrl(campaign.id, 'contribution_reminder', hash1), { method: 'POST' });
    const result = await snapshot(t, campaign.id);
    assert.equal(result.recipientsCount, 1);
    assert.deepEqual(result.exclusions, {});
    const { rows } = await t.db.query('SELECT email FROM email_campaign_recipients WHERE campaign_id = $1', [campaign.id]);
    assert.equal(rows[0].email, 'rodzic2@example.invalid');
  } finally { await t.close(); }
});

test('siblings sharing one address in two households: opt-out excludes both with opted_out', async () => {
  const t = await setup();
  try {
    const campaign = await createDraft(t);
    await family(t.db, 'h1', { guardians: [{ email: 'wspolny@example.invalid' }] });
    await family(t.db, 'h2', { guardians: [{ id: 'h2-g1', email: 'wspolny@example.invalid' }] });
    const hash = emailHash('wspolny@example.invalid');
    await t.call(null, optOutUrl(campaign.id, 'contribution_reminder', hash), { method: 'POST' });
    const result = await snapshot(t, campaign.id);
    assert.equal(result.recipientsCount, 0);
    assert.equal(result.exclusions.opted_out, 2);
  } finally { await t.close(); }
});

test('webhook "unsubscribed" without a matching outbox row records the event without any global block', async () => {
  const t = await setup();
  try {
    const res = await t.call(null, '/api/email/webhooks/brevo', {
      method: 'POST', headers: { Authorization: `Bearer ${WEBHOOK_SECRET}` },
      body: { event: 'unsubscribed', email: 'nieznany@example.invalid', id: 'no-match', ts_event: 1791187200 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.recorded, 1);
    assert.equal(res.body.suppressed, 0);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppressions'), 0);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_preferences_events'), 0);
  } finally { await t.close(); }
});

test('spam complaint still creates a global suppression (unlike unsubscribed)', async () => {
  const t = await setup();
  try {
    const res = await t.call(null, '/api/email/webhooks/brevo', {
      method: 'POST', headers: { Authorization: `Bearer ${WEBHOOK_SECRET}` },
      body: { event: 'spam', email: 'skarzacy@example.invalid', id: 'no-match-2', ts_event: 1791187200 },
    });
    assert.equal(res.status, 200);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppressions'), 1);
  } finally { await t.close(); }
});
