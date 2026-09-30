// API księgi na PostgreSQL (issue #38). Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSecret } from '../src/auth.js';
import { handlePgRequest, ROUTES } from '../src/pg/app.js';
import * as ledgerRoutes from '../src/pg/routes/ledger.js';
import { unzipSync, strFromU8 } from 'fflate';
import { buildLedgerUrl, buildOverviewUrl, normalizeEntry } from '../ledger/core.js';
import { assertEvery } from './helpers/assertions.js';
import { createTestDb, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const BASE = 'https://rd.example';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

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

// Wspólne dane syntetyczne obu backendów. `active` różni się typem (0/1 vs boolean).
// #87: w PostgreSQL dowodem może być wyłącznie dokument finansowy z API tego
// samego roku, więc 'd1' jest tam takim dokumentem; w D1 zostaje wiersz jak dawniej.
const PG_SOURCE_DOCUMENT_SQL = `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by,
      school_year_id, sha256, idempotency_key)
      VALUES ('d1', 'docs/00000000-0000-4000-8000-00000000d001', 'application/pdf', 1200, 'financial', 'u1',
        'y2026', '${'a'.repeat(64)}', 'seed-document-0001');`;
const LEGACY_SOURCE_DOCUMENT_SQL = `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by)
      VALUES ('d1', 'synthetic/source.pdf', 'application/pdf', 1200, 'receipt', 'u1');`;

function seedSql(falseValue, documentSql = LEGACY_SOURCE_DOCUMENT_SQL) {
  return `
    INSERT INTO households (id) VALUES ('h1'), ('h2');
    ${documentSql}
    INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by, active) VALUES
      ('income-other', 'y2026', 'income', 'Inne przychody', 'u1', NOT ${falseValue}),
      ('income-fees', 'y2026', 'income', 'Składki dobrowolne', 'u1', NOT ${falseValue}),
      ('expense-events', 'y2026', 'expense', 'Wydarzenia', 'u1', NOT ${falseValue}),
      ('expense-Zoo', 'y2026', 'expense', 'Zoo wycieczka', 'u1', NOT ${falseValue}),
      ('expense-old', 'y2026', 'expense', 'Archiwalna', 'u1', ${falseValue}),
      ('expense-2025', 'y2025', 'expense', 'Wydarzenia', 'u1', NOT ${falseValue});
    INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key) VALUES
      ('p1', 'h1', 'y2026', 5000, '2026-09-20', 'bank', 'recorded', 'u1', 'seed-payment-0001'),
      ('p2', NULL, 'y2026', 3000, '2026-09-21', 'bank', 'unmatched', 'u1', 'seed-payment-0002'),
      ('p3', 'h2', 'y2025', 4000, '2025-10-01', 'cash', 'recorded', 'u1', 'seed-payment-0003'),
      ('p4', 'h2', 'y2026', 2500, '2026-09-22', 'cash', 'recorded', 'u1', 'seed-payment-0004');
    INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, note, created_by, idempotency_key)
      VALUES ('ob1', 'y2026', 100000, 'Bilans syntetyczny', 'u1', 'seed-opening-0001');
    INSERT INTO ledger_opening_balance_adjustments (id, opening_balance_id, amount_cents, reason, created_by, idempotency_key)
      VALUES ('oba1', 'ob1', -2500, 'Syntetyczna poprawka', 'u1', 'seed-opening-adj-0001');
    INSERT INTO ledger_budget_lines (id, school_year_id, category_id, planned_cents, note, created_by, idempotency_key) VALUES
      ('bl1', 'y2026', 'expense-events', 20000, 'Plan początkowy', 'u1', 'seed-budget-0001'),
      ('bl3', 'y2026', 'income-fees', 50000, NULL, 'u1', 'seed-budget-0003');
    INSERT INTO ledger_budget_lines (id, school_year_id, category_id, planned_cents, note, supersedes_id, created_by, idempotency_key)
      VALUES ('bl2', 'y2026', 'expense-events', 18000, 'Plan poprawiony', 'bl1', 'u1', 'seed-budget-0002');
  `;
}

// --- Backend PostgreSQL ----------------------------------------------------

async function pgBackend({ role = 'treasurer', mfa = true, schoolYearId = 'y2026', classId } = {}) {
  const db = await createTestDb();
  await seedSchoolYear(db, 'y2025', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
  await seedSchoolYear(db, 'y2026');
  const cookie = await seedUserSession(db, { userId: 'u1', mfa, roles: [{ role, schoolYearId, classId }] });
  await db.exec(seedSql('false', PG_SOURCE_DOCUMENT_SQL));
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

const legacyToken = 'Q'.repeat(43);

function d1Adapter(db) {
  function bound(sql, values) {
    const run = () => {
      const result = db.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    };
    return {
      first: async () => { const row = db.prepare(sql).get(...values); return row ? { ...row } : null; },
      all: async () => ({ results: db.prepare(sql).all(...values).map((row) => ({ ...row })) }),
      run: async () => run(),
      _run: run,
    };
  }
  return {
    prepare: (sql) => ({ bind: (...values) => bound(sql, values) }),
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement._run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

async function legacyBackend() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of ['0001_initial', '0002_auth_sessions', '0003_student_guardians',
    '0004_enrollment_school_year', '0005_payment_corrections', '0006_payment_assignments',
    '0007_ledger_schema', '0008_ledger_payment_links']) {
    db.exec(readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
  db.exec(`
    INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
      ('y2025', 'test y2025', '2025-09-01', '2026-08-31'),
      ('y2026', 'test y2026', '2026-09-01', '2027-08-31');
    INSERT INTO users (id, email, display_name) VALUES ('u1', 'u1@example.invalid', 'Test u1');
    INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ('rg1', 'u1', 'treasurer', 'y2026');
  `);
  db.exec(seedSql('0'));
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

function normalizer() {
  const ids = new Map();
  const label = (id) => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
    return ids.get(id);
  };
  const visit = (value, key) => {
    if (typeof value === 'string') {
      if (key === 'nextCursor') {
        const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
        return visit(JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))));
      }
      return value.replace(UUID, label);
    }
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === 'object') {
      // #87: attachmentIds to rozszerzenie listy tylko w PostgreSQL (Worker go nie zna);
      // sprawdzane osobnym testem niżej.
      return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'attachmentIds').map(([k, v]) => [k, visit(v, k)]));
    }
    return value;
  };
  return visit;
}

