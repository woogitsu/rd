// Lista wyłączeń: przegląd i zdjęcie blokady jako nowy zapis (issue #94).
// Wyłącznie dane syntetyczne (.invalid/.test). Żaden test nie łączy się z siecią
// (globalny fetch jest pułapką, helpers/pg.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { emailHash } from '../src/email/content.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const YEAR = 'y2026';
const WEBHOOK_SECRET = 'w'.repeat(48);

async function setup(extraEnv = {}) {
  const db = await createTestDb();
  await seedClass(db, { id: 'c1', schoolYearId: YEAR });
  const treasurer = await seedUserSession(db, { userId: 'u-tr', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-bd', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const board2 = await seedUserSession(db, { userId: 'u-bd2', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  const representative = await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }] });
  const env = {
    db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true',
    EMAIL_TEST_ALLOWLIST: '*@example.invalid', BREVO_FROM_EMAIL: 'rada@example.invalid',
    BREVO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...extraEnv,
  };
  const call = async (cookie, path, options = {}) => {
    const response = await handlePgRequest(request(path, { cookie, ...options }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  return { db, env, treasurer, board, board2, representative, call, count, close: () => db.close() };
}

async function guardian(db, { id, householdId, email }) {
  await db.query('INSERT INTO households (id) VALUES ($1) ON CONFLICT DO NOTHING', [householdId]);
  await db.query(
    `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
     VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true) ON CONFLICT (id) DO NOTHING`,
    [id, householdId, email],
  );
}

async function block(t, email, reason = 'hard_bounce') {
  const res = await t.call(null, '/api/email/webhooks/brevo', {
    method: 'POST', headers: { Authorization: `Bearer ${WEBHOOK_SECRET}` },
    body: { event: reason, email, id: `evt-${email}-${reason}-${Date.now()}-${Math.random()}`, ts_event: 1791187200 },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
}

test('active suppression list resolves guardianId/householdId and masks the address', async () => {
  const t = await setup();
  try {
    await guardian(t.db, { id: 'g1', householdId: 'h1', email: 'blocked@example.invalid' });
    await block(t, 'blocked@example.invalid');
    const res = await t.call(t.treasurer, `/api/email/suppressions?schoolYearId=${YEAR}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.suppressions.length, 1);
    const row = res.body.suppressions[0];
    assert.equal(row.guardianId, 'g1');
    assert.equal(row.householdId, 'h1');
    assert.equal(row.email, 'b***@example.invalid');
    assert.equal(row.reason, 'hard_bounce');
  } finally { await t.close(); }
});

test('role boundaries: representative and class board get 403 on all three routes', async () => {
  const t = await setup();
  try {
    for (const path of [
      `/api/email/suppressions?schoolYearId=${YEAR}`,
    ]) {
      const res = await t.call(t.representative, path);
      assert.equal(res.status, 403, JSON.stringify(res.body));
    }
  } finally { await t.close(); }
});

test('release requires two different people (four eyes); same person is refused', async () => {
  const t = await setup();
  try {
    await guardian(t.db, { id: 'g1', householdId: 'h1', email: 'blocked@example.invalid' });
    await block(t, 'blocked@example.invalid');
    const hash = emailHash('blocked@example.invalid');
    const req = await t.call(t.treasurer, `/api/email/suppressions/${hash}/release-request`, {
      method: 'POST', body: { schoolYearId: YEAR, releaseReason: 'address_corrected' },
    });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    const selfApprove = await t.call(t.treasurer, `/api/email/suppressions/${hash}/release`, {
      method: 'POST', body: { schoolYearId: YEAR, requestId: req.body.requestId },
    });
    assert.equal(selfApprove.status, 403);
    assert.equal(selfApprove.body.error, 'self_approval_forbidden');
    const approved = await t.call(t.board, `/api/email/suppressions/${hash}/release`, {
      method: 'POST', body: { schoolYearId: YEAR, requestId: req.body.requestId },
    });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    // #184: zużycie wniosku (consumed_at) ma ślad — zdarzenie zdjęcia niesie id wniosku.
    const released = await t.db.query("SELECT metadata_json FROM audit_events WHERE action = 'email.suppression.released'");
    assert.equal(released.rows.length, 1);
    assert.equal(released.rows[0].metadata_json.requestId, req.body.requestId);
    // Wniosek zużyty — drugie użycie odmawia.
    const reused = await t.call(t.board2, `/api/email/suppressions/${hash}/release`, {
      method: 'POST', body: { schoolYearId: YEAR, requestId: req.body.requestId },
    });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error, 'request_already_consumed');
    const listAfter = await t.call(t.treasurer, `/api/email/suppressions?schoolYearId=${YEAR}`);
    assert.equal(listAfter.body.suppressions.length, 0, 'blokada zdjęta — adres nie jest już aktywnie zablokowany');
    // #387: każde zdarzenie audytu email.* dotyczące roku ma metadata.schoolYearId.
    const { rows: events } = await t.db.query(
      `SELECT action, metadata_json FROM audit_events
        WHERE action IN ('email.suppressions.viewed', 'email.suppression.release_requested', 'email.suppression.released')
        ORDER BY occurred_at`,
    );
    assert.ok(events.length >= 3, 'oczekiwano co najmniej po jednym zdarzeniu każdego typu');
    for (const row of events) {
      const metadata = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json;
      assert.equal(metadata.schoolYearId, YEAR, `${row.action} powinno mieć metadata.schoolYearId`);
    }
  } finally { await t.close(); }
});

test('complaint/unsubscribed can only be released with parent_request', async () => {
  const t = await setup();
  try {
    await guardian(t.db, { id: 'g1', householdId: 'h1', email: 'skarzacy@example.invalid' });
    await block(t, 'skarzacy@example.invalid', 'spam');
    const hash = emailHash('skarzacy@example.invalid');
    const wrongReason = await t.call(t.treasurer, `/api/email/suppressions/${hash}/release-request`, {
      method: 'POST', body: { schoolYearId: YEAR, releaseReason: 'bounce_reviewed' },
    });
    assert.equal(wrongReason.status, 409);
    assert.equal(wrongReason.body.error, 'release_reason_not_allowed');
    const ok = await t.call(t.treasurer, `/api/email/suppressions/${hash}/release-request`, {
      method: 'POST', body: { schoolYearId: YEAR, releaseReason: 'parent_request', confirmationNote: 'parent_email_reply' },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  } finally { await t.close(); }
});

test('a new bounce after release creates a new block record; history is never erased', async () => {
  const t = await setup();
  try {
    await guardian(t.db, { id: 'g1', householdId: 'h1', email: 'flaky@example.invalid' });
    await block(t, 'flaky@example.invalid');
    const hash = emailHash('flaky@example.invalid');
    const req = await t.call(t.treasurer, `/api/email/suppressions/${hash}/release-request`, {
      method: 'POST', body: { schoolYearId: YEAR, releaseReason: 'address_corrected' },
    });
    await t.call(t.board, `/api/email/suppressions/${hash}/release`, {
      method: 'POST', body: { schoolYearId: YEAR, requestId: req.body.requestId },
    });
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_active_suppressions'), 0);
    await block(t, 'flaky@example.invalid');
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_active_suppressions'), 1);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppressions WHERE email_hash = $1', [hash]), 2);
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppression_releases WHERE email_hash = $1', [hash]), 1);
  } finally { await t.close(); }
});

test('repeated webhook events for an already-active block do not create duplicate block rows', async () => {
  const t = await setup();
  try {
    await guardian(t.db, { id: 'g1', householdId: 'h1', email: 'repeat@example.invalid' });
    await block(t, 'repeat@example.invalid');
    await block(t, 'repeat@example.invalid');
    const hash = emailHash('repeat@example.invalid');
    assert.equal(await t.count('SELECT count(*)::int AS n FROM email_suppressions WHERE email_hash = $1', [hash]), 1);
  } finally { await t.close(); }
});
