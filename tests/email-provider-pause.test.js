// Trwała pauza wysyłki po odmowie konta przez Brevo (#209, migracja 0155) oraz
// brakujące scenariusze workera z tego issue. Wyłącznie dane syntetyczne
// (@example.invalid). Żaden test nie łączy się z siecią: transport Brevo
// dostaje wstrzyknięty fetchImpl, a globalny fetch jest pułapką (helpers/pg.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createBrevoTransport } from '../src/email/brevo.js';
import { emailHash } from '../src/email/content.js';
import { activeProviderPause, runEmailBatch } from '../src/email/worker.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const YEAR = 'y2026';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const HOUR = 60 * 60_000;
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

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
    return { status: response.status, body: text ? JSON.parse(text) : null, replayed: response.headers.get('Idempotency-Replayed') };
  };
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  return { db, env, treasurer, board, board2, call, count, close: () => db.close() };
}

async function family(db, householdId, { guardians = [{}] } = {}) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT DO NOTHING', [householdId]);
  const studentId = `${householdId}-s1`;
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [studentId, householdId]);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${studentId}`, studentId, 'c1', YEAR]);
  for (const [index, guardian] of guardians.entries()) {
    const id = `${householdId}-g${index + 1}`;
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, 'Opiekun', 'Testowy', $3, $4)`,
      [id, householdId, `${id}@example.invalid`, guardian.allowed ?? true],
    );
    await db.query(
      'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, $3)',
      [studentId, id, guardian.primary ?? false],
    );
  }
}

