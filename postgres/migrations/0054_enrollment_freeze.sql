-- Zamrożenie roku obejmuje odtąd enrollments (#78, punkt 4 propozycji).
--
-- Skutki dla danych:
-- * Dodaje trigger a0_year_freeze na enrollments, taki sam jak na payment_entries/
--   ledger_entries/events/... (0017_year_close.sql) — zapis (INSERT/UPDATE) wskazujący
--   zamknięty rok (enrollments.school_year_id) dostaje 'school_year_closed'.
--   Odczyt (SELECT) i istniejące wiersze bez zmian.
-- * Bez nowych kolumn ani tabel. Rok już zamknięty przed tą migracją: jeśli ktoś
--   zdążył zmienić enrollments w międzyczasie, te wiersze zostają — trigger
--   działa tylko na przyszłe zapisy.
-- Wycofanie: na pustej bazie usunąć trigger; na bazie z danymi bezpiecznie —
-- trigger tylko blokuje zapisy, nie zmienia istniejących wierszy.

CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON enrollments
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
