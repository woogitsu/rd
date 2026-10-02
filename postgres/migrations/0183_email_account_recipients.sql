-- Odbiorca-konto w kampaniach e-mail: zawiadomienie o zebraniu zarządu (#113,
-- część „odbiorcy-konta”; wskazanie właściciela 2026-10-02, D-21 + D-16/D-17).
-- NICZEGO ta migracja nie wysyła i nie tworzy żadnej kampanii.
--
-- Co się zmienia:
-- * email_campaigns: nowe audience 'meeting_invitees' — konta (users) z
--   aktywnym przydziałem ról board/representative/audit/principal w roku
--   kampanii. Wyłącznie dla kampanii powiązanej z zebraniem (CHECK
--   email_campaigns_invitees_require_meeting); trigger
--   email_campaign_meeting_link_guard() dopuszcza je wyłącznie dla zebrania
--   zarządu (kind 'board'), tak jak 'class_households' tylko dla klasowego.
--   Kampania uzupełniająca (#139) nie może mieć takiego źródła
--   (email_campaign_followup_guard() → email_followup_source_not_eligible).
-- * email_campaign_recipients, email_campaign_exclusions, email_outbox: nowa
--   kolumna user_id (FK users) obok household_id; CHECK „dokładnie jedno:
--   gospodarstwo (z opiekunem) albo konto”. Migawka konta: jeden wiersz na
--   (kampania, konto) — UNIQUE (campaign_id, user_id); kolejka: jeden wiersz
--   na (kampania, konto), klucz idempotencji 'campaign:<id>:user:<id>'
--   (dotychczasowy 'campaign:<id>:household:<id>' bez zmian). Złożony FK
--   (recipient_id, campaign_id, user_id) wiąże wiersz kolejki z wierszem
--   migawki tego samego konta (dla rodzin działa nadal FK z 0007).
-- * email_campaign_exclusions: klucz główny (campaign_id, household_id)
--   zastępują dwa unikalne indeksy częściowe (rodzina albo konto) — kolumna
--   household_id nie może być już NOT NULL. Nowy powód 'account_disabled'.
-- * email_outbox: user_id jest niezmienne (trigger email_outbox_user_immutable,
--   osobny od email_outbox_guard() z 0007/0025, którego nie redefiniujemy).
--   Wiersze migawki i wykluczeń są i tak niezmienne (email_snapshot_guard).
--
-- Skutki dla danych: istniejące wiersze bez zmian — user_id = NULL, a każdy
-- istniejący wiersz ma household_id (i guardian_id), więc spełnia nowe CHECK
-- (sprawdzane przy ADD CONSTRAINT na istniejących danych). Indeksy częściowe
-- dla rodzin mają tę samą unikalność co dotychczasowy klucz główny. ADD COLUMN
-- bez DEFAULT nie przepisuje tabel. Zdjęcie NOT NULL nie zmienia wartości.
-- Adres konta w migawce to kopia users.email (jak adres opiekuna z guardians).
--
-- Wycofanie: na bazie bez wierszy z user_id — DROP TRIGGER
-- email_outbox_user_immutable, DROP FUNCTION email_outbox_user_immutable(),
-- DROP nowych CONSTRAINT/indeksów, DROP COLUMN user_id (trzy tabele),
-- SET NOT NULL na household_id/guardian_id, przywrócenie klucza głównego
-- email_campaign_exclusions (campaign_id, household_id), CHECK audience i
-- powodów wykluczeń z 0178 oraz funkcji email_campaign_meeting_link_guard()
-- z 0139 i email_campaign_followup_guard() z 0156. Z wierszami kont — tylko
-- po anulowaniu takich kampanii i kopii zapasowej (wiersze kolejki nie są
-- usuwane, więc user_id musi zostać do czasu decyzji o retencji, D-04).

-- ---------- email_campaigns ----------

ALTER TABLE email_campaigns DROP CONSTRAINT email_campaigns_audience_check;
ALTER TABLE email_campaigns ADD CONSTRAINT email_campaigns_audience_check
  CHECK (audience IN ('all_households', 'no_payment_record', 'class_households', 'meeting_invitees'));
ALTER TABLE email_campaigns ADD CONSTRAINT email_campaigns_invitees_require_meeting
  CHECK (audience <> 'meeting_invitees' OR meeting_id IS NOT NULL);

CREATE OR REPLACE FUNCTION email_campaign_meeting_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- 0183: zebranie zarządu -> konta zaproszonych (meeting_invitees).
  IF NOT ((m.kind = 'plenary' AND NEW.audience = 'all_households')
       OR (m.kind = 'class' AND NEW.audience = 'class_households' AND NEW.class_id = m.class_id)
       OR (m.kind = 'board' AND NEW.audience = 'meeting_invitees' AND NEW.class_id IS NULL)) THEN
    RAISE EXCEPTION 'email_campaign_meeting_audience_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION email_campaign_followup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- 0183: uzupełnienie dotyczy wyłącznie rodzin; kampania do kont (meeting_invitees)
  -- nie jest jego źródłem (ponowną wiadomość do konta daje nowe zawiadomienie).
  IF NOT FOUND OR s.school_year_id IS DISTINCT FROM NEW.school_year_id
     OR s.status NOT IN ('sending', 'paused', 'done', 'cancelled')
     OR s.audience = 'meeting_invitees'
     OR NEW.status IS DISTINCT FROM 'draft' OR NEW.meeting_id IS NOT NULL OR NEW.class_id IS NOT NULL THEN
    RAISE EXCEPTION 'email_followup_source_not_eligible';
  END IF;
  IF NEW.audience IS DISTINCT FROM (CASE WHEN s.audience = 'no_payment_record' THEN 'no_payment_record' ELSE 'all_households' END) THEN
    RAISE EXCEPTION 'email_followup_audience_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------- migawka odbiorców ----------

ALTER TABLE email_campaign_recipients
  ALTER COLUMN household_id DROP NOT NULL,
  ALTER COLUMN guardian_id DROP NOT NULL,
  ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE email_campaign_recipients
  ADD CONSTRAINT email_campaign_recipients_one_subject CHECK (
    (household_id IS NOT NULL AND guardian_id IS NOT NULL AND user_id IS NULL)
    OR (household_id IS NULL AND guardian_id IS NULL AND user_id IS NOT NULL)
  ),
  ADD CONSTRAINT email_campaign_recipients_campaign_user_key UNIQUE (campaign_id, user_id),
  ADD CONSTRAINT email_campaign_recipients_id_campaign_user_key UNIQUE (id, campaign_id, user_id);
CREATE INDEX email_campaign_recipients_user_idx ON email_campaign_recipients(user_id) WHERE user_id IS NOT NULL;

-- ---------- wykluczenia ----------

ALTER TABLE email_campaign_exclusions DROP CONSTRAINT email_campaign_exclusions_pkey;
ALTER TABLE email_campaign_exclusions
  ALTER COLUMN household_id DROP NOT NULL,
  ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE email_campaign_exclusions
  ADD CONSTRAINT email_campaign_exclusions_one_subject CHECK ((household_id IS NOT NULL) <> (user_id IS NOT NULL));
CREATE UNIQUE INDEX email_campaign_exclusions_household_key ON email_campaign_exclusions(campaign_id, household_id)
  WHERE household_id IS NOT NULL;
CREATE UNIQUE INDEX email_campaign_exclusions_user_key ON email_campaign_exclusions(campaign_id, user_id)
  WHERE user_id IS NOT NULL;
ALTER TABLE email_campaign_exclusions DROP CONSTRAINT email_campaign_exclusions_reason_check;
ALTER TABLE email_campaign_exclusions ADD CONSTRAINT email_campaign_exclusions_reason_check CHECK (reason IN
  ('no_consent', 'no_valid_email', 'duplicate_address', 'suppressed', 'payment_recorded', 'opted_out',
   'followup_already_covered', 'no_payment_reference', 'processing_restricted', 'account_disabled'));

-- ---------- kolejka ----------

ALTER TABLE email_outbox
  ALTER COLUMN household_id DROP NOT NULL,
  ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_key_format;
-- Konkatenacja z NULL daje NULL (CHECK przepuszcza NULL), więc każda gałąź
-- wymaga jawnie swojej kolumny.
ALTER TABLE email_outbox
  ADD CONSTRAINT email_outbox_one_subject CHECK ((household_id IS NOT NULL) <> (user_id IS NOT NULL)),
  ADD CONSTRAINT email_outbox_key_format CHECK (
    (household_id IS NOT NULL AND idempotency_key = 'campaign:' || campaign_id || ':household:' || household_id)
    OR (user_id IS NOT NULL AND idempotency_key = 'campaign:' || campaign_id || ':user:' || user_id)
  ),
  ADD CONSTRAINT email_outbox_campaign_user_key UNIQUE (campaign_id, user_id),
  ADD CONSTRAINT email_outbox_recipient_user_fkey FOREIGN KEY (recipient_id, campaign_id, user_id)
    REFERENCES email_campaign_recipients(id, campaign_id, user_id);

CREATE FUNCTION email_outbox_user_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'email_outbox_identity_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_outbox_user_immutable BEFORE UPDATE ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION email_outbox_user_immutable();
