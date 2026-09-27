import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSecret } from '../src/auth.js';

const sessionToken = 'P'.repeat(43);

function migration(name) {
  return readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8');
}

function d1Adapter(db) {
  function bound(sql, values) {
    const first = () => {
      const row = db.prepare(sql).get(...values);
      return row ? { ...row } : null;
    };
    const all = () => ({ results: db.prepare(sql).all(...values).map(row => ({ ...row })) });
    const run = () => {
      const result = db.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    };
    return { first: async () => first(), all: async () => all(), run: async () => run(), _run: run };
  }

  return {
    prepare(sql) {
      return { bind: (...values) => bound(sql, values) };
    },
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement._run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

async function setup({ role = 'treasurer', mfa = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of [
    '0001_initial',
    '0002_auth_sessions',
    '0003_student_guardians',
    '0004_enrollment_school_year',
    '0005_payment_corrections',
    '0006_payment_assignments',
  ]) db.exec(migration(name));
  db.exec(`
    INSERT INTO school_years (id, label, starts_on, ends_on)
      VALUES ('y2026', '2026/2027', '2026-09-01', '2027-06-30');
    INSERT INTO classes (id, school_year_id, name) VALUES ('c1', 'y2026', '1A');
    INSERT INTO households (id) VALUES ('h1'), ('h2');
    INSERT INTO users (id, email, display_name)
      VALUES ('u1', 'finanse@example.org', 'Osoba Testowa');
  `);
  db.prepare(`
    INSERT INTO role_grants (id, user_id, role, class_id, school_year_id)
    VALUES ('rg1', 'u1', ?, ?, 'y2026')
  `).run(role, role === 'representative' ? 'c1' : null);
  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, mfa_verified_at)
    VALUES ('s1', 'u1', ?, '2099-01-01T00:00:00Z', ?)
  `).run(await hashSecret(sessionToken), mfa ? '2026-09-27T00:00:00Z' : null);
  return { db, env: { DB: d1Adapter(db) } };
}

function post(path, body, idempotencyKey = 'request-key-0001', origin = 'https://rd.example') {
  return new Request(`https://rd.example${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `rd_session=${sessionToken}`,
      Origin: origin,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function get(path) {
  return new Request(`https://rd.example${path}`, {
    headers: { Cookie: `rd_session=${sessionToken}` },
  });
}

const paymentInput = {
  householdId: 'h1',
  schoolYearId: 'y2026',
  amountCents: 7500,
  receivedOn: '2026-09-27',
  method: 'bank',
  reference: 'synthetic-reference',
};

test('financial role with MFA creates one payment and one audit event', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  const response = await worker.fetch(post('/api/payments', paymentInput), env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Idempotency-Replayed'), 'false');
  const payload = await response.json();
  assert.equal(payload.payment.amountCents, 7500);
  assert.equal(payload.payment.status, 'recorded');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_entries').get().count, 1);
  assert.deepEqual(
    { ...db.prepare('SELECT actor_id, action, entity_type FROM audit_events').get() },
    { actor_id: 'u1', action: 'payment.created', entity_type: 'payment_entry' },
  );
});

test('payment retry is idempotent and changed payload conflicts', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  const first = await worker.fetch(post('/api/payments', paymentInput), env);
  const firstId = (await first.json()).payment.id;
  const retry = await worker.fetch(post('/api/payments', paymentInput), env);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get('Idempotency-Replayed'), 'true');
  assert.equal((await retry.json()).payment.id, firstId);
  const conflict = await worker.fetch(post('/api/payments', { ...paymentInput, amountCents: 7600 }), env);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'idempotency_conflict' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_entries').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
});

