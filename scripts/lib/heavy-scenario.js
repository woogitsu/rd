// Scenariusz "heavy" testu wydajności (#217): trasy pominięte przez domyślny
// scenariusz load-test.js (lekkie odczyty jednego roku) — karty z sumami
// wielu lat, kartki dla całej szkoły, lista klasy XLSX, eksport księgi i
// paczka roczna, raport dla Komisji Rewizyjnej, dziennik zdarzeń z filtrem
// roku i listy z kursorem, pełny przepływ uzgodnienia rachunku, migawka
// odbiorców kampanii (bez wysyłki), import (podgląd i zapis) oraz zamknięcie
// roku z zestawieniem przekazania.
//
// Dane: kilka lat syntetycznej historii (buildHistoricalData) zamiast
// jednego roku z synthetic-seed.js — koszt tych tras rośnie z wiekiem
// systemu (historia lat, audit_events, korekty, uzgodnienia), czego seed
// jednego roku nie pokazuje. Uczniowie przechodzą między latami (rotacja:
// co roku ok. 1/4 odchodzi i tyle samo dochodzi), więc karta gospodarstwa
// sumuje kilka lat wpłat tej samej rodziny.
//
// Skala domyślna jest CELOWO mniejsza niż baseline z opisu issue #217 —
// pełny seed trwa dziesiątki sekund i spowalnia CI/PR (patrz "Ryzyko" w
// opisie issue: scenariusz ma być nocny, #111). Pełną skalę (HEAVY_FULL_SCALE:
// 5 lat, 50 klas/rok, 1000 uczniów/rok, 100 000 zdarzeń audytu, import 1000
// wierszy) włącza `--heavy-full`; pojedyncze wymiary — flagi `--heavy-*`.
//
// Zapisy (import, uzgodnienie, kampania — tylko migawka, eksport roczny,
// zamknięcie roku) wyłącznie lokalnie. Tryb zdalny (`readOnly: true`)
// wykonuje tylko operacje oznaczone `remoteSafe` (odczyty). Scenariusz nie
// wywołuje żadnej trasy `…/queue`, `…/approve`, `…/test-send` ani workera
// e-mail — nie może powstać żaden wiersz email_outbox.

import { createSessionSecret } from '../../src/auth.js';
import { insertRows, pad, q } from './synthetic-seed.js';

export const HEAVY_DEFAULTS = Object.freeze({
  years: 2, classesPerYear: 5, studentsPerYear: 40, auditEvents: 3000, importRows: 60,
});

// Baseline z opisu issue #217 (pomiar bazowy): 5 lat, 50 klas/rok,
// 1000 uczniów/rok (2000 łącznie przy rotacji 1/4), 100 000 zdarzeń audytu.
export const HEAVY_FULL_SCALE = Object.freeze({
  years: 5, classesPerYear: 50, studentsPerYear: 1000, auditEvents: 100_000, importRows: 1000,
});

// Progi orientacyjne (ms, p50 przebiegu sekwencyjnego), luźniejsze niż w
// opisie issue: kontener testowy jest współdzielony i przeciążony, więc czasy
// z tego środowiska nie są reprezentatywne dla Railway — budżety łapią tylko
// rażącą regresję (np. N+1 w pętli), nie mikroopóźnienia. Klucz = nazwa
// operacji; wariant z dopiskiem w nawiasie (np. granica roli) bez własnego
// wpisu dziedziczy budżet trasy bazowej.
export const HEAVY_ROUTE_BUDGETS_MS = Object.freeze({
  'GET /api/classes': 1500,
  'GET /api/classes/{id}/students': 1500,
  'GET /api/households/{id}': 1500,
  'GET /api/print/cards': 3000,
  'GET /api/exports/class-roster (xlsx)': 2000,
  'GET /api/ledger/export.csv': 3000,
  'GET /api/reports/audit': 3000,
  'GET /api/reports/audit (html)': 3000,
  'GET /api/admin/audit (finance, rok)': 3000,
  'GET /api/admin/audit (kursor, 5 stron)': 8000,
  'GET /api/payments (kursor, 5 stron)': 5000,
  'GET /api/reconciliations': 1500,
  'POST /api/reconciliations/{id}/lines': 5000,
  'GET /api/reconciliations/{id}': 2000,
  'GET /api/reconciliations/{id}/suggestions': 2000,
  'POST /api/exports': 15_000,
  'POST /api/email/campaigns/{id}/snapshot (no_payment_record)': 5000,
  'POST /api/email/campaigns/{id}/snapshot (all_households)': 8000,
  'POST /api/email/campaigns/{id}/snapshot (double click)': 12_000,
  'GET /api/email/campaigns/{id}/preview': 2000,
  'POST /api/import/preview': 8000,
  'POST /api/import/commit': 20_000,
  'POST /api/import/commit (double click)': 30_000,
  'POST /api/year-close/{id}/close': 5000,
  'GET /api/year-close/{id}/handover': 2000,
});

// Budżet przyrostu sterty procesu (MB, szczyt w trakcie trasy minus stan
// przed nią) — mierzony wyłącznie lokalnie (serwer w tym samym procesie;
// odpowiedź jest po stronie klienta tylko zliczana, nie buforowana). Eksport
// roczny jest strumieniowany (#216): 64 MB to próg z opisu issue #217
// (pomiar 30.09 w pełnej skali: ok. +18 MB przy paczce 9,3 MB).
export const HEAVY_ROUTE_HEAP_BUDGETS_MB = Object.freeze({
  'POST /api/exports': 64,
});

const CAMPAIGN_TEXT = 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. '
  + 'Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.';

const CHECKLIST_ITEMS = ['financial_report', 'audit_commission_report', 'minutes_approved', 'resolutions_archived',
  'reconciliation_confirmed', 'documents_handed_over'];

// Najnowszy rok zawiera dzisiejszą datę (kampanie i kartki liczą stan „na
// dziś”); starsze lata są wcześniejszymi rocznikami. Rok szkolny od 1.09.
function latestStartYear(today) {
  return today.getUTCMonth() >= 8 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
}

function yearBounds(startYear) {
  return { startsOn: `${startYear}-09-01`, endsOn: `${startYear + 1}-08-31` };
}

