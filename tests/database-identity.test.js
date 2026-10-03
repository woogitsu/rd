// #166 (kryterium 3), #191: tożsamość bazy docelowej w skryptach operatora.
// `--expect-database=<nazwa>` jest wymagane przed zapisem i porównywane z adresem
// oraz z current_database(); wynik zależy od bazy, nie od APP_ENV w powłoce.
// Dane wyłącznie syntetyczne; skrypty uruchamiane z nieosiągalną bazą (port 1),
// więc żaden test nie łączy się z prawdziwą bazą ani siecią.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  assertConnectedDatabase, databaseNameFromUrl, DatabaseIdentityError, parseExpectDatabase, requireExpectedDatabase,
} from '../src/database-identity.js';
import { SNAPSHOT_FORMAT, SNAPSHOT_TABLES, snapshotChecksum } from '../src/d1-postgres-migration.js';
import { runRotateCli } from '../scripts/rotate-mfa-key.js';
import { createTestDb } from './helpers/pg.js';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const PRODUCTION_URL = 'postgres://rd:rd@127.0.0.1:1/rd_production';

function run(name, args, { appEnv = 'staging', url = PRODUCTION_URL } = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', DATABASE_URL: url, APP_ENV: appEnv };
  return spawnSync(process.execPath, [script(name), ...args], { env, encoding: 'utf8', timeout: 60_000 });
}

function failure(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
}

test('databaseNameFromUrl: nazwa z adresu, bez hasła; brak nazwy i śmieci to null', () => {
  assert.equal(databaseNameFromUrl('postgres://u:p@host.railway.internal:5432/railway'), 'railway');
  assert.equal(databaseNameFromUrl('postgresql://u:p@h/rd_staging?sslmode=require'), 'rd_staging');
  assert.equal(databaseNameFromUrl('postgres://u:p@h/rd%5Fstaging'), 'rd_staging');
  for (const bad of ['postgres://u:p@h', 'postgres://u:p@h/', '', 'nie adres', undefined, null]) assert.equal(databaseNameFromUrl(bad), null, String(bad));
});

test('parseExpectDatabase: jedna poprawna nazwa; brak = undefined; powtórzenie, brak wartości i dziwne znaki to błąd', () => {
  assert.equal(parseExpectDatabase(['snapshot.json', '--apply']), undefined);
  assert.equal(parseExpectDatabase(['--expect-database=rd_staging', '--apply']), 'rd_staging');
  assert.equal(parseExpectDatabase(['--expect-database=rd-prod.1$']), 'rd-prod.1$');
  const cases = [
    [['--expect-database=a', '--expect-database=b'], 'expect_database_duplicate'],
    [['--expect-database'], 'expect_database_invalid'],
    [['--expect-database='], 'expect_database_invalid'],
    [['--expect-database=a b'], 'expect_database_invalid'],
    [['--expect-database=postgres://u:p@h/db'], 'expect_database_invalid'],
    [['--expect-database=' + 'x'.repeat(64)], 'expect_database_invalid'],
    [['--expect-database=-leading'], 'expect_database_invalid'],
  ];
  for (const [args, code] of cases) {
    const error = failure(() => parseExpectDatabase(args));
    assert.ok(error instanceof DatabaseIdentityError, JSON.stringify(args));
    assert.equal(error.code, code, JSON.stringify(args));
  }
});

