// Scenariusz "heavy" testu wydajności (#217): trasy pominięte przez domyślny
// scenariusz load-test.js (lekkie odczyty jednego roku) — karty z sumami
// wielu lat, kartki dla całej szkoły, eksport księgi, raport dla Komisji
// Rewizyjnej i pełny przepływ uzgodnienia rachunku (import, karta, propozycje).
//
// Dane: kilka lat syntetycznej historii (buildHistoricalData) zamiast
// jednego roku z synthetic-seed.js — koszt tych tras rośnie z wiekiem
// systemu (historia lat, audit_events, uzgodnienia), czego seed jednego
// roku nie pokazuje.
//
// Skala domyślna jest CELOWO mniejsza niż baseline z opisu issue #217
// (5 lat, 50 klas/rok, 100 000 zdarzeń audytu) — taki seed trwa dziesiątki
// sekund i spowalnia CI/PR (patrz "Ryzyko" w opisie issue: scenariusz ma
// być nocny, #111). `--heavy-years`, `--heavy-classes`, `--heavy-students`,
// `--heavy-audit-events` pozwalają odtworzyć pełną skalę na żądanie
// (nocny przebieg albo pomiar ręczny), ale nie jest to wymagane na PR.
//
// Zapisuje: import, uzgodnienie i pozycje wyciągu (wyłącznie lokalnie —
// zapisuje dane). Nie wywołuje żadnej trasy e-mail/`…/queue`.

import { createSessionSecret } from '../../src/auth.js';
import { insertRows, pad, q } from './synthetic-seed.js';

export const HEAVY_DEFAULTS = Object.freeze({
  years: 2, classesPerYear: 5, studentsPerYear: 40, auditEvents: 3000,
});

// Progi orientacyjne (ms), luźniejsze niż w opisie issue: kontener testowy
// jest współdzielony i przeciążony (patrz AGENTS.md pracy nad poprawkami),
// więc czasy z tego środowiska nie są reprezentatywne dla Railway — budżety
// łapią tylko rażącą regresję (np. N+1 w pętli), nie mikroopóźnienia.
export const HEAVY_ROUTE_BUDGETS_MS = Object.freeze({
  'GET /api/classes': 1500,
  'GET /api/classes/{id}/students': 1500,
  'GET /api/households/{id}': 1500,
  'GET /api/print/cards': 3000,
  'GET /api/ledger/export.csv': 3000,
  'GET /api/reports/audit': 3000,
  'GET /api/reconciliations': 1500,
  'POST /api/reconciliations/{id}/lines': 5000,
  'GET /api/reconciliations/{id}': 2000,
  'GET /api/reconciliations/{id}/suggestions': 2000,
});

function yearBounds(index) {
  const start = 2020 + index;
  return { startsOn: `${start}-09-01`, endsOn: `${start + 1}-08-31` };
}

