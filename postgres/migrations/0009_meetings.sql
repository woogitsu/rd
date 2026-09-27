-- Meetings, agenda, attendance, quorum, minutes and resolutions (#13).
-- The Rada regulamin is not in the repository (D-21). Quorum rules, the size of
-- the voting body and each attendee's voting eligibility are entered per meeting
-- by an authorised person; this schema does not encode any legal rule.
-- There is no electronic voting (D-19): resolutions store only the counts of
-- votes held at the meeting, entered by the secretary.
-- Attendance stores references (users/guardians ids) and a capacity, no names.

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  kind TEXT NOT NULL CHECK (kind IN ('plenary', 'board', 'class')),
  class_id TEXT,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  scheduled_at TIMESTAMPTZ NOT NULL,
  location TEXT CHECK (location IS NULL OR length(btrim(location)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'held', 'archived')),
  quorum_mode TEXT NOT NULL DEFAULT 'not_configured'
    CHECK (quorum_mode IN ('not_configured', 'fraction', 'minimum_count')),
  quorum_numerator INTEGER,
  quorum_denominator INTEGER,
  quorum_inclusive BOOLEAN,
  quorum_min_count INTEGER,
  voting_body_size INTEGER CHECK (voting_body_size IS NULL OR voting_body_size BETWEEN 1 AND 10000),
  quorum_rule_source TEXT
    CHECK (quorum_rule_source IS NULL OR length(btrim(quorum_rule_source)) BETWEEN 3 AND 200),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, school_year_id),
  FOREIGN KEY (class_id, school_year_id) REFERENCES classes(id, school_year_id),
  CONSTRAINT meeting_class_scope CHECK ((kind = 'class') = (class_id IS NOT NULL)),
  -- Every branch uses explicit IS NOT NULL so that a NULL never passes the CHECK.
  CONSTRAINT meeting_quorum_rule CHECK (
    (quorum_mode = 'not_configured'
      AND quorum_numerator IS NULL AND quorum_denominator IS NULL
      AND quorum_inclusive IS NULL AND quorum_min_count IS NULL)
    OR (quorum_mode = 'fraction'
      AND quorum_numerator IS NOT NULL AND quorum_denominator IS NOT NULL
      AND quorum_inclusive IS NOT NULL AND voting_body_size IS NOT NULL
      AND quorum_min_count IS NULL
      AND quorum_numerator >= 1 AND quorum_denominator <= 1000
      AND quorum_numerator <= quorum_denominator
      AND (quorum_inclusive OR quorum_numerator < quorum_denominator))
    OR (quorum_mode = 'minimum_count'
      AND quorum_min_count IS NOT NULL AND quorum_min_count BETWEEN 1 AND 10000
      AND quorum_numerator IS NULL AND quorum_denominator IS NULL
      AND quorum_inclusive IS NULL)
  )
);
CREATE INDEX meetings_year_date_idx ON meetings(school_year_id, scheduled_at, id);
CREATE INDEX meetings_class_idx ON meetings(class_id) WHERE class_id IS NOT NULL;

CREATE TABLE meeting_agenda_items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 200),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 300),
  description TEXT CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 2000),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, position)
);

CREATE TABLE meeting_attendees (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  user_id TEXT REFERENCES users(id),
  guardian_id TEXT REFERENCES guardians(id),
  capacity TEXT NOT NULL CHECK (capacity IN (
    'representative', 'board_member', 'audit_member', 'principal',
    'teacher', 'guardian', 'guest', 'other'
  )),
  voting_eligible BOOLEAN NOT NULL,
  present BOOLEAN NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attendee_single_reference CHECK ((user_id IS NULL) <> (guardian_id IS NULL)),
  UNIQUE (meeting_id, user_id),
  UNIQUE (meeting_id, guardian_id)
);
CREATE INDEX meeting_attendees_voting_idx
  ON meeting_attendees(meeting_id, voting_eligible, present);

CREATE TABLE meeting_quorum_checks (
  id TEXT PRIMARY KEY,
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  quorum_mode TEXT NOT NULL CHECK (quorum_mode IN ('fraction', 'minimum_count')),
  quorum_numerator INTEGER,
  quorum_denominator INTEGER,
  quorum_inclusive BOOLEAN,
  quorum_min_count INTEGER,
  voting_body_size INTEGER,
  present_eligible INTEGER NOT NULL CHECK (present_eligible >= 0),
  required_count INTEGER NOT NULL CHECK (required_count >= 1),
  met BOOLEAN NOT NULL,
  determined_by TEXT NOT NULL REFERENCES users(id),
  determined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, meeting_id)
);
CREATE INDEX meeting_quorum_checks_meeting_idx ON meeting_quorum_checks(meeting_id, seq);

