// #181: historia zdarzeń jednego obiektu i filtr domenowy dziennika audytu.
// Wariant zachowawczy: odczyt wyłącznie admin+MFA (jak reszta modułu admin) —
// D-08/D-09 nie ustaliły jeszcze ról zarządu/KR per domena.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';

async function call(env, path, { cookie, method = 'GET', body, key } = {}) {
  const headers = key ? { 'Idempotency-Key': key } : undefined;
  const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y-1', { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedEnrolledHousehold(db, 'h-1', ['y-1']);
  const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
  const treasurer = await seedUserSession(db, { userId: 'u-treasurer', roles: [{ role: 'treasurer', schoolYearId: 'y-1' }], mfa: true });
  return { db, env: { db }, admin, treasurer };
}

async function recordPayment(env, cookie, key) {
  return call(env, '/api/payments', {
    method: 'POST', cookie, key,
    body: { householdId: 'h-1', schoolYearId: 'y-1', amountCents: 2500, receivedOn: '2026-10-01', method: 'bank' },
  });
}

test('historia wpłaty pokazuje utworzenie i korektę w kolejności; obiekt spoza słownika typów jest odrzucony', async () => {
  const { env, admin, treasurer } = await setup();
  const created = await recordPayment(env, treasurer, 'key-payment-history-0001');
  assert.equal(created.status, 201);
  const paymentId = created.data.payment.id;
  const corrected = await call(env, `/api/payments/${paymentId}/corrections`, {
    method: 'POST', cookie: treasurer, key: 'key-correction-0001',
    body: { amountCents: 500, reason: 'Blad kwoty przy zapisie' },
  });
  assert.equal(corrected.status, 201);

  const history = await call(env, `/api/admin/audit/entity/payment_entry/${paymentId}`, { cookie: admin });
  assert.equal(history.status, 200);
  assert.deepEqual(history.data.events.map((e) => e.action), ['payment.created', 'payment.correction.created']);
  assert.equal(history.data.events[0].actorId, 'u-treasurer');
  // Bez PII: brak adresu e-mail, imienia, kwoty odczytanej jako tekst z powodem wolnym.
  assert.doesNotMatch(JSON.stringify(history.data), /@/);

  const badType = await call(env, `/api/admin/audit/entity/guardian/${paymentId}`, { cookie: admin });
  assert.equal(badType.status, 400);
  assert.equal(badType.data.error, 'invalid_entity_type');

  const missing = await call(env, '/api/admin/audit/entity/payment_entry/p-nope', { cookie: admin });
  assert.equal(missing.status, 404);
});

test('odczyt historii sam zapisuje audit.viewed', async () => {
  const { env, admin } = await setup();
  const created = await recordPayment(env, admin, 'key-payment-history-0002');
  const paymentId = created.data.payment.id;
  await call(env, `/api/admin/audit/entity/payment_entry/${paymentId}`, { cookie: admin });
  const { rows } = await env.db.query(
    `SELECT 1 FROM audit_events WHERE action = 'audit.viewed' AND entity_type = 'payment_entry' AND entity_id = $1`,
    [paymentId],
  );
  assert.equal(rows.length, 1);
});

test('nie-admin nie ma dostępu do historii obiektu ani filtra domenowego', async () => {
  const { env, treasurer } = await setup();
  assert.equal((await call(env, '/api/admin/audit/entity/payment_entry/p-1', { cookie: treasurer })).status, 403);
  assert.equal((await call(env, '/api/admin/audit?domain=finance', { cookie: treasurer })).status, 403);
});

test('filtr domenowy zwraca tylko akcje domeny i odrzuca nieznaną domenę', async () => {
  const { env, admin, treasurer } = await setup();
  await recordPayment(env, treasurer, 'key-payment-history-0003');
  const finance = await call(env, '/api/admin/audit?domain=finance', { cookie: admin });
  assert.equal(finance.status, 200);
  assert.ok(finance.data.events.length > 0);
  assert.ok(finance.data.events.every((e) => e.action.startsWith('payment.') || e.action.startsWith('ledger.')
    || e.action.startsWith('reconciliation.') || e.action.startsWith('report.audit.')));

  const bad = await call(env, '/api/admin/audit?domain=nope', { cookie: admin });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'invalid_domain');

  // Domyślnie (bez domain) — zachowanie sprzed #181: tylko akcje AUDIT_ACTIONS.
  const defaultList = await call(env, '/api/admin/audit', { cookie: admin });
  assert.ok(defaultList.data.events.every((e) => !e.action.startsWith('payment.')));
});

test('odczyt listy z filtrem sam zapisuje audit.viewed z domeną jako entityId, bez parametrów zapytania', async () => {
  const { env, admin } = await setup();
  await call(env, '/api/admin/audit?domain=security&actorId=u-admin', { cookie: admin });
  const { rows } = await env.db.query(
    `SELECT entity_id, metadata_json FROM audit_events WHERE action = 'audit.viewed' ORDER BY occurred_at DESC LIMIT 1`,
  );
  assert.equal(rows[0].entity_id, 'security');
  const metadata = typeof rows[0].metadata_json === 'string' ? JSON.parse(rows[0].metadata_json) : rows[0].metadata_json;
  assert.deepEqual(metadata, {});
});

test('filtr actorId i schoolYearId zawężają wynik', async () => {
  const { env, admin, treasurer } = await setup();
  await recordPayment(env, treasurer, 'key-payment-history-0004');
  const byActor = await call(env, '/api/admin/audit?domain=finance&actorId=u-treasurer', { cookie: admin });
  assert.equal(byActor.status, 200);
  assert.ok(byActor.data.events.every((e) => e.actorId === 'u-treasurer'));
  // payment.created nie ma jeszcze schoolYearId w metadanych (luka #174);
  // role_grant.created (domena domyślna) ma, więc filtr sprawdzamy na nim.
  await call(env, '/api/admin/grants', {
    method: 'POST', cookie: admin, body: { userId: 'u-treasurer', role: 'board', schoolYearId: 'y-1' },
  });
  const byYear = await call(env, '/api/admin/audit?schoolYearId=y-1', { cookie: admin });
  assert.equal(byYear.status, 200);
  assert.ok(byYear.data.events.length > 0);
});
