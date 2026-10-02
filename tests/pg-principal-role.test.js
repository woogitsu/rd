// Dyrekcja (`principal`, wskazanie właściciela 2026-10-02, D-09): odczyt zebrań, uchwał
// oraz zbiorczych sum roku (raport roczny, przepływy) — bez księgi, wpłat, dokumentów,
// danych rodzin, bez zapisu. Dane wyłącznie syntetyczne. Pełną macierz tras (każda
// trasa x każdy aktor) sprawdza tests/pg-authz-matrix.test.js; tu granice roli.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-dir';
const OTHER = 'y-dir-other';
let keySeq = 0;
const nextKey = () => `dir-key-${++keySeq}-write`;

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR);
  await seedSchoolYear(db, OTHER);
  const env = { db };
  const cookies = {
    principal: await seedUserSession(db, { userId: 'u-dir', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: true }),
    principalNoMfa: await seedUserSession(db, { userId: 'u-dir-nomfa', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: false }),
    principalOther: await seedUserSession(db, { userId: 'u-dir-other', roles: [{ role: 'principal', schoolYearId: OTHER }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
  };
  return { db, env, cookies };
}

async function call(env, path, cookie, { method = 'GET', body, headers } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function createMeetingAs(env, cookie, title = 'Zebranie syntetyczne') {
  const created = await call(env, '/api/meetings', cookie, {
    method: 'POST', headers: { 'Idempotency-Key': `dir-create-${++keySeq}-key` },
    body: { schoolYearId: YEAR, kind: 'plenary', classId: null, title, scheduledAt: '2026-10-10T17:00:00Z' },
  });
  assert.equal(created.status, 201);
  return created.data.meeting.id;
}

const counts = async (db) => (await db.query(
  'SELECT (SELECT count(*) FROM meetings)::int AS m, (SELECT count(*) FROM meeting_agenda_items)::int AS a, (SELECT count(*) FROM meeting_minutes)::int AS n, (SELECT count(*) FROM resolutions)::int AS r')).rows[0];

test('dyrekcja czyta zebrania, rejestr uchwał i szczegóły zebrania (200), bez MFA jak Komisja Rewizyjna', async () => {
  const { db, env, cookies } = await setup();
  try {
    const meetingId = await createMeetingAs(env, cookies.board);
    for (const cookie of [cookies.principal, cookies.principalNoMfa]) {
      const list = await call(env, `/api/meetings?schoolYearId=${YEAR}`, cookie);
      assert.equal(list.status, 200);
      assert.ok(list.data.meetings.some((meeting) => meeting.id === meetingId), 'lista zawiera zebranie');
      assert.equal((await call(env, `/api/meetings/${meetingId}`, cookie)).status, 200);
      assert.equal((await call(env, `/api/meetings/resolutions?schoolYearId=${YEAR}`, cookie)).status, 200);
    }
  } finally { await db.close(); }
});

test('dyrekcja nie zapisuje: zebranie, punkt porządku, protokół i uchwała dają 403/404, a w bazie nic nie przybywa', async () => {
  const { db, env, cookies } = await setup();
  try {
    const meetingId = await createMeetingAs(env, cookies.board);
    const before = await counts(db);
    const attempts = [
      ['/api/meetings', { schoolYearId: YEAR, kind: 'plenary', title: 'Próba', scheduledAt: '2026-10-11T17:00:00Z' }],
      [`/api/meetings/${meetingId}/agenda-items`, { title: 'Próba punktu' }],
      [`/api/meetings/${meetingId}/minutes`, { body: 'Próba protokołu' }],
      [`/api/meetings/${meetingId}/resolutions`, { title: 'Próba uchwały', body: 'Treść syntetyczna', status: 'draft' }],
    ];
    assert.ok(attempts.length > 0);
    for (const [path, body] of attempts) {
      const result = await call(env, path, cookies.principal, { method: 'POST', body, headers: { 'Idempotency-Key': nextKey() } });
      assert.ok([403, 404].includes(result.status), `${path} -> ${result.status}`);
    }
    const patch = await call(env, `/api/meetings/${meetingId}`, cookies.principal, { method: 'PATCH', body: { revision: 1, title: 'Zmiana' } });
    assert.ok([403, 404].includes(patch.status), `PATCH -> ${patch.status}`);
    assert.deepEqual(await counts(db), before);
  } finally { await db.close(); }
});

test('dyrekcja widzi raport roczny i przepływy (sumy) z MFA; bez MFA 403; migawki i inny rok 403', async () => {
  const { db, env, cookies } = await setup();
  try {
    const annual = await call(env, `/api/reports/annual?schoolYearId=${YEAR}`, cookies.principal);
    assert.equal(annual.status, 200);
    assert.equal(annual.data.report.kind, 'annual');
    assert.equal((await call(env, `/api/reports/cash-flow?schoolYearId=${YEAR}`, cookies.principal)).status, 200);
    const audit = await db.query("SELECT actor_id FROM audit_events WHERE action = 'report.annual.generated'");
    assert.deepEqual(audit.rows.map((row) => row.actor_id), ['u-dir']);

    const noMfa = await call(env, `/api/reports/annual?schoolYearId=${YEAR}`, cookies.principalNoMfa);
    assert.equal(noMfa.status, 403);
    assert.match(noMfa.data.error, /mfa/);
    assert.equal((await call(env, `/api/reports/annual?schoolYearId=${OTHER}`, cookies.principal)).status, 403);
    assert.equal((await call(env, `/api/reports/annual?schoolYearId=${YEAR}`, cookies.principalOther)).status, 403);
    assert.equal((await call(env, `/api/reports/cash-flow?schoolYearId=${YEAR}`, cookies.principalOther)).status, 403);
    assert.equal((await call(env, `/api/reports/annual/snapshots?schoolYearId=${YEAR}`, cookies.principal)).status, 403);
    const create = await call(env, '/api/reports/annual/snapshots', cookies.principal, { method: 'POST', body: { schoolYearId: YEAR } });
    assert.equal(create.status, 403);
  } finally { await db.close(); }
});

test('dyrekcja nie widzi księgi, wpłat, dokumentów, rodzin ani uzgodnień (403)', async () => {
  const { db, env, cookies } = await setup();
  try {
    const paths = [
      `/api/ledger?schoolYearId=${YEAR}`, `/api/ledger/summary?schoolYearId=${YEAR}`, `/api/ledger/export.csv?schoolYearId=${YEAR}`,
      `/api/payments?schoolYearId=${YEAR}`, `/api/payments/export.csv?schoolYearId=${YEAR}`,
      `/api/documents?schoolYearId=${YEAR}`, `/api/reports/audit?schoolYearId=${YEAR}&format=json`,
      `/api/audit-reviews/${YEAR}`, '/api/admin/grants', '/api/admin/audit',
    ];
    assert.ok(paths.length > 0);
    for (const path of paths) {
      const result = await call(env, path, cookies.principal);
      assert.equal(result.status, 403, path);
    }
    const families = await call(env, `/api/families?schoolYearId=${YEAR}`, cookies.principal);
    assert.ok([403, 404].includes(families.status), `families -> ${families.status}`);
    const write = await call(env, '/api/ledger', cookies.principal, { method: 'POST', headers: { 'Idempotency-Key': nextKey() },
      body: { schoolYearId: YEAR, direction: 'income', amountCents: 500, categoryId: 'cat-x', description: 'Wpis syntetyczny', occurredOn: '2026-10-05', method: 'bank' } });
    assert.equal(write.status, 403);
  } finally { await db.close(); }
});

test('rolę dyrekcji nadaje wyłącznie admin: samonadanie 409, nie-admin 403, audyt role_grant.created', async () => {
  const { db, env, cookies } = await setup();
  try {
    const self = await call(env, '/api/admin/grants', cookies.admin, {
      method: 'POST', body: { userId: 'u-admin', role: 'principal', schoolYearId: YEAR },
    });
    assert.equal(self.status, 409);
    assert.equal(self.data.error, 'cannot_grant_self');

    for (const cookie of [cookies.board, cookies.principal]) {
      const denied = await call(env, '/api/admin/grants', cookie, {
        method: 'POST', body: { userId: 'u-board', role: 'principal', schoolYearId: YEAR },
      });
      assert.equal(denied.status, 403);
    }
    assert.equal((await db.query("SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-board' AND role = 'principal'")).rows[0].n, 0);

    const granted = await call(env, '/api/admin/grants', cookies.admin, {
      method: 'POST', body: { userId: 'u-board', role: 'principal', schoolYearId: YEAR },
    });
    assert.equal(granted.status, 201);
    const audit = await db.query("SELECT actor_id, entity_type FROM audit_events WHERE action = 'role_grant.created'");
    assert.ok(audit.rows.some((row) => row.actor_id === 'u-admin' && row.entity_type === 'role_grant'));
  } finally { await db.close(); }
});
