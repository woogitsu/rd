// Wyścigi powiązań w uzgodnieniu na prawdziwym PostgreSQL (#162, #165).
// PGlite serializuje transakcje, więc tych przeplotów nie odtworzy. Test działa
// tylko z RD_TEST_PG_URL (adres serwera testowego z prawem CREATE DATABASE);
// tworzy i usuwa własną bazę. Bez zmiennej jest pomijany.
// Wyłącznie dane syntetyczne.
//
//   RD_TEST_PG_URL=postgres://postgres@127.0.0.1:55462/postgres node --test tests/pg-reconciliation-race.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPgDatabase } from '../src/db.js';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const ADMIN_URL = process.env.RD_TEST_PG_URL;
const YEAR = 'y-race';
const skip = ADMIN_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';
let seq = 0;
const key = (prefix) => `${prefix}-race-${++seq}-${Date.now()}`;

async function withDatabase(fn) {
  const name = `rd_race_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const db = createPgDatabase({ connectionString: url.toString(), max: 8 });
  try {
    await applyMigrations(client, await loadMigrations(fileURLToPath(new URL('../postgres/migrations/', import.meta.url))));
    await client.end();
    await fn(db, url.toString());
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}

async function seed(db) {
  await seedSchoolYear(db, YEAR);
  const cookie = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: YEAR }], mfa: true });
  const board = await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: YEAR }], mfa: true });
  await db.query(`INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
    VALUES ('cat-dues', $1, 'income', 'Składki dobrowolne', 'u-treasurer')`, [YEAR]);
  await db.query("INSERT INTO households (id) VALUES ('h-1')");
  return { cookie, board };
}

async function draftWithLine(call, cookie, amountCents) {
  const created = await call('/api/reconciliations', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key('rec') },
    body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 0 },
  });
  const { reconciliation } = await created.json();
  await call(`/api/reconciliations/${reconciliation.id}/lines`, {
    method: 'POST', cookie, headers: { 'Idempotency-Key': key('imp') },
    body: { lines: [{ bookedOn: '2026-09-14', amountCents }] },
  });
  const detail = await (await call(`/api/reconciliations/${reconciliation.id}`, { cookie })).json();
  return { id: reconciliation.id, lineId: detail.lines[0].id };
}

async function insertEntry(db, id, cents, paymentId = null) {
  await db.query(`INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description,
    occurred_on, method, payment_entry_id, created_by, idempotency_key)
    VALUES ($1, $2, 'income', $3, 'cat-dues', 'Wpis syntetyczny', '2026-09-14', 'bank', $4, 'u-treasurer', $5)`,
  [id, YEAR, cents, paymentId, `le-key-${id}`]);
}

async function insertPayment(db, id, cents) {
  await db.query(`INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method,
    status, created_by, idempotency_key) VALUES ($1, 'h-1', $2, $3, '2026-09-14', 'bank', 'recorded', 'u-treasurer', $4)`,
  [id, YEAR, cents, `pay-key-${id}`]);
}

// Transakcja trzymana otwarta na osobnym połączeniu: wymusza przeplot „korekta
// zablokowała cel, a drugie żądanie startuje w tym czasie”.
async function openTransaction(url, sql, params) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('BEGIN');
  await client.query(sql, params);
  return {
    async commit() { await client.query('COMMIT'); await client.end(); },
  };
}

async function waitsThenCommits(holder, pending) {
  // Drugie żądanie musi czekać na blokadę, a nie rozstrzygać ze starą migawką.
  const early = await Promise.race([pending.then(() => 'finished', () => 'finished'), sleep(300).then(() => 'waiting')]);
  await holder.commit();
  return early;
}

test('a match waits for an uncommitted correction of its target and compares the new net amount', { skip }, async () => {
  await withDatabase(async (db, url) => {
    const { cookie } = await seed(db);
    const call = (path, options = {}) => handlePgRequest(request(path, { cookie, ...options }), { db });
    for (const kind of ['ledger', 'payment']) {
      const target = `${kind}-1`;
      if (kind === 'ledger') await insertEntry(db, target, 5000);
      else await insertPayment(db, target, 5000);
      const draft = await draftWithLine(call, cookie, 5000);
      const holder = await openTransaction(url, kind === 'ledger'
        ? `INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
           VALUES ($1, $2, 2000, 'Korekta syntetyczna', 'u-treasurer', $3)`
        : `INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
           VALUES ($1, $2, 2000, 'Korekta syntetyczna', 'u-treasurer', $3)`, [`corr-${kind}`, target, key('c')]);
      const pending = call(`/api/reconciliations/${draft.id}/matches`, {
        method: 'POST', headers: { 'Idempotency-Key': key('m') },
        body: kind === 'ledger' ? { statementLineId: draft.lineId, ledgerEntryId: target }
          : { statementLineId: draft.lineId, paymentEntryId: target },
      });
      assert.equal(await waitsThenCommits(holder, pending), 'waiting', kind);
      const match = await pending;
      assert.equal(match.status, 409, kind);
      assert.equal((await match.json()).error, 'match_amount_mismatch');
      const stale = await db.query(
        'SELECT count(*)::int AS n FROM bank_match_consistency WHERE reconciliation_id = $1 AND NOT amount_matches', [draft.id]);
      assert.equal(stale.rows[0].n, 0, kind);
    }
  });
});

test('matching a ledger entry waits for an uncommitted match of its payment and is refused', { skip }, async () => {
  await withDatabase(async (db, url) => {
    const { cookie } = await seed(db);
    const call = (path, options = {}) => handlePgRequest(request(path, { cookie, ...options }), { db });
    await insertPayment(db, 'p-1', 2500);
    await insertEntry(db, 'le-1', 2500, 'p-1');
    const created = await call('/api/reconciliations', {
      method: 'POST', headers: { 'Idempotency-Key': key('rec') },
      body: { schoolYearId: YEAR, statementDate: '2026-09-30', statementBalanceCents: 0 },
    });
    const { reconciliation } = await created.json();
    await call(`/api/reconciliations/${reconciliation.id}/lines`, {
      method: 'POST', headers: { 'Idempotency-Key': key('imp') },
      body: { lines: [{ bookedOn: '2026-09-14', amountCents: 2500 }, { bookedOn: '2026-09-15', amountCents: 2500 }] },
    });
    const { rows: lines } = await db.query(
      'SELECT id FROM bank_statement_lines WHERE reconciliation_id = $1 ORDER BY booked_on', [reconciliation.id]);
    // Oba zapisy bezpośrednio w bazie, z pominięciem blokady w trasie: kontrola musi być w triggerze.
    const holder = await openTransaction(url, `INSERT INTO bank_reconciliation_matches (id, reconciliation_id,
      statement_line_id, payment_entry_id, created_by, idempotency_key) VALUES ('mp-1', $1, $2, 'p-1', 'u-treasurer', $3)`,
    [reconciliation.id, lines[0].id, key('dm')]);
    const pending = db.transaction((tx) => tx.query(`INSERT INTO bank_reconciliation_matches (id, reconciliation_id,
      statement_line_id, ledger_entry_id, created_by, idempotency_key) VALUES ('ml-1', $1, $2, 'le-1', 'u-treasurer', $3)`,
    [reconciliation.id, lines[1].id, key('dm')]));
    assert.equal(await waitsThenCommits(holder, pending), 'waiting');
    await assert.rejects(pending, /bank_match_already_matched_via_payment/);
  });
});

test('confirmation waits for an uncommitted correction of a matched entry and is refused', { skip }, async () => {
  await withDatabase(async (db, url) => {
    const { cookie, board } = await seed(db);
    const call = (path, options = {}) => handlePgRequest(request(path, { cookie, ...options }), { db });
    await insertEntry(db, 'le-c', 5000);
    const draft = await draftWithLine(call, cookie, 5000);
    const matched = await call(`/api/reconciliations/${draft.id}/matches`, {
      method: 'POST', headers: { 'Idempotency-Key': key('m') }, body: { statementLineId: draft.lineId, ledgerEntryId: 'le-c' },
    });
    assert.equal(matched.status, 201);
    const holder = await openTransaction(url, `INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason,
      created_by, idempotency_key) VALUES ('corr-c', 'le-c', 2000, 'Korekta syntetyczna', 'u-treasurer', $1)`, [key('c')]);
    const pending = call(`/api/reconciliations/${draft.id}/confirm`, {
      method: 'POST', cookie: board, body: { confirmationNote: 'Sprawdzone syntetycznie' },
    });
    assert.equal(await waitsThenCommits(holder, pending), 'waiting');
    const confirm = await pending;
    assert.equal(confirm.status, 409);
    const body = await confirm.json();
    assert.equal(body.error, 'inconsistent_matches');
    assert.deepEqual(body.matches.map((m) => [m.lineAmountCents, m.targetNetCents]), [[5000, 3000]]);
    assert.equal((await db.query('SELECT status FROM bank_reconciliations WHERE id = $1', [draft.id])).rows[0].status, 'draft');
  });
});