// Zestaw historyczny: kilka lat, kilka klas na rok, uczniowie z rodzeństwem
// i dwoje opiekunów, dobrowolne wpłaty częściowe i korekty w każdym roku,
// kilka wpisów księgi, jeden szkic uzgodnienia w najnowszym roku, oraz
// zdarzenia audytu (generate_series po stronie bazy — szybciej niż wiersze JS).
export function buildHistoricalData({
  years = HEAVY_DEFAULTS.years, classesPerYear = HEAVY_DEFAULTS.classesPerYear,
  studentsPerYear = HEAVY_DEFAULTS.studentsPerYear, auditEvents = HEAVY_DEFAULTS.auditEvents,
} = {}) {
  const yearIds = Array.from({ length: years }, (_, i) => `hy${pad(i + 1)}`);
  const schoolYears = yearIds.map((id, i) => [id, `${2020 + i}/${(2020 + i + 1) % 100}`, yearBounds(i).startsOn, yearBounds(i).endsOn]);
  const latestYear = yearIds.at(-1);

  const classes = [];
  const households = [];
  const students = [];
  const enrollments = [];
  const guardians = [];
  const links = [];
  const payments = [];
  const corrections = [];
  const ledgerCategories = [];
  const ledgerEntries = [];

  for (const [yearIndex, yearId] of yearIds.entries()) {
    for (let c = 0; c < classesPerYear; c += 1) {
      classes.push([`hc${yearIndex}${pad(c + 1)}`, yearId, `Klasa historyczna ${yearIndex}-${pad(c + 1)}`]);
    }
    ledgerCategories.push([`hcat-income-${yearIndex}`, yearId, 'income', 'Składki dobrowolne', 'hu-treasurer']);
    ledgerCategories.push([`hcat-expense-${yearIndex}`, yearId, 'expense', 'Wydatki bieżące', 'hu-treasurer']);

    // Co dziesiąte gospodarstwo ma dwoje dzieci (rodzeństwo w różnych klasach).
    let studentSeq = 0;
    let householdSeq = 0;
    while (studentSeq < studentsPerYear) {
      householdSeq += 1;
      const householdId = `hh${yearIndex}${pad(householdSeq)}`;
      households.push([householdId]);
      const siblingCount = householdSeq % 10 === 0 && studentSeq + 1 < studentsPerYear ? 2 : 1;
      const studentIdsHere = [];
      for (let s = 0; s < siblingCount; s += 1) {
        studentSeq += 1;
        const studentId = `hs${yearIndex}${pad(studentSeq)}`;
        studentIdsHere.push(studentId);
        students.push([studentId, householdId, `Uczeń historyczny ${pad(studentSeq)}`, 'Syntetyczny']);
        const classId = `hc${yearIndex}${pad(((studentSeq - 1) % classesPerYear) + 1)}`;
        enrollments.push([`he${yearIndex}${pad(studentSeq)}`, studentId, classId, yearId]);
      }
      // Dwoje opiekunów na gospodarstwo (oboje z kontaktem, jeden główny).
      for (let g = 0; g < 2; g += 1) {
        const guardianId = `hg${yearIndex}${pad(householdSeq)}${g}`;
        guardians.push([guardianId, householdId, `Opiekun historyczny ${pad(householdSeq)}${g}`, 'Syntetyczny',
          `opiekun-hist-${yearIndex}-${pad(householdSeq)}-${g}@example.invalid`, 'true']);
        for (const studentId of studentIdsHere) links.push([studentId, guardianId, 'true', g === 0 ? 'true' : 'false']);
      }
      // Wpłaty częściowe: co trzecie gospodarstwo wpłaca w dwóch ratach.
      const parts = householdSeq % 3 === 0 ? 2 : 1;
      for (let p = 0; p < parts; p += 1) {
        const paymentId = `hp${yearIndex}${pad(payments.length + 1)}`;
        payments.push([paymentId, householdId, yearId, String(1500 + (householdSeq % 4) * 500),
          `${yearBounds(yearIndex).startsOn.slice(0, 4)}-10-0${(p % 9) + 1}`, 'bank', `REF-HIST-${pad(payments.length + 1)}`,
          'recorded', 'hu-treasurer', `heavy-payment-${yearIndex}-${pad(payments.length + 1)}`]);
      }
    }
    // Korekta na kilku pierwszych wpłatach roku.
    const yearPayments = payments.filter(([id]) => id.startsWith(`hp${yearIndex}`));
    for (const [paymentId] of yearPayments.slice(0, 3)) {
      corrections.push([`hpc${corrections.length + 1}`, paymentId, '200', 'Korekta syntetyczna (historia)',
        'hu-treasurer', `heavy-correction-${corrections.length + 1}`]);
    }
    // Kilka wpisów księgi (bank), niepowiązanych z wpłatami — do eksportu/raportu/uzgodnienia.
    for (let i = 0; i < 5; i += 1) {
      ledgerEntries.push([`hle${yearIndex}${pad(i + 1)}`, yearId, i % 2 === 0 ? 'income' : 'expense',
        String(1000 + i * 300), i % 2 === 0 ? `hcat-income-${yearIndex}` : `hcat-expense-${yearIndex}`,
        `Wpis historyczny ${yearIndex}-${pad(i + 1)}`, `${yearBounds(yearIndex).startsOn.slice(0, 4)}-10-1${i}`, 'bank',
        'hu-treasurer', `heavy-ledger-${yearIndex}-${pad(i + 1)}`]);
    }
  }

  const users = [
    ['hu-admin', 'admin-hist@example.invalid', 'Administrator historyczny'],
    ['hu-board', 'board-hist@example.invalid', 'Zarząd historyczny'],
    ['hu-treasurer', 'treasurer-hist@example.invalid', 'Skarbnik historyczny'],
    ['hu-audit', 'audit-hist@example.invalid', 'Komisja Rewizyjna historyczna'],
    ['hu-rep', 'rep-hist@example.invalid', 'Przedstawiciel historyczny'],
  ];
  const grants = [
    ['hr1', 'hu-admin', 'admin', null, null],
    ['hr2', 'hu-board', 'board', null, null],
    ['hr3', 'hu-audit', 'audit', null, null],
    // Skarbnik i przedstawiciel: przydział na każdy rok (jak dwie osoby
    // opiekujące się jednym dzieckiem w różnych latach — przydział roczny).
    ...yearIds.map((yearId, i) => [`hr-t${i}`, 'hu-treasurer', 'treasurer', null, yearId]),
    ['hr-rep', 'hu-rep', 'representative', `hc${years - 1}${pad(1)}`, latestYear],
  ];

  // Drugie gospodarstwo najnowszego roku ma dziecko w innej klasie niż przydział
  // przedstawiciela (round-robin po klasach) — dopóki są co najmniej dwie klasy
  // na rok; służy do sprawdzenia granicy roli (#217, "Testy do dodania").
  const latestOtherHouseholdId = classesPerYear > 1 ? `hh${years - 1}${pad(2)}` : null;

  return {
    yearIds, latestYear, schoolYears, classes, households, students, enrollments, guardians, links,
    payments, corrections, ledgerCategories, ledgerEntries, users, grants, auditEventCount: auditEvents,
    latestClassId: `hc${years - 1}${pad(1)}`, latestHouseholdId: `hh${years - 1}${pad(1)}`, latestOtherHouseholdId,
  };
}

