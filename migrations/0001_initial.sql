-- Initial schema. Review retention and access policy before production import.
PRAGMA foreign_keys = ON;
CREATE TABLE school_years (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL);
CREATE TABLE classes (id TEXT PRIMARY KEY, school_year_id TEXT NOT NULL REFERENCES school_years(id), name TEXT NOT NULL, UNIQUE(school_year_id,name));
CREATE TABLE households (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, archived_at TEXT);
CREATE TABLE guardians (id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, contact_allowed INTEGER NOT NULL DEFAULT 0 CHECK(contact_allowed IN (0,1)));
CREATE INDEX guardians_household_idx ON guardians(household_id);
CREATE TABLE students (id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), first_name TEXT NOT NULL, last_name TEXT NOT NULL);
CREATE INDEX students_household_idx ON students(household_id);
CREATE TABLE enrollments (id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), class_id TEXT NOT NULL REFERENCES classes(id), UNIQUE(student_id,class_id));
CREATE INDEX enrollments_class_idx ON enrollments(class_id);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, disabled_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE role_grants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('admin','board','treasurer','representative','audit','principal')), class_id TEXT REFERENCES classes(id), school_year_id TEXT REFERENCES school_years(id), expires_at TEXT, CHECK(role != 'representative' OR class_id IS NOT NULL));
CREATE INDEX role_grants_user_idx ON role_grants(user_id,expires_at);
CREATE TABLE payment_entries (id TEXT PRIMARY KEY, household_id TEXT REFERENCES households(id), school_year_id TEXT NOT NULL REFERENCES school_years(id), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), received_on TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('bank','cash','other')), reference TEXT, status TEXT NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','unmatched','reversed')), created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, idempotency_key TEXT UNIQUE);
CREATE INDEX payment_household_year_idx ON payment_entries(household_id,school_year_id);
CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, school_year_id TEXT NOT NULL REFERENCES school_years(id), direction TEXT NOT NULL CHECK(direction IN ('income','expense')), amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), category TEXT NOT NULL, description TEXT NOT NULL, occurred_on TEXT NOT NULL, payment_entry_id TEXT REFERENCES payment_entries(id), source_document_id TEXT, approval_id TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX ledger_year_date_idx ON ledger_entries(school_year_id,occurred_on);
CREATE TABLE documents (id TEXT PRIMARY KEY, object_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, kind TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE events (id TEXT PRIMARY KEY, school_year_id TEXT NOT NULL REFERENCES school_years(id), title TEXT NOT NULL, begins_at TEXT NOT NULL, description TEXT, visibility TEXT NOT NULL DEFAULT 'internal' CHECK(visibility IN ('internal','draft_public','published')), published_at TEXT, created_by TEXT NOT NULL REFERENCES users(id));
CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX audit_entity_idx ON audit_events(entity_type,entity_id,occurred_at);
-- Future migrations: approvals, meetings, campaigns, bounce events and deletion policy.
