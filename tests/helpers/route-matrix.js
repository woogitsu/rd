// Deklaratywna macierz autoryzacji tras API na PostgreSQL (issue #4).
//
// Każda trasa zarejestrowana w src/pg/app.js (ROUTES) MUSI mieć tu wpis.
// tests/pg-authz-matrix.test.js sprawdza to meta-testem: nowy moduł tras albo
// nowa ścieżka bez wpisu = czerwony test. Tabela jest opisana także w
// docs/AUTHORIZATION.md (sekcja „Macierz tras API”) — zmieniaj oba miejsca.
//
// Wpis trasy:
//   id        unikalna nazwa przypadku, np. 'events.update'
//   module    `name` modułu z ROUTES
//   method    metoda HTTP
//   path      szablon ścieżki (dokumentacja i meta-test); :param = identyfikator
//   targets   zakresy, dla których wykonujemy żądanie (TARGETS poniżej; '-' = bez zakresu)
//   allow     { kluczAktora: [zakresy dozwolone] } lub 'authenticated' / 'public'
//   mfa       true = wymagane potwierdzone MFA
//   ok        oczekiwany status sukcesu
//   deny      status odmowy dla zalogowanego bez uprawnień (403 lub 404) albo
//             (actor, targetKey) => 403 | 404, gdy zależy od widoczności obiektu (SR-07)
//   fixture   'static' (wspólne obiekty) | 'fresh' (nowy obiekt dla przypadku dozwolonego) | null
//   object    rodzaj obiektu: { kind, stage } — tworzy go test (ctx.object)
//   build     (ctx) => { path, body?, headers? } — ctx: { target, obj, key, fx }
//   visible   opcjonalnie (actor, target) => zakresy danych, które odpowiedź 2xx może zawierać
//   contains  opcjonalnie (actor, target) => zakresy, których znaczniki odpowiedź 2xx MUSI zawierać
//
// Wszystkie dane są syntetyczne. Znaczniki zakresów wstawiamy do tytułów,
// treści protokołów i opisów wpłat; odpowiedź odmowna nie może zawierać żadnego.

export const YEAR_1 = 'y-1';
export const YEAR_2 = 'y-2';

// Zakresy danych. W1 = dane ogólnoszkolne roku 1 (bez klasy); Y2 = klasa w innym roku.
export const TARGETS = Object.freeze({
  A: Object.freeze({ key: 'A', classId: 'kl-1a', schoolYearId: YEAR_1 }),
  B: Object.freeze({ key: 'B', classId: 'kl-1b', schoolYearId: YEAR_1 }),
  W1: Object.freeze({ key: 'W1', classId: null, schoolYearId: YEAR_1 }),
  Y2: Object.freeze({ key: 'Y2', classId: 'kl-2a', schoolYearId: YEAR_2 }),
  '-': Object.freeze({ key: '-', classId: null, schoolYearId: YEAR_1 }),
});

// Znaczniki syntetyczne; pierwszy element trafia do treści danych.
export const MARKERS = Object.freeze({
  A: Object.freeze(['MRK-KLASA-1A', '"kl-1a"']),
  B: Object.freeze(['MRK-KLASA-1B', '"kl-1b"']),
  W1: Object.freeze(['MRK-SZKOLA-R1']),
  Y2: Object.freeze(['MRK-ROK-2', '"kl-2a"', '"y-2"']),
  PUBLIC: Object.freeze(['MRK-JAWNE']),
});
export const SCOPED_MARKER_KEYS = Object.freeze(['A', 'B', 'W1', 'Y2']);
export const marker = (scope) => MARKERS[scope][0];

const PAST = '2020-01-01T00:00:00Z';
const board1 = { role: 'board', schoolYearId: YEAR_1 };

