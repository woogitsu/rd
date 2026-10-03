// Równoważność API księgi (issue #41, część B): stary Worker (D1) kontra handlePgRequest (PGlite).
// Ten sam scenariusz na tych samych danych syntetycznych; porównanie statusu, WSZYSTKICH
// nagłówków i ciała po normalizacji (tests/helpers/parity.js), a do tego granice ról
// (MFA, zakres roku, przedstawiciel klasy), których pełny scenariusz zapisów w
// tests/pg-ledger-api.test.js nie porównuje ze starym Workerem.
// Wyniki i uzasadnione różnice: docs/EQUIVALENCE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { hashSecret } from '../src/auth.js';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb } from './helpers/pg.js';
import { assertSameScenario, createLegacyDb, createNormalizer, d1Adapter, snapshotResponse } from './helpers/parity.js';

const BASE = 'https://rd.example';
const token = (char) => char.repeat(43);
const cookieOf = (char) => `rd_session=${token(char)}`;

const TREASURER = 'T';
const NO_MFA = 'N';
const BOARD = 'B';
const REPRESENTATIVE = 'R';
const OTHER_YEAR = 'Y';
const NO_ROLE = 'Z';

// Wspólny, syntetyczny stan obu baz. Czas w formacie CURRENT_TIMESTAMP D1;
// w PostgreSQL ten sam zapis jest rzutowany na UTC (patrz `utc`).
const FIXTURE = {
  users: ['treasurer', 'nomfa', 'board', 'rep', 'otheryear', 'norole'],
  grants: [
    { id: 'g-tr', userId: 'treasurer', role: 'treasurer', schoolYearId: 'y2026' },
    { id: 'g-nomfa', userId: 'nomfa', role: 'treasurer', schoolYearId: 'y2026' },
    { id: 'g-board', userId: 'board', role: 'board', schoolYearId: 'y2026' },
    { id: 'g-rep', userId: 'rep', role: 'representative', classId: 'c-1a', schoolYearId: 'y2026' },
    { id: 'g-other', userId: 'otheryear', role: 'treasurer', schoolYearId: 'y2025' },
  ],
  sessions: [
    { id: 's-tr', userId: 'treasurer', char: TREASURER, mfa: true },
    { id: 's-nomfa', userId: 'nomfa', char: NO_MFA, mfa: false },
    { id: 's-board', userId: 'board', char: BOARD, mfa: true },
    { id: 's-rep', userId: 'rep', char: REPRESENTATIVE, mfa: true },
    { id: 's-other', userId: 'otheryear', char: OTHER_YEAR, mfa: true },
    { id: 's-norole', userId: 'norole', char: NO_ROLE, mfa: true },
  ],
};
const CREATED_AT = '2026-09-27 07:00:00';
const MFA_AT = '2026-09-27 08:00:00';
const utc = (value) => `${value.replace(' ', 'T')}Z`;

// Dowód księgowy: w PostgreSQL wyłącznie dokument finansowy z API tego samego roku (#87).
const PG_DOCUMENT_SQL = `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by,
    school_year_id, sha256, idempotency_key)
  VALUES ('d1', 'docs/00000000-0000-4000-8000-00000000d001', 'application/pdf', 1200, 'financial', 'treasurer',
    'y2026', '${'a'.repeat(64)}', 'seed-document-0001');`;
const LEGACY_DOCUMENT_SQL = `INSERT INTO documents (id, object_key, mime_type, byte_size, kind, created_by)
  VALUES ('d1', 'synthetic/source.pdf', 'application/pdf', 1200, 'receipt', 'treasurer');`;

