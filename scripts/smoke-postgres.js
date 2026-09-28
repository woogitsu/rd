// Smoke test for CI and local checks: no external services, no real data.
// 1. Applies postgres/migrations to an in-memory PGlite using the same
//    migrator as `npm run db:migrate:postgres` and checks that a second run
//    is a no-op.
// 2. Starts the Node server on an ephemeral port on 127.0.0.1 without a
//    database and checks /health, every built panel (STATIC_PREFIXES —
//    single source of truth in src/node-app.js) and the absence of
//    private paths / source maps.
// 3. Starts a second server WITH a migrated PGlite database and a small
//    synthetic dataset (issue #119): /health/ready 200 through a real HTTP
//    server, and role boundaries checked at the HTTP level (representative
//    ≠ payments; treasurer with MFA does get payments; public events do not
//    leak author data).
// Requires `npm run build` beforehand (dist/).
import { access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { checkReadiness } from '../src/health.js';
import { startServer } from '../src/server.js';
import { handlePgRequest } from '../src/pg/app.js';
import { STATIC_PREFIXES } from '../src/node-app.js';
import { createSessionSecret } from '../src/auth.js';

const migrationsDir = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const PANELS = Array.from(STATIC_PREFIXES).sort();

// Adapter: the migrator sends multi-statement SQL without parameters, which
// PGlite supports only through exec(); parameterised queries use query().
export function pgliteClient(db) {
  return {
    async query(sql, params = []) {
      if (params.length) return db.query(sql, params);
      const results = await db.exec(sql);
      return results.at(-1) ?? { rows: [] };
    },
  };
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

export async function smokePostgres() {
  const db = new PGlite();
  try {
    const client = pgliteClient(db);
    const migrations = await loadMigrations(migrationsDir);
    check(migrations.length > 0, `found ${migrations.length} PostgreSQL migrations`);
    const applied = await applyMigrations(client, migrations);
    check(applied.length === migrations.length, `applied ${applied.join(', ')}`);
    const again = await applyMigrations(client, migrations);
    check(again.length === 0, 'second migrator run is a no-op');
    const { rows } = await db.query('SELECT count(*)::int AS count FROM schema_migrations');
    check(rows[0].count === migrations.length, 'schema_migrations records every file');
    for (const view of ['household_payment_totals', 'payment_entry_net']) {
      await db.query(`SELECT * FROM ${view} LIMIT 1`);
      check(true, `view ${view} is queryable`);
    }
    const readiness = await checkReadiness({ db });
    check(readiness.ready && readiness.body.migrations.applied === migrations.length, 'readiness reports every migration applied');
  } finally {
    await db.close();
  }
}

async function checkPanelsBuilt() {
  for (const app of PANELS) {
    try {
      await access(`${distRoot}${app}/index.html`);
    } catch {
      throw new Error(`dist/${app}/index.html is missing; run npm run build first`);
    }
  }
  check(true, `all ${PANELS.length} built panels are present (${PANELS.join(', ')})`);
}

// No *.map file may be served from dist/ (issue #119).
async function checkNoSourceMaps() {
  const stack = [distRoot];
  const offenders = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = `${dir}${entry.name}`;
      if (entry.isDirectory()) stack.push(`${full}/`);
      else if (entry.name.endsWith('.map')) offenders.push(full);
    }
  }
  check(offenders.length === 0, `no *.map files in dist/ (found: ${offenders.join(', ') || 'none'})`);
}

const PRIVATE_PATHS = [
  '/postgres/migrations/0001_core.sql',
  '/src/server.js',
  '/scripts/smoke-postgres.js',
  '/.env',
  '/package.json',
  '/panel/../src/server.js',
  '/panel/%2e%2e/src/server.js',
  '/panel/%2e%2e%2fsrc%2fserver.js',
];

