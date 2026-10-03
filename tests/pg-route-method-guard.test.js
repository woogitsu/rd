// Strażnik metod HTTP (po #748/#750): trasa zapisu nie może wykonać się inną
// metodą niż własna. W #748 decyzja o wniosku opiekuna dopasowywała ścieżkę
// `…/approve` bez sprawdzenia metody, więc `GET` z sesją zarządu rozstrzygał
// wniosek z pominięciem kontroli Origin i trybu tylko do odczytu.
//
// Test bierze KAŻDĄ trasę zapisu z macierzy tras (tests/helpers/route-matrix.js,
// to samo źródło co docs/openapi.json), buduje jej ścieżkę z prawdziwym obiektem
// w odpowiednim stanie (fixture macierzy, np. wniosek `pending` do `approve`) albo
// z syntetycznym identyfikatorem, i wywołuje ją metodami GET, HEAD i OPTIONS sesją
// z rolami admin + zarząd + skarbnik + Komisja Rewizyjna i potwierdzonym MFA.
// Oczekiwane: żadnego 2xx, żadnego 5xx, zero nowych wierszy w audit_events i bez
// zmiany liczby wierszy tabel zapisu (odcisk z macierzy). Do tego reguły routera:
// OPTIONS (i każda metoda poza GET/HEAD) wymaga Origin i jest blokowana w trybie
// tylko do odczytu, HEAD jest bezpieczny i nigdy nie dostaje 2xx.
//
// Dane wyłącznie syntetyczne (@example.invalid), PGlite, bez sieci. Jedna baza
// (matrixContext) i jedna sesja na cały plik.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPgHandler, handlePgRequest } from '../src/pg/app.js';
import { isSafeMethod } from '../src/pg/http.js';
import { isWriteExempt } from '../src/write-mode.js';
import { TEST_ORIGIN, request, seedUserSession } from './helpers/pg.js';
import { ROUTE_MATRIX, TARGETS, YEAR_1 } from './helpers/route-matrix.js';
import { makeObject, matrixContext, nextKey, staticObject, writeFingerprint } from './helpers/authz-matrix.js';
import { assertCaptured, assertEvery } from './helpers/assertions.js';

const SUPER_ROLES = ['admin', 'board', 'treasurer', 'audit'];
const FOREIGN_ORIGIN = 'https://obca-domena.example.invalid';

// Szablon ścieżki bez query; każdy parametr `:nazwa` (macierz) i `{nazwa}` (OpenAPI) to `:p`.
const normalize = (path) => path.split('?')[0].replace(/:[A-Za-z][A-Za-z0-9]*/g, ':p').replace(/\{[^}]+\}/g, ':p');

// Ścieżki, pod którymi macierz ma trasę GET: tam GET jest legalnym odczytem (np. lista
// kampanii obok POST tworzenia), więc strażnik sprawdza na nich tylko HEAD i OPTIONS.
const GET_PATHS = new Set(ROUTE_MATRIX.filter((route) => route.method === 'GET').map((route) => normalize(route.path)));
const MUTATING = ROUTE_MATRIX.filter((route) => !isSafeMethod(route.method));
const READS = ROUTE_MATRIX.filter((route) => route.method === 'GET');

// Zastępcza ścieżka, gdy budowa z obiektem macierzy nie jest możliwa (trasy z nowym
// użytkownikiem na przypadek, grupa zamknięcia roku): rok 1 i syntetyczny identyfikator.
function syntheticPath(route) {
  return route.path.replace(/:year\b/g, YEAR_1).replace(/:[A-Za-z][A-Za-z0-9]*/g, 'mg-brak-1');
}

let shared;
async function setup() {
  shared ??= (async () => {
    const ctx = await matrixContext('main');
    const cookie = await seedUserSession(ctx.db, {
      userId: 'u-method-guard', email: 'method-guard@example.invalid', mfa: true,
      roles: SUPER_ROLES.map((role) => ({ role, schoolYearId: YEAR_1 })),
    });
    return { ctx, cookie };
  })();
  return shared;
}

// Ścieżka trasy z prawdziwym obiektem w stanie wymaganym przez trasę (jak przypadek
// dozwolony macierzy). Obiekt powstaje PRZED odciskiem zapisów.
async function concretePath(ctx, cookie, route) {
  const targetKey = route.targets.includes('W1') ? 'W1' : route.targets[0];
  const target = TARGETS[targetKey];
  if (route.object && !route.freshUser && (route.group ?? 'main') === 'main') {
    const obj = route.fixture === 'static'
      ? await staticObject(ctx, route.object.kind, route.object.stage, targetKey)
      : await makeObject(ctx, route.object, target, { cookie, route: route.id, success: true });
    const built = await route.build({ target, obj, key: nextKey(`mg-${route.id}`), fx: ctx.fx });
    return { path: built.path, withObject: true };
  }
  try {
    const built = await route.build({ target, obj: null, key: nextKey(`mg-${route.id}`), fx: ctx.fx });
    return { path: built.path, withObject: false };
  } catch {
    return { path: syntheticPath(route), withObject: false };
  }
}

