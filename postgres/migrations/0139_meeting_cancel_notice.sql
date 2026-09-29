-- Odwołanie i zmiana terminu zebrania, wersje porządku obrad i zawiadomienie
-- o zebraniu (issue #113). Wszystko jest dopisywane; nic nie jest usuwane ani
-- przepisywane, a NICZEGO ta migracja nie wysyła.
--
-- Co się zmienia:
-- * meetings: nowy stan 'cancelled' (przejścia draft|scheduled -> cancelled,
--   stan końcowy) z cancellation_reason (3-500 znaków, wewnętrzny),
--   cancelled_by, cancelled_at; pola notice_min_days + notice_rule_source
--   (jak quorum_rule_source: serwer tylko odnotowuje, że zawiadomienie poszło
--   za późno, nie blokuje). meeting_guard() i meeting_assert_editable() są
--   przenoszone z 0009_meetings.sql (najnowsza wersja) z jedną zmianą: zebranie
--   odwołane nie przyjmuje obecności, porządku, protokołu, quorum ani uchwał
--   (409 meeting_cancelled; quorum/protokół/uchwała i tak wymagały stanu held).
-- * meeting_agenda_items: withdrawn_at/withdrawn_by — wycofanie punktu zamiast
--   usuwania (raz ustawione nie wraca).
-- * meeting_agenda_versions: niezmienna migawka (JSON + skrót) porządku obrad.
-- * meeting_reschedules: dopisywany dziennik zmian terminu (stara/nowa data,
--   powód 3-500 znaków, aktor).
-- * meeting_notices: wersjonowane zawiadomienie (draft -> approved). Treść jest
--   niezmienna; poprawka = nowa wersja. Zatwierdzająca osoba jest inna niż autor
--   (zasada czterech oczu — wariant zachowawczy do decyzji D-08).
-- * email_campaigns: meeting_id, meeting_notice_id, class_id oraz audience
--   'class_households' (rodziny dzieci jednej klasy w danym roku). Trigger
--   dopuszcza wiersz powiązany z zebraniem WYŁĄCZNIE jako szkic
--   powstały z zatwierdzonego zawiadomienia; lista odbiorców i zatwierdzenie
--   wysyłki zostają w istniejącym module kampanii.
-- * public_meeting_notices: widok publiczny — wyłącznie najnowsze ZATWIERDZONE
--   zawiadomienie zebrania ogólnego (plenary), bez powodu odwołania.
--
-- Skutki dla danych: istniejące wiersze bez zmian (nowe kolumny NULL, żaden
-- stan nie zmienia się wstecz). Zapytanie kontrolne przed migracją nie jest
-- potrzebne: nic nie jest blokowane wstecz.
-- Wycofanie na pustej bazie: usunięcie nowych tabel, widoku, triggerów i
-- kolumn oraz przywrócenie funkcji z 0009. Na bazie z danymi tylko po kopii:
-- tabele niosą historię zmian terminu i zawiadomień.
-- Poza zakresem (kolejne PR-y): audience 'meeting_invitees' (konta zarządu,
-- przedstawicieli, KR — wymaga odbiorców-kont, dziś odbiorca to rodzina),
-- zmiana kolejności punktów porządku, załącznik .ics.

-- ---------- meetings ----------

ALTER TABLE meetings DROP CONSTRAINT meetings_status_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('draft', 'scheduled', 'held', 'archived', 'cancelled'));
ALTER TABLE meetings
  ADD COLUMN cancellation_reason TEXT
    CHECK (cancellation_reason IS NULL OR length(btrim(cancellation_reason)) BETWEEN 3 AND 500),
  ADD COLUMN cancelled_by TEXT REFERENCES users(id),
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN notice_min_days INTEGER CHECK (notice_min_days IS NULL OR notice_min_days BETWEEN 0 AND 365),
  ADD COLUMN notice_rule_source TEXT
    CHECK (notice_rule_source IS NULL OR length(btrim(notice_rule_source)) BETWEEN 3 AND 200);
