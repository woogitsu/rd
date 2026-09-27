-- Sessions, role grants and invitations for the PostgreSQL API (issue #35).
-- Adds nullable/defaulted columns, constraints and guards only.
-- Existing rows keep their meaning; no row is rewritten or deleted.

-- Role grants: who granted, and revocation without deleting history.
ALTER TABLE role_grants
  ADD COLUMN granted_by TEXT REFERENCES users(id),
  ADD COLUMN granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN revoked_at TIMESTAMPTZ,
  ADD COLUMN revoked_by TEXT REFERENCES users(id),
  ADD COLUMN source_invitation_id TEXT UNIQUE REFERENCES invitations(id),
  ADD CONSTRAINT role_grant_revocation_actor CHECK (revoked_at IS NULL OR revoked_by IS NOT NULL);
CREATE INDEX role_grants_user_active_idx ON role_grants(user_id) WHERE revoked_at IS NULL;

-- A grant is never deleted; after revocation it cannot be restored or re-scoped.
-- Only expires_at, revoked_at and revoked_by may change on an active grant;
-- a new scope is a new row.
CREATE FUNCTION role_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'role_grants_cannot_be_deleted';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'role_grant_already_revoked';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.role IS DISTINCT FROM OLD.role OR NEW.class_id IS DISTINCT FROM OLD.class_id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.source_invitation_id IS DISTINCT FROM OLD.source_invitation_id THEN
    RAISE EXCEPTION 'role_grant_scope_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_grants_guard BEFORE UPDATE OR DELETE ON role_grants
  FOR EACH ROW EXECUTE FUNCTION role_grant_guard();

-- Invitations: one-time use, actor of acceptance and revocation.
ALTER TABLE invitations
  ADD COLUMN accepted_by TEXT REFERENCES users(id),
  ADD COLUMN revoked_by TEXT REFERENCES users(id),
  ADD CONSTRAINT invitation_single_outcome CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  ADD CONSTRAINT invitation_accept_actor CHECK (accepted_at IS NULL OR accepted_by IS NOT NULL),
  ADD CONSTRAINT invitation_revoke_actor CHECK (revoked_at IS NULL OR revoked_by IS NOT NULL);

-- An accepted or revoked invitation is final.
CREATE FUNCTION invitation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invitations_cannot_be_deleted';
  END IF;
  IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation_already_closed';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.class_id IS DISTINCT FROM OLD.class_id OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'invitation_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitations_guard BEFORE UPDATE OR DELETE ON invitations
  FOR EACH ROW EXECUTE FUNCTION invitation_guard();

-- Sessions: revocation reason and rotation chain.
ALTER TABLE sessions
  ADD COLUMN revoked_reason TEXT
    CHECK (revoked_reason IN ('logout','rotated','admin','user_disabled')),
  ADD COLUMN rotated_from TEXT REFERENCES sessions(id);

-- Audit log is append-only; a correction is a new event.
CREATE FUNCTION audit_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events_are_append_only';
END $$;
CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();
