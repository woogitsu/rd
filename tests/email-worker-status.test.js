// Stan zadania wysyłki i alarm „brak przebiegów” dla zarządu/skarbnika (#130):
// GET /api/email/worker-status. Wyłącznie dane syntetyczne (@example.invalid).
// Żaden test nie wysyła poczty: przebiegi to dry-run (bez transportu) albo
// wiersze email_worker_runs wstawione wprost; globalny fetch jest pułapką
// (helpers/pg.js), licznik wywołań sieci na końcu musi wynosić 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { computeWorkerStatus } from '../src/pg/routes/email.js';
import { runEmailBatch } from '../src/email/worker.js';
import { resolveRuntime } from '../src/server.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const YEAR = 'y2026';
const OTHER_YEAR = 'y2025';
const HOUR = 60 * 60_000;
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

async function setup(envExtra = {}) {
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  await seedClass(db, { id: 'c0', schoolYearId: OTHER_YEAR });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const env = {
    db,
    APP_ENV: 'development',
    EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid',
    ...envExtra,
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  return { db, env, treasurer, board, call, close: () => db.close() };
}

async function family(db, householdId, { classId = 'c1', schoolYearId = YEAR } = {}) {
  await db.query('INSERT INTO households (id) VALUES ($1)', [householdId]);
  const studentId = `${householdId}-s1`;
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [studentId, householdId]);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${studentId}`, studentId, classId, schoolYearId]);
  const guardianId = `${householdId}-g1`;
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ($1, $2, 'Opiekun', 'Nazwiskowy', $3, true)`,
    [guardianId, householdId, `${guardianId}@example.invalid`],
  );
  await db.query(
    'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, true)',
    [studentId, guardianId],
  );
}

