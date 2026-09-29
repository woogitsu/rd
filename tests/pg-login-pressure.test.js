// Agregat „konto pod presją” (#126): wiele błędnych prób na jedno konto z wielu
// adresów IP → sygnał dla administratora (ops-status + zdarzenie audytu), bez
// blokady prawowitego właściciela i bez e-maili/IP w odpowiedzi i audycie.
// Bez zegara ściennego: liczniki + wstrzyknięty `now`. Dane syntetyczne.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handlePgRequest } from '../src/pg/app.js';
import { hashPassword } from '../src/pg/password.js';
import {
  accountsUnderPressure, estimatedMinSources, LOGIN_POLICY, LOGIN_PRESSURE_DEFAULT_THRESHOLD, loginPressureThreshold,
} from '../src/pg/login.js';
import { computeOpsStatus } from '../src/pg/ops-status.js';
import { createTestDb, request, seedUser, seedUserSession } from './helpers/pg.js';

const FAST = { SCRYPT_COST_LOG2: '15' };
let db;
let env;
before(async () => {
  db = await createTestDb();
  env = { db, LOGIN_EMAIL_DELAY_MS: '0', LOGIN_PRESSURE_THRESHOLD: '6', ...FAST };
});
after(async () => { await db?.close(); });

let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq}`;

async function seedAccount(userId) {
  const password = `Syntetyczne haslo ${randomBytes(6).toString('hex')}`;
  await seedUser(db, { userId });
  await db.query("INSERT INTO user_passwords (user_id, hash, set_reason) VALUES ($1, $2, 'invitation')", [userId, await hashPassword(password, { env: FAST })]);
  return { userId, email: `${userId}@example.invalid`, password };
}
const login = (account, ip, password = account.password) => handlePgRequest(request('/api/login', {
  method: 'POST', body: { email: account.email, password }, headers: { 'x-rd-client-ip': ip },
}), env);
const pressureEvents = async (userId) => (await db.query(
  "SELECT metadata_json AS metadata FROM audit_events WHERE action = 'auth.account_under_pressure' AND entity_id = $1", [userId],
)).rows;

test('próg: wartość domyślna, poprawna konfiguracja i bezpieczny powrót do domyślnej przy błędnej', () => {
  assert.equal(loginPressureThreshold({}), LOGIN_PRESSURE_DEFAULT_THRESHOLD);
  assert.equal(loginPressureThreshold({ LOGIN_PRESSURE_THRESHOLD: '40' }), 40);
  for (const bad of ['abc', '0', '5', '-3', '1001', '7.5', 'Infinity']) {
    assert.equal(loginPressureThreshold({ LOGIN_PRESSURE_THRESHOLD: bad }), LOGIN_PRESSURE_DEFAULT_THRESHOLD, bad);
  }
  assert.ok(LOGIN_PRESSURE_DEFAULT_THRESHOLD > LOGIN_POLICY.pairMaxFailures);
  assert.equal(estimatedMinSources(5), 1);
  assert.equal(estimatedMinSources(6), 2);
  assert.equal(estimatedMinSources(15), 3);
});

test('wiele adresów IP na jedno konto: dokładnie jedno zdarzenie audytu przy przekroczeniu, bez PII', async () => {
  const account = await seedAccount('u-pressure-a');
  const ipA = nextIp();
  const ipB = nextIp();
  for (let i = 0; i < 5; i += 1) await login(account, ipA, `zle haslo ${i}`);
  assert.equal((await pressureEvents(account.userId)).length, 0, 'poniżej progu brak zdarzenia');
  await login(account, ipB, 'zle haslo b1');
  const events = await pressureEvents(account.userId);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].metadata, { threshold: 6, windowSeconds: LOGIN_POLICY.windowSeconds, estimatedMinSources: 2 });
  // Kolejne błędy ponad próg nie mnożą zdarzeń.
  for (let i = 0; i < 3; i += 1) await login(account, ipB, `zle haslo b${i + 2}`);
  assert.equal((await pressureEvents(account.userId)).length, 1);
  const raw = JSON.stringify((await db.query("SELECT * FROM audit_events WHERE action = 'auth.account_under_pressure'")).rows);
  assert.doesNotMatch(raw, /@|example\.invalid|198\.51\.100/);
});

test('presja nie blokuje właściciela: poprawne hasło z nowego IP przechodzi (sesja), blokada tylko pary', async () => {
  const account = await seedAccount('u-pressure-owner');
  for (let i = 0; i < 5; i += 1) await login(account, nextIp(), `zle haslo ${i}`);
  await login(account, nextIp(), 'zle haslo 5');
  assert.equal((await pressureEvents(account.userId)).length, 1);
  const ok = await login(account, nextIp());
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get('Set-Cookie'));
});

test('nieistniejące konto i konto poniżej progu nie generują zdarzenia', async () => {
  const account = await seedAccount('u-pressure-low');
  for (let i = 0; i < 3; i += 1) await login(account, nextIp(), `zle haslo ${i}`);
  const ghost = { email: 'nieistniejace-presja@example.invalid', password: 'x'.repeat(12) };
  for (let i = 0; i < 8; i += 1) {
    await handlePgRequest(request('/api/login', { method: 'POST', body: ghost, headers: { 'x-rd-client-ip': nextIp() } }), env);
  }
  assert.equal((await pressureEvents(account.userId)).length, 0);
});

test('ops-status: konto pod presją widoczne dla admina jako identyfikator i liczby, bez e-maili i IP; okno wg wstrzykniętego zegara', async () => {
  const account = await seedAccount('u-pressure-ops');
  for (let i = 0; i < 7; i += 1) await login(account, nextIp(), `zle haslo ${i}`);
  const admin = await seedUserSession(db, { userId: 'u-pressure-admin', roles: [{ role: 'admin' }], mfa: true });
  const response = await handlePgRequest(request('/api/admin/ops-status', { cookie: admin }), env);
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  const entry = body.loginPressure.accounts.find((item) => item.accountId === account.userId);
  assert.ok(entry, 'konto na liście');
  assert.equal(entry.failures, 7);
  assert.equal(entry.estimatedMinSources, 2);
  assert.equal(body.loginPressure.thresholdFailures, 6);
  assert.equal(body.loginPressure.windowSeconds, LOGIN_POLICY.windowSeconds);
  assert.doesNotMatch(text, /@|example\.invalid|198\.51\.100/);

  // Zegar wstrzyknięty: po upływie okna (od początku okna) konto znika z agregatu.
  const started = new Date(entry.windowStartedAt).getTime();
  const inside = await computeOpsStatus({ db, env, now: () => new Date(started + 60_000) });
  assert.ok(inside.loginPressure.accounts.some((item) => item.accountId === account.userId));
  const after = await computeOpsStatus({ db, env, now: () => new Date(started + (LOGIN_POLICY.windowSeconds + 1) * 1000) });
  assert.ok(!after.loginPressure.accounts.some((item) => item.accountId === account.userId));
  // Wyższy próg z konfiguracji: ten sam licznik nie jest już presją.
  const strict = await accountsUnderPressure(db, { env: { LOGIN_PRESSURE_THRESHOLD: '100' }, now: () => new Date(started + 60_000) });
  assert.equal(strict.accounts.length, 0);
});

test('ops-status: skrót e-maila bez konta liczy się tylko w unmatchedTargets', async () => {
  const { scopeHash } = await import('../src/pg/login.js');
  await db.query('DELETE FROM login_rate_limits');
  const hash = scopeHash('email', 'nieznany-cel@example.invalid');
  await db.query(
    "INSERT INTO login_rate_limits (scope_type, scope_hash, failure_count, window_started_at, updated_at) VALUES ('email', $1, 30, '2026-01-01T10:00:00Z', '2026-01-01T10:05:00Z')",
    [hash],
  );
  const result = await accountsUnderPressure(db, { env, now: () => new Date('2026-01-01T10:10:00Z') });
  assert.equal(result.unmatchedTargets, 1);
  assert.ok(!JSON.stringify(result).includes(hash));
});
