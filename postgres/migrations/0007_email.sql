-- Kampanie e-mail, migawka odbiorców, kolejka wysyłki Brevo i dzienny limit (issues #10, #40).
-- Tylko nowe tabele, funkcje i triggery. Istniejące wiersze nie są zmieniane.
-- Składki są dobrowolne: nic tu nie wylicza należności ani statusu dłużnika.

-- Kampania: draft -> approved -> sending -> done; draft/approved/sending -> cancelled.
-- Zatwierdzenie dotyczy dokładnego skrótu treści (content_hash) i migawki
-- odbiorców (recipients_hash). Każda zmiana treści lub odbiorców cofa kampanię
-- do szkicu i usuwa zatwierdzenie (historia zostaje w audit_events).
CREATE TABLE email_campaigns (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  audience TEXT NOT NULL CHECK (audience IN ('all_households', 'no_payment_record')),
  subject TEXT NOT NULL CHECK (length(btrim(subject)) BETWEEN 3 AND 200),
  body_text TEXT NOT NULL CHECK (length(btrim(body_text)) BETWEEN 20 AND 10000),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'sending', 'done', 'cancelled')),
  recipients_hash TEXT CHECK (recipients_hash ~ '^[0-9a-f]{64}$'),
  recipients_count INTEGER CHECK (recipients_count >= 0),
  snapshot_built_by TEXT REFERENCES users(id),
  snapshot_built_at TIMESTAMPTZ,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  approved_content_hash TEXT,
  approved_recipients_hash TEXT,
  daily_cap INTEGER CHECK (daily_cap > 0),
  queued_by TEXT REFERENCES users(id),
  queued_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_by TEXT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  CONSTRAINT email_campaign_snapshot_complete CHECK (
    (recipients_hash IS NULL AND recipients_count IS NULL AND snapshot_built_by IS NULL AND snapshot_built_at IS NULL)
    OR (recipients_hash IS NOT NULL AND recipients_count IS NOT NULL AND snapshot_built_by IS NOT NULL AND snapshot_built_at IS NOT NULL)
  ),
  CONSTRAINT email_campaign_approval_complete CHECK (
    (approved_by IS NULL AND approved_at IS NULL AND approved_content_hash IS NULL AND approved_recipients_hash IS NULL)
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_content_hash IS NOT NULL AND approved_recipients_hash IS NOT NULL)
  ),
  -- Autor (tworzący, ostatnio edytujący, budujący listę) nie zatwierdza sam siebie.
  CONSTRAINT email_campaign_four_eyes CHECK (
    approved_by IS NULL OR (approved_by <> created_by AND approved_by <> updated_by AND approved_by <> snapshot_built_by)
  ),
  -- Stan approved/sending/done wymaga zatwierdzenia dokładnie bieżącej treści i listy.
  CONSTRAINT email_campaign_approved_exact CHECK (
    status NOT IN ('approved', 'sending', 'done')
    OR (approved_at IS NOT NULL AND approved_content_hash = content_hash AND approved_recipients_hash = recipients_hash)
  ),
  CONSTRAINT email_campaign_sending_queued CHECK (
    status NOT IN ('sending', 'done') OR (queued_at IS NOT NULL AND queued_by IS NOT NULL AND daily_cap IS NOT NULL)
  ),
  CONSTRAINT email_campaign_cancel_actor CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
  )
);
CREATE INDEX email_campaigns_year_idx ON email_campaigns(school_year_id, created_at);
CREATE INDEX email_campaigns_sending_idx ON email_campaigns(status) WHERE status = 'sending';

