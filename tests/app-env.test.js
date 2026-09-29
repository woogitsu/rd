// #166: jedna normalizacja APP_ENV (src/app-env.js) i jej użycie w skryptach.
// Dane syntetyczne; skrypty odmawiają PRZED jakimkolwiek połączeniem, a adresy
// baz w testach wskazują nieosiągalny port lokalny.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appEnvWarning, guardDangerousOperation, isProductionEnv, isProductionLikeEnv, KNOWN_APP_ENVS, resolveAppEnv,
} from '../src/app-env.js';
import { isProductionEnv as reexported } from '../src/pg/bootstrap-admin.js';
import { assertRestoreAllowed } from '../src/pg/export.js';
import { emailConfig, isProduction, recipientRefusal } from '../src/email/brevo.js';
import { SNAPSHOT_FORMAT, SNAPSHOT_TABLES, snapshotChecksum } from '../src/d1-postgres-migration.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = (name) => join(root, 'scripts', name);

test('resolveAppEnv: wielkość liter, spacje i alias prod', () => {
  for (const value of ['production', 'PRODUCTION', 'Production', ' prod ', 'PROD']) {
    assert.deepEqual([resolveAppEnv(value).name, resolveAppEnv(value).production, resolveAppEnv(value).known], ['production', true, true], value);
    assert.equal(isProductionEnv(value), true, value);
  }
  for (const value of KNOWN_APP_ENVS) assert.equal(resolveAppEnv(value.toUpperCase()).known, true, value);
  for (const value of [undefined, null, '', '   ']) assert.equal(resolveAppEnv(value).unset, true);
  const typo = resolveAppEnv('Prodution');
  assert.deepEqual([typo.known, typo.production, typo.name], [false, false, 'prodution']);
});

test('isProductionLikeEnv: brak i nieznana wartość są zachowawczo jak produkcja', () => {
  for (const value of [undefined, '', 'prodution', 'load-test', 'production', 'Prod']) assert.equal(isProductionLikeEnv(value), true, String(value));
  for (const value of ['development', 'test', 'staging', ' Staging ']) assert.equal(isProductionLikeEnv(value), false, value);
  // Ścisła produkcja nie obejmuje braku/nieznanej wartości.
  assert.equal(isProductionEnv(undefined), false);
  assert.equal(isProductionEnv('prodution'), false);
});

test('appEnvWarning: ostrzeżenie tylko dla braku/nieznanej wartości, bez sekretów', () => {
  assert.equal(appEnvWarning('staging'), null);
  assert.equal(appEnvWarning('PROD'), null);
  assert.match(appEnvWarning(undefined), /brak/);
  assert.match(appEnvWarning('prodution'), /nieznana wartość "prodution"/);
  assert.ok(appEnvWarning('x'.repeat(500)).length < 400);
});

test('guardDangerousOperation: odmowa bez flagi, zgoda z flagą, staging bez blokady', () => {
  for (const value of [undefined, 'prod', 'Production', 'foo']) {
    assert.equal(guardDangerousOperation(value).refused, true, String(value));
    assert.equal(guardDangerousOperation(value, { allowProduction: true }).refused, false, String(value));
  }
  assert.equal(guardDangerousOperation('staging').refused, false);
  assert.equal(guardDangerousOperation('development').refused, false);
});

test('bootstrap-admin i export używają wspólnej funkcji', () => {
  assert.equal(reexported, isProductionEnv);
  for (const appEnv of [undefined, '', 'prod', 'Production', 'foo']) {
    assert.throws(() => assertRestoreAllowed({ appEnv }), { code: 'production_restore_requires_allow_production' }, String(appEnv));
    assert.doesNotThrow(() => assertRestoreAllowed({ appEnv, allowProduction: true }));
  }
  for (const appEnv of ['staging', 'development', 'test']) assert.doesNotThrow(() => assertRestoreAllowed({ appEnv }));
});

test('e-mail: allowlista wyłączona tylko przy rozpoznanej produkcji; brak/nieznane zostaje z allowlistą', () => {
  const address = 'ktos@example.test';
  for (const appEnv of ['production', 'Production', ' PROD ']) {
    const config = emailConfig({ APP_ENV: appEnv, EMAIL_TEST_ALLOWLIST: 'ops@example.test' });
    assert.equal(config.appEnv, 'production', appEnv);
    assert.equal(isProduction(config), true);
    assert.equal(recipientRefusal(config, address), null, appEnv);
  }
  for (const appEnv of [undefined, '', 'prodution', 'staging']) {
    const config = emailConfig({ APP_ENV: appEnv, EMAIL_TEST_ALLOWLIST: 'ops@example.test' });
    assert.equal(isProduction(config), false, String(appEnv));
    assert.equal(recipientRefusal(config, address), 'recipient_not_allowlisted', String(appEnv));
  }
  assert.equal(emailConfig({}).appEnv, 'development');
});

test('żaden plik w src/ ani scripts/ nie porównuje APP_ENV do literału production poza src/app-env.js', async () => {
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith('.js') || full.endsWith('src/app-env.js')) continue;
      const lines = (await readFile(full, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (/^\s*\/\//.test(line)) return;
        if (/(APP_ENV|appEnv)\s*[!=]==?\s*['"](production|prod)['"]/.test(line)) offenders.push(`${full}:${index + 1}`);
      });
    }
  }
  await walk(join(root, 'src'));
  await walk(join(root, 'scripts'));
  assert.deepEqual(offenders, []);
});