function seedSql(falseValue, documentSql) {
  return `
    INSERT INTO households (id) VALUES ('h1'), ('h2');
    ${documentSql}
    INSERT INTO ledger_categories (id, school_year_id, direction, name, created_by, active) VALUES
      ('income-fees', 'y2026', 'income', 'Składki dobrowolne', 'treasurer', NOT ${falseValue}),
      ('expense-events', 'y2026', 'expense', 'Wydarzenia', 'treasurer', NOT ${falseValue}),
      ('expense-old', 'y2026', 'expense', 'Archiwalna', 'treasurer', ${falseValue}),
      ('expense-2025', 'y2025', 'expense', 'Wydarzenia', 'treasurer', NOT ${falseValue});
    INSERT INTO payment_entries (id, household_id, school_year_id, amount_cents, received_on, method, status, created_by, idempotency_key) VALUES
      ('p1', 'h1', 'y2026', 5000, '2026-09-20', 'bank', 'recorded', 'treasurer', 'seed-payment-0001'),
      ('p2', NULL, 'y2026', 3000, '2026-09-21', 'bank', 'unmatched', 'treasurer', 'seed-payment-0002');
    INSERT INTO ledger_opening_balances (id, school_year_id, amount_cents, note, created_by, idempotency_key)
      VALUES ('ob1', 'y2026', 100000, 'Bilans syntetyczny', 'treasurer', 'seed-opening-0001');
    INSERT INTO ledger_budget_lines (id, school_year_id, category_id, planned_cents, note, created_by, idempotency_key)
      VALUES ('bl1', 'y2026', 'expense-events', 20000, 'Plan początkowy', 'treasurer', 'seed-budget-0001');
  `;
}

const YEARS_SQL = `
  INSERT INTO school_years (id, label, starts_on, ends_on) VALUES
    ('y2025', 'test y2025', '2025-09-01', '2026-08-31'),
    ('y2026', 'test y2026', '2026-09-01', '2027-08-31');
  INSERT INTO classes (id, school_year_id, name) VALUES ('c-1a', 'y2026', '1A');
`;

async function legacyBackend() {
  const db = createLegacyDb();
  db.exec(YEARS_SQL);
  for (const id of FIXTURE.users) {
    db.prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)').run(id, `${id}@example.invalid`, `Test ${id}`);
  }
  for (const grant of FIXTURE.grants) {
    db.prepare('INSERT INTO role_grants (id, user_id, role, class_id, school_year_id) VALUES (?, ?, ?, ?, ?)')
      .run(grant.id, grant.userId, grant.role, grant.classId ?? null, grant.schoolYearId);
  }
  db.exec(seedSql('0', LEGACY_DOCUMENT_SQL));
  for (const session of FIXTURE.sessions) {
    db.prepare(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, mfa_verified_at)
                VALUES (?, ?, ?, ?, '2099-01-01 00:00:00', ?)`)
      .run(session.id, session.userId, await hashSecret(token(session.char)), CREATED_AT, session.mfa ? MFA_AT : null);
  }
  const env = { DB: d1Adapter(db) };
  return {
    kind: 'legacy',
    fetch: (req) => worker.fetch(req, env),
    close: async () => db.close(),
  };
}

async function pgBackend() {
  const db = await createTestDb();
  await db.exec(YEARS_SQL);
  for (const id of FIXTURE.users) {
    await db.query('INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)', [id, `${id}@example.invalid`, `Test ${id}`]);
  }
  for (const grant of FIXTURE.grants) {
    await db.query('INSERT INTO role_grants (id, user_id, role, class_id, school_year_id) VALUES ($1, $2, $3, $4, $5)',
      [grant.id, grant.userId, grant.role, grant.classId ?? null, grant.schoolYearId]);
  }
  await db.exec(seedSql('false', PG_DOCUMENT_SQL));
  for (const session of FIXTURE.sessions) {
    await db.query(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, mfa_verified_at)
                    VALUES ($1, $2, $3, $4, '2099-01-01T00:00:00Z', $5)`,
    [session.id, session.userId, await hashSecret(token(session.char)), utc(CREATED_AT), session.mfa ? utc(MFA_AT) : null]);
  }
  // Limit bezczynności sesji (#150) to polityka tylko PostgreSQL, a fixture ma stały
  // `created_at`; wyłączamy go jak w tests/api-parity-session.test.js.
  const env = { db, SESSION_IDLE_TIMEOUT_SECONDS: '0' };
  return {
    kind: 'pg',
    fetch: (req) => handlePgRequest(req, env),
    count: async (table) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n),
    close: () => db.close(),
  };
}

