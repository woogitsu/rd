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
//   mfa       true = wymagane potwierdzone MFA; albo (actor) => boolean (MFA zależne od roli)
//   mfaDeny   status przy braku MFA (domyślnie 403; dokumenty: 404)
//   ok        oczekiwany status sukcesu
//   deny      status odmowy dla zalogowanego bez uprawnień (403 lub 404) albo (actor, targetKey, mfa) => 400/403/404,
//             gdy zależy od roli lub widoczności obiektu (SR-07)
//   fixture   'static' (wspólne obiekty) | 'fresh' (nowy obiekt dla przypadku dozwolonego) | null
//   object    rodzaj obiektu: { kind, stage } — tworzy go test (MAKERS w tests/pg-authz-matrix.test.js)
//   needs     opcjonalnie [[kind, stage, zakresy]] — obiekty wspólne potrzebne liście przed pierwszym przypadkiem
//   build     (ctx) => { path, body?, headers? } — ctx: { target, obj, key, fx }
//   visible   opcjonalnie (actor, target) => zakresy danych, które odpowiedź 2xx może zawierać
//   contains  opcjonalnie (actor, target) => zakresy, których znaczniki odpowiedź 2xx MUSI zawierać
//   check     opcjonalnie ({ actor, mfa, targetKey, json, text }) => [problemy] — dodatkowe asercje 2xx
//   todo      opcjonalnie (actor, mfa, targetKey) => opis znanej luki | undefined. Oczekiwany status zawsze
//             opisuje ZAMIERZONĄ politykę; przypadek `todo` wykonuje się, a rozbieżność trafia do testu `todo`.
//   group     opcjonalnie nazwa osobnej bazy (domyślnie 'main'; 'yearClose' — zamknięcie roku)
//   freshUser nowy użytkownik (z przydziałami aktora) na każdy przypadek — trasy zmieniające własne konto
//
// Wszystkie dane są syntetyczne. Znaczniki zakresów wstawiamy do tytułów,
// treści protokołów i opisów wpłat; odpowiedź odmowna nie może zawierać żadnego.

import { isMfaGateExempt } from '../../src/pg/mfa-policy.js';

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
  // Przydział zarządu zawężony do klasy (schemat na to pozwala). Zgodnie z docs/AUTHORIZATION.md
  // class_id ogranicza przydział do jednej klasy — nigdy nie otwiera danych ogólnoszkolnych (SR-01).
  { key: 'boardA', label: 'zarząd — przydział ograniczony do klasy 1A', grants: [{ role: 'board', classId: 'kl-1a', schoolYearId: YEAR_1 }], scopes: ['A'], classBoard: 'A' },
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
// Zarząd z przydziałem klasy 1A zarządza wyłącznie zebraniami klasy 1A.
const MEETING_MANAGE = { admin: Y1_ALL, board: Y1_ALL, boardA: ['A'] };
const MEETING_READ = { admin: Y1_ALL, board: Y1_ALL, audit: Y1_ALL, boardA: ['A'] };

const json = (body) => body;
const withKey = (key) => ({ 'Idempotency-Key': key });
const everyY1 = () => Y1_ALL;

