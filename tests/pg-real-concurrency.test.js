// Współbieżność na PRAWDZIWYM PostgreSQL (#208, #93, #210). PGlite wykonuje
// transakcje po kolei, więc "równoległe" testy na nim sprawdzają tylko wynik
// końcowy; tu zapytania idą osobnymi połączeniami puli z src/db.js. Plik działa
// wyłącznie z RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Wyłącznie dane syntetyczne, żadnej sieci: transport e-mail jest fałszywy.
//
// Dowód blokady (bariera): pierwsze żądanie jest wstrzymywane W TRANSAKCJI po
// zapisie, a przed COMMIT (gatedEnv). Drugie żądanie musi wtedy CZEKAĆ na blokadę
// (pg_stat_activity: wait_event_type = 'Lock'); dopiero po zatwierdzeniu pierwszego
// widzi jego wynik. Bez blokady drugie żądanie nie czekałoby i wynik byłby zły,
// czego test na PGlite (transakcje po kolei) nie wykryje. Zwykłe Promise.all
// przeplata się zbyt rzadko (okno wyścigu to mikrosekundy), więc samo nie wystarcza.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { handlePgRequest } from '../src/pg/app.js';
import { createMeeting, createResolution, determineQuorum, recordAttendance } from '../src/pg/meetings.js';
import { runEmailBatch } from '../src/email/worker.js';
import { hashPassword } from '../src/pg/password.js';
import { LOGIN_POLICY } from '../src/pg/login.js';
import { createRealTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';
import { updateMeeting } from './helpers/with-revision.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const YEAR = 'y-2026';
let seq = 0;
const key = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`;

// Baza z licznikiem błędów 23505 wracających z transakcji: dowód, że gałąź
// „isUniqueError → odtwórz zapis” (prawdziwe podwójne kliknięcie) się wykonała.
function countingEnv(db, extra = {}) {
  const state = { unique: 0, retries: 0 };
  return {
    state,
    env: {
      ...extra,
      db: {
        query: (...a) => db.query(...a),
        probe: (...a) => db.probe(...a),
        transaction: async (fn, options) => {
          try { return await db.transaction(fn, options); } catch (error) {
            if (error?.code === '23505') state.unique += 1;
            throw error;
          }
        },
      },
    },
  };
}

function api(env) {
  return async (method, path, cookie, body, idempotencyKey) => {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, body: data, replayed: response.headers.get('Idempotency-Replayed') };
  };
}

// Pierwsza transakcja, w której wykonano zapytanie pasujące do `match`, jest
// wstrzymywana po zakończeniu funkcji (zapis wykonany), przed COMMIT, aż do release().
function gatedEnv(db, match, extra = {}) {
  let armed = true;
  let reach;
  let open;
  const reached = new Promise((resolve) => { reach = resolve; });
  const gate = new Promise((resolve) => { open = resolve; });
  const env = {
    ...extra,
    db: {
      query: (...a) => db.query(...a),
      probe: (...a) => db.probe(...a),
      transaction: (fn, options) => db.transaction(async (tx) => {
        let hit = false;
        const result = await fn({ query: (sql, params) => { if (match.test(String(sql))) hit = true; return tx.query(sql, params); } });
        if (hit && armed) { armed = false; reach(); await gate; }
        return result;
      }, options),
    },
  };
  return { env, reached, release: () => open() };
}

// Czeka, aż w bazie pojawi się połączenie aplikacji zablokowane na blokadzie.
async function waitForLockWaiter(db, { timeoutMs = 2500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    );
    if (rows[0].n > 0) return true;
    await sleep(15);
  }
  return false;
}

async function withReal(fn) {
  const db = await createRealTestDb();
  try { return await fn(db); } finally { await db.close(); }
}

// ---------------------------------------------------------------- wpłaty

async function paymentsSetup(db) {
  await seedSchoolYear(db, YEAR);
  await db.query("INSERT INTO households (id) VALUES ('h1'), ('h2')");
  const cookie = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  return cookie;
}
const paymentBody = (patch = {}) => ({
  schoolYearId: YEAR, householdId: 'h1', amountCents: 5000, receivedOn: '2026-10-05', method: 'bank', reference: 'Składka syntetyczna', ...patch,
});
const count = async (db, table, where = 'true') => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n);

test('#208: podwójne kliknięcie zapisu wpłaty na prawdziwym PostgreSQL — jedna wpłata, jedno zdarzenie, drugie żądanie to odtworzenie', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await paymentsSetup(db);
    const { env, state } = countingEnv(db);
    const call = api(env);
    let rounds = 0;
    // Wyścig dwóch transakcji o ten sam klucz: przegrywająca dostaje 23505 i odtwarza zapis.
    // Powtarzamy, aż gałąź 23505 zostanie faktycznie wykonana (co najwyżej 60 rund).
    while (state.unique === 0 && rounds < 60) {
      rounds += 1;
      const idem = key('dbl');
      const results = await Promise.all([1, 2].map(() => call('POST', '/api/payments', cookie, paymentBody({ reference: `Runda ${rounds}` }), idem)));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 201], `runda ${rounds}: ${JSON.stringify(results.map((r) => [r.status, r.body]))}`);
      assert.deepEqual(results.map((r) => r.replayed).sort(), ['false', 'true']);
      assert.equal(results[0].body.payment.id, results[1].body.payment.id);
    }
    assert.ok(state.unique > 0, 'gałąź 23505 → odtworzenie zapisu została wykonana');
    assert.equal(await count(db, 'payment_entries'), rounds);
    assert.equal(await count(db, 'audit_events', "action = 'payment.created'"), rounds);
  });
});

test('#208: dwoje opiekunów tej samej rodziny wpłaca równolegle — dwa wpisy i poprawna suma netto', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await paymentsSetup(db);
    const call = api(countingEnv(db).env);
    const results = await Promise.all([[3000, 'Opiekun A'], [4500, 'Opiekun B']].map(([amountCents, reference]) =>
      call('POST', '/api/payments', cookie, paymentBody({ amountCents, reference }), key('two'))));
    assert.deepEqual(results.map((r) => r.status), [201, 201]);
    const total = (await db.query("SELECT net_amount_cents FROM household_payment_totals WHERE household_id = 'h1' AND school_year_id = $1", [YEAR])).rows[0];
    assert.equal(Number(total.net_amount_cents), 7500);
    assert.equal(await count(db, 'payment_entries'), 2);
  });
});

test('#208 (bariera): druga korekta czeka na blokadę wpłaty, aż pierwsza się zatwierdzi, i widzi jej kwotę', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await paymentsSetup(db);
    const payment = (await api({ db })('POST', '/api/payments', cookie, paymentBody({ amountCents: 10000 }), key('pay'))).body.payment;
    const gated = gatedEnv(db, /INSERT INTO payment_corrections/);
    const first = api(gated.env)('POST', `/api/payments/${payment.id}/corrections`, cookie, { amountCents: 7000, reason: 'Pierwsza korekta' }, key('corr'));
    await gated.reached;
    let settled = false;
    const second = api({ db })('POST', `/api/payments/${payment.id}/corrections`, cookie, { amountCents: 7000, reason: 'Druga korekta' }, key('corr'))
      .then((r) => { settled = true; return r; });
    try {
      assert.equal(await waitForLockWaiter(db), true, 'druga korekta czeka na blokadę wpłaty');
      assert.equal(settled, false);
    } finally { gated.release(); }
    assert.equal((await first).status, 201);
    const result = await second;
    assert.deepEqual([result.status, result.body.error], [409, 'correction_exceeds_remaining_amount']);
    assert.equal(await count(db, 'payment_corrections'), 1);
  });
});

test('#208: trzy równoległe korekty 40/40/40 € wpłaty 100 € — dokładnie jedna odmowa (na prawdziwym PostgreSQL)', { skip }, async () => {
  await withReal(async (db) => {
    const cookie = await paymentsSetup(db);
    const call = api(countingEnv(db).env);
    const payment = (await call('POST', '/api/payments', cookie, paymentBody({ amountCents: 10000 }), key('pay'))).body.payment;
    const results = await Promise.all([1, 2, 3].map((n) => call('POST', `/api/payments/${payment.id}/corrections`, cookie, { amountCents: 4000, reason: `Korekta ${n}` }, key('corr'))));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 409]);
    assert.equal(results.find((r) => r.status === 409).body.error, 'correction_exceeds_remaining_amount');
    assert.equal(Number((await db.query('SELECT net_amount_cents FROM payment_entry_net WHERE id = $1', [payment.id])).rows[0].net_amount_cents), 2000);
    assert.equal(await count(db, 'audit_events', "action = 'payment.correction.created'"), 2);
  });
});

// ---------------------------------------------------------------- uchwała i wydatki (#93)

const admin = { userId: 'u-meet-admin', grants: [{ role: 'admin', classId: null, schoolYearId: null }], mfaVerified: true };

async function ledgerSetup(db) {
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR });
  await seedUser(db, { userId: admin.userId });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    board: await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
  };
  await db.query("INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES ('cat-exp', $1, 'expense', 'Wydarzenia', 'u-treasurer')", [YEAR]);
  const { meeting } = await createMeeting(db, admin, {
    idempotencyKey: key('meeting'), schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie syntetyczne',
    scheduledAt: '2026-10-01T17:00:00Z', status: 'scheduled', quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Założenie testowe',
  });
  await updateMeeting(db, admin, { meetingId: meeting.id, status: 'held' });
  await recordAttendance(db, admin, { meetingId: meeting.id, userId: admin.userId, capacity: 'board_member', votingEligible: true, present: true });
  const { quorumCheck } = await determineQuorum(db, admin, { idempotencyKey: key('quorum'), meetingId: meeting.id });
  const { resolution } = await createResolution(db, admin, {
    idempotencyKey: key('res'), meetingId: meeting.id, title: 'Uchwała syntetyczna', body: 'Treść syntetyczna uchwały',
    status: 'adopted', number: 'U-1/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
  });
  return { cookies, resolution };
}
const expenseBody = (patch = {}) => ({
  schoolYearId: YEAR, direction: 'expense', amountCents: 25000, categoryId: 'cat-exp', description: 'Syntetyczny wydatek',
  occurredOn: '2026-10-05', method: 'bank', ...patch,
});

test('#93: dwa równoległe wydatki przekraczające razem limit uchwały — jeden 201, drugi 409 resolution_amount_exceeded', { skip }, async () => {
  await withReal(async (db) => {
    const call = api(countingEnv(db).env);
    const { cookies, resolution } = await ledgerSetup(db);
    assert.equal((await call('POST', `/api/ledger/resolutions/${resolution.id}/authorizations`, cookies.board,
      { authorizedAmountCents: 70000, note: 'Kwota z uchwały syntetycznej' }, key('auth'))).status, 201);
    // Dwa wydatki po 400,00 EUR przy limicie 700,00 EUR razem go przekraczają.
    const results = await Promise.all([1, 2].map(() => call('POST', '/api/ledger', cookies.treasurer,
      expenseBody({ amountCents: 40000, resolutionId: resolution.id }), key('entry'))));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], JSON.stringify(results.map((r) => [r.status, r.body])));
    assert.equal(results.find((r) => r.status === 409).body.error, 'resolution_amount_exceeded');
    const spent = (await db.query('SELECT spent_net_cents, remaining_cents FROM resolution_spending WHERE resolution_id = $1', [resolution.id])).rows[0];
    assert.deepEqual([Number(spent.spent_net_cents), Number(spent.remaining_cents)], [40000, 30000]);
    assert.equal(await count(db, 'ledger_entries', "resolution_id IS NOT NULL"), 1);
    assert.equal(await count(db, 'audit_events', "action = 'ledger.entry.created'"), 1);
  });
});

test('#93: pięć równoległych wydatków po 20 000 przy limicie 50 000 — dokładnie dwa przechodzą, suma nie przekracza limitu', { skip }, async () => {
  await withReal(async (db) => {
    const call = api(countingEnv(db).env);
    const { cookies, resolution } = await ledgerSetup(db);
    assert.equal((await call('POST', `/api/ledger/resolutions/${resolution.id}/authorizations`, cookies.board,
      { authorizedAmountCents: 50000, note: 'Kwota z uchwały syntetycznej' }, key('auth'))).status, 201);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', '/api/ledger', cookies.treasurer,
      expenseBody({ amountCents: 20000, resolutionId: resolution.id }), key('entry'))));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 201, 409, 409, 409], JSON.stringify(results.map((r) => [r.status, r.body])));
    const spent = (await db.query('SELECT spent_net_cents FROM resolution_spending WHERE resolution_id = $1', [resolution.id])).rows[0];
    assert.equal(Number(spent.spent_net_cents), 40000);
  });
});

test('#93: podwójne kliknięcie tego samego wydatku (ten sam klucz) przy limicie uchwały — jeden wpis, drugie żądanie to odtworzenie', { skip }, async () => {
  await withReal(async (db) => {
    const { env, state } = countingEnv(db);
    const call = api(env);
    const { cookies, resolution } = await ledgerSetup(db);
    assert.equal((await call('POST', `/api/ledger/resolutions/${resolution.id}/authorizations`, cookies.board,
      { authorizedAmountCents: 1_000_000, note: 'Kwota z uchwały syntetycznej' }, key('auth'))).status, 201);
    let rounds = 0;
    while (state.unique === 0 && rounds < 60) {
      rounds += 1;
      const idem = key('dbl');
      const results = await Promise.all([1, 2].map(() => call('POST', '/api/ledger', cookies.treasurer,
        expenseBody({ amountCents: 1000, resolutionId: resolution.id, description: `Runda ${rounds}` }), idem)));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 201], `runda ${rounds}: ${JSON.stringify(results.map((r) => [r.status, r.body]))}`);
    }
    assert.ok(state.unique > 0, 'gałąź 23505 → odtworzenie zapisu została wykonana');
    assert.equal(await count(db, 'ledger_entries'), rounds);
    assert.equal(await count(db, 'audit_events', "action = 'ledger.entry.created'"), rounds);
  });
});

test('#93 (bariera): drugi wydatek czeka na blokadę uchwały, aż pierwszy się zatwierdzi, i widzi jego kwotę', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, resolution } = await ledgerSetup(db);
    assert.equal((await api({ db })('POST', `/api/ledger/resolutions/${resolution.id}/authorizations`, cookies.board,
      { authorizedAmountCents: 70000, note: 'Kwota z uchwały syntetycznej' }, key('auth'))).status, 201);
    const gated = gatedEnv(db, /INSERT INTO ledger_entries/);
    const first = api(gated.env)('POST', '/api/ledger', cookies.treasurer, expenseBody({ amountCents: 40000, resolutionId: resolution.id }), key('entry'));
    await gated.reached;
    let settled = false;
    const second = api({ db })('POST', '/api/ledger', cookies.treasurer, expenseBody({ amountCents: 40000, resolutionId: resolution.id }), key('entry'))
      .then((r) => { settled = true; return r; });
    try {
      assert.equal(await waitForLockWaiter(db), true, 'drugi wydatek czeka na blokadę uchwały');
      assert.equal(settled, false);
    } finally { gated.release(); }
    assert.equal((await first).status, 201);
    const result = await second;
    assert.deepEqual([result.status, result.body.error], [409, 'resolution_amount_exceeded']);
    assert.equal(await count(db, 'ledger_entries', 'resolution_id IS NOT NULL'), 1);
  });
});

// ---------------------------------------------------------------- e-mail (#210)

const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';
const DAY1 = new Date('2026-10-05T08:00:00Z');

async function emailSetup(db, families) {
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    board: await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    board2: await seedUserSession(db, { userId: 'u-bd2', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
  };
  for (let i = 1; i <= families; i += 1) {
    const h = `h${i}`;
    await db.query('INSERT INTO households (id) VALUES ($1)', [h]);
    await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [`${h}-s`, h]);
    await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${h}`, `${h}-s`, 'c1', YEAR]);
    await db.query("INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true)", [`${h}-g`, h, `${h}-g@example.invalid`]);
    await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, false)', [`${h}-s`, `${h}-g`]);
  }
  const env = {
    APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid', BREVO_WEBHOOK_SECRET: 'w'.repeat(48), db,
  };
  return { cookies, env };
}

