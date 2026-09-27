// API wpłat na PostgreSQL (issue #37). Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { hashSecret } from '../src/auth.js';
import { handlePgRequest, ROUTES } from '../src/pg/app.js';
import * as paymentsRoutes from '../src/pg/routes/payments.js';
import { createTestDb, seedSchoolYear, seedUserSession } from './helpers/pg.js';
import { createLegacyDb, createNormalizer, d1Adapter } from './helpers/parity.js';

const BASE = 'https://rd.example';
const DEBT_WORDS = /debt|due|owed|owing|outstanding|arrear|balance|receivable|d[lł]u[zż]n|zaleg|nale[zż]/i;

// --- Budowanie żądań ------------------------------------------------------

function call(cookie, path, { method, body, key, origin = BASE, contentType = 'application/json', rawBody } = {}) {
  const upper = method ?? (body !== undefined || rawBody !== undefined ? 'POST' : 'GET');
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (upper !== 'GET' && origin) headers.set('Origin', origin);
  if (key) headers.set('Idempotency-Key', key);
  if (contentType && upper !== 'GET') headers.set('Content-Type', contentType);
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Request(`${BASE}${path}`, { method: upper, headers, body: payload });
}

async function read(response) {
  const text = await response.text();
  return {
    status: response.status,
    replayed: response.headers.get('Idempotency-Replayed'),
    cacheControl: response.headers.get('Cache-Control'),
    body: text ? JSON.parse(text) : null,
  };
}

// --- Backend PostgreSQL ----------------------------------------------------

async function pgBackend({ role = 'treasurer', mfa = true, schoolYearId = 'y2026', classId } = {}) {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y2025', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, 'y2026');
  await db.query("INSERT INTO households (id) VALUES ('h1'), ('h2'), ('h3')");
  const cookie = await seedUserSession(db, {
    userId: 'u1', mfa, roles: [{ role, schoolYearId, classId }],
  });
  const env = { db };
  return {
    kind: 'pg', db, env, cookie,
    fetch: (req) => handlePgRequest(req, env),
    as: async (userId, options) => seedUserSession(db, { userId, ...options }),
    count: async (table, where = 'TRUE') => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n),
    close: () => db.close(),
  };
}

// --- Stary Worker/D1 (kontrakt referencyjny) --------------------------------

const legacyToken = 'P'.repeat(43);

