-- Issue #205 (część): identyfikator konta (user_id) w liście obecności zebrania
-- nie był sprawdzany względem zakresu zebrania. Konto bez przydziału w roku
-- zebrania dawało 200, a nieistniejące 400 invalid_reference — odpowiedź była
-- wyrocznią istnienia kont w całej szkole.
--
-- Zmiana (wyłącznie funkcja triggera meeting_attendees_guard, CREATE OR REPLACE
-- od NAJNOWSZEJ wersji, czyli z 0037; trigger z 0009 dalej jej używa):
-- 1. user_id przy wstawieniu wiersza musi mieć w chwili zapisu aktywny przydział
--    (role_grants: niecofnięty, niewygasły) obowiązujący w roku zebrania
--    (school_year_id NULL = wszystkie lata albo równy rokowi zebrania), a dla
--    zebrania klasowego bez zawężenia do innej klasy (class_id NULL albo klasa
--    zebrania). W przeciwnym razie RAISE EXCEPTION 'invalid_reference' — ten
--    sam kod co dla nieistniejącego konta (FK), sprawdzany przed zapisem.
-- 2. Sprawdzenia zakresu (user_id i dotychczasowe guardian_id z capacity
--    'guardian') wykonują się przy INSERT oraz przy UPDATE tylko wtedy, gdy
--    capacity zmienia się NA 'guardian' (inaczej zmiana 'guest' -> 'guardian'
--    omijałaby kontrolę). Odniesienie do osoby jest niezmienne
--    (meeting_attendee_reference_immutable), więc zakres sprawdzony przy
--    wstawieniu nie musi być sprawdzany ponownie przy korekcie. Skutek: poprawka
--    obecności (upsert) osoby, której relacja albo przydział zakończyły się
--    PO zapisaniu obecności, nie jest już odrzucana (0037 odrzucała ją
--    zachowawczo). Korekta nadal zapisuje się jako aktualizacja z audytem
--    meeting.attendance.corrected; brak zatarcia historii.
--
-- SKUTKI DLA DANYCH: brak zmian w istniejących wierszach ani ich usunięć.
-- Istniejące wiersze meeting_attendees z user_id bez przydziału w roku zebrania
-- (goście, nauczyciele, dyrekcja zaproszeni na zebranie) zostają nietknięte i
-- nadal liczą się w quorum, ale NOWYCH takich wpisów nie da się już zapisać.
--
-- WARIANT ZACHOWAWCZY DO D-19 (kto ma prawo głosu i kto może być gościem
-- zebrania): gość bez konta z przydziałem nie może być dziś wpisany w liście
-- obecności przez userId; potrzebny będzie osobny wariant (wpis bez odniesienia
-- i bez prawa głosu) po decyzji Rady. Nie rozstrzygamy tego migracją.
--
-- Wycofanie: przywrócić funkcję z 0037 (bez sprawdzania user_id i z
-- sprawdzaniem guardian_id także przy UPDATE). Dane nie wymagają zmian.

CREATE OR REPLACE FUNCTION meeting_attendee_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m meetings%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'meeting_attendees_cannot_be_deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.meeting_id, NEW.user_id, NEW.guardian_id)
       IS DISTINCT FROM ROW(OLD.id, OLD.meeting_id, OLD.user_id, OLD.guardian_id) THEN
      RAISE EXCEPTION 'meeting_attendee_reference_immutable';
    END IF;
    NEW.updated_at := now();
  END IF;
  PERFORM meeting_assert_editable(NEW.meeting_id);

  SELECT * INTO m FROM meetings WHERE id = NEW.meeting_id;

  -- Opiekun obecny w roli 'guardian' (głos rodzica): aktywna relacja z uczniem
  -- zapisanym w klasie zebrania (klasowe) albo w dowolnej klasie roku (pozostałe).
  IF NEW.guardian_id IS NOT NULL AND NEW.capacity = 'guardian'
     AND (TG_OP = 'INSERT' OR OLD.capacity IS DISTINCT FROM 'guardian')
     AND NOT EXISTS (
    SELECT 1 FROM student_guardians sg
      JOIN enrollments e ON e.student_id = sg.student_id
     WHERE sg.guardian_id = NEW.guardian_id
       AND e.school_year_id = m.school_year_id
       AND (m.class_id IS NULL OR e.class_id = m.class_id)
       AND (sg.starts_on IS NULL OR sg.starts_on <= rd_today())
       AND (sg.ends_on IS NULL OR sg.ends_on > rd_today())
  ) THEN
    RAISE EXCEPTION 'invalid_reference';
  END IF;

  -- Konto: aktywny przydział w roku zebrania (i klasie zebrania klasowego).
  IF NEW.user_id IS NOT NULL AND TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM role_grants g
     WHERE g.user_id = NEW.user_id
       AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > now())
       AND (g.school_year_id IS NULL OR g.school_year_id = m.school_year_id)
       AND (m.class_id IS NULL OR g.class_id IS NULL OR g.class_id = m.class_id)
  ) THEN
    RAISE EXCEPTION 'invalid_reference';
  END IF;

  RETURN NEW;
END;
$$;
