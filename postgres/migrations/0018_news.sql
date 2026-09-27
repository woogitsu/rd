-- Public news (aktualności) and gallery photos with verified rights (#14).
--
-- news_photos: metadata of a photo whose file lives in private document
--   storage (document_id; FK added once the documents storage lands).
--   Author, source, date and public licence caption are mandatory. Rights
--   must be verified by a different person than the uploader. A photo with
--   children requires a consent reference for every identifiable child (and
--   adult). A copy from a public website is rejected unless an explicit
--   licence is recorded. Metadata is immutable; a correction is a new photo.
-- news_posts: draft -> submitted -> approved (four eyes) -> published;
--   withdrawn is final. Every content change is an immutable revision.
--   The database refuses approval or publication of a revision that
--   contains a photo without verified rights.
-- public_news: only the published revision of non-withdrawn posts and only
--   photos whose rights are currently verified (revocation hides at once).

CREATE TABLE news_photos (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  -- Reference to the private file in document storage (no FK yet: the
  -- storage module is developed separately; link it in a later migration).
  document_id TEXT NOT NULL CHECK (document_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  author TEXT NOT NULL CHECK (length(btrim(author)) BETWEEN 2 AND 200),
  source TEXT NOT NULL CHECK (source IN (
    'own_work', 'school_provided', 'parent_provided', 'licensed_third_party', 'public_website_copy')),
  source_detail TEXT CHECK (source_detail IS NULL OR length(btrim(source_detail)) BETWEEN 3 AND 500),
  taken_on DATE NOT NULL CHECK (taken_on >= DATE '1900-01-01'),
  -- Public caption: licence or permission statement shown under the photo.
  license_text TEXT NOT NULL CHECK (length(btrim(license_text)) BETWEEN 10 AND 1000),
  explicit_license_granted BOOLEAN NOT NULL DEFAULT false,
  license_document_ref TEXT CHECK (license_document_ref IS NULL
    OR license_document_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  -- Internal note on rights (never public).
  rights_note TEXT CHECK (rights_note IS NULL OR length(btrim(rights_note)) BETWEEN 3 AND 1000),
  alt_text TEXT CHECK (alt_text IS NULL OR length(btrim(alt_text)) BETWEEN 3 AND 300),
  depicts_children BOOLEAN NOT NULL,
  identifiable_children INTEGER NOT NULL DEFAULT 0 CHECK (identifiable_children BETWEEN 0 AND 100),
  identifiable_adults INTEGER NOT NULL DEFAULT 0 CHECK (identifiable_adults BETWEEN 0 AND 100),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rights_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (rights_status IN ('pending', 'verified', 'revoked')),
  rights_verified_by TEXT REFERENCES users(id),
  rights_verified_at TIMESTAMPTZ,
  revoked_by TEXT REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  idempotency_key TEXT UNIQUE
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$'),
  CONSTRAINT news_photo_children_flag CHECK (identifiable_children = 0 OR depicts_children),
  CONSTRAINT news_photo_verification_complete CHECK (
    (rights_verified_by IS NULL) = (rights_verified_at IS NULL)),
  CONSTRAINT news_photo_revocation_complete CHECK (
    (rights_status = 'revoked') = (revoked_at IS NOT NULL)
    AND (revoked_at IS NULL OR (revoked_by IS NOT NULL
      AND length(btrim(revocation_reason)) BETWEEN 3 AND 500)))
);
CREATE INDEX news_photos_status_idx ON news_photos(rights_status, uploaded_at);

-- One row per identifiable person: only a reference to the consent
-- document, never a name.
CREATE TABLE news_photo_consents (
  photo_id TEXT NOT NULL REFERENCES news_photos(id),
  subject_no INTEGER NOT NULL CHECK (subject_no BETWEEN 1 AND 200),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('child', 'adult')),
  consent_document_ref TEXT NOT NULL
    CHECK (consent_document_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  recorded_by TEXT NOT NULL REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (photo_id, subject_no)
);

CREATE FUNCTION news_photo_rights_problem(photo news_photos) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  child_consents INTEGER;
  adult_consents INTEGER;
BEGIN
  IF photo.source = 'public_website_copy'
     AND (NOT photo.explicit_license_granted OR photo.license_document_ref IS NULL) THEN
    RETURN 'news_photo_public_copy_requires_license';
  END IF;
  SELECT count(*) FILTER (WHERE subject_kind = 'child'), count(*) FILTER (WHERE subject_kind = 'adult')
    INTO child_consents, adult_consents
    FROM news_photo_consents WHERE photo_id = photo.id;
  IF photo.depicts_children AND child_consents = 0 THEN
    RETURN 'news_photo_child_consent_required';
  END IF;
  IF child_consents < photo.identifiable_children OR adult_consents < photo.identifiable_adults THEN
    RETURN 'news_photo_consent_missing';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION news_photo_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rights_status <> 'pending' OR NEW.rights_verified_by IS NOT NULL
     OR NEW.rights_verified_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'news_photo_must_start_pending';
  END IF;
  IF NEW.source = 'public_website_copy'
     AND (NOT NEW.explicit_license_granted OR NEW.license_document_ref IS NULL) THEN
    RAISE EXCEPTION 'news_photo_public_copy_requires_license';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER news_photos_before_insert BEFORE INSERT ON news_photos
  FOR EACH ROW EXECUTE FUNCTION news_photo_before_insert();

CREATE FUNCTION news_photo_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  problem TEXT;
BEGIN
  IF OLD.rights_status = 'revoked' THEN
    RAISE EXCEPTION 'news_photo_revoked_is_final';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['rights_status', 'rights_verified_by', 'rights_verified_at',
        'revoked_by', 'revoked_at', 'revocation_reason'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['rights_status', 'rights_verified_by', 'rights_verified_at',
        'revoked_by', 'revoked_at', 'revocation_reason']) THEN
    RAISE EXCEPTION 'news_photo_metadata_immutable';
  END IF;
  IF OLD.rights_status = 'pending' AND NEW.rights_status = 'verified' THEN
    IF NEW.rights_verified_by IS NULL OR NEW.rights_verified_at IS NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'news_photo_invalid_verification';
    END IF;
    IF NEW.rights_verified_by = NEW.uploaded_by THEN
      RAISE EXCEPTION 'news_photo_four_eyes_required';
    END IF;
    problem := news_photo_rights_problem(NEW);
    IF problem IS NOT NULL THEN
      RAISE EXCEPTION '%', problem;
    END IF;
  ELSIF NEW.rights_status = 'revoked' THEN
    IF NEW.rights_verified_by IS DISTINCT FROM OLD.rights_verified_by
       OR NEW.rights_verified_at IS DISTINCT FROM OLD.rights_verified_at THEN
      RAISE EXCEPTION 'news_photo_invalid_revocation';
    END IF;
  ELSE
    RAISE EXCEPTION 'news_photo_invalid_transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER news_photos_before_update BEFORE UPDATE ON news_photos
  FOR EACH ROW EXECUTE FUNCTION news_photo_before_update();

CREATE FUNCTION news_photo_consent_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM news_photos WHERE id = NEW.photo_id AND rights_status = 'pending') THEN
    RAISE EXCEPTION 'news_photo_consents_locked';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER news_photo_consents_guard_insert BEFORE INSERT ON news_photo_consents
  FOR EACH ROW EXECUTE FUNCTION news_photo_consent_insert_guard();

CREATE FUNCTION news_immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%_cannot_be_changed', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER news_photo_consents_no_change BEFORE UPDATE OR DELETE ON news_photo_consents
  FOR EACH ROW EXECUTE FUNCTION news_immutable_row();
CREATE TRIGGER news_photos_no_delete BEFORE DELETE ON news_photos
  FOR EACH ROW EXECUTE FUNCTION news_immutable_row();

CREATE TABLE news_posts (
  id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  class_id TEXT,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  photo_ids TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(photo_ids) <= 20),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'published', 'withdrawn')),
  revision_no INTEGER NOT NULL DEFAULT 1 CHECK (revision_no >= 1),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_revision_no INTEGER,
  submitted_by TEXT REFERENCES users(id),
  submitted_at TIMESTAMPTZ,
  approved_revision_no INTEGER,
  approved_by TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  published_revision_no INTEGER,
  published_by TEXT REFERENCES users(id),
  published_at TIMESTAMPTZ,
  first_published_at TIMESTAMPTZ,
  withdrawn_by TEXT REFERENCES users(id),
  withdrawn_at TIMESTAMPTZ,
  withdrawal_reason TEXT,
  idempotency_key TEXT UNIQUE
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$'),
  CONSTRAINT news_posts_class_same_year FOREIGN KEY (class_id, school_year_id)
    REFERENCES classes(id, school_year_id),
  CONSTRAINT news_posts_withdrawal_complete CHECK (
    (status = 'withdrawn') = (withdrawn_at IS NOT NULL)
    AND (withdrawn_at IS NULL OR (withdrawn_by IS NOT NULL
      AND length(btrim(withdrawal_reason)) BETWEEN 3 AND 500)))
);
CREATE INDEX news_posts_year_status_idx ON news_posts(school_year_id, status, updated_at);
CREATE INDEX news_posts_class_idx ON news_posts(class_id) WHERE class_id IS NOT NULL;
CREATE INDEX news_posts_public_idx ON news_posts(published_at)
  WHERE published_revision_no IS NOT NULL AND status <> 'withdrawn';

