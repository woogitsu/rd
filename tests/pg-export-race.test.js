// #216: podwójne kliknięcie „Eksportuj” — dwa równoczesne przebiegi tego
// samego roku na prawdziwym PostgreSQL. PGlite serializuje transakcje (patrz
// tests/pg-reconciliation-race.test.js), więc ten przeplot odtwarza tylko
// prawdziwy serwer. Test działa jedynie z RD_TEST_PG_URL (adres serwera
// testowego z prawem CREATE DATABASE) i jest pomijany bez tej zmiennej.
//
//   RD_TEST_PG_URL=postgres://postgres@127.0.0.1:55462/postgres node --test tests/pg-export-race.test.js
//
// Wyłącznie dane syntetyczne.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPgDatabase } from '../src/db.js';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { handlePgRequest } from '../src/pg/app.js';
import { request, seedSchoolYear, seedUserSession } from './helpers/pg.js';

const ADMIN_URL = process.env.RD_TEST_PG_URL;
const YEAR = 'y-export-race';
const skip = ADMIN_URL ? false : 'brak RD_TEST_PG_URL (wymaga prawdziwego PostgreSQL)';

async function withDatabase(fn) {
  const name = `rd_export_race_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const db = createPgDatabase({ connectionString: url.toString(), max: 8 });
  try {
    await applyMigrations(client, await loadMigrations(fileURLToPath(new URL('../postgres/migrations/', import.meta.url))));
    await client.end();
    await fn(db, url.toString());
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}

// Trzyma blokadę doradczą tego samego roku na osobnym, otwartym połączeniu —
// symuluje eksport w trakcie (transakcja jeszcze niezacommitowana).
async function holdExportLock(url, schoolYearId) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('BEGIN');
  const { rows } = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [`rd_export:${schoolYearId}`]);
  assert.equal(rows[0].locked, true, 'test setup: lock must be free at start');
  return {
    async release() { await client.query('COMMIT'); await client.end(); },
  };
}

test('a second yearly export of the same year, started while the first is in flight, gets 409 without waiting', { skip }, async () => {
  await withDatabase(async (db, url) => {
    await seedSchoolYear(db, YEAR);
    const admin = await seedUserSession(db, { userId: 'u-admin-race', roles: [{ role: 'admin' }], mfa: true });
    const call = (path, options = {}) => handlePgRequest(request(path, { cookie: admin, ...options }), { db });

    const holder = await holdExportLock(url, YEAR);
    const started = Date.now();
    const res = await call('/api/exports', { method: 'POST', body: { schoolYearId: YEAR } });
    const elapsedMs = Date.now() - started;
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'export_in_progress' });
    assert.ok(elapsedMs < 2000, `powinno odpowiedzieć od razu, nie czekać na zwolnienie blokady (${elapsedMs} ms)`);
    const runs = await db.query("SELECT count(*)::int AS n FROM export_runs WHERE kind = 'yearly' AND school_year_id = $1", [YEAR]);
    assert.equal(runs.rows[0].n, 0, 'nieudany przebieg nie zapisuje export_runs');

    await holder.release();
    // Po zwolnieniu blokady (COMMIT trzymającej transakcji) kolejny eksport przebiega normalnie.
    const ok = await call('/api/exports', { method: 'POST', body: { schoolYearId: YEAR } });
    assert.equal(ok.status, 200);
    const runsAfter = await db.query("SELECT count(*)::int AS n FROM export_runs WHERE kind = 'yearly' AND school_year_id = $1", [YEAR]);
    assert.equal(runsAfter.rows[0].n, 1);
  });
});

test('two truly concurrent POST /api/exports for the same year: one 200, one 409, exactly one export_runs row', { skip }, async () => {
  await withDatabase(async (db, url) => {
    await seedSchoolYear(db, YEAR);
    const admin = await seedUserSession(db, { userId: 'u-admin-race2', roles: [{ role: 'admin' }], mfa: true });
    const call = (path, options = {}) => handlePgRequest(request(path, { cookie: admin, ...options }), { db });

    const [first, second] = await Promise.all([
      call('/api/exports', { method: 'POST', body: { schoolYearId: YEAR } }),
      call('/api/exports', { method: 'POST', body: { schoolYearId: YEAR } }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const runs = await db.query("SELECT count(*)::int AS n FROM export_runs WHERE kind = 'yearly' AND school_year_id = $1", [YEAR]);
    assert.equal(runs.rows[0].n, 1, 'tylko udany przebieg zapisuje export_runs');
  });
});