test('requireExpectedDatabase: flaga wymagana, nazwa musi zgadzać się z adresem; komunikat bez adresu i hasła', () => {
  assert.equal(requireExpectedDatabase({ url: PRODUCTION_URL, args: ['--expect-database=rd_production'] }), 'rd_production');
  const missing = failure(() => requireExpectedDatabase({ url: PRODUCTION_URL, args: [] }));
  assert.equal(missing?.code, 'expect_database_required');
  const mismatch = failure(() => requireExpectedDatabase({ url: PRODUCTION_URL, args: ['--expect-database=rd_staging'] }));
  assert.equal(mismatch?.code, 'database_identity_mismatch');
  assert.match(mismatch.message, /"rd_production", not "rd_staging"/);
  assert.doesNotMatch(mismatch.message, /rd:rd@|127\.0\.0\.1/);
  assert.equal(failure(() => requireExpectedDatabase({ url: 'postgres://u:p@h', args: ['--expect-database=x'] }))?.code, 'database_url_without_name');
  assert.equal(failure(() => requireExpectedDatabase({ url: '', args: ['--expect-database=x'] }))?.code, 'database_url_without_name', 'pusty adres to błąd, nie pominięcie');
  // Wstrzyknięte połączenie (bez adresu): flaga nadal wymagana, porównanie z adresem pominięte.
  assert.equal(requireExpectedDatabase({ url: undefined, args: ['--expect-database=x'] }), 'x');
  assert.equal(failure(() => requireExpectedDatabase({ url: undefined, args: [] }))?.code, 'expect_database_required');
});

test('assertConnectedDatabase: current_database() musi zgadzać się z oczekiwaną nazwą', async () => {
  const db = new PGlite();
  try {
    const { rows } = await db.query('SELECT current_database() AS name');
    await assertConnectedDatabase(db, rows[0].name);
    await assert.rejects(assertConnectedDatabase(db, 'rd_production'), (error) => (
      error instanceof DatabaseIdentityError && error.code === 'database_identity_mismatch'
      && error.message.includes(`"${rows[0].name}"`) && error.message.includes('"rd_production"')));
  } finally { await db.close(); }
});

test('migrate-postgres: baza produkcyjna z APP_ENV=staging w powłoce nie przechodzi bez --expect-database ani z inną nazwą', () => {
  // Scenariusz z #166: operator wpisuje APP_ENV=staging przed komendą z adresem produkcji.
  const noFlag = run('migrate-postgres.js', []);
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stderr, /--expect-database=<database name> is required/);
  assert.match(noFlag.stderr, /Nothing was changed/);
  assert.doesNotMatch(noFlag.stderr, /ECONNREFUSED|connect/, 'odmowa przed połączeniem z bazą');

  const wrong = run('migrate-postgres.js', ['--expect-database=rd_staging']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /points to database "rd_production", not "rd_staging"/);
  assert.doesNotMatch(wrong.stderr, /ECONNREFUSED|rd:rd@/);

  const right = run('migrate-postgres.js', ['--expect-database=rd_production']);
  assert.equal(right.status, 1);
  assert.match(right.stderr, /Migration failed/);
  assert.doesNotMatch(right.stderr, /expect-database|identity/, 'poprawna nazwa przechodzi do łączenia (tu: nieosiągalna baza)');

  // Wynik zależy od adresu, nie od powłoki: ta sama komenda, inny APP_ENV.
  for (const appEnv of ['staging', 'production', 'Production', 'prod', 'development', undefined]) {
    const result = run('migrate-postgres.js', ['--expect-database=rd_staging', '--allow-production'], { appEnv });
    assert.equal(result.status, 1, String(appEnv));
    assert.match(result.stderr, /points to database "rd_production", not "rd_staging"/, String(appEnv));
  }
});

