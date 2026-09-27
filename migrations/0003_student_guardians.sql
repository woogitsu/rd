-- Decouple a child's guardians from one household. Review the backfill before any remote migration.
PRAGMA foreign_keys = ON;

CREATE TABLE student_guardians (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  contact_allowed INTEGER NOT NULL DEFAULT 0 CHECK(contact_allowed IN (0,1)),
  is_primary_contact INTEGER NOT NULL DEFAULT 0 CHECK(is_primary_contact IN (0,1)),
  starts_on TEXT,
  ends_on TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(student_id, guardian_id),
  CHECK(ends_on IS NULL OR starts_on IS NULL OR date(ends_on) >= date(starts_on))
);

CREATE INDEX student_guardians_guardian_idx
  ON student_guardians(guardian_id, student_id);
CREATE INDEX student_guardians_contact_idx
  ON student_guardians(student_id, contact_allowed, ends_on);

-- Preserve the meaning of the old one-household model for existing development data.
-- A production migration requires a reviewed preview because a shared household does not
-- always prove that every guardian may be contacted about every child.
INSERT INTO student_guardians (student_id, guardian_id, contact_allowed)
SELECT students.id, guardians.id, guardians.contact_allowed
FROM students
JOIN guardians ON guardians.household_id = students.household_id;
