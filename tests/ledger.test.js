import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSecret } from '../src/auth.js';

const sessionToken = 'L'.repeat(43);

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
    '0007_ledger_schema',
    '0008_ledger_payment_links',
  ]) db.exec(migration(name));
  db.exec(`
    INSERT INTO school_years (id, label, starts_on, ends_on)
      VALUES ('y2026', '2026/2027', '2026-09-01', '2027-06-30');
    INSERT INTO classes (id, school_year_id, name) VALUES ('c1', 'y2026', '1A');
    INSERT INTO users (id, email, display_name)
      VALUES ('u1', 'finanse@example.org', 'Osoba Testowa');
    INSERT INTO households (id) VALUES ('h1');
    INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by)
      VALUES ('d1', 'synthetic/source.pdf', 'application/pdf', 1200, 'receipt', 'u1');
    INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
      VALUES ('income-other', 'y2026', 'income', 'Inne przychody', 'u1'),
             ('expense-events', 'y2026', 'expense', 'Wydarzenia', 'u1');
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

function post(path, body, idempotencyKey = 'ledger-request-0001', origin = 'https://rd.example') {
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

const entryInput = {
  schoolYearId: 'y2026',
  direction: 'expense',
  amountCents: 12500,
  categoryId: 'expense-events',
  description: 'Syntetyczny wydatek wydarzenia',
  occurredOn: '2026-09-27',
  method: 'bank',
  source: 'Konto testowe',
  sourceDocumentId: 'd1',
};

test('financial role with MFA creates one ledger entry and one audit event', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  const response = await worker.fetch(post('/api/ledger', entryInput), env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Idempotency-Replayed'), 'false');
  const payload = await response.json();
  assert.equal(payload.entry.amountCents, 12500);
  assert.equal(payload.entry.direction, 'expense');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_entries').get().count, 1);
  assert.deepEqual(
    { ...db.prepare('SELECT actor_id, action, entity_type, metadata_json FROM audit_events').get() },
    {
      actor_id: 'u1',
      action: 'ledger.entry.created',
      entity_type: 'ledger_entry',
      metadata_json: '{}',
    },
  );
});

test('ledger entry retry is idempotent and changed payload conflicts', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  const first = await worker.fetch(post('/api/ledger', entryInput), env);
  const firstId = (await first.json()).entry.id;
  const retry = await worker.fetch(post('/api/ledger', entryInput), env);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get('Idempotency-Replayed'), 'true');
  assert.equal((await retry.json()).entry.id, firstId);
  const conflict = await worker.fetch(post('/api/ledger', { ...entryInput, amountCents: 12600 }), env);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'idempotency_conflict' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_entries').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
});

test('ledger writes reject missing MFA, representatives and foreign origins', async t => {
  for (const options of [{ mfa: false }, { role: 'representative' }]) {
    const { db, env } = await setup(options);
    const response = await worker.fetch(post('/api/ledger', entryInput), env);
    assert.equal(response.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_entries').get().count, 0);
    db.close();
  }
  const { db, env } = await setup();
  t.after(() => db.close());
  const foreign = await worker.fetch(post(
    '/api/ledger', entryInput, 'ledger-request-0001', 'https://evil.example',
  ), env);
  assert.equal(foreign.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_entries').get().count, 0);
});

test('large expense requires a resolution and references are validated', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  const missingResolution = await worker.fetch(post('/api/ledger', {
    ...entryInput,
    amountCents: 300001,
  }), env);
  assert.equal(missingResolution.status, 400);
  assert.deepEqual(await missingResolution.json(), { error: 'resolution_required' });
  const invalidCategory = await worker.fetch(post('/api/ledger', {
    ...entryInput,
    categoryId: 'income-other',
  }, 'ledger-request-0002'), env);
  assert.equal(invalidCategory.status, 400);
  assert.deepEqual(await invalidCategory.json(), { error: 'invalid_category' });
  const missingDocument = await worker.fetch(post('/api/ledger', {
    ...entryInput,
    sourceDocumentId: 'missing',
  }, 'ledger-request-0003'), env);
  assert.equal(missingDocument.status, 400);
  assert.deepEqual(await missingDocument.json(), { error: 'invalid_source_document' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_entries').get().count, 0);
});

test('recorded payment can be linked once to income in the same school year', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  db.exec(`
    INSERT INTO payment_entries (
      id, household_id, school_year_id, amount_cents, received_on,
      method, status, created_by, idempotency_key
    ) VALUES (
      'p1', 'h1', 'y2026', 5000, '2026-09-27',
      'bank', 'recorded', 'u1', 'payment-ledger-link-0001'
    );
  `);
  const income = {
    ...entryInput,
    direction: 'income',
    categoryId: 'income-other',
    paymentEntryId: 'p1',
    description: 'Syntetyczne ujęcie wpłaty',
  };
  assert.equal((await worker.fetch(post('/api/ledger', income, 'ledger-payment-link-0001'), env)).status, 201);
  const duplicate = await worker.fetch(post('/api/ledger', {
    ...income,
    description: 'Drugie ujęcie tej samej wpłaty',
  }, 'ledger-payment-link-0002'), env);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'payment_already_linked' });

  const expenseLink = await worker.fetch(post('/api/ledger', {
    ...entryInput,
    paymentEntryId: 'p1',
  }, 'ledger-payment-link-0003'), env);
  assert.equal(expenseLink.status, 400);
  assert.deepEqual(await expenseLink.json(), { error: 'invalid_payment_link' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_entries').get().count, 1);
});

test('ledger correction is audited, idempotent and reflected in paginated list', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  const first = await worker.fetch(post('/api/ledger', entryInput, 'ledger-list-key-0001'), env);
  const firstId = (await first.json()).entry.id;
  const correctionPath = `/api/ledger/${firstId}/corrections`;
  const correction = { amountCents: 2500, reason: 'Syntetyczna korekta częściowa' };
  const corrected = await worker.fetch(post(correctionPath, correction, 'ledger-correction-key-0001'), env);
  assert.equal(corrected.status, 201);
  const correctionId = (await corrected.json()).correction.id;
  const retry = await worker.fetch(post(correctionPath, correction, 'ledger-correction-key-0001'), env);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).correction.id, correctionId);

  await worker.fetch(post('/api/ledger', {
    ...entryInput,
    amountCents: 5000,
    occurredOn: '2026-09-26',
    description: 'Drugi syntetyczny wydatek',
    sourceDocumentId: null,
  }, 'ledger-list-key-0002'), env);
  const pageOne = await worker.fetch(get('/api/ledger?schoolYearId=y2026&direction=expense&limit=1'), env);
  assert.equal(pageOne.status, 200);
  const firstPage = await pageOne.json();
  assert.equal(firstPage.entries.length, 1);
  assert.equal(firstPage.entries[0].id, firstId);
  assert.equal(firstPage.entries[0].correctedCents, 2500);
  assert.equal(firstPage.entries[0].netAmountCents, 10000);
  assert.ok(firstPage.nextCursor);
  const pageTwo = await worker.fetch(get(
    `/api/ledger?schoolYearId=y2026&direction=expense&limit=1&cursor=${firstPage.nextCursor}`,
  ), env);
  const secondPage = await pageTwo.json();
  assert.equal(secondPage.entries.length, 1);
  assert.equal(secondPage.entries[0].amountCents, 5000);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'ledger.correction.created'").get().count,
    1,
  );

  const excessive = await worker.fetch(post(correctionPath, {
    amountCents: 10001,
    reason: 'Korekta przekraczająca pozostałą kwotę',
  }, 'ledger-correction-key-0002'), env);
  assert.equal(excessive.status, 409);
  assert.deepEqual(await excessive.json(), { error: 'correction_exceeds_remaining_amount' });
});

test('ledger list rejects missing scope, invalid cursor and unauthorized access', async () => {
  const { db, env } = await setup();
  assert.equal((await worker.fetch(get('/api/ledger'), env)).status, 400);
  assert.equal((await worker.fetch(get('/api/ledger?schoolYearId=y2026&cursor=bad'), env)).status, 400);
  assert.equal((await worker.fetch(get('/api/ledger?schoolYearId=y2025'), env)).status, 403);
  db.close();

  for (const options of [{ mfa: false }, { role: 'representative' }]) {
    const scoped = await setup(options);
    const response = await worker.fetch(get('/api/ledger?schoolYearId=y2026'), scoped.env);
    assert.equal(response.status, 403);
    scoped.db.close();
  }
});

test('ledger overview returns active categories, yearly balance and current budget revision', async t => {
  const { db, env } = await setup();
  t.after(() => db.close());
  db.exec(`
    UPDATE ledger_categories SET active = 0 WHERE id = 'income-other';
    INSERT INTO ledger_opening_balances (
      id, school_year_id, amount_cents, note, created_by, idempotency_key
    ) VALUES ('ob1', 'y2026', 1000, 'Bilans syntetyczny', 'u1', 'overview-opening-0001');
    INSERT INTO ledger_budget_lines (
      id, school_year_id, category_id, planned_cents, note, created_by, idempotency_key
    ) VALUES ('bl1', 'y2026', 'expense-events', 20000, 'Plan początkowy', 'u1', 'overview-budget-0001');
    INSERT INTO ledger_budget_lines (
      id, school_year_id, category_id, planned_cents, note, supersedes_id, created_by, idempotency_key
    ) VALUES (
      'bl2', 'y2026', 'expense-events', 18000, 'Plan poprawiony', 'bl1', 'u1', 'overview-budget-0002'
    );
  `);
  assert.equal((await worker.fetch(post('/api/ledger', entryInput, 'overview-entry-0001'), env)).status, 201);

  const categoriesResponse = await worker.fetch(get('/api/ledger/categories?schoolYearId=y2026'), env);
  assert.equal(categoriesResponse.status, 200);
  assert.deepEqual(await categoriesResponse.json(), {
    categories: [{ id: 'expense-events', direction: 'expense', name: 'Wydarzenia' }],
  });
  const filtered = await worker.fetch(get(
    '/api/ledger/categories?schoolYearId=y2026&direction=income',
  ), env);
  assert.deepEqual(await filtered.json(), { categories: [] });

  const summaryResponse = await worker.fetch(get('/api/ledger/summary?schoolYearId=y2026'), env);
  assert.equal(summaryResponse.status, 200);
  assert.deepEqual(await summaryResponse.json(), { summary: {
    schoolYearId: 'y2026',
    openingBalanceCents: 1000,
    incomeCents: 0,
    expenseCents: 12500,
    closingBalanceCents: -11500,
  } });

  const budgetResponse = await worker.fetch(get('/api/ledger/budget?schoolYearId=y2026'), env);
  assert.equal(budgetResponse.status, 200);
  assert.deepEqual(await budgetResponse.json(), { budget: [{
    id: 'bl2',
    categoryId: 'expense-events',
    categoryName: 'Wydarzenia',
    direction: 'expense',
    plannedCents: 18000,
    note: 'Plan poprawiony',
    supersedesId: 'bl1',
  }] });
});

test('ledger overview endpoints enforce MFA, role and school-year scope', async () => {
  const paths = [
    '/api/ledger/categories?schoolYearId=y2026',
    '/api/ledger/summary?schoolYearId=y2026',
    '/api/ledger/budget?schoolYearId=y2026',
  ];
  for (const options of [{ mfa: false }, { role: 'representative' }]) {
    const { db, env } = await setup(options);
    for (const path of paths) assert.equal((await worker.fetch(get(path), env)).status, 403);
    db.close();
  }
  const { db, env } = await setup();
  for (const suffix of ['categories', 'summary', 'budget']) {
    assert.equal((await worker.fetch(get(`/api/ledger/${suffix}?schoolYearId=y2025`), env)).status, 403);
  }
  db.close();
});
