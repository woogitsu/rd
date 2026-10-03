// #184 pkt 1 i 3 (etap 3: kontrola domeny dziennika admina): ślad odmowy 403 (bez PII, jedno zdarzenie na okno 5 minut
// z licznikiem w access_denial_windows — migracja 0160, tylko dla zalogowanego
// aktora, także dla żądań zmieniających stan) i zaostrzenie assertNoPii dla
// pól-kodów. Dane wyłącznie syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgHandler, handlePgRequest, ROUTES } from '../src/pg/app.js';
import {
  loadAuthorizationContext, logAccessDenied, logDeferredAccessDenied, requireAccess, withDeferredAccessDenied,
} from '../src/pg/authorization.js';
import { assertNoPii } from '../src/pg/audit.js';
import { requireAuditDomains } from '../src/pg/routes/admin.js';
import {
  createTestDb, request, seedClass, seedEnrolledHousehold, seedSchoolYear, seedUserSession,
} from './helpers/pg.js';

const financeProbe = {
  name: 'finance-probe',
  async handle(req, env, url, json) {
    if (url.pathname !== '/api/probe/finance') return null;
    const access = await requireAccess(req, env, { roles: ['treasurer'], requireMfa: true }, json);
    if (access.response) return access.response;
    return json({ ok: true });
  },
};
// Trasa klasowa: przedstawiciel ma dostęp wyłącznie do przypisanych klas.
const classProbe = {
  name: 'class-probe',
  async handle(req, env, url, json) {
    const match = /^\/api\/probe\/classes\/([^/]+)$/.exec(url.pathname);
    if (!match) return null;
    const access = await requireAccess(req, env, { roles: ['representative'], classId: match[1], schoolYearId: 'y-test' }, json);
    if (access.response) return access.response;
    return json({ ok: true });
  },
};
const probeHandler = createPgHandler([...ROUTES, financeProbe, classProbe]);

async function withDb(fn) {
  const db = await createTestDb();
  try { return await fn(db, { db }); } finally { await db.close(); }
}

async function accessDeniedEvents(db, actorId) {
  const { rows } = await db.query(
    `SELECT a.id, a.entity_type, a.entity_id, a.metadata_json, w.denial_count, w.method
       FROM audit_events a LEFT JOIN access_denial_windows w ON w.audit_event_id = a.id
      WHERE a.actor_id = $1 AND a.action = 'access.denied' ORDER BY a.occurred_at, a.id`,
    [actorId],
  );
  return rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    route: row.entity_id,
    count: row.denial_count,
    method: row.method,
    metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
  }));
}

const representative = (db, userId) => seedUserSession(db, {
  userId, mfa: true, roles: [{ role: 'representative', classId: 'c-1a' }],
});

test('representative denied a finance route leaves exactly one access.denied event with a window', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep1');
  const res = await probeHandler(request('/api/probe/finance?householdId=h-secret', { cookie }), env);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
  const events = await accessDeniedEvents(db, 'rep1');
  assert.equal(events.length, 1);
  assert.equal(events[0].entityType, 'route');
  // Ścieżka bez parametrów zapytania.
  assert.equal(events[0].route, '/api/probe/finance');
  assert.equal(events[0].metadata.method, 'GET');
  assert.equal(events[0].metadata.requiredRole, 'treasurer');
  assert.equal(typeof events[0].metadata.sessionId, 'string');
  assert.equal(events[0].count, 1);
  // Bez PII: bez adresu e-mail i bez wartości z zapytania w metadanych.
  assert.doesNotMatch(JSON.stringify(events[0].metadata), /@|h-secret/);
  assert.doesNotThrow(() => assertNoPii(events[0].metadata));
}));

