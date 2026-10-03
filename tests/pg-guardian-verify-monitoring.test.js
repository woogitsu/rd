// Monitoring kolejki kodów weryfikacyjnych nowych adresów (#140 pkt 5, migracja 0184):
// `GET /health/jobs` (checkJobsHealth), `GET /api/admin/ops-status` i `GET /api/email/worker-status`.
// Analogicznie do email_outbox, ale wyłącznie liczby, stany i czas najstarszego oczekującego — bez
// adresów, kodów i identyfikatorów wniosków. Wyłącznie dane syntetyczne (@example.invalid);
// żadna wiadomość nie wychodzi: worker dostaje transport-atrapę, a prawdziwy transport Brevo
// odmawia pod `node --test` (src/email/brevo.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { emailConfig } from '../src/email/brevo.js';
import { runEmailBatch } from '../src/email/worker.js';
import { checkJobsHealth } from '../src/pg/jobs-health.js';
import { computeWorkerStatus } from '../src/pg/routes/email.js';
import { guardianVerifyQueueStatus } from '../src/pg/ops-status.js';
import { resolveRuntime } from '../src/server.js';
import { createTestDb, request, seedClass, seedPublishedPrivacyNotice, seedSchoolYear, seedUserSession, ownerDb } from './helpers/pg.js';

const Y = 'y-2026';
const HOUR = 60 * 60_000;
const FLAG = { GUARDIAN_VERIFY_EMAIL_ENABLED: 'true' };
const TEMPLATE = {
  subject: 'Potwierdzenie adresu e-mail dla Rady Rodziców',
  bodyText: 'Twój kod potwierdzający nowy adres to {kod}. Kod jest ważny {waznosc} godzin. Jeśli to nie Ty, zignoruj tę wiadomość.',
};
const WORKER_ENV = {
  APP_ENV: 'test', EMAIL_SENDING_ENABLED: 'true', BREVO_FROM_EMAIL: 'rada@rada.example.invalid',
  EMAIL_TEST_ALLOWLIST: '*@example.invalid', ...FLAG,
};

