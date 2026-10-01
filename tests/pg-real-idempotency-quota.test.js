// Testy współbieżności na PRAWDZIWYM PostgreSQL (#6, #84): dwa brakujące
// wyścigi, których PGlite nie odtworzy (transakcje idą tam po kolei).
//
//  * #6: dwa przypisania DWÓCH RÓŻNYCH wpłat pod tym samym `Idempotency-Key`.
//    Zwycięzca zapisuje przypisanie, przegrany czeka na unikalny klucz, dostaje
//    23505 i — bo klucz należy do innej wpłaty — 409 `idempotency_conflict`
//    (a nie `payment_already_assigned`); jego wpłata zostaje nieprzypisana.
//  * #84: dwa równoległe przebiegi workera e-mail na przełomie doby konta Brevo
//    (UTC vs strefa konta). Przebieg A trzyma blokadę doradczą limitu
//    (QUOTA_LOCK_ID) po przejęciu wierszy, przebieg B czeka na nią w bazie;
//    dalej A stoi w transporcie, więc przejęte wiadomości są „w locie”, a B musi
//    je policzyć. Razem wychodzi dokładnie tyle, ile wynosi pula doby.
//
// Bariera: tests/helpers/pg-barrier.js; każde żądanie/przebieg ma osobne
// połączenie puli z src/db.js. Plik działa wyłącznie z RD_TEST_PG_URL
// (npm run test:pg-real); bez niej jest pomijany. Wyłącznie dane syntetyczne
// (@example.invalid), transport e-mail to atrapa — nic nie wychodzi do sieci.
//
// Uwaga o zegarze: `now` przebiegu jest wstrzykiwany (przełom doby), ale
// `email_send_ledger.recorded_at` nowych wpisów pochodzi z zegara bazy
// (DEFAULT now(), poza strażnikiem znaczników 0144). Dlatego test nie uruchamia
// trzeciego przebiegu po zakończeniu A — doba konta liczona po `recorded_at`
// widziałaby wtedy rzeczywistą, a nie symulowaną datę. Wpisy „other” zasiewamy
// z jawnym `recorded_at`, jak tests/pg-email-quota.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emailConfig } from '../src/email/brevo.js';
import { QUOTA_LOCK_ID, remainingQuota, runEmailBatch } from '../src/email/worker.js';
import {
  createRealTestDb, seedClass, seedEnrolledHousehold, seedPublishedPrivacyNotice, seedSchoolYear, seedUserSession,
} from './helpers/pg.js';
import {
  barrierEnv, callApi, countRows, settledWithin, waitForLockWaitersWithQuery,
} from './helpers/pg-barrier.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
let seq = 0;
const key = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;

async function withReal(fn) {
  const db = await createRealTestDb();
  try { return await fn(db); } finally { await db.close(); }
}

// ------------------------------------------------------------------ #6

test('#6 (bariera): ten sam klucz idempotencji, dwie różne wpłaty — jedno 201, drugie 409 idempotency_conflict, przegrana wpłata zostaje nieprzypisana', { skip }, async () => {
  await withReal(async (db) => {
    await seedSchoolYear(db, YEAR);
    for (const household of ['h1', 'h2']) await seedEnrolledHousehold(db, household, [YEAR]);
    const cookie = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    const body = (reference) => ({
      schoolYearId: YEAR, householdId: null, amountCents: 5000, receivedOn: '2026-10-05', method: 'bank', reference,
    });
    const p1 = (await callApi({ db }, 'POST', '/api/payments', cookie, body('Wpłata syntetyczna 1'), key('pay'))).body.payment;
    const p2 = (await callApi({ db }, 'POST', '/api/payments', cookie, body('Wpłata syntetyczna 2'), key('pay'))).body.payment;
    assert.notEqual(p1.id, p2.id);
    const sharedKey = key('asg');
    const errors = [];
    const gated = barrierEnv(db, { pauseAfter: /INSERT INTO payment_assignments/, errors });
    const first = callApi(gated.env, 'POST', `/api/payments/${p1.id}/assignment`, cookie, { householdId: 'h1' }, sharedKey);
    await gated.reached;
    const second = callApi(barrierEnv(db, { errors }).env, 'POST', `/api/payments/${p2.id}/assignment`, cookie, { householdId: 'h2' }, sharedKey);
    let waiters;
    try { waiters = await waitForLockWaitersWithQuery(db, 1); } finally { gated.release(); }
    const [a, b] = await Promise.all([first, second]);

    // Przegrany nie jest wstrzymany blokadą wpłaty (inny wiersz), tylko czeka na
    // unikalny klucz idempotencji niezatwierdzonego przypisania zwycięzcy.
    assert.deepEqual(waiters.map((w) => w.event), ['transactionid']);
    assert.match(waiters[0].query, /INSERT INTO payment_assignments/);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([b.status, b.body.error], [409, 'idempotency_conflict'], JSON.stringify(b.body));
    assert.equal(b.replayed, null, 'konflikt nie jest odtworzeniem');
    assert.deepEqual(errors, ['23505'], 'wykonana gałąź isUniqueError → idempotency_conflict (payments.js)');

    const rows = (await db.query('SELECT id, household_id, status FROM payment_entries WHERE id = ANY($1) ORDER BY id', [[p1.id, p2.id]])).rows;
    assert.equal(rows.length, 2);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.deepEqual([byId[p1.id].household_id, byId[p1.id].status], ['h1', 'recorded']);
    assert.deepEqual([byId[p2.id].household_id, byId[p2.id].status], [null, 'unmatched'], 'przegrana wpłata nadal czeka na przypisanie');
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM payment_assignments'), 1);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'payment.assigned'"), 1);

    // Ponowienie przegranego żądania z tym samym kluczem nadal jest konfliktem
    // (nie przypisuje wpłaty), a ponowienie zwycięzcy odtwarza zapis.
    const retryLoser = await callApi({ db }, 'POST', `/api/payments/${p2.id}/assignment`, cookie, { householdId: 'h2' }, sharedKey);
    assert.deepEqual([retryLoser.status, retryLoser.body.error], [409, 'idempotency_conflict']);
    const retryWinner = await callApi({ db }, 'POST', `/api/payments/${p1.id}/assignment`, cookie, { householdId: 'h1' }, sharedKey);
    assert.deepEqual([retryWinner.status, retryWinner.replayed, retryWinner.body.assignment.id], [200, 'true', a.body.assignment.id]);
    assert.equal(await countRows(db, 'SELECT count(*)::int AS n FROM payment_assignments'), 1);
    assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'payment.assigned'"), 1);
  });
});

