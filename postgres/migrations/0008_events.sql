-- Events: internal draft -> submission -> approval (four eyes) -> publication.
-- Every content change is stored as an immutable revision in event_revisions.
-- The public calendar reads only the revision recorded in published_revision_no.
-- Times are stored as TIMESTAMPTZ (UTC instants); the only supported display
-- zone is Europe/Brussels.

ALTER TABLE events
  ADD COLUMN class_id TEXT,
  ADD COLUMN location TEXT CHECK (location IS NULL OR length(btrim(location)) BETWEEN 1 AND 200),
  ADD COLUMN organizer TEXT CHECK (organizer IS NULL OR length(btrim(organizer)) BETWEEN 1 AND 200),
  ADD COLUMN ends_at TIMESTAMPTZ,
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/Brussels'
    CHECK (timezone = 'Europe/Brussels'),
  ADD COLUMN audience TEXT CHECK (audience IN ('internal', 'public')),
  ADD COLUMN status TEXT
    CHECK (status IN ('draft', 'submitted', 'approved', 'published', 'cancelled')),
  ADD COLUMN revision_no INTEGER CHECK (revision_no >= 1),
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_by TEXT REFERENCES users(id),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN submitted_revision_no INTEGER,
  ADD COLUMN submitted_by TEXT REFERENCES users(id),
  ADD COLUMN submitted_at TIMESTAMPTZ,
  ADD COLUMN approved_revision_no INTEGER,
  ADD COLUMN approved_by TEXT REFERENCES users(id),
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD COLUMN published_revision_no INTEGER,
  ADD COLUMN published_by TEXT REFERENCES users(id),
  ADD COLUMN first_published_at TIMESTAMPTZ,
  ADD COLUMN cancelled_by TEXT REFERENCES users(id),
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN cancellation_reason TEXT,
  ADD COLUMN idempotency_key TEXT UNIQUE
    CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 8 AND 128);

-- Backfill rows that may already exist (empty on a fresh database).
UPDATE events SET
  audience = CASE WHEN visibility = 'internal' THEN 'internal' ELSE 'public' END,
  status = CASE WHEN visibility = 'published' THEN 'published' ELSE 'draft' END,
  revision_no = 1,
  updated_by = created_by,
  published_revision_no = CASE WHEN visibility = 'published' THEN 1 END,
  published_at = CASE WHEN visibility = 'published' THEN COALESCE(published_at, now()) END,
  first_published_at = CASE WHEN visibility = 'published' THEN COALESCE(published_at, now()) END;

ALTER TABLE events
  ALTER COLUMN audience SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN revision_no SET NOT NULL,
  ALTER COLUMN updated_by SET NOT NULL,
  ADD CONSTRAINT events_class_same_year FOREIGN KEY (class_id, school_year_id)
    REFERENCES classes(id, school_year_id),
  ADD CONSTRAINT events_end_after_start CHECK (ends_at IS NULL OR ends_at >= begins_at),
  ADD CONSTRAINT events_cancellation_complete CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (cancelled_at IS NULL OR (cancelled_by IS NOT NULL
      AND length(btrim(cancellation_reason)) BETWEEN 3 AND 500))
  ),
  ADD CONSTRAINT events_visibility_matches_publication CHECK (
    (visibility = 'published') = (published_revision_no IS NOT NULL)
  );

CREATE INDEX events_year_status_idx ON events(school_year_id, status, begins_at);
CREATE INDEX events_class_idx ON events(class_id, begins_at) WHERE class_id IS NOT NULL;
CREATE INDEX events_published_idx ON events(begins_at) WHERE published_revision_no IS NOT NULL;

CREATE TABLE event_revisions (
  event_id TEXT NOT NULL REFERENCES events(id),
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  title TEXT NOT NULL,
  description TEXT,
  begins_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  location TEXT,
  organizer TEXT,
  audience TEXT NOT NULL CHECK (audience IN ('internal', 'public')),
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'legacy_d1')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, revision_no),
  CONSTRAINT event_revision_end_after_start CHECK (ends_at IS NULL OR ends_at >= begins_at)
);

INSERT INTO event_revisions (event_id, revision_no, title, description, begins_at, ends_at,
  location, organizer, audience, source, created_by)
