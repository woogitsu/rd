// Test wydajności API PostgreSQL (#16, #41): 1000 uczniów / 2000 kontaktów /
// 50 użytkowników, 50 równoczesnych wirtualnych użytkowników.
//
// Tryb lokalny (domyślny): serwer Node w tym procesie + PGlite w pamięci
// (wszystkie postgres/migrations), dane syntetyczne ze scripts/lib/synthetic-seed.js,
// sesje dla 50 użytkowników. Nic nie wychodzi poza 127.0.0.1.
//
//   npm run load:test
//   npm run load:test -- --users 50 --duration 30 --p95-ms 800
//
// Tryb zdalny (wyłącznie staging na danych syntetycznych):
//
//   LOAD_TEST_ALLOWED_HOSTS=rd-staging.up.railway.app APP_ENV=staging \
//   LOAD_TEST_SCHOOL_YEAR_ID=… LOAD_TEST_SESSION_BOARD=… LOAD_TEST_SESSION_TREASURER=… \
//   LOAD_TEST_SESSION_REPRESENTATIVE=… \
//   npm run load:test -- --target https://rd-staging.up.railway.app --i-confirm-staging
//
// Zdalnie skrypt odmawia, gdy brak --i-confirm-staging, adres nie jest https,
// host nie jest dokładnie na liście LOAD_TEST_ALLOWED_HOSTS, APP_ENV=production
// albo któraś sesja nie należy do konta syntetycznego. Domyślnie zdalnie tylko
// odczyty; zapisy (wpłaty „unmatched”, szkice wydarzeń) wymagają --allow-writes.
//
// Wynik: JSON na stdout (p50/p95/p99, odsetek błędów, przepustowość, podział
// na operacje). Kod wyjścia 1 przy przekroczeniu progu, 2 przy błędzie użycia.
// Czasy z PGlite (WASM, jeden proces, jedno połączenie) NIE są reprezentatywne
// dla PostgreSQL na Railway.

import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { isProductionEnv } from '../src/app-env.js';
import { startServer } from '../src/server.js';
import { handlePgRequest } from '../src/pg/app.js';
import { approve, createDraft, publish, submit } from '../src/pg/events.js';
import { createMeeting } from '../src/pg/meetings.js';
import { pgliteClient } from './smoke-postgres.js';
import {
  buildSyntheticData, insertSyntheticData, primaryRoles, seedSyntheticSessions, YEAR,
} from './lib/synthetic-seed.js';
import {
  buildHistoricalData, checkHeavyBudgets, HEAVY_DEFAULTS, insertHistoricalData, runHeavyScenario, seedHeavySessions,
} from './lib/heavy-scenario.js';

const migrationsDir = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));

export const DEFAULT_THRESHOLDS = Object.freeze({
  p95Ms: 1000,
  p99Ms: 2000,
  maxErrorRate: 0.01,
  minRps: 0,
});

export const REMOTE_SESSION_ENV = Object.freeze({
  admin: 'LOAD_TEST_SESSION_ADMIN',
  board: 'LOAD_TEST_SESSION_BOARD',
  treasurer: 'LOAD_TEST_SESSION_TREASURER',
  representative: 'LOAD_TEST_SESSION_REPRESENTATIVE',
});

const FINANCIAL = ['admin', 'board', 'treasurer'];
const EVENT_READERS = ['admin', 'board', 'representative'];
const MEETING_READERS = ['admin', 'board'];
const SYNTHETIC_EMAIL = /@([a-z0-9-]+\.)*(example\.invalid|invalid|test|example)$/i;

export class UsageError extends Error {}

// ---------- argumenty ----------

