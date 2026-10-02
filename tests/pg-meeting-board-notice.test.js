// #113 (część „odbiorcy-konta”, migracja 0183): zawiadomienie o zebraniu ZARZĄDU jako
// kampania e-mail do KONT członków Rady (audience meeting_invitees). Wskazanie właściciela
// 2026-10-02 (D-21, D-16/D-17): odbiorcy = konta z aktywnym przydziałem ról board,
// representative, audit, principal w roku zebrania; jedna wiadomość na konto; adres =
// users.email. Testy PGlite przez handlePgRequest i runEmailBatch z atrapą transportu.
// Dane wyłącznie syntetyczne (@example.invalid); żadna wiadomość nie wychodzi z procesu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { runEmailBatch } from '../src/email/worker.js';
import { EmailTransportError } from '../src/email/brevo.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedPublishedPrivacyNotice, seedUserSession } from './helpers/pg.js';

const YEAR = 'y2026';
const OTHER_YEAR = 'y2025';
const DAY = 86400000;
const WEBHOOK_SECRET = 'w'.repeat(48);
// 15.01.2027 18:00 UTC = 19:00 w Brukseli (czas zimowy).
const SCHEDULED_AT = '2027-01-15T18:00:00.000Z';

// Konta zaproszone (aktywny przydział zapraszanej roli w roku 2026 albo bez roku).
const INVITED = ['u-aud', 'u-bd', 'u-bd2', 'u-bdclass', 'u-noyear', 'u-pri', 'u-rep', 'u-two'];

