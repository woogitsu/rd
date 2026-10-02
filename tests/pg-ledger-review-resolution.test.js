// Zasada czterech oczu przy wydatkach (#97) i uchwała jako upoważnienie do
// wydatku (#93). PGlite, wyłącznie dane syntetyczne, kwoty w centach EUR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { renderAuditReportHtml } from '../src/pg/audit-report.js';
import {
  correctResolution,
  createMeeting,
  createResolution,
  determineQuorum,
  recordAttendance,
} from '../src/pg/meetings.js';
import { updateMeeting } from './helpers/with-revision.js';
import { createTestDb, request, seedClass, seedRoleGrant, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

const PREV = 'y-2025';
const YEAR = 'y-2026';
const NEXT = 'y-2027';
const admin = { userId: 'u-meet-admin', grants: [{ role: 'admin', classId: null, schoolYearId: null }], mfaVerified: true };

const MEETING_DATES = { [PREV]: '2026-06-10T17:00:00Z', [YEAR]: '2026-10-01T17:00:00Z', [NEXT]: '2027-10-01T17:00:00Z' };
let counter = 0;
const key = (prefix) => `${prefix}-${String(++counter).padStart(6, '0')}-synthetic`;

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, PREV, { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, NEXT, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR });
  await seedUser(db, { userId: admin.userId });
  const years = (role) => [PREV, YEAR, NEXT].map((schoolYearId) => ({ role, schoolYearId }));
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', mfa: true, roles: years('treasurer') }),
    // Treasurer only in the current year (no grant for the previous year).
    treasurerYear: await seedUserSession(db, { userId: 'u-treasurer-y', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] }),
    board: await seedUserSession(db, { userId: 'u-board', mfa: true, roles: years('board') }),
    // Ta sama osoba ze skarbnikiem i zarządem — nadal autor wpisu.
    dual: await seedUserSession(db, { userId: 'u-dual', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }, { role: 'board', schoolYearId: YEAR }] }),
    boardNoMfa: await seedUserSession(db, { userId: 'u-board-nomfa', mfa: false, roles: years('board') }),
    audit: await seedUserSession(db, { userId: 'u-audit', mfa: true, roles: years('audit') }),
    principal: await seedUserSession(db, { userId: 'u-principal', mfa: true, roles: years('principal') }),
    rep: await seedUserSession(db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }] }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-exp', $1, 'expense', 'Wydarzenia', 'u-treasurer'),
    ('cat-trip', $1, 'expense', 'Wycieczki', 'u-treasurer'),
    ('cat-inc', $1, 'income', 'Składki dobrowolne', 'u-treasurer')`, [YEAR]);
  const env = { db };
  const call = async (method, path, cookie, body, idempotencyKey) => {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, body: data };
  };
  const count = async (table, where = 'true', params = []) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n);
  return { db, env, cookies, call, count };
}

// Uchwała zebrania (ogólnego albo klasowego) w podanym stanie, przez moduł zebrań.
async function resolution(db, { schoolYearId = YEAR, number, status = 'adopted', classId = null } = {}) {
  const { meeting } = await createMeeting(db, admin, {
    idempotencyKey: key('meeting'), schoolYearId, kind: classId ? 'class' : 'plenary', classId,
    title: 'Zebranie syntetyczne', scheduledAt: MEETING_DATES[schoolYearId], status: 'scheduled',
    quorumMode: 'minimum_count', quorumMinCount: 1, quorumRuleSource: 'Założenie testowe',
  });
  await updateMeeting(db, admin, { meetingId: meeting.id, status: 'held' });
  if (status === 'draft') {
    const { resolution: row } = await createResolution(db, admin, {
      idempotencyKey: key('res'), meetingId: meeting.id, title: 'Uchwała syntetyczna', body: 'Treść syntetyczna projektu',
    });
    return row;
  }
  await seedRoleGrant(db, { userId: admin.userId, role: 'admin' });
  await recordAttendance(db, admin, { meetingId: meeting.id, userId: admin.userId, capacity: 'board_member', votingEligible: true, present: true });
  const { quorumCheck } = await determineQuorum(db, admin, { idempotencyKey: key('quorum'), meetingId: meeting.id });
  const { resolution: row } = await createResolution(db, admin, {
    idempotencyKey: key('res'), meetingId: meeting.id, title: 'Uchwała syntetyczna', body: 'Treść syntetyczna uchwały',
    status, number: number ?? `U-${counter}/2026`, votesFor: status === 'adopted' ? 1 : 0, votesAgainst: status === 'adopted' ? 0 : 1,
    votesAbstain: 0, quorumCheckId: quorumCheck.id,
  });
  return { ...row, quorumCheckId: quorumCheck.id };
}

const expense = (patch = {}) => ({
  schoolYearId: YEAR, direction: 'expense', amountCents: 25000, categoryId: 'cat-exp',
  description: 'Syntetyczny wydatek', occurredOn: '2026-10-05', method: 'bank', ...patch,
});

async function createExpense(call, cookie, patch = {}, idempotencyKey = key('entry')) {
  return call('POST', '/api/ledger', cookie, expense(patch), idempotencyKey);
}

async function authorize(call, cookie, resolutionId, body, idempotencyKey = key('auth')) {
  return call('POST', `/api/ledger/resolutions/${resolutionId}/authorizations`, cookie, body, idempotencyKey);
}

test('#97: autor nie weryfikuje własnego wydatku; druga osoba weryfikuje; podwójne kliknięcie = jedna weryfikacja', async () => {
  const { db, cookies, call, count } = await setup();
  try {
    const entry = (await createExpense(call, cookies.treasurer)).body.entry;
    const own = await call('POST', `/api/ledger/${entry.id}/reviews`, cookies.treasurer, { decision: 'verified' }, key('rev'));
    assert.deepEqual([own.status, own.body], [403, { error: 'four_eyes_required' }]);

    const reviewKey = key('rev');
    const verified = await call('POST', `/api/ledger/${entry.id}/reviews`, cookies.board, { decision: 'verified' }, reviewKey);
    assert.equal(verified.status, 201);
    assert.equal(verified.body.review.decision, 'verified');
    assert.equal(verified.body.review.reviewedBy, 'u-board');
    const again = await call('POST', `/api/ledger/${entry.id}/reviews`, cookies.board, { decision: 'verified' }, reviewKey);
    assert.equal(again.status, 200);
    assert.equal(again.body.review.id, verified.body.review.id);
    const conflict = await call('POST', `/api/ledger/${entry.id}/reviews`, cookies.board,
      { decision: 'questioned', note: 'Brak faktury syntetycznej' }, reviewKey);
    assert.deepEqual([conflict.status, conflict.body], [409, { error: 'idempotency_conflict' }]);
    assert.equal(await count('ledger_entry_reviews'), 1);

    // Dziennik: aktor, czas, id wpisu — bez kwoty i opisu.
    const events = (await db.query("SELECT actor_id, entity_id, metadata_json FROM audit_events WHERE action = 'ledger.entry.verified'")).rows;
    assert.deepEqual(events, [{
      actor_id: 'u-board', entity_id: entry.id,
      metadata_json: { reviewId: verified.body.review.id, schoolYearId: YEAR },
    }]);

    // Ta sama osoba z rolą skarbnika i zarządu jest nadal autorem.
    const dualEntry = (await createExpense(call, cookies.dual)).body.entry;
    const dual = await call('POST', `/api/ledger/${dualEntry.id}/reviews`, cookies.dual, { decision: 'verified' }, key('rev'));
    assert.deepEqual([dual.status, dual.body.error], [403, 'four_eyes_required']);

    // Baza pilnuje tego samego poza API; wpisy weryfikacji są niezmienne.
    await assert.rejects(db.query(
      `INSERT INTO ledger_entry_reviews (id, school_year_id, ledger_entry_id, decision, reviewed_by, idempotency_key)
       VALUES ('rev-direct', $1, $2, 'verified', 'u-treasurer', 'direct-review-0001')`, [YEAR, entry.id],
    ), /ledger_review_four_eyes/);
    await assert.rejects(db.query("UPDATE ledger_entry_reviews SET decision = 'questioned'"), /ledger_reviews_are_immutable/);
    await assert.rejects(db.query('DELETE FROM ledger_entry_reviews'), /ledger_reviews_are_immutable/);
  } finally { await db.close(); }
});

test('#97: zakwestionowanie wymaga uwagi, stan pochodny i filtr reviewStatus; przychód i role bez uprawnień odrzucone', async () => {
  const { db, cookies, call } = await setup();
  try {
    const first = (await createExpense(call, cookies.treasurer, { description: 'Wydatek pierwszy' })).body.entry;
    const second = (await createExpense(call, cookies.treasurer, { description: 'Wydatek drugi' })).body.entry;
    const income = (await call('POST', '/api/ledger', cookies.treasurer, {
      ...expense({ direction: 'income', categoryId: 'cat-inc', description: 'Przychód syntetyczny' }),
    }, key('entry'))).body.entry;

    const noNote = await call('POST', `/api/ledger/${first.id}/reviews`, cookies.board, { decision: 'questioned' }, key('rev'));
    assert.deepEqual([noNote.status, noNote.body.error], [400, 'invalid_reason']);
    assert.equal((await call('POST', `/api/ledger/${first.id}/reviews`, cookies.board,
      { decision: 'questioned', note: 'Kwota niezgodna z dowodem' }, key('rev'))).status, 201);
    const incomeReview = await call('POST', `/api/ledger/${income.id}/reviews`, cookies.board, { decision: 'verified' }, key('rev'));
    assert.deepEqual([incomeReview.status, incomeReview.body.error], [409, 'review_expense_only']);

    for (const cookie of [cookies.rep, cookies.audit, cookies.principal, cookies.boardNoMfa]) {
      const denied = await call('POST', `/api/ledger/${second.id}/reviews`, cookie, { decision: 'verified' }, key('rev'));
      assert.equal(denied.status, 403);
      assert.equal((await call('GET', `/api/ledger/reviews?schoolYearId=${YEAR}`, cookie)).status, 403);
    }
    // Nieistniejący wpis: 404 dopiero po sprawdzeniu roli.
    assert.equal((await call('POST', '/api/ledger/brak-wpisu/reviews', cookies.rep, { decision: 'verified' }, key('rev'))).status, 403);
    assert.equal((await call('POST', '/api/ledger/brak-wpisu/reviews', cookies.board, { decision: 'verified' }, key('rev'))).status, 404);

    const all = await call('GET', `/api/ledger/reviews?schoolYearId=${YEAR}`, cookies.treasurer);
    assert.equal(all.status, 200);
    assert.deepEqual(Object.fromEntries(all.body.reviews.map((item) => [item.ledgerEntryId, item.reviewStatus])),
      { [first.id]: 'questioned', [second.id]: 'unverified' });
    const questioned = await call('GET', `/api/ledger/reviews?schoolYearId=${YEAR}&reviewStatus=questioned`, cookies.treasurer);
    assert.deepEqual(questioned.body.reviews.map((item) => item.ledgerEntryId), [first.id]);
    assert.equal((await call('GET', `/api/ledger/reviews?schoolYearId=${YEAR}&reviewStatus=x`, cookies.treasurer)).status, 400);

    // Wpis skorygowany do zera nadal można zweryfikować (np. potwierdzić storno); w raporcie nie jest liczony.
    await call('POST', `/api/ledger/${second.id}/corrections`, cookies.treasurer, { amountCents: 25000, reason: 'Syntetyczne anulowanie' }, key('corr'));
    assert.equal((await call('POST', `/api/ledger/${second.id}/reviews`, cookies.board, { decision: 'verified' }, key('rev'))).status, 201);

    const status = await call('GET', `/api/year-close/${YEAR}`, cookies.board);
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.expenseReviews, { unverified: { count: 0, netCents: 0 }, questioned: { count: 1, netCents: 25000 } });
  } finally { await db.close(); }
});

test('#97: zamknięty rok odrzuca weryfikację (409 school_year_closed)', async () => {
  const { db, cookies, call, count } = await setup();
  try {
    const entry = (await createExpense(call, cookies.treasurer)).body.entry;
    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
        closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
        carried_opening_balance_id, expired_grant_count)
      VALUES ('cl-97', '${YEAR}', '${NEXT}', 'closed', 'u-treasurer', 'u-board', now(), 0, 0, 0, 0, 'ob-x', 0);
      SET session_replication_role = origin;
    `);
    const closed = await call('POST', `/api/ledger/${entry.id}/reviews`, cookies.board, { decision: 'verified' }, key('rev'));
    assert.deepEqual([closed.status, closed.body.error], [409, 'school_year_closed']);
    assert.equal(await count('ledger_entry_reviews'), 0);
  } finally { await db.close(); }
});

