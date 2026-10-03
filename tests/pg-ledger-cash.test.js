// Kasa i rachunek: bilans otwarcia z podziałem, przeniesienia kasa ↔ rachunek (#199).
// PGlite, wyłącznie dane syntetyczne. Kwoty w centach EUR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { createTestDb, request, seedUserSession, assertOwnerGuard } from './helpers/pg.js';

const OLD = 'y-2026';
const NEW = 'y-2027';
const CASH = 300000; // 3000 EUR w kasie
const BANK = 50000;

let keySeq = 0;
const key = (prefix) => `${prefix}-${String(++keySeq).padStart(6, '0')}`;

async function setup() {
  const db = await createTestDb();
  await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
    ($1, '2026/27 test', '2026-09-01', '2027-08-31'),
    ($2, '2027/28 test', '2027-09-01', '2028-08-31')`, [OLD, NEW]);
  const both = (role) => [{ role, schoolYearId: OLD }, { role, schoolYearId: NEW }];
  const cookies = {
    boardA: await seedUserSession(db, { userId: 'u-board-a', roles: both('board'), mfa: true }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', roles: both('board'), mfa: true }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', roles: both('board'), mfa: false }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: both('treasurer'), mfa: true }),
    rep: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', schoolYearId: OLD, classId: 'c-1a' }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: both('audit'), mfa: true }),
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-treasurer'),
    ('cat-in-new', $2, 'income', 'Składki dobrowolne', 'u-treasurer')`, [OLD, NEW]);
  const env = { db };
  const call = async (method, path, cookie, body, idempotencyKey) => {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { db, env, cookies, call };
}

const count = async (db, table, where = 'true') => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n);

async function reconcile(call, cookie, schoolYearId, statementDate, statementBalanceCents) {
  const created = await call('POST', '/api/reconciliations', cookie, { schoolYearId, statementDate, statementBalanceCents }, key('rec'));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.reconciliation;
}

