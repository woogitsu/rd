-- Foundation for invite-only access. No public registration endpoint is provided.
PRAGMA foreign_keys = ON;

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  role TEXT NOT NULL CHECK(role IN ('admin','board','treasurer','representative','audit','principal')),
  class_id TEXT REFERENCES classes(id),
  school_year_id TEXT REFERENCES school_years(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  CHECK(role != 'representative' OR class_id IS NOT NULL)
);
CREATE INDEX invitations_email_idx ON invitations(email, expires_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  mfa_verified_at TEXT,
  revoked_at TEXT
);
CREATE INDEX sessions_user_active_idx ON sessions(user_id, revoked_at, expires_at);