async function legacyBackend() {
  const db = createLegacyDb(['0001_initial', '0002_auth_sessions', '0003_student_guardians',
    '0004_enrollment_school_year', '0005_payment_corrections', '0006_payment_assignments']);
  db.exec(`
    INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
      ('y2025', 'test y2025', '2025-09-01', '2026-08-31'),
      ('y2026', 'test y2026', '2026-09-01', '2027-08-31');
    INSERT INTO households (id) VALUES ('h1'), ('h2'), ('h3');
    INSERT INTO users (id, email, display_name) VALUES ('u1', 'u1@example.invalid', 'Test u1');
    INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ('rg1', 'u1', 'treasurer', 'y2026');
  `);
  db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, mfa_verified_at)
              VALUES ('s1', 'u1', ?, '2099-01-01T00:00:00Z', '2026-09-27T00:00:00Z')`)
    .run(await hashSecret(legacyToken));
  const env = { DB: d1Adapter(db) };
  return {
    kind: 'legacy', db, cookie: `rd_session=${legacyToken}`,
    fetch: (req) => worker.fetch(req, env),
    close: () => db.close(),
  };
}

// --- Scenariusz zgodności ---------------------------------------------------

// Losowe identyfikatory -> etykiety, kursor dekodowany (tests/helpers/parity.js).
const normalizer = () => createNormalizer({ cursorKeys: ['nextCursor'] });

const paymentInput = {
  householdId: 'h1', schoolYearId: 'y2026', amountCents: 7500,
  receivedOn: '2026-09-20', method: 'bank', reference: 'synthetic-reference',
};

async function runContractScenario(backend) {
  const normalize = normalizer();
  const steps = [];
  const cookie = backend.cookie;
  const step = async (label, req) => {
    const result = await read(await backend.fetch(req));
    steps.push({ label, ...result, body: normalize(result.body) });
    return result.body;
  };

  const p1 = (await step('create', call(cookie, '/api/payments', { body: paymentInput, key: 'pay-key-0001' }))).payment.id;
  await step('create retry', call(cookie, '/api/payments', { body: paymentInput, key: 'pay-key-0001' }));
  await step('create conflict', call(cookie, '/api/payments', { body: { ...paymentInput, amountCents: 7600 }, key: 'pay-key-0001' }));
  const p2 = (await step('create unmatched', call(cookie, '/api/payments', {
    body: { ...paymentInput, householdId: null, amountCents: 3000, receivedOn: '2026-09-21', method: 'cash', reference: null },
    key: 'pay-key-0002',
  }))).payment.id;
  await step('create partial', call(cookie, '/api/payments', {
    body: { ...paymentInput, amountCents: 2000, receivedOn: '2026-09-22', reference: '  trimmed  ' }, key: 'pay-key-0003',
  }));
  await step('create unknown household', call(cookie, '/api/payments', { body: { ...paymentInput, householdId: 'h-missing' }, key: 'pay-key-0004' }));
  await step('create other year', call(cookie, '/api/payments', { body: { ...paymentInput, schoolYearId: 'y2025' }, key: 'pay-key-0005' }));
  await step('create unknown year', call(cookie, '/api/payments', { body: { ...paymentInput, schoolYearId: 'y-missing' }, key: 'pay-key-0006' }));
  await step('create no session', call(null, '/api/payments', { body: paymentInput, key: 'pay-key-0007' }));
  await step('create foreign origin', call(cookie, '/api/payments', { body: paymentInput, key: 'pay-key-0008', origin: 'https://evil.example' }));
  await step('create no origin', call(cookie, '/api/payments', { body: paymentInput, key: 'pay-key-0009', origin: null }));
  await step('create short key', call(cookie, '/api/payments', { body: paymentInput, key: 'short' }));
  await step('create no key', call(cookie, '/api/payments', { body: paymentInput }));
  await step('create text/plain', call(cookie, '/api/payments', { body: paymentInput, key: 'pay-key-0010', contentType: 'text/plain' }));
  await step('create bad json', call(cookie, '/api/payments', { rawBody: '{', key: 'pay-key-0011' }));
  await step('create array json', call(cookie, '/api/payments', { rawBody: '[]', key: 'pay-key-0012' }));
  await step('create too large', call(cookie, '/api/payments', { rawBody: JSON.stringify({ x: 'a'.repeat(17000) }), key: 'pay-key-0013' }));
  for (const [label, patch] of [
    ['zero amount', { amountCents: 0 }], ['fraction amount', { amountCents: 1.5 }], ['string amount', { amountCents: '75' }],
    ['huge amount', { amountCents: 100_000_001 }], ['bad date', { receivedOn: '2026-02-30' }], ['bad method', { method: 'card' }],
    ['bad household', { householdId: 'bad id' }], ['bad reference', { reference: 42 }], ['long reference', { reference: 'r'.repeat(201) }],
  ]) {
    await step(`create ${label}`, call(cookie, '/api/payments', { body: { ...paymentInput, ...patch }, key: `pay-key-v-${label.replace(' ', '-')}` }));
  }

  const correctionPath = `/api/payments/${p1}/corrections`;
  const correction = { amountCents: 2500, reason: 'Testowa korekta częściowa' };
  await step('correct', call(cookie, correctionPath, { body: correction, key: 'corr-key-0001' }));
  await step('correct retry', call(cookie, correctionPath, { body: correction, key: 'corr-key-0001' }));
  await step('correct conflict', call(cookie, correctionPath, { body: { ...correction, reason: 'Inny powód' }, key: 'corr-key-0001' }));
  await step('correct excessive', call(cookie, correctionPath, { body: { amountCents: 5001, reason: 'Za dużo' }, key: 'corr-key-0002' }));
  await step('correct rest', call(cookie, correctionPath, { body: { amountCents: 5000, reason: 'Reszta kwoty' }, key: 'corr-key-0003' }));
  await step('correct beyond zero', call(cookie, correctionPath, { body: { amountCents: 1, reason: 'Jeszcze jeden' }, key: 'corr-key-0004' }));
  await step('correct missing payment', call(cookie, '/api/payments/missing-id/corrections', { body: correction, key: 'corr-key-0005' }));
  await step('correct bad path', call(cookie, '/api/payments/%E0/corrections', { body: correction, key: 'corr-key-0006' }));
  await step('correct invalid id', call(cookie, '/api/payments/-bad/corrections', { body: correction, key: 'corr-key-0007' }));
  await step('correct short reason', call(cookie, correctionPath, { body: { amountCents: 1, reason: 'ab' }, key: 'corr-key-0008' }));
  await step('correct no reason', call(cookie, correctionPath, { body: { amountCents: 1 }, key: 'corr-key-0009' }));
  await step('correct bad amount', call(cookie, correctionPath, { body: { amountCents: -1, reason: 'Ujemna' }, key: 'corr-key-0010' }));
  await step('correct no session', call(null, correctionPath, { body: correction, key: 'corr-key-0011' }));

  const assignmentPath = `/api/payments/${p2}/assignment`;
  await step('assign', call(cookie, assignmentPath, { body: { householdId: 'h2' }, key: 'assign-key-0001' }));
  await step('assign retry', call(cookie, assignmentPath, { body: { householdId: 'h2' }, key: 'assign-key-0001' }));
  await step('assign same key other household', call(cookie, assignmentPath, { body: { householdId: 'h3' }, key: 'assign-key-0001' }));
  await step('assign again', call(cookie, assignmentPath, { body: { householdId: 'h1' }, key: 'assign-key-0002' }));
  await step('assign recorded payment', call(cookie, `/api/payments/${p1}/assignment`, { body: { householdId: 'h2' }, key: 'assign-key-0003' }));
  await step('assign missing payment', call(cookie, '/api/payments/missing-id/assignment', { body: { householdId: 'h2' }, key: 'assign-key-0004' }));
  await step('assign bad household', call(cookie, assignmentPath, { body: { householdId: '' }, key: 'assign-key-0005' }));
  const p4 = (await step('create unmatched 2', call(cookie, '/api/payments', {
    body: { ...paymentInput, householdId: null, amountCents: 1000, receivedOn: '2026-09-23' }, key: 'pay-key-0020',
  }))).payment.id;
  await step('assign unknown household', call(cookie, `/api/payments/${p4}/assignment`, { body: { householdId: 'h-missing' }, key: 'assign-key-0006' }));
  await step('correct unmatched', call(cookie, `/api/payments/${p4}/corrections`, { body: { amountCents: 100, reason: 'Korekta nierozpoznanej' }, key: 'corr-key-0020' }));

  const pageOne = await step('list recorded page 1', call(cookie, '/api/payments?schoolYearId=y2026&status=recorded&limit=2'));
  await step('list recorded page 2', call(cookie, `/api/payments?schoolYearId=y2026&status=recorded&limit=2&cursor=${pageOne.nextCursor}`));
  await step('list unmatched', call(cookie, '/api/payments?schoolYearId=y2026&status=unmatched'));
  await step('list all', call(cookie, '/api/payments?schoolYearId=y2026'));
  await step('list other year', call(cookie, '/api/payments?schoolYearId=y2025'));
  await step('list no year', call(cookie, '/api/payments'));
  await step('list bad status', call(cookie, '/api/payments?schoolYearId=y2026&status=reversed'));
  for (const limit of ['0', '101', 'abc', '1000']) {
    await step(`list limit ${limit}`, call(cookie, `/api/payments?schoolYearId=y2026&limit=${limit}`));
  }
  await step('list bad cursor', call(cookie, '/api/payments?schoolYearId=y2026&cursor=not-a-cursor'));
  await step('list bad cursor json', call(cookie, `/api/payments?schoolYearId=y2026&cursor=${btoa('[1,2]')}`));
  await step('list no session', call(null, '/api/payments?schoolYearId=y2026'));
  await step('put not found', call(cookie, '/api/payments', { method: 'PUT', body: paymentInput, key: 'pay-key-0030' }));
  await step('get corrections not found', call(cookie, correctionPath));
  return steps;
}

test('PostgreSQL API matches the legacy Worker contract step by step', async () => {
  const legacy = await legacyBackend();
  const pg = await pgBackend();
  try {
    const expected = await runContractScenario(legacy);
    const actual = await runContractScenario(pg);
    assert.equal(actual.length, expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      assert.deepEqual(actual[index], expected[index], `step: ${expected[index].label}`);
    }
    // Scenariusz obejmuje sukcesy i odmowy, nie same błędy.
    assert.ok(expected.some((s) => s.status === 201) && expected.some((s) => s.status === 409));
    assert.equal(await pg.count('payment_entries'), 4);
    assert.equal(await pg.count('payment_corrections'), 3);
    assert.equal(await pg.count('payment_assignments'), 1);
  } finally {
    legacy.close();
    await pg.close();
  }
});

// --- Scenariusze PostgreSQL -------------------------------------------------

async function withPg(options, fn) {
  const backend = await pgBackend(options);
  try { return await fn(backend); } finally { await backend.close(); }
}

async function createPayment(backend, patch = {}, key = `pay-${crypto.randomUUID()}`, cookie = backend.cookie) {
  const result = await read(await backend.fetch(call(cookie, '/api/payments', { body: { ...paymentInput, ...patch }, key })));
  return result;
}

test('double click with the same Idempotency-Key creates one payment and one audit event', async () => withPg({}, async (backend) => {
  const [first, second] = await Promise.all([
    createPayment(backend, {}, 'double-click-0001'),
    createPayment(backend, {}, 'double-click-0001'),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(first.body.payment.id, second.body.payment.id);
  assert.deepEqual([first.replayed, second.replayed].sort(), ['false', 'true']);
  const third = await createPayment(backend, {}, 'double-click-0001');
  assert.equal(third.status, 200);
  assert.equal(third.body.payment.id, first.body.payment.id);
  assert.equal(await backend.count('payment_entries'), 1);
  assert.equal(await backend.count('audit_events', "action = 'payment.created'"), 1);

  const conflict = await createPayment(backend, { reference: 'other' }, 'double-click-0001');
  assert.deepEqual([conflict.status, conflict.body], [409, { error: 'idempotency_conflict' }]);

  // Ten sam klucz innej osoby finansowej też jest konfliktem, nie odtworzeniem cudzego zapisu.
  const other = await backend.as('u2', { mfa: true, roles: [{ role: 'board' }] });
  const foreignReplay = await createPayment(backend, {}, 'double-click-0001', other);
  assert.deepEqual([foreignReplay.status, foreignReplay.body], [409, { error: 'idempotency_conflict' }]);
  assert.equal(await backend.count('payment_entries'), 1);
}));

test('parallel corrections are serialized and never exceed the payment amount', async () => withPg({}, async (backend) => {
  const payment = (await createPayment(backend, { amountCents: 10000 })).body.payment;
  const path = `/api/payments/${payment.id}/corrections`;
  const results = await Promise.all([1, 2, 3].map((n) => backend.fetch(call(backend.cookie, path, {
    body: { amountCents: 4000, reason: `Równoległa korekta ${n}` }, key: `parallel-corr-000${n}`,
  })).then(read)));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 201, 409]);
  assert.deepEqual(results.find((r) => r.status === 409).body, { error: 'correction_exceeds_remaining_amount' });
  const net = (await backend.db.query('SELECT corrected_cents, net_amount_cents FROM payment_entry_net WHERE id = $1', [payment.id])).rows[0];
  assert.equal(Number(net.corrected_cents), 8000);
  assert.equal(Number(net.net_amount_cents), 2000);
  assert.equal(await backend.count('audit_events', "action = 'payment.correction.created'"), 2);

  // Parallel retries of one correction with the same key: one row, one replay.
  const retryPath = path;
  const same = await Promise.all([0, 1].map(() => backend.fetch(call(backend.cookie, retryPath, {
    body: { amountCents: 2000, reason: 'Ostatnia korekta' }, key: 'parallel-corr-same',
  })).then(read)));
  assert.deepEqual(same.map((r) => r.status).sort(), [200, 201]);
  assert.equal(same[0].body.correction.id, same[1].body.correction.id);
  assert.equal(await backend.count('payment_corrections'), 3);

  // Baza sama też odrzuca nadmierną korektę (trigger z 0002_payments.sql).
  await assert.rejects(backend.db.query(
    `INSERT INTO payment_corrections (id, payment_entry_id, amount_cents, reason, created_by, idempotency_key)
     VALUES ('direct', $1, 1, 'Bezpośrednio', 'u1', 'direct-key-0001')`, [payment.id],
  ), /payment_correction_exceeds_remaining_amount/);
  // Historia jest niezmienna.
  await assert.rejects(backend.db.query('DELETE FROM payment_corrections'), /cannot_be_changed/);
  await assert.rejects(backend.db.query('UPDATE payment_entries SET amount_cents = 1'), /immutable/);
}));

test('an unmatched payment can be assigned only once, also in parallel', async () => withPg({}, async (backend) => {
  const payment = (await createPayment(backend, { householdId: null })).body.payment;
  assert.equal(payment.status, 'unmatched');
  const path = `/api/payments/${payment.id}/assignment`;
  const results = await Promise.all([['h1', 'assign-par-0001'], ['h2', 'assign-par-0002']].map(([householdId, key]) =>
    backend.fetch(call(backend.cookie, path, { body: { householdId }, key })).then(read)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.deepEqual(results.find((r) => r.status === 409).body, { error: 'payment_already_assigned' });
  const winner = results.find((r) => r.status === 201).body.assignment.householdId;
  const row = (await backend.db.query('SELECT household_id, status FROM payment_entries WHERE id = $1', [payment.id])).rows[0];
  assert.deepEqual(row, { household_id: winner, status: 'recorded' });

  const again = await read(await backend.fetch(call(backend.cookie, path, { body: { householdId: 'h3' }, key: 'assign-par-0003' })));
  assert.deepEqual([again.status, again.body], [409, { error: 'payment_already_assigned' }]);
  assert.equal(await backend.count('payment_assignments'), 1);
  assert.equal(await backend.count('audit_events', "action = 'payment.assigned'"), 1);
  await assert.rejects(backend.db.query("UPDATE payment_entries SET household_id = 'h3'"), /payment_assignment_event_required/);
}));

test('representative, audit and principal roles are refused on every payment route', async () => {
  const roles = [
    { role: 'representative', classId: 'c-1a', schoolYearId: 'y2026' },
    { role: 'audit', schoolYearId: 'y2026' },
    { role: 'principal' },
  ];
  for (const grant of roles) {
    await withPg({}, async (backend) => {
      const payment = (await createPayment(backend, { householdId: null })).body.payment;
      const cookie = await backend.as(`u-${grant.role}`, { mfa: true, roles: [grant] });
      const responses = [
        call(cookie, '/api/payments?schoolYearId=y2026'),
        call(cookie, '/api/payments', { body: paymentInput, key: 'role-key-0001' }),
        call(cookie, `/api/payments/${payment.id}/corrections`, { body: { amountCents: 1, reason: 'Próba roli' }, key: 'role-key-0002' }),
        call(cookie, `/api/payments/${payment.id}/assignment`, { body: { householdId: 'h1' }, key: 'role-key-0003' }),
      ];
      for (const req of responses) {
        const result = await read(await backend.fetch(req));
        assert.deepEqual([result.status, result.body], [403, { error: 'forbidden' }], `${grant.role} ${req.method} ${req.url}`);
      }
      assert.equal(await backend.count('payment_entries'), 1);
      assert.equal(await backend.count('payment_corrections'), 0);
      assert.equal(await backend.count('payment_assignments'), 0);
    });
  }
});

test('board and admin with MFA may record payments; a year-scoped grant cannot touch another year', async () => withPg({}, async (backend) => {
  for (const role of ['board', 'admin']) {
    const cookie = await backend.as(`u-${role}`, { mfa: true, roles: [{ role }] });
    const result = await createPayment(backend, { schoolYearId: 'y2025', receivedOn: '2025-10-01' }, `role-${role}-0001`, cookie);
    assert.equal(result.status, 201, role);
  }
  const old = (await createPayment(backend, { householdId: null, schoolYearId: 'y2025' }, 'old-year-0001',
    await backend.as('u-admin2', { mfa: true, roles: [{ role: 'admin' }] }))).body.payment;
  // u1 ma rolę skarbnika tylko w y2026.
  for (const req of [
    call(backend.cookie, '/api/payments?schoolYearId=y2025'),
    call(backend.cookie, '/api/payments', { body: { ...paymentInput, schoolYearId: 'y2025' }, key: 'year-key-0001' }),
    call(backend.cookie, `/api/payments/${old.id}/corrections`, { body: { amountCents: 1, reason: 'Inny rok' }, key: 'year-key-0002' }),
    call(backend.cookie, `/api/payments/${old.id}/assignment`, { body: { householdId: 'h1' }, key: 'year-key-0003' }),
  ]) {
    const result = await read(await backend.fetch(req));
    assert.deepEqual([result.status, result.body], [403, { error: 'forbidden' }], req.url);
  }
  assert.equal(await backend.count('payment_corrections'), 0);
  assert.equal(await backend.count('payment_assignments'), 0);
}));

test('missing MFA, expired grant, no session and cross-origin writes are refused without writes', async () => withPg({ mfa: false }, async (backend) => {
  const admin = await backend.as('u-admin', { mfa: true, roles: [{ role: 'admin' }] });
  const payment = (await createPayment(backend, { householdId: null }, 'setup-key-0001', admin)).body.payment;
  const expired = await backend.as('u-expired', { mfa: true, roles: [{ role: 'treasurer', expiresAt: new Date(Date.now() - 1000) }] });
  const targets = [
    ['/api/payments', paymentInput],
    [`/api/payments/${payment.id}/corrections`, { amountCents: 1, reason: 'Bez MFA' }],
    [`/api/payments/${payment.id}/assignment`, { householdId: 'h1' }],
  ];
  for (const [path, body] of targets) {
    for (const [cookie, status, error] of [[backend.cookie, 403, 'forbidden'], [expired, 403, 'forbidden'], [null, 401, 'unauthenticated']]) {
      const result = await read(await backend.fetch(call(cookie, path, { body, key: 'mfa-key-0001' })));
      assert.deepEqual([result.status, result.body], [status, { error }], path);
    }
    for (const origin of ['https://evil.example', null, 'http://rd.example']) {
      const result = await read(await backend.fetch(call(admin, path, { body, key: 'origin-key-0001', origin })));
      assert.deepEqual([result.status, result.body], [403, { error: 'invalid_origin' }], `${path} ${origin}`);
    }
  }
  const list = await read(await backend.fetch(call(backend.cookie, '/api/payments?schoolYearId=y2026')));
  assert.equal(list.status, 403);
  assert.equal(await backend.count('payment_entries'), 1);
  assert.equal(await backend.count('payment_corrections'), 0);
  assert.equal(await backend.count('payment_assignments'), 0);
  // Moduł sam też odrzuca obce Origin, gdyby został użyty poza handlePgRequest.
  const direct = await paymentsRoutes.handle(call(admin, '/api/payments', { body: paymentInput, key: 'origin-key-0002', origin: 'https://evil.example' }),
    backend.env, new URL(`${BASE}/api/payments`), (data, status) => new Response(JSON.stringify(data), { status }));
  assert.equal(direct.status, 403);
}));

test('partial payments, siblings and two guardians sum per household without any debt field', async () => withPg({}, async (backend) => {
  // Rodzina h1: dwoje rodzeństwa, dwie osoby opiekujące się; dane syntetyczne.
  await backend.db.exec(`
    INSERT INTO guardians (id, household_id, first_name, last_name) VALUES
      ('g1', 'h1', 'Opiekun', 'Testowy'), ('g2', 'h1', 'Opiekunka', 'Testowa');
    INSERT INTO students (id, household_id, first_name, last_name) VALUES
      ('s1', 'h1', 'Dziecko', 'Pierwsze'), ('s2', 'h1', 'Dziecko', 'Drugie');
    INSERT INTO student_guardians (student_id, guardian_id) VALUES ('s1','g1'), ('s1','g2'), ('s2','g1'), ('s2','g2');
  `);
  // Dwie wpłaty częściowe (np. od każdej z osób opiekujących się) i jedna korekta.
  const first = (await createPayment(backend, { amountCents: 2000, receivedOn: '2026-09-10' })).body.payment;
  await createPayment(backend, { amountCents: 1500, receivedOn: '2026-09-11', method: 'cash', reference: null });
  await createPayment(backend, { householdId: 'h2', amountCents: 5000, receivedOn: '2026-09-12' });
  const unmatched = (await createPayment(backend, { householdId: null, amountCents: 999, receivedOn: '2026-09-13' })).body.payment;
  await backend.fetch(call(backend.cookie, `/api/payments/${first.id}/corrections`, { body: { amountCents: 500, reason: 'Zwrot części' }, key: 'sibling-corr-0001' }));

  const totals = (await backend.db.query(
    "SELECT household_id, net_amount_cents, payment_count FROM household_payment_totals WHERE school_year_id = 'y2026' ORDER BY household_id",
  )).rows.map((row) => ({ household: row.household_id, net: paymentsRoutes.toSafeInteger(row.net_amount_cents), count: paymentsRoutes.toSafeInteger(row.payment_count) }));
  assert.deepEqual(totals, [{ household: 'h1', net: 3000, count: 2 }, { household: 'h2', net: 5000, count: 1 }]);

  const list = await read(await backend.fetch(call(backend.cookie, '/api/payments?schoolYearId=y2026')));
  assert.equal(list.status, 200);
  assert.equal(list.cacheControl, 'no-store');
  const h1 = list.body.payments.filter((p) => p.householdId === 'h1');
  assert.deepEqual(h1.map((p) => [p.amountCents, p.correctedCents, p.netAmountCents]), [[1500, 0, 1500], [2000, 500, 1500]]);
  assert.ok(list.body.payments.every((p) => Number.isSafeInteger(p.correctedCents) && typeof p.netAmountCents === 'number'));
  assert.deepEqual(Object.keys(list.body.payments[0]).sort(),
    ['amountCents', 'correctedCents', 'householdId', 'id', 'method', 'netAmountCents', 'receivedOn', 'reference', 'schoolYearId', 'status']);
  assert.equal(list.body.payments.find((p) => p.id === unmatched.id).status, 'unmatched');
  const keys = JSON.stringify(list.body).match(/"[A-Za-z_]+":/g);
  assert.ok(!keys.some((key) => DEBT_WORDS.test(key)), 'no debt-like fields');
}));

test('audit events are atomic with the write and carry no amounts, references or family data', async () => withPg({}, async (backend) => {
  const payment = (await createPayment(backend, { householdId: null, reference: 'REF-SYNTH-123', amountCents: 4321 })).body.payment;
  await backend.fetch(call(backend.cookie, `/api/payments/${payment.id}/corrections`, { body: { amountCents: 321, reason: 'Powód syntetyczny' }, key: 'audit-corr-0001' }));
  await backend.fetch(call(backend.cookie, `/api/payments/${payment.id}/assignment`, { body: { householdId: 'h3' }, key: 'audit-assign-0001' }));
  const events = (await backend.db.query(
    "SELECT actor_id, action, entity_type, metadata_json FROM audit_events WHERE action LIKE 'payment.%' ORDER BY occurred_at, action",
  )).rows;
  assert.deepEqual(events.map((e) => [e.actor_id, e.action, e.entity_type]), [
    ['u1', 'payment.created', 'payment_entry'],
    ['u1', 'payment.correction.created', 'payment_correction'],
    ['u1', 'payment.assigned', 'payment_assignment'],
  ]);
  // Identyfikator wpłaty (losowy UUID) usuwamy przed szukaniem ciągów — w zapisie szesnastkowym może zawierać np. „321”.
  const metadata = JSON.stringify(events.map((e) => e.metadata_json)).replaceAll(payment.id, '<payment-id>');
  for (const secret of ['REF-SYNTH-123', '4321', '321', 'h3', 'Powód']) assert.ok(!metadata.includes(secret), secret);
  assert.deepEqual(events[0].metadata_json, {});
  assert.deepEqual(events[2].metadata_json, { paymentEntryId: payment.id });

  // Gdy zapis audytu zawiedzie, wpłata nie powstaje (jedna transakcja).
  await backend.db.exec(`
    CREATE FUNCTION fail_payment_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'payment.created' THEN RAISE EXCEPTION 'audit_down'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_payment_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_payment_audit();
  `);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const failed = await createPayment(backend, {}, 'audit-fail-0001');
    assert.deepEqual([failed.status, failed.body], [503, { error: 'service_unavailable' }]);
  } finally {
    console.error = original;
  }
  assert.ok(errors.every((line) => !line.includes('synthetic-reference') && !line.includes('@')));
  assert.equal(await backend.count('payment_entries', "idempotency_key = 'audit-fail-0001'"), 0);
}));

test('BIGINT aggregates are converted only when safe; route is registered once', () => {
  assert.equal(paymentsRoutes.toSafeInteger('9007199254740991'), Number.MAX_SAFE_INTEGER);
  assert.equal(paymentsRoutes.toSafeInteger(null), 0);
  assert.equal(paymentsRoutes.toSafeInteger(12n), 12);
  assert.throws(() => paymentsRoutes.toSafeInteger('9007199254740993'), /unsafe_integer/);
  assert.throws(() => paymentsRoutes.toSafeInteger('1.5'), /unsafe_integer/);
  assert.equal(ROUTES.filter((route) => route.name === 'payments').length, 1);
});
