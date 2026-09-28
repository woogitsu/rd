-- Odejście ze szkoły w trakcie roku: zakończenie przypisania do klasy zamiast
-- usuwania (#86). Dotyczy wyłącznie enrollments; zakończenie relacji
-- opiekun–dziecko i członkostwa w gospodarstwie pozostaje poza zakresem tej
-- migracji (patrz PR — „Część #86”).
--
-- Skutki dla danych:
-- * Dodaje enrollments.ended_on/ended_reason/ended_by/ended_at. Wszystkie
--   istniejące wiersze mają ended_on = NULL (bez zmian — nikt nie „odszedł”
--   wstecznie). Można ustawić raz; trigger enrollment_guard blokuje dalsze
--   zmiany wiersza po ustawieniu ended_on (łącznie ze zmianą klasy).
-- * enrollment_history dostaje nowy rodzaj zdarzenia 'withdrawn', zapisywany
--   automatycznie przy ustawieniu ended_on (from_class_id = to_class_id =
--   klasa w chwili odejścia; effective_on = ended_on; reason = ended_reason).
--   Historia pozostaje tylko do dopisywania.
-- * Nowy widok enrollments_current = przypisania bez ended_on lub z ended_on
--   w przyszłości (ended_on > CURRENT_DATE) — ta sama konwencja co
--   student_households_current/guardian_households_current (0014). Kod
--   odczytujący listę klasy, kartki, dobór adresatów kampanii i eksport listy
--   klasy używa odtąd enrollments_current; wpłaty i księga (płatności,
--   preliminarz) nadal wskazują enrollments/school_year_id bez zmian —
--   odejście nie tworzy ani nie usuwa żadnej należności.
-- Wycofanie: na pustej bazie usunąć obiekty tej migracji; na bazie z danymi
-- tylko po kopii zapasowej (kolumny są nullable, view i trigger można usunąć
-- bez utraty istniejących danych, o ile żaden wiersz nie ma już ended_on).

ALTER TABLE enrollments
  ADD COLUMN ended_on DATE,
  ADD COLUMN ended_reason TEXT CHECK (ended_reason IS NULL OR length(btrim(ended_reason)) BETWEEN 3 AND 500),
  ADD COLUMN ended_by TEXT REFERENCES users(id),
  ADD COLUMN ended_at TIMESTAMPTZ,
  ADD CONSTRAINT enrollments_ended_consistent CHECK ((ended_on IS NULL) = (ended_at IS NULL));

CREATE INDEX enrollments_ended_idx ON enrollments(school_year_id, ended_on);

-- Zastępuje funkcję z 0001_core.sql: dopisuje blokadę zmian po zakończeniu.
-- Istniejąca reguła niezmienności tożsamości (id/student_id/school_year_id)
-- zostaje bez zmian.
CREATE OR REPLACE FUNCTION enrollment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'enrollments_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id THEN
    RAISE EXCEPTION 'enrollment_identity_immutable';
  END IF;
  IF OLD.ended_on IS NOT NULL THEN
    RAISE EXCEPTION 'enrollment_already_ended';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE enrollment_history DROP CONSTRAINT enrollment_history_kind_check;
ALTER TABLE enrollment_history ADD CONSTRAINT enrollment_history_kind_check
  CHECK (kind IN ('enrolled', 'class_changed', 'withdrawn'));

-- Wpis historii zapisywany automatycznie, osobno od istniejącego triggera
-- enrollments_history (0014) — nie modyfikujemy go, żeby zminimalizować
-- konflikt z kolejką (origin/claude/determined-noether-95gpi9-queue).
CREATE FUNCTION enrollment_withdrawal_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO enrollment_history (
    id, enrollment_id, student_id, school_year_id, kind, from_class_id, to_class_id,
    effective_on, reason, source, changed_by
  ) VALUES (
    gen_random_uuid()::text, NEW.id, NEW.student_id, NEW.school_year_id,
    'withdrawn', NEW.class_id, NEW.class_id, NEW.ended_on, NEW.ended_reason,
    CASE WHEN NEW.ended_by IS NULL THEN 'direct' ELSE 'api' END, NEW.ended_by
  );
  RETURN NEW;
END $$;
CREATE TRIGGER enrollments_withdrawal_history AFTER UPDATE OF ended_on ON enrollments
  FOR EACH ROW WHEN (OLD.ended_on IS NULL AND NEW.ended_on IS NOT NULL)
  EXECUTE FUNCTION enrollment_withdrawal_history();

-- Bieżące przypisania (uczeń jeszcze w szkole/klasie dziś).
CREATE VIEW enrollments_current AS
SELECT * FROM enrollments WHERE ended_on IS NULL OR ended_on > CURRENT_DATE;
