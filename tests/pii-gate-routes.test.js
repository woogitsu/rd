// #152: bramka danych osobowych w trasach zapisu pól wolnego tekstu (tabele
// niezmienne). Wyłącznie dane syntetyczne (.invalid, IBAN testowe).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { cancelTask, createDraft, createTask } from '../src/pg/events.js';
import { createTestDb, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { SYNTHETIC_PHONE_IN_TEXT } from './helpers/assertions.js';

const BASE = 'https://rd.example';
const EMAIL_TEXT = 'Zwrot dla rodzic@example.invalid za wycieczkę';
const IBAN_TEXT = 'Zwrot na konto BE68 5390 0754 7034 za wycieczkę';
const PHONE_TEXT = 'Zwrot, kontakt +32 470 12 34 56';

function call(cookie, path, { body, key } = {}) {
  const headers = new Headers({ Cookie: cookie, Origin: BASE, 'Content-Type': 'application/json' });
  if (key) headers.set('Idempotency-Key', key);
  return new Request(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function post(backend, cookie, path, body, key) {
  const response = await handlePgRequest(call(cookie, path, { body, key }), backend.env);
  const text = await response.text();
  return { status: response.status, replayed: response.headers.get('Idempotency-Replayed'), body: text ? JSON.parse(text) : null };
}

async function backendWithFinance() {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y2026');
  const treasurer = await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y2026' }] });
  const board = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board', schoolYearId: 'y2026' }] });
  // #205: wpłata przyjmuje gospodarstwo z uczniem zapisanym w roku wpłaty.
  await seedEnrolledHousehold(db, 'h1', ['y2026']);
  await seedEnrolledHousehold(db, 'h2', ['y2026']);
  await db.exec(`
    INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by, active)
      VALUES ('expense-events', 'y2026', 'expense', 'Wydarzenia', 'u-treasurer', true);
    INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
      VALUES ('p1', 'h1', 'y2026', 5000, '2026-09-20', 'bank', 'recorded', 'u-treasurer', 'seed-payment-0001'),
             ('p2', NULL, 'y2026', 3000, '2026-09-21', 'bank', 'unmatched', 'u-treasurer', 'seed-payment-0002');
  `);
  const count = async (table) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const auditMetadata = async (action) => {
    const { rows } = await db.query('SELECT metadata_json FROM audit_events WHERE action = $1 ORDER BY occurred_at DESC LIMIT 1', [action]);
    const raw = rows[0]?.metadata_json;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  };
  return { db, env: { db }, treasurer, board, count, auditMetadata, close: () => db.close() };
}

const entryBody = (description, extra = {}) => ({
  schoolYearId: 'y2026', direction: 'expense', amountCents: 1000, categoryId: 'expense-events',
  description, occurredOn: '2026-09-27', method: 'bank', ...extra,
});

test('#152 payments: tytuł wpłaty z IBAN jest odrzucany bez obejścia, z telefonem wymaga potwierdzenia (jeden wpis mimo ponowienia)', async () => {
  const backend = await backendWithFinance();
  try {
    const payment = (reference, extra = {}) => ({
      schoolYearId: 'y2026', householdId: 'h1', amountCents: 2000, receivedOn: '2026-09-28', method: 'bank', reference, ...extra,
    });
    const iban = await post(backend, backend.treasurer, '/api/payments', payment(IBAN_TEXT, { confirmPersonalData: true }), 'pii-pay-0001');
    assert.equal(iban.status, 422);
    assert.equal(iban.body.error, 'personal_data_forbidden');
    assert.deepEqual(iban.body.categories, ['iban']);
    assert.ok(!/5390\s?0754\s?7034/.test(JSON.stringify(iban.body)), 'odpowiedź nie zawiera fragmentu tekstu');
    assert.equal(await backend.count('payment_entries'), 2);

    const blocked = await post(backend, backend.treasurer, '/api/payments', payment(PHONE_TEXT), 'pii-pay-0002');
    assert.equal(blocked.status, 422);
    assert.equal(blocked.body.error, 'possible_personal_data');
    assert.deepEqual(blocked.body.categories, ['phone']);

    const confirmed = await post(backend, backend.treasurer, '/api/payments', payment(PHONE_TEXT, { confirmPersonalData: true }), 'pii-pay-0002');
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.payment.confirmPersonalData, undefined, 'flaga potwierdzenia nie trafia do odpowiedzi');
    const retried = await post(backend, backend.treasurer, '/api/payments', payment(PHONE_TEXT, { confirmPersonalData: true }), 'pii-pay-0002');
    assert.equal(retried.status, 200);
    assert.equal(retried.replayed, 'true');
    assert.equal(await backend.count('payment_entries'), 3);
    const metadata = await backend.auditMetadata('payment.created');
    assert.equal(metadata.piiConfirmed, true);
    assert.deepEqual(metadata.piiCategories, ['phone']);
    assert.ok(!SYNTHETIC_PHONE_IN_TEXT.test(JSON.stringify(metadata)));
  } finally { await backend.close(); }
});

test('#152 payments: zwrot, ponowne przypisanie i cofnięcie części wpłaty — e-mail w powodzie odrzucony (payment_allocation_reversals.reason)', async () => {
  const backend = await backendWithFinance();
  try {
    const refund = await post(backend, backend.treasurer, '/api/payments/p1/refunds',
      { amountCents: 100, refundedOn: '2026-09-28', method: 'bank', reason: EMAIL_TEXT }, 'pii-refund-0001');
    assert.equal(refund.status, 422);
    assert.equal(refund.body.error, 'personal_data_forbidden');
    assert.equal(await backend.count('payment_refunds'), 0);
    const cleanRefund = await post(backend, backend.treasurer, '/api/payments/p1/refunds',
      { amountCents: 100, refundedOn: '2026-09-28', method: 'bank', reason: 'Zwrot nadpłaty za materiały' }, 'pii-refund-0002');
    assert.equal(cleanRefund.status, 201, JSON.stringify(cleanRefund.body));

    const reassign = await post(backend, backend.treasurer, '/api/payments/p1/reassignment',
      { householdId: 'h2', reason: IBAN_TEXT }, 'pii-reassign-0001');
    assert.equal(reassign.status, 422);
    assert.equal(reassign.body.error, 'personal_data_forbidden');
    assert.equal(await backend.count('payment_reassignments'), 0);

    const allocation = await post(backend, backend.treasurer, '/api/payments/p2/allocations',
      { householdId: 'h1', amountCents: 1000 }, 'pii-alloc-0001');
    assert.equal(allocation.status, 201, JSON.stringify(allocation.body));
    const allocationId = allocation.body.allocation.id;
    const reversalPath = `/api/payments/p2/allocations/${allocationId}/reversal`;
    const reversal = await post(backend, backend.treasurer, reversalPath, { reason: EMAIL_TEXT, confirmPersonalData: true }, 'pii-reverse-0001');
    assert.equal(reversal.status, 422);
    assert.equal(reversal.body.error, 'personal_data_forbidden');
    assert.equal(await backend.count('payment_allocation_reversals'), 0);
    const cleanReversal = await post(backend, backend.treasurer, reversalPath, { reason: 'Błędnie przypisana część' }, 'pii-reverse-0002');
    assert.equal(cleanReversal.status, 201, JSON.stringify(cleanReversal.body));
    assert.equal(await backend.count('payment_allocation_reversals'), 1);
  } finally { await backend.close(); }
});

test('#152 księga: opis wpisu, powód korekty i uwaga weryfikacji — bramka po stronie serwera', async () => {
  const backend = await backendWithFinance();
  try {
    const bad = await post(backend, backend.treasurer, '/api/ledger', entryBody(IBAN_TEXT, { confirmPersonalData: true }), 'pii-ledger-0001');
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error, 'personal_data_forbidden');
    assert.equal(await backend.count('ledger_entries'), 0);

    const phone = await post(backend, backend.treasurer, '/api/ledger', entryBody(PHONE_TEXT), 'pii-ledger-0002');
    assert.equal(phone.status, 422);
    assert.equal(phone.body.error, 'possible_personal_data');

    const created = await post(backend, backend.treasurer, '/api/ledger', entryBody('Zakup materiałów plastycznych'), 'pii-ledger-0003');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const entryId = created.body.entry.id;

    const correction = await post(backend, backend.treasurer, `/api/ledger/${entryId}/corrections`,
      { amountCents: 100, reason: EMAIL_TEXT }, 'pii-ledger-0004');
    assert.equal(correction.status, 422);
    assert.equal(correction.body.error, 'personal_data_forbidden');
    assert.equal(await backend.count('ledger_corrections'), 0);

    // Uwaga przy zakwestionowaniu wydatku (druga osoba — cztery oczy).
    const review = await post(backend, backend.board, `/api/ledger/${entryId}/reviews`,
      { decision: 'questioned', note: IBAN_TEXT }, 'pii-ledger-0005');
    assert.equal(review.status, 422);
    assert.equal(review.body.error, 'personal_data_forbidden');
    assert.equal(await backend.count('ledger_entry_reviews'), 0);
    const cleanReview = await post(backend, backend.board, `/api/ledger/${entryId}/reviews`,
      { decision: 'questioned', note: 'Brak faktury do wglądu' }, 'pii-ledger-0006');
    assert.equal(cleanReview.status, 201, JSON.stringify(cleanReview.body));
  } finally { await backend.close(); }
});

test('#152 księga gotówkowa: opis przeniesienia i uwaga do bilansu otwarcia', async () => {
  const backend = await backendWithFinance();
  try {
    const transfer = await post(backend, backend.treasurer, '/api/ledger/transfers', {
      schoolYearId: 'y2026', direction: 'cash_to_bank', amountCents: 1000, transferredOn: '2026-09-28', description: EMAIL_TEXT,
    }, 'pii-transfer-0001');
    assert.equal(transfer.status, 422);
    assert.equal(transfer.body.error, 'personal_data_forbidden');
    assert.equal(await backend.count('ledger_transfers'), 0);

    const opening = await post(backend, backend.board, '/api/ledger/opening-balance', {
      schoolYearId: 'y2026', bankCents: 1000, cashCents: 0, note: IBAN_TEXT,
    }, 'pii-opening-0001');
    assert.equal(opening.status, 422);
    assert.equal(opening.body.error, 'personal_data_forbidden');
    assert.equal(await backend.count('ledger_opening_balances'), 0);
  } finally { await backend.close(); }
});

test('#152 zadania wolontariackie: tytuł i powód odwołania — bramka (e-mail bez obejścia, telefon do potwierdzenia)', async () => {
  const db = new PGlite();
  try {
    for (const migration of await loadMigrations(fileURLToPath(new URL('../postgres/migrations/', import.meta.url)))) await db.exec(migration.sql);
    await db.query("INSERT INTO school_years VALUES ('year','2026/27','2026-09-01','2027-08-31')");
    await db.query("INSERT INTO users (id,email,display_name) VALUES ('board1','board1@example.invalid','Synthetic board1')");
    const board = { userId: 'board1', grants: [{ role: 'board', classId: null, schoolYearId: 'year' }], mfaVerified: true };
    const { event } = await createDraft(db, board, {
      schoolYearId: 'year', title: 'Piknik (syntetyczny)', startsAt: '2026-11-12T10:00', endsAt: '2026-11-12T14:00',
      audience: 'internal', idempotencyKey: 'pii-event-0001',
    });
    await assert.rejects(
      createTask(db, board, { eventId: event.id, title: 'Ciasto od rodzic@example.invalid', slotsNeeded: 2, idempotencyKey: 'pii-task-0001', confirmPersonalData: true }),
      { code: 'personal_data_forbidden', status: 422 },
    );
    await assert.rejects(
      createTask(db, board, { eventId: event.id, title: 'Ciasto, tel. +32 470 12 34 56', slotsNeeded: 2, idempotencyKey: 'pii-task-0002' }),
      { code: 'possible_personal_data', status: 422 },
    );
    assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM event_tasks')).rows[0].n), 0);
    const { task } = await createTask(db, board, { eventId: event.id, title: 'Ciasto na piknik', slotsNeeded: 2, idempotencyKey: 'pii-task-0003' });
    await assert.rejects(
      cancelTask(db, board, { eventId: event.id, taskId: task.id, reason: 'Odwołane, pisz na rodzic@example.invalid', confirmPersonalData: true }),
      { code: 'personal_data_forbidden', status: 422 },
    );
    const cancelled = await cancelTask(db, board, { eventId: event.id, taskId: task.id, reason: 'Odwołane z powodu pogody' });
    assert.equal(cancelled.task.cancelledAt !== null, true);
  } finally { await db.close(); }
});