export async function insertHistoricalData(db, data) {
  for (const [id, label, startsOn, endsOn] of data.schoolYears) {
    await db.exec(`INSERT INTO school_years VALUES (${q(id)},${q(label)},${q(startsOn)},${q(endsOn)})`);
  }
  await insertRows(db, 'users', ['id', 'email', 'display_name'], data.users);
  await insertRows(db, 'classes', ['id', 'school_year_id', 'name'], data.classes);
  await insertRows(db, 'role_grants', ['id', 'user_id', 'role', 'class_id', 'school_year_id'], data.grants);
  await insertRows(db, 'households', ['id'], data.households);
  await insertRows(db, 'students', ['id', 'household_id', 'first_name', 'last_name'], data.students);
  await insertRows(db, 'enrollments', ['id', 'student_id', 'class_id', 'school_year_id'], data.enrollments);
  await insertRows(db, 'guardians', ['id', 'household_id', 'first_name', 'last_name', 'email', 'contact_allowed'], data.guardians);
  await insertRows(db, 'student_guardians', ['student_id', 'guardian_id', 'contact_allowed', 'is_primary_contact'], data.links);
  await insertRows(db, 'ledger_categories', ['id', 'school_year_id', 'direction', 'name', 'created_by'], data.ledgerCategories);
  await insertRows(db, 'payment_entries', ['id', 'household_id', 'school_year_id', 'amount_cents', 'received_on', 'method',
    'reference', 'status', 'created_by', 'idempotency_key'], data.payments);
  await insertRows(db, 'payment_corrections', ['id', 'payment_entry_id', 'amount_cents', 'reason', 'created_by', 'idempotency_key'], data.corrections, 1);
  await insertRows(db, 'ledger_entries', ['id', 'school_year_id', 'direction', 'amount_cents', 'category_id', 'description',
    'occurred_on', 'method', 'created_by', 'idempotency_key'], data.ledgerEntries);

  // Zdarzenia audytu: generate_series po stronie bazy (issue #217 pkt 1) —
  // znacznie szybsze niż tyle samo wierszy JS przez insertRows.
  if (data.auditEventCount > 0) {
    await db.query(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
       SELECT 'hae' || i, 'hu-treasurer', 'payment.recorded', 'payment_entry', 'hp' || (1 + (i % 997)),
              now() - make_interval(days => (i % 730)), '{}'::jsonb
         FROM generate_series(1, $1) AS i`,
      [data.auditEventCount],
    );
  }

  // Szkic uzgodnienia w najnowszym roku — karta/propozycje mają co pokazać
  // nawet przed importem pozycji w scenariuszu (POST .../lines dokłada resztę).
  const reconciliationId = 'hrec1';
  await db.query(
    `INSERT INTO bank_reconciliations (id, school_year_id, statement_date, statement_balance_cents,
       ledger_balance_cents, ledger_non_bank_cents, reference_salt, created_by, idempotency_key)
     VALUES ($1, $2, $3, 0, 0, 0, $4, 'hu-treasurer', 'heavy-reconciliation-draft')`,
    [reconciliationId, data.latestYear, `${data.schoolYears.at(-1)[2].slice(0, 4)}-09-30`,
      [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')],
  );
  return reconciliationId;
}

export async function seedHeavySessions(db, userIds) {
  const cookies = new Map();
  const rows = [];
  for (const userId of userIds) {
    const { secret, tokenHash } = await createSessionSecret();
    cookies.set(userId, `rd_session=${secret}`);
    rows.push([crypto.randomUUID(), userId, tokenHash]);
  }
  const values = rows.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}, now() + make_interval(secs => 7200), now())`).join(',');
  await db.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at, mfa_verified_at) VALUES ${values}`, rows.flat());
  return cookies;
}

function heavyOperations({ latestYear, classId, householdId, otherHouseholdId, reconciliationId, origin }) {
  const key = `heavy-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const ops = [
    { name: 'GET /api/classes', method: 'GET', role: 'board', path: `/api/classes?schoolYearId=${latestYear}`, writes: false },
    { name: 'GET /api/classes/{id}/students', method: 'GET', role: 'board', path: `/api/classes/${classId}/students`, writes: false },
    { name: 'GET /api/households/{id}', method: 'GET', role: 'treasurer', path: `/api/households/${householdId}`, writes: false },
    { name: 'GET /api/print/cards', method: 'GET', role: 'board', path: `/api/print/cards?schoolYearId=${latestYear}`, writes: false },
    { name: 'GET /api/ledger/export.csv', method: 'GET', role: 'treasurer', path: `/api/ledger/export.csv?schoolYearId=${latestYear}`, writes: false },
    { name: 'GET /api/reports/audit', method: 'GET', role: 'audit', path: `/api/reports/audit?schoolYearId=${latestYear}&format=json`, writes: false },
    { name: 'GET /api/reconciliations', method: 'GET', role: 'treasurer', path: `/api/reconciliations?schoolYearId=${latestYear}`, writes: false },
    {
      name: 'POST /api/reconciliations/{id}/lines', method: 'POST', role: 'treasurer', writes: true,
      path: `/api/reconciliations/${reconciliationId}/lines`, key, origin,
      body: { lines: Array.from({ length: 200 }, (_, i) => ({ bookedOn: '2020-10-15', amountCents: 1000 + (i % 5) * 100 })) },
      expect: [201, 200],
    },
    { name: 'GET /api/reconciliations/{id}', method: 'GET', role: 'treasurer', path: `/api/reconciliations/${reconciliationId}`, writes: false },
    { name: 'GET /api/reconciliations/{id}/suggestions', method: 'GET', role: 'treasurer', path: `/api/reconciliations/${reconciliationId}/suggestions`, writes: false },
  ];
  // Granica ról (#217, testy do dodania): przedstawiciel poza swoją klasą — 403/404
  // jest oczekiwanym wynikiem, nie błędem; tylko gdy w danych jest druga klasa.
  if (otherHouseholdId) {
    ops.push({
      name: 'GET /api/households/{id} (representative, out of scope)', method: 'GET', role: 'representative',
      path: `/api/households/${otherHouseholdId}`, writes: false, expect: [403, 404],
    });
  }
  return ops;
}

