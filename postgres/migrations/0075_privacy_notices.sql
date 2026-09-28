-- #145: wersjonowana informacja o przetwarzaniu danych (D-06) jako warunek
-- importu (i, w przyszłych PR-ach, kampanii e-mail i wydruku kartek — patrz
-- opis w PR: te dwie bramki są świadomie poza zakresem tej migracji z powodu
-- kolizji z równoległymi PR-ami #303/#306/#309 dotykającymi email_campaigns
-- i print/core.js).
--
-- Skutki dla danych: dwie nowe, puste tabele (`privacy_notices`,
-- `privacy_notice_deliveries`) oraz jedna nullable kolumna
-- `import_batches.privacy_notice_id` (istniejące wiersze zostają NULL —
-- importy sprzed tej migracji nie miały i nie mogły mieć powiązanej wersji).
-- Brak zmian w innych tabelach.
--
-- Treść informacji (`body_text`) wpisuje zarząd/administrator — kod nie
-- dostarcza żadnej treści domyślnej ani wartości `decision_ref`.

CREATE SEQUENCE privacy_notice_version_seq;

CREATE TABLE privacy_notices (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE DEFAULT nextval('privacy_notice_version_seq'),
  school_year_id TEXT REFERENCES school_years(id),
  body_text TEXT NOT NULL CHECK (length(btrim(body_text)) BETWEEN 1 AND 20000),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  decision_ref TEXT NOT NULL CHECK (length(btrim(decision_ref)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published', 'superseded')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  published_by TEXT REFERENCES users(id),
  published_at TIMESTAMPTZ,
  CONSTRAINT privacy_notice_four_eyes CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT privacy_notice_approved_pair CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CONSTRAINT privacy_notice_published_pair CHECK ((published_at IS NULL) = (published_by IS NULL)),
  CONSTRAINT privacy_notice_status_approved CHECK (status NOT IN ('approved', 'published', 'superseded') OR approved_at IS NOT NULL),
  CONSTRAINT privacy_notice_status_published CHECK (status NOT IN ('published', 'superseded') OR published_at IS NOT NULL)
);
-- Najwyżej jedna wersja opublikowana naraz; publikacja nowej najpierw
-- przenosi poprzednią do 'superseded' w tej samej transakcji (aplikacja).
CREATE UNIQUE INDEX privacy_notices_one_published ON privacy_notices ((true)) WHERE status = 'published';

CREATE FUNCTION privacy_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'privacy_notices_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.body_text IS DISTINCT FROM OLD.body_text OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.decision_ref IS DISTINCT FROM OLD.decision_ref
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'privacy_notice_identity_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'approved')
    OR (OLD.status = 'approved' AND NEW.status = 'published')
    OR (OLD.status = 'published' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'privacy_notice_invalid_transition';
  END IF;
  IF (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at)
     AND NOT (OLD.status = 'draft' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'privacy_notice_approval_fields_locked';
  END IF;
  IF (NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at)
     AND NOT (OLD.status = 'approved' AND NEW.status = 'published') THEN
    RAISE EXCEPTION 'privacy_notice_publish_fields_locked';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER privacy_notices_guard BEFORE UPDATE OR DELETE ON privacy_notices
  FOR EACH ROW EXECUTE FUNCTION privacy_notice_guard();

-- Ewidencja przekazania (opcjonalna, per gospodarstwo i kanał) — patrz
-- propozycja #145 pkt 4. Tylko dopisywanie.
CREATE TABLE privacy_notice_deliveries (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  notice_id TEXT NOT NULL REFERENCES privacy_notices(id),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'card', 'meeting', 'school')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL REFERENCES users(id),
  UNIQUE (household_id, notice_id, channel)
);
CREATE INDEX privacy_notice_deliveries_notice_idx ON privacy_notice_deliveries(notice_id);

CREATE FUNCTION privacy_notice_deliveries_no_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy_notice_deliveries is append-only';
END;
$$;
CREATE TRIGGER privacy_notice_deliveries_no_change BEFORE UPDATE OR DELETE ON privacy_notice_deliveries
  FOR EACH ROW EXECUTE FUNCTION privacy_notice_deliveries_no_change();

-- Import: która wersja obowiązywała przy commit (bramka w src/pg/routes/import.js).
-- import_batches jest niezmienne po INSERT — kolumna ustawiana tylko przy wstawieniu wiersza.
ALTER TABLE import_batches ADD COLUMN privacy_notice_id TEXT REFERENCES privacy_notices(id);
