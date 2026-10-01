-- #92: kampania e-mail zapamiętuje, którą ZATWIERDZONĄ wersję danych do wpłaty
-- (payment_instructions) widział i zatwierdził zatwierdzający treść z
-- {rachunek}/{odbiorca}. Dotąd wiązanie istniało wyłącznie w metadanych
-- zdarzenia `email.campaign.approved` (paymentInstructionsId), a kolejka,
-- wznowienie i worker odczytywały je z audit_events. Teraz:
--   * `email_campaigns.approved_payment_instructions_id` — identyfikator wersji
--     ustawiany w tej samej instrukcji UPDATE co przejście draft -> approved
--     (trasa POST /api/email/campaigns/{id}/approve); NULL dla treści bez
--     {rachunek}/{odbiorca};
--   * podgląd zatwierdzonej kampanii, wiadomość testowa i worker renderują
--     rachunek z TEJ wersji (po id), nie z „bieżącej”;
--   * wariant zachowawczy (bez zmian względem dotychczasowego zachowania):
--     jeśli po zatwierdzeniu kampanii zatwierdzono nowszą wersję danych do
--     wpłaty, kolejka i wznowienie odmawiają (409 payment_instructions_changed),
--     a worker pomija kampanię (wiersze zostają 'queued'). Ponowne zatwierdzenie
--     kampanii jest wymagane — nie wysyłamy ani starego rachunku (już
--     skorygowanego), ani nowego (niezatwierdzonego w kampanii).
--
-- Strażnik (nowa funkcja, istniejące email_campaign_guard i pozostałe
-- triggery bez zmian):
--   * kolumnę można ustawić wyłącznie przy przejściu draft -> approved,
--     a wyczyścić wyłącznie przy cofnięciu approved -> draft; w każdym innym
--     UPDATE jest niezmienna (także w 'sending'/'paused'/'done'/'cancelled');
--   * CHECK: szkic nigdy nie nosi wersji (cofnięcie do szkicu musi ją
--     wyczyścić, jak approved_by/approved_at);
--   * wersja musi należeć do roku szkolnego kampanii;
--   * nowy wiersz (INSERT) zawsze bez wersji — kampania powstaje jako szkic.
-- FK do payment_instructions: wiersz wersji i tak jest niezmienny i nieusuwalny
-- (payment_instructions_guard, 0086).
--
-- Skutki dla danych: nowa kolumna bez wartości domyślnej — istniejące kampanie
-- dostają NULL. Niczego nie uzupełniamy wstecznie z audit_events. Dla
-- kampanii bez {rachunek}/{odbiorca} NULL jest poprawnym stanem i nic się nie
-- zmienia. Kampania z {rachunek}/{odbiorca} zatwierdzona przed tą migracją
-- (stan 'approved', 'sending' albo 'paused') traci wiązanie: kolejka i
-- wznowienie odmówią z 409 payment_instructions_changed, a worker ją pominie
-- (nic nie wychodzi) — trzeba zbudować migawkę i zatwierdzić ponownie albo
-- anulować i utworzyć nową. To świadomie zachowawcze (prototyp nie jest
-- wdrożony; na danych syntetycznych takich kampanii nie ma). Zdarzenia
-- `email.campaign.approved` z paymentInstructionsId zostają w dzienniku bez
-- zmian. ADD COLUMN bez DEFAULT nie przepisuje tabeli i nie uruchamia
-- triggerów UPDATE. CHECK jest spełniony przez istniejące wiersze (wszystkie
-- NULL). Kampanie są poza eksportem rocznym (EXPORT_EXCLUDED_TABLES), bez zmian.
-- Wycofanie: DROP TRIGGER, DROP FUNCTION, DROP COLUMN — zostaje wiązanie
-- przez metadane zdarzeń (kod sprzed migracji).

ALTER TABLE email_campaigns
  ADD COLUMN approved_payment_instructions_id TEXT REFERENCES payment_instructions(id),
  ADD CONSTRAINT email_campaigns_draft_without_payment_instructions
    CHECK (status <> 'draft' OR approved_payment_instructions_id IS NULL);

CREATE FUNCTION email_campaign_payment_instructions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_year TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.approved_payment_instructions_id IS NOT NULL THEN
      RAISE EXCEPTION 'email_campaign_payment_instructions_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.approved_payment_instructions_id IS NOT DISTINCT FROM OLD.approved_payment_instructions_id THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status = 'approved')
          OR (OLD.status = 'approved' AND NEW.status = 'draft')) THEN
    RAISE EXCEPTION 'email_campaign_payment_instructions_immutable';
  END IF;
  IF NEW.approved_payment_instructions_id IS NOT NULL THEN
    SELECT school_year_id INTO version_year FROM payment_instructions WHERE id = NEW.approved_payment_instructions_id;
    IF FOUND AND version_year IS DISTINCT FROM NEW.school_year_id THEN
      RAISE EXCEPTION 'email_campaign_payment_instructions_year_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_campaigns_payment_instructions_guard BEFORE INSERT OR UPDATE ON email_campaigns
  FOR EACH ROW EXECUTE FUNCTION email_campaign_payment_instructions_guard();
