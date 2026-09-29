// Test seeda demo (scripts/demo-seed.js) — WYŁĄCZNIE dane syntetyczne, PGlite w pamięci.
// Sprawdza: liczności podstawowych obiektów, brak adresów spoza @example.invalid,
// brak słowa „dłużnik” gdziekolwiek w wygenerowanych danych i odmowę seeda dla
// ustawień produkcyjnych/zdalnej bazy/obecności klucza Brevo.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCall, assertSafeEnvironment, DEMO_STATEMENT_DIFFERENCE_CENTS, DemoSeedRefused, runDemoSeed, SCHOOL_YEAR_ID,
} from '../scripts/demo-seed.js';
import { base32Decode, totp } from '../src/pg/mfa.js';

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
  // Wszystkie konta demo mają założony i potwierdzony czynnik TOTP: admin/board/treasurer
  // wymusza MFA_REQUIRED_ROLES, a przedstawiciel klasy i Komisja Rewizyjna mają go
  // zapisanego w seedzie (decyzja użytkownika; wymóg w kodzie bez zmian).
  for (const account of seeded.accounts) assert.ok(account.mfaSecret, `${account.role} ma czynnik MFA`);
});

test('demo-seed: przedstawiciel klasy i Komisja Rewizyjna logują się hasłem + kodem TOTP', async () => {
  for (const role of ['representative', 'audit']) {
    const account = seeded.accounts.find((a) => a.role === role);
    const { rows } = await seeded.env.db.query(
      `SELECT count(*)::int AS n FROM user_mfa_factors
        WHERE user_id = $1 AND confirmed_at IS NOT NULL AND disabled_at IS NULL`,
      [account.userId],
    );
    assert.equal(rows[0].n, 1, `${role}: jeden potwierdzony czynnik`);
    // Świeża sesja po samym haśle nie wpuszcza do chronionej trasy (mfa_required),
    // dopiero kod TOTP z zapisanego sekretu ją odblokowuje.
    const login = await apiCall(seeded.env, {
      method: 'POST', path: '/api/login', body: { email: account.email, password: account.password },
    });
    await assert.rejects(
      apiCall(seeded.env, { path: `/api/reports/audit?schoolYearId=${SCHOOL_YEAR_ID}`, cookie: login.cookie }),
      /mfa_required/,
    );
    // Kod z następnego kroku czasowego — kod bieżącego kroku zużył zapis czynnika w seedzie.
    const code = totp(base32Decode(account.mfaSecret), Date.now() + 30_000);
    const verified = await apiCall(seeded.env, {
      method: 'POST', path: '/api/mfa/verify', cookie: login.cookie, body: { code },
    });
    const state = await apiCall(seeded.env, { path: '/api/session', cookie: verified.cookie ?? login.cookie });
    assert.equal(state.data.user.id, account.userId);
  }
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

// #166: demo bez ręcznego ustawiania zmiennych.
test('demoAppEnv: brak APP_ENV daje development (import bez IMPORT_ENABLED), jawna wartość zostaje', async () => {
  const { demoAppEnv } = await import('../scripts/demo-seed.js');
  const { isProductionLikeEnv } = await import('../src/app-env.js');
  assert.equal(demoAppEnv({}), 'development');
  assert.equal(demoAppEnv({ APP_ENV: '' }), 'development');
  assert.equal(isProductionLikeEnv(demoAppEnv({})), false);
  assert.equal(demoAppEnv({ APP_ENV: 'staging' }), 'staging');
});

test('demo-start: z APP_ENV=production/prod odmawia przed otwarciem bazy', async () => {
  const { startDemoServer } = await import('../scripts/demo-start.js');
  const saved = process.env.APP_ENV;
  try {
    for (const value of ['production', 'Prod']) {
      process.env.APP_ENV = value;
      await assert.rejects(startDemoServer({ port: 0 }), (error) => error instanceof DemoSeedRefused && error.code === 'production_env');
    }
  } finally {
    if (saved === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = saved;
  }
});

// Spójność liczb demo (przegląd demo 2026-09-29): raport roczny i raport Komisji
// Rewizyjnej nie mogą pokazywać przypadkowego „niezgodne”. Jedyne celowe przykłady
// do pokazu kontroli są opisane w docs/DEMO.md („Celowe przykłady”): wpłata bez
// przypisanej rodziny, pozycja wyciągu bez wpisu księgi (opłata SWIFT) i wydatki
// bez dowodu (demo nie ma magazynu plików, więc nie ma dokumentów).
async function auditReport() {
  const audit = seeded.accounts.find((a) => a.role === 'audit');
  const response = await apiCall(seeded.env, {
    path: `/api/reports/audit?schoolYearId=${encodeURIComponent(SCHOOL_YEAR_ID)}`, cookie: audit.cookie,
  });
  return response.data.report;
}

test('demo-seed: raport Komisji Rewizyjnej — żadna kontrola nie jest „niezgodna”', async () => {
  const report = await auditReport();
  for (const check of report.checks.items) {
    assert.notEqual(check.ok, false, `kontrola ${check.id} nie może być niezgodna`);
  }
  const byId = Object.fromEntries(report.checks.items.map((check) => [check.id, check]));
  assert.equal(byId.payments_in_ledger.paymentsWithoutLedgerEntry, 0, 'każda przypisana wpłata jest w księdze');
  assert.equal(byId.payments_in_ledger.differenceCents, 0);
  assert.ok(byId.payments_in_ledger.paymentsNetCents > 0);
  assert.equal(byId.year_end_balance.differenceCents, 0);
  assert.equal(report.checks.largeExpensesWithoutAdoptedResolution, 0);
});

test('demo-seed: raport roczny — bilans z wpłatami w księdze, saldo kasy i rachunku nie jest ujemne', async () => {
  const board = seeded.accounts.find((a) => a.role === 'board');
  const response = await apiCall(seeded.env, {
    path: `/api/reports/annual?schoolYearId=${encodeURIComponent(SCHOOL_YEAR_ID)}`, cookie: board.cookie,
  });
  const { balance } = response.data.report;
  assert.ok(balance.incomeCents > 0 && balance.expenseCents > 0);
  assert.ok(balance.closingCashCents >= 0, `saldo kasy ${balance.closingCashCents} nie może być ujemne`);
  assert.ok(balance.closingBankCents >= 0, 'saldo rachunku nie może być ujemne');
  assert.equal(balance.closingBalanceCents, balance.closingBankCents + balance.closingCashCents);
  assert.equal(balance.closingBalanceCents, balance.openingBalanceCents + balance.incomeCents - balance.expenseCents);
  const report = await auditReport();
  const skladki = report.categories.find((c) => c.id === 'cat-income-skladki');
  assert.equal(skladki.netCents, report.checks.items.find((c) => c.id === 'payments_in_ledger').paymentsNetCents,
    'przychód z składek = suma wpłat przypisanych do rodzin');
  assert.ok(!Object.hasOwn(balance, 'debtCents'), 'brak pojęcia zadłużenia');
});

test('demo-seed: uzgodnienie wyciągu — różnica niewielka i w całości opisana dwiema pozycjami do wyjaśnienia', async () => {
  const report = await auditReport();
  const [draft] = report.reconciliations.items;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.differenceCents, DEMO_STATEMENT_DIFFERENCE_CENTS);
  assert.ok(Math.abs(draft.differenceCents) < 5000, 'różnica poniżej 50 EUR');
  const treasurer = seeded.accounts.find((a) => a.role === 'treasurer');
  const detail = await apiCall(seeded.env, {
    path: `/api/reconciliations/${seeded.reconciliation.reconciliationId}`, cookie: treasurer.cookie,
  });
  const suggestions = await apiCall(seeded.env, {
    path: `/api/reconciliations/${seeded.reconciliation.reconciliationId}/suggestions`, cookie: treasurer.cookie,
  });
  const withoutCandidate = suggestions.data.suggestions.filter((entry) => entry.candidates.length === 0);
  assert.equal(withoutCandidate.length, 1, 'jedna pozycja (SWIFT) nie ma żadnego kandydata');
  assert.equal(withoutCandidate[0].amountCents, -375);
  const onlyPaymentCandidate = suggestions.data.suggestions.filter(
    (entry) => entry.candidates.length > 0 && entry.candidates.every((c) => c.type === 'payment_entry'),
  );
  assert.equal(onlyPaymentCandidate.length, 1, 'jedna pozycja pasuje tylko do wpłaty bez wpisu księgi');
  assert.equal(onlyPaymentCandidate[0].amountCents, 1550);
  const unexplained = withoutCandidate[0].amountCents + onlyPaymentCandidate[0].amountCents;
  assert.equal(unexplained, draft.differenceCents, 'różnica = suma dwóch pozycji do wyjaśnienia');
  // Wszystkie pozostałe pozycje wyciągu mają propozycję wpisu księgi.
  assert.equal(
    suggestions.data.suggestions.filter((entry) => entry.candidates.some((c) => c.type === 'ledger_entry')).length,
    detail.data.lines.length - 2,
  );
  // Saldo wyciągu = suma pozycji (bilans otwarcia rachunku wynosi 0).
  assert.equal(detail.data.lines.reduce((sum, line) => sum + line.amountCents, 0), draft.statementBalanceCents);
});

test('demo-seed: celowa wpłata bez przypisanej rodziny nie jest ujęta w księdze i nie jest „niezgodna”', async () => {
  const treasurer = seeded.accounts.find((a) => a.role === 'treasurer');
  const list = await apiCall(seeded.env, {
    path: `/api/payments?schoolYearId=${encodeURIComponent(SCHOOL_YEAR_ID)}&limit=100`, cookie: treasurer.cookie,
  });
  const unassigned = list.data.payments.filter((payment) => !payment.householdId);
  assert.equal(unassigned.length, 1, 'dokładnie jeden opisany przykład');
  assert.equal(unassigned[0].id, seeded.unassignedPaymentId);
  assert.equal(unassigned[0].status, 'unmatched');
});

test('demo-seed: wydatki bez dowodu to opisany brak magazynu plików w demo, nie przypadkowy bałagan', async () => {
  const report = await auditReport();
  const expenseEntries = report.categories.filter((c) => c.direction === 'expense')
    .reduce((sum, c) => sum + c.entryCount, 0);
  assert.equal(report.evidence.expensesWithoutEvidence.count, expenseEntries,
    'demo nie zawiera dokumentów: brak dowodu przy każdym wydatku jest opisany w docs/DEMO.md');
});