const entryInput = {
  schoolYearId: 'y2026', direction: 'expense', amountCents: 12500, categoryId: 'expense-events',
  description: 'Syntetyczny wydatek wydarzenia', occurredOn: '2026-09-27', method: 'bank',
  source: 'Konto testowe', sourceDocumentId: 'd1',
};
const incomeInput = {
  schoolYearId: 'y2026', direction: 'income', amountCents: 5000, categoryId: 'income-fees',
  description: 'Syntetyczne ujęcie wpłaty', occurredOn: '2026-09-20', method: 'bank', paymentEntryId: 'p1',
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
  const post = (label, body, key, options = {}) => step(label, call(cookie, '/api/ledger', { body, key, ...options }));

  // Przegląd przed zapisami (ścieżki budowane tak jak w panelu z PR #30).
  await step('categories', call(cookie, buildOverviewUrl('categories', 'y2026')));
  await step('categories expense', call(cookie, buildOverviewUrl('categories', 'y2026', 'expense')));
  await step('categories bad direction', call(cookie, '/api/ledger/categories?schoolYearId=y2026&direction=x'));
  await step('categories no year', call(cookie, '/api/ledger/categories'));
  await step('summary empty', call(cookie, buildOverviewUrl('summary', 'y2026')));
  await step('summary with direction', call(cookie, '/api/ledger/summary?schoolYearId=y2026&direction=income'));
  await step('summary other year', call(cookie, '/api/ledger/summary?schoolYearId=y2025'));
  await step('budget', call(cookie, buildOverviewUrl('budget', 'y2026')));
  await step('budget other year', call(cookie, '/api/ledger/budget?schoolYearId=y2025'));

  const e1 = (await post('create', entryInput, 'ledger-key-0001')).entry.id;
  await post('create retry', entryInput, 'ledger-key-0001');
  await post('create conflict', { ...entryInput, amountCents: 12600 }, 'ledger-key-0001');
  await post('create income linked', incomeInput, 'ledger-key-0002');
  await post('create income linked retry', incomeInput, 'ledger-key-0002');
  await post('link payment twice', { ...incomeInput, description: 'Drugie ujęcie tej samej wpłaty' }, 'ledger-key-0003');
  await post('link payment twice bad category', { ...incomeInput, categoryId: 'expense-events' }, 'ledger-key-0004');
  await post('link payment to expense', { ...entryInput, paymentEntryId: 'p4' }, 'ledger-key-0005');
  await post('link unmatched payment', { ...incomeInput, paymentEntryId: 'p2' }, 'ledger-key-0006');
  await post('link other-year payment', { ...incomeInput, paymentEntryId: 'p3' }, 'ledger-key-0007');
  await post('link missing payment', { ...incomeInput, paymentEntryId: 'p-missing' }, 'ledger-key-0008');
  await post('link bad payment + missing document', { ...incomeInput, paymentEntryId: 'p2', sourceDocumentId: 'd-missing' }, 'ledger-key-0009');
  await post('missing document', { ...entryInput, sourceDocumentId: 'd-missing' }, 'ledger-key-0010');
  await post('missing document + bad category', { ...entryInput, sourceDocumentId: 'd-missing', categoryId: 'income-other' }, 'ledger-key-0011');
  await post('category other direction', { ...entryInput, categoryId: 'income-other' }, 'ledger-key-0012');
  await post('category inactive', { ...entryInput, categoryId: 'expense-old' }, 'ledger-key-0013');
  await post('category other year', { ...entryInput, categoryId: 'expense-2025' }, 'ledger-key-0014');
  await post('category missing', { ...entryInput, categoryId: 'cat-missing' }, 'ledger-key-0015');
  await post('other year', { ...entryInput, schoolYearId: 'y2025', categoryId: 'expense-2025' }, 'ledger-key-0016');
  await post('unknown year', { ...entryInput, schoolYearId: 'y-missing' }, 'ledger-key-0017');
  await post('expense exactly 3000 EUR', { ...entryInput, amountCents: 300000, sourceDocumentId: null, occurredOn: '2026-09-25' }, 'ledger-key-0018');
  await post('expense over 3000 EUR without resolution', { ...entryInput, amountCents: 300001 }, 'ledger-key-0019');
  await post('expense over 3000 EUR short resolution', { ...entryInput, amountCents: 300001, resolutionReference: 'ab' }, 'ledger-key-0020');
  await post('expense over 3000 EUR short resolution + missing document', { ...entryInput, amountCents: 300001, resolutionReference: 'ab', sourceDocumentId: 'd-missing' }, 'ledger-key-0021');
  await post('expense over 3000 EUR blank resolution', { ...entryInput, amountCents: 300001, resolutionReference: '   ' }, 'ledger-key-0022');
  await post('expense over 3000 EUR with resolution', {
    ...entryInput, amountCents: 450000, resolutionReference: '  Uchwała syntetyczna 1/2026  ', occurredOn: '2026-09-26', categoryId: 'expense-Zoo',
  }, 'ledger-key-0023');
  await post('income over 3000 EUR without resolution', {
    ...incomeInput, paymentEntryId: null, amountCents: 400000, categoryId: 'income-other', method: 'card', occurredOn: '2026-09-26',
  }, 'ledger-key-0024');
  await step('create no session', call(null, '/api/ledger', { body: entryInput, key: 'ledger-key-0031' }));
  await post('create foreign origin', entryInput, 'ledger-key-0032', { origin: 'https://evil.example' });
  await post('create no origin', entryInput, 'ledger-key-0033', { origin: null });
  await post('create short key', entryInput, 'short');
  await post('create no key', entryInput, undefined);
  await post('create text/plain', entryInput, 'ledger-key-0034', { contentType: 'text/plain' });
  await step('create bad json', call(cookie, '/api/ledger', { rawBody: '{', key: 'ledger-key-0035' }));
  await step('create array json', call(cookie, '/api/ledger', { rawBody: '[]', key: 'ledger-key-0036' }));
  await step('create too large', call(cookie, '/api/ledger', { rawBody: JSON.stringify({ x: 'a'.repeat(17000) }), key: 'ledger-key-0037' }));
  for (const [label, patch] of [
    ['zero amount', { amountCents: 0 }], ['fraction amount', { amountCents: 1.5 }], ['string amount', { amountCents: '75' }],
    ['huge amount', { amountCents: 100_000_001 }], ['bad date', { occurredOn: '2026-02-30' }], ['bad method', { method: 'crypto' }],
    ['bad direction', { direction: 'transfer' }], ['short description', { description: ' ab ' }], ['no description', { description: undefined }],
    ['long description', { description: 'd'.repeat(501) }], ['bad category', { categoryId: 'bad id' }], ['bad year', { schoolYearId: '' }],
    ['bad payment id', { paymentEntryId: 'bad id' }], ['bad document id', { sourceDocumentId: 42 }], ['long source', { source: 's'.repeat(201) }],
    ['numeric resolution', { resolutionReference: 7 }],
  ]) {
    await post(`create ${label}`, { ...entryInput, ...patch }, `ledger-key-v-${label.replaceAll(' ', '-')}`);
  }

  const correctionPath = `/api/ledger/${e1}/corrections`;
  const correction = { amountCents: 2500, reason: 'Syntetyczna korekta częściowa' };
  const cpost = (label, body, key, path = correctionPath, options = {}) => step(label, call(cookie, path, { body, key, ...options }));
  await cpost('correct', correction, 'corr-key-0001');
  await cpost('correct retry', correction, 'corr-key-0001');
  await cpost('correct conflict', { ...correction, reason: 'Inny powód' }, 'corr-key-0001');
  await cpost('correct same key other entry', correction, 'corr-key-0001', '/api/ledger/other-entry/corrections');
  await cpost('correct excessive', { amountCents: 10001, reason: 'Za dużo' }, 'corr-key-0002');
  await cpost('correct rest', { amountCents: 10000, reason: 'Reszta kwoty' }, 'corr-key-0003');
  await cpost('correct beyond zero', { amountCents: 1, reason: 'Jeszcze jeden' }, 'corr-key-0004');
  await cpost('correct missing entry', correction, 'corr-key-0005', '/api/ledger/missing-id/corrections');
  await cpost('correct bad path', correction, 'corr-key-0006', '/api/ledger/%E0/corrections');
  await cpost('correct invalid id', correction, 'corr-key-0007', '/api/ledger/-bad/corrections');
  await cpost('correct short reason', { amountCents: 1, reason: 'ab' }, 'corr-key-0008');
  await cpost('correct no reason', { amountCents: 1 }, 'corr-key-0009');
  await cpost('correct bad amount', { amountCents: -1, reason: 'Ujemna' }, 'corr-key-0010');
  await cpost('correct no key', correction, undefined);
  await cpost('correct text/plain', correction, 'corr-key-0011', correctionPath, { contentType: 'text/plain' });
  await step('correct no session', call(null, correctionPath, { body: correction, key: 'corr-key-0012' }));
  await cpost('correct foreign origin', correction, 'corr-key-0013', correctionPath, { origin: 'https://evil.example' });

  // Lista i przegląd po zapisach.
  const pageOne = await step('list page 1', call(cookie, buildLedgerUrl({ schoolYearId: 'y2026', limit: 2 })));
  const pageTwo = await step('list page 2', call(cookie, buildLedgerUrl({ schoolYearId: 'y2026', limit: 2, cursor: pageOne.nextCursor })));
  // #192: kursor wiąże rok i rodzaj wpisu zapytania, które go wydało.
  await step('list cursor other direction', call(cookie, buildLedgerUrl({ schoolYearId: 'y2026', direction: 'expense', limit: 2, cursor: pageOne.nextCursor })));
  await step('list cursor other year', call(cookie, buildLedgerUrl({ schoolYearId: 'y2025', limit: 2, cursor: pageOne.nextCursor })));
  await step('list page 3', call(cookie, buildLedgerUrl({ schoolYearId: 'y2026', limit: 2, cursor: pageTwo.nextCursor })));
  await step('list expense', call(cookie, buildLedgerUrl({ schoolYearId: 'y2026', direction: 'expense' })));
  await step('list income', call(cookie, buildLedgerUrl({ schoolYearId: 'y2026', direction: 'income' })));
  await step('list all', call(cookie, '/api/ledger?schoolYearId=y2026'));
  await step('list other year', call(cookie, '/api/ledger?schoolYearId=y2025'));
  await step('list no year', call(cookie, '/api/ledger'));
  await step('list bad direction', call(cookie, '/api/ledger?schoolYearId=y2026&direction=x'));
  for (const limit of ['0', '101', 'abc', '1000', '']) {
    await step(`list limit ${limit}`, call(cookie, `/api/ledger?schoolYearId=y2026&limit=${limit}`));
  }
  await step('list bad cursor', call(cookie, '/api/ledger?schoolYearId=y2026&cursor=not-a-cursor'));
  await step('list bad cursor json', call(cookie, `/api/ledger?schoolYearId=y2026&cursor=${btoa('[1,2]')}`));
  await step('list no session', call(null, '/api/ledger?schoolYearId=y2026'));
  await step('summary after', call(cookie, buildOverviewUrl('summary', 'y2026')));
  await step('summary no session', call(null, '/api/ledger/summary?schoolYearId=y2026'));
  await step('budget after', call(cookie, buildOverviewUrl('budget', 'y2026')));
  await step('put not found', call(cookie, '/api/ledger', { method: 'PUT', body: entryInput, key: 'ledger-key-0040' }));
  await step('get corrections not found', call(cookie, correctionPath));
  await step('post summary not found', call(cookie, '/api/ledger/summary', { body: {}, key: 'ledger-key-0041' }));
  return steps;
}