// Kampania w stanie „w kolejce” (szkic → migawka → zatwierdzenie zarządu → kolejka).
async function queuedCampaign(call, cookies) {
  const draft = await call('POST', '/api/email/campaigns', cookies.treasurer,
    { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY }, crypto.randomUUID());
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const id = draft.body.campaign.id;
  assert.equal((await call('POST', `/api/email/campaigns/${id}/snapshot`, cookies.treasurer)).status, 200);
  const preview = await call('GET', `/api/email/campaigns/${id}/preview`, cookies.board);
  const approved = await call('POST', `/api/email/campaigns/${id}/approve`, cookies.board, { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await call('POST', `/api/email/campaigns/${id}/queue`, cookies.treasurer)).status, 200);
  return id;
}

function recordingTransport(delayMs = 0) {
  const calls = [];
  return {
    calls, name: 'fake',
    async send(message) {
      calls.push({ outboxId: message.outboxId, at: Date.now() });
      if (delayMs) await sleep(delayMs);
      return { messageId: `fake-${calls.length}-${message.outboxId}` };
    },
  };
}

test('#210: dwa równoległe przebiegi kolejki na prawdziwym PostgreSQL — każda wiadomość dokładnie raz', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, env } = await emailSetup(db, 12);
    const call = api(env);
    const campaignId = await queuedCampaign(call, cookies);
    const transports = [recordingTransport(5), recordingTransport(5)];
    await Promise.all(transports.map((transport, i) => runEmailBatch(env, { transport, dryRun: false, now: new Date(DAY1.getTime() + i) })));
    const ids = transports.flatMap((t) => t.calls.map((c) => c.outboxId));
    assert.equal(ids.length, 12, 'łącznie 12 wysyłek');
    assert.equal(new Set(ids).size, 12, 'żadna wiadomość nie wyszła dwa razy');
    const states = (await db.query('SELECT state, count(*)::int AS n FROM email_outbox WHERE campaign_id = $1 GROUP BY state', [campaignId])).rows;
    assert.deepEqual(states.map((r) => [r.state, r.n]), [['sent', 12]]);
    assert.equal(await count(db, 'audit_events', "action = 'email.sent'"), 12);
  });
});