SELECT id, 1, title, description, begins_at, ends_at, location, organizer, audience,
  CASE WHEN status = 'published' THEN 'legacy_d1' ELSE 'app' END, created_by
FROM events;

CREATE FUNCTION event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision_no := 1;
  NEW.updated_by := COALESCE(NEW.updated_by, NEW.created_by);
  IF NEW.updated_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'event_first_revision_author_mismatch';
  END IF;
  IF NEW.audience IS NULL THEN
    NEW.audience := CASE WHEN NEW.visibility = 'internal' THEN 'internal' ELSE 'public' END;
  END IF;
  IF NEW.visibility = 'published' THEN
    -- Legacy D1 restore only: the old system published without a recorded
    -- approval. The application never inserts published rows.
    IF NEW.status IS NOT NULL AND NEW.status <> 'published' THEN
      RAISE EXCEPTION 'event_invalid_initial_status';
    END IF;
    NEW.status := 'published';
    NEW.audience := 'public';
    NEW.published_revision_no := 1;
    NEW.published_at := COALESCE(NEW.published_at, now());
    NEW.first_published_at := NEW.published_at;
  ELSE
    IF COALESCE(NEW.status, 'draft') <> 'draft'
       OR NEW.published_at IS NOT NULL OR NEW.published_revision_no IS NOT NULL
       OR NEW.submitted_revision_no IS NOT NULL OR NEW.approved_revision_no IS NOT NULL
       OR NEW.approved_by IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'event_must_start_as_draft';
    END IF;
    NEW.status := 'draft';
    NEW.visibility := CASE WHEN NEW.audience = 'public' THEN 'draft_public' ELSE 'internal' END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER events_before_insert BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION event_before_insert();

CREATE FUNCTION event_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  content_changed BOOLEAN;
  revision_author TEXT;
  submit_changed BOOLEAN;
  approve_changed BOOLEAN;
  publish_changed BOOLEAN;
  cancel_changed BOOLEAN;
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'event_cancelled_is_final';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.class_id IS DISTINCT FROM OLD.class_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.timezone IS DISTINCT FROM OLD.timezone
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'event_identity_immutable';
  END IF;

  content_changed := NEW.title IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.begins_at IS DISTINCT FROM OLD.begins_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.location IS DISTINCT FROM OLD.location
    OR NEW.organizer IS DISTINCT FROM OLD.organizer
    OR NEW.audience IS DISTINCT FROM OLD.audience;
  submit_changed := NEW.submitted_revision_no IS DISTINCT FROM OLD.submitted_revision_no
    OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at;
  approve_changed := NEW.approved_revision_no IS DISTINCT FROM OLD.approved_revision_no
    OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at;
  publish_changed := NEW.published_revision_no IS DISTINCT FROM OLD.published_revision_no
    OR NEW.published_by IS DISTINCT FROM OLD.published_by
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.first_published_at IS DISTINCT FROM OLD.first_published_at;
  cancel_changed := NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
    OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
    OR NEW.cancellation_reason IS DISTINCT FROM OLD.cancellation_reason;

  IF content_changed THEN
    -- A change always creates a new revision and returns the event to draft.
    -- The previously published revision stays public until a new one is published.
    IF submit_changed OR approve_changed OR publish_changed OR cancel_changed
       OR NEW.status NOT IN (OLD.status, 'draft') THEN
      RAISE EXCEPTION 'event_content_and_workflow_change';
    END IF;
    IF NEW.updated_by IS NULL THEN RAISE EXCEPTION 'event_revision_author_required'; END IF;
    NEW.revision_no := OLD.revision_no + 1;
    NEW.status := 'draft';
  ELSE
    IF NEW.revision_no IS DISTINCT FROM OLD.revision_no THEN
      RAISE EXCEPTION 'event_revision_without_change';
    END IF;
    IF NEW.status = OLD.status THEN
      IF submit_changed OR approve_changed OR publish_changed OR cancel_changed THEN
        RAISE EXCEPTION 'event_invalid_transition';
      END IF;
    ELSIF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
      IF approve_changed OR publish_changed OR cancel_changed
         OR NEW.submitted_revision_no IS DISTINCT FROM NEW.revision_no
         OR NEW.submitted_by IS NULL OR NEW.submitted_at IS NULL THEN
        RAISE EXCEPTION 'event_invalid_submission';
      END IF;
    ELSIF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
      IF submit_changed OR publish_changed OR cancel_changed
         OR NEW.approved_revision_no IS DISTINCT FROM NEW.revision_no
         OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
        RAISE EXCEPTION 'event_invalid_approval';
      END IF;
      SELECT created_by INTO revision_author FROM event_revisions
        WHERE event_id = NEW.id AND revision_no = NEW.revision_no;
      IF NEW.approved_by = NEW.created_by OR NEW.approved_by = revision_author THEN
        RAISE EXCEPTION 'event_four_eyes_required';
      END IF;
    ELSIF OLD.status = 'approved' AND NEW.status = 'published' THEN
      IF submit_changed OR approve_changed OR cancel_changed
         OR NEW.audience <> 'public'
         OR NEW.published_revision_no IS DISTINCT FROM NEW.revision_no
         OR NEW.approved_revision_no IS DISTINCT FROM NEW.revision_no
         OR NEW.published_by IS NULL OR NEW.published_at IS NULL
         OR NEW.first_published_at IS DISTINCT FROM COALESCE(OLD.first_published_at, NEW.published_at) THEN
        RAISE EXCEPTION 'event_invalid_publication';
      END IF;
    ELSIF NEW.status = 'cancelled' THEN
      IF submit_changed OR approve_changed OR publish_changed THEN
        RAISE EXCEPTION 'event_invalid_cancellation';
      END IF;
    ELSE
      RAISE EXCEPTION 'event_invalid_transition';
    END IF;
  END IF;

  NEW.visibility := CASE
    WHEN NEW.published_revision_no IS NOT NULL THEN 'published'
    WHEN NEW.audience = 'public' THEN 'draft_public'
    ELSE 'internal' END;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER events_before_update BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION event_before_update();

