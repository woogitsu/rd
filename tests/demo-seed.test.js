// Test seeda demo (scripts/demo-seed.js) — WYŁĄCZNIE dane syntetyczne, PGlite w pamięci.
// Sprawdza: liczności podstawowych obiektów, brak adresów spoza @example.invalid,
// brak słowa „dłużnik” gdziekolwiek w wygenerowanych danych i odmowę seeda dla
// ustawień produkcyjnych/zdalnej bazy/obecności klucza Brevo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handlePgRequest } from '../src/pg/app.js';
import { buildDemoPdf, demoInvoicePdf, demoMinutesPdf } from '../scripts/lib/demo-pdf.js';
import {
  addDays, brusselsLocalIso, demoTimeline, easterSunday, isBelgianPublicHoliday, parseDemoNow,
} from '../scripts/lib/demo-dates.js';
import { heuristicSchoolYearId } from '../shared/school-year.js';
import {
  apiCall, assertSafeEnvironment, DEMO_ORIGIN, DEMO_STATEMENT_DIFFERENCE_CENTS, DemoSeedRefused, runDemoSeed,
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

// #166: tryb demo nigdy poza środowiskiem lokalnym — także przy literówce i stagingu.
test('demo-seed: odmawia przy każdej wartości APP_ENV poza brak/development/test', () => {
  for (const APP_ENV of ['production', 'PRODUCTION', 'Prod', ' prod ', 'staging', 'Staging', 'prodution', 'live', 'load-test']) {
    assert.throws(() => assertSafeEnvironment({ APP_ENV }),
      (error) => error instanceof DemoSeedRefused && error.code === 'production_env', APP_ENV);
  }
  for (const APP_ENV of [undefined, '', 'development', 'Development', 'test', 'TEST']) {
    assert.doesNotThrow(() => assertSafeEnvironment({ APP_ENV }), String(APP_ENV));
  }
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
    method: 'GET', path: `/api/meetings/public-minutes?schoolYearId=${encodeURIComponent(seeded.schoolYearId)}`,
  });
  assert.ok(Array.isArray(response.data.minutes), 'odpowiedź zawiera listę protokołów');
  assert.ok(response.data.minutes.length >= 1, '/site/ ma pokazać co najmniej jeden zatwierdzony, publiczny protokół');
  const published = response.data.minutes.find((entry) => entry.minutesId === seeded.meeting.minutesId);
  assert.ok(published, 'protokół z zebrania zasiedzonego przez seed jest wśród publicznie widocznych');
});

