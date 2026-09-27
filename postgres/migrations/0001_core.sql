-- Fresh PostgreSQL schema for synthetic/staging data only.
-- This is not an automatic conversion of an existing D1 database.

CREATE TABLE school_years (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  CONSTRAINT school_year_dates CHECK (ends_on >= starts_on)
);

CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  name TEXT NOT NULL,
  UNIQUE (school_year_id, name),
  UNIQUE (id, school_year_id)
);

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE guardians (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  contact_allowed BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX guardians_household_idx ON guardians(household_id);

CREATE TABLE students (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL
);
CREATE INDEX students_household_idx ON students(household_id);

CREATE TABLE student_guardians (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  contact_allowed BOOLEAN NOT NULL DEFAULT false,
  is_primary_contact BOOLEAN NOT NULL DEFAULT false,
  starts_on DATE,
  ends_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, guardian_id),
  CONSTRAINT guardian_relation_dates CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX student_guardians_guardian_idx ON student_guardians(guardian_id, student_id);
CREATE INDEX student_guardians_contact_idx ON student_guardians(student_id, contact_allowed, ends_on);

CREATE TABLE enrollments (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  class_id TEXT NOT NULL,
  school_year_id TEXT NOT NULL,
  UNIQUE (student_id, school_year_id),
  UNIQUE (student_id, class_id),
  FOREIGN KEY (class_id, school_year_id) REFERENCES classes(id, school_year_id)
);
CREATE INDEX enrollments_class_idx ON enrollments(class_id);
CREATE INDEX enrollments_school_year_class_idx ON enrollments(school_year_id, class_id);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin','board','treasurer','representative','audit','principal')),
  class_id TEXT REFERENCES classes(id),
  school_year_id TEXT REFERENCES school_years(id),
  expires_at TIMESTAMPTZ,
  CONSTRAINT representative_requires_class CHECK (role <> 'representative' OR class_id IS NOT NULL)
);
CREATE INDEX role_grants_user_idx ON role_grants(user_id, expires_at);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  role TEXT NOT NULL CHECK (role IN ('admin','board','treasurer','representative','audit','principal')),
  class_id TEXT REFERENCES classes(id),
  school_year_id TEXT REFERENCES school_years(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT invite_representative_requires_class CHECK (role <> 'representative' OR class_id IS NOT NULL)
);
CREATE INDEX invitations_email_idx ON invitations(email, expires_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  mfa_verified_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX sessions_user_active_idx ON sessions(user_id, revoked_at, expires_at);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  kind TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  title TEXT NOT NULL,
  begins_at TIMESTAMPTZ NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('internal','draft_public','published')),
  published_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_entity_idx ON audit_events(entity_type, entity_id, occurred_at);
