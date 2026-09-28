// Centra kosztów w księdze (#117). Wyłącznie dane syntetyczne.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { request, seedClass, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const YEAR = 'y-test';
const OTHER = 'y-other';
let keySeq = 0;
const key = (prefix = 'cc') => `${prefix}-key-${++keySeq}-${Date.now()}`;

const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));
let shared = null;
let schemaSeq = 0;
after(async () => { await shared?.close(); });

async function freshDb() {
  shared ??= new PGlite();
  const schema = `cost_center_test_${++schemaSeq}`;
  await shared.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  for (const migration of await loadMigrations(migrationsDirectory)) await shared.exec(migration.sql);
  return { query: (...args) => shared.query(...args), exec: (...args) => shared.exec(...args),
    transaction: (fn) => shared.transaction(fn), close: async () => {} };
}

async function setup() {
  const db = await freshDb();
  await seedSchoolYear(db, YEAR);
  await seedSchoolYear(db, OTHER, { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  await seedClass(db, { id: 'c-1a', schoolYearId: YEAR, name: '1A' });
  await seedClass(db, { id: 'c-1b', schoolYearId: YEAR, name: '1B' });
  await seedClass(db, { id: 'c-other', schoolYearId: OTHER, name: '1A' });
  const cookies = {
    treasurer: await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-treasurer', mfa: false }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: YEAR }], mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal', schoolYearId: YEAR }], mfa: true }),
    rep: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-1a', schoolYearId: YEAR }], mfa: true,
    }),
  };
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
    ('cat-in', $1, 'income', 'Kiermasz', 'u-treasurer'),
    ('cat-out', $1, 'expense', 'Materiały', 'u-treasurer')`, [YEAR]);
  const entry = (id, direction, cents, category, date) => db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on,
       method, created_by, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7, 'bank', 'u-treasurer', $8)`,
    [id, YEAR, direction, cents, category, `Wpis syntetyczny ${id} test@example.invalid`, date, `le-key-${id}`]);
  await entry('le-fair-in', 'income', 40000, 'cat-in', '2026-10-10');
  await entry('le-fair-out', 'expense', 15000, 'cat-out', '2026-10-05');
  await entry('le-shared', 'expense', 9000, 'cat-out', '2026-10-06');
  await entry('le-general', 'expense', 1000, 'cat-out', '2026-10-07');
  await db.query(`INSERT INTO events (id, school_year_id, title, begins_at, visibility, created_by) VALUES
    ('ev-fair', $1, 'Kiermasz testowy', '2026-10-10T10:00:00Z', 'internal', 'u-board'),
    ('ev-ball', $1, 'Bal testowy', '2027-02-10T18:00:00Z', 'internal', 'u-board')`, [YEAR]);
  await db.query(`INSERT INTO events (id, school_year_id, title, begins_at, visibility, created_by) VALUES
    ('ev-other', $1, 'Wydarzenie innego roku', '2027-10-10T10:00:00Z', 'internal', 'u-board')`, [OTHER]);
  const call = (path, options = {}) => handlePgRequest(request(path, options), { db });
  return { db, cookies, call };
}

function allocate(call, cookie, entryId, body, idempotencyKey = key('alloc')) {
  return call(`/api/ledger/${entryId}/allocations`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': idempotencyKey }, body,
  });
}