async function closeOldYear(call, cookies) {
  assert.equal((await call('POST', `/api/year-close/${OLD}/start`, cookies.boardA, { nextSchoolYearId: NEW })).status, 201);
  for (const item of CHECKLIST_ITEMS) {
    assert.equal((await call('POST', `/api/year-close/${OLD}/checklist/${item}`, cookies.boardA, { note: `Potwierdzenie ${item}` })).status, 201);
  }
  const closed = await call('POST', `/api/year-close/${OLD}/close`, cookies.boardB, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  return closed.body;
}

test('symulacja: 3000 EUR w kasie przechodzi na nowy rok, wpłata do banku jako przeniesienie', async () => {
  const { db, cookies, call } = await setup();
  try {
    // Bilans otwarcia pierwszego roku przez API (zarząd + MFA): rachunek 500 EUR, kasa 0.
    const opening = await call('POST', '/api/ledger/opening-balance', cookies.boardA,
      { schoolYearId: OLD, bankCents: BANK, cashCents: 0, note: 'Bilans otwarcia z wyciągu' }, key('ob'));
    assert.equal(opening.status, 201, JSON.stringify(opening.body));
    assert.deepEqual(opening.body.current, { amountCents: BANK, cashCents: 0, bankCents: BANK });

    // Zebrana gotówka 3000 EUR zostaje w kasie skarbnika.
    const cash = await call('POST', '/api/ledger', cookies.treasurer, {
      schoolYearId: OLD, direction: 'income', amountCents: CASH, categoryId: 'cat-in',
      description: 'Składki zebrane gotówką', occurredOn: '2026-11-15', method: 'cash',
    }, key('le'));
    assert.equal(cash.status, 201);

    // Uzgodnienie roku N: wyciąg pokazuje tylko rachunek.
    const recOld = await reconcile(call, cookies.treasurer, OLD, '2027-08-31', BANK);
    assert.equal(recOld.ledgerBalanceCents, BANK + CASH);
    assert.equal(recOld.ledgerNonBankCents, CASH);
    assert.equal(recOld.differenceCents, -CASH);

    const closed = await closeOldYear(call, cookies);
    assert.equal(closed.balance.closingBalanceCents, BANK + CASH);
    assert.equal(closed.balance.closingCashCents, CASH);
    assert.equal(closed.balance.closingBankCents, BANK);

    // Bilans otwarcia N+1 = bilans zamknięcia N, osobno rachunek i kasa; suma bez zmian.
    const nextOpening = await call('GET', `/api/ledger/opening-balance?schoolYearId=${NEW}`, cookies.treasurer);
    assert.equal(nextOpening.status, 200);
    assert.deepEqual(nextOpening.body.current, { amountCents: BANK + CASH, cashCents: CASH, bankCents: BANK });
    assert.equal(nextOpening.body.openingBalance.carriedFromSchoolYearId, OLD);

    // Uzgodnienie N+1 bez żadnej operacji, to samo saldo banku: ta sama różnica, gotówka nadal wyjaśniona.
    const recNew = await reconcile(call, cookies.treasurer, NEW, '2027-09-30', BANK);
    assert.equal(recNew.differenceCents, recOld.differenceCents);
    assert.equal(recNew.ledgerNonBankCents, CASH);

    // Wpłata gotówki na rachunek: przeniesienie wewnętrzne.
    const summaryBefore = (await call('GET', `/api/ledger/summary?schoolYearId=${NEW}`, cookies.treasurer)).body.summary;
    const transferKey = key('tr');
    const body = { schoolYearId: NEW, direction: 'cash_to_bank', amountCents: CASH, transferredOn: '2027-10-01', description: 'Wpłata gotówki z kasy na rachunek' };
    // Podwójne kliknięcie: dwa równoległe żądania z tym samym kluczem → jeden zapis.
    const [first, second] = await Promise.all([
      call('POST', '/api/ledger/transfers', cookies.treasurer, body, transferKey),
      call('POST', '/api/ledger/transfers', cookies.treasurer, body, transferKey),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 201]);
    assert.equal(await count(db, 'ledger_transfers'), 1);
    const transfer = (first.status === 201 ? first : second).body.transfer;

    const summaryAfter = (await call('GET', `/api/ledger/summary?schoolYearId=${NEW}`, cookies.treasurer)).body.summary;
    assert.deepEqual(summaryAfter, summaryBefore, 'przeniesienie nie jest przychodem ani wydatkiem');
    const recAfter = await reconcile(call, cookies.treasurer, NEW, '2027-10-02', BANK + CASH);
    assert.equal(recAfter.differenceCents, 0);
    assert.equal(recAfter.ledgerNonBankCents, 0);
    assert.equal(recAfter.ledgerBalanceCents, BANK + CASH);

    // Korekta przeniesienia = storno (nowy wiersz), pierwotny zapis zostaje.
    const storno = await call('POST', '/api/ledger/transfers', cookies.treasurer,
      { schoolYearId: NEW, reversesId: transfer.id, description: 'Storno: błędna kwota' }, key('tr'));
    assert.equal(storno.status, 201);
    assert.equal(storno.body.transfer.direction, 'bank_to_cash');
    assert.equal(storno.body.transfer.amountCents, CASH);
    assert.equal(await count(db, 'ledger_transfers'), 2);
    const again = await call('POST', '/api/ledger/transfers', cookies.treasurer,
      { schoolYearId: NEW, reversesId: transfer.id, description: 'Drugie storno' }, key('tr'));
    assert.equal(again.status, 409);
    const stornoOfStorno = await call('POST', '/api/ledger/transfers', cookies.treasurer,
      { schoolYearId: NEW, reversesId: storno.body.transfer.id, description: 'Storno storna' }, key('tr'));
    assert.equal(stornoOfStorno.status, 409);
    const recStorno = await reconcile(call, cookies.treasurer, NEW, '2027-10-03', BANK + CASH);
    assert.equal(recStorno.ledgerNonBankCents, CASH);
    await assert.rejects(db.query('UPDATE ledger_transfers SET amount_cents = 1'), /ledger_transfers_cannot_be_changed/);
    await assertOwnerGuard(db, 'DELETE FROM ledger_transfers', /ledger_transfers_cannot_be_changed/);

    // Raport KR i zestawienie przekazania pokazują podział.
    // Raport zamkniętego roku czyta zarząd roku następnego (#195).
    const reportOld = await call('GET', `/api/reports/audit?schoolYearId=${OLD}`, cookies.boardA);
    assert.equal(reportOld.status, 200);
    assert.equal(reportOld.body.report.balance.closingCashCents, CASH);
    assert.equal(reportOld.body.report.balance.closingBankCents, BANK);
    const reportNew = await call('GET', `/api/reports/audit?schoolYearId=${NEW}`, cookies.audit);
    assert.equal(reportNew.status, 200);
    const { balance } = reportNew.body.report;
    assert.equal(balance.openingCashCents, CASH);
    assert.equal(balance.openingBankCents, BANK);
    assert.equal(balance.closingCashCents, CASH); // przeniesienie i storno znoszą się
    const handoverNew = await call('GET', `/api/year-close/${OLD}/handover`, cookies.boardA);
    assert.equal(handoverNew.status, 200);
    assert.equal(handoverNew.body.finance.closingCashCents, CASH);
    assert.equal(handoverNew.body.finance.closingBankCents, BANK);
    assert.equal(handoverNew.body.finance.nextYearOpeningBalance.cashCents, CASH);

    // Audyt bez kwot i opisów.
    const { rows } = await db.query("SELECT action, metadata_json FROM audit_events WHERE action LIKE 'ledger.transfer.%' OR action LIKE 'ledger_opening_balance.%' ORDER BY occurred_at");
    assert.ok(rows.some((row) => row.action === 'ledger.transfer.created'));
    assert.ok(rows.some((row) => row.action === 'ledger.transfer.reversed'));
    assert.ok(rows.some((row) => row.action === 'ledger_opening_balance.created'));
    assert.equal(JSON.stringify(rows).includes(String(CASH)), false);
  } finally {
    await db.close();
  }
});

test('bilans otwarcia przez API: tylko zarząd z MFA, pierwszy rok, korekta jako nowy wpis, zamknięty rok 409', async () => {
  const { db, cookies, call } = await setup();
  try {
    const input = { schoolYearId: OLD, bankCents: 10000, cashCents: 2500, note: 'Bilans z protokołu przekazania' };
    for (const cookie of [cookies.treasurer, cookies.rep, cookies.audit, cookies.admin, cookies.boardNoMfa]) {
      assert.equal((await call('POST', '/api/ledger/opening-balance', cookie, input, key('ob'))).status, 403);
    }
    assert.equal((await call('POST', '/api/ledger/opening-balance', undefined, input, key('ob'))).status, 401);
    assert.equal(await count(db, 'ledger_opening_balances'), 0);
    // Rok następny nie jest pierwszym rokiem — bilans przyjdzie z zamknięcia.
    const notFirst = await call('POST', '/api/ledger/opening-balance', cookies.boardA, { ...input, schoolYearId: NEW }, key('ob'));
    assert.deepEqual([notFirst.status, notFirst.body.error], [409, 'not_first_school_year']);
    // Kasa nie może być ujemna.
    assert.equal((await call('POST', '/api/ledger/opening-balance', cookies.boardA, { ...input, cashCents: -1 }, key('ob'))).status, 400);

    const openingKey = key('ob');
    const created = await call('POST', '/api/ledger/opening-balance', cookies.boardA, input, openingKey);
    assert.equal(created.status, 201);
    const replay = await call('POST', '/api/ledger/opening-balance', cookies.boardA, input, openingKey);
    assert.equal(replay.status, 200);
    const second = await call('POST', '/api/ledger/opening-balance', cookies.boardB, input, key('ob'));
    assert.deepEqual([second.status, second.body.error], [409, 'opening_balance_exists']);
    assert.equal(await count(db, 'ledger_opening_balances'), 1);

    // Korekta: przesunięcie 1000 z kasy na rachunek (suma bez zmian) + podwójne kliknięcie.
    const adjKey = key('adj');
    const adjBody = { schoolYearId: OLD, amountCents: 0, cashCents: -1000, reason: 'Część gotówki była już na rachunku' };
    const [a1, a2] = await Promise.all([
      call('POST', '/api/ledger/opening-balance/adjustments', cookies.boardB, adjBody, adjKey),
      call('POST', '/api/ledger/opening-balance/adjustments', cookies.boardB, adjBody, adjKey),
    ]);
    assert.deepEqual([a1.status, a2.status].sort(), [200, 201]);
    assert.equal(await count(db, 'ledger_opening_balance_adjustments'), 1);
    const view = (await call('GET', `/api/ledger/opening-balance?schoolYearId=${OLD}`, cookies.treasurer)).body;
    assert.deepEqual(view.current, { amountCents: 12500, cashCents: 1500, bankCents: 11000 });
    assert.deepEqual([view.openingBalance.amountCents, view.openingBalance.cashCents], [12500, 2500], 'pierwotny wpis w historii');
    assert.equal(view.adjustments.length, 1);
    // Kasa poniżej zera → 409; przedstawiciel i KR → 403.
    const below = await call('POST', '/api/ledger/opening-balance/adjustments', cookies.boardB,
      { schoolYearId: OLD, cashCents: -5000, reason: 'Za duża korekta' }, key('adj'));
    assert.deepEqual([below.status, below.body.error], [409, 'cash_below_zero']);
    for (const cookie of [cookies.rep, cookies.audit, cookies.treasurer]) {
      assert.equal((await call('POST', '/api/ledger/opening-balance/adjustments', cookie,
        { schoolYearId: OLD, amountCents: 100, reason: 'Próba' }, key('adj'))).status, 403);
    }
    const { rows } = await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'ledger_opening_balance.adjusted'");
    assert.equal(rows[0].n, 1);

    // Zamknięcie roku, potem poprawka i przeniesienie w zamkniętym roku → 409.
    await closeOldYear(call, cookies);
    const board = await seedUserSession(db, { userId: 'u-board-global', roles: [{ role: 'board' }], mfa: true });
    const closedAdj = await call('POST', '/api/ledger/opening-balance/adjustments', board,
      { schoolYearId: OLD, amountCents: 100, reason: 'Po zamknięciu' }, key('adj'));
    assert.deepEqual([closedAdj.status, closedAdj.body.error], [409, 'school_year_closed']);
    const closedTransfer = await call('POST', '/api/ledger/transfers', board,
      { schoolYearId: OLD, direction: 'cash_to_bank', amountCents: 100, transferredOn: '2027-08-01', description: 'Po zamknięciu' }, key('tr'));
    assert.deepEqual([closedTransfer.status, closedTransfer.body.error], [409, 'school_year_closed']);
    // Zamknięcie przeniosło podział: 1500 w kasie.
    const nextView = (await call('GET', `/api/ledger/opening-balance?schoolYearId=${NEW}`, board)).body;
    assert.deepEqual(nextView.current, { amountCents: 12500, cashCents: 1500, bankCents: 11000 });
  } finally {
    await db.close();
  }
});

test('przeniesienie: data poza rokiem 422, przedstawiciel i KR 403, bez MFA 403; brak zapisu', async () => {
  const { db, cookies, call } = await setup();
  try {
    const body = { schoolYearId: OLD, direction: 'bank_to_cash', amountCents: 2000, transferredOn: '2027-09-01', description: 'Wypłata do kasy' };
    const outside = await call('POST', '/api/ledger/transfers', cookies.treasurer, body, key('tr'));
    assert.deepEqual([outside.status, outside.body.error], [422, 'date_outside_school_year']);
    for (const cookie of [cookies.rep, cookies.audit, cookies.boardNoMfa]) {
      assert.equal((await call('POST', '/api/ledger/transfers', cookie, { ...body, transferredOn: '2027-01-10' }, key('tr'))).status, 403);
      assert.equal((await call('GET', `/api/ledger/transfers?schoolYearId=${OLD}`, cookie)).status, 403);
    }
    assert.equal(await count(db, 'ledger_transfers'), 0);
    const ok = await call('POST', '/api/ledger/transfers', cookies.admin, { ...body, transferredOn: '2027-01-10' }, key('tr'));
    assert.equal(ok.status, 201);
    const list = await call('GET', `/api/ledger/transfers?schoolYearId=${OLD}`, cookies.treasurer);
    assert.equal(list.body.transfers.length, 1);
    // Ten sam klucz z inną treścią → konflikt.
    const reused = await call('POST', '/api/ledger/transfers', cookies.admin, { ...body, transferredOn: '2027-01-10', amountCents: 2001 },
      (await db.query('SELECT idempotency_key FROM ledger_transfers')).rows[0].idempotency_key);
    assert.equal(reused.status, 409);
    // Bezpośredni INSERT niespójnego storna odrzuca baza.
    await assert.rejects(db.query(
      `INSERT INTO ledger_transfers (id, school_year_id, direction, amount_cents, transferred_on, description, reverses_id, created_by, idempotency_key)
       VALUES ('t-bad', $1, 'bank_to_cash', 2000, '2027-01-11', 'Złe storno', $2, 'u-admin', 'direct-transfer-1')`,
      [OLD, ok.body.transfer.id],
    ), /ledger_transfer_reversal_mismatch/);
  } finally {
    await db.close();
  }
});

test('#87: przeniesienie i bilans otwarcia przyjmują tylko dokument finansowy tego samego roku', async () => {
  const { db, cookies, call } = await setup();
  try {
    const insertDoc = (id, kind, schoolYearId) => db.query(
      `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key)
       VALUES ($1, $2, 'application/pdf', 10, $3, 'u-admin', $4, $5, $6)`,
      [id, `docs/00000000-0000-4000-8000-${id.padStart(12, '0').slice(-12)}`, kind, schoolYearId, 'b'.repeat(64), `seed-${id}-key`],
    );
    await insertDoc('0000000000a1', 'financial', OLD);
    await insertDoc('0000000000a2', 'financial', NEW);
    await insertDoc('0000000000a3', 'board', OLD);
    await db.query(`INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by)
      VALUES ('legacy-doc', 'synthetic/legacy.pdf', 'application/pdf', 10, 'financial', 'u-admin')`);
    const body = { schoolYearId: OLD, direction: 'bank_to_cash', amountCents: 2000, transferredOn: '2027-01-10', description: 'Wypłata do kasy' };
    for (const sourceDocumentId of ['0000000000a2', '0000000000a3', 'legacy-doc', 'doc-missing']) {
      const refused = await call('POST', '/api/ledger/transfers', cookies.treasurer, { ...body, sourceDocumentId }, key('tr'));
      assert.deepEqual([refused.status, refused.body.error], [400, 'invalid_source_document'], sourceDocumentId);
      const opening = await call('POST', '/api/ledger/opening-balance', cookies.boardA,
        { schoolYearId: OLD, bankCents: BANK, cashCents: CASH, note: 'Bilans syntetyczny', sourceDocumentId }, key('ob'));
      assert.deepEqual([opening.status, opening.body.error], [400, 'invalid_source_document'], sourceDocumentId);
    }
    assert.equal(await count(db, 'ledger_transfers'), 0);
    assert.equal(await count(db, 'ledger_opening_balances'), 0);
    const ok = await call('POST', '/api/ledger/transfers', cookies.treasurer, { ...body, sourceDocumentId: '0000000000a1' }, key('tr'));
    assert.equal(ok.status, 201);
  } finally {
    await db.close();
  }
});
