// Ostrzeżenia informacyjne przed zamknięciem roku i przegląd dziennika odczytu
// (#80, #133). Wyłącznie dane syntetyczne. Ostrzeżenia nie blokują zamknięcia.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS, CLOSE_WARNING_CODES } from '../src/pg/routes/year-close.js';
import { createTestDb, request, seedClass, seedUserSession } from './helpers/pg.js';

const OLD = 'y-2026';
const NEW = 'y-2027';
const LOG_ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const get = (env, path, cookie) => handlePgRequest(request(path, { cookie }), env);
const post = (env, path, cookie, body = {}) => handlePgRequest(request(path, { method: 'POST', cookie, body }), env);
const warningsOf = async (env, cookie) => {
  const response = await get(env, `/api/year-close/${OLD}`, cookie);
  assert.equal(response.status, 200);
  return response.json();
};
const byCode = (body) => Object.fromEntries(body.warnings.map((w) => [w.code, w]));

describe('ostrzeżenia year-close (#80) i przegląd odczytów (#133)', () => {
  let db; let env; let cookies;
  before(async () => {
    db = await createTestDb();
    env = { db };
    await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
      ($1, '2026/27 test', '2026-09-01', '2027-08-31'), ($2, '2027/28 test', '2027-09-01', '2028-08-31')`, [OLD, NEW]);
    await seedClass(db, { id: 'c-1a', schoolYearId: OLD, name: '1A' });
    cookies = {
      boardA: await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
      boardB: await seedUserSession(db, { userId: 'u-board-b', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
      treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: OLD }], mfa: true }),
      rep: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', schoolYearId: OLD, classId: 'c-1a' }], mfa: true }),
      auditor: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: OLD }], mfa: true }),
    };
    await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
      ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-treasurer'), ('cat-out', $1, 'expense', 'Wydarzenia', 'u-treasurer')`, [OLD]);
  });
  after(() => db.close());

  test('pusty rok: brak ostrzeżeń poza brakiem uzgodnienia; kształt odpowiedzi', async () => {
    const body = await warningsOf(env, cookies.treasurer);
    assert.deepEqual(body.warnings, [{ code: 'reconciliation_missing', count: 1, amountCents: null }]);
    assert.equal(body.accessReview.informational, true);
    assert.deepEqual(body.accessReview.reads, []);
    assert.deepEqual(body.accessReview.readsWithoutValidGrant, { entries: 0, hits: 0, actors: 0 });
    for (const w of body.warnings) assert.ok(CLOSE_WARNING_CODES.includes(w.code));
  });

  test('ostrzeżenia z liczbami: wpłaty nieprzypisane, wydatki bez dowodu, wydatek > 3000 EUR bez uchwały, szkic, kampania', async () => {
    await db.query("INSERT INTO households (id) VALUES ('h-1')");
    await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
      VALUES ('p-ok', 'h-1', $1, 2000, '2026-10-02', 'bank', 'recorded', 'u-treasurer', 'p-ok-key-0001'),
             ('p-un', NULL, $1, 1500, '2026-10-03', 'bank', 'unmatched', 'u-treasurer', 'p-un-key-0001')`, [OLD]);
    await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key, resolution_reference) VALUES
      ('le-in', $1, 'income', 120000, 'cat-in', 'Wpływy', '2026-10-01', 'bank', 'u-treasurer', 'le-in-key-1', NULL),
      ('le-out', $1, 'expense', 30000, 'cat-out', 'Wydatek', '2026-11-01', 'bank', 'u-treasurer', 'le-out-key-1', NULL),
      ('le-big', $1, 'expense', 350000, 'cat-out', 'Duży wydatek', '2026-12-01', 'bank', 'u-treasurer', 'le-big-key-1', 'U/99/2026')`, [OLD]);
    await db.query(`INSERT INTO bank_reconciliations (id, school_year_id, statement_date, statement_balance_cents, ledger_balance_cents,
        ledger_non_bank_cents, reference_salt, created_by, idempotency_key)
      VALUES ('br-draft', $1, '2027-01-15', 0, 0, 0, repeat('b', 32), 'u-treasurer', 'br-draft-key-1')`, [OLD]);
    await db.query(`INSERT INTO bank_statement_imports (id, reconciliation_id, source, line_count, request_hash, created_by, idempotency_key)
      VALUES ('bi-1', 'br-draft', 'manual', 2, $1, 'u-treasurer', 'bi-1-key-00001')`, ['a'.repeat(64)]);
    await db.query(`INSERT INTO bank_statement_lines (id, reconciliation_id, import_id, line_no, booked_on, amount_cents, created_by) VALUES
      ('bl-1', 'br-draft', 'bi-1', 1, '2027-01-10', 4000, 'u-treasurer'), ('bl-2', 'br-draft', 'bi-1', 2, '2027-01-11', -1000, 'u-treasurer')`);
    await db.query(`INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, status, created_by, updated_by, idempotency_key)
      VALUES ('camp-1', $1, 'Szkic', 'all_households', 'Temat', repeat('x', 30), $2, 'draft', 'u-treasurer', 'u-treasurer', 'idem-camp-1'),
             ('camp-2', $1, 'Anulowana', 'all_households', 'Temat', repeat('y', 30), $2, 'draft', 'u-treasurer', 'u-treasurer', 'idem-camp-2')`, [OLD, 'c'.repeat(64)]);
    await db.query(`UPDATE email_campaigns SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'u-treasurer' WHERE id = 'camp-2'`);

    const body = await warningsOf(env, cookies.boardA);
    const w = byCode(body);
    assert.deepEqual(body.warnings.map((x) => x.code), [
      'unallocated_payments', 'payments_not_in_ledger', 'expenses_without_evidence', 'large_expenses_without_resolution',
      'reconciliation_missing', 'reconciliation_drafts', 'unmatched_statement_lines', 'open_email_campaigns',
    ]);
    assert.deepEqual(w.unallocated_payments, { code: 'unallocated_payments', count: 1, amountCents: 1500 });
    // #138: wpłata zapisana bez ujęcia w księdze (unmatched nie liczy się — nie ma jeszcze gospodarstwa).
    assert.deepEqual(w.payments_not_in_ledger, { code: 'payments_not_in_ledger', count: 1, amountCents: 2000 });
    assert.equal(w.payment_ledger_amount_mismatch, undefined);
    assert.deepEqual([w.expenses_without_evidence.count, w.expenses_without_evidence.amountCents], [2, 380000]);
    assert.deepEqual([w.large_expenses_without_resolution.count, w.large_expenses_without_resolution.amountCents], [1, 350000]);
    assert.deepEqual([w.reconciliation_drafts.count, w.unmatched_statement_lines.count, w.unmatched_statement_lines.amountCents], [1, 2, 5000]);
    assert.equal(w.open_email_campaigns.count, 1);
    // Bez danych osobowych i opisów wpisów.
    const text = JSON.stringify(body.warnings);
    assert.doesNotMatch(text, /Duży wydatek|u-treasurer|h-1|example/);
  });

  test('częściowe przypisanie wpłaty zmniejsza kwotę nieprzypisaną; pełne usuwa ostrzeżenie', async () => {
    await db.query(`INSERT INTO payment_allocations (id, payment_entry_id, school_year_id, household_id, amount_cents, created_by, idempotency_key)
      VALUES ('pa-1', 'p-un', $1, 'h-1', 500, 'u-treasurer', 'pa-1-key-00001')`, [OLD]);
    let w = byCode(await warningsOf(env, cookies.boardA));
    assert.deepEqual([w.unallocated_payments.count, w.unallocated_payments.amountCents], [1, 1000]);
    await db.query(`INSERT INTO households (id) VALUES ('h-2')`);
    await db.query(`INSERT INTO payment_allocations (id, payment_entry_id, school_year_id, household_id, amount_cents, created_by, idempotency_key)
      VALUES ('pa-2', 'p-un', $1, 'h-2', 1000, 'u-treasurer', 'pa-2-key-00001')`, [OLD]);
    w = byCode(await warningsOf(env, cookies.boardA));
    assert.equal(w.unallocated_payments, undefined);
  });

  test('#138: wpłata ↔ księga: nieujęte i różnica netto są wskaźnikami; korekta i zwrot z korektą księgi zostają spójne', async () => {
    const ledgerRow = (id, paymentId, cents, key) => db.query(
      `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key, payment_entry_id)
       VALUES ($1, $2, 'income', $3, 'cat-in', 'Wpłata', '2026-10-05', 'bank', 'u-treasurer', $4, $5)`,
      [id, OLD, cents, key, paymentId],
    );
    const flags = async () => byCode(await warningsOf(env, cookies.boardA));
    // Ujęcie wpłaty p-ok (2000) w księdze usuwa wskaźnik „nieujęte”.
    await ledgerRow('le-lk-ok', 'p-ok', 2000, 'le-lk-ok-key-1');
    let w = await flags();
    assert.equal(w.payments_not_in_ledger, undefined);
    assert.equal(w.payment_ledger_amount_mismatch, undefined);

    // Dwie wpłaty tej samej rodziny (dwoje opiekunów): obie poprawne, brak ostrzeżenia „duplikat”.
    await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
      VALUES ('p-twin-a', 'h-1', $1, 5000, '2026-10-06', 'bank', 'recorded', 'u-treasurer', 'p-twin-a-key-1'),
             ('p-twin-b', 'h-1', $1, 5000, '2026-10-06', 'bank', 'recorded', 'u-treasurer', 'p-twin-b-key-1')`, [OLD]);
    w = await flags();
    assert.deepEqual([w.payments_not_in_ledger.count, w.payments_not_in_ledger.amountCents], [2, 10000]);
    assert.deepEqual(Object.keys(w).filter((code) => /dup/i.test(code)), []);
    await ledgerRow('le-twin-a', 'p-twin-a', 5000, 'le-twin-a-key-1');
    await ledgerRow('le-twin-b', 'p-twin-b', 5000, 'le-twin-b-key-1');
    assert.equal((await flags()).payments_not_in_ledger, undefined);

    // Korekta częściowa i zwrot: najpierw korekta księgi, potem wpłaty — sumy zgodne, brak wskaźników.
    const correction = async (ledgerId, paymentId, table, cents, key) => {
      await db.query(`INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
        VALUES ($1, $2, $3, 'Korekta testowa', 'u-treasurer', $4)`, [`lc-${key}`, ledgerId, cents, `lc-${key}-key`]);
      await db.query(table === 'refund'
        ? `INSERT INTO payment_refunds (id, payment_entry_id, amount_cents, refunded_on, method, reason, created_by, idempotency_key)
           VALUES ($1, $2, $3, '2026-10-20', 'bank', 'Zwrot testowy', 'u-treasurer', $4)`
        : `INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
           VALUES ($1, $2, $3, 'Korekta testowa', 'u-treasurer', $4)`,
      [`pc-${key}`, paymentId, cents, `pc-${key}-key`]);
    };
    await correction('le-twin-a', 'p-twin-a', 'correction', 1000, 'twin-a-1');
    await correction('le-twin-a', 'p-twin-a', 'refund', 500, 'twin-a-2');
    w = await flags();
    assert.equal(w.payment_ledger_amount_mismatch, undefined);
    assert.equal(w.payments_not_in_ledger, undefined);

    // Zwrot całości netto: wpłata zeruje się i nie liczy jako „nieujęta”.
    await correction('le-twin-b', 'p-twin-b', 'refund', 5000, 'twin-b-1');
    assert.equal((await flags()).payments_not_in_ledger, undefined);

    // Różnica powstaje tylko w trybie odtworzenia (import historyczny); API jej nie tworzy.
    await db.query(`INSERT INTO households (id) VALUES ('h-3') ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
      VALUES ('p-mm', 'h-3', $1, 2500, '2026-10-07', 'bank', 'recorded', 'u-treasurer', 'p-mm-key-0001')`, [OLD]);
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('rd.restore', 'on', true)`);
      await tx.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key, payment_entry_id)
        VALUES ('le-mm', $1, 'income', 25000, 'cat-in', 'Wpłata', '2026-10-07', 'bank', 'u-treasurer', 'le-mm-key-0001', 'p-mm')`, [OLD]);
    });
    const body = await warningsOf(env, cookies.boardA);
    w = byCode(body);
    assert.deepEqual(w.payment_ledger_amount_mismatch, { code: 'payment_ledger_amount_mismatch', count: 1, amountCents: 22500 });
    assert.equal(w.payments_not_in_ledger, undefined);
    for (const warning of body.warnings) assert.ok(CLOSE_WARNING_CODES.includes(warning.code));
    assert.doesNotMatch(JSON.stringify(body.warnings), /p-mm|h-3|h-1|twin/);
    // Raport niczego nie poprawia z urzędu.
    assert.equal(Number((await db.query(`SELECT amount_cents FROM ledger_entries WHERE id = 'le-mm'`)).rows[0].amount_cents), 25000);
  });

  test('zatwierdzone uzgodnienie z datą przed końcem roku i różnicą: dwa ostrzeżenia zamiast „brak”', async () => {
    await db.query(`INSERT INTO bank_reconciliations (id, school_year_id, statement_date, statement_balance_cents, ledger_balance_cents,
        ledger_non_bank_cents, reference_salt, created_by, idempotency_key)
      VALUES ('br-conf', $1, '2027-02-15', 700, 0, 0, repeat('c', 32), 'u-treasurer', 'br-conf-key-1')`, [OLD]);
    await db.query(`UPDATE bank_reconciliations SET status = 'confirmed', confirmed_by = 'u-board-a', confirmed_at = now(),
        confirmation_note = 'Test' WHERE id = 'br-conf'`);
    const w = byCode(await warningsOf(env, cookies.boardA));
    assert.equal(w.reconciliation_missing, undefined);
    assert.equal(w.reconciliation_drafts.count, 1, 'szkic z wcześniejszego kroku nadal widoczny');
    assert.deepEqual(w.reconciliation_before_year_end, { code: 'reconciliation_before_year_end', count: 1, amountCents: null });
    const stored = (await db.query("SELECT ledger_balance_cents FROM bank_reconciliations WHERE id = 'br-conf'")).rows[0];
    assert.deepEqual(w.reconciliation_difference, { code: 'reconciliation_difference', count: 1, amountCents: 700 - Number(stored.ledger_balance_cents) });
    assert.notEqual(w.reconciliation_difference.amountCents, 0);
  });

  test('przegląd dziennika odczytu: liczby wg rodzaju, odczyty bez ważnego przydziału, bez identyfikatorów', async () => {
    await db.query(`INSERT INTO users (id, email, display_name) VALUES ('u-gone', 'gone@example.invalid', 'Syntetyczny')
      ON CONFLICT (id) DO NOTHING`).catch(() => {});
    await db.query(`INSERT INTO data_access_log (id, actor_id, access_kind, school_year_id, class_id, household_id, outcome, row_count, hit_count) VALUES
      ($1, 'u-rep', 'class_students', $5, 'c-1a', NULL, 'ok', 20, 3),
      ($2, 'u-treasurer', 'payment_list', $5, NULL, NULL, 'ok', 5, 1),
      ($3, 'u-rep', 'household_card', $5, 'c-1a', 'h-1', 'ok', 1, 1),
      ($4, 'u-rep', 'print_cards', $5, 'c-1a', NULL, 'not_found', 0, 1)`,
    [LOG_ID(1), LOG_ID(2), LOG_ID(3), LOG_ID(4), OLD]);
    const body = await warningsOf(env, cookies.boardA);
    const kinds = Object.fromEntries(body.accessReview.reads.map((r) => [r.accessKind, r]));
    assert.deepEqual([kinds.class_students.hits, kinds.household_card.hits, kinds.payment_list.hits], [3, 1, 1]);
    assert.equal(kinds.print_cards, undefined, 'odczyt z wynikiem not_found nie liczy się jako odczyt danych');
    assert.equal(body.accessReview.readsWithoutValidGrant.hits, 0);
    assert.ok(body.accessReview.activeGrantsInScope >= 3);
    // Odczyt po wygaśnięciu przydziału przedstawiciela.
    await db.query(`UPDATE role_grants SET expires_at = (SELECT max(occurred_at) + interval '1 millisecond' FROM data_access_log WHERE actor_id = 'u-rep')
      WHERE user_id = 'u-rep'`);
    await db.query('SELECT pg_sleep(0.05)');
    await db.query(`INSERT INTO data_access_log (id, actor_id, access_kind, school_year_id, class_id, outcome, row_count, hit_count)
      VALUES ($1, 'u-rep', 'class_students', $2, 'c-1a', 'ok', 20, 2)`, [LOG_ID(5), OLD]);
    const after = await warningsOf(env, cookies.boardA);
    assert.equal(after.accessReview.readsWithoutValidGrant.hits, 2);
    assert.equal(after.accessReview.readsWithoutValidGrant.actors, 1);
    assert.doesNotMatch(JSON.stringify(after.accessReview), /u-rep|u-treasurer|h-1|c-1a/);
  });

  test('granice ról: przedstawiciel klasy i Komisja Rewizyjna nie czytają stanu zamknięcia', async () => {
    assert.equal((await get(env, `/api/year-close/${OLD}`, cookies.rep)).status, 403);
    assert.equal((await get(env, `/api/year-close/${OLD}`, cookies.auditor)).status, 403);
    assert.equal((await get(env, `/api/year-close/${OLD}`, cookies.treasurer)).status, 200);
  });

  test('ostrzeżenia nie blokują zamknięcia: rok z ostrzeżeniami zamyka się po liście kontrolnej', async () => {
    const dbg = await get(env, `/api/year-close/${OLD}`, cookies.boardA);
    assert.equal(dbg.status, 200, JSON.stringify(await dbg.clone().json()));
    assert.ok((await dbg.json()).warnings.length >= 4);
    const started = await post(env, `/api/year-close/${OLD}/start`, cookies.boardA, { nextSchoolYearId: NEW });
    assert.equal(started.status, 201);
    for (const [index, item] of CHECKLIST_ITEMS.entries()) {
      const response = await post(env, `/api/year-close/${OLD}/checklist/${item}`, index % 2 ? cookies.treasurer : cookies.boardA, { note: `Potwierdzenie ${item}` });
      assert.equal(response.status, 201, item);
    }
    const closed = await post(env, `/api/year-close/${OLD}/close`, cookies.boardB);
    const closedBody = await closed.json();
    assert.equal(closed.status, 200, JSON.stringify(closedBody));
    const row = (await db.query('SELECT status FROM school_year_closures WHERE school_year_id = $1', [OLD])).rows[0];
    assert.equal(row.status, 'closed');
  });
});
