// Manifest, kolejność scalania i kontrola CI dla migracji PostgreSQL (issue #79).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { buildManifest, manifestsEqual, readManifestFile } from '../scripts/generate-migrations-manifest.js';
import { checkMigrationsOrder } from '../scripts/check-migrations-order.js';

const migrationsDir = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

function fakeClient(initial = []) {
  const rows = [...initial];
  return {
    rows,
    async query(sql, params = []) {
      if (sql.startsWith('SELECT name, checksum')) return { rows: rows.map((r) => ({ ...r })) };
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        rows.push({ name: params[0], checksum: params[1], applied_seq: params[2] });
      }
      return { rows: [] };
    },
  };
}

// --- Manifest -------------------------------------------------------------

test('MANIFEST.json in the repository is up to date with postgres/migrations', async () => {
  const migrations = await loadMigrations(migrationsDir);
  const existing = await readManifestFile(join(migrationsDir, 'MANIFEST.json'));
  const next = buildManifest(existing, migrations);
  assert.ok(manifestsEqual(existing, next), 'run `npm run migrations:manifest` and commit the result');
  assert.deepEqual(existing.map((e) => e.name), migrations.map((m) => m.name));
  for (const entry of existing) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.name}: sha256 in manifest looks malformed`);
  }
});

test('buildManifest keeps existing order and appends new files at the end', () => {
  const migrations = [
    { name: '0001_a.sql', checksum: 'a'.repeat(64) },
    { name: '0002_b.sql', checksum: 'b'.repeat(64) },
    { name: '0003_c.sql', checksum: 'c'.repeat(64) }, // nowy plik, numer w środku — i tak trafia na koniec
  ];
  const existing = [
    { name: '0002_b.sql', sha256: 'b'.repeat(64) },
    { name: '0001_a.sql', sha256: 'a'.repeat(64) },
  ];
  const next = buildManifest(existing, migrations);
  assert.deepEqual(next.map((e) => e.name), ['0002_b.sql', '0001_a.sql', '0003_c.sql']);
});

test('buildManifest updates the checksum of an existing entry without moving it', () => {
  const migrations = [{ name: '0001_a.sql', checksum: 'z'.repeat(64) }];
  const existing = [{ name: '0001_a.sql', sha256: 'a'.repeat(64) }];
  const next = buildManifest(existing, migrations);
  assert.deepEqual(next, [{ name: '0001_a.sql', sha256: 'z'.repeat(64) }]);
});

// --- Kontrola kolejności/integralności (CI) -------------------------------

test('checkMigrationsOrder: new file with a number <= the base branch maximum is refused', () => {
  const problems = checkMigrationsOrder(
    [{ status: 'A', path: 'postgres/migrations/0010_gap.sql' }],
    ['0001_a.sql', '0018_news.sql'],
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /0010_gap\.sql.*0018/);
});

test('checkMigrationsOrder: new file with a number above the base maximum passes', () => {
  const problems = checkMigrationsOrder(
    [{ status: 'A', path: 'postgres/migrations/0033_new.sql' }],
    ['0001_a.sql', '0018_news.sql'],
  );
  assert.deepEqual(problems, []);
});

test('checkMigrationsOrder: modifying or deleting an already-merged file is refused', () => {
  const modified = checkMigrationsOrder([{ status: 'M', path: 'postgres/migrations/0018_news.sql' }], ['0018_news.sql']);
  assert.equal(modified.length, 1);
  assert.match(modified[0], /0018_news\.sql/);
  const deleted = checkMigrationsOrder([{ status: 'D', path: 'postgres/migrations/0018_news.sql' }], ['0018_news.sql']);
  assert.equal(deleted.length, 1);
  const renamed = checkMigrationsOrder([{ status: 'R100', path: 'postgres/migrations/0018_renamed.sql' }], ['0018_news.sql']);
  // Zmiana nazwy pliku spoza gałęzi bazowej pod tym samym starym numerem nie jest
  // sama w sobie problemem tej reguły (nowa nazwa to inny plik) — ale gdyby dotyczyła
  // pliku obecnego na bazie pod tą samą nazwą, zgłosiłaby się jak 'M'/'D' powyżej.
  assert.deepEqual(renamed, []);
});

test('checkMigrationsOrder ignores non-migration files (e.g. MANIFEST.json)', () => {
  const problems = checkMigrationsOrder([{ status: 'M', path: 'postgres/migrations/MANIFEST.json' }], []);
  assert.deepEqual(problems, []);
});

// --- Migrator: out-of-order --------------------------------------------

test('migrator refuses an out-of-order migration by default and records applied_seq', async () => {
  const already = { name: '0018_news.sql', checksum: 'a'.repeat(64), applied_seq: 1 };
  const client = fakeClient([already]);
  const outOfOrder = { name: '0016_late.sql', checksum: 'b'.repeat(64), sql: 'SELECT 1' };
  const source = [already, outOfOrder]; // wszystkie już nałożone migracje muszą być w źródle
  await assert.rejects(applyMigrations(client, source), /Out-of-order migration: 0016_late\.sql/);
  const completed = await applyMigrations(client, source, { allowOutOfOrder: true });
  assert.deepEqual(completed, ['0016_late.sql']);
  assert.equal(client.rows.at(-1).applied_seq, 2);
});

test('migrator accepts a new migration with a higher number and increments applied_seq', async () => {
  const already = { name: '0001_a.sql', checksum: 'a'.repeat(64), applied_seq: 1 };
  const client = fakeClient([already]);
  const migration = { name: '0002_b.sql', checksum: 'b'.repeat(64), sql: 'SELECT 1' };
  assert.deepEqual(await applyMigrations(client, [already, migration]), ['0002_b.sql']);
  assert.equal(client.rows.at(-1).applied_seq, 2);
});

// --- Ścieżka aktualizacji: resume w dowolnym punkcie daje ten sam katalog --
// Uwaga o zakresie: `main` ma dziś już scaloną kolejkę (#13/#14/#16/#17) i
// logowanie (#20) w jednej liniowej liście plików (patrz postgres/README.md).
// Ten test sprawdza więc odporność migratora na WZNOWIENIE w dowolnym punkcie
// (np. baza już ma 0001..0009, PR dokłada 0010..N) — nie dwie RÓŻNE kolejności
// historyczne, bo dla obecnego main-a nie ma już dwóch do porównania.
test('resuming the migrator at any split point yields the same schema as applying everything at once', { timeout: 120_000 }, async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgliteClient } = await import('../scripts/smoke-postgres.js');
  const migrations = await loadMigrations(migrationsDir);

  async function snapshot(db) {
    const columns = await db.query(`SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`);
    const constraints = await db.query(`SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY table_name, conname`);
    const triggers = await db.query(`SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(oid) AS def
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY table_name, tgname`);
    const views = await db.query(`SELECT table_name, view_definition FROM information_schema.views
      WHERE table_schema = 'public' ORDER BY table_name`);
    return JSON.stringify({ columns: columns.rows, constraints: constraints.rows, triggers: triggers.rows, views: views.rows });
  }

  const fresh = new PGlite();
  await applyMigrations(pgliteClient(fresh), migrations);
  const freshSnapshot = await snapshot(fresh);
  await fresh.close();

  // Dwa punkty wznowienia (maszyna współdzielona — bez mnożenia pełnych
  // przebiegów migratora ponad potrzebę): w połowie i tuż przed końcem.
  const splitPoints = [Math.floor(migrations.length / 2), migrations.length - 1];
  for (const split of splitPoints) {
    const db = new PGlite();
    const client = pgliteClient(db);
    await applyMigrations(client, migrations.slice(0, split));
    await applyMigrations(client, migrations); // "PR" dokłada resztę, migrator pomija już nałożone
    assert.equal(await snapshot(db), freshSnapshot, `mismatch when resuming after ${split} migrations`);
    await db.close();
  }
});

// --- CLI (git) — jeden test end-to-end na tymczasowym repozytorium --------

const checkOrderScript = fileURLToPath(new URL('../scripts/check-migrations-order.js', import.meta.url));

async function initBaseRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'rd-migrations-order-'));
  const { mkdir } = await import('node:fs/promises');
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'agent@example.invalid']);
  run(['config', 'user.name', 'Test Agent']);
  await mkdir(join(dir, 'postgres', 'migrations'), { recursive: true });
  await writeFile(join(dir, 'postgres', 'migrations', '0001_a.sql'), 'SELECT 1;\n');
  await writeFile(join(dir, 'postgres', 'migrations', '0018_b.sql'), 'SELECT 1;\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'base']);
  run(['checkout', '-q', '-b', 'feature']);
  return { dir, run };
}

test('check-migrations-order.js CLI: refuses a new migration numbered <= the base branch maximum', async () => {
  const { dir, run } = await initBaseRepo();
  try {
    await writeFile(join(dir, 'postgres', 'migrations', '0010_low.sql'), 'SELECT 2;\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'add low-numbered migration']);
    assert.throws(
      () => execFileSync(process.execPath, [checkOrderScript, '--base', 'main'], { cwd: dir, encoding: 'utf8' }),
      (error) => error.status === 1 && /0010_low\.sql/.test(error.stderr.toString()),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-migrations-order.js CLI: passes for a new migration numbered above the base branch maximum', async () => {
  const { dir, run } = await initBaseRepo();
  try {
    await writeFile(join(dir, 'postgres', 'migrations', '0033_high.sql'), 'SELECT 3;\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'add high-numbered migration']);
    const out = execFileSync(process.execPath, [checkOrderScript, '--base', 'main'], { cwd: dir, encoding: 'utf8' });
    assert.match(out, /passed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check-migrations-order.js CLI: refuses editing an already-merged migration file', async () => {
  const { dir, run } = await initBaseRepo();
  try {
    await writeFile(join(dir, 'postgres', 'migrations', '0018_b.sql'), 'SELECT 999; -- edited after merge\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'edit a merged migration']);
    assert.throws(
      () => execFileSync(process.execPath, [checkOrderScript, '--base', 'main'], { cwd: dir, encoding: 'utf8' }),
      (error) => error.status === 1 && /0018_b\.sql/.test(error.stderr.toString()),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
