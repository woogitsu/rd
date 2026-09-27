-- Keep one class enrollment per student and school year while preserving history.
PRAGMA foreign_keys = ON;

ALTER TABLE enrollments
  ADD COLUMN school_year_id TEXT REFERENCES school_years(id);

UPDATE enrollments
SET school_year_id = (
  SELECT classes.school_year_id
  FROM classes
  WHERE classes.id = enrollments.class_id
);

CREATE UNIQUE INDEX enrollments_student_year_unique
  ON enrollments(student_id, school_year_id);
CREATE INDEX enrollments_school_year_class_idx
  ON enrollments(school_year_id, class_id);

CREATE TRIGGER enrollments_school_year_insert
BEFORE INSERT ON enrollments
FOR EACH ROW
WHEN NEW.school_year_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM classes
    WHERE classes.id = NEW.class_id
      AND classes.school_year_id = NEW.school_year_id
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment_class_school_year_mismatch');
END;

CREATE TRIGGER enrollments_school_year_update
BEFORE UPDATE OF class_id, school_year_id ON enrollments
FOR EACH ROW
WHEN NEW.school_year_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM classes
    WHERE classes.id = NEW.class_id
      AND classes.school_year_id = NEW.school_year_id
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment_class_school_year_mismatch');
END;
