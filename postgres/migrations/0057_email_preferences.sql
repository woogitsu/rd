-- Kategorie komunikatów i wypisanie jednym kliknięciem (issue #110).
-- Tylko nowa kolumna z domyślną wartością, nowa tabela i rozszerzenie CHECK.
-- Żaden istniejący wiersz nie jest zmieniany poza uzupełnieniem domyślnej
-- kategorii istniejących kampanii (wszystkie dotychczasowe to przypomnienia
-- o składce).

ALTER TABLE email_campaigns
  ADD COLUMN category TEXT NOT NULL DEFAULT 'contribution_reminder'
    CHECK (category IN ('contribution_reminder', 'organizational'));

-- Zdarzenia preferencji kontaktu wg kategorii (tylko dopisywanie). Stan
-- bieżący dla (email_hash, category) to ostatnie zdarzenie wg created_at.
-- Bez identyfikatora rodziny/opiekuna — adres jest jedynym kluczem, tak jak
-- w email_suppressions; ten sam adres może obsługiwać kilka rodzin/rodzeństw.
CREATE TABLE email_preferences_events (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  category TEXT NOT NULL CHECK (category IN ('contribution_reminder', 'organizational')),
  action TEXT NOT NULL CHECK (action IN ('opt_out', 'opt_in')),
  source TEXT NOT NULL CHECK (source IN ('link', 'webhook', 'staff_on_parent_request')),
  campaign_id TEXT REFERENCES email_campaigns(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_preferences_events_lookup_idx ON email_preferences_events(email_hash, category, created_at);

CREATE TRIGGER email_preferences_events_append_only BEFORE UPDATE OR DELETE ON email_preferences_events
  FOR EACH ROW EXECUTE FUNCTION email_append_only();

-- Migawka: nowy powód wykluczenia dla adresu wypisanego z kategorii kampanii.
ALTER TABLE email_campaign_exclusions DROP CONSTRAINT email_campaign_exclusions_reason_check;
ALTER TABLE email_campaign_exclusions ADD CONSTRAINT email_campaign_exclusions_reason_check CHECK (reason IN
  ('no_consent', 'no_valid_email', 'duplicate_address', 'suppressed', 'payment_recorded', 'opted_out'));