test('allocations to an event and split across two classes; report sums to the year summary with "ogólne"', async () => {
  const { db, cookies, call } = await setup();
  assert.equal((await allocate(call, cookies.treasurer, 'le-fair-in', { items: [{ eventId: 'ev-fair', amountCents: 40000 }] })).status, 201);
  assert.equal((await allocate(call, cookies.treasurer, 'le-fair-out', { items: [{ eventId: 'ev-fair', amountCents: 15000 }] })).status, 201);
  const split = await allocate(call, cookies.board, 'le-shared', { items: [
    { classId: 'c-1a', amountCents: 4000 }, { classId: 'c-1b', amountCents: 3000 },
  ] });
  assert.equal(split.status, 201);
  const splitBody = await split.json();
  assert.equal(splitBody.allocation.allocatedCents, 7000);
  assert.equal(splitBody.allocation.generalCents, 2000);

  const summary = (await (await call(`/api/ledger/summary?schoolYearId=${YEAR}`, { cookie: cookies.treasurer })).json()).summary;
  for (const type of ['event', 'class']) {
    const { report } = await (await call(`/api/ledger/cost-centers?schoolYearId=${YEAR}&type=${type}`, { cookie: cookies.treasurer })).json();
    const income = report.centers.reduce((s, c) => s + c.incomeCents, 0) + report.general.incomeCents;
    const expense = report.centers.reduce((s, c) => s + c.expenseCents, 0) + report.general.expenseCents;
    assert.equal(income, summary.incomeCents, `${type}: przychody`);
    assert.equal(expense, summary.expenseCents, `${type}: wydatki`);
    if (type === 'event') {
      assert.deepEqual(report.centers.map((c) => [c.id, c.incomeCents, c.expenseCents, c.resultCents]), [['ev-fair', 40000, 15000, 25000]]);
    } else {
      assert.deepEqual(report.centers.map((c) => [c.id, c.expenseCents]), [['c-1a', 4000], ['c-1b', 3000]]);
      // Raport klas nie zawiera wpłat rodzin ani opisów wpisów.
      assert.doesNotMatch(JSON.stringify(report), /example\.invalid|payment/);
    }
  }

  const csv = await call(`/api/ledger/cost-centers?schoolYearId=${YEAR}&type=event&format=csv`, { cookie: cookies.treasurer });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /wydarzenie;ev-fair;Kiermasz testowy;draft;400,00;150,00;250,00/);
  assert.match(text, /ogólne;;Bez przypisania;;0,00;100,00;-100,00/);

  const finance = await (await call('/api/ledger/cost-centers/events/ev-fair', { cookie: cookies.board })).json();
  assert.equal(finance.event.resultCents, 25000);
  assert.deepEqual(finance.event.entries.map((e) => e.ledgerEntryId), ['le-fair-out', 'le-fair-in']);

  const audit = await db.query("SELECT metadata_json FROM audit_events WHERE action = 'ledger.allocation.created'");
  assert.equal(audit.rows.length, 3);
});

test('event or class from another year is refused (API 400 and FK in the database)', async () => {
  const { db, cookies, call } = await setup();
  for (const item of [{ eventId: 'ev-other', amountCents: 100 }, { classId: 'c-other', amountCents: 100 }, { eventId: 'nope', amountCents: 1 }]) {
    const response = await allocate(call, cookies.treasurer, 'le-general', { items: [item] });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_cost_center');
  }
  await db.query(`INSERT INTO ledger_allocation_versions (id, ledger_entry_id, school_year_id, version_no, created_by, idempotency_key)
    VALUES ('v-direct', 'le-general', $1, 1, 'u-treasurer', 'direct-version-1')`, [YEAR]);
  await assert.rejects(db.query(`INSERT INTO ledger_allocation_items (id, version_id, school_year_id, event_id, amount_cents)
    VALUES ('i-direct', 'v-direct', $1, 'ev-other', 100)`, [YEAR]), /foreign key/);
  await assert.rejects(db.query("UPDATE ledger_allocation_versions SET reason = 'zmiana' WHERE id = 'v-direct'"), /immutable|cannot/);
});

test('sum above net is refused; a correction below the allocation needs a new version first', async () => {
  const { db, cookies, call } = await setup();
  const over = await allocate(call, cookies.treasurer, 'le-shared', { items: [
    { classId: 'c-1a', amountCents: 5000 }, { classId: 'c-1b', amountCents: 5000 },
  ] });
  assert.equal(over.status, 409);
  assert.equal((await over.json()).error, 'allocation_exceeds_net');
  const first = await (await allocate(call, cookies.treasurer, 'le-shared', { items: [
    { classId: 'c-1a', amountCents: 4500 }, { classId: 'c-1b', amountCents: 4500 },
  ] })).json();

  const correct = (amountCents) => call('/api/ledger/le-shared/corrections', {
    method: 'POST', cookie: cookies.treasurer, headers: { 'Idempotency-Key': key('corr') },
    body: { amountCents, reason: 'Zwrot części kosztów — syntetyczne' },
  });
  const blocked = await correct(1000);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'allocation_exceeds_net');

  const second = await allocate(call, cookies.treasurer, 'le-shared', {
    supersedesId: first.versionId, reason: 'Korekta kosztów wycieczki',
    items: [{ classId: 'c-1a', amountCents: 4000 }, { classId: 'c-1b', amountCents: 4000 }],
  });
  assert.equal(second.status, 201);
  assert.equal((await correct(1000)).status, 201);

  const history = await (await call('/api/ledger/le-shared/allocations', { cookie: cookies.board })).json();
  assert.equal(history.allocation.netAmountCents, 8000);
  assert.deepEqual(history.allocation.versions.map((v) => [v.versionNo, v.supersedesId, v.reason]),
    [[1, null, null], [2, first.versionId, 'Korekta kosztów wycieczki']]);
  assert.equal(history.allocation.generalCents, 0);
  // Bezpośredni INSERT korekty też jest pilnowany przez bazę.
  await assert.rejects(db.query(`INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
    VALUES ('lc-direct', 'le-shared', 100, 'Syntetyczna korekta', 'u-treasurer', 'lc-direct-key-1')`), /ledger_allocation_exceeds_net/);
});

