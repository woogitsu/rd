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
