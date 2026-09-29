// Dopasowanie zwrotu wpłaty do ujemnej pozycji wyciągu (#138, migracja 0152).
// Wyłącznie dane syntetyczne; kwoty w centach. Działa na PGlite i (RD_TEST_PG_BACKEND=real) na PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-138r';
const NEXT = 'y-138r-next';
const TITLE = 'Tytuł przelewu syntetyczny 138';
let keySeq = 0;
const key = (prefix = 'k') => `${prefix}-138r-${String(++keySeq).padStart(6, '0')}`;

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedEnrolledHousehold(db, 'h-1', [YEAR]);
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true,
    }),
  };
  const call = async (path, { cookie, body, idempotencyKey } = {}) => {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const response = await handlePgRequest(request(path, {
      cookie, headers, method: body === undefined ? 'GET' : 'POST', body,
    }), { db });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return { db, cookies, call };
}

async function createPayment(call, cookie, amountCents) {
  const res = await call('/api/payments', {
    cookie, idempotencyKey: key('pay'),
    body: { schoolYearId: YEAR, householdId: 'h-1', amountCents, receivedOn: '2026-10-01', method: 'bank', reference: 'Wpłata syntetyczna' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.payment.id;
}

async function createRefund(call, cookie, paymentId, amountCents, method = 'bank') {
  const res = await call(`/api/payments/${paymentId}/refunds`, {
    cookie, idempotencyKey: key('ref'),
    body: { amountCents, refundedOn: '2026-10-05', method, reason: 'Zwrot syntetyczny na prośbę rodziny' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.refund.id;
}

async function createDraft(call, cookie, statementBalanceCents = 0) {
  const res = await call('/api/reconciliations', {
    cookie, idempotencyKey: key('rec'),
    body: { schoolYearId: YEAR, statementDate: '2026-10-31', statementBalanceCents },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.reconciliation.id;
}

async function importLines(call, db, cookie, reconciliationId, amounts) {
  const res = await call(`/api/reconciliations/${reconciliationId}/lines`, {
    cookie, idempotencyKey: key('imp'),
    body: { lines: amounts.map((amountCents) => ({ bookedOn: '2026-10-06', amountCents, reference: TITLE })) },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { rows } = await db.query('SELECT id FROM bank_statement_lines WHERE import_id = $1 ORDER BY line_no', [res.body.import.id]);
  return rows.map((row) => row.id);
}

const match = (call, cookie, reconciliationId, statementLineId, target, idempotencyKey = key('m')) =>
  call(`/api/reconciliations/${reconciliationId}/matches`, {
    cookie, idempotencyKey, body: { statementLineId, ...target },
  });

const activeMatches = async (db, reconciliationId) => Number((await db.query(
  'SELECT count(*) AS n FROM bank_reconciliation_matches WHERE reconciliation_id = $1 AND revoked_at IS NULL', [reconciliationId],
)).rows[0].n);

test('zwrot częściowy: wpływ brutto i wypływ dopasowane osobno, zatwierdzenie bez niezgodności', async () => {
  const { db, cookies, call } = await setup();
  try {
    const paymentId = await createPayment(call, cookies.treasurer, 5000);
    const refundId = await createRefund(call, cookies.treasurer, paymentId, 1200);
    const rec = await createDraft(call, cookies.treasurer);
    const [inflow, outflow] = await importLines(call, db, cookies.treasurer, rec, [5000, -1200]);

    // Wpływ 50,00 EUR nadal pasuje do wpłaty mimo zwrotu (zwrot to osobne zdarzenie bankowe).
    const inflowMatch = await match(call, cookies.treasurer, rec, inflow, { paymentEntryId: paymentId });
    assert.equal(inflowMatch.status, 201, JSON.stringify(inflowMatch.body));
    const outflowMatch = await match(call, cookies.treasurer, rec, outflow, { paymentRefundId: refundId });
    assert.equal(outflowMatch.status, 201, JSON.stringify(outflowMatch.body));
    assert.equal(outflowMatch.body.match.paymentRefundId, refundId);
    assert.equal(outflowMatch.body.match.paymentEntryId, null);
    // Kontrakt zwykłych powiązań bez zmian: brak pola paymentRefundId.
    assert.equal('paymentRefundId' in inflowMatch.body.match, false);

    const view = await call(`/api/reconciliations/${rec}`, { cookie: cookies.treasurer });
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.inconsistentMatches ?? [], []);
    assert.equal(view.body.summary.unmatchedLineCount, 0);
    assert.equal(view.body.summary.inconsistentMatchCount, 0);
    const lineOfRefund = view.body.lines.find((line) => line.id === outflow);
    assert.equal(lineOfRefund.match.paymentRefundId, refundId);

    // Zwrot po powiązaniu wpłaty nie unieważnia jej powiązania (dotąd: amount_mismatch).
    const second = await createRefund(call, cookies.treasurer, paymentId, 800);
    assert.ok(second);
    const after = await call(`/api/reconciliations/${rec}`, { cookie: cookies.treasurer });
    assert.equal(after.body.summary.inconsistentMatchCount, 0);

    const confirmed = await call(`/api/reconciliations/${rec}/confirm`, { cookie: cookies.board, body: {} });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

    // Audyt: reconciliation.match.confirmed z schoolYearId i celem, bez tytułu przelewu.
    const events = (await db.query(
      "SELECT metadata_json FROM audit_events WHERE action = 'reconciliation.match.confirmed' ORDER BY occurred_at",
    )).rows.map((row) => (typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json));
    assert.equal(events.length, 2);
    const refundEvent = events.find((event) => event.paymentRefundId === refundId);
    assert.equal(refundEvent.schoolYearId, YEAR);
    assert.equal(refundEvent.reconciliationId, rec);
    assert.equal('paymentRefundId' in events.find((event) => event.paymentEntryId === paymentId), false);
    assert.equal(JSON.stringify(events).includes(TITLE), false);
    assert.equal(JSON.stringify(events).includes('Tytuł'), false);
  } finally { await db.close(); }
});

test('zwrot nie pasuje do dodatniej pozycji ani do innej kwoty; zwrot gotówkowy odrzucony', async () => {
  const { db, cookies, call } = await setup();
  try {
    const paymentId = await createPayment(call, cookies.treasurer, 5000);
    const refundId = await createRefund(call, cookies.treasurer, paymentId, 1200);
    const cashRefundId = await createRefund(call, cookies.treasurer, paymentId, 300, 'cash');
    const rec = await createDraft(call, cookies.treasurer);
    const [positive, wrongAmount, cashLine, exactLine] = await importLines(call, db, cookies.treasurer, rec, [1200, -1000, -300, -1200]);

    const toPositive = await match(call, cookies.treasurer, rec, positive, { paymentRefundId: refundId });
    assert.equal(toPositive.status, 409, JSON.stringify(toPositive.body));
    assert.equal(toPositive.body.error, 'match_amount_mismatch');
    const toWrong = await match(call, cookies.treasurer, rec, wrongAmount, { paymentRefundId: refundId });
    assert.equal(toWrong.status, 409);
    assert.equal(toWrong.body.error, 'match_amount_mismatch');
    const cash = await match(call, cookies.treasurer, rec, cashLine, { paymentRefundId: cashRefundId });
    assert.equal(cash.status, 409);
    assert.equal(cash.body.error, 'match_method_mismatch');
    assert.equal(await activeMatches(db, rec), 0);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE action = 'reconciliation.match.confirmed'")).rows[0].n), 0);

    // Wpłata (wpływ) nie pasuje do ujemnej pozycji o jej kwocie po zwrocie.
    const paymentToNegative = await match(call, cookies.treasurer, rec, wrongAmount, { paymentEntryId: paymentId });
    assert.equal(paymentToNegative.status, 409);

    // Baza odrzuca to samo przy bezpośrednim INSERT (backstop).
    await assert.rejects(db.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id,
      payment_refund_id, created_by, idempotency_key) VALUES ('m-sql-1', $1, $2, $3, 'u-treasurer', 'm-sql-key-0001')`,
    [rec, positive, refundId]), /bank_match_amount_mismatch/);
    // Dwa cele naraz albo brak celu: CHECK.
    await assert.rejects(db.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id,
      payment_entry_id, payment_refund_id, created_by, idempotency_key) VALUES ('m-sql-2', $1, $2, $3, $4, 'u-treasurer', 'm-sql-key-0002')`,
    [rec, exactLine, paymentId, refundId]), /bank_match_single_target/);

    // Niepoprawne żądania API: dwa cele albo zły identyfikator.
    const both = await match(call, cookies.treasurer, rec, wrongAmount, { paymentEntryId: paymentId, paymentRefundId: refundId });
    assert.equal(both.status, 400);
    const unknown = await match(call, cookies.treasurer, rec, wrongAmount, { paymentRefundId: 'nie-ma-takiego-zwrotu' });
    assert.equal(unknown.status, 400);
  } finally { await db.close(); }
});

test('podwójne kliknięcie i ponowienie: ten sam klucz odtwarza wynik, konflikty dają 409', async () => {
  const { db, cookies, call } = await setup();
  try {
    const paymentId = await createPayment(call, cookies.treasurer, 5000);
    const refundId = await createRefund(call, cookies.treasurer, paymentId, 1200);
    const otherRefundId = await createRefund(call, cookies.treasurer, paymentId, 1200);
    const rec = await createDraft(call, cookies.treasurer);
    const [line, line2] = await importLines(call, db, cookies.treasurer, rec, [-1200, -1200]);

    const idem = key('dbl');
    const [first, second] = await Promise.all([
      match(call, cookies.treasurer, rec, line, { paymentRefundId: refundId }, idem),
      match(call, cookies.treasurer, rec, line, { paymentRefundId: refundId }, idem),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 201]);
    const replay = first.status === 200 ? first : second;
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.equal(first.body.match.id, second.body.match.id);
    assert.equal(await activeMatches(db, rec), 1);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE action = 'reconciliation.match.confirmed'")).rows[0].n), 1);

    // Ponowienie po sukcesie (utrata odpowiedzi) nadal odtwarza wynik.
    const again = await match(call, cookies.treasurer, rec, line, { paymentRefundId: refundId }, idem);
    assert.equal(again.status, 200);
    // Ten sam klucz z innym zwrotem — konflikt idempotencji.
    const conflict = await match(call, cookies.treasurer, rec, line, { paymentRefundId: otherRefundId }, idem);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'idempotency_conflict');
    // Nowy klucz: pozycja zajęta i zwrot już powiązany.
    const lineTaken = await match(call, cookies.treasurer, rec, line, { paymentRefundId: otherRefundId });
    assert.equal(lineTaken.status, 409);
    assert.equal(lineTaken.body.error, 'already_matched');
    const refundTaken = await match(call, cookies.treasurer, rec, line2, { paymentRefundId: refundId });
    assert.equal(refundTaken.status, 409);
    assert.equal(refundTaken.body.error, 'already_matched');
    assert.equal(await activeMatches(db, rec), 1);
  } finally { await db.close(); }
});

test('zwrot powiązany w jednym uzgodnieniu roku nie może być w drugim; cofnięcie zwalnia, powiązanie jest niezmienne', async () => {
  const { db, cookies, call } = await setup();
  try {
    const paymentId = await createPayment(call, cookies.treasurer, 5000);
    const refundId = await createRefund(call, cookies.treasurer, paymentId, 1200);
    const recA = await createDraft(call, cookies.treasurer);
    const recB = await createDraft(call, cookies.treasurer);
    const [lineA] = await importLines(call, db, cookies.treasurer, recA, [-1200]);
    const [lineB] = await importLines(call, db, cookies.treasurer, recB, [-1200]);
    const first = await match(call, cookies.treasurer, recA, lineA, { paymentRefundId: refundId });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const elsewhere = await match(call, cookies.treasurer, recB, lineB, { paymentRefundId: refundId });
    assert.equal(elsewhere.status, 409);
    assert.equal(elsewhere.body.error, 'matched_in_other_reconciliation');
    assert.equal(elsewhere.body.reconciliationId, recA);
    // Baza (backstop, bez ścieżki API).
    await assert.rejects(db.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id, statement_line_id,
      payment_refund_id, created_by, idempotency_key) VALUES ('m-sql-3', $1, $2, $3, 'u-treasurer', 'm-sql-key-0003')`,
    [recB, lineB, refundId]), /bank_match_in_other_reconciliation/);

    // Fakty powiązania są niezmienne, także cel zwrotu.
    await assert.rejects(db.query(
      "UPDATE bank_reconciliation_matches SET payment_refund_id = NULL, payment_entry_id = $1 WHERE id = $2",
      [paymentId, first.body.match.id],
    ), /bank_match_facts_immutable|bank_match_single_target/);

    const revoked = await call(`/api/reconciliations/${recA}/matches/${first.body.match.id}/revocation`, {
      cookie: cookies.treasurer, body: { reason: 'Błędne dopasowanie — syntetyczne' },
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.match.paymentRefundId, refundId);
    const moved = await match(call, cookies.treasurer, recB, lineB, { paymentRefundId: refundId });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
  } finally { await db.close(); }
});

test('zamknięty rok: dopasowanie zwrotu → 409 school_year_closed, nic nie zapisano', async () => {
  const { db, cookies, call } = await setup();
  try {
    const paymentId = await createPayment(call, cookies.treasurer, 5000);
    const refundId = await createRefund(call, cookies.treasurer, paymentId, 1200);
    const rec = await createDraft(call, cookies.treasurer);
    const [line] = await importLines(call, db, cookies.treasurer, rec, [-1200]);
    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
        closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
        carried_opening_balance_id, expired_grant_count)
      VALUES ('clo-138r', '${YEAR}', '${NEXT}', 'closed', 'u-treasurer', 'u-board', now(), 0, 0, 0, 0, 'ob-138r', 0);
      SET session_replication_role = origin;
    `);
    const closed = await match(call, cookies.treasurer, rec, line, { paymentRefundId: refundId });
    assert.equal(closed.status, 409, JSON.stringify(closed.body));
    assert.equal(closed.body.error, 'school_year_closed');
    assert.equal(await activeMatches(db, rec), 0);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM audit_events WHERE action = 'reconciliation.match.confirmed'")).rows[0].n), 0);
  } finally { await db.close(); }
});

test('przedstawiciel klasy i brak sesji nie dopasują zwrotu; zwrot z innego roku odrzucony', async () => {
  const { db, cookies, call } = await setup();
  try {
    const paymentId = await createPayment(call, cookies.treasurer, 5000);
    const refundId = await createRefund(call, cookies.treasurer, paymentId, 1200);
    const rec = await createDraft(call, cookies.treasurer);
    const [line] = await importLines(call, db, cookies.treasurer, rec, [-1200]);
    assert.equal((await match(call, cookies.rep, rec, line, { paymentRefundId: refundId })).status, 403);
    assert.equal((await match(call, undefined, rec, line, { paymentRefundId: refundId })).status, 401);
    assert.equal(await activeMatches(db, rec), 0);

    // Zwrot wpłaty z innego roku szkolnego niż uzgodnienie: niepoprawny cel.
    await seedEnrolledHousehold(db, 'h-2', [NEXT]);
    await db.query(`INSERT INTO payment_entries (id, school_year_id, household_id, amount_cents, received_on, method,
      reference, status, created_by, idempotency_key) VALUES ('p-next', $1, 'h-2', 3000, '2027-09-05', 'bank',
      'Syntetyczna', 'recorded', 'u-treasurer', 'p-next-key-0001')`, [NEXT]);
    await db.query(`INSERT INTO payment_refunds (id, payment_entry_id, amount_cents, refunded_on, method, reason,
      created_by, idempotency_key) VALUES ('rf-next', 'p-next', 1200, '2027-09-06', 'bank', 'Zwrot syntetyczny',
      'u-treasurer', 'rf-next-key-0001')`);
    const wrongYear = await match(call, cookies.treasurer, rec, line, { paymentRefundId: 'rf-next' });
    assert.equal(wrongYear.status, 400, JSON.stringify(wrongYear.body));
    assert.equal(wrongYear.body.error, 'invalid_match_target');
  } finally { await db.close(); }
});