test('#93: resolutionId przyjmuje tylko bieżącą, przyjętą uchwałę zebrania ogólnego z roku wpisu lub poprzedniego', async () => {
  const { db, cookies, call, count } = await setup();
  try {
    const adopted = await resolution(db, { number: 'U-1/2026' });
    const previousYear = await resolution(db, { schoolYearId: PREV, number: 'U-9/2025' });
    const nextYear = await resolution(db, { schoolYearId: NEXT, number: 'U-1/2027' });
    const draft = await resolution(db, { status: 'draft' });
    const rejected = await resolution(db, { status: 'rejected', number: 'U-2/2026' });
    const classResolution = await resolution(db, { classId: 'c-1a', number: 'U-K1/2026' });
    const toCorrect = await resolution(db, { number: 'U-3/2026' });
    await correctResolution(db, admin, { idempotencyKey: key('corr-res'), resolutionId: toCorrect.id, reason: 'Poprawka syntetyczna' });

    const cases = [
      [draft.id, 409, 'resolution_not_adopted'],
      [rejected.id, 409, 'resolution_not_adopted'],
      [toCorrect.id, 409, 'resolution_not_current'],
      [classResolution.id, 404, 'resolution_not_found'],
      [nextYear.id, 404, 'resolution_not_found'],
      ['uchwala-brak', 404, 'resolution_not_found'],
    ];
    for (const [resolutionId, status, error] of cases) {
      const refused = await createExpense(call, cookies.treasurer, { amountCents: 350000, resolutionId });
      assert.deepEqual([refused.status, refused.body], [status, { error }], resolutionId);
    }
    const onIncome = await call('POST', '/api/ledger', cookies.treasurer,
      expense({ direction: 'income', categoryId: 'cat-inc', resolutionId: adopted.id }), key('entry'));
    assert.deepEqual([onIncome.status, onIncome.body.error], [400, 'resolution_expense_only']);
    const mismatch = await createExpense(call, cookies.treasurer, { amountCents: 350000, resolutionId: adopted.id, resolutionReference: 'U-7/2026' });
    assert.deepEqual([mismatch.status, mismatch.body.error], [400, 'resolution_reference_mismatch']);
    assert.equal(await count('ledger_entries'), 0);

    // Powyżej 3000 EUR bez tekstu: numer uchwały trafia do referencji; podwójne kliknięcie = jeden wpis.
    const entryKey = key('entry');
    const created = await createExpense(call, cookies.treasurer, { amountCents: 350000, resolutionId: adopted.id }, entryKey);
    assert.equal(created.status, 201);
    assert.equal(created.body.entry.resolutionId, adopted.id);
    assert.equal(created.body.entry.resolutionReference, 'U-1/2026');
    const replay = await createExpense(call, cookies.treasurer, { amountCents: 350000, resolutionId: adopted.id }, entryKey);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.entry.id, created.body.entry.id);
    assert.equal(await count('ledger_entries'), 1);
    const [event] = (await db.query("SELECT actor_id, metadata_json FROM audit_events WHERE action = 'ledger.entry.created'")).rows;
    assert.deepEqual(event, { actor_id: 'u-treasurer', metadata_json: { resolutionId: adopted.id, schoolYearId: YEAR } });

    // Uchwała budżetowa z poprzedniego roku upoważnia wydatek bieżącego roku — także skarbnikowi bez przydziału w roku poprzednim.
    const crossYear = await createExpense(call, cookies.treasurerYear, { amountCents: 120000, resolutionId: previousYear.id });
    assert.equal(crossYear.status, 201);
    const spending = (await db.query('SELECT resolution_id, spent_net_cents, entry_count FROM resolution_spending ORDER BY resolution_id')).rows;
    assert.deepEqual(spending.map((row) => [row.resolution_id, Number(row.spent_net_cents), Number(row.entry_count)]).sort(),
      [[adopted.id, 350000, 1], [previousYear.id, 120000, 1]].sort());

    // Lista uchwał dla panelu: rok bieżący i poprzedni, bez treści uchwały.
    const listed = await call('GET', `/api/ledger/resolutions?schoolYearId=${YEAR}`, cookies.treasurerYear);
    assert.equal(listed.status, 200);
    const ids = listed.body.resolutions.map((item) => item.id);
    assert.ok(ids.includes(adopted.id) && ids.includes(previousYear.id));
    assert.ok(!ids.includes(nextYear.id) && !ids.includes(rejected.id) && !ids.includes(classResolution.id) && !ids.includes(toCorrect.id));
    assertEvery(listed.body.resolutions, (item) => !('body' in item));
    assert.equal((await call('GET', `/api/ledger/resolutions?schoolYearId=${YEAR}`, cookies.rep)).status, 403);
  } finally { await db.close(); }
});

