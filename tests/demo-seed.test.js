// Test seeda demo (scripts/demo-seed.js) — WYŁĄCZNIE dane syntetyczne, PGlite w pamięci.
// Sprawdza: liczności podstawowych obiektów, brak adresów spoza @example.invalid,
// brak słowa „dłużnik” gdziekolwiek w wygenerowanych danych i odmowę seeda dla
// ustawień produkcyjnych/zdalnej bazy/obecności klucza Brevo.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCall, assertSafeEnvironment, DemoSeedRefused, runDemoSeed, SCHOOL_YEAR_ID,
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
  // keepOpen: true — kolejny test odpytuje tę samą bazę przez publiczny
  // endpoint; zamykamy ją w test.after poniżej.
  seeded = await runDemoSeed({ inMemory: true, log: () => {}, keepOpen: true });
  assert.equal(seeded.mode, 'pglite');
});

test.after(async () => {
  await seeded?.env?.db?.close();
});

// Regresja: /site/ pokazywało „Brak opublikowanych protokołów”, mimo że seed
// zatwierdzał protokół i ustawiał widoczność „public” — przyczyną było
// niedopasowanie formatu identyfikatora roku (seed używał „y2026”, a
// site/core.js#defaultSchoolYearId zgaduje z dzisiejszej daty identyfikator w
// postaci „<rok>-<rok+1>”, więc publiczne zapytanie pytało o inny rok niż ten,
// do którego trafiły dane). Ten test woła DOKŁADNIE tę samą trasę, którą woła
// przeglądarka na /site/ (GET /api/meetings/public-minutes, bez sesji).
test('demo-seed: publiczny endpoint /api/meetings/public-minutes zwraca zatwierdzony protokół', async () => {
  const response = await apiCall(seeded.env, {
    method: 'GET', path: `/api/meetings/public-minutes?schoolYearId=${encodeURIComponent(SCHOOL_YEAR_ID)}`,
  });
  assert.ok(Array.isArray(response.data.minutes), 'odpowiedź zawiera listę protokołów');
  assert.ok(response.data.minutes.length >= 1, '/site/ ma pokazać co najmniej jeden zatwierdzony, publiczny protokół');
  const published = response.data.minutes.find((entry) => entry.minutesId === seeded.meeting.minutesId);
  assert.ok(published, 'protokół z zebrania zasiedzonego przez seed jest wśród publicznie widocznych');
});

test('demo-seed: SCHOOL_YEAR_ID jest w formacie zgodnym z site/core.js#defaultSchoolYearId', () => {
  // ID_PATTERN w site/core.js akceptuje szerszy zakres znaków, ale
  // defaultSchoolYearId ZAWSZE generuje postać „<rok>-<rok+1>” — dopasowanie
  // gwarantuje, że domyślne (bez „?rok=”) wejście na /site/ pokaże ten rok.
  assert.match(SCHOOL_YEAR_ID, /^\d{4}-\d{4}$/);
  const [start, end] = SCHOOL_YEAR_ID.split('-').map(Number);
  assert.equal(end, start + 1);
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
  // `env` (keepOpen: true) trzyma uchwyt PGlite ze strukturą cykliczną — poza
  // zakresem tej asercji (baza nie jest tekstem), więc pomijamy je przy stringify.
  const { env: _env, ...serializable } = seeded;
  const haystack = JSON.stringify(serializable).toLowerCase();
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

test('demo-seed: uzgodnienie wyciągu — szkic z zaimportowanym wyciągiem, NIE zatwierdzony', async () => {
  const { reconciliation } = seeded;
  assert.ok(reconciliation.reconciliationId, 'seed zwraca id utworzonego uzgodnienia');
  assert.ok(reconciliation.lineCount >= 2, 'wyciąg ma co najmniej kilka zaimportowanych pozycji');

  // Ta sama trasa co GET szczegółów w panelu /reconciliation/ (treasurer.cookie —
  // WRITE_ROLES — ma dostęp do odczytu własnego uzgodnienia).
  const treasurer = seeded.accounts.find((a) => a.role === 'treasurer');
  const detail = await apiCall(seeded.env, {
    method: 'GET', path: `/api/reconciliations/${reconciliation.reconciliationId}`, cookie: treasurer.cookie,
  });
  assert.equal(detail.data.reconciliation.status, 'draft', 'seed NIE zatwierdza uzgodnienia (POST .../confirm nie jest wołane)');
  assert.equal(detail.data.reconciliation.schoolYearId, SCHOOL_YEAR_ID);
  assert.equal(detail.data.lines.length, reconciliation.lineCount);

  // Przynajmniej jedna pozycja celowo nie odpowiada żadnej wpłacie/wpisowi księgi —
  // import samych linii wyciągu nie tworzy dopasowań (to osobna akcja w panelu),
  // więc wszystkie linie mają match: null; sprawdzamy więc same kwoty/liczności
  // zamiast stanu dopasowania.
  const amounts = detail.data.lines.map((line) => line.amountCents);
  assert.ok(amounts.includes(1550) || amounts.includes(-375), 'przynajmniej jedna pozycja ma kwotę celowo niepasującą do wpłat/księgi');

  const notes = String(detail.data.reconciliation.notes ?? '');
  assert.match(notes, /BE62.?5100.?0754.?7061/, 'notatka wskazuje testowy IBAN (dane syntetyczne, nie prawdziwy rachunek)');
});

test('demo-seed: nazwiska rodzin/uczniów są jawnie syntetyczne', () => {
  const { roster } = seeded;
  for (const [, , , lastName] of roster.students) assert.match(lastName, /^Przykładowy /);
  for (const [, , , lastName] of roster.guardians) assert.match(lastName, /^Przykładowy /);
});
