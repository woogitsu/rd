// Klasyfikacja błędów bazy w routerze (#156): stany biznesowe -> 409, błędy
// przejściowe -> 503 + Retry-After, ograniczenia bazy -> 4xx, reszta -> 503 bez szczegółów; nagłówek
// Allow przy każdym 405. Wyłącznie dane syntetyczne.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDbError } from '../src/pg/db-errors.js';
import { BUSINESS_STATE_CODES, BUG_STATE_CODES, IMMUTABILITY_PATTERN } from '../src/pg/business-state-codes.js';
import { createPgHandler, handlePgRequest, ROUTES } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUser, seedUserSession } from './helpers/pg.js';

describe('#156: classifyDbError (jednostkowo)', () => {
  test('komunikat triggera zamrożenia roku -> business, 409', () => {
    assert.deepEqual(classifyDbError(new Error('school_year_closed')),
      { error: 'school_year_closed', status: 409, class: 'business' });
    assert.deepEqual(classifyDbError(new Error('school_year_closure_is_final')),
      { error: 'school_year_closed', status: 409, class: 'business' });
  });

  test('SQLSTATE przejściowe -> transient, 503 + retryAfter', () => {
    for (const code of ['40001', '40P01', '55P03']) {
      const error = Object.assign(new Error('x'), { code });
      assert.deepEqual(classifyDbError(error), { error: 'retry_later', status: 503, retryAfter: 1, class: 'transient' });
    }
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    assert.deepEqual(classifyDbError(timeout), { error: 'timeout', status: 503, retryAfter: 5, class: 'transient' });
  });

  test('nieznany błąd -> bug, 503 service_unavailable bez retryAfter (jak dotychczas)', () => {
    assert.deepEqual(classifyDbError(new Error('cokolwiek nieznanego')),
      { error: 'service_unavailable', status: 503, class: 'bug' });
    assert.deepEqual(classifyDbError(Object.assign(new Error('x'), { code: '22012' })),
      { error: 'service_unavailable', status: 503, class: 'bug' });
  });

  test('ograniczenia klasy 23 i wyjątki triggerów -> business (#156)', () => {
    const withCode = (code, message = 'x') => Object.assign(new Error(message), { code });
    assert.deepEqual(classifyDbError(withCode('23505')), { error: 'conflict', status: 409, class: 'business' });
    assert.deepEqual(classifyDbError(withCode('23503')), { error: 'invalid_reference', status: 400, class: 'business' });
    assert.deepEqual(classifyDbError(withCode('23514')), { error: 'invalid_request', status: 400, class: 'business' });
    assert.deepEqual(classifyDbError(withCode('23502')), { error: 'invalid_request', status: 400, class: 'business' });
    assert.deepEqual(classifyDbError(withCode('P0001', 'payment_financial_facts_immutable')),
      { error: 'business_rule_violation', status: 409, class: 'business' });
    assert.equal(classifyDbError(withCode('P0001', 'audit_down')).status, 503);
    assert.equal(classifyDbError(withCode('P0001', 'year_freeze_unknown_table')).status, 503);
    assert.deepEqual(classifyDbError(withCode('P0001', 'invalid_reference')), { error: 'invalid_reference', status: 400, class: 'business' });
    // Tekst niebędący samym kodem stanu nie jest traktowany jako stan biznesowy.
    assert.equal(classifyDbError(withCode('P0001', 'Wartość klienta: jan@example.invalid')).status, 503);
  });
});

describe('#156: klasyfikacja wszystkich kodów RAISE EXCEPTION z migracji', () => {
  test('każdy literalny kod z postgres/migrations jest sklasyfikowany (nowy trigger bez klasyfikacji = błąd testu)', async () => {
    const { loadMigrations } = await import('../src/postgres-migrations.js');
    const dir = new URL('../postgres/migrations/', import.meta.url).pathname;
    const codes = new Set();
    for (const migration of await loadMigrations(dir)) {
      for (const match of migration.sql.matchAll(/RAISE EXCEPTION '([a-z][a-z0-9_]*)'/g)) codes.add(match[1]);
    }
    assert.ok(codes.size > 100);
    const special = new Set(['school_year_closed', 'school_year_closure_is_final', 'invalid_reference']);
    const unclassified = [...codes].filter((code) => !special.has(code)
      && !BUSINESS_STATE_CODES.has(code) && !BUG_STATE_CODES.has(code) && !IMMUTABILITY_PATTERN.test(code));
    assert.deepEqual(unclassified, [], 'dopisz kod do src/pg/business-state-codes.js (BUSINESS_STATE_CODES albo BUG_STATE_CODES)');
    for (const code of BUSINESS_STATE_CODES) assert.ok(codes.has(code), `martwy kod na liście: ${code}`);
  });
});