async function call(env, path, { cookie, body } = {}) {
  const response = await handlePgRequest(request(path, { cookie, method: body ? 'POST' : 'GET', body }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

function fakeTransport() {
  const sent = [];
  return { sent, calls: 0, async send(message) { this.calls += 1; sent.push(message); return { messageId: `fx-${sent.length}` }; } };
}

async function setup(env = FLAG) {
  const db = await createTestDb();
  await seedSchoolYear(db, Y);
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: 'c-1a' });
  const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  const author = await seedUserSession(db, { userId: 'u-board-author', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
  const approver = await seedUserSession(db, { userId: 'u-board-approver', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
  const ctx = { db, env: { db, ...env }, cookies: { admin, author, approver } };
  const created = await call(ctx.env, '/api/admin/guardian-verify-templates', { cookie: author, body: TEMPLATE });
  const approved = await call(ctx.env, `/api/admin/guardian-verify-templates/${created.data.template.id}/approve`, { cookie: approver, body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  return ctx;
}

// Wniosek rodzica z nowym adresem: wiersz kolejki powstaje przez prawdziwą trasę publiczną.
async function submitRequest(ctx, n, email = `nowy${n}@example.invalid`) {
  const { db } = ctx;
  await db.query('INSERT INTO households (id) VALUES ($1)', [`h-${n}`]);
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ($1, $2, 'Anna', 'Testowa', $3, true)`,
    [`g-${n}`, `h-${n}`, `stary${n}@example.invalid`],
  );
  const link = await call(ctx.env, '/api/admin/guardian-links', { cookie: ctx.cookies.admin, body: { guardianId: `g-${n}` } });
  assert.equal(link.status, 201);
  const submitted = await call(ctx.env, '/api/public/guardian-update', { body: { token: link.data.token, email } });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  assert.equal(submitted.data.emailVerification, 'requested');
  return submitted.data.requestId;
}

// Wiek wiersza symulujemy zegarem (`now`) — created_at jest niezmienne, a strażnik nie jest wyłączany.
async function workerRun(db, finishedAt, mode = 'live') {
  await db.query(
    `INSERT INTO email_worker_runs (id, mode, day, started_at, finished_at, remaining_quota, planned, sent, retried, failed)
     VALUES ($1, $2, $3, $4, $4, 100, 0, 0, 0, 0)`,
    [crypto.randomUUID(), mode, finishedAt.toISOString().slice(0, 10), finishedAt.toISOString()],
  );
}

test('stan kolejki kodów: queued, sending i najstarszy oczekujący; bez tabeli null; liczby są liczbami, nie tekstem', async () => {
  const ctx = await setup();
  try {
    assert.deepEqual(await guardianVerifyQueueStatus(ctx.db), { queued: 0, sending: 0, oldestPendingAt: null });
    const first = await submitRequest(ctx, 1);
    await submitRequest(ctx, 2);
    const queued = await guardianVerifyQueueStatus(ctx.db);
    assert.equal(queued.queued, 2);
    assert.equal(typeof queued.queued, 'number');
    assert.equal(queued.sending, 0);
    const oldest = await ctx.db.query('SELECT min(created_at) AS t FROM guardian_update_verifications');
    assert.equal(new Date(queued.oldestPendingAt).getTime(), new Date(oldest.rows[0].t).getTime());
    // Przejęcie jednego wiersza przez przebieg: sending liczy się osobno, najstarszy oczekujący to wciąż `queued`.
    await ctx.db.query(
      "UPDATE guardian_update_verifications SET state = 'sending', claim_token = 'run-1', claimed_at = now() WHERE request_id = $1",
      [first],
    );
    const mixed = await guardianVerifyQueueStatus(ctx.db);
    assert.deepEqual([mixed.queued, mixed.sending], [1, 1]);
    assert.ok(new Date(mixed.oldestPendingAt).getTime() >= new Date(queued.oldestPendingAt).getTime());
    // Wiersze rozstrzygnięte (anulowane przez decyzję zarządu) wychodzą z kolejki.
    await ctx.db.query("UPDATE guardian_update_verifications SET state = 'queued', claim_token = NULL, claimed_at = NULL WHERE request_id = $1", [first]);
    const decided = await call(ctx.env, `/api/admin/guardian-update-requests/${first}/reject`, { cookie: ctx.cookies.approver, body: {} });
    assert.equal(decided.status, 200);
    assert.equal((await guardianVerifyQueueStatus(ctx.db)).queued, 1);
    // Baza sprzed 0184 symulowana DDL-em: połączenie właściciela (SR-05); odczyt stanu nadal rolą aplikacji.
    await ownerDb(ctx.db).query('DROP TABLE guardian_update_verifications CASCADE');
    assert.equal(await guardianVerifyQueueStatus(ctx.db), null, 'brak tabeli (baza sprzed 0184) to null, nie wyjątek');
  } finally {
    await ctx.db.close();
  }
});

test('/health/jobs: czekający kod wymaga świeżego przebiegu workera i mieści się w progu; nazwy progów bez liczb i danych', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query(
      `INSERT INTO backup_runs (id, kind, environment, started_at, finished_at, result, sha256)
       VALUES ('b-1', 'backup', 'test', now(), now(), 'success', repeat('a', 64))`,
    );
    const env = { ...ctx.env, GUARDIAN_VERIFY_EMAIL_ENABLED: 'true' };
    assert.deepEqual(await checkJobsHealth(env), { ok: true, failedThresholds: [] }, 'pusta kolejka kodów nie alarmuje');

    await submitRequest(ctx, 1, 'nowy-monitor@example.invalid');
    const soon = () => new Date(Date.now() + 30 * 60_000);
    // Kod czeka 30 min, a worker nigdy nie działał: sygnał workera, ale nie „za stary”.
    assert.deepEqual((await checkJobsHealth(env, { now: soon })).failedThresholds, ['email_worker_stale']);
    await workerRun(ctx.db, new Date());
    assert.deepEqual(await checkJobsHealth(env, { now: soon }), { ok: true, failedThresholds: [] });

    // 3 h oczekiwania przy domyślnym progu 2 h: worker nadal świeży (próg 6 h), kod za stary.
    const later = () => new Date(Date.now() + 3 * HOUR);
    const late = await checkJobsHealth(env, { now: later });
    assert.deepEqual(late, { ok: false, failedThresholds: ['guardian_verify_queue_too_old'] });
    assert.doesNotMatch(JSON.stringify(late), /@|example\.invalid|\d{8}/, 'tylko nazwy progów — bez adresu, kodu i liczb');
    // Próg jest konfiguracją, nie kodem.
    assert.equal((await checkJobsHealth({ ...env, GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS: '4' }, { now: later })).ok, true);
    assert.equal((await checkJobsHealth({ ...env, GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS: '0.25' }, { now: soon })).ok, false);
    assert.equal((await checkJobsHealth({ ...env, GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS: 'x' }, { now: later })).ok, false, 'zła wartość → domyślny próg');

    // Worker bez przebiegu od 7 h (próg 6 h) i kod w kolejce: dwa progi, jedna nazwa na przyczynę.
    const much = () => new Date(Date.now() + 7 * HOUR);
    assert.deepEqual((await checkJobsHealth(env, { now: much })).failedThresholds, ['email_worker_stale', 'guardian_verify_queue_too_old']);

    // Wyłączona flaga: wiersze czekają celowo, więc brak progów (dotyczy kolejki kodów, nie kampanii).
    const off = { ...ctx.env, GUARDIAN_VERIFY_EMAIL_ENABLED: 'false' };
    assert.deepEqual(await checkJobsHealth(off, { now: much }), { ok: true, failedThresholds: [] });
  } finally {
    await ctx.db.close();
  }
});

test('/health/jobs: po przebiegu workera kod wychodzi (transport-atrapa) i kolejka znika z progów; ponowienie nic nie dopisuje', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query(
      `INSERT INTO backup_runs (id, kind, environment, started_at, finished_at, result, sha256)
       VALUES ('b-1', 'backup', 'test', now(), now(), 'success', repeat('a', 64))`,
    );
    const env = { ...ctx.env, GUARDIAN_VERIFY_EMAIL_ENABLED: 'true' };
    await submitRequest(ctx, 1);
    const transport = fakeTransport();
    const run = await runEmailBatch(ctx.env, {
      dryRun: false, transport, now: new Date(), config: emailConfig({ ...WORKER_ENV }),
    });
    assert.equal(run.sent, 1);
    assert.equal(transport.calls, 1);
    assert.deepEqual(await guardianVerifyQueueStatus(ctx.db), { queued: 0, sending: 0, oldestPendingAt: null });
    const later = () => new Date(Date.now() + 8 * HOUR);
    await workerRun(ctx.db, new Date(Date.now() + 8 * HOUR - 60_000));
    assert.deepEqual(await checkJobsHealth(env, { now: later }), { ok: true, failedThresholds: [] }, 'nic w kolejce — brak progów, także gdy kiedyś czekało');
    await runEmailBatch(ctx.env, { dryRun: false, transport, now: new Date(), config: emailConfig({ ...WORKER_ENV }) });
    assert.equal(transport.calls, 1, 'ponowienie zadania nie wysyła drugiej wiadomości');
  } finally {
    await ctx.db.close();
  }
});

test('GET /api/admin/ops-status: blok guardianVerifyQueue z liczbami, `overdue` tylko przy fladze i po progu; bez adresów i kodów', async () => {
  const ctx = await setup();
  try {
    const empty = await call(ctx.env, '/api/admin/ops-status', { cookie: ctx.cookies.admin });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data.guardianVerifyQueue, { queued: 0, sending: 0, oldestPendingAt: null, overdue: false });
    await submitRequest(ctx, 1, 'nowy-ops@example.invalid');
    const waiting = await call(ctx.env, '/api/admin/ops-status', { cookie: ctx.cookies.admin });
    assert.deepEqual([waiting.data.guardianVerifyQueue.queued, waiting.data.guardianVerifyQueue.sending, waiting.data.guardianVerifyQueue.overdue], [1, 0, false]);
    assert.ok(Date.parse(waiting.data.guardianVerifyQueue.oldestPendingAt) > 0);
    assert.doesNotMatch(JSON.stringify(waiting.data), /nowy-ops|stary1@/, 'bez adresów');
    // Zaległość: zegar +3 h (próg domyślny 2 h) — tylko przy włączonej fladze.
    const { computeOpsStatus } = await import('../src/pg/ops-status.js');
    const overdue = await computeOpsStatus({ db: ctx.db, env: { ...FLAG }, now: () => new Date(Date.now() + 3 * HOUR) });
    assert.equal(overdue.guardianVerifyQueue.overdue, true);
    const disabled = await computeOpsStatus({ db: ctx.db, env: { GUARDIAN_VERIFY_EMAIL_ENABLED: 'false' }, now: () => new Date(Date.now() + 3 * HOUR) });
    assert.equal(disabled.guardianVerifyQueue.overdue, false);
    assert.equal(disabled.guardianVerifyQueue.queued, 1, 'liczby widać także przy wyłączonej fladze');
    // Odmowa dla ról bez uprawnień do panelu administracji nadal obowiązuje.
    assert.equal((await call(ctx.env, '/api/admin/ops-status', { cookie: ctx.cookies.approver })).status, 403);
  } finally {
    await ctx.db.close();
  }
});

test('GET /api/email/worker-status: kolejka kodów (queued/sending, najstarszy), alarm po progu, bez alarmów przy wyłączonej fladze', async () => {
  const ctx = await setup();
  try {
    const path = `/api/email/worker-status?schoolYearId=${Y}`;
    const none = await call(ctx.env, path, { cookie: ctx.cookies.approver });
    assert.equal(none.status, 200, JSON.stringify(none.data));
    assert.deepEqual(none.data.workerStatus.guardianVerifications, { enabled: true, queued: 0, sending: 0, oldestQueuedAt: null });
    assert.deepEqual(none.data.workerStatus.alarms, []);

    await submitRequest(ctx, 1, 'nowy-status@example.invalid');
    const waiting = await call(ctx.env, path, { cookie: ctx.cookies.approver });
    const block = waiting.data.workerStatus.guardianVerifications;
    assert.deepEqual([block.enabled, block.queued, block.sending], [true, 1, 0]);
    assert.ok(Date.parse(block.oldestQueuedAt) > 0);
    assert.deepEqual(waiting.data.workerStatus.alarms, ['worker_never_ran'], 'czekający kod i brak przebiegów — jak kampania');
    assert.doesNotMatch(JSON.stringify(waiting.data), /nowy-status|stary1@/, 'bez adresów');

    // Zegar +3 h, próg alarmu 2 h: przebieg sprzed 2,5 h jest nieświeży, najstarszy kod za stary.
    const now = new Date(Date.now() + 3 * HOUR);
    await workerRun(ctx.db, new Date(now.getTime() - 30 * 60_000));
    const stale = await computeWorkerStatus(ctx.db, { schoolYearId: Y, now, guardianVerify: true });
    assert.deepEqual(stale.alarms, ['guardian_verify_queue_stale']);
    // Wyłączona flaga w procesie serwera: blok pokazuje liczby, ale alarmów nie ma.
    const off = await computeWorkerStatus(ctx.db, { schoolYearId: Y, now, guardianVerify: false });
    assert.deepEqual(off.alarms, []);
    assert.deepEqual([off.guardianVerifications.enabled, off.guardianVerifications.queued], [false, 1]);
    // Role bez dostępu do statusu zadania (administrator techniczny) dostają 403 jak dotąd.
    assert.equal((await call(ctx.env, path, { cookie: ctx.cookies.admin })).status, 403);
  } finally {
    await ctx.db.close();
  }
});

test('serwer HTTP dostaje próg kolejki kodów (bez niego /health/jobs w produkcji zawsze używałby domyślnego), ale nie klucz Brevo', () => {
  const runtime = resolveRuntime({
    DATABASE_URL: 'postgres://synthetic.invalid/rd', GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS: '3', BREVO_API_KEY: 'synthetic-key',
  }, { createDatabase: () => ({ close: async () => {} }), createStorage: () => null });
  assert.equal(runtime.env.GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS, '3');
  assert.equal(runtime.env.BREVO_API_KEY, undefined);
});
