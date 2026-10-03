// #111: szablon bazy PGlite (tests/helpers/pg.js, createPgliteTestDb). Migracje
// wykonują się raz na proces, a każda baza testowa to klon szablonu przez
// dumpDataDir/loadDataDir. Te testy pilnują, że klon jest równoważny bazie
// zmigrowanej od zera i że testy się nie widzą nawzajem (izolacja instancji).
// Wyłącznie dane syntetyczne; bez sieci i bez prawdziwego PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';
import { createPgliteTestDb, seedSchoolYear } from './helpers/pg.js';

const migrationsDirectory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

const catalog = async (db) => {
  const one = async (sql) => (await db.query(sql)).rows.map((row) => Object.values(row).join('|'));
  return {
    tables: await one("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1"),
    columns: await one("SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2"),
    triggers: await one('SELECT tgrelid::regclass::text, tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2'),
    functions: await one("SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1"),
    constraints: await one('SELECT conrelid::regclass::text, conname, contype FROM pg_constraint WHERE connamespace = \'public\'::regnamespace ORDER BY 1, 2'),
    roles: await one("SELECT rolname FROM pg_roles WHERE rolname = 'rd_app'"),
    indexes: await one("SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2"),
  };
};

test('szablon: klon ma ten sam schemat, wyzwalacze, funkcje, indeksy i role co baza zmigrowana od zera', async () => {
  const fresh = new PGlite();
  for (const migration of await loadMigrations(migrationsDirectory)) await fresh.exec(migration.sql);
  const clone = await createPgliteTestDb();
  const second = await createPgliteTestDb();
  try {
    const expected = await catalog(fresh);
    assert.ok(expected.tables.length > 50, 'schemat nie jest pusty');
    assert.ok(expected.triggers.length > 100 && expected.functions.length > 50, 'wyzwalacze i funkcje z migracji są w schemacie');
    assert.deepEqual(await catalog(clone), expected);
    assert.deepEqual(await catalog(second), expected);
  } finally { await Promise.all([fresh.close(), clone.close(), second.close()]); }
});

test('szablon: zapis w jednej bazie nie jest widoczny w drugiej ani w następnym klonie', async () => {
  const a = await createPgliteTestDb();
  const b = await createPgliteTestDb();
  try {
    await seedSchoolYear(a, 'y-isolation');
    await a.query("INSERT INTO households (id) VALUES ('h-isolation')");
    assert.equal((await a.query("SELECT count(*)::int AS n FROM households WHERE id = 'h-isolation'")).rows[0].n, 1);
    assert.equal((await b.query('SELECT count(*)::int AS n FROM households')).rows[0].n, 0);
    assert.equal((await b.query('SELECT count(*)::int AS n FROM school_years')).rows[0].n, 0);
    const c = await createPgliteTestDb();
    try {
      assert.equal((await c.query('SELECT count(*)::int AS n FROM households')).rows[0].n, 0, 'szablon nie przejął zapisu z pierwszej bazy');
      assert.equal((await c.query('SELECT count(*)::int AS n FROM school_years')).rows[0].n, 0);
    } finally { await c.close(); }
  } finally { await Promise.all([a.close(), b.close()]); }
});

test('szablon: kilka wywołań naraz (PGlite: po kolei, nie wyścig) buduje jeden szablon, każde dostaje własną, pustą bazę', async () => {
  const dbs = await Promise.all([createPgliteTestDb(), createPgliteTestDb(), createPgliteTestDb()]);
  try {
    assert.equal(new Set(dbs).size, 3, 'trzy osobne instancje');
    await Promise.all(dbs.map((db, i) => db.query('INSERT INTO households (id) VALUES ($1)', [`h-parallel-${i}`])));
    for (const [i, db] of dbs.entries()) {
      const ids = (await db.query('SELECT id FROM households ORDER BY id')).rows.map((row) => row.id);
      assert.deepEqual(ids, [`h-parallel-${i}`]);
    }
  } finally { await Promise.all(dbs.map((db) => db.close())); }
});

test('szablon: wyzwalacze niezmienności działają w klonie (UPDATE audit_events odrzucony), a rola rd_app istnieje', async () => {
  const db = await createPgliteTestDb();
  try {
    await db.query("INSERT INTO users (id, email, display_name) VALUES ('u-tpl', 'u-tpl@example.invalid', 'Test')");
    await db.query("INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json) VALUES ('ae-tpl', 'u-tpl', 'test.action', 'user', 'u-tpl', '{}')");
    await assert.rejects(db.query("UPDATE audit_events SET action = 'test.changed' WHERE id = 'ae-tpl'"), /audit_events_are_append_only/);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'rd_app'")).rows[0].n, 1);
  } finally { await db.close(); }
});
