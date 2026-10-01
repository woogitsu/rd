// #113: kampania zawiadomienia o zebraniu klasowym — worker tuż przed wysyłką sprawdza ponownie,
// czy dziecko, przez które opiekun jest adresatem, nadal jest zapisane do klasy zebrania
// (migawka jest zamrożona przy zatwierdzeniu). Testy PGlite przez handlePgRequest i
// runEmailBatch z atrapą transportu; dane syntetyczne (@example.invalid), nic nie wychodzi z procesu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { runEmailBatch } from '../src/email/worker.js';
import { createTestDb, request, seedClass, seedPublishedPrivacyNotice, seedUserSession } from './helpers/pg.js';

const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network_forbidden_in_tests'); };
test.after(() => { globalThis.fetch = realFetch; });

const YEAR = 'y2026';
const DAY = 86400000;

async function family(db, id, classes) {
  await db.query('INSERT INTO households (id) VALUES ($1)', [id]);
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ($1, $2, 'Opiekun', 'Syntetyczny', $3, true)`, [`${id}-g`, id, `${id}-g@example.invalid`]);
  for (const classId of classes) {
    const studentId = `${id}-s-${classId}`;
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', $1)", [studentId, id]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)',
      [`e-${studentId}`, studentId, classId, YEAR]);
    await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ($1, $2, true)', [studentId, `${id}-g`]);
  }
}

async function setup() {
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db); // #145: zatwierdzenie kampanii wymaga opublikowanej informacji
  await seedClass(db, { id: 'ca', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'cb', schoolYearId: YEAR, name: '2B' });
  const cookies = {
    board: await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    board2: await seedUserSession(db, { userId: 'u-bd2', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    repA: await seedUserSession(db, { userId: 'u-repa', mfa: true, roles: [{ role: 'representative', schoolYearId: YEAR, classId: 'ca' }] }),
  };
  const env = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid', BREVO_WEBHOOK_SECRET: 'w'.repeat(48),
  };
  let seq = 0;
  const call = async (cookie, method, path, body) => {
    const response = await handlePgRequest(request(path, {
      method, cookie, body, headers: { 'Idempotency-Key': `k-${++seq}-${Math.random().toString(36).slice(2)}` },
    }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { db, env, cookies, call };
}

// Zebranie klasy 1A -> zatwierdzone zawiadomienie -> szkic kampanii -> migawka -> zatwierdzenie -> kolejka.
async function queuedClassCampaign(t) {
  const created = await t.call(t.cookies.board, 'POST', '/api/meetings', {
    schoolYearId: YEAR, kind: 'class', classId: 'ca', title: 'Zebranie klasy 1A',
    scheduledAt: new Date(Date.now() + 20 * DAY).toISOString(), location: 'Sala 1', status: 'scheduled',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const meetingId = created.body.meeting.id;
  assert.equal((await t.call(t.cookies.board, 'POST', `/api/meetings/${meetingId}/agenda-items`, { title: 'Punkt klasowy' })).status, 201);
  const draft = await t.call(t.cookies.board, 'POST', `/api/meetings/${meetingId}/notices`, {});
  const noticeId = draft.body.notice.id;
  assert.equal((await t.call(t.cookies.board2, 'POST', `/api/meetings/${meetingId}/notices/${noticeId}/approval`, {})).status, 200);
  const made = await t.call(t.cookies.board, 'POST', `/api/meetings/${meetingId}/notices/${noticeId}/campaign-draft`, {});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.campaign.id;
  assert.equal((await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/snapshot`)).status, 200);
  const preview = await t.call(t.cookies.board, 'GET', `/api/email/campaigns/${id}/preview`);
  assert.deepEqual(preview.body.staleRecipients, {});
  const approved = await t.call(t.cookies.board2, 'POST', `/api/email/campaigns/${id}/approve`,
    { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/queue`)).status, 200);
  return id;
}

async function runWorker(t, sent) {
  const transport = { name: 'fake', async send(message) { sent.push(message); return { messageId: `fake-${sent.length}` }; } };
  return runEmailBatch(t.env, { transport, dryRun: false, now: new Date() });
}

test('kampania zebrania klasowego: dziecko przeniesione do innej klasy po zatwierdzeniu nie dostaje wiadomości, ponowienie zadania niczego nie dubluje', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-stay', ['ca']);
    await family(t.db, 'h-moved', ['ca']);
    await family(t.db, 'h-sib', ['ca', 'cb']); // rodzeństwo: dziecko z 1A przechodzi do 2B, drugie już jest w 2B
    const id = await queuedClassCampaign(t);
    const stored = await t.db.query('SELECT household_id FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY household_id', [id]);
    assert.deepEqual(stored.rows.map((r) => r.household_id), ['h-moved', 'h-sib', 'h-stay']);

    await t.db.query("UPDATE enrollments SET class_id = 'cb' WHERE id IN ('e-h-moved-s-ca', 'e-h-sib-s-ca')");
    const preview = await t.call(t.cookies.board, 'GET', `/api/email/campaigns/${id}/preview`);
    assert.deepEqual(preview.body.staleRecipients, { student_left_class: 2 });
    // Zatwierdzona migawka sama się nie zmienia — decyzja o przebudowie należy do zarządu.
    assert.equal(preview.body.recipientsCount, 3);

    const sent = [];
    const first = await runWorker(t, sent);
    assert.equal(sent.length, 1);
    assert.equal(first.suppressed, 2);
    const again = await runWorker(t, sent); // ponowienie zadania
    assert.equal(sent.length, 1, 'ponowienie nie wysyła drugiej wiadomości');
    assert.equal(again.suppressed, 0);
    const outbox = await t.db.query('SELECT household_id, state, last_error FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [id]);
    assert.deepEqual(outbox.rows, [
      { household_id: 'h-moved', state: 'suppressed', last_error: 'student_left_class' },
      { household_id: 'h-sib', state: 'suppressed', last_error: 'student_left_class' },
      { household_id: 'h-stay', state: 'sent', last_error: null },
    ]);
    assert.ok(JSON.stringify(sent[0]).includes('h-stay-g@example.invalid'));
  } finally { await t.db.close(); }
});

test('kampania zebrania klasowego bez zmian klasy: wszystkie rodziny dostają po jednej wiadomości, przedstawiciel nie widzi kampanii', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-1', ['ca']);
    await family(t.db, 'h-2', ['ca']);
    const id = await queuedClassCampaign(t);
    const denied = await t.call(t.cookies.repA, 'GET', `/api/email/campaigns/${id}/preview`);
    assert.ok([403, 404].includes(denied.status), `status ${denied.status}`);
    const sent = [];
    const run = await runWorker(t, sent);
    assert.equal(sent.length, 2);
    assert.equal(run.suppressed, 0);
    await runWorker(t, sent);
    assert.equal(sent.length, 2, 'klucz kampania + rodzina: brak drugiej wiadomości po ponowieniu');
  } finally { await t.db.close(); }
});