CREATE TABLE news_post_revisions (
  post_id TEXT NOT NULL REFERENCES news_posts(id),
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  photo_ids TEXT[] NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, revision_no)
);

CREATE FUNCTION news_post_check_photos(ids TEXT[], require_verified BOOLEAN) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  photo_id TEXT;
  photo_status TEXT;
BEGIN
  IF (SELECT count(DISTINCT x) FROM unnest(ids) AS x) <> cardinality(ids) THEN
    RAISE EXCEPTION 'news_post_duplicate_photo';
  END IF;
  FOREACH photo_id IN ARRAY ids LOOP
    -- FOR SHARE serialises publication with a concurrent revocation.
    SELECT rights_status INTO photo_status FROM news_photos WHERE id = photo_id FOR SHARE;
    IF photo_status IS NULL THEN
      RAISE EXCEPTION 'news_post_photo_not_found';
    END IF;
    IF photo_status = 'revoked' THEN
      RAISE EXCEPTION 'news_post_photo_revoked';
    END IF;
    IF require_verified AND photo_status <> 'verified' THEN
      RAISE EXCEPTION 'news_post_photo_rights_unverified';
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION news_post_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.revision_no <> 1
     OR NEW.submitted_revision_no IS NOT NULL OR NEW.approved_revision_no IS NOT NULL
     OR NEW.approved_by IS NOT NULL OR NEW.published_revision_no IS NOT NULL
     OR NEW.published_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'news_post_must_start_as_draft';
  END IF;
  IF NEW.updated_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'news_post_first_revision_author_mismatch';
  END IF;
  PERFORM news_post_check_photos(NEW.photo_ids, false);
  RETURN NEW;
