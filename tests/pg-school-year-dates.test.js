// Data wpisu księgi i wpłaty w granicach roku szkolnego (#169) oraz
// kontrole krzyżowe raportu KR. PGlite, wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { renderAuditReportHtml } from '../src/pg/audit-report.js';
import { createTestDb, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const BASE = 'https://rd.example';
const YEAR = 'y-2026'; // 2026-09-01 .. 2027-08-31

function request(cookie, path, { body, key } = {}) {
  const method = body === undefined ? 'GET' : 'POST';
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (method === 'POST') {
    headers.set('Origin', BASE);
    headers.set('Content-Type', 'application/json');
  }
  if (key) headers.set('Idempotency-Key', key);
  return new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR);
  const treasurer = await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const rep = await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] });
  const audit = await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] });
  const board = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] });
  for (const householdId of ['h-1', 'h-2']) await seedEnrolledHousehold(db, householdId, [YEAR]);
  await db.exec(`
    INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
      ('cat-in', '${YEAR}', 'income', 'Składki dobrowolne', 'u-treasurer'),
      ('cat-out', '${YEAR}', 'expense', 'Wydarzenia', 'u-treasurer');
  `);
  const env = { db };
  const call = async (cookie, path, options) => {
    const response = await handlePgRequest(request(cookie, path, options), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { db, call, cookies: { treasurer, rep, audit, board } };
}

const entry = (occurredOn, extra = {}) => ({
  schoolYearId: YEAR, direction: 'expense', amountCents: 12345, categoryId: 'cat-out',
  description: 'Wydatek syntetyczny', occurredOn, method: 'bank', ...extra,
});
const payment = (receivedOn, extra = {}) => ({
  schoolYearId: YEAR, householdId: 'h-1', amountCents: 3000, receivedOn, method: 'bank', ...extra,
});
const count = async (db, table) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

test('odtworzenie z #169: wydatek z 2072 i wpłata z 1926 dają 422 i niczego nie zapisują', async () => {
  const { db, call, cookies } = await setup();
  try {
    const ledger = await call(cookies.treasurer, '/api/ledger', { body: entry('2072-09-20'), key: 'le-2072-0001' });
    assert.equal(ledger.status, 422);
    assert.equal(ledger.body.error, 'date_outside_school_year');
    const paid = await call(cookies.treasurer, '/api/payments', { body: payment('1926-09-20'), key: 'pay-1926-0001' });
    assert.equal(paid.status, 422);
    assert.equal(paid.body.error, 'date_outside_school_year');
    assert.equal(await count(db, 'ledger_entries'), 0);
    assert.equal(await count(db, 'payment_entries'), 0);
    // Ponowienie z tym samym kluczem: nadal 422, brak zapisu (podwójne kliknięcie).
    const again = await call(cookies.treasurer, '/api/ledger', { body: entry('2072-09-20'), key: 'le-2072-0001' });
    assert.equal(again.status, 422);
    assert.equal(await count(db, 'ledger_entries'), 0);
    const summary = await call(cookies.treasurer, `/api/ledger/summary?schoolYearId=${YEAR}`);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.summary?.expenseCents ?? summary.body.expenseCents, 0);
    // Zdarzenia audytu nie powstały dla odrzuconych zapisów.
    const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action IN ('ledger.entry.created', 'payment.created')");
    assert.equal(rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('granice roku: starts_on i ends_on przyjęte, dzień przed i po odrzucony (API)', async () => {
  const { db, call, cookies } = await setup();
  try {
    for (const [date, status] of [['2026-09-01', 201], ['2027-08-31', 201], ['2026-08-31', 422], ['2027-09-01', 422]]) {
      const ledger = await call(cookies.treasurer, '/api/ledger', { body: entry(date), key: `le-edge-${date}` });
      assert.equal(ledger.status, status, `wpis ${date}`);
      const paid = await call(cookies.treasurer, '/api/payments', { body: payment(date), key: `pay-edge-${date}` });
      assert.equal(paid.status, status, `wpłata ${date}`);
    }
    assert.equal(await count(db, 'ledger_entries'), 2);
    assert.equal(await count(db, 'payment_entries'), 2);
    // Wpłata z ostatniego dnia sierpnia w roku, który się kończy, jest przyjęta;
    // przedstawiciel klasy nadal nie ma dostępu do wpłat (403 przed walidacją daty).
    const repPayment = await call(cookies.rep, '/api/payments', { body: payment('2027-08-30'), key: 'pay-rep-00001' });
    assert.equal(repPayment.status, 403);
    const repOutside = await call(cookies.rep, '/api/payments', { body: payment('2072-08-30'), key: 'pay-rep-00002' });
    assert.equal(repOutside.status, 403);
  } finally {
    await db.close();
  }
});

test('baza odrzuca bezpośredni INSERT z datą spoza roku; zamknięty rok nadal daje school_year_closed', async () => {
  const { db } = await setup();
  try {
    await assert.rejects(db.query(
      `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
         occurred_on, method, created_by, idempotency_key)
       VALUES ('le-x', $1, 'expense', 100, 'cat-out', 'Wpis bezpośredni', '2027-09-01', 'bank', 'u-treasurer', 'direct-le-0001')`,
      [YEAR],
    ), /date_outside_school_year/);
    await assert.rejects(db.query(
      `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status,
         created_by, idempotency_key)
       VALUES ('p-x', 'h-1', $1, 100, '2026-08-31', 'cash', 'recorded', 'u-treasurer', 'direct-pay-0001')`,
      [YEAR],
    ), /date_outside_school_year/);
    // Odtworzenie istniejących danych (import D1) przenosi historyczne wiersze bez zmian.
    await db.transaction(async (tx) => {
      await tx.query("SET LOCAL rd.restore = 'on'");
      await tx.query(
        `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status,
           created_by, idempotency_key)
         VALUES ('p-legacy', 'h-1', $1, 100, '2026-08-31', 'cash', 'recorded', 'u-treasurer', 'legacy-pay-0001')`,
        [YEAR],
      );
    });
    const { rows } = await db.query('SELECT kind, id FROM school_year_date_deviations');
    assert.deepEqual(rows, [{ kind: 'payment_entry', id: 'p-legacy' }]);
    // Poza transakcją odtworzenia ustawienie nie obowiązuje.
    await assert.rejects(db.query(
      `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status,
         created_by, idempotency_key)
       VALUES ('p-y', 'h-1', $1, 100, '2026-08-31', 'cash', 'recorded', 'u-treasurer', 'direct-pay-0002')`,
      [YEAR],
    ), /date_outside_school_year/);
  } finally {
    await db.close();
  }
});

test('trigger daty działa po zamrożeniu roku: zamknięty rok daje 409 school_year_closed, nie 422', async () => {
  const { db, call, cookies } = await setup();
  try {
    await seedSchoolYear(db, 'y-2027', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
    // Stan „zamknięty” wprost (bez przebiegu zamknięcia): tylko na potrzeby kolejności triggerów.
    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
        closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
        carried_opening_balance_id, expired_grant_count)
      VALUES ('cl-1', '${YEAR}', 'y-2027', 'closed', 'u-treasurer', 'u-audit', now(), 0, 0, 0, 0, 'ob-x', 0);
      SET session_replication_role = origin;
    `);
    const response = await call(cookies.treasurer, '/api/ledger', { body: entry('2072-09-20'), key: 'le-closed-0001' });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'school_year_closed');
  } finally {
    await db.close();
  }
});

async function seedLegacyOutOfRange(db) {
  // Wiersze sprzed migracji 0027 (symulacja: odtworzenie z rd.restore).
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL rd.restore = 'on'");
    await tx.query(
      `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
         occurred_on, method, created_by, idempotency_key)
       VALUES ('le-2072', $1, 'expense', 12345, 'cat-out', 'Literówka w roku', '2072-09-20', 'bank', 'u-treasurer', 'legacy-le-0001')`,
      [YEAR],
    );
    await tx.query(
      `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status,
         created_by, idempotency_key)
       VALUES ('p-1926', 'h-2', $1, 3000, '1926-09-20', 'bank', 'recorded', 'u-treasurer', 'legacy-pay-1926')`,
      [YEAR],
    );
  });
}

test('raport KR: kontrole krzyżowe wykrywają wpis spoza roku i wpłatę bez ujęcia w księdze', async () => {
  const { db, call, cookies } = await setup();
  try {
    // Dwoje rodzeństwa w jednym gospodarstwie wpłaca częściowo: dwie wpłaty h-1, jedna ujęta w księdze.
    const p1 = await call(cookies.treasurer, '/api/payments', { body: payment('2026-09-10', { amountCents: 2000 }), key: 'pay-part-0001' });
    const p2 = await call(cookies.treasurer, '/api/payments', { body: payment('2026-09-12', { amountCents: 1000 }), key: 'pay-part-0002' });
    assert.equal(p1.status, 201);
    assert.equal(p2.status, 201);
    const linked = await call(cookies.treasurer, '/api/ledger', {
      body: entry('2026-09-10', { direction: 'income', categoryId: 'cat-in', amountCents: 2000, paymentEntryId: p1.body.payment.id }),
      key: 'le-link-00001',
    });
    assert.equal(linked.status, 201);
    await seedLegacyOutOfRange(db);

    const response = await call(cookies.audit, `/api/reports/audit?schoolYearId=${YEAR}`);
    assert.equal(response.status, 200);
    const checks = Object.fromEntries(response.body.report.checks.items.map((item) => [item.id, item]));
    assert.equal(response.body.report.checks.categoryIncomeMatchesSummary, undefined);

    // Bilans zamknięcia liczy wpis z 2072, saldo na 31.08.2027 — nie.
    assert.equal(checks.year_end_balance.ok, false);
    assert.equal(checks.year_end_balance.closingBalanceCents, 2000 - 12345);
    assert.equal(checks.year_end_balance.balanceAtYearEndCents, 2000);
    assert.equal(checks.year_end_balance.differenceCents, -12345);

    assert.equal(checks.dates_within_school_year.ok, false);
    assert.equal(checks.dates_within_school_year.ledgerEntryCount, 1);
    assert.equal(checks.dates_within_school_year.paymentCount, 1);
    assert.deepEqual(checks.dates_within_school_year.items, [
      { kind: 'payment_entry', id: 'p-1926', date: '1926-09-20' },
      { kind: 'ledger_entry', id: 'le-2072', date: '2072-09-20' },
    ]);

    // Wpłaty 2000 + 1000 + 3000 (legacy) vs ujęte w księdze 2000.
    assert.equal(checks.payments_in_ledger.ok, false);
    assert.equal(checks.payments_in_ledger.paymentsNetCents, 6000);
    assert.equal(checks.payments_in_ledger.ledgerLinkedNetCents, 2000);
    assert.equal(checks.payments_in_ledger.paymentsWithoutLedgerEntry, 2);

    assert.equal(checks.reconciliation_matches.ok, true);
    assert.equal(checks.latest_confirmed_reconciliation.ok, null);

    // Istniejące wiersze spoza zakresu nie są zmieniane.
    const { rows } = await db.query("SELECT to_char(occurred_on, 'YYYY-MM-DD') AS d FROM ledger_entries WHERE id = 'le-2072'");
    assert.equal(rows[0].d, '2072-09-20');

    const html = renderAuditReportHtml(response.body.report);
    assert.doesNotMatch(html, /Sumy kategorii są zgodne/);
    assert.match(html, /Daty wpisów i wpłat w granicach roku szkolnego/);
    assert.match(html, /niezgodne/);
    assert.match(html, /nie liczono/);
  } finally {
    await db.close();
  }
});

test('raport KR: czysty rok — wszystkie kontrole zgodne; korekta wpisu nie psuje salda końca roku', async () => {
  const { db, call, cookies } = await setup();
  try {
    const p1 = await call(cookies.treasurer, '/api/payments', { body: payment('2026-10-01', { amountCents: 5000 }), key: 'pay-clean-001' });
    const le = await call(cookies.treasurer, '/api/ledger', {
      body: entry('2026-10-01', { direction: 'income', categoryId: 'cat-in', amountCents: 5000, paymentEntryId: p1.body.payment.id }),
      key: 'le-clean-0001',
    });
    assert.equal(le.status, 201);
    const out = await call(cookies.treasurer, '/api/ledger', { body: entry('2027-08-31', { amountCents: 1000 }), key: 'le-clean-0002' });
    assert.equal(out.status, 201);
    const corr = await call(cookies.treasurer, `/api/ledger/${out.body.entry.id}/corrections`, {
      body: { amountCents: 400, reason: 'Korekta syntetyczna' }, key: 'le-corr-00001',
    });
    assert.equal(corr.status, 201);
    const response = await call(cookies.audit, `/api/reports/audit?schoolYearId=${YEAR}`);
    const checks = Object.fromEntries(response.body.report.checks.items.map((item) => [item.id, item]));
    assert.equal(checks.year_end_balance.ok, true);
    assert.equal(checks.year_end_balance.balanceAtYearEndCents, 5000 - 600);
    assert.equal(checks.dates_within_school_year.ok, true);
    assert.equal(checks.payments_in_ledger.ok, true);
    assert.equal(checks.payments_in_ledger.paymentsWithoutLedgerEntry, 0);
  } finally {
    await db.close();
  }
});

// --- #169, część 3: granica 31.08/01.09 w strefie Brukseli, wpłata z pozycji
// wyciągu, korekta po zatwierdzonym uzgodnieniu (kontrole 3a/3b). ------------

const NEXT_YEAR = 'y-2027'; // 2027-09-01 .. 2028-08-31

async function withProcessTimeZone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('granica 31.08/01.09 w strefie Brukseli: data wpłaty i wpisu nie przesuwa się ze strefą procesu ani sesji bazy', async () => {
  const { db, call } = await setup();
  try {
    await seedSchoolYear(db, NEXT_YEAR, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
    await seedEnrolledHousehold(db, 'h-3', [YEAR, NEXT_YEAR]);
    await db.exec(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
      ('cat-out-next', '${NEXT_YEAR}', 'expense', 'Wydarzenia', 'u-treasurer')`);
    const both = await seedUserSession(db, {
      userId: 'u-treasurer-2', mfa: true,
      roles: [{ role: 'treasurer', schoolYearId: YEAR }, { role: 'treasurer', schoolYearId: NEXT_YEAR }],
    });
    // Północ 01.09 w Brukseli (CEST, UTC+2) to jeszcze 31.08 w UTC; Kiritimati (UTC+14)
    // i Los Angeles (UTC−7) sprawdzają oba kierunki przesunięcia.
    const zones = ['Europe/Brussels', 'Pacific/Kiritimati', 'America/Los_Angeles'];
    for (const [index, zone] of zones.entries()) {
      await withProcessTimeZone(zone, async () => {
        await db.exec(`SET TIME ZONE '${zone}'`);
        const tag = `${index}`;
        // Wpłata częściowa (1500 z sugerowanych 3000) w ostatnim dniu roku — przyjęta.
        const last = await call(both, '/api/payments', { body: payment('2027-08-31', { householdId: 'h-3', amountCents: 1500 }), key: `pay-tz-last-${tag}` });
        assert.equal(last.status, 201, `${zone}: 31.08 w roku kończącym się`);
        assert.equal(last.body.payment.receivedOn, '2027-08-31');
        // Ten sam dzień w roku, który zaczyna się 01.09 — bez okna wpłat z wyprzedzeniem (wariant zachowawczy).
        const early = await call(both, '/api/payments', { body: payment('2027-08-31', { schoolYearId: NEXT_YEAR, householdId: 'h-3', amountCents: 1500 }), key: `pay-tz-early-${tag}` });
        assert.equal(early.status, 422, `${zone}: 31.08 w nowym roku`);
        assert.equal(early.body.error, 'date_outside_school_year');
        // Druga część wpłaty 01.09 — należy już do nowego roku.
        const first = await call(both, '/api/payments', { body: payment('2027-09-01', { schoolYearId: NEXT_YEAR, householdId: 'h-3', amountCents: 1500 }), key: `pay-tz-first-${tag}` });
        assert.equal(first.status, 201, `${zone}: 01.09 w nowym roku`);
        assert.equal(first.body.payment.receivedOn, '2027-09-01');
        const late = await call(both, '/api/payments', { body: payment('2027-09-01', { householdId: 'h-3', amountCents: 1500 }), key: `pay-tz-late-${tag}` });
        assert.equal(late.status, 422, `${zone}: 01.09 w roku zakończonym`);
        // Wpis księgi: ta sama granica.
        const entryLast = await call(both, '/api/ledger', { body: entry('2027-08-31', { amountCents: 100 }), key: `le-tz-last-${tag}` });
        assert.equal(entryLast.status, 201, `${zone}: wpis 31.08`);
        assert.equal(entryLast.body.entry.occurredOn, '2027-08-31');
        const entryNext = await call(both, '/api/ledger', { body: entry('2027-09-01', { schoolYearId: NEXT_YEAR, categoryId: 'cat-out-next', amountCents: 100 }), key: `le-tz-next-${tag}` });
        assert.equal(entryNext.status, 201, `${zone}: wpis 01.09 w nowym roku`);
        const entryLate = await call(both, '/api/ledger', { body: entry('2027-09-01', { amountCents: 100 }), key: `le-tz-late-${tag}` });
        assert.equal(entryLate.status, 422, `${zone}: wpis 01.09 w roku zakończonym`);
      });
    }
    await db.exec('SET TIME ZONE DEFAULT');
    // Zapisane daty są dokładnie takie, jak podane — żadna nie „przeskoczyła” granicy.
    const stored = await db.query(
      "SELECT school_year_id, to_char(received_on, 'YYYY-MM-DD') AS d, count(*)::int AS n FROM payment_entries GROUP BY 1, 2 ORDER BY 1, 2",
    );
    assert.deepEqual(stored.rows, [
      { school_year_id: YEAR, d: '2027-08-31', n: 3 },
      { school_year_id: NEXT_YEAR, d: '2027-09-01', n: 3 },
    ]);
    // Saldo końca roku (jak w uzgodnieniu) obejmuje wpis z 31.08, a widok odchyleń jest pusty.
    const atEnd = await db.query("SELECT ledger_balance_at($1, DATE '2027-08-31') AS c", [YEAR]);
    assert.equal(Number(atEnd.rows[0].c), -300);
    assert.equal(await count(db, 'school_year_date_deviations'), 0);
  } finally {
    await db.close();
  }
});

test('wpłata z pozycji wyciągu z 31.08 (pierwszy wyciąg roku): 422 date_outside_school_year, bez wpłaty i powiązania; ponowienie nadal 422', async () => {
  const { db, call, cookies } = await setup();
  try {
    const draft = await call(cookies.treasurer, '/api/reconciliations', {
      body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 5000 }, key: 'rec-draft-0001',
    });
    assert.equal(draft.status, 201);
    const recId = draft.body.reconciliation.id;
    // Pozycja z 31.08 może stać na wyciągu z 30.09 (trigger 0015 sprawdza tylko „nie po dacie wyciągu”).
    const imported = await call(cookies.treasurer, `/api/reconciliations/${recId}/lines`, {
      body: { lines: [{ bookedOn: '2026-08-31', amountCents: 3000 }, { bookedOn: '2026-09-01', amountCents: 2000 }] },
      key: 'rec-lines-0001',
    });
    assert.equal(imported.status, 201);
    const detail = await call(cookies.treasurer, `/api/reconciliations/${recId}`);
    const lineOn = (date) => detail.body.lines.find((line) => line.bookedOn === date).id;

    const linePayment = (lineId, key) => call(cookies.treasurer, `/api/reconciliations/${recId}/lines/${lineId}/payment`, {
      body: { householdId: 'h-1' }, key,
    });
    const refused = await linePayment(lineOn('2026-08-31'), 'line-pay-0831');
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error, 'date_outside_school_year');
    const again = await linePayment(lineOn('2026-08-31'), 'line-pay-0831');
    assert.equal(again.status, 422);
    assert.equal(await count(db, 'payment_entries'), 0);
    assert.equal(await count(db, 'bank_reconciliation_matches'), 0);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action IN ('payment.created', 'reconciliation.match.confirmed')");
    assert.equal(rows[0].n, 0);

    // Podwójne kliknięcie na pozycji z 01.09: jedna wpłata i jedno powiązanie.
    const [a, b] = await Promise.all([linePayment(lineOn('2026-09-01'), 'line-pay-0901'), linePayment(lineOn('2026-09-01'), 'line-pay-0901')]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(await count(db, 'payment_entries'), 1);
    assert.equal(await count(db, 'bank_reconciliation_matches'), 1);
  } finally {
    await db.close();
  }
});

