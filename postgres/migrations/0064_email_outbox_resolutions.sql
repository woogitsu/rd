-- Rozstrzyganie delivery_unknown/soft_bounce bez zmiany historii wiersza
-- outbox (#139). Tylko nowa tabela, tylko dopisywanie.
--
-- Skutki dla danych: brak zmian w istniejących tabelach. Nowa tabela jest
-- pusta po migracji; wypełnia się wyłącznie przez trasę
-- POST /api/email/campaigns/{id}/resolutions.

CREATE TABLE email_outbox_resolutions (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES email_outbox(id),
  campaign_id TEXT NOT NULL REFERENCES email_campaigns(id),
  resolution TEXT NOT NULL CHECK (resolution IN ('confirmed_delivered', 'confirmed_not_sent')),
  evidence_code TEXT NOT NULL CHECK (evidence_code ~ '^[a-z0-9_]{1,60}$'),
  resolved_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_resolutions_outbox_idx ON email_outbox_resolutions(outbox_id, created_at);

CREATE TRIGGER email_outbox_resolutions_append_only BEFORE UPDATE OR DELETE ON email_outbox_resolutions
  FOR EACH ROW EXECUTE FUNCTION email_append_only();
