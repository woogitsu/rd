-- Meetings integrity before minutes approval (#81).
--
-- 1. Minutes cannot be approved while the meeting still has draft resolutions
--    (`minutes_open_resolutions`). The first approval locks the meeting for
--    good, so an open draft would otherwise stay undecided in the register.
--    A draft must first be decided (adopted/rejected) or withdrawn
--    (status `withdrawn`; the row stays, the change is audited by the API).
-- 2. Every insert or update of a meeting_attendees row bumps a per-meeting
--    attendance revision. A quorum check stores the revision it was computed
--    from. Adopting or rejecting a resolution requires a quorum check computed
--    from the current revision (`resolution_quorum_check_stale`); a correction
--    of a final resolution may keep the check of the revision it corrects.
--    ASSUMPTION (D-21 open): a stale check blocks the decision instead of only
--    warning; this is the stricter variant until the regulamin decides.
--
-- Data effects: adds table meeting_attendance_state and the nullable column
-- meeting_quorum_checks.attendance_revision. Existing quorum checks get NULL
-- ("unknown revision") and therefore count as stale: a new decision on an
-- already held meeting needs a fresh quorum check. Existing resolutions,
-- attendance and minutes rows are not changed. A meeting whose minutes were
-- approved before this migration and still has draft resolutions stays locked
-- as it is; this migration does not repair it.
-- Rollback on an empty database: drop the triggers, functions, the column and
-- the table. On a database with data, only after a backup — the column is part
-- of the quorum history.

CREATE TABLE meeting_attendance_state (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(id),
  revision BIGINT NOT NULL CHECK (revision >= 0)
);

ALTER TABLE meeting_quorum_checks
  ADD COLUMN attendance_revision BIGINT CHECK (attendance_revision IS NULL OR attendance_revision >= 0);

-- The revision only grows and the row is never deleted.
CREATE FUNCTION meeting_attendance_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'meeting_attendance_state_cannot_be_deleted'; END IF;
  IF NEW.meeting_id IS DISTINCT FROM OLD.meeting_id OR NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'meeting_attendance_state_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_attendance_state_guard BEFORE UPDATE OR DELETE ON meeting_attendance_state
  FOR EACH ROW EXECUTE FUNCTION meeting_attendance_state_guard();

-- AFTER trigger: runs only when meeting_attendee_guard accepted the change.
-- The row lock on meeting_attendance_state is held until commit, so a quorum
-- check or a resolution decision waits for a concurrent attendance change.
CREATE FUNCTION meeting_attendance_bump_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO meeting_attendance_state (meeting_id, revision) VALUES (NEW.meeting_id, 1)
  ON CONFLICT (meeting_id) DO UPDATE SET revision = meeting_attendance_state.revision + 1;
  RETURN NULL;
END;
$$;
CREATE TRIGGER meeting_attendees_bump_revision AFTER INSERT OR UPDATE ON meeting_attendees
  FOR EACH ROW EXECUTE FUNCTION meeting_attendance_bump_revision();

-- Current attendance revision of a meeting, locked FOR SHARE until commit.
CREATE FUNCTION meeting_attendance_revision_locked(p_meeting_id TEXT) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE current_revision BIGINT;
BEGIN
  INSERT INTO meeting_attendance_state (meeting_id, revision) VALUES (p_meeting_id, 0)
  ON CONFLICT (meeting_id) DO NOTHING;
  SELECT revision INTO current_revision FROM meeting_attendance_state
    WHERE meeting_id = p_meeting_id FOR SHARE;
  RETURN current_revision;
END;
$$;

-- Named "a0_..." so it runs before meeting_quorum_checks_compute (triggers of
-- one event fire in name order): the revision is locked before the attendees
-- are counted, so the count and the revision describe the same list.
CREATE FUNCTION meeting_quorum_snapshot_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM meetings WHERE id = NEW.meeting_id) THEN
    RAISE EXCEPTION 'meeting_not_found';
  END IF;
  NEW.attendance_revision := meeting_attendance_revision_locked(NEW.meeting_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_quorum_checks_a0_revision BEFORE INSERT ON meeting_quorum_checks
  FOR EACH ROW EXECUTE FUNCTION meeting_quorum_snapshot_revision();

-- Runs after resolutions_guard (name order), which already validated the row.
CREATE FUNCTION resolution_quorum_current_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE check_revision BIGINT;
DECLARE previous_check TEXT;
BEGIN
  IF NEW.status NOT IN ('adopted', 'rejected') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND NEW.corrects_id IS NOT NULL THEN
    SELECT quorum_check_id INTO previous_check FROM resolutions WHERE id = NEW.corrects_id;
    -- A correction keeping the original basis of the vote.
    IF NEW.quorum_check_id IS NOT DISTINCT FROM previous_check THEN RETURN NEW; END IF;
  END IF;
  SELECT attendance_revision INTO check_revision FROM meeting_quorum_checks
    WHERE id = NEW.quorum_check_id AND meeting_id = NEW.meeting_id;
  IF check_revision IS NULL
     OR check_revision <> meeting_attendance_revision_locked(NEW.meeting_id) THEN
    RAISE EXCEPTION 'resolution_quorum_check_stale';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resolutions_quorum_current_guard BEFORE INSERT OR UPDATE ON resolutions
  FOR EACH ROW EXECUTE FUNCTION resolution_quorum_current_guard();

-- Runs after meeting_minutes_guard_change (name order), which takes the
-- meetings row FOR UPDATE; resolution changes take it FOR SHARE, so no draft
-- can appear between this check and the commit of the approval.
CREATE FUNCTION meeting_minutes_open_resolutions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status = 'draft' AND EXISTS (
    SELECT 1 FROM resolutions WHERE meeting_id = NEW.meeting_id AND status = 'draft'
  ) THEN
    RAISE EXCEPTION 'minutes_open_resolutions';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_minutes_open_resolutions_guard BEFORE UPDATE ON meeting_minutes
  FOR EACH ROW EXECUTE FUNCTION meeting_minutes_open_resolutions_guard();
