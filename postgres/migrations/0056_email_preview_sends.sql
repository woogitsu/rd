-- Wysyłka testowa kampanii na adresy techniczne Rady (issue #104).
-- Tylko nowa tabela i rozszerzenie CHECK istniejącego dziennika limitu.
-- Żaden istniejący wiersz nie jest zmieniany.

-- Dziennik zużycia limitu dostawcy dopuszcza teraz też source = 'preview'
-- (wysyłka testowa liczy się do dziennej puli konta, jak przypomina #104).
-- Wiersz 'preview' odnosi się do kampanii, ale nie do konkretnego wiersza
-- kolejki (email_outbox) — testu nie ma w kolejce.
ALTER TABLE email_send_ledger DROP CONSTRAINT email_ledger_campaign_row;
ALTER TABLE email_send_ledger ADD CONSTRAINT email_ledger_campaign_row CHECK (
  (source = 'campaign' AND campaign_id IS NOT NULL AND outbox_id IS NOT NULL AND attempt IS NOT NULL AND message_count = 1)
  OR (source = 'preview' AND campaign_id IS NOT NULL AND outbox_id IS NULL AND attempt IS NULL AND message_count = 1)
  OR (source = 'other' AND campaign_id IS NULL AND outbox_id IS NULL AND attempt IS NULL)
);
ALTER TABLE email_send_ledger DROP CONSTRAINT email_send_ledger_source_check;
ALTER TABLE email_send_ledger ADD CONSTRAINT email_send_ledger_source_check CHECK (source IN ('campaign', 'other', 'preview'));

-- Wysyłki testowe (tylko dopisywanie): dzienny limit na kampanię (5) i na
-- konto (20) liczony z tej tabeli, bez adresu (recipient_hash = SHA-256
-- znormalizowanego adresu, ten sam wzór co email_hash w treści kampanii).
CREATE TABLE email_preview_sends (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES email_campaigns(id),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  recipient_hash TEXT NOT NULL CHECK (recipient_hash ~ '^[0-9a-f]{64}$'),
  actor_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  provider_message_id TEXT CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_preview_sends_campaign_day_idx ON email_preview_sends(campaign_id, created_at);

CREATE TRIGGER email_preview_sends_append_only BEFORE UPDATE OR DELETE ON email_preview_sends
  FOR EACH ROW EXECUTE FUNCTION email_append_only();
