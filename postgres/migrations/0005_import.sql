-- Transactional CSV/XLSX import into PostgreSQL (issue #36).
-- Adds the import_batches journal and nullable source-identifier columns.
-- Existing rows keep their meaning; no row is rewritten or deleted.
-- import_batches stores counts and hashes only: no names, e-mails or file content.

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  -- SHA-256 of the normalized rows and options; the same data is committed at most once.
  fingerprint TEXT NOT NULL UNIQUE CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  -- SHA-256 of the per-row plan shown in the preview; commit refuses a stale preview.
  plan_digest TEXT NOT NULL CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('committed')),
  rows_total INTEGER NOT NULL CHECK (rows_total >= 0),
  rows_added INTEGER NOT NULL CHECK (rows_added >= 0),
  rows_updated INTEGER NOT NULL CHECK (rows_updated >= 0),
  rows_unchanged INTEGER NOT NULL CHECK (rows_unchanged >= 0),
  rows_conflict INTEGER NOT NULL CHECK (rows_conflict >= 0),
  rows_skipped INTEGER NOT NULL CHECK (rows_skipped >= 0),
  households_created INTEGER NOT NULL CHECK (households_created >= 0),
  guardians_created INTEGER NOT NULL CHECK (guardians_created >= 0),
  students_created INTEGER NOT NULL CHECK (students_created >= 0),
  enrollments_created INTEGER NOT NULL CHECK (enrollments_created >= 0),
  links_created INTEGER NOT NULL CHECK (links_created >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT import_batch_row_totals CHECK (
    rows_total = rows_added + rows_updated + rows_unchanged + rows_conflict + rows_skipped
  )
);
CREATE INDEX import_batches_year_idx ON import_batches(school_year_id, created_at);

-- The journal is append-only; a correction is a new batch or a manual, audited change.
CREATE FUNCTION import_batch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'import_batches_are_append_only';
END $$;
CREATE TRIGGER import_batches_no_change BEFORE UPDATE OR DELETE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION import_batch_immutable();

-- Stable identifiers from the school's source file. Matching is case-insensitive.
-- One school per database, so uniqueness is global.
ALTER TABLE households
  ADD COLUMN source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 80),
  ADD COLUMN import_batch_id TEXT REFERENCES import_batches(id);
CREATE UNIQUE INDEX households_source_ref_key ON households (lower(source_ref)) WHERE source_ref IS NOT NULL;

ALTER TABLE students
  ADD COLUMN source_ref TEXT CHECK (source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 80),
  ADD COLUMN import_batch_id TEXT REFERENCES import_batches(id);
CREATE UNIQUE INDEX students_source_ref_key ON students (lower(source_ref)) WHERE source_ref IS NOT NULL;

ALTER TABLE guardians
  ADD COLUMN import_batch_id TEXT REFERENCES import_batches(id);