// ------------------------------------------------------------------ #84

const DAILY_LIMIT = 10;
const FAMILIES = 20;
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';
// Lato 2027 (CEST = UTC+2) w obrębie roku szkolnego z seedSchoolYear; doba konta
// w Brukseli zaczyna się o 22:00 UTC poprzedniego dnia kalendarzowego.
const SEEDS_BEFORE_MIDNIGHT = [
  { id: 'q1', day: '2027-08-10', count: 4, at: '2027-08-10T20:00:00Z' }, // doba UTC 10 i doba konta 10
  { id: 'q2', day: '2027-08-10', count: 3, at: '2027-08-10T22:10:00Z' }, // doba UTC 10, ale doba konta już 11
];
const CASES = [
  {
    name: '22:30 UTC = 00:30 w Brukseli: doba UTC 10 sierpnia (zużyte 7), doba konta 11 sierpnia (zużyte 3) — pula z większego zużycia',
    now: '2027-08-10T22:30:00Z', timezone: 'Europe/Brussels', seeds: SEEDS_BEFORE_MIDNIGHT, utcUsed: 7, accountUsed: 3, pool: 3,
  },
  {
    name: '01:00 UTC 11 sierpnia: doba UTC zużyła 1, doba konta 4 (wpis z 22:10 UTC) — pula z doby konta',
    now: '2027-08-11T01:00:00Z', timezone: 'Europe/Brussels',
    seeds: [...SEEDS_BEFORE_MIDNIGHT, { id: 'q3', day: '2027-08-11', count: 1, at: '2027-08-11T00:30:00Z' }],
    utcUsed: 1, accountUsed: 4, pool: 6,
  },
  {
    name: 'kontrola: te same wpisy, konto w UTC — doba konta = doba UTC, pula większa (bez okna Brukseli)',
    now: '2027-08-11T01:00:00Z', timezone: 'UTC',
    seeds: [...SEEDS_BEFORE_MIDNIGHT, { id: 'q3', day: '2027-08-11', count: 1, at: '2027-08-11T00:30:00Z' }],
    utcUsed: 1, accountUsed: 1, pool: 9,
  },
];

