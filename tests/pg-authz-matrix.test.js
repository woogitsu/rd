// Macierz autoryzacji na rzeczywistych trasach API PostgreSQL (issue #4).
//
// Dla każdej trasy z tests/helpers/route-matrix.js i każdego aktora (role, brak
// przydziału, przydział wygasły/cofnięty, konto wyłączone, sesja wygasła/cofnięta,
// brak sesji) × MFA wł./wył. × zakres (własna klasa / inna klasa / dane ogólnoszkolne /
// inny rok) sprawdzamy:
//   1. status HTTP (401 / 403 / 404 / 2xx) zgodny z tabelą,
//   2. odpowiedź odmowna nie zawiera żadnego syntetycznego znacznika danych,
//   3. odpowiedź 2xx nie zawiera znaczników zakresu, do którego aktor nie ma przydziału
//      (np. przedstawiciel 1A nigdy nie widzi danych 1B ani roku 2),
//   4. odmowa żądania zmieniającego stan niczego nie zapisuje (liczniki tabel i dziennika zdarzeń bez zmian).
// Meta-test pilnuje, by każdy moduł z ROUTES i każda ścieżka w jego kodzie miały wpis w macierzy.
// Wyłącznie dane syntetyczne (domeny .invalid, znaczniki MRK-…).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handlePgRequest, ROUTES } from '../src/pg/app.js';
import { approve, createDraft, publish, submit } from '../src/pg/events.js';
import {
  approveMinutes, createMeeting, createMinutesVersion, createResolution, determineQuorum,
  recordAttendance, setMinutesVisibility, updateMeeting,
} from '../src/pg/meetings.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';
import {
  ACTOR_KEYS, ACTORS, MARKERS, ROUTE_MATRIX, SCOPED_MARKER_KEYS, TARGETS, YEAR_1, YEAR_2,
  expectedStatus, marker, visibleScopes,
} from './helpers/route-matrix.js';

const PAST = '2020-01-01T00:00:00Z';
const fxAdmin = { userId: 'u-fx-admin', grants: [{ role: 'admin', classId: null, schoolYearId: null }], mfaVerified: true };
const fxBoard = { userId: 'u-fx-board', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };

let seq = 0;
const nextKey = (prefix) => `${prefix}-${String(++seq).padStart(5, '0')}`;
const isSuccess = (status) => status >= 200 && status < 300;

// ---------- fixtures ----------