async function draftWithSnapshot(t, { audience = 'all_households' } = {}) {
  const created = await t.call(t.treasurer, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience, subject: 'Dobrowolna składka {rok}', bodyText: BODY },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const campaign = created.body.campaign;
  const snap = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/snapshot`, { method: 'POST' });
  assert.equal(snap.status, 200, JSON.stringify(snap.body));
  return { campaign, snapshot: snap.body };
}

async function approveAndQueue(t, campaignId) {
  const preview = await t.call(t.board, `/api/email/campaigns/${campaignId}/preview`);
  const approved = await t.call(t.board, `/api/email/campaigns/${campaignId}/approve`, {
    method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const queued = await t.call(t.treasurer, `/api/email/campaigns/${campaignId}/queue`, { method: 'POST' });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
}

async function readyCampaign(t, options) {
  const { campaign } = await draftWithSnapshot(t, options);
  await approveAndQueue(t, campaign.id);
  return campaign;
}

// Transport Brevo z wstrzykniętym fetchImpl (bez sieci); status per wywołanie.
function brevoStub(statusFor) {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const status = statusFor(requests.length, requests.at(-1));
    return new Response(status === 201 ? JSON.stringify({ messageId: `<m${requests.length}@example.invalid>` }) : '{}', { status });
  };
  const transport = createBrevoTransport({ apiKey: 'synthetic-key', appEnv: 'development', fetchImpl, processEnv: {} });
  transport.requests = requests;
  return transport;
}

async function outboxStates(t, campaignId) {
  const { rows } = await t.db.query('SELECT household_id, state, last_error FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [campaignId]);
  return rows;
}

const auditCount = (t, action) => t.count('SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [action]);
const ledgerCount = (t) => t.count("SELECT COALESCE(SUM(message_count), 0)::int AS n FROM email_send_ledger WHERE source = 'campaign'");
const pauseOf = async (t, cookie = t.board) => (await t.call(cookie, `/api/email/provider-pause?schoolYearId=${YEAR}`)).body.pause;
const lift = (t, cookie, pauseId, extra = {}) => t.call(cookie, '/api/email/provider-pause/lift', {
  method: 'POST', body: { schoolYearId: YEAR, pauseId }, ...extra,
});

// --- Pauza konta: przebiegi, panel, zdjęcie, wznowienie bez duplikatów -------

test('401: trwała pauza — kolejne przebiegi bez wywołania dostawcy, stan „wstrzymana — błąd konta”; zdjęcie przez zarząd wznawia wysyłkę, każda rodzina raz', async () => {
  const t = await setup();
  try {
    for (const id of ['h1', 'h2', 'h3']) await family(t.db, id);
    const campaign = await readyCampaign(t);
    let broken = true;
    const transport = brevoStub(() => (broken ? 401 : 201));

    const first = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(first.stoppedReason, 'provider_account_rejected');
    assert.equal(first.failed, 0);
    assert.equal(transport.requests.length, 1);
    const pause = await pauseOf(t);
    assert.equal(pause.reason, 'account_rejected');
    assert.equal(pause.errorCode, 'provider_rejected_401');
    assert.equal(pause.campaignId, campaign.id);
    assert.equal(pause.liftedAt, null);
    assert.equal(await auditCount(t, 'email.provider.paused'), 1);

    // Klucz poprawiony, ale bez potwierdzenia: ani przebieg na żywo, ani dry-run
    // nie przejmują kolejki i nie łączą się z dostawcą (nie ma ponowień bez końca).
    broken = false;
    for (const [i, dryRun] of [[1, false], [2, true], [3, false]]) {
      const run = await runEmailBatch(t.env, { transport, dryRun, now: new Date(DAY1.getTime() + i * HOUR) });
      assert.equal(run.stoppedReason, 'provider_account_paused');
      assert.equal(run.planned, 0);
      assert.equal(run.sent, 0);
    }
    assert.equal(transport.requests.length, 1);
    assert.equal(await t.count("SELECT count(*)::int AS n FROM email_worker_runs WHERE stopped_reason = 'provider_account_paused'"), 3);
    assert.equal(await auditCount(t, 'email.provider.paused'), 1, 'pauza zapisana raz');
    const queued = await outboxStates(t, campaign.id);
    assert.equal(queued.length, 3);
    for (const row of queued) assert.equal(row.state, 'queued');
    assert.equal(await ledgerCount(t), 0, 'odmowa konta nie zużywa limitu Brevo');

    // Panel: kampania „sending” z informacją o pauzie konta.
    const status = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}`);
    assert.equal(status.body.campaign.status, 'sending');
    assert.equal(status.body.providerPause.id, pause.id);

    const lifted = await lift(t, t.board, pause.id);
    assert.equal(lifted.status, 200, JSON.stringify(lifted.body));
    assert.equal(lifted.body.pause.liftedBy, 'u-bd');
    assert.ok(lifted.body.pause.liftedAt);
    assert.equal(await pauseOf(t), null);
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}`)).body.providerPause, null);

    const resumed = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 4 * HOUR) });
    assert.equal(resumed.sent, 3);
    const again = await runEmailBatch(t.env, { transport, dryRun: false, now: new Date(DAY1.getTime() + 5 * HOUR) });
    assert.equal(again.sent, 0, 'ponowienie zadania nic nie dubluje');
    const keys = transport.requests.slice(1).map((body) => body.headers['X-RD-Idempotency-Key']);
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 3);
    const { rows } = await t.db.query('SELECT idempotency_key FROM email_outbox WHERE campaign_id = $1 ORDER BY idempotency_key', [campaign.id]);
    assert.deepEqual([...keys].sort(), rows.map((row) => row.idempotency_key));
    assert.equal(await ledgerCount(t), 3);
    assert.equal((await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}`)).body.campaign.status, 'done');
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('podwójne kliknięcie „potwierdź naprawę” (kolejno i równolegle): jedno zdjęcie, jedno zdarzenie audytu', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await readyCampaign(t);
    await runEmailBatch(t.env, { transport: brevoStub(() => 403), dryRun: false, now: DAY1 });
    const pause = await pauseOf(t);
    assert.equal(pause.errorCode, 'provider_rejected_403');

    const [a, b] = await Promise.all([lift(t, t.board, pause.id), lift(t, t.board2, pause.id)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal([a, b].filter((r) => r.replayed === 'true').length, 1, 'jedno z dwóch to powtórzenie');
    const again = await lift(t, t.board, pause.id);
    assert.equal(again.status, 200);
    assert.equal(again.replayed, 'true');
    assert.equal(await auditCount(t, 'email.provider.pause_lifted'), 1);
    const { rows } = await t.db.query('SELECT lifted_by FROM email_provider_pauses WHERE id = $1', [pause.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].lifted_by, a.replayed === 'true' ? 'u-bd2' : 'u-bd');
    const { rows: events } = await t.db.query(
      "SELECT actor_id, entity_type, metadata_json FROM audit_events WHERE action = 'email.provider.pause_lifted'",
    );
    assert.equal(events[0].actor_id, rows[0].lifted_by);
    assert.equal(events[0].entity_type, 'email_provider_pause');
    assert.equal(events[0].metadata_json.errorCode, 'provider_rejected_403');
  } finally { await t.close(); }
});

