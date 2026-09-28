// Pulpit zarządu: statystyki per klasa (#131). Wyłącznie dane syntetyczne
// (domeny .invalid). Zero rankingu, zero słów "dłużnik"/"zaległość".
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const Y = 'y-2026';
const Y_OTHER = 'y-2025';

async function call(env, path, { cookie } = {}) {
  const response = await handlePgRequest(request(path, { cookie }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function insertPayment(db, { id, householdId, schoolYearId, amountCents, status = 'recorded' }) {
  await seedUser(db, { userId: 'u-treasurer-seed' });
  await db.query(
    `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, '2026-10-01', 'bank', $5, 'u-treasurer-seed', $6)
     ON CONFLICT (id) DO NOTHING`,
    [id, householdId, schoolYearId, amountCents, status, `syn-key-${id}`],
  );
}

describe('pulpit zarządu: statystyki per klasa (#131)', () => {
  test('granice ról: przedstawiciel, skarbnik, audit, principal → 403; brak sesji → 401', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-x', schoolYearId: Y }] });
    const treasurer = await seedUserSession(db, { userId: 'u-treas', roles: [{ role: 'treasurer', schoolYearId: Y }], mfa: true });
    const audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }], mfa: true });
    const principal = await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal' }] });
    for (const cookie of [rep, treasurer, audit, principal]) {
      assert.equal((await call(env, `/api/board/overview?schoolYearId=${Y}`, { cookie })).status, 403);
    }
    assert.equal((await call(env, `/api/board/overview?schoolYearId=${Y}`)).status, 401);
    await db.close();
  });

  test('zarząd przydzielony do jednego roku nie widzi innego roku', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    await seedSchoolYear(db, Y_OTHER);
    const env = { db };
    const boardY = await seedUserSession(db, { userId: 'u-board-y', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
    const denied = await call(env, `/api/board/overview?schoolYearId=${Y_OTHER}`, { cookie: boardY });
    assert.deepEqual(denied, { status: 404, data: { error: 'school_year_not_found' } });
    const allowed = await call(env, `/api/board/overview?schoolYearId=${Y}`, { cookie: boardY });
    assert.equal(allowed.status, 200);
    await db.close();
  });

  // Bramka MFA routera (mfa-policy.js) wymaga potwierdzonego czynnika od KAŻDEJ
  // roli z MFA_REQUIRED_ROLES (domyślnie admin/board/treasurer) na każdej trasie
  // — zarząd bez potwierdzonego MFA nie dostaje się w ogóle do tej trasy.
  // Osobny wymóg MFA dla kolumny wpłat (families.financialYears — ta sama reguła)
  // ma więc znaczenie tylko, gdy globalny wymóg jest wyłączony (MFA_REQUIRED_ROLES
  // konfigurowalne, patrz pg-login.test.js) — tak sprawdzamy poniżej.
  test('zarząd bez potwierdzonego MFA nie dostaje się na trasę (bramka routera)', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    const boardNoMfa = await seedUserSession(db, { userId: 'u-board-nomfa', roles: [{ role: 'board' }] });
    const result = await call(env, `/api/board/overview?schoolYearId=${Y}`, { cookie: boardNoMfa });
    assert.deepEqual(result, { status: 403, data: { error: 'mfa_enrollment_required' } });
    await db.close();
  });

  test('zarząd bez wymogu MFA (MFA_REQUIRED_ROLES=admin): brak kolumny wpłat; nieprawidłowy schoolYearId → 400', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
    const env = { db, MFA_REQUIRED_ROLES: 'admin' };
    const boardNoMfa = await seedUserSession(db, { userId: 'u-board-nomfa2', roles: [{ role: 'board' }] });
    const result = await call(env, `/api/board/overview?schoolYearId=${Y}`, { cookie: boardNoMfa });
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(result.data.totals, 'paymentEntryRatePercent'), false);
    for (const klass of result.data.classes) assert.equal(Object.hasOwn(klass, 'paymentEntryRatePercent'), false);
    assert.equal((await call(env, '/api/board/overview', { cookie: boardNoMfa })).status, 400);
    assert.equal((await call(env, '/api/board/overview?schoolYearId=..%2Fx', { cookie: boardNoMfa })).status, 400);
    await db.close();
  });

  test('admin z MFA: liczby zgodne z listą klasy; rodzeństwo w sumie szkoły liczone raz; próg klasy; wpłata częściowa/korekta', async () => {
    const db = await createTestDb();
    const env = { db };
    await seedClass(db, { id: 'c-1a', schoolYearId: Y, name: '1A' });
    await seedClass(db, { id: 'c-1b', schoolYearId: Y, name: '1B' });
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });

    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1'), ('h-2'), ('h-3'), ('h-4'), ('h-5'), ('h-6');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-1', 'h-1', 'Anna', 'Testowa', 'g1@example.invalid', true),
        ('g-2', 'h-2', 'Piotr', 'Testowy', NULL, true),
        ('g-3', 'h-3', 'Ewa', 'Inna', 'g3@example.invalid', true),
        ('g-4', 'h-4', 'Tom', 'Nowak', 'g4@example.invalid', true),
        ('g-5', 'h-5', 'Zofia', 'Kowal', 'g5@example.invalid', true),
        ('g-6', 'h-6', 'Marek', 'Wiśnia', 'g6@example.invalid', true);
      -- s-1, s-2: rodzeństwo w h-1, w dwóch różnych klasach (1A, 1B).
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-1', 'h-1', 'Ola', 'Testowa'),
        ('s-2', 'h-1', 'Jan', 'Testowy'),
        ('s-3', 'h-2', 'Kuba', 'Inny'),
        ('s-4', 'h-3', 'Zosia', 'Nowak'),
        ('s-5', 'h-4', 'Ala', 'Nowak'),
        ('s-6', 'h-5', 'Bob', 'Kowal'),
        ('s-7', 'h-6', 'Ewa', 'Wiśnia');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-1', 'g-1', true, true), ('s-2', 'g-1', true, true),
        ('s-3', 'g-2', true, true), ('s-4', 'g-3', true, true),
        ('s-5', 'g-4', true, true), ('s-6', 'g-5', true, true), ('s-7', 'g-6', true, true);
      -- 1A: s-1, s-3, s-4, s-5, s-6 (5 gospodarstw: h-1, h-2, h-3, h-4, h-5) — próg spełniony.
      -- 1B: s-2, s-7 (2 gospodarstwa: h-1, h-6) — poniżej progu (5).
      INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES
        ('e-1', 's-1', 'c-1a', '${Y}'), ('e-2', 's-3', 'c-1a', '${Y}'), ('e-3', 's-4', 'c-1a', '${Y}'),
        ('e-4', 's-5', 'c-1a', '${Y}'), ('e-5', 's-6', 'c-1a', '${Y}'),
        ('e-6', 's-2', 'c-1b', '${Y}'), ('e-7', 's-7', 'c-1b', '${Y}');
    `);
    // h-1: wpłata częściowa (100 EUR) → wpis netto > 0. h-3: wpłata skorygowana do zera → bez wpisu netto.
    // h-4: podwójne kliknięcie (dwie wpłaty, ten sam idempotency_key przez ON CONFLICT DO NOTHING = jeden wiersz).
    await insertPayment(db, { id: 'p-1', householdId: 'h-1', schoolYearId: Y, amountCents: 10000 });
    await insertPayment(db, { id: 'p-3', householdId: 'h-3', schoolYearId: Y, amountCents: 5000 });
    await db.query(
      `INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
       VALUES ('corr-1', 'p-3', 5000, 'Korekta do zera (syntetyczne)', 'u-treasurer-seed', 'syn-key-corr-1')`,
    );
    await insertPayment(db, { id: 'p-4', householdId: 'h-4', schoolYearId: Y, amountCents: 2000 });
    // Podwójne kliknięcie: druga próba z tym samym id i tym samym idempotency_key — ON CONFLICT DO NOTHING, jeden wiersz.
    await insertPayment(db, { id: 'p-4', householdId: 'h-4', schoolYearId: Y, amountCents: 2000 });
    await insertPayment(db, { id: 'p-unmatched', householdId: null, schoolYearId: Y, amountCents: 1500, status: 'unmatched' });

    const classesList = await call(env, '/api/classes', { cookie: admin });
    const result = await call(env, `/api/board/overview?schoolYearId=${Y}`, { cookie: admin });
    assert.equal(result.status, 200);
    const byId = Object.fromEntries(result.data.classes.map((c) => [c.id, c]));

    // Zgodność z listą klasy (#83/#118 na tych samych danych: studentCount).
    const listById = Object.fromEntries(classesList.data.classes.map((c) => [c.id, c]));
    assert.equal(byId['c-1a'].studentCount, listById['c-1a'].studentCount);
    assert.equal(byId['c-1b'].studentCount, listById['c-1b'].studentCount);

    assert.equal(byId['c-1a'].studentCount, 5);
    assert.equal(byId['c-1a'].householdCount, 5);
    assert.equal(byId['c-1a'].paymentEntryRatePercent, 40, 'h-1 i h-4 mają wpis netto > 0 z 5 gospodarstw = 40%');
    assert.equal(byId['c-1b'].studentCount, 2);
    assert.equal(byId['c-1b'].householdCount, 2);
    assert.equal(byId['c-1b'].paymentEntryRatePercent, null, 'poniżej progu 5 gospodarstw — "—"');

    // Suma szkoły: rodzeństwo (h-1) w obu klasach liczone raz -> 6 gospodarstw, nie 7.
    assert.equal(result.data.totals.studentCount, 7);
    assert.equal(result.data.totals.householdCount, 6);
    assert.equal(result.data.totals.unmatchedPaymentsCount, 1);

    // Brak identyfikatorów gospodarstw/opiekunów, imion, e-maili i słów zakazanych; brak sortowania po odsetku.
    const text = JSON.stringify(result.data);
    assert.doesNotMatch(text, /h-1|h-2|h-3|h-4|h-5|h-6|g-1|g-2|Anna|Testowa|example\.invalid/);
    assert.doesNotMatch(text, /dłużnik|zaległoś/i);
    assert.deepEqual(result.data.classes.map((c) => c.id), ['c-1a', 'c-1b'], 'sortowanie wyłącznie po nazwie klasy');

    // Część wpłaty nieprzypisanej (#127) przypisana h-5 liczy się jako wpis
    // gospodarstwa (jak w household_payment_totals); cofnięta część — już nie.
    await db.query(
      `INSERT INTO payment_allocations (id, payment_entry_id, school_year_id, household_id, amount_cents, created_by, idempotency_key)
       VALUES ('alloc-1', 'p-unmatched', $1, 'h-5', 500, 'u-treasurer-seed', 'syn-key-alloc-1')`, [Y],
    );
    const withAllocation = await call(env, `/api/board/overview?schoolYearId=${Y}`, { cookie: admin });
    assert.equal(withAllocation.data.classes.find((c) => c.id === 'c-1a').paymentEntryRatePercent, 60);
    assert.equal(withAllocation.data.totals.unmatchedPaymentsCount, 1, 'wpłata z częściami nadal jest nieprzypisana');
    await db.query(
      `INSERT INTO payment_allocation_reversals (id, allocation_id, school_year_id, reason, created_by, idempotency_key)
       VALUES ('alloc-rev-1', 'alloc-1', $1, 'Cofnięcie syntetyczne', 'u-treasurer-seed', 'syn-key-alloc-rev-1')`, [Y],
    );
    const reversed = await call(env, `/api/board/overview?schoolYearId=${Y}`, { cookie: admin });
    assert.equal(reversed.data.classes.find((c) => c.id === 'c-1a').paymentEntryRatePercent, 40);

    await db.close();
  });
});