function meetingRoute(id, method, template, suffix, { ok = 200, stage = 'draft', body, create = false, mfa = false }) {
  return {
    id, module: 'meetings', method, path: template, targets: CLASS_TARGETS,
    allow: MEETING_MANAGE, mfa, ok, deny: 403, fixture: 'fresh',
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

// ---------- moduły #36, #39, #38, #40, #14, #3/#4/#9, #7, #5, #11, #15 ----------

const IMPORT = { admin: SCHOOL_Y1, board: SCHOOL_Y1 };
const DOC_FINANCIAL = FINANCIAL;
const DOC_BOARD = { admin: SCHOOL_Y1, board: SCHOOL_Y1 };
// Klasa: admin/zarząd bez klasy — obie klasy roku 1; przedstawiciel i zarząd z przydziałem klasy — tylko ona.
const CLASS_READ_ALL = { admin: ['A', 'B'], board: ['A', 'B'], repA: ['A'], repB: ['B'], boardA: ['A'] };
const DOC_CLASS = CLASS_READ_ALL;
const EMAIL_EDIT = { board: SCHOOL_Y1, treasurer: SCHOOL_Y1 };
const EMAIL_APPROVE = { board: SCHOOL_Y1 };
const PHOTO_REGISTER = { admin: ['-'], board: ['-'] };
const PHOTO_VERIFY = { board: ['-'] };
const ADMIN_ONLY = { admin: ['-'] };
const FAMILY_READ = { ...CLASS_READ_ALL, treasurer: ['A', 'B'] };
const FAMILY_EDIT = { admin: ['A', 'B'], board: ['A', 'B'], boardA: ['A'] };
const PRINT = { admin: Y1_ALL, board: Y1_ALL, treasurer: Y1_ALL, repA: ['A'], repB: ['B'], boardA: ['A'] };
const YEAR_CLOSE_READ = { board: SCHOOL_Y1, treasurer: SCHOOL_Y1 };
const YEAR_CLOSE_BOARD = { board: SCHOOL_Y1 };
const FINANCIAL_ROLE_KEYS = ['admin', 'board', 'treasurer'];

export const safeKey = (key) => key.replace(/[^A-Za-z0-9_-]/g, '-').slice(-100);

// Data w roku szkolnym zakresu: miesiące 09–12 w pierwszym roku kalendarzowym, 01–08 w drugim.
export function yearDate(target, monthDay) {
  const base = target.schoolYearId === YEAR_2 ? 2027 : 2026;
  return `${Number(monthDay.slice(0, 2)) >= 9 ? base : base + 1}-${monthDay}`;
}
export const statementDate = (target) => yearDate(target, '06-30');
export const ledgerCategory = (target) => `cat-in-${target.schoolYearId}`;
export const classNameFor = (target) => (target.schoolYearId === YEAR_2 ? TARGETS.Y2.classId : TARGETS.A.classId);

export const IMPORT_COLUMNS = Object.freeze(['studentId', 'firstName', 'lastName', 'className', 'householdId',
  'guardian1', 'email1', 'guardian2', 'email2']);
export function importPayload(target, key) {
  const id = safeKey(key).slice(-58);
  return {
    version: 1, schoolYearId: target.schoolYearId, columns: [...IMPORT_COLUMNS],
    rows: [[`imp-${id}`, 'Ola', 'Importowana', classNameFor(target), `imph-${id}`, 'Anna Importowa',
      `imp-${id.toLowerCase()}@example.invalid`, '', '']],
  };
}

export function pdfBytes(scope) {
  return new TextEncoder().encode(`%PDF-1.4\n% ${marker(scope)} dokument syntetyczny\n%%EOF\n`);
}

// Prawdziwy, poprawny plik PNG 2x2 (nie tekst udający sygnaturę jak pdfBytes
// powyżej) — POST /api/news-photos/:id/file (#96) dekoduje bajty przez sharp,
// więc atrapa musi być poprawnym obrazem, nie tylko mieć poprawne magic bytes.
// Wygenerowany raz: sharp({create:{width:2,height:2,channels:3,background:
// {r:200,g:30,b:30}}}).png().toBuffer() — bez danych osobowych, bez EXIF.
const SYNTHETIC_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4ISd3Qk6OAUIBAB8mBBGFRCvEAAAAAElFTkSuQmCC';
export function pngBytes() {
  const binary = atob(SYNTHETIC_PNG_BASE64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export const CAMPAIGN_TEXT = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. '
  + 'Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';
export function campaignBody(target) {
  return { schoolYearId: target.schoolYearId, title: `Kampania ${marker(target.key)}`, audience: 'all_households',
    subject: 'Dobrowolna składka {rok}', bodyText: CAMPAIGN_TEXT };
}

export function photoBody(key) {
  return {
    documentId: `dok-${safeKey(key)}`.slice(0, 120), author: 'Fotograf syntetyczny', source: 'own_work', takenOn: '2026-10-10',
    licenseText: 'Zdjęcie własne autora, udostępnione Radzie do publikacji (syntetyczne).',
    altText: `Zdjęcie ${marker('W1')}`, depictsChildren: false,
  };
}

function documentUpload(id, kind, targets, allow, mfa) {
  const classPart = kind === 'class' ? '&classId=:class' : '';
  return {
    id, module: 'documents', method: 'POST', path: `/api/documents?kind=${kind}&schoolYearId=:year${classPart}`,
    targets, allow, mfa, ok: 201, deny: 403, fixture: null,
    build: ({ target, key }) => ({
      path: `/api/documents?kind=${kind}&schoolYearId=${target.schoolYearId}${kind === 'class' ? `&classId=${target.classId}` : ''}`,
      headers: { 'Content-Type': 'application/pdf', 'Idempotency-Key': key }, body: pdfBytes(target.key),
    }),
  };
}

// Odczyt dokumentu: brak uprawnień, brak MFA i nieistniejący identyfikator dają to samo 404.
function documentRead(id, path, kind, targets, allow, mfa, suffix) {
  return {
    id, module: 'documents', method: 'GET', path, targets, allow, mfa, mfaDeny: 404, ok: 200, deny: 404,
    fixture: 'static', object: { kind: 'document', stage: kind },
    build: ({ obj }) => ({ path: `/api/documents/${obj.documentId}${suffix}` }),
    contains: suffix ? (_actor, target) => [target.key] : undefined,
  };
}

// Zapis opisu (tytuł/kategoria — issue #76): te same reguły dostępu co odczyt
// metadanych dokumentu (canAccessDocument), więc mfaDeny/deny = 404 jak wyżej.
function documentDescribe(id, path, kind, targets, allow, mfa) {
  return {
    id, module: 'documents', method: 'POST', path,
    targets, allow, mfa, mfaDeny: 404, ok: 201, deny: 404,
    fixture: 'static', object: { kind: 'document', stage: kind },
    build: ({ obj, target, key }) => ({
      path: `/api/documents/${obj.documentId}/description`, headers: withKey(key),
      body: { title: `Opis ${marker(target.key)}`, category: 'inne' },
    }),
    contains: (_actor, target) => [target.key],
  };
}

function ledgerRead(id, path, suffix, contains) {
  return {
    id, module: 'ledger', method: 'GET', path, targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 200, deny: 403,
    fixture: null, needs: [['ledgerEntry', undefined, YEAR_TARGETS]],
    build: ({ target }) => ({ path: `/api/ledger${suffix}?schoolYearId=${target.schoolYearId}` }),
    contains: () => contains,
  };
}

function emailRoute(id, method, suffix, stage, { fixture = 'fresh', allow = EMAIL_EDIT, body, contains, ok = 200, withKey: keyed = false }) {
  return {
    id, module: 'email', method, path: `/api/email/campaigns/:campaignId${suffix}`, targets: YEAR_TARGETS,
    allow, mfa: true, ok, deny: 403, fixture, object: { kind: 'campaign', stage },
    build: ({ obj, target, key }) => ({
      path: `/api/email/campaigns/${obj.campaignId}${suffix}`,
      headers: method !== 'GET' && keyed ? withKey(key) : {},
      body: method === 'GET' ? undefined : (body ? body(target, obj) : {}),
    }),
    contains,
  };
}

// Zatwierdzenie/publikacja wpisu: kto może edytować wpis, dostaje 403; kto go nie widzi — 404.
function newsReviewDeny(actor, targetKey) {
  return (EVENT_EDIT[actor.key] ?? []).includes(targetKey) ? 403 : 404;
}

function newsAction(id, action, stage, allow, deny, extra = {}) {
  return {
    id, module: 'news', method: 'POST', path: `/api/news/:postId/${action}`, targets: CLASS_TARGETS,
    allow, mfa: false, ok: 200, deny, fixture: 'fresh', object: { kind: 'newsPost', stage },
    build: ({ obj }) => ({ path: `/api/news/${obj.postId}/${action}`, body: { revision: 1, ...extra } }),
  };
}

function photoAction(id, action, allow, ok, body) {
  return {
    id, module: 'news', method: 'POST', path: `/api/news-photos/:photoId/${action}`, targets: ['-'],
    allow, mfa: false, ok, deny: 403, fixture: 'fresh', object: { kind: 'photo', stage: 'pending' }, visible: () => ['W1'],
    build: ({ obj }) => ({ path: `/api/news-photos/${obj.photoId}/${action}`, body }),
  };
}

function adminRoute(id, method, path, { ok = 200, object, build }) {
  return {
    id, module: 'admin', method, path, targets: ['-'], allow: ADMIN_ONLY, mfa: true, ok, deny: 403,
    fixture: object ? 'fresh' : null, object: object ? { kind: 'adminTarget', stage: object } : undefined,
    visible: () => SCOPED_MARKER_KEYS,
    build: build ?? (() => ({ path })),
  };
}

function reconciliationRoute(id, method, template, stage, { fixture = 'fresh', ok = 200, withKey: keyed = false, body, suffix, contains }) {
  return {
    id, module: 'reconciliation', method, path: `/api/reconciliations/:reconciliationId${template}`, targets: YEAR_TARGETS,
    allow: FINANCIAL, mfa: true, ok, deny: 403, fixture, object: { kind: 'reconciliation', stage },
    build: ({ obj, target, key }) => ({
      path: `/api/reconciliations/${obj.reconciliationId}${suffix ? suffix(obj) : template}`,
      headers: keyed ? withKey(key) : {},
      body: method === 'GET' ? undefined : (body ? body(target, obj) : {}),
    }),
    contains,
  };
}

// Katalog rodzin: rola bez dostępu do danych rodzin (Komisja Rewizyjna, dyrekcja, brak przydziału) — 403;
// rola z dostępem, ale obiekt poza zakresem — 404 (jak brak obiektu).
function familyReadDeny(actor) {
  return Object.hasOwn(FAMILY_READ, actor.key) ? 404 : 403;
}

// Zmiany w katalogu rodzin: rola bez prawa edycji — 403; rola edycji poza zakresem — 404 (jak brak obiektu).
function familyEditDeny(actor) {
  return ['admin', 'board', 'boardA'].includes(actor.key) ? 404 : 403;
}

// Kartki: przydział klasowy bez classId — 400 class_required (docs/PRINT); poza zakresem — 403.
function printDeny(actor, targetKey) {
  return targetKey === 'W1' && ['repA', 'repB', 'boardA'].includes(actor.key) ? 400 : 403;
}

function mfaRoute(id, path, ok, stage) {
  return {
    id, module: 'mfa', method: 'POST', path, targets: ['-'], allow: 'authenticated', mfa: false, ok, deny: 403,
    fixture: stage ? 'fresh' : null, object: stage ? { kind: 'mfaFactor', stage, route: id } : undefined, freshUser: true,
    build: ({ obj }) => ({ path, body: obj?.code ? { code: obj.code } : (stage ? { code: '000000' } : {}) }),
  };
}

function yearCloseRoute(id, method, path, suffix, allow, ok, { fixture = null, object, suffix: suffixFn, body } = {}) {
  return {
    id, module: 'year-close', group: 'yearClose', method, path, targets: YEAR_TARGETS, allow, mfa: true, ok, deny: 403,
    fixture, object,
    // Stan zamknięcia roku 1 podaje identyfikator następnego roku ("y-2") — to nie są dane roku 2.
    visible: (actor, target) => (target.key === 'W1' ? [...actor.scopes, 'Y2'] : actor.scopes),
    build: ({ target, obj }) => ({
      path: `/api/year-close/${target.schoolYearId}${suffixFn ? suffixFn(obj) : suffix}`,
      body: method === 'GET' ? undefined : (body ? body(target, obj) : {}),
    }),
  };
}

// ---------- dodatkowe asercje odpowiedzi 2xx ----------

// Rodzaje dokumentów widoczne na liście: skarbnik — wyłącznie finansowe (MFA); przedstawiciel
// i przydział klasowy — wyłącznie dokumenty `class` własnej klasy.
export function documentKindsCheck(actor, mfa, json) {
  const ownClass = actor.ownClass ?? actor.classBoard;
  const allowed = (doc) => {
    if (ownClass) return doc.kind === 'class' && doc.classId === TARGETS[ownClass].classId;
    if (doc.kind === 'financial') return FINANCIAL_ROLE_KEYS.includes(actor.key) && mfa;
    return ['admin', 'board'].includes(actor.key);
  };
  const documents = json?.documents ?? [];
  const wrong = documents.filter((doc) => !allowed(doc));
  const problems = wrong.length ? [`lista zawiera niedozwolone dokumenty: ${wrong.map((doc) => `${doc.kind}/${doc.classId}`).join(', ')}`] : [];
  // Oczekiwane rodzaje (klasa) muszą być na liście — pusta lista nie jest dowodem poprawnego zakresu.
  const expected = ownClass ? [`class/${TARGETS[ownClass].classId}`]
    : actor.key === 'treasurer' ? ['financial/null']
      : [`class/${TARGETS.A.classId}`, `class/${TARGETS.B.classId}`, 'board/null', ...(mfa ? ['financial/null'] : [])];
  const seen = new Set(documents.map((doc) => `${doc.kind}/${doc.classId}`));
  const missing = expected.filter((entry) => !seen.has(entry));
  if (missing.length) problems.push(`lista nie zawiera: ${missing.join(', ')}`);
  return problems;
}

export function classListCheck(actor, json) {
  const ids = (json?.classes ?? []).map((row) => row.id);
  const ownClass = actor.ownClass ?? actor.classBoard;
  const expected = ownClass ? [TARGETS[ownClass].classId] : [TARGETS.A.classId, TARGETS.B.classId];
  const same = ids.length === expected.length && expected.every((id) => ids.includes(id));
  return same ? [] : [`lista klas ${JSON.stringify(ids)} zamiast ${JSON.stringify(expected)}`];
}

// Kwoty wpłat na kartkach wyłącznie dla roli finansowej z MFA obejmującej zakres.
export function printPaymentCheck(actor, mfa, json) {
  const expected = mfa && (FINANCIAL_ROLE_KEYS.includes(actor.key) || Boolean(actor.classBoard));
  const rows = json?.rows ?? [];
  const problems = [];
  if (json?.paymentInfoIncluded !== expected) problems.push(`paymentInfoIncluded=${json?.paymentInfoIncluded} zamiast ${expected}`);
  if (rows.some((row) => ('recordedNetCents' in row) !== expected)) problems.push('recordedNetCents niezgodne z paymentInfoIncluded');
  return problems;
}

export const ROUTE_MATRIX = Object.freeze([
  // ---------- session ----------
  {
    id: 'session.get', module: 'session', method: 'GET', path: '/api/session', targets: ['-'],
    allow: 'authenticated', mfa: false, ok: 200, deny: 403, fixture: null,
    build: () => ({ path: '/api/session' }),
  },
  {
    // Zwolniona z bramki MFA, ale sesja czekająca na MFA dostaje pustą listę (#189; test w pg-authz-matrix).
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
      body: { schoolYearId: target.schoolYearId, householdId: 'hh-1', amountCents: 1000, receivedOn: yearDate(target, '10-01'),
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
  {
    // #138: zwrot pieniędzy rodzinie — osobny, niezmienny zapis (nie korekta).
    id: 'payments.refund', module: 'payments', method: 'POST', path: '/api/payments/:paymentId/refunds',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: 'static',
    object: { kind: 'payment', stage: 'recorded' },
    build: ({ target, obj, key }) => ({
      path: `/api/payments/${obj.paymentId}/refunds`, headers: withKey(key),
      body: { amountCents: 1, refundedOn: yearDate(target, '10-02'), method: 'bank', reason: 'Zwrot syntetyczny' },
    }),
  },
  {
    // #138: ponowne przypisanie do gospodarstwa — niezmienne zdarzenie zamiast korekty do zera.
    // fixture 'fresh': każda próba przenosi hh-1 -> hh-2, więc dzielony obiekt nie może się powtórzyć.
    id: 'payments.reassignment', module: 'payments', method: 'POST', path: '/api/payments/:paymentId/reassignment',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: 'fresh',
    object: { kind: 'payment', stage: 'recorded' },
    build: ({ obj, key }) => ({
      path: `/api/payments/${obj.paymentId}/reassignment`, headers: withKey(key),
      body: { householdId: 'hh-2', reason: 'Błędne przypisanie, korekta syntetyczna' },
    }),
  },
  {
    // #141: eksport CSV wpisów wpłat i korekt (skarbnik/zarząd/admin).
    id: 'payments.exportCsv', module: 'payments', method: 'GET', path: '/api/payments/export.csv?schoolYearId=:year',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: `/api/payments/export.csv?schoolYearId=${target.schoolYearId}` }),
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

  // ---------- events: zadania i zapisy wolontariuszy (#142) ----------
  // Dostęp do zadania/zapisu sprawdza ten sam canEdit(actor, event) co szkic
  // wydarzenia (src/pg/events.js) — te same zakresy i ta sama odmowa 404/403
  // (SR-07: wydarzenie spoza zakresu podglądu wygląda jak nieznane).
  {
    id: 'events.tasksList', module: 'events', method: 'GET', path: '/api/events/:eventId/tasks', targets: CLASS_TARGETS,
    allow: EVENT_EDIT, mfa: false, ok: 200, deny: eventDeny, fixture: 'static', object: { kind: 'event', stage: 'draft' },
    build: ({ obj }) => ({ path: `/api/events/${obj.eventId}/tasks` }),
  },
  {
    id: 'events.taskCreate', module: 'events', method: 'POST', path: '/api/events/:eventId/tasks', targets: CLASS_TARGETS,
    allow: EVENT_EDIT, mfa: false, ok: 201, deny: eventDeny, fixture: 'fresh', object: { kind: 'event', stage: 'draft' },
    build: ({ obj, target, key }) => ({
      path: `/api/events/${obj.eventId}/tasks`, headers: withKey(key),
      body: { title: `Zadanie ${marker(target.key)}`, slotsNeeded: 2, isPublic: false },
    }),
  },
  {
    id: 'events.taskCancel', module: 'events', method: 'POST', path: '/api/events/:eventId/tasks/:taskId/cancel',
    targets: CLASS_TARGETS, allow: EVENT_EDIT, mfa: false, ok: 200, deny: eventDeny, fixture: 'fresh',
    object: { kind: 'eventTask', stage: 'draft' },
    build: ({ obj }) => ({
      path: `/api/events/${obj.eventId}/tasks/${obj.taskId}/cancel`, body: { reason: 'Odwołanie syntetyczne' },
    }),
  },
  {
    id: 'events.signupCreate', module: 'events', method: 'POST', path: '/api/events/:eventId/tasks/:taskId/signups',
    targets: CLASS_TARGETS, allow: EVENT_EDIT, mfa: false, ok: 201, deny: eventDeny, fixture: 'fresh',
    object: { kind: 'eventTask', stage: 'draft' },
    build: ({ obj, key }) => ({
      path: `/api/events/${obj.eventId}/tasks/${obj.taskId}/signups`, headers: withKey(key),
      body: { userId: 'u-fx-board' },
    }),
  },
  {
    id: 'events.signupWithdraw', module: 'events',
    method: 'POST', path: '/api/events/:eventId/tasks/:taskId/signups/:signupId/withdraw',
    targets: CLASS_TARGETS, allow: EVENT_EDIT, mfa: false, ok: 200, deny: eventDeny, fixture: 'fresh',
    object: { kind: 'eventTaskSignup', stage: 'draft' },
    build: ({ obj }) => ({ path: `/api/events/${obj.eventId}/tasks/${obj.taskId}/signups/${obj.signupId}/withdraw` }),
  },

  // ---------- meetings (#13) ----------
  {
    id: 'meetings.list', module: 'meetings', method: 'GET', path: '/api/meetings?schoolYearId=:year',
    targets: YEAR_TARGETS, allow: { admin: SCHOOL_Y1, board: SCHOOL_Y1, audit: SCHOOL_Y1, boardA: SCHOOL_Y1 },
    mfa: false, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: `/api/meetings?schoolYearId=${target.schoolYearId}` }),
    // Przydział klasowy zarządu widzi na liście roku wyłącznie zebrania swojej klasy.
    contains: (actor) => (actor.classBoard ? [actor.classBoard] : Y1_ALL),
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
  // #135: zawsze wymaga MFA (rozstrzyga o przyjęciu dokumentu zebrania).
  meetingRoute('meetings.minutesApproval', 'POST', '/api/meetings/:meetingId/minutes/:minutesId/approval',
    (obj) => `/minutes/${obj.minutesId}/approval`, { stage: 'draftMinutes', body: () => ({}), mfa: true }),
  // #135: fixture udostępnia `internal` (bez MFA); `parents`/`public` wymagają MFA (nietestowane tu wprost).
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
  // #135: korekta zawsze zapisuje rozstrzygnięcie (adopted/rejected) — zawsze wymaga MFA.
  meetingRoute('meetings.resolutionCorrection', 'POST', '/api/meetings/:meetingId/resolutions/:resolutionId/corrections',
    (obj) => `/resolutions/${obj.resolutionId}/corrections`, {
      ok: 201, create: true, stage: 'finalResolution', body: () => ({ reason: 'Pomyłka w zapisie głosów', votesAgainst: 1 }),
      mfa: true,
    }),
  // #102: rejestr uchwał roku. Bez fixture (brak innych tras tworzy uchwały
  // domyślnie), więc odpowiedź 2xx jest pustą listą — trasa sprawdza tu
  // wyłącznie granicę roli/MFA; zakres klasowy i treść rejestru ma własny,
  // dedykowany test w tests/pg-meetings-resolutions.test.js.
  {
    id: 'meetings.resolutionRegister', module: 'meetings', method: 'GET',
    path: '/api/meetings/resolutions?schoolYearId=:year', targets: YEAR_TARGETS,
    allow: { admin: SCHOOL_Y1, board: SCHOOL_Y1, audit: SCHOOL_Y1, boardA: SCHOOL_Y1 },
    mfa: false, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: `/api/meetings/resolutions?schoolYearId=${target.schoolYearId}` }),
  },
  // #102: śledzenie wykonania uchwały — nie zagnieżdżone pod /:meetingId, więc
  // budowane ręcznie (nie przez meetingRoute), ale z tym samym fixture uchwały
  // przyjętej (stage 'finalResolution') co korekta wyżej.
  {
    id: 'meetings.resolutionExecution', module: 'meetings', method: 'POST',
    path: '/api/meetings/resolutions/:resolutionId/execution', targets: CLASS_TARGETS,
    allow: MEETING_MANAGE, mfa: false, ok: 201, deny: 403, fixture: 'fresh',
    object: { kind: 'meeting', stage: 'finalResolution' },
    build: ({ obj, key }) => ({
      path: `/api/meetings/resolutions/${obj.resolutionId}/execution`,
      body: json({ status: 'not_started' }), headers: withKey(key),
    }),
  },
  // ---------- import (#36) ----------
  // admin i zarząd z MFA, wyłącznie przydział bez klasy obejmujący rok importu.
  {
    id: 'import.options', module: 'import', method: 'GET', path: '/api/import/options', targets: ['-'],
    allow: { admin: ['-'], board: ['-'] }, mfa: true, ok: 200, deny: 403, fixture: null,
    build: () => ({ path: '/api/import/options' }),
  },
  {
    id: 'import.preview', module: 'import', method: 'POST', path: '/api/import/preview', targets: YEAR_TARGETS,
    allow: IMPORT, mfa: true, ok: 200, deny: 403, fixture: null,
    build: ({ target, key }) => ({ path: '/api/import/preview', body: importPayload(target, key) }),
  },
  {
    id: 'import.commit', module: 'import', method: 'POST', path: '/api/import/commit', targets: YEAR_TARGETS,
    allow: IMPORT, mfa: true, ok: 201, deny: 403, fixture: 'fresh', object: { kind: 'importPlan' },
    build: ({ obj, key }) => ({
      path: '/api/import/commit', headers: withKey(safeKey(key)),
      body: { ...obj.payload, fingerprint: obj.fingerprint, planDigest: obj.planDigest },
    }),
  },

  // ---------- documents (#39) ----------
  // financial: admin/zarząd/skarbnik bez klasy + MFA; board: admin/zarząd bez klasy; class: admin/zarząd
  // i przedstawiciel (także zarząd z przydziałem) wyłącznie przypisanej klasy. Odczyt bez uprawnień = 404.
  documentUpload('documents.uploadFinancial', 'financial', YEAR_TARGETS, DOC_FINANCIAL, true),
  documentUpload('documents.uploadBoard', 'board', YEAR_TARGETS, DOC_BOARD, false),
  documentUpload('documents.uploadClass', 'class', ['A', 'B', 'Y2'], DOC_CLASS, false),
  {
    id: 'documents.list', module: 'documents', method: 'GET', path: '/api/documents?schoolYearId=:year',
    targets: YEAR_TARGETS,
    allow: { admin: SCHOOL_Y1, board: SCHOOL_Y1, treasurer: SCHOOL_Y1, repA: SCHOOL_Y1, repB: SCHOOL_Y1, boardA: SCHOOL_Y1 },
    // Skarbnik widzi wyłącznie dowody finansowe, a te wymagają MFA.
    mfa: (actor) => actor.key === 'treasurer', ok: 200, deny: 403, fixture: null,
    needs: [['document', 'financial', YEAR_TARGETS], ['document', 'board', YEAR_TARGETS], ['document', 'class', ['A', 'B', 'Y2']]],
    build: ({ target }) => ({ path: `/api/documents?schoolYearId=${target.schoolYearId}` }),
    check: ({ actor, mfa, json }) => documentKindsCheck(actor, mfa, json),
  },
  documentRead('documents.getFinancial', '/api/documents/:financialDocumentId', 'financial', YEAR_TARGETS, DOC_FINANCIAL, true, ''),
  documentRead('documents.getBoard', '/api/documents/:boardDocumentId', 'board', YEAR_TARGETS, DOC_BOARD, false, ''),
  documentRead('documents.getClass', '/api/documents/:classDocumentId', 'class', ['A', 'B', 'Y2'], DOC_CLASS, false, ''),
  documentRead('documents.contentFinancial', '/api/documents/:financialDocumentId/content', 'financial', YEAR_TARGETS, DOC_FINANCIAL, true, '/content'),
  documentRead('documents.contentBoard', '/api/documents/:boardDocumentId/content', 'board', YEAR_TARGETS, DOC_BOARD, false, '/content'),
  documentRead('documents.contentClass', '/api/documents/:classDocumentId/content', 'class', ['A', 'B', 'Y2'], DOC_CLASS, false, '/content'),
  documentDescribe('documents.describeFinancial', '/api/documents/:financialDocumentId/description', 'financial', YEAR_TARGETS, DOC_FINANCIAL, true),
  documentDescribe('documents.describeBoard', '/api/documents/:boardDocumentId/description', 'board', YEAR_TARGETS, DOC_BOARD, false),
  documentDescribe('documents.describeClass', '/api/documents/:classDocumentId/description', 'class', ['A', 'B', 'Y2'], DOC_CLASS, false),

  // ---------- ledger (#38) ----------
  // admin/zarząd/skarbnik z MFA, przydział bez klasy w roku wpisu (docs/LEDGER.md).
  ledgerRead('ledger.list', '/api/ledger?schoolYearId=:year', '', ['W1']),
  ledgerRead('ledger.categories', '/api/ledger/categories?schoolYearId=:year', '/categories', ['W1']),
  ledgerRead('ledger.summary', '/api/ledger/summary?schoolYearId=:year', '/summary', []),
  ledgerRead('ledger.budget', '/api/ledger/budget?schoolYearId=:year', '/budget', []),
  ledgerRead('ledger.exportCsv', '/api/ledger/export.csv?schoolYearId=:year', '/export.csv', ['W1']),
  {
    id: 'ledger.create', module: 'ledger', method: 'POST', path: '/api/ledger', targets: YEAR_TARGETS,
    allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: null,
    build: ({ target, key }) => ({
      path: '/api/ledger', headers: withKey(key),
      body: { schoolYearId: target.schoolYearId, direction: 'income', amountCents: 500, categoryId: ledgerCategory(target),
        description: `Wpis ${marker(target.key)}`, occurredOn: yearDate(target, '10-05'), method: 'bank' },
    }),
  },
  {
    id: 'ledger.correction', module: 'ledger', method: 'POST', path: '/api/ledger/:ledgerEntryId/corrections',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: 'static',
    object: { kind: 'ledgerEntry' },
    build: ({ obj, key }) => ({
      path: `/api/ledger/${obj.ledgerEntryId}/corrections`, headers: withKey(key), body: { amountCents: 1, reason: 'Korekta syntetyczna' },
    }),
  },
  {
    // #144: przeksięgowanie (storno + wpis zastępczy) — jednorazowe na wpis, więc fixture 'fresh'.
    id: 'ledger.replacement', module: 'ledger', method: 'POST', path: '/api/ledger/:ledgerEntryId/replacement',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: 'fresh',
    object: { kind: 'ledgerEntry' },
    build: ({ target, obj, key }) => ({
      path: `/api/ledger/${obj.ledgerEntryId}/replacement`, headers: withKey(key),
      body: {
        schoolYearId: target.schoolYearId, direction: 'income', amountCents: 100000, categoryId: ledgerCategory(target),
        description: `Wpis zastępczy ${marker(target.key)}`, occurredOn: yearDate(target, '10-06'), method: 'bank',
        reason: 'Zła kategoria, korekta syntetyczna',
      },
    }),
  },
  {
    // #207: kategorie przez API zamiast SQL. Bez Idempotency-Key — dedup przez
    // UNIQUE(school_year_id, direction, name); `key` (unikalny na przypadek testu)
    // jako nazwa, żeby równoległe przypadki się nie zderzały.
    id: 'ledger.categoryCreate', module: 'ledger', method: 'POST', path: '/api/ledger/categories',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: null,
    build: ({ target, key }) => ({
      path: '/api/ledger/categories',
      body: { schoolYearId: target.schoolYearId, direction: 'expense', name: `Kat ${key}` },
    }),
  },
  {
    id: 'ledger.categoryDeactivate', module: 'ledger', method: 'POST',
    path: '/api/ledger/categories/:categoryId/deactivate', targets: YEAR_TARGETS,
    allow: FINANCIAL, mfa: true, ok: 200, deny: 403, fixture: 'fresh', object: { kind: 'ledgerCategory' },
    build: ({ obj }) => ({ path: `/api/ledger/categories/${obj.categoryId}/deactivate` }),
  },
  {
    // Kopiowanie wymaga przydziału bez klasy wyłącznie w roku DOCELOWYM
    // (rok źródłowy — tu YEAR_2 — nie wymaga dostępu: kopiowane są tylko
    // nazwy/kierunki kategorii, bez kwot).
    id: 'ledger.categoryCopy', module: 'ledger', method: 'POST', path: '/api/ledger/categories/copy',
    targets: ['W1'], allow: FINANCIAL, mfa: true, ok: 200, deny: 403, fixture: null,
    // Podgląd celowo zawiera NAZWY kategorii roku źródłowego (Y2), nawet gdy
    // aktor nie ma przydziału do tego roku — to nie kwoty ani dane rodzin,
    // patrz komentarz przy copyCategories w ledger.js.
    visible: (actor) => [...actor.scopes, 'Y2'],
    build: () => ({ path: '/api/ledger/categories/copy', body: { fromSchoolYearId: YEAR_2, toSchoolYearId: YEAR_1, dryRun: true } }),
  },

  // ---------- kasa i rachunek (#199) ----------
  // Przeniesienia i odczyt: admin/zarząd/skarbnik z MFA, przydział bez klasy w roku (jak księga).
  // Bilans otwarcia i jego poprawki: wyłącznie zarząd z MFA (docs/LEDGER.md).
  {
    id: 'ledgerCash.transfers', module: 'ledger-cash', method: 'GET', path: '/api/ledger/transfers?schoolYearId=:year',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: `/api/ledger/transfers?schoolYearId=${target.schoolYearId}` }),
  },
  {
    id: 'ledgerCash.createTransfer', module: 'ledger-cash', method: 'POST', path: '/api/ledger/transfers',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: null,
    build: ({ target, key }) => ({
      path: '/api/ledger/transfers', headers: withKey(key),
      body: { schoolYearId: target.schoolYearId, direction: 'cash_to_bank', amountCents: 100,
        transferredOn: yearDate(target, '10-10'), description: `Wpłata gotówki ${marker(target.key)}` },
    }),
  },
  {
    id: 'ledgerCash.openingBalance', module: 'ledger-cash', method: 'GET', path: '/api/ledger/opening-balance?schoolYearId=:year',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: `/api/ledger/opening-balance?schoolYearId=${target.schoolYearId}` }),
  },
  {
    // Osobna baza: rok 1 nie może mieć jeszcze bilansu otwarcia (jeden na rok).
    id: 'ledgerCash.createOpeningBalance', module: 'ledger-cash', method: 'POST', path: '/api/ledger/opening-balance',
    targets: YEAR_TARGETS, allow: { board: SCHOOL_Y1 }, mfa: true, ok: 201, deny: 403, fixture: null, group: 'ledgerOpening',
    build: ({ target, key }) => ({
      path: '/api/ledger/opening-balance', headers: withKey(key),
      body: { schoolYearId: target.schoolYearId, bankCents: 1000, cashCents: 500, note: 'Bilans syntetyczny' },
    }),
  },
  {
    id: 'ledgerCash.adjustOpeningBalance', module: 'ledger-cash', method: 'POST', path: '/api/ledger/opening-balance/adjustments',
    targets: YEAR_TARGETS, allow: { board: SCHOOL_Y1 }, mfa: true, ok: 201, deny: 403, fixture: 'static',
    object: { kind: 'openingBalance' },
    build: ({ target, key }) => ({
      path: '/api/ledger/opening-balance/adjustments', headers: withKey(key),
      body: { schoolYearId: target.schoolYearId, amountCents: 100, cashCents: 0, reason: 'Poprawka syntetyczna' },
    }),
  },

  // ---------- email (#10, #40) ----------
  // Szkic i kolejka: zarząd, skarbnik z MFA; zatwierdzenie: wyłącznie zarząd z MFA (inna osoba niż autor).
  // Admin techniczny nie ma dostępu. Przydział klasowy nie otwiera kampanii całego roku.
  {
    id: 'email.list', module: 'email', method: 'GET', path: '/api/email/campaigns?schoolYearId=:year', targets: YEAR_TARGETS,
    allow: EMAIL_EDIT, mfa: true, ok: 200, deny: 403, fixture: null,
    needs: [['campaign', 'snapshot', YEAR_TARGETS]],
    build: ({ target }) => ({ path: `/api/email/campaigns?schoolYearId=${target.schoolYearId}` }),
    contains: () => ['W1'],
  },
  {
    id: 'email.create', module: 'email', method: 'POST', path: '/api/email/campaigns', targets: YEAR_TARGETS,
    allow: EMAIL_EDIT, mfa: true, ok: 201, deny: 403, fixture: null,
    build: ({ target, key }) => ({ path: '/api/email/campaigns', headers: withKey(key), body: campaignBody(target) }),
  },
  emailRoute('email.status', 'GET', '', 'snapshot', { fixture: 'static', contains: () => ['W1'] }),
  emailRoute('email.update', 'PUT', '', 'draft', {
    body: (target) => ({ ...campaignBody(target), title: `Zmiana ${marker(target.key)}` }),
  }),
  emailRoute('email.snapshot', 'POST', '/snapshot', 'draft', {}),
  emailRoute('email.preview', 'GET', '/preview', 'snapshot', { fixture: 'static', contains: () => ['W1'] }),
  emailRoute('email.recipients', 'GET', '/recipients', 'snapshot', { fixture: 'static' }),
  emailRoute('email.report', 'GET', '/report', 'snapshot', { fixture: 'static', contains: () => ['W1'] }),
  emailRoute('email.attention', 'GET', '/attention', 'snapshot', { fixture: 'static' }),
  {
    // Rozstrzygnięcie delivery_unknown/error (#139): confirmed_delivered wystarcza board/treasurer;
    // confirmed_not_sent (silniejsze twierdzenie) wymaga roli board — sprawdzone osobno w pg-email.test.js.
    id: 'email.resolutions', module: 'email', method: 'POST', path: '/api/email/campaigns/:campaignId/resolutions',
    targets: YEAR_TARGETS, allow: EMAIL_EDIT, mfa: true, ok: 201, deny: 403, fixture: 'fresh',
    object: { kind: 'campaign', stage: 'failed' },
    build: ({ obj }) => ({
      path: `/api/email/campaigns/${obj.campaignId}/resolutions`,
      body: { outboxId: obj.outboxId, resolution: 'confirmed_delivered', evidenceCode: 'brevo_log_delivered' },
    }),
  },
  emailRoute('email.approve', 'POST', '/approve', 'snapshot', {
    allow: EMAIL_APPROVE, body: (_target, obj) => ({ contentHash: obj.contentHash, recipientsHash: obj.recipientsHash }),
  }),
  emailRoute('email.queue', 'POST', '/queue', 'approved', {}),
  emailRoute('email.pause', 'POST', '/pause', 'sending', {}),
  emailRoute('email.resume', 'POST', '/resume', 'paused', {}),
  emailRoute('email.cancel', 'POST', '/cancel', 'draft', {}),
  // Środowisko macierzy wstrzykuje transport (nigdy nie łączy się z siecią) i
  // adres z EMAIL_PREVIEW_RECIPIENTS, więc dozwolona osoba dostaje 201.
  emailRoute('email.testSend', 'POST', '/test-send', 'draft', {
    ok: 201, withKey: true, body: () => ({ recipientEmail: 'fx-preview@rada.example.invalid' }),
  }),
  {
    // Webhook Brevo: bez sesji i bez Origin; uwierzytelnia wspólny sekret (brak/zły sekret = 401, test niżej).
    id: 'email.webhook', module: 'email', method: 'POST', path: '/api/email/webhooks/brevo', targets: ['-'],
    allow: 'public', mfa: false, ok: 200, deny: 200, fixture: null,
    build: ({ key, fx }) => ({
      path: '/api/email/webhooks/brevo', headers: { Authorization: `Bearer ${fx.webhookSecret}` },
      body: { event: 'opened', email: 'nieznany@example.invalid', id: key, ts_event: 1791187200 },
    }),
  },

  // ---------- news (#14) ----------
  {
    id: 'news.public', module: 'news', method: 'GET', path: '/api/public/news', targets: ['-'],
    allow: 'public', mfa: false, ok: 200, deny: 200, fixture: null, needs: [['newsPost', 'published', ['W1']]],
    build: () => ({ path: '/api/public/news' }),
    visible: () => [], contains: () => ['PUBLIC'],
  },
  {
    id: 'news.list', module: 'news', method: 'GET', path: '/api/news?schoolYearId=:year', targets: YEAR_TARGETS,
    allow: { admin: SCHOOL_Y1, board: SCHOOL_Y1, repA: SCHOOL_Y1, repB: SCHOOL_Y1 }, mfa: false, ok: 200, deny: 403,
    fixture: null, needs: [['newsPost', 'draft', CLASS_TARGETS]],
    build: ({ target }) => ({ path: `/api/news?schoolYearId=${target.schoolYearId}` }),
    contains: (actor) => (actor.ownClass ? [actor.ownClass] : Y1_ALL),
  },
  {
    id: 'news.create', module: 'news', method: 'POST', path: '/api/news', targets: CLASS_TARGETS,
    allow: EVENT_EDIT, mfa: false, ok: 201, deny: 403, fixture: null,
    build: ({ target, key }) => ({
      path: '/api/news', headers: withKey(key),
      body: { schoolYearId: target.schoolYearId, classId: target.classId, title: `Wpis ${marker(target.key)}`, body: 'Treść syntetyczna.' },
    }),
  },
  {
    id: 'news.get', module: 'news', method: 'GET', path: '/api/news/:postId', targets: CLASS_TARGETS,
    allow: EVENT_EDIT, mfa: false, ok: 200, deny: 404, fixture: 'static', object: { kind: 'newsPost', stage: 'draft' },
    build: ({ obj }) => ({ path: `/api/news/${obj.postId}` }),
    contains: (_actor, target) => [target.key],
  },
  {
    id: 'news.update', module: 'news', method: 'PATCH', path: '/api/news/:postId', targets: CLASS_TARGETS,
    allow: EVENT_EDIT, mfa: false, ok: 200, deny: 404, fixture: 'fresh', object: { kind: 'newsPost', stage: 'draft' },
    build: ({ obj, target }) => ({ path: `/api/news/${obj.postId}`, body: { revision: 1, title: `Zmiana ${marker(target.key)}` } }),
  },
  newsAction('news.submit', 'submit', 'draft', EVENT_EDIT, 404),
  newsAction('news.approve', 'approve', 'submitted', EVENT_REVIEW, newsReviewDeny),
  newsAction('news.publish', 'publish', 'approved', EVENT_REVIEW, newsReviewDeny),
  newsAction('news.withdraw', 'withdraw', 'draft', EVENT_EDIT, 404, { reason: 'Wycofanie syntetyczne' }),
  {
    id: 'news.photos', module: 'news', method: 'GET', path: '/api/news-photos', targets: ['-'],
    allow: PHOTO_REGISTER, mfa: false, ok: 200, deny: 403, fixture: null, needs: [['photo', 'pending', ['-']]],
    build: () => ({ path: '/api/news-photos' }), visible: () => ['W1'], contains: () => ['W1'],
  },
  {
    id: 'news.photoRegister', module: 'news', method: 'POST', path: '/api/news-photos', targets: ['-'],
    allow: PHOTO_REGISTER, mfa: false, ok: 201, deny: 403, fixture: null, visible: () => ['W1'],
    build: ({ key }) => ({ path: '/api/news-photos', headers: withKey(key), body: photoBody(key) }),
  },
  {
    id: 'news.photoGet', module: 'news', method: 'GET', path: '/api/news-photos/:photoId', targets: ['-'],
    allow: PHOTO_REGISTER, mfa: false, ok: 200, deny: 403, fixture: 'static', object: { kind: 'photo', stage: 'pending' },
    build: ({ obj }) => ({ path: `/api/news-photos/${obj.photoId}` }), visible: () => ['W1'], contains: () => ['W1'],
  },
  photoAction('news.photoConsent', 'consents', PHOTO_REGISTER, 201, { subjectNo: 1, subjectKind: 'adult', consentDocumentRef: 'zgoda-syntetyczna-1' }),
  photoAction('news.photoVerify', 'verify', PHOTO_VERIFY, 200, {}),
  photoAction('news.photoRevoke', 'revoke', PHOTO_VERIFY, 200, { reason: 'Cofnięcie zgody (syntetyczne)' }),
  {
    // Plik obrazu (#96): surowe bajty PNG, nie JSON — Content-Type + Idempotency-Key.
    id: 'news.photoFile', module: 'news', method: 'POST', path: '/api/news-photos/:photoId/file', targets: ['-'],
    allow: PHOTO_REGISTER, mfa: false, ok: 201, deny: 403, fixture: 'fresh',
    object: { kind: 'photo', stage: 'pending' }, visible: () => ['W1'],
    build: ({ obj, key }) => ({
      path: `/api/news-photos/${obj.photoId}/file`,
      headers: { ...withKey(key), 'Content-Type': 'image/png' },
      body: pngBytes(),
    }),
  },
  // Trasa publiczna (#96): zdjęcie zweryfikowane, z plikiem, w opublikowanym
  // wpisie -> 200 dla każdego (bez sesji też) — sama treść nie zależy od roli.
  // Cofnięcie/wygaśnięcie/szkic -> 404 identyczne jak nieistniejące; ta ścieżka
  // ma dedykowany test w tests/pg-news.test.js (macierz sprawdza tu tylko, że
  // odpowiedź jest jednakowa dla każdego aktora, nie cały cykl życia pliku).
  {
    id: 'news.publicPhotoFileWeb', module: 'news', method: 'GET', path: '/api/public/news-photos/:photoId/web',
    targets: ['-'], allow: 'public', mfa: false, ok: 200, deny: 200, fixture: 'static',
    object: { kind: 'publicPhotoFile', stage: 'n/a' }, visible: () => [],
    build: ({ obj }) => ({ path: `/api/public/news-photos/${obj.photoId}/web` }),
  },
  {
    id: 'news.publicPhotoFileThumb', module: 'news', method: 'GET', path: '/api/public/news-photos/:photoId/thumb',
    targets: ['-'], allow: 'public', mfa: false, ok: 200, deny: 200, fixture: 'static',
    object: { kind: 'publicPhotoFile', stage: 'n/a' }, visible: () => [],
    build: ({ obj }) => ({ path: `/api/public/news-photos/${obj.photoId}/thumb` }),
  },

  // ---------- admin (#3, #4, #9) ----------
  // Wyłącznie admin z MFA, także odczyt. Moduł obejmuje konta całej szkoły, więc odpowiedź 2xx
  // może zawierać identyfikatory klas i lat spoza przydziału admina (visible: wszystkie).
  adminRoute('admin.users', 'GET', '/api/admin/users', {}),
  adminRoute('admin.userDisable', 'POST', '/api/admin/users/:userId/disable', {
    object: 'active', build: ({ obj }) => ({ path: `/api/admin/users/${obj.userId}/disable`, body: {} }),
  }),
  adminRoute('admin.userEnable', 'POST', '/api/admin/users/:userId/enable', {
    object: 'disabled', build: ({ obj }) => ({ path: `/api/admin/users/${obj.userId}/enable`, body: {} }),
  }),
  adminRoute('admin.userRevokeSessions', 'POST', '/api/admin/users/:userId/revoke-sessions', {
    object: 'active', build: ({ obj }) => ({ path: `/api/admin/users/${obj.userId}/revoke-sessions`, body: {} }),
  }),
  // Token resetu hasła i reset MFA innego konta (#3): jak cały moduł — wyłącznie admin z MFA.
  adminRoute('admin.userPasswordReset', 'POST', '/api/admin/users/:userId/password-reset', {
    ok: 201, object: 'active', build: ({ obj }) => ({ path: `/api/admin/users/${obj.userId}/password-reset`, body: {} }),
  }),
  adminRoute('admin.userMfaReset', 'POST', '/api/admin/users/:userId/mfa-reset', {
    object: 'withFactor', build: ({ obj }) => ({ path: `/api/admin/users/${obj.userId}/mfa-reset`, body: { confirm: obj.userId } }),
  }),
  adminRoute('admin.grants', 'GET', '/api/admin/grants', {}),
  adminRoute('admin.grantCreate', 'POST', '/api/admin/grants', {
    ok: 201, object: 'active',
    build: ({ obj }) => ({ path: '/api/admin/grants', body: { userId: obj.userId, role: 'board', schoolYearId: YEAR_1 } }),
  }),
  adminRoute('admin.grantRevoke', 'POST', '/api/admin/grants/:grantId/revoke', {
    object: 'grant', build: ({ obj }) => ({ path: `/api/admin/grants/${obj.grantId}/revoke`, body: {} }),
  }),
  adminRoute('admin.expireGrants', 'POST', '/api/admin/school-years/:schoolYearId/expire-grants', {
    object: 'finishedYear',
    build: ({ obj }) => ({ path: `/api/admin/school-years/${obj.schoolYearId}/expire-grants`, body: { confirm: obj.schoolYearId } }),
  }),
  adminRoute('admin.invitations', 'GET', '/api/admin/invitations', {}),
  adminRoute('admin.invitationCreate', 'POST', '/api/admin/invitations', {
    ok: 201,
    build: ({ key }) => ({ path: '/api/admin/invitations', body: { email: `zaproszenie-${safeKey(key).toLowerCase()}@example.invalid`, role: 'board', schoolYearId: YEAR_1 } }),
  }),
  adminRoute('admin.invitationRevoke', 'POST', '/api/admin/invitations/:invitationId/revoke', {
    object: 'invitation', build: ({ obj }) => ({ path: `/api/admin/invitations/${obj.invitationId}/revoke`, body: {} }),
  }),
  adminRoute('admin.invitationReissue', 'POST', '/api/admin/invitations/:invitationId/reissue', {
    ok: 201, object: 'invitation', build: ({ obj }) => ({ path: `/api/admin/invitations/${obj.invitationId}/reissue`, body: {} }),
  }),
  adminRoute('admin.schoolYears', 'GET', '/api/admin/school-years', {}),
  adminRoute('admin.classCoverage', 'GET', '/api/admin/class-coverage?schoolYearId=:year', {
    build: () => ({ path: `/api/admin/class-coverage?schoolYearId=${YEAR_1}` }),
  }),
  // Konfiguracja roku i klas (#78): wyłącznie admin z MFA, jak cały moduł.
  adminRoute('admin.schoolYearCreate', 'POST', '/api/admin/school-years', {
    ok: 201,
    build: ({ key }) => ({
      path: '/api/admin/school-years',
      body: { id: `y-matrix-${safeKey(key).toLowerCase()}`, label: `Rok macierzy ${safeKey(key)}`, startsOn: '2030-09-01', endsOn: '2031-08-31' },
    }),
  }),
  adminRoute('admin.classesCreate', 'POST', '/api/admin/school-years/:schoolYearId/classes', {
    ok: 201, object: 'emptySchoolYear',
    build: ({ obj, key }) => ({ path: `/api/admin/school-years/${obj.schoolYearId}/classes`, body: { names: [`Klasa-${safeKey(key)}`] } }),
  }),
  adminRoute('admin.audit', 'GET', '/api/admin/audit', {}),
  // Stan operacyjny (#149): kolejka e-mail, ostatnie kopie zapasowe — bez adresów, nazw rodzin i treści.
  adminRoute('admin.opsStatus', 'GET', '/api/admin/ops-status', {}),

  // ---------- reconciliation (#7, #15) ----------
  // Uzgodnienia: admin/zarząd/skarbnik z MFA w roku uzgodnienia; raport: Komisja Rewizyjna/zarząd/skarbnik z MFA.
  {
    id: 'reconciliation.list', module: 'reconciliation', method: 'GET', path: '/api/reconciliations?schoolYearId=:year',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 200, deny: 403, fixture: null,
    needs: [['reconciliation', 'withLine', YEAR_TARGETS]],
    build: ({ target }) => ({ path: `/api/reconciliations?schoolYearId=${target.schoolYearId}` }),
    contains: () => ['W1'],
  },
  {
    id: 'reconciliation.create', module: 'reconciliation', method: 'POST', path: '/api/reconciliations',
    targets: YEAR_TARGETS, allow: FINANCIAL, mfa: true, ok: 201, deny: 403, fixture: null,
    build: ({ target, key }) => ({
      path: '/api/reconciliations', headers: withKey(key),
      body: { schoolYearId: target.schoolYearId, statementDate: statementDate(target), statementBalanceCents: 100000, notes: `Uzgodnienie ${marker(target.key)}` },
    }),
  },
  reconciliationRoute('reconciliation.get', 'GET', '', 'withLine', { fixture: 'static', contains: () => ['W1'] }),
  reconciliationRoute('reconciliation.lines', 'POST', '/lines', 'draft', {
    ok: 201, withKey: true,
    body: (target) => ({ lines: [{ bookedOn: yearDate(target, '10-02'), amountCents: 1234, reference: 'Tytuł syntetyczny' }] }),
  }),
  reconciliationRoute('reconciliation.linePayment', 'POST', '/lines/:lineId/payment', 'withLine', {
    ok: 201, withKey: true, suffix: (obj) => `/lines/${obj.statementLineId}/payment`, body: () => ({ householdId: null }),
  }),
  reconciliationRoute('reconciliation.suggestions', 'GET', '/suggestions', 'withLine', { fixture: 'static' }),
  reconciliationRoute('reconciliation.match', 'POST', '/matches', 'withLine', {
    ok: 201, withKey: true, body: (_target, obj) => ({ statementLineId: obj.statementLineId, paymentEntryId: obj.paymentEntryId }),
  }),
  reconciliationRoute('reconciliation.matchRevocation', 'POST', '/matches/:matchId/revocation', 'matched', {
    suffix: (obj) => `/matches/${obj.matchId}/revocation`, body: () => ({ reason: 'Pomyłka syntetyczna' }),
  }),
  reconciliationRoute('reconciliation.confirm', 'POST', '/confirm', 'draft', {
    body: () => ({ confirmationNote: 'Różnica wyjaśniona (syntetyczne)' }),
  }),
  {
    id: 'reconciliation.auditReport', module: 'reconciliation', method: 'GET', path: '/api/reports/audit?schoolYearId=:year&format=json',
    targets: YEAR_TARGETS, allow: { audit: SCHOOL_Y1, board: SCHOOL_Y1, treasurer: SCHOOL_Y1 }, mfa: true, ok: 200, deny: 403,
    fixture: null, needs: [['ledgerEntry', undefined, YEAR_TARGETS]],
    build: ({ target }) => ({ path: `/api/reports/audit?schoolYearId=${target.schoolYearId}&format=json` }),
  },

  // ---------- sprawozdanie roczne i przepływy (#125) ----------
  // Zarząd i skarbnik z MFA; admin, audit, principal, przedstawiciel: 403 (D-08/D-09).
  {
    id: 'financialReports.annual', module: 'financial-reports', method: 'GET', path: '/api/reports/annual?schoolYearId=:year&format=json',
    targets: YEAR_TARGETS, allow: { board: SCHOOL_Y1, treasurer: SCHOOL_Y1 }, mfa: true, ok: 200, deny: 403,
    fixture: null, needs: [['ledgerEntry', undefined, YEAR_TARGETS]],
    build: ({ target }) => ({ path: `/api/reports/annual?schoolYearId=${target.schoolYearId}&format=json` }),
  },
  {
    id: 'financialReports.cashFlow', module: 'financial-reports', method: 'GET', path: '/api/reports/cash-flow?schoolYearId=:year',
    targets: YEAR_TARGETS, allow: { board: SCHOOL_Y1, treasurer: SCHOOL_Y1 }, mfa: true, ok: 200, deny: 403,
    fixture: null, needs: [['ledgerEntry', undefined, YEAR_TARGETS]],
    build: ({ target }) => ({ path: `/api/reports/cash-flow?schoolYearId=${target.schoolYearId}` }),
  },

  // ---------- exports (#9) ----------
  {
    id: 'exports.yearly', module: 'exports', method: 'POST', path: '/api/exports', targets: YEAR_TARGETS,
    allow: { admin: SCHOOL_Y1, board: SCHOOL_Y1 }, mfa: true, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: '/api/exports', body: { schoolYearId: target.schoolYearId } }),
    contains: () => ['A', 'B'],
  },
  {
    id: 'exports.classRoster', module: 'exports', method: 'GET', path: '/api/exports/class-roster?classId=:class',
    targets: ['A', 'B', 'Y2'], allow: CLASS_READ_ALL, mfa: true, ok: 200, deny: 403, fixture: null,
    build: ({ target }) => ({ path: `/api/exports/class-roster?classId=${target.classId}` }),
    contains: (_actor, target) => [target.key],
  },

  // ---------- families (#5) ----------
  // Odczyt: admin/zarząd/skarbnik (klasy roku przydziału), przedstawiciel i przydział klasowy — tylko własna klasa.
  // Obiekt spoza zakresu = 404 (jak nieistniejący). Zmiany: admin i zarząd.
  {
    id: 'families.classes', module: 'families', method: 'GET', path: '/api/classes', targets: ['-'],
    allow: { admin: ['-'], board: ['-'], treasurer: ['-'], repA: ['-'], repB: ['-'], boardA: ['-'] },
    mfa: false, ok: 200, deny: 403, fixture: null,
    build: () => ({ path: '/api/classes' }),
    check: ({ actor, json }) => classListCheck(actor, json),
  },
  {
    id: 'families.classStudents', module: 'families', method: 'GET', path: '/api/classes/:classId/students',
    targets: ['A', 'B', 'Y2'], allow: FAMILY_READ, mfa: false, ok: 200, deny: familyReadDeny, fixture: null,
    build: ({ target }) => ({ path: `/api/classes/${target.classId}/students` }),
    contains: (_actor, target) => [target.key],
  },
  {
    id: 'families.household', module: 'families', method: 'GET', path: '/api/households/:householdId',
    targets: ['A', 'B', 'Y2'], allow: FAMILY_READ, mfa: false, ok: 200, deny: familyReadDeny, fixture: 'static', object: { kind: 'household' },
    build: ({ obj }) => ({ path: `/api/households/${obj.householdId}` }),
    contains: (_actor, target) => [target.key],
  },
  {
    id: 'families.guardianContact', module: 'families', method: 'PATCH', path: '/api/guardians/:guardianId/contact',
    targets: ['A', 'B', 'Y2'], allow: FAMILY_EDIT, mfa: false, ok: 200, deny: familyEditDeny, fixture: 'fresh', object: { kind: 'household' },
    build: ({ obj }) => ({ path: `/api/guardians/${obj.guardianId}/contact`, body: { contactAllowed: false, reason: 'Prośba opiekuna (syntetyczne)' } }),
  },
  {
    id: 'families.relationContact', module: 'families', method: 'PATCH', path: '/api/guardians/:guardianId/students/:studentId',
    targets: ['A', 'B', 'Y2'], allow: FAMILY_EDIT, mfa: false, ok: 200, deny: familyEditDeny, fixture: 'fresh', object: { kind: 'household' },
    build: ({ obj }) => ({
      path: `/api/guardians/${obj.guardianId}/students/${obj.studentId}`,
      body: { contactAllowed: false, reason: 'Prośba opiekuna (syntetyczne)' },
    }),
  },
  {
    id: 'families.enrollment', module: 'families', method: 'POST', path: '/api/students/:studentId/enrollments',
    targets: ['A', 'B', 'Y2'], allow: FAMILY_EDIT, mfa: false, ok: 200, deny: familyEditDeny, fixture: 'fresh', object: { kind: 'household' },
    // Przypisanie do tej samej klasy (200, bez zmiany) — macierz sprawdza granicę zakresu, nie logikę przeniesień.
    build: ({ obj, target }) => ({
      path: `/api/students/${obj.studentId}/enrollments`,
      body: { schoolYearId: target.schoolYearId, classId: target.classId, effectiveOn: yearDate(target, '10-01'), reason: 'Korekta przydziału (syntetyczne)' },
    }),
  },
  {
    id: 'families.enrollmentEnd', module: 'families', method: 'POST', path: '/api/students/:studentId/enrollments/:enrollmentId/end',
    targets: ['A', 'B', 'Y2'], allow: FAMILY_EDIT, mfa: false, ok: 200, deny: familyEditDeny, fixture: 'fresh', object: { kind: 'household' },
    // Odejście ze szkoły (#86) — data w przeszłości, żeby uczeń zniknął z bieżących list od razu.
    build: ({ obj }) => ({
      path: `/api/students/${obj.studentId}/enrollments/${obj.enrollmentId}/end`,
      body: { endedOn: '2020-01-01', reason: 'Odejście ze szkoły (syntetyczne)' },
    }),
  },

  // ---------- print (#11) ----------
  {
    id: 'print.cards', module: 'print', method: 'GET', path: '/api/print/cards?schoolYearId=:year&classId=:class',
    targets: CLASS_TARGETS, allow: PRINT, mfa: false, ok: 200, deny: printDeny, fixture: null,
    build: ({ target }) => ({ path: `/api/print/cards?schoolYearId=${target.schoolYearId}${target.classId ? `&classId=${target.classId}` : ''}` }),
    contains: (_actor, target) => (target.classId ? [target.key] : ['A', 'B']),
    check: ({ actor, mfa, json }) => printPaymentCheck(actor, mfa, json),
  },

  // ---------- representative (#118) ----------
  // Pulpit przedstawiciela: wyłącznie rola `representative` (nie zarząd nawet
  // z przydziałem klasy) — własne przypisane klasy, wyliczone z przydziałów,
  // bez parametru classId w ścieżce. Trasa nie przyjmuje zakresu w żądaniu
  // (tylko schoolYearId) — pojedynczy target '-' jak families.classes; zakres
  // sprawdzamy treścią odpowiedzi (classListCheck), nie odmową per-target.
  {
    id: 'representative.overview', module: 'representative', method: 'GET',
    path: '/api/representative/overview?schoolYearId=:year',
    targets: ['-'], allow: { repA: ['-'], repB: ['-'] }, mfa: false, ok: 200, deny: 403, fixture: null,
    build: () => ({ path: `/api/representative/overview?schoolYearId=${YEAR_1}` }),
    check: ({ actor, json }) => classListCheck(actor, json),
  },

  // ---------- board (#131) ----------
  // Pulpit zarządu: statystyki per klasa. Admin/zarząd bez przydziału klasowego
  // (przydział zarządu ograniczony do klasy — `boardA` — nie otwiera tego
  // widoku, SR-01); skarbnik i inne role — 403. MFA jest już wymuszone przez
  // bramkę routera dla admin/board (mfa-policy.js), stąd `mfa: true` tutaj.
  {
    id: 'board.overview', module: 'board', method: 'GET',
    path: '/api/board/overview?schoolYearId=:year',
    targets: ['-'], allow: { admin: ['-'], board: ['-'] }, mfa: true, ok: 200, deny: 403, fixture: null,
    build: () => ({ path: `/api/board/overview?schoolYearId=${YEAR_1}` }),
    check: ({ actor, json }) => classListCheck(actor, json),
  },

  // ---------- mfa (#3) ----------
  // Każda sesja (także bez przydziału) zarządza wyłącznie własnym czynnikiem; nowy użytkownik na przypadek.
  mfaRoute('mfa.enroll', '/api/mfa/enroll', 201, null),
  mfaRoute('mfa.confirm', '/api/mfa/confirm', 200, 'enrolled'),
  mfaRoute('mfa.verify', '/api/mfa/verify', 200, 'confirmed'),
  mfaRoute('mfa.recovery', '/api/mfa/recovery', 200, 'confirmed'),
  mfaRoute('mfa.revokeAll', '/api/sessions/revoke-all', 200, null),

  // ---------- login (#3, D-10) ----------
  // Logowanie, przyjęcie zaproszenia i reset hasła działają bez sesji (cookie jest ignorowane) —
  // uwierzytelnia je hasło albo jednorazowy token; zwolnione z bramki MFA. Zgodny Origin sprawdza router.
  {
    id: 'login.password', module: 'login', method: 'POST', path: '/api/login', targets: ['-'],
    allow: 'public', mfa: false, ok: 200, deny: 200, fixture: 'static', object: { kind: 'loginAccount' },
    build: ({ obj }) => ({ path: '/api/login', body: { email: obj.email, password: obj.password } }),
  },
  {
    // Stan własnej sesji dla ekranu logowania; zwolniony z bramki MFA (ekran musi wiedzieć, że trzeba zapisać MFA).
    id: 'login.state', module: 'login', method: 'GET', path: '/api/auth/state', targets: ['-'],
    allow: 'authenticated', mfa: false, ok: 200, deny: 403, fixture: null,
    build: () => ({ path: '/api/auth/state' }),
  },
  {
    id: 'login.invitationAccept', module: 'login', method: 'POST', path: '/api/invitations/accept', targets: ['-'],
    allow: 'public', mfa: false, ok: 201, deny: 201, fixture: 'fresh', object: { kind: 'invitationToken' },
    // #164: nowe konto wymaga zgodnego powtórzenia hasła (bez niego: 400 password_mismatch).
    build: ({ obj }) => ({ path: '/api/invitations/accept', body: { token: obj.token, password: obj.password, passwordRepeat: obj.password } }),
  },
  {
    id: 'login.passwordReset', module: 'login', method: 'POST', path: '/api/password/reset', targets: ['-'],
    allow: 'public', mfa: false, ok: 200, deny: 200, fixture: 'fresh', object: { kind: 'passwordResetToken' },
    build: ({ obj }) => ({ path: '/api/password/reset', body: { token: obj.token, newPassword: obj.newPassword } }),
  },
  {
    // Każdy zalogowany zmienia własne hasło; trasa NIE jest zwolniona z bramki MFA, więc admin/zarząd/skarbnik
    // bez MFA dostają 403 (mfaGateBlocks). Nowy użytkownik na przypadek — zmiana wylogowuje inne sesje konta.
    id: 'login.passwordChange', module: 'login', method: 'POST', path: '/api/password/change', targets: ['-'],
    allow: 'authenticated', mfa: false, ok: 200, deny: 403, fixture: 'fresh', object: { kind: 'ownPassword' }, freshUser: true,
    build: ({ obj }) => ({
      path: '/api/password/change',
      body: { currentPassword: obj?.password ?? 'Nieznane haslo syntetyczne', newPassword: obj?.newPassword ?? 'Nowe haslo syntetyczne 1' },
    }),
  },

  // ---------- year-close (#15) ----------
  // Zarząd i skarbnik (odczyt, lista kontrolna), zamknięcie: wyłącznie zarząd; MFA, przydział bez klasy.
  // Osobna baza: zamknięcie roku 1 wygasza przydziały roku 1, więc `close` jest ostatnią trasą grupy.
  yearCloseRoute('yearClose.status', 'GET', '/api/year-close/:schoolYearId', '', YEAR_CLOSE_READ, 200),
  yearCloseRoute('yearClose.start', 'POST', '/api/year-close/:schoolYearId/start', '/start', YEAR_CLOSE_BOARD, 200, {
    body: () => ({ nextSchoolYearId: YEAR_2 }),
  }),
  yearCloseRoute('yearClose.checklist', 'POST', '/api/year-close/:schoolYearId/checklist/:item', null, YEAR_CLOSE_READ, 201, {
    fixture: 'fresh', object: { kind: 'checklistItem' },
    suffix: (obj) => `/checklist/${obj.item}`, body: () => ({ note: 'Potwierdzenie syntetyczne' }),
  }),
  yearCloseRoute('yearClose.handover', 'GET', '/api/year-close/:schoolYearId/handover', '/handover', YEAR_CLOSE_READ, 200),
  yearCloseRoute('yearClose.close', 'POST', '/api/year-close/:schoolYearId/close', '/close', YEAR_CLOSE_BOARD, 200, {
    body: () => ({}),
  }),
].map((route) => Object.freeze(route)));