test('granice ról: zdjęcie pauzy tylko zarząd ze świeżym MFA; skarbnik, przedstawiciel, KR, admin, dyrekcja, inny rok — 403 bez zmian', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await readyCampaign(t);
    await runEmailBatch(t.env, { transport: brevoStub(() => 401), dryRun: false, now: DAY1 });
    const pause = await pauseOf(t);
    const rep = await seedUserSession(t.db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] });
    const audit = await seedUserSession(t.db, { userId: 'u-kr', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] });
    const admin = await seedUserSession(t.db, { userId: 'u-adm', mfa: true, roles: [{ role: 'admin' }] });
    const principal = await seedUserSession(t.db, { userId: 'u-pr', mfa: true, roles: [{ role: 'principal', schoolYearId: YEAR }] });
    const otherYear = await seedUserSession(t.db, { userId: 'u-oy', mfa: true, roles: [{ role: 'board', schoolYearId: 'y2025' }] });
    const noMfa = await seedUserSession(t.db, { userId: 'u-nomfa', roles: [{ role: 'board', schoolYearId: YEAR }] });

    assert.equal((await lift(t, null, pause.id)).status, 401);
    for (const cookie of [t.treasurer, rep, audit, admin, principal, otherYear]) {
      const denied = await lift(t, cookie, pause.id);
      assert.deepEqual([denied.status, denied.body], [403, { error: 'forbidden' }]);
    }
    assert.equal((await lift(t, noMfa, pause.id)).status, 403);
    // Odczyt: zarząd i skarbnik; pozostali 403.
    assert.equal((await pauseOf(t, t.treasurer)).id, pause.id);
    for (const cookie of [rep, audit, admin, principal, otherYear]) {
      assert.equal((await t.call(cookie, `/api/email/provider-pause?schoolYearId=${YEAR}`)).status, 403);
    }
    // Krok w górę MFA (jak zatwierdzenie kampanii): MFA sprzed 20 min → mfa_stale.
    await t.db.query("UPDATE sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = 'u-bd'");
    assert.deepEqual(await lift(t, t.board, pause.id).then((r) => [r.status, r.body]), [403, { error: 'mfa_stale' }]);
    await t.db.query("UPDATE sessions SET mfa_verified_at = now() WHERE user_id = 'u-bd'");
    assert.deepEqual((await lift(t, t.board, pause.id, { origin: 'https://evil.example' })).body, { error: 'invalid_origin' });
    assert.equal(await auditCount(t, 'email.provider.pause_lifted'), 0);
    assert.equal((await pauseOf(t)).liftedAt, null, 'odmowa niczego nie zmieniła');

    assert.deepEqual((await lift(t, t.board, 'nieznana-pauza')).body, { error: 'provider_pause_not_found' });
    assert.deepEqual((await lift(t, t.board, '')).body, { error: 'invalid_provider_pause_id' });
    assert.deepEqual((await t.call(t.board, '/api/email/provider-pause/lift')).status, 405);
    assert.equal((await lift(t, t.board, pause.id)).status, 200);
  } finally { await t.close(); }
});

