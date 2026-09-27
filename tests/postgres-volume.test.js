// Volume test on synthetic data only: 1000 students, 2000 guardian contacts,
// 50 users with role grants. Names are generated ("Uczeń 0001") and every
// e-mail uses the reserved domain example.invalid. No real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrations } from '../src/postgres-migrations.js';
import { pgliteClient } from '../scripts/smoke-postgres.js';

const directory = fileURLToPath(new URL('../postgres/migrations/', import.meta.url));

const YEAR = 'y2026';
const CLASS_COUNT = 20;
const HOUSEHOLDS = 800; // 200 with siblings (2 children), 600 with one child
const STUDENTS = 1000;
const GUARDIANS = 2000; // 400 households with 3 contacts, 400 with 2
const USERS = 50;
// Generous bound for a shared CI runner; PGlite is in-process WASM and slower
// than a real PostgreSQL server. It catches missing indexes or N+1 patterns.
const QUERY_BOUND_MS = 2000;

const pad = (n) => String(n).padStart(4, '0');
const q = (value) => (value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);

async function insertRows(db, table, columns, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    const values = rows.slice(i, i + chunk).map((row) => `(${row.map(q).join(',')})`).join(',');
    await db.exec(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values}`);
  }
}

async function timed(label, fn) {
  const started = performance.now();
  const result = await fn();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < QUERY_BOUND_MS, `${label} took ${elapsed.toFixed(0)} ms (bound ${QUERY_BOUND_MS} ms)`);
  return result;
}

function buildData() {
  const classes = Array.from({ length: CLASS_COUNT }, (_, i) => [`c${pad(i + 1)}`, YEAR, `Klasa ${pad(i + 1)}`]);
  const households = Array.from({ length: HOUSEHOLDS }, (_, i) => [`h${pad(i + 1)}`]);
  const students = [];
  const enrollments = [];
  for (let h = 0; h < HOUSEHOLDS; h += 1) {
    const children = h < STUDENTS - HOUSEHOLDS ? 2 : 1;
    for (let c = 0; c < children; c += 1) {
      const n = students.length + 1;
      students.push([`s${pad(n)}`, `h${pad(h + 1)}`, `Uczeń ${pad(n)}`, 'Syntetyczny']);
      // Siblings land in different classes.
      const classId = `c${pad(((n - 1) % CLASS_COUNT) + 1)}`;
      enrollments.push([`e${pad(n)}`, `s${pad(n)}`, classId, YEAR]);
    }
  }
  const guardians = [];
  for (let h = 0; h < HOUSEHOLDS; h += 1) {
    const count = h < GUARDIANS - 2 * HOUSEHOLDS ? 3 : 2;
    for (let g = 0; g < count; g += 1) {
      const n = guardians.length + 1;
      guardians.push([`g${pad(n)}`, `h${pad(h + 1)}`, `Opiekun ${pad(n)}`, 'Syntetyczny',
        `opiekun${pad(n)}@example.invalid`, 'true']);
    }
  }
  const byHousehold = new Map();
  for (const [id, household] of guardians) {
    if (!byHousehold.has(household)) byHousehold.set(household, []);
    byHousehold.get(household).push(id);
  }
  const links = [];
  for (const [studentId, household] of students) {
    byHousehold.get(household).forEach((guardianId, index) => {
      // Two people caring for one child: both contactable; the third is not.
      links.push([studentId, guardianId, index < 2 ? 'true' : 'false', index === 0 ? 'true' : 'false']);
    });
  }
  const users = Array.from({ length: USERS }, (_, i) => [`u${pad(i + 1)}`, `uzytkownik${pad(i + 1)}@example.invalid`, `Użytkownik ${pad(i + 1)}`]);
  const grants = [];
  users.forEach(([userId], i) => {
    if (i < 2) grants.push([`r${grants.length + 1}`, userId, 'admin', null, null]);
    else if (i < 8) grants.push([`r${grants.length + 1}`, userId, 'board', null, null]);
    else if (i < 10) grants.push([`r${grants.length + 1}`, userId, 'treasurer', null, YEAR]);
    else {
      // 40 class representatives: 2 per class, some with a second class.
      const classIndex = (i - 10) % CLASS_COUNT;
      grants.push([`r${grants.length + 1}`, userId, 'representative', `c${pad(classIndex + 1)}`, YEAR]);
      if (i % 5 === 0) grants.push([`r${grants.length + 1}`, userId, 'representative', `c${pad(((classIndex + 1) % CLASS_COUNT) + 1)}`, YEAR]);
    }
  });
  // Partial voluntary payments: households 1..600 pay once or twice.
  const payments = [];
  for (let h = 0; h < 600; h += 1) {
    const parts = h % 3 === 0 ? 2 : 1;
    for (let p = 0; p < parts; p += 1) {
      const n = payments.length + 1;
      payments.push([`p${pad(n)}`, `h${pad(h + 1)}`, YEAR, String(2000 + (h % 5) * 500), '2026-10-01', 'bank',
        `REF-${pad(n)}`, 'recorded', 'u0009', `volume-payment-${pad(n)}`]);
    }
  }
  const corrections = payments.slice(0, 50).map(([id], i) => [`pc${pad(i + 1)}`, id, '500', 'Korekta syntetyczna', 'u0009', `volume-correction-${pad(i + 1)}`]);
  return { classes, households, students, enrollments, guardians, links, users, grants, payments, corrections };
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

    await db.exec(`INSERT INTO school_years VALUES ('${YEAR}','2026/27','2026-09-01','2027-08-31')`);
    await insertRows(db, 'classes', ['id', 'school_year_id', 'name'], data.classes);
    await insertRows(db, 'households', ['id'], data.households);
    await insertRows(db, 'students', ['id', 'household_id', 'first_name', 'last_name'], data.students);
    await insertRows(db, 'enrollments', ['id', 'student_id', 'class_id', 'school_year_id'], data.enrollments);
    await insertRows(db, 'guardians', ['id', 'household_id', 'first_name', 'last_name', 'email', 'contact_allowed'], data.guardians);
    await insertRows(db, 'student_guardians', ['student_id', 'guardian_id', 'contact_allowed', 'is_primary_contact'], data.links);
    await insertRows(db, 'users', ['id', 'email', 'display_name'], data.users);
    await insertRows(db, 'role_grants', ['id', 'user_id', 'role', 'class_id', 'school_year_id'], data.grants);
    await insertRows(db, 'payment_entries', ['id', 'household_id', 'school_year_id', 'amount_cents', 'received_on', 'method',
      'reference', 'status', 'created_by', 'idempotency_key'], data.payments);
    await insertRows(db, 'payment_corrections', ['id', 'payment_entry_id', 'amount_cents', 'reason', 'created_by', 'idempotency_key'], data.corrections, 1);

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