// Trasa testowa symulująca moduł BEZ własnego mapDatabaseError — dokładnie
// przypadek, który app.js ma teraz klasyfikować zamiast zawsze zwracać 503.
function throwingProbe(errorFactory) {
  return {
    name: 'throwing-probe',
    async handle(req, env, url) {
      if (url.pathname !== '/api/probe/throw') return null;
      throw errorFactory();
    },
  };
}

describe('#156: app.js — siec bezpieczeństwa dla modułu bez własnego mapowania', () => {
  test('nieprzechwycony school_year_closed -> 409, nie 503', async () => {
    const db = await createTestDb();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-1' });
      const handler = createPgHandler([...ROUTES, throwingProbe(() => new Error('school_year_closed'))]);
      const res = await handler(request('/api/probe/throw', { cookie }), { db });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: 'school_year_closed' });
    } finally {
      await db.close();
    }
  });

  test('nieprzechwycony deadlock (40P01) -> 503 z Retry-After', async () => {
    const db = await createTestDb();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-1' });
      const handler = createPgHandler([...ROUTES, throwingProbe(() => Object.assign(new Error('deadlock detected'), { code: '40P01' }))]);
      const res = await handler(request('/api/probe/throw', { cookie }), { db });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('Retry-After'), '1');
      assert.deepEqual(await res.json(), { error: 'retry_later' });
    } finally {
      await db.close();
    }
  });

  test('nieprzechwycony query_canceled (57014) -> 503 z Retry-After: 5', async () => {
    const db = await createTestDb();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-1' });
      const handler = createPgHandler([...ROUTES, throwingProbe(() => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))]);
      const res = await handler(request('/api/probe/throw', { cookie }), { db });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('Retry-After'), '5');
      assert.deepEqual(await res.json(), { error: 'timeout' });
    } finally {
      await db.close();
    }
  });

  test('inny nieznany błąd -> 503 service_unavailable bez Retry-After (jak dotychczas)', async () => {
    const db = await createTestDb();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-1' });
      const handler = createPgHandler([...ROUTES, throwingProbe(() => new Error('cos innego'))]);
      const res = await handler(request('/api/probe/throw', { cookie }), { db });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('Retry-After'), null);
      assert.deepEqual(await res.json(), { error: 'service_unavailable' });
    } finally {
      await db.close();
    }
  });
});

// Prawdziwe ograniczenia i triggery z postgres/migrations (PGlite), przez router.
// Trasa testowa wykonuje SQL i nie tłumaczy błędu — robi to app.js.
function sqlProbe(sql, params = []) {
  return {
    name: 'sql-probe',
    async handle(req, env, url) {
      if (url.pathname !== '/api/probe/sql') return null;
      await env.db.query(sql, params);
      return new Response('{}', { status: 200 });
    },
  };
}