test('równoległy przebieg zapisał już pauzę: druga odmowa nie tworzy drugiej pauzy ani drugiego zdarzenia', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await readyCampaign(t);
    const transport = brevoStub(() => 401);
    const inner = transport.send.bind(transport);
    transport.send = async (message) => {
      // Inny przebieg (np. ręczny) dostał 401 chwilę wcześniej i zapisał pauzę.
      await t.db.query("INSERT INTO email_provider_pauses (id, reason, error_code) VALUES ('p-other', 'account_rejected', 'provider_rejected_401')");
      return inner(message);
    };
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.stoppedReason, 'provider_account_rejected');
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_provider_pauses'), 1);
    assert.equal((await activeProviderPause(t.db)).id, 'p-other');
    assert.equal(await auditCount(t, 'email.provider.paused'), 0);
    assert.equal(await auditCount(t, 'email.campaign.provider_rejected'), 1);
  } finally { await t.close(); }
});

test('baza: pauza niezmienna poza jednorazowym zdjęciem; bez DELETE/TRUNCATE; jedna aktywna; czas z zegara bazy', async () => {
  const t = await setup();
  try {
    await t.db.query(
      "INSERT INTO email_provider_pauses (id, reason, error_code, created_at) VALUES ('p1', 'account_rejected', 'provider_rejected_402', '2019-01-01T00:00:00Z')",
    );
    const { rows } = await t.db.query("SELECT created_at > now() - interval '1 hour' AS fresh FROM email_provider_pauses WHERE id = 'p1'");
    assert.equal(rows[0].fresh, true, 'antydatowany created_at przestawiony na now()');
    await assert.rejects(
      t.db.query("INSERT INTO email_provider_pauses (id, reason, error_code) VALUES ('p2', 'account_rejected', 'provider_rejected_401')"),
      /duplicate key/,
    );
    await assert.rejects(t.db.query("UPDATE email_provider_pauses SET error_code = 'provider_rejected_401' WHERE id = 'p1'"), /email_provider_pause_immutable/);
    await assert.rejects(t.db.query("DELETE FROM email_provider_pauses WHERE id = 'p1'"), /email_provider_pause_immutable/);
    await assert.rejects(t.db.query('TRUNCATE email_provider_pauses'));
    await assert.rejects(t.db.query("UPDATE email_provider_pauses SET lifted_at = now() WHERE id = 'p1'"), /email_provider_pause_lift_actor|email_provider_pause_immutable/);
    await t.db.query("UPDATE email_provider_pauses SET lifted_by = 'u-bd', lifted_at = '2019-01-01T00:00:00Z' WHERE id = 'p1'");
    const { rows: lifted } = await t.db.query("SELECT lifted_at > now() - interval '1 hour' AS fresh FROM email_provider_pauses WHERE id = 'p1'");
    assert.equal(lifted[0].fresh, true, 'lifted_at z zegara bazy');
    await assert.rejects(t.db.query("UPDATE email_provider_pauses SET lifted_by = 'u-bd2' WHERE id = 'p1'"), /email_provider_pause_immutable/);
    await assert.rejects(t.db.query("INSERT INTO email_provider_pauses (id, reason, error_code) VALUES ('p3', 'rate_limited', 'provider_rejected_401')"), /check/i);
    // Po zdjęciu wolno zapisać nową pauzę (kolejna odmowa konta).
    await t.db.query("INSERT INTO email_provider_pauses (id, reason, error_code) VALUES ('p4', 'account_rejected', 'provider_rejected_401')");
    assert.equal((await activeProviderPause(t.db)).id, 'p4');
  } finally { await t.close(); }
});

// --- Pozostałe scenariusze workera z #209 ---------------------------------------