// Kampania w wysyłce (`sending`) przez API: szkic → migawka → zatwierdzenie
// (inna osoba) → zakolejkowanie. `sendNotBefore` ustawiane w szkicu, przed zatwierdzeniem.
async function sendingCampaign(t, { treasurer = t.treasurer, board = t.board, schoolYearId = YEAR, sendNotBefore } = {}) {
  const created = await t.call(treasurer, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { schoolYearId, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const campaign = created.body.campaign;
  if (sendNotBefore) {
    const revision = (await t.call(board, `/api/email/campaigns/${campaign.id}`)).body.campaign.revisionNo;
    const updated = await t.call(treasurer, `/api/email/campaigns/${campaign.id}`, {
      method: 'PUT',
      body: { revision, title: campaign.title, subject: campaign.subject, bodyText: BODY, audience: 'all_households', sendNotBefore },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
  }
  assert.equal((await t.call(treasurer, `/api/email/campaigns/${campaign.id}/snapshot`, { method: 'POST' })).status, 200);
  const preview = await t.call(board, `/api/email/campaigns/${campaign.id}/preview`);
  const approved = await t.call(board, `/api/email/campaigns/${campaign.id}/approve`, {
    method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const queued = await t.call(treasurer, `/api/email/campaigns/${campaign.id}/queue`, { method: 'POST' });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  return campaign;
}

// Wiersz przebiegu z zadaną chwilą zakończenia (tabela tylko do dopisywania —
// INSERT jest dozwolony; nie ma tu obejścia triggera).
async function insertRun(db, { mode, finishedAt, stoppedReason = null }) {
  await db.query(
    `INSERT INTO email_worker_runs (id, mode, day, started_at, finished_at, remaining_quota, stopped_reason)
     VALUES ($1, $2, $3::date, $4, $4, 0, $5)`,
    [crypto.randomUUID(), mode, finishedAt.toISOString().slice(0, 10), finishedAt.toISOString(), stoppedReason],
  );
}

const statusOf = async (t, cookie = t.board, year = YEAR) => t.call(cookie, `/api/email/worker-status?schoolYearId=${year}`);

test('bez kampanii w wysyłce brak alarmu, także gdy zadanie nigdy nie działało', async () => {
  const t = await setup();
  try {
    const res = await statusOf(t);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(res.body.workerStatus.alarms, []);
    assert.equal(res.body.workerStatus.lastRun, null);
    assert.equal(res.body.workerStatus.lastLiveRun, null);
    assert.deepEqual(res.body.workerStatus.campaigns, { due: 0, scheduled: 0, paused: 0 });
    assert.equal(res.body.workerStatus.alarmAfterHours, 2);
    assert.equal(res.body.workerStatus.sendWindowEnabled, false);
  } finally { await t.close(); }
});

test('kampania w wysyłce: brak przebiegów → worker_never_ran; tylko dry-run → worker_dry_run_only; świeży przebieg wysyłki → brak alarmu', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    const campaign = await sendingCampaign(t);

    const never = (await statusOf(t)).body.workerStatus;
    assert.deepEqual(never.alarms, ['worker_never_ran']);
    assert.equal(never.campaigns.due, 1);

    // Przebieg próbny (tak działa usługa z railway.email-worker.json): zapis
    // przebiegu, kolejka bez zmian, brak transportu.
    const dry = await runEmailBatch(t.env, { dryRun: true });
    assert.equal(dry.mode, 'dry_run');
    const { rows: queued } = await t.db.query("SELECT state FROM email_outbox WHERE campaign_id = $1", [campaign.id]);
    assert.deepEqual(queued.map((r) => r.state), ['queued']);
    const dryOnly = (await statusOf(t, t.treasurer)).body.workerStatus;
    assert.deepEqual(dryOnly.alarms, ['worker_dry_run_only']);
    assert.equal(dryOnly.lastRun.mode, 'dry_run');
    assert.equal(dryOnly.lastLiveRun, null);

    await insertRun(t.db, { mode: 'live', finishedAt: new Date(Date.now() - 30 * 60_000), stoppedReason: 'outside_send_window' });
    const ok = (await statusOf(t)).body.workerStatus;
    assert.deepEqual(ok.alarms, []);
    assert.equal(ok.lastLiveRun.stoppedReason, 'outside_send_window', 'przebieg poza oknem nadal dowodzi, że zadanie działa');
  } finally { await t.close(); }
});

test('ostatni przebieg starszy niż próg → worker_stale; próg z EMAIL_WORKER_ALARM_HOURS', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await sendingCampaign(t);
    await insertRun(t.db, { mode: 'live', finishedAt: new Date(Date.now() - 3 * HOUR) });
    const stale = (await statusOf(t)).body.workerStatus;
    assert.deepEqual(stale.alarms, ['worker_stale']);
    assert.equal(stale.lastRun.mode, 'live');

    t.env.EMAIL_WORKER_ALARM_HOURS = '6';
    const relaxed = (await statusOf(t)).body.workerStatus;
    assert.deepEqual(relaxed.alarms, []);
    assert.equal(relaxed.alarmAfterHours, 6);
    // Niepoprawna wartość → domyślne 2 h (nie „alarm wyłączony”).
    t.env.EMAIL_WORKER_ALARM_HOURS = 'zero';
    assert.deepEqual((await statusOf(t)).body.workerStatus.alarms, ['worker_stale']);
  } finally { await t.close(); }
});

test('wstrzymana kampania i start w przyszłości nie włączają alarmu; kampania innego roku się nie liczy', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await family(t.db, 'h0', { classId: 'c0', schoolYearId: OTHER_YEAR });
    const paused = await sendingCampaign(t);
    const pauseRes = await t.call(t.board, `/api/email/campaigns/${paused.id}/pause`, { method: 'POST' });
    assert.equal(pauseRes.status, 200, JSON.stringify(pauseRes.body));
    const future = new Date(Date.now() + 7 * 24 * HOUR).toISOString();
    await sendingCampaign(t, { sendNotBefore: future });
    const otherTr = await seedUserSession(t.db, { userId: 'u-tr0', mfa: true, roles: [{ role: 'treasurer', schoolYearId: OTHER_YEAR }] });
    const otherBd = await seedUserSession(t.db, { userId: 'u-bd0', mfa: true, roles: [{ role: 'board', schoolYearId: OTHER_YEAR }] });
    await sendingCampaign(t, { treasurer: otherTr, board: otherBd, schoolYearId: OTHER_YEAR });

    const status = (await statusOf(t)).body.workerStatus;
    assert.deepEqual(status.campaigns, { due: 0, scheduled: 1, paused: 1 });
    assert.deepEqual(status.alarms, []);
    // Ten sam stan zadania (brak przebiegów) dla roku, w którym kampania czeka.
    const other = (await statusOf(t, otherBd, OTHER_YEAR)).body.workerStatus;
    assert.deepEqual(other.alarms, ['worker_never_ran']);
    assert.equal(other.campaigns.due, 1);

    // Po nadejściu terminu kampania zaplanowana staje się „czekającą” (zegar wstrzyknięty).
    const later = await computeWorkerStatus(t.db, { schoolYearId: YEAR, now: new Date(Date.now() + 8 * 24 * HOUR) });
    assert.deepEqual(later.campaigns, { due: 1, scheduled: 0, paused: 1 });
    assert.deepEqual(later.alarms, ['worker_never_ran']);
  } finally { await t.close(); }
});

