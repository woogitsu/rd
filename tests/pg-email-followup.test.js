// #139 (0156): zasada czterech oczu dla „wiadomość nie wyszła” i kampania
// uzupełniająca (followup). Wyłącznie dane syntetyczne (@example.invalid).
// Żaden test nie łączy się z siecią: wysyłka używa atrapy transportu, a globalna
// pułapka sieci (tests/helpers/network-guard.js) liczy próby — licznik musi być 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { runEmailBatch } from '../src/email/worker.js';
import { AUDIT_ACTION_LABELS } from '../shared/audit-actions.js';
import { MESSAGES } from '../shared/messages.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const YEAR = 'y2026';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

function fakeTransport() {
  const calls = [];
  return {
    calls,
    name: 'fake',
    async send(message) {
      calls.push(message);
      return { messageId: `fake-${calls.length}-${message.outboxId}` };
    },
  };
}

async function setup() {
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db);
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
    BREVO_WEBHOOK_SECRET: 'w'.repeat(48),
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  return { db, env, treasurer, board, board2, call, count, close: () => db.close() };
}

async function family(db, householdId, { students = 1, guardians = 1 } = {}) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT DO NOTHING', [householdId]);
  const studentIds = [];
  for (let i = 1; i <= students; i += 1) {
    const id = `${householdId}-s${i}`;
    studentIds.push(id);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [id, householdId]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, id, 'c1', YEAR]);
  }
  for (let g = 1; g <= guardians; g += 1) {
    const id = `${householdId}-g${g}`;
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true)`,
      [id, householdId, `${id}@example.invalid`],
    );
    for (const studentId of studentIds) {
      await db.query(
        'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, $3)',
        [studentId, id, g === 1],
      );
    }
  }
}

async function approveCampaign(t, id, cookie) {
  const preview = await t.call(cookie, `/api/email/campaigns/${id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  return t.call(cookie, `/api/email/campaigns/${id}/approve`, {
    method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
  });
}

// Kampania źródłowa: rodziny `sent` dostają wiadomość (atrapa transportu),
// rodziny `unknown` kończą jako failed/delivery_unknown (przerwane przekazanie).
async function sourceCampaign(t, { sent = [], unknown = [], audience = 'all_households' } = {}) {
  const created = await t.call(t.treasurer, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience, subject: 'Dobrowolna składka {rok}', bodyText: BODY },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.campaign.id;
  assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' })).status, 200);
  const approved = await approveCampaign(t, id, t.board);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' })).status, 200);
  if (unknown.length) {
    await t.db.query(
      `UPDATE email_outbox SET state = 'sending', attempts = 1, claimed_at = $2, claim_token = $3, send_started_at = $2
        WHERE campaign_id = $1 AND household_id = ANY($4::text[])`,
      [id, DAY1.toISOString(), crypto.randomUUID(), unknown],
    );
  }
  const transport = fakeTransport();
  await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 30 * 60_000) });
  assert.deepEqual(transport.calls.map((call) => call.to).sort(), sent.map((h) => `${h}-g1@example.invalid`).sort());
  const { rows } = await t.db.query('SELECT household_id, id, state, last_error FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [id]);
  const outbox = Object.fromEntries(rows.map((row) => [row.household_id, row]));
  for (const h of unknown) assert.deepEqual([outbox[h].state, outbox[h].last_error], ['failed', 'delivery_unknown'], h);
  for (const h of sent) assert.equal(outbox[h].state, 'sent', h);
  return { id, outbox: Object.fromEntries(rows.map((row) => [row.household_id, row.id])) };
}

