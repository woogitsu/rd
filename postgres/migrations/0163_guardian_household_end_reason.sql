-- Powód zakończenia członkostwa opiekuna w gospodarstwie (#86, #535).
--
-- Nowa trasa POST /api/guardians/{id}/households/{membershipId}/end zapisuje
-- aktora (ended_by), czas (ended_at) i datę (ends_on) w guardian_households,
-- ale tabela nie miała miejsca na powód zmiany — inaczej niż student_households
-- (0136). Ta migracja dodaje jedną kolumnę tekstową.
--
-- Skutki dla danych:
-- * Dodaje guardian_households.ended_reason (nullable, 3–500 znaków po
--   przycięciu). Istniejące wiersze mają NULL — nikt nie podał powodu
--   wstecznie. Żaden wiersz nie jest zmieniany ani usuwany.
-- * CHECK guardian_household_end_reason_with_end: powód tylko razem z datą
--   zakończenia (ends_on). Istniejące wiersze go spełniają (NULL).
-- * Kolumna jest wolnym tekstem i może opisywać sytuację rodzinną (rozwód,
--   wyprowadzka) — wpis w privacy/data-inventory.json i w
--   docs/DPIA_CHECKLIST.md jak dla student_households.ended_reason. Do
--   audit_events trafia wyłącznie identyfikator obiektu, bez powodu.
-- * guardian_household_check (najnowsza wersja: 0023) bez zmian: po
--   zakończeniu żadna zmiana wiersza nie jest możliwa
--   (guardian_household_already_ended), więc ended_reason ustawiony razem
--   z ends_on jest niezmienny. Korekta = nowe członkostwo.
-- Wycofanie: na pustej bazie usunąć constraint i kolumnę; na bazie z danymi
-- tylko po kopii (kolumna zawiera tekst od użytkowników).

ALTER TABLE guardian_households
  ADD COLUMN ended_reason TEXT CHECK (ended_reason IS NULL OR length(btrim(ended_reason)) BETWEEN 3 AND 500),
  ADD CONSTRAINT guardian_household_end_reason_with_end CHECK (ended_reason IS NULL OR ends_on IS NOT NULL);
