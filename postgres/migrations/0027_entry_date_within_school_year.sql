-- Data wpisu księgi i wpłaty w granicach roku szkolnego (#169).
--
-- Co zmienia:
-- * Funkcja school_year_contains(rok, dzień): czy dzień leży w
--   [starts_on, ends_on] roku szkolnego (obie granice włącznie). Jedna
--   reguła dla bazy i dla raportów kontrolnych.
-- * Trigger b0_date_within_school_year (BEFORE INSERT) na ledger_entries
--   (occurred_on) i payment_entries (received_on). Nowy zapis z datą spoza
--   roku kończy się wyjątkiem date_outside_school_year — także przy
--   bezpośrednim INSERT z pominięciem API. Nazwa zaczyna się od „b0”, więc
--   trigger działa po a0_year_freeze (0017): zapis w zamkniętym roku nadal
--   daje school_year_closed.
-- * Wyjątek: odtworzenie istniejących danych (import z D1,
--   src/d1-postgres-migration.js) ustawia w swojej transakcji
--   SET LOCAL rd.restore = 'on'. Historyczne wiersze spoza zakresu są wtedy
--   przenoszone bez zmian (nie gubimy historii) i trafiają do raportu
--   poniżej. API nigdy tego ustawienia nie włącza.
-- * Widok school_year_date_deviations (tylko odczyt): istniejące wpisy
--   księgi i wpłaty (recorded/unmatched) z datą spoza roku. Używany przez
--   raport Komisji Rewizyjnej.
--
-- Założenie (D-21, D-13; zarząd nic jeszcze nie zdecydował): rok obrachunkowy
-- Rady = rok szkolny z school_years. Wariant zachowawczy: wpłata także musi
-- mieć datę w [starts_on, ends_on] — bez okna „wpłat z wyprzedzeniem”
-- przed 1 września. Szerokość takiego okna jest decyzją skarbnika/zarządu;
-- do tego czasu wpłatę z sierpnia zapisuje się w roku, w którym wpłynęła.
--
-- Skutki dla istniejących danych:
-- * Żaden wiersz nie jest zmieniany ani usuwany. Trigger działa wyłącznie
--   przy INSERT; wpłaty spoza zakresu nadal można przypisać do rodziny
--   (UPDATE statusu) i korygować, a wpisy księgi — korygować.
-- * Istniejące wiersze spoza zakresu zostają w sumach (ledger_year_summary)
--   tak jak dotąd i są raportowane: widok school_year_date_deviations
--   i kontrola „Daty w roku szkolnym” w raporcie KR. Poprawka należy do
--   skarbnika (korekta do zera i nowy wpis z właściwą datą, #144).
-- * Zapytanie kontrolne przed/po migracji:
--     SELECT kind, school_year_id, count(*) FROM school_year_date_deviations
--      GROUP BY kind, school_year_id;
-- * Zmiana dat roku w school_years nie jest blokowana; po niej wiersze spoza
--   nowego zakresu pojawią się w widoku.
--
-- Wycofanie: DROP VIEW school_year_date_deviations; DROP TRIGGER
-- b0_date_within_school_year ON ledger_entries / payment_entries;
-- DROP FUNCTION ledger_entry_date_guard, payment_entry_date_guard,
-- school_year_contains. Dane nie wymagają cofania.

CREATE FUNCTION school_year_contains(p_school_year_id TEXT, p_on DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM school_years y
     WHERE y.id = p_school_year_id AND p_on BETWEEN y.starts_on AND y.ends_on
  )
$$;

CREATE FUNCTION ledger_entry_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT school_year_contains(NEW.school_year_id, NEW.occurred_on)
     AND current_setting('rd.restore', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'date_outside_school_year';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER b0_date_within_school_year BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_date_guard();

CREATE FUNCTION payment_entry_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT school_year_contains(NEW.school_year_id, NEW.received_on)
     AND current_setting('rd.restore', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'date_outside_school_year';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER b0_date_within_school_year BEFORE INSERT ON payment_entries
  FOR EACH ROW EXECUTE FUNCTION payment_entry_date_guard();

CREATE VIEW school_year_date_deviations AS
SELECT 'ledger_entry'::TEXT AS kind, e.id, e.school_year_id, e.occurred_on AS entry_date,
       y.starts_on, y.ends_on
  FROM ledger_entries e JOIN school_years y ON y.id = e.school_year_id
 WHERE e.occurred_on NOT BETWEEN y.starts_on AND y.ends_on
UNION ALL
SELECT 'payment_entry'::TEXT, p.id, p.school_year_id, p.received_on, y.starts_on, y.ends_on
  FROM payment_entries p JOIN school_years y ON y.id = p.school_year_id
 WHERE p.status IN ('recorded', 'unmatched')
   AND p.received_on NOT BETWEEN y.starts_on AND y.ends_on;
