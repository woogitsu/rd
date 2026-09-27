-- Password login (e-mail + password, then TOTP), login rate limits and
-- admin-issued password reset tokens (issue #3, D-10: user's indication
-- 2026-09-27, pending formal confirmation by the board / DPO).
-- Only adds tables, a guard trigger and one widened CHECK; no existing row
-- is changed or deleted. No plaintext password, e-mail or IP address is stored.

-- One password hash per account. The hash string carries the algorithm and
-- its parameters: scrypt$N$r$p$<salt base64url>$<key base64url>.
CREATE TABLE user_passwords (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  hash TEXT NOT NULL
    CHECK (hash ~ '^scrypt\$[0-9]{4,8}\$[0-9]{1,2}\$[0-9]{1,2}\$[A-Za-z0-9_-]{22,64}\$[A-Za-z0-9_-]{43,128}$'),
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  set_reason TEXT NOT NULL CHECK (set_reason IN ('invitation','change','reset','rehash')),
  must_change BOOLEAN NOT NULL DEFAULT false
);

-- Failed-login counters. scope_hash is SHA-256 (hex) of a domain-separated,
-- normalised e-mail address or client IP — never the plaintext value.
-- Proposed policy (pending D-10): 5 failures / 15 min per e-mail,
-- 20 failures / 15 min per IP -> 15 min lock. Rows older than one day are
-- purged by the application on the next failure.
CREATE TABLE login_rate_limits (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('email','ip')),
  scope_hash TEXT NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_hash)
);
CREATE INDEX login_rate_limits_updated_idx ON login_rate_limits(updated_at);

-- One-time password reset tokens, issued ONLY by an administrator through
-- the admin API (no self-service e-mail reset: e-mail template and sender
-- are open decisions D-16/D-17). Only SHA-256 of the token is stored.
CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX password_reset_tokens_user_open_idx
  ON password_reset_tokens(user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

-- Tokens are never deleted or rewritten; a token can be closed once
-- (used or revoked) and then stays closed.
CREATE FUNCTION password_reset_token_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'password_reset_token_immutable'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'password_reset_token_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER password_reset_tokens_guard BEFORE UPDATE OR DELETE ON password_reset_tokens
  FOR EACH ROW EXECUTE FUNCTION password_reset_token_guard();

-- Sessions: new revocation reasons for password change/reset and admin MFA reset.
ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_revoked_reason_check
  CHECK (revoked_reason IN ('logout','rotated','admin','user_disabled','user_revoke_all',
                            'password_changed','password_reset','mfa_reset'));