// --- skrypty operatorskie: odmowa dla production/prod/Production/brak/nieznane ---

const REFUSING_ENVS = [undefined, '', 'prod', 'Production', 'PRODUCTION', ' production ', 'prodution'];
const UNREACHABLE_DB = 'postgres://rd:rd@127.0.0.1:1/rd_test';

function run(name, args, appEnv, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', DATABASE_URL: UNREACHABLE_DB, ...extra };
  if (appEnv !== undefined) env.APP_ENV = appEnv;
  return spawnSync(process.execPath, [script(name), ...args], { env, encoding: 'utf8', timeout: 60_000 });
}

test('migrate-postgres: odmowa bez --allow-production przy production/prod/brak/nieznane; staging i flaga przechodzą bramkę', () => {
  for (const appEnv of REFUSING_ENVS) {
    const refused = run('migrate-postgres.js', [], appEnv);
    assert.equal(refused.status, 1, String(appEnv));
    assert.match(refused.stderr, /requires explicit --allow-production\. No migration was run/, String(appEnv));
  }
  assert.match(run('migrate-postgres.js', [], undefined).stderr, /APP_ENV: brak/);
  assert.match(run('migrate-postgres.js', [], 'prodution').stderr, /nieznana wartość/);
  for (const [args, appEnv] of [[[], 'staging'], [[], 'Staging'], [['--allow-production'], 'Production'], [['--allow-production'], undefined]]) {
    const passed = run('migrate-postgres.js', args, appEnv);
    assert.doesNotMatch(passed.stderr, /requires explicit --allow-production/, String(appEnv));
    assert.match(passed.stderr, /Migration failed/, String(appEnv)); // bramka przepuszcza, dalej nieosiągalna baza
  }
});

test('restore-postgres-snapshot --apply: ta sama bramka', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rd-appenv-'));
  try {
    const tables = Object.fromEntries(SNAPSHOT_TABLES.map((name) => [name, []]));
    const file = join(directory, 'snapshot.json');
    await writeFile(file, JSON.stringify({ format: SNAPSHOT_FORMAT, tables, checksum: snapshotChecksum(tables) }), { mode: 0o600 });
    for (const appEnv of REFUSING_ENVS) {
      const refused = run('restore-postgres-snapshot.js', [file, '--apply'], appEnv);
      assert.equal(refused.status, 1, String(appEnv));
      assert.match(refused.stderr, /requires explicit --allow-production/, String(appEnv));
    }
    const passed = run('restore-postgres-snapshot.js', [file, '--apply', '--allow-production'], 'Production');
    assert.doesNotMatch(passed.stderr, /requires explicit --allow-production/);
    const staging = run('restore-postgres-snapshot.js', [file, '--apply'], 'staging');
    assert.doesNotMatch(staging.stderr, /requires explicit --allow-production/);
    // Bez --apply (próba na sucho) nie dotyka bazy i nie wymaga flagi.
    const dry = run('restore-postgres-snapshot.js', [file], undefined);
    assert.equal(dry.status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup-storage: odmowa przed jakimkolwiek kopiowaniem', () => {
  for (const appEnv of REFUSING_ENVS) {
    const refused = run('backup-storage.js', [], appEnv);
    assert.equal(refused.status, 1, String(appEnv));
    assert.match(refused.stderr, /requires explicit --allow-production\. Nothing was copied/, String(appEnv));
  }
  for (const [args, appEnv] of [[[], 'staging'], [['--allow-production'], 'PROD']]) {
    const passed = run('backup-storage.js', args, appEnv);
    assert.doesNotMatch(passed.stderr, /requires explicit --allow-production/, String(appEnv));
  }
});

test('restore-drill: odmowa po sprawdzeniu zmiennych, przed użyciem bazy i bucketu', () => {
  const drillEnv = {
    RESTORE_DRILL_TARGET_DATABASE_URL: UNREACHABLE_DB, BACKUP_DECRYPTION_PRIVATE_KEY: 'x',
    BACKUP_S3_ENDPOINT: 'http://127.0.0.1:1', BACKUP_S3_REGION: 'test', BACKUP_S3_BUCKET: 'test',
    BACKUP_S3_ACCESS_KEY_ID: 'x', BACKUP_S3_SECRET_ACCESS_KEY: 'x',
  };
  for (const appEnv of REFUSING_ENVS) {
    const refused = run('restore-drill.js', [], appEnv, drillEnv);
    assert.equal(refused.status, 1, String(appEnv));
    assert.match(refused.stderr, /requires explicit --allow-production/, String(appEnv));
  }
  const staging = run('restore-drill.js', [], 'staging', drillEnv);
  assert.doesNotMatch(staging.stderr, /requires explicit --allow-production/);
});

test('storage-smoke: odmowa dla production/prod/brak/nieznane (tylko staging)', () => {
  for (const appEnv of REFUSING_ENVS) {
    const refused = run('storage-smoke.js', [], appEnv);
    assert.equal(refused.status, 1, String(appEnv));
    assert.match(refused.stderr, /for staging only/, String(appEnv));
  }
  assert.doesNotMatch(run('storage-smoke.js', [], 'staging').stderr, /for staging only/);
});
