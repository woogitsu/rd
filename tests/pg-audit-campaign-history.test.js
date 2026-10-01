// #181: historia kampanii e-mail obejmuje zdarzenia workera (ponowienie i
// wysyłka) i odróżnia je od zdarzeń ludzi oraz webhooka (`source`, `actorKind`).
// Dane syntetyczne (@example.invalid); transport to atrapa, bez sieci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { runEmailBatch } from '../src/email/worker.js';
import { EmailTransportError } from '../src/email/brevo.js';
import { auditEventSource } from '../shared/audit-actions.js';
import { createTestDb, request, seedClass, seedPublishedPrivacyNotice, seedUserSession } from './helpers/pg.js';

const YEAR = 'y2026';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

async function setup() {
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db); // #145: zatwierdzenie kampanii wymaga opublikowanej informacji
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const admin = await seedUserSession(db, { userId: 'u-adm', mfa: true, roles: [{ role: 'admin' }] });
  const env = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid', BREVO_WEBHOOK_SECRET: 'w'.repeat(48),
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { db, env, treasurer, board, admin, call };
}

async function seedFamily(db) {
  await db.query('INSERT INTO households (id) VALUES ($1)', ['h1']);
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('h1-s1', 'h1', 'Uczeń', 'Testowy')");
  await db.query("INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-1', 'h1-s1', 'c1', $1)", [YEAR]);
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ('h1-g1', 'h1', 'Opiekun', 'Testowy', 'h1-g1@example.invalid', true)`,
  );
  await db.query("INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ('h1-s1', 'h1-g1', true, true)");
}

test('historia kampanii: ponowienie i wysyłka workera są widoczne i oznaczone jako źródło email_worker', async () => {
  const t = await setup();
  try {
    await seedFamily(t.db);
    const created = await t.call(t.treasurer, '/api/email/campaigns', {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.campaign.id;
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' })).status, 200);
    const preview = await t.call(t.treasurer, `/api/email/campaigns/${id}/preview`);
    const approved = await t.call(t.board, `/api/email/campaigns/${id}/approve`, {
      method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' })).status, 200);

    // Pierwsze podejście: błąd przejściowy dostawcy → ponowienie; drugie → wysłano.
    const failing = { name: 'fake', async send() { throw new EmailTransportError('server_busy', { retryable: true }); } };
    await runEmailBatch(t.env, { transport: failing, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
    const sent = [];
    const ok = { name: 'fake', async send(message) { sent.push(message); return { messageId: `fake-${sent.length}` }; } };
    await runEmailBatch(t.env, { transport: ok, dryRun: false, now: new Date(DAY1.getTime() + 24 * 3600_000) });
    assert.equal(sent.length, 1);

    const history = await t.call(t.admin, `/api/admin/audit/entity/email_campaign/${id}`);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    const events = history.body.events;
    const actions = events.map((e) => e.action);
    for (const action of ['email.campaign.created', 'email.campaign.approved', 'email.campaign.queued', 'email.retry_scheduled', 'email.sent']) {
      assert.ok(actions.includes(action), `brak ${action}: ${actions.join(', ')}`);
    }
    assert.ok(actions.indexOf('email.retry_scheduled') < actions.indexOf('email.sent'));

    const byAction = (action) => events.find((e) => e.action === action);
    for (const action of ['email.retry_scheduled', 'email.sent']) {
      assert.deepEqual([byAction(action).actorId, byAction(action).actorKind, byAction(action).source], [null, 'system', 'email_worker'], action);
    }
    assert.deepEqual([byAction('email.campaign.approved').actorKind, byAction('email.campaign.approved').source], ['user', null]);
    assert.equal(byAction('email.campaign.approved').actorId, 'u-bd');
    assert.doesNotMatch(JSON.stringify(history.body), /@/);
  } finally {
    await t.db.close();
  }
});

test('źródło zdarzenia bez aktora: webhook, link rezygnacji, logowanie i bootstrap są rozróżnialne', () => {
  const kind = (action, actorId = null, metadata = {}) => auditEventSource(action, actorId, metadata);
  assert.deepEqual(kind('email.sent'), { actorKind: 'system', source: 'email_worker' });
  assert.deepEqual(kind('email.address_suppressed'), { actorKind: 'system', source: 'brevo_webhook' });
  assert.deepEqual(kind('email.webhook.previous_secret_used'), { actorKind: 'system', source: 'brevo_webhook' });
  assert.deepEqual(kind('email.preference.opt_out', null, { source: 'link' }), { actorKind: 'anonymous', source: 'unsubscribe_link' });
  assert.deepEqual(kind('email.preference.opt_out', null, { source: 'webhook' }), { actorKind: 'system', source: 'brevo_webhook' });
  assert.deepEqual(kind('auth.login_failed'), { actorKind: 'anonymous', source: 'login' });
  assert.deepEqual(kind('auth.bootstrap_issued'), { actorKind: 'system', source: 'bootstrap' });
  assert.deepEqual(kind('email.sent', 'u-1'), { actorKind: 'user', source: null });
});
