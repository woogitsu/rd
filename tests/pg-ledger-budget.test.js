// Preliminarz przez API (#107): kategorie, wersje linii, przyjęcie przez zebranie
// i zestawienie plan vs wykonanie. PGlite, dane syntetyczne, kwoty w centach EUR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { renderAuditReportHtml, reportContentSecurityPolicy } from '../src/pg/audit-report.js';
import { unzipSync, strFromU8 } from 'fflate';
import { BUDGET_CSV_COLUMNS, budgetCsvLine } from '../src/pg/routes/ledger-budget.js';
import { createMeeting, createResolution, determineQuorum, recordAttendance } from '../src/pg/meetings.js';
import { updateMeeting } from './helpers/with-revision.js';
import { createTestDb, request, seedClass, seedRoleGrant, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-2026';
const NEXT = 'y-2027';
const admin = { userId: 'u-meet-admin', grants: [{ role: 'admin', classId: null, schoolYearId: null }], mfaVerified: true };

let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR });
  await seedUser(db, { userId: admin.userId });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    board: await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', mfa: false, roles: [{ role: 'board', schoolYearId: YEAR }] }),
    boardNext: await seedUserSession(db, { userId: 'u-board-next', mfa: true, roles: [{ role: 'board', schoolYearId: NEXT }] }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] }),
    principal: await seedUserSession(db, { userId: 'u-principal', mfa: true, roles: [{ role: 'principal', schoolYearId: YEAR }] }),
    rep: await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] }),
  };
  const env = { db };
  const raw = (method, path, cookie, body, idempotencyKey) => handlePgRequest(
    request(path, { method, cookie, body, headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {} }), env,
  );
  const call = async (...args) => {
    const response = await raw(...args);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, body: data };
  };
  const count = async (table, where = 'true') => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n);
  return { db, cookies, call, raw, count };
}

async function adoptedResolution(db, { schoolYearId = YEAR, number = `P-${counter}/2026` } = {}) {
  const { meeting } = await createMeeting(db, admin, {
    idempotencyKey: key('meeting'), schoolYearId, kind: 'plenary', title: 'Zebranie ogólne syntetyczne',
    scheduledAt: '2026-10-01T17:00:00Z', status: 'scheduled', quorumMode: 'minimum_count', quorumMinCount: 1,
    quorumRuleSource: 'Założenie testowe',
  });
  await updateMeeting(db, admin, { meetingId: meeting.id, status: 'held' });
  await seedRoleGrant(db, { userId: admin.userId, role: 'admin' });
  await recordAttendance(db, admin, { meetingId: meeting.id, userId: admin.userId, capacity: 'board_member', votingEligible: true, present: true });
  const { quorumCheck } = await determineQuorum(db, admin, { idempotencyKey: key('quorum'), meetingId: meeting.id });
  const { resolution } = await createResolution(db, admin, {
    idempotencyKey: key('res'), meetingId: meeting.id, title: 'Preliminarz syntetyczny', body: 'Treść syntetyczna',
    status: 'adopted', number, votesFor: 1, votesAgainst: 0, votesAbstain: 0, quorumCheckId: quorumCheck.id,
  });
  return resolution;
}

const category = (call, cookie, body, k = key('cat')) => call('POST', '/api/ledger/categories', cookie, { schoolYearId: YEAR, ...body }, k);
const line = (call, cookie, body, k = key('line')) => call('POST', '/api/ledger/budget', cookie, { schoolYearId: YEAR, ...body }, k);
const revise = (call, cookie, lineId, body, k = key('rev')) => call('POST', `/api/ledger/budget/${lineId}/revisions`, cookie, body, k);

