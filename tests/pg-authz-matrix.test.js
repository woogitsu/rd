// Macierz autoryzacji na rzeczywistych trasach API PostgreSQL (issue #4).
//
// Dla każdej trasy z tests/helpers/route-matrix.js i każdego aktora (role, przydział klasowy
// zarządu, brak przydziału, przydział wygasły/cofnięty, konto wyłączone, sesja wygasła/cofnięta,
// brak sesji) × MFA wł./wył. × zakres (własna klasa / inna klasa / dane ogólnoszkolne / inny rok)
// sprawdzamy:
//   1. status HTTP (401 / 403 / 404 / 2xx) zgodny z tabelą (zamierzona polityka),
//   2. odpowiedź odmowna nie zawiera żadnego syntetycznego znacznika danych,
//   3. odpowiedź 2xx nie zawiera znaczników zakresu, do którego aktor nie ma przydziału
//      (np. przedstawiciel 1A nigdy nie widzi danych 1B ani roku 2),
//   4. odmowa żądania zmieniającego stan niczego nie zapisuje (liczniki tabel i dziennika zdarzeń bez zmian).
// Przypadki oznaczone w macierzy `todo` (znane luki, np. SR-01) są wykonywane, ale ich rozbieżności
// trafiają do osobnego testu `todo` — CI pozostaje zielone, a luka jest widoczna w raporcie.
// Meta-test pilnuje, by każdy moduł z ROUTES i każda ścieżka w jego kodzie miały wpis w macierzy.
// Wyłącznie dane syntetyczne (domeny .invalid, znaczniki MRK-…). Żadna trasa nie wysyła poczty.
//
// #111: testy tras są w tests/helpers/authz-matrix.js, podzielone na MATRIX_PARTS części. Ten plik
// uruchamia część 1, testy uzupełniające i meta-testy; części 2 i 3 — pg-authz-matrix-2/-3.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handlePgRequest, ROUTES } from '../src/pg/app.js';
import { AUDIT_ROW_PARENTS, AUDIT_ROW_ROUTE_EXEMPT, AUDIT_ROW_TECHNICAL, rowCoverageTables } from './helpers/audit-row-coverage.js';
import { MFA_GATE_EXEMPT_EXACT, MFA_GATE_EXEMPT_PREFIXES } from '../src/pg/mfa-policy.js';
import { request } from './helpers/pg.js';
import {
  ACTOR_KEYS, ACTORS, MARKERS, MFA_GATE_EXEMPT_REASONS, REFERENCE_CASES, ROUTE_MATRIX, SCOPED_MARKER_KEYS, TARGETS, denyStatus,
  marker,
} from './helpers/route-matrix.js';
import { assertEvery } from './helpers/assertions.js';
import {
  AUDIT_ACTORLESS_ROUTES, AUDIT_EXEMPT_ROUTES, MATRIX_PART_STARTS, MATRIX_PARTS, WEBHOOK_SECRET, allMatrixRoutes, caseList, makeObject,
  matrixContext, matrixPart, matrixUnit, nextKey, registerMatrixRoutes, runCase, staticObject, writeFingerprint,
} from './helpers/authz-matrix.js';

registerMatrixRoutes(1);

test('meta: części macierzy (#111) pokrywają każdą trasę dokładnie raz, w kolejności macierzy i bez rozcinania modułu', () => {
  const routes = allMatrixRoutes();
  const parts = Array.from({ length: MATRIX_PARTS }, (_, index) => matrixPart(routes, index + 1));
  for (const [index, part] of parts.entries()) assert.ok(part.length > 0, `część ${index + 1} jest pusta`);
  // Sklejenie części w kolejności daje dokładnie całą macierz: każda trasa raz, ta sama kolejność.
  assert.deepEqual(parts.flat(), routes);
  const partOfUnit = new Map();
  parts.forEach((part, index) => {
    for (const route of part) {
      const unit = matrixUnit(route);
      if (!partOfUnit.has(unit)) partOfUnit.set(unit, index + 1);
      assert.equal(partOfUnit.get(unit), index + 1, `${unit} (${route.id}) rozcięty między części ${partOfUnit.get(unit)} i ${index + 1}`);
    }
  });
  for (const [index, module] of MATRIX_PART_STARTS.entries()) assert.equal(matrixUnit(parts[index + 1][0]), module);
  assert.throws(() => matrixPart(routes, MATRIX_PARTS + 1), /poza zakresem/);
  assert.throws(() => matrixPart(routes.filter((route) => route.module !== MATRIX_PART_STARTS[0]), 2), /brak modułu/);
});

