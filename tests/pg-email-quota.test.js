// Dzienny limit Brevo (#84): GET /api/email/quota i POST /api/email/quota/other-sends.
// Wyłącznie dane syntetyczne (@example.invalid), czas wstrzykiwany (env.now / now),
// brak sieci i żadnej wysyłki do rodziców: transport jest fałszywy, a globalny
// fetch jest pułapką (helpers/pg.js) — licznik wywołań sieci musi wynosić 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { emailConfig } from '../src/email/brevo.js';
import { addDays, quotaOverview, remainingQuota, runEmailBatch } from '../src/email/worker.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedUserSession, seedPublishedPrivacyNotice, assertOwnerGuard } from './helpers/pg.js';

const YEAR = 'y2026';
const NOW = new Date('2026-10-05T10:00:00Z');
const TODAY = '2026-10-05';
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

async function setup(extraEnv = {}, now = NOW) {
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const users = {
    treasurer: await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    board: await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    noMfa: await seedUserSession(db, { userId: 'u-nm', mfa: false, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    classTreasurer: await seedUserSession(db, { userId: 'u-ct', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR, classId: 'c1' }] }),
    classBoard: await seedUserSession(db, { userId: 'u-cb', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR, classId: 'c1' }] }),
    representative: await seedUserSession(db, { userId: 'u-rp', mfa: true, roles: [{ role: 'representative', schoolYearId: YEAR, classId: 'c1' }] }),
    admin: await seedUserSession(db, { userId: 'u-ad', mfa: true, roles: [{ role: 'admin', schoolYearId: YEAR }] }),
    audit: await seedUserSession(db, { userId: 'u-kr', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] }),
  };
  const env = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid', now: () => now, ...extraEnv,
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  let n = 0;
  const post = (cookie, body, key = `quota-key-${n += 1}-xxxxxxxx`) => call(cookie, '/api/email/quota/other-sends', {
    method: 'POST', headers: { 'Idempotency-Key': key }, body: { schoolYearId: YEAR, ...body },
  });
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  return { db, env, users, call, post, count, close: () => db.close() };
}

const entry = (overrides = {}) => ({ day: TODAY, count: 12, reasonCode: 'invitation', ...overrides });

