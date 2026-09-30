-- Zasada czterech oczu dla rozstrzygnięcia „wiadomość nie wyszła” oraz
-- kampania uzupełniająca (followup) powiązana z kampanią źródłową (#139,
-- dalsza część po PR #570).
--
-- Zmiany:
-- * Nowa tabela email_outbox_resolution_approvals: zatwierdzenie
--   rozstrzygnięcia `confirmed_not_sent` przez INNĄ osobę niż zgłaszająca.
--   Jeden wiersz na rozstrzygnięcie (UNIQUE resolution_id — podwójne
--   kliknięcie nie tworzy drugiego zatwierdzenia). Klucz obcy złożony
--   (resolution_id, outbox_id, campaign_id, resolved_by, resolution) do
--   email_outbox_resolutions gwarantuje, że skopiowane kolumny są zgodne ze
--   zgłoszeniem, a CHECK email_outbox_resolution_approval_four_eyes — że
--   zatwierdzający to inna osoba (approved_by <> resolved_by). Tylko
--   dopisywanie: bez UPDATE/DELETE/TRUNCATE, approved_at z zegara bazy (0144).
-- * email_outbox_resolutions: dodatkowy klucz unikalny na
--   (id, outbox_id, campaign_id, resolved_by, resolution) — wyłącznie cel
--   klucza obcego powyżej; wiersze tabeli nie są zmieniane.
-- * email_campaigns: kolumny kind ('standard' | 'followup', domyślnie
--   'standard') i source_campaign_id (kampania źródłowa). CHECK: followup
--   wtedy i tylko wtedy, gdy jest kampania źródłowa; nie może wskazywać siebie.
--   Strażnik email_campaign_followup_guard(): przy INSERT kampania źródłowa
--   musi należeć do tego samego roku i mieć kolejkę (sending/paused/done/
--   cancelled), uzupełnienie powstaje jako szkic bez powiązania z zebraniem,
--   a odbiorcy (audience) wynikają ze źródła (no_payment_record zostaje
--   no_payment_record — worker dalej pomija rodziny po wpłacie; każde inne
--   źródło → all_households, bo lista i tak jest zawężona do rodzin
--   z zatwierdzonym „nie wyszło”). Przy UPDATE kind, source_campaign_id
--   i audience uzupełnienia są niezmienne.
-- * email_campaign_exclusions: nowy powód 'followup_already_covered'
--   (rodzina jest już w kolejce innego uzupełnienia tej samej kampanii).
-- * Strażnik email_outbox_followup_guard() (BEFORE INSERT na email_outbox):
--   wiersz kolejki uzupełnienia wolno dodać tylko dla rodziny, której
--   wiersz w kampanii źródłowej ma ZATWIERDZONE `confirmed_not_sent`,
--   i tylko jeśli ta rodzina nie ma już (nieanulowanego) wiersza w innym
--   uzupełnieniu tej samej kampanii źródłowej. Blokada doradcza per kampania
--   źródłowa szereguje równoległe zakolejkowania. W ramach jednego
--   uzupełnienia duplikat blokuje nadal klucz idempotencji
--   `campaign:<uzupełnienie>:household:<rodzina>`.
-- Żadna zmiana nie wysyła poczty; uzupełnienie przechodzi zwykłą ścieżkę
-- migawka → zatwierdzenie treści i listy przez inną osobę → kolejka.
--
-- Skutki dla danych:
-- * Istniejące kampanie dostają kind = 'standard' i source_campaign_id = NULL
--   (wartość domyślna; treść, skróty i zatwierdzenia bez zmian — kolumny nie
--   wchodzą do skrótu treści).
-- * Istniejące rozstrzygnięcia `confirmed_not_sent` (zapisane przed tą
--   migracją przez jedną osobę z zarządu) NIE są uznawane za zatwierdzone:
--   nie mają wiersza w email_outbox_resolution_approvals, więc rodziny nie
--   trafiają do migawki uzupełnienia, a kolejka ich nie przyjmie, dopóki inna
--   osoba z zarządu nie zatwierdzi rozstrzygnięcia (wariant zachowawczy).
--   Samych rozstrzygnięć migracja nie zmienia i nie usuwa.
-- * Rozstrzygnięcia `confirmed_delivered` nie wymagają zatwierdzenia.
-- * Nowa tabela jest pusta po migracji.
-- Wycofanie: na bazie bez uzupełnień i zatwierdzeń — DROP triggerów i funkcji
-- email_outbox_followup_guard/email_campaign_followup_guard, DROP TABLE
-- email_outbox_resolution_approvals, usunięcie klucza
-- email_outbox_resolutions_approval_target, kolumn kind/source_campaign_id
-- i przywrócenie CHECK powodów wykluczeń z 0057. Na bazie z danymi tylko po
-- kopii zapasowej (znika ślad, kto zatwierdził; zdarzenia zostają
-- w audit_events).

-- ---------- zasada czterech oczu dla confirmed_not_sent ----------

ALTER TABLE email_outbox_resolutions
  ADD CONSTRAINT email_outbox_resolutions_approval_target UNIQUE (id, outbox_id, campaign_id, resolved_by, resolution);

CREATE TABLE email_outbox_resolution_approvals (
  id TEXT PRIMARY KEY,
  resolution_id TEXT NOT NULL UNIQUE,
  outbox_id TEXT NOT NULL REFERENCES email_outbox(id),
  campaign_id TEXT NOT NULL REFERENCES email_campaigns(id),
  resolution TEXT NOT NULL CHECK (resolution = 'confirmed_not_sent'),
  resolved_by TEXT NOT NULL REFERENCES users(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_outbox_resolution_approval_four_eyes CHECK (approved_by <> resolved_by),
  CONSTRAINT email_outbox_resolution_approval_target_fk
    FOREIGN KEY (resolution_id, outbox_id, campaign_id, resolved_by, resolution)
    REFERENCES email_outbox_resolutions(id, outbox_id, campaign_id, resolved_by, resolution)
);
CREATE INDEX email_outbox_resolution_approvals_outbox_idx ON email_outbox_resolution_approvals(outbox_id);
CREATE INDEX email_outbox_resolution_approvals_campaign_idx ON email_outbox_resolution_approvals(campaign_id);

CREATE TRIGGER email_outbox_resolution_approvals_append_only BEFORE UPDATE OR DELETE ON email_outbox_resolution_approvals
  FOR EACH ROW EXECUTE FUNCTION email_append_only();
CREATE TRIGGER email_outbox_resolution_approvals_no_truncate BEFORE TRUNCATE ON email_outbox_resolution_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();
CREATE TRIGGER a0_stamp_created_now BEFORE INSERT ON email_outbox_resolution_approvals
  FOR EACH ROW EXECUTE FUNCTION stamp_created_now('approved_at');

-- ---------- kampania uzupełniająca ----------

ALTER TABLE email_campaigns
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'followup')),
  ADD COLUMN source_campaign_id TEXT REFERENCES email_campaigns(id),
  ADD CONSTRAINT email_campaigns_followup_source CHECK ((kind = 'followup') = (source_campaign_id IS NOT NULL)),
  ADD CONSTRAINT email_campaigns_followup_not_self CHECK (source_campaign_id IS DISTINCT FROM id);