test('restore-postgres-snapshot --apply: --expect-database wymagane i zgodne z adresem; próba na sucho go nie wymaga', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rd-identity-'));
  try {
    const tables = Object.fromEntries(SNAPSHOT_TABLES.map((name) => [name, []]));
    const file = join(directory, 'snapshot.json');
    await writeFile(file, JSON.stringify({ format: SNAPSHOT_FORMAT, tables, checksum: snapshotChecksum(tables) }), { mode: 0o600 });
    const base = [file, '--apply', '--actor=u-admin'];
    const noFlag = run('restore-postgres-snapshot.js', base);
    assert.equal(noFlag.status, 1);
    assert.match(noFlag.stderr, /Restore failed: --expect-database=<database name> is required/);
    assert.doesNotMatch(noFlag.stderr, /ECONNREFUSED/);
    const wrong = run('restore-postgres-snapshot.js', [...base, '--expect-database=rd_staging']);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /points to database "rd_production", not "rd_staging"/);
    const right = run('restore-postgres-snapshot.js', [...base, '--expect-database=rd_production']);
    assert.equal(right.status, 1);
    assert.match(right.stderr, /Restore failed/);
    assert.doesNotMatch(right.stderr, /expect-database|identity/);
    const dry = run('restore-postgres-snapshot.js', [file]);
    assert.equal(dry.status, 0, 'próba na sucho nie dotyka bazy');
    const check = run('restore-postgres-snapshot.js', [file, '--check']);
    assert.equal(check.status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('verify-export --restore-database: --expect-database wymagane przed jakimkolwiek odczytem paczki lub bazy', () => {
  const noFlag = run('verify-export.js', ['bundle-does-not-exist.json', '--restore-database']);
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stderr, /Export verification failed: --expect-database=<database name> is required/);
  const wrong = run('verify-export.js', ['bundle-does-not-exist.json', '--restore-database', '--expect-database=rd_staging']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /points to database "rd_production", not "rd_staging"/);
  // Poprawna nazwa przechodzi do odczytu paczki (tu: brak pliku), nie do błędu tożsamości.
  const right = run('verify-export.js', ['bundle-does-not-exist.json', '--restore-database', '--expect-database=rd_production']);
  assert.equal(right.status, 1);
  assert.doesNotMatch(right.stderr, /expect-database|identity/);
});

test('mfa:rotate-key: zapis (--apply) wymaga nazwy bazy, próba bez zapisu nie; nazwa podana w próbie też jest sprawdzana', async () => {
  const db = new PGlite();
  const sink = () => { const chunks = []; return { write: (chunk) => { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') }; };
  const keys = `1:${Buffer.alloc(32, 7).toString('base64')}`;
  const env = { MFA_ENCRYPTION_KEYS: keys };
  try {
    // Schemat potrzebny rotacji nie jest tu istotny: odmowa następuje przed jakimkolwiek zapisem.
    const refusals = [
      [['--apply'], /--expect-database=<database name> is required/],
      [['--apply', '--expect-database=rd_production'], /Connected to database ".+", not "rd_production"/],
      [['--expect-database=rd_production'], /Connected to database ".+", not "rd_production"/],
    ];
    for (const [argv, pattern] of refusals) {
      const stdout = sink();
      const stderr = sink();
      assert.equal(await runRotateCli({ argv, env, db, stdout, stderr }), 1, argv.join(' '));
      assert.match(stderr.text(), pattern, argv.join(' '));
      assert.equal(stdout.text(), '', 'nic nie wypisano jako sukces');
    }
    const urlMismatch = sink();
    assert.equal(await runRotateCli({ argv: ['--apply', '--expect-database=rd_staging'], env: { ...env, DATABASE_URL: PRODUCTION_URL }, stdout: sink(), stderr: urlMismatch }), 1);
    assert.match(urlMismatch.text(), /points to database "rd_production", not "rd_staging"/);
  } finally { await db.close(); }
});

test('mfa:rotate-key: poprawna nazwa bazy przepuszcza próbę i zapis (pusta baza: nic do rotacji)', async () => {
  const db = await createTestDb();
  const sink = () => { const chunks = []; return { write: (chunk) => { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') }; };
  const env = { MFA_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 7).toString('base64')}` };
  try {
    const name = (await db.query('SELECT current_database() AS name')).rows[0].name;
    for (const [argv, mode] of [[[`--expect-database=${name}`], 'DRY RUN'], [['--apply', `--expect-database=${name}`], 'APPLY'], [[], 'DRY RUN']]) {
      const stdout = sink();
      const stderr = sink();
      assert.equal(await runRotateCli({ argv, env, db, stdout, stderr }), 0, `${argv.join(' ')}: ${stderr.text()}`);
      assert.ok(stdout.text().includes(`mode: ${mode}`), argv.join(' '));
      assert.match(stdout.text(), /(would rotate|rotated): 0/, argv.join(' '));
    }
  } finally { await db.close(); }
});