test('#93: kwota upoważnienia — tylko zarząd, przekroczenie 409, korekta przywraca kwotę, termin, zmiana kwoty jako nowy wiersz', async () => {
  const { db, cookies, call, count } = await setup();
  try {
    const adopted = await resolution(db, { number: 'U-5/2026' });
    const body = { authorizedAmountCents: 500000, note: 'Kwota z treści uchwały syntetycznej' };
    for (const cookie of [cookies.treasurer, cookies.audit, cookies.rep, cookies.boardNoMfa]) {
      assert.equal((await authorize(call, cookie, adopted.id, body)).status, 403);
    }
    const authKey = key('auth');
    const first = await authorize(call, cookies.board, adopted.id, body, authKey);
    assert.equal(first.status, 201);
    assert.equal((await authorize(call, cookies.board, adopted.id, body, authKey)).status, 200);
    assert.equal(await count('resolution_spending_authorizations'), 1);
    const [authEvent] = (await db.query("SELECT entity_id, metadata_json FROM audit_events WHERE action = 'resolution.spending_authorization.recorded'")).rows;
    assert.equal(authEvent.entity_id, adopted.id);
    assert.doesNotMatch(JSON.stringify(authEvent.metadata_json), /(?<![\w-])500000(?![\w-])|Kwota/);
    // Bez supersedesId, gdy kwota już istnieje -> 409 (nieaktualny stan).
    const stale = await authorize(call, cookies.board, adopted.id, { ...body, authorizedAmountCents: 600000 });
    assert.deepEqual([stale.status, stale.body.error], [409, 'authorization_superseded']);

    const e1 = await createExpense(call, cookies.treasurer, { amountCents: 300000, resolutionId: adopted.id });
    assert.equal(e1.status, 201);
    const over = await createExpense(call, cookies.treasurer, { amountCents: 200001, resolutionId: adopted.id });
    assert.deepEqual([over.status, over.body.error], [409, 'resolution_amount_exceeded']);
    const exact = await createExpense(call, cookies.treasurer, { amountCents: 150000, resolutionId: adopted.id });
    assert.equal(exact.status, 201);
    // Częściowy zwrot (korekta) zmniejsza wykorzystanie i przywraca dostępną kwotę.
    await call('POST', `/api/ledger/${e1.body.entry.id}/corrections`, cookies.treasurer, { amountCents: 60000, reason: 'Częściowy zwrot syntetyczny' }, key('corr'));
    assert.equal((await createExpense(call, cookies.treasurer, { amountCents: 110000, resolutionId: adopted.id })).status, 201);
    const [spending] = (await db.query('SELECT authorized_amount_cents, spent_net_cents, remaining_cents FROM resolution_spending WHERE resolution_id = $1', [adopted.id])).rows;
    assert.deepEqual([spending.authorized_amount_cents, spending.spent_net_cents, spending.remaining_cents].map(Number), [500000, 500000, 0]);

    // Nowa kwota z terminem: nowy wiersz wskazuje poprzedni; poprzedni zostaje.
    const raised = await authorize(call, cookies.board, adopted.id,
      { authorizedAmountCents: 700000, validUntil: '2026-12-31', note: 'Zwiększenie kwoty syntetyczne', supersedesId: first.body.authorization.id });
    assert.equal(raised.status, 201);
    assert.equal(await count('resolution_spending_authorizations'), 2);
    const late = await createExpense(call, cookies.treasurer, { amountCents: 1000, resolutionId: adopted.id, occurredOn: '2027-01-05' });
    assert.deepEqual([late.status, late.body.error], [409, 'resolution_expired']);
    assert.equal((await createExpense(call, cookies.treasurer, { amountCents: 1000, resolutionId: adopted.id, occurredOn: '2026-12-31' })).status, 201);
    await assert.rejects(db.query('UPDATE resolution_spending_authorizations SET authorized_amount_cents = 1'), /resolution_authorizations_are_immutable/);

    // Dwa równoległe wydatki, które razem przekraczają resztę: jeden przechodzi, drugi 409.
    const remaining = 700000 - 500000 - 1000;
    const results = await Promise.all([1, 2].map(() => createExpense(call, cookies.treasurer, { amountCents: remaining, resolutionId: adopted.id })));
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  } finally { await db.close(); }
});

