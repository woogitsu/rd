// #91: raport kandydatów do retencji (D-04) — wyłącznie odczyt, bez PII.
// Wyłącznie dane syntetyczne (.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

async function call(env, path, opts = {}) {
  const response = await handlePgRequest(request(path, opts), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function setup() {
  const db = await createTestDb();
  const env = { db };
  const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  return { db, env, admin };
}

test('raport retencji: tylko admin z MFA, bez danych osobowych w odpowiedzi', async () => {
  const { db, env, admin } = await setup();
  try {
    await seedSchoolYear(db, 'y-2026');
    await db.exec(`
      INSERT INTO households (id) VALUES ('h-1'), ('h-2');
      INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed) VALUES
        ('g-1', 'h-1', 'Anna', 'Testowa', 'anna@example.invalid', true),
        ('g-2', 'h-2', 'Piotr', 'Testowy', 'piotr@example.invalid', true);
      INSERT INTO students (id, household_id, first_name, last_name) VALUES
        ('s-1', 'h-1', 'Ola', 'Testowa'), ('s-2', 'h-1', 'Jan', 'Testowy');
      INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact) VALUES
        ('s-1', 'g-1', true, true), ('s-2', 'g-1', true, true);
      INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, reference, created_by, idempotency_key)
        VALUES ('p-1', 'h-1', 'y-2026', 5000, '2026-10-01', 'bank', 'Składka Ola i Jan Testowi', 'u-admin', 'idem-p-1');
    `);
    // Wyzwala trigger historii kontaktu (guardian_contact_changes) — zawiera dane osobowe.
    await db.query("UPDATE guardians SET email = 'anna2@example.invalid' WHERE id = 'g-1'");

    const anon = await call(env, '/api/admin/retention/preview');
    assert.equal(anon.status, 401);

    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a' }], mfa: true });
    assert.equal((await call(env, '/api/admin/retention/preview', { cookie: rep })).status, 403);

    const noMfa = await seedUserSession(db, { userId: 'u-admin-nomfa', roles: [{ role: 'admin' }], mfa: false });
    assert.equal((await call(env, '/api/admin/retention/preview', { cookie: noMfa })).status, 403);

    const result = await call(env, '/api/admin/retention/preview', { cookie: admin });
    assert.equal(result.status, 200);
    const body = JSON.stringify(result.data);
    // Kryterium akceptacji: raport nie zwraca imion, nazwisk, e-maili ani referencji.
    for (const forbidden of ['Anna', 'Testowa', 'Piotr', 'anna@example.invalid', 'anna2@example.invalid', 'Ola i Jan Testowi', 'Składka']) {
      assert.ok(!body.includes(forbidden), `raport zawiera dane osobowe: ${forbidden}`);
    }
    const paymentRef = result.data.candidates.find((c) => c.category === 'payment_reference' && c.schoolYearId === 'y-2026');
    assert.ok(paymentRef, 'brak kandydata payment_reference dla y-2026');
    assert.equal(paymentRef.count, 1);
    assert.equal(paymentRef.hasPolicy, false);
    const guardianContact = result.data.candidates.find((c) => c.category === 'guardian_contact');
    assert.ok(guardianContact);
    assert.equal(guardianContact.count, 1);
    assert.deepEqual(result.data.policies, []);
  } finally {
    await db.close();
  }
});

test('raport pokazuje zarejestrowaną politykę retencji (najnowsza wersja jest "current")', async () => {
  const { db, env, admin } = await setup();
  try {
    await seedUser(db, { userId: 'u-admin2' });
    await db.query(
      `INSERT INTO retention_policies (id, data_category, retain_for, decision_ref, created_by, approved_by, effective_from)
       VALUES ('rp-1', 'audit_event', '5 years', 'D-04/uchwała-testowa-1', 'u-admin', 'u-admin2', now() - interval '2 days')`,
    );
    await db.query(
      `INSERT INTO retention_policies (id, data_category, retain_for, decision_ref, created_by, approved_by, effective_from)
       VALUES ('rp-2', 'audit_event', '3 years', 'D-04/uchwała-testowa-2', 'u-admin', 'u-admin2', now())`,
    );
    const result = await call(env, '/api/admin/retention/preview', { cookie: admin });
    assert.equal(result.status, 200);
    const policies = result.data.policies.filter((p) => p.category === 'audit_event');
    assert.equal(policies.length, 2);
    const current = policies.find((p) => p.id === 'rp-2');
    assert.equal(current.current, true);
    assert.equal(policies.find((p) => p.id === 'rp-1').current, false);
    const candidate = result.data.candidates.find((c) => c.category === 'audit_event');
    if (candidate) assert.equal(candidate.hasPolicy, true);
  } finally {
    await db.close();
  }
});

test('retention_policies jest tylko do dopisywania (UPDATE/DELETE odrzucone) i wymaga innego zatwierdzającego niż autor', async () => {
  const { db } = await setup();
  try {
    await seedUser(db, { userId: 'u-x' });
    await seedUser(db, { userId: 'u-y' });
    await db.query(
      `INSERT INTO retention_policies (id, data_category, retain_for, decision_ref, created_by)
       VALUES ('rp-3', 'export_package', '10 years', 'D-04/uchwała', 'u-x')`,
    );
    await assert.rejects(
      db.query(
        `INSERT INTO retention_policies (id, data_category, retain_for, decision_ref, created_by, approved_by)
         VALUES ('rp-4', 'export_package', '10 years', 'D-04/uchwała', 'u-x', 'u-x')`,
      ),
      /retention_policies_four_eyes|check constraint/i,
    );
    await assert.rejects(
      db.query("UPDATE retention_policies SET decision_ref = 'zmienione' WHERE id = 'rp-3'"),
      /append-only/,
    );
    await assert.rejects(
      db.query("DELETE FROM retention_policies WHERE id = 'rp-3'"),
      /append-only/,
    );
    await assert.rejects(
      db.query(
        `INSERT INTO retention_policies (id, data_category, decision_ref, created_by)
         VALUES ('rp-5', 'export_package', 'D-04/uchwała', 'u-x')`,
      ),
      /retention_policies_shape|check constraint/i,
    );
  } finally {
    await db.close();
  }
});