test('korekta po zatwierdzonym uzgodnieniu: saldo końca roku (3a) zgodne, 3b wskazuje wpis po dacie wyciągu, przeksięgowanie poza rok 422 bez storna', async () => {
  const { db, call, cookies } = await setup();
  try {
    const income = await call(cookies.treasurer, '/api/ledger', {
      body: entry('2026-09-10', { direction: 'income', categoryId: 'cat-in', amountCents: 5000, description: 'Wpływ syntetyczny' }), key: 'le-rec-in-001',
    });
    const expense = await call(cookies.treasurer, '/api/ledger', { body: entry('2026-09-15', { amountCents: 1000 }), key: 'le-rec-out-01' });
    assert.equal(income.status, 201);
    assert.equal(expense.status, 201);
    const draft = await call(cookies.treasurer, '/api/reconciliations', {
      body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 4000 }, key: 'rec-draft-0002',
    });
    const recId = draft.body.reconciliation.id;
    assert.equal(draft.body.reconciliation.differenceCents, 0);
    await call(cookies.treasurer, `/api/reconciliations/${recId}/lines`, {
      body: { lines: [{ bookedOn: '2026-09-10', amountCents: 5000 }, { bookedOn: '2026-09-15', amountCents: -1000 }] }, key: 'rec-lines-0002',
    });
    const detail = await call(cookies.treasurer, `/api/reconciliations/${recId}`);
    const lineIn = detail.body.lines.find((line) => line.amountCents === 5000).id;
    const matched = await call(cookies.treasurer, `/api/reconciliations/${recId}/matches`, {
      body: { statementLineId: lineIn, ledgerEntryId: income.body.entry.id }, key: 'rec-match-0001',
    });
    assert.equal(matched.status, 201);
    const confirmed = await call(cookies.board, `/api/reconciliations/${recId}/confirm`, { body: {} });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.reconciliation.status, 'confirmed');

    const checksNow = async () => {
      const response = await call(cookies.audit, `/api/reports/audit?schoolYearId=${YEAR}`);
      assert.equal(response.status, 200);
      return Object.fromEntries(response.body.report.checks.items.map((item) => [item.id, item]));
    };
    let checks = await checksNow();
    assert.equal(checks.latest_confirmed_reconciliation.ok, true);
    assert.equal(checks.latest_confirmed_reconciliation.bankEntriesAfterStatement, 0);

    // Korekta (częściowa, 500 z 5000) wpisu powiązanego w zatwierdzonym uzgodnieniu — dozwolona (#165 blokuje tylko szkic).
    const corrected = await call(cookies.treasurer, `/api/ledger/${income.body.entry.id}/corrections`, {
      body: { amountCents: 500, reason: 'Korekta syntetyczna po uzgodnieniu' }, key: 'le-rec-corr-1',
    });
    assert.equal(corrected.status, 201);

    // Przeksięgowanie wydatku na datę spoza roku: 422, a storno nie zostaje (jedna transakcja).
    const replacement = (occurredOn, key) => call(cookies.treasurer, `/api/ledger/${expense.body.entry.id}/replacement`, {
      body: { ...entry(occurredOn, { amountCents: 1000 }), reason: 'Zła data wpisu' }, key,
    });
    const correctionsBefore = await count(db, 'ledger_corrections');
    const outside = await replacement('2027-09-01', 'le-rec-repl-x');
    assert.equal(outside.status, 422);
    assert.equal(outside.body.error, 'date_outside_school_year');
    assert.equal((await replacement('2027-09-01', 'le-rec-repl-x')).status, 422);
    assert.equal(await count(db, 'ledger_corrections'), correctionsBefore);
    assert.equal(await count(db, 'ledger_entries'), 2);

    // Przeksięgowanie na datę w roku, ale po dacie zatwierdzonego wyciągu.
    const moved = await replacement('2026-10-05', 'le-rec-repl-1');
    assert.equal(moved.status, 201);

    checks = await checksNow();
    // 3a: bilans zamknięcia = saldo na ends_on (5000 − 500 − 1000), oba liczone niezależnie.
    assert.equal(checks.year_end_balance.ok, true);
    assert.equal(checks.year_end_balance.balanceAtYearEndCents, 3500);
    assert.equal(checks.year_end_balance.differenceCents, 0);
    // 3b: utrwalona różnica zatwierdzonego uzgodnienia bez zmian, ale jest wpis bankowy po dacie wyciągu.
    assert.equal(checks.latest_confirmed_reconciliation.ok, true);
    assert.equal(checks.latest_confirmed_reconciliation.statementDate, '2026-09-30');
    assert.equal(checks.latest_confirmed_reconciliation.bankEntriesAfterStatement, 1);
    // Powiązanie w zatwierdzonym uzgodnieniu stało się niezgodne kwotowo (5000 vs 4500) — KR wyjaśnia ręcznie.
    assert.equal(checks.reconciliation_matches.ok, false);
    assert.equal(checks.reconciliation_matches.amountMismatchConfirmedCount, 1);
    assert.equal(checks.dates_within_school_year.ok, true);
  } finally {
    await db.close();
  }
});