CREATE TABLE meeting_minutes (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  supersedes_id TEXT UNIQUE REFERENCES meeting_minutes(id),
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 10 AND 200000),
  change_note TEXT CHECK (change_note IS NULL OR length(btrim(change_note)) BETWEEN 3 AND 500),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  approved_by TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  approval_note TEXT CHECK (approval_note IS NULL OR length(btrim(approval_note)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, version),
  CONSTRAINT minutes_approval_fields CHECK (
    (status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT minutes_first_version CHECK ((version = 1) = (supersedes_id IS NULL))
);

CREATE TABLE meeting_minutes_publications (
  id TEXT PRIMARY KEY,
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  minutes_id TEXT NOT NULL REFERENCES meeting_minutes(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('internal', 'parents', 'public')),
  reason TEXT CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX meeting_minutes_publications_idx ON meeting_minutes_publications(minutes_id, seq);

CREATE TABLE resolutions (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  -- Free-form number given by the secretary (format is decision D-15). The same
  -- trimmed text is what ledger_entries.resolution_reference should contain.
  number TEXT CHECK (number IS NULL OR (number = btrim(number) AND length(number) BETWEEN 3 AND 64)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  corrects_id TEXT UNIQUE REFERENCES resolutions(id),
  correction_reason TEXT
    CHECK (correction_reason IS NULL OR length(btrim(correction_reason)) BETWEEN 3 AND 500),
  amends_resolution_id TEXT REFERENCES resolutions(id),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 300),
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 3 AND 20000),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'adopted', 'rejected', 'withdrawn')),
  votes_for INTEGER CHECK (votes_for IS NULL OR votes_for BETWEEN 0 AND 10000),
  votes_against INTEGER CHECK (votes_against IS NULL OR votes_against BETWEEN 0 AND 10000),
  votes_abstain INTEGER CHECK (votes_abstain IS NULL OR votes_abstain BETWEEN 0 AND 10000),
  quorum_check_id TEXT,
  decided_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (meeting_id, school_year_id) REFERENCES meetings(id, school_year_id),
  FOREIGN KEY (quorum_check_id, meeting_id) REFERENCES meeting_quorum_checks(id, meeting_id),
  CONSTRAINT resolution_revision_chain CHECK ((revision = 1) = (corrects_id IS NULL)),
  CONSTRAINT resolution_correction_reason CHECK ((corrects_id IS NULL) = (correction_reason IS NULL)),
  CONSTRAINT resolution_adopted_number CHECK (status <> 'adopted' OR number IS NOT NULL),
  CONSTRAINT resolution_vote_record CHECK (
    status NOT IN ('adopted', 'rejected')
    OR (votes_for IS NOT NULL AND votes_against IS NOT NULL AND votes_abstain IS NOT NULL
        AND quorum_check_id IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CONSTRAINT resolution_open_has_no_decision CHECK (
    status IN ('adopted', 'rejected') OR decided_at IS NULL
  ),
  CONSTRAINT resolution_correction_is_final CHECK (
    corrects_id IS NULL OR status IN ('adopted', 'rejected')
  )
);
-- One resolution per number and school year; corrections reuse the number of
-- the revision they correct (enforced by trigger).
CREATE UNIQUE INDEX resolutions_number_per_year_idx
  ON resolutions(school_year_id, number) WHERE corrects_id IS NULL;
CREATE INDEX resolutions_meeting_idx ON resolutions(meeting_id);

-- Idempotency keys for create operations of the meetings API. The request hash
-- is a SHA-256 of the normalised input; no request content is stored.
CREATE TABLE meeting_request_keys (
  idempotency_key TEXT PRIMARY KEY
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  actor_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION meeting_has_approved_minutes(p_meeting_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM meeting_minutes WHERE meeting_id = p_meeting_id AND status = 'approved'
  );
$$;

-- A meeting is locked once archived or once any minutes version is approved:
-- attendance, agenda, quorum checks and resolutions are then frozen.
CREATE FUNCTION meeting_assert_editable(p_meeting_id TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE current_status TEXT;
BEGIN
  SELECT status INTO current_status FROM meetings WHERE id = p_meeting_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'meeting_not_found'; END IF;
  IF current_status = 'archived' OR meeting_has_approved_minutes(p_meeting_id) THEN
    RAISE EXCEPTION 'meeting_locked';
  END IF;
END;
$$;

CREATE FUNCTION meeting_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%_cannot_be_changed', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION meeting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'meetings_cannot_be_deleted'; END IF;
  IF ROW(NEW.id, NEW.school_year_id, NEW.kind, NEW.class_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.school_year_id, OLD.kind, OLD.class_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'meeting_identity_immutable';
  END IF;
  IF OLD.status = 'archived' THEN RAISE EXCEPTION 'meeting_locked'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'scheduled')
    OR (OLD.status = 'scheduled' AND NEW.status IN ('draft', 'held'))
    OR (OLD.status = 'held' AND NEW.status = 'archived')
  ) THEN
    RAISE EXCEPTION 'meeting_status_transition_invalid';
  END IF;
  IF NEW.status = 'archived' AND NOT meeting_has_approved_minutes(OLD.id) THEN
    RAISE EXCEPTION 'meeting_archive_requires_approved_minutes';
  END IF;
  IF meeting_has_approved_minutes(OLD.id) AND
     ROW(NEW.title, NEW.scheduled_at, NEW.location, NEW.quorum_mode, NEW.quorum_numerator,
         NEW.quorum_denominator, NEW.quorum_inclusive, NEW.quorum_min_count,
         NEW.voting_body_size, NEW.quorum_rule_source)
     IS DISTINCT FROM
     ROW(OLD.title, OLD.scheduled_at, OLD.location, OLD.quorum_mode, OLD.quorum_numerator,
         OLD.quorum_denominator, OLD.quorum_inclusive, OLD.quorum_min_count,
         OLD.voting_body_size, OLD.quorum_rule_source) THEN
    RAISE EXCEPTION 'meeting_locked';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER meetings_guard_update BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION meeting_guard();
CREATE TRIGGER meetings_guard_delete BEFORE DELETE ON meetings
  FOR EACH ROW EXECUTE FUNCTION meeting_guard();

CREATE FUNCTION meeting_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'meeting_must_start_as_draft_or_scheduled';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meetings_guard_insert BEFORE INSERT ON meetings
  FOR EACH ROW EXECUTE FUNCTION meeting_insert_guard();

-- Agenda items and attendance rows may be corrected until the meeting locks.
CREATE FUNCTION meeting_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '%_cannot_be_deleted', TG_TABLE_NAME; END IF;
  IF TG_OP = 'UPDATE' AND NEW.meeting_id IS DISTINCT FROM OLD.meeting_id THEN
    RAISE EXCEPTION '%_meeting_immutable', TG_TABLE_NAME;
  END IF;
  PERFORM meeting_assert_editable(NEW.meeting_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_agenda_items_guard BEFORE INSERT OR UPDATE OR DELETE ON meeting_agenda_items
  FOR EACH ROW EXECUTE FUNCTION meeting_child_guard();

CREATE FUNCTION meeting_attendee_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'meeting_attendees_cannot_be_deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.meeting_id, NEW.user_id, NEW.guardian_id)
       IS DISTINCT FROM ROW(OLD.id, OLD.meeting_id, OLD.user_id, OLD.guardian_id) THEN
      RAISE EXCEPTION 'meeting_attendee_reference_immutable';
    END IF;
    NEW.updated_at := now();
  END IF;
  PERFORM meeting_assert_editable(NEW.meeting_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_attendees_guard BEFORE INSERT OR UPDATE OR DELETE ON meeting_attendees
  FOR EACH ROW EXECUTE FUNCTION meeting_attendee_guard();

-- The quorum result is always computed here from the stored rule and the
-- attendance list; values supplied by the client are overwritten.
CREATE FUNCTION meeting_quorum_compute() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m meetings%ROWTYPE;
DECLARE present_count INTEGER;
BEGIN
  PERFORM meeting_assert_editable(NEW.meeting_id);
  SELECT * INTO m FROM meetings WHERE id = NEW.meeting_id;
  IF m.status <> 'held' THEN RAISE EXCEPTION 'quorum_requires_held_meeting'; END IF;
  IF m.quorum_mode = 'not_configured' THEN RAISE EXCEPTION 'quorum_rule_not_configured'; END IF;
  SELECT count(*) INTO present_count FROM meeting_attendees
    WHERE meeting_id = NEW.meeting_id AND present AND voting_eligible;
  IF m.voting_body_size IS NOT NULL AND present_count > m.voting_body_size THEN
    RAISE EXCEPTION 'quorum_attendance_exceeds_voting_body';
  END IF;
  NEW.quorum_mode := m.quorum_mode;
  NEW.quorum_numerator := m.quorum_numerator;
  NEW.quorum_denominator := m.quorum_denominator;
  NEW.quorum_inclusive := m.quorum_inclusive;
  NEW.quorum_min_count := m.quorum_min_count;
  NEW.voting_body_size := m.voting_body_size;
  NEW.present_eligible := present_count;
  IF m.quorum_mode = 'fraction' THEN
    IF m.quorum_inclusive THEN
      -- at least numerator/denominator of the voting body (rounded up)
      NEW.required_count := (m.quorum_numerator * m.voting_body_size + m.quorum_denominator - 1)
        / m.quorum_denominator;
    ELSE
      -- more than numerator/denominator of the voting body
      NEW.required_count := (m.quorum_numerator * m.voting_body_size) / m.quorum_denominator + 1;
    END IF;
  ELSE
    NEW.required_count := m.quorum_min_count;
  END IF;
  NEW.required_count := GREATEST(NEW.required_count, 1);
  NEW.met := present_count >= NEW.required_count;
  NEW.determined_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_quorum_checks_compute BEFORE INSERT ON meeting_quorum_checks
  FOR EACH ROW EXECUTE FUNCTION meeting_quorum_compute();
CREATE TRIGGER meeting_quorum_checks_no_change BEFORE UPDATE OR DELETE ON meeting_quorum_checks
  FOR EACH ROW EXECUTE FUNCTION meeting_record_immutable();

CREATE FUNCTION meeting_minutes_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status TEXT;
DECLARE latest meeting_minutes%ROWTYPE;
BEGIN
  -- Row lock serialises version numbering and approval for one meeting.
  SELECT status INTO current_status FROM meetings WHERE id = NEW.meeting_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'meeting_not_found'; END IF;
  IF current_status <> 'held' THEN RAISE EXCEPTION 'minutes_require_held_meeting'; END IF;
  IF NEW.status <> 'draft' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'minutes_must_start_as_draft';
  END IF;
  SELECT * INTO latest FROM meeting_minutes
    WHERE meeting_id = NEW.meeting_id ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.version <> 1 OR NEW.supersedes_id IS NOT NULL THEN
      RAISE EXCEPTION 'minutes_version_mismatch';
    END IF;
  ELSIF NEW.supersedes_id IS DISTINCT FROM latest.id OR NEW.version <> latest.version + 1 THEN
    RAISE EXCEPTION 'minutes_version_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_minutes_guard_insert BEFORE INSERT ON meeting_minutes
  FOR EACH ROW EXECUTE FUNCTION meeting_minutes_insert_guard();

-- The only permitted change is approving the latest draft. Approved versions
-- and drafts are otherwise immutable; a correction is a new version.
CREATE FUNCTION meeting_minutes_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'meeting_minutes_cannot_be_deleted'; END IF;
  IF OLD.status = 'approved' THEN RAISE EXCEPTION 'minutes_approved_immutable'; END IF;
  IF NEW.status <> 'approved' OR
     ROW(NEW.id, NEW.meeting_id, NEW.version, NEW.supersedes_id, NEW.body, NEW.change_note,
         NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.meeting_id, OLD.version, OLD.supersedes_id, OLD.body, OLD.change_note,
         OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'minutes_version_immutable';
  END IF;
  SELECT status INTO current_status FROM meetings WHERE id = OLD.meeting_id FOR UPDATE;
  IF current_status <> 'held' THEN RAISE EXCEPTION 'meeting_locked'; END IF;
  IF EXISTS (SELECT 1 FROM meeting_minutes WHERE supersedes_id = OLD.id) THEN
    RAISE EXCEPTION 'minutes_not_latest_version';
  END IF;
  NEW.approved_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_minutes_guard_change BEFORE UPDATE OR DELETE ON meeting_minutes
  FOR EACH ROW EXECUTE FUNCTION meeting_minutes_change_guard();

CREATE FUNCTION meeting_minutes_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM meeting_minutes WHERE id = NEW.minutes_id AND status = 'approved' FOR SHARE
  ) THEN
    RAISE EXCEPTION 'minutes_not_approved';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_minutes_publications_guard BEFORE INSERT ON meeting_minutes_publications
  FOR EACH ROW EXECUTE FUNCTION meeting_minutes_publication_guard();
CREATE TRIGGER meeting_minutes_publications_no_change BEFORE UPDATE OR DELETE ON meeting_minutes_publications
  FOR EACH ROW EXECUTE FUNCTION meeting_record_immutable();

CREATE FUNCTION resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous resolutions%ROWTYPE;
DECLARE current_status TEXT;
DECLARE present_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'resolutions_cannot_be_deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'resolution_final_immutable'; END IF;
    IF ROW(NEW.id, NEW.school_year_id, NEW.meeting_id, NEW.revision, NEW.corrects_id,
           NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.school_year_id, OLD.meeting_id, OLD.revision, OLD.corrects_id,
           OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'resolution_identity_immutable';
    END IF;
  END IF;
  PERFORM meeting_assert_editable(NEW.meeting_id);
  IF TG_OP = 'INSERT' AND NEW.corrects_id IS NOT NULL THEN
    SELECT * INTO previous FROM resolutions WHERE id = NEW.corrects_id FOR UPDATE;
    IF NOT FOUND OR previous.status NOT IN ('adopted', 'rejected')
       OR previous.meeting_id <> NEW.meeting_id
       OR previous.school_year_id <> NEW.school_year_id
       OR previous.number IS DISTINCT FROM NEW.number
       OR NEW.revision <> previous.revision + 1 THEN
      RAISE EXCEPTION 'resolution_correction_mismatch';
    END IF;
  END IF;
  IF NEW.amends_resolution_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM resolutions WHERE id = NEW.amends_resolution_id AND status = 'adopted'
  ) THEN
    RAISE EXCEPTION 'resolution_amends_requires_adopted';
  END IF;
  IF NEW.status IN ('adopted', 'rejected') THEN
    SELECT status INTO current_status FROM meetings WHERE id = NEW.meeting_id;
    IF current_status <> 'held' THEN RAISE EXCEPTION 'resolution_requires_held_meeting'; END IF;
    SELECT present_eligible INTO present_count FROM meeting_quorum_checks
      WHERE id = NEW.quorum_check_id AND meeting_id = NEW.meeting_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'resolution_quorum_check_required'; END IF;
    IF COALESCE(NEW.votes_for, 0) + COALESCE(NEW.votes_against, 0)
       + COALESCE(NEW.votes_abstain, 0) > present_count THEN
      RAISE EXCEPTION 'resolution_votes_exceed_present_voters';
    END IF;
    NEW.decided_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER resolutions_guard BEFORE INSERT OR UPDATE OR DELETE ON resolutions
  FOR EACH ROW EXECUTE FUNCTION resolution_guard();

CREATE TRIGGER meeting_request_keys_no_change BEFORE UPDATE OR DELETE ON meeting_request_keys
  FOR EACH ROW EXECUTE FUNCTION meeting_record_immutable();

-- Current visibility of each minutes version (default internal).
CREATE VIEW meeting_minutes_visibility AS
SELECT m.id AS minutes_id, COALESCE(p.visibility, 'internal') AS visibility,
  p.created_at AS visibility_set_at
FROM meeting_minutes m
LEFT JOIN LATERAL (
  SELECT visibility, created_at FROM meeting_minutes_publications pub
  WHERE pub.minutes_id = m.id ORDER BY pub.seq DESC LIMIT 1
) p ON true;

-- Latest approved version per meeting. A newer approved correction replaces the
-- previous one and starts as internal until explicitly shared.
CREATE VIEW meeting_effective_minutes AS
SELECT DISTINCT ON (mm.meeting_id)
  mm.id, mm.meeting_id, mm.version, mm.body, mm.approved_at, v.visibility
FROM meeting_minutes mm
JOIN meeting_minutes_visibility v ON v.minutes_id = mm.id
WHERE mm.status = 'approved'
ORDER BY mm.meeting_id, mm.version DESC;

-- Latest revision of each resolution.
CREATE VIEW resolution_current AS
SELECT r.* FROM resolutions r
WHERE NOT EXISTS (SELECT 1 FROM resolutions newer WHERE newer.corrects_id = r.id);

-- Helps reconcile expenses above 3000 EUR with adopted resolutions. The ledger
-- itself is unchanged: its CHECK still only requires a textual reference (D-15).
CREATE VIEW ledger_resolution_links AS
SELECT e.id AS ledger_entry_id, e.school_year_id, e.amount_cents,
  e.resolution_reference, r.id AS resolution_id, r.status AS resolution_status
FROM ledger_entries e
LEFT JOIN resolution_current r
  ON r.school_year_id = e.school_year_id
 AND r.number = btrim(e.resolution_reference)
 AND r.status = 'adopted'
WHERE e.resolution_reference IS NOT NULL;