function call(path, { method, cookie, body, key, origin = BASE, contentType = 'application/json' } = {}) {
  const upper = method ?? (body === undefined ? 'GET' : 'POST');
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (upper !== 'GET' && origin) headers.set('Origin', origin);
  if (key) headers.set('Idempotency-Key', key);
  if (upper !== 'GET' && body !== undefined) headers.set('Content-Type', contentType);
  return new Request(`${BASE}${path}`, { method: upper, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

// Rozszerzenia odpowiedzi tylko w PostgreSQL (#87 `attachmentIds`, #82 `attachments`):
// Worker ich nie zna, pokrywają je osobne testy (tests/pg-ledger-api.test.js).
const PG_ONLY_FIELDS = new Set(['attachmentIds', 'attachments']);
function withoutPgOnlyFields(value) {
  if (Array.isArray(value)) return value.map(withoutPgOnlyFields);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !PG_ONLY_FIELDS.has(key)).map(([key, item]) => [key, withoutPgOnlyFields(item)]));
  }
  return value;
}

// Oba backendy losują UUID, a wpisy z tą samą datą sortują się po id; rosnące UUID
// w obu przebiegach dają tę samą kolejność remisów (nie zmienia kontraktu).
async function withSequentialUuids(fn) {
  const original = crypto.randomUUID;
  let counter = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  try { return await fn(); } finally { crypto.randomUUID = original; }
}

const expense = {
  schoolYearId: 'y2026', direction: 'expense', amountCents: 12500, categoryId: 'expense-events',
  description: 'Syntetyczny wydatek wydarzenia', occurredOn: '2026-09-27', method: 'bank', source: 'Konto testowe', sourceDocumentId: 'd1',
};
const income = {
  schoolYearId: 'y2026', direction: 'income', amountCents: 5000, categoryId: 'income-fees',
  description: 'Syntetyczne ujęcie wpłaty', occurredOn: '2026-09-20', method: 'bank', paymentEntryId: 'p1',
};

