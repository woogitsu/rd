// Test seeda demo (scripts/demo-seed.js) — WYŁĄCZNIE dane syntetyczne, PGlite w pamięci.
// Sprawdza: liczności podstawowych obiektów, brak adresów spoza @example.invalid,
// brak słowa „dłużnik” gdziekolwiek w wygenerowanych danych i odmowę seeda dla
// ustawień produkcyjnych/zdalnej bazy/obecności klucza Brevo.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeEnvironment, DemoSeedRefused, runDemoSeed,
} from '../scripts/demo-seed.js';

test('demo-seed: odmawia działania gdy NODE_ENV=production', () => {
  assert.throws(
    () => assertSafeEnvironment({ NODE_ENV: 'production' }),
    (error) => error instanceof DemoSeedRefused && error.code === 'production_env',
  );
});

test('demo-seed: odmawia działania gdy APP_ENV=production (isProductionEnv)', () => {
  assert.throws(
    () => assertSafeEnvironment({ APP_ENV: 'production' }),
    (error) => error instanceof DemoSeedRefused && error.code === 'production_env',
  );
});

test('demo-seed: odmawia działania gdy BREVO_API_KEY jest ustawiony', () => {
  assert.throws(
    () => assertSafeEnvironment({ BREVO_API_KEY: 'xkeysib-fake' }),
    (error) => error instanceof DemoSeedRefused && error.code === 'brevo_key_present',
  );
});

test('demo-seed: odmawia działania gdy DATABASE_URL wskazuje poza localhost/PGlite', () => {
  assert.throws(
    () => assertSafeEnvironment({ DATABASE_URL: 'postgres://user:pass@db.production.example.com:5432/rd' }),
    (error) => error instanceof DemoSeedRefused && error.code === 'remote_database_url',
  );
});

test('demo-seed: akceptuje DATABASE_URL na localhost i pusty DATABASE_URL (PGlite)', () => {
  assert.doesNotThrow(() => assertSafeEnvironment({ DATABASE_URL: 'postgres://user:pass@localhost:5432/rd_demo' }));
  assert.doesNotThrow(() => assertSafeEnvironment({ DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/rd_demo' }));
  assert.doesNotThrow(() => assertSafeEnvironment({}));
});

// Jeden przebieg seeda dla wszystkich testów liczności — PGlite w pamięci to
// pełna migracja + ok. 20 rodzin + role + wpłaty + księga + wydarzenia +
// zebranie + kampania + aktualności; uruchomienie dla każdego test() osobno
// byłoby zbyt kosztowne (patrz BRIEF.md: ~550 MB na instancję PGlite).
let seeded;
test('demo-seed: przebiega bez błędu na PGlite w pamięci', async () => {
  seeded = await runDemoSeed({ inMemory: true, log: () => {} });
  assert.equal(seeded.mode, 'pglite');
});

test('demo-seed: konta demo — jedna z każdej wymaganej roli', () => {
  const roles = seeded.accounts.map((account) => account.role).sort();
  assert.deepEqual(roles, ['admin', 'audit', 'board', 'board', 'representative', 'treasurer']);
  for (const account of seeded.accounts) {
    assert.ok(account.userId, `konto ${account.role} ma userId`);
    assert.ok(account.cookie, `konto ${account.role} ma sesję`);
    assert.match(account.email, /@example\.invalid$/);
    assert.ok(account.password.length >= 12, 'hasło spełnia minimalną długość polityki (12 znaków)');
  }
  // Role z domyślnego MFA_REQUIRED_ROLES (admin/board/treasurer) mają założony i potwierdzony czynnik.
  const withMfa = seeded.accounts.filter((a) => ['admin', 'board', 'treasurer'].includes(a.role));
  for (const account of withMfa) assert.ok(account.mfaSecret, `${account.role} ma czynnik MFA`);
  const withoutMfa = seeded.accounts.filter((a) => ['representative', 'audit'].includes(a.role));
  for (const account of withoutMfa) assert.equal(account.mfaSecret, null, `${account.role} nie ma wymuszonego MFA`);
});

test('demo-seed: roster — kilka klas i ok. 20 rodzin z rodzeństwem i dwojgiem opiekunów', () => {
  const { roster } = seeded;
  assert.ok(roster.classes.length >= 3 && roster.classes.length <= 10, 'kilka klas');
  assert.equal(roster.households.length, 20);
  assert.ok(roster.students.length > roster.households.length, 'przynajmniej jedna rodzina ma rodzeństwo (więcej uczniów niż rodzin)');
  const guardianCounts = new Map();
  for (const [, householdId] of roster.guardians) {
    guardianCounts.set(householdId, (guardianCounts.get(householdId) ?? 0) + 1);
  }
  assert.ok([...guardianCounts.values()].some((count) => count >= 2), 'przynajmniej jedna rodzina ma dwoje opiekunów');
  assert.ok([...guardianCounts.values()].some((count) => count === 1), 'przynajmniej jedna rodzina ma jednego opiekuna (wariant do przetestowania)');
});

test('demo-seed: wszystkie adresy e-mail rodzin i kont są w domenie @example.invalid', () => {
  const { roster } = seeded;
  for (const [, , , , email] of roster.guardians) assert.match(email, /@example\.invalid$/);
  for (const account of seeded.accounts) assert.match(account.email, /@example\.invalid$/);
});

test('demo-seed: nigdzie nie występuje słowo „dłużnik” (AGENTS.md: brak automatycznego statusu)', () => {
  const haystack = JSON.stringify(seeded).toLowerCase();
  assert.ok(!haystack.includes('dłużnik'), 'seed nie wprowadza etykiety „dłużnik”');
});

test('demo-seed: wpłaty, wpisy księgi, wydarzenia i zebranie mają nieliczne, ale niezerowe liczności', () => {
  assert.ok(seeded.counts.payments > 0);
  assert.ok(seeded.counts.ledger > 0);
  assert.ok(seeded.counts.events >= 2);
  assert.ok(seeded.meeting.meetingId);
  assert.ok(seeded.meeting.minutesId);
  assert.ok(seeded.campaignId);
  assert.ok(seeded.newsId);
});

test('demo-seed: nazwiska rodzin/uczniów są jawnie syntetyczne', () => {
  const { roster } = seeded;
  for (const [, , , lastName] of roster.students) assert.match(lastName, /^Przykładowy /);
  for (const [, , , lastName] of roster.guardians) assert.match(lastName, /^Przykładowy /);
});
