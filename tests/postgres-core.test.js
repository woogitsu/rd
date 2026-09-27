import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from '../src/postgres-migrations.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

test('core schema enforces school-year enrollment and guardian constraints', async () => {
  const db = new PGlite();
  try {
    const [migration] = await loadMigrations(directory);
    await db.exec(migration.sql);
    await db.query("INSERT INTO school_years VALUES ('y1','2026/27','2026-09-01','2027-08-31'), ('y2','2027/28','2027-09-01','2028-08-31')");
    await db.query("INSERT INTO classes VALUES ('c1','y1','1A'), ('c2','y2','2A')");
    await db.query("INSERT INTO households (id) VALUES ('h1')");
    await db.query("INSERT INTO students VALUES ('s1','h1','Ada','Testowa'), ('s2','h1','Jan','Testowy')");
    await db.query("INSERT INTO guardians (id,household_id,first_name,last_name) VALUES ('g1','h1','Maria','Testowa')");
    await db.query("INSERT INTO student_guardians (student_id,guardian_id) VALUES ('s1','g1'), ('s2','g1')");
    await db.query("INSERT INTO enrollments VALUES ('e1','s1','c1','y1')");
    await assert.rejects(db.query("INSERT INTO enrollments VALUES ('e2','s1','c1','y1')"));
    await assert.rejects(db.query("INSERT INTO enrollments VALUES ('e3','s2','c1','y2')"));
    await assert.rejects(db.query("INSERT INTO student_guardians (student_id,guardian_id,starts_on,ends_on) VALUES ('s1','g1','2027-01-01','2026-01-01')"));
    const { rows } = await db.query('SELECT count(*)::int AS count FROM student_guardians');
    assert.equal(rows[0].count, 2);
  } finally {
    await db.close();
  }
});

test('representative role requires a class and session requires token hash', async () => {
  const db = new PGlite();
  try {
    const [migration] = await loadMigrations(directory);
    await db.exec(migration.sql);
    await db.query("INSERT INTO users (id,email,display_name) VALUES ('u1','test@example.invalid','Synthetic User')");
    await assert.rejects(db.query("INSERT INTO role_grants (id,user_id,role) VALUES ('r1','u1','representative')"));
    await assert.rejects(db.query("INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ('ss1','u1','raw-token',now())"));
    await db.query("INSERT INTO role_grants (id,user_id,role) VALUES ('r2','u1','board')");
    const { rows } = await db.query('SELECT count(*)::int AS count FROM role_grants');
    assert.equal(rows[0].count, 1);
  } finally {
    await db.close();
  }
});