test('10 denials within 5 minutes → one event with counter 10; an expired window opens a new event', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep2');
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await probeHandler(request('/api/probe/finance', { cookie }), env)).status, 403);
  }
  const events = await accessDeniedEvents(db, 'rep2');
  assert.equal(events.length, 1);
  assert.equal(events[0].count, 10);

  // Okno sprzed 10 minut innego aktora (tryb odtworzenia — inaczej stempel
  // zegara bazy z 0144 przestawiłby znacznik na now()): wygasłe, więc nowa
  // odmowa otwiera nowe zdarzenie, a stare okno zostaje bez zmian.
  const oldCookie = await representative(db, 'rep2b');
  await db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('rd.restore', 'on', true)`);
    await tx.query(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
       VALUES ('ae-old-denied', 'rep2b', 'access.denied', 'route', '/api/probe/finance', now() - interval '10 minutes', '{"method":"GET"}'::jsonb)`,
    );
    await tx.query(
      `INSERT INTO access_denial_windows (id, audit_event_id, actor_id, method, route, denial_count, first_denied_at, last_denied_at)
       VALUES ('00000000-0000-4000-8000-000000000184', 'ae-old-denied', 'rep2b', 'GET', '/api/probe/finance', 3,
               now() - interval '10 minutes', now() - interval '9 minutes')`,
    );
  });
  assert.equal((await probeHandler(request('/api/probe/finance', { cookie: oldCookie }), env)).status, 403);
  const after = await accessDeniedEvents(db, 'rep2b');
  assert.equal(after.length, 2);
  assert.deepEqual(after.map((event) => event.count), [3, 1]);
}));

test('anonymous 401 (GET and POST) leaves no access.denied event', async () => withDb(async (db, env) => {
  assert.equal((await probeHandler(request('/api/probe/finance'), env)).status, 401);
  assert.equal((await probeHandler(request('/api/probe/finance', { method: 'POST', body: {} }), env)).status, 401);
  const { rows } = await db.query(`SELECT 1 FROM audit_events WHERE action = 'access.denied'`);
  assert.equal(rows.length, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM access_denial_windows')).rows[0].n, 0);
}));

test('state-changing denial: representative POST /api/payments → 403, one access.denied; 10 attempts → counter 10', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep3');
  const body = {
    householdId: 'h1', schoolYearId: 'y-test', amountCents: 7500,
    receivedOn: '2026-09-20', method: 'bank', reference: 'synthetic-reference',
  };
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await handlePgRequest(request('/api/payments', {
      method: 'POST', cookie, body, headers: { 'Idempotency-Key': `rep3-pay-key-${String(i).padStart(4, '0')}` },
    }), env);
    assert.equal(res.status, 403);
  }
  const events = await accessDeniedEvents(db, 'rep3');
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '/api/payments');
  assert.equal(events[0].method, 'POST');
  assert.equal(events[0].metadata.method, 'POST');
  assert.equal(events[0].count, 10);
  // Odmowa nie zapisała nic poza śladem odmowy.
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_entries')).rows[0].n, 0);
  const { rows } = await db.query(`SELECT action FROM audit_events WHERE actor_id = 'rep3'`);
  assert.deepEqual(rows.map((row) => row.action), ['access.denied']);
}));

test('GET and POST on the same path are separate windows', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep4');
  assert.equal((await probeHandler(request('/api/probe/finance', { cookie }), env)).status, 403);
  assert.equal((await probeHandler(request('/api/probe/finance', { method: 'POST', cookie, body: {} }), env)).status, 403);
  assert.equal((await probeHandler(request('/api/probe/finance', { method: 'POST', cookie, body: {} }), env)).status, 403);
  const events = await accessDeniedEvents(db, 'rep4');
  assert.deepEqual(events.map((event) => [event.method, event.count]).sort(), [['GET', 1], ['POST', 2]]);
}));

test('email: representative approving a campaign → 403 and access.denied (POST)', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep5');
  const res = await handlePgRequest(request('/api/email/campaigns/camp-x/approve', {
    method: 'POST', cookie, body: { contentHash: 'a'.repeat(64), recipientsHash: 'b'.repeat(64) },
  }), env);
  assert.equal(res.status, 403);
  const events = await accessDeniedEvents(db, 'rep5');
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '/api/email/campaigns/camp-x/approve');
  assert.equal(events[0].method, 'POST');
}));