export function requiresMfa(route, actor) {
  return typeof route.mfa === 'function' ? Boolean(route.mfa(actor)) : Boolean(route.mfa);
}

export function denyStatus(route, actor, targetKey, mfa) {
  return typeof route.deny === 'function' ? route.deny(actor, targetKey, mfa) : route.deny;
}

// Bramka MFA routera (src/pg/mfa-policy.js): konto z aktywną rolą z
// MFA_REQUIRED_ROLES (domyślnie admin, board, treasurer) bez potwierdzonego
// czynnika i bez sesji z MFA dostaje 403 mfa_enrollment_required na każdej
// trasie poza zwolnionymi. Aktorzy macierzy nie mają zapisanych czynników.
const MFA_REQUIRED_ROLES = new Set(['admin', 'board', 'treasurer']);
// Czy bramka zatrzymałaby tę sesję na trasie chronionej (niezależnie od zwolnień trasy).
export function mfaPending(actor, mfa) {
  if (mfa || actor.unauthenticated) return false;
  return actor.grants.some((grant) => MFA_REQUIRED_ROLES.has(grant.role) && !grant.revoked && !grant.expiresAt);
}
export function mfaGateBlocks(route, actor, mfa) {
  if (isMfaGateExempt(route.path.split('?')[0])) return false;
  return mfaPending(actor, mfa);
}