test('#210: anulowanie kampanii równolegle z przebiegiem — każda wiadomość jest wysłana albo anulowana, nigdy obie; po anulowaniu nic nowego nie wychodzi', { skip }, async () => {
  const delays = [0, 8, 20, 45, 80];
  for (const delay of delays) {
    await withReal(async (db) => {
      const { cookies, env } = await emailSetup(db, 10);
      const call = api(env);
      const campaignId = await queuedCampaign(call, cookies);
      const transport = recordingTransport(10);
      const run = runEmailBatch(env, { transport, dryRun: false, now: DAY1 });
      await sleep(delay);
      const cancelledAt = { at: 0 };
      const cancelled = await call('POST', `/api/email/campaigns/${campaignId}/cancel`, cookies.treasurer).then((r) => { cancelledAt.at = Date.now(); return r; });
      await run;
      assert.equal(cancelled.status, 200, `opóźnienie ${delay} ms: ${JSON.stringify(cancelled.body)}`);
      const rows = (await db.query('SELECT id, state FROM email_outbox WHERE campaign_id = $1', [campaignId])).rows;
      const sent = rows.filter((r) => r.state === 'sent');
      const cancelledRows = rows.filter((r) => r.state === 'cancelled');
      assert.equal(sent.length + cancelledRows.length, 10, `opóźnienie ${delay} ms: stany ${rows.map((r) => r.state)}`);
      assert.equal(transport.calls.length, sent.length, 'liczba wywołań transportu = liczba wiadomości „sent”');
      assert.equal(new Set(transport.calls.map((c) => c.outboxId)).size, transport.calls.length);
      // Wysyłka, której przekazanie do transportu zaczęło się już po odpowiedzi „anulowano”, byłaby błędem;
      // odpowiedź zgłasza inFlight tylko dla wiadomości, których przekazanie już trwało.
      const startedAfter = transport.calls.filter((c) => c.at > cancelledAt.at);
      assert.equal(startedAfter.length, 0, `opóźnienie ${delay} ms: po anulowaniu wystartowało ${startedAfter.length} wysyłek (inFlight=${cancelled.body.inFlight})`);
      assert.equal(await count(db, 'audit_events', "action = 'email.campaign.cancelled'"), 1);
      assert.equal(await count(db, 'audit_events', "action = 'email.sent'"), sent.length);
      const ret = recordingTransport();
      await runEmailBatch(env, { transport: ret, dryRun: false, now: new Date(DAY1.getTime() + 60_000) });
      assert.equal(ret.calls.length, 0, 'ponowienie zadania po anulowaniu nie wysyła');
    });
  }
});