ALTER TABLE meetings
  ADD CONSTRAINT meeting_cancellation_complete CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (cancelled_at IS NULL) = (cancelled_by IS NULL)
    AND (cancelled_at IS NULL) = (cancellation_reason IS NULL)
  ),
  ADD CONSTRAINT meeting_notice_rule_complete CHECK ((notice_min_days IS NULL) = (notice_rule_source IS NULL));

CREATE OR REPLACE FUNCTION meeting_assert_editable(p_meeting_id TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE current_status TEXT;
BEGIN
  SELECT status INTO current_status FROM meetings WHERE id = p_meeting_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'meeting_not_found'; END IF;
  IF current_status = 'cancelled' THEN RAISE EXCEPTION 'meeting_cancelled'; END IF;
  IF current_status = 'archived' OR meeting_has_approved_minutes(p_meeting_id) THEN
    RAISE EXCEPTION 'meeting_locked';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION meeting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'meetings_cannot_be_deleted'; END IF;
  IF ROW(NEW.id, NEW.school_year_id, NEW.kind, NEW.class_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.school_year_id, OLD.kind, OLD.class_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'meeting_identity_immutable';
  END IF;
  IF OLD.status = 'archived' THEN RAISE EXCEPTION 'meeting_locked'; END IF;
  -- Odwołanie jest stanem końcowym: nic w wierszu się już nie zmienia.
  IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'meeting_cancelled'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'scheduled')
    OR (OLD.status = 'scheduled' AND NEW.status IN ('draft', 'held'))
    OR (OLD.status = 'held' AND NEW.status = 'archived')
    OR (OLD.status IN ('draft', 'scheduled') AND NEW.status = 'cancelled')
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

-- ---------- porządek obrad: wycofanie punktu, wersje ----------

ALTER TABLE meeting_agenda_items
  ADD COLUMN withdrawn_at TIMESTAMPTZ,
  ADD COLUMN withdrawn_by TEXT REFERENCES users(id),
  ADD CONSTRAINT meeting_agenda_item_withdrawal_complete
    CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL));

CREATE FUNCTION meeting_agenda_item_withdrawal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.withdrawn_at IS NOT NULL AND
     (NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by) THEN
    RAISE EXCEPTION 'agenda_item_withdrawal_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_agenda_items_withdrawal_guard BEFORE UPDATE ON meeting_agenda_items
  FOR EACH ROW EXECUTE FUNCTION meeting_agenda_item_withdrawal_guard();

-- Wspólna kontrola nowych tabel zebrania: rok otwarty (school_year_closed).
-- Tabele mają własne school_year_id; zamrożenie zamkniętego roku (#80) to
-- trigger a0_year_freeze z istniejącej year_freeze_direct() (0017, bez
-- redefinicji), założony niżej na wszystkich trzech tabelach.
CREATE FUNCTION meeting_notice_tables_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION '%_cannot_be_changed', TG_TABLE_NAME; END IF;
  PERFORM school_year_assert_open(NEW.school_year_id);
  SELECT status INTO m FROM meetings WHERE id = NEW.meeting_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'meeting_not_found'; END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE meeting_agenda_versions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  school_year_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'array'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, version),
  UNIQUE (id, meeting_id),
  FOREIGN KEY (meeting_id, school_year_id) REFERENCES meetings(id, school_year_id)
);
CREATE TRIGGER meeting_agenda_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON meeting_agenda_versions
  FOR EACH ROW EXECUTE FUNCTION meeting_notice_tables_guard();

-- ---------- zmiany terminu ----------

CREATE TABLE meeting_reschedules (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  school_year_id TEXT NOT NULL,
  from_scheduled_at TIMESTAMPTZ NOT NULL,
  to_scheduled_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_scheduled_at <> to_scheduled_at),
  FOREIGN KEY (meeting_id, school_year_id) REFERENCES meetings(id, school_year_id)
);
CREATE INDEX meeting_reschedules_meeting_idx ON meeting_reschedules(meeting_id, created_at);
CREATE TRIGGER meeting_reschedules_guard BEFORE INSERT OR UPDATE OR DELETE ON meeting_reschedules
  FOR EACH ROW EXECUTE FUNCTION meeting_notice_tables_guard();