CREATE FUNCTION event_record_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.revision_no <> OLD.revision_no THEN
    INSERT INTO event_revisions (event_id, revision_no, title, description, begins_at, ends_at,
      location, organizer, audience, source, created_by)
    VALUES (NEW.id, NEW.revision_no, NEW.title, NEW.description, NEW.begins_at, NEW.ends_at,
      NEW.location, NEW.organizer, NEW.audience,
      CASE WHEN TG_OP = 'INSERT' AND NEW.status = 'published' THEN 'legacy_d1' ELSE 'app' END,
      NEW.updated_by);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER events_record_revision AFTER INSERT OR UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION event_record_revision();

CREATE FUNCTION event_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events_cannot_be_deleted';
END;
$$;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION event_no_delete();

CREATE FUNCTION event_revision_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.id = NEW.event_id AND e.revision_no = NEW.revision_no
      AND e.title = NEW.title AND e.begins_at = NEW.begins_at
      AND e.description IS NOT DISTINCT FROM NEW.description
      AND e.ends_at IS NOT DISTINCT FROM NEW.ends_at
      AND e.location IS NOT DISTINCT FROM NEW.location
      AND e.organizer IS NOT DISTINCT FROM NEW.organizer
      AND e.audience = NEW.audience
  ) THEN
    RAISE EXCEPTION 'event_revision_must_match_current_event';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_revisions_guard_insert BEFORE INSERT ON event_revisions
  FOR EACH ROW EXECUTE FUNCTION event_revision_insert_guard();

CREATE FUNCTION event_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%_cannot_be_changed', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER event_revisions_no_change BEFORE UPDATE OR DELETE ON event_revisions
  FOR EACH ROW EXECUTE FUNCTION event_revision_immutable();

-- Public projection: only the published revision, no creator identities,
-- no internal workflow data and no cancellation reason.
CREATE VIEW public_events AS
SELECT e.id, e.school_year_id, r.title, r.description, r.begins_at, r.ends_at,
  r.location, r.organizer, e.timezone,
  CASE WHEN e.status = 'cancelled' THEN 'cancelled' ELSE 'scheduled' END AS public_status,
  e.cancelled_at, e.published_at, e.first_published_at
FROM events e
JOIN event_revisions r ON r.event_id = e.id AND r.revision_no = e.published_revision_no
WHERE e.published_revision_no IS NOT NULL AND r.audience = 'public';
