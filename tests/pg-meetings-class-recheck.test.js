// #113: kampania zawiadomienia o zebraniu klasowym — worker tuż przed wysyłką sprawdza ponownie,
// czy dziecko, przez które opiekun jest adresatem, nadal jest zapisane do klasy zebrania
// (migawka jest zamrożona przy zatwierdzeniu). Testy PGlite przez handlePgRequest i
// runEmailBatch z atrapą transportu; dane syntetyczne (@example.invalid), nic nie wychodzi z procesu.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handlePgRequest } from '../src/pg/app.js';
import { runEmailBatch } from '../src/email/worker.js';
import { createTestDb, request, seedClass, seedPublishedPrivacyNotice, seedUserSession } from './helpers/pg.js';

const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network_forbidden_in_tests'); };
test.after(() => { globalThis.fetch = realFetch; });

const YEAR = 'y2026';
const DAY = 86400000;

async function family(db, id, classes, { guardians = 1 } = {}) {
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
  // Druga osoba opiekująca się tym samym dzieckiem (pierwsze dziecko rodziny).
  for (let n = 2; n <= guardians; n += 1) {
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, 'Opiekun', 'Drugi', $3, true)`, [`${id}-g${n}`, id, `${id}-g${n}@example.invalid`]);
    await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ($1, $2, true)',
      [`${id}-s-${classes[0]}`, `${id}-g${n}`]);
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
    boardA: await seedUserSession(db, { userId: 'u-bda', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR, classId: 'ca' }] }),
    audit: await seedUserSession(db, { userId: 'u-au', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] }),
    principal: await seedUserSession(db, { userId: 'u-pr', mfa: true, roles: [{ role: 'principal', schoolYearId: YEAR }] }),
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
async function queuedClassCampaign(t, { classId = 'ca', name = '1A' } = {}) {
  const created = await t.call(t.cookies.board, 'POST', '/api/meetings', {
    schoolYearId: YEAR, kind: 'class', classId, title: `Zebranie klasy ${name}`,
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

// Ograniczenie przetwarzania zapisuje się wyłącznie w dzienniku ograniczeń (append-only) — jak po
// decyzji administratora, ale bez trasy: test dotyczy tylko tego, co robi worker.
async function restrict(db, { householdId = null, guardianId = null }) {
  const requestId = crypto.randomUUID();
  await db.query(
    `INSERT INTO data_subject_requests (id, kind, household_id, guardian_id, received_on, created_by)
     VALUES ($1, 'restriction', $2, $3, date '2026-10-01', 'u-bd')`, [requestId, householdId, guardianId]);
  await db.query(
    `INSERT INTO processing_restrictions (id, request_id, household_id, guardian_id, action, created_by)
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'restrict', 'u-bd')`, [requestId, householdId, guardianId]);
}

const outboxOf = async (t, id) => (await t.db.query(
  'SELECT household_id, state, last_error FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [id])).rows;

test('kampania zebrania klasowego: zgoda cofnięta, ograniczenie przetwarzania i odejście ze szkoły po zatwierdzeniu — wiersze pominięte z powodem, reszta wysłana', async () => {
  const t = await setup();
  try {
    for (const id of ['h-ok', 'h-nocontact', 'h-restricted-h', 'h-restricted-g', 'h-left']) await family(t.db, id, ['ca']);
    const id = await queuedClassCampaign(t);
    await t.db.query("UPDATE guardians SET contact_allowed = false WHERE id = 'h-nocontact-g'");
    await restrict(t.db, { householdId: 'h-restricted-h' });
    await restrict(t.db, { guardianId: 'h-restricted-g-g' });
    await t.db.query("UPDATE enrollments SET ended_on = CURRENT_DATE, ended_at = now(), ended_by = 'u-bd' WHERE id = 'e-h-left-s-ca'");

    const preview = await t.call(t.cookies.board, 'GET', `/api/email/campaigns/${id}/preview`);
    assert.deepEqual(preview.body.staleRecipients,
      { consent_or_address_changed: 1, processing_restricted: 2, student_withdrawn: 1 });
    assert.equal(preview.body.recipientsCount, 5, 'migawka zostaje zamrożona do przebudowy');

    const sent = [];
    const run = await runWorker(t, sent);
    assert.equal(run.sent, 1);
    assert.equal(run.suppressed, 2);
    assert.equal(run.skipped, 2);
    assert.deepEqual(await outboxOf(t, id), [
      { household_id: 'h-left', state: 'suppressed', last_error: 'student_withdrawn' },
      { household_id: 'h-nocontact', state: 'suppressed', last_error: 'consent_or_address_changed' },
      { household_id: 'h-ok', state: 'sent', last_error: null },
      { household_id: 'h-restricted-g', state: 'skipped', last_error: 'processing_restricted' },
      { household_id: 'h-restricted-h', state: 'skipped', last_error: 'processing_restricted' },
    ]);
    assert.deepEqual(sent.map((m) => m.to), ['h-ok-g@example.invalid']);
    const events = await t.db.query(
      "SELECT action, metadata_json->>'reason' AS reason FROM audit_events WHERE action IN ('email.suppressed', 'email.skipped') ORDER BY action, metadata_json->>'reason'");
    assert.deepEqual(events.rows, [
      { action: 'email.skipped', reason: 'processing_restricted' },
      { action: 'email.skipped', reason: 'processing_restricted' },
      { action: 'email.suppressed', reason: 'consent_or_address_changed' },
      { action: 'email.suppressed', reason: 'student_withdrawn' },
    ]);
    const logged = JSON.stringify((await t.db.query("SELECT metadata_json FROM audit_events WHERE action IN ('email.suppressed', 'email.skipped')")).rows);
    assert.ok(logged.includes('"reason"') && !logged.includes('example.invalid'), 'dziennik zawiera powody, ale nie adresy');
  } finally { await t.db.close(); }
});

test('kampania zebrania klasowego: dwoje opiekunów jednego dziecka — wiadomość idzie do adresata z migawki, cofnięcie jego zgody nie przekierowuje jej do drugiego', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-two', ['ca'], { guardians: 2 });
    await family(t.db, 'h-other', ['ca']);
    const id = await queuedClassCampaign(t);
    const stored = await t.db.query(
      'SELECT household_id, guardian_id FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY household_id', [id]);
    assert.equal(stored.rows.length, 2, 'jedna wiadomość na rodzinę mimo dwóch opiekunów');
    const chosen = stored.rows.find((row) => row.household_id === 'h-two').guardian_id;
    await t.db.query('UPDATE guardians SET contact_allowed = false WHERE id = $1', [chosen]);

    const sent = [];
    await runWorker(t, sent);
    assert.deepEqual(sent.map((m) => m.to), ['h-other-g@example.invalid']);
    assert.deepEqual(await outboxOf(t, id), [
      { household_id: 'h-other', state: 'sent', last_error: null },
      { household_id: 'h-two', state: 'suppressed', last_error: 'consent_or_address_changed' },
    ]);
    await runWorker(t, sent);
    assert.equal(sent.length, 1, 'ponowienie zadania nie wysyła do drugiego opiekuna');
  } finally { await t.db.close(); }
});

test('kampania zebrania klasowego: zmiana klasy w trakcie przebiegu (po przejęciu, tuż przed wysyłką) — potwierdzenie przed wysyłką pomija rodzinę', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-1', ['ca']);
    await family(t.db, 'h-2', ['ca']);
    const id = await queuedClassCampaign(t);
    const sent = [];
    let moved = null;
    const transport = {
      name: 'fake',
      async send(message) {
        // Wiersze są już przejęte; przy pierwszej wysyłce przenosimy dziecko rodziny, która jeszcze czeka.
        if (!moved) {
          moved = message.to === 'h-1-g@example.invalid' ? 'h-2' : 'h-1';
          await t.db.query("UPDATE enrollments SET class_id = 'cb' WHERE student_id = $1", [`${moved}-s-ca`]);
        }
        sent.push(message);
        return { messageId: `fake-${sent.length}` };
      },
    };
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date() });
    assert.ok(moved);
    assert.equal(run.sent, 1);
    assert.equal(run.suppressed, 1);
    assert.ok(!sent.some((m) => m.to === `${moved}-g@example.invalid`));
    const { rows: [row] } = await t.db.query('SELECT id, state, last_error FROM email_outbox WHERE campaign_id = $1 AND household_id = $2', [id, moved]);
    assert.deepEqual([row.state, row.last_error], ['suppressed', 'student_left_class']);
    const { rows: [event] } = await t.db.query("SELECT metadata_json FROM audit_events WHERE action = 'email.suppressed' AND entity_id = $1", [row.id]);
    assert.equal(event.metadata_json.stage, 'before_send');
    assert.equal(event.metadata_json.reason, 'student_left_class');
  } finally { await t.db.close(); }
});

test('rodzeństwo w 1A i 2B: kampania 1A daje rodzinie jedną wiadomość, kampania 2B drugą; ponowienie zadania niczego nie dubluje', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-sib', ['ca', 'cb']);
    await family(t.db, 'h-a', ['ca']);
    await family(t.db, 'h-b', ['cb']);
    const campaignA = await queuedClassCampaign(t, { classId: 'ca', name: '1A' });
    const campaignB = await queuedClassCampaign(t, { classId: 'cb', name: '2B' });
    const sent = [];
    const run = await runWorker(t, sent);
    assert.equal(run.sent, 4);
    assert.equal(run.suppressed, 0, 'rodzeństwo nadal zapisane do obu klas — brak pominięć');
    assert.deepEqual(await outboxOf(t, campaignA), [
      { household_id: 'h-a', state: 'sent', last_error: null },
      { household_id: 'h-sib', state: 'sent', last_error: null },
    ]);
    assert.deepEqual(await outboxOf(t, campaignB), [
      { household_id: 'h-b', state: 'sent', last_error: null },
      { household_id: 'h-sib', state: 'sent', last_error: null },
    ]);
    assert.equal(sent.filter((m) => m.to === 'h-sib-g@example.invalid').length, 2, 'po jednej wiadomości na kampanię');
    await runWorker(t, sent);
    assert.equal(sent.length, 4);
  } finally { await t.db.close(); }
});

test('zebranie klasy 2B: przedstawiciel i zarząd klasy 1A go nie widzą (404), a żadna z tych ról, także audyt i dyrekcja, nie tworzy zawiadomienia ani szkicu kampanii (403)', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h-1', ['ca']);
    const created = await t.call(t.cookies.board, 'POST', '/api/meetings', {
      schoolYearId: YEAR, kind: 'class', classId: 'cb', title: 'Zebranie klasy 2B',
      scheduledAt: new Date(Date.now() + 20 * DAY).toISOString(), location: 'Sala 2', status: 'scheduled',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const meetingB = created.body.meeting.id;
    assert.equal((await t.call(t.cookies.board, 'POST', `/api/meetings/${meetingB}/agenda-items`, { title: 'Punkt 2B' })).status, 201);
    const draft = await t.call(t.cookies.board, 'POST', `/api/meetings/${meetingB}/notices`, {});
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const noticeB = draft.body.notice.id;
    assert.equal((await t.call(t.cookies.board2, 'POST', `/api/meetings/${meetingB}/notices/${noticeB}/approval`, {})).status, 200);

    // Odczyt: przedstawiciel i zarząd klasy 1A nie widzą zebrania 2B (ani jego zawiadomień);
    // audyt i dyrekcja mają odczyt całego roku (istniejąca reguła ról tylko do odczytu).
    for (const name of ['repA', 'boardA']) {
      const res = await t.call(t.cookies[name], 'GET', `/api/meetings/${meetingB}`);
      assert.equal(res.status, 404, `${name}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, 'meeting_not_found');
    }
    for (const name of ['audit', 'principal']) {
      const res = await t.call(t.cookies[name], 'GET', `/api/meetings/${meetingB}`);
      assert.equal(res.status, 200, name);
    }
    for (const name of ['repA', 'audit', 'principal', 'boardA']) {
      const cookie = t.cookies[name];
      for (const [method, path] of [
        ['POST', `/api/meetings/${meetingB}/notices`],
        ['POST', `/api/meetings/${meetingB}/notices/${noticeB}/approval`],
        ['POST', `/api/meetings/${meetingB}/notices/${noticeB}/campaign-draft`],
      ]) {
        const res = await t.call(cookie, method, path, method === 'POST' ? {} : undefined);
        assert.equal(res.status, 403, `${name} ${method} ${path}: ${JSON.stringify(res.body)}`);
      }
    }
    assert.equal((await t.db.query('SELECT count(*)::int AS n FROM email_campaigns')).rows[0].n, 0);

    // Zarząd z przydziałem 1A obsługuje zebranie własnej klasy.
    const own = await t.call(t.cookies.board, 'POST', '/api/meetings', {
      schoolYearId: YEAR, kind: 'class', classId: 'ca', title: 'Zebranie klasy 1A',
      scheduledAt: new Date(Date.now() + 21 * DAY).toISOString(), location: 'Sala 1', status: 'scheduled',
    });
    const meetingA = own.body.meeting.id;
    assert.equal((await t.call(t.cookies.board, 'POST', `/api/meetings/${meetingA}/agenda-items`, { title: 'Punkt 1A' })).status, 201);
    assert.equal((await t.call(t.cookies.boardA, 'POST', `/api/meetings/${meetingA}/notices`, {})).status, 201);
  } finally { await t.db.close(); }
});