test('odpowiedź: tylko liczby, znaczniki czasu i kody — bez adresów, nazw i identyfikatorów rodzin', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1');
    await sendingCampaign(t);
    await runEmailBatch(t.env, { dryRun: true });
    const text = JSON.stringify((await statusOf(t)).body);
    assert.doesNotMatch(text, /@/);
    assert.doesNotMatch(text, /Nazwiskowy|Testowy|Opiekun|h1-g1|"h1"/);
    assert.doesNotMatch(text, /Przypomnienie jesienne|Dobrowolna składka/);
  } finally { await t.close(); }
});

test('granice ról: zarząd i skarbnik roku z MFA; przedstawiciel, KR, admin, dyrekcja, inny rok, bez MFA — 403; bez sesji — 401', async () => {
  const t = await setup();
  try {
    const rep = await seedUserSession(t.db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] });
    const classTreasurer = await seedUserSession(t.db, { userId: 'u-ctr', mfa: true, roles: [{ role: 'treasurer', classId: 'c1', schoolYearId: YEAR }] });
    const audit = await seedUserSession(t.db, { userId: 'u-kr', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] });
    const admin = await seedUserSession(t.db, { userId: 'u-adm', mfa: true, roles: [{ role: 'admin' }] });
    const principal = await seedUserSession(t.db, { userId: 'u-pr', mfa: true, roles: [{ role: 'principal', schoolYearId: YEAR }] });
    const otherYear = await seedUserSession(t.db, { userId: 'u-oy', mfa: true, roles: [{ role: 'board', schoolYearId: OTHER_YEAR }] });
    const noMfa = await seedUserSession(t.db, { userId: 'u-nomfa', roles: [{ role: 'board', schoolYearId: YEAR }] });

    assert.equal((await statusOf(t, t.board)).status, 200);
    assert.equal((await statusOf(t, t.treasurer)).status, 200);
    assert.equal((await statusOf(t, null)).status, 401);
    for (const cookie of [rep, classTreasurer, audit, admin, principal, otherYear]) {
      const denied = await statusOf(t, cookie);
      assert.deepEqual([denied.status, denied.body], [403, { error: 'forbidden' }]);
    }
    // Zarząd bez MFA: 403 z kodem wymuszającym konfigurację MFA (wspólny kod autoryzacji).
    assert.deepEqual(await statusOf(t, noMfa).then((r) => [r.status, r.body]), [403, { error: 'mfa_enrollment_required' }]);
    assert.deepEqual((await t.call(t.board, '/api/email/worker-status?schoolYearId=')).body, { error: 'invalid_request' });
    const post = await t.call(t.board, `/api/email/worker-status?schoolYearId=${YEAR}`, { method: 'POST', body: {} });
    assert.deepEqual([post.status, post.headers.get('Allow')], [405, 'GET']);
    const { rows } = await t.db.query('SELECT count(*)::int AS n FROM email_worker_runs');
    assert.equal(rows[0].n, 0, 'odczyt stanu nie zapisuje przebiegu');
  } finally { await t.close(); }
});

test('serwer HTTP dostaje okno wysyłki i próg alarmu (podgląd liczy start jak zadanie), ale nie klucz Brevo', () => {
  const runtime = resolveRuntime({
    DATABASE_URL: 'postgres://synthetic.invalid/rd', EMAIL_SEND_WINDOW_ENABLED: 'true', EMAIL_SEND_WINDOW_START: '09:00',
    EMAIL_SEND_WINDOW_END: '18:00', EMAIL_SEND_WINDOW_TIMEZONE: 'Europe/Brussels', EMAIL_SEND_WINDOW_DAYS: '1-5',
    EMAIL_WORKER_ALARM_HOURS: '3', BREVO_API_KEY: 'synthetic-key', EMAIL_SENDING_ENABLED: 'true',
  }, { createDatabase: () => ({ close: async () => {} }), createStorage: () => null });
  assert.equal(runtime.env.EMAIL_SEND_WINDOW_ENABLED, 'true');
  assert.equal(runtime.env.EMAIL_SEND_WINDOW_START, '09:00');
  assert.equal(runtime.env.EMAIL_SEND_WINDOW_END, '18:00');
  assert.equal(runtime.env.EMAIL_SEND_WINDOW_TIMEZONE, 'Europe/Brussels');
  assert.equal(runtime.env.EMAIL_SEND_WINDOW_DAYS, '1-5');
  assert.equal(runtime.env.EMAIL_WORKER_ALARM_HOURS, '3');
  assert.equal(runtime.env.BREVO_API_KEY, undefined);
});

test('żaden test tego pliku nie wywołał sieci', () => {
  assert.equal(networkGuardCalls(), 0);
});
