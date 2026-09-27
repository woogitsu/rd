-- MFA factors, attempt limits and recovery codes (issue #3).
-- The MFA method (TOTP) is a PROPOSED default pending decision D-10.
-- Only adds tables, indexes and one widened CHECK; no existing row is changed.

-- One row per enrolled factor. The shared secret is stored only as
-- AES-256-GCM ciphertext (key MFA_ENCRYPTION_KEY, outside the database).
-- A factor is never deleted: replacement or removal sets disabled_at.
CREATE TABLE user_mfa_factors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  method TEXT NOT NULL CHECK (method IN ('totp')),
  secret_ciphertext TEXT NOT NULL CHECK (secret_ciphertext ~ '^[A-Za-z0-9_-]+$'),
  secret_iv TEXT NOT NULL CHECK (secret_iv ~ '^[A-Za-z0-9_-]{16}$'),
  secret_tag TEXT NOT NULL CHECK (secret_tag ~ '^[A-Za-z0-9_-]{22}$'),
  key_version SMALLINT NOT NULL DEFAULT 1 CHECK (key_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  -- Last accepted TOTP time step; the API refuses a code for the same or an older
  -- step, the trigger refuses moving it backwards.
  last_used_step BIGINT,
  CHECK (disabled_at IS NULL OR disabled_at >= created_at)
);
-- At most one active confirmed factor and one active pending factor per user.
CREATE UNIQUE INDEX user_mfa_factors_one_confirmed
  ON user_mfa_factors(user_id) WHERE confirmed_at IS NOT NULL AND disabled_at IS NULL;
CREATE UNIQUE INDEX user_mfa_factors_one_pending
  ON user_mfa_factors(user_id) WHERE confirmed_at IS NULL AND disabled_at IS NULL;

CREATE FUNCTION user_mfa_factor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mfa_factor_immutable'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext
     OR NEW.secret_iv IS DISTINCT FROM OLD.secret_iv OR NEW.secret_tag IS DISTINCT FROM OLD.secret_tag
     OR NEW.key_version IS DISTINCT FROM OLD.key_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)
     OR (OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at)
     OR (OLD.last_used_step IS NOT NULL AND (NEW.last_used_step IS NULL OR NEW.last_used_step < OLD.last_used_step)) THEN
    RAISE EXCEPTION 'mfa_factor_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_mfa_factors_guard BEFORE UPDATE OR DELETE ON user_mfa_factors
  FOR EACH ROW EXECUTE FUNCTION user_mfa_factor_guard();

-- Recovery codes: SHA-256 of a high-entropy code, single use.
CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  factor_id TEXT NOT NULL REFERENCES user_mfa_factors(id),
  code_hash TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  used_session_id TEXT REFERENCES sessions(id),
  invalidated_at TIMESTAMPTZ
);
CREATE INDEX mfa_recovery_codes_user_active_idx
  ON mfa_recovery_codes(user_id) WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE FUNCTION mfa_recovery_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mfa_recovery_code_immutable'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.factor_id IS DISTINCT FROM OLD.factor_id OR NEW.code_hash IS DISTINCT FROM OLD.code_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.used_at IS NOT NULL AND (NEW.used_at IS DISTINCT FROM OLD.used_at OR NEW.used_session_id IS DISTINCT FROM OLD.used_session_id))
     OR (OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at) THEN
    RAISE EXCEPTION 'mfa_recovery_code_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mfa_recovery_codes_guard BEFORE UPDATE OR DELETE ON mfa_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION mfa_recovery_code_guard();

-- Failed-attempt counters, separately per user and per session.
-- Proposed policy (pending D-10): 5 failures within 15 min -> 15 min lock.
CREATE TABLE mfa_rate_limits (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user','session')),
  scope_id TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id)
);

-- Sessions: a user can revoke all own sessions.
ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_revoked_reason_check
  CHECK (revoked_reason IN ('logout','rotated','admin','user_disabled','user_revoke_all'));