async function report(t, campaignId, outboxId, resolution, cookie = t.board) {
  const res = await t.call(cookie, `/api/email/campaigns/${campaignId}/resolutions`, {
    method: 'POST', body: { outboxId, resolution, evidenceCode: resolution === 'confirmed_not_sent' ? 'brevo_log_no_event' : 'brevo_log_delivered' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.resolution.id;
}

function approveResolution(t, campaignId, resolutionId, cookie) {
  return t.call(cookie, `/api/email/campaigns/${campaignId}/resolutions/${resolutionId}/approve`, { method: 'POST' });
}

async function createFollowup(t, sourceId, { cookie = t.treasurer, key = crypto.randomUUID() } = {}) {
  return t.call(cookie, `/api/email/campaigns/${sourceId}/followup`, { method: 'POST', headers: { 'Idempotency-Key': key } });
}

async function recipientsOf(t, campaignId) {
  const { rows } = await t.db.query('SELECT household_id, email FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY household_id', [campaignId]);
  return rows;
}

test('#139 cztery oczy: ta sama osoba → 403, inna osoba z zarządu → jedno zatwierdzenie, podwójne kliknięcie bez duplikatu', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await family(t.db, 'h2');
    const source = await sourceCampaign(t, { unknown: ['h1', 'h2'] });
    const notSent = await report(t, source.id, source.outbox.h1, 'confirmed_not_sent');
    const delivered = await report(t, source.id, source.outbox.h2, 'confirmed_delivered', t.treasurer);

    const self = await approveResolution(t, source.id, notSent, t.board);
    assert.deepEqual([self.status, self.body], [403, { error: 'self_approval_forbidden' }]);
    const treasurer = await approveResolution(t, source.id, notSent, t.treasurer);
    assert.deepEqual([treasurer.status, treasurer.body], [403, { error: 'forbidden' }]);
    const rep = await seedUserSession(t.db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] });
    const admin = await seedUserSession(t.db, { userId: 'u-adm', mfa: true, roles: [{ role: 'admin' }] });
    const classBoard = await seedUserSession(t.db, { userId: 'u-cbd', mfa: true, roles: [{ role: 'board', classId: 'c1', schoolYearId: YEAR }] });
    const noMfa = await seedUserSession(t.db, { userId: 'u-bd-nomfa', mfa: false, roles: [{ role: 'board', schoolYearId: YEAR }] });
    for (const cookie of [rep, admin, classBoard, noMfa]) {
      assert.equal((await approveResolution(t, source.id, notSent, cookie)).status, 403);
    }
    assert.equal((await t.call(null, `/api/email/campaigns/${source.id}/resolutions/${notSent}/approve`, { method: 'POST' })).status, 401);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_outbox_resolution_approvals'), 0, 'odmowa nie tworzy zatwierdzenia');

    const ok = await approveResolution(t, source.id, notSent, t.board2);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.approval.resolutionId, ok.body.approval.outboxId, ok.body.approval.approvedBy], [notSent, source.outbox.h1, 'u-bd2']);
    const again = await approveResolution(t, source.id, notSent, t.board2);
    assert.equal(again.status, 200);
    assert.equal(again.body.approval.id, ok.body.approval.id);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_outbox_resolution_approvals WHERE resolution_id = $1', [notSent]), 1);

    // Trwały dziennik: jedno zdarzenie z aktorem, obiektem i etykietą w katalogu.
    const { rows: events } = await t.db.query(
      "SELECT actor_id, entity_type, entity_id, metadata_json AS metadata FROM audit_events WHERE action = 'email.outbox.resolution_approved'",
    );
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].actor_id, events[0].entity_type, events[0].entity_id], ['u-bd2', 'email_outbox', source.outbox.h1]);
    assert.equal(events[0].metadata.resolutionId, notSent);
    assert.equal(events[0].metadata.schoolYearId, YEAR);
    assert.ok(AUDIT_ACTION_LABELS['email.outbox.resolution_approved'], 'etykieta w shared/audit-actions.js');
    assert.ok(AUDIT_ACTION_LABELS['email.campaign.followup_created'], 'etykieta w shared/audit-actions.js');

    // „Wyszła” nie wymaga i nie przyjmuje zatwierdzenia; nieznane rozstrzygnięcie → 404.
    const notApprovable = await approveResolution(t, source.id, delivered, t.board2);
    assert.deepEqual([notApprovable.status, notApprovable.body], [409, { error: 'resolution_not_approvable' }]);
    const missing = await approveResolution(t, source.id, 'brak-takiego', t.board2);
    assert.deepEqual([missing.status, missing.body], [404, { error: 'outbox_resolution_not_found' }]);
    for (const code of ['resolution_not_approvable', 'outbox_resolution_not_found', 'followup_no_households', 'followup_source_not_eligible',
      'followup_household_already_covered', 'followup_household_not_eligible']) {
      assert.ok(MESSAGES[code], `tekst dla ${code}`);
    }

    // Lista „do sprawdzenia” pokazuje stan zatwierdzenia.
    const attention = await t.call(t.board, `/api/email/campaigns/${source.id}/attention`);
    const byId = Object.fromEntries(attention.body.rows.map((row) => [row.outboxId, row]));
    assert.deepEqual([byId[source.outbox.h1].resolutionApproval, byId[source.outbox.h1].resolvedByMe], ['approved', true]);
    assert.deepEqual([byId[source.outbox.h2].resolutionApproval, byId[source.outbox.h2].resolvedByMe], [null, false]);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('#139 baza: zatwierdzenie tej samej osoby, zmiana i usunięcie zatwierdzenia są odrzucane', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    const source = await sourceCampaign(t, { unknown: ['h1'] });
    const notSent = await report(t, source.id, source.outbox.h1, 'confirmed_not_sent');
    await assert.rejects(t.db.query(
      `INSERT INTO email_outbox_resolution_approvals (id, resolution_id, outbox_id, campaign_id, resolution, resolved_by, approved_by)
       VALUES ('a-self', $1, $2, $3, 'confirmed_not_sent', 'u-bd', 'u-bd')`,
      [notSent, source.outbox.h1, source.id],
    ), /four_eyes/);
    // Skopiowany autor zgłoszenia musi się zgadzać ze zgłoszeniem (klucz obcy złożony).
    await assert.rejects(t.db.query(
      `INSERT INTO email_outbox_resolution_approvals (id, resolution_id, outbox_id, campaign_id, resolution, resolved_by, approved_by)
       VALUES ('a-fake', $1, $2, $3, 'confirmed_not_sent', 'u-tr', 'u-bd')`,
      [notSent, source.outbox.h1, source.id],
    ), /foreign key|approval_target_fk/);
    assert.equal((await approveResolution(t, source.id, notSent, t.board2)).status, 201);
    await assert.rejects(t.db.query("UPDATE email_outbox_resolution_approvals SET approved_by = 'u-tr'"), /append_only/);
    await assert.rejects(t.db.query('DELETE FROM email_outbox_resolution_approvals'), /append_only/);
    await assert.rejects(t.db.query('TRUNCATE email_outbox_resolution_approvals'));
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_outbox_resolution_approvals'), 1);
  } finally { await t.close(); }
});

