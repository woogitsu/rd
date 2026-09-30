-- Trwała pauza wysyłki po odmowie konta przez dostawcę e-mail (#209, punkt 3
-- propozycji).
--
-- Problem: po 401/402/403 z Brevo (zły lub obrócony klucz, brak kredytów,
-- nieuprawniony nadawca lub IP) worker zatrzymywał przebieg i zwracał
-- wiadomość do kolejki (#243), ale KAŻDY kolejny przebieg crona ponawiał
-- jedno wywołanie z tym samym, odrzucanym kluczem — bez końca i bez
-- jawnego potwierdzenia, że konfigurację poprawiono.
--
-- Zmiany:
-- * Nowa tabela email_provider_pauses: jeden wiersz na odmowę konta, zapisany
--   przez worker w tej samej transakcji co zwrot wiadomości do kolejki
--   (kod błędu dostawcy, kampania i przebieg, w którym wystąpiła odmowa).
--   Dopóki istnieje wiersz niezdjęty (lifted_at IS NULL), worker nie
--   przejmuje kolejki i nie łączy się z dostawcą (stopped_reason =
--   'provider_account_paused').
-- * Najwyżej jedna aktywna pauza danego powodu (unikalny indeks częściowy),
--   więc równoległe przebiegi nie tworzą duplikatów.
-- * Zdjęcie pauzy = jednorazowe ustawienie lifted_by/lifted_at (trasa
--   POST /api/email/provider-pause/lift, zarząd z MFA, zdarzenie audytu).
--   Poza tym wiersze są niezmienne (strażnik email_provider_pause_guard),
--   bez DELETE i TRUNCATE; created_at i lifted_at z zegara bazy (0144).
-- * Bez adresów, imion i treści wiadomości — tylko kody, identyfikatory
--   kampanii i przebiegu oraz identyfikator osoby zdejmującej pauzę.
--
-- Skutki dla danych: żaden istniejący wiersz nie jest zmieniany. Kampanie,
-- kolejka (email_outbox), dziennik limitu i przebiegi pozostają bez zmian;
-- wiadomości zwrócone do kolejki po odmowie konta przed tą migracją zostaną
-- wysłane przy najbliższym przebiegu, jak dotąd (brak wiersza pauzy).
-- Wycofanie: na bazie bez pauz — DROP TABLE email_provider_pauses i DROP
-- FUNCTION email_provider_pause_guard(); na bazie z pauzami tylko po kopii
-- zapasowej (znika ślad, kto i kiedy potwierdził naprawę; zdarzenia
-- email.provider.* zostają w audit_events).

CREATE TABLE email_provider_pauses (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('account_rejected')),
  error_code TEXT NOT NULL CHECK (error_code ~ '^[a-z0-9_]{1,60}$'),
  campaign_id TEXT REFERENCES email_campaigns(id),
  run_id TEXT CHECK (run_id IS NULL OR run_id ~ '^[A-Za-z0-9-]{1,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_by TEXT REFERENCES users(id),
  lifted_at TIMESTAMPTZ,
  CONSTRAINT email_provider_pause_lift_actor CHECK ((lifted_at IS NULL) = (lifted_by IS NULL))
);
CREATE UNIQUE INDEX email_provider_pauses_active_idx ON email_provider_pauses(reason) WHERE lifted_at IS NULL;
CREATE INDEX email_provider_pauses_created_idx ON email_provider_pauses(created_at);

-- Jedyna dozwolona zmiana: zdjęcie aktywnej pauzy (lifted_by/lifted_at z NULL
-- na wartość, raz). Pozostałe kolumny i usuwanie — odrzucane.
CREATE FUNCTION email_provider_pause_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email_provider_pause_immutable';
  END IF;
  IF ROW(NEW.id, NEW.reason, NEW.error_code, NEW.campaign_id, NEW.run_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.reason, OLD.error_code, OLD.campaign_id, OLD.run_id, OLD.created_at)
     OR OLD.lifted_at IS NOT NULL OR OLD.lifted_by IS NOT NULL
     OR NEW.lifted_at IS NULL OR NEW.lifted_by IS NULL THEN
    RAISE EXCEPTION 'email_provider_pause_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_provider_pauses_guard BEFORE UPDATE OR DELETE ON email_provider_pauses
  FOR EACH ROW EXECUTE FUNCTION email_provider_pause_guard();
CREATE TRIGGER email_provider_pauses_no_truncate BEFORE TRUNCATE ON email_provider_pauses
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();
CREATE TRIGGER a0_stamp_created_now BEFORE INSERT ON email_provider_pauses
  FOR EACH ROW EXECUTE FUNCTION stamp_created_now('created_at');
CREATE TRIGGER a0_stamp_transition_now BEFORE UPDATE ON email_provider_pauses
  FOR EACH ROW EXECUTE FUNCTION stamp_transition_now('lifted_at');