-- ---------- zawiadomienia ----------

CREATE TABLE meeting_notices (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  school_year_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('invitation', 'update', 'reschedule', 'cancellation')),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  scheduled_at TIMESTAMPTZ NOT NULL,
  previous_scheduled_at TIMESTAMPTZ,
  location TEXT CHECK (location IS NULL OR length(btrim(location)) BETWEEN 1 AND 200),
  agenda_version_id TEXT,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  notice_days_before INTEGER,
  notice_late BOOLEAN,
  UNIQUE (meeting_id, version),
  UNIQUE (id, meeting_id),
  FOREIGN KEY (meeting_id, school_year_id) REFERENCES meetings(id, school_year_id),
  FOREIGN KEY (agenda_version_id, meeting_id) REFERENCES meeting_agenda_versions(id, meeting_id),
  CONSTRAINT meeting_notice_approval_complete CHECK (
    (status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL AND notice_days_before IS NOT NULL)
  ),
  CONSTRAINT meeting_notice_four_eyes CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT meeting_notice_previous_date CHECK ((kind = 'reschedule') = (previous_scheduled_at IS NOT NULL)),
  CONSTRAINT meeting_notice_agenda CHECK ((kind = 'cancellation') = (agenda_version_id IS NULL))
);
CREATE INDEX meeting_notices_meeting_idx ON meeting_notices(meeting_id, version);

CREATE FUNCTION meeting_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'meeting_notices_cannot_be_deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM school_year_assert_open(NEW.school_year_id);
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'meeting_notice_must_start_as_draft'; END IF;
    SELECT status INTO m FROM meetings WHERE id = NEW.meeting_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'meeting_not_found'; END IF;
    IF (NEW.kind = 'cancellation') <> (m.status = 'cancelled')
       OR m.status NOT IN ('draft', 'scheduled', 'cancelled') THEN
      RAISE EXCEPTION 'meeting_notice_closed';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: wyłącznie draft -> approved; treść zawiadomienia jest niezmienna.
  IF OLD.status <> 'draft' OR NEW.status <> 'approved'
     OR ROW(NEW.id, NEW.meeting_id, NEW.school_year_id, NEW.version, NEW.kind, NEW.title, NEW.scheduled_at,
            NEW.previous_scheduled_at, NEW.location, NEW.agenda_version_id, NEW.content_hash,
            NEW.created_by, NEW.created_at)
        IS DISTINCT FROM
        ROW(OLD.id, OLD.meeting_id, OLD.school_year_id, OLD.version, OLD.kind, OLD.title, OLD.scheduled_at,
            OLD.previous_scheduled_at, OLD.location, OLD.agenda_version_id, OLD.content_hash,
            OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'meeting_notice_immutable';
  END IF;
  PERFORM school_year_assert_open(OLD.school_year_id);
  PERFORM 1 FROM meetings WHERE id = OLD.meeting_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM meeting_notices WHERE meeting_id = OLD.meeting_id AND version > OLD.version) THEN
    RAISE EXCEPTION 'meeting_notice_not_latest';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_notices_guard BEFORE INSERT OR UPDATE OR DELETE ON meeting_notices
  FOR EACH ROW EXECUTE FUNCTION meeting_notice_guard();

-- ---------- kampania e-mail: wyłącznie szkic powiązany z zawiadomieniem ----------

ALTER TABLE email_campaigns DROP CONSTRAINT email_campaigns_audience_check;
ALTER TABLE email_campaigns ADD CONSTRAINT email_campaigns_audience_check
  CHECK (audience IN ('all_households', 'no_payment_record', 'class_households'));
ALTER TABLE email_campaigns
  ADD COLUMN meeting_id TEXT,
  ADD COLUMN meeting_notice_id TEXT,
  ADD COLUMN class_id TEXT,
  ADD CONSTRAINT email_campaigns_meeting_fk FOREIGN KEY (meeting_id, school_year_id)
    REFERENCES meetings(id, school_year_id),
  ADD CONSTRAINT email_campaigns_notice_fk FOREIGN KEY (meeting_notice_id, meeting_id)
    REFERENCES meeting_notices(id, meeting_id),
  ADD CONSTRAINT email_campaigns_class_fk FOREIGN KEY (class_id, school_year_id)
    REFERENCES classes(id, school_year_id),
  ADD CONSTRAINT email_campaigns_class_audience CHECK ((audience = 'class_households') = (class_id IS NOT NULL)),
  ADD CONSTRAINT email_campaigns_notice_needs_meeting CHECK (meeting_notice_id IS NULL OR meeting_id IS NOT NULL);