// Aktorzy. `scopes` = dane, do których aktor ma jakikolwiek przydział (górna granica
// tego, co może zobaczyć w odpowiedzi 2xx). Wszystkie przydziały dotyczą roku 1.
export const ACTORS = Object.freeze([
  { key: 'admin', label: 'admin techniczny', grants: [{ role: 'admin', schoolYearId: YEAR_1 }], scopes: ['A', 'B', 'W1'] },
  { key: 'board', label: 'zarząd', grants: [board1], scopes: ['A', 'B', 'W1'] },
  { key: 'treasurer', label: 'skarbnik', grants: [{ role: 'treasurer', schoolYearId: YEAR_1 }], scopes: ['A', 'B', 'W1'] },
  { key: 'repA', label: 'przedstawiciel klasy 1A', grants: [{ role: 'representative', classId: 'kl-1a', schoolYearId: YEAR_1 }], scopes: ['A'], ownClass: 'A' },
  { key: 'repB', label: 'przedstawiciel klasy 1B', grants: [{ role: 'representative', classId: 'kl-1b', schoolYearId: YEAR_1 }], scopes: ['B'], ownClass: 'B' },
  { key: 'audit', label: 'Komisja Rewizyjna', grants: [{ role: 'audit', schoolYearId: YEAR_1 }], scopes: ['A', 'B', 'W1'] },
  { key: 'principal', label: 'dyrekcja', grants: [{ role: 'principal', schoolYearId: YEAR_1 }], scopes: [] },
  { key: 'noGrant', label: 'zalogowany bez przydziału', grants: [], scopes: [] },
  { key: 'expiredGrant', label: 'zarząd — przydział wygasły', grants: [{ ...board1, expiresAt: PAST }], scopes: [] },
  { key: 'revokedGrant', label: 'zarząd — przydział cofnięty', grants: [{ ...board1, revoked: true }], scopes: [] },
  { key: 'disabled', label: 'zarząd — konto wyłączone', grants: [board1], scopes: [], disabled: true, unauthenticated: true },
  { key: 'expiredSession', label: 'zarząd — sesja wygasła', grants: [board1], scopes: [], sessionExpired: true, unauthenticated: true },
  { key: 'revokedSession', label: 'zarząd — sesja cofnięta', grants: [board1], scopes: [], sessionRevoked: true, unauthenticated: true },
  { key: 'anonymous', label: 'bez sesji', grants: [], scopes: [], anonymous: true, unauthenticated: true },
].map((actor) => Object.freeze(actor)));

export const ACTOR_KEYS = ACTORS.map((actor) => actor.key);

const Y1_ALL = ['A', 'B', 'W1'];
const SCHOOL_Y1 = ['W1'];
const CLASS_TARGETS = ['A', 'B', 'W1', 'Y2'];
const YEAR_TARGETS = ['W1', 'Y2'];

// Szkic wydarzenia: admin/zarząd w całym roku 1, przedstawiciel tylko własna klasa.
const EVENT_EDIT = { admin: Y1_ALL, board: Y1_ALL, repA: ['A'], repB: ['B'] };
const EVENT_REVIEW = { board: Y1_ALL };
const FINANCIAL = { admin: SCHOOL_Y1, board: SCHOOL_Y1, treasurer: SCHOOL_Y1 };
const MEETING_MANAGE = { admin: Y1_ALL, board: Y1_ALL };
const MEETING_READ = { admin: Y1_ALL, board: Y1_ALL, audit: Y1_ALL };

const json = (body) => body;
const withKey = (key) => ({ 'Idempotency-Key': key });
const everyY1 = () => Y1_ALL;

function meetingRoute(id, method, template, suffix, { ok = 200, stage = 'draft', body, create = false }) {
  return {
    id, module: 'meetings', method, path: template, targets: CLASS_TARGETS,
    allow: MEETING_MANAGE, mfa: false, ok, deny: 403, fixture: 'fresh',
    object: { kind: 'meeting', stage },
    build: ({ obj, key, target }) => ({
      path: `/api/meetings/${obj.meetingId}${suffix(obj)}`,
      body: json(body(target, obj)),
      headers: create ? withKey(key) : {},
    }),
  };
}

// SR-07: wydarzenie spoza zakresu podglądu (EVENT_EDIT) daje 404 jak brak obiektu;
// widoczne, ale bez prawa do kroku (np. zatwierdzenie przez przedstawiciela) — 403.
const eventDeny = (actor, targetKey) => ((EVENT_EDIT[actor.key] ?? []).includes(targetKey) ? 403 : 404);

