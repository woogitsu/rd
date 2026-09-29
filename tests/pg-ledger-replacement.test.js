// Przeksięgowanie wpisu księgi: storno + wpis zastępczy, atomowo (#144).
// Wyłącznie dane syntetyczne. PGlite w pamięci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, seedSchoolYear, seedUserSession, TEST_ORIGIN } from './helpers/pg.js';

const YEAR = 'y-144';

function req(path, { cookie, method, body, key } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  const upper = method ?? (body !== undefined ? 'POST' : 'GET');
  if (upper !== 'GET') headers.set('Origin', TEST_ORIGIN);
  if (key) headers.set('Idempotency-Key', key);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${TEST_ORIGIN}${path}`, {
    method: upper, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(response) {
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, YEAR, { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  const cookie = await seedUserSession(db, { userId: 'u-t', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  await db.query(
    `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by) VALUES
       ('cat-in-a', $1, 'income', 'Składki A', 'u-t'),
       ('cat-in-b', $1, 'income', 'Składki B', 'u-t')`,
    [YEAR],
  );
  const env = { db };
  const fetch = (request) => handlePgRequest(request, env);
  return { db, cookie, fetch };
}

async function createEntry(fetch, cookie, { key, categoryId = 'cat-in-a', amountCents = 10000, occurredOn = '2026-10-01' }) {
  const res = await readJson(await fetch(req('/api/ledger', {
    cookie, key,
    body: { schoolYearId: YEAR, direction: 'income', amountCents, categoryId, description: 'Wpis syntetyczny', occurredOn, method: 'bank' },
  })));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.entry.id;
}

async function balance(db) {
  const { rows } = await db.query('SELECT closing_balance_cents FROM ledger_year_summary WHERE school_year_id = $1', [YEAR]);
  return Number(rows[0].closing_balance_cents);
}

test('przeksięgowanie zmienia kategorię, bilans roku identyczny przed i po', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const entryId = await createEntry(fetch, cookie, { key: 'k-led-144-001', categoryId: 'cat-in-a' });
    const before = await balance(db);
    const res = await readJson(await fetch(req(`/api/ledger/${entryId}/replacement`, {
      cookie, key: 'k-repl-144-001',
      body: {
        schoolYearId: YEAR, direction: 'income', amountCents: 10000, categoryId: 'cat-in-b',
        description: 'Poprawiona kategoria', occurredOn: '2026-10-01', method: 'bank', reason: 'Zła kategoria',
      },
    })));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.entry.replacesEntryId, entryId);
    const after = await balance(db);
    assert.equal(after, before);

    // Wpis oryginalny ma pełne storno (netto 0), wpis zastępczy pełną kwotę.
    const list = await readJson(await fetch(req(`/api/ledger?schoolYearId=${YEAR}`, { cookie })));
    const original = list.body.entries.find((e) => e.id === entryId);
    const replacement = list.body.entries.find((e) => e.id === res.body.entry.id);
    assert.equal(original.netAmountCents, 0);
    assert.equal(replacement.netAmountCents, 10000);
    assert.equal(replacement.categoryId, 'cat-in-b');
  } finally { await db.close(); }
});

test('wpis częściowo skorygowany, potem zastąpiony — storno tylko pozostałej kwoty', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const entryId = await createEntry(fetch, cookie, { key: 'k-led-144-002', amountCents: 10000 });
    const corr = await readJson(await fetch(req(`/api/ledger/${entryId}/corrections`, {
      cookie, key: 'k-corr-144-002', body: { amountCents: 4000, reason: 'Częściowa korekta' },
    })));
    assert.equal(corr.status, 201);
    const res = await readJson(await fetch(req(`/api/ledger/${entryId}/replacement`, {
      cookie, key: 'k-repl-144-002',
      body: {
        schoolYearId: YEAR, direction: 'income', amountCents: 6000, categoryId: 'cat-in-b',
        description: 'Zastępczy po korekcie', occurredOn: '2026-10-01', method: 'bank', reason: 'Poprawka',
      },
    })));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const stornoSum = await db.query(
      'SELECT sum(amount_cents)::int AS n FROM ledger_corrections WHERE ledger_entry_id = $1', [entryId],
    );
    assert.equal(stornoSum.rows[0].n, 10000); // 4000 (ręczna) + 6000 (storno reszty)
  } finally { await db.close(); }
});

test('wpis już zastąpiony nie może być zastąpiony ponownie (409); wpis zastępczy — może', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const entryId = await createEntry(fetch, cookie, { key: 'k-led-144-003' });
    const first = await readJson(await fetch(req(`/api/ledger/${entryId}/replacement`, {
      cookie, key: 'k-repl-144-003a',
      body: { schoolYearId: YEAR, direction: 'income', amountCents: 10000, categoryId: 'cat-in-b', description: 'Zastępczy', occurredOn: '2026-10-01', method: 'bank', reason: 'Poprawka' },
    })));
    assert.equal(first.status, 201);
    const replacementId = first.body.entry.id;

    const second = await readJson(await fetch(req(`/api/ledger/${entryId}/replacement`, {
      cookie, key: 'k-repl-144-003b',
      body: { schoolYearId: YEAR, direction: 'income', amountCents: 10000, categoryId: 'cat-in-a', description: 'Zastępczy 2', occurredOn: '2026-10-01', method: 'bank', reason: 'Poprawka' },
    })));
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'ledger_entry_already_replaced');

    // Wpis zastępczy sam może zostać zastąpiony (łańcuch przeksięgowań).
    const chained = await readJson(await fetch(req(`/api/ledger/${replacementId}/replacement`, {
      cookie, key: 'k-repl-144-003c',
      body: { schoolYearId: YEAR, direction: 'income', amountCents: 10000, categoryId: 'cat-in-a', description: 'Zastępczy 3', occurredOn: '2026-10-01', method: 'bank', reason: 'Kolejna poprawka' },
    })));
    assert.equal(chained.status, 201, JSON.stringify(chained.body));
  } finally { await db.close(); }
});

test('podwójne kliknięcie (ten sam klucz) odtwarza jedno storno i jeden wpis; inna treść -> 409', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const entryId = await createEntry(fetch, cookie, { key: 'k-led-144-004' });
    const body = { schoolYearId: YEAR, direction: 'income', amountCents: 10000, categoryId: 'cat-in-b', description: 'Zastępczy', occurredOn: '2026-10-01', method: 'bank', reason: 'Poprawka' };
    const first = await readJson(await fetch(req(`/api/ledger/${entryId}/replacement`, { cookie, key: 'k-repl-144-004', body })));
    assert.equal(first.status, 201);
    const replay = await readJson(await fetch(req(`/api/ledger/${entryId}/replacement`, { cookie, key: 'k-repl-144-004', body })));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.entry.id, first.body.entry.id);
    assert.equal(await db.query('SELECT count(*)::int AS n FROM ledger_corrections').then((r) => r.rows[0].n), 1);
    assert.equal(await db.query("SELECT count(*)::int AS n FROM ledger_entries WHERE replaces_entry_id = $1", [entryId]).then((r) => r.rows[0].n), 1);

    const conflict = await readJson(await fetch(req(`/api/ledger/${entryId}/replacement`, {
      cookie, key: 'k-repl-144-004', body: { ...body, description: 'Inna treść' },
    })));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'idempotency_conflict');
  } finally { await db.close(); }
});

// Wpis powiązany z wpłatą (0142): przeksięgowanie przenosi powiązanie — pełne scenariusze
// w tests/pg-ledger-replacement-links.test.js.
test('wpis powiązany z wpłatą jest przeksięgowany z zachowaniem powiązania (0142)', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    await db.query("INSERT INTO households (id) VALUES ('h1')");
    const payment = await readJson(await fetch(req('/api/payments', {
      cookie, key: 'k-pay-144-005',
      body: { schoolYearId: YEAR, householdId: 'h1', amountCents: 5000, receivedOn: '2026-10-01', method: 'bank', reference: 'Wpłata' },
    })));
    assert.equal(payment.status, 201, JSON.stringify(payment.body));
    const entry = await readJson(await fetch(req('/api/ledger', {
      cookie, key: 'k-led-144-005',
      body: {
        schoolYearId: YEAR, direction: 'income', amountCents: 5000, categoryId: 'cat-in-a',
        description: 'Ujęcie wpłaty', occurredOn: '2026-10-01', method: 'bank', paymentEntryId: payment.body.payment.id,
      },
    })));
    assert.equal(entry.status, 201, JSON.stringify(entry.body));

    const res = await readJson(await fetch(req(`/api/ledger/${entry.body.entry.id}/replacement`, {
      cookie, key: 'k-repl-144-005',
      body: { schoolYearId: YEAR, direction: 'income', amountCents: 5000, categoryId: 'cat-in-b', description: 'Poprawiona kategoria', occurredOn: '2026-10-01', method: 'bank', reason: 'Zła kategoria' },
    })));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.entry.paymentEntryId, payment.body.payment.id);
  } finally { await db.close(); }
});

test('rok zamknięty odrzuca przeksięgowanie (409 school_year_closed)', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const entryId = await createEntry(fetch, cookie, { key: 'k-led-144-006' });
    await seedSchoolYear(db, 'y-144-next', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
    // Stan „zamknięty” wprost (bez przebiegu zamknięcia), jak w tests/pg-school-year-dates.test.js.
    await db.exec(`
      SET session_replication_role = replica;
      INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
        closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
        carried_opening_balance_id, expired_grant_count)
      VALUES ('cl-144', '${YEAR}', 'y-144-next', 'closed', 'u-t', 'u-closer-x', now(), 0, 0, 0, 0, 'ob-x', 0);
      SET session_replication_role = origin;
    `);
    const res = await readJson(await fetch(req(`/api/ledger/${entryId}/replacement`, {
      cookie, key: 'k-repl-144-006',
      body: { schoolYearId: YEAR, direction: 'income', amountCents: 10000, categoryId: 'cat-in-b', description: 'Próba', occurredOn: '2026-10-01', method: 'bank', reason: 'Próba' },
    })));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'school_year_closed');
  } finally { await db.close(); }
});

test('przedstawiciel i audit dostają 403; brak MFA — 403', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const entryId = await createEntry(fetch, cookie, { key: 'k-led-144-007' });
    const repCookie = await seedUserSession(db, { userId: 'u-rep-144', roles: [{ role: 'representative', schoolYearId: YEAR, classId: 'kl-x' }] });
    const auditCookie = await seedUserSession(db, { userId: 'u-audit-144', mfa: true, roles: [{ role: 'audit', schoolYearId: YEAR }] });
    const noMfaCookie = await seedUserSession(db, { userId: 'u-t-nomfa-144', mfa: false, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
    const body = { schoolYearId: YEAR, direction: 'income', amountCents: 10000, categoryId: 'cat-in-b', description: 'Próba', occurredOn: '2026-10-01', method: 'bank', reason: 'Próba' };
    for (const cookie2 of [repCookie, auditCookie, noMfaCookie]) {
      const res = await readJson(await fetch(req(`/api/ledger/${entryId}/replacement`, { cookie: cookie2, key: `k-repl-144-007-${cookie2.length}`, body })));
      assert.equal(res.status, 403);
    }
  } finally { await db.close(); }
});
