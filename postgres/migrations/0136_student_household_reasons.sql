-- Powód zakończenia i dodania członkostwa ucznia w gospodarstwie (#86).
--
-- Trasy API z tego PR (POST /api/students/{id}/households oraz
-- .../households/{membershipId}/end) zapisują aktora (created_by/ended_by),
-- czas (ended_at) i datę (starts_on/ends_on), ale student_households nie miała
-- miejsca na powód zmiany. Ta migracja dodaje dwie kolumny tekstowe.
--
-- Skutki dla danych:
-- * Dodaje student_households.created_reason i ended_reason (nullable, 3–500
--   znaków po przycięciu). Istniejące wiersze mają NULL — nikt nie podał
--   powodu wstecznie. Żaden wiersz nie jest zmieniany ani usuwany.
-- * Kolumny są wolnym tekstem i mogą opisywać sytuację rodzinną (rozwód,
--   opieka naprzemienna) — wpis w privacy/data-inventory.json i w
--   docs/DPIA_CHECKLIST.md jak dla enrollments.ended_reason. Do
--   audit_events trafia wyłącznie identyfikator obiektu, bez powodu.
-- * student_household_check (najnowsza wersja: 0023) jest odtwarzana bez zmian
--   logiki, z jednym dodatkiem: created_reason jest niezmienne po utworzeniu
--   (jak pozostałe kolumny tożsamości). ended_reason ustawia się razem z
--   ends_on; po zakończeniu żadna zmiana wiersza nie jest możliwa
--   (student_household_already_ended). Korekta = nowe członkostwo.
-- * guardian_households nie zmienia się — zakończenie członkostwa opiekuna
--   w gospodarstwie nie ma jeszcze trasy (patrz opis PR, „Część #86”).
-- Wycofanie: na pustej bazie usunąć kolumny i przywrócić funkcję z 0023; na
-- bazie z danymi tylko po kopii (kolumny zawierają tekst od użytkowników).

ALTER TABLE student_households
  ADD COLUMN created_reason TEXT CHECK (created_reason IS NULL OR length(btrim(created_reason)) BETWEEN 3 AND 500),
  ADD COLUMN ended_reason TEXT CHECK (ended_reason IS NULL OR length(btrim(ended_reason)) BETWEEN 3 AND 500);

CREATE OR REPLACE FUNCTION student_household_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'student_households_cannot_be_deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.ends_on IS NOT NULL THEN
      RAISE EXCEPTION 'student_household_already_ended';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.student_id IS DISTINCT FROM OLD.student_id
       OR NEW.household_id IS DISTINCT FROM OLD.household_id OR NEW.is_primary IS DISTINCT FROM OLD.is_primary
       OR NEW.starts_on IS DISTINCT FROM OLD.starts_on OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_reason IS DISTINCT FROM OLD.created_reason THEN
      RAISE EXCEPTION 'student_household_immutable';
    END IF;
  END IF;
  -- Serializuje zmiany członkostw jednego ucznia (#194). Kolejne polecenie
  -- (EXISTS) bierze nową migawkę i widzi wiersze zatwierdzone w międzyczasie.
  PERFORM 1 FROM students WHERE id = NEW.student_id FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM student_households o
     WHERE o.student_id = NEW.student_id AND o.id <> NEW.id
       AND daterange(o.starts_on, o.ends_on, '[)') && daterange(NEW.starts_on, NEW.ends_on, '[)')
       AND (o.household_id = NEW.household_id OR (o.is_primary AND NEW.is_primary))
  ) THEN
    RAISE EXCEPTION 'student_household_overlap';
  END IF;
  RETURN NEW;
END $$;