export async function smokeServer() {
  await checkPanelsBuilt();
  await checkNoSourceMaps();
  const server = await startServer({ host: '127.0.0.1', port: 0, distRoot, env: {} });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`);
    check(health.status === 200, '/health returns 200');
    const body = await health.json();
    check(JSON.stringify(body) === '{"status":"ok"}', '/health returns only the technical status');
    check(health.headers.get('cache-control') === 'no-store', '/health is not cached');
    const ready = await fetch(`${base}/health/ready`);
    check(ready.status === 503 && (await ready.json()).checks.database === 'not_configured', '/health/ready returns 503 without a database');
    for (const app of PANELS) {
      const redirect = await fetch(`${base}/${app}`, { redirect: 'manual' });
      check(redirect.status === 308 && redirect.headers.get('location') === `/${app}/`, `/${app} redirects to /${app}/`);
      const page = await fetch(`${base}/${app}/`);
      const html = await page.text();
      check(page.status === 200 && /<html/i.test(html), `/${app}/ serves built HTML`);
      check(page.headers.get('x-frame-options') === 'DENY', `/${app}/ sends security headers`);
    }
    const missing = await fetch(`${base}/panel/does-not-exist.js`);
    check(missing.status === 404, 'missing static file returns 404');
    for (const path of PRIVATE_PATHS) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' });
      check(response.status === 404, `private/traversal path ${path} returns 404 (got ${response.status})`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- Server with a migrated database and a small synthetic dataset ---

async function seedSchoolYear(db, id) {
  await db.query(
    `INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ($1, $2, '2026-09-01', '2027-08-31')
     ON CONFLICT (id) DO NOTHING`,
    [id, `smoke ${id}`],
  );
}

async function seedClass(db, id, schoolYearId) {
  await db.query(
    `INSERT INTO classes (id, school_year_id, name) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [id, schoolYearId],
  );
}

async function seedUser(db, userId) {
  await db.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@example.invalid`],
  );
}

// Minimal reimplementation of tests/helpers/pg.js#seedUserSession — this
// script does not import that file directly, because tests/helpers/
// network-guard.js installs a global fetch() trap as an import side effect,
// which would break this script's OWN fetch() calls to its local server.
async function seedSession(db, { userId, role, classId, schoolYearId, mfa }) {
  await seedUser(db, userId);
  if (schoolYearId) await seedSchoolYear(db, schoolYearId);
  if (classId) await seedClass(db, classId, schoolYearId);
  await db.query(
    `INSERT INTO role_grants (id, user_id, role, class_id, school_year_id) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
    [userId, role, classId ?? null, schoolYearId ?? null],
  );
  const { secret, tokenHash } = await createSessionSecret();
  const expires = new Date(Date.now() + 60 * 60 * 1000);
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, mfa_verified_at)
     VALUES (gen_random_uuid(), $1, $2, now(), $3, CASE WHEN $4::boolean THEN now() END)`,
    [userId, tokenHash, expires.toISOString(), Boolean(mfa)],
  );
  return `rd_session=${secret}`;
}

export async function smokeServerWithDatabase() {
  const db = new PGlite();
  const client = pgliteClient(db);
  const migrations = await loadMigrations(migrationsDir);
  await applyMigrations(client, migrations);
  const YEAR = 'smoke-y2026';
  const CLASS = 'smoke-c1a';
  await seedSchoolYear(db, YEAR);
  const repCookie = await seedSession(db, { userId: 'smoke-rep', role: 'representative', classId: CLASS, schoolYearId: YEAR, mfa: true });
  const treasurerCookie = await seedSession(db, { userId: 'smoke-treasurer', role: 'treasurer', schoolYearId: YEAR, mfa: true });

  const server = await startServer({
    host: '127.0.0.1', port: 0, distRoot, env: { db }, fetchHandler: handlePgRequest,
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const ready = await fetch(`${base}/health/ready`);
    check(ready.status === 200, `/health/ready returns 200 through the real HTTP server on a migrated database (got ${ready.status})`);

    const anonymous = await fetch(`${base}/api/session`);
    check(anonymous.status === 401, 'GET /api/session without a cookie returns 401');

    const repAccess = await fetch(`${base}/api/access`, { headers: { Cookie: repCookie } });
    check(repAccess.status === 200, 'GET /api/access for a class representative returns 200');

    // Granica ról (issue #119): przedstawiciel klasy nie ma dostępu do wpłat.
    const repPayments = await fetch(`${base}/api/payments?schoolYearId=${YEAR}`, { headers: { Cookie: repCookie } });
    check(repPayments.status === 403, `GET /api/payments for a class representative returns 403 (got ${repPayments.status})`);

    const treasurerPayments = await fetch(`${base}/api/payments?schoolYearId=${YEAR}`, { headers: { Cookie: treasurerCookie } });
    check(treasurerPayments.status === 200, `GET /api/payments for a treasurer with confirmed MFA returns 200 (got ${treasurerPayments.status})`);

    const publicEvents = await fetch(`${base}/api/public/events`);
    check(publicEvents.status === 200, 'GET /api/public/events returns 200 without a session');
    const publicEventsText = await publicEvents.text();
    check(!/smoke-rep|smoke-treasurer|authorId|author_id/i.test(publicEventsText), 'GET /api/public/events does not leak author data');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await smokePostgres();
    await smokeServer();
    await smokeServerWithDatabase();
    console.log('Smoke test passed.');
  } catch (error) {
    console.error(`Smoke test failed: ${error.message}`);
    process.exitCode = 1;
  }
}