// Każde zwolnienie z bramki MFA (src/pg/mfa-policy.js) ma uzasadnienie; zasada (#189): trasa
// zwolniona zmienia wyłącznie stan bieżącej sesji albo działa bez sesji i nie ujawnia ról.
export const MFA_GATE_EXEMPT_REASONS = Object.freeze({
  '/api/session': 'własna sesja (id, e-mail, stan MFA) — ekran MFA musi wiedzieć, kto jest zalogowany',
  '/api/access': 'bez potwierdzonego MFA zwraca pustą listę przydziałów i mfaRequired (#189)',
  '/api/logout': 'wylogowuje wyłącznie bieżącą sesję',
  '/api/sessions/revoke-all': 'konto z czynnikiem bez potwierdzonego MFA wycofuje wyłącznie bieżącą sesję (#189)',
  '/api/login': 'działa bez sesji; tworzy nową sesję bez MFA',
  '/api/auth/state': 'stan własnej sesji dla ekranu logowania (bez ról)',
  '/api/invitations/accept': 'działa bez sesji; uwierzytelnia token zaproszenia',
  '/api/password/reset': 'działa bez sesji; uwierzytelnia token resetu',
  '/api/meetings/public-minutes': 'publiczne dane zatwierdzone',
  '/api/email/webhooks/brevo': 'webhook bez sesji (sekret Brevo)',
  '/api/mfa/': 'zapis i potwierdzenie MFA; limity błędów per sesja, wyższy sufit per konto (#189)',
  '/api/public/': 'publiczne dane zatwierdzone',
});