function number(value, name, { min = 0, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    throw new UsageError(`${name} must be a${integer ? 'n integer' : ' number'} >= ${min}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    users: 50, durationSec: 30, thinkMs: 0, timeoutMs: 10_000, target: null,
    confirmStaging: false, allowWrites: null, out: null, thresholds: { ...DEFAULT_THRESHOLDS },
    scenario: 'light', heavyIterations: 3, heavy: { ...HEAVY_DEFAULTS },
  };
  const valueFlags = new Map([
    ['--users', (v) => { options.users = number(v, '--users', { min: 1, integer: true }); }],
    ['--duration', (v) => { options.durationSec = number(v, '--duration', { min: 0.1 }); }],
    ['--think-ms', (v) => { options.thinkMs = number(v, '--think-ms'); }],
    ['--timeout-ms', (v) => { options.timeoutMs = number(v, '--timeout-ms', { min: 1 }); }],
    ['--target', (v) => { options.target = v; }],
    ['--out', (v) => { options.out = v; }],
    ['--p95-ms', (v) => { options.thresholds.p95Ms = number(v, '--p95-ms'); }],
    ['--p99-ms', (v) => { options.thresholds.p99Ms = number(v, '--p99-ms'); }],
    ['--max-error-rate', (v) => { options.thresholds.maxErrorRate = number(v, '--max-error-rate'); }],
    ['--min-rps', (v) => { options.thresholds.minRps = number(v, '--min-rps'); }],
    ['--scenario', (v) => {
      if (v !== 'light' && v !== 'heavy') throw new UsageError('--scenario must be "light" or "heavy"');
      options.scenario = v;
    }],
    ['--heavy-iterations', (v) => { options.heavyIterations = number(v, '--heavy-iterations', { min: 1, integer: true }); }],
    ['--heavy-years', (v) => { options.heavy.years = number(v, '--heavy-years', { min: 1, integer: true }); }],
    ['--heavy-classes', (v) => { options.heavy.classesPerYear = number(v, '--heavy-classes', { min: 1, integer: true }); }],
    ['--heavy-students', (v) => { options.heavy.studentsPerYear = number(v, '--heavy-students', { min: 1, integer: true }); }],
    ['--heavy-audit-events', (v) => { options.heavy.auditEvents = number(v, '--heavy-audit-events', { min: 0, integer: true }); }],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    if (flag === '--i-confirm-staging') options.confirmStaging = true;
    else if (flag === '--allow-writes') options.allowWrites = true;
    else if (flag === '--read-only') options.allowWrites = false;
    else if (valueFlags.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`${flag} requires a value`);
      valueFlags.get(flag)(value);
    } else throw new UsageError(`unknown argument: ${argv[i]}`);
  }
  return options;
}

// ---------- tryb zdalny: bezpieczniki ----------

export function validateRemoteTarget(target, { confirmStaging = false, env = process.env } = {}) {
  if (!confirmStaging) throw new UsageError('remote target requires --i-confirm-staging (synthetic staging only)');
  if (isProductionEnv(env.APP_ENV)) throw new UsageError('refusing to run with APP_ENV=production');
  let url;
  try {
    url = new URL(target);
  } catch {
    throw new UsageError('--target must be an absolute URL');
  }
  if (url.protocol !== 'https:') throw new UsageError('--target must use https');
  if (url.username || url.password) throw new UsageError('--target must not contain credentials');
  const allowed = String(env.LOAD_TEST_ALLOWED_HOSTS ?? '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) throw new UsageError('LOAD_TEST_ALLOWED_HOSTS is empty; refusing remote target');
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new UsageError(`host ${url.hostname} is not listed in LOAD_TEST_ALLOWED_HOSTS`);
  }
  return url.origin;
}

function asCookie(value) {
  const trimmed = String(value).trim();
  return trimmed.startsWith('rd_session=') ? trimmed : `rd_session=${trimmed}`;
}

export function remoteActorsFromEnv(env = process.env) {
  const schoolYearId = env.LOAD_TEST_SCHOOL_YEAR_ID?.trim();
  if (!schoolYearId) throw new UsageError('LOAD_TEST_SCHOOL_YEAR_ID is required for a remote target');
  const actors = [];
  for (const [role, name] of Object.entries(REMOTE_SESSION_ENV)) {
    if (env[name]?.trim()) actors.push({ userId: `remote-${role}`, role, cookie: asCookie(env[name]) });
  }
  if (!actors.length) {
    throw new UsageError(`set at least one of ${Object.values(REMOTE_SESSION_ENV).join(', ')} (synthetic staging accounts)`);
  }
  return { schoolYearId, actors };
}

// Każda sesja musi być ważna i należeć do konta syntetycznego.
async function verifyRemoteActors(baseUrl, actors, timeoutMs) {
  for (const actor of actors) {
    const response = await fetch(`${baseUrl}/api/session`, {
      headers: { Cookie: actor.cookie }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) throw new UsageError(`session for ${actor.role} is not valid (HTTP ${response.status})`);
    const body = await response.json();
    if (!SYNTHETIC_EMAIL.test(String(body?.user?.email ?? ''))) {
      throw new UsageError(`session for ${actor.role} is not a synthetic account (e-mail domain must be .invalid/.test/.example)`);
    }
  }
}

// ---------- tryb lokalny ----------

async function seedEventsAndMeetings(db) {
  const author = { userId: 'u0003', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
  const reviewer = { userId: 'u0004', grants: [{ role: 'board', classId: null, schoolYearId: null }], mfaVerified: true };
  for (let i = 1; i <= 20; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const { event } = await createDraft(db, author, {
      schoolYearId: YEAR, title: `Wydarzenie syntetyczne ${i}`, startsAt: `2026-11-${day}T18:00`,
      endsAt: `2026-11-${day}T19:30`, location: 'Sala testowa', organizer: 'Rada Rodziców',
      audience: 'public', idempotencyKey: `load-seed-event-${String(i).padStart(3, '0')}`,
    });
    if (i > 15) continue; // 5 szkiców pozostaje wewnętrznych
    await submit(db, author, { eventId: event.id, revision: 1 });
    await approve(db, reviewer, { eventId: event.id, revision: 1 });
    await publish(db, reviewer, { eventId: event.id, revision: 1 });
  }
  for (let i = 1; i <= 10; i += 1) {
    await createMeeting(db, author, {
      idempotencyKey: `load-seed-meeting-${String(i).padStart(3, '0')}`, schoolYearId: YEAR,
      kind: i % 2 ? 'plenary' : 'board', title: `Zebranie syntetyczne ${i}`,
      scheduledAt: `2026-10-${String(i + 5).padStart(2, '0')}T17:00:00Z`, location: 'Sala 1', status: 'scheduled',
    });
  }
}

// Kolejność aktorów przeplata role, by nawet 5 wirtualnych użytkowników objęło każdą rolę.
function interleaveByRole(actors) {
  const groups = new Map();
  for (const actor of actors) {
    if (!groups.has(actor.role)) groups.set(actor.role, []);
    groups.get(actor.role).push(actor);
  }
  const order = ['treasurer', 'board', 'representative', 'admin'].filter((role) => groups.has(role));
  for (const role of groups.keys()) if (!order.includes(role)) order.push(role);
  const result = [];
  while (result.length < actors.length) {
    for (const role of order) {
      const next = groups.get(role).shift();
      if (next) result.push(next);
    }
  }
  return result;
}

export async function startLocalTarget({ log = () => {} } = {}) {
  const started = performance.now();
  const db = new PGlite();
  try {
    await applyMigrations(pgliteClient(db), await loadMigrations(migrationsDir));
    const data = await insertSyntheticData(db, buildSyntheticData());
    const roles = primaryRoles(data);
    const cookies = await seedSyntheticSessions(db, data.users.map(([id]) => id));
    await seedEventsAndMeetings(db);
    const actors = interleaveByRole(data.users.map(([userId]) => ({ userId, role: roles.get(userId), cookie: cookies.get(userId) })));
    const server = await startServer({
      host: '127.0.0.1', port: 0, distRoot, env: { db, APP_ENV: 'load-test' }, fetchHandler: handlePgRequest,
    });
    const setupMs = Math.round(performance.now() - started);
    log(`local target ready in ${setupMs} ms (PGlite, ${data.students.length} students, ${data.guardians.length} guardians, ${data.users.length} users)`);
    return {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      schoolYearId: YEAR,
      actors,
      householdIds: data.households.map(([id]) => id),
      dataset: { students: data.students.length, guardians: data.guardians.length, users: data.users.length },
      setupMs,
      close: async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        await db.close();
      },
    };
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}

// ---------- scenariusz "heavy" (#217) ----------

export async function startHeavyTarget({ heavy = HEAVY_DEFAULTS, log = () => {} } = {}) {
  const started = performance.now();
  const db = new PGlite();
  try {
    await applyMigrations(pgliteClient(db), await loadMigrations(migrationsDir));
    const data = buildHistoricalData(heavy);
    const reconciliationId = await insertHistoricalData(db, data);
    const cookies = await seedHeavySessions(db, data.users.map(([id]) => id));
    const roles = new Map(data.grants.map(([, userId, role]) => [userId, role]));
    const actors = data.users.map(([userId]) => ({ userId, role: roles.get(userId), cookie: cookies.get(userId) }));
    const server = await startServer({
      host: '127.0.0.1', port: 0, distRoot, env: { db, APP_ENV: 'load-test' }, fetchHandler: handlePgRequest,
    });
    const setupMs = Math.round(performance.now() - started);
    log(`heavy target ready in ${setupMs} ms (PGlite, ${data.yearIds.length} lat, `
      + `${data.students.length} uczniów, ${data.auditEventCount} zdarzeń audytu)`);
    return {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      latestYear: data.latestYear, classId: data.latestClassId, householdId: data.latestHouseholdId,
      otherHouseholdId: data.latestOtherHouseholdId, reconciliationId, actors,
      dataset: {
        years: data.yearIds.length, students: data.students.length, guardians: data.guardians.length,
        auditEvents: data.auditEventCount,
      },
      setupMs,
      close: async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        await db.close();
      },
    };
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}

async function runHeavy(options, { log = () => {} } = {}) {
  const startedAt = new Date().toISOString();
  const target = await startHeavyTarget({ heavy: options.heavy, log });
  try {
    log(`running scenario heavy (${options.heavyIterations} iterations/route) against local PGlite`);
    const result = await runHeavyScenario({
      baseUrl: target.baseUrl, actors: target.actors, latestYear: target.latestYear, classId: target.classId,
      householdId: target.householdId, otherHouseholdId: target.otherHouseholdId, reconciliationId: target.reconciliationId,
      iterations: options.heavyIterations, timeoutMs: options.timeoutMs, log,
    });
    const breaches = checkHeavyBudgets(result.byOperation);
    return {
      mode: 'local', scenario: 'heavy',
      target: 'pglite-in-process (not representative)',
      startedAt, node: process.version,
      dataset: target.dataset, setupMs: target.setupMs,
      ...result,
      breaches, passed: breaches.length === 0,
    };
  } finally {
    await target.close();
  }
}

// ---------- obciążenie ----------

function operations({ schoolYearId, allowWrites, householdIds, runId }) {
  const year = encodeURIComponent(schoolYearId);
  let sequence = 0;
  const nextKey = (vu) => `load-${runId}-${vu}-${(sequence += 1)}`;
  const household = () => (householdIds?.length ? householdIds[Math.floor(Math.random() * householdIds.length)] : null);
  const paymentBody = () => ({
    householdId: household(), schoolYearId, amountCents: 500 + Math.floor(Math.random() * 20) * 100,
    receivedOn: '2026-10-15', method: 'bank', reference: 'LOAD-TEST syntetyczny',
  });
  const ops = [
    { name: 'GET /api/session', weight: 15, roles: null, run: (s, a) => s('GET', '/api/session', { cookie: a.cookie, expect: [200] }) },
    { name: 'GET /api/access', weight: 10, roles: null, run: (s, a) => s('GET', '/api/access', { cookie: a.cookie, expect: [200] }) },
    { name: 'GET /api/public/events', weight: 15, roles: null, run: (s) => s('GET', `/api/public/events?schoolYearId=${year}`, { expect: [200] }) },
    { name: 'GET /api/events', weight: 15, roles: EVENT_READERS, run: (s, a) => s('GET', `/api/events?schoolYearId=${year}`, { cookie: a.cookie, expect: [200] }) },
    { name: 'GET /api/meetings', weight: 10, roles: MEETING_READERS, run: (s, a) => s('GET', `/api/meetings?schoolYearId=${year}`, { cookie: a.cookie, expect: [200] }) },
    { name: 'GET /api/payments', weight: 15, roles: FINANCIAL, run: (s, a) => s('GET', `/api/payments?schoolYearId=${year}&limit=50`, { cookie: a.cookie, expect: [200] }) },
    // Granica ról: przedstawiciel nie widzi wpłat ani zebrań — oczekiwane 403.
    { name: 'GET /api/payments (403)', weight: 5, roles: ['representative'], run: (s, a) => s('GET', `/api/payments?schoolYearId=${year}&limit=50`, { cookie: a.cookie, expect: [403] }) },
    { name: 'GET /api/meetings (403)', weight: 3, roles: ['representative'], run: (s, a) => s('GET', `/api/meetings?schoolYearId=${year}`, { cookie: a.cookie, expect: [403] }) },
  ];
  if (allowWrites) {
    ops.push(
      { name: 'POST /api/payments', weight: 6, roles: FINANCIAL, run: (s, a, vu) => s('POST', '/api/payments', { cookie: a.cookie, body: paymentBody(), key: nextKey(vu), expect: [201] }) },
      {
        // Podwójne kliknięcie: dwa równoczesne żądania z tym samym kluczem → dokładnie jedno 201, drugie 200 (replay).
        name: 'POST /api/payments (double click)', weight: 2, roles: FINANCIAL,
        run: async (s, a, vu) => {
          const body = paymentBody();
          const key = nextKey(vu);
          const statuses = await Promise.all([0, 1].map(() => s('POST', '/api/payments', { cookie: a.cookie, body, key, expect: [200, 201] })));
          const created = statuses.filter((status) => status === 201).length;
          if (created !== 1 || !statuses.every((status) => status === 200 || status === 201)) {
            return { error: `double click produced ${statuses.join('/')}` };
          }
          return null;
        },
      },
      {
        name: 'POST /api/events', weight: 2, roles: ['admin', 'board'],
        run: (s, a, vu) => s('POST', '/api/events', {
          cookie: a.cookie, key: nextKey(vu), expect: [201],
          body: {
            schoolYearId, title: 'Szkic syntetyczny (test wydajności)', startsAt: '2026-12-03T18:00',
            endsAt: '2026-12-03T19:00', location: 'Sala testowa', organizer: 'Rada Rodziców', audience: 'internal',
          },
        }),
      },
    );
  }
  return ops;
}

function pickWeighted(list) {
  const total = list.reduce((sum, op) => sum + op.weight, 0);
  let roll = Math.random() * total;
  for (const op of list) {
    roll -= op.weight;
    if (roll < 0) return op;
  }
  return list[list.length - 1];
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function latencySummary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value) => Math.round(value * 10) / 10;
  return {
    p50: round(percentile(sorted, 50)), p95: round(percentile(sorted, 95)), p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? 0), mean: round(sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0),
  };
}

export async function runLoad({
  baseUrl, actors, schoolYearId, users, durationSec, thinkMs = 0, timeoutMs = 10_000,
  allowWrites = true, householdIds = null,
}) {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const allOps = operations({ schoolYearId, allowWrites, householdIds, runId });
  const origin = new URL(baseUrl).origin;
  const stats = new Map();
  const statusCounts = {};
  const errorSamples = [];
  const latencies = [];
  let requests = 0;
  let errors = 0;

  const record = (name, ms, ok, detail) => {
    if (!stats.has(name)) stats.set(name, { requests: 0, errors: 0, latencies: [] });
    const entry = stats.get(name);
    if (ms !== null) {
      entry.requests += 1;
      entry.latencies.push(ms);
      latencies.push(ms);
      requests += 1;
    }
    if (!ok) {
      entry.errors += 1;
      errors += 1;
      if (errorSamples.length < 20) errorSamples.push({ operation: name, ...detail });
    }
  };

  const sender = (opName) => async (method, path, { cookie, body, key, expect }) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET') headers.Origin = origin;
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const started = performance.now();
    let status = 0;
    let failure = null;
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      await response.arrayBuffer();
    } catch (error) {
      failure = error?.name === 'TimeoutError' ? 'timeout' : 'network_error';
    }
    const ms = performance.now() - started;
    statusCounts[status || failure] = (statusCounts[status || failure] ?? 0) + 1;
    const ok = !failure && expect.includes(status);
    record(opName, ms, ok, ok ? undefined : { status: status || failure, expected: expect });
    return status;
  };

  const end = performance.now() + durationSec * 1000;
  const started = performance.now();
  const virtualUser = async (vu) => {
    const actor = actors[vu % actors.length];
    const available = allOps.filter((op) => !op.roles || op.roles.includes(actor.role));
    while (performance.now() < end) {
      const op = pickWeighted(available);
      const outcome = await op.run(sender(op.name), actor, vu);
      if (outcome?.error) record(op.name, null, false, { detail: outcome.error });
      if (thinkMs > 0) await new Promise((resolve) => setTimeout(resolve, thinkMs));
    }
  };
  await Promise.all(Array.from({ length: users }, (_, vu) => virtualUser(vu)));
  const elapsedSec = (performance.now() - started) / 1000;

  const byOperation = {};
  for (const [name, entry] of [...stats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    byOperation[name] = { requests: entry.requests, errors: entry.errors, latencyMs: latencySummary(entry.latencies) };
  }
  return {
    virtualUsers: users,
    actors: actors.length,
    rolesCovered: [...new Set(actors.slice(0, users).map((a) => a.role))].sort(),
    writes: Boolean(allowWrites),
    durationSec: Math.round(elapsedSec * 100) / 100,
    requests,
    errors,
    errorRate: requests ? Math.round((errors / requests) * 10000) / 10000 : 0,
    throughputRps: Math.round((requests / elapsedSec) * 10) / 10,
    latencyMs: latencySummary(latencies),
    statusCounts,
    byOperation,
    errorSamples,
  };
}

export function checkThresholds(result, thresholds = DEFAULT_THRESHOLDS) {
  const breaches = [];
  if (result.requests === 0) breaches.push('no requests completed');
  if (result.latencyMs.p95 > thresholds.p95Ms) breaches.push(`p95 ${result.latencyMs.p95} ms > ${thresholds.p95Ms} ms`);
  if (result.latencyMs.p99 > thresholds.p99Ms) breaches.push(`p99 ${result.latencyMs.p99} ms > ${thresholds.p99Ms} ms`);
  if (result.errorRate > thresholds.maxErrorRate) breaches.push(`error rate ${result.errorRate} > ${thresholds.maxErrorRate}`);
  if (result.throughputRps < thresholds.minRps) breaches.push(`throughput ${result.throughputRps} rps < ${thresholds.minRps} rps`);
  return breaches;
}

export async function loadTest(options, { env = process.env, log = () => {} } = {}) {
  if (options.scenario === 'heavy') {
    // #217 pkt 4: scenariusz "heavy" zapisuje dane (import wyciągu) — wyłącznie
    // lokalnie. Tryb zdalny (tylko do odczytu, tylko staging) nie jest jeszcze
    // zaimplementowany — patrz "Ryzyka" w opisie PR.
    if (options.target) throw new UsageError('--scenario heavy runs locally only (remote heavy mode is not implemented yet)');
    return runHeavy(options, { log });
  }
  const startedAt = new Date().toISOString();
  let target;
  if (options.target) {
    const baseUrl = validateRemoteTarget(options.target, { confirmStaging: options.confirmStaging, env });
    const { schoolYearId, actors } = remoteActorsFromEnv(env);
    await verifyRemoteActors(baseUrl, actors, options.timeoutMs);
    target = { mode: 'remote', baseUrl, schoolYearId, actors, householdIds: null, close: async () => {} };
  } else {
    target = { mode: 'local', ...(await startLocalTarget({ log })) };
  }
  try {
    const allowWrites = options.allowWrites ?? target.mode === 'local';
    log(`running ${options.users} virtual users for ${options.durationSec} s against ${target.mode === 'local' ? 'local PGlite' : target.baseUrl} (writes: ${allowWrites})`);
    const result = await runLoad({
      baseUrl: target.baseUrl, actors: target.actors, schoolYearId: target.schoolYearId,
      users: options.users, durationSec: options.durationSec, thinkMs: options.thinkMs,
      timeoutMs: options.timeoutMs, allowWrites, householdIds: target.householdIds,
    });
    const breaches = checkThresholds(result, options.thresholds);
    return {
      mode: target.mode,
      target: target.mode === 'local' ? 'pglite-in-process (not representative)' : target.baseUrl,
      startedAt,
      node: process.version,
      ...(target.mode === 'local' ? { dataset: target.dataset, setupMs: target.setupMs } : {}),
      ...result,
      thresholds: options.thresholds,
      breaches,
      passed: breaches.length === 0,
    };
  } finally {
    await target.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = (message) => console.error(`[load-test] ${message}`);
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await loadTest(options, { log });
    const text = JSON.stringify(report, null, 2);
    console.log(text);
    if (options.out) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(options.out, `${text}\n`);
    }
    if (!report.passed) {
      log(`thresholds breached: ${report.breaches.join('; ')}`);
      process.exitCode = 1;
    }
  } catch (error) {
    log(error instanceof UsageError ? `refused: ${error.message}` : `failed: ${error.stack ?? error.message}`);
    process.exitCode = 2;
  }
}

