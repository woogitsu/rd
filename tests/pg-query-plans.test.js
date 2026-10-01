// Regresja planów zapytań list z kursorem (issue #159). Seed wolumenowy (dane
// syntetyczne), ANALYZE, potem EXPLAIN dokładnie tych zapytań, które wysyłają
// trasy (przechwytujemy SQL i parametry z db.query) — zmiana zapytania, która
// wprowadzi Seq Scan na dużej tabeli, psuje test.
//
// Wolumen: > 10 000 wierszy w każdej tabeli objętej asercją. Test jest wolniejszy
// od zwykłych (kilkanaście sekund) — docelowo do nocnego przebiegu (#111).

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const VOLUME = 12000;
let db;
let admin;
let board;
let captured;
const env = {
  get db() {
    return {
      query: (sql, params) => {
        captured.push({ sql, params });
        return db.query(sql, params);
      },
      transaction: (fn) => db.transaction(fn),
    };
  },
};

async function call(path, cookie) {
  captured = [];
  const response = await handlePgRequest(request(path, { cookie }), env);
  const data = JSON.parse(await response.text());
  return { status: response.status, data, queries: [...captured] };
}

function planNodes(node, found = []) {
  found.push(node);
  for (const child of node.Plans ?? []) planNodes(child, found);
  return found;
}

async function explain({ sql, params }) {
  const { rows } = await db.query(`EXPLAIN (FORMAT JSON) ${sql}`, params ?? []);
  return planNodes(rows[0]['QUERY PLAN'][0].Plan);
}

async function assertNoSeqScan(queries, table) {
  const target = queries.find((q) => new RegExp(`FROM ${table}\\b`, 'i').test(q.sql) && /ORDER BY/i.test(q.sql) && /LIMIT/i.test(q.sql));
  assert.ok(target, `zapytanie listy po ${table} zostało wysłane`);
  const nodes = await explain(target);
  const scans = nodes.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table);
  assert.deepEqual(scans, [], `Seq Scan na ${table}: ${JSON.stringify(nodes.map((n) => [n['Node Type'], n['Relation Name'], n['Index Name']]))}`);
}