// #214: `todo` w macierzy nie oblewa CI, więc bez limitu jest wygodnym miejscem
// na ukrycie nowej regresji uprawnień. Dopuszczalne `todo` to WYŁĄCZNIE wpisy
// z listy poniżej: klucz to id trasy, wartość to numer otwartego issue. Lista
// jest dziś pusta. Nowe `todo` bez wpisu oraz wpis bez `todo` w macierzy (lub bez
// numeru issue) oblewają test — luka musi być zgłoszona, nie schowana.
export const ALLOWED_TODO = Object.freeze({
  // 'route.id': '#NNN',
});

export function todoViolations(routes, allowed, listCases = caseList) {
  const problems = [];
  const withTodo = new Set();
  for (const route of routes) {
    if (listCases(route).some((item) => item.todo)) withTodo.add(route.id);
  }
  for (const id of withTodo) {
    if (!Object.hasOwn(allowed, id)) problems.push(`trasa ${id} ma \`todo\` bez wpisu w ALLOWED_TODO`);
  }
  for (const [id, issue] of Object.entries(allowed)) {
    if (!/^#\d+$/.test(String(issue))) problems.push(`wpis ${id} nie wskazuje numeru issue (#NNN)`);
    if (!withTodo.has(id)) problems.push(`wpis ${id} w ALLOWED_TODO nie ma odpowiadającego \`todo\` w macierzy`);
  }
  return problems;
}

test('macierz uprawnień: `todo` tylko z listy ALLOWED_TODO wskazującej issue (#214)', () => {
  assert.deepEqual(todoViolations(ROUTE_MATRIX, ALLOWED_TODO), []);
});

test('meta-test `todo` wykrywa nowe `todo` bez wpisu, wpis martwy i wpis bez issue (kontrola pozytywna)', () => {
  const fakeRoutes = [
    { id: 'a.route', targets: [], todo: () => 'luka' },
    { id: 'b.route', targets: [] },
  ];
  const listCases = (route) => [{ todo: route.todo?.() }];
  assert.equal(todoViolations(fakeRoutes, {}, listCases).length, 1, 'todo bez wpisu');
  assert.deepEqual(todoViolations(fakeRoutes, { 'a.route': '#214' }, listCases), []);
  assert.equal(todoViolations(fakeRoutes, { 'a.route': 'kiedyś' }, listCases).length, 1, 'wpis bez numeru issue');
  assert.equal(todoViolations(fakeRoutes, { 'a.route': '#214', 'b.route': '#1' }, listCases).length, 1, 'martwy wpis');
});

// ---------- identyfikatory w treści żądania: spoza zakresu = nieistniejący (#205, SR-07) ----------

for (const item of REFERENCE_CASES) {
  test(`identyfikator w treści: ${item.id} — spoza zakresu i nieistniejący dają tę samą odmowę, bez zapisu`, async () => {
    const ctx = await matrixContext();
    const route = ROUTE_MATRIX.find((entry) => entry.id === item.routeId);
    assert.ok(route, `brak trasy ${item.routeId} w macierzy`);
    const target = TARGETS[item.target];
    for (const actorKey of item.actors) {
      const cookie = ctx.sessions[actorKey][true];
      const values = [...item.outOfScope, item.missing, item.inScope];
      // Obiekty (zebranie, wpłata nieprzypisana) powstają PRZED zdjęciem śladu zapisu.
      const objects = new Map();
      for (const value of values) {
        objects.set(value, route.object ? await makeObject(ctx, route.object, target, { cookie, route: route.id, success: true }) : null);
      }
      const send = async (value) => {
        const built = await route.build({ target, obj: objects.get(value), key: nextKey(`ref-${item.id}`), fx: ctx.fx });
        const response = await handlePgRequest(request(built.path, {
          method: route.method, body: item.body(value, { target, actorKey }),
          headers: { 'Idempotency-Key': nextKey(`ref-key-${actorKey}`) }, cookie,
        }), ctx.env);
        const text = await response.text();
        return { status: response.status, text };
      };
      const before = await writeFingerprint(ctx.db);
      const refused = [];
      for (const value of [...item.outOfScope, item.missing]) refused.push({ value, ...(await send(value)) });
      for (const result of refused) {
        assert.equal(result.status, item.denied, `${actorKey}/${result.value}: ${result.text}`);
        assert.equal(JSON.parse(result.text).error, item.deniedError, `${actorKey}/${result.value}`);
        assert.equal(result.text, refused[refused.length - 1].text, `${actorKey}/${result.value}: odpowiedź odróżnia spoza zakresu od nieistniejącego`);
        for (const scope of SCOPED_MARKER_KEYS) assert.ok(!MARKERS[scope].some((value) => result.text.includes(value)), `${actorKey}: odmowa zawiera dane ${scope}`);
      }
      assert.deepEqual(await writeFingerprint(ctx.db), before, `${actorKey}: odmowa zmieniła dane`);
      const accepted = await send(item.inScope);
      assert.equal(accepted.status, item.ok, `${actorKey}/${item.inScope}: ${accepted.text}`);
    }
  });
}

// ---------- testy uzupełniające (poza macierzą) ----------

test('email: webhook Brevo bez sekretu albo ze złym sekretem — 401 i brak zapisu', async () => {
  const ctx = await matrixContext();
  const before = await writeFingerprint(ctx.db);
  for (const headers of [{}, { Authorization: `Bearer ${'x'.repeat(48)}` }, { Authorization: `Bearer ${WEBHOOK_SECRET}x` }]) {
    const response = await handlePgRequest(request('/api/email/webhooks/brevo', {
      method: 'POST', origin: false, headers, body: { event: 'hard_bounce', email: 'opiekun-a@example.invalid', id: 1 },
    }), ctx.env);
    assert.equal(response.status, 401);
  }
  assert.deepEqual(await writeFingerprint(ctx.db), before);
});

test('families: rodzeństwo w 1A i 1B — przedstawiciel widzi wyłącznie dziecko własnej klasy', async () => {
  const ctx = await matrixContext();
  // Zarząd (także z przydziałem klasy) i skarbnik przechodzą bramkę MFA routera tylko z sesją z MFA.
  for (const [actorKey, own, other, mfa] of [['repA', 'A', 'B', false], ['repB', 'B', 'A', false], ['boardA', 'A', 'B', true]]) {
    const response = await handlePgRequest(request('/api/households/hh-sib', { cookie: ctx.sessions[actorKey][mfa] }), ctx.env);
    const text = await response.text();
    assert.equal(response.status, 200, `${actorKey}: ${text}`);
    assert.ok(text.includes(marker(own)), `${actorKey}: brak dziecka własnej klasy`);
    assert.ok(!text.includes(marker(other)), `${actorKey}: widzi rodzeństwo z innej klasy`);
  }
  const wide = await handlePgRequest(request('/api/households/hh-sib', { cookie: ctx.sessions.treasurer[true] }), ctx.env);
  const text = await wide.text();
  assert.ok(text.includes(marker('A')) && text.includes(marker('B')), 'skarbnik widzi całą rodzinę roku');
});

test('denyStatus: funkcja odmowy zwraca wyłącznie 400/403/404', () => {
  for (const route of ROUTE_MATRIX.filter((entry) => typeof entry.deny === 'function')) {
    for (const actor of ACTORS) {
      for (const targetKey of route.targets) {
        for (const mfa of [false, true]) assert.ok([400, 403, 404].includes(denyStatus(route, actor, targetKey, mfa)), route.id);
      }
    }
  }
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
  // `variant` (opcjonalny): druga pozycja tej samej trasy z innym obiektem fixture (np. #200 —
  // opiekun z dziećmi z dwóch klas), z własną tabelą oczekiwanych statusów.
  const signatures = ROUTE_MATRIX.map((route) => `${route.method} ${route.path}${route.variant ? ` [${route.variant}]` : ''}`);
  assert.equal(new Set(signatures).size, signatures.length, 'para metoda + ścieżka (+ variant) musi być unikalna');
  for (const route of ROUTE_MATRIX) {
    assert.ok(route.targets.length > 0 && route.targets.every((key) => key in TARGETS), route.id);
    // 202: przyjęty wniosek do zatwierdzenia przez drugą osobę (#146).
    assert.ok([200, 201, 202, 204].includes(route.ok), `${route.id}: ok`);
    if (typeof route.allow === 'object') {
      const denies = typeof route.deny === 'function'
        ? ACTORS.flatMap((actor) => route.targets.flatMap((key) => [false, true].map((mfa) => route.deny(actor, key, mfa))))
        : [route.deny];
      assertEvery(denies, (status) => [400, 403, 404].includes(status), `${route.id}: deny`);
      if (route.mfaDeny !== undefined) assert.ok([403, 404].includes(route.mfaDeny), `${route.id}: mfaDeny`);
      for (const [actorKey, scopes] of Object.entries(route.allow)) {
        assert.ok(ACTOR_KEYS.includes(actorKey), `${route.id}: nieznany aktor ${actorKey}`);
        // Pusta lista zakresów jest poprawna (aktor bez dostępu do żadnego celu).
        assert.ok(Array.isArray(scopes), `${route.id}: zakresy ${actorKey} nie są listą`);
        for (const scope of scopes) assert.ok(route.targets.includes(scope), `${route.id}: zakres spoza targets (${scope})`);
      }
      // Każda trasa chroniona musi mieć co najmniej jeden przypadek odmowy dla innego roku.
      if (route.targets.includes('Y2')) {
        assertEvery(Object.values(route.allow), (scopes) => !scopes.includes('Y2'), `${route.id}: Y2`);
      }
    } else {
      assert.ok(['authenticated', 'public'].includes(route.allow), route.id);
    }
  }
});

const MODULE_SOURCES = {
  session: ['../src/pg/routes/session.js'],
  payments: ['../src/pg/routes/payments.js'],
  'payment-references': ['../src/pg/routes/payment-references.js'],
  'payment-instructions': ['../src/pg/routes/payment-instructions.js'],
  events: ['../src/pg/routes/events.js', '../src/pg/events.js'],
  meetings: ['../src/pg/routes/meetings.js', '../src/pg/meetings.js'],
  import: ['../src/pg/routes/import.js'],
  documents: ['../src/pg/routes/documents.js', '../src/documents.js'],
  ledger: ['../src/pg/routes/ledger.js'],
  'ledger-cash': ['../src/pg/routes/ledger-cash.js'],
  'ledger-budget': ['../src/pg/routes/ledger-budget.js'],
  'ledger-cost-centers': ['../src/pg/routes/ledger-cost-centers.js'],
  email: ['../src/pg/routes/email.js'],
  news: ['../src/pg/routes/news.js', '../src/pg/news.js'],
  admin: ['../src/pg/routes/admin.js'],
  reconciliation: ['../src/pg/routes/reconciliation.js'],
  'financial-reports': ['../src/pg/routes/financial-reports.js'],
  'audit-reviews': ['../src/pg/routes/audit-reviews.js'],
  'audit-history': ['../src/pg/routes/audit-history.js'],
  exports: ['../src/pg/routes/exports.js'],
  families: ['../src/pg/routes/families.js'],
  print: ['../src/pg/routes/print.js'],
  'year-close': ['../src/pg/routes/year-close.js'],
  mfa: ['../src/pg/routes/mfa.js'],
  login: ['../src/pg/routes/login.js'],
  representative: ['../src/pg/routes/representative.js'],
  'guardian-updates': ['../src/pg/routes/guardian-updates.js'],
  'privacy-notice': ['../src/pg/routes/privacy-notice.js'],
  board: ['../src/pg/routes/board.js'],
};

// Segmenty ścieżek widoczne w kodzie modułu: literały '/api/…', segmenty z wyrażeń
// regularnych /^\/api…$/ (\/słowo, (a|b)) i porównania w funkcji route() modułu zebrań.
// Dla modułu administracji — także sekcje z KNOWN_SECTIONS.
function pathSegmentsInSource(source) {
  const segments = new Set();
  for (const [, literal] of source.matchAll(/'(\/api\/[a-z/-]+)'/g)) {
    for (const part of literal.split('/').filter(Boolean)) segments.add(part);
  }
  for (const [, regex] of source.matchAll(/\/(\^\\\/api[^\n]*?)\$\//g)) {
    for (const [, word] of regex.matchAll(/\\\/([a-z][a-z-]*)/g)) segments.add(word);
    for (const [, group] of regex.matchAll(/\(([a-z|]+)\)/g)) group.split('|').forEach((word) => segments.add(word));
  }
  const sections = source.match(/KNOWN_SECTIONS = new Set\(\[([^\]]*)\]\)/);
  if (sections) for (const [, word] of sections[1].matchAll(/'([a-z][a-z-]*)'/g)) segments.add(word);
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

test('meta: każde zwolnienie z bramki MFA ma uzasadnienie i wpis w macierzy (#189)', () => {
  const exempt = [...MFA_GATE_EXEMPT_EXACT, ...MFA_GATE_EXEMPT_PREFIXES];
  assert.deepEqual([...exempt].sort(), Object.keys(MFA_GATE_EXEMPT_REASONS).sort(),
    'Nowe zwolnienie w src/pg/mfa-policy.js wymaga uzasadnienia w MFA_GATE_EXEMPT_REASONS (tests/helpers/route-matrix.js)');
  for (const path of exempt) {
    assert.ok(ROUTE_MATRIX.some((route) => (path.endsWith('/') ? route.path.startsWith(path) : route.path.split('?')[0] === path)),
      `zwolnienie ${path} bez wpisu w macierzy`);
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
  // #161: tabela twierdzi, że przedstawiciel czyta wpłaty z MFA — bez MFA trasa odpowiada ogólnym
  // `forbidden` (rola nie pasuje), więc detektor zgłasza brak kodu prowadzącego do zapisu MFA.
  const deadEnd = await runCase(ctx, { ...byId['payments.list'], allow: { repA: ['W1'] } }, repA, false, 'W1');
  assert.ok(deadEnd.some((problem) => problem.includes('kod forbidden zamiast mfa_enrollment_required')), deadEnd.join('\n'));
  // Poprawny przypadek: lista własnej klasy bez czynnika daje mfa_enrollment_required (brak problemów).
  assert.deepEqual(await runCase(ctx, byId['exports.classRoster'], repA, false, 'A'), []);
});

// ---------- regresje dawnych rozbieżności ----------

// SR-07 (naprawione): PATCH/submit/cancel cudzego wydarzenia odpowiadają jak brak wydarzenia.
test('events: zmiana cudzego szkicu odpowiada jak brak wydarzenia (bez wyroczni istnienia)', async () => {
  const ctx = await matrixContext();
  const repA = ctx.sessions.repA[false];
  const foreign = (await staticObject(ctx, 'event', 'draft', 'B')).eventId;
  const attempts = [
    ['PATCH', '', { revision: 1, title: 'Próba zmiany' }],
    ['POST', '/submit', { revision: 1 }],
    ['POST', '/cancel', { revision: 1, reason: 'Próba odwołania' }],
  ];
  for (const [method, suffix, body] of attempts) {
    const missing = await handlePgRequest(request(`/api/events/nieistniejace-wydarzenie${suffix}`, {
      method, cookie: repA, body,
    }), ctx.env);
    const other = await handlePgRequest(request(`/api/events/${foreign}${suffix}`, {
      method, cookie: repA, body,
    }), ctx.env);
    assert.equal(missing.status, 404, `${method} ${suffix}`);
    assert.equal(other.status, missing.status, `${method} ${suffix}: odmowa dla cudzej klasy powinna być nieodróżnialna od braku obiektu`);
  }
});

test('meta: wyjątki od pokrycia audytem wskazują istniejące trasy zapisu i mają uzasadnienie (#184)', () => {
  const writes = new Map(ROUTE_MATRIX.filter((route) => route.method !== 'GET').map((route) => [route.id, route]));
  for (const [name, list] of [['AUDIT_EXEMPT_ROUTES', AUDIT_EXEMPT_ROUTES], ['AUDIT_ACTORLESS_ROUTES', AUDIT_ACTORLESS_ROUTES]]) {
    for (const [id, reason] of list) {
      assert.ok(writes.has(id), `${name}: ${id} nie jest trasą zapisu w macierzy`);
      assert.ok(reason.length >= 30, `${name}: ${id} bez uzasadnienia`);
    }
  }
  for (const id of AUDIT_EXEMPT_ROUTES.keys()) assert.ok(!AUDIT_ACTORLESS_ROUTES.has(id), `${id} na obu listach`);
});

test('meta: wyjątki pokrycia wierszy audytem wskazują tabele z kolumną id i mają uzasadnienie (#184 pkt 6)', async () => {
  const ctx = await matrixContext();
  const tables = new Set(await rowCoverageTables(ctx.db));
  const writes = new Set(ROUTE_MATRIX.filter((route) => route.method !== 'GET').map((route) => route.id));
  for (const [table, entry] of AUDIT_ROW_PARENTS) {
    assert.ok(tables.has(table), `AUDIT_ROW_PARENTS: ${table} nie jest tabelą z kolumną id`);
    assert.equal(typeof entry.keys, 'function', `AUDIT_ROW_PARENTS: ${table} bez funkcji kluczy`);
    assert.ok(entry.why.length >= 30, `AUDIT_ROW_PARENTS: ${table} bez uzasadnienia`);
    for (const key of entry.metadataKeys ?? []) assert.match(key, /^[a-z][A-Za-z]*Id$/, `AUDIT_ROW_PARENTS: ${table}: klucz metadanych ${key}`);
    assert.ok(!AUDIT_ROW_TECHNICAL.has(table), `${table} na dwóch listach`);
  }
  for (const [table, why] of AUDIT_ROW_TECHNICAL) {
    assert.ok(tables.has(table), `AUDIT_ROW_TECHNICAL: ${table} nie jest tabelą z kolumną id`);
    assert.ok(why.length >= 30, `AUDIT_ROW_TECHNICAL: ${table} bez uzasadnienia`);
  }
  for (const [routeId, entry] of AUDIT_ROW_ROUTE_EXEMPT) {
    assert.ok(writes.has(routeId), `AUDIT_ROW_ROUTE_EXEMPT: ${routeId} nie jest trasą zapisu w macierzy`);
    assert.ok(entry.why.length >= 30, `AUDIT_ROW_ROUTE_EXEMPT: ${routeId} bez uzasadnienia`);
    for (const table of entry.tables) assert.ok(tables.has(table), `AUDIT_ROW_ROUTE_EXEMPT: ${routeId}: ${table} nie jest tabelą z kolumną id`);
  }
  // Tabele finansowe, ról i wysyłek (AGENTS.md) nie mogą być zwolnione jako techniczne.
  for (const table of AUDIT_ROW_TECHNICAL.keys()) {
    assert.doesNotMatch(table, /^(payment|ledger|bank_|role_grants|invitations|users|email_campaigns|email_outbox$)/, `${table}: tabela biznesowa na liście technicznej`);
  }
});