CREATE FUNCTION email_campaign_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR NEW.recipients_count IS DISTINCT FROM OLD.recipients_count THEN
    -- Zmiana treści lub listy: tylko przed wysyłką i zawsze z utratą zatwierdzenia.
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
    OR (OLD.status = 'sending' AND NEW.status IN ('done', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'email_campaign_invalid_transition';
  END IF;
  IF OLD.status = 'sending' AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.daily_cap IS DISTINCT FROM OLD.daily_cap
     OR NEW.queued_at IS DISTINCT FROM OLD.queued_at) THEN
    RAISE EXCEPTION 'email_campaign_sending_locked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_campaigns_guard BEFORE UPDATE OR DELETE ON email_campaigns
  FOR EACH ROW EXECUTE FUNCTION email_campaign_guard();

-- Migawka odbiorców: najwyżej jedna wiadomość na rodzinę i jeden adres na kampanię.
-- Adres jest przechowywany, bo jest potrzebny do wysyłki; email_hash (SHA-256
-- znormalizowanego adresu) służy do deduplikacji i listy wyłączeń.
CREATE TABLE email_campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES email_campaigns(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  guardian_id TEXT NOT NULL REFERENCES guardians(id),
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 6 AND 254),
  email_hash TEXT NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, household_id),
  UNIQUE (campaign_id, email_hash),
  UNIQUE (id, campaign_id, household_id)
);
CREATE INDEX email_campaign_recipients_guardian_idx ON email_campaign_recipients(guardian_id);

-- Rodziny pominięte przy budowie listy (raport dla zatwierdzającego).
CREATE TABLE email_campaign_exclusions (
  campaign_id TEXT NOT NULL REFERENCES email_campaigns(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  reason TEXT NOT NULL CHECK (reason IN
    ('no_consent', 'no_valid_email', 'duplicate_address', 'suppressed', 'payment_recorded')),
  PRIMARY KEY (campaign_id, household_id)
);

-- Migawkę można przebudować tylko w szkicu; po zakolejkowaniu jest zamrożona.
CREATE FUNCTION email_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign_status TEXT;
BEGIN
  SELECT status INTO campaign_status FROM email_campaigns
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.campaign_id ELSE NEW.campaign_id END;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'email_snapshot_rows_immutable';
  END IF;
  IF campaign_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'email_snapshot_locked';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER email_campaign_recipients_guard BEFORE INSERT OR UPDATE OR DELETE ON email_campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION email_snapshot_guard();
CREATE TRIGGER email_campaign_exclusions_guard BEFORE INSERT OR UPDATE OR DELETE ON email_campaign_exclusions
  FOR EACH ROW EXECUTE FUNCTION email_snapshot_guard();

-- Kolejka: jeden wiersz na (kampania, rodzina), klucz idempotencji o stałym formacie.
CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES email_campaigns(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  recipient_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN
    ('queued', 'sending', 'sent', 'failed', 'bounced', 'suppressed', 'skipped', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  provider_message_id TEXT UNIQUE CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  last_error TEXT CHECK (last_error ~ '^[a-z0-9_]{1,60}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (recipient_id, campaign_id, household_id)
    REFERENCES email_campaign_recipients(id, campaign_id, household_id),
  UNIQUE (campaign_id, household_id),
  CONSTRAINT email_outbox_key_format CHECK (idempotency_key = 'campaign:' || campaign_id || ':household:' || household_id),
  CONSTRAINT email_outbox_sent_fields CHECK (state NOT IN ('sent', 'bounced') OR sent_at IS NOT NULL)
);
CREATE INDEX email_outbox_claim_idx ON email_outbox(campaign_id, next_attempt_at, created_at) WHERE state = 'queued';
CREATE INDEX email_outbox_state_idx ON email_outbox(campaign_id, state);

-- Stany końcowe są ostateczne (poza sent -> bounced po webhooku). Wiersza nie usuwamy.
CREATE FUNCTION email_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email_outbox_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.household_id IS DISTINCT FROM OLD.household_id OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'email_outbox_identity_immutable';
  END IF;
  IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'email_outbox_message_id_immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'queued' AND NEW.state IN ('sending', 'skipped', 'suppressed', 'failed', 'cancelled'))
    OR (OLD.state = 'sending' AND NEW.state IN ('sent', 'failed', 'queued'))
    OR (OLD.state = 'sent' AND NEW.state = 'bounced')
  ) THEN
    RAISE EXCEPTION 'email_outbox_invalid_transition';
  END IF;
  -- Powrót do kolejki tylko po jawnej odmowie dostawcy (np. 429) — nigdy po wysłaniu.
  IF OLD.state = 'sending' AND NEW.state = 'queued' AND NEW.provider_message_id IS NOT NULL THEN
    RAISE EXCEPTION 'email_outbox_sent_cannot_requeue';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_outbox_guard BEFORE UPDATE OR DELETE ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION email_outbox_guard();

-- Dziennik zużycia limitu dostawcy (dzień UTC). Brevo Free: 300/dzień na całe konto,
-- więc inne wiadomości konta (source = 'other') także zmniejszają pulę.
CREATE TABLE email_send_ledger (
  id TEXT PRIMARY KEY,
  day DATE NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('campaign', 'other')),
  campaign_id TEXT REFERENCES email_campaigns(id),
  outbox_id TEXT REFERENCES email_outbox(id),
  attempt INTEGER CHECK (attempt BETWEEN 1 AND 20),
  message_count INTEGER NOT NULL CHECK (message_count BETWEEN 1 AND 10000),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Każda próba wysyłki wiersza kolejki zużywa limit najwyżej raz.
  UNIQUE (outbox_id, attempt),
  CONSTRAINT email_ledger_campaign_row CHECK (
    (source = 'campaign' AND campaign_id IS NOT NULL AND outbox_id IS NOT NULL AND attempt IS NOT NULL AND message_count = 1)
    OR (source = 'other' AND campaign_id IS NULL AND outbox_id IS NULL AND attempt IS NULL)
  )
);
CREATE INDEX email_send_ledger_day_idx ON email_send_ledger(day, campaign_id);

-- Lista wyłączeń po bounce/skardze. Tylko skrót adresu, bez samego adresu.
CREATE TABLE email_suppressions (
  email_hash TEXT PRIMARY KEY CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'invalid_email', 'complaint', 'unsubscribed', 'blocked')),
  source_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wyłącznie zweryfikowane zdarzenia webhooka (bez adresu, tylko skrót).
