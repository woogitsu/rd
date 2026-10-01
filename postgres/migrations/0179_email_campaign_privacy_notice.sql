-- #145 (D-06): zatwierdzenie kampanii e-mail wymaga OPUBLIKOWANEJ wersji
-- informacji o przetwarzaniu danych (privacy_notices, 0075) i zapamiętuje ją.
-- Wzór: 0162 (approved_payment_instructions_id).
--   * `email_campaigns.privacy_notice_id` — identyfikator opublikowanej wersji
--     obowiązującej w chwili zatwierdzenia; ustawiany w tej samej instrukcji
--     UPDATE co przejście draft -> approved (POST /api/email/campaigns/{id}/approve);
--   * brak opublikowanej wersji => 409 privacy_notice_missing (zatwierdzenie);
--   * podgląd zatwierdzonej kampanii, wiadomość testowa i worker dopisują do
--     stopki odnośnik do informacji i numer wersji z TEJ wersji (po id), nie z
--     „bieżącej”; w szkicu podgląd pokazuje bieżącą opublikowaną wersję.
--     Treść informacji (D-06) NIE jest częścią tej migracji ani kodu.
--
-- Strażnik (nowa funkcja; istniejące triggery email_campaigns bez zmian):
--   * kolumnę można ustawić wyłącznie przy przejściu draft -> approved, a
--     wyczyścić wyłącznie przy cofnięciu approved -> draft; w każdym innym
--     UPDATE jest niezmienna ('sending'/'paused'/'done'/'cancelled');
--   * CHECK: szkic nigdy nie nosi wersji;
--   * wersja musi mieć status 'published' w chwili zatwierdzenia;
--   * INSERT zawsze bez wersji — kampania powstaje jako szkic.
-- FK do privacy_notices: wiersz wersji jest niezmienny i nieusuwalny (0075).
--
-- Skutki dla danych: nowa kolumna bez DEFAULT — istniejące kampanie dostają NULL;
-- nic nie jest uzupełniane wstecznie. Kampania zatwierdzona przed tą migracją
-- (stan 'approved', 'sending' albo 'paused') nie ma wiązania z informacją:
-- kolejkowanie i wznowienie odmówią z 409 privacy_notice_missing, a worker ją
-- pominie (wiersze zostają 'queued', nic nie wychodzi). Trzeba cofnąć do
-- szkicu (zmiana treści/nowa migawka) i zatwierdzić ponownie albo anulować i
-- utworzyć nową. Wariant zachowawczy: żadna wiadomość nie wychodzi bez
-- zapisanej wersji informacji (prototyp nie jest wdrożony; na danych
-- syntetycznych takich kampanii nie ma). Kampanie 'done'/'cancelled' bez zmian.
-- ADD COLUMN bez DEFAULT nie przepisuje tabeli i nie uruchamia UPDATE-triggerów;
-- CHECK spełniają istniejące wiersze (wszystkie NULL). Kampanie są poza
-- eksportem rocznym (EXPORT_EXCLUDED_TABLES), bez zmian.
-- Wycofanie: DROP TRIGGER, DROP FUNCTION, DROP COLUMN.

ALTER TABLE email_campaigns
  ADD COLUMN privacy_notice_id TEXT REFERENCES privacy_notices(id),
  ADD CONSTRAINT email_campaigns_draft_without_privacy_notice
    CHECK (status <> 'draft' OR privacy_notice_id IS NULL);

CREATE FUNCTION email_campaign_privacy_notice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE notice_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.privacy_notice_id IS NOT NULL THEN
      RAISE EXCEPTION 'email_campaign_privacy_notice_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.privacy_notice_id IS NOT DISTINCT FROM OLD.privacy_notice_id THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status = 'approved')
          OR (OLD.status = 'approved' AND NEW.status = 'draft')) THEN
    RAISE EXCEPTION 'email_campaign_privacy_notice_immutable';
  END IF;
  IF NEW.privacy_notice_id IS NOT NULL THEN
    SELECT status INTO notice_status FROM privacy_notices WHERE id = NEW.privacy_notice_id;
    IF FOUND AND notice_status IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'email_campaign_privacy_notice_not_published';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_campaigns_privacy_notice_guard BEFORE INSERT OR UPDATE ON email_campaigns
  FOR EACH ROW EXECUTE FUNCTION email_campaign_privacy_notice_guard();