test('demo-seed: rok szkolny demo to rok z dnia uruchomienia, zgodny z site/core.js#defaultSchoolYearId', () => {
  // ID_PATTERN w site/core.js akceptuje szerszy zakres znaków, ale
  // defaultSchoolYearId ZAWSZE generuje postać „<rok>-<rok+1>” z dzisiejszej daty —
  // ten sam rok gwarantuje, że domyślne (bez „?rok=”) wejście na /site/ go pokaże.
  assert.match(seeded.schoolYearId, /^\d{4}-\d{4}$/);
  const [start, end] = seeded.schoolYearId.split('-').map(Number);
  assert.equal(end, start + 1);
  assert.equal(seeded.schoolYearId, heuristicSchoolYearId(seeded.timeline.now));
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
      apiCall(seeded.env, { path: `/api/reports/audit?schoolYearId=${seeded.schoolYearId}`, cookie: login.cookie }),
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

// Przegląd demo 3 (krok 6): zebranie z zatwierdzonym protokołem nie może pokazywać
// „Quorum nieosiągnięte” — lista obecności ma 3 osoby z prawem głosu, reguła wymaga 3.
// Liczbę obecnych z prawem głosu liczy trigger bazy przy zapisie ustalenia quorum.
test('demo-seed: ustalenie quorum zebrania demo jest osiągnięte (3 obecnych z prawem głosu)', async () => {
  const { rows: checks } = await seeded.env.db.query(
    'SELECT present_eligible, required_count, met FROM meeting_quorum_checks WHERE meeting_id = $1 ORDER BY seq',
    [seeded.meeting.meetingId],
  );
  assert.deepEqual(checks, [{ present_eligible: 3, required_count: 3, met: true }]);
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
  assert.equal(detail.data.reconciliation.schoolYearId, seeded.schoolYearId);
  assert.equal(detail.data.lines.length, reconciliation.lineCount);

  // Przynajmniej jedna pozycja celowo nie odpowiada żadnej wpłacie/wpisowi księgi —
  // import samych linii wyciągu nie tworzy dopasowań (to osobna akcja w panelu),
  // więc wszystkie linie mają match: null; sprawdzamy więc same kwoty/liczności
  // zamiast stanu dopasowania.
  const amounts = detail.data.lines.map((line) => line.amountCents);
  assert.ok(amounts.includes(1550) || amounts.includes(-375), 'przynajmniej jedna pozycja ma kwotę celowo niepasującą do wpłat/księgi');

  const notes = String(detail.data.reconciliation.notes ?? '');
  assert.match(notes, /dane syntetyczne/, 'notatka jest oznaczona jako dane syntetyczne');
  assert.doesNotMatch(notes, /[A-Z]{2}\d{2}[ ]?(?:\d{4}[ ]?){2}/, 'notatka nie zawiera numeru rachunku (bramka danych osobowych)');
});

test('demo-seed: nazwiska rodzin/uczniów są jawnie syntetyczne', () => {
  const { roster } = seeded;
  for (const [, , , lastName] of roster.students) assert.match(lastName, /^Przykładowy /);
  for (const [, , , lastName] of roster.guardians) assert.match(lastName, /^Przykładowy /);
});

// #166: demo bez ręcznego ustawiania zmiennych.
test('demoAppEnv: brak APP_ENV daje development (import bez IMPORT_ENABLED), jawna wartość znormalizowana', async () => {
  const { demoAppEnv } = await import('../scripts/demo-seed.js');
  const { isProductionLikeEnv } = await import('../src/app-env.js');
  assert.equal(demoAppEnv({}), 'development');
  assert.equal(demoAppEnv({ APP_ENV: '' }), 'development');
  assert.equal(isProductionLikeEnv(demoAppEnv({})), false);
  assert.equal(demoAppEnv({ APP_ENV: 'staging' }), 'staging');
  assert.equal(demoAppEnv({ APP_ENV: ' TEST ' }), 'test');
});

test('demo-start: z APP_ENV=production/prod odmawia przed otwarciem bazy', async () => {
  const { startDemoServer } = await import('../scripts/demo-start.js');
  const saved = process.env.APP_ENV;
  try {
    for (const value of ['production', 'Prod', 'prodution', 'staging']) {
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
// bez dowodu (faktura demo dołączona tylko do jednego wydatku).
async function auditReport() {
  const audit = seeded.accounts.find((a) => a.role === 'audit');
  const response = await apiCall(seeded.env, {
    path: `/api/reports/audit?schoolYearId=${encodeURIComponent(seeded.schoolYearId)}`, cookie: audit.cookie,
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
    path: `/api/reports/annual?schoolYearId=${encodeURIComponent(seeded.schoolYearId)}`, cookie: board.cookie,
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
  // Przegląd demo 3: pozycja 2026-10-15 (50,00 €) miała trzech kandydatów, w tym
  // gotówkowy wpis księgi tej samej kwoty i daty. Wyciąg dotyczy rachunku — każda
  // propozycja jest przelewem, a każda pozycja ma co najwyżej jedną propozycję z tego samego dnia.
  for (const entry of suggestions.data.suggestions) {
    for (const candidate of entry.candidates) assert.equal(candidate.method, 'bank', `pozycja ${entry.bookedOn}: kandydat ${candidate.type}`);
    assert.ok(entry.candidates.filter((c) => c.dayDistance === 0).length <= 1, `pozycja ${entry.bookedOn}: jedna propozycja z tego samego dnia`);
  }
  // Saldo wyciągu = suma pozycji (bilans otwarcia rachunku wynosi 0).
  assert.equal(detail.data.lines.reduce((sum, line) => sum + line.amountCents, 0), draft.statementBalanceCents);
});

// #175: docs/DEMO.md podaje zarządowi konkretne kwoty — muszą być tymi, które
// panel pokaże po `npm run demo:seed` (kroki 3, 4 i 9 oraz tabela liczb).
test('demo-seed: kwoty i liczby w docs/DEMO.md zgadzają się z danymi seeda', async () => {
  const demo = readFileSync(new URL('../docs/DEMO.md', import.meta.url), 'utf8');
  const eur = (cents) => (cents / 100).toFixed(2).replace('.', ',');
  const board = seeded.accounts.find((a) => a.role === 'board');
  const annual = await apiCall(seeded.env, {
    path: `/api/reports/annual?schoolYearId=${encodeURIComponent(seeded.schoolYearId)}`, cookie: board.cookie,
  });
  const { balance } = annual.data.report;
  const report = await auditReport();
  const [draft] = report.reconciliations.items;
  const treasurer = seeded.accounts.find((a) => a.role === 'treasurer');
  const detail = await apiCall(seeded.env, {
    path: `/api/reconciliations/${seeded.reconciliation.reconciliationId}`, cookie: treasurer.cookie,
  });
  const skladki = report.categories.find((c) => c.id === 'cat-income-skladki');
  const expected = [
    `bilans otwarcia/zamknięcia (${eur(balance.openingBalanceCents)} / ${eur(balance.closingBalanceCents)} EUR), przychody ${eur(balance.incomeCents)} EUR i wydatki ${eur(balance.expenseCents)} EUR`,
    `${detail.data.lines.length} pozycji zaimportowanych z wyciągu (saldo wyciągu ${eur(draft.statementBalanceCents)} EUR, „Saldo księgi (rachunek)” ${eur(draft.ledgerBalanceCents)} EUR, „Różnica: ${eur(draft.differenceCents)} €”)`,
    `(otwarcia ${eur(balance.openingBalanceCents)}, przychody ${eur(balance.incomeCents)}, wydatki ${eur(balance.expenseCents)}, zamknięcia ${eur(balance.closingBalanceCents)} EUR, w tym rachunek ${eur(balance.closingBankCents)} i kasa ${eur(balance.closingCashCents)})`,
    `| Bilans otwarcia / zamknięcia | ${eur(balance.openingBalanceCents)} / ${eur(balance.closingBalanceCents)} EUR |`,
    `| Saldo wyciągu na dzień wyciągu | ${eur(draft.statementBalanceCents)} EUR |`,
    `| Różnica uzgodnienia (szkic) | ${eur(draft.differenceCents)} EUR |`,
    `| ${eur(skladki.netCents)} EUR |`,
    `| Wydatki | ${eur(balance.expenseCents)} EUR |`,
  ];
  const missing = expected.filter((snippet) => !demo.includes(snippet));
  assert.deepEqual(missing, [], 'docs/DEMO.md podaje inne liczby niż seed demo');
});

test('demo-seed: celowa wpłata bez przypisanej rodziny nie jest ujęta w księdze i nie jest „niezgodna”', async () => {
  const treasurer = seeded.accounts.find((a) => a.role === 'treasurer');
  const list = await apiCall(seeded.env, {
    path: `/api/payments?schoolYearId=${encodeURIComponent(seeded.schoolYearId)}&limit=100`, cookie: treasurer.cookie,
  });
  const unassigned = list.data.payments.filter((payment) => !payment.householdId);
  assert.equal(unassigned.length, 1, 'dokładnie jeden opisany przykład');
  assert.equal(unassigned[0].id, seeded.unassignedPaymentId);
  assert.equal(unassigned[0].status, 'unmatched');
});

test('demo-seed: faktura demo jest dowodem jednego wydatku, pozostałe wydatki celowo bez dowodu', async () => {
  const report = await auditReport();
  const expenseEntries = report.categories.filter((c) => c.direction === 'expense')
    .reduce((sum, c) => sum + c.entryCount, 0);
  assert.equal(expenseEntries, 3);
  assert.equal(report.evidence.expensesWithoutEvidence.count, 2, 'dwa wydatki bez dowodu (poczęstunek, opłata bankowa)');
  assert.equal(report.evidence.expensesWithoutEvidence.netCents, 18000 + 1200);
  assert.deepEqual(report.evidence.possibleDuplicateEvidence, []);
});

test('demo-seed: panel Dokumenty — 2 syntetyczne PDF-y, podgląd, zastąpienie i unieważnienie działają', async () => {
  const board = seeded.accounts.find((a) => a.role === 'board');
  const treasurer = seeded.accounts.find((a) => a.role === 'treasurer');
  const audit = seeded.accounts.find((a) => a.role === 'audit');
  const list = await apiCall(seeded.env, {
    path: `/api/documents?schoolYearId=${encodeURIComponent(seeded.schoolYearId)}`, cookie: treasurer.cookie,
  });
  const boardList = await apiCall(seeded.env, {
    path: `/api/documents?schoolYearId=${encodeURIComponent(seeded.schoolYearId)}`, cookie: board.cookie,
  });
  assert.equal(boardList.data.documents.length, 2, 'zarząd (z MFA) widzi oba dokumenty');
  assert.equal(list.data.documents.length, 1, 'skarbnik widzi tylko dowód finansowy');
  const all = new Map([...list.data.documents, ...boardList.data.documents].map((d) => [d.id, d]));
  assert.equal(all.size, 2);
  const invoice = all.get(seeded.documents.invoiceId);
  const minutes = all.get(seeded.documents.minutesId);
  assert.equal(invoice.title, 'Faktura — przykład demo');
  assert.equal(invoice.kind, 'financial');
  assert.equal(invoice.linkedEntityType, 'ledger_entry');
  assert.equal(minutes.title, 'Protokół — przykład demo');
  assert.equal(minutes.category, 'protokol');
  for (const doc of all.values()) {
    assert.equal(doc.mimeType, 'application/pdf');
    assert.equal(doc.status, 'active');
  }
  // Podgląd inline (#466): treść przechodzi przez atrapę magazynu i ma sygnaturę PDF.
  const content = await handlePgRequest(new Request(
    new URL(`/api/documents/${invoice.id}/content?disposition=inline`, DEMO_ORIGIN),
    { headers: { Cookie: treasurer.cookie } },
  ), seeded.env);
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('Content-Type'), 'application/pdf');
  const bytes = new Uint8Array(await content.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  assert.equal(bytes.length, invoice.byteSize);
  // Dyrekcja/KR bez dostępu do dokumentów (macierz z documents.js).
  const denied = await handlePgRequest(new Request(
    new URL(`/api/documents/${invoice.id}`, DEMO_ORIGIN), { headers: { Cookie: audit.cookie } },
  ), seeded.env);
  assert.equal(denied.status, 404);
  // Zastąp/Unieważnij (#477) działają na dokumentach z tego samego magazynu. Dokumenty
  // demo zostają nietknięte — akcje wykonujemy na dwóch dodatkowych plikach testowych.
  const upload = (key) => apiCall(seeded.env, {
    method: 'POST', path: `/api/documents?kind=board&schoolYearId=${encodeURIComponent(seeded.schoolYearId)}`, cookie: board.cookie,
    idempotencyKey: key, rawBody: buildDemoPdf(demoMinutesPdf({ date: seeded.meeting.meetingDate, schoolYearLabel: seeded.timeline.schoolYearLabel })), contentType: 'application/pdf',
  });
  const first = (await upload('demo-test-first')).data.document;
  const second = (await upload('demo-test-second')).data.document;
  const superseded = await apiCall(seeded.env, {
    method: 'POST', path: `/api/documents/${first.id}/supersede`, cookie: board.cookie, idempotencyKey: 'demo-test-supersede',
    body: { replacementDocumentId: second.id, reason: 'Zastąpienie w teście demo' },
  });
  assert.equal(superseded.status, 201);
  const voided = await apiCall(seeded.env, {
    method: 'POST', path: `/api/documents/${second.id}/void`, cookie: board.cookie, idempotencyKey: 'demo-test-void',
    body: { reason: 'Unieważnienie w teście demo' },
  });
  assert.equal(voided.status, 201);
  const active = await apiCall(seeded.env, {
    path: `/api/documents?schoolYearId=${encodeURIComponent(seeded.schoolYearId)}&kind=board`, cookie: board.cookie,
  });
  assert.deepEqual(active.data.documents.map((d) => d.id), [minutes.id], 'aktywny zostaje tylko protokół demo');
});

test('demo-seed: PDF-y demo odrzuca ta sama walidacja co w produkcji (typ, sygnatura)', async () => {
  const board = seeded.accounts.find((a) => a.role === 'board');
  const response = await handlePgRequest(new Request(
    new URL(`/api/documents?kind=board&schoolYearId=${encodeURIComponent(seeded.schoolYearId)}`, DEMO_ORIGIN),
    {
      method: 'POST', body: new TextEncoder().encode('to nie jest PDF'),
      headers: { Cookie: board.cookie, Origin: DEMO_ORIGIN, 'Content-Type': 'application/pdf', 'Idempotency-Key': 'demo-test-not-pdf' },
    },
  ), seeded.env);
  assert.equal(response.status, 415);
});

test('demo-pdf: PDF ma poprawną tabelę xref, brak aktywnej treści i przechodzi walidację struktury', async () => {
  const { validateStructure, detectType } = await import('../src/documents.js');
  for (const pdf of [demoMinutesPdf({ date: '2026-10-01', schoolYearLabel: '2026/2027' }), demoInvoicePdf({ date: '2026-09-15' })]) {
    const bytes = buildDemoPdf(pdf);
    assert.equal(detectType(bytes), 'application/pdf');
    assert.deepEqual(validateStructure(bytes, 'application/pdf'), { ok: true });
    const text = new TextDecoder('latin1').decode(bytes);
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
    assert.equal(text.slice(startxref, startxref + 4), 'xref');
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    assert.equal(entries.length, 5);
    entries.forEach((offset, index) => assert.ok(text.startsWith(`${index + 1} 0 obj`, offset), `obiekt ${index + 1}`));
    const length = Number(/\/Length (\d+)/.exec(text)[1]);
    const stream = /stream\n([\s\S]*)\nendstream/.exec(text)[1];
    assert.equal(stream.length, length);
    assert.doesNotMatch(text, /[^\x00-\x7f]/);
  }
});

// Przegląd demo 4: stałe daty z X–XII 2026 dawały przy pokazie w październiku dane
// „z przyszłości” (protokół zatwierdzony przed zebraniem „Odbyte”). Oś czasu jest
// teraz liczona względem dnia uruchomienia — deterministycznie dla podanej chwili.
test('demo-dates: połowa października — rok 2026-2027, wyciąg wczoraj, plan ściśnięty do 1 września', () => {
  const t = demoTimeline(new Date('2026-10-15T10:00:00Z'));
  assert.equal(t.schoolYearId, '2026-2027');
  assert.equal(t.schoolYearLabel, '2026/2027');
  assert.equal(t.startsOn, '2026-09-01');
  assert.equal(t.endsOn, '2027-08-31');
  assert.equal(t.today, '2026-10-15');
  assert.equal(t.statementDate, '2026-10-14');
  assert.equal(t.beforeStatement(61), '2026-09-01', 'najstarsza wpłata dokładnie na początku roku');
  assert.equal(t.beforeStatement(0), '2026-10-14');
  assert.ok(t.beforeStatement(15) < t.today, 'zebranie odbyło się przed dniem pokazu');
  assert.equal(t.upcoming(14), '2026-10-29');
  // Ta sama chwila daje te same daty.
  const again = demoTimeline(new Date('2026-10-15T10:00:00Z'));
  assert.deepEqual([61, 51, 30, 15, 4, 1].map(again.beforeStatement), [61, 51, 30, 15, 4, 1].map(t.beforeStatement));
});

test('demo-dates: po ponad 61 dniach roku odstępy planu są pełne (bez ściskania)', () => {
  const t = demoTimeline(parseDemoNow('2027-01-20'));
  assert.equal(t.schoolYearId, '2026-2027');
  assert.equal(t.scale, 1);
  assert.equal(t.statementDate, '2027-01-19');
  assert.equal(t.beforeStatement(61), addDays('2027-01-19', -61));
  assert.equal(t.beforeStatement(15), '2027-01-04');
});

test('demo-dates: 1 września wszystko mieści się w roku; strefa Bruksela i koniec roku', () => {
  const first = demoTimeline(parseDemoNow('2026-09-01'));
  assert.equal(first.statementDate, '2026-09-01');
  assert.equal(first.beforeStatement(61), '2026-09-01', 'żadna data przed 1 września (trigger 0027)');
  // 31 sierpnia 22:30 UTC to już 1 września w Brukseli — nowy rok szkolny.
  assert.equal(demoTimeline(new Date('2027-08-31T22:30:00Z')).schoolYearId, '2027-2028');
  assert.equal(demoTimeline(new Date('2027-08-31T21:30:00Z')).schoolYearId, '2026-2027');
  // Zapowiedzi nie wychodzą poza rok szkolny.
  assert.equal(demoTimeline(parseDemoNow('2027-08-20')).upcoming(42), '2027-08-31');
  assert.throws(() => parseDemoNow('nie-data'), /RRRR-MM-DD/);
});

test('demo-seed: daty danych demo nie są z przyszłości, zapowiedzi są, protokół zatwierdzony po zebraniu', async () => {
  const t = seeded.timeline;
  const { db } = seeded.env;
  const { rows: payments } = await db.query(
    `SELECT to_char(received_on, 'YYYY-MM-DD') AS d FROM payment_entries WHERE school_year_id = $1`, [t.schoolYearId],
  );
  const { rows: entries } = await db.query(
    `SELECT to_char(occurred_on, 'YYYY-MM-DD') AS d FROM ledger_entries WHERE school_year_id = $1`, [t.schoolYearId],
  );
  const { rows: lines } = await db.query(
    `SELECT to_char(l.booked_on, 'YYYY-MM-DD') AS d FROM bank_statement_lines l
       JOIN bank_reconciliations r ON r.id = l.reconciliation_id WHERE r.school_year_id = $1`, [t.schoolYearId],
  );
  assert.equal(payments.length, 17);
  assert.equal(entries.length, 20);
  assert.equal(lines.length, 17);
  for (const { d } of [...payments, ...entries, ...lines]) {
    assert.ok(d >= t.startsOn && d <= t.statementDate, `data ${d} w [${t.startsOn}, ${t.statementDate}]`);
    assert.ok(d <= t.today, `data ${d} nie jest z przyszłości (dziś ${t.today})`);
  }
  const { rows: [reconciliation] } = await db.query(
    `SELECT to_char(statement_date, 'YYYY-MM-DD') AS d FROM bank_reconciliations WHERE id = $1`,
    [seeded.reconciliation.reconciliationId],
  );
  assert.equal(reconciliation.d, t.statementDate);
  const { rows: [meeting] } = await db.query(
    `SELECT m.scheduled_at, mm.approved_at FROM meetings m JOIN meeting_minutes mm ON mm.meeting_id = m.id
      WHERE m.id = $1 AND mm.id = $2`,
    [seeded.meeting.meetingId, seeded.meeting.minutesId],
  );
  assert.equal(seeded.meeting.meetingDate, t.beforeStatement(15));
  // 1 września (pierwszy dzień roku) zebranie może wypaść tego samego dnia co seed —
  // wtedy kolejność godzin zależy od pory uruchomienia; w każdym innym dniu zebranie jest wcześniej.
  if (t.elapsedDays >= 1) {
    assert.ok(new Date(meeting.scheduled_at) < new Date(meeting.approved_at), 'protokół zatwierdzony po zebraniu');
  }
  const { rows: events } = await db.query(
    'SELECT begins_at FROM events WHERE school_year_id = $1',
    [t.schoolYearId],
  );
  assert.ok(events.length >= 2);
  for (const { begins_at: beginsAt } of events) {
    assert.ok(new Date(beginsAt) > t.now || t.upcoming(14) === t.endsOn, 'zapowiedź dotyczy przyszłego terminu');
  }
});

// Przegląd demo 5 (propozycja 8): kiermasz demo wypadał 11.11 (święto w Belgii).
// Terminy zapowiedzi omijają belgijskie święta ustawowe — deterministycznie dla `--teraz`.
test('demo-dates: zapowiedzi omijają belgijskie święta ustawowe (1.11, 11.11, 25.12, ruchome)', () => {
  const t = demoTimeline(parseDemoNow('2026-09-30'));
  assert.equal(t.upcoming(14), '2026-10-14');
  assert.equal(t.upcoming(42), '2026-11-12', '11.11 → 12.11');
  assert.equal(demoTimeline(parseDemoNow('2026-09-20')).upcoming(42), '2026-11-02', '1.11 → 2.11');
  assert.equal(demoTimeline(parseDemoNow('2026-11-13')).upcoming(42), '2026-12-26', '25.12 → 26.12');
  assert.equal(easterSunday(2027), '2027-03-28');
  for (const date of ['2027-01-01', '2027-03-29', '2027-05-01', '2027-05-06', '2027-05-17', '2027-07-21', '2027-08-15', '2026-11-01', '2026-11-11', '2026-12-25']) {
    assert.equal(isBelgianPublicHoliday(date), true, date);
  }
  for (const date of ['2026-11-12', '2027-03-28', '2027-05-18', '2026-12-24']) {
    assert.equal(isBelgianPublicHoliday(date), false, date);
  }
  // Każdy dzień uruchomienia w roku: żadna zapowiedź nie wypada w święto.
  for (let day = '2026-09-01'; day <= '2027-08-31'; day = addDays(day, 1)) {
    const timeline = demoTimeline(parseDemoNow(day));
    for (const ahead of [14, 21, 42]) {
      const date = timeline.upcoming(ahead);
      assert.ok(!isBelgianPublicHoliday(date) || date === timeline.endsOn, `${day} +${ahead} → ${date}`);
      assert.ok(date >= timeline.today && date <= timeline.endsOn, `${day} +${ahead} → ${date} w roku szkolnym`);
    }
  }
  assert.equal(brusselsLocalIso('2026-10-14', '18:00'), '2026-10-14T18:00:00+02:00');
  assert.equal(brusselsLocalIso('2026-11-12', '16:00'), '2026-11-12T16:00:00+01:00');
});

// Przegląd demo 5 (propozycja 8): nowe funkcje widoczne bez zapisu na pokazie —
// zadania wolontariuszy (#142/#579) i zatwierdzone zawiadomienie z plikiem .ics (#113/#584).
test('demo-seed: wydarzenie klasowe 0-A — dwa zadania, jeden zapis opiekuna, na /site/ „potrzebni jeszcze: 1”', async () => {
  const { classEvent } = seeded;
  const representative = seeded.accounts.find((a) => a.role === 'representative');
  const list = await apiCall(seeded.env, { path: `/api/events?schoolYearId=${seeded.schoolYearId}`, cookie: representative.cookie });
  assert.deepEqual(list.data.events.map((event) => event.id), [classEvent.eventId], 'przedstawiciel widzi wydarzenie własnej klasy');
  const tasks = await apiCall(seeded.env, { path: `/api/events/${classEvent.eventId}/tasks`, cookie: representative.cookie });
  assert.equal(tasks.data.tasks.length, 2);
  const [publicTask, internalTask] = tasks.data.tasks;
  assert.equal(publicTask.isPublic, true);
  assert.equal(publicTask.slotsNeeded, 2);
  assert.equal(publicTask.confirmedCount, 1);
  assert.equal(publicTask.signups[0].guardianId, classEvent.guardianId);
  assert.match(publicTask.signups[0].personName, /^Opiekun [AB] Przykładowy \d+$/, 'zapis syntetycznego opiekuna');
  assert.equal(internalTask.isPublic, false);
  assert.equal(internalTask.signups.length, 0);
  const pub = await apiCall(seeded.env, { path: `/api/public/events?schoolYearId=${seeded.schoolYearId}` });
  const event = pub.data.events.find((entry) => entry.id === classEvent.eventId);
  assert.deepEqual(event.volunteerTasks.map(({ title, stillNeeded }) => ({ title, stillNeeded })),
    [{ title: publicTask.title, stillNeeded: 1 }], 'publicznie tylko zadanie publiczne, bez osób');
  assert.doesNotMatch(JSON.stringify(pub.data), /Opiekun|guardianId/);
  assert.ok(!pub.data.events.some((entry) => isBelgianPublicHoliday(entry.startsAt.slice(0, 10))), 'żadna zapowiedź w święto');
});

test('demo-seed: zebranie ogólne z zatwierdzonym zawiadomieniem — plik .ics działa, bez kampanii do wysyłki', async () => {
  const { generalMeeting } = seeded;
  const board = seeded.accounts.find((a) => a.role === 'board');
  const detail = await apiCall(seeded.env, { path: `/api/meetings/${generalMeeting.meetingId}`, cookie: board.cookie });
  assert.equal(detail.data.meeting.status, 'scheduled');
  const [notice] = detail.data.notices;
  assert.equal(detail.data.notices.length, 1);
  assert.equal(notice.id, generalMeeting.noticeId);
  assert.equal(notice.status, 'approved');
  const response = await handlePgRequest(new Request(
    new URL(`/api/meetings/${generalMeeting.meetingId}/notices/${generalMeeting.noticeId}/calendar`, DEMO_ORIGIN),
    { headers: { Cookie: board.cookie } },
  ), seeded.env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^text\/calendar/);
  const ics = await response.text();
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /Wolne wnioski/, 'porządek obrad w pliku kalendarza');
  const pub = await apiCall(seeded.env, { path: `/api/meetings/public-notices?schoolYearId=${seeded.schoolYearId}` });
  assert.deepEqual(pub.data.notices.map((entry) => entry.id), [generalMeeting.noticeId]);
  const { rows: campaigns } = await seeded.env.db.query(
    'SELECT id, status, meeting_notice_id FROM email_campaigns WHERE school_year_id = $1', [seeded.schoolYearId],
  );
  assert.deepEqual(campaigns, [{ id: seeded.campaignId, status: 'draft', meeting_notice_id: null }], 'jedyna kampania to szkic z seeda');
});

test('demo-seed: szkic kampanii tylko z uwagami o {rodzina} (#83) i stałą uwagą D-16', async () => {
  const board = seeded.accounts.find((a) => a.role === 'board');
  const preview = await apiCall(seeded.env, { path: `/api/email/campaigns/${seeded.campaignId}/preview`, cookie: board.cookie });
  // Demo nie ma rejestru komunikacji strukturalnej (payment_references), więc szkic zostaje przy {rodzina}
  // — {komunikat} wykluczyłby wszystkie rodziny (no_payment_reference). #83 ostrzega o tym jawnie.
  assert.deepEqual(preview.data.warnings, ['household_id_as_payment_reference', 'template_requires_board_decision_d16']);
});

// #146/#586: demo ma jednego administratora, więc nadanie ról chronionych (zarząd ×2,
// skarbnik) idzie bezpośrednio z wyjątkiem czterech oczu zapisanym w dzienniku.
test('demo-seed: jeden administrator — role chronione nadane z wyjątkiem czterech oczu w dzienniku', async () => {
  assert.equal(seeded.accounts.filter((a) => a.role === 'admin').length, 1);
  const admin = seeded.accounts.find((a) => a.role === 'admin');
  const { rows } = await seeded.env.db.query(
    `SELECT actor_id, (metadata_json::jsonb)->>'reason' AS reason FROM audit_events WHERE action = 'role_grant.four_eyes_waived'`,
  );
  assert.equal(rows.length, 3, 'zarząd ×2 i skarbnik');
  for (const row of rows) assert.deepEqual(row, { actor_id: admin.userId, reason: 'no_other_admin' });
  const { rows: requests } = await seeded.env.db.query('SELECT count(*)::int AS n FROM role_grant_requests');
  assert.equal(requests[0].n, 0, 'brak oczekujących wniosków o rolę');
});