END;
$$;
CREATE TRIGGER news_posts_before_insert BEFORE INSERT ON news_posts
  FOR EACH ROW EXECUTE FUNCTION news_post_before_insert();

CREATE FUNCTION news_post_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  content_changed BOOLEAN;
  submit_changed BOOLEAN;
  approve_changed BOOLEAN;
  publish_changed BOOLEAN;
  withdraw_changed BOOLEAN;
  revision_author TEXT;
BEGIN
  IF OLD.status = 'withdrawn' THEN
    RAISE EXCEPTION 'news_post_withdrawn_is_final';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.class_id IS DISTINCT FROM OLD.class_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'news_post_identity_immutable';
  END IF;

  content_changed := NEW.title IS DISTINCT FROM OLD.title
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.photo_ids IS DISTINCT FROM OLD.photo_ids;
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
  withdraw_changed := NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
    OR NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by
    OR NEW.withdrawal_reason IS DISTINCT FROM OLD.withdrawal_reason;

  IF content_changed THEN
    -- A change creates a new revision and returns the post to draft; the
    -- previously published revision stays public until a new one is published.
    IF submit_changed OR approve_changed OR publish_changed OR withdraw_changed
       OR NEW.status NOT IN (OLD.status, 'draft') THEN
      RAISE EXCEPTION 'news_post_content_and_workflow_change';
    END IF;
    PERFORM news_post_check_photos(NEW.photo_ids, false);
    NEW.revision_no := OLD.revision_no + 1;
    NEW.status := 'draft';
  ELSE
    IF NEW.revision_no IS DISTINCT FROM OLD.revision_no THEN
      RAISE EXCEPTION 'news_post_revision_without_change';
    END IF;
    IF NEW.status = OLD.status THEN
      IF submit_changed OR approve_changed OR publish_changed OR withdraw_changed
         OR NEW.updated_by IS DISTINCT FROM OLD.updated_by THEN
        RAISE EXCEPTION 'news_post_invalid_transition';
      END IF;
    ELSIF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
      IF approve_changed OR publish_changed OR withdraw_changed
         OR NEW.submitted_revision_no IS DISTINCT FROM NEW.revision_no
         OR NEW.submitted_by IS NULL OR NEW.submitted_at IS NULL THEN
        RAISE EXCEPTION 'news_post_invalid_submission';
      END IF;
    ELSIF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
      IF submit_changed OR publish_changed OR withdraw_changed
         OR NEW.approved_revision_no IS DISTINCT FROM NEW.revision_no
         OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
        RAISE EXCEPTION 'news_post_invalid_approval';
      END IF;
      SELECT created_by INTO revision_author FROM news_post_revisions
        WHERE post_id = NEW.id AND revision_no = NEW.revision_no;
      IF NEW.approved_by = NEW.created_by OR NEW.approved_by = revision_author THEN
        RAISE EXCEPTION 'news_post_four_eyes_required';
      END IF;
      PERFORM news_post_check_photos(NEW.photo_ids, true);
    ELSIF OLD.status = 'approved' AND NEW.status = 'published' THEN
      IF submit_changed OR approve_changed OR withdraw_changed
         OR NEW.published_revision_no IS DISTINCT FROM NEW.revision_no
         OR NEW.approved_revision_no IS DISTINCT FROM NEW.revision_no
         OR NEW.published_by IS NULL OR NEW.published_at IS NULL
         OR NEW.first_published_at IS DISTINCT FROM COALESCE(OLD.first_published_at, NEW.published_at) THEN
        RAISE EXCEPTION 'news_post_invalid_publication';
      END IF;
      PERFORM news_post_check_photos(NEW.photo_ids, true);
    ELSIF NEW.status = 'withdrawn' THEN
      IF submit_changed OR approve_changed OR publish_changed
         OR NEW.withdrawn_by IS NULL OR NEW.withdrawn_at IS NULL THEN
        RAISE EXCEPTION 'news_post_invalid_withdrawal';
      END IF;
    ELSE
      RAISE EXCEPTION 'news_post_invalid_transition';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER news_posts_before_update BEFORE UPDATE ON news_posts
  FOR EACH ROW EXECUTE FUNCTION news_post_before_update();

