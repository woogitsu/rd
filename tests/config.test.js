import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConfigError, configProblems, validateConfig } from '../src/config.js';

// Wyłącznie dane syntetyczne; klucze i sekrety są losowymi ciągami testowymi.
const KEY = Buffer.alloc(32, 7).toString('base64');
const WEBHOOK = 'w'.repeat(40);
const valid = () => ({
  APP_ENV: 'production',
  PUBLIC_BASE_URL: 'https://rd.example.invalid',
  MFA_ENCRYPTION_KEY: KEY,
  TRUST_PROXY: '1',
  BREVO_WEBHOOK_SECRET: WEBHOOK,
});
const names = (env) => configProblems(env).map((p) => p.variable);

test('lokalne środowiska (brak APP_ENV, development, test) nie wymagają niczego', () => {
  for (const APP_ENV of [undefined, '', 'development', 'test', ' Development ']) {
    assert.doesNotThrow(() => validateConfig({ APP_ENV }), String(APP_ENV));
  }
});

test('poprawna konfiguracja staging/production przechodzi (także pierścień kluczy MFA)', () => {
  for (const APP_ENV of ['staging', 'production', 'prod', 'PRODUCTION']) {
    assert.doesNotThrow(() => validateConfig({ ...valid(), APP_ENV }), APP_ENV);
  }
  const ring = { ...valid(), MFA_ENCRYPTION_KEY: undefined, MFA_ENCRYPTION_KEYS: `2:${KEY}` };
  assert.doesNotThrow(() => validateConfig(ring));
  assert.doesNotThrow(() => validateConfig({ ...valid(), PUBLIC_BASE_URL: 'https://rd.example.invalid:8443/' }));
  assert.doesNotThrow(() => validateConfig({ ...valid(), TRUST_PROXY: 'true' }));
});

test('nieznana wartość APP_ENV jest traktowana zachowawczo (wymaga konfiguracji)', () => {
  for (const APP_ENV of ['prodution', 'live', 'stagng', 'local']) {
    assert.deepEqual(names({ APP_ENV }), ['PUBLIC_BASE_URL', 'MFA_ENCRYPTION_KEY', 'TRUST_PROXY', 'BREVO_WEBHOOK_SECRET'], APP_ENV);
    assert.deepEqual(names({ ...valid(), APP_ENV }), [], APP_ENV);
  }
});

test('brak każdej wymaganej zmiennej z osobna daje błąd tylko o tej zmiennej', () => {
  for (const variable of ['PUBLIC_BASE_URL', 'MFA_ENCRYPTION_KEY', 'TRUST_PROXY', 'BREVO_WEBHOOK_SECRET']) {
    const env = valid();
    delete env[variable];
    assert.deepEqual(names(env), [variable], variable);
    assert.throws(() => validateConfig(env), (error) => error instanceof ConfigError && error.code === 'config_invalid'
      && error.variables.length === 1 && error.variables[0] === variable);
  }
});

test('niepoprawne wartości: PUBLIC_BASE_URL, klucz MFA, TRUST_PROXY, sekret webhooka', () => {
  for (const PUBLIC_BASE_URL of ['http://rd.example.invalid', 'https://rd.example.invalid/panel', 'https://', 'rd.example.invalid',
    'https://rd.example.invalid?x=1', 'https://user@rd.example.invalid', ' https://rd.example.invalid', '//rd.example.invalid']) {
    assert.deepEqual(names({ ...valid(), PUBLIC_BASE_URL }), ['PUBLIC_BASE_URL'], PUBLIC_BASE_URL);
  }
  for (const MFA_ENCRYPTION_KEY of ['', 'krotki', Buffer.alloc(31, 1).toString('base64'), Buffer.alloc(33, 1).toString('base64')]) {
    assert.deepEqual(names({ ...valid(), MFA_ENCRYPTION_KEY }), ['MFA_ENCRYPTION_KEY'], MFA_ENCRYPTION_KEY);
  }
  for (const TRUST_PROXY of ['0', 'false', '', 'yes']) {
    assert.deepEqual(names({ ...valid(), TRUST_PROXY }), ['TRUST_PROXY'], TRUST_PROXY);
  }
  assert.deepEqual(names({ ...valid(), BREVO_WEBHOOK_SECRET: 'x'.repeat(31) }), ['BREVO_WEBHOOK_SECRET']);
  assert.deepEqual(names({ ...valid(), BREVO_WEBHOOK_SECRET: 'x'.repeat(32) }), []);
});

test('walidacja nie sięga do process.env dla kluczy MFA i nie ujawnia wartości w błędzie', () => {
  const previous = process.env.MFA_ENCRYPTION_KEYS;
  process.env.MFA_ENCRYPTION_KEYS = `1:${KEY}`;
  try {
    assert.deepEqual(names({ ...valid(), MFA_ENCRYPTION_KEY: undefined }), ['MFA_ENCRYPTION_KEY']);
  } finally {
    if (previous === undefined) delete process.env.MFA_ENCRYPTION_KEYS; else process.env.MFA_ENCRYPTION_KEYS = previous;
  }
  const secretish = 'TajnyKlucz-nie-do-logu-0123456789';
  try {
    validateConfig({ ...valid(), MFA_ENCRYPTION_KEY: secretish, BREVO_WEBHOOK_SECRET: 'krotki-sekret', PUBLIC_BASE_URL: 'http://ukryty.invalid/x' });
    assert.fail('powinno rzucić');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    const text = `${error.message} ${JSON.stringify(error.problems)}`;
    for (const value of [secretish, 'krotki-sekret', 'ukryty.invalid']) assert.ok(!text.includes(value), value);
    assert.match(error.message, /MFA_ENCRYPTION_KEY/);
  }
});

test('serwer w produkcji bez konfiguracji nie startuje: kod ≠ 0, log tylko z nazwami zmiennych', () => {
  const secretish = 'krotki-sekret-nie-do-logu';
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
    env: { PATH: process.env.PATH, APP_ENV: 'production', PORT: '0', BREVO_WEBHOOK_SECRET: secretish },
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.status, 1, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /config_invalid/);
  for (const variable of ['PUBLIC_BASE_URL', 'MFA_ENCRYPTION_KEY', 'TRUST_PROXY', 'BREVO_WEBHOOK_SECRET']) assert.match(output, new RegExp(variable));
  assert.ok(!output.includes(secretish));
  assert.doesNotMatch(output, /server_started/);
});
