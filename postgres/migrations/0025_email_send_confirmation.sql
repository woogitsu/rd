-- Potwierdzenie wysyłki tuż przed wywołaniem dostawcy (#210, #177).
--
-- Worker potwierdza każdą wiadomość osobno jedną instrukcją UPDATE … RETURNING
-- tuż przed transport.send: wiersz nadal należy do tego przebiegu
-- (claim_token), jest w stanie 'sending', kampania nadal 'sending', a odbiorca
-- nadal się kwalifikuje (wpłata, lista wyłączeń, zgoda). Potwierdzenie ustawia
-- send_started_at. Jeżeli się nie powiedzie, wiersz — o ile nadal należy do
-- przebiegu — przechodzi do cancelled/skipped/suppressed bez wysyłki.
--
-- Skutki dla danych:
--   * email_outbox dostaje dwie kolumny dopuszczające NULL: claim_token (uuid
--     przebiegu, który przejął wiersz) i send_started_at (chwila przekazania
--     wiadomości do dostawcy). Istniejące wiersze nie są zmieniane — obie
--     kolumny pozostają puste.
--   * Wiersz 'sending' sprzed tej migracji (claim_token IS NULL) jest dalej
--     traktowany zachowawczo: po wygaśnięciu dzierżawy trafia do
--     failed/delivery_unknown, bo nie wiadomo, czy wyszedł.
--   * Trigger email_outbox_guard dopuszcza nowe przejścia
--     sending -> cancelled | skipped | suppressed wyłącznie, gdy wiadomość nie
--     została jeszcze przekazana dostawcy (OLD.send_started_at IS NULL).
--     Nie da się więc „cofnąć” wiadomości, której wysyłka się rozpoczęła.
--     Raz ustawionego send_started_at nie można wyczyścić, dopóki wiersz jest
--     w 'sending' (wyzerowanie dopuszczalne tylko przy powrocie do kolejki po
--     jawnej odmowie dostawcy, jak dotąd).
--   * Zakaz sending -> queued dla wiadomości z provider_message_id bez zmian.

ALTER TABLE email_outbox ADD COLUMN claim_token TEXT
  CHECK (claim_token IS NULL OR claim_token ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE email_outbox ADD COLUMN send_started_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION email_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR (OLD.state = 'sending' AND NEW.state IN ('cancelled', 'skipped', 'suppressed') AND OLD.send_started_at IS NULL)
    OR (OLD.state = 'sent' AND NEW.state = 'bounced')
  ) THEN
    RAISE EXCEPTION 'email_outbox_invalid_transition';
  END IF;
  -- Powrót do kolejki tylko po jawnej odmowie dostawcy (np. 429) — nigdy po wysłaniu.
  IF OLD.state = 'sending' AND NEW.state = 'queued' AND NEW.provider_message_id IS NOT NULL THEN
    RAISE EXCEPTION 'email_outbox_sent_cannot_requeue';
  END IF;
  -- Rozpoczętej wysyłki nie można „odznaczyć”, dopóki wiersz pozostaje w 'sending'.
  IF OLD.state = 'sending' AND NEW.state = 'sending'
     AND OLD.send_started_at IS NOT NULL AND NEW.send_started_at IS DISTINCT FROM OLD.send_started_at THEN
    RAISE EXCEPTION 'email_outbox_send_started_immutable';
  END IF;
  RETURN NEW;
END $$;