async function runScenario(backend) {
  const normalize = createNormalizer({ cursorKeys: ['nextCursor'] });
  const steps = [];
  const step = async (label, request) => {
    const response = await backend.fetch(request);
    // Surowe ciało (identyfikatory i kursory) służy do budowania kolejnych żądań; porównuje się wersję znormalizowaną.
    const raw = await response.clone().json().catch(() => null);
    steps.push({ label, ...await snapshotResponse(response, (value) => normalize(withoutPgOnlyFields(value))) });
    return raw;
  };
  const t = cookieOf(TREASURER);

  // Granice ról na każdej trasie księgi (odczyt i zapis).
  for (const [who, char] of [['no session', null], ['no MFA', NO_MFA], ['representative', REPRESENTATIVE], ['no role', NO_ROLE], ['other year', OTHER_YEAR]]) {
    const cookie = char ? cookieOf(char) : undefined;
    await step(`${who}: list`, call('/api/ledger?schoolYearId=y2026', { cookie }));
    await step(`${who}: categories`, call('/api/ledger/categories?schoolYearId=y2026', { cookie }));
    await step(`${who}: summary`, call('/api/ledger/summary?schoolYearId=y2026', { cookie }));
    await step(`${who}: budget`, call('/api/ledger/budget?schoolYearId=y2026', { cookie }));
    await step(`${who}: create`, call('/api/ledger', { cookie, body: expense, key: `denied-${char ?? 'none'}-0001` }));
  }

  // Skarbnik: odczyty przed zapisami.
  await step('treasurer: categories', call('/api/ledger/categories?schoolYearId=y2026', { cookie: t }));
  await step('treasurer: categories expense', call('/api/ledger/categories?schoolYearId=y2026&direction=expense', { cookie: t }));
  await step('treasurer: summary empty', call('/api/ledger/summary?schoolYearId=y2026', { cookie: t }));
  await step('treasurer: budget', call('/api/ledger/budget?schoolYearId=y2026', { cookie: t }));
  await step('treasurer: other year (no grant)', call('/api/ledger?schoolYearId=y2025', { cookie: t }));
  await step('treasurer: unknown year', call('/api/ledger?schoolYearId=y-missing', { cookie: t }));

  // Zapisy: tworzenie, ponowienie, konflikt klucza, powiązana wpłata, próg 3000 EUR.
  const e1 = (await step('create', call('/api/ledger', { cookie: t, body: expense, key: 'ledger-key-0001' }))).entry.id;
  // Odmowa korekty istniejącego wpisu (decyzja o uprawnieniu zależy od roku wpisu).
  const correctionPath = `/api/ledger/${e1}/corrections`;
  for (const [who, char] of [['no session', null], ['no MFA', NO_MFA], ['representative', REPRESENTATIVE], ['no role', NO_ROLE], ['other year', OTHER_YEAR]]) {
    await step(`${who}: correct existing entry`, call(correctionPath, {
      cookie: char ? cookieOf(char) : undefined, body: { amountCents: 100, reason: 'Odmowa' }, key: `denied-${char ?? 'none'}-0002`,
    }));
  }
  await step('representative: correct unknown entry', call('/api/ledger/missing-id/corrections', {
    cookie: cookieOf(REPRESENTATIVE), body: { amountCents: 100, reason: 'Odmowa' }, key: 'denied-R-0003',
  }));
  await step('create retry', call('/api/ledger', { cookie: t, body: expense, key: 'ledger-key-0001' }));
  await step('create conflict', call('/api/ledger', { cookie: t, body: { ...expense, amountCents: 12600 }, key: 'ledger-key-0001' }));
  await step('create income linked', call('/api/ledger', { cookie: t, body: income, key: 'ledger-key-0002' }));
  await step('link payment twice', call('/api/ledger', { cookie: t, body: { ...income, description: 'Drugie ujęcie tej wpłaty' }, key: 'ledger-key-0003' }));
  await step('link unmatched payment', call('/api/ledger', { cookie: t, body: { ...income, paymentEntryId: 'p2' }, key: 'ledger-key-0004' }));
  await step('category inactive', call('/api/ledger', { cookie: t, body: { ...expense, categoryId: 'expense-old' }, key: 'ledger-key-0005' }));
  await step('category other year', call('/api/ledger', { cookie: t, body: { ...expense, categoryId: 'expense-2025' }, key: 'ledger-key-0006' }));
  await step('expense exactly 3000 EUR', call('/api/ledger', { cookie: t, body: { ...expense, amountCents: 300000, sourceDocumentId: null, occurredOn: '2026-09-25' }, key: 'ledger-key-0007' }));
  await step('expense over 3000 EUR without resolution', call('/api/ledger', { cookie: t, body: { ...expense, amountCents: 300001 }, key: 'ledger-key-0008' }));
  await step('expense over 3000 EUR with resolution', call('/api/ledger', {
    cookie: t, body: { ...expense, amountCents: 450000, resolutionReference: 'Uchwała syntetyczna 1/2026', occurredOn: '2026-09-26' }, key: 'ledger-key-0009',
  }));
  await step('create without Origin', call('/api/ledger', { cookie: t, body: expense, key: 'ledger-key-0010', origin: null }));
  await step('create foreign Origin', call('/api/ledger', { cookie: t, body: expense, key: 'ledger-key-0011', origin: 'https://evil.example' }));
  await step('create without key', call('/api/ledger', { cookie: t, body: expense }));
  await step('create text/plain', call('/api/ledger', { cookie: t, body: expense, key: 'ledger-key-0012', contentType: 'text/plain' }));

  // Korekty częściowe do zera, ponowienie i przekroczenie.
  const path = correctionPath;
  await step('correct', call(path, { cookie: t, body: { amountCents: 2500, reason: 'Syntetyczna korekta częściowa' }, key: 'corr-key-0001' }));
  await step('correct retry', call(path, { cookie: t, body: { amountCents: 2500, reason: 'Syntetyczna korekta częściowa' }, key: 'corr-key-0001' }));
  await step('correct conflict', call(path, { cookie: t, body: { amountCents: 2500, reason: 'Inny powód' }, key: 'corr-key-0001' }));
  await step('correct excessive', call(path, { cookie: t, body: { amountCents: 10001, reason: 'Za dużo' }, key: 'corr-key-0002' }));
  await step('correct rest', call(path, { cookie: t, body: { amountCents: 10000, reason: 'Reszta kwoty' }, key: 'corr-key-0003' }));
  await step('correct beyond zero', call(path, { cookie: t, body: { amountCents: 1, reason: 'Jeszcze jeden' }, key: 'corr-key-0004' }));
  await step('correct missing entry', call('/api/ledger/missing-id/corrections', { cookie: t, body: { amountCents: 1, reason: 'Brak wpisu' }, key: 'corr-key-0005' }));

  // Odczyty po zapisach: stronicowanie kursorem, filtry, podsumowanie, zarząd z MFA.
  const page1 = await step('list page 1', call('/api/ledger?schoolYearId=y2026&limit=3', { cookie: t }));
  await step('list page 2', call(`/api/ledger?schoolYearId=y2026&limit=3&cursor=${page1.nextCursor}`, { cookie: t }));
  await step('list expense', call('/api/ledger?schoolYearId=y2026&direction=expense', { cookie: t }));
  await step('list bad direction', call('/api/ledger?schoolYearId=y2026&direction=x', { cookie: t }));
  await step('list bad limit', call('/api/ledger?schoolYearId=y2026&limit=101', { cookie: t }));
  await step('list bad cursor', call('/api/ledger?schoolYearId=y2026&cursor=not-a-cursor', { cookie: t }));
  await step('list no year', call('/api/ledger', { cookie: t }));
  await step('summary after', call('/api/ledger/summary?schoolYearId=y2026', { cookie: t }));
  await step('budget after', call('/api/ledger/budget?schoolYearId=y2026', { cookie: t }));
  await step('board: list', call('/api/ledger?schoolYearId=y2026', { cookie: cookieOf(BOARD) }));
  await step('board: summary', call('/api/ledger/summary?schoolYearId=y2026', { cookie: cookieOf(BOARD) }));
  await step('PUT /api/ledger', call('/api/ledger', { cookie: t, method: 'PUT', body: expense, key: 'ledger-key-0040' }));
  await step('POST /api/ledger/summary', call('/api/ledger/summary', { cookie: t, body: {}, key: 'ledger-key-0041' }));
  return steps;
}