test('wyjątek spoza EmailTransportError (TypeError): failed/transport_error, zużywa limit (mogła wyjść), reszta partii wychodzi, bez pauzy', async () => {
  const t = await setup();
  try {
    for (const id of ['h1', 'h2', 'h3']) await family(t.db, id);
    const campaign = await readyCampaign(t);
    const calls = [];
    const transport = {
      name: 'fake',
      async send(message) {
        calls.push(message);
        if (calls.length === 1) throw new TypeError('nieoczekiwany błąd transportu');
        return { messageId: `fake-${calls.length}` };
      },
    };
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.failed, 1);
    assert.equal(run.sent, 2);
    const states = await outboxStates(t, campaign.id);
    assert.equal(states.filter((r) => r.state === 'failed' && r.last_error === 'transport_error').length, 1);
    assert.equal(states.filter((r) => r.state === 'sent').length, 2);
    // Nie wiadomo, czy wiadomość wyszła — zachowawczo liczona do limitu dnia i nie ponawiana.
    assert.equal(await ledgerCount(t), 3);
    assert.equal(await activeProviderPause(t.db), null);
  } finally { await t.close(); }
});

test('wpłata 1 € skorygowana do 0 €: rodzina wraca do „brak wpisu wpłaty” w nowej migawce; korekta po kolejce nie blokuje wiadomości', async () => {
  const t = await setup();
  try {
    for (const id of ['h1', 'h2']) await family(t.db, id);
    const payment = (id, household) => t.db.query(
      `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
       VALUES ($1, $2, $3, 100, '2026-10-01', 'bank', 'recorded', 'u-tr', $4)`,
      [id, household, YEAR, `payment-key-${id}`],
    );
    const correctToZero = (id) => t.db.query(
      `INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
       VALUES ($1, $2, 100, 'Korekta syntetyczna', 'u-tr', $3)`,
      [`corr-${id}`, id, `correction-key-${id}`],
    );
    await payment('p1', 'h1');
    const before = await draftWithSnapshot(t, { audience: 'no_payment_record' });
    assert.deepEqual(before.snapshot.exclusions, { payment_recorded: 1 });
    assert.equal(before.snapshot.recipientsCount, 1);

    await correctToZero('p1');
    const after = await draftWithSnapshot(t, { audience: 'no_payment_record' });
    assert.equal(after.snapshot.recipientsCount, 2, 'netto 0 € = brak wpisu wpłaty');
    await approveAndQueue(t, after.campaign.id);

    // Wpłata 1 € po zakolejkowaniu, skorygowana do 0 € przed przebiegiem.
    await payment('p2', 'h2');
    await correctToZero('p2');
    const transport = brevoStub(() => 201);
    const run = await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.sent, 2);
    assert.equal(run.skipped, 0);
    assert.deepEqual(await outboxStates(t, after.campaign.id), [
      { household_id: 'h1', state: 'sent', last_error: null },
      { household_id: 'h2', state: 'sent', last_error: null },
    ]);
  } finally { await t.close(); }
});

test('dwoje opiekunów, hard_bounce kontaktu głównego: nowa migawka wybiera drugiego opiekuna ze zgodą; bez zgody — rodzina wykluczona (suppressed)', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', { guardians: [{ primary: true }, {}] });
    await family(t.db, 'h2', { guardians: [{ primary: true }, { allowed: false }] });
    for (const target of ['h1', 'h2']) {
      await t.db.query("INSERT INTO email_suppressions (id, email_hash, reason) VALUES ($1, $2, 'hard_bounce')",
        [crypto.randomUUID(), emailHash(`${target}-g1@example.invalid`)]);
    }
    const { campaign, snapshot } = await draftWithSnapshot(t);
    assert.equal(snapshot.recipientsCount, 1);
    assert.deepEqual(snapshot.exclusions, { suppressed: 1 });
    const { rows } = await t.db.query('SELECT household_id, guardian_id FROM email_campaign_recipients WHERE campaign_id = $1', [campaign.id]);
    assert.deepEqual(rows, [{ household_id: 'h1', guardian_id: 'h1-g2' }]);
  } finally { await t.close(); }
});

test('no test in this file touched the network', () => {
  assert.equal(networkGuardCalls(), 0);
});
