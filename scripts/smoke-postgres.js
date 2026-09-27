// Smoke test for CI and local checks: no external services, no real data.
// 1. Applies postgres/migrations to an in-memory PGlite using the same
//    migrator as `npm run db:migrate:postgres` and checks that a second run
//    is a no-op.
// 2. Starts the Node server on an ephemeral port on 127.0.0.1 and checks
//    /health, built static pages and the absence of source maps.
// Requires `npm run build` beforehand (dist/).
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { checkReadiness } from '../src/health.js';
import { startServer } from '../src/server.js';

const migrationsDir = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));

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

export async function smokeServer() {
  for (const app of ['import', 'panel', 'ledger']) {
    try {
      await access(`${distRoot}${app}/index.html`);
    } catch {
      throw new Error(`dist/${app}/index.html is missing; run npm run build first`);
    }
  }
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
    for (const app of ['import', 'panel', 'ledger']) {
      const redirect = await fetch(`${base}/${app}`, { redirect: 'manual' });
      check(redirect.status === 308 && redirect.headers.get('location') === `/${app}/`, `/${app} redirects to /${app}/`);
      const page = await fetch(`${base}/${app}/`);
      const html = await page.text();
      check(page.status === 200 && /<html/i.test(html), `/${app}/ serves built HTML`);
      check(page.headers.get('x-frame-options') === 'DENY', `/${app}/ sends security headers`);
    }
    const missing = await fetch(`${base}/panel/does-not-exist.js`);
    check(missing.status === 404, 'missing static file returns 404');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await smokePostgres();
    await smokeServer();
    console.log('Smoke test passed.');
  } catch (error) {
    console.error(`Smoke test failed: ${error.message}`);
    process.exitCode = 1;
  }
}
