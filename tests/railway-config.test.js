import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile(new URL('../railway.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('railway.json builds the panels and starts the Node server', () => {
  assert.equal(config.build.buildCommand, 'npm ci && npm run build');
  // Node uruchamiany bezpośrednio (nie przez npm), aby SIGTERM trafił do procesu serwera.
  assert.equal(config.deploy.startCommand, 'node src/server.js');
  assert.equal(pkg.scripts.start, config.deploy.startCommand);
  assert.equal(config.deploy.healthcheckPath, '/health');
  assert.ok(config.deploy.drainingSeconds * 1000 > 10_000, 'draining time exceeds the default shutdown timeout');
  assert.equal(config.deploy.restartPolicyType, 'ON_FAILURE');
  assert.ok(config.deploy.restartPolicyMaxRetries >= 1);
});

test('railway.json never runs migrations or restores automatically', () => {
  const commands = [config.build.buildCommand, config.deploy.startCommand, config.deploy.preDeployCommand, pkg.scripts.start, pkg.scripts.build]
    .flat().filter(Boolean).join(' ');
  assert.doesNotMatch(commands, /migrat|restore|db:|wrangler|deploy/i);
  assert.equal(config.deploy.preDeployCommand, undefined);
  assert.equal(config.deploy.cronSchedule, undefined);
});

test('railway.json pins the EU region and holds no secrets', () => {
  assert.deepEqual(Object.keys(config.deploy.multiRegionConfig), ['europe-west4-drams3a']);
  const text = JSON.stringify(config);
  assert.doesNotMatch(text, /postgres(ql)?:\/\/|DATABASE_URL|BREVO|API_KEY|SECRET|PASSWORD|TOKEN/i);
  assert.equal(config.environments, undefined, 'environment overrides are managed in Railway, not in repo');
});

// Usługa cron zadania e-mail (#130): osobny plik konfiguracji, nigdy w railway.json.
const workerConfig = JSON.parse(await readFile(new URL('../railway.email-worker.json', import.meta.url), 'utf8'));

test('railway.email-worker.json: jeden przebieg co godzinę, bez restartu, domyślnie dry-run', () => {
  // Node bezpośrednio (nie przez npm), aby SIGTERM przy redeployu trafił do
  // procesu zadania i przebieg zwrócił niewysłane wiersze do kolejki (#172).
  assert.equal(workerConfig.deploy.startCommand, 'node scripts/email-worker.js');
  assert.equal(pkg.scripts['email:worker'], workerConfig.deploy.startCommand);
  // Wysyłka wymaga osobnej decyzji (D-20): zmiany tego pliku w przeglądanym PR
  // na `--send` ORAZ EMAIL_SENDING_ENABLED=true w usłudze. Sama zmienna nie wystarcza.
  assert.doesNotMatch(workerConfig.deploy.startCommand, /--send/);
  // Co godzinę, codziennie; dni i godziny liczy zadanie w strefie Brukseli
  // (EMAIL_SEND_WINDOW_*), nie cron w UTC — zmiana czasu nie przesuwa okna.
  assert.equal(workerConfig.deploy.cronSchedule, '15 * * * *');
  assert.equal(workerConfig.deploy.restartPolicyType, 'NEVER');
  // Zadanie cron kończy proces — bez healthchecku i bez serwera HTTP.
  assert.equal(workerConfig.deploy.healthcheckPath, undefined);
  assert.doesNotMatch(workerConfig.deploy.startCommand, /server\.js/);
});

test('railway.email-worker.json nie migruje, nie odtwarza, przypina region UE i nie zawiera sekretów', () => {
  const commands = [workerConfig.build.buildCommand, workerConfig.deploy.startCommand, workerConfig.deploy.preDeployCommand]
    .filter(Boolean).join(' ');
  assert.doesNotMatch(commands, /migrat|restore|db:|wrangler|deploy/i);
  assert.equal(workerConfig.deploy.preDeployCommand, undefined);
  assert.deepEqual(Object.keys(workerConfig.deploy.multiRegionConfig), ['europe-west4-drams3a']);
  assert.equal(workerConfig.deploy.multiRegionConfig['europe-west4-drams3a'].numReplicas, 1);
  const text = JSON.stringify(workerConfig);
  assert.doesNotMatch(text, /postgres(ql)?:\/\/|DATABASE_URL|BREVO|API_KEY|SECRET|PASSWORD|TOKEN|EMAIL_SENDING_ENABLED/i);
  assert.equal(workerConfig.environments, undefined, 'environment overrides are managed in Railway, not in repo');
});

// Usługi cron kopii i próby odtworzenia (#90): osobne pliki, nigdy w railway.json.
const cronConfigs = [
  { file: '../railway.backup.json', start: 'node scripts/backup-postgres.js', script: 'backup:postgres', cron: '17 2 * * *' },
  { file: '../railway.restore-drill.json', start: 'node scripts/restore-drill.js', script: 'restore:drill', cron: '43 4 * * 1' },
];
for (const { file, start, script, cron } of cronConfigs) {
  const cfg = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
  test(`${file.slice(3)}: jeden przebieg crona, bez restartu, bez sekretów, region UE`, () => {
    // Node bezpośrednio, aby SIGTERM przy redeployu trafił do procesu zadania.
    assert.equal(cfg.deploy.startCommand, start);
    assert.equal(pkg.scripts[script], start);
    assert.equal(cfg.deploy.cronSchedule, cron);
    assert.equal(cfg.deploy.restartPolicyType, 'NEVER');
    assert.equal(cfg.deploy.healthcheckPath, undefined);
    assert.equal(cfg.deploy.preDeployCommand, undefined);
    // Próba na produkcji wymaga jawnej flagi w osobnej decyzji, nie w pliku repozytorium.
    assert.doesNotMatch(cfg.deploy.startCommand, /--allow-production|--force|--send/);
    assert.doesNotMatch([cfg.build.buildCommand, cfg.deploy.startCommand].join(' '), /migrat|db:|wrangler|deploy/i);
    assert.deepEqual(Object.keys(cfg.deploy.multiRegionConfig), ['europe-west4-drams3a']);
    assert.equal(cfg.deploy.multiRegionConfig['europe-west4-drams3a'].numReplicas, 1);
    assert.doesNotMatch(JSON.stringify(cfg), /postgres(ql)?:\/\/|DATABASE_URL|BREVO|API_KEY|SECRET|PASSWORD|TOKEN|BACKUP_|RESTORE_DRILL_/i);
    assert.equal(cfg.environments, undefined, 'environment overrides are managed in Railway, not in repo');
  });
}
