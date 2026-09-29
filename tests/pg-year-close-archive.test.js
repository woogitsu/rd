// Odczyt archiwum zamkniętego roku (#195). Wyłącznie dane syntetyczne.
// Wariant zachowawczy (D-08/D-09 nierozstrzygnięte): tylko odczyt zestawienia
// przekazania, raportu KR i eksportu; zarząd/skarbnik roku N+1 i admin.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { CHECKLIST_ITEMS } from '../src/pg/routes/year-close.js';
import { createTestDb, request, seedClass, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const OLD = 'y-2026';
const NEW = 'y-2027';

async function setup() {
  const db = await createTestDb();
  await db.query(`INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
    ($1, '2026/27 test', '2026-09-01', '2027-08-31'),
    ($2, '2027/28 test', '2027-09-01', '2028-08-31')`, [OLD, NEW]);
  await seedClass(db, { id: 'c-1a', schoolYearId: OLD, name: '1A' });
  await seedClass(db, { id: 'c-2a', schoolYearId: NEW, name: '2A' });

  const cookies = {
    boardA: await seedUserSession(db, { userId: 'u-board-a', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
    boardB: await seedUserSession(db, { userId: 'u-board-b', roles: [{ role: 'board', schoolYearId: OLD }], mfa: true }),
    boardGlobal: await seedUserSession(db, { userId: 'u-board-global', roles: [{ role: 'board' }], mfa: true }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', roles: [{ role: 'board', schoolYearId: OLD }], mfa: false }),
    classBoard: await seedUserSession(db, { userId: 'u-board-class', roles: [{ role: 'board', schoolYearId: OLD, classId: 'c-1a' }], mfa: true }),
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: OLD }], mfa: true }),
    rep: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', schoolYearId: OLD, classId: 'c-1a' }], mfa: true }),
    auditor: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: OLD }], mfa: true }),
    boardNew: await seedUserSession(db, { userId: 'u-board-new', roles: [{ role: 'board', schoolYearId: NEW }], mfa: true }),
    repNew: await seedUserSession(db, { userId: 'u-rep-new', roles: [{ role: 'representative', schoolYearId: NEW, classId: 'c-2a' }], mfa: true }),
  };

  // Księga starego roku: bilans otwarcia 500,00 z poprawką −15,00, przychód 1200,00,
  // wydatek 300,00 z korektą 50,00. Bilans zamknięcia = 485,00 + 1200,00 − 250,00 = 1435,00 EUR.
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-in', $1, 'income', 'Składki dobrowolne', 'u-treasurer'),
    ('cat-out', $1, 'expense', 'Wydarzenia', 'u-treasurer'),
    ('cat-in-new', $2, 'income', 'Składki dobrowolne', 'u-treasurer')`, [OLD, NEW]);
  await db.query(`INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, created_by, idempotency_key)
    VALUES ('ob-old', $1, 50000, 'u-treasurer', 'ob-old-key-1')`, [OLD]);
  await db.query(`INSERT INTO ledger_opening_balance_adjustments (id, opening_balance_id, amount_cents, reason, created_by, idempotency_key)
    VALUES ('oba-old', 'ob-old', -1500, 'Poprawka testowa', 'u-treasurer', 'oba-old-key-1')`);
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key) VALUES
    ('le-in', $1, 'income', 120000, 'cat-in', 'Wpływy syntetyczne', '2026-10-01', 'bank', 'u-treasurer', 'le-in-key-1'),
    ('le-out', $1, 'expense', 30000, 'cat-out', 'Wydatek syntetyczny', '2026-11-01', 'bank', 'u-treasurer', 'le-out-key-1')`, [OLD]);
  await db.query(`INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
    VALUES ('lc-out', 'le-out', 5000, 'Zwrot części kosztu', 'u-treasurer', 'lc-out-key-1')`);

  for (const householdId of ['h-1', 'h-2']) await seedEnrolledHousehold(db, householdId, [OLD]);
  await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
    VALUES ('p-1', 'h-1', $1, 2000, '2026-10-02', 'bank', 'recorded', 'u-treasurer', 'p-1-key-001'),
           ('p-2', NULL, $1, 1500, '2026-10-03', 'bank', 'unmatched', 'u-treasurer', 'p-2-key-001')`, [OLD]);
  await db.query(`INSERT INTO events (id, school_year_id, title, begins_at, created_by)
    VALUES ('ev-old', $1, 'Piknik syntetyczny', '2027-05-01T10:00:00Z', 'u-board-a')`, [OLD]);
  await db.query(`INSERT INTO meetings (id, school_year_id, kind, title, scheduled_at, created_by)
    VALUES ('m-old', $1, 'plenary', 'Zebranie syntetyczne', '2027-06-01T17:00:00Z', 'u-board-a')`, [OLD]);

  return { db, env: { db }, cookies };
}

function post(env, path, cookie, body = {}) {
  return handlePgRequest(request(path, { method: 'POST', cookie, body }), env);
}

function get(env, path, cookie) {
  return handlePgRequest(request(path, { cookie }), env);
}

async function startAndConfirm(env, cookies) {
  const started = await post(env, `/api/year-close/${OLD}/start`, cookies.boardA, { nextSchoolYearId: NEW });
  assert.equal(started.status, 201);
  for (const [index, item] of CHECKLIST_ITEMS.entries()) {
    const cookie = index % 2 ? cookies.treasurer : cookies.boardA;
    const response = await post(env, `/api/year-close/${OLD}/checklist/${item}`, cookie, { note: `Potwierdzenie ${item}` });
    assert.equal(response.status, 201, item);
  }
}

async function archiveReads(db) {
  const { rows } = await db.query(
    `SELECT actor_id, entity_id, metadata_json FROM audit_events WHERE action = 'year_close.archive_read'
      ORDER BY occurred_at, id`,
  );
  return rows;
}

describe('po zamknięciu roku: odczyt archiwum przez nową Radę', () => {
  let db; let env; let cookies; let extra;

  before(async () => {
    ({ db, env, cookies } = await setup());
    await seedSchoolYear(db, 'y-2028', { startsOn: '2028-09-01', endsOn: '2029-08-31' });
    await seedClass(db, { id: 'c-3a', schoolYearId: 'y-2028', name: '3A' });
    extra = {
      treasurerNew: await seedUserSession(db, { userId: 'u-treasurer-new', roles: [{ role: 'treasurer', schoolYearId: NEW }], mfa: true }),
      boardNewNoMfa: await seedUserSession(db, { userId: 'u-board-new-nomfa', roles: [{ role: 'board', schoolYearId: NEW }], mfa: false }),
      boardNewClass: await seedUserSession(db, { userId: 'u-board-new-class', roles: [{ role: 'board', schoolYearId: NEW, classId: 'c-2a' }], mfa: true }),
      auditNew: await seedUserSession(db, { userId: 'u-audit-new', roles: [{ role: 'audit', schoolYearId: NEW }], mfa: true }),
      treasurerN2: await seedUserSession(db, { userId: 'u-treasurer-n2', roles: [{ role: 'treasurer', schoolYearId: 'y-2028' }], mfa: true }),
      boardN2: await seedUserSession(db, { userId: 'u-board-n2', roles: [{ role: 'board', schoolYearId: 'y-2028' }], mfa: true }),
      admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
      principalNew: await seedUserSession(db, { userId: 'u-principal-new', roles: [{ role: 'principal', schoolYearId: NEW }], mfa: true }),
    };
    // Przed zamknięciem: przydział roku N+1 nie otwiera roku N (brak archiwum).
    assert.equal((await get(env, `/api/year-close/${OLD}/handover`, cookies.boardNew)).status, 403);
    assert.equal((await get(env, `/api/reports/audit?schoolYearId=${OLD}`, cookies.boardNew)).status, 403);
    assert.equal((await post(env, '/api/exports', cookies.boardNew, { schoolYearId: OLD })).status, 403);
    assert.equal((await get(env, `/api/year-close/${OLD}/handover`, extra.admin)).status, 403);
    await startAndConfirm(env, cookies);
    const closed = await post(env, `/api/year-close/${OLD}/close`, cookies.boardB);
    assert.equal(closed.status, 200);
  });
  after(() => db.close());

  test('zarząd i skarbnik roku N+1 oraz admin czytają zestawienie przekazania i raport KR', async () => {
    const before = (await archiveReads(db)).length;
    for (const [who, cookie] of [['boardNew', cookies.boardNew], ['treasurerNew', extra.treasurerNew], ['admin', extra.admin]]) {
      const handover = await get(env, `/api/year-close/${OLD}/handover`, cookie);
      assert.equal(handover.status, 200, `handover ${who}`);
      const body = await handover.json();
      assert.equal(body.final, true);
      assert.equal(body.finance.closingBalanceCents, 143500);
      const report = await get(env, `/api/reports/audit?schoolYearId=${OLD}`, cookie);
      assert.equal(report.status, 200, `raport ${who}`);
      assert.equal((await report.json()).report.balance.closingBalanceCents, 143500);
      const html = await get(env, `/api/reports/audit?schoolYearId=${OLD}&format=html`, cookie);
      assert.equal(html.status, 200, `raport html ${who}`);
    }
    // Zdarzenia audytu: kto, rok, trasa — bez danych osobowych.
    const reads = (await archiveReads(db)).slice(before);
    assert.equal(reads.filter((row) => row.actor_id === 'u-board-new').length, 3);
    assert.ok(reads.every((row) => row.entity_id === OLD));
    const routes = new Set(reads.map((row) => (typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json).route));
    assert.deepEqual([...routes].sort(), ['reports.audit', 'year_close.handover']);
    assert.equal(JSON.stringify(reads).includes('@'), false);
  });

  test('eksport zamkniętego roku: zarząd N+1 i admin tak, skarbnik N+1 nie (jak w bieżącym roku)', async () => {
    const board = await post(env, '/api/exports', cookies.boardNew, { schoolYearId: OLD });
    assert.equal(board.status, 200);
    const bundle = JSON.parse(await board.text());
    assert.ok(bundle);
    assert.equal((await post(env, '/api/exports', extra.admin, { schoolYearId: OLD })).status, 200);
    assert.equal((await post(env, '/api/exports', extra.treasurerNew, { schoolYearId: OLD })).status, 403);
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'year_close.archive_read' AND actor_id = 'u-board-new' AND metadata_json->>'route' = 'exports.yearly'",
    );
    assert.equal(rows[0].n, 1);
  });

  test('bez dostępu: N+2, przedstawiciel N+1, przydział klasowy, KR, dyrekcja, bez MFA, stara kadencja', async () => {
    const denied = {
      treasurerN2: extra.treasurerN2, boardN2: extra.boardN2, repNew: cookies.repNew, boardNewClass: extra.boardNewClass,
      auditNew: extra.auditNew, auditOld: cookies.auditor, principalNew: extra.principalNew,
      boardNewNoMfa: extra.boardNewNoMfa, boardA: cookies.boardA, treasurerOld: cookies.treasurer,
    };
    for (const [who, cookie] of Object.entries(denied)) {
      assert.equal((await get(env, `/api/year-close/${OLD}/handover`, cookie)).status, 403, `handover ${who}`);
      assert.equal((await get(env, `/api/reports/audit?schoolYearId=${OLD}`, cookie)).status, 403, `raport ${who}`);
      assert.equal((await post(env, '/api/exports', cookie, { schoolYearId: OLD })).status, 403, `eksport ${who}`);
    }
    assert.equal((await get(env, `/api/year-close/${OLD}/handover`)).status, 401);
    // Tylko wskazane trasy: stan zamknięcia i księga roku N nadal zamknięte dla nowej Rady.
    assert.equal((await get(env, `/api/year-close/${OLD}`, cookies.boardNew)).status, 403);
    assert.equal((await get(env, `/api/ledger/summary?schoolYearId=${OLD}`, cookies.boardNew)).status, 403);
    assert.equal((await get(env, `/api/payments?schoolYearId=${OLD}`, cookies.boardNew)).status, 403);
  });

  test('odczyt archiwum nie daje zapisu: zapis w roku N przez nową Radę i admina kończy się 403/409', async () => {
    const payment = await handlePgRequest(request('/api/payments', {
      method: 'POST', cookie: cookies.boardNew, headers: { 'Idempotency-Key': 'archive-write-0001' },
      body: { householdId: 'h-2', schoolYearId: OLD, amountCents: 700, receivedOn: '2027-08-30', method: 'bank' },
    }), env);
    assert.equal(payment.status, 403);
    const adminPayment = await handlePgRequest(request('/api/payments', {
      method: 'POST', cookie: extra.admin, headers: { 'Idempotency-Key': 'archive-write-0002' },
      body: { householdId: 'h-2', schoolYearId: OLD, amountCents: 700, receivedOn: '2027-08-30', method: 'bank' },
    }), env);
    assert.equal(adminPayment.status, 409);
    assert.equal((await adminPayment.json()).error, 'school_year_closed');
    const checklist = await post(env, `/api/year-close/${OLD}/checklist/financial_report`, cookies.boardNew, { note: 'Próba zapisu' });
    assert.equal(checklist.status, 403);
  });

  test('nowy przydział na zamknięty rok: 409 school_year_closed, nie 503; podwójne kliknięcie bez wiersza', async () => {
    for (const role of ['board', 'treasurer', 'audit']) {
      const response = await post(env, '/api/admin/grants', extra.admin, { userId: 'u-board-new', role, schoolYearId: OLD });
      assert.equal(response.status, 409, role);
      assert.equal((await response.json()).error, 'school_year_closed');
    }
    const again = await post(env, '/api/admin/grants', extra.admin, { userId: 'u-board-new', role: 'board', schoolYearId: OLD });
    assert.equal(again.status, 409);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM role_grants WHERE user_id = 'u-board-new' AND school_year_id = $1", [OLD]);
    assert.equal(rows[0].n, 0);
  });
});