async function setup(extraEnv = {}) {
  const db = await createTestDb();
  // #145: zatwierdzenie każdej kampanii wymaga opublikowanej informacji o przetwarzaniu
  // danych — bramka jest globalna w module e-mail i obejmuje też kampanię do kont.
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'ca', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'cx', schoolYearId: OTHER_YEAR, name: '1X' });
  const s = (userId, roles, extra = {}) => seedUserSession(db, { userId, roles, mfa: true, ...extra });
  const cookies = {
    board: await s('u-bd', [{ role: 'board', schoolYearId: YEAR }]),
    board2: await s('u-bd2', [{ role: 'board', schoolYearId: YEAR }]),
    boardClass: await s('u-bdclass', [{ role: 'board', schoolYearId: YEAR, classId: 'ca' }]),
    rep: await s('u-rep', [{ role: 'representative', schoolYearId: YEAR, classId: 'ca' }]),
    audit: await s('u-aud', [{ role: 'audit', schoolYearId: YEAR }]),
    principal: await s('u-pri', [{ role: 'principal', schoolYearId: YEAR }]),
    treasurer: await s('u-treas', [{ role: 'treasurer', schoolYearId: YEAR }]),
    admin: await s('u-admin', [{ role: 'admin' }]),
  };
  // Dwie role tego samego konta = jedna wiadomość.
  await s('u-two', [{ role: 'board', schoolYearId: YEAR }, { role: 'representative', schoolYearId: YEAR, classId: 'ca' }]);
  // Przydział bez roku obowiązuje we wszystkich latach (jak resolver zakresu) — zaproszony.
  await s('u-noyear', [{ role: 'audit' }]);
  // Pominięci: przydział cofnięty, wygasły, z innego roku, rola spoza listy.
  await s('u-revoked', [{ role: 'board', schoolYearId: YEAR, revoked: true }]);
  await s('u-expired', [{ role: 'audit', schoolYearId: YEAR, expiresAt: Date.now() - DAY }]);
  await s('u-other', [{ role: 'representative', schoolYearId: OTHER_YEAR, classId: 'cx' }]);
  // Konto wyłączone i konto z błędnym adresem — wykluczenia widoczne dla zatwierdzającego.
  await s('u-disabled', [{ role: 'board', schoolYearId: YEAR }], { disabled: true });
  await s('u-bad', [{ role: 'representative', schoolYearId: YEAR, classId: 'ca' }], { email: 'zly-adres.example.invalid' });
  const env = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid', BREVO_WEBHOOK_SECRET: WEBHOOK_SECRET, ...extraEnv,
  };
  let seq = 0;
  const call = async (cookie, method, path, body, headers = {}) => {
    const response = await handlePgRequest(request(path, {
      method, cookie, body, headers: { 'Idempotency-Key': `k-${++seq}-${Math.random().toString(36).slice(2)}`, ...headers },
    }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const count = async (sql, params = []) => (await db.query(sql, params)).rows[0].n;
  return { db, env, cookies, call, count, close: () => db.close() };
}

// Zebranie zarządu z porządkiem obrad i zatwierdzonym zawiadomieniem (autor ≠ zatwierdzający).
async function boardMeetingWithNotice(t, { items = ['Sprawozdanie skarbnika', 'Plan wydarzeń'] } = {}) {
  const created = await t.call(t.cookies.board, 'POST', '/api/meetings', {
    schoolYearId: YEAR, kind: 'board', title: 'Posiedzenie zarządu', scheduledAt: SCHEDULED_AT,
    location: 'Sala 12', status: 'scheduled',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const meeting = created.body.meeting;
  const agenda = [];
  for (const title of items) {
    const item = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/agenda-items`, { title });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    agenda.push(item.body.agendaItem);
  }
  const draft = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const approved = await t.call(t.cookies.board2, 'POST', `/api/meetings/${meeting.id}/notices/${draft.body.notice.id}/approval`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { meeting, notice: approved.body.notice, agenda };
}

async function campaignDraft(t, meeting, notice) {
  const made = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices/${notice.id}/campaign-draft`, {});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body.campaign.id;
}

async function snapshotAndPreview(t, id) {
  const snap = await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/snapshot`);
  assert.equal(snap.status, 200, JSON.stringify(snap.body));
  const preview = await t.call(t.cookies.board, 'GET', `/api/email/campaigns/${id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  return { snap: snap.body, preview: preview.body };
}

async function approveAndQueue(t, id) {
  const { preview } = await snapshotAndPreview(t, id);
  const approved = await t.call(t.cookies.board2, 'POST', `/api/email/campaigns/${id}/approve`,
    { contentHash: preview.contentHash, recipientsHash: preview.recipientsHash });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const queued = await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/queue`);
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  return preview;
}

function fakeTransport(sent, { reject = () => null } = {}) {
  return {
    name: 'fake',
    async send(message) {
      const error = reject(message);
      if (error) throw error;
      sent.push(message);
      return { messageId: `fake-${sent.length}` };
    },
  };
}

const runWorker = (t, transport) => runEmailBatch(t.env, { transport, dryRun: false, now: new Date() });

async function recipientUsers(db, campaignId) {
  const { rows } = await db.query(
    'SELECT user_id, household_id, guardian_id, email FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY user_id', [campaignId]);
  return rows;
}

test('zebranie zarządu: odbiorcy z aktywnych przydziałów roku (board, representative, audit, principal), jedna wiadomość na konto, adres z konta', async () => {
  const t = await setup();
  try {
    const { meeting, notice } = await boardMeetingWithNotice(t);
    const id = await campaignDraft(t, meeting, notice);
    const { rows: [campaign] } = await t.db.query('SELECT * FROM email_campaigns WHERE id = $1', [id]);
    assert.equal(campaign.audience, 'meeting_invitees');
    assert.equal(campaign.status, 'draft');
    assert.equal(campaign.category, 'organizational');
    assert.equal(campaign.meeting_notice_id, notice.id);
    // Treść = szkic z szablonu: data i godzina w Europe/Brussels, miejsce, porządek z wersji zawiadomienia.
    assert.match(campaign.body_text, /15\.01\.2027, 19:00 \(czas brukselski\)/);
    assert.match(campaign.body_text, /Miejsce: Sala 12\./);
    assert.match(campaign.body_text, /Porządek obrad:\n1\. Sprawozdanie skarbnika\n2\. Plan wydarzeń/);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_campaign_recipients'), 0, 'szkic nie buduje listy');

    const { snap, preview } = await snapshotAndPreview(t, id);
    const rows = await recipientUsers(t.db, id);
    assert.deepEqual(rows.map((r) => r.user_id), INVITED);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.household_id === null && r.guardian_id === null), 'odbiorca to konto, nie rodzina');
    assert.ok(rows.every((r) => r.email === `${r.user_id}@example.invalid`), 'adres = users.email');
    assert.equal(snap.recipientsCount, INVITED.length);
    assert.deepEqual(snap.exclusions, { account_disabled: 1, no_valid_email: 1 });
    const { rows: exclusions } = await t.db.query(
      'SELECT user_id, household_id, reason FROM email_campaign_exclusions WHERE campaign_id = $1 ORDER BY user_id', [id]);
    assert.deepEqual(exclusions, [
      { user_id: 'u-bad', household_id: null, reason: 'no_valid_email' },
      { user_id: 'u-disabled', household_id: null, reason: 'account_disabled' },
    ]);
    for (const absent of ['u-revoked', 'u-expired', 'u-other', 'u-treas', 'u-admin']) {
      assert.ok(!rows.some((r) => r.user_id === absent), `${absent} nie jest zaproszony`);
    }

    assert.equal(preview.recipientsCount, INVITED.length);
    assert.equal(preview.snapshotCurrent, true);
    assert.deepEqual(preview.staleRecipients, {});
    assert.equal(preview.sample.householdId, null);
    assert.equal(preview.sample.userId, INVITED[0]);
    assert.ok(!preview.warnings.includes('missing_skip_if_paid_sentence'), 'zawiadomienie nie dotyczy składki');
    assert.ok(!preview.warnings.includes('notice_outdated'));
    assert.ok(preview.warnings.includes('template_requires_board_decision_d16'));
    assert.equal(preview.sends, false);

    const list = await t.call(t.cookies.board, 'GET', `/api/email/campaigns/${id}/recipients?limit=3`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.recipients.map((r) => r.userId), INVITED.slice(0, 3));
    assert.equal(list.body.recipients[0].householdId, null);
    const next = await t.call(t.cookies.board, 'GET', `/api/email/campaigns/${id}/recipients?limit=3&cursor=${encodeURIComponent(list.body.nextCursor)}`);
    assert.deepEqual(next.body.recipients.map((r) => r.userId), INVITED.slice(3, 6));

    // Odbiorców kampanii z zawiadomienia nie zmienia się ręcznie; ręczny szkic nie dostanie kont.
    const change = await t.call(t.cookies.board, 'PUT', `/api/email/campaigns/${id}`, {
      revision: campaign.revision_no, title: campaign.title, audience: 'all_households',
      subject: campaign.subject, bodyText: campaign.body_text, category: 'organizational',
    });
    assert.equal(change.status, 409);
    assert.equal(change.body.error, 'campaign_audience_locked');
    const placeholder = await t.call(t.cookies.board, 'PUT', `/api/email/campaigns/${id}`, {
      revision: campaign.revision_no, title: campaign.title, audience: 'meeting_invitees',
      subject: campaign.subject, bodyText: `${campaign.body_text}\nRodzina: {rodzina}`, category: 'organizational',
    });
    assert.equal(placeholder.status, 400, 'wiadomość do konta nie ma placeholderów rodziny');
    assert.equal(placeholder.body.error, 'invalid_placeholder');
    const manual = await t.call(t.cookies.board, 'POST', '/api/email/campaigns', {
      schoolYearId: YEAR, title: 'Ręczny szkic', audience: 'meeting_invitees', subject: 'Temat wiadomości',
      bodyText: 'Treść wiadomości organizacyjnej, ponad dwadzieścia znaków.', category: 'organizational',
    });
    assert.equal(manual.status, 400);
    assert.equal(manual.body.error, 'invalid_audience');
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_outbox'), 0);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('zebranie zarządu: brak wysyłki bez zatwierdzenia; podwójne kliknięcie migawki, zatwierdzenia i kolejki (PGlite: po kolei, nie wyścig); ponowienie zadania bez drugiej wiadomości', async () => {
  const t = await setup();
  try {
    const { meeting, notice } = await boardMeetingWithNotice(t);
    const id = await campaignDraft(t, meeting, notice);
    const [first, second] = await Promise.all([
      t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/snapshot`),
      t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/snapshot`),
    ]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(first.body.recipientsHash, second.body.recipientsHash, 'ta sama lista = ten sam skrót');
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_campaign_recipients WHERE campaign_id = $1', [id]), INVITED.length);

    // Bez zatwierdzenia: kolejka odmawia, zadanie nic nie wysyła.
    const early = await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/queue`);
    assert.equal(early.status, 409);
    assert.equal(early.body.error, 'approval_required');
    const sent = [];
    const idle = await runWorker(t, fakeTransport(sent));
    assert.equal(idle.sent, 0);
    assert.equal(sent.length, 0);

    const preview = (await t.call(t.cookies.board, 'GET', `/api/email/campaigns/${id}/preview`)).body;
    const body = { contentHash: preview.contentHash, recipientsHash: preview.recipientsHash };
    // Autor szkicu i migawki nie zatwierdza sam (cztery oczy).
    const self = await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/approve`, body);
    assert.equal(self.status, 403);
    assert.equal(self.body.error, 'self_approval_forbidden');
    // Zatwierdzenie dokładnie widzianych skrótów treści i listy.
    const wrong = await t.call(t.cookies.board2, 'POST', `/api/email/campaigns/${id}/approve`,
      { contentHash: preview.contentHash, recipientsHash: 'b'.repeat(64) });
    assert.equal(wrong.status, 409);
    const approvals = await Promise.all([
      t.call(t.cookies.board2, 'POST', `/api/email/campaigns/${id}/approve`, body),
      t.call(t.cookies.board2, 'POST', `/api/email/campaigns/${id}/approve`, body),
    ]);
    assert.deepEqual(approvals.map((r) => r.status), [200, 200], JSON.stringify(approvals.map((r) => r.body)));
    assert.equal((await t.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.campaign.approved' AND entity_id = $1", [id])).rows[0].n, 1);
    const queues = await Promise.all([
      t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/queue`),
      t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/queue`),
    ]);
    assert.deepEqual(queues.map((r) => r.status), [200, 200]);
    assert.deepEqual(queues.map((r) => r.body.queued).sort(), [0, INVITED.length]);
    const { rows: outbox } = await t.db.query('SELECT user_id, household_id, idempotency_key, state FROM email_outbox WHERE campaign_id = $1 ORDER BY user_id', [id]);
    assert.deepEqual(outbox.map((r) => r.user_id), INVITED);
    assert.ok(outbox.every((r) => r.household_id === null && r.idempotency_key === `campaign:${id}:user:${r.user_id}`),
      'klucz idempotencji kampania + konto');

    // Nadawca wyłącznie z konfiguracji: bez BREVO_FROM_EMAIL zadanie odmawia i nic nie wychodzi.
    const noSender = await runEmailBatch({ ...t.env, BREVO_FROM_EMAIL: '' }, { transport: fakeTransport(sent), dryRun: false, now: new Date() });
    assert.equal(noSender.stoppedReason, 'sender_not_configured');
    assert.equal(sent.length, 0);

    const run = await runWorker(t, fakeTransport(sent));
    assert.equal(run.sent, INVITED.length);
    assert.equal(sent.length, INVITED.length);
    // Osobne wiadomości: jeden adresat, bez kopii; nadawca z konfiguracji.
    assert.deepEqual(sent.map((m) => m.to).sort(), INVITED.map((u) => `${u}@example.invalid`).sort());
    for (const message of sent) {
      assert.equal(typeof message.to, 'string');
      assert.equal(message.cc, undefined);
      assert.equal(message.bcc, undefined);
      assert.equal(message.sender.email, 'rada@example.invalid');
      assert.match(message.text, /15\.01\.2027, 19:00/);
      assert.match(message.idempotencyKey, /^campaign:.+:user:u-[a-z0-9]+$/);
    }
    const again = await runWorker(t, fakeTransport(sent));
    assert.equal(again.sent, 0);
    assert.equal(sent.length, INVITED.length, 'ponowienie zadania nie wysyła drugiej wiadomości do konta');
    assert.equal((await t.db.query('SELECT status FROM email_campaigns WHERE id = $1', [id])).rows[0].status, 'done');

    // Dziennik: aktor, czas, identyfikatory — bez adresów i treści.
    const { rows: sentEvents } = await t.db.query("SELECT metadata_json FROM audit_events WHERE action = 'email.sent' ORDER BY occurred_at, id");
    assert.equal(sentEvents.length, INVITED.length);
    assert.deepEqual(sentEvents.map((e) => e.metadata_json.userId).sort(), INVITED);
    const leaked = await t.db.query("SELECT count(*)::int AS n FROM audit_events WHERE metadata_json::text LIKE '%example.invalid%' OR metadata_json::text LIKE '%Sprawozdanie%'");
    assert.equal(leaked.rows[0].n, 0);

    // Kampania uzupełniająca dotyczy wyłącznie rodzin.
    const followup = await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${id}/followup`, {});
    assert.equal(followup.status, 409);
    assert.equal(followup.body.error, 'followup_source_not_eligible');
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('zebranie zarządu: błędny adres odrzucony przez dostawcę i odbicie — wykluczenie, reszta kampanii przechodzi; kolejna migawka pomija adres', async () => {
  const t = await setup();
  try {
    const { meeting, notice } = await boardMeetingWithNotice(t);
    const id = await campaignDraft(t, meeting, notice);
    await approveAndQueue(t, id);
    const sent = [];
    const run = await runWorker(t, fakeTransport(sent, {
      reject: (m) => (m.to === 'u-aud@example.invalid' ? new EmailTransportError('invalid_recipient') : null),
    }));
    assert.equal(run.failed, 1);
    assert.equal(run.sent, INVITED.length - 1);
    const { rows: [failed] } = await t.db.query("SELECT state, last_error FROM email_outbox WHERE campaign_id = $1 AND user_id = 'u-aud'", [id]);
    assert.deepEqual(failed, { state: 'failed', last_error: 'invalid_recipient' });

    // Webhook: twarde odbicie adresu konta → wiersz „bounced” i blokada adresu (tylko skrót).
    const { rows: [rep] } = await t.db.query("SELECT id, provider_message_id FROM email_outbox WHERE campaign_id = $1 AND user_id = 'u-rep'", [id]);
    const hook = await handlePgRequest(request('/api/email/webhooks/brevo', {
      method: 'POST', origin: false, headers: { Authorization: `Bearer ${WEBHOOK_SECRET}` },
      body: { event: 'hard_bounce', email: 'u-rep@example.invalid', 'message-id': rep.provider_message_id, 'X-Mailin-custom': rep.id, ts_event: 1800000000 },
    }), t.env);
    assert.equal(hook.status, 200, await hook.text());
    assert.equal((await t.db.query('SELECT state FROM email_outbox WHERE id = $1', [rep.id])).rows[0].state, 'bounced');
    const { rows: [suppressedEvent] } = await t.db.query("SELECT metadata_json FROM audit_events WHERE action = 'email.address_suppressed'");
    assert.equal(suppressedEvent.metadata_json.userId, 'u-rep');
    assert.equal(suppressedEvent.metadata_json.guardianId, null);
    assert.ok(!JSON.stringify(suppressedEvent.metadata_json).includes('@'));

    // Zmiana terminu po wysyłce: nowa wersja zawiadomienia → nowa kampania, adres z blokadą wykluczony.
    const revision = (await t.call(t.cookies.board, 'GET', `/api/meetings/${meeting.id}`)).body.meeting.revisionNo;
    const moved = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/reschedule`,
      { scheduledAt: '2027-01-22T18:00:00.000Z', reason: 'Nowy termin posiedzenia', revision });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const rescheduleNotice = moved.body.rescheduleNotice;
    assert.equal(rescheduleNotice.kind, 'reschedule');
    const approvedAgain = await t.call(t.cookies.board2, 'POST', `/api/meetings/${meeting.id}/notices/${rescheduleNotice.id}/approval`, {});
    assert.equal(approvedAgain.status, 200, JSON.stringify(approvedAgain.body));
    const id2 = await campaignDraft(t, meeting, approvedAgain.body.notice);
    const { snap } = await snapshotAndPreview(t, id2);
    assert.deepEqual(snap.exclusions, { account_disabled: 1, no_valid_email: 1, suppressed: 1 });
    const users = (await recipientUsers(t.db, id2)).map((r) => r.user_id);
    assert.ok(!users.includes('u-rep'));
    assert.equal(users.length, INVITED.length - 1);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('zebranie zarządu: przydział cofnięty, konto wyłączone lub adres zmieniony po zatwierdzeniu — worker pomija wiadomość, reszta przechodzi', async () => {
  const t = await setup();
  try {
    const { meeting, notice } = await boardMeetingWithNotice(t);
    const id = await campaignDraft(t, meeting, notice);
    await approveAndQueue(t, id);
    // Po zatwierdzeniu, przed wysyłką.
    await t.db.query("UPDATE role_grants SET revoked_at = now(), revoked_by = 'u-admin' WHERE user_id = 'u-rep'");
    await t.db.query("UPDATE users SET disabled_at = now() WHERE id = 'u-pri'");
    await t.db.query("UPDATE users SET email = 'u-aud-nowy@example.invalid' WHERE id = 'u-aud'");
    // Konto z dwiema rolami traci tylko jedną — nadal zaproszone.
    await t.db.query("UPDATE role_grants SET revoked_at = now(), revoked_by = 'u-admin' WHERE user_id = 'u-two' AND role = 'board'");
    // Przydział, który wygasł po zatwierdzeniu.
    await t.db.query("UPDATE role_grants SET expires_at = now() - interval '1 minute' WHERE user_id = 'u-noyear'");

    const preview = (await t.call(t.cookies.board, 'GET', `/api/email/campaigns/${id}/preview`)).body;
    assert.deepEqual(preview.staleRecipients, { account_address_changed: 1, account_disabled: 1, role_grant_inactive: 2 });

    const sent = [];
    const run = await runWorker(t, fakeTransport(sent));
    assert.equal(run.suppressed, 4);
    assert.equal(run.sent, INVITED.length - 4);
    const { rows } = await t.db.query('SELECT user_id, state, last_error FROM email_outbox WHERE campaign_id = $1 ORDER BY user_id', [id]);
    const byUser = Object.fromEntries(rows.map((r) => [r.user_id, [r.state, r.last_error]]));
    assert.deepEqual(byUser['u-rep'], ['suppressed', 'role_grant_inactive']);
    assert.deepEqual(byUser['u-noyear'], ['suppressed', 'role_grant_inactive']);
    assert.deepEqual(byUser['u-pri'], ['suppressed', 'account_disabled']);
    assert.deepEqual(byUser['u-aud'], ['suppressed', 'account_address_changed']);
    assert.deepEqual(byUser['u-two'], ['sent', null]);
    assert.ok(!sent.some((m) => ['u-rep@example.invalid', 'u-pri@example.invalid', 'u-noyear@example.invalid'].includes(m.to)));
    assert.ok(!sent.some((m) => m.to.startsWith('u-aud')), 'ani stary, ani nowy adres konta');
    const again = await runWorker(t, fakeTransport(sent));
    assert.equal(again.sent, 0);
    assert.equal(sent.length, INVITED.length - 4);
  } finally { await t.close(); }
});

test('zebranie zarządu: przydział cofnięty w trakcie przebiegu (po przejęciu, tuż przed wysyłką) — potwierdzenie przed wysyłką pomija konto', async () => {
  const t = await setup();
  try {
    const { meeting, notice } = await boardMeetingWithNotice(t);
    const id = await campaignDraft(t, meeting, notice);
    await approveAndQueue(t, id);
    const sent = [];
    let revoked = null;
    const wrapped = {
      name: 'fake',
      async send(message) {
        // Wiersze są już przejęte przez przebieg; przy pierwszej wysyłce cofamy przydział
        // konta, które jeszcze czeka na swoją kolej.
        const marker = !revoked ? (message.to === 'u-rep@example.invalid' ? 'u-pri' : 'u-rep') : null;
        if (marker) {
          revoked = marker;
          await t.db.query("UPDATE role_grants SET revoked_at = now(), revoked_by = 'u-admin' WHERE user_id = $1", [marker]);
        }
        sent.push(message);
        return { messageId: `fake-${sent.length}` };
      },
    };
    const run = await runWorker(t, wrapped);
    assert.ok(revoked);
    assert.equal(run.sent, INVITED.length - 1);
    assert.equal(run.suppressed, 1);
    const { rows: [row] } = await t.db.query('SELECT id, state, last_error FROM email_outbox WHERE campaign_id = $1 AND user_id = $2', [id, revoked]);
    assert.deepEqual([row.state, row.last_error], ['suppressed', 'role_grant_inactive']);
    assert.ok(!sent.some((m) => m.to === `${revoked}@example.invalid`));
    const { rows: [event] } = await t.db.query("SELECT metadata_json FROM audit_events WHERE action = 'email.suppressed' AND entity_id = $1", [row.id]);
    assert.equal(event.metadata_json.stage, 'before_send');
    assert.equal(event.metadata_json.reason, 'role_grant_inactive');
  } finally { await t.close(); }
});

test('zebranie zarządu: zmiana porządku lub terminu po zatwierdzeniu kampanii unieważnia jej zatwierdzenie i wstrzymuje wysyłkę', async () => {
  const t = await setup();
  try {
    // A) Zatwierdzona, niezakolejkowana: zmiana kolejności punktów → kolejka 409 notice_outdated.
    const a = await boardMeetingWithNotice(t);
    const idA = await campaignDraft(t, a.meeting, a.notice);
    const previewA = (await snapshotAndPreview(t, idA)).preview;
    const approvedA = await t.call(t.cookies.board2, 'POST', `/api/email/campaigns/${idA}/approve`,
      { contentHash: previewA.contentHash, recipientsHash: previewA.recipientsHash });
    assert.equal(approvedA.status, 200, JSON.stringify(approvedA.body));
    const reorder = await t.call(t.cookies.board, 'POST', `/api/meetings/${a.meeting.id}/agenda-order`,
      { itemIds: [a.agenda[1].id, a.agenda[0].id] });
    assert.equal(reorder.status, 200, JSON.stringify(reorder.body));
    const queued = await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${idA}/queue`);
    assert.equal(queued.status, 409);
    assert.equal(queued.body.error, 'notice_outdated');
    assert.ok((await t.call(t.cookies.board, 'GET', `/api/email/campaigns/${idA}/preview`)).body.warnings.includes('notice_outdated'));

    // B) Szkic z migawką: zmiana porządku przed zatwierdzeniem → zatwierdzenie 409 notice_outdated.
    const b = await boardMeetingWithNotice(t);
    const idB = await campaignDraft(t, b.meeting, b.notice);
    const previewB = (await snapshotAndPreview(t, idB)).preview;
    const added = await t.call(t.cookies.board, 'POST', `/api/meetings/${b.meeting.id}/agenda-items`, { title: 'Punkt dodatkowy' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const approvedB = await t.call(t.cookies.board2, 'POST', `/api/email/campaigns/${idB}/approve`,
      { contentHash: previewB.contentHash, recipientsHash: previewB.recipientsHash });
    assert.equal(approvedB.status, 409);
    assert.equal(approvedB.body.error, 'notice_outdated');

    // C) Zakolejkowana: zmiana terminu (nowa wersja zawiadomienia) → worker pomija kampanię, wiersze zostają w kolejce.
    const c = await boardMeetingWithNotice(t);
    const idC = await campaignDraft(t, c.meeting, c.notice);
    await approveAndQueue(t, idC);
    const revision = (await t.call(t.cookies.board, 'GET', `/api/meetings/${c.meeting.id}`)).body.meeting.revisionNo;
    const moved = await t.call(t.cookies.board, 'POST', `/api/meetings/${c.meeting.id}/reschedule`,
      { scheduledAt: '2027-02-05T18:00:00.000Z', reason: 'Nowy termin posiedzenia', revision });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const sent = [];
    const run = await runWorker(t, fakeTransport(sent));
    assert.equal(sent.length, 0);
    assert.equal(run.stoppedReason, 'meeting_notice_outdated');
    assert.equal(await t.count("SELECT count(*)::int AS n FROM email_outbox WHERE campaign_id = $1 AND state = 'queued'", [idC]), INVITED.length);
    // Pauza i wznowienie nie omijają sprawdzenia.
    assert.equal((await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${idC}/pause`)).status, 200);
    const resumed = await t.call(t.cookies.board, 'POST', `/api/email/campaigns/${idC}/resume`);
    assert.equal(resumed.status, 409);
    assert.equal(resumed.body.error, 'notice_outdated');
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('zebranie zarządu: granice ról — przedstawiciel, KR, dyrekcja, skarbnik i zarząd klasowy nie tworzą zawiadomienia ani szkicu kampanii (403)', async () => {
  const t = await setup();
  try {
    const { meeting, notice } = await boardMeetingWithNotice(t);
    const base = `/api/meetings/${meeting.id}/notices`;
    for (const [name, cookie] of [
      ['representative', t.cookies.rep], ['audit', t.cookies.audit], ['principal', t.cookies.principal],
      ['treasurer', t.cookies.treasurer], ['board:class', t.cookies.boardClass],
    ]) {
      const draft = await t.call(cookie, 'POST', base, {});
      assert.ok([403, 404].includes(draft.status), `${name} notice: ${draft.status}`);
      const campaign = await t.call(cookie, 'POST', `${base}/${notice.id}/campaign-draft`, {});
      assert.equal(campaign.status, 403, `${name} campaign-draft: ${campaign.status}`);
      assert.equal(campaign.body.error, 'forbidden');
    }
    const noMfa = await seedUserSession(t.db, { userId: 'u-bd4', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: false });
    const denied = await t.call(noMfa, 'POST', `${base}/${notice.id}/campaign-draft`, {});
    assert.equal(denied.status, 403);
    // Bramka routera (brak skonfigurowanego MFA) albo trasa (MFA niepotwierdzone) — w obu przypadkach 403.
    assert.ok(['mfa_required', 'mfa_enrollment_required'].includes(denied.body.error), denied.body.error);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_campaigns'), 0);
    // Zarząd szkolny z MFA — tak jak dla zebrań ogólnych.
    const id = await campaignDraft(t, meeting, notice);
    // Moduł kampanii: przedstawiciel, KR, dyrekcja i zarząd klasowy nie widzą podglądu ani listy.
    for (const [name, cookie] of [
      ['representative', t.cookies.rep], ['audit', t.cookies.audit], ['principal', t.cookies.principal],
      ['board:class', t.cookies.boardClass],
    ]) {
      const res = await t.call(cookie, 'GET', `/api/email/campaigns/${id}/preview`);
      assert.equal(res.status, 403, `${name} preview: ${res.status}`);
    }
  } finally { await t.close(); }
});

test('baza: odbiorca kampanii to dokładnie rodzina albo konto; meeting_invitees tylko dla zebrania zarządu', async () => {
  const t = await setup();
  try {
    const { meeting, notice } = await boardMeetingWithNotice(t);
    const plenary = await t.call(t.cookies.board, 'POST', '/api/meetings', {
      schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie ogólne', scheduledAt: SCHEDULED_AT, location: 'Aula', status: 'scheduled',
    });
    const insertCampaign = (over) => t.db.query(
      `INSERT INTO email_campaigns (id, school_year_id, title, audience, category, subject, body_text, content_hash,
         created_by, updated_by, idempotency_key, meeting_id, meeting_notice_id)
       VALUES ($1, $2, 'Tytuł kampanii', $3, 'organizational', 'Temat wiadomości', 'Treść wiadomości powyżej dwudziestu znaków',
         repeat('a', 64), 'u-bd', 'u-bd', $4, $5, $6)`,
      [over.id, YEAR, over.audience, `key-${over.id}`, over.meeting ?? null, over.notice ?? null]);
    await assert.rejects(insertCampaign({ id: 'c-manual', audience: 'meeting_invitees' }), /email_campaigns_invitees_require_meeting/);
    await assert.rejects(insertCampaign({ id: 'c-board-households', audience: 'all_households', meeting: meeting.id, notice: notice.id }),
      /email_campaign_meeting_audience_mismatch/);
    assert.equal(plenary.status, 201);

    const id = await campaignDraft(t, meeting, notice);
    await snapshotAndPreview(t, id);
    await t.db.query("INSERT INTO households (id) VALUES ('h-1')");
    await t.db.query(`INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
                      VALUES ('g-1', 'h-1', 'Opiekun', 'Syntetyczny', 'g-1@example.invalid', true)`);
    const { rows: [campaign] } = await t.db.query('SELECT recipients_hash FROM email_campaigns WHERE id = $1', [id]);
    assert.ok(campaign.recipients_hash);
    await assert.rejects(t.db.query(
      `INSERT INTO email_campaign_recipients (id, campaign_id, household_id, guardian_id, user_id, email, email_hash)
       VALUES ('r-both', $1, 'h-1', 'g-1', 'u-treas', 'u-treas@example.invalid', repeat('c', 64))`, [id]),
    /email_campaign_recipients_one_subject/);
    await assert.rejects(t.db.query(
      `INSERT INTO email_campaign_recipients (id, campaign_id, email, email_hash)
       VALUES ('r-none', $1, 'x-1@example.invalid', repeat('d', 64))`, [id]),
    /email_campaign_recipients_one_subject/);
    await assert.rejects(t.db.query(
      `INSERT INTO email_campaign_recipients (id, campaign_id, user_id, email, email_hash)
       VALUES ('r-dup', $1, 'u-bd', 'u-bd-2@example.invalid', repeat('e', 64))`, [id]),
    /email_campaign_recipients_campaign_user_key/);
    // Wiersz migawki konta jest niezmienny.
    await assert.rejects(t.db.query("UPDATE email_campaign_recipients SET user_id = 'u-treas' WHERE campaign_id = $1 AND user_id = 'u-bd'", [id]),
      /email_snapshot_rows_immutable/);
  } finally { await t.close(); }
});

test('regresja: zebranie ogólne nadal wysyła do rodzin (klucz kampania + rodzina), bez kont', async () => {
  const t = await setup();
  try {
    await t.db.query("INSERT INTO households (id) VALUES ('h-a')");
    await t.db.query(`INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
                      VALUES ('h-a-g', 'h-a', 'Opiekun', 'Syntetyczny', 'h-a-g@example.invalid', true)`);
    await t.db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ('h-a-s', 'h-a', 'Uczeń', 'Syntetyczny')");
    await t.db.query("INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ('e-h-a', 'h-a-s', 'ca', $1)", [YEAR]);
    await t.db.query("INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES ('h-a-s', 'h-a-g', true)");
    const created = await t.call(t.cookies.board, 'POST', '/api/meetings', {
      schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie ogólne', scheduledAt: SCHEDULED_AT, location: 'Aula', status: 'scheduled',
    });
    const meeting = created.body.meeting;
    assert.equal((await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/agenda-items`, { title: 'Sprawozdanie' })).status, 201);
    const draft = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices`, {});
    const approved = await t.call(t.cookies.board2, 'POST', `/api/meetings/${meeting.id}/notices/${draft.body.notice.id}/approval`, {});
    const made = await t.call(t.cookies.board, 'POST', `/api/meetings/${meeting.id}/notices/${approved.body.notice.id}/campaign-draft`, {});
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.campaign.audience, 'all_households');
    const id = made.body.campaign.id;
    await approveAndQueue(t, id);
    const { rows } = await t.db.query('SELECT household_id, user_id, idempotency_key FROM email_outbox WHERE campaign_id = $1', [id]);
    assert.deepEqual(rows, [{ household_id: 'h-a', user_id: null, idempotency_key: `campaign:${id}:household:h-a` }]);
    const sent = [];
    const run = await runWorker(t, fakeTransport(sent));
    assert.equal(run.sent, 1);
    assert.deepEqual(sent.map((m) => m.to), ['h-a-g@example.invalid']);
  } finally { await t.close(); }
});