async function seedBase(db) {
  await seedSchoolYear(db, YEAR_1, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, YEAR_2, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  for (const target of [TARGETS.A, TARGETS.B, TARGETS.Y2]) {
    await seedClass(db, { id: target.classId, schoolYearId: target.schoolYearId });
  }
  await seedUser(db, { userId: fxAdmin.userId });
  await seedUser(db, { userId: fxBoard.userId });
  await db.query("INSERT INTO households (id) VALUES ('hh-1')");
}

async function makeEvent(db, target, stage, { audience = 'internal', title } = {}) {
  const publicStage = stage === 'approved' || stage === 'published';
  const { event } = await createDraft(db, fxAdmin, {
    schoolYearId: target.schoolYearId, classId: target.classId,
    // Wydarzenia, które mogą trafić do publicznego kalendarza, niosą tylko znacznik jawny.
    title: title ?? `Wydarzenie ${publicStage ? marker('PUBLIC') : marker(target.key)}`,
    startsAt: '2026-11-12T18:30', audience: publicStage ? 'public' : audience,
    idempotencyKey: nextKey('fx-event'),
  });
  if (stage === 'draft') return { eventId: event.id };
  await submit(db, fxAdmin, { eventId: event.id, revision: 1 });
  if (stage === 'submitted') return { eventId: event.id };
  await approve(db, fxBoard, { eventId: event.id, revision: 1 });
  if (stage === 'approved') return { eventId: event.id };
  await publish(db, fxBoard, { eventId: event.id, revision: 1 });
  return { eventId: event.id };
}

async function makeMeeting(db, target, stage, { title, minutesBody, visibility = 'parents', resolutionNumber } = {}) {
  const scopeMarker = marker(target.key);
  const { meeting } = await createMeeting(db, fxAdmin, {
    idempotencyKey: nextKey('fx-meeting'), schoolYearId: target.schoolYearId,
    kind: target.classId ? 'class' : 'plenary', classId: target.classId,
    title: title ?? `Zebranie ${scopeMarker}`, scheduledAt: '2026-10-10T17:00:00Z',
    status: stage === 'draft' ? 'draft' : 'scheduled', quorumMode: 'minimum_count', quorumMinCount: 1,
  });
  const obj = { meetingId: meeting.id };
  if (stage === 'draft') return obj;
  await updateMeeting(db, fxAdmin, { meetingId: meeting.id, status: 'held' });
  if (stage === 'held') return obj;
  if (stage === 'draftResolution') {
    const { resolution } = await createResolution(db, fxAdmin, {
      idempotencyKey: nextKey('fx-res'), meetingId: meeting.id, title: `Uchwała ${scopeMarker}`, body: 'Treść syntetyczna',
    });
    return { ...obj, resolutionId: resolution.id };
  }
  if (stage === 'finalResolution' || resolutionNumber) {
    await recordAttendance(db, fxAdmin, {
      meetingId: meeting.id, userId: fxBoard.userId, capacity: 'board_member', votingEligible: true, present: true,
    });
    const { quorumCheck } = await determineQuorum(db, fxAdmin, { idempotencyKey: nextKey('fx-quorum'), meetingId: meeting.id });
    const { resolution } = await createResolution(db, fxAdmin, {
      idempotencyKey: nextKey('fx-res'), meetingId: meeting.id, title: `Uchwała ${scopeMarker}`, body: 'Treść syntetyczna',
      status: resolutionNumber ? 'adopted' : 'rejected', number: resolutionNumber,
      votesFor: resolutionNumber ? 1 : 0, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
    });
    if (stage === 'finalResolution') return { ...obj, resolutionId: resolution.id };
  }
  const { minutes } = await createMinutesVersion(db, fxAdmin, {
    idempotencyKey: nextKey('fx-minutes'), meetingId: meeting.id,
    body: minutesBody ?? `Protokół ${scopeMarker} — treść syntetyczna.`,
  });
  if (stage === 'draftMinutes') return { ...obj, minutesId: minutes.id };
  await approveMinutes(db, fxAdmin, { minutesId: minutes.id });
  if (stage === 'approvedMinutes') return { ...obj, minutesId: minutes.id };
  await setMinutesVisibility(db, fxAdmin, { idempotencyKey: nextKey('fx-vis'), minutesId: minutes.id, visibility });
  return { ...obj, minutesId: minutes.id };
}

async function makePayment(db, target, stage) {
  const id = nextKey('fx-payment');
  const unmatched = stage === 'unmatched';
  await db.query(
    `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method,
       reference, status, created_by, idempotency_key)
     VALUES ($1, $2, $3, 100000, '2026-10-01', 'bank', $4, $5, $6, $7)`,
    [id, unmatched ? null : 'hh-1', target.schoolYearId, `Wpłata ${marker(target.key)}`,
      unmatched ? 'unmatched' : 'recorded', fxAdmin.userId, `${id}-key`],
  );
  return { paymentId: id };
}

function makeObject(db, { kind, stage }, target) {
  if (kind === 'event') return makeEvent(db, target, stage);
  if (kind === 'meeting') return makeMeeting(db, target, stage);
  if (kind === 'payment') return makePayment(db, target, stage);
  throw new Error(`unknown fixture kind ${kind}`);
}

async function seedStatic(db) {
  const fx = { events: {}, meetings: {}, payments: {}, resolutionNumber: { W1: 'UCHW/1/R1', Y2: 'UCHW/1/R2' } };
  for (const key of ['A', 'B', 'W1', 'Y2']) {
    fx.events[key] = await makeEvent(db, TARGETS[key], 'draft');
    fx.meetings[key] = await makeMeeting(db, TARGETS[key], 'shared', { resolutionNumber: fx.resolutionNumber[key] });
  }
  for (const key of ['W1', 'Y2']) fx.payments[key] = await makePayment(db, TARGETS[key], 'recorded');
  // Jawne dane: opublikowane wydarzenie i protokół publiczny bez znaczników klas.
  await makeEvent(db, TARGETS.W1, 'published', { title: `Wydarzenie ${marker('PUBLIC')}` });
  await makeMeeting(db, TARGETS.W1, 'shared', {
    title: `Zebranie jawne ${marker('PUBLIC')}`, minutesBody: `Protokół ${marker('PUBLIC')} — treść jawna.`, visibility: 'public',
  });
  return fx;
}

async function seedSessions(db) {
  const sessions = {};
  for (const actor of ACTORS) {
    if (actor.anonymous) continue;
    sessions[actor.key] = {};
    for (const mfa of [false, true]) {
      sessions[actor.key][mfa] = await seedUserSession(db, sessionOptions(actor, mfa, !mfa));
    }
  }
  return sessions;
}

function sessionOptions(actor, mfa, withGrants) {
  return {
    userId: `mx-${actor.key}`,
    roles: withGrants ? actor.grants : [],
    mfa,
    disabled: Boolean(actor.disabled),
    expiresAt: actor.sessionExpired ? PAST : undefined,
    revoked: Boolean(actor.sessionRevoked),
  };
}

const WRITE_TABLES = [
  'audit_events', 'events', 'event_revisions', 'meetings', 'meeting_agenda_items', 'meeting_attendees',
  'meeting_quorum_checks', 'meeting_minutes', 'meeting_minutes_publications', 'resolutions',
  'meeting_request_keys', 'payment_entries', 'payment_corrections', 'payment_assignments', 'role_grants',
];

async function writeFingerprint(db) {
  const { rows } = await db.query(
    `SELECT ${WRITE_TABLES.map((table) => `(SELECT count(*) FROM ${table})::int AS ${table}`).join(', ')}`,
  );
  return rows[0];
}

let shared;
async function matrixContext() {
  if (!shared) {
    shared = (async () => {
      const db = await createTestDb();
      await seedBase(db);
      const fx = await seedStatic(db);
      const sessions = await seedSessions(db);
      return { db, fx, sessions, cache: new Map() };
    })();
  }
  return shared;
}

async function objectFor(ctx, route, targetKey, expected) {
  if (!route.object) return null;
  const target = TARGETS[targetKey];
  if (route.fixture === 'fresh' && isSuccess(expected)) return makeObject(ctx.db, route.object, target);
  if (route.fixture === 'static') {
    if (route.object.kind === 'event') return ctx.fx.events[targetKey];
    if (route.object.kind === 'meeting') return ctx.fx.meetings[targetKey];
    if (route.object.kind === 'payment') return ctx.fx.payments[targetKey];
  }
  // Odmowa: obiekt wspólny dla (trasa, zakres) — odmowa nie może go zmienić.
  const cacheKey = `${route.id}:${targetKey}`;
  if (!ctx.cache.has(cacheKey)) ctx.cache.set(cacheKey, await makeObject(ctx.db, route.object, target));
  return ctx.cache.get(cacheKey);
}

function markersIn(text, scopes) {
  return scopes.flatMap((scope) => MARKERS[scope].filter((value) => text.includes(value)).map((value) => `${scope}:${value}`));
}

async function runCase(ctx, route, actor, mfa, targetKey) {
  const expected = expectedStatus(route, actor, mfa, targetKey);
  const obj = await objectFor(ctx, route, targetKey, expected);
  let cookie;
  if (!actor.anonymous) {
    cookie = route.freshSession
      ? await seedUserSession(ctx.db, sessionOptions(actor, mfa, false))
      : ctx.sessions[actor.key][mfa];
  }
  const key = `mx-${route.id}-${actor.key}-${mfa ? 'mfa' : 'nomfa'}-${targetKey === '-' ? 'x' : targetKey}-${++seq}`;
  const built = route.build({ target: TARGETS[targetKey], obj, key, fx: ctx.fx });
  // Odczyty (GET) sprawdzamy pod kątem wycieku; ślad zapisu — dla metod zmieniających stan.
  const tracksWrites = route.method !== 'GET';
  const before = tracksWrites ? await writeFingerprint(ctx.db) : null;
  const response = await handlePgRequest(request(built.path, {
    method: route.method, body: built.body, headers: built.headers ?? {}, cookie,
  }), { db: ctx.db });
  const text = await response.text();
  const label = `${route.method} ${built.path} | ${actor.key} | mfa=${mfa} | zakres=${targetKey}`;
  const problems = [];

  if (response.status !== expected) problems.push(`status ${response.status} zamiast ${expected}: ${text.slice(0, 200)}`);
  if (!isSuccess(response.status)) {
    const leaked = markersIn(text, [...SCOPED_MARKER_KEYS, 'PUBLIC']);
    if (leaked.length) problems.push(`odmowa zawiera dane: ${leaked.join(', ')}`);
    const after = tracksWrites ? await writeFingerprint(ctx.db) : before;
    const changed = tracksWrites ? WRITE_TABLES.filter((table) => after[table] !== before[table]) : [];
    if (changed.length) problems.push(`odmowa zmieniła tabele: ${changed.join(', ')}`);
  } else {
    const visible = visibleScopes(route, actor, targetKey);
    const leaked = markersIn(text, SCOPED_MARKER_KEYS.filter((scope) => !visible.includes(scope)));
    if (leaked.length) problems.push(`odpowiedź 2xx zawiera dane spoza zakresu aktora: ${leaked.join(', ')}`);
    if (route.contains && isSuccess(expected)) {
      const missing = route.contains(actor, TARGETS[targetKey]).filter((scope) => !text.includes(marker(scope)));
      if (missing.length) problems.push(`odpowiedź nie zawiera oczekiwanych danych: ${missing.join(', ')}`);
    }
  }

  if (route.id === 'session.access' && response.status === 200) {
    const { grants } = JSON.parse(text);
    const expectedGrants = ['noGrant', 'expiredGrant', 'revokedGrant'].includes(actor.key) ? 0 : actor.grants.length;
    if (grants.length !== expectedGrants) problems.push(`/api/access zwraca ${grants.length} przydziałów zamiast ${expectedGrants}`);
  }
  if (route.id === 'session.logout' && cookie) {
    const after = await handlePgRequest(request('/api/session', { cookie }), { db: ctx.db });
    if (after.status !== 401) problems.push(`sesja działa po wylogowaniu (status ${after.status})`);
  }
  return problems.map((problem) => `${label}: ${problem}`);
}

for (const route of ROUTE_MATRIX) {
  test(`macierz uprawnień: ${route.id} (${route.method} ${route.path})`, async () => {
    const ctx = await matrixContext();
    const failures = [];
    let cases = 0;
    for (const targetKey of route.targets) {
      for (const actor of ACTORS) {
        for (const mfa of [false, true]) {
          failures.push(...await runCase(ctx, route, actor, mfa, targetKey));
          cases += 1;
        }
      }
    }
    assert.equal(cases, route.targets.length * ACTORS.length * 2);
    assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
  });
}

test.after(async () => {
  if (shared) await (await shared).db.close();
});

// ---------- meta-testy: macierz musi nadążać za ROUTES ----------

test('meta: każdy moduł z ROUTES ma wpisy w macierzy i odwrotnie', () => {
  const registered = ROUTES.map((route) => route.name);
  assert.equal(new Set(registered).size, registered.length, 'moduły w ROUTES muszą mieć unikalne `name`');
  const listed = new Set(ROUTE_MATRIX.map((route) => route.module));
  for (const name of registered) {
    assert.ok(listed.has(name),
      `Moduł tras "${name}" jest w ROUTES (src/pg/app.js), ale nie ma wpisów w tests/helpers/route-matrix.js. `
      + 'Dopisz każdą jego trasę do ROUTE_MATRIX i do tabeli w docs/AUTHORIZATION.md.');
  }
  for (const name of listed) assert.ok(registered.includes(name), `Macierz opisuje moduł "${name}", którego nie ma w ROUTES`);
});

test('meta: wpisy macierzy są spójne (id, aktorzy, zakresy, statusy)', () => {
  const ids = ROUTE_MATRIX.map((route) => route.id);
  assert.equal(new Set(ids).size, ids.length, 'id tras w macierzy muszą być unikalne');
  const signatures = ROUTE_MATRIX.map((route) => `${route.method} ${route.path}`);
  assert.equal(new Set(signatures).size, signatures.length, 'para metoda + ścieżka musi być unikalna');
  for (const route of ROUTE_MATRIX) {
    assert.ok(route.targets.length > 0 && route.targets.every((key) => key in TARGETS), route.id);
    assert.ok([200, 201, 204].includes(route.ok), `${route.id}: ok`);
    if (typeof route.allow === 'object') {
      assert.ok([403, 404].includes(route.deny), `${route.id}: deny`);
      for (const [actorKey, scopes] of Object.entries(route.allow)) {
        assert.ok(ACTOR_KEYS.includes(actorKey), `${route.id}: nieznany aktor ${actorKey}`);
        assert.ok(scopes.every((scope) => route.targets.includes(scope)), `${route.id}: zakres spoza targets`);
      }
      // Każda trasa chroniona musi mieć co najmniej jeden przypadek odmowy dla innego roku.
      if (route.targets.includes('Y2')) {
        assert.ok(Object.values(route.allow).every((scopes) => !scopes.includes('Y2')), `${route.id}: Y2`);
      }
    } else {
      assert.ok(['authenticated', 'public'].includes(route.allow), route.id);
    }
  }
});

const MODULE_SOURCES = {
  session: ['../src/pg/routes/session.js'],
  payments: ['../src/pg/routes/payments.js'],
  events: ['../src/pg/routes/events.js', '../src/pg/events.js'],
  meetings: ['../src/pg/routes/meetings.js', '../src/pg/meetings.js'],
};

// Segmenty ścieżek widoczne w kodzie modułu: literały '/api/…', segmenty z wyrażeń
// regularnych (\/słowo, (a|b)) i porównania w funkcji route() modułu zebrań.
function pathSegmentsInSource(source) {
  const segments = new Set();
  for (const [, literal] of source.matchAll(/'(\/api\/[a-z/-]+)'/g)) {
    for (const part of literal.split('/').filter(Boolean)) segments.add(part);
  }
  for (const [, regex] of source.matchAll(/\.match\(\/(\^\\\/api[^\n]*?)\$\/\)/g)) {
    for (const [, word] of regex.matchAll(/\\\/([a-z][a-z-]*)/g)) segments.add(word);
    for (const [, group] of regex.matchAll(/\(([a-z|]+)\)/g)) group.split('|').forEach((word) => segments.add(word));
  }
  const routeFunction = source.match(/\nfunction route\([\s\S]*?\n}\n/);
  if (routeFunction) {
    for (const [, word] of routeFunction[0].matchAll(/[a-e] === '([a-z][a-z-]*)'/g)) segments.add(word);
  }
  return segments;
}

test('meta: każda ścieżka widoczna w kodzie modułu tras jest pokryta macierzą', async () => {
  for (const route of ROUTES) {
    const files = MODULE_SOURCES[route.name];
    assert.ok(files, `Dopisz pliki źródłowe modułu "${route.name}" do MODULE_SOURCES w tym teście`);
    const covered = new Set(ROUTE_MATRIX.filter((entry) => entry.module === route.name)
      .flatMap((entry) => entry.path.split('?')[0].split('/').filter(Boolean)));
    let found = 0;
    for (const file of files) {
      const source = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      const segments = pathSegmentsInSource(source);
      found += segments.size;
      for (const segment of segments) {
        assert.ok(covered.has(segment),
          `${file}: segment ścieżki "${segment}" nie występuje w żadnym wpisie macierzy modułu "${route.name}"`);
      }
    }
    assert.ok(found > 0, `${route.name}: nie znaleziono żadnej ścieżki w kodzie — zaktualizuj pathSegmentsInSource`);
  }
});

test('meta: każda trasa macierzy jest opisana w docs/AUTHORIZATION.md', async () => {
  const doc = await readFile(fileURLToPath(new URL('../docs/AUTHORIZATION.md', import.meta.url)), 'utf8');
  for (const route of ROUTE_MATRIX) {
    assert.ok(doc.includes(`\`${route.method} ${route.path}\``),
      `docs/AUTHORIZATION.md: brak wiersza \`${route.method} ${route.path}\` w tabeli macierzy tras`);
  }
});

test('meta: detektor macierzy wykrywa błędny status i wyciek danych (kontrola pozytywna)', async () => {
  const ctx = await matrixContext();
  const byId = Object.fromEntries(ROUTE_MATRIX.map((route) => [route.id, route]));
  const repA = ACTORS.find((actor) => actor.key === 'repA');
  // Tabela twierdzi (błędnie), że 1A może czytać szkic 1B — trasa odmawia, więc detektor zgłasza status.
  const wrongStatus = await runCase(ctx, { ...byId['events.get'], allow: { repA: ['A', 'B'] } }, repA, false, 'B');
  assert.ok(wrongStatus.some((problem) => problem.includes('status 404 zamiast 200')), wrongStatus.join('\n'));
  // Tabela twierdzi, że przedstawiciel nie może widzieć żadnej klasy — /api/access zawiera "kl-1a".
  const leak = await runCase(ctx, { ...byId['session.access'], visible: () => [] }, repA, false, '-');
  assert.ok(leak.some((problem) => problem.includes('A:"kl-1a"')), leak.join('\n'));
  // Ślad odmowy: próba zapisu bez uprawnień nie zmienia tabel (przypadek poprawny = brak problemów).
  const denied = await runCase(ctx, byId['events.create'], repA, false, 'B');
  assert.deepEqual(denied, []);
});

// ---------- znane rozbieżności (todo: nie blokują CI, opisane w raporcie) ----------

test('events: zmiana cudzego szkicu odpowiada jak brak wydarzenia (bez wyroczni istnienia)', {
  todo: 'bug: src/pg/events.js:379 i :412 zwracają 403 dla istniejącego wydarzenia innej klasy, '
    + 'a 404 dla nieistniejącego — getInternal (:496) celowo tego unika; PATCH/submit/cancel ujawniają istnienie id',
}, async () => {
  const ctx = await matrixContext();
  const repA = ctx.sessions.repA[false];
  const foreign = ctx.fx.events.B.eventId;
  const missing = await handlePgRequest(request('/api/events/nieistniejace-wydarzenie', {
    method: 'PATCH', cookie: repA, body: { revision: 1, title: 'Próba zmiany' },
  }), { db: ctx.db });
  const other = await handlePgRequest(request(`/api/events/${foreign}`, {
    method: 'PATCH', cookie: repA, body: { revision: 1, title: 'Próba zmiany' },
  }), { db: ctx.db });
  assert.equal(missing.status, 404);
  assert.equal(other.status, missing.status, 'odmowa dla cudzej klasy powinna być nieodróżnialna od braku obiektu');
});
