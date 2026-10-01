// #100 pkt 5: ograniczenie przetwarzania (RODO art. 18) — oznaczenie gospodarstwa
// albo opiekuna, które wyklucza z migawki kampanii e-mail, z kolejki przed
// wysyłką i z kartek; zdjęcie to NOWY zapis, historia zostaje. Wyłącznie dane
// syntetyczne (.invalid); żaden test nie łączy się z siecią (fałszywy transport).
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { runEmailBatch } from '../src/email/worker.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const YEAR = 'y2026';
const DAY1 = new Date('2026-10-05T08:00:00Z');
const BODY = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

function fakeTransport() {
  const calls = [];
  return { calls, name: 'fake', async send(message) { calls.push(message); return { messageId: `fake-${calls.length}` }; } };
}

describe('ograniczenie przetwarzania (#100, art. 18)', () => {
  let db;
  let env;
  const cookies = {};

  before(async () => {
    db = await createTestDb();
    env = {
      db, APP_ENV: 'development', EMAIL_SENDING_ENABLED: 'true', EMAIL_TEST_ALLOWLIST: '*@example.invalid',
      BREVO_FROM_EMAIL: 'rada@example.invalid',
    };
    await seedClass(db, { id: 'c1', schoolYearId: YEAR });
    // h-1: dwoje opiekunów jednego dziecka (g-1a, g-1b); h-2: rodzeństwo (dwoje dzieci), opiekun g-2; h-3: zwykła rodzina.
    for (const [household, students, guardians] of [
      ['h-1', ['s-1'], ['g-1a', 'g-1b']], ['h-2', ['s-2a', 's-2b'], ['g-2']], ['h-3', ['s-3'], ['g-3']],
    ]) {
      await db.query('INSERT INTO households (id) VALUES ($1)', [household]);
      for (const id of students) {
        await db.query("INSERT INTO students (id, household_id, first_name, last_name) VALUES ($1, $2, 'Uczeń', 'Testowy')", [id, household]);
        await db.query('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES ($1, $2, $3, $4)', [`e-${id}`, id, 'c1', YEAR]);
      }
      for (const id of guardians) {
        await db.query(
          `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
           VALUES ($1, $2, 'Opiekun', 'Testowy', $3, true)`, [id, household, `${id}@example.invalid`]);
        for (const studentId of students) {
          await db.query('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES ($1, $2, true, $3)',
            [studentId, id, id.endsWith('a') || guardians.length === 1]);
        }
      }
    }
    cookies.admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    cookies.board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
    cookies.treasurer = await seedUserSession(db, { userId: 'u-tr', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true });
    cookies.board2 = await seedUserSession(db, { userId: 'u-bd2', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
    cookies.audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true });
    cookies.principal = await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: true });
    cookies.rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c1', schoolYearId: YEAR }], mfa: true });
  });
  after(async () => { await db?.close(); });

  const call = async (path, { cookie = cookies.admin, method = 'POST', body, headers } = {}) => {
    const response = await handlePgRequest(request(path, { cookie, method, body, headers }), env);
    const text = await response.text();
    return { status: response.status, text, json: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  };

  async function newRequest(subject, { kind = 'restriction', verify = true } = {}) {
    const created = await call('/api/admin/data-requests', { body: { kind, ...subject, receivedOn: '2026-10-01' } });
    assert.equal(created.status, 201, created.text);
    const id = created.json.request.id;
    if (verify) assert.equal((await call(`/api/admin/data-requests/${id}/status`, { body: { status: 'identity_verified' } })).status, 200);
    return id;
  }
  const restrict = (id, cookie) => call(`/api/admin/data-requests/${id}/restrict`, { cookie, body: {} });
  const lift = (id, cookie) => call(`/api/admin/data-requests/${id}/lift-restriction`, { cookie, body: {} });
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

  async function snapshotCampaign() {
    const created = await call('/api/email/campaigns', {
      cookie: cookies.treasurer, headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { schoolYearId: YEAR, title: 'Przypomnienie', audience: 'all_households', subject: 'Dobrowolna składka {rok}', bodyText: BODY },
    });
    assert.equal(created.status, 201, created.text);
    const id = created.json.campaign.id;
    const built = await call(`/api/email/campaigns/${id}/snapshot`, { cookie: cookies.treasurer });
    assert.equal(built.status, 200, built.text);
    return id;
  }
  const recipientHouseholds = async (campaignId) => (await rows(
    'SELECT household_id, guardian_id FROM email_campaign_recipients WHERE campaign_id = $1 ORDER BY household_id', [campaignId]));
  const exclusionsOf = async (campaignId) => (await rows(
    'SELECT household_id, reason FROM email_campaign_exclusions WHERE campaign_id = $1 ORDER BY household_id', [campaignId]));

  test('granice ról: tylko admin z MFA; reszta 403 bez zapisu i bez zmiany stanu', async () => {
    const id = await newRequest({ householdId: 'h-3' });
    for (const role of ['board', 'treasurer', 'audit', 'principal', 'rep']) {
      assert.equal((await restrict(id, cookies[role])).status, 403, role);
      assert.equal((await lift(id, cookies[role])).status, 403, role);
      assert.equal((await call(`/api/admin/data-requests/${id}/restrictions`, { cookie: cookies[role], method: 'GET' })).status, 403, role);
    }
    assert.equal((await restrict(id, undefined)).status, 200, 'admin ma dostęp');
    assert.equal((await rows('SELECT count(*)::int AS n FROM processing_restrictions'))[0].n, 1);
    assert.equal((await lift(id)).status, 200);
    assert.equal((await rows('SELECT count(*)::int AS n FROM processing_restrictions'))[0].n, 2);
  });

  test('warunki: rodzaj, tożsamość, podmiot, stan żądania', async () => {
    const access = await newRequest({ householdId: 'h-3' }, { kind: 'access' });
    assert.equal((await restrict(access)).json.error, 'data_request_kind_not_restrictable');
    const unverified = await newRequest({ householdId: 'h-3' }, { verify: false });
    assert.equal((await restrict(unverified)).json.error, 'data_request_identity_not_verified');
    const studentOnly = await newRequest({ studentId: 's-3' });
    assert.equal((await restrict(studentOnly)).json.error, 'data_request_subject_not_restrictable');
    const missing = await restrict('00000000-0000-4000-8000-000000000000');
    assert.equal(missing.status, 404);
    const closed = await newRequest({ householdId: 'h-3' });
    await call(`/api/admin/data-requests/${closed}/status`, { body: { status: 'rejected' } });
    assert.equal((await restrict(closed)).json.error, 'data_request_closed');
    const answered = await newRequest({ householdId: 'h-3' });
    await call(`/api/admin/data-requests/${answered}/status`, { body: { status: 'answered' } });
    assert.equal((await restrict(answered)).json.error, 'data_request_closed');
  });

  test('podwójne kliknięcie i ponowienie: jeden zapis i jedno zdarzenie', async () => {
    const id = await newRequest({ householdId: 'h-2' });
    const [a, b] = await Promise.all([restrict(id), restrict(id)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal([a, b].filter((r) => r.json.changed).length, 1);
    assert.equal((await restrict(id)).json.changed, false);
    const events = await rows("SELECT id FROM audit_events WHERE action = 'processing_restriction.applied' AND metadata_json->>'requestId' = $1", [id]);
    assert.equal(events.length, 1);
    assert.equal((await lift(id)).json.changed, true);
    assert.equal((await lift(id)).json.changed, false);
  });

  test('migawka kampanii pomija ograniczone gospodarstwo; rodzeństwo to jedna rodzina', async () => {
    const id = await newRequest({ householdId: 'h-2' });
    assert.equal((await restrict(id)).status, 200);
    const campaignId = await snapshotCampaign();
    assert.deepEqual((await recipientHouseholds(campaignId)).map((r) => r.household_id), ['h-1', 'h-3']);
    assert.deepEqual(await exclusionsOf(campaignId), [{ household_id: 'h-2', reason: 'processing_restricted' }]);
    // Dane nie zostały usunięte: gospodarstwo, opiekun i dzieci nadal istnieją.
    assert.equal((await rows("SELECT count(*)::int AS n FROM students WHERE household_id = 'h-2'"))[0].n, 2);
    assert.equal((await rows("SELECT count(*)::int AS n FROM guardians WHERE id = 'g-2'"))[0].n, 1);
    assert.equal((await lift(id)).status, 200);
  });

  test('dwoje opiekunów jednego dziecka: ograniczony opiekun nie jest adresatem, drugi tak', async () => {
    const id = await newRequest({ guardianId: 'g-1a' });
    assert.equal((await restrict(id)).json.subjectType, 'guardian');
    const campaignId = await snapshotCampaign();
    const recipients = await recipientHouseholds(campaignId);
    assert.deepEqual(recipients.find((r) => r.household_id === 'h-1'), { household_id: 'h-1', guardian_id: 'g-1b' });
    // Gdy ograniczeni są obaj, rodzina wypada z powodem processing_restricted.
    const second = await newRequest({ guardianId: 'g-1b' });
    assert.equal((await restrict(second)).status, 200);
    const campaign2 = await snapshotCampaign();
    assert.deepEqual(await exclusionsOf(campaign2), [{ household_id: 'h-1', reason: 'processing_restricted' }]);
    assert.equal((await lift(id)).status, 200);
    assert.equal((await lift(second)).status, 200);
  });

  test('zdjęcie ograniczenia to nowy zapis: historia zostaje, kampania znów obejmuje rodzinę', async () => {
    const id = await newRequest({ guardianId: 'g-3' });
    await restrict(id);
    await lift(id);
    const history = await call(`/api/admin/data-requests/${id}/restrictions`, { method: 'GET' });
    assert.equal(history.status, 200);
    assert.deepEqual(history.json.events.map((e) => e.action), ['restrict', 'lift']);
    assert.equal(history.json.restricted, false);
    assert.doesNotMatch(history.text, /example\.invalid/);
    const campaignId = await snapshotCampaign();
    assert.ok((await recipientHouseholds(campaignId)).some((r) => r.guardian_id === 'g-3'));
    await assert.rejects(db.query("UPDATE processing_restrictions SET action = 'lift' WHERE action = 'restrict'"), /processing_restrictions_append_only/);
    await assert.rejects(db.query('DELETE FROM processing_restrictions'), /processing_restrictions_append_only/);
    const events = await rows("SELECT action FROM audit_events WHERE action LIKE 'processing_restriction.%' AND metadata_json->>'requestId' = $1 ORDER BY occurred_at, id", [id]);
    assert.equal(events.length, 2);
  });

  test('kartki pomijają ograniczone gospodarstwo (także przedstawiciela klasy)', async () => {
    const id = await newRequest({ householdId: 'h-2' });
    await restrict(id);
    for (const cookie of [cookies.board, cookies.rep]) {
      const res = await call(`/api/print/cards?schoolYearId=${YEAR}&classId=c1`, { cookie, method: 'GET' });
      assert.equal(res.status, 200, res.text);
      const households = [...new Set(res.json.rows.map((row) => row.householdId))].sort();
      assert.deepEqual(households, ['h-1', 'h-3']);
    }
    await lift(id);
    const after = await call(`/api/print/cards?schoolYearId=${YEAR}&classId=c1`, { cookie: cookies.board, method: 'GET' });
    assert.ok(after.json.rows.some((row) => row.householdId === 'h-2'));
  });

  test('ograniczenie po zakolejkowaniu: worker pomija wiersz i nic nie wysyła', async () => {
    const campaignId = await snapshotCampaign();
    const preview = await call(`/api/email/campaigns/${campaignId}/preview`, { cookie: cookies.board, method: 'GET' });
    const approved = await call(`/api/email/campaigns/${campaignId}/approve`, {
      cookie: cookies.board, body: { contentHash: preview.json.contentHash, recipientsHash: preview.json.recipientsHash },
    });
    assert.equal(approved.status, 200, approved.text);
    assert.equal((await call(`/api/email/campaigns/${campaignId}/queue`, { cookie: cookies.treasurer })).status, 200);
    const id = await newRequest({ householdId: 'h-3' });
    await restrict(id);
    const transport = fakeTransport();
    const run = await runEmailBatch(env, { transport, dryRun: false, now: DAY1 });
    assert.equal(run.skipped, 1);
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls.filter((message) => message.to.startsWith('g-3@')).length, 0);
    const outbox = await rows('SELECT household_id, state, last_error FROM email_outbox WHERE campaign_id = $1 ORDER BY household_id', [campaignId]);
    assert.deepEqual(outbox.find((r) => r.household_id === 'h-3'), { household_id: 'h-3', state: 'skipped', last_error: 'processing_restricted' });
    await lift(id);
  });

  test('zdarzenia audytu bez danych osobowych', async () => {
    const events = await rows("SELECT action, entity_type, metadata_json::text AS metadata FROM audit_events WHERE action LIKE 'processing_restriction.%'");
    assert.ok(events.length >= 2);
    for (const event of events) {
      assert.equal(event.entity_type, 'processing_restriction');
      assert.doesNotMatch(event.metadata, /example\.invalid|Testowy/);
    }
  });
});
