// Lista wyłączeń (#94): scenariusze rodzin, idempotencja, dziennik i granice ról.
// Uzupełnia tests/email-suppression-releases.test.js. Wyłącznie dane syntetyczne
// (.invalid). Żaden test nie wysyła poczty: worker dostaje fałszywy transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { assertNoPii } from '../src/pg/audit.js';
import { emailHash } from '../src/email/content.js';
import { runEmailBatch } from '../src/email/worker.js';
import { createTestDb, networkGuardCalls, request, seedClass, seedUserSession, seedPublishedPrivacyNotice } from './helpers/pg.js';

const YEAR = 'y2026';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const WEBHOOK_SECRET = 'w'.repeat(48);
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

async function setup() {
  const db = await createTestDb();
  await seedPublishedPrivacyNotice(db);
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const users = {
    treasurer: await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    board: await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    board2: await seedUserSession(db, { userId: 'u-bd2', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    representative: await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] }),
    classBoard: await seedUserSession(db, { userId: 'u-cb', mfa: true, roles: [{ role: 'board', classId: 'c1', schoolYearId: YEAR }] }),
    admin: await seedUserSession(db, { userId: 'u-ad', mfa: true, roles: [{ role: 'admin' }] }),
  };
  const env = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
    BREVO_FROM_EMAIL: 'rada@example.invalid', BREVO_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  return { db, env, ...users, call, count, close: () => db.close() };
}

async function family(db, householdId, guardians) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT DO NOTHING', [householdId]);
  const studentId = `${householdId}-s1`;
  await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [studentId, householdId]);
  await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${studentId}`, studentId, 'c1', YEAR]);
  for (const guardian of guardians) {
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true) ON CONFLICT (id) DO NOTHING`,
      [guardian.id, householdId, guardian.email],
    );
    await db.query(
      'INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, $3)',
      [studentId, guardian.id, guardian.primary ?? false],
    );
  }
}