test('representative of two classes: own classes pass without an event, a class outside the assignment → 403 + event', async () => withDb(async (db, env) => {
  await seedClass(db, { id: 'c-1c' });
  const cookie = await seedUserSession(db, {
    userId: 'rep6', mfa: true, roles: [{ role: 'representative', classId: 'c-1a' }, { role: 'representative', classId: 'c-1b' }],
  });
  assert.equal((await probeHandler(request('/api/probe/classes/c-1a', { cookie }), env)).status, 200);
  assert.equal((await probeHandler(request('/api/probe/classes/c-1b', { cookie }), env)).status, 200);
  assert.equal((await probeHandler(request('/api/probe/classes/c-1c', { cookie }), env)).status, 403);
  const events = await accessDeniedEvents(db, 'rep6');
  assert.deepEqual(events.map((event) => event.route), ['/api/probe/classes/c-1c']);
}));

test('access_denial_windows: only the counter moves; no rewrite, no delete, no truncate', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep7');
  assert.equal((await probeHandler(request('/api/probe/finance', { cookie }), env)).status, 403);
  await assert.rejects(db.query(`UPDATE access_denial_windows SET route = '/api/other'`), /access_denial_window_immutable/);
  await assert.rejects(db.query('UPDATE access_denial_windows SET denial_count = 0'), /access_denial_window_immutable|check/i);
  await assert.rejects(db.query(`UPDATE access_denial_windows SET first_denied_at = now() - interval '1 hour'`), /access_denial_window_immutable/);
  await assert.rejects(db.query('DELETE FROM access_denial_windows'), /access_denial_windows_cannot_be_deleted/);
  await assert.rejects(db.query('TRUNCATE access_denial_windows'));
  await db.query('UPDATE access_denial_windows SET denial_count = denial_count + 1');
  assert.equal((await accessDeniedEvents(db, 'rep7'))[0].count, 2);
}));

