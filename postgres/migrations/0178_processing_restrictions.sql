-- Ograniczenie przetwarzania (RODO art. 18) — oznaczenie gospodarstwa albo
-- opiekuna jako „ograniczone” (#100, pkt 5 propozycji). Oznaczenie wyklucza:
--   * gospodarstwo: z migawki kampanii e-mail (powód wykluczenia
--     'processing_restricted') i z wydruku kartek;
--   * opiekuna: jako adresata e-mail (inny opiekun tej samej rodziny, bez
--     ograniczenia, może nadal dostać wiadomość). Kartka nie zawiera danych
--     opiekuna, więc jej nie dotyczy (założenie do D-07).
-- Dane NIE są usuwane ani zmieniane: ograniczenie to dodatkowy stan, który
-- tylko wyłącza wybrane operacje. Usunięcie/anonimizacja pozostaje osobnym
-- zakresem (retencja #91, D-04).
--
-- Model: tabela tylko do dopisywania. Nałożenie ('restrict') i zdjęcie ('lift')
-- to dwa osobne wiersze z aktorem, czasem serwera i odwołaniem do żądania
-- (data_subject_requests, 0068). Zdjęcie nie kasuje i nie zmienia wiersza
-- nałożenia — historia zostaje. Stan bieżący = ostatni wiersz dla podmiotu
-- (widok processing_restricted_subjects).
--
-- Skutki dla danych:
--   * dwie nowe struktury (tabela + widok); brak wstecznego wypełnienia —
--     po migracji nikt nie jest ograniczony;
--   * bez treści żądania, powodu w wolnym tekście i danych kontaktowych
--     (tylko identyfikatory obiektu, akcja, aktor, czas);
--   * wiersz nie jest nigdy usuwany ani zmieniany (trigger; TRUNCATE blokuje
--     deny_truncate() z 0095), created_at stempluje zegar bazy
--     (stamp_created_now() z 0144);
--   * rozszerzenie CHECK email_campaign_exclusions.reason o
--     'processing_restricted' — istniejące wykluczenia bez zmian;
--   * kampanie już zatwierdzone/zakolejkowane przed nałożeniem ograniczenia:
--     worker pomija wiersz kolejki (skipped, 'processing_restricted') przy
--     ponownym sprawdzeniu przed wysyłką.
--
-- Wycofanie: DROP VIEW processing_restricted_subjects; DROP TABLE
-- processing_restrictions; DROP FUNCTION processing_restrictions_guard();
-- przywrócenie CHECK z 0158 (tylko bez wierszy 'processing_restricted').
-- Znika ślad ograniczeń; dane rodzin bez zmian.
CREATE TABLE processing_restrictions (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  request_id TEXT NOT NULL REFERENCES data_subject_requests(id),
  household_id TEXT REFERENCES households(id),
  guardian_id TEXT REFERENCES guardians(id),
  action TEXT NOT NULL CHECK (action IN ('restrict', 'lift')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((household_id IS NOT NULL)::int + (guardian_id IS NOT NULL)::int = 1)
);
CREATE INDEX processing_restrictions_household_idx ON processing_restrictions(household_id, seq) WHERE household_id IS NOT NULL;
CREATE INDEX processing_restrictions_guardian_idx ON processing_restrictions(guardian_id, seq) WHERE guardian_id IS NOT NULL;
CREATE INDEX processing_restrictions_request_idx ON processing_restrictions(request_id);

CREATE FUNCTION processing_restrictions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rd.restore', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'processing_restrictions_are_append_only';
END $$;
CREATE TRIGGER processing_restrictions_guard BEFORE UPDATE OR DELETE ON processing_restrictions
  FOR EACH ROW EXECUTE FUNCTION processing_restrictions_guard();
CREATE TRIGGER processing_restrictions_no_truncate BEFORE TRUNCATE ON processing_restrictions
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();
CREATE TRIGGER a0_stamp_created_now BEFORE INSERT ON processing_restrictions
  FOR EACH ROW EXECUTE FUNCTION stamp_created_now('created_at');

-- Podmioty, których ostatni wiersz to 'restrict' (jedna z kolumn jest NULL).
CREATE VIEW processing_restricted_subjects AS
SELECT household_id, guardian_id FROM (
  SELECT DISTINCT ON (household_id, guardian_id) household_id, guardian_id, action
    FROM processing_restrictions
   ORDER BY household_id, guardian_id, seq DESC
) latest
WHERE action = 'restrict';

ALTER TABLE email_campaign_exclusions DROP CONSTRAINT email_campaign_exclusions_reason_check;
ALTER TABLE email_campaign_exclusions ADD CONSTRAINT email_campaign_exclusions_reason_check CHECK (reason IN
  ('no_consent', 'no_valid_email', 'duplicate_address', 'suppressed', 'payment_recorded', 'opted_out',
   'followup_already_covered', 'no_payment_reference', 'processing_restricted'));
