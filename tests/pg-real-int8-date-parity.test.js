// #208: parytet typów pg ↔ PGlite w kodzie produkcyjnym. Na sterowniku `pg`
// (bez setTypeParser) int8 (bigint, count(*), sum(integer), max(bigint)) wraca
// jako STRING, a kolumna DATE jako Date o północy LOKALNEJ strefy procesu;
// PGlite zwraca liczbę i północ UTC. Testy PGlite tych różnic nie wykryją.
// Plik wymaga RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany.
// Dane wyłącznie syntetyczne (@example.invalid); żadnej sieci i e-maili.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import {
  createMeeting, createResolution, determineQuorum, listResolutionRegister, recordAttendance, recordResolutionExecution,
} from '../src/pg/meetings.js';
import { createRealTestDb, request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { updateMeeting } from './helpers/with-revision.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';

// `pg` buduje Date z DATE lokalnie, więc zmiana TZ w trakcie testu zmienia wynik
// parsowania (Node odczytuje process.env.TZ przy każdej zmianie).
async function inTimeZone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
}
// Skrajne strefy: na wschód od UTC (północ lokalna = poprzedni dzień UTC) i na zachód.
const ZONES = ['Pacific/Kiritimati', 'Europe/Brussels', 'Pacific/Pago_Pago'];

async function withEnv(fn) {
  const db = await createRealTestDb();
  try { return await fn({ db, env: { db } }); } finally { await db.close(); }
}