function eventAction(id, action, stage, allow, body = {}) {
  return {
    id, module: 'events', method: 'POST', path: `/api/events/:eventId/${action}`, targets: CLASS_TARGETS,
    allow, mfa: false, ok: 200, deny: eventDeny, fixture: 'fresh', object: { kind: 'event', stage },
    build: ({ obj }) => ({ path: `/api/events/${obj.eventId}/${action}`, body: { revision: 1, ...body } }),
  };
}

export const ROUTE_MATRIX = Object.freeze([
  // ---------- session ----------
  {
    id: 'session.get', module: 'session', method: 'GET', path: '/api/session', targets: ['-'],
    allow: 'authenticated', mfa: false, ok: 200, deny: 403, fixture: null,
    build: () => ({ path: '/api/session' }),
  },
  {
    id: 'session.access', module: 'session', method: 'GET', path: '/api/access', targets: ['-'],
    allow: 'authenticated', mfa: false, ok: 200, deny: 403, fixture: null,
    build: () => ({ path: '/api/access' }),
  },
  {
    id: 'session.logout', module: 'session', method: 'POST', path: '/api/logout', targets: ['-'],
    allow: 'public', mfa: false, ok: 204, deny: 204, fixture: null, freshSession: true,
    build: () => ({ path: '/api/logout' }),
  },

  // ---------- payments (#37) ----------
  {
    id: 'payments.list', module: 'payments', method: 'GET', path: '/api/payments?schoolYearId=:year',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: `/api/payments?schoolYearId=${target.schoolYearId}` }),
    contains: () => ['W1'],
  },
  {
    id: 'payments.create', module: 'payments', method: 'POST', path: '/api/payments',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: null,
    build: ({ target, key }) => ({
      path: '/api/payments', headers: withKey(key),
      body: { schoolYearId: target.schoolYearId, householdId: 'hh-1', amountCents: 1000, receivedOn: '2026-10-01',
        method: 'bank', reference: `Nowa ${marker(target.key)}` },
    }),
  },
  {
    id: 'payments.correction', module: 'payments', method: 'POST', path: '/api/payments/:paymentId/corrections',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: 'static',
    object: { kind: 'payment', stage: 'recorded' },
    build: ({ obj, key }) => ({
      path: `/api/payments/${obj.paymentId}/corrections`, headers: withKey(key),
      body: { amountCents: 1, reason: 'Korekta syntetyczna' },
    }),
  },
  {
    id: 'payments.assignment', module: 'payments', method: 'POST', path: '/api/payments/:paymentId/assignment',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: 'fresh',
    object: { kind: 'payment', stage: 'unmatched' },
    build: ({ obj, key }) => ({
      path: `/api/payments/${obj.paymentId}/assignment`, headers: withKey(key), body: { householdId: 'hh-1' },
    }),
  },

  // ---------- events (#12) ----------
  {
    id: 'events.public', module: 'events', method: 'GET', path: '/api/public/events', targets: ['-'],
    allow: 'public', mfa: false, ok: 200, deny: 200, fixture: null,
    build: () => ({ path: '/api/public/events' }),
    visible: () => [], contains: () => ['PUBLIC'],
  },
  {
    id: 'events.list', module: 'events', method: 'GET', path: '/api/events?schoolYearId=:year',
    targets: YEAR_TARGETS, allow: { admin: SCHOOL_Y1, board: SCHOOL_Y1, repA: SCHOOL_Y1, repB: SCHOOL_Y1 },
    mfa: false, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: `/api/events?schoolYearId=${target.schoolYearId}` }),
    contains: (actor) => (actor.ownClass ? [actor.ownClass] : Y1_ALL),
  },
  {
    id: 'events.create', module: 'events', method: 'POST', path: '/api/events', targets: CLASS_TARGETS,
    allow: EVENT_EDIT, mfa: false, ok: 201, deny: 403, fixture: null,
    build: ({ target, key }) => ({
      path: '/api/events', headers: withKey(key),
      body: { schoolYearId: target.schoolYearId, classId: target.classId, title: `Nowe ${marker(target.key)}`,
        startsAt: '2026-11-12T18:30', audience: 'internal' },
    }),
  },
  {
    id: 'events.get', module: 'events', method: 'GET', path: '/api/events/:eventId', targets: CLASS_TARGETS,
    allow: EVENT_EDIT, mfa: false, ok: 200, deny: 404, fixture: 'static', object: { kind: 'event', stage: 'draft' },
    build: ({ obj }) => ({ path: `/api/events/${obj.eventId}` }),
    contains: (_actor, target) => [target.key],
  },
  {
    id: 'events.update', module: 'events', method: 'PATCH', path: '/api/events/:eventId', targets: CLASS_TARGETS,
    allow: EVENT_EDIT, mfa: false, ok: 200, deny: eventDeny, fixture: 'fresh', object: { kind: 'event', stage: 'draft' },
    build: ({ obj, target }) => ({ path: `/api/events/${obj.eventId}`, body: { revision: 1, title: `Zmiana ${marker(target.key)}` } }),
  },
  eventAction('events.submit', 'submit', 'draft', EVENT_EDIT),
  eventAction('events.approve', 'approve', 'submitted', EVENT_REVIEW),
  eventAction('events.publish', 'publish', 'approved', EVENT_REVIEW),
  eventAction('events.cancel', 'cancel', 'draft', EVENT_EDIT, { reason: 'Odwołanie syntetyczne' }),

  // ---------- meetings (#13) ----------
  {
    id: 'meetings.list', module: 'meetings', method: 'GET', path: '/api/meetings?schoolYearId=:year',
    targets: YEAR_TARGETS, allow: { admin: SCHOOL_Y1, board: SCHOOL_Y1, audit: SCHOOL_Y1 },
    mfa: false, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: `/api/meetings?schoolYearId=${target.schoolYearId}` }),
    contains: everyY1,
  },
  {
    id: 'meetings.create', module: 'meetings', method: 'POST', path: '/api/meetings', targets: CLASS_TARGETS,
    allow: MEETING_MANAGE, mfa: false, ok: 201, deny: 403, fixture: null,
    build: ({ target, key }) => ({
      path: '/api/meetings', headers: withKey(key),
      body: { schoolYearId: target.schoolYearId, kind: target.classId ? 'class' : 'plenary', classId: target.classId,
        title: `Zebranie ${marker(target.key)}`, scheduledAt: '2026-10-10T17:00:00Z' },
    }),
  },
  {
    id: 'meetings.sharedMinutes', module: 'meetings', method: 'GET', path: '/api/meetings/shared-minutes?schoolYearId=:year',
    targets: YEAR_TARGETS,
    allow: { admin: SCHOOL_Y1, board: SCHOOL_Y1, audit: SCHOOL_Y1, repA: SCHOOL_Y1, repB: SCHOOL_Y1 },
    mfa: false, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: `/api/meetings/shared-minutes?schoolYearId=${target.schoolYearId}` }),
    // Przedstawiciel: protokoły ogólnoszkolne udostępnione rodzicom + własna klasa.
    visible: (actor) => (actor.ownClass ? [actor.ownClass, 'W1'] : actor.scopes),
    contains: (actor) => (actor.ownClass ? [actor.ownClass, 'W1'] : Y1_ALL),
  },
  {
    id: 'meetings.publicMinutes', module: 'meetings', method: 'GET', path: '/api/meetings/public-minutes?schoolYearId=:year',
    targets: ['-'], allow: 'public', mfa: false, ok: 200, deny: 200, fixture: null,
    build: () => ({ path: `/api/meetings/public-minutes?schoolYearId=${YEAR_1}` }),
    visible: () => [], contains: () => ['PUBLIC'],
  },
  {
    id: 'meetings.resolutionLookup', module: 'meetings', method: 'GET',
    path: '/api/meetings/resolutions/lookup?schoolYearId=:year&number=:number', targets: YEAR_TARGETS,
    allow: { admin: SCHOOL_Y1, board: SCHOOL_Y1, audit: SCHOOL_Y1, treasurer: SCHOOL_Y1 },
    mfa: false, ok: 200, deny: 403, fixture: null,
    build: ({ target, fx }) => ({
      path: `/api/meetings/resolutions/lookup?schoolYearId=${target.schoolYearId}&number=${encodeURIComponent(fx.resolutionNumber[target.key])}`,
    }),
    contains: () => ['W1'],
  },
  {
    id: 'meetings.get', module: 'meetings', method: 'GET', path: '/api/meetings/:meetingId', targets: CLASS_TARGETS,
    allow: MEETING_READ, mfa: false, ok: 200, deny: 404, fixture: 'static', object: { kind: 'meeting', stage: 'shared' },
    build: ({ obj }) => ({ path: `/api/meetings/${obj.meetingId}` }),
    contains: (_actor, target) => [target.key],
  },
  meetingRoute('meetings.update', 'PATCH', '/api/meetings/:meetingId', () => '', {
    body: (target) => ({ title: `Zmiana ${marker(target.key)}` }),
  }),
  meetingRoute('meetings.agendaItem', 'POST', '/api/meetings/:meetingId/agenda-items', () => '/agenda-items', {
    ok: 201, create: true, body: (target) => ({ title: `Punkt ${marker(target.key)}` }),
  }),
  meetingRoute('meetings.attendance', 'POST', '/api/meetings/:meetingId/attendance', () => '/attendance', {
    body: () => ({ userId: 'u-fx-board', capacity: 'board_member', votingEligible: true, present: true }),
  }),
  meetingRoute('meetings.quorumCheck', 'POST', '/api/meetings/:meetingId/quorum-checks', () => '/quorum-checks', {
    ok: 201, create: true, stage: 'held', body: () => ({}),
  }),
  meetingRoute('meetings.minutes', 'POST', '/api/meetings/:meetingId/minutes', () => '/minutes', {
    ok: 201, create: true, stage: 'held', body: (target) => ({ body: `Protokół roboczy ${marker(target.key)}` }),
  }),
  meetingRoute('meetings.minutesApproval', 'POST', '/api/meetings/:meetingId/minutes/:minutesId/approval',
    (obj) => `/minutes/${obj.minutesId}/approval`, { stage: 'draftMinutes', body: () => ({}) }),
  meetingRoute('meetings.minutesVisibility', 'POST', '/api/meetings/:meetingId/minutes/:minutesId/visibility',
    (obj) => `/minutes/${obj.minutesId}/visibility`, {
      ok: 201, create: true, stage: 'approvedMinutes', body: () => ({ visibility: 'internal' }),
    }),
  meetingRoute('meetings.resolution', 'POST', '/api/meetings/:meetingId/resolutions', () => '/resolutions', {
    ok: 201, create: true, stage: 'held',
    body: (target) => ({ title: `Uchwała ${marker(target.key)}`, body: 'Treść syntetyczna', status: 'draft' }),
  }),
  meetingRoute('meetings.resolutionUpdate', 'PATCH', '/api/meetings/:meetingId/resolutions/:resolutionId',
    (obj) => `/resolutions/${obj.resolutionId}`, {
      stage: 'draftResolution', body: (target) => ({ title: `Poprawiony tytuł ${marker(target.key)}` }),
    }),
  meetingRoute('meetings.resolutionCorrection', 'POST', '/api/meetings/:meetingId/resolutions/:resolutionId/corrections',
    (obj) => `/resolutions/${obj.resolutionId}/corrections`, {
      ok: 201, create: true, stage: 'finalResolution', body: () => ({ reason: 'Pomyłka w zapisie głosów', votesAgainst: 1 }),
    }),
].map((route) => Object.freeze(route)));

// Oczekiwany status dla (trasa, aktor, MFA, zakres).
export function expectedStatus(route, actor, mfa, targetKey) {
  if (route.allow === 'public') return route.ok;
  if (actor.unauthenticated) return 401;
  if (route.allow === 'authenticated') return route.ok;
  const scopes = route.allow[actor.key] ?? [];
  if (!scopes.includes(targetKey)) return typeof route.deny === 'function' ? route.deny(actor, targetKey) : route.deny;
  if (route.mfa && !mfa) return 403;
  return route.ok;
}

// Zakresy, których znaczniki mogą wystąpić w odpowiedzi 2xx.
export function visibleScopes(route, actor, targetKey) {
  if (route.visible) return route.visible(actor, TARGETS[targetKey]);
  return actor.scopes;
}