test('payment writes reject missing MFA, representatives and foreign origins', async t => {
  for (const options of [{ mfa: false }, { role: 'representative' }]) {
    const { db, env } = await setup(options);
    const response = await worker.fetch(post('/api/payments', paymentInput), env);
    assert.equal(response.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_entries').get().count, 0);
    db.close();
  }
  const { db, env } = await setup();
  t.after(() => db.close());
  const foreign = await worker.fetch(post('/api/payments', paymentInput, 'request-key-0001', 'https://evil.example'), env);
  assert.equal(foreign.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_entries').get().count, 0);
});

test('correction is audited, idempotent and cannot exceed the remaining amount', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  const created = await worker.fetch(post('/api/payments', paymentInput), env);
  const paymentId = (await created.json()).payment.id;
  const path = `/api/payments/${paymentId}/corrections`;
  const correction = { amountCents: 2500, reason: 'Testowa korekta częściowa' };
  const first = await worker.fetch(post(path, correction, 'correction-key-0001'), env);
  assert.equal(first.status, 201);
  const correctionId = (await first.json()).correction.id;
  const retry = await worker.fetch(post(path, correction, 'correction-key-0001'), env);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).correction.id, correctionId);
  const excessive = await worker.fetch(post(path, {
    amountCents: 5001,
    reason: 'Korekta przekraczająca pozostałą kwotę',
  }, 'correction-key-0002'), env);
  assert.equal(excessive.status, 409);
  assert.deepEqual(await excessive.json(), { error: 'correction_exceeds_remaining_amount' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_corrections').get().count, 1);
  assert.deepEqual(
    db.prepare('SELECT action FROM audit_events ORDER BY occurred_at, action').all().map(row => row.action),
    ['payment.correction.created', 'payment.created'],
  );
});

test('payment list is scoped, paginated and returns corrected net amounts', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  const first = await worker.fetch(post('/api/payments', paymentInput, 'payment-list-key-0001'), env);
  const firstId = (await first.json()).payment.id;
  await worker.fetch(post(`/api/payments/${firstId}/corrections`, {
    amountCents: 2500,
    reason: 'Testowa korekta do listy',
  }, 'payment-list-correction-0001'), env);
  await worker.fetch(post('/api/payments', {
    ...paymentInput,
    amountCents: 2000,
    receivedOn: '2026-09-26',
    reference: null,
  }, 'payment-list-key-0002'), env);

  const pageOne = await worker.fetch(get('/api/payments?schoolYearId=y2026&status=recorded&limit=1'), env);
  assert.equal(pageOne.status, 200);
  const firstPage = await pageOne.json();
  assert.equal(firstPage.payments.length, 1);
  assert.equal(firstPage.payments[0].id, firstId);
  assert.equal(firstPage.payments[0].netAmountCents, 5000);
  assert.ok(firstPage.nextCursor);
  const pageTwo = await worker.fetch(get(
    `/api/payments?schoolYearId=y2026&status=recorded&limit=1&cursor=${firstPage.nextCursor}`,
  ), env);
  const secondPage = await pageTwo.json();
  assert.equal(secondPage.payments.length, 1);
  assert.equal(secondPage.payments[0].amountCents, 2000);
  assert.equal(secondPage.nextCursor, null);
  const invalid = await worker.fetch(get('/api/payments?schoolYearId=y2026&cursor=not-a-cursor'), env);
  assert.equal(invalid.status, 400);
});

test('unmatched payment assignment is immutable, audited and idempotent', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  const created = await worker.fetch(post('/api/payments', {
    ...paymentInput,
    householdId: null,
  }, 'unmatched-payment-key-0001'), env);
  const paymentId = (await created.json()).payment.id;
  const path = `/api/payments/${paymentId}/assignment`;
  const first = await worker.fetch(post(path, { householdId: 'h1' }, 'assignment-key-0001'), env);
  assert.equal(first.status, 201);
  const assignmentId = (await first.json()).assignment.id;
  const retry = await worker.fetch(post(path, { householdId: 'h1' }, 'assignment-key-0001'), env);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).assignment.id, assignmentId);
  const reassignment = await worker.fetch(post(path, { householdId: 'h2' }, 'assignment-key-0002'), env);
  assert.equal(reassignment.status, 409);
  assert.deepEqual(
    { ...db.prepare('SELECT household_id, status FROM payment_entries WHERE id = ?').get(paymentId) },
    { household_id: 'h1', status: 'recorded' },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_assignments').get().count, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'payment.assigned'").get().count,
    1,
  );
});