let webhookSeq = 0;
async function block(t, email, event = 'hard_bounce') {
  webhookSeq += 1;
  const res = await t.call(null, '/api/email/webhooks/brevo', {
    method: 'POST', headers: { Authorization: `Bearer ${WEBHOOK_SECRET}` },
    body: { event, email, id: `evt-${webhookSeq}`, ts_event: 1791187200 + webhookSeq },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

// Wniosek + zatwierdzenie przez drugą osobę.
async function release(t, email, reason = 'address_corrected') {
  const hash = emailHash(email);
  const req = await t.call(t.treasurer, `/api/email/suppressions/${hash}/release-request`, {
    method: 'POST', body: { schoolYearId: YEAR, releaseReason: reason },
  });
  assert.ok([200, 201].includes(req.status), JSON.stringify(req.body));
  const done = await t.call(t.board, `/api/email/suppressions/${hash}/release`, {
    method: 'POST', body: { schoolYearId: YEAR, requestId: req.body.requestId },
  });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  return { hash, requestId: req.body.requestId };
}

async function draft(t) {
  const res = await t.call(t.treasurer, '/api/email/campaigns', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { schoolYearId: YEAR, title: 'Przypomnienie jesienne', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.campaign;
}

async function snapshot(t, id) {
  const res = await t.call(t.treasurer, `/api/email/campaigns/${id}/snapshot`, { method: 'POST' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function recipients(t, campaignId) {
  const { rows } = await t.db.query('SELECT household_id, guardian_id FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY household_id', [campaignId]);
  return rows;
}

test('two guardians of one child: block of the first picks the second, release brings the primary contact back', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', [{ id: 'h1-g1', email: 'glowny@example.invalid', primary: true }, { id: 'h1-g2', email: 'drugi@example.invalid' }]);
    const before = await snapshot(t, (await draft(t)).id);
    assert.equal(before.recipientsCount, 1);
    await block(t, 'glowny@example.invalid');
    const blockedCampaign = await draft(t);
    await snapshot(t, blockedCampaign.id);
    assert.deepEqual(await recipients(t, blockedCampaign.id), [{ household_id: 'h1', guardian_id: 'h1-g2' }]);
    await release(t, 'glowny@example.invalid');
    const afterCampaign = await draft(t);
    await snapshot(t, afterCampaign.id);
    assert.deepEqual(await recipients(t, afterCampaign.id), [{ household_id: 'h1', guardian_id: 'h1-g1' }]);
  } finally { await t.close(); }
});

test('siblings in two households with the same address: block excludes both, release keeps duplicate_address rule', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', [{ id: 'h1-g1', email: 'wspolny@example.invalid', primary: true }]);
    await family(t.db, 'h2', [{ id: 'h2-g1', email: 'wspolny@example.invalid', primary: true }]);
    await block(t, 'wspolny@example.invalid');
    const blocked = await draft(t);
    const blockedSnapshot = await snapshot(t, blocked.id);
    assert.equal(blockedSnapshot.recipientsCount, 0);
    assert.equal(blockedSnapshot.exclusions.suppressed, 2);
    await release(t, 'wspolny@example.invalid');
    const after = await draft(t);
    const afterSnapshot = await snapshot(t, after.id);
    assert.equal(afterSnapshot.recipientsCount, 1, 'ten sam adres nadal tylko raz na kampanię');
    assert.equal(afterSnapshot.exclusions.duplicate_address, 1);
    assert.equal(afterSnapshot.exclusions.suppressed ?? 0, 0);
  } finally { await t.close(); }
});

test('address corrected in guardian data: new hash, family returns to the snapshot without releasing the old block', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', [{ id: 'h1-g1', email: 'blad@example.invalid', primary: true }]);
    await block(t, 'blad@example.invalid');
    const listed = await t.call(t.treasurer, `/api/email/suppressions?schoolYearId=${YEAR}`);
    assert.equal(listed.body.suppressions[0].guardianId, 'h1-g1');
    await t.db.query("UPDATE guardians SET email = 'poprawiony@example.invalid' WHERE id = 'h1-g1'");
    const campaign = await draft(t);
    const result = await snapshot(t, campaign.id);
    assert.equal(result.recipientsCount, 1);
    assert.deepEqual(await recipients(t, campaign.id), [{ household_id: 'h1', guardian_id: 'h1-g1' }]);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppression_releases'), 0, 'blokada starego adresu nie została zdjęta');
    // Lista „do poprawy” nie wskazuje już rodziny (zniknął opiekun z tym skrótem).
    const after = await t.call(t.treasurer, `/api/email/suppressions?schoolYearId=${YEAR}`);
    assert.equal(after.body.suppressions.length, 1);
    assert.equal(after.body.suppressions[0].guardianId, null);
    assert.equal(after.body.suppressions[0].householdId, null);
    assert.equal(after.body.suppressions[0].email, null);
  } finally { await t.close(); }
});

test('double click: a repeated request returns the same open request, a repeated approval creates one release', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', [{ id: 'h1-g1', email: 'klik@example.invalid', primary: true }]);
    await block(t, 'klik@example.invalid');
    const hash = emailHash('klik@example.invalid');
    const send = () => t.call(t.treasurer, `/api/email/suppressions/${hash}/release-request`, {
      method: 'POST', body: { schoolYearId: YEAR, releaseReason: 'bounce_reviewed' },
    });
    const first = await send();
    const second = await send();
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.requestId, first.body.requestId);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppression_release_requests WHERE email_hash = $1', [hash]), 1);

    // Lista pokazuje otwarty wniosek: zgłaszającemu „mój”, drugiej osobie do zatwierdzenia.
    const mine = await t.call(t.treasurer, `/api/email/suppressions?schoolYearId=${YEAR}`);
    assert.equal(mine.body.suppressions[0].pendingRequest.requestId, first.body.requestId);
    assert.equal(mine.body.suppressions[0].pendingRequest.requestedByMe, true);
    const theirs = await t.call(t.board, `/api/email/suppressions?schoolYearId=${YEAR}`);
    assert.equal(theirs.body.suppressions[0].pendingRequest.requestedByMe, false);
    assert.doesNotMatch(JSON.stringify(theirs.body), /u-tr/, 'lista nie ujawnia identyfikatora zgłaszającego');

    const approve = () => t.call(t.board, `/api/email/suppressions/${hash}/release`, {
      method: 'POST', body: { schoolYearId: YEAR, requestId: first.body.requestId },
    });
    const results = await Promise.all([approve(), approve()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppression_releases WHERE email_hash = $1', [hash]), 1);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppressions WHERE email_hash = $1', [hash]), 1, 'zdjęcie nie usuwa ani nie zmienia zapisu blokady');
  } finally { await t.close(); }
});