// Oczekiwany status dla (trasa, aktor, MFA, zakres) — zamierzona polityka, nie stan kodu.
export function expectedStatus(route, actor, mfa, targetKey) {
  if (route.allow === 'public') return route.ok;
  if (actor.unauthenticated) return 401;
  if (mfaGateBlocks(route, actor, mfa)) return 403;
  if (route.allow === 'authenticated') return route.ok;
  const scopes = route.allow[actor.key] ?? [];
  if (!scopes.includes(targetKey)) return denyStatus(route, actor, targetKey, mfa);
  if (requiresMfa(route, actor) && !mfa) return route.mfaDeny ?? 403;
  return route.ok;
}

// Znana luka polityki dla przypadku (tekst) albo undefined. Przypadek nadal jest wykonywany,
// a jego rozbieżność trafia do osobnego testu `todo` (CI zielone, luka widoczna w raporcie).
export function todoReason(route, actor, mfa, targetKey) {
  return typeof route.todo === 'function' ? route.todo(actor, mfa, targetKey) : undefined;
}

// Zakresy, których znaczniki mogą wystąpić w odpowiedzi 2xx.
export function visibleScopes(route, actor, targetKey) {
  if (route.visible) return route.visible(actor, TARGETS[targetKey]);
  return actor.scopes;
}
