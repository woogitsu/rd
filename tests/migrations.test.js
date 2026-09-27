import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration = number => readFileSync(new URL(`../migrations/${number}.sql`, import.meta.url), 'utf8');

test('student-guardian migration preserves legacy household links and supports shared care', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(migration('0001_initial'));
  db.exec(`
    INSERT INTO households (id) VALUES ('h1'), ('h2');
    INSERT INTO guardians (id, household_id, first_name, last_name, email, contact_allowed)
      VALUES ('g1', 'h1', 'Anna', 'Testowa', 'anna@example.org', 1),
             ('g2', 'h2', 'Jan', 'Testowy', 'jan@example.org', 0);
    INSERT INTO students (id, household_id, first_name, last_name)
      VALUES ('s1', 'h1', 'Ala', 'Testowa'),
             ('s2', 'h1', 'Marek', 'Testowy');
  `);
  db.exec(migration('0002_auth_sessions'));
  db.exec(migration('0003_student_guardians'));

  assert.deepEqual(
    db.prepare('SELECT student_id, guardian_id, contact_allowed FROM student_guardians ORDER BY student_id')
      .all().map(row => ({ ...row })),
    [
      { student_id: 's1', guardian_id: 'g1', contact_allowed: 1 },
      { student_id: 's2', guardian_id: 'g1', contact_allowed: 1 },
    ],
  );

  db.prepare(`
    INSERT INTO student_guardians (student_id, guardian_id, contact_allowed, is_primary_contact)
    VALUES (?, ?, ?, ?)
  `).run('s1', 'g2', 1, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM student_guardians WHERE student_id = ?').get('s1').count, 2);
  assert.throws(
    () => db.prepare('INSERT INTO student_guardians (student_id, guardian_id) VALUES (?, ?)').run('s1', 'g2'),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => db.prepare('INSERT INTO student_guardians (student_id, guardian_id) VALUES (?, ?)').run('s1', 'missing'),
    /FOREIGN KEY constraint failed/,
  );
  db.close();
});

test('student-guardian relation validates flags and active date range', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(migration('0001_initial'));
  db.exec(migration('0002_auth_sessions'));
  db.exec(migration('0003_student_guardians'));
  db.exec(`
    INSERT INTO households (id) VALUES ('h1');
    INSERT INTO guardians (id, household_id, first_name, last_name) VALUES ('g1', 'h1', 'Anna', 'Testowa');
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s1', 'h1', 'Ala', 'Testowa');
  `);
  assert.throws(
    () => db.prepare('INSERT INTO student_guardians (student_id, guardian_id, contact_allowed) VALUES (?, ?, ?)').run('s1', 'g1', 2),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare('INSERT INTO student_guardians (student_id, guardian_id, starts_on, ends_on) VALUES (?, ?, ?, ?)').run('s1', 'g1', '2026-09-01', '2026-08-31'),
    /CHECK constraint failed/,
  );
  db.close();
});

test('enrollment migration keeps history and allows only one class per school year', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(migration('0001_initial'));
  db.exec(`
    INSERT INTO school_years (id, label, starts_on, ends_on)
      VALUES ('y2025', '2025/2026', '2025-09-01', '2026-06-30'),
             ('y2026', '2026/2027', '2026-09-01', '2027-06-30');
    INSERT INTO classes (id, school_year_id, name)
      VALUES ('c1a', 'y2025', '1A'), ('c1b', 'y2025', '1B'), ('c2a', 'y2026', '2A');
    INSERT INTO households (id) VALUES ('h1');
    INSERT INTO students (id, household_id, first_name, last_name) VALUES ('s1', 'h1', 'Ala', 'Testowa');
    INSERT INTO enrollments (id, student_id, class_id) VALUES ('e1', 's1', 'c1a');
  `);
  db.exec(migration('0002_auth_sessions'));
  db.exec(migration('0003_student_guardians'));
  db.exec(migration('0004_enrollment_school_year'));

  assert.equal(db.prepare('SELECT school_year_id FROM enrollments WHERE id = ?').get('e1').school_year_id, 'y2025');
  assert.throws(
    () => db.prepare('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES (?, ?, ?, ?)').run('e2', 's1', 'c1b', 'y2025'),
    /UNIQUE constraint failed/,
  );
  db.prepare('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES (?, ?, ?, ?)')
    .run('e3', 's1', 'c2a', 'y2026');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM enrollments WHERE student_id = ?').get('s1').count, 2);
  assert.throws(
    () => db.prepare('INSERT INTO enrollments (id, student_id, class_id, school_year_id) VALUES (?, ?, ?, ?)').run('e4', 's1', 'c2a', 'y2025'),
    /enrollment_class_school_year_mismatch/,
  );
  assert.throws(
    () => db.prepare('INSERT INTO enrollments (id, student_id, class_id) VALUES (?, ?, ?)').run('e5', 's1', 'c2a'),
    /enrollment_class_school_year_mismatch/,
  );
  db.close();
});