async function probe(db, sql, params) {
  const cookie = await seedUserSession(db, { userId: 'u-1' });
  const handler = createPgHandler([...ROUTES, sqlProbe(sql, params)]);
  const res = await handler(request('/api/probe/sql', { cookie }), { db });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

describe('#156: prawdziwe ograniczenia i triggery bazy -> właściwe kody 4xx', () => {
  test('23505: duplikat klucza -> 409 conflict, bez treści SQL', async () => {
    const db = await createTestDb();
    try {
      await seedSchoolYear(db, 'y-dup');
      const r = await probe(db, `INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ('y-dup', 'inna', '2030-09-01', '2031-08-31')`);
      assert.equal(r.status, 409);
      assert.deepEqual(r.body, { error: 'conflict' });
    } finally { await db.close(); }
  });

  test('23503: brak wskazanego rekordu -> 400 invalid_reference', async () => {
    const db = await createTestDb();
    try {
      const r = await probe(db, `INSERT INTO classes (id, school_year_id, name) VALUES ('c-x', 'y-brak', '1A')`);
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: 'invalid_reference' });
    } finally { await db.close(); }
  });

  test('23514: naruszenie CHECK -> 400 invalid_request', async () => {
    const db = await createTestDb();
    try {
      const r = await probe(db, `INSERT INTO school_years (id, label, starts_on, ends_on) VALUES ('y-bad', 'zly', '2027-09-01', '2026-09-01')`);
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: 'invalid_request' });
    } finally { await db.close(); }
  });

  test('trigger niezmienności (P0001, snake_case) -> 409 business_rule_violation', async () => {
    const db = await createTestDb();
    try {
      await db.query(`INSERT INTO audit_events (id, action, entity_type, entity_id) VALUES ('a-1', 'test.event', 'test', 't-1')`);
      const r = await probe(db, `UPDATE audit_events SET action = 'zmiana'`);
      assert.equal(r.status, 409);
      assert.deepEqual(r.body, { error: 'business_rule_violation' });
    } finally { await db.close(); }
  });

  test('trigger zamrożenia roku (rzeczywista migracja 0017) -> 409 school_year_closed', async () => {
    const db = await createTestDb();
    try {
      await seedSchoolYear(db, 'y-closed', { startsOn: '2026-09-01', endsOn: '2027-08-31' });
      await seedSchoolYear(db, 'y-next', { startsOn: '2027-09-01', endsOn: '2028-08-31' });
      await seedUser(db, { userId: 'u-target' });
      await seedUser(db, { userId: 'u-other' });
      // Zamknięcie „na skróty” (wzorzec z tests/pg-events-ics.test.js): sam trigger zamrożenia jest prawdziwy.
      await db.exec(`
        SET session_replication_role = replica;
        INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
          closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
          carried_opening_balance_id, expired_grant_count)
        VALUES ('cl-1', 'y-closed', 'y-next', 'closed', 'u-target', 'u-other', now(), 0, 0, 0, 0, 'ob-1', 0);
        SET session_replication_role = origin;
      `);
      const r = await probe(db, `INSERT INTO role_grants (id, user_id, role, school_year_id) VALUES ('g-1', 'u-target', 'audit', 'y-closed')`);
      assert.equal(r.status, 409);
      assert.deepEqual(r.body, { error: 'school_year_closed' });
    } finally { await db.close(); }
  });

  test('błąd nieprzewidziany (dzielenie przez zero) -> 503 service_unavailable bez szczegółów SQL', async () => {
    const db = await createTestDb();
    try {
      const r = await probe(db, `SELECT 1/0`);
      assert.equal(r.status, 503);
      assert.deepEqual(r.body, { error: 'service_unavailable' });
      assert.ok(!/division|zero/i.test(r.text));
    } finally { await db.close(); }
  });

  test('trigger z komunikatem będącym zdaniem z danymi -> 503, treść nie wycieka', async () => {
    const db = await createTestDb();
    try {
      await db.exec(`CREATE TABLE probe_t (v int);
        CREATE FUNCTION probe_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Wartosc tajna jan@example.invalid'; END $$;
        CREATE TRIGGER probe_trg BEFORE INSERT ON probe_t FOR EACH ROW EXECUTE FUNCTION probe_fn();`);
      const r = await probe(db, `INSERT INTO probe_t VALUES (1)`);
      assert.equal(r.status, 503);
      assert.ok(!r.text.includes('example.invalid'));
    } finally { await db.close(); }
  });
});

// Nagłówek Allow przy 405 (RFC 9110 §15.5.6) — luki znalezione w #156.
describe('#156: nagłówek Allow przy 405', () => {
  const cases = [
    ['PATCH', '/api/public/events'],
    ['POST', '/api/public/news'],
    ['DELETE', '/api/meetings'],
    ['DELETE', '/api/admin/grants'],
    ['DELETE', '/api/email/webhooks/brevo'],
    ['DELETE', '/api/email/campaigns'],
    ['DELETE', '/api/reconciliations'],
    ['POST', '/api/reports/audit'],
    ['GET', '/api/import/preview'],
    ['DELETE', '/api/year-close/y-2026'],
    ['DELETE', '/api/year-close/y-2026/start'],
  ];

  test('każda odpowiedź 405 z tras zmienionych w #156 ma nagłówek Allow', async () => {
    const db = await createTestDb();
    try {
      const cookie = await seedUserSession(db, { userId: 'u-board', mfa: true, roles: [{ role: 'board' }] });
      for (const [method, path] of cases) {
        const res = await handlePgRequest(request(path, { method, cookie }), { db });
        if (res.status !== 405) continue; // niektóre kombinacje trafiają w 401/403 wcześniej — to nie jest przedmiotem tego testu
        assert.ok(res.headers.get('Allow'), `${method} ${path} -> 405 bez nagłówka Allow`);
      }
    } finally {
      await db.close();
    }
  });
});