async function withSequentialUuids(fn) {
  const original = crypto.randomUUID;
  let counter = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  try { return await fn(); } finally { crypto.randomUUID = original; }
}

test('PostgreSQL ledger API matches the legacy Worker contract step by step', async () => {
  const legacy = await legacyBackend();
  const pg = await pgBackend();
  try {
    // Oba backendy generują losowe UUID; przy wpisach z tą samą datą kolejność
    // (occurred_on, id) zależałaby od losowania. Rosnące, deterministyczne UUID
    // w obu przebiegach dają tę samą kolejność remisów.
    const expected = await withSequentialUuids(() => runContractScenario(legacy));
    const actual = await withSequentialUuids(() => runContractScenario(pg));
    assert.equal(actual.length, expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      assert.deepEqual(actual[index], expected[index], `step: ${expected[index].label}`);
    }
    assert.ok(expected.some((s) => s.status === 201) && expected.some((s) => s.status === 409));
    for (const label of ['list cursor other direction', 'list cursor other year']) {
      const found = actual.find((s) => s.label === label);
      assert.deepEqual([found.status, found.body], [400, { error: 'invalid_cursor' }], label);
    }
    assert.equal(await pg.count('ledger_entries'), 5);
    assert.equal(await pg.count('ledger_corrections'), 2);
    assert.equal(await pg.count('audit_events', "action LIKE 'ledger.%'"), 7);
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

async function createEntry(backend, patch = {}, key = `entry-${crypto.randomUUID()}`, cookie = backend.cookie) {
  return read(await backend.fetch(call(cookie, '/api/ledger', { body: { ...entryInput, ...patch }, key })));
}

async function correct(backend, entryId, body, key = `corr-${crypto.randomUUID()}`, cookie = backend.cookie) {
  return read(await backend.fetch(call(cookie, `/api/ledger/${entryId}/corrections`, { body, key })));
}

async function summary(backend, schoolYearId = 'y2026') {
  return (await read(await backend.fetch(call(backend.cookie, `/api/ledger/summary?schoolYearId=${schoolYearId}`)))).body.summary;
}

test('summary balances opening, adjustments, income, expenses and corrections in EUR cents', async () => withPg({}, async (backend) => {
  assert.deepEqual(await summary(backend), {
    schoolYearId: 'y2026', openingBalanceCents: 97500, incomeCents: 0, expenseCents: 0, closingBalanceCents: 97500,
  });
  const expense = (await createEntry(backend, { amountCents: 12345 })).body.entry;
  await createEntry(backend, { amountCents: 1, sourceDocumentId: null });
  await createEntry(backend, { ...incomeInput, amountCents: 5000 });
  await createEntry(backend, { ...incomeInput, paymentEntryId: 'p4', amountCents: 2500, method: 'cash' });
  await createEntry(backend, { ...incomeInput, paymentEntryId: null, categoryId: 'income-other', amountCents: 99 });
  await correct(backend, expense.id, { amountCents: 345, reason: 'Zwrot części' });
  // Rok obok nie wpływa na bilans (admin bez zakresu roku).
  const admin = await backend.as('u-admin', { mfa: true, roles: [{ role: 'admin' }] });
  assert.equal((await createEntry(backend, { schoolYearId: 'y2025', categoryId: 'expense-2025', sourceDocumentId: null, occurredOn: '2025-10-01' }, 'other-year-0001', admin)).status, 201);

  const result = await summary(backend);
  const income = 5000 + 2500 + 99;
  const expenses = 12345 - 345 + 1;
  assert.deepEqual(result, {
    schoolYearId: 'y2026', openingBalanceCents: 97500, incomeCents: income, expenseCents: expenses,
    closingBalanceCents: 97500 + income - expenses,
  });
  for (const value of Object.values(result).slice(1)) assert.ok(Number.isSafeInteger(value));

  // Suma netto listy zgadza się z podsumowaniem; panel z PR #30 odczytuje wpisy bez strat.
  const list = await read(await backend.fetch(call(backend.cookie, buildLedgerUrl({ schoolYearId: 'y2026', limit: 100 }))));
  const entries = list.body.entries.map(normalizeEntry);
  const net = (direction) => entries.filter((e) => e.direction === direction).reduce((sum, e) => sum + e.netCents, 0);
  assert.equal(net('income'), income);
  assert.equal(net('expense'), expenses);
  assert.deepEqual(Object.keys(list.body.entries[0]).sort(), [
    // #87: attachmentIds — wszystkie dowody wpisu (tylko lista w PostgreSQL).
    'amountCents', 'attachmentIds', 'categoryId', 'categoryName', 'correctedCents', 'description', 'direction', 'id', 'method',
    'netAmountCents', 'occurredOn', 'paymentEntryId', 'resolutionReference', 'schoolYearId', 'source', 'sourceDocumentId',
  ]);
  const corrected = entries.find((e) => e.id === expense.id);
  assert.deepEqual([corrected.amountCents, corrected.correctedCents, corrected.netCents], [12345, 345, 12000]);

  const budget = await read(await backend.fetch(call(backend.cookie, buildOverviewUrl('budget', 'y2026'))));
  assert.deepEqual(budget.body.budget.map((line) => [line.id, line.plannedCents, line.supersedesId]), [
    ['bl2', 18000, 'bl1'], ['bl3', 50000, null],
  ]);
  assert.equal(await summary(backend, 'y-missing'), undefined);
}));

test('corrections sent via Promise.all (sequential on PGlite) never exceed the entry amount; lock proof on PostgreSQL in pg-real-double-click', async () => withPg({}, async (backend) => {
  const entry = (await createEntry(backend, { amountCents: 10000 })).body.entry;
  const results = await Promise.all([1, 2, 3].map((n) => correct(backend, entry.id, {
    amountCents: 4000, reason: `Równoległa korekta ${n}`,
  }, `parallel-corr-000${n}`)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 201, 409]);
  assert.deepEqual(results.find((r) => r.status === 409).body, { error: 'correction_exceeds_remaining_amount' });
  const net = (await backend.db.query('SELECT corrected_cents, net_amount_cents FROM ledger_entry_net WHERE id = $1', [entry.id])).rows[0];
  assert.equal(Number(net.corrected_cents), 8000);
  assert.equal(Number(net.net_amount_cents), 2000);
  assert.equal(await backend.count('audit_events', "action = 'ledger.correction.created'"), 2);

  // Równoległe ponowienia tej samej korekty: jeden wiersz, jedno odtworzenie.
  const same = await Promise.all([0, 1].map(() => correct(backend, entry.id, {
    amountCents: 2000, reason: 'Ostatnia korekta',
  }, 'parallel-corr-same')));
  assert.deepEqual(same.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(same.map((r) => r.replayed).sort(), ['false', 'true']);
  assert.equal(same[0].body.correction.id, same[1].body.correction.id);
  assert.equal(await backend.count('ledger_corrections'), 3);
  assert.equal((await summary(backend)).expenseCents, 0);

  // Baza sama też odrzuca nadmierną korektę, a historia jest niezmienna.
  await assert.rejects(backend.db.query(
    `INSERT INTO ledger_corrections (id, ledger_entry_id, amount_cents, reason, created_by, idempotency_key)
     VALUES ('direct', $1, 1, 'Bezpośrednio', 'u1', 'direct-key-0001')`, [entry.id],
  ), /ledger_correction_exceeds_remaining_amount/);
  await assert.rejects(backend.db.query('DELETE FROM ledger_corrections'), /cannot_be_changed/);
  await assert.rejects(backend.db.query('UPDATE ledger_entries SET amount_cents = 1'), /cannot_be_changed/);
  await assert.rejects(backend.db.query('DELETE FROM ledger_entries'), /cannot_be_changed/);
}));

test('#99: after re-login the same Idempotency-Key does not duplicate a ledger entry (expired session, lost response)', async () => withPg({}, async (backend) => {
  // 1) Sesja wygasła przed zapisem: 401 i nic nie powstaje. Po ponownym zalogowaniu (nowa sesja
  //    tej samej osoby) formularz wysyła ten sam klucz — jeden zapis i jedno zdarzenie audytu.
  const expired = await backend.as('u1', { mfa: true, expiresAt: new Date(Date.now() - 60 * 1000) });
  const rejected = await createEntry(backend, {}, 'entry-relogin-0001', expired);
  assert.deepEqual([rejected.status, rejected.body], [401, { error: 'unauthenticated' }]);
  assert.equal(await backend.count('ledger_entries'), 0);
  const fresh = await backend.as('u1', { mfa: true });
  const created = await createEntry(backend, {}, 'entry-relogin-0001', fresh);
  assert.equal(created.status, 201);
  const again = await createEntry(backend, {}, 'entry-relogin-0001', fresh);
  assert.deepEqual([again.status, again.replayed, again.body.entry.id], [200, 'true', created.body.entry.id]);

  // 2) Zapis przeszedł, ale odpowiedź nie dotarła, a potem sesja wygasła (wylogowanie):
  //    ponowienie tym samym kluczem z nowej sesji odtwarza zapis zamiast tworzyć drugi.
  const first = await createEntry(backend, {}, 'entry-relogin-0002');
  assert.equal(first.status, 201);
  const relogged = await backend.as('u1', { mfa: true });
  const replay = await createEntry(backend, {}, 'entry-relogin-0002', relogged);
  assert.deepEqual([replay.status, replay.replayed, replay.body.entry.id], [200, 'true', first.body.entry.id]);

  assert.equal(await backend.count('ledger_entries'), 2);
  assert.equal(await backend.count('audit_events', "action = 'ledger.entry.created'"), 2);
}));

test('double click with the same Idempotency-Key creates one entry and one audit event', async () => withPg({}, async (backend) => {
  for (const [key, patch] of [['double-click-0001', {}], ['double-click-0002', incomeInput]]) {
    const [first, second] = await Promise.all([createEntry(backend, patch, key), createEntry(backend, patch, key)]);
    assert.deepEqual([first.status, second.status].sort(), [200, 201], key);
    assert.deepEqual([first.replayed, second.replayed].sort(), ['false', 'true']);
    assert.equal(first.body.entry.id, second.body.entry.id);
    const third = await createEntry(backend, patch, key);
    assert.deepEqual([third.status, third.body.entry.id], [200, first.body.entry.id]);
  }
  assert.equal(await backend.count('ledger_entries'), 2);
  assert.equal(await backend.count('audit_events', "action = 'ledger.entry.created'"), 2);

  const conflict = await createEntry(backend, { description: 'Inny opis wydatku' }, 'double-click-0001');
  assert.deepEqual([conflict.status, conflict.body], [409, { error: 'idempotency_conflict' }]);
  // Ten sam klucz innej osoby finansowej też jest konfliktem, nie odtworzeniem cudzego zapisu.
  const other = await backend.as('u2', { mfa: true, roles: [{ role: 'board' }] });
  const foreign = await createEntry(backend, {}, 'double-click-0001', other);
  assert.deepEqual([foreign.status, foreign.body], [409, { error: 'idempotency_conflict' }]);
  assert.equal(await backend.count('ledger_entries'), 2);
}));

test('a linked payment is never recorded twice, also via Promise.all with different keys (sequential on PGlite)', async () => withPg({}, async (backend) => {
  const other = await backend.as('u2', { mfa: true, roles: [{ role: 'board', schoolYearId: 'y2026' }] });
  const results = await Promise.all([
    createEntry(backend, incomeInput, 'link-par-0001'),
    createEntry(backend, { ...incomeInput, description: 'Równoległe ujęcie' }, 'link-par-0002'),
    createEntry(backend, { ...incomeInput, occurredOn: '2026-09-21' }, 'link-par-0003', other),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
  for (const result of results.filter((r) => r.status === 409)) {
    assert.deepEqual(result.body, { error: 'payment_already_linked' });
  }
  assert.equal(await backend.count('ledger_entries', "payment_entry_id = 'p1'"), 1);
  assert.equal(await backend.count('audit_events', "action = 'ledger.entry.created'"), 1);
  const later = await createEntry(backend, { ...incomeInput, categoryId: 'income-other' }, 'link-par-0004');
  assert.deepEqual([later.status, later.body], [409, { error: 'payment_already_linked' }]);
  // Baza sama odrzuca drugie ujęcie (trigger ledger_entry_insert_guard, 0142; wcześniej unikalny indeks z 0003).
  await assert.rejects(backend.db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on,
       method, payment_entry_id, created_by, idempotency_key)
     VALUES ('direct', 'y2026', 'income', 5000, 'income-fees', 'Bezpośrednio', '2026-09-20', 'bank', 'p1', 'u1', 'direct-link-0001')`,
  ), /ledger_payment_already_linked/);
}));

test('an expense above 3000 EUR without a resolution reference is refused; exactly 3000 EUR is allowed', async () => withPg({}, async (backend) => {
  for (const resolutionReference of [undefined, null, '', 'ab']) {
    const result = await createEntry(backend, { amountCents: 300001, resolutionReference });
    assert.deepEqual([result.status, result.body], [400, { error: 'resolution_required' }], String(resolutionReference));
  }
  assert.equal(await backend.count('ledger_entries'), 0);
  assert.equal((await createEntry(backend, { amountCents: 300000 })).status, 201);
  const approved = await createEntry(backend, { amountCents: 300001, resolutionReference: 'Uchwała 2/2026' });
  assert.equal(approved.status, 201);
  assert.equal(approved.body.entry.resolutionReference, 'Uchwała 2/2026');
  // Ograniczenie w bazie niezależnie od API.
  await assert.rejects(backend.db.query(
    `INSERT INTO ledger_entries (id, school_year_id, direction, amount_cents, category_id, description, occurred_on,
       method, created_by, idempotency_key)
     VALUES ('direct', 'y2026', 'expense', 300001, 'expense-events', 'Bezpośrednio', '2026-09-20', 'bank', 'u1', 'direct-res-0001')`,
  ), /ledger_large_expense_resolution/);
}));

const LEDGER_GETS = [
  '/api/ledger?schoolYearId=y2026', '/api/ledger/categories?schoolYearId=y2026', '/api/ledger/summary?schoolYearId=y2026',
  '/api/ledger/budget?schoolYearId=y2026', '/api/ledger/export.csv?schoolYearId=y2026',
  '/api/ledger/export.xlsx?schoolYearId=y2026',
];

test('representative, audit and principal roles are refused on every ledger route', async () => {
  const roles = [
    { role: 'representative', classId: 'c-1a', schoolYearId: 'y2026' },
    { role: 'audit', schoolYearId: 'y2026' },
    { role: 'principal' },
  ];
  for (const grant of roles) {
    await withPg({}, async (backend) => {
      const entry = (await createEntry(backend)).body.entry;
      const cookie = await backend.as(`u-${grant.role}`, { mfa: true, roles: [grant] });
      const requests = [
        ...LEDGER_GETS.map((path) => call(cookie, path)),
        call(cookie, '/api/ledger', { body: entryInput, key: 'role-key-0001' }),
        call(cookie, `/api/ledger/${entry.id}/corrections`, { body: { amountCents: 1, reason: 'Próba roli' }, key: 'role-key-0002' }),
        call(cookie, '/api/ledger/missing-id/corrections', { body: { amountCents: 1, reason: 'Próba roli' }, key: 'role-key-0003' }),
      ];
      for (const req of requests) {
        const result = await read(await backend.fetch(req));
        assert.deepEqual([result.status, result.body], [403, { error: 'forbidden' }], `${grant.role} ${req.method} ${req.url}`);
      }
      assert.equal(await backend.count('ledger_entries'), 1);
      assert.equal(await backend.count('ledger_corrections'), 0);
      assert.equal(await backend.count('audit_events', "action = 'ledger.exported'"), 0);
    });
  }
});

test('missing MFA, expired grant, no session and cross-origin writes are refused without writes', async () => withPg({ mfa: false }, async (backend) => {
  const admin = await backend.as('u-admin', { mfa: true, roles: [{ role: 'admin' }] });
  const entry = (await createEntry(backend, {}, 'setup-key-0001', admin)).body.entry;
  const expired = await backend.as('u-expired', { mfa: true, roles: [{ role: 'treasurer', expiresAt: new Date(Date.now() - 1000) }] });
  // Skarbnik bez sesji z MFA: bramka MFA routera (mfa_enrollment_required) przed trasą księgi.
  for (const path of LEDGER_GETS) {
    for (const [cookie, status, error] of [[backend.cookie, 403, 'mfa_enrollment_required'], [expired, 403, 'forbidden'], [null, 401, 'unauthenticated']]) {
      const result = await read(await backend.fetch(call(cookie, path)));
      assert.deepEqual([result.status, result.body], [status, { error }], path);
    }
  }
  const targets = [['/api/ledger', entryInput], [`/api/ledger/${entry.id}/corrections`, { amountCents: 1, reason: 'Bez MFA' }]];
  for (const [path, body] of targets) {
    for (const [cookie, status, error] of [[backend.cookie, 403, 'mfa_enrollment_required'], [expired, 403, 'forbidden'], [null, 401, 'unauthenticated']]) {
      const result = await read(await backend.fetch(call(cookie, path, { body, key: 'mfa-key-0001' })));
      assert.deepEqual([result.status, result.body], [status, { error }], path);
    }
    for (const origin of ['https://evil.example', null, 'http://rd.example']) {
      const result = await read(await backend.fetch(call(admin, path, { body, key: 'origin-key-0001', origin })));
      assert.deepEqual([result.status, result.body], [403, { error: 'invalid_origin' }], `${path} ${origin}`);
    }
  }
  assert.equal(await backend.count('ledger_entries'), 1);
  assert.equal(await backend.count('ledger_corrections'), 0);
  // Moduł sam też odrzuca obce Origin, gdyby został użyty poza handlePgRequest.
  const direct = await ledgerRoutes.handle(call(admin, '/api/ledger', { body: entryInput, key: 'origin-key-0002', origin: 'https://evil.example' }),
    backend.env, new URL(`${BASE}/api/ledger`), (data, status) => new Response(JSON.stringify(data), { status }));
  assert.equal(direct.status, 403);
}));

test('a year-scoped grant cannot read or write another school year', async () => withPg({}, async (backend) => {
  const admin = await backend.as('u-admin', { mfa: true, roles: [{ role: 'admin' }] });
  const old = (await createEntry(backend, { schoolYearId: 'y2025', categoryId: 'expense-2025', sourceDocumentId: null, occurredOn: '2025-10-01' }, 'old-year-0001', admin)).body.entry;
  assert.ok(old?.id);
  for (const req of [
    ...LEDGER_GETS.map((path) => call(backend.cookie, path.replace('y2026', 'y2025'))),
    call(backend.cookie, '/api/ledger', { body: { ...entryInput, schoolYearId: 'y2025', categoryId: 'expense-2025' }, key: 'year-key-0001' }),
    call(backend.cookie, `/api/ledger/${old.id}/corrections`, { body: { amountCents: 1, reason: 'Inny rok' }, key: 'year-key-0002' }),
  ]) {
    const result = await read(await backend.fetch(req));
    assert.deepEqual([result.status, result.body], [403, { error: 'forbidden' }], req.url);
  }
  assert.equal(await backend.count('ledger_corrections'), 0);
  assert.equal(await backend.count('ledger_entries', "school_year_id = 'y2025'"), 1);
  // Admin bez zakresu roku widzi y2025, ale nie dostaje pustych danych dla nieistniejącego roku.
  const missing = await read(await backend.fetch(call(admin, '/api/ledger/summary?schoolYearId=y-missing')));
  assert.deepEqual([missing.status, missing.body], [404, { error: 'school_year_not_found' }]);
}));

test('audit events are atomic with the write and carry no amounts, descriptions or documents', async () => withPg({}, async (backend) => {
  const entry = (await createEntry(backend, { amountCents: 4321, description: 'Opis syntetyczny XYZ', resolutionReference: 'UCHWALA-SYNTH' })).body.entry;
  await correct(backend, entry.id, { amountCents: 321, reason: 'Powód syntetyczny' }, 'audit-corr-0001');
  const events = (await backend.db.query(
    "SELECT actor_id, action, entity_type, entity_id, metadata_json FROM audit_events WHERE action LIKE 'ledger.%' ORDER BY occurred_at, action",
  )).rows;
  assert.deepEqual(events.map((e) => [e.actor_id, e.action, e.entity_type]), [
    ['u1', 'ledger.entry.created', 'ledger_entry'],
    ['u1', 'ledger.correction.created', 'ledger_correction'],
  ]);
  assert.equal(events[0].entity_id, entry.id);
  // #174: zdarzenia finansowe niosą teraz schoolYearId (eksport roczny).
  assert.deepEqual(events[0].metadata_json, { schoolYearId: 'y2026' });
  assert.deepEqual(events[1].metadata_json, { ledgerEntryId: entry.id, schoolYearId: 'y2026' });
  // Identyfikator wpisu (losowy UUID) usuwamy przed szukaniem ciągów — w zapisie szesnastkowym może zawierać np. „d1” lub „321”.
  const metadata = JSON.stringify(events.map((e) => e.metadata_json)).replaceAll(entry.id, '<entry-id>');
  for (const secret of ['4321', '321', 'XYZ', 'UCHWALA', 'Powód', 'd1']) assert.ok(!metadata.includes(secret), secret);

  // Gdy zapis audytu zawiedzie, wpis nie powstaje (jedna transakcja).
  await backend.db.exec(`
    CREATE FUNCTION fail_ledger_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action LIKE 'ledger.%' THEN RAISE EXCEPTION 'audit_down'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_ledger_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_ledger_audit();
  `);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const failed = await createEntry(backend, {}, 'audit-fail-0001');
    assert.deepEqual([failed.status, failed.body], [503, { error: 'service_unavailable' }]);
    const failedCorrection = await correct(backend, entry.id, { amountCents: 1, reason: 'Bez audytu' }, 'audit-fail-0002');
    assert.equal(failedCorrection.status, 503);
    const failedExport = await backend.fetch(call(backend.cookie, '/api/ledger/export.csv?schoolYearId=y2026'));
    assert.equal(failedExport.status, 503);
  } finally {
    console.error = original;
  }
  // #214: kontrola pozytywna — bez niej test przechodzi także wtedy, gdy logger przestaje pisać na console.error.
  assert.ok(errors.length > 0, 'awarie triggera audytu muszą zostać zalogowane przez console.error');
  assertEvery(errors, (line) => !line.includes('Syntetyczny') && !line.includes('@'));
  assert.equal(await backend.count('ledger_entries', "idempotency_key = 'audit-fail-0001'"), 0);
  assert.equal(await backend.count('ledger_corrections'), 1);

  // #211: ponowienie tym samym kluczem po usunięciu awarii — dokładnie ten krok
  // wykona przeglądarka skarbnika po 503 (macierz scenariuszy AGENTS.md, księga).
  await backend.db.exec('DROP TRIGGER fail_ledger_audit ON audit_events; DROP FUNCTION fail_ledger_audit();');
  const retried = await createEntry(backend, {}, 'audit-fail-0001');
  assert.equal(retried.status, 201);
  assert.equal(retried.replayed, 'false');
  assert.equal(await backend.count('ledger_entries', "idempotency_key = 'audit-fail-0001'"), 1);
  assert.equal(await backend.count('audit_events', `action = 'ledger.entry.created' AND entity_id = '${retried.body.entry.id}'`), 1);
  const thirdTry = await createEntry(backend, {}, 'audit-fail-0001');
  assert.equal(thirdTry.status, 200);
  assert.equal(thirdTry.replayed, 'true');
  assert.equal(thirdTry.body.entry.id, retried.body.entry.id);
  assert.equal(await backend.count('ledger_entries', "idempotency_key = 'audit-fail-0001'"), 1);

  const correctionRetry = await correct(backend, entry.id, { amountCents: 1, reason: 'Bez audytu' }, 'audit-fail-0002');
  assert.equal(correctionRetry.status, 201);
  assert.equal(correctionRetry.replayed, 'false');
  assert.equal(await backend.count('ledger_corrections'), 2);
  const correctionThird = await correct(backend, entry.id, { amountCents: 1, reason: 'Bez audytu' }, 'audit-fail-0002');
  assert.equal(correctionThird.status, 200);
  assert.equal(correctionThird.replayed, 'true');
  assert.equal(await backend.count('ledger_corrections'), 2);
}));

test('CSV export of a school year is financial-only, injection-safe and audited', async () => withPg({}, async (backend) => {
  const expense = (await createEntry(backend, {
    amountCents: 12345, description: '=HYPERLINK("http://evil.example")', occurredOn: '2026-09-10', source: '+48 konto; "cytat"',
  })).body.entry;
  await correct(backend, expense.id, { amountCents: 45, reason: 'Korekta eksportu' });
  await createEntry(backend, { ...incomeInput, description: '@SUM(A1)', occurredOn: '2026-09-11' });
  await createEntry(backend, { ...incomeInput, paymentEntryId: null, categoryId: 'income-other', description: '-2+3 wiersz\ndrugi', amountCents: 7, method: 'card' });

  const response = await backend.fetch(call(backend.cookie, '/api/ledger/export.csv?schoolYearId=y2026'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Disposition'), /^attachment; filename="ksiega-y2026-\d{8}\.csv"$/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for spreadsheets');
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('id_wpisu;data;rodzaj;kategoria;opis;'));
  const lines = text.split('\r\n');
  assert.equal(lines.at(-1), '');
  assert.equal(lines.length, 1 + 3 + 1);
  assert.equal(lines[1], [
    expense.id, '2026-09-10', 'Wydatek', 'Wydarzenia', `"'=HYPERLINK(""http://evil.example"")"`,
    // #144: nowa kolumna „zastepuje_wpis” (replaces_entry_id) między id_dokumentu a kwota_eur; pusta dla zwykłego wpisu.
    'Przelew', '"\'+48 konto; ""cytat"""', '', '', 'd1', '', '123,45', '0,45', '123,00', '1', 'd1',
  ].join(';'));
  assert.match(lines[2], /;Przychód;Składki dobrowolne;'@SUM\(A1\);Przelew;Konto testowe;;p1;d1;;50,00;0,00;50,00;1;d1$/);
  assert.match(lines[3], /;Przychód;Inne przychody;"'-2\+3 wiersz\ndrugi";Karta;Konto testowe;;;d1;;0,07;0,00;0,07;1;d1$/);
  // Żadna komórka nie zaczyna się od znaku formuły (poza cytowaniem).
  for (const line of lines.slice(1, -1)) {
    for (const cell of line.split(';')) assert.ok(!/^"?[=+\-@]/.test(cell), cell);
  }

  const events = (await backend.db.query("SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'ledger.exported'")).rows;
  // #174: schoolYearId w metadanych (eksport roczny), oprócz entity_id.
  assert.deepEqual(events, [{ actor_id: 'u1', entity_type: 'school_year', entity_id: 'y2026', metadata_json: { format: 'csv', rowCount: 3, schoolYearId: 'y2026' } }]);

  const other = await read(await backend.fetch(call(backend.cookie, '/api/ledger/export.csv?schoolYearId=y2025')));
  assert.deepEqual([other.status, other.body], [403, { error: 'forbidden' }]);
  const bad = await read(await backend.fetch(call(backend.cookie, '/api/ledger/export.csv')));
  assert.deepEqual([bad.status, bad.body], [400, { error: 'invalid_request' }]);
  const admin = await backend.as('u-admin', { mfa: true, roles: [{ role: 'admin' }] });
  const missing = await read(await backend.fetch(call(admin, '/api/ledger/export.csv?schoolYearId=y-missing')));
  assert.deepEqual([missing.status, missing.body], [404, { error: 'school_year_not_found' }]);
  const post = await read(await backend.fetch(call(backend.cookie, '/api/ledger/export.csv', { body: {}, key: 'export-key-0001' })));
  assert.equal(post.status, 404);
  assert.equal(await backend.count('audit_events', "action = 'ledger.exported'"), 1);
}));

// Odczyt arkusza z bajtów XLSX bez zewnętrznego czytnika: wiersze -> { ref: { type, value } }.
function readXlsxRows(bytes) {
  const sheet = strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']);
  return [...sheet.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/g)].map(([, , cells]) => [...cells.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?: t="(inlineStr)")?>(?:<is><t[^>]*>([\s\S]*?)<\/t><\/is>|<v>(.*?)<\/v>)<\/c>/g)]
    .map(([, column, inline, text, number]) => ({ column, type: inline ? 'string' : 'number', value: inline ? text : number })));
}

test('XLSX export: same roles, audit format=xlsx, numeric negative amounts, no formulas, sums equal CSV and summary', async () => withPg({}, async (backend) => {
  const expense = (await createEntry(backend, {
    amountCents: 12345, description: '=HYPERLINK("http://evil.example")', occurredOn: '2026-09-10', source: '+48 konto; "cytat"',
  })).body.entry;
  await correct(backend, expense.id, { amountCents: 45, reason: 'Korekta eksportu' });
  await createEntry(backend, { ...incomeInput, description: '@SUM(A1)', occurredOn: '2026-09-11' });
  await createEntry(backend, { ...incomeInput, paymentEntryId: null, categoryId: 'income-other', description: '-2+3 wiersz\ndrugi', amountCents: 7, method: 'card' });

  const response = await backend.fetch(call(backend.cookie, '/api/ledger/export.xlsx?schoolYearId=y2026'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Content-Disposition'), /^attachment; filename="ksiega-y2026-\d{8}\.xlsx"$/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  for (const [name, part] of Object.entries(unzipSync(bytes))) assert.ok(!/<f[\s>/]/.test(strFromU8(part)), `${name} bez formuł`);
  const rows = readXlsxRows(bytes);
  assert.equal(rows.length, 1 + 3);
  const at = (row, column) => row.find((cell) => cell.column === column);
  // Kolumny L, M, N = kwota_eur, korekty_eur, netto_eur: liczby; K/D/E/G tekst.
  for (const row of rows.slice(1)) for (const column of ['L', 'M', 'N']) assert.equal(at(row, column).type, 'number');
  assert.deepEqual(at(rows[1], 'E'), { column: 'E', type: 'string', value: '=HYPERLINK(&quot;http://evil.example&quot;)' });
  assert.equal(at(rows[1], 'L').value, '123.45');
  assert.equal(at(rows[1], 'N').value, '123.00');

  // Sumy netto XLSX = CSV = ledger_year_summary (osobno przychody i wydatki).
  const csv = new TextDecoder().decode(await (await backend.fetch(call(backend.cookie, '/api/ledger/export.csv?schoolYearId=y2026'))).arrayBuffer());
  const csvNet = { Przychód: 0, Wydatek: 0 };
  const xlsxNet = { Przychód: 0, Wydatek: 0 };
  for (const line of csv.split('\r\n').slice(1, -1)) {
    const cells = line.match(/("([^"]|"")*"|[^;]*)(;|$)/g).map((cell) => cell.replace(/;$/, ''));
    csvNet[cells[2]] += Math.round(Number(cells[13].replace(',', '.')) * 100);
  }
  for (const row of rows.slice(1)) xlsxNet[at(row, 'C').value] += Math.round(Number(at(row, 'N').value) * 100);
  assert.deepEqual(xlsxNet, csvNet);
  const totals = await summary(backend);
  assert.equal(xlsxNet.Przychód, totals.incomeCents);
  assert.equal(xlsxNet.Wydatek, totals.expenseCents);

  const events = (await backend.db.query("SELECT actor_id, entity_type, entity_id, metadata_json FROM audit_events WHERE action = 'ledger.exported' ORDER BY occurred_at, id")).rows;
  assert.deepEqual(events.map((event) => event.metadata_json), [
    { format: 'xlsx', rowCount: 3, schoolYearId: 'y2026' },
    { format: 'csv', rowCount: 3, schoolYearId: 'y2026' },
  ]);
  // Podwójne kliknięcie: dwa pobrania, dwa wpisy audytu (zamierzone, docs/EXPORT.md).
  assert.equal((await backend.fetch(call(backend.cookie, '/api/ledger/export.xlsx?schoolYearId=y2026'))).status, 200);
  assert.equal(await backend.count('audit_events', "action = 'ledger.exported'"), 3);

  const other = await read(await backend.fetch(call(backend.cookie, '/api/ledger/export.xlsx?schoolYearId=y2025')));
  assert.deepEqual([other.status, other.body], [403, { error: 'forbidden' }]);
  const bad = await read(await backend.fetch(call(backend.cookie, '/api/ledger/export.xlsx')));
  assert.deepEqual([bad.status, bad.body], [400, { error: 'invalid_request' }]);
  const post = await read(await backend.fetch(call(backend.cookie, '/api/ledger/export.xlsx', { body: {}, key: 'export-key-0002' })));
  assert.equal(post.status, 404);
  assert.equal(await backend.count('audit_events', "action = 'ledger.exported'"), 3);
}));

test('CSV helpers neutralise formulas and quote separators', () => {
  assert.equal(ledgerRoutes.csvCell('=1+1'), "'=1+1");
  assert.equal(ledgerRoutes.csvCell('+48'), "'+48");
  assert.equal(ledgerRoutes.csvCell('-5'), "'-5");
  assert.equal(ledgerRoutes.csvCell('@x'), "'@x");
  assert.equal(ledgerRoutes.csvCell('\tx'), "'\tx");
  assert.equal(ledgerRoutes.csvCell('a;b'), '"a;b"');
  assert.equal(ledgerRoutes.csvCell('a"b'), '"a""b"');
  assert.equal(ledgerRoutes.csvCell(null), '');
  assert.equal(ledgerRoutes.csvCell('Zwykły tekst'), 'Zwykły tekst');
  assert.equal(ledgerRoutes.formatEuro(0), '0,00');
  assert.equal(ledgerRoutes.formatEuro(5), '0,05');
  assert.equal(ledgerRoutes.formatEuro('100000000'), '1000000,00');
  assert.throws(() => ledgerRoutes.formatEuro('9007199254740993'), /unsafe_integer/);
});

test('ledger CSV line exports negative amounts as numbers and neutralises text (#121)', () => {
  const line = ledgerRoutes.ledgerCsvLine({
    id: 'le-syn-1', occurred_on: '2026-09-12', direction: 'income', category_name: '=Kategoria',
    description: '-korekta; "opis"', method: 'bank', source: '@konto', resolution_reference: '+U/1',
    payment_entry_id: null, source_document_id: null,
    amount_cents: 1000, corrected_cents: -1250, net_amount_cents: '2250',
  });
  assert.equal(line, [
    'le-syn-1', '2026-09-12', 'Przychód', "'=Kategoria", `"'-korekta; ""opis"""`, 'Przelew', "'@konto", "'+U/1",
    '', '', '', '10,00', '-12,50', '22,50', '0', '',
  ].join(';'));
  assert.deepEqual(ledgerRoutes.LEDGER_CSV_COLUMNS.filter((column) => column.type === 'amount').map((column) => column.header),
    ['kwota_eur', 'korekty_eur', 'netto_eur']);
});

test('ledger route is registered once, after payments', () => {
  assert.equal(ROUTES.filter((route) => route.name === 'ledger').length, 1);
  assert.ok(ROUTES.findIndex((route) => route.name === 'ledger') > ROUTES.findIndex((route) => route.name === 'payments'));
});