test('#210: równoległe anulowanie kampanii przez dwie osoby (podwójne kliknięcie) — jedno zdarzenie, drugie żądanie to odtworzenie', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, env } = await emailSetup(db, 6);
    const call = api(env);
    const campaignId = await queuedCampaign(call, cookies);
    const results = await Promise.all([
      call('POST', `/api/email/campaigns/${campaignId}/cancel`, cookies.treasurer),
      call('POST', `/api/email/campaigns/${campaignId}/cancel`, cookies.board2),
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.deepEqual(results.map((r) => r.replayed).sort(), [null, 'true']);
    assert.equal(results.reduce((sum, r) => sum + r.body.cancelledMessages, 0), 6);
    assert.equal(await count(db, 'audit_events', "action = 'email.campaign.cancelled'"), 1);
    assert.equal(await count(db, 'email_outbox', "state = 'cancelled'"), 6);
  });
});

test('#210 (bariera): drugie anulowanie czeka na blokadę kampanii, a po zatwierdzeniu pierwszego jest odtworzeniem (jedno zdarzenie)', { skip }, async () => {
  await withReal(async (db) => {
    const { cookies, env } = await emailSetup(db, 4);
    const campaignId = await queuedCampaign(api(env), cookies);
    const gated = gatedEnv(db, /UPDATE email_campaigns SET status = 'cancelled'/, env);
    const first = api(gated.env)('POST', `/api/email/campaigns/${campaignId}/cancel`, cookies.treasurer);
    await gated.reached;
    let settled = false;
    const second = api(env)('POST', `/api/email/campaigns/${campaignId}/cancel`, cookies.board2).then((r) => { settled = true; return r; });
    try {
      assert.equal(await waitForLockWaiter(db), true, 'drugie anulowanie czeka na blokadę kampanii');
      assert.equal(settled, false);
    } finally { gated.release(); }
    const [a, b] = [await first, await second];
    assert.deepEqual([a.status, a.replayed, a.body.cancelledMessages], [200, null, 4]);
    assert.deepEqual([b.status, b.replayed, b.body.cancelledMessages], [200, 'true', 0]);
    assert.equal(await count(db, 'audit_events', "action = 'email.campaign.cancelled'"), 1);
  });
});