async function call(env, path, { cookie, method = 'GET', body } = {}) {
  const response = await handlePgRequest(request(path, { method, cookie, body }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

test('sanity: pg zwraca int8 jako string, a DATE jako Date (założenie testów w tym pliku)', { skip }, async () => {
  await withEnv(async ({ db }) => {
    const { rows } = await db.query("SELECT count(*) AS n, 1::bigint AS b, '2026-09-01'::date AS d");
    assert.equal(typeof rows[0].n, 'string');
    assert.equal(typeof rows[0].b, 'string');
    assert.ok(rows[0].d instanceof Date);
  });
});

for (const zone of ZONES) test(`rejestr żądań osób: receivedOn/dueOn to sama data YYYY-MM-DD (TZ ${zone})`, { skip }, async () => {
  await inTimeZone(zone, () => withEnv(async ({ db, env }) => {
    await db.exec(`INSERT INTO households (id) VALUES ('h-1');`);
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    const created = await call(env, '/api/admin/data-requests', {
      method: 'POST', cookie: admin, body: { kind: 'access', householdId: 'h-1', receivedOn: '2026-10-01', dueOn: '2026-10-31' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.request.receivedOn, '2026-10-01');
    assert.equal(created.data.request.dueOn, '2026-10-31');
    const list = await call(env, '/api/admin/data-requests', { cookie: admin });
    assert.equal(list.status, 200);
    assert.equal(list.data.requests.length, 1);
    assert.equal(list.data.requests[0].receivedOn, '2026-10-01');
    assert.equal(list.data.requests[0].dueOn, '2026-10-31');
  }));
});

const grant = (role) => ({ role, classId: null, schoolYearId: 'year', expiresAt: null });
const board = { userId: 'board', grants: [grant('board')], mfaVerified: true };

// Rok szkolny od 1 stycznia: podpowiedź numeru uchwały `{year}` musi dać rok z daty
// startu roku, nie rok z Date w UTC (północ lokalna na wschód od UTC to poprzedni rok).
for (const zone of ZONES) test(`podpowiedź numeru uchwały: {year} z daty startu roku (1 stycznia, TZ ${zone})`, { skip }, async () => {
  await inTimeZone(zone, () => withEnv(async ({ db }) => {
    await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on, resolution_number_pattern)
      VALUES ('year', 'syntetyczny rok', '2027-01-01', '2027-12-31', '{seq}/{year}')`);
    await db.query("INSERT INTO users (id, email, display_name) VALUES ('board', 'board@example.invalid', 'Synthetic board')");
    const { meeting } = await createMeeting(db, board, {
      idempotencyKey: 'int8-date-key-0001', schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
      scheduledAt: '2027-02-10T17:00:00Z', status: 'scheduled',
      quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Założenie testowe',
    });
    await updateMeeting(db, board, { meetingId: meeting.id, status: 'held' });
    const created = await createResolution(db, board, {
      idempotencyKey: 'int8-date-key-0002', meetingId: meeting.id, title: 'Projekt', body: 'Treść syntetyczna.',
    });
    assert.equal(created.suggestedNumber, '1/2027');
  }));
});

// Termin wykonania uchwały to sama data: północ lokalna z `pg` + toISOString() dawała
// w strefie na wschód od UTC dzień wcześniej (w rejestrze i w odpowiedzi zapisu).
for (const zone of ZONES) test(`wykonanie uchwały: dueOn bez przesunięcia dnia (TZ ${zone})`, { skip }, async () => {
  await inTimeZone(zone, () => withEnv(async ({ db }) => {
    await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on)
      VALUES ('year', 'syntetyczny rok', '2026-09-01', '2027-08-31')`);
    for (const id of ['board', 'u1']) {
      await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [id, `${id}@example.invalid`, `Synthetic ${id}`]);
    }
    await db.query("INSERT INTO role_grants (id, user_id, role) VALUES ('grant-u1', 'u1', 'board')");
    const { meeting } = await createMeeting(db, board, {
      idempotencyKey: 'int8-date-key-0101', schoolYearId: 'year', kind: 'plenary', title: 'Zebranie plenarne',
      scheduledAt: '2026-10-10T17:00:00Z', status: 'scheduled',
      quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Założenie testowe',
    });
    await updateMeeting(db, board, { meetingId: meeting.id, status: 'held' });
    await recordAttendance(db, board, { meetingId: meeting.id, userId: 'u1', capacity: 'board_member', votingEligible: true, present: true });
    const { quorumCheck } = await determineQuorum(db, board, { idempotencyKey: 'int8-date-key-0102', meetingId: meeting.id });
    const { resolution } = await createResolution(db, board, {
      idempotencyKey: 'int8-date-key-0103', meetingId: meeting.id, title: 'Uchwała 1', body: 'Treść syntetyczna.',
      status: 'adopted', number: 'U-1/2026', votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    });
    const recorded = await recordResolutionExecution(db, board, {
      idempotencyKey: 'int8-date-key-0104', resolutionId: resolution.id, status: 'in_progress', dueOn: '2026-10-31',
    });
    assert.equal(recorded.execution.dueOn, '2026-10-31');
    const { resolutions } = await listResolutionRegister(db, board, { schoolYearId: 'year' });
    const item = resolutions.find((row) => row.id === resolution.id);
    assert.ok(item, 'uchwała jest w rejestrze');
    assert.equal(item.execution.dueOn, '2026-10-31');
  }));
});

// Kontrakt liczbowy: liczniki z count(*)/count(DISTINCT) (int8 → string na `pg`) wracają
// w JSON jako liczby. Test chroni rzutowanie/Number() przed regresją, której PGlite nie zauważy.
test('obsada klas: liczniki w JSON są liczbami (count(*) to string na pg)', { skip }, async () => {
  await withEnv(async ({ db, env }) => {
    await seedSchoolYear(db, 'y-2026');
    await seedClass(db, { id: 'c-1a', schoolYearId: 'y-2026', name: '1A' });
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    await db.query("INSERT INTO users (id, email, display_name) VALUES ('u-rep', 'rep@example.invalid', 'Synthetic rep')");
    await db.query(`INSERT INTO role_grants (id, user_id, role, class_id, school_year_id, granted_by)
      VALUES ('g-1', 'u-rep', 'representative', 'c-1a', 'y-2026', 'u-admin')`);
    const coverage = await call(env, '/api/admin/class-coverage?schoolYearId=y-2026', { cookie: admin });
    assert.equal(coverage.status, 200);
    assert.equal(coverage.data.classes.length, 1);
    const [row] = coverage.data.classes;
    for (const field of ['activeRepresentativeCount', 'pendingInvitationCount', 'neverLoggedInRepresentativeCount', 'mfaEnrolledRepresentativeCount']) {
      assert.equal(typeof row[field], 'number', field);
    }
    assert.equal(row.activeRepresentativeCount, 1);
    assert.equal(row.pendingInvitationCount, 0);
  });
});
