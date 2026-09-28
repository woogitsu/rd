-- Harmonogram startu i wstrzymanie/wznowienie kampanii e-mail (#130).
--
-- Skutki dla danych: dodaje kolumny (wszystkie nullable/domyślnie puste) do
-- email_campaigns. Żaden istniejący wiersz nie zmienia stanu ani wartości.
-- Rozszerza CHECK stanu o 'paused' i trigger email_campaign_guard() o
-- przejścia sending<->paused oraz paused->cancelled. Bez zmiany semantyki
-- istniejących przejść i pól (approved_by/daily_cap/queued_at pozostają
-- zamrożone tak samo w 'paused' jak w 'sending').
--
-- send_not_before jest traktowane jak treść kampanii: zmienia się tylko przed
-- zatwierdzeniem/wysyłką i każda zmiana cofa kampanię do szkicu (kryterium
-- akceptacji #130 — nie da się przesunąć startu po zatwierdzeniu bez wiedzy
-- zatwierdzającego).

ALTER TABLE email_campaigns
  ADD COLUMN send_not_before TIMESTAMPTZ,
  ADD COLUMN paused_by TEXT REFERENCES users(id),
  ADD COLUMN paused_at TIMESTAMPTZ,
  ADD COLUMN resumed_by TEXT REFERENCES users(id),
  ADD COLUMN resumed_at TIMESTAMPTZ;

ALTER TABLE email_campaigns
  ADD CONSTRAINT email_campaign_paused_actor CHECK ((paused_at IS NULL) = (paused_by IS NULL)),
  ADD CONSTRAINT email_campaign_resumed_actor CHECK ((resumed_at IS NULL) = (resumed_by IS NULL)),
  ADD CONSTRAINT email_campaign_paused_requires_flag
    CHECK (status <> 'paused' OR (paused_at IS NOT NULL AND paused_by IS NOT NULL));

-- Stan 'paused' dopisany do dopuszczalnych wartości (nazwa ograniczenia
-- ustalona przez Postgres dla pojedynczego CHECK na kolumnie, wyszukiwana
-- dynamicznie na wypadek innej nazwy w praktyce).
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'email_campaigns'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%draft%approved%sending%done%cancelled%'
     AND pg_get_constraintdef(oid) NOT LIKE '%queued_at%';
  IF cname IS NULL THEN
    RAISE EXCEPTION 'email_campaigns_status_check_not_found';
  END IF;
  EXECUTE format('ALTER TABLE email_campaigns DROP CONSTRAINT %I', cname);
END $$;
ALTER TABLE email_campaigns ADD CONSTRAINT email_campaigns_status_check
  CHECK (status IN ('draft', 'approved', 'sending', 'paused', 'done', 'cancelled'));

ALTER TABLE email_campaigns DROP CONSTRAINT email_campaign_sending_queued;
ALTER TABLE email_campaigns ADD CONSTRAINT email_campaign_sending_queued
  CHECK (status NOT IN ('sending', 'paused', 'done') OR (queued_at IS NOT NULL AND queued_by IS NOT NULL AND daily_cap IS NOT NULL));

CREATE OR REPLACE FUNCTION email_campaign_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email_campaigns_cannot_be_deleted';
  END IF;
  IF OLD.status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'email_campaign_closed';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'email_campaign_identity_immutable';
  END IF;
  IF NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body_text IS DISTINCT FROM OLD.body_text
     OR NEW.audience IS DISTINCT FROM OLD.audience OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.recipients_hash IS DISTINCT FROM OLD.recipients_hash
     OR NEW.recipients_count IS DISTINCT FROM OLD.recipients_count
     OR NEW.send_not_before IS DISTINCT FROM OLD.send_not_before THEN
    -- Zmiana treści, listy lub terminu startu: tylko przed wysyłką i zawsze z utratą zatwierdzenia.
    IF OLD.status NOT IN ('draft', 'approved') THEN
      RAISE EXCEPTION 'email_campaign_content_locked';
    END IF;
    IF NEW.status <> 'draft' OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'email_campaign_change_requires_reapproval';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'sending', 'cancelled'))
    OR (OLD.status = 'sending' AND NEW.status IN ('done', 'paused', 'cancelled'))
    OR (OLD.status = 'paused' AND NEW.status IN ('sending', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'email_campaign_invalid_transition';
  END IF;
  IF OLD.status IN ('sending', 'paused') AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.daily_cap IS DISTINCT FROM OLD.daily_cap
     OR NEW.queued_at IS DISTINCT FROM OLD.queued_at) THEN
    RAISE EXCEPTION 'email_campaign_sending_locked';
  END IF;
  -- paused_by/paused_at i resumed_by/resumed_at zmieniają się wyłącznie razem
  -- z przejściem, którego dotyczą (trasy pause/resume) — nie da się ich
  -- ustawić przy okazji innej zmiany.
  IF (NEW.paused_by IS DISTINCT FROM OLD.paused_by OR NEW.paused_at IS DISTINCT FROM OLD.paused_at)
     AND NOT (OLD.status = 'sending' AND NEW.status = 'paused') THEN
    RAISE EXCEPTION 'email_campaign_pause_fields_locked';
  END IF;
  IF (NEW.resumed_by IS DISTINCT FROM OLD.resumed_by OR NEW.resumed_at IS DISTINCT FROM OLD.resumed_at)
     AND NOT (OLD.status = 'paused' AND NEW.status = 'sending') THEN
    RAISE EXCEPTION 'email_campaign_resume_fields_locked';
  END IF;
  RETURN NEW;
END $$;