test('kategorie przez API: podwójne kliknięcie = jedna kategoria, wyłączenie z historią, nieaktywna niedostępna dla nowych wpisów', async () => {
  const { db, cookies, call, count } = await setup();
  try {
    const catKey = key('cat');
    const created = await category(call, cookies.treasurer, { direction: 'expense', name: 'Wycieczki' }, catKey);
    assert.equal(created.status, 201);
    const again = await category(call, cookies.treasurer, { direction: 'expense', name: 'Wycieczki' }, catKey);
    assert.deepEqual([again.status, again.body.category.id], [200, created.body.category.id]);
    const conflict = await category(call, cookies.treasurer, { direction: 'expense', name: 'Inna nazwa' }, catKey);
    assert.deepEqual([conflict.status, conflict.body.error], [409, 'idempotency_conflict']);
    const duplicate = await category(call, cookies.board, { direction: 'expense', name: 'Wycieczki' });
    assert.deepEqual([duplicate.status, duplicate.body.error], [409, 'category_exists']);
    assert.equal(await count('ledger_categories'), 1);

    const categoryId = created.body.category.id;
    const entry = await call('POST', '/api/ledger', cookies.treasurer, {
      schoolYearId: YEAR, direction: 'expense', amountCents: 4000, categoryId, description: 'Autokar syntetyczny',
      occurredOn: '2026-10-10', method: 'bank',
    }, key('entry'));
    assert.equal(entry.status, 201);

    const deactivation = await call('POST', `/api/ledger/categories/${categoryId}/deactivation`, cookies.board, { reason: 'Połączona z inną kategorią' }, key('deact'));
    assert.equal(deactivation.status, 201);
    const twice = await call('POST', `/api/ledger/categories/${categoryId}/deactivation`, cookies.board, { reason: 'Drugi raz' }, key('deact'));
    assert.deepEqual([twice.status, twice.body.error], [409, 'category_inactive']);
    const refused = await call('POST', '/api/ledger', cookies.treasurer, {
      schoolYearId: YEAR, direction: 'expense', amountCents: 100, categoryId, description: 'Po wyłączeniu', occurredOn: '2026-10-11', method: 'bank',
    }, key('entry'));
    assert.deepEqual([refused.status, refused.body.error], [400, 'invalid_category']);
    await assert.rejects(db.query('DELETE FROM ledger_category_deactivations'), /ledger_category_deactivations_cannot_be_changed/);

    // Kategoria wyłączona z wpisami jest widoczna w wykonaniu.
    const execution = await call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}`, cookies.treasurer);
    assert.deepEqual(execution.body.execution.items.map((item) => [item.categoryId, item.active, item.executedNetCents, item.outsidePlan]),
      [[categoryId, false, 4000, true]]);

    const events = (await db.query("SELECT actor_id, action, entity_id, metadata_json FROM audit_events WHERE action LIKE 'ledger.category.%' ORDER BY occurred_at")).rows;
    assert.deepEqual(events.map((event) => [event.actor_id, event.action, event.entity_id]),
      [['u-treasurer', 'ledger.category.created', categoryId], ['u-board', 'ledger.category.deactivated', categoryId]]);
    assert.doesNotMatch(JSON.stringify(events.map((event) => event.metadata_json)), /Wycieczki|Połączona/);
  } finally { await db.close(); }
});

test('wersje linii: nowa wersja nie usuwa poprzedniej, historia w API, równoległe rewizje — jedna wygrywa, druga 409', async () => {
  const { db, cookies, call, count } = await setup();
  try {
    const cat = (await category(call, cookies.treasurer, { direction: 'expense', name: 'Wydarzenia' })).body.category;
    const lineKey = key('line');
    const first = await line(call, cookies.treasurer, { categoryId: cat.id, plannedCents: 200000, note: 'Plan wstępny' }, lineKey);
    assert.equal(first.status, 201);
    assert.equal((await line(call, cookies.treasurer, { categoryId: cat.id, plannedCents: 200000, note: 'Plan wstępny' }, lineKey)).status, 200);
    const second = await line(call, cookies.treasurer, { categoryId: cat.id, plannedCents: 1 });
    assert.deepEqual([second.status, second.body.error], [409, 'budget_line_exists']);

    const noReason = await revise(call, cookies.board, first.body.line.id, { plannedCents: 180000 });
    assert.deepEqual([noReason.status, noReason.body.error], [400, 'invalid_reason']);
    const [a, b] = await Promise.all([
      revise(call, cookies.board, first.body.line.id, { plannedCents: 180000, reason: 'Mniejsza dotacja' }),
      revise(call, cookies.treasurer, first.body.line.id, { plannedCents: 220000, reason: 'Większa frekwencja' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal([a, b].find((r) => r.status === 409).body.error, 'budget_line_superseded');
    assert.equal(await count('ledger_budget_lines'), 2);

    const history = await call('GET', `/api/ledger/budget/history?schoolYearId=${YEAR}`, cookies.treasurer);
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.lines.map((item) => [item.supersedesId === null, item.current]), [[true, false], [false, true]]);
    assert.equal(history.body.lines[1].note.length > 3, true);

    const events = (await db.query("SELECT action, metadata_json FROM audit_events WHERE action LIKE 'ledger.budget_line.%' ORDER BY occurred_at")).rows;
    assert.deepEqual(events.map((event) => event.action), ['ledger.budget_line.created', 'ledger.budget_line.revised']);
    assert.doesNotMatch(JSON.stringify(events), /200000|180000|220000/);
  } finally { await db.close(); }
});

test('przyjęcie przez zebranie zamraża wersje linii; wykonanie = netto wpisów i sumuje się do bilansu roku', async () => {
  const { db, cookies, call, raw } = await setup();
  try {
    const events = (await category(call, cookies.treasurer, { direction: 'expense', name: 'Wydarzenia' })).body.category;
    const fees = (await category(call, cookies.treasurer, { direction: 'income', name: 'Składki dobrowolne' })).body.category;
    const other = (await category(call, cookies.treasurer, { direction: 'expense', name: 'Inne' })).body.category;
    const eventsLine = (await line(call, cookies.treasurer, { categoryId: events.id, plannedCents: 100000 })).body.line;
    await line(call, cookies.treasurer, { categoryId: fees.id, plannedCents: 500000 });

    const resolution = await adoptedResolution(db, { number: 'P-1/2026' });
    const nextYearResolution = await adoptedResolution(db, { schoolYearId: NEXT, number: 'P-1/2027' });
    for (const cookie of [cookies.treasurer, cookies.audit, cookies.rep, cookies.boardNoMfa]) {
      assert.equal((await call('POST', '/api/ledger/budget/adoptions', cookie, { schoolYearId: YEAR, adoptedOn: '2026-10-01', note: 'Przyjęcie' }, key('adopt'))).status, 403);
    }
    const wrongResolution = await call('POST', '/api/ledger/budget/adoptions', cookies.board,
      { schoolYearId: YEAR, adoptedOn: '2026-10-01', note: 'Przyjęcie', resolutionId: nextYearResolution.id }, key('adopt'));
    assert.deepEqual([wrongResolution.status, wrongResolution.body.error], [404, 'resolution_not_found']);
    const adoptKey = key('adopt');
    const adoption = await call('POST', '/api/ledger/budget/adoptions', cookies.board,
      { schoolYearId: YEAR, adoptedOn: '2026-10-01', note: 'Przyjęty na zebraniu ogólnym', resolutionId: resolution.id }, adoptKey);
    assert.equal(adoption.status, 201);
    assert.equal(adoption.body.adoption.lineIds.length, 2);
    assert.equal((await call('POST', '/api/ledger/budget/adoptions', cookies.board,
      { schoolYearId: YEAR, adoptedOn: '2026-10-01', note: 'Przyjęty na zebraniu ogólnym', resolutionId: resolution.id }, adoptKey)).status, 200);

    // Zmiana po przyjęciu: plan bieżący się zmienia, przyjęty zostaje.
    await revise(call, cookies.treasurer, eventsLine.id, { plannedCents: 80000, reason: 'Cięcie wydatków' });
    const entry = async (body) => (await call('POST', '/api/ledger', cookies.treasurer, {
      schoolYearId: YEAR, method: 'bank', description: 'Wpis syntetyczny', ...body,
    }, key('entry'))).body.entry;
    const big = await entry({ direction: 'expense', categoryId: events.id, amountCents: 90000, occurredOn: '2026-11-05' });
    await entry({ direction: 'expense', categoryId: other.id, amountCents: 1500, occurredOn: '2026-11-06' });
    await entry({ direction: 'income', categoryId: fees.id, amountCents: 250000, occurredOn: '2027-01-10' });

    let result = (await call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}`, cookies.treasurer)).body.execution;
    const byName = Object.fromEntries(result.items.map((item) => [item.categoryName, item]));
    assert.deepEqual([byName.Wydarzenia.adoptedPlanCents, byName.Wydarzenia.currentPlanCents, byName.Wydarzenia.executedNetCents,
      byName.Wydarzenia.differenceCents, byName.Wydarzenia.executionPercent, byName.Wydarzenia.overBudget], [100000, 80000, 90000, -10000, 112.5, true]);
    assert.deepEqual([byName.Inne.outsidePlan, byName.Inne.currentPlanCents, byName.Inne.executedNetCents], [true, null, 1500]);
    assert.deepEqual([byName['Składki dobrowolne'].executionPercent, byName['Składki dobrowolne'].overBudget], [50, false]);
    assert.equal(result.adoption.resolutionNumber, 'P-1/2026');
    assert.deepEqual(result.check, { ok: true, summaryIncomeCents: 250000, summaryExpenseCents: 91500 });

    // Korekta wpisu zmienia wykonanie (netto), nie plan.
    await call('POST', `/api/ledger/${big.id}/corrections`, cookies.treasurer, { amountCents: 20000, reason: 'Zwrot części kosztów' }, key('corr'));
    result = (await call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}`, cookies.treasurer)).body.execution;
    const corrected = result.items.find((item) => item.categoryName === 'Wydarzenia');
    assert.deepEqual([corrected.currentPlanCents, corrected.executedNetCents, corrected.overBudget], [80000, 70000, false]);
    assert.equal(result.check.ok, true);

    // Na dzień: tylko wpisy do tej daty.
    const asOf = (await call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&asOf=2026-12-31`, cookies.treasurer)).body.execution;
    assert.equal(asOf.totals.income.executedNetCents, 0);
    assert.equal(asOf.check, null);

    // CSV: brak planu = pusta komórka, nie 0,00; wydruk HTML bez skryptów, z CSP raportu.
    const csv = await raw('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&format=csv`, cookies.treasurer);
    assert.equal(csv.headers.get('Content-Type'), 'text/csv; charset=utf-8');
    const lines = (await csv.text()).split('\r\n');
    assert.ok(lines[0].includes('rodzaj;kategoria;aktywna;plan_przyjety_eur'));
    assert.ok(lines.some((row) => row.startsWith('Wydatek;Inne;tak;;;15,00;;;tak;nie;1')));
    // XLSX (#121): te same kolumny co CSV, kwoty jako liczby (także ujemne), brak planu = pusta komórka, bez formuł.
    const xlsx = await raw('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&format=xlsx`, cookies.treasurer);
    assert.equal(xlsx.headers.get('Content-Type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(xlsx.headers.get('Content-Disposition'), `attachment; filename="preliminarz-${YEAR}.xlsx"`);
    assert.equal(xlsx.headers.get('Cache-Control'), 'no-store');
    const xlsxBytes = new Uint8Array(await xlsx.arrayBuffer());
    for (const [name, part] of Object.entries(unzipSync(xlsxBytes))) assert.ok(!/<f[\s>/]/.test(strFromU8(part)), `${name} bez formuł`);
    const { default: readXlsxFileNode } = await import('read-excel-file/node');
    const parsed = await readXlsxFileNode(Buffer.from(xlsxBytes));
    const sheetRows = parsed[0].data ?? parsed[0];
    assert.equal(sheetRows.length, 1 + result.items.length);
    const outside = sheetRows.find((row) => row[1] === 'Inne');
    assert.deepEqual([outside[3], outside[4], outside[5], outside[6]], [null, null, 15, null]);
    const executedColumn = BUDGET_CSV_COLUMNS.findIndex((column) => column.header === 'wykonanie_netto_eur');
    const xlsxExecuted = { Przychód: 0, Wydatek: 0 };
    for (const row of sheetRows.slice(1)) {
      assert.equal(typeof row[executedColumn], 'number');
      xlsxExecuted[row[0]] += Math.round(row[executedColumn] * 100);
    }
    assert.deepEqual(xlsxExecuted, { Przychód: result.totals.income.executedNetCents, Wydatek: result.totals.expense.executedNetCents });
    const exportEvents = (await db.query("SELECT metadata_json FROM audit_events WHERE action = 'ledger.budget_execution.exported' ORDER BY occurred_at, id")).rows;
    assert.deepEqual(exportEvents.map((event) => event.metadata_json.format), ['csv', 'xlsx']);
    const html = await raw('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}&format=html`, cookies.treasurer);
    assert.equal(html.headers.get('Content-Security-Policy'), await reportContentSecurityPolicy());
    const page = await html.text();
    assert.doesNotMatch(page, /<script/i);
    assert.match(page, /Preliminarz a wykonanie/);
    assert.match(page, /poza planem/);
    assert.equal(budgetCsvLine({ direction: 'expense', categoryName: '=HYPERLINK()', active: true, adoptedPlanCents: null,
      currentPlanCents: 100, executedNetCents: 250, differenceCents: -150, executionPercent: 250, outsidePlan: false, overBudget: true, entryCount: 2 }),
    "Wydatek;'=HYPERLINK();tak;;1,00;2,50;-1,50;250;nie;tak;2");

    // Raport KR: sekcja 2a.
    const report = (await call('GET', `/api/reports/audit?schoolYearId=${YEAR}`, cookies.audit)).body.report;
    assert.equal(report.budgetExecution.items.length, 3);
    assert.match(renderAuditReportHtml(report), /2a\. Preliminarz a wykonanie/);
    const legacy = { ...report };
    delete legacy.budgetExecution;
    assert.doesNotMatch(renderAuditReportHtml(legacy), /2a\./);
  } finally { await db.close(); }
});

test('role: przedstawiciel, KR, dyrekcja i brak MFA — 403 przed walidacją obiektów; inny rok 403; zamknięty rok 409', async () => {
  const { db, cookies, call, count } = await setup();
  try {
    const cat = (await category(call, cookies.treasurer, { direction: 'expense', name: 'Wydarzenia' })).body.category;
    const existing = (await line(call, cookies.treasurer, { categoryId: cat.id, plannedCents: 1000 })).body.line;
    for (const cookie of [cookies.rep, cookies.audit, cookies.principal, cookies.boardNoMfa]) {
      assert.equal((await category(call, cookie, { direction: 'expense', name: 'Nowa' })).status, 403);
      assert.equal((await call('POST', '/api/ledger/categories/brak/deactivation', cookie, { reason: 'Test odmowy' }, key('d'))).status, 403);
      assert.equal((await line(call, cookie, { categoryId: 'brak', plannedCents: 1 })).status, 403);
      assert.equal((await revise(call, cookie, 'brak', { plannedCents: 1, reason: 'Test odmowy' })).status, 403);
      assert.equal((await call('GET', `/api/ledger/budget/execution?schoolYearId=${YEAR}`, cookie)).status, 403);
      assert.equal((await call('GET', `/api/ledger/budget/history?schoolYearId=${YEAR}`, cookie)).status, 403);
    }
    // Zarząd innego roku: 403 na obiektach tego roku (bez wyroczni), 404 dla nieistniejących.
    assert.equal((await revise(call, cookies.boardNext, existing.id, { plannedCents: 1, reason: 'Inny rok' })).status, 403);
    assert.equal((await revise(call, cookies.boardNext, 'brak', { plannedCents: 1, reason: 'Inny rok' })).status, 404);
    assert.equal(await count('ledger_budget_lines'), 1);

    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
        closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
        carried_opening_balance_id, expired_grant_count)
      VALUES ('cl-107', '${YEAR}', '${NEXT}', 'closed', 'u-treasurer', 'u-board', now(), 0, 0, 0, 0, 'ob-x', 0);
      SET session_replication_role = origin;
    `);
    const closed = [
      await category(call, cookies.treasurer, { direction: 'income', name: 'Po zamknięciu' }),
      await revise(call, cookies.treasurer, existing.id, { plannedCents: 2000, reason: 'Po zamknięciu' }),
      await call('POST', `/api/ledger/categories/${cat.id}/deactivation`, cookies.treasurer, { reason: 'Po zamknięciu' }, key('d')),
      await call('POST', '/api/ledger/budget/adoptions', cookies.board, { schoolYearId: YEAR, adoptedOn: '2027-08-01', note: 'Po zamknięciu' }, key('adopt')),
    ];
    assert.deepEqual(closed.map((result) => [result.status, result.body.error]), Array(4).fill([409, 'school_year_closed']));
  } finally { await db.close(); }
});
