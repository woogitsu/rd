// Kategorie księgi przez API zamiast SQL co roku (#207, część 1/3 audytu
// cyklu roku: krok 7 „tylko SQL” i krok 19 „znów SQL” w nowym roku).
// Wyłącznie dane syntetyczne.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { handlePgRequest } from '../src/pg/app.js';
import { createTestDb, request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const Y = 'y-2026';
const Y_OTHER = 'y-2025';
const Y_CLOSED = 'y-closed';
const Y_NEXT = 'y-next';

async function call(env, path, { cookie, body } = {}) {
  const response = await handlePgRequest(request(path, { cookie, method: body ? 'POST' : 'GET', body }), env);
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

// Zamknięcie „na skróty” (wzorzec z tests/pg-year-close-finance-freeze.test.js):
// interesuje nas wyłącznie reakcja triggera a0_year_freeze, nie procedura /close.
async function closeYear(db) {
  await seedSchoolYear(db, Y_CLOSED);
  await seedSchoolYear(db, Y_NEXT);
  await db.exec(`
    SET session_replication_role = replica;
    INSERT INTO school_year_closures (id, school_year_id, next_school_year_id, status, initiated_by,
      closed_by, closed_at, income_cents, expense_cents, opening_balance_cents, closing_balance_cents,
      carried_opening_balance_id, expired_grant_count)
    VALUES ('clo-cat-1', '${Y_CLOSED}', '${Y_NEXT}', 'closed', 'u-a', 'u-b', now(), 0, 0, 0, 0, 'ob-next-cat', 0);
    SET session_replication_role = origin;
  `);
}

describe('kategorie księgi przez API (#207)', () => {
  test('granice ról: przedstawiciel i audit → 403; brak sesji → 401; niepoprawne dane → 400', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    const rep = await seedUserSession(db, { userId: 'u-rep', roles: [{ role: 'representative', classId: 'c-x', schoolYearId: Y }] });
    const audit = await seedUserSession(db, { userId: 'u-audit', roles: [{ role: 'audit' }], mfa: true });
    for (const cookie of [rep, audit]) {
      assert.equal((await call(env, '/api/ledger/categories', { cookie, body: { schoolYearId: Y, direction: 'income', name: 'Test' } })).status, 403);
    }
    assert.equal((await call(env, '/api/ledger/categories', { body: { schoolYearId: Y, direction: 'income', name: 'Test' } })).status, 401);
    const admin = await seedUserSession(db, { userId: 'u-admin', roles: [{ role: 'admin' }], mfa: true });
    assert.equal((await call(env, '/api/ledger/categories', { cookie: admin, body: { schoolYearId: Y, direction: 'nope', name: 'Test' } })).status, 400);
    assert.equal((await call(env, '/api/ledger/categories', { cookie: admin, body: { schoolYearId: Y, direction: 'income', name: 'X' } })).status, 400);
    await db.close();
  });

  test('zarząd przydzielony do jednego roku nie tworzy kategorii w innym roku', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    await seedSchoolYear(db, Y_OTHER);
    const env = { db };
    const boardY = await seedUserSession(db, { userId: 'u-board-y', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
    const denied = await call(env, '/api/ledger/categories', { cookie: boardY, body: { schoolYearId: Y_OTHER, direction: 'income', name: 'Składki' } });
    assert.equal(denied.status, 403);
    await db.close();
  });

  test('utworzenie kategorii; podwójne kliknięcie zwraca ten sam wiersz (200, nie drugi 201)', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    const env = { db };
    const admin = await seedUserSession(db, { userId: 'u-admin2', roles: [{ role: 'admin' }], mfa: true });
    const body = { schoolYearId: Y, direction: 'income', name: 'Składki dobrowolne' };
    const first = await call(env, '/api/ledger/categories', { cookie: admin, body });
    assert.equal(first.status, 201);
    assert.equal(first.data.category.active, true);
    const second = await call(env, '/api/ledger/categories', { cookie: admin, body });
    assert.equal(second.status, 200);
    assert.equal(second.data.category.id, first.data.category.id);
    const { rows } = await db.query(
      'SELECT count(*) AS n FROM ledger_categories WHERE school_year_id = $1 AND direction = $2 AND name = $3',
      [Y, 'income', 'Składki dobrowolne'],
    );
    assert.equal(Number(rows[0].n), 1, 'podwójne kliknięcie nie tworzy drugiego wiersza');
    await db.close();
  });

  test('rok zamknięty: 409 school_year_closed', async () => {
    const db = await createTestDb();
    await closeYear(db);
    const env = { db };
    const admin = await seedUserSession(db, { userId: 'u-admin3', roles: [{ role: 'admin' }], mfa: true });
    const result = await call(env, '/api/ledger/categories', { cookie: admin, body: { schoolYearId: Y_CLOSED, direction: 'expense', name: 'Nowa kategoria' } });
    assert.deepEqual(result, { status: 409, data: { error: 'school_year_closed' } });
    await db.close();
  });

  test('dezaktywacja: idempotentna (drugie żądanie 200 bez błędu), nieznane id → 404, cudzy rok → 403', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    await seedSchoolYear(db, Y_OTHER);
    const env = { db };
    const admin = await seedUserSession(db, { userId: 'u-admin4', roles: [{ role: 'admin' }], mfa: true });
    const created = await call(env, '/api/ledger/categories', { cookie: admin, body: { schoolYearId: Y, direction: 'expense', name: 'Wydarzenia' } });
    const id = created.data.category.id;

    const boardOther = await seedUserSession(db, { userId: 'u-board-other', roles: [{ role: 'board', schoolYearId: Y_OTHER }], mfa: true });
    assert.equal((await call(env, `/api/ledger/categories/${id}/deactivate`, { cookie: boardOther, body: {} })).status, 403);

    const first = await call(env, `/api/ledger/categories/${id}/deactivate`, { cookie: admin, body: {} });
    assert.equal(first.status, 200);
    assert.equal(first.data.category.active, false);
    const second = await call(env, `/api/ledger/categories/${id}/deactivate`, { cookie: admin, body: {} });
    assert.equal(second.status, 200, 'podwójne kliknięcie deaktywacji nie jest błędem');

    assert.equal((await call(env, '/api/ledger/categories/brak-takiej-id/deactivate', { cookie: admin, body: {} })).status, 404);

    const { rows: auditRows } = await db.query(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'ledger_category.deactivated' AND entity_id = $1",
      [id],
    );
    assert.equal(Number(auditRows[0].n), 1, 'jedno zdarzenie audytu mimo dwóch żądań');
    const { rows: deactivatedMeta } = await db.query(
      "SELECT metadata_json FROM audit_events WHERE action = 'ledger_category.deactivated' AND entity_id = $1", [id],
    );
    assert.equal(deactivatedMeta[0].metadata_json.schoolYearId, Y, '#207: rok kategorii w metadanych zdarzenia');
    await db.close();
  });

  test('kopiowanie: dryRun bez zapisu; zapis pomija już istniejące nazwy; podwójne kliknięcie nie duplikuje', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    await seedSchoolYear(db, Y_OTHER);
    const env = { db };
    const admin = await seedUserSession(db, { userId: 'u-admin5', roles: [{ role: 'admin' }], mfa: true });
    await call(env, '/api/ledger/categories', { cookie: admin, body: { schoolYearId: Y, direction: 'income', name: 'Składki' } });
    await call(env, '/api/ledger/categories', { cookie: admin, body: { schoolYearId: Y, direction: 'expense', name: 'Wydarzenia' } });
    // W roku docelowym już istnieje kategoria o tej samej nazwie — ma zostać pominięta.
    await call(env, '/api/ledger/categories', { cookie: admin, body: { schoolYearId: Y_OTHER, direction: 'income', name: 'Składki' } });

    const preview = await call(env, '/api/ledger/categories/copy', {
      cookie: admin, body: { fromSchoolYearId: Y, toSchoolYearId: Y_OTHER, dryRun: true },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.copied.length, 1, 'tylko "Wydarzenia" nie istnieje jeszcze w roku docelowym');
    assert.equal(preview.data.skipped.length, 1);
    const { rows: beforeCopy } = await db.query('SELECT count(*) AS n FROM ledger_categories WHERE school_year_id = $1', [Y_OTHER]);
    assert.equal(Number(beforeCopy[0].n), 1, 'dryRun nie zapisuje');

    const first = await call(env, '/api/ledger/categories/copy', {
      cookie: admin, body: { fromSchoolYearId: Y, toSchoolYearId: Y_OTHER },
    });
    assert.equal(first.status, 200);
    assert.equal(first.data.copied.length, 1);

    const second = await call(env, '/api/ledger/categories/copy', {
      cookie: admin, body: { fromSchoolYearId: Y, toSchoolYearId: Y_OTHER },
    });
    assert.equal(second.status, 200);
    assert.equal(second.data.copied.length, 0, 'podwójne kliknięcie nie duplikuje — wszystko już skopiowane');

    const { rows } = await db.query(
      'SELECT count(*) AS n FROM ledger_categories WHERE school_year_id = $1 AND name = $2',
      [Y_OTHER, 'Wydarzenia'],
    );
    assert.equal(Number(rows[0].n), 1);
    await db.close();
  });

  test('kopiowanie: zarząd przydzielony do jednego roku nie może skopiować do/z innego roku (403)', async () => {
    const db = await createTestDb();
    await seedSchoolYear(db, Y);
    await seedSchoolYear(db, Y_OTHER);
    const env = { db };
    const boardY = await seedUserSession(db, { userId: 'u-board-copy', roles: [{ role: 'board', schoolYearId: Y }], mfa: true });
    const result = await call(env, '/api/ledger/categories/copy', {
      cookie: boardY, body: { fromSchoolYearId: Y, toSchoolYearId: Y_OTHER },
    });
    assert.equal(result.status, 403);
    await db.close();
  });
});
