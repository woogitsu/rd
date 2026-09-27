// Volume test on synthetic data only: 1000 students, 2000 guardian contacts,
// 50 users with role grants. Names are generated ("Uczeń 0001") and every
// e-mail uses the reserved domain example.invalid. No real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { pgliteClient } from '../scripts/smoke-postgres.js';
import {
  buildSyntheticData as buildData, CLASS_COUNT, GUARDIANS, insertSyntheticData, STUDENTS, USERS, YEAR,
} from '../scripts/lib/synthetic-seed.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

// Generous bound for a shared CI runner; PGlite is in-process WASM and slower
// than a real PostgreSQL server. It catches missing indexes or N+1 patterns.
const QUERY_BOUND_MS = 2000;

async function timed(label, fn) {
  const started = performance.now();
  const result = await fn();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < QUERY_BOUND_MS, `${label} took ${elapsed.toFixed(0)} ms (bound ${QUERY_BOUND_MS} ms)`);
  return result;
}

test('PostgreSQL schema handles 1000 students, 2000 contacts and 50 users within bounds', { timeout: 60_000 }, async () => {
  const db = new PGlite();
  try {
    await applyMigrations(pgliteClient(db), await loadMigrations(directory));
    const data = buildData();
    assert.equal(data.students.length, STUDENTS);
    assert.equal(data.guardians.length, GUARDIANS);
    assert.equal(data.users.length, USERS);
    // 200 sibling households x 2 children x 3 contacts + 200 x 1 x 3 + 400 x 1 x 2.
    assert.equal(data.links.length, 2600);

    await insertSyntheticData(db, data);

    const totals = await timed('household totals view', () => db.query(
      `SELECT household_id, net_amount_cents::bigint AS net, payment_count::int AS payments
         FROM household_payment_totals WHERE school_year_id = $1 ORDER BY household_id`, [YEAR]));
    assert.equal(totals.rows.length, 600);
    const sum = totals.rows.reduce((acc, row) => acc + Number(row.net), 0);
    const expected = data.payments.reduce((acc, row) => acc + Number(row[3]), 0) - 50 * 500;
    assert.equal(sum, expected);
    assert.equal(totals.rows.find((row) => row.household_id === 'h0001').payments, 2);

    const byClass = await timed('enrollment by class', () => db.query(
      `SELECT c.name, count(e.id)::int AS students
         FROM classes c LEFT JOIN enrollments e ON e.class_id = c.id AND e.school_year_id = c.school_year_id
        WHERE c.school_year_id = $1 GROUP BY c.name ORDER BY c.name`, [YEAR]));
    assert.equal(byClass.rows.length, CLASS_COUNT);
    assert.ok(byClass.rows.every((row) => row.students === STUDENTS / CLASS_COUNT));

    const contacts = await timed('contactable guardians for one class', () => db.query(
      `SELECT DISTINCT g.id
         FROM enrollments e
         JOIN student_guardians sg ON sg.student_id = e.student_id AND sg.contact_allowed AND sg.ends_on IS NULL
         JOIN guardians g ON g.id = sg.guardian_id AND g.contact_allowed AND g.email IS NOT NULL
        WHERE e.class_id = $1 AND e.school_year_id = $2`, ['c0001', YEAR]));
    assert.equal(contacts.rows.length, 2 * STUDENTS / CLASS_COUNT);

    await timed('grant loading for all 50 users', async () => {
      for (const [userId] of data.users) {
        const { rows } = await db.query(
          `SELECT role, class_id, school_year_id, expires_at FROM role_grants
            WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())
            ORDER BY role, class_id, school_year_id`, [userId]);
        assert.ok(rows.length >= 1);
        if (rows[0].role === 'representative') assert.ok(rows.every((row) => row.class_id));
      }
    });

    const { rows: [counts] } = await db.query(
      `SELECT (SELECT count(*)::int FROM students) AS students,
              (SELECT count(*)::int FROM guardians) AS guardians,
              (SELECT count(*)::int FROM student_guardians) AS links,
              (SELECT count(*)::int FROM users) AS users`);
    assert.deepEqual(counts, { students: STUDENTS, guardians: GUARDIANS, links: data.links.length, users: USERS });
  } finally {
    await db.close();
  }
});