CREATE FUNCTION news_post_record_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.revision_no <> OLD.revision_no THEN
    INSERT INTO news_post_revisions (post_id, revision_no, title, body, photo_ids, created_by)
    VALUES (NEW.id, NEW.revision_no, NEW.title, NEW.body, NEW.photo_ids, NEW.updated_by);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER news_posts_record_revision AFTER INSERT OR UPDATE ON news_posts
  FOR EACH ROW EXECUTE FUNCTION news_post_record_revision();

CREATE TRIGGER news_posts_no_delete BEFORE DELETE ON news_posts
  FOR EACH ROW EXECUTE FUNCTION news_immutable_row();

CREATE FUNCTION news_post_revision_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM news_posts p
    WHERE p.id = NEW.post_id AND p.revision_no = NEW.revision_no
      AND p.title = NEW.title AND p.body = NEW.body AND p.photo_ids = NEW.photo_ids
      AND p.updated_by = NEW.created_by
  ) THEN
    RAISE EXCEPTION 'news_post_revision_must_match_current_post';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER news_post_revisions_guard_insert BEFORE INSERT ON news_post_revisions
  FOR EACH ROW EXECUTE FUNCTION news_post_revision_insert_guard();
CREATE TRIGGER news_post_revisions_no_change BEFORE UPDATE OR DELETE ON news_post_revisions
  FOR EACH ROW EXECUTE FUNCTION news_immutable_row();

-- Public projection: published revision only, no user ids, no workflow data,
-- no internal rights notes or consent references; only photos whose rights
-- are verified at the moment of the query.
CREATE VIEW public_news AS
SELECT p.id, p.school_year_id, r.title, r.body, p.published_at, p.first_published_at,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
        'id', ph.id,
        'author', ph.author,
        'source', ph.source,
        'license', ph.license_text,
        'takenOn', to_char(ph.taken_on, 'YYYY-MM-DD'),
        'altText', ph.alt_text) ORDER BY u.ord)
      FROM unnest(r.photo_ids) WITH ORDINALITY AS u(photo_id, ord)
      JOIN news_photos ph ON ph.id = u.photo_id AND ph.rights_status = 'verified'
  ), '[]'::jsonb) AS photos
FROM news_posts p
JOIN news_post_revisions r ON r.post_id = p.id AND r.revision_no = p.published_revision_no
WHERE p.published_revision_no IS NOT NULL AND p.status <> 'withdrawn';
