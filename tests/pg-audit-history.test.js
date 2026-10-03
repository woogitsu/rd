// #181: historia zdarzeń jednego obiektu i filtr domenowy dziennika audytu.
// Wariant zachowawczy: odczyt wyłącznie admin+MFA (jak reszta modułu admin) —
// D-08/D-09 nie ustaliły jeszcze ról zarządu/KR per domena.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { perTestDb, request, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { AUDIT_ACTION_CATALOG, AUDIT_DOMAINS, auditActionDomain } from '../shared/audit-actions.js';
import { assertEvery } from './helpers/assertions.js';

// #111: każdy test zakłada własną bazę w setup(); perTestDb() zamyka ją zaraz po teście.
const createDb = perTestDb();

async function call(env, path, { cookie, method = 'GET', body, key } = {}) {
  const headers = key ? { 'Idempotency-Key': key } : undefined;
  const response = await handlePgRequest(request(path, { method, cookie, body, headers }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function setup() {
  const db = await createDb();
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
  const { db, env, admin, treasurer } = await setup();
  await recordPayment(env, treasurer, 'key-payment-history-0003');
  // #214: zdarzenie z listy domyślnej (AUDIT_ACTIONS) — bez niego asercja o braku
  // akcji payment.* w liście domyślnej przechodziła na pustej liście.
  await db.query(`INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
    VALUES ('ae-default-1', 'u-admin', 'user.created', 'user', 'u-treasurer', '{}'::jsonb)`);
  const finance = await call(env, '/api/admin/audit?domain=finance', { cookie: admin });
  assert.equal(finance.status, 200);
  assert.ok(finance.data.events.length > 0);
  assertEvery(finance.data.events, (e) => e.domain === 'finance' && auditActionDomain(e.action) === 'finance');

  const bad = await call(env, '/api/admin/audit?domain=nope', { cookie: admin });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'invalid_domain');

  // Domyślnie (bez domain) — zachowanie sprzed #181: tylko akcje AUDIT_ACTIONS.
  const defaultList = await call(env, '/api/admin/audit', { cookie: admin });
  assert.equal(defaultList.status, 200);
  assert.ok(defaultList.data.events.some((e) => e.action === 'user.created'), 'lista domyślna zawiera akcje AUDIT_ACTIONS');
  assertEvery(defaultList.data.events, (e) => !e.action.startsWith('payment.'));
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
  assertEvery(byActor.data.events, (e) => e.actorId === 'u-treasurer');
  await call(env, '/api/admin/grants', {
    method: 'POST', cookie: admin, body: { userId: 'u-treasurer', role: 'board', schoolYearId: 'y-1' },
  });
  const byYear = await call(env, '/api/admin/audit?schoolYearId=y-1', { cookie: admin });
  assert.equal(byYear.status, 200);
  assert.ok(byYear.data.events.length > 0);
  // #174: payment.created niesie już schoolYearId — filtr roku działa w domenie finansów.
  const financeYear = await call(env, '/api/admin/audit?domain=finance&schoolYearId=y-1', { cookie: admin });
  assert.deepEqual(financeYear.data.events.map((e) => e.action), ['payment.created']);
  assert.equal(financeYear.data.events[0].metadata.schoolYearId, 'y-1');
});

test('#174: filtr roku przypisuje stare zdarzenia bez schoolYearId do roku obiektu, bez heurystyki dat', async () => {
  const { db, env, admin, treasurer } = await setup();
  await seedSchoolYear(db, 'y-2', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
  const own = await recordPayment(env, treasurer, 'key-payment-history-0005');
  const paymentId = own.data.payment.id;
  // Stare zdarzenia (sprzed dopisania roku do metadanych) — dziennik trwały, nie poprawiamy ich;
  // wstawione bezpośrednio, bo insertAuditEvent odrzuca dziś takie zdarzenie.
  const legacy = [
    ['lg-y1-pay', 'payment.correction.created', 'payment_entry', paymentId],
    ['lg-y1-year', 'report.audit.generated', 'school_year', 'y-1'],
    ['lg-y2-year', 'report.audit.generated', 'school_year', 'y-2'],
    ['lg-orphan', 'payment.created', 'payment_entry', 'p-nieistniejaca'],
  ];
  for (const [id, action, entityType, entityId] of legacy) {
    await db.query(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
       VALUES ($1, 'u-treasurer', $2, $3, $4, '{}'::jsonb)`, [id, action, entityType, entityId]);
  }
  const ids = async (query) => (await call(env, `/api/admin/audit?${query}`, { cookie: admin })).data.events.map((e) => e.id);
  const y1 = await ids('domain=finance&schoolYearId=y-1');
  const y2 = await ids('domain=finance&schoolYearId=y-2');
  assert.ok(y1.includes('lg-y1-pay') && y1.includes('lg-y1-year'), 'stare zdarzenia roku y-1');
  assert.ok(!y1.includes('lg-y2-year') && !y1.includes('lg-orphan'));
  assert.deepEqual(y2, ['lg-y2-year']);
  // Zdarzenie bez obiektu roku nie trafia do żadnego roku wg daty.
  await db.query(`INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
    VALUES ('lg-session', 'u-treasurer', 'session.revoked', 'session', 's-synthetic', '{}'::jsonb)`);
  assert.ok(!(await ids('schoolYearId=y-1')).includes('lg-session'));
  assert.ok((await ids('')).includes('lg-session'));
  // Zapisanych zdarzeń nie zmieniono.
  const { rows } = await db.query(`SELECT metadata_json FROM audit_events WHERE id = 'lg-y1-pay'`);
  assert.deepEqual(typeof rows[0].metadata_json === 'string' ? JSON.parse(rows[0].metadata_json) : rows[0].metadata_json, {});
});

async function insertLegacy(db, id, action, entityType, entityId, metadata = {}) {
  await db.query(
    `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
     VALUES ($1, 'u-treasurer', $2, $3, $4, $5::jsonb)`, [id, action, entityType, entityId, JSON.stringify(metadata)]);
}

test('granice ról: zarząd, skarbnik, przedstawiciel, KR i dyrekcja × każda domena → 403; admin → 200', async () => {
  const { db, env, admin, treasurer } = await setup();
  const created = await recordPayment(env, treasurer, 'key-payment-history-0101');
  const paymentId = created.data.payment.id;
  const others = {
    treasurer,
    board: await seedUserSession(db, { userId: 'u-board', roles: [{ role: 'board', schoolYearId: 'y-1' }], mfa: true }),
    representative: await seedUserSession(db, {
      userId: 'u-rep', roles: [{ role: 'representative', schoolYearId: 'y-1', classId: 'c-1' }], mfa: true,
    }),
    audit: await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit', schoolYearId: 'y-1' }], mfa: true }),
    principal: await seedUserSession(db, { userId: 'u-principal', roles: [{ role: 'principal' }], mfa: true }),
  };
  for (const domain of Object.keys(AUDIT_DOMAINS)) {
    assert.equal((await call(env, `/api/admin/audit?domain=${domain}`, { cookie: admin })).status, 200, `admin × ${domain}`);
    for (const [role, cookie] of Object.entries(others)) {
      assert.equal((await call(env, `/api/admin/audit?domain=${domain}`, { cookie })).status, 403, `${role} × ${domain}`);
    }
  }
  for (const [role, cookie] of Object.entries(others)) {
    assert.equal((await call(env, '/api/admin/audit', { cookie })).status, 403, `${role} × widok domyślny`);
    assert.equal((await call(env, `/api/admin/audit/entity/payment_entry/${paymentId}`, { cookie })).status, 403, `${role} × historia`);
  }
});

test('każda domena zwraca wyłącznie swoje akcje; finance obejmuje tytuły, dane do wpłat, kategorie i sprawozdania', async () => {
  const { db, env, admin } = await setup();
  // Po jednym syntetycznym wierszu dla każdej akcji słownika (bez aktora-człowieka w metadanych).
  let n = 0;
  for (const action of Object.keys(AUDIT_ACTION_CATALOG)) {
    n += 1;
    await insertLegacy(db, `cat-${String(n).padStart(3, '0')}`, action, 'school_year', 'y-1', { schoolYearId: 'y-1' });
  }
  const seen = new Set();
  for (const domain of Object.keys(AUDIT_DOMAINS)) {
    const result = await call(env, `/api/admin/audit?domain=${domain}&limit=500`, { cookie: admin });
    assert.equal(result.status, 200);
    for (const event of result.data.events) {
      if (event.action === 'audit.viewed' && event.entityType === 'audit_log') continue; // ślad samego odczytu
      assert.equal(event.domain, domain, `${event.action} w domenie ${domain}`);
      seen.add(event.action);
    }
  }
  // Żadna akcja nie wypada z filtra domen (dawniej: przedrostki bez payment_reference. itd.).
  assert.deepEqual(Object.keys(AUDIT_ACTION_CATALOG).filter((action) => !seen.has(action)), []);
  const finance = (await call(env, '/api/admin/audit?domain=finance&limit=500', { cookie: admin })).data.events.map((e) => e.action);
  for (const action of ['payment_reference.generated', 'payment_instructions.approved', 'ledger_category.copied',
    'report.snapshot.approved', 'report.annual.generated']) assert.ok(finance.includes(action), action);
  assert.ok(!finance.includes('email.sent') && !finance.includes('year_close.closed'));
});

test('widok nie ujawnia wolnego tekstu ani danych osobowych z metadanych (także starych wierszy)', async () => {
  const { db, env, admin, treasurer } = await setup();
  const created = await recordPayment(env, treasurer, 'key-payment-history-0102');
  const paymentId = created.data.payment.id;
  // Stary wiersz sprzed #184 z wolnym tekstem i danymi osobowymi w metadanych.
  await insertLegacy(db, 'lg-pii', 'payment.correction.created', 'payment_correction', 'pc-legacy', {
    schoolYearId: 'y-1', paymentEntryId: paymentId, amountCents: 500,
    reason: 'Rodzina Przykładowa zapłaciła gotówką', note: 'Kontakt: rodzic', displayName: 'Anna Przykład',
    guardianEmail: 'rodzic@example.invalid', nested: { comment: 'x', ids: ['pc-1', 'wolny tekst'] },
  });
  for (const path of ['/api/admin/audit?domain=finance', `/api/admin/audit/entity/payment_entry/${paymentId}`]) {
    const result = await call(env, path, { cookie: admin });
    assert.equal(result.status, 200);
    const event = result.data.events.find((e) => e.id === 'lg-pii');
    assert.ok(event, path);
    assert.deepEqual(event.metadata, { schoolYearId: 'y-1', paymentEntryId: paymentId, amountCents: 500, nested: { ids: ['pc-1'] } });
    assert.deepEqual(event.redactedFields.sort(),
      ['displayName', 'guardianEmail', 'nested.comment', 'nested.ids[1]', 'note', 'reason'].sort());
    const text = JSON.stringify(result.data);
    assert.doesNotMatch(text, /@|Przykład|Kontakt|gotówką|wolny tekst/);
  }
});

test('historia wpłaty: kilka korekt w kolejności, podwójne kliknięcie daje jedno zdarzenie', async () => {
  const { env, admin, treasurer } = await setup();
  const created = await recordPayment(env, treasurer, 'key-payment-history-0103');
  const replay = await recordPayment(env, treasurer, 'key-payment-history-0103');
  assert.equal(replay.data.payment.id, created.data.payment.id);
  const paymentId = created.data.payment.id;
  for (const [index, amountCents] of [[1, 500], [2, 200]]) {
    const corrected = await call(env, `/api/payments/${paymentId}/corrections`, {
      method: 'POST', cookie: treasurer, key: `key-correction-010${index}`,
      body: { amountCents, reason: `Korekta numer ${index}` },
    });
    assert.equal(corrected.status, 201, JSON.stringify(corrected.data));
  }
  const history = await call(env, `/api/admin/audit/entity/payment_entry/${paymentId}`, { cookie: admin });
  assert.deepEqual(history.data.events.map((e) => e.action),
    ['payment.created', 'payment.correction.created', 'payment.correction.created']);
  assert.deepEqual(history.data.events.map((e) => e.domain), ['finance', 'finance', 'finance']);
  assert.doesNotMatch(JSON.stringify(history.data), /Korekta numer/);
});

test('historia uzgodnienia obejmuje zdarzenia zapisane jako bank_reconciliation', async () => {
  const { env, admin, treasurer } = await setup();
  const created = await call(env, '/api/reconciliations', {
    method: 'POST', cookie: treasurer, key: 'key-reconciliation-0101',
    body: { schoolYearId: 'y-1', statementDate: '2026-09-30', statementBalanceCents: 0 },
  });
  assert.equal(created.status, 201);
  const id = created.data.reconciliation.id;
  const history = await call(env, `/api/admin/audit/entity/reconciliation/${id}`, { cookie: admin });
  assert.equal(history.status, 200);
  assert.deepEqual(history.data.events.map((e) => e.action), ['reconciliation.created']);
});
