// #181: GET /api/audit/entity/{typ}/{id} — historia obiektu dla zarządu i skarbnika.
// Wariant zachowawczy (D-08/D-09): board/treasurer z MFA i przydziałem ogólnoszkolnym na rok obiektu.
// Dane syntetyczne; żadnych wysyłek.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedClass, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { assertEvery } from './helpers/assertions.js';

async function setup() {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y-1', { startsOn: '2026-09-01', endsOn: '2027-08-31' });
  await seedSchoolYear(db, 'y-2', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  const classId = await seedClass(db, { id: 'cls-1a', schoolYearId: 'y-1', name: '1A' });
  await seedEnrolledHousehold(db, 'h-1', ['y-1'], { classIds: { 'y-1': classId } });
  // Dwoje opiekunów jednego dziecka — ich dane nie mogą trafić do historii wpłaty.
  for (const [id, first] of [['g-1', 'Anna'], ['g-2', 'Bartosz']]) {
    await db.query(
      `INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
       VALUES ($1, 'h-1', $2, 'Opiekunowski', $3, true)`,
      [id, first, `${id}@example.invalid`],
    );
  }
  const sessions = {
    admin: await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true }),
    treasurer: await seedUserSession(db, { userId: 'u-tr', roles: [{ role: 'treasurer', schoolYearId: 'y-1' }], mfa: true }),
    board: await seedUserSession(db, { userId: 'u-bd', roles: [{ role: 'board', schoolYearId: 'y-1' }], mfa: true }),
    boardClass: await seedUserSession(db, { userId: 'u-bdc', roles: [{ role: 'board', schoolYearId: 'y-1', classId }], mfa: true }),
    rep: await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', schoolYearId: 'y-1', classId }], mfa: true }),
    audit: await seedUserSession(db, { userId: 'u-kr', roles: [{ role: 'audit', schoolYearId: 'y-1' }], mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-dir', roles: [{ role: 'principal', schoolYearId: 'y-1' }], mfa: true }),
    treasurerNoMfa: await seedUserSession(db, { userId: 'u-trn', roles: [{ role: 'treasurer', schoolYearId: 'y-1' }], mfa: false }),
    treasurerYear2: await seedUserSession(db, { userId: 'u-tr2', roles: [{ role: 'treasurer', schoolYearId: 'y-2' }], mfa: true }),
  };
  const env = { db };
  const call = async (cookie, path, { method = 'GET', body, key } = {}) => {
    const headers = key ? { 'Idempotency-Key': key } : undefined;
    const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, text };
  };
  return { db, env, sessions, call };
}

async function payAndCorrect(t, key) {
  const created = await t.call(t.sessions.treasurer, '/api/payments', {
    method: 'POST', key,
    body: { householdId: 'h-1', schoolYearId: 'y-1', amountCents: 2500, receivedOn: '2026-10-01', method: 'bank' },
  });
  assert.equal(created.status, 201, created.text);
  return created.data.payment.id;
}

test('skarbnik widzi historię wpłaty: utworzenie, korekty po kolei, bez danych opiekunów', async () => {
  const t = await setup();
  const id = await payAndCorrect(t, 'key-board-history-0001');
  for (const [n, amountCents] of [[1, 500], [2, 300]]) {
    const corrected = await t.call(t.sessions.treasurer, `/api/payments/${id}/corrections`, {
      method: 'POST', key: `key-board-correction-000${n}`, body: { amountCents, reason: 'Blad kwoty przy zapisie' },
    });
    assert.equal(corrected.status, 201, corrected.text);
  }
  const history = await t.call(t.sessions.treasurer, `/api/audit/entity/payment_entry/${id}`);
  assert.equal(history.status, 200, history.text);
  assert.deepEqual(history.data.events.map((e) => e.action), ['payment.created', 'payment.correction.created', 'payment.correction.created']);
  assert.equal(history.data.events[0].actorId, 'u-tr');
  assert.equal(history.data.events[0].actorKind, 'user');
  assert.doesNotMatch(history.text, /@|Anna|Bartosz|Opiekunowski/);
  // Zarząd (inna osoba) widzi to samo.
  const byBoard = await t.call(t.sessions.board, `/api/audit/entity/payment_entry/${id}`);
  assert.equal(byBoard.status, 200);
  assert.deepEqual(byBoard.data.events.map((e) => e.id), history.data.events.map((e) => e.id));
});

test('historia wpłaty nieprzypisanej: przypisanie do gospodarstwa dopisuje zdarzenie bez opiekunów', async () => {
  const t = await setup();
  await t.db.query(
    `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, reference, status, created_by, idempotency_key)
     VALUES ('p-un', NULL, 'y-1', 5000, '2026-10-02', 'bank', 'Wpłata bez gospodarstwa', 'unmatched', 'u-tr', 'p-un-key')`,
  );
  const assigned = await t.call(t.sessions.treasurer, '/api/payments/p-un/assignment', {
    method: 'POST', key: 'key-board-assign-0001', body: { householdId: 'h-1' },
  });
  assert.equal(assigned.status, 201, assigned.text);
  const history = await t.call(t.sessions.treasurer, '/api/audit/entity/payment_entry/p-un');
  assert.equal(history.status, 200, history.text);
  assert.ok(history.data.events.some((e) => e.action === 'payment.assigned'), 'przypisanie widoczne w historii');
  assert.doesNotMatch(history.text, /@|Anna|Bartosz|Opiekunowski/);
});