// Uzasadnione różnice (opis w docs/EQUIVALENCE.md). Każda inna różnica = błąd testu.
const NO_MFA_REASON = 'konto z rolą finansową bez MFA: stary Worker zwraca ogólne forbidden, nowy API odróżnia brak MFA (mfa_enrollment_required) od braku roli; status 403 ten sam';
const ALLOWED = {
  ...Object.fromEntries(['list', 'categories', 'summary', 'budget', 'create', 'correct existing entry'].map((route) => [`no MFA: ${route}`, {
    legacy: { status: 403, error: 'forbidden' }, pg: { status: 403, error: 'mfa_enrollment_required' }, reason: NO_MFA_REASON,
  }])),
  'representative: correct unknown entry': {
    legacy: { status: 404, error: 'ledger_entry_not_found' }, pg: { status: 403, error: 'forbidden' },
    reason: 'nowy API odmawia roli bez uprawnień do księgi (403) przed szukaniem wpisu, więc nie zdradza, czy wpis istnieje; Worker najpierw szuka wpisu (404)',
  },
};

test('GET/POST /api/ledger: stary Worker i router PostgreSQL zwracają te same statusy, nagłówki i ciała (z jawnie opisanymi różnicami)', async () => {
  const legacy = await legacyBackend();
  const pg = await pgBackend();
  try {
    const expected = await withSequentialUuids(() => runScenario(legacy));
    const actual = await withSequentialUuids(() => runScenario(pg));
    assertSameScenario(expected, actual, { allowed: ALLOWED });

    // Scenariusz obejmuje sukcesy, odmowy ról i konflikty, nie same błędy.
    const statuses = new Set(expected.map((s) => s.status));
    for (const status of [200, 201, 400, 401, 403, 409]) assert.ok(statuses.has(status), `status ${status} in scenario`);
    assert.equal(expected.find((s) => s.label === 'create').status, 201);
    assert.equal(actual.find((s) => s.label === 'treasurer: summary empty').status, 200);
    assert.equal(await pg.count('ledger_entries'), 4);
    assert.equal(await pg.count('ledger_corrections'), 2);
  } finally {
    await legacy.close();
    await pg.close();
  }
});
