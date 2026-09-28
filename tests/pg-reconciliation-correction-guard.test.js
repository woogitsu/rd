// Korekta z aktywnym powiązaniem w SZKICU uzgodnienia (#165, reszta).
// Wyłącznie dane syntetyczne. PGlite w pamięci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, seedSchoolYear, seedUserSession, TEST_ORIGIN } from './helpers/pg.js';

const YEAR = 'y-165b';

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
  await db.query("INSERT INTO households (id) VALUES ('h1')");
  const cookie = await seedUserSession(db, { userId: 'u-t', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const cookie2 = await seedUserSession(db, { userId: 'u-t2', mfa: true, roles: [{ role: 'treasurer', schoolYearId: YEAR }] });
  const env = { db };
  const fetch = (request) => handlePgRequest(request, env);
  return { db, cookie, cookie2, fetch };
}

async function createPayment(fetch, cookie, { amountCents, key }) {
  const res = await readJson(await fetch(req('/api/payments', {
    cookie, key,
    body: { schoolYearId: YEAR, householdId: 'h1', amountCents, receivedOn: '2026-10-01', method: 'bank', reference: 'Wpłata syntetyczna' },
  })));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.payment.id;
}

async function draftMatch(fetch, cookie, { paymentEntryId, amountCents }) {
  const rec = await readJson(await fetch(req('/api/reconciliations', {
    cookie, key: `k-rec-${paymentEntryId}`,
    body: { schoolYearId: YEAR, statementDate: '2026-10-10', statementBalanceCents: amountCents, notes: 'Test' },
  })));
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  const reconciliationId = rec.body.reconciliation.id;
  const lines = await readJson(await fetch(req(`/api/reconciliations/${reconciliationId}/lines`, {
    cookie, key: `k-lines-${paymentEntryId}`,
    body: { lines: [{ bookedOn: '2026-10-01', amountCents, reference: 'Tytuł syntetyczny' }] },
  })));
  assert.equal(lines.status, 201, JSON.stringify(lines.body));
  const detail = await readJson(await fetch(req(`/api/reconciliations/${reconciliationId}`, { cookie })));
  const statementLineId = detail.body.lines[0].id;
  const match = await readJson(await fetch(req(`/api/reconciliations/${reconciliationId}/matches`, {
    cookie, key: `k-match-${paymentEntryId}`,
    body: { statementLineId, paymentEntryId },
  })));
  assert.equal(match.status, 201, JSON.stringify(match.body));
  return { reconciliationId, matchId: match.body.match.id };
}

test('korekta wpłaty z aktywnym powiązaniem w szkicu jest blokowana (409 active_bank_match)', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 4000, key: 'k-pay-165-001' });
    const { reconciliationId } = await draftMatch(fetch, cookie, { paymentEntryId: paymentId, amountCents: 4000 });

    const blocked = await readJson(await fetch(req(`/api/payments/${paymentId}/corrections`, {
      cookie, key: 'k-corr-165-blocked-001', body: { amountCents: 500, reason: 'Pomyłka' },
    })));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'active_bank_match');
    assert.equal(blocked.body.reconciliationId, reconciliationId);
    assert.equal(await db.query('SELECT count(*)::int AS n FROM payment_corrections').then((r) => r.rows[0].n), 0);

    // Ponowienie tego samego żądania (ten sam klucz) po odrzuceniu 409 -> nadal 409, bez zapisu.
    const retry = await readJson(await fetch(req(`/api/payments/${paymentId}/corrections`, {
      cookie, key: 'k-corr-165-blocked-001', body: { amountCents: 500, reason: 'Pomyłka' },
    })));
    assert.equal(retry.status, 409);
    assert.equal(await db.query('SELECT count(*)::int AS n FROM payment_corrections').then((r) => r.rows[0].n), 0);
  } finally { await db.close(); }
});

test('po cofnięciu powiązania korekta wpłaty przechodzi', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    const paymentId = await createPayment(fetch, cookie, { amountCents: 4000, key: 'k-pay-165-002' });
    const { reconciliationId, matchId } = await draftMatch(fetch, cookie, { paymentEntryId: paymentId, amountCents: 4000 });

    const revoke = await readJson(await fetch(req(`/api/reconciliations/${reconciliationId}/matches/${matchId}/revocation`, {
      cookie, key: 'k-revoke-165-002', body: { reason: 'Test cofnięcia przed korektą' },
    })));
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));

    const ok = await readJson(await fetch(req(`/api/payments/${paymentId}/corrections`, {
      cookie, key: 'k-corr-165-ok-002', body: { amountCents: 500, reason: 'Pomyłka' },
    })));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  } finally { await db.close(); }
});

test('korekta wpisu księgi z aktywnym powiązaniem w szkicu jest blokowana; poza szkicem (bez powiązania) przechodzi', async () => {
  const { db, cookie, fetch } = await setup();
  try {
    await db.query(
      `INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by)
       VALUES ('cat-out', $1, 'expense', 'Wydatki', 'u-t')`,
      [YEAR],
    );
    const entry = await readJson(await fetch(req('/api/ledger', {
      cookie, key: 'k-led-165-003',
      body: {
        schoolYearId: YEAR, direction: 'expense', amountCents: 3000, categoryId: 'cat-out',
        description: 'Wydatek syntetyczny', occurredOn: '2026-10-02', method: 'bank',
      },
    })));
    assert.equal(entry.status, 201, JSON.stringify(entry.body));
    const ledgerEntryId = entry.body.entry.id;

    const rec = await readJson(await fetch(req('/api/reconciliations', {
      cookie, key: 'k-rec-165-003',
      body: { schoolYearId: YEAR, statementDate: '2026-10-10', statementBalanceCents: -3000, notes: 'Test' },
    })));
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    const reconciliationId = rec.body.reconciliation.id;
    await fetch(req(`/api/reconciliations/${reconciliationId}/lines`, {
      cookie, key: 'k-lines-165-003',
      body: { lines: [{ bookedOn: '2026-10-02', amountCents: -3000, reference: 'Tytuł syntetyczny' }] },
    }));
    const detail = await readJson(await fetch(req(`/api/reconciliations/${reconciliationId}`, { cookie })));
    const statementLineId = detail.body.lines[0].id;
    const match = await readJson(await fetch(req(`/api/reconciliations/${reconciliationId}/matches`, {
      cookie, key: 'k-match-165-003', body: { statementLineId, ledgerEntryId },
    })));
    assert.equal(match.status, 201, JSON.stringify(match.body));

    const blocked = await readJson(await fetch(req(`/api/ledger/${ledgerEntryId}/corrections`, {
      cookie, key: 'k-corr-led-165-blocked-003', body: { amountCents: 500, reason: 'Pomyłka' },
    })));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'active_bank_match');
    assert.equal(blocked.body.reconciliationId, reconciliationId);
  } finally { await db.close(); }
});