const auditCount = async (db) => (await db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n;
const isSuccess = (status) => status >= 200 && status < 300;

// Wywołania jednej ścieżki: [metoda, origin] — null = bez nagłówka Origin.
function probesFor(route) {
  const probes = [];
  if (!GET_PATHS.has(normalize(route.path))) probes.push(['GET', null], ['GET', 'same']);
  probes.push(['HEAD', null], ['HEAD', 'same'], ['OPTIONS', 'same'], ['OPTIONS', null]);
  return probes;
}

async function probeRoute(ctx, cookie, route) {
  const { path, withObject } = await concretePath(ctx, cookie, route);
  const problems = [];
  const statuses = [];
  const auditBefore = await auditCount(ctx.db);
  const before = await writeFingerprint(ctx.db);
  for (const [method, origin] of probesFor(route)) {
    const response = await handlePgRequest(request(path, { method, cookie, origin: origin === 'same' ? TEST_ORIGIN : null }), ctx.env);
    const text = await response.text();
    let error = null;
    try { error = JSON.parse(text).error; } catch { /* treść nie-JSON */ }
    statuses.push({ method, origin, status: response.status, error });
    const label = `${route.id}: ${method} ${path} (Origin: ${origin ?? 'brak'})`;
    if (isSuccess(response.status)) problems.push(`${label} -> ${response.status} (trasa zapisu wykonana inną metodą): ${text.slice(0, 160)}`);
    else if (response.status < 400 || response.status >= 500) problems.push(`${label} -> ${response.status} zamiast odmowy 4xx: ${text.slice(0, 160)}`);
    if (method === 'OPTIONS' && origin === null && !(response.status === 403 && error === 'invalid_origin')) {
      problems.push(`${label} -> ${response.status} ${error}: OPTIONS bez Origin musi dostać 403 invalid_origin od routera`);
    }
    if (method === 'HEAD' && error === 'invalid_origin') problems.push(`${label}: HEAD jest metodą bezpieczną, nie wymaga Origin`);
  }
  const auditAfter = await auditCount(ctx.db);
  if (auditAfter !== auditBefore) problems.push(`${route.id} (${path}): ${auditAfter - auditBefore} nowych wierszy audit_events`);
  const after = await writeFingerprint(ctx.db);
  const changed = Object.keys(before).filter((table) => before[table] !== after[table]);
  if (changed.length) problems.push(`${route.id} (${path}): zmieniona liczba wierszy: ${changed.join(', ')}`);
  return { problems, statuses, withObject };
}

test('trasy zapisu z macierzy: GET, HEAD i OPTIONS nie wykonują zapisu (bez 2xx, 5xx i nowych zdarzeń audytu)', async () => {
  const { ctx, cookie } = await setup();
  const problems = [];
  const statuses = [];
  let withObject = 0;
  for (const route of MUTATING) {
    const result = await probeRoute(ctx, cookie, route);
    problems.push(...result.problems);
    statuses.push(...result.statuses);
    if (result.withObject) withObject += 1;
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  // Meta: test nie przechodzi „na pusto” — wiele tras i modułów, większość z prawdziwym obiektem.
  assert.ok(MUTATING.length >= 150, `tylko ${MUTATING.length} tras zapisu w macierzy`);
  assert.ok(new Set(MUTATING.map((route) => route.module)).size >= 20, 'trasy zapisu z mniej niż 20 modułów');
  assert.ok(withObject >= 60, `tylko ${withObject} tras z prawdziwym obiektem`);
  assertCaptured(statuses.filter((item) => item.method === 'GET'), { min: 100, message: 'za mało wywołań GET na trasach zapisu' });
  // Ścieżki zapisu nie ujawniają się metodą GET jako 2xx; typowa odpowiedź to 404/405 modułu.
  assertEvery(statuses, (item) => item.status >= 400 && item.status < 500, 'każda odpowiedź to odmowa 4xx');
});

test('trasy odczytu z macierzy: HEAD nie dostaje 2xx ani nie zapisuje śladu odczytu; OPTIONS wymaga Origin', async () => {
  const { ctx, cookie } = await setup();
  const problems = [];
  const seen = new Set();
  let probed = 0;
  for (const route of READS) {
    const key = normalize(route.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const { path } = await concretePath(ctx, cookie, route);
    const auditBefore = await auditCount(ctx.db);
    for (const [method, origin] of [['HEAD', null], ['OPTIONS', null], ['OPTIONS', 'same']]) {
      const response = await handlePgRequest(request(path, { method, cookie, origin: origin === 'same' ? TEST_ORIGIN : null }), ctx.env);
      const text = await response.text();
      probed += 1;
      const label = `${route.id}: ${method} ${path} (Origin: ${origin ?? 'brak'})`;
      if (response.status < 400 || response.status >= 500) problems.push(`${label} -> ${response.status}: ${text.slice(0, 160)}`);
      if (method === 'HEAD' && text.includes('invalid_origin')) problems.push(`${label}: HEAD dostał invalid_origin`);
      if (method === 'OPTIONS' && origin === null && !(response.status === 403 && text.includes('invalid_origin'))) {
        problems.push(`${label} -> ${response.status}: OPTIONS bez Origin musi dostać 403 invalid_origin`);
      }
    }
    const auditAfter = await auditCount(ctx.db);
    if (auditAfter !== auditBefore) problems.push(`${route.id} (${path}): ${auditAfter - auditBefore} nowych wierszy audit_events po HEAD/OPTIONS`);
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  assert.ok(probed >= 150, `tylko ${probed} wywołań na trasach odczytu`);
});

test('tryb tylko do odczytu: OPTIONS na każdej ścieżce zapisu dostaje 503 read_only, HEAD nie', async () => {
  const { ctx, cookie } = await setup();
  const env = { ...ctx.env, APP_WRITE_MODE: 'read_only' };
  const pathnames = [...new Set(MUTATING.map((route) => syntheticPath(route).split('?')[0]))];
  assert.ok(pathnames.length >= 100, `tylko ${pathnames.length} ścieżek zapisu`);
  const problems = [];
  for (const pathname of pathnames) {
    const options = await handlePgRequest(request(pathname, { method: 'OPTIONS', cookie }), env);
    const expected = isWriteExempt(pathname) ? null : 503;
    if (expected && options.status !== expected) problems.push(`OPTIONS ${pathname} -> ${options.status} zamiast 503`);
    const head = await handlePgRequest(request(pathname, { method: 'HEAD', cookie }), env);
    if (head.status === 503 || isSuccess(head.status)) problems.push(`HEAD ${pathname} -> ${head.status} w trybie tylko do odczytu`);
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('router: OPTIONS i metoda nieznana przechodzą bramkę Origin i read_only, HEAD trafia do modułu bez nich', async () => {
  const reached = [];
  // Moduł-atrapa celowo „method-agnostic”: odpowiada 200 na każdą metodę.
  const probe = { name: 'probe', handle: async (req, _env, url, json) => { reached.push(req.method); return url.pathname.startsWith('/api/public/probe') ? json({ ok: true }) : null; } };
  const handler = createPgHandler([probe]);
  const send = (method, { origin = null, env = {} } = {}) => handler(new Request(`${TEST_ORIGIN}/api/public/probe`, {
    method, headers: origin ? { Origin: origin } : {},
  }), env);
  for (const method of ['OPTIONS', 'PROPFIND', 'POST']) {
    const missing = await send(method);
    assert.equal(missing.status, 403, `${method} bez Origin`);
    assert.deepEqual(await missing.json(), { error: 'invalid_origin' });
    const foreign = await send(method, { origin: FOREIGN_ORIGIN });
    assert.equal(foreign.status, 403, `${method} z obcym Origin`);
    const readOnly = await send(method, { origin: TEST_ORIGIN, env: { APP_WRITE_MODE: 'read_only' } });
    assert.equal(readOnly.status, 503, `${method} w read_only`);
    assert.deepEqual(await readOnly.json(), { error: 'read_only' });
  }
  assert.deepEqual(reached, [], 'metoda zmieniająca bez Origin albo w read_only nie może dotrzeć do modułu');
  // HEAD i GET: metody bezpieczne — bez Origin i w read_only docierają do modułu (atrapa odpowiada 200,
  // prawdziwe moduły na HEAD odpowiadają 404/405 — testy wyżej).
  for (const method of ['HEAD', 'GET']) {
    const response = await send(method, { env: { APP_WRITE_MODE: 'read_only' } });
    assert.equal(response.status, 200, method);
  }
  assert.deepEqual(reached, ['HEAD', 'GET']);
  assert.deepEqual(['GET', 'HEAD', 'OPTIONS', 'POST', 'PROPFIND'].map(isSafeMethod), [true, true, false, false, false]);
});

test('meta: każda operacja zapisu z docs/openapi.json jest w macierzy, z której korzysta strażnik', async () => {
  const spec = JSON.parse(await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
  const covered = new Set(MUTATING.map((route) => `${route.method} ${normalize(route.path)}`));
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ['post', 'put', 'patch', 'delete']) {
      if (item[method]) operations.push(`${method.toUpperCase()} ${normalize(path)}`);
    }
  }
  assertCaptured(operations, { min: 150, message: 'za mało operacji zapisu w docs/openapi.json' });
  assert.deepEqual(operations.filter((operation) => !covered.has(operation)), []);
});