async function quotaSetup(db, envExtra) {
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    board: await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
  };
  for (let i = 1; i <= FAMILIES; i += 1) {
    const h = `h${String(i).padStart(2, '0')}`;
    await db.query('INSERT INTO households (id) VALUES ($1)', [h]);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [`${h}-s`, h]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${h}`, `${h}-s`, 'c1', YEAR]);
    await db.query("INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true)", [`${h}-g`, h, `${h}-g@example.invalid`]);
    await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, true)', [`${h}-s`, `${h}-g`]);
  }
  const base = {
    APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid', BREVO_WEBHOOK_SECRET: 'w'.repeat(48),
    EMAIL_DAILY_LIMIT: String(DAILY_LIMIT), EMAIL_CAMPAIGN_MIN_DAILY: '100', ...envExtra,
  };
  const env = { ...base, db };
  const call = (method, path, cookie, body) => callApi(env, method, path, cookie, body, method === 'POST' ? key('idem') : null);
  const draft = await call('POST', '/api/email/campaigns', cookies.treasurer,
    { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const campaignId = draft.body.campaign.id;
  assert.equal((await call('POST', `/api/email/campaigns/${campaignId}/snapshot`, cookies.treasurer)).status, 200);
  const preview = await call('GET', `/api/email/campaigns/${campaignId}/preview`, cookies.board);
  const approved = await call('POST', `/api/email/campaigns/${campaignId}/approve`, cookies.board,
    { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await call('POST', `/api/email/campaigns/${campaignId}/queue`, cookies.treasurer)).status, 200);
  return { base, campaignId };
}

for (const scenario of CASES) {
  test(`#84 (bariera): dwa równoległe przebiegi workera na przełomie doby konta — ${scenario.name}`, { skip }, async () => {
    await withReal(async (db) => {
      const now = new Date(scenario.now);
      const { base, campaignId } = await quotaSetup(db, { EMAIL_QUOTA_TIMEZONE: scenario.timezone });
      for (const seed of scenario.seeds) {
        await db.query(
          `INSERT INTO email_send_ledger (id, day, source, message_count, recorded_at) VALUES ($1, $2, 'other', $3, $4)`,
          [seed.id, seed.day, seed.count, seed.at],
        );
      }
      const config = emailConfig(base);
      assert.equal(config.quotaTimezone, scenario.timezone);
      assert.equal(config.dailyLimit, DAILY_LIMIT);
      // Oczekiwana pula wynika z większego z dwóch zużyć (doba UTC / doba konta).
      assert.equal(DAILY_LIMIT - Math.max(scenario.utcUsed, scenario.accountUsed), scenario.pool);
      assert.equal(await remainingQuota(db, now, config), scenario.pool);
      assert.ok(scenario.pool > 0 && scenario.pool < FAMILIES, 'pula jest niepusta i mniejsza niż kolejka');

      let releaseSend;
      const sendGate = new Promise((resolve) => { releaseSend = resolve; });
      const transportA = { name: 'fake-a', calls: [], async send(message) { this.calls.push(message.outboxId); await sendGate; return { messageId: `fake-a-${this.calls.length}` }; } };
      const transportB = { name: 'fake-b', calls: [], async send(message) { this.calls.push(message.outboxId); return { messageId: `fake-b-${this.calls.length}` }; } };

      // A: przejmuje wiersze (UPDATE … 'sending') i stoi w transakcji z blokadą limitu.
      const gated = barrierEnv(db, { pauseAfter: /UPDATE email_outbox SET state = 'sending'/, extra: base });
      const runA = runEmailBatch(gated.env, { transport: transportA, dryRun: false, now, config });
      await gated.reached;
      const runB = runEmailBatch(barrierEnv(db, { extra: base }).env, { transport: transportB, dryRun: false, now, config });
      let waiters;
      try { waiters = await waitForLockWaitersWithQuery(db, 1); } finally { gated.release(); }
      assert.deepEqual(waiters.map((w) => w.event), ['advisory'], 'B czeka na blokadę doradczą limitu');
      assert.match(waiters[0].query, /pg_advisory_xact_lock/);
      assert.equal(Number((await db.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted", [QUOTA_LOCK_ID],
      )).rows[0].n), 1, 'blokadę limitu trzyma dokładnie jeden przebieg');

      // A zatwierdził przejęcie i stoi w transporcie (wiadomości w locie bez wpisu
      // w dzienniku); B musi je policzyć i nic nie przejąć.
      assert.equal(await settledWithin(runB, 8000), 'settled', 'B kończy się, gdy A stoi w transporcie');
      const resultB = await runB;
      assert.equal(resultB.sent, 0);
      assert.equal(resultB.planned, 0);
      assert.equal(resultB.stoppedReason, 'daily_quota_reached');
      assert.equal(transportB.calls.length, 0);
      assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM email_outbox WHERE state = 'sending'"), scenario.pool);

      releaseSend();
      const resultA = await runA;
      assert.equal(resultA.sent, scenario.pool);
      assert.equal(transportA.calls.length, scenario.pool);
      assert.equal(new Set(transportA.calls).size, scenario.pool, 'żadna wiadomość nie wyszła dwa razy');

      const states = (await db.query('SELECT state, count(*)::int AS n FROM email_outbox WHERE campaign_id = $1 GROUP BY state ORDER BY state', [campaignId])).rows;
      assert.deepEqual(states.map((r) => [r.state, r.n]), [['queued', FAMILIES - scenario.pool], ['sent', scenario.pool]]);
      const day = scenario.now.slice(0, 10);
      assert.equal(await countRows(db, "SELECT COALESCE(SUM(message_count), 0)::int AS n FROM email_send_ledger WHERE source = 'campaign' AND day = $1", [day]), scenario.pool);
      assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM email_send_ledger WHERE source = 'campaign'"), scenario.pool, 'jeden wpis na wysłaną wiadomość');
      // Licznik doby: poprzednie zużycie + wysłane wypełnia dokładnie limit, nie więcej.
      assert.equal(Math.max(scenario.utcUsed, scenario.accountUsed) + resultA.sent + resultB.sent, DAILY_LIMIT);
      assert.equal(await countRows(db, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'email.sent'"), scenario.pool);
    });
  });
}
