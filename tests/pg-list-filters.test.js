// Filtry serwerowe GET /api/payments i GET /api/ledger (#128). Wyłącznie dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { escapeLikePattern } from '../src/pg/routes/payments.js';
import { createTestDb, seedEnrolledHousehold, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const BASE = 'https://rd.example';

function call(cookie, path, { body, key } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined) {
    headers.set('Origin', BASE);
    headers.set('Content-Type', 'application/json');
    headers.set('Idempotency-Key', key);
  }
  return new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function get(backend, path, cookie = backend.cookie) {
  const response = await backend.fetch(call(cookie, path));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function backendWith(fn) {
  const db = await createTestDb();
  try {
    await seedSchoolYear(db, 'y2025', { startsOn: '2025-09-01', endsOn: '2026-08-31' });
    await seedSchoolYear(db, 'y2026');
    for (const id of ['h1', 'h2', 'h3']) await seedEnrolledHousehold(db, id, ['y2026']);
    await seedEnrolledHousehold(db, 'h-old', ['y2025']);
    const cookie = await seedUserSession(db, { userId: 'u1', mfa: true, roles: [{ role: 'treasurer', schoolYearId: 'y2026' }] });
    const backend = { db, cookie, fetch: (req) => handlePgRequest(req, { db }) };
    await fn(backend);
  } finally {
    await db.close();
  }
}

// [id, gospodarstwo, rok, kwota, data, metoda, tytuł, status]
const PAYMENTS = [
  ['p01', 'h1', 'y2026', 5000, '2026-09-10', 'bank', 'Składka Żółć 100%', 'recorded'],
  ['p02', 'h1', 'y2026', 3000, '2026-09-20', 'cash', 'Składka 100X', 'recorded'],
  ['p03', 'h2', 'y2026', 2500, '2026-10-05', 'bank', 'wplata_a', 'recorded'],
  ['p04', 'h2', 'y2026', 2500, '2026-10-06', 'bank', 'wplataXa', 'recorded'],
  ['p05', null, 'y2026', 1000, '2026-10-07', 'other', 'Ścieżka\\dowolna', 'unmatched'],
  ['p06', null, 'y2026', 1200, '2026-11-01', 'bank', null, 'unmatched'],
  ['p07', 'h-old', 'y2025', 4000, '2025-10-01', 'bank', 'Składka Żółć 100%', 'recorded'],
];

async function seedPayments(db) {
  for (const [id, household, year, amount, date, method, reference, status] of PAYMENTS) {
    await db.query(
      `INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, reference, status, created_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'u1', $9)`,
      [id, household, year, amount, date, method, reference, status, `seed-${id}-0000`],
    );
  }
}

const ids = (result) => result.body.payments.map((p) => p.id);
const list = (backend, query) => get(backend, `/api/payments?schoolYearId=y2026&${query}`);

test('escapeLikePattern ucieka %, _ i ukośnik wsteczny', () => {
  assert.equal(escapeLikePattern('a%b_c\\d'), 'a\\%b\\_c\\\\d');
  assert.equal(escapeLikePattern('Żółć'), 'Żółć');
});

test('GET /api/payments: filtry dat, metody, rodziny i tekstu działają w SQL i łączą się przez AND', async () => backendWith(async (backend) => {
  await seedPayments(backend.db);
  assert.deepEqual(ids(await list(backend, '')), ['p06', 'p05', 'p04', 'p03', 'p02', 'p01']);
  assert.deepEqual(ids(await list(backend, 'dateFrom=2026-10-05')), ['p06', 'p05', 'p04', 'p03']);
  assert.deepEqual(ids(await list(backend, 'dateTo=2026-09-20')), ['p02', 'p01']);
  assert.deepEqual(ids(await list(backend, 'dateFrom=2026-09-20&dateTo=2026-10-05')), ['p03', 'p02']);
  assert.deepEqual(ids(await list(backend, 'method=cash')), ['p02']);
  assert.deepEqual(ids(await list(backend, 'method=bank&status=recorded&householdId=h2')), ['p04', 'p03']);
  assert.deepEqual(ids(await list(backend, 'householdId=h1')), ['p02', 'p01']);
  assert.deepEqual(ids(await list(backend, 'method=bank&dateFrom=2026-10-01&status=unmatched')), ['p06']);
}));

test('GET /api/payments: q z %, _ i \\ jest szukane dosłownie, polskie znaki i wielkość liter działają', async () => backendWith(async (backend) => {
  await seedPayments(backend.db);
  // "%" nie jest wieloznacznikiem: "100%" nie łapie "100X".
  assert.deepEqual(ids(await list(backend, `q=${encodeURIComponent('100%')}`)), ['p01']);
  assert.deepEqual(ids(await list(backend, `q=${encodeURIComponent('%')}`)), ['p01']);
  // "_" nie jest wieloznacznikiem: "wplata_a" nie łapie "wplataXa".
  assert.deepEqual(ids(await list(backend, `q=${encodeURIComponent('wplata_a')}`)), ['p03']);
  assert.deepEqual(ids(await list(backend, `q=${encodeURIComponent('_')}`)), ['p03']);
  assert.deepEqual(ids(await list(backend, `q=${encodeURIComponent('\\')}`)), ['p05']);
  assert.deepEqual(ids(await list(backend, `q=${encodeURIComponent('Żółć')}`)), ['p01']);
  assert.deepEqual(ids(await list(backend, `q=${encodeURIComponent('  składka  ')}`)), ['p02', 'p01']);
  assert.deepEqual(ids(await list(backend, `q=${encodeURIComponent("'; DROP TABLE payment_entries; --")}`)), []);
  assert.equal(Number((await backend.db.query('SELECT count(*)::int AS n FROM payment_entries')).rows[0].n), PAYMENTS.length);
}));

test('GET /api/payments: zły parametr → 400 z kodem, długie q → 400', async () => backendWith(async (backend) => {
  await seedPayments(backend.db);
  const cases = [
    ['dateFrom=2026-13-40', 'invalid_date'],
    ['dateTo=jutro', 'invalid_date'],
    ['dateFrom=2026-10-05&dateTo=2026-10-01', 'invalid_date_range'],
    ['method=blik', 'invalid_method'],
    ['householdId=' + encodeURIComponent('h1 OR 1=1'), 'invalid_request'],
    [`q=${'a'.repeat(101)}`, 'invalid_request'],
    ['status=reversed', 'invalid_request'],
  ];
  for (const [query, code] of cases) {
    const result = await list(backend, query);
    assert.deepEqual([result.status, result.body.error], [400, code], query);
  }
}));

test('GET /api/payments: kursor jest związany z filtrami, a strony z filtrem nie gubią ani nie powtarzają wierszy', async () => backendWith(async (backend) => {
  await seedPayments(backend.db);
  const first = await list(backend, 'method=bank&limit=2');
  assert.deepEqual(ids(first), ['p06', 'p04']);
  assert.ok(first.body.nextCursor);
  const second = await list(backend, `method=bank&limit=2&cursor=${first.body.nextCursor}`);
  assert.deepEqual(ids(second), ['p03', 'p01']);
  assert.equal(second.body.nextCursor, null);
  // Podwójne kliknięcie „Wczytaj następne”: ten sam kursor daje tę samą stronę.
  assert.deepEqual(ids(await list(backend, `method=bank&limit=2&cursor=${first.body.nextCursor}`)), ids(second));

  const otherFilters = [
    'method=cash', 'limit=2', 'method=bank&dateFrom=2026-09-01', 'method=bank&dateTo=2026-12-31',
    'method=bank&q=Sk', 'method=bank&householdId=h1', 'method=bank&status=recorded',
  ];
  for (const query of otherFilters) {
    const result = await list(backend, `${query}${query.includes('limit') ? '' : '&limit=2'}&cursor=${first.body.nextCursor}`);
    assert.deepEqual([result.status, result.body.error], [400, 'invalid_cursor'], query);
  }
  // Kursor bez filtrów nie pasuje do listy z filtrem i odwrotnie.
  const plain = await list(backend, 'limit=2');
  assert.equal((await list(backend, `method=bank&limit=2&cursor=${plain.body.nextCursor}`)).status, 400);
  assert.equal((await list(backend, `limit=2&cursor=${first.body.nextCursor}`)).status, 400);
  assert.equal((await list(backend, `limit=2&cursor=${plain.body.nextCursor}`)).status, 200);
}));

test('GET /api/payments: filtr nie gubi korekt w kwocie netto (wpłata częściowa)', async () => backendWith(async (backend) => {
  await seedPayments(backend.db);
  const response = await backend.fetch(call(backend.cookie, '/api/payments/p02/corrections', { body: { amountCents: 500, reason: 'Korekta syntetyczna' }, key: 'corr-key-filter-1' }));
  assert.equal(response.status, 201);
  const filtered = await list(backend, 'method=cash&dateFrom=2026-09-01&dateTo=2026-09-30&householdId=h1&q=100X');
  assert.equal(filtered.body.payments.length, 1);
  assert.equal(filtered.body.payments[0].correctedCents, 500);
  assert.equal(filtered.body.payments[0].netAmountCents, 2500);
}));

test('GET /api/payments: filtry nie rozszerzają zakresu — rodzina spoza roku daje pustą listę, inne role i lata są odrzucone', async () => backendWith(async (backend) => {
  await seedPayments(backend.db);
  // Gospodarstwo z zeszłego roku nie pojawia się w liście bieżącego roku (bez wyroczni istnienia).
  assert.deepEqual(ids(await list(backend, 'householdId=h-old')), []);
  assert.deepEqual(ids(await list(backend, 'householdId=nie-ma-takiej')), []);
  // Skarbnik przypisany do y2026 nie czyta y2025, także z filtrami.
  const otherYear = await get(backend, '/api/payments?schoolYearId=y2025&q=Sk&method=bank');
  assert.equal(otherYear.status, 403);
  const rep = await seedUserSession(backend.db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', schoolYearId: 'y2026', classId: 'c-1' }] });
  assert.equal((await get(backend, '/api/payments?schoolYearId=y2026&method=bank', rep)).status, 403);
  assert.equal((await get(backend, '/api/payments?schoolYearId=y2026&method=bank', null)).status, 401);
  const noMfa = await seedUserSession(backend.db, { userId: 'u-nomfa', mfa: false, roles: [{ role: 'treasurer', schoolYearId: 'y2026' }] });
  assert.equal((await get(backend, '/api/payments?schoolYearId=y2026&q=x', noMfa)).status, 403);
}));

// --- Księga ------------------------------------------------------------------

async function seedLedger(db) {
  await db.exec(`
    INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by, active) VALUES
      ('cat-fees', 'y2026', 'income', 'Składki dobrowolne', 'u1', true),
      ('cat-other', 'y2026', 'income', 'Inne przychody', 'u1', true),
      ('cat-events', 'y2026', 'expense', 'Wydarzenia', 'u1', true),
      ('cat-old', 'y2025', 'income', 'Składki dobrowolne', 'u1', true);
  `);
}

const LEDGER = [
  ['l01', 'income', 'cat-fees', '2026-09-10'],
  ['l02', 'income', 'cat-fees', '2026-09-20'],
  ['l03', 'income', 'cat-other', '2026-10-05'],
  ['l04', 'income', 'cat-fees', '2026-10-06'],
  ['l05', 'expense', 'cat-events', '2026-10-07'],
];

async function seedEntries(backend) {
  for (const [id, direction, categoryId, occurredOn] of LEDGER) {
    const response = await backend.fetch(call(backend.cookie, '/api/ledger', {
      key: `ledger-filter-${id}`,
      body: { schoolYearId: 'y2026', direction, amountCents: 1000, categoryId, description: `Wpis ${id}`, occurredOn, method: 'bank', source: 'Konto testowe' },
    }));
    assert.equal(response.status, 201, `${id}: ${await response.clone().text()}`);
  }
  // Id wpisów są losowe — mapujemy po opisie.
}

const descriptions = (result) => result.body.entries.map((e) => e.description);
const ledgerList = (backend, query) => get(backend, `/api/ledger?schoolYearId=y2026&${query}`);

test('GET /api/ledger: filtry kategorii i dat w SQL, kursor związany z filtrem, zły parametr → 400', async () => backendWith(async (backend) => {
  await seedLedger(backend.db);
  await seedEntries(backend);
  assert.equal((await ledgerList(backend, '')).body.entries.length, 5);
  assert.deepEqual(descriptions(await ledgerList(backend, 'category=cat-fees')), ['Wpis l04', 'Wpis l02', 'Wpis l01']);
  assert.deepEqual(descriptions(await ledgerList(backend, 'dateFrom=2026-10-05')), ['Wpis l05', 'Wpis l04', 'Wpis l03']);
  assert.deepEqual(descriptions(await ledgerList(backend, 'dateTo=2026-09-20')), ['Wpis l02', 'Wpis l01']);
  assert.deepEqual(descriptions(await ledgerList(backend, 'category=cat-fees&dateFrom=2026-09-15&direction=income')), ['Wpis l04', 'Wpis l02']);
  // Kategoria z innego roku i nieistniejąca: pusta lista, bez ujawniania istnienia.
  assert.deepEqual(descriptions(await ledgerList(backend, 'category=cat-old')), []);
  assert.deepEqual(descriptions(await ledgerList(backend, 'category=brak')), []);

  const first = await ledgerList(backend, 'category=cat-fees&limit=2');
  assert.deepEqual(descriptions(first), ['Wpis l04', 'Wpis l02']);
  const second = await ledgerList(backend, `category=cat-fees&limit=2&cursor=${first.body.nextCursor}`);
  assert.deepEqual(descriptions(second), ['Wpis l01']);
  assert.equal(second.body.nextCursor, null);
  for (const query of ['category=cat-other', 'limit=2', 'category=cat-fees&dateFrom=2026-01-01', 'category=cat-fees&dateTo=2026-12-31', 'category=cat-fees&direction=income']) {
    const result = await ledgerList(backend, `${query}${query.includes('limit') ? '' : '&limit=2'}&cursor=${first.body.nextCursor}`);
    assert.deepEqual([result.status, result.body.error], [400, 'invalid_cursor'], query);
  }

  const cases = [
    ['dateFrom=2026-02-30', 'invalid_date'],
    ['dateTo=x', 'invalid_date'],
    ['dateFrom=2026-10-05&dateTo=2026-10-01', 'invalid_date_range'],
    [`category=${encodeURIComponent('a b')}`, 'invalid_request'],
  ];
  for (const [query, code] of cases) {
    const result = await ledgerList(backend, query);
    assert.deepEqual([result.status, result.body.error], [400, code], query);
  }
}));

test('GET /api/ledger: filtry nie rozszerzają uprawnień', async () => backendWith(async (backend) => {
  await seedLedger(backend.db);
  assert.equal((await get(backend, '/api/ledger?schoolYearId=y2025&category=cat-old&dateFrom=2025-09-01')).status, 403);
  const rep = await seedUserSession(backend.db, { userId: 'u-rep', mfa: true, roles: [{ role: 'representative', schoolYearId: 'y2026', classId: 'c-1' }] });
  assert.equal((await get(backend, '/api/ledger?schoolYearId=y2026&category=cat-fees', rep)).status, 403);
  assert.equal((await get(backend, '/api/ledger?schoolYearId=y2026&category=cat-fees', null)).status, 401);
}));