CREATE TABLE email_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'brevo'),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
  event TEXT NOT NULL CHECK (event ~ '^[a-z_]{1,40}$'),
  provider_message_id TEXT CHECK (length(provider_message_id) <= 200),
  outbox_id TEXT REFERENCES email_outbox(id),
  email_hash TEXT CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_webhook_events_outbox_idx ON email_webhook_events(outbox_id);

-- Przebiegi zadania (również dry-run) — bez adresów.
CREATE TABLE email_worker_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'live')),
  day DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  remaining_quota INTEGER NOT NULL,
  planned INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  retried INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  suppressed INTEGER NOT NULL DEFAULT 0,
  stopped_reason TEXT CHECK (stopped_reason ~ '^[a-z0-9_]{1,60}$')
);

CREATE FUNCTION email_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%_are_append_only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER email_send_ledger_append_only BEFORE UPDATE OR DELETE ON email_send_ledger
  FOR EACH ROW EXECUTE FUNCTION email_append_only();
CREATE TRIGGER email_suppressions_append_only BEFORE UPDATE OR DELETE ON email_suppressions
  FOR EACH ROW EXECUTE FUNCTION email_append_only();
CREATE TRIGGER email_webhook_events_append_only BEFORE UPDATE OR DELETE ON email_webhook_events
  FOR EACH ROW EXECUTE FUNCTION email_append_only();
CREATE TRIGGER email_worker_runs_append_only BEFORE UPDATE OR DELETE ON email_worker_runs
  FOR EACH ROW EXECUTE FUNCTION email_append_only();