const pad2 = (n) => String(n).padStart(2, '0');
const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (isoDate, days) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// Liczba dni, na które rozkładane są daty wpłat i wpisów roku: do 180 dni od
// początku roku, w najnowszym roku nie dalej niż do dziś (bez dat przyszłych).
// Wpłaty w jednym dniu dawałyby sztucznie złośliwy przypadek propozycji
// dopasowań (każda pozycja wyciągu w oknie ±7 dni każdej wpłaty).
function spreadDays(startsOn, today, latest) {
  if (!latest) return 180;
  const elapsed = Math.floor((today.getTime() - Date.parse(`${startsOn}T00:00:00Z`)) / DAY_MS) + 1;
  return Math.max(1, Math.min(180, elapsed));
}
const classIdFor = (yearIndex, classIndex) => `hc${yearIndex}${pad(classIndex + 1)}`;
const studentIndex = (studentId) => Number(studentId.slice(2)) - 1;

// Zestaw historyczny: kilka lat, rotacja uczniów między latami, rodzeństwo w
// różnych klasach (co dziesiąte gospodarstwo), dwoje opiekunów na
// gospodarstwo, dobrowolne wpłaty częściowe (co trzecie gospodarstwo w dwóch
// ratach), brak wpisu wpłaty w części gospodarstw, korekty w każdym roku,
// wpisy księgi powiązane z wpłatami i wydatki, oraz zdarzenia audytu
// (generate_series po stronie bazy — szybciej niż wiersze JS).
export function buildHistoricalData({
  years = HEAVY_DEFAULTS.years, classesPerYear = HEAVY_DEFAULTS.classesPerYear,
  studentsPerYear = HEAVY_DEFAULTS.studentsPerYear, auditEvents = HEAVY_DEFAULTS.auditEvents,
  importRows = HEAVY_DEFAULTS.importRows, today = new Date(),
} = {}) {
  const firstStart = latestStartYear(today) - (years - 1);
  const yearIds = Array.from({ length: years }, (_, i) => `hy${pad(i + 1)}`);
  const schoolYears = yearIds.map((id, i) => {
    const start = firstStart + i;
    const { startsOn, endsOn } = yearBounds(start);
    return [id, `${start}/${pad2((start + 1) % 100)}`, startsOn, endsOn];
  });
  const latestYear = yearIds.at(-1);
  const latestIndex = years - 1;

  // Rotacja: uczeń j jest w szkole w roku y, gdy y*rotation <= j < y*rotation + studentsPerYear.
  const rotation = years > 1 ? Math.max(1, Math.ceil(studentsPerYear / 4)) : 0;
  const totalStudents = studentsPerYear + (years - 1) * rotation;
  const activeIn = (j, y) => y * rotation <= j && j < y * rotation + studentsPerYear;

  const classes = [];
  const ledgerCategories = [];
  for (let y = 0; y < years; y += 1) {
    for (let c = 0; c < classesPerYear; c += 1) {
      classes.push([classIdFor(y, c), yearIds[y], `Klasa historyczna ${y}-${pad(c + 1)}`]);
    }
    ledgerCategories.push([`hcat-income-${y}`, yearIds[y], 'income', 'Składki dobrowolne', 'hu-treasurer']);
    ledgerCategories.push([`hcat-expense-${y}`, yearIds[y], 'expense', 'Wydatki bieżące', 'hu-treasurer']);
  }

  const households = [];
  const householdStudents = new Map();
  const students = [];
  const studentHousehold = new Map();
  const enrollments = [];
  const studentClass = new Map(); // `${j}:${y}` → indeks klasy
  const guardians = [];
  const links = [];
  for (let j = 0, h = 0; j < totalStudents; h += 1) {
    const householdId = `hh${pad(h + 1)}`;
    households.push([householdId]);
    // Co dziesiąte gospodarstwo ma dwoje dzieci (sąsiednie numery → różne klasy).
    const count = (h + 1) % 10 === 0 && j + 1 < totalStudents ? 2 : 1;
    const ids = [];
    for (let s = 0; s < count; s += 1, j += 1) {
      const studentId = `hs${pad(j + 1)}`;
      ids.push(studentId);
      studentHousehold.set(j, householdId);
      students.push([studentId, householdId, `Uczeń historyczny ${pad(j + 1)}`, 'Syntetyczny']);
      for (let y = 0; y < years; y += 1) {
        if (!activeIn(j, y)) continue;
        const classIndex = (j + y) % classesPerYear;
        studentClass.set(`${j}:${y}`, classIndex);
        enrollments.push([`he${y}-${pad(j + 1)}`, studentId, classIdFor(y, classIndex), yearIds[y]]);
      }
    }
    householdStudents.set(householdId, ids);
    // Dwoje opiekunów na gospodarstwo (jeden główny). Co dwudzieste
    // gospodarstwo: pierwszy opiekun bez zgody na kontakt (wykluczenie w migawce).
    for (let g = 0; g < 2; g += 1) {
      const guardianId = `hg${pad(h + 1)}-${g}`;
      const contact = !(g === 0 && (h + 1) % 20 === 0);
      guardians.push([guardianId, householdId, `Opiekun historyczny ${pad(h + 1)}-${g}`, 'Syntetyczny',
        `opiekun-hist-${pad(h + 1)}-${g}@example.invalid`, String(contact)]);
      for (const studentId of ids) links.push([studentId, guardianId, String(contact), g === 0 ? 'true' : 'false']);
    }
  }

  // Wpłaty dobrowolne: gospodarstwo z dzieckiem w danym roku; co siódme
  // gospodarstwo-rok bez wpisu wpłaty (lista „brak wpisu” ma adresatów),
  // co trzecie w dwóch ratach (wpłaty częściowe).
  const payments = [];
  const paymentYears = [];
  const corrections = [];
  const ledgerEntries = [];
  for (let y = 0; y < years; y += 1) {
    const { startsOn } = yearBounds(firstStart + y);
    const spread = spreadDays(startsOn, today, y === latestIndex);
    const activeHouseholds = [];
    const seen = new Set();
    for (let j = 0; j < totalStudents; j += 1) {
      if (!activeIn(j, y)) continue;
      const householdId = studentHousehold.get(j);
      if (!seen.has(householdId)) { seen.add(householdId); activeHouseholds.push(householdId); }
    }
    const firstPaymentOfYear = payments.length;
    for (const [n, householdId] of activeHouseholds.entries()) {
      if ((n + y) % 7 === 3) continue;
      const parts = n % 3 === 0 ? 2 : 1;
      for (let p = 0; p < parts; p += 1) {
        const seq = payments.length + 1;
        const amount = String(1500 + (n % 4) * 500);
        const receivedOn = addDays(startsOn, (n * 7 + p * 30) % spread);
        payments.push([`hp${pad(seq)}`, householdId, yearIds[y], amount,
          receivedOn, 'bank', `REF-HIST-${pad(seq)}`, 'recorded', 'hu-treasurer', `heavy-payment-${pad(seq)}`]);
        paymentYears.push(yearIds[y]);
        // Co trzecia wpłata ma wpis księgi (przychód powiązany z wpłatą, kwota
        // równa wpłacie) — poza trzema pierwszymi wpłatami roku, które niżej dostają korektę.
        if (seq % 3 === 0 && seq - firstPaymentOfYear > 3) {
          ledgerEntries.push([`hle-p${pad(seq)}`, yearIds[y], 'income', amount, `hcat-income-${y}`,
            `Wpłata dobrowolna ${pad(seq)}`, receivedOn, 'bank', 'hu-treasurer', `heavy-ledger-p${pad(seq)}`, `hp${pad(seq)}`]);
        }
      }
    }
    // Korekta na kilku pierwszych wpłatach roku.
    for (const [paymentId] of payments.slice(firstPaymentOfYear, firstPaymentOfYear + 3)) {
      corrections.push([`hpc${corrections.length + 1}`, paymentId, '200', 'Korekta syntetyczna (historia)',
        'hu-treasurer', `heavy-correction-${corrections.length + 1}`]);
    }
    // Wydatki (bank) niepowiązane z wpłatami — do eksportu/raportu/uzgodnienia.
    const expenses = Math.max(5, Math.ceil(studentsPerYear / 10));
    for (let i = 0; i < expenses; i += 1) {
      ledgerEntries.push([`hle${y}-${pad(i + 1)}`, yearIds[y], 'expense', String(1000 + (i % 7) * 300), `hcat-expense-${y}`,
        `Wydatek historyczny ${y}-${pad(i + 1)}`, addDays(startsOn, (i * 11) % spread), 'bank', 'hu-treasurer', `heavy-ledger-${y}-${pad(i + 1)}`, null]);
    }
  }

  const users = [
    ['hu-admin', 'admin-hist@example.invalid', 'Administrator historyczny'],
    ['hu-board', 'board-hist@example.invalid', 'Zarząd historyczny'],
    ['hu-board2', 'board2-hist@example.invalid', 'Zarząd historyczny (druga osoba)'],
    ['hu-treasurer', 'treasurer-hist@example.invalid', 'Skarbnik historyczny'],
    ['hu-audit', 'audit-hist@example.invalid', 'Komisja Rewizyjna historyczna'],
    ['hu-rep', 'rep-hist@example.invalid', 'Przedstawiciel historyczny'],
  ];
  const grants = [
    ['hr1', 'hu-admin', 'admin', null, null],
    ['hr2', 'hu-board', 'board', null, null],
    ['hr2b', 'hu-board2', 'board', null, null],
    ['hr3', 'hu-audit', 'audit', null, null],
    // Skarbnik: przydział na każdy rok (przydział roczny, jak w kolejnych kadencjach).
    ...yearIds.map((yearId, i) => [`hr-t${i}`, 'hu-treasurer', 'treasurer', null, yearId]),
    ['hr-rep', 'hu-rep', 'representative', classIdFor(latestIndex, 0), latestYear],
  ];

  // Karta gospodarstwa z sumami wielu lat: gospodarstwo ucznia, który jest w
  // szkole w najnowszym roku i był w poprzednich.
  const latestHouseholdId = studentHousehold.get(Math.min(totalStudents - 1, latestIndex * rotation));
  // Gospodarstwo z rodzeństwem, oboje w najnowszym roku (liczba wierszy karty i kartek).
  let siblingHouseholdId = null;
  for (const [householdId, ids] of householdStudents) {
    if (ids.length === 2 && ids.every((id) => activeIn(studentIndex(id), latestIndex))) { siblingHouseholdId = householdId; break; }
  }
  // Gospodarstwo bez żadnego dziecka w klasie przedstawiciela (granica roli).
  let latestOtherHouseholdId = null;
  if (classesPerYear > 1) {
    for (const [householdId, ids] of householdStudents) {
      const indexes = ids.map(studentIndex);
      if (indexes.some((j) => activeIn(j, latestIndex))
        && indexes.every((j) => studentClass.get(`${j}:${latestIndex}`) !== 0)) { latestOtherHouseholdId = householdId; break; }
    }
  }

  return {
    yearIds, latestYear, schoolYears, classes, households, students, enrollments, guardians, links,
    payments, paymentYears, corrections, ledgerCategories, ledgerEntries, users, grants, auditEventCount: auditEvents,
    importRows, householdStudents, studentsPerYear, totalStudents,
    latestClassId: classIdFor(latestIndex, 0),
    latestClassNames: Array.from({ length: classesPerYear }, (_, c) => `Klasa historyczna ${latestIndex}-${pad(c + 1)}`),
    latestStartsOn: schoolYears.at(-1)[2],
    latestSpreadDays: spreadDays(schoolYears.at(-1)[2], today, true),
    latestHouseholdId, siblingHouseholdId, latestOtherHouseholdId,
    closeYearId: years > 1 ? yearIds[0] : null, closeNextYearId: years > 1 ? yearIds[1] : null,
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
    'occurred_on', 'method', 'created_by', 'idempotency_key', 'payment_entry_id'], data.ledgerEntries);

  // Informacja o przetwarzaniu danych (D-06) — wymagana przez zapis importu;
  // treść syntetyczna, nie jest decyzją szkoły.
  await db.query(
    `INSERT INTO privacy_notices (id, body_text, content_hash, decision_ref, status, created_by, approved_by, approved_at, published_by, published_at)
     VALUES ('hpn1', 'Syntetyczna informacja o przetwarzaniu danych (test wydajności).', repeat('a', 64), 'D-06/test-wydajnosci',
             'published', 'hu-board', 'hu-admin', now(), 'hu-admin', now())`,
  );

  // Zdarzenia audytu: generate_series po stronie bazy (issue #217 pkt 1).
  // Mieszanka jak w dzienniku kilkuletnim: 10% sesji (bez roku), 50% wpłat z
  // rokiem w metadanych, 30% wpłat i 10% wpisów księgi bez roku w metadanych
  // (starsze zdarzenia — filtr roku #174 przypisuje je do roku OBIEKTU, czyli
  // ścieżka najdroższa). Rozłożone na cały okres lat.
  if (data.auditEventCount > 0 && data.payments.length) {
    await db.query(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at, metadata_json)
       SELECT 'hae' || i, 'hu-treasurer',
              CASE WHEN i % 10 = 0 THEN 'session.created' WHEN i % 10 = 9 THEN 'ledger.entry.created' ELSE 'payment.created' END,
              CASE WHEN i % 10 = 0 THEN 'session' WHEN i % 10 = 9 THEN 'ledger_entry' ELSE 'payment_entry' END,
              CASE WHEN i % 10 = 0 THEN 'hsess' || i
                   WHEN i % 10 = 9 THEN ($3::text[])[1 + (i % cardinality($3::text[]))]
                   ELSE ($2::text[])[1 + (i % cardinality($2::text[]))] END,
              now() - make_interval(days => (i % $5::int)),
              CASE WHEN i % 10 BETWEEN 1 AND 5
                   THEN jsonb_build_object('schoolYearId', ($4::text[])[1 + (i % cardinality($2::text[]))])
                   ELSE '{}'::jsonb END
         FROM generate_series(1, $1::int) AS i`,
      [data.auditEventCount, data.payments.map(([id]) => id), data.ledgerEntries.map(([id]) => id), data.paymentYears,
        365 * data.yearIds.length],
    );
  }

  // Szkic uzgodnienia w najnowszym roku — karta/propozycje mają co pokazać
  // nawet przed importem pozycji w scenariuszu (POST .../lines dokłada resztę).
  const reconciliationId = 'hrec1';
  await db.query(
    `INSERT INTO bank_reconciliations (id, school_year_id, statement_date, statement_balance_cents,
       ledger_balance_cents, ledger_non_bank_cents, reference_salt, created_by, idempotency_key)
     VALUES ($1, $2, $3, 0, 0, 0, $4, 'hu-treasurer', 'heavy-reconciliation-draft')`,
    [reconciliationId, data.latestYear, `${data.latestStartsOn.slice(0, 4)}-09-30`,
      [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')],
  );
  // Statystyki planisty po wsadowym wstawieniu: bez ANALYZE PGlite (brak
  // autovacuum) szacuje po kilka wierszy na tabelę i wybiera pętle
  // zagnieżdżone, których PostgreSQL z autovacuum na Railway by nie wybrał —
  // pomiar i plany zapytań byłyby zawyżone i mylące.
  await db.exec('ANALYZE');
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

// ---------- instrumentacja env.db (#217 pkt 2) ----------

function normalizeSql(sql) {
  // Wyłącznie tekst zapytania (bez parametrów — parametry mogą zawierać dane).
  return String(sql).replace(/\s+/g, ' ').trim().slice(0, 160);
}

// Opakowuje klienta bazy (kontrakt src/db.js: query + transaction) i zbiera
// dla bieżącej operacji: liczbę zapytań i transakcji, łączny czas zapytań,
// najwolniejsze zapytanie oraz najdłuższą przerwę JS w transakcji (czas od
// początku transakcji lub końca poprzedniego zapytania do początku
// następnego — praca JS, która trzyma otwartą transakcję i jej blokady).
export function instrumentDb(db) {
  const fresh = () => ({ queries: 0, totalMs: 0, slowestMs: 0, slowestSql: null, transactions: 0, maxTxJsGapMs: 0 });
  let current = fresh();
  const record = (sql, ms) => {
    current.queries += 1;
    current.totalMs += ms;
    if (ms > current.slowestMs) { current.slowestMs = ms; current.slowestSql = normalizeSql(sql); }
  };
  const forward = (target, prop) => {
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const wrapTx = (tx) => {
    let lastEnd = performance.now();
    return new Proxy(tx, {
      get(target, prop) {
        if (prop !== 'query') return forward(target, prop);
        return async (sql, params) => {
          const started = performance.now();
          current.maxTxJsGapMs = Math.max(current.maxTxJsGapMs, started - lastEnd);
          try {
            return await target.query(sql, params);
          } finally {
            lastEnd = performance.now();
            record(sql, lastEnd - started);
          }
        };
      },
    });
  };
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === 'query') {
        return async (sql, params) => {
          const started = performance.now();
          try {
            return await target.query(sql, params);
          } finally {
            record(sql, performance.now() - started);
          }
        };
      }
      if (prop === 'transaction') {
        return (fn) => {
          current.transactions += 1;
          return target.transaction((tx) => fn(wrapTx(tx)));
        };
      }
      return forward(target, prop);
    },
  });
  return {
    db: wrapped,
    reset() { current = fresh(); },
    snapshot() {
      return {
        queries: current.queries, transactions: current.transactions,
        totalMs: Math.round(current.totalMs), slowestQueryMs: Math.round(current.slowestMs),
        slowestQuery: current.slowestSql, maxTxJsGapMs: Math.round(current.maxTxJsGapMs),
      };
    },
  };
}

// ---------- operacje ----------

const IMPORT_COLUMNS = ['studentId', 'firstName', 'lastName', 'className', 'householdId', 'guardian1', 'email1', 'guardian2', 'email2'];

// Wiersze importu: nowi uczniowie najnowszego roku, co dziesiąte gospodarstwo
// z rodzeństwem, dwoje opiekunów w każdym wierszu. `prefix` odróżnia paczki.
export function importRowsFor(prefix, count, classNames) {
  const rows = [];
  for (let i = 0, h = 0; i < count; h += 1) {
    const kids = (h + 1) % 10 === 0 && i + 1 < count ? 2 : 1;
    for (let k = 0; k < kids; k += 1, i += 1) {
      rows.push([`${prefix}-s${pad(i + 1)}`, 'Uczeń', `Importowany ${pad(i + 1)}`, classNames[i % classNames.length],
        `${prefix}-h${pad(h + 1)}`, `Opiekun ${pad(h + 1)}-A`, `${prefix}-${pad(h + 1)}-a@example.invalid`,
        `Opiekun ${pad(h + 1)}-B`, `${prefix}-${pad(h + 1)}-b@example.invalid`]);
    }
  }
  return rows;
}

// Lista operacji. Pola: `role` (aktor), `path`/`body` (stałe albo funkcja
// stanu z `setup`), `setup` (przygotowanie niemierzone), `measure` (własny
// pomiar, np. podwójne kliknięcie), `pages` (lista z kursorem), `writes`
// (zmienia dane — wyłącznie lokalnie, bez fazy równoczesnej), `remoteSafe`
// (odczyt dopuszczony w trybie zdalnym), `needs` (wymagane identyfikatory),
// `once` (jedno wywołanie), `expect` (oczekiwane kody HTTP).
function heavyOperations(ids) {
  const {
    latestYear, classId, householdId, otherHouseholdId, reconciliationId, lineDate, lineSpreadDays,
    classNames, importRows, closeYearId, closeNextYearId, campaignId,
  } = ids;
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const year = encodeURIComponent(latestYear ?? '');
  const ops = [
    { name: 'GET /api/classes', role: 'board', path: '/api/classes', remoteSafe: true },
    { name: 'GET /api/classes/{id}/students', role: 'board', path: `/api/classes/${classId}/students`, needs: [classId], remoteSafe: true },
    { name: 'GET /api/households/{id}', role: 'treasurer', path: `/api/households/${householdId}`, needs: [householdId], remoteSafe: true },
    { name: 'GET /api/print/cards', role: 'board', path: `/api/print/cards?schoolYearId=${year}`, remoteSafe: true },
    {
      name: 'GET /api/exports/class-roster (xlsx)', role: 'representative',
      path: `/api/exports/class-roster?classId=${classId}&format=xlsx`, needs: [classId], remoteSafe: true,
    },
    { name: 'GET /api/ledger/export.csv', role: 'treasurer', path: `/api/ledger/export.csv?schoolYearId=${year}`, remoteSafe: true },
    { name: 'GET /api/reports/audit', role: 'audit', path: `/api/reports/audit?schoolYearId=${year}&format=json`, remoteSafe: true },
    { name: 'GET /api/reports/audit (html)', role: 'audit', path: `/api/reports/audit?schoolYearId=${year}&format=html`, remoteSafe: true },
    // Dziennik zdarzeń z filtrem roku (#174/#181): domena finansów, rok z metadanych albo obiektu.
    {
      name: 'GET /api/admin/audit (finance, rok)', role: 'admin',
      path: `/api/admin/audit?domain=finance&schoolYearId=${year}&limit=100`, remoteSafe: true,
    },
    // Listy z kursorem keyset (#159): 5 kolejnych stron.
    {
      name: 'GET /api/admin/audit (kursor, 5 stron)', role: 'admin', remoteSafe: true,
      pages: { path: `/api/admin/audit?domain=finance&schoolYearId=${year}&limit=100`, count: 5 },
    },
    {
      name: 'GET /api/payments (kursor, 5 stron)', role: 'treasurer', remoteSafe: true,
      pages: { path: `/api/payments?schoolYearId=${year}&limit=50`, count: 5 },
    },
    { name: 'GET /api/reconciliations', role: 'treasurer', path: `/api/reconciliations?schoolYearId=${year}`, remoteSafe: true },
    {
      name: 'POST /api/reconciliations/{id}/lines', method: 'POST', role: 'treasurer', writes: true, needs: [reconciliationId],
      path: `/api/reconciliations/${reconciliationId}/lines`, key: `heavy-lines-${run}`,
      // Pozycje wyciągu rozłożone na dni roku (jak wpłaty), kwoty jak wpłaty i wydatki.
      body: {
        lines: Array.from({ length: 200 }, (_, i) => ({
          bookedOn: addDays(lineDate, (i * 3) % Math.max(1, lineSpreadDays)), amountCents: 1500 + (i % 4) * 500,
        })),
      },
      expect: [201, 200],
    },
    { name: 'GET /api/reconciliations/{id}', role: 'treasurer', path: `/api/reconciliations/${reconciliationId}`, needs: [reconciliationId], remoteSafe: true },
    {
      name: 'GET /api/reconciliations/{id}/suggestions', role: 'treasurer',
      path: `/api/reconciliations/${reconciliationId}/suggestions`, needs: [reconciliationId], remoteSafe: true,
    },
    // Granica ról (#217, testy do dodania): przedstawiciel poza swoją klasą i
    // na eksporcie rocznym — 403/404 jest oczekiwanym wynikiem, nie błędem.
    {
      name: 'GET /api/households/{id} (representative, out of scope)', role: 'representative',
      path: `/api/households/${otherHouseholdId}`, needs: [otherHouseholdId], expect: [403, 404], remoteSafe: true,
    },
    {
      name: 'POST /api/exports (representative, 403)', method: 'POST', role: 'representative', writes: true,
      path: '/api/exports', body: { schoolYearId: latestYear }, expect: [403, 404],
    },
    // Paczka roczna (#216 w toku zmienia src/pg/export.js — tu tylko pomiar).
    { name: 'POST /api/exports', method: 'POST', role: 'board', writes: true, path: '/api/exports', body: { schoolYearId: latestYear } },
  ];

  // Kampanie: wyłącznie szkic i migawka odbiorców (bez zatwierdzenia i kolejki).
  const campaignSetup = (audience) => async (call, shared) => {
    const { status, json } = await call('board', 'POST', '/api/email/campaigns', {
      key: `heavy-campaign-${audience}-${run}`,
      body: {
        schoolYearId: latestYear, title: `Kampania syntetyczna ${audience}`, audience,
        subject: 'Dobrowolna składka {rok}', bodyText: CAMPAIGN_TEXT,
      },
    });
    const id = json?.campaign?.id ?? json?.id;
    if (status !== 201 || !id) throw new Error(`campaign setup ${audience}: HTTP ${status}`);
    shared.lastCampaignId = id;
    return { campaignId: id };
  };
  for (const audience of ['no_payment_record', 'all_households']) {
    ops.push({
      name: `POST /api/email/campaigns/{id}/snapshot (${audience})`, method: 'POST', role: 'board', writes: true,
      setup: campaignSetup(audience), path: (state) => `/api/email/campaigns/${state.campaignId}/snapshot`, body: {},
    });
  }
  // Podgląd kampanii z migawką (lokalnie: ostatnia kampania z kroku wyżej).
  ops.push({
    name: 'GET /api/email/campaigns/{id}/preview', role: 'board', writes: true,
    setup: async (_call, shared) => ({ campaignId: shared.lastCampaignId }),
    path: (state) => `/api/email/campaigns/${state.campaignId}/preview`,
  });
  // Podwójne kliknięcie migawki: dwa równoległe żądania → jedna spójna migawka.
  ops.push({
    name: 'POST /api/email/campaigns/{id}/snapshot (double click)', role: 'board', writes: true, once: true,
    setup: async (_call, shared) => ({ campaignId: shared.lastCampaignId }),
    measure: async (call, state) => {
      const [a, b] = await Promise.all([0, 1].map(() => call('board', 'POST', `/api/email/campaigns/${state.campaignId}/snapshot`, { body: {} })));
      const ok = a.status === 200 && b.status === 200 && a.json?.recipientsHash === b.json?.recipientsHash
        && a.json?.recipientsCount === b.json?.recipientsCount;
      return { bytes: a.bytes + b.bytes, error: ok ? null : `double click snapshot: ${a.status}/${b.status}` };
    },
  });
  if (campaignId) {
    // Tryb zdalny: podgląd istniejącej kampanii z migawką (LOAD_TEST_CAMPAIGN_ID).
    ops.push({
      name: 'GET /api/email/campaigns/{id}/preview (remote)', role: 'board',
      path: `/api/email/campaigns/${encodeURIComponent(campaignId)}/preview`, remoteSafe: true, remoteOnly: true,
    });
  }

  // Import: podgląd (N razy) i zapis jednej paczki; potem podwójne kliknięcie
  // zapisu innej paczki i ponowienie tym samym kluczem (200, replay).
  const payloadFor = (prefix) => ({
    version: 1, schoolYearId: latestYear, columns: [...IMPORT_COLUMNS], rows: importRowsFor(prefix, importRows, classNames),
  });
  const importPrefix = `imp${run}`;
  ops.push({ name: 'POST /api/import/preview', method: 'POST', role: 'board', writes: true, path: '/api/import/preview', body: payloadFor(importPrefix) });
  const previewed = (prefix) => async (call) => {
    const payload = payloadFor(prefix);
    const { status, json } = await call('board', 'POST', '/api/import/preview', { body: payload });
    if (status !== 200) throw new Error(`import preview setup: HTTP ${status}`);
    return { body: { ...payload, fingerprint: json.fingerprint, planDigest: json.planDigest } };
  };
  ops.push({
    name: 'POST /api/import/commit', method: 'POST', role: 'board', writes: true, once: true,
    setup: previewed(importPrefix), path: '/api/import/commit', key: `heavy-import-${run}`, body: (state) => state.body, expect: [201],
  });
  ops.push({
    name: 'POST /api/import/commit (double click)', role: 'board', writes: true, once: true,
    setup: previewed(`dbl${run}`),
    measure: async (call, state) => {
      const key = `heavy-import-dbl-${run}`;
      const pair = await Promise.all([0, 1].map(() => call('board', 'POST', '/api/import/commit', { key, body: state.body })));
      const statuses = pair.map((r) => r.status).sort();
      const batchIds = new Set(pair.map((r) => r.json?.batchId));
      // Ponowienie po zerwaniu połączenia: ten sam klucz → 200 i zapisany wynik.
      const replay = await call('board', 'POST', '/api/import/commit', { key, body: state.body });
      const ok = statuses[0] === 200 && statuses[1] === 201 && batchIds.size === 1 && !batchIds.has(undefined)
        && replay.status === 200 && replay.json?.replayed === true && replay.json?.batchId === pair[0].json?.batchId;
      return {
        bytes: pair[0].bytes + pair[1].bytes,
        error: ok ? null : `double click import: ${statuses.join('/')}, replay ${replay.status}, batches ${batchIds.size}`,
      };
    },
  });

  // Zamknięcie najstarszego roku (inna osoba niż rozpoczynająca) i zestawienie przekazania.
  if (closeYearId) {
    ops.push({
      name: 'POST /api/year-close/{id}/close', method: 'POST', role: 'board2', writes: true, once: true,
      path: `/api/year-close/${closeYearId}/close`, body: (state) => state.body, expect: [200],
      setup: async (call) => {
        const started = await call('board', 'POST', `/api/year-close/${closeYearId}/start`, { body: { nextSchoolYearId: closeNextYearId } });
        if (![200, 201].includes(started.status)) throw new Error(`year close start: HTTP ${started.status}`);
        for (const item of CHECKLIST_ITEMS) {
          const confirmed = await call('treasurer', 'POST', `/api/year-close/${closeYearId}/checklist/${item}`, { body: { note: 'Potwierdzenie syntetyczne' } });
          if (![200, 201].includes(confirmed.status)) throw new Error(`year close checklist ${item}: HTTP ${confirmed.status}`);
        }
        const status = await call('board', 'GET', `/api/year-close/${closeYearId}`);
        const check = status.json?.yearEndCheck;
        // Rozbieżność salda końca roku w danych syntetycznych: jawne potwierdzenie (#169).
        const body = check && !check.ok ? {
          confirmYearEndDiscrepancy: {
            reason: 'explained_outside_system', balanceDifferenceCents: check.balanceDifferenceCents,
            cashDifferenceCents: check.cashDifferenceCents,
          },
        } : {};
        return { body };
      },
    });
    ops.push({ name: 'GET /api/year-close/{id}/handover', role: 'board', path: `/api/year-close/${closeYearId}/handover`, writes: true });
  }
  return ops;
}

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function latencyOf(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: Math.round(quantile(sorted, 0.5)), p95: Math.round(quantile(sorted, 0.95)), max: Math.round(sorted.at(-1) ?? 0) };
}

const MB = 1024 * 1024;
const roundMb = (bytes) => Math.round((bytes / MB) * 10) / 10;

// Próbkowanie pamięci procesu w trakcie operacji (serwer lokalny działa w tym
// samym procesie, więc to pamięć serwera + klienta testu). Próbki co 5 ms —
// szczyt w długim synchronicznym kawałku pracy może zostać niedoszacowany.
function memorySampler() {
  const before = process.memoryUsage();
  let peakHeap = before.heapUsed;
  let peakRss = before.rss;
  const sample = () => {
    const now = process.memoryUsage();
    peakHeap = Math.max(peakHeap, now.heapUsed);
    peakRss = Math.max(peakRss, now.rss);
  };
  const timer = setInterval(sample, 5);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      sample();
      return { heapDeltaMb: roundMb(peakHeap - before.heapUsed), peakHeapUsedMb: roundMb(peakHeap), peakRssMb: roundMb(peakRss) };
    },
  };
}

// Opis błędu sieci bez danych: nazwa/kod (np. UND_ERR_SOCKET, ECONNRESET), nie treść odpowiedzi.
function describeFailure(error) {
  if (error?.name === 'TimeoutError') return 'timeout';
  const code = error?.cause?.code ?? error?.cause?.name;
  return `${String(error?.message ?? error)}${code ? ` (${code})` : ''}`;
}

function budgetFor(name) {
  return HEAVY_ROUTE_BUDGETS_MS[name] ?? HEAVY_ROUTE_BUDGETS_MS[name.replace(/ \(.*\)$/, '')] ?? null;
}

function heapBudgetFor(name) {
  return HEAVY_ROUTE_HEAP_BUDGETS_MB[name] ?? null;
}

// Uruchamia każdą trasę: odczyty `iterations` razy sekwencyjnie, potem przy
// `concurrency` równoczesnych żądaniach (tyle samo rund); zapisy raz albo
// `iterations` razy z nowym kluczem. Wynik: p50/p95/max, rozmiar odpowiedzi,
// pamięć (lokalnie), zapytania SQL (lokalnie, `dbStats` z instrumentDb) i
// maks. opóźnienie pętli zdarzeń.
export async function runHeavyScenario({
  baseUrl, actors, latestYear, classId, householdId, otherHouseholdId, reconciliationId,
  classNames = [], importRows = HEAVY_DEFAULTS.importRows, closeYearId = null, closeNextYearId = null,
  lineDate = new Date().toISOString().slice(0, 10), lineSpreadDays = 1, campaignId = null,
  iterations = 3, concurrency = 5, timeoutMs = 20_000, readOnly = false, dbStats = null, log = () => {},
}) {
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  const loopDelay = monitorEventLoopDelay({ resolution: 5 });
  loopDelay.enable();

  const origin = new URL(baseUrl).origin;
  const byRole = new Map();
  for (const actor of actors) {
    // Druga osoba zarządu (zasada czterech oczu przy zamknięciu roku).
    const role = actor.role === 'board' && byRole.has('board') ? 'board2' : actor.role;
    if (!byRole.has(role)) byRole.set(role, actor);
  }
  // `slot` wybiera jedną z kilku sesji tej samej osoby (lokalnie: `actor.cookies`),
  // żeby faza równoczesna odpowiadała kilku osobom, a nie jednej sesji, którą
  // limiter kosztownych tras (src/rate-limit.js, heavyConcurrency) ogranicza do 2 naraz.
  // `parse: false` (pomiar zwykłej trasy): odpowiedź jest tylko zliczana
  // strumieniowo, bez trzymania całej treści i bez JSON.parse — inaczej 9 MB
  // paczki rocznej zawyżałoby przyrost sterty „serwera” pracą klienta testu.
  const call = async (role, method, path, { body, key, slot = 0, parse = true } = {}) => {
    const actor = byRole.get(role);
    if (!actor) throw new Error(`no actor for role ${role}`);
    const cookie = actor.cookies?.length ? actor.cookies[slot % actor.cookies.length] : actor.cookie;
    const headers = { Cookie: cookie };
    if (method !== 'GET') headers.Origin = origin;
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!parse) {
      let bytes = 0;
      if (response.body) for await (const chunk of response.body) bytes += chunk.byteLength;
      return { status: response.status, bytes, json: null };
    }
    const buffer = await response.arrayBuffer();
    let json = null;
    if ((response.headers.get('content-type') ?? '').includes('json')) {
      try { json = JSON.parse(new TextDecoder().decode(buffer)); } catch { json = null; }
    }
    return { status: response.status, bytes: buffer.byteLength, json };
  };

  const ops = heavyOperations({
    latestYear, classId, householdId, otherHouseholdId, reconciliationId, classNames, importRows,
    closeYearId, closeNextYearId, campaignId, lineDate, lineSpreadDays,
  });
  const byOperation = {};
  const skipped = [];
  const shared = {};
  let peakHeapUsedMb = roundMb(process.memoryUsage().heapUsed);
  let peakRssMb = roundMb(process.memoryUsage().rss);
  let maxLoopDelayMs = 0;

  const measureOnce = async (op, state, i, slot = 0) => {
    if (op.measure) return op.measure(call, state);
    if (op.pages) {
      let path = op.pages.path;
      let bytes = 0;
      for (let page = 0; page < op.pages.count && path; page += 1) {
        const result = await call(op.role, 'GET', path, { slot });
        bytes += result.bytes;
        if (result.status !== 200) return { bytes, status: result.status, error: `page ${page + 1}: HTTP ${result.status}` };
        const next = result.json?.nextCursor;
        path = next ? `${op.pages.path}&cursor=${encodeURIComponent(next)}` : null;
      }
      return { bytes, error: null };
    }
    const path = typeof op.path === 'function' ? op.path(state) : op.path;
    const body = typeof op.body === 'function' ? op.body(state) : op.body;
    const key = op.key ? (i === 0 ? op.key : `${op.key}-${i}`) : undefined;
    const result = await call(op.role, op.method ?? 'GET', path, { body, key, slot, parse: false });
    const expected = op.expect ?? [200, 201];
    return { bytes: result.bytes, status: result.status, error: expected.includes(result.status) ? null : `HTTP ${result.status}` };
  };

  for (const op of ops) {
    if (readOnly && !op.remoteSafe) continue;
    if (!readOnly && op.remoteOnly) continue;
    if (!byRole.has(op.role)) { skipped.push(`${op.name}: brak sesji roli ${op.role}`); log(`pomijam ${op.name}: brak aktora roli ${op.role}`); continue; }
    if (op.needs?.some((value) => !value)) { skipped.push(`${op.name}: brak identyfikatora obiektu`); continue; }
    const base = { budgetMs: budgetFor(op.name), heapBudgetMb: heapBudgetFor(op.name) };
    let state = {};
    try {
      if (op.setup) state = (await op.setup(call, shared)) ?? {};
    } catch (error) {
      byOperation[op.name] = {
        requests: 0, errors: 1, errorSamples: [`setup: ${error.message}`], latencyMs: { p50: 0, p95: 0, max: 0 }, responseBytes: 0, ...base,
      };
      continue;
    }
    const runs = op.once ? 1 : iterations;
    const latencies = [];
    const errorSamples = [];
    let errors = 0;
    let bytes = 0;
    dbStats?.reset();
    loopDelay.reset();
    const memory = readOnly ? null : memorySampler();
    for (let i = 0; i < runs; i += 1) {
      const started = performance.now();
      try {
        const outcome = await measureOnce(op, state, i);
        bytes += outcome.bytes;
        if (outcome.error) { errors += 1; if (errorSamples.length < 3) errorSamples.push(outcome.error); }
      } catch (error) {
        errors += 1;
        if (errorSamples.length < 3) errorSamples.push(describeFailure(error));
      }
      latencies.push(performance.now() - started);
    }
    const mem = memory?.stop() ?? null;
    const db = dbStats?.snapshot() ?? null;
    // Maks. opóźnienie pętli zdarzeń w przebiegu sekwencyjnym tej trasy — lokalnie
    // to blokada serwera (praca JS w tym samym procesie), zdalnie tylko klienta.
    const opLoopDelayMs = Math.round(loopDelay.max / 1e6);
    maxLoopDelayMs = Math.max(maxLoopDelayMs, opLoopDelayMs);
    if (mem) {
      peakHeapUsedMb = Math.max(peakHeapUsedMb, mem.peakHeapUsedMb);
      peakRssMb = Math.max(peakRssMb, mem.peakRssMb);
    }

    // Równoczesność (#217 pkt 2: 5 równoczesnych): tylko odczyty bez własnej
    // logiki. PGlite szereguje zapytania (#208) — wynik lokalny pokazuje
    // kolejkowanie, nie skalowanie; budżet dotyczy przebiegu sekwencyjnego.
    let concurrent = null;
    if (!op.writes && !op.measure && !op.setup && concurrency > 1) {
      const samples = [];
      const concurrentSamples = [];
      let concurrentErrors = 0;
      let rateLimited = 0;
      for (let round = 0; round < iterations; round += 1) {
        await Promise.all(Array.from({ length: concurrency }, async (_, slot) => {
          const started = performance.now();
          try {
            const outcome = await measureOnce(op, state, 0, slot);
            // 429 z limitera równoczesnych kosztownych żądań jednej sesji (zdalnie
            // jedna sesja na rolę) to zamierzona ochrona, nie błąd trasy — liczony osobno.
            if (outcome.status === 429) rateLimited += 1;
            else if (outcome.error) {
              concurrentErrors += 1;
              if (concurrentSamples.length < 3) concurrentSamples.push(outcome.error);
            }
          } catch (error) {
            concurrentErrors += 1;
            if (concurrentSamples.length < 3) concurrentSamples.push(describeFailure(error));
          }
          samples.push(performance.now() - started);
        }));
      }
      errors += concurrentErrors;
      if (concurrentErrors) errorSamples.push(`${concurrentErrors} błędów przy ${concurrency} równoczesnych: ${concurrentSamples.join(', ')}`);
      concurrent = { concurrency, requests: samples.length, errors: concurrentErrors, rateLimited, latencyMs: latencyOf(samples) };
      maxLoopDelayMs = Math.max(maxLoopDelayMs, Math.round(loopDelay.max / 1e6));
    }

    byOperation[op.name] = {
      requests: runs, errors,
      ...(errorSamples.length ? { errorSamples } : {}),
      latencyMs: latencyOf(latencies),
      responseBytes: Math.round(bytes / runs),
      maxEventLoopDelayMs: opLoopDelayMs,
      ...base,
      ...(concurrent ? { concurrent } : {}),
      ...(mem ? { memory: mem } : {}),
      ...(db ? { db } : {}),
    };
  }

  loopDelay.disable();
  return {
    byOperation,
    skipped,
    peakHeapUsedMb: Math.round(peakHeapUsedMb * 10) / 10,
    peakRssMb: Math.round(peakRssMb * 10) / 10,
    maxEventLoopDelayMs: Math.max(maxLoopDelayMs, Math.round(loopDelay.max / 1e6)),
  };
}

export function checkHeavyBudgets(byOperation) {
  const breaches = [];
  for (const [name, entry] of Object.entries(byOperation)) {
    if (entry.errors > 0) {
      const detail = entry.errorSamples?.length ? ` (${entry.errorSamples.join('; ')})` : '';
      breaches.push(`${name}: ${entry.errors} błędnych odpowiedzi${detail}`);
    }
    if (entry.budgetMs !== null && entry.budgetMs !== undefined && entry.latencyMs.p50 > entry.budgetMs) {
      breaches.push(`${name}: p50 ${entry.latencyMs.p50} ms > budżet ${entry.budgetMs} ms`);
    }
    if (entry.heapBudgetMb && entry.memory && entry.memory.heapDeltaMb > entry.heapBudgetMb) {
      breaches.push(`${name}: przyrost sterty ${entry.memory.heapDeltaMb} MB > budżet ${entry.heapBudgetMb} MB`);
    }
  }
  return breaches;
}