test('#93/#97: raport KR — wykonanie uchwał, uchwała poprawiona na odrzuconą, weryfikacja i możliwy podział wydatku', async () => {
  const { db, cookies, call } = await setup();
  try {
    const adopted = await resolution(db, { number: 'U-6/2026' });
    const linked = await createExpense(call, cookies.treasurer, { amountCents: 320000, resolutionId: adopted.id, description: 'Wydatek z uchwałą' });
    assert.equal(linked.status, 201);
    const textOnly = await createExpense(call, cookies.treasurer, { amountCents: 310000, resolutionReference: 'U-6/2026', description: 'Wydatek z tekstem' });
    assert.equal(textOnly.status, 201);
    // Trzy wydatki po 1200 EUR na wycieczki w ciągu 30 dni: razem 3600 EUR.
    for (const occurredOn of ['2026-11-02', '2026-11-15', '2026-11-28']) {
      assert.equal((await createExpense(call, cookies.treasurer, { amountCents: 120000, categoryId: 'cat-trip', occurredOn, description: 'Wycieczka syntetyczna' })).status, 201);
    }
    await call('POST', `/api/ledger/${linked.body.entry.id}/reviews`, cookies.board, { decision: 'verified' }, key('rev'));

    let report = (await call('GET', `/api/reports/audit?schoolYearId=${YEAR}`, cookies.audit)).body.report;
    const byId = Object.fromEntries(report.largeExpenses.map((item) => [item.id, item]));
    assert.equal(byId[linked.body.entry.id].resolutionLink, 'explicit');
    assert.equal(byId[linked.body.entry.id].matchesAdoptedResolution, true);
    assert.equal(byId[textOnly.body.entry.id].resolutionLink, 'text');
    assert.deepEqual(report.resolutionExecution.map((item) => [item.resolutionId, item.status, item.spentNetCents, item.flagged]),
      [[adopted.id, 'adopted', 320000, false]]);
    assert.deepEqual(report.expenseReviews.unverified, { count: 4, netCents: 310000 + 3 * 120000 });
    assert.deepEqual(report.expenseReviews.verified, { count: 1, netCents: 320000 });
    assert.equal(report.expenseReviews.possibleSplits.length, 1);
    assert.deepEqual([report.expenseReviews.possibleSplits[0].entryCount, report.expenseReviews.possibleSplits[0].netCents], [3, 360000]);

    // Poprawka uchwały nową rewizją zmienia stan na „odrzucona”: powiązany wydatek jest oznaczony.
    await correctResolution(db, admin, {
      idempotencyKey: key('corr-res'), resolutionId: adopted.id, reason: 'Błędnie policzone głosy', status: 'rejected',
      votesFor: 0, votesAgainst: 1, votesAbstain: 0,
    });
    report = (await call('GET', `/api/reports/audit?schoolYearId=${YEAR}`, cookies.audit)).body.report;
    const flagged = report.largeExpenses.find((item) => item.id === linked.body.entry.id);
    assert.deepEqual([flagged.matchesAdoptedResolution, flagged.flagged], [false, true]);
    assert.deepEqual(report.resolutionExecution.map((item) => [item.status, item.spentNetCents, item.flagged]), [['rejected', 320000, true]]);

    const html = renderAuditReportHtml(report);
    assert.match(html, /3a\. Wykonanie uchwał finansowych/);
    assert.match(html, /3b\. Weryfikacja wydatków przez drugą osobę/);
    assert.match(html, /powiązanie tekstowe/);
    assert.match(html, /odrzucona/);
    // Raport sprzed 0072 (bez nowych sekcji) nadal się renderuje.
    const legacy = { ...report };
    delete legacy.resolutionExecution;
    delete legacy.expenseReviews;
    assert.doesNotMatch(renderAuditReportHtml(legacy), /3b\./);
  } finally { await db.close(); }
});