test('a new hard_bounce after release blocks again and the worker skips the row as suppressed', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', [{ id: 'h1-g1', email: 'ponownie@example.invalid', primary: true }]);
    await block(t, 'ponownie@example.invalid');
    await release(t, 'ponownie@example.invalid');
    const campaign = await draft(t);
    await snapshot(t, campaign.id);
    const preview = await t.call(t.board, `/api/email/campaigns/${campaign.id}/preview`);
    const approved = await t.call(t.board, `/api/email/campaigns/${campaign.id}/approve`, {
      method: 'POST', body: { contentHash: preview.body.contentHash, recipientsHash: preview.body.recipientsHash },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const queued = await t.call(t.treasurer, `/api/email/campaigns/${campaign.id}/queue`, { method: 'POST' });
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    // Kolejny bounce między zakolejkowaniem a wysyłką: nowa blokada, worker nie wysyła.
    await block(t, 'ponownie@example.invalid');
    const calls = [];
    const transport = { name: 'fake', async send(message) { calls.push(message); return { messageId: 'never' }; } };
    await runEmailBatch(t.env, { transport, dryRun: false, now: DAY1 });
    assert.equal(calls.length, 0);
    const { rows } = await t.db.query('SELECT state FROM email_outbox WHERE campaign_id = $1', [campaign.id]);
    assert.deepEqual(rows.map((r) => r.state), ['suppressed']);
    assert.equal(networkGuardCalls(), 0);
  } finally { await t.close(); }
});

test('audit events of the suppression flow carry ids and codes, never an address', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', [{ id: 'h1-g1', email: 'audyt@example.invalid', primary: true }]);
    await block(t, 'audyt@example.invalid');
    await t.call(t.treasurer, `/api/email/suppressions?schoolYearId=${YEAR}`);
    await release(t, 'audyt@example.invalid', 'provider_unblocked');
    const { rows } = await t.db.query(
      `SELECT action, metadata_json FROM audit_events
        WHERE action IN ('email.suppressions.viewed', 'email.suppression.release_requested', 'email.suppression.released', 'email.address_suppressed')`,
    );
    assert.ok(rows.length >= 4);
    for (const row of rows) {
      const metadata = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json;
      assertNoPii(metadata);
      assert.doesNotMatch(JSON.stringify(metadata), /audyt|example\.invalid|@/, `${row.action} bez adresu`);
    }
  } finally { await t.close(); }
});

test('role boundaries: representative, class board and admin get 403 on the list and on both POST routes', async () => {
  const t = await setup();
  try {
    await family(t.db, 'h1', [{ id: 'h1-g1', email: 'role@example.invalid', primary: true }]);
    await block(t, 'role@example.invalid');
    const hash = emailHash('role@example.invalid');
    const pending = await t.call(t.treasurer, `/api/email/suppressions/${hash}/release-request`, {
      method: 'POST', body: { schoolYearId: YEAR, releaseReason: 'address_corrected' },
    });
    for (const cookie of [t.representative, t.classBoard, t.admin, null]) {
      const list = await t.call(cookie, `/api/email/suppressions?schoolYearId=${YEAR}`);
      assert.equal(list.status, cookie ? 403 : 401);
      const req = await t.call(cookie, `/api/email/suppressions/${hash}/release-request`, {
        method: 'POST', body: { schoolYearId: YEAR, releaseReason: 'address_corrected' },
      });
      assert.equal(req.status, cookie ? 403 : 401);
      const rel = await t.call(cookie, `/api/email/suppressions/${hash}/release`, {
        method: 'POST', body: { schoolYearId: YEAR, requestId: pending.body.requestId },
      });
      assert.equal(rel.status, cookie ? 403 : 401);
    }
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppression_releases'), 0);
    // Lista nie zawiera pełnego adresu ani treści webhooka.
    const ok = await t.call(t.board, `/api/email/suppressions?schoolYearId=${YEAR}`);
    assert.doesNotMatch(JSON.stringify(ok.body), /role@example/);
  } finally { await t.close(); }
});