// ---------------------------------------------------------------- logowanie (znalezione przy #208)

test('#208: udane logowania z jednego adresu zwalniają rezerwację limitu IP (mikrosekundy okna) — bez blokady po 20 sukcesach', { skip }, async () => {
  await withReal(async (db) => {
    const fast = { SCRYPT_COST_LOG2: '15' };
    const env = { db, LOGIN_EMAIL_DELAY_MS: '0', ...fast };
    await seedUser(db, { userId: 'u-login' });
    const password = `Syntetyczne haslo ${crypto.randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO user_passwords (user_id, hash, set_reason) VALUES ('u-login', $1, 'invitation')", [await hashPassword(password, { env: fast })]);
    // Więcej udanych logowań niż próg IP: gdyby zwolnienie rezerwacji nie działało, licznik
    // IP przekroczyłby próg i logowanie dostałoby 429 mimo poprawnego hasła.
    const attempts = LOGIN_POLICY.ipMaxFailures + 3;
    for (let i = 0; i < attempts; i += 1) {
      const response = await handlePgRequest(request('/api/login', {
        method: 'POST', body: { email: 'u-login@example.invalid', password }, headers: { 'x-rd-client-ip': '198.51.100.7' },
      }), env);
      assert.equal(response.status, 200, `logowanie ${i + 1}/${attempts}`);
    }
    const ip = (await db.query("SELECT failure_count, locked_until FROM login_rate_limits WHERE scope_type = 'ip'")).rows[0];
    assert.equal(Number(ip.failure_count), 0, 'rezerwacje zwolnione po sukcesie');
    assert.equal(ip.locked_until, null);
  });
});