// Uruchamia każdą trasę `iterations` razy, sekwencyjnie (#217: czas trasy,
// rozmiar odpowiedzi, szczyt heapUsed i maks. opóźnienie pętli zdarzeń).
export async function runHeavyScenario({
  baseUrl, actors, latestYear, classId, householdId, otherHouseholdId, reconciliationId,
  iterations = 3, timeoutMs = 20_000, log = () => {},
}) {
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  const loopDelay = monitorEventLoopDelay({ resolution: 5 });
  loopDelay.enable();

  const origin = new URL(baseUrl).origin;
  const byRole = new Map(actors.map((a) => [a.role, a]));
  const ops = heavyOperations({ latestYear, classId, householdId, otherHouseholdId, reconciliationId, origin });
  const byOperation = {};
  let peakHeapUsedMb = process.memoryUsage().heapUsed / (1024 * 1024);

  for (const op of ops) {
    const actor = byRole.get(op.role);
    if (!actor) { log(`pomijam ${op.name}: brak aktora roli ${op.role}`); continue; }
    const runs = op.writes ? 1 : iterations;
    const latencies = [];
    let bytes = 0;
    let errors = 0;
    for (let i = 0; i < runs; i += 1) {
      const headers = { Cookie: actor.cookie };
      if (op.method !== 'GET') headers.Origin = origin;
      if (op.key) headers['Idempotency-Key'] = i === 0 ? op.key : `${op.key}-${i}`;
      if (op.body !== undefined) headers['Content-Type'] = 'application/json';
      const started = performance.now();
      try {
        const response = await fetch(`${baseUrl}${op.path}`, {
          method: op.method, headers, body: op.body === undefined ? undefined : JSON.stringify(op.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const buffer = await response.arrayBuffer();
        bytes += buffer.byteLength;
        const expected = op.expect ?? [200, 201];
        if (!expected.includes(response.status)) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - started);
      peakHeapUsedMb = Math.max(peakHeapUsedMb, process.memoryUsage().heapUsed / (1024 * 1024));
    }
    latencies.sort((a, b) => a - b);
    byOperation[op.name] = {
      requests: runs, errors,
      latencyMs: { p50: Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0),
        max: Math.round(latencies.at(-1) ?? 0) },
      responseBytes: Math.round(bytes / runs),
      budgetMs: HEAVY_ROUTE_BUDGETS_MS[op.name.replace(/ \(.*\)$/, '')] ?? null,
    };
  }

  loopDelay.disable();
  return {
    byOperation,
    peakHeapUsedMb: Math.round(peakHeapUsedMb * 10) / 10,
    maxEventLoopDelayMs: Math.round(loopDelay.max / 1e6),
  };
}

export function checkHeavyBudgets(byOperation) {
  const breaches = [];
  for (const [name, entry] of Object.entries(byOperation)) {
    if (entry.errors > 0) breaches.push(`${name}: ${entry.errors} błędnych odpowiedzi`);
    if (entry.budgetMs !== null && entry.latencyMs.p50 > entry.budgetMs) {
      breaches.push(`${name}: p50 ${entry.latencyMs.p50} ms > budżet ${entry.budgetMs} ms`);
    }
  }
  return breaches;
}