CREATE UNIQUE INDEX email_campaigns_meeting_notice_idx ON email_campaigns(meeting_notice_id)
  WHERE meeting_notice_id IS NOT NULL;

CREATE FUNCTION email_campaign_meeting_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m RECORD; n RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.meeting_id IS DISTINCT FROM OLD.meeting_id OR NEW.meeting_notice_id IS DISTINCT FROM OLD.meeting_notice_id
       OR NEW.class_id IS DISTINCT FROM OLD.class_id THEN
      RAISE EXCEPTION 'email_campaign_meeting_link_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.class_id IS NOT NULL AND NEW.meeting_id IS NULL THEN
    RAISE EXCEPTION 'email_campaign_class_audience_requires_meeting';
  END IF;
  IF NEW.meeting_id IS NULL THEN RETURN NEW; END IF;
  -- Kampania powiązana z zebraniem powstaje tylko jako szkic z zatwierdzonego
  -- zawiadomienia, dla odbiorców zgodnych z rodzajem zebrania.
  IF NEW.status <> 'draft' OR NEW.meeting_notice_id IS NULL THEN
    RAISE EXCEPTION 'email_campaign_meeting_requires_approved_notice';
  END IF;
  SELECT status, approved_at INTO n FROM meeting_notices WHERE id = NEW.meeting_notice_id;
  IF n.status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'email_campaign_meeting_requires_approved_notice';
  END IF;
  SELECT kind, class_id INTO m FROM meetings WHERE id = NEW.meeting_id;
  IF NOT ((m.kind = 'plenary' AND NEW.audience = 'all_households')
       OR (m.kind = 'class' AND NEW.audience = 'class_households' AND NEW.class_id = m.class_id)) THEN
    RAISE EXCEPTION 'email_campaign_meeting_audience_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER email_campaigns_meeting_link_guard BEFORE INSERT OR UPDATE ON email_campaigns
  FOR EACH ROW EXECUTE FUNCTION email_campaign_meeting_link_guard();

-- ---------- widok publiczny ----------

-- Tylko najnowsze ZATWIERDZONE zawiadomienie zebrania ogólnego; zebranie
-- w szkicu nie jest pokazywane. Bez powodu odwołania i bez opisów punktów.
CREATE VIEW public_meeting_notices AS
SELECT DISTINCT ON (n.meeting_id)
       n.id, n.school_year_id, n.kind, n.title, n.scheduled_at, n.previous_scheduled_at, n.location,
       n.approved_at, v.snapshot AS agenda_snapshot
  FROM meeting_notices n
  JOIN meetings m ON m.id = n.meeting_id
  LEFT JOIN meeting_agenda_versions v ON v.id = n.agenda_version_id
 WHERE n.status = 'approved' AND m.kind = 'plenary' AND m.status <> 'draft'
 ORDER BY n.meeting_id, n.version DESC;

-- Historia zmian jest tylko dopisywana.
CREATE TRIGGER meeting_agenda_versions_no_truncate BEFORE TRUNCATE ON meeting_agenda_versions
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();
CREATE TRIGGER meeting_reschedules_no_truncate BEFORE TRUNCATE ON meeting_reschedules
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();
CREATE TRIGGER meeting_notices_no_truncate BEFORE TRUNCATE ON meeting_notices
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();

-- Zamrożenie roku (#80): zapis w tabelach zebrania zamkniętego roku daje
-- school_year_closed; a0_ uruchamia się przed pozostałymi triggerami BEFORE.
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE OR DELETE ON meeting_agenda_versions
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE OR DELETE ON meeting_reschedules
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE OR DELETE ON meeting_notices
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