test('failure of the denial log never changes the 403 response', async () => withDb(async (db) => {
  const cookie = await representative(db, 'rep8');
  // Baza, która odmawia każdej transakcji (np. awaria połączenia przy zapisie).
  const broken = new Proxy(db, {
    get(target, key) {
      if (key === 'transaction') return async () => { throw new Error('synthetic_failure'); };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const res = await probeHandler(request('/api/probe/finance', { cookie }), { db: broken });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
  // Bez aktora (kontekst bez sesji) — nic się nie zapisuje.
  await logAccessDenied({ db }, null, { roles: ['treasurer'] }, request('/api/probe/finance'));
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.denied'`)).rows[0].n, 0);
}));

test('admin audit list shows the denial counter on access.denied', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep9');
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await probeHandler(request('/api/probe/finance', { method: 'POST', cookie, body: {} }), env);
  }
  const admin = await seedUserSession(db, { userId: 'adm1', mfa: true, roles: [{ role: 'admin' }] });
  const res = await handlePgRequest(request('/api/admin/audit?domain=access', { cookie: admin }), env);
  assert.equal(res.status, 200);
  const { events } = await res.json();
  const denied = events.filter((event) => event.action === 'access.denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].actorId, 'rep9');
  assert.equal(denied[0].denialCount, 3);
  assert.equal(denied[0].metadata.method, 'POST');
  // Inne zdarzenia nie mają licznika odmów.
  assert.deepEqual(events.filter((event) => event.action !== 'access.denied' && 'denialCount' in event), []);
}));

test('assertNoPii rejects free text in code-only fields, accepts a code', () => {
  assert.throws(() => assertNoPii({ reason: 'Jan Kowalski' }), /audit_metadata_pii/);
  assert.doesNotThrow(() => assertNoPii({ reason: 'user_disabled' }));
  assert.throws(() => assertNoPii({ status: 'Zatwierdzone przez zarząd' }), /audit_metadata_pii/);
  assert.doesNotThrow(() => assertNoPii({ status: 'sending' }));
});

// ---------- #184 etap 2: ślad odmowy w bramkach pozostałych modułów ----------

// Jedno żądanie → status i kod odpowiedzi (semantyka 403 bez zmian).
async function statusOf(env, path, options) {
  const res = await handlePgRequest(request(path, options), env);
  const text = await res.text();
  return { status: res.status, error: text ? JSON.parse(text).error : null };
}

async function expectOneDenial(db, actorId, route, method, count = 1) {
  const events = await accessDeniedEvents(db, actorId);
  assert.deepEqual(events.map((event) => [event.route, event.method, event.count]), [[route, method, count]]);
  assert.doesNotThrow(() => assertNoPii(events[0].metadata));
  return events[0];
}

test('families: audit role on the class list and a class-scoped board adding a household → 403 + access.denied', async () => withDb(async (db, env) => {
  const audit = await seedUserSession(db, { userId: 'kr-fam', mfa: true, roles: [{ role: 'audit' }] });
  assert.deepEqual(await statusOf(env, '/api/classes', { cookie: audit }), { status: 403, error: 'forbidden' });
  const event = await expectOneDenial(db, 'kr-fam', '/api/classes', 'GET');
  assert.equal(event.metadata.requiredRole, 'admin,board,treasurer,representative');

  const boardA = await seedUserSession(db, { userId: 'board-fam', mfa: true, roles: [{ role: 'board', classId: 'c-1a' }] });
  const body = { householdId: 'h-x', isPrimary: false, startsOn: '2026-09-01', reason: 'Dodanie syntetyczne' };
  assert.deepEqual(await statusOf(env, '/api/students/s-x/households', { method: 'POST', cookie: boardA, body }),
    { status: 403, error: 'forbidden' });
  await expectOneDenial(db, 'board-fam', '/api/students/s-x/households', 'POST');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM student_households')).rows[0].n, 0);
}));

test('events: representative creating an event for a class outside the assignment; double click (PGlite: ponowienie po kolei) → one event, counter 2', async () => withDb(async (db, env) => {
  await seedClass(db, { id: 'c-1b' });
  const cookie = await representative(db, 'rep-ev');
  const create = (classId, key) => statusOf(env, '/api/events', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key },
    body: { schoolYearId: 'y-test', classId, title: 'Wydarzenie syntetyczne', startsAt: '2026-11-12T18:30', audience: 'internal' },
  });
  // Własna klasa: bez śladu odmowy.
  assert.equal((await create('c-1a', 'rep-ev-own-0001')).status, 201);
  assert.deepEqual(await accessDeniedEvents(db, 'rep-ev'), []);
  // Podwójne kliknięcie (ten sam klucz) na klasie spoza przydziału.
  assert.deepEqual(await create('c-1b', 'rep-ev-other-0001'), { status: 403, error: 'forbidden' });
  assert.deepEqual(await create('c-1b', 'rep-ev-other-0001'), { status: 403, error: 'forbidden' });
  await expectOneDenial(db, 'rep-ev', '/api/events', 'POST', 2);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM events WHERE class_id = 'c-1b'`)).rows[0].n, 0);
}));

test('meetings: representative listing meetings → 403 + access.denied (GET)', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep-mt');
  assert.deepEqual(await statusOf(env, '/api/meetings?schoolYearId=y-test', { cookie }), { status: 403, error: 'forbidden' });
  const event = await expectOneDenial(db, 'rep-mt', '/api/meetings', 'GET');
  assert.equal(event.metadata.requiredRole, null);
}));

test('news: representative creating a school-wide post → 403 + access.denied (POST)', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep-nw');
  assert.deepEqual(await statusOf(env, '/api/news', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': 'rep-nw-key-0001' },
    body: { schoolYearId: 'y-test', classId: null, title: 'Wpis syntetyczny', body: 'Treść syntetyczna.' },
  }), { status: 403, error: 'forbidden' });
  await expectOneDenial(db, 'rep-nw', '/api/news', 'POST');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM news_posts')).rows[0].n, 0);
}));

test('exports: representative yearly export and a roster of a class outside the assignment → 403 + access.denied', async () => withDb(async (db, env) => {
  await seedClass(db, { id: 'c-1b' });
  const cookie = await representative(db, 'rep-ex');
  assert.deepEqual(await statusOf(env, '/api/exports', { method: 'POST', cookie, body: { schoolYearId: 'y-test' } }),
    { status: 403, error: 'forbidden' });
  await expectOneDenial(db, 'rep-ex', '/api/exports', 'POST');
  assert.deepEqual(await statusOf(env, '/api/exports/class-roster?classId=c-1b', { cookie }), { status: 403, error: 'forbidden' });
  const routes = (await accessDeniedEvents(db, 'rep-ex')).map((event) => [event.route, event.method]);
  assert.deepEqual(routes, [['/api/exports', 'POST'], ['/api/exports/class-roster', 'GET']]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM export_runs')).rows[0].n, 0);
}));

test('year close: representative reading the close status → 403 + access.denied', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep-yc');
  assert.deepEqual(await statusOf(env, '/api/year-close/y-test', { cookie }), { status: 403, error: 'forbidden' });
  await expectOneDenial(db, 'rep-yc', '/api/year-close/y-test', 'GET');
}));

test('audit committee report: representative → 403 + access.denied, no report.audit.generated', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep-kr');
  assert.deepEqual(await statusOf(env, '/api/reports/audit?schoolYearId=y-test&format=json', { cookie }), { status: 403, error: 'forbidden' });
  await expectOneDenial(db, 'rep-kr', '/api/reports/audit', 'GET');
  const { rows } = await db.query(`SELECT action FROM audit_events WHERE actor_id = 'rep-kr'`);
  assert.deepEqual(rows.map((row) => row.action), ['access.denied']);
}));

test('board overview and representative overview: role outside the gate → 403 + access.denied', async () => withDb(async (db, env) => {
  const cookie = await representative(db, 'rep-bo');
  assert.deepEqual(await statusOf(env, '/api/board/overview?schoolYearId=y-test', { cookie }), { status: 403, error: 'forbidden' });
  const treasurer = await seedUserSession(db, { userId: 'tr-ro', mfa: true, roles: [{ role: 'treasurer' }] });
  assert.deepEqual(await statusOf(env, '/api/representative/overview?schoolYearId=y-test', { cookie: treasurer }), { status: 403, error: 'forbidden' });
  await expectOneDenial(db, 'rep-bo', '/api/board/overview', 'GET');
  await expectOneDenial(db, 'tr-ro', '/api/representative/overview', 'GET');
}));

test('denial detected inside the request transaction (payment of another year) → 403, event written after rollback', async () => withDb(async (db, env) => {
  await seedSchoolYear(db, 'y-other', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedEnrolledHousehold(db, 'h1', ['y-test']);
  const owner = await seedUserSession(db, { userId: 'tr-own', mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y-test' }] });
  const created = await handlePgRequest(request('/api/payments', {
    method: 'POST', cookie: owner, headers: { 'Idempotency-Key': 'tr-own-pay-0001' },
    body: { householdId: 'h1', schoolYearId: 'y-test', amountCents: 7500, receivedOn: '2026-09-20', method: 'bank', reference: 'synthetic-reference' },
  }), env);
  assert.equal(created.status, 201);
  const paymentId = (await created.json()).payment.id;

  // Skarbnik innego roku: rola i MFA pasują (bramka przed transakcją przepuszcza),
  // odmowa zakresu roku zapada dopiero po odczycie wpłaty w transakcji.
  const other = await seedUserSession(db, { userId: 'tr-other', mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y-other' }] });
  const correct = () => statusOf(env, `/api/payments/${paymentId}/corrections`, {
    method: 'POST', cookie: other, headers: { 'Idempotency-Key': 'tr-other-cor-0001' },
    body: { amountCents: 5000, reason: 'Korekta syntetyczna' },
  });
  assert.deepEqual(await correct(), { status: 403, error: 'forbidden' });
  assert.deepEqual(await correct(), { status: 403, error: 'forbidden' });
  const event = await expectOneDenial(db, 'tr-other', `/api/payments/${paymentId}/corrections`, 'POST', 2);
  assert.equal(event.metadata.requiredRole, 'admin,board,treasurer');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_corrections')).rows[0].n, 0);
  const { rows } = await db.query(`SELECT action FROM audit_events WHERE actor_id = 'tr-other'`);
  assert.deepEqual(rows.map((row) => row.action), ['access.denied']);
}));

test('deferred denial: logged once per error, never without an actor', async () => withDb(async (db) => {
  const cookie = await representative(db, 'rep-df');
  const context = await loadAuthorizationContext(request('/api/x', { cookie }), { db });
  const error = withDeferredAccessDenied(new Error('forbidden'), context, { roles: ['treasurer'] });
  await logDeferredAccessDenied({ db }, error, request('/api/probe/deferred', { method: 'POST', body: {} }));
  await logDeferredAccessDenied({ db }, error, request('/api/probe/deferred', { method: 'POST', body: {} }));
  await logDeferredAccessDenied({ db }, new Error('other'), request('/api/probe/deferred', { method: 'POST', body: {} }));
  await logDeferredAccessDenied({ db }, withDeferredAccessDenied(new Error('x'), null, null), request('/api/probe/deferred'));
  await expectOneDenial(db, 'rep-df', '/api/probe/deferred', 'POST', 1);
}));

test('MFA-only denial (403 mfa_* code) leaves no access.denied; only `forbidden` does', async () => withDb(async (db, env) => {
  const cookie = await seedUserSession(db, { userId: 'rep-nomfa', mfa: false, roles: [{ role: 'representative', classId: 'c-1a' }] });
  // Własna klasa, konto bez czynnika: kod prowadzący do zapisu MFA (#161), bez śladu.
  assert.deepEqual(await statusOf(env, '/api/exports/class-roster?classId=c-1a', { cookie }),
    { status: 403, error: 'mfa_enrollment_required' });
  assert.deepEqual(await accessDeniedEvents(db, 'rep-nomfa'), []);
  // Raport KR: rola spoza bramki → `forbidden` i ślad.
  assert.deepEqual(await statusOf(env, '/api/reports/audit?schoolYearId=y-test&format=json', { cookie }),
    { status: 403, error: 'forbidden' });
  await expectOneDenial(db, 'rep-nomfa', '/api/reports/audit', 'GET');
}));

// #184 etap 3: druga linia w dzienniku admina — kontrola domeny (`readRoles`).
// Przez HTTP nieosiągalna (moduł wpuszcza tylko admina, każda domena ma dziś
// `readRoles: ['admin']`), więc test woła bramkę bezpośrednio z kontekstem
// konta bez roli admin — tak jak po zawężeniu `readRoles` decyzją D-08/D-09.
test('admin audit domain check: denial → forbidden + one access.denied; admin passes without an event', async () => withDb(async (db, env) => {
  const boardCookie = await seedUserSession(db, { userId: 'board-dom', mfa: true, roles: [{ role: 'board' }] });
  const boardContext = await loadAuthorizationContext(request('/api/admin/audit', { cookie: boardCookie }), env);
  const denied = () => requireAuditDomains(env, request('/api/admin/audit?domain=finance&actorId=u-secret'), boardContext, ['finance']);
  await assert.rejects(denied, (error) => error.code === 'forbidden' && error.status === 403);
  // Odświeżenie widoku w oknie 5 minut: bez nowego zdarzenia, tylko licznik.
  await assert.rejects(denied, (error) => error.code === 'forbidden');
  await expectOneDenial(db, 'board-dom', '/api/admin/audit', 'GET', 2);
  const [event] = await accessDeniedEvents(db, 'board-dom');
  assert.equal(event.metadata.requiredRole, 'admin');
  assert.doesNotMatch(JSON.stringify(event.metadata), /u-secret|finance/);

  const adminCookie = await seedUserSession(db, { userId: 'adm-dom', mfa: true, roles: [{ role: 'admin' }] });
  const adminContext = await loadAuthorizationContext(request('/api/admin/audit', { cookie: adminCookie }), env);
  await requireAuditDomains(env, request('/api/admin/audit?domain=finance'), adminContext, ['finance', 'email']);
  assert.deepEqual(await accessDeniedEvents(db, 'adm-dom'), []);
}));
