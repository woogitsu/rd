// Regresje: zakres przydziałów klasowych (wzorzec SR-01 w kolejnych modułach),
// wyrocznia istnienia (SR-07) i mapowanie błędów triggerów na 409.
// Wyłącznie dane syntetyczne (.invalid / .test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { updateMeeting, createMeeting, createMinutesVersion } from '../src/pg/meetings.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-2026';
const NEXT = 'y-2027';
const CLASS = 'c-sc-1a';

async function status(env, path, options) {
  const response = await handlePgRequest(request(path, options), env);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function baseDb() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR);
  await seedClass(db, { id: CLASS, schoolYearId: YEAR });
  await db.query("INSERT INTO households (id) VALUES ('h-sc-1')");
  await seedUser(db, { userId: 'u-sc-seed' });
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
    VALUES ('cat-sc-exp', $1, 'expense', 'Wydarzenia', 'u-sc-seed')`, [YEAR]);
  return db;
}

function classScoped(db, role, suffix = '') {
  return seedUserSession(db, {
    userId: `u-sc-class-${role}${suffix}`, mfa: true, roles: [{ role, classId: CLASS, schoolYearId: YEAR }],
  });
}

function schoolWide(db, role) {
  return seedUserSession(db, { userId: `u-sc-school-${role}`, mfa: true, roles: [{ role, schoolYearId: YEAR }] });
}

const ledgerInput = {
  schoolYearId: YEAR, direction: 'expense', amountCents: 1500, categoryId: 'cat-sc-exp',
  description: 'Syntetyczny wydatek', occurredOn: '2026-10-01', method: 'bank',
};

// ---------- zakres: przydział klasowy nie działa jak szkolny ----------

test('SR-01 (księga): przydział finansowy z class_id nie daje dostępu do księgi', async () => {
  const db = await baseDb();
  try {
    const env = { db };
    for (const role of ['treasurer', 'board', 'admin']) {
      const cookie = await classScoped(db, role);
      const responses = [
        await status(env, `/api/ledger?schoolYearId=${YEAR}`, { cookie }),
        await status(env, `/api/ledger/summary?schoolYearId=${YEAR}`, { cookie }),
        await status(env, `/api/ledger/export.csv?schoolYearId=${YEAR}`, { cookie }),
        await status(env, '/api/ledger', {
          method: 'POST', cookie, body: ledgerInput, headers: { 'Idempotency-Key': `sc-ledger-${role}-01` },
        }),
      ];
      for (const response of responses) assert.deepEqual(response, { status: 403, body: { error: 'forbidden' } }, role);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0].n, 0);
    const school = await schoolWide(db, 'treasurer');
    assert.equal((await status(env, `/api/ledger?schoolYearId=${YEAR}`, { cookie: school })).status, 200);
  } finally {
    await db.close();
  }
});

test('SR-01 (e-mail): zarząd/skarbnik z class_id nie widzi ani nie tworzy kampanii', async () => {
  const db = await baseDb();
  try {
    const env = { db };
    for (const role of ['board', 'treasurer']) {
      const cookie = await classScoped(db, role);
      assert.deepEqual(await status(env, `/api/email/campaigns?schoolYearId=${YEAR}`, { cookie }),
        { status: 403, body: { error: 'forbidden' } }, role);
      const created = await status(env, '/api/email/campaigns', {
        method: 'POST', cookie, headers: { 'Idempotency-Key': `sc-email-${role}-0001` },
        body: {
          schoolYearId: YEAR, title: 'Kampania syntetyczna', audience: 'all_households', subject: 'Składka {rok}',
          bodyText: 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}.',
        },
      });
      assert.equal(created.status, 403, role);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM email_campaigns')).rows[0].n, 0);
    const school = await schoolWide(db, 'board');
    assert.equal((await status(env, `/api/email/campaigns?schoolYearId=${YEAR}`, { cookie: school })).status, 200);
  } finally {
    await db.close();
  }
});

test('SR-01 (uzgodnienia, eksport roczny): przydział z class_id nie działa ogólnoszkolnie', async () => {
  const db = await baseDb();
  try {
    const env = { db };
    for (const role of ['treasurer', 'board', 'admin']) {
      const cookie = await classScoped(db, role);
      assert.equal((await status(env, `/api/reconciliations?schoolYearId=${YEAR}`, { cookie })).status, 403, role);
    }
    for (const role of ['board', 'treasurer', 'audit']) {
      const cookie = await classScoped(db, role, '-r');
      assert.equal((await status(env, `/api/reports/audit?schoolYearId=${YEAR}`, { cookie })).status, 403, role);
    }
    for (const role of ['admin', 'board']) {
      const cookie = await classScoped(db, role, '-x');
      const response = await status(env, '/api/exports', { method: 'POST', cookie, body: { schoolYearId: YEAR } });
      assert.equal(response.status, 403, role);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM export_runs')).rows[0].n, 0);
    const treasurer = await schoolWide(db, 'treasurer');
    assert.equal((await status(env, `/api/reconciliations?schoolYearId=${YEAR}`, { cookie: treasurer })).status, 200);
    const board = await schoolWide(db, 'board');
    assert.equal((await status(env, '/api/exports', { method: 'POST', cookie: board, body: { schoolYearId: YEAR } })).status, 200);
  } finally {
    await db.close();
  }
});

test('zakres (wydarzenia, zebrania): zarząd z class_id nie działa ogólnoszkolnie; odczyt spoza zakresu = 404', async () => {
  const db = await baseDb();
  try {
    const env = { db };
    const board = await schoolWide(db, 'board');
    const classBoard = await classScoped(db, 'board');
    // Wydarzenia: przydział klasowy daje szkic tylko przedstawicielowi, zarząd z klasą — nic.
    const eventBody = { schoolYearId: YEAR, title: 'Wydarzenie ogólne', startsAt: '2026-11-12T18:30', audience: 'internal' };
    assert.equal((await status(env, '/api/events', {
      method: 'POST', cookie: classBoard, body: eventBody, headers: { 'Idempotency-Key': 'sc-event-class-01' },
    })).status, 403);
    assert.equal((await status(env, `/api/events?schoolYearId=${YEAR}`, { cookie: classBoard })).status, 403);
    const created = await status(env, '/api/events', {
      method: 'POST', cookie: board, body: eventBody, headers: { 'Idempotency-Key': 'sc-event-board-01' },
    });
    assert.equal(created.status, 201);
    const eventId = created.body.event.id;
    for (const [path, method, body] of [
      [`/api/events/${eventId}`, 'GET'],
      [`/api/events/${eventId}`, 'PATCH', { revision: 1, title: 'Przejęte' }],
      [`/api/events/${eventId}/submit`, 'POST', { revision: 1 }],
      [`/api/events/${eventId}/cancel`, 'POST', { revision: 1, reason: 'Nie moje' }],
    ]) {
      const foreign = await status(env, path, { method, cookie: classBoard, body });
      const missing = await status(env, path.replace(eventId, 'brak-wydarzenia'), { method, cookie: classBoard, body });
      assert.deepEqual(foreign, { status: 404, body: { error: 'event_not_found' } }, `${method} ${path}`);
      assert.deepEqual(foreign, missing, `${method} ${path}`);
    }

    // Zebrania: lista zarządu klasowego zawiera tylko jego klasę; zebranie ogólne = 404.
    const meeting = await status(env, '/api/meetings', {
      method: 'POST', cookie: board, headers: { 'Idempotency-Key': 'sc-meeting-board-01' },
      body: { schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie ogólne', scheduledAt: '2026-10-10T17:00:00Z' },
    });
    assert.equal(meeting.status, 201);
    const meetingId = meeting.body.meeting.id;
    const listed = await status(env, `/api/meetings?schoolYearId=${YEAR}`, { cookie: classBoard });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.meetings, []);
    const foreign = await status(env, `/api/meetings/${meetingId}`, { cookie: classBoard });
    const missing = await status(env, '/api/meetings/brak-zebrania', { cookie: classBoard });
    assert.deepEqual(foreign, { status: 404, body: { error: 'meeting_not_found' } });
    assert.deepEqual(foreign, missing);
    assert.equal((await status(env, `/api/meetings/${meetingId}`, { cookie: board })).status, 200);
  } finally {
    await db.close();
  }
});

// ---------- zamknięty rok: 409 school_year_closed zamiast 503 ----------

// Zamknięcie „na skróty” wyłącznie w bazie testowej: pomija listę kontrolną
// i bilans, bo test sprawdza tylko odpowiedź API na trigger a0_year_freeze.
async function closeYear(db, schoolYearId) {
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedUser(db, { userId: 'u-sc-close-a' });
  await seedUser(db, { userId: 'u-sc-close-b' });
  await db.exec('ALTER TABLE school_year_closures DISABLE TRIGGER USER');
  await db.exec('ALTER TABLE school_year_closures DROP CONSTRAINT year_close_closed_fields');
  await db.query(`INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by, closed_by, closed_at)
    VALUES ('close-sc-1', $1, $2, 'closed', 'u-sc-close-a', 'u-sc-close-b', now())`, [schoolYearId, NEXT]);
  await db.exec('ALTER TABLE school_year_closures ENABLE TRIGGER USER');
}

test('zamknięty rok: wpłaty, księga, wydarzenia i zebrania odpowiadają 409 school_year_closed', async () => {
  const db = await baseDb();
  try {
    const env = { db };
    const treasurer = await schoolWide(db, 'treasurer');
    const board = await schoolWide(db, 'board');
    const payment = await status(env, '/api/payments', {
      method: 'POST', cookie: treasurer, headers: { 'Idempotency-Key': 'sc-closed-pay-01' },
      body: { householdId: 'h-sc-1', schoolYearId: YEAR, amountCents: 2500, receivedOn: '2026-10-01', method: 'bank' },
    });
    assert.equal(payment.status, 201);
    const event = await status(env, '/api/events', {
      method: 'POST', cookie: board, headers: { 'Idempotency-Key': 'sc-closed-event-01' },
      body: { schoolYearId: YEAR, title: 'Wydarzenie roku', startsAt: '2026-11-12T18:30', audience: 'internal' },
    });
    const meeting = await status(env, '/api/meetings', {
      method: 'POST', cookie: board, headers: { 'Idempotency-Key': 'sc-closed-meeting-01' },
      body: { schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie roku', scheduledAt: '2026-10-10T17:00:00Z' },
    });
    await closeYear(db, YEAR);

    const closed = { status: 409, body: { error: 'school_year_closed' } };
    assert.deepEqual(await status(env, '/api/payments', {
      method: 'POST', cookie: treasurer, headers: { 'Idempotency-Key': 'sc-closed-pay-02' },
      body: { householdId: 'h-sc-1', schoolYearId: YEAR, amountCents: 700, receivedOn: '2027-08-30', method: 'bank' },
    }), closed);
    assert.deepEqual(await status(env, `/api/payments/${payment.body.payment.id}/corrections`, {
      method: 'POST', cookie: treasurer, headers: { 'Idempotency-Key': 'sc-closed-corr-01' },
      body: { amountCents: 100, reason: 'Korekta po zamknięciu' },
    }), closed);
    assert.deepEqual(await status(env, '/api/ledger', {
      method: 'POST', cookie: treasurer, body: ledgerInput, headers: { 'Idempotency-Key': 'sc-closed-ledger-01' },
    }), closed);
    assert.deepEqual(await status(env, `/api/events/${event.body.event.id}`, {
      method: 'PATCH', cookie: board, body: { revision: 1, title: 'Zmiana po zamknięciu' },
    }), closed);
    assert.deepEqual(await status(env, `/api/meetings/${meeting.body.meeting.id}`, {
      method: 'PATCH', cookie: board, body: { title: 'Zmiana po zamknięciu' },
    }), closed);
    assert.deepEqual(await status(env, '/api/meetings', {
      method: 'POST', cookie: board, headers: { 'Idempotency-Key': 'sc-closed-meeting-02' },
      body: { schoolYearId: YEAR, kind: 'plenary', title: 'Nowe zebranie', scheduledAt: '2027-06-10T17:00:00Z' },
    }), closed);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_entries')).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

// ---------- zebrania: pozostałe błędy triggerów to 409, nie 503 ----------

// Opakowanie bazy, które symuluje odmowę triggera dla wskazanej instrukcji
// (ścieżki nieosiągalne z API, ale mapowanie musi dać kod reguły, nie awarię).
function failingDb(db, pattern, message) {
  const wrap = (executor) => ({
    query(sql, params) {
      if (pattern.test(sql)) return Promise.reject(new Error(message));
      return executor.query(sql, params);
    },
  });
  return { ...wrap(db), transaction: (work) => db.transaction((tx) => work(wrap(tx))) };
}

test('zebrania: minutes_must_start_as_draft i meetings_cannot_be_deleted dają 409', async () => {
  const db = await baseDb();
  try {
    const actor = { userId: 'u-sc-seed', grants: [{ role: 'board', classId: null, schoolYearId: YEAR }], mfaVerified: false };
    const { meeting } = await createMeeting(db, actor, {
      idempotencyKey: 'sc-trigger-meeting-1', schoolYearId: YEAR, kind: 'plenary', title: 'Zebranie',
      scheduledAt: '2026-10-10T17:00:00Z', status: 'scheduled',
    });
    await updateMeeting(db, actor, { meetingId: meeting.id, status: 'held' });
    await assert.rejects(
      createMinutesVersion(failingDb(db, /INSERT INTO meeting_minutes/, 'minutes_must_start_as_draft'), actor, {
        idempotencyKey: 'sc-trigger-minutes-1', meetingId: meeting.id, body: 'Protokół syntetyczny zebrania.',
      }),
      { code: 'minutes_must_start_as_draft', status: 409 },
    );
    await assert.rejects(
      updateMeeting(failingDb(db, /UPDATE meetings/, 'meetings_cannot_be_deleted'), actor, { meetingId: meeting.id, title: 'Zmiana' }),
      { code: 'meetings_cannot_be_deleted', status: 409 },
    );
  } finally {
    await db.close();
  }
});