test('podwójne kliknięcie (ten sam klucz) zostawia w historii jedno zdarzenie utworzenia', async () => {
  const t = await setup();
  const id = await payAndCorrect(t, 'key-board-history-0002');
  const replay = await t.call(t.sessions.treasurer, '/api/payments', {
    method: 'POST', key: 'key-board-history-0002',
    body: { householdId: 'h-1', schoolYearId: 'y-1', amountCents: 2500, receivedOn: '2026-10-01', method: 'bank' },
  });
  assert.ok([200, 201].includes(replay.status), replay.text);
  const history = await t.call(t.sessions.board, `/api/audit/entity/payment_entry/${id}`);
  assert.deepEqual(history.data.events.map((e) => e.action), ['payment.created']);
});

test('granice ról: admin, KR, dyrekcja, przedstawiciel, zarząd klasowy, bez MFA i bez sesji', async () => {
  const t = await setup();
  const id = await payAndCorrect(t, 'key-board-history-0003');
  const path = `/api/audit/entity/payment_entry/${id}`;
  const denied = {};
  for (const actor of ['admin', 'audit', 'principal', 'rep', 'boardClass', 'treasurerNoMfa']) {
    denied[actor] = await t.call(t.sessions[actor], path);
    assert.equal(denied[actor].status, 403, `${actor}: ${denied[actor].text}`);
    assert.doesNotMatch(denied[actor].text, /payment\./);
  }
  assert.equal((await t.call(undefined, path)).status, 401);
  assert.equal((await t.call(t.sessions.treasurer, path, { method: 'POST' })).status, 405);
});

test('obiekt roku bez przydziału i nieistniejący dają to samo 404; zły typ to 400', async () => {
  const t = await setup();
  const id = await payAndCorrect(t, 'key-board-history-0004');
  const outOfYear = await t.call(t.sessions.treasurerYear2, `/api/audit/entity/payment_entry/${id}`);
  const missing = await t.call(t.sessions.treasurerYear2, '/api/audit/entity/payment_entry/p-nie-ma');
  assert.equal(outOfYear.status, 404);
  assert.deepEqual(outOfYear.data, missing.data);
  assert.equal(missing.status, 404);
  const badType = await t.call(t.sessions.treasurer, `/api/audit/entity/guardian/${id}`);
  assert.equal(badType.status, 400);
  assert.equal(badType.data.error, 'invalid_entity_type');
});

test('odczyt zapisuje audit.viewed, ale zdarzenie nie wraca w historii obiektu (inna domena)', async () => {
  const t = await setup();
  const id = await payAndCorrect(t, 'key-board-history-0005');
  const path = `/api/audit/entity/payment_entry/${id}`;
  await t.call(t.sessions.board, path);
  const { rows } = await t.db.query(
    `SELECT actor_id FROM audit_events WHERE action = 'audit.viewed' AND entity_type = 'payment_entry' AND entity_id = $1`,
    [id],
  );
  assert.deepEqual(rows.map((r) => r.actor_id), ['u-bd']);
  const again = await t.call(t.sessions.board, path);
  assert.ok(again.data.events.length > 0);
  assertEvery(again.data.events, (e) => e.domain === 'finance');
});

test('historia kampanii e-mail: zarząd widzi swoją kampanię, tylko domena email', async () => {
  const t = await setup();
  const created = await t.call(t.sessions.treasurer, '/api/email/campaigns', {
    method: 'POST', key: 'key-board-campaign-0001',
    body: {
      schoolYearId: 'y-1', title: 'Przypomnienie jesienne', audience: 'all_households',
      subject: 'Dobrowolna składka {rok}', bodyText: 'Przypominamy o możliwości wniesienia dobrowolnej składki na rok {rok}. Tytuł przelewu: {rodzina}. Jeśli wpłata została już wykonana, prosimy pominąć wiadomość.',
    },
  });
  assert.equal(created.status, 201, created.text);
  const id = created.data.campaign.id;
  const history = await t.call(t.sessions.board, `/api/audit/entity/email_campaign/${id}`);
  assert.equal(history.status, 200, history.text);
  assert.ok(history.data.events.length > 0);
  assertEvery(history.data.events, (e) => e.domain === 'email');
  assert.doesNotMatch(history.text, /Przypomnienie jesienne|Dobrowolna/);
  assert.equal((await t.call(t.sessions.audit, `/api/audit/entity/email_campaign/${id}`)).status, 403);
  assert.equal((await t.call(t.sessions.treasurerYear2, `/api/audit/entity/email_campaign/${id}`)).status, 404);
});
