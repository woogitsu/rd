// #166 (kryterium 3), #191: skrypty operatora na PRAWDZIWYM PostgreSQL. Pusta baza
// jednorazowa (osobna od szablonu testów), skrypty uruchamiane jako procesy z
// DATABASE_URL tej bazy i APP_ENV=staging w powłoce — dokładnie scenariusz z #166:
// wynik zależy od `--expect-database`, nie od APP_ENV. Plik działa wyłącznie z
// RD_TEST_PG_URL (npm run test:pg-real); bez niej jest pomijany. Dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SNAPSHOT_FORMAT, SNAPSHOT_TABLES, snapshotChecksum } from '../src/d1-postgres-migration.js';

const skip = process.env.RD_TEST_PG_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
// Prefiks rd_t_<znacznik>_ pozwala scripts/test-pg-real.js zamieść bazę, gdyby test został przerwany.
const tag = /^[a-z0-9]{1,16}$/.test(process.env.RD_TEST_PG_RUN_TAG ?? '') ? `${process.env.RD_TEST_PG_RUN_TAG}_` : '';

async function withEmptyDatabase(fn) {
  const name = `rd_t_${tag}opid_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: process.env.RD_TEST_PG_URL });
  await admin.connect();
  const url = new URL(process.env.RD_TEST_PG_URL);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn({ name, url: url.toString(), client });
  } finally {
    await client.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

function run(name, args, url) {
  // APP_ENV=staging w powłoce operatora, DATABASE_URL tej bazy: strażnik --allow-production jej nie rozpozna.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', DATABASE_URL: url, APP_ENV: 'staging', TZ: 'UTC' };
  return spawnSync(process.execPath, [script(name), ...args], { env, encoding: 'utf8', timeout: 180_000 });
}

const count = async (client, sql) => Number((await client.query(sql)).rows[0].n);

function adminSnapshot() {
  const tables = Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, []]));
  tables.users.push({ id: 'u-admin', email: 'admin@example.invalid', display_name: 'Syntetyczny administrator', disabled_at: null, created_at: '2026-09-01T00:00:00Z' });
  tables.role_grants.push({ id: 'g-admin', user_id: 'u-admin', role: 'admin', class_id: null, school_year_id: null, expires_at: null });
  return { format: SNAPSHOT_FORMAT, createdAt: '2026-09-27T00:00:00Z', checksum: snapshotChecksum(tables), tables };
}

test('migrate-postgres na prawdziwej bazie: zła nazwa nie zostawia śladu, właściwa stosuje migracje; APP_ENV w powłoce nie ma znaczenia', { skip }, async () => {
  await withEmptyDatabase(async ({ name, url, client }) => {
    for (const flag of [[], ['--expect-database=rd_production'], [`--expect-database=${name}_x`]]) {
      const refused = run('migrate-postgres.js', flag, url);
      assert.equal(refused.status, 1, flag.join(' '));
      assert.match(refused.stderr, /--expect-database/, flag.join(' '));
      assert.equal(await count(client, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'"), 0, 'baza nietknięta (brak tabel)');
    }
    const applied = run('migrate-postgres.js', [`--expect-database=${name}`], url);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Applied migrations: /);
    assert.ok(await count(client, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'") > 50);
    const again = run('migrate-postgres.js', [`--expect-database=${name}`], url);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /No pending migrations/);
  });
});

test('restore-postgres-snapshot --apply na prawdziwej bazie: zła nazwa nic nie zapisuje; po odtworzeniu baza nie jest już pusta (ensureEmpty na wszystkich tabelach)', { skip }, async () => {
  await withEmptyDatabase(async ({ name, url, client }) => {
    const migrated = run('migrate-postgres.js', [`--expect-database=${name}`], url);
    assert.equal(migrated.status, 0, migrated.stderr);
    const directory = await mkdtemp(join(tmpdir(), 'rd-real-identity-'));
    try {
      const file = join(directory, 'snapshot.json');
      await writeFile(file, JSON.stringify(adminSnapshot()), { mode: 0o600 });
      const args = [file, '--apply', '--actor=u-admin'];

      const wrong = run('restore-postgres-snapshot.js', [...args, '--expect-database=rd_production'], url);
      assert.equal(wrong.status, 1);
      assert.match(wrong.stderr, /points to database ".+", not "rd_production"/);
      const missing = run('restore-postgres-snapshot.js', args, url);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /--expect-database=<database name> is required/);
      assert.equal(await count(client, 'SELECT count(*)::int AS n FROM users'), 0, 'odmowa przed jakimkolwiek zapisem');

      const restored = run('restore-postgres-snapshot.js', [...args, `--expect-database=${name}`], url);
      assert.equal(restored.status, 0, restored.stderr);
      assert.equal(await count(client, 'SELECT count(*)::int AS n FROM users'), 1);
      assert.equal(await count(client, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'migration.d1_import'"), 1);

      // Drugie odtworzenie na tej samej bazie: niepusta (także tabela spoza migawki, np. audit_events/users).
      const second = run('restore-postgres-snapshot.js', [...args, `--expect-database=${name}`], url);
      assert.equal(second.status, 1);
      assert.match(second.stderr, /Target table is not empty: /);
      assert.equal(await count(client, "SELECT count(*)::int AS n FROM audit_events WHERE action = 'migration.d1_import'"), 1, 'jedno zdarzenie importu');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('restore-postgres-snapshot: wiersz w tabeli spoza migawki (login_rate_limits) blokuje odtworzenie na prawdziwej bazie', { skip }, async () => {
  await withEmptyDatabase(async ({ name, url, client }) => {
    assert.equal(run('migrate-postgres.js', [`--expect-database=${name}`], url).status, 0);
    await client.query("INSERT INTO login_rate_limits (scope_type, scope_hash) VALUES ('ip', repeat('b', 64))");
    const directory = await mkdtemp(join(tmpdir(), 'rd-real-identity-'));
    try {
      const file = join(directory, 'snapshot.json');
      await writeFile(file, JSON.stringify(adminSnapshot()), { mode: 0o600 });
      const refused = run('restore-postgres-snapshot.js', [file, '--apply', '--actor=u-admin', `--expect-database=${name}`], url);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /Target table is not empty: login_rate_limits/);
      assert.equal(await count(client, 'SELECT count(*)::int AS n FROM users'), 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