test('double click: same key replays, a stale supersedesId (other key) is refused; change needs a reason', async () => {
  const { cookies, call } = await setup();
  const sameKey = key('alloc');
  const body = { items: [{ eventId: 'ev-fair', amountCents: 40000 }] };
  const results = await Promise.all([
    allocate(call, cookies.treasurer, 'le-fair-in', body, sameKey),
    allocate(call, cookies.treasurer, 'le-fair-in', body, sameKey),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  const firstId = (await results.find((r) => r.status === 201).json()).versionId;

  const conflictingKey = await allocate(call, cookies.treasurer, 'le-fair-in', { items: [] }, sameKey);
  assert.equal(conflictingKey.status, 409);
  assert.equal((await conflictingKey.json()).error, 'idempotency_conflict');

  const again = await allocate(call, cookies.treasurer, 'le-fair-in', body);
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: 'allocation_version_conflict', currentVersionId: firstId });

  const noReason = await allocate(call, cookies.treasurer, 'le-fair-in', { supersedesId: firstId, items: [] });
  assert.equal(noReason.status, 400);
  assert.equal((await noReason.json()).error, 'allocation_reason_required');

  const parallel = await Promise.all([1, 2].map(() => allocate(call, cookies.treasurer, 'le-fair-in',
    { supersedesId: firstId, reason: 'Przeniesienie do ogólnych', items: [] })));
  assert.deepEqual(parallel.map((r) => r.status).sort(), [201, 409]);
  const history = await (await call('/api/ledger/le-fair-in/allocations', { cookie: cookies.treasurer })).json();
  assert.equal(history.allocation.versions.length, 2);
  assert.equal(history.allocation.generalCents, 40000);
});

test('cancelled event keeps its allocated entries; the report shows its status', async () => {
  const { db, cookies, call } = await setup();
  await allocate(call, cookies.treasurer, 'le-fair-out', { items: [{ eventId: 'ev-ball', amountCents: 15000 }] });
  await db.exec(`SET session_replication_role = replica;
    UPDATE events SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'u-board',
      cancellation_reason = 'Odwołane — syntetyczne' WHERE id = 'ev-ball';
    SET session_replication_role = origin;`);
  const { report } = await (await call(`/api/ledger/cost-centers?schoolYearId=${YEAR}&type=event`, { cookie: cookies.treasurer })).json();
  assert.deepEqual(report.centers.map((c) => [c.id, c.status, c.expenseCents]), [['ev-ball', 'cancelled', 15000]]);
  const finance = await (await call('/api/ledger/cost-centers/events/ev-ball', { cookie: cookies.treasurer })).json();
  assert.equal(finance.event.status, 'cancelled');
  assert.equal(finance.event.expenseCents, 15000);
});

test('representative, audit, principal and missing MFA get 403 on every route, without an existence oracle', async () => {
  const { db, cookies, call } = await setup();
  await allocate(call, cookies.treasurer, 'le-shared', { items: [{ classId: 'c-1b', amountCents: 1000 }] });
  const routes = [
    ['GET', '/api/ledger/le-shared/allocations'],
    ['GET', '/api/ledger/does-not-exist/allocations'],
    ['POST', '/api/ledger/le-shared/allocations'],
    ['GET', `/api/ledger/cost-centers?schoolYearId=${YEAR}&type=class`],
    ['GET', '/api/ledger/cost-centers/events/ev-fair'],
    ['GET', '/api/ledger/cost-centers/events/does-not-exist'],
  ];
  for (const cookie of [cookies.rep, cookies.audit, cookies.principal, cookies.treasurerNoMfa]) {
    for (const [method, path] of routes) {
      const response = await call(path, {
        method, cookie, headers: method === 'POST' ? { 'Idempotency-Key': key('deny') } : {},
        body: method === 'POST' ? { items: [{ classId: 'c-1a', amountCents: 100 }] } : undefined,
      });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.doesNotMatch(await response.text(), /1B|c-1b|Kiermasz/);
    }
  }
  const { rows } = await db.query('SELECT count(*)::int AS n FROM ledger_allocation_versions');
  assert.equal(rows[0].n, 1);
});

test('closed school year: new allocation version is refused with 409', async () => {
  const { db, cookies, call } = await setup();
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-1', '${YEAR}', '${OTHER}', 'closed', 'u-treasurer', 'u-board', now(), 0, 0, 0, 0, 'ob-next', 0);
    SET session_replication_role = origin;
  `);
  const response = await allocate(call, cookies.treasurer, 'le-general', { items: [{ eventId: 'ev-fair', amountCents: 100 }] });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'school_year_closed');
});