test('#139 uzupełnienie: tylko rodziny z zatwierdzonym „nie wyszła”; zwykła ścieżka zatwierdzenia; jedna wiadomość na rodzinę', async () => {
  const t = await setup();
  try {
    // h1 — wyszła; h2 — „nie wyszła” zatwierdzone (dwoje opiekunów, rodzeństwo);
    // h3 — „nie wyszła” bez zatwierdzenia (jak zapis sprzed 0156); h4 — potwierdzone doręczenie.
    await family(t.db, 'h1');
    await family(t.db, 'h2', { students: 2, guardians: 2 });
    await family(t.db, 'h3');
    await family(t.db, 'h4');
    const source = await sourceCampaign(t, { sent: ['h1'], unknown: ['h2', 'h3', 'h4'] });
    const r2 = await report(t, source.id, source.outbox.h2, 'confirmed_not_sent');
    const r3 = await report(t, source.id, source.outbox.h3, 'confirmed_not_sent');
    await report(t, source.id, source.outbox.h4, 'confirmed_delivered', t.treasurer);
    assert.equal((await approveResolution(t, source.id, r2, t.board2)).status, 201);

    // Uprawnienia: przedstawiciel i admin techniczny nie tworzą uzupełnienia.
    const rep = await seedUserSession(t.db, { userId: 'u-rep2', mfa: true, roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] });
    const admin = await seedUserSession(t.db, { userId: 'u-adm2', mfa: true, roles: [{ role: 'admin' }] });
    for (const cookie of [rep, admin]) assert.equal((await createFollowup(t, source.id, { cookie })).status, 403);
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${source.id}/followup`, { method: 'POST' })).body.error, 'invalid_idempotency_key');

    const key = crypto.randomUUID();
    const created = await createFollowup(t, source.id, { key });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const followup = created.body.campaign;
    assert.deepEqual([followup.kind, followup.sourceCampaignId, followup.status, followup.audience], ['followup', source.id, 'draft', 'all_households']);
    assert.deepEqual([created.body.eligibleHouseholds, created.body.pendingApprovals], [1, 1]);
    assert.match(followup.title, /^Uzupełnienie: /);
    const replay = await createFollowup(t, source.id, { key });
    assert.deepEqual([replay.status, replay.body.campaign.id], [200, followup.id]);
    assert.equal(await t.count("SELECT count(*)::int AS n FROM email_campaigns WHERE kind = 'followup'"), 1);
    assert.equal(await t.count("SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.campaign.followup_created' AND entity_id = $1", [followup.id]), 1);

    // Odbiorców nie da się zmienić ręcznie; treść można poprawić jak w każdym szkicu.
    const audience = await t.call(t.treasurer, `/api/email/campaigns/${followup.id}`, {
      method: 'PUT', body: { title: followup.title, audience: 'no_payment_record', subject: followup.subject, bodyText: followup.bodyText, revision: followup.revisionNo },
    });
    assert.deepEqual([audience.status, audience.body], [409, { error: 'campaign_audience_locked' }]);
    const edited = await t.call(t.treasurer, `/api/email/campaigns/${followup.id}`, {
      method: 'PUT', body: { title: followup.title, audience: 'all_households', subject: 'Dobrowolna składka {rok} — ponowienie', bodyText: followup.bodyText, revision: followup.revisionNo },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.campaign.kind, 'followup');

    // Migawka: wyłącznie h2, jeden adres na rodzinę mimo dwojga opiekunów i rodzeństwa.
    const snap = await t.call(t.treasurer, `/api/email/campaigns/${followup.id}/snapshot`, { method: 'POST' });
    assert.equal(snap.status, 200, JSON.stringify(snap.body));
    assert.equal(snap.body.recipientsCount, 1);
    assert.deepEqual(await recipientsOf(t, followup.id), [{ household_id: 'h2', email: 'h2-g1@example.invalid' }]);

    // Zwykła ścieżka: bez zatwierdzenia nie ma kolejki; autor migawki nie zatwierdza.
    assert.deepEqual((await t.call(t.treasurer, `/api/email/campaigns/${followup.id}/queue`, { method: 'POST' })).body, { error: 'approval_required' });
    const approvedByOther = await approveCampaign(t, followup.id, t.board2);
    assert.equal(approvedByOther.status, 200, 'inna osoba z zarządu niż autor szkicu i migawki');
    const queued = await t.call(t.treasurer, `/api/email/campaigns/${followup.id}/queue`, { method: 'POST' });
    assert.deepEqual([queued.status, queued.body.queued], [200, 1]);
    const queuedAgain = await t.call(t.treasurer, `/api/email/campaigns/${followup.id}/queue`, { method: 'POST' });
    assert.deepEqual([queuedAgain.status, queuedAgain.body.queued], [200, 0]);
    const { rows: outbox } = await t.db.query('SELECT household_id, idempotency_key FROM email_outbox WHERE campaign_id = $1', [followup.id]);
    assert.deepEqual(outbox, [{ household_id: 'h2', idempotency_key: `campaign:${followup.id}:household:h2` }]);

    const transport = fakeTransport();
    await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 60 * 60_000) });
    assert.deepEqual(transport.calls.map((call) => call.to), ['h2-g1@example.invalid']);
    const rerun = fakeTransport();
    await runEmailBatch(t.env, { transport: rerun, dryRun: false, now: new Date(DAY1.getTime() + 90 * 60_000) });
    assert.equal(rerun.calls.length, 0, 'ponowienie zadania nie wysyła drugi raz');

    // Zatwierdzenie h3 później: kolejne uzupełnienie obejmuje tylko h3 (h2 już obsłużona).
    assert.equal((await approveResolution(t, source.id, r3, t.board2)).status, 201);
    const second = await createFollowup(t, source.id);
    assert.deepEqual([second.status, second.body.eligibleHouseholds, second.body.pendingApprovals], [201, 1, 0]);
    const snap2 = await t.call(t.treasurer, `/api/email/campaigns/${second.body.campaign.id}/snapshot`, { method: 'POST' });
    assert.deepEqual(snap2.body.exclusions, { followup_already_covered: 1 });
    assert.deepEqual((await recipientsOf(t, second.body.campaign.id)).map((row) => row.household_id), ['h3']);

    // Wszystkie rozstrzygnięcia zatwierdzone i obsłużone → brak rodzin do nowego uzupełnienia
    // po zakolejkowaniu drugiego.
    assert.equal((await approveCampaign(t, second.body.campaign.id, t.board)).status, 200);
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${second.body.campaign.id}/queue`, { method: 'POST' })).status, 200);
    const none = await createFollowup(t, source.id);
    assert.deepEqual([none.status, none.body], [409, { error: 'followup_no_households' }]);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('#139 uzupełnienie: dwa szkice tej samej rodziny — drugie zakolejkowanie 409, kolejka bez drugiej wiadomości', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    const source = await sourceCampaign(t, { unknown: ['h1'] });
    const r1 = await report(t, source.id, source.outbox.h1, 'confirmed_not_sent');
    assert.equal((await approveResolution(t, source.id, r1, t.board2)).status, 201);
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      const created = await createFollowup(t, source.id);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      ids.push(created.body.campaign.id);
      assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${created.body.campaign.id}/snapshot`, { method: 'POST' })).body.recipientsCount, 1);
      assert.equal((await approveCampaign(t, created.body.campaign.id, t.board)).status, 200);
    }
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${ids[0]}/queue`, { method: 'POST' })).status, 200);
    const second = await t.call(t.treasurer, `/api/email/campaigns/${ids[1]}/queue`, { method: 'POST' });
    assert.deepEqual([second.status, second.body], [409, { error: 'followup_household_already_covered' }]);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_outbox WHERE campaign_id = $1', [ids[1]]), 0);
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${ids[1]}`)).body.campaign.status, 'approved');

    // Strażnik bazy: wiersz kolejki uzupełnienia dla rodziny bez zatwierdzonego „nie wyszła”.
    await family(t.db, 'h9');
    await assert.rejects(t.db.query(
      `INSERT INTO email_outbox (id, campaign_id, household_id, recipient_id, idempotency_key)
       SELECT 'o-fake', $1, 'h9', r.id, 'campaign:' || $1 || ':household:h9' FROM email_campaign_recipients r WHERE r.campaign_id = $1 LIMIT 1`,
      [ids[0]],
    ), /email_followup_household_not_eligible/);
    // Powiązanie ze źródłem jest niezmienne.
    await assert.rejects(t.db.query("UPDATE email_campaigns SET kind = 'standard', source_campaign_id = NULL WHERE id = $1", [ids[1]]), /email_campaign_followup_link_immutable/);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('#139 uzupełnienie: wpłata między kampanią a uzupełnieniem przy no_payment_record → rodzina wykluczona', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await family(t.db, 'h2');
    const source = await sourceCampaign(t, { unknown: ['h1', 'h2'], audience: 'no_payment_record' });
    for (const h of ['h1', 'h2']) {
      const id = await report(t, source.id, source.outbox[h], 'confirmed_not_sent');
      assert.equal((await approveResolution(t, source.id, id, t.board2)).status, 201);
    }
    // Wpłata częściowa (dobrowolna, dowolna kwota) — wpis wpłaty wyklucza rodzinę.
    await t.db.query(
      `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
       VALUES ('p-h1', 'h1', $1, 500, '2026-10-06', 'bank', 'recorded', 'u-tr', 'payment-key-h1')`,
      [YEAR],
    );
    const created = await createFollowup(t, source.id);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.campaign.audience, 'no_payment_record');
    const snap = await t.call(t.treasurer, `/api/email/campaigns/${created.body.campaign.id}/snapshot`, { method: 'POST' });
    assert.deepEqual(snap.body.exclusions, { payment_recorded: 1 });
    assert.deepEqual((await recipientsOf(t, created.body.campaign.id)).map((row) => row.household_id), ['h2']);
  } finally { await t.close(); }
});

test('#139 uzupełnienie: źródło bez kolejki → 409; bez zatwierdzonych rozstrzygnięć → 409 i żadna kampania nie powstaje', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    const draft = await t.call(t.treasurer, '/api/email/campaigns', {
      method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { schoolYearId: YEAR, title: 'Szkic', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY },
    });
    const fromDraft = await createFollowup(t, draft.body.campaign.id);
    assert.deepEqual([fromDraft.status, fromDraft.body], [409, { error: 'followup_source_not_eligible' }]);
    const source = await sourceCampaign(t, { unknown: ['h1'] });
    // Zgłoszenie jednej osoby (jak rozstrzygnięcia sprzed 0156) nie wystarcza.
    await report(t, source.id, source.outbox.h1, 'confirmed_not_sent');
    const pending = await createFollowup(t, source.id);
    assert.deepEqual([pending.status, pending.body], [409, { error: 'followup_no_households' }]);
    assert.equal(await t.count("SELECT count(*)::int AS n FROM email_campaigns WHERE kind = 'followup'"), 0);
    // Zwykły szkic nie może udawać uzupełnienia.
    await assert.rejects(t.db.query(
      `INSERT INTO email_campaigns (id, school_year_id, title, audience, category, subject, body_text, content_hash, created_by, updated_by, kind, source_campaign_id)
       VALUES ('c-fake', $1, 'x', 'all_households', 'contribution_reminder', 's', 'b', 'h', 'u-tr', 'u-tr', 'followup', $2)`,
      [YEAR, draft.body.campaign.id],
    ), /email_followup_source_not_eligible/);
  } finally { await t.close(); }
});