before(async () => {
  db = await createTestDb();
  await seedSchoolYear(db, 'y-plan');
  await seedSchoolYear(db, 'y-plan-2');
  admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: 'y-plan' }], mfa: true });
  await db.query(
    `INSERT INTO users (id, email, display_name)
     SELECT 'p-' || lpad(i::text, 6, '0'), 'p-' || lpad(i::text, 6, '0') || '@example.invalid', 'P ' || i
       FROM generate_series(1, ${VOLUME}) i`,
  );
  await db.query(
    `INSERT INTO role_grants (id, user_id, role, school_year_id, granted_by, granted_at)
     SELECT 'pg-' || i, 'p-' || lpad(i::text, 6, '0'), 'board', 'y-plan', 'u-admin', now() - i * interval '1 minute'
       FROM generate_series(1, ${VOLUME}) i`,
  );
  await db.query(
    `INSERT INTO invitations (id, email, token_hash, role, school_year_id, created_by, created_at, expires_at)
     SELECT 'pi-' || i, 'pi-' || i || '@example.invalid', encode(sha256(('t' || i)::bytea), 'hex'), 'board', 'y-plan', 'u-admin',
            now() - i * interval '1 minute', now() + interval '30 days'
       FROM generate_series(1, ${VOLUME}) i`,
  );
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, occurred_at)
     SELECT 'pa-' || i, 'u-admin', CASE WHEN i % 20 = 0 THEN 'role_grant.created' ELSE 'session.created' END,
            'x', 'x-' || i, now() - i * interval '1 second'
       FROM generate_series(1, ${VOLUME * 2}) i`,
  );
  await db.query(
    `INSERT INTO email_campaigns (id, school_year_id, title, audience, subject, body_text, content_hash, created_by, updated_by,
                                  idempotency_key, created_at)
     SELECT 'pc-' || i, CASE WHEN i % 2 = 0 THEN 'y-plan' ELSE 'y-plan-2' END, 'Kampania ' || i, 'all_households',
            'Temat ' || i, repeat('x', 30), repeat('a', 64), 'u-admin', 'u-admin', 'idem-pc-' || i,
            now() - i * interval '1 minute'
       FROM generate_series(1, ${VOLUME}) i`,
  );
  await db.query(
    `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by, school_year_id, sha256, idempotency_key, created_at)
     SELECT '00000000-0000-4000-8000-' || lpad(i::text, 12, '0'), 'docs/00000000-0000-4000-8000-' || lpad(i::text, 12, '0'),
            'application/pdf', 10, 'board', 'u-admin', CASE WHEN i % 2 = 0 THEN 'y-plan' ELSE 'y-plan-2' END,
            repeat('b', 64), 'idem-pd-' || i, now() - i * interval '1 minute'
       FROM generate_series(1, ${VOLUME}) i`,
  );
  // Księga i wpłaty z trzech lat (#159, dodatek): widoki netto agregują korekty,
  // więc plan odczytu jednego roku/gospodarstwa nie może czytać korekt wszystkich lat.
  await seedSchoolYear(db, 'y-plan-3');
  const years = ['y-plan', 'y-plan-2', 'y-plan-3'];
  for (const [n, year] of years.entries()) {
    await db.query(
      `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
         ('cat-in-${n}', $1, 'income', 'Przychody', 'u-admin'), ('cat-out-${n}', $1, 'expense', 'Wydatki', 'u-admin')`,
      [year],
    );
  }
  await db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on, method, created_by, idempotency_key)
     SELECT 'le-' || i, (ARRAY['y-plan','y-plan-2','y-plan-3'])[i % 3 + 1],
            CASE WHEN i % 2 = 0 THEN 'income' ELSE 'expense' END, 1000 + i % 500,
            CASE WHEN i % 2 = 0 THEN 'cat-in-' ELSE 'cat-out-' END || (i % 3),
            'Wpis syntetyczny ' || i, DATE '2026-09-01' + (i % 300), CASE WHEN i % 4 = 0 THEN 'cash' ELSE 'bank' END,
            'u-admin', 'idem-le-' || i
       FROM generate_series(1, ${VOLUME}) i`,
  );
  await db.query(
    `INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
     SELECT 'lc-' || i, 'le-' || i, 1, 'Korekta syntetyczna', 'u-admin', 'idem-lc-' || i
       FROM generate_series(1, ${VOLUME}) i`,
  );
  await db.query(`INSERT INTO households (id) SELECT 'hh-' || i FROM generate_series(1, 2000) i`);
  await db.query(
    `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key)
     SELECT 'pe-' || i, 'hh-' || (i % 2000 + 1), (ARRAY['y-plan','y-plan-2','y-plan-3'])[i % 3 + 1], 2000 + i % 100,
            DATE '2026-09-01' + (i % 300), 'bank', 'recorded', 'u-admin', 'idem-pe-' || i
       FROM generate_series(1, ${VOLUME}) i`,
  );
  await db.query(
    `INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
     SELECT 'pcor-' || i, 'pe-' || i, 1, 'Korekta syntetyczna', 'u-admin', 'idem-pcor-' || i
       FROM generate_series(1, ${VOLUME}) i`,
  );
  for (const table of ['users', 'role_grants', 'invitations', 'audit_events', 'email_campaigns', 'documents',
    'ledger_entries', 'ledger_corrections', 'payment_entries', 'payment_corrections']) {
    await db.query(`ANALYZE ${table}`);
  }
});
after(async () => { await db?.close(); });

test('GET /api/admin/users?cursor — bez Seq Scan po users', async () => {
  const first = await call('/api/admin/users?limit=50', admin);
  assert.equal(first.status, 200);
  const next = await call(`/api/admin/users?limit=50&cursor=${first.data.nextCursor}`, admin);
  assert.equal(next.status, 200);
  await assertNoSeqScan(next.queries, 'users');
});

test('GET /api/admin/grants?cursor — bez Seq Scan po role_grants', async () => {
  const first = await call('/api/admin/grants?status=all&limit=50', admin);
  const next = await call(`/api/admin/grants?status=all&limit=50&cursor=${first.data.nextCursor}`, admin);
  assert.equal(next.status, 200);
  await assertNoSeqScan(next.queries, 'role_grants');
});

test('GET /api/admin/invitations?cursor — bez Seq Scan po invitations', async () => {
  const first = await call('/api/admin/invitations?limit=50', admin);
  const next = await call(`/api/admin/invitations?limit=50&cursor=${first.data.nextCursor}`, admin);
  assert.equal(next.status, 200);
  await assertNoSeqScan(next.queries, 'invitations');
});