test('#84 role boundaries: only school-wide board/treasurer with MFA; others get 403 and an access.denied event', async () => {
  const t = await setup();
  try {
    const denied = ['representative', 'classTreasurer', 'classBoard', 'admin', 'noMfa'];
    for (const who of denied) {
      const get = await t.call(t.users[who], `/api/email/quota?schoolYearId=${YEAR}`);
      assert.equal(get.status, 403, `GET ${who}`);
      const before = await t.count('SELECT count(*) AS n FROM email_send_ledger');
      const post = await t.post(t.users[who], entry());
      assert.equal(post.status, 403, `POST ${who}`);
      assert.equal(await t.count('SELECT count(*) AS n FROM email_send_ledger'), before, `no write for ${who}`);
    }
    assert.ok(await t.count("SELECT count(*) AS n FROM audit_events WHERE action = 'access.denied'") >= denied.length);
    assert.equal((await t.call(null, `/api/email/quota?schoolYearId=${YEAR}`)).status, 401);
    for (const who of ['treasurer', 'board']) {
      const get = await t.call(t.users[who], `/api/email/quota?schoolYearId=${YEAR}`);
      assert.equal(get.status, 200, `GET ${who}`);
      assert.equal(get.body.quota.dailyLimit, 300);
    }
    assert.equal((await t.post(t.users.treasurer, entry({ count: 1 }))).status, 201);
    assert.equal((await t.post(t.users.board, entry({ count: 2 }))).status, 201);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('#84 other-sends: the same Idempotency-Key writes one row; a different payload under the key is 409', async () => {
  const t = await setup();
  try {
    const key = 'double-click-0001';
    const first = await t.post(t.users.treasurer, entry(), key);
    const [second, third] = await Promise.all([t.post(t.users.treasurer, entry(), key), t.post(t.users.treasurer, entry(), key)]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(third.status, 200);
    assert.equal(second.body.entry.id, first.body.entry.id);
    assert.equal(await t.count("SELECT count(*) AS n FROM email_send_ledger WHERE source = 'other'"), 1);
    assert.equal(await t.count("SELECT count(*) AS n FROM audit_events WHERE action = 'email.quota.other_recorded'"), 1);
    assert.equal((await t.post(t.users.treasurer, entry({ count: 13 }), key)).status, 409);
    assert.equal((await t.post(t.users.board, entry(), key)).status, 409);
    const audit = (await t.db.query("SELECT metadata_json AS metadata FROM audit_events WHERE action = 'email.quota.other_recorded'")).rows[0].metadata;
    assert.deepEqual(Object.keys(audit).sort(), ['correctsId', 'count', 'day', 'reasonCode', 'schoolYearId']);
  } finally { await t.close(); }
});

test('#84 other-sends validation: key, day, count, reason code', async () => {
  const t = await setup();
  try {
    const noKey = await t.call(t.users.treasurer, '/api/email/quota/other-sends', { method: 'POST', body: { schoolYearId: YEAR, ...entry() } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error, 'invalid_idempotency_key');
    const cases = [
      [entry({ day: '2026-10-04' }), 'invalid_quota_day'],
      [entry({ day: '2026-02-30' }), 'invalid_quota_day'],
      [entry({ count: 0 }), 'invalid_quota_count'],
      [entry({ count: -3 }), 'invalid_quota_count'],
      [entry({ count: 10_001 }), 'invalid_quota_count'],
      [entry({ count: 1.5 }), 'invalid_quota_count'],
      [entry({ reasonCode: 'nope' }), 'invalid_quota_reason'],
      [entry({ reasonCode: 'correction', count: 3 }), 'invalid_quota_count'],
    ];
    for (const [body, error] of cases) {
      const res = await t.post(t.users.treasurer, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error, error);
    }
    assert.equal(await t.count('SELECT count(*) AS n FROM email_send_ledger'), 0);
    assert.equal((await t.post(t.users.treasurer, entry({ day: '2026-10-05' }))).status, 201);
  } finally { await t.close(); }
});

test('#84 correction is a new negative row; history is kept; the ledger cannot be edited or deleted', async () => {
  const t = await setup({ EMAIL_DAILY_LIMIT: '100' });
  try {
    const config = emailConfig({ EMAIL_DAILY_LIMIT: '100' });
    const original = await t.post(t.users.treasurer, entry({ count: 30 }));
    assert.equal(original.status, 201);
    assert.equal(await remainingQuota(t.db, NOW, config), 70);
    const fix = await t.post(t.users.board, { day: TODAY, count: -10, reasonCode: 'correction', correctsId: original.body.entry.id });
    assert.equal(fix.status, 201, JSON.stringify(fix.body));
    assert.equal(fix.body.entry.correctsId, original.body.entry.id);
    assert.equal(await remainingQuota(t.db, NOW, config), 80);
    const { rows } = await t.db.query("SELECT message_count FROM email_send_ledger WHERE source = 'other' ORDER BY message_count");
    assert.deepEqual(rows.map((row) => row.message_count), [-10, 30], 'original row untouched, correction appended');
    assert.equal(await t.count("SELECT count(*) AS n FROM audit_events WHERE action = 'email.quota.other_corrected'"), 1);
    // Korekty razem nie przekroczą wpisu; nieistniejący wpis i cudza doba są odrzucane.
    const tooMuch = await t.post(t.users.board, { day: TODAY, count: -21, reasonCode: 'correction', correctsId: original.body.entry.id });
    assert.equal(tooMuch.status, 409);
    assert.equal(tooMuch.body.error, 'quota_correction_exceeds');
    assert.equal((await t.post(t.users.board, { day: TODAY, count: -1, reasonCode: 'correction', correctsId: 'nie-ma' })).status, 404);
    assert.equal((await t.post(t.users.board, { day: '2026-10-04', count: -1, reasonCode: 'correction', correctsId: original.body.entry.id })).status, 400);
    assert.equal((await t.post(t.users.board, { day: TODAY, count: -1, reasonCode: 'correction', correctsId: fix.body.entry.id })).status, 404);
    assert.equal((await t.post(t.users.board, { day: TODAY, count: -20, reasonCode: 'correction', correctsId: original.body.entry.id })).status, 201);
    assert.equal(await remainingQuota(t.db, NOW, config), 100);
    await assert.rejects(t.db.query("UPDATE email_send_ledger SET message_count = 1 WHERE id = $1", [original.body.entry.id]), /append_only/);
    await assertOwnerGuard(t.db, 'DELETE FROM email_send_ledger WHERE id = $1', /append_only/, [original.body.entry.id]);
  } finally { await t.close(); }
});

test('#84 GET quota: today and tomorrow in UTC and in the account timezone, numbers only', async () => {
  // 23:30 UTC 5 października = 01:30 6 października w Brukseli (CEST).
  const now = new Date('2026-10-05T23:30:00Z');
  const t = await setup({ EMAIL_DAILY_LIMIT: '300', EMAIL_DAILY_RESERVED: '20' }, now);
  try {
    await t.db.query(`INSERT INTO email_send_ledger (id, day, source, message_count, recorded_at) VALUES
      ('l1', '2026-10-05', 'other', 40, '2026-10-05T21:00:00Z'),
      ('l2', '2026-10-05', 'other', 15, '2026-10-05T22:30:00Z')`);
    const res = await t.call(t.users.treasurer, `/api/email/quota?schoolYearId=${YEAR}`);
    assert.equal(res.status, 200);
    const q = res.body.quota;
    assert.equal(q.windows.utc.today.day, '2026-10-05');
    assert.equal(q.windows.utc.today.other, 55);
    assert.equal(q.windows.utc.tomorrow.total, 0);
    assert.equal(q.windows.account.timezone, 'Europe/Brussels');
    assert.equal(q.windows.account.today.day, '2026-10-06');
    assert.equal(q.windows.account.today.total, 15, 'l2 (22:30 UTC = 00:30 CEST) to już doba 6 w Brukseli, l1 jeszcze 5');
    assert.equal(q.windows.account.tomorrow.day, '2026-10-07');
    assert.equal(q.remaining, 300 - 20 - 55, 'ostrożnie: większe z dwóch zużyć');
    assert.deepEqual(q.queuedCampaigns, { campaigns: 0, queuedMessages: 0 });
    assert.equal(await t.count('SELECT count(*) AS n FROM email_outbox'), 0);
    assert.doesNotMatch(JSON.stringify(res.body), /@/);
  } finally { await t.close(); }
});

test('#84 DST transitions: each entry is counted once in its account day, never negatively', async () => {
  const t = await setup({ EMAIL_DAILY_LIMIT: '100' });
  try {
    const config = emailConfig({ EMAIL_DAILY_LIMIT: '100' });
    // Koniec czasu letniego 2026-10-25 (03:00 CEST -> 02:00 CET): doba w Brukseli ma 25 godzin.
    await t.db.query(`INSERT INTO email_send_ledger (id, day, source, message_count, recorded_at) VALUES
      ('a', '2026-10-24', 'other', 10, '2026-10-24T22:30:00Z'),
      ('b', '2026-10-25', 'other', 20, '2026-10-25T12:00:00Z'),
      ('d', '2026-10-25', 'other', 7,  '2026-10-25T23:10:00Z')`);
    const autumn = await quotaOverview(t.db, new Date('2026-10-25T22:00:00Z'), config);
    assert.equal(autumn.windows.account.today.day, '2026-10-25');
    assert.equal(autumn.windows.account.today.total, 30, 'a + b w jednej 25-godzinnej dobie');
    assert.equal(autumn.windows.utc.today.total, 27);
    assert.equal(autumn.windows.account.tomorrow.total, 7);
    assert.equal(autumn.remaining, 70);
    const lateAutumn = await quotaOverview(t.db, new Date('2026-10-25T23:30:00Z'), config);
    assert.equal(lateAutumn.windows.account.today.day, '2026-10-26');
    assert.equal(lateAutumn.windows.account.today.total, 7);
    assert.equal(lateAutumn.remaining, 73);
    // Początek czasu letniego 2026-03-29 (02:00 CET -> 03:00 CEST): doba ma 23 godziny.
    await t.db.query(`INSERT INTO email_send_ledger (id, day, source, message_count, recorded_at) VALUES
      ('e', '2026-03-28', 'other', 5, '2026-03-28T23:30:00Z'),
      ('f', '2026-03-29', 'other', 8, '2026-03-29T21:30:00Z'),
      ('g', '2026-03-29', 'other', 4, '2026-03-29T22:30:00Z')`);
    const spring = await quotaOverview(t.db, new Date('2026-03-29T12:00:00Z'), config);
    assert.equal(spring.windows.account.today.total, 13, 'e + f');
    assert.equal(spring.windows.utc.today.total, 12);
    assert.equal(spring.remaining, 87);
    const lateSpring = await quotaOverview(t.db, new Date('2026-03-29T22:45:00Z'), config);
    assert.equal(lateSpring.windows.account.today.day, '2026-03-30');
    assert.equal(lateSpring.windows.account.today.total, 4);
    assert.equal(lateSpring.remaining, 88);
    for (const view of [autumn, lateAutumn, spring, lateSpring]) {
      assert.ok(view.remaining >= 0 && view.remaining <= 100);
    }
    assert.equal(addDays('2026-10-25', 1), '2026-10-26');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  } finally { await t.close(); }
});

test('#84 GET other-sends: role boundaries (admin, board, treasurer with/without MFA, representative, KR)', async () => {
  const t = await setup();
  try {
    assert.equal((await t.post(t.users.treasurer, entry())).status, 201);
    const path = `/api/email/quota/other-sends?schoolYearId=${YEAR}`;
    for (const who of ['representative', 'classTreasurer', 'classBoard', 'admin', 'audit', 'noMfa']) {
      const res = await t.call(t.users[who], path);
      assert.equal(res.status, 403, `GET ${who}`);
      assert.equal(res.body.entries, undefined, `no data for ${who}`);
    }
    assert.equal((await t.call(null, path)).status, 401);
    assert.equal((await t.call(t.users.treasurer, `/api/email/quota/other-sends`)).status, 400);
    for (const who of ['treasurer', 'board']) {
      const res = await t.call(t.users[who], path);
      assert.equal(res.status, 200, `GET ${who}`);
      assert.equal(res.body.entries.length, 1);
    }
    assert.equal((await t.call(t.users.treasurer, path, { method: 'DELETE' })).status, 405);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('#84 GET other-sends: list with corrections, day filter and cursor; no addresses or message content', async () => {
  const t = await setup();
  try {
    const path = `/api/email/quota/other-sends?schoolYearId=${YEAR}`;
    assert.deepEqual((await t.call(t.users.board, path)).body.entries, []);
    const a = await t.post(t.users.treasurer, entry({ count: 30 }));
    const b = await t.post(t.users.board, entry({ count: 5, reasonCode: 'audit_committee' }));
    const fix = await t.post(t.users.board, { day: TODAY, count: -10, reasonCode: 'correction', correctsId: a.body.entry.id });
    assert.equal(fix.status, 201);
    // Wpis sprzed 0177 (bez aktora) oraz wiersz kampanii nie należą do listy ręcznej.
    await t.db.query(`INSERT INTO email_send_ledger (id, day, source, message_count) VALUES ('legacy', '2026-10-05', 'other', 4)`);
    await t.db.query(`INSERT INTO email_send_ledger (id, day, source, message_count, actor_id, reason_code, idempotency_key, recorded_at)
      VALUES ('old', '2026-10-01', 'other', 1, 'u-tr', 'other', 'old-entry-0001', '2026-10-01T10:00:00Z')`);
    const all = await t.call(t.users.treasurer, path);
    assert.equal(all.status, 200);
    const byId = new Map(all.body.entries.map((e) => [e.id, e]));
    assert.equal(all.body.entries.length, 4);
    assert.ok(!byId.has('legacy'));
    assert.deepEqual(Object.keys(byId.get(a.body.entry.id)).sort(),
      ['correctableCount', 'corrected', 'correctedCount', 'correctsId', 'count', 'day', 'id', 'reasonCode', 'recordedAt', 'recordedBy']);
    assert.deepEqual([byId.get(a.body.entry.id).corrected, byId.get(a.body.entry.id).correctedCount, byId.get(a.body.entry.id).correctableCount], [true, 10, 20]);
    assert.equal(byId.get(b.body.entry.id).corrected, false);
    assert.equal(byId.get(b.body.entry.id).correctableCount, 5);
    assert.equal(byId.get(fix.body.entry.id).correctsId, a.body.entry.id);
    assert.equal(byId.get(fix.body.entry.id).correctableCount, 0);
    assert.equal(byId.get(fix.body.entry.id).recordedBy, 'u-bd');
    assert.doesNotMatch(JSON.stringify(all.body), /@/);
    // Filtr doby.
    const day = await t.call(t.users.treasurer, `${path}&day=2026-10-01`);
    assert.deepEqual(day.body.entries.map((e) => e.id), ['old']);
    assert.equal((await t.call(t.users.treasurer, `${path}&day=2026-02-30`)).body.error, 'invalid_quota_day');
    assert.equal((await t.call(t.users.treasurer, `${path}&day=jutro`)).body.error, 'invalid_quota_day');
    // Kursor: strony po 2, bez powtórzeń; kursor z innym filtrem doby jest odrzucany.
    const first = await t.call(t.users.treasurer, `${path}&limit=2`);
    assert.equal(first.body.entries.length, 2);
    assert.equal(first.body.truncated, true);
    assert.ok(first.body.nextCursor);
    const second = await t.call(t.users.treasurer, `${path}&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(second.body.entries.length, 2);
    assert.equal(second.body.nextCursor, null);
    const ids = [...first.body.entries, ...second.body.entries].map((e) => e.id);
    assert.equal(new Set(ids).size, 4);
    assert.deepEqual([...ids].sort(), [...byId.keys()].sort());
    assert.equal((await t.call(t.users.treasurer, `${path}&day=2026-10-05&cursor=${encodeURIComponent(first.body.nextCursor)}`)).status, 400);
    assert.equal((await t.call(t.users.treasurer, `${path}&limit=0`)).status, 400);
    assert.equal(await t.count("SELECT count(*) AS n FROM audit_events WHERE action = 'email.quota.other_recorded'"), 2);
  } finally { await t.close(); }
});

async function family(db, id) {
  await db.query('INSERT INTO households (id) VALUES ($1)', [id]);
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [`${id}-s`, id]);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, `${id}-s`, 'c1', YEAR]);
  await db.query("INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true)", [`${id}-g`, id, `${id}-g@example.invalid`]);
  await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, true)', [`${id}-s`, `${id}-g`]);
}

test('#84 two parallel worker runs at the day boundary never exceed the pool (PGlite: po kolei, nie wyścig)', async () => {
  // 22:30 UTC = 00:30 w Brukseli: doba UTC 5 października, doba konta już 6.
  const boundary = new Date('2026-10-05T22:30:00Z');
  const t = await setup({ EMAIL_DAILY_LIMIT: '10', EMAIL_CAMPAIGN_MIN_DAILY: '100' }, boundary);
  try {
    for (let i = 1; i <= 20; i += 1) await family(t.db, `h${String(i).padStart(2, '0')}`);
    const draft = await t.call(t.users.treasurer, '/api/email/campaigns', {
      method: 'POST', headers: { 'Idempotency-Key': 'campaign-key-0001' },
      body: { schoolYearId: YEAR, title: 'Przypomnienie', audience: 'all_households', subject: 'Składka {rok}', bodyText: BODY },
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const id = draft.body.campaign.id;
    assert.equal((await t.call(t.users.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' })).status, 200);
    const preview = await t.call(t.users.board, `/api/email/campaigns/${id}/preview`);
    assert.equal((await t.call(t.users.board, `/api/email/campaigns/${id}/approve`, {
      method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
    })).status, 200);
    assert.equal((await t.call(t.users.treasurer, `/api/email/campaigns/${id}/queue`, { method: 'POST' })).status, 200);
    // 3 wiadomości spoza kolejki z doby 5 (UTC) i 5 (Bruksela, 23:xx CEST) -> pula 7.
    const other = await t.post(t.users.treasurer, { day: '2026-10-05', count: 3, reasonCode: 'manual_brevo_panel' });
    assert.equal(other.status, 201);
    const calls = [];
    const transport = {
      name: 'fake', calls,
      async send(message) { calls.push(message); return { messageId: `fake-${calls.length}` }; },
    };
    const runs = await Promise.all([
      runEmailBatch(t.env, { transport, dryRun: false, now: boundary }),
      runEmailBatch(t.env, { transport, dryRun: false, now: boundary }),
    ]);
    const sent = runs.reduce((sum, run) => sum + run.sent, 0);
    assert.ok(sent > 0, 'coś zostało wysłane');
    assert.ok(sent <= 7, `suma przejętych ${sent} <= pula 7`);
    assert.equal(calls.length, sent);
    assert.ok(new Set(calls.map((message) => message.outboxId)).size === calls.length, 'żadna wiadomość nie wyszła dwa razy');
    const ledger = await t.count("SELECT COALESCE(SUM(message_count), 0) AS n FROM email_send_ledger WHERE day = '2026-10-05'");
    assert.ok(ledger <= 10, `dziennik doby 5: ${ledger}`);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});