CREATE INDEX email_campaigns_source_idx ON email_campaigns(source_campaign_id) WHERE source_campaign_id IS NOT NULL;

ALTER TABLE email_campaign_exclusions DROP CONSTRAINT email_campaign_exclusions_reason_check;
ALTER TABLE email_campaign_exclusions ADD CONSTRAINT email_campaign_exclusions_reason_check CHECK (reason IN
  ('no_consent', 'no_valid_email', 'duplicate_address', 'suppressed', 'payment_recorded', 'opted_out',
   'followup_already_covered'));

CREATE FUNCTION email_campaign_followup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.source_campaign_id IS DISTINCT FROM OLD.source_campaign_id
       OR (OLD.kind = 'followup' AND NEW.audience IS DISTINCT FROM OLD.audience) THEN
      RAISE EXCEPTION 'email_campaign_followup_link_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind IS DISTINCT FROM 'followup' THEN RETURN NEW; END IF;
  SELECT school_year_id, status, audience INTO s FROM email_campaigns WHERE id = NEW.source_campaign_id;
  IF NOT FOUND OR s.school_year_id IS DISTINCT FROM NEW.school_year_id
     OR s.status NOT IN ('sending', 'paused', 'done', 'cancelled')
     OR NEW.status IS DISTINCT FROM 'draft' OR NEW.meeting_id IS NOT NULL OR NEW.class_id IS NOT NULL THEN
    RAISE EXCEPTION 'email_followup_source_not_eligible';
  END IF;
  IF NEW.audience IS DISTINCT FROM (CASE WHEN s.audience = 'no_payment_record' THEN 'no_payment_record' ELSE 'all_households' END) THEN
    RAISE EXCEPTION 'email_followup_audience_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER email_campaigns_followup_guard BEFORE INSERT OR UPDATE ON email_campaigns
  FOR EACH ROW EXECUTE FUNCTION email_campaign_followup_guard();

CREATE FUNCTION email_outbox_followup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
  SELECT kind, source_campaign_id INTO c FROM email_campaigns WHERE id = NEW.campaign_id;
  IF c.kind IS DISTINCT FROM 'followup' THEN RETURN NEW; END IF;
  -- Równoległe zakolejkowania uzupełnień tej samej kampanii źródłowej czekają
  -- na siebie (do końca transakcji), więc sprawdzenie niżej widzi wynik drugiej.
  PERFORM pg_advisory_xact_lock(hashtext('email_followup:' || c.source_campaign_id));
  IF NOT EXISTS (
    SELECT 1 FROM email_outbox so
      JOIN email_outbox_resolution_approvals a ON a.outbox_id = so.id
     WHERE so.campaign_id = c.source_campaign_id AND so.household_id = NEW.household_id AND so.state = 'failed'
  ) THEN
    RAISE EXCEPTION 'email_followup_household_not_eligible';
  END IF;
  IF EXISTS (
    SELECT 1 FROM email_outbox o
      JOIN email_campaigns f ON f.id = o.campaign_id
     WHERE f.source_campaign_id = c.source_campaign_id AND f.id <> NEW.campaign_id
       AND o.household_id = NEW.household_id AND o.state <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'email_followup_household_already_covered';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER email_outbox_followup_guard BEFORE INSERT ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION email_outbox_followup_guard();