test('GET /api/admin/audit?cursor — bez Seq Scan po audit_events (z filtrem i bez)', async () => {
  for (const filter of ['', '&domain=access', '&from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z']) {
    const first = await call(`/api/admin/audit?limit=50${filter}`, admin);
    assert.equal(first.status, 200, filter);
    assert.ok(first.data.nextCursor, filter);
    const next = await call(`/api/admin/audit?limit=50&cursor=${first.data.nextCursor}${filter}`, admin);
    assert.equal(next.status, 200, filter);
    await assertNoSeqScan(next.queries, 'audit_events');
  }
});

test('GET /api/email/campaigns?cursor — bez Seq Scan po email_campaigns', async () => {
  const first = await call('/api/email/campaigns?schoolYearId=y-plan&limit=50', board);
  const next = await call(`/api/email/campaigns?schoolYearId=y-plan&limit=50&cursor=${first.data.nextCursor}`, board);
  assert.equal(next.status, 200);
  await assertNoSeqScan(next.queries, 'email_campaigns');
});

test('GET /api/documents?cursor — bez Seq Scan po documents', async () => {
  const first = await call('/api/documents?schoolYearId=y-plan&limit=50', admin);
  const next = await call(`/api/documents?schoolYearId=y-plan&limit=50&cursor=${first.data.nextCursor}`, admin);
  assert.equal(next.status, 200);
  await assertNoSeqScan(next.queries, 'documents');
});

// Widoki netto agregują korekty. Plan odczytu jednego roku (lub gospodarstwa) nie może
// czytać wszystkich korekt wszystkich lat (Seq Scan po tabeli korekt, > 10 000 wierszy).
async function assertNoSeqScanOf(sql, params, tables, label) {
  const nodes = await explain({ sql, params });
  const scans = nodes.filter((n) => n['Node Type'] === 'Seq Scan' && tables.includes(n['Relation Name']));
  assert.deepEqual(scans, [], `${label}: Seq Scan ${JSON.stringify(scans.map((n) => n['Relation Name']))}: ${JSON.stringify(nodes.map((n) => [n['Node Type'], n['Relation Name'], n['Index Name']]))}`);
}

test('ledger_entry_net dla jednego roku — bez Seq Scan po ledger_corrections', async () => {
  await assertNoSeqScanOf(
    'SELECT id, net_amount_cents FROM ledger_entry_net WHERE school_year_id = $1 AND occurred_on <= $2',
    ['y-plan', '2027-03-01'], ['ledger_corrections'], 'ledger_entry_net',
  );
});

test('ledger_balance_at i ledger_non_bank_net_at — treść funkcji bez Seq Scan po ledger_corrections', async () => {
  // Plan funkcji SQL jest wbudowany (inlining) tylko dla prostych funkcji; sprawdzamy
  // zapytanie z ciała funkcji oraz poprawność wyniku samej funkcji.
  await assertNoSeqScanOf(
    `SELECT sum(CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END)
       FROM ledger_entry_net e WHERE e.school_year_id = $1 AND e.occurred_on <= $2`,
    ['y-plan', '2027-03-01'], ['ledger_corrections'], 'ledger_balance_at (ciało)',
  );
  await assertNoSeqScanOf(
    `SELECT sum(CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END)
       FROM ledger_entry_net e WHERE e.school_year_id = $1 AND e.occurred_on <= $2 AND e.method <> 'bank'`,
    ['y-plan', '2027-03-01'], ['ledger_corrections'], 'ledger_non_bank_net_at (ciało)',
  );
  const { rows } = await db.query(
    `SELECT ledger_balance_at('y-plan', DATE '2027-03-01')::text AS balance,
            (SELECT COALESCE(sum(CASE WHEN e.direction = 'income' THEN e.amount_cents - COALESCE(c.s, 0) ELSE -(e.amount_cents - COALESCE(c.s, 0)) END), 0)
               FROM ledger_entries e LEFT JOIN (SELECT ledger_entry_id, sum(amount_cents) s FROM ledger_corrections GROUP BY 1) c ON c.ledger_entry_id = e.id
              WHERE e.school_year_id = 'y-plan' AND e.occurred_on <= DATE '2027-03-01')::text AS expected`,
  );
  assert.equal(rows[0].balance, rows[0].expected);
});

test('household_payment_totals dla jednego gospodarstwa — bez Seq Scan po payment_corrections i payment_entries', async () => {
  await assertNoSeqScanOf(
    'SELECT household_id, school_year_id, net_amount_cents, payment_count FROM household_payment_totals WHERE household_id = ANY($1::text[])',
    [['hh-7']], ['payment_corrections', 'payment_entries'], 'household_payment_totals',
  );
});
