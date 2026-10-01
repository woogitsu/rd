-- Sprostowanie imienia i nazwiska ucznia i opiekuna z historią (#100, art. 16
-- RODO). Prototyp — nie jest wdrożony i nie jest gotowy do pracy na danych
-- rodzin. Zasady wariantem zachowawczym do decyzji D-03/D-04/D-07.
--
-- Problem: imię i nazwisko ucznia (students) i opiekuna (guardians) dało się
-- zmienić wyłącznie bezpośrednim UPDATE — bez trasy w API, bez powodu, bez
-- aktora i bez śladu poprzedniej wartości. Dla kontaktu opiekuna historia
-- istnieje (guardian_contact_changes, 0014), dla tożsamości nie.
--
-- Zmiany:
-- 1. `identity_changes` — jedna tabela dopisywana (append-only) dla obu
--    podmiotów (`subject_type` = student | guardian; dokładnie jeden z
--    `student_id` / `guardian_id`): poprzednie i nowe imię oraz nazwisko,
--    powód (3–500 znaków; przechodzi bramkę danych osobowych w API, a kolumna
--    jest nullable, żeby anonimizacja mogła ją wyzerować), `source` (`api` gdy
--    ustawiono rd.actor_id, inaczej `direct`), aktor (`changed_by`), czas z
--    zegara bazy (`changed_at`, a0_stamp_created_now) i opcjonalne
--    `data_request_id` z rejestru żądań osób (data_subject_requests, #100).
-- 2. Triggery historii `students_identity_history` / `guardians_identity_history`
--    (AFTER UPDATE OF first_name, last_name) — wzorem guardians_contact_history:
--    aktor, powód i identyfikator żądania pochodzą z set_config
--    rd.actor_id / rd.change_reason / rd.data_request_id ustawianych przez
--    trasę. Wpis powstaje tylko, gdy imię lub nazwisko faktycznie się zmienia;
--    w kontekście przebiegu anonimizacji (0174) wpisu nie tworzy (kopiowałby
--    stare imię do nowego wiersza).
-- 3. Niezmienność: `identity_changes_no_change` odrzuca UPDATE i DELETE, a
--    BEFORE TRUNCATE (`identity_changes_no_truncate`, deny_truncate() z 0095)
--    odrzuca TRUNCATE. Jedyna furtka: UPDATE w kontekście przebiegu anonimizacji
--    (rd.anonymization_run), który zmienia WYŁĄCZNIE imiona/nazwiska na wartość
--    zastępczą '[zanonimizowano]' i powód na NULL (te same wartości co
--    src/pg/anonymization.js); aktor, czas, podmiot i żądanie zostają. Funkcja
--    rd_anonymization_update_allowed (0174) nie jest zmieniana — tabela ma
--    własnego strażnika, dzięki czemu nie redefiniujemy współdzielonej funkcji.
--
-- Skutki dla istniejących danych: tylko nowa tabela, funkcje i triggery; żaden
-- istniejący wiersz nie jest zmieniany. Historia zaczyna się od wdrożenia
-- migracji — wcześniejsze zmiany imion nie są odtwarzalne. Od tej chwili także
-- bezpośredni UPDATE imienia/nazwiska (np. import) zostawia wpis z
-- `source = 'direct'` i bez aktora; to zamierzone (ślad zamiast milczącej
-- zmiany). Tabela zawiera dane osobowe (imiona i nazwiska — poprzednie i nowe):
-- retencja wymaga decyzji D-04, do audit_events trafiają wyłącznie
-- identyfikatory i nazwy pól (nigdy imiona).
--
-- Wycofanie: DROP TRIGGER students_identity_history ON students; DROP TRIGGER
-- guardians_identity_history ON guardians; DROP FUNCTION student_identity_history(),
-- guardian_identity_history(), identity_changes_immutable(); DROP TABLE
-- identity_changes (na bazie z wpisami wyłącznie po kopii zapasowej — wiersze
-- są jedynym dowodem poprzednich wartości).

CREATE TABLE identity_changes (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('student', 'guardian')),
  student_id TEXT REFERENCES students(id),
  guardian_id TEXT REFERENCES guardians(id),
  previous_first_name TEXT NOT NULL,
  previous_last_name TEXT NOT NULL,
  new_first_name TEXT NOT NULL,
  new_last_name TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 500),
  source TEXT NOT NULL CHECK (source IN ('api', 'direct')),
  changed_by TEXT REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data_request_id TEXT REFERENCES data_subject_requests(id),
  CONSTRAINT identity_changes_subject_shape CHECK (
    (subject_type = 'student' AND student_id IS NOT NULL AND guardian_id IS NULL)
    OR (subject_type = 'guardian' AND guardian_id IS NOT NULL AND student_id IS NULL)
  )
);
CREATE INDEX identity_changes_student_idx ON identity_changes(student_id, changed_at) WHERE student_id IS NOT NULL;
CREATE INDEX identity_changes_guardian_idx ON identity_changes(guardian_id, changed_at) WHERE guardian_id IS NOT NULL;
CREATE INDEX identity_changes_request_idx ON identity_changes(data_request_id) WHERE data_request_id IS NOT NULL;

CREATE FUNCTION student_identity_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF rd_anonymization_active() THEN
    RETURN NEW;
  END IF;
  IF NEW.first_name IS DISTINCT FROM OLD.first_name OR NEW.last_name IS DISTINCT FROM OLD.last_name THEN
    INSERT INTO identity_changes (
      id, subject_type, student_id, previous_first_name, previous_last_name, new_first_name, new_last_name,
      reason, source, changed_by, data_request_id
    ) VALUES (
      gen_random_uuid()::text, 'student', NEW.id, OLD.first_name, OLD.last_name, NEW.first_name, NEW.last_name,
      rd_setting('rd.change_reason'),
      CASE WHEN rd_setting('rd.actor_id') IS NULL THEN 'direct' ELSE 'api' END,
      rd_setting('rd.actor_id'), rd_setting('rd.data_request_id')
    );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER students_identity_history AFTER UPDATE OF first_name, last_name ON students
  FOR EACH ROW EXECUTE FUNCTION student_identity_history();

CREATE FUNCTION guardian_identity_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF rd_anonymization_active() THEN
    RETURN NEW;
  END IF;
  IF NEW.first_name IS DISTINCT FROM OLD.first_name OR NEW.last_name IS DISTINCT FROM OLD.last_name THEN
    INSERT INTO identity_changes (
      id, subject_type, guardian_id, previous_first_name, previous_last_name, new_first_name, new_last_name,
      reason, source, changed_by, data_request_id
    ) VALUES (
      gen_random_uuid()::text, 'guardian', NEW.id, OLD.first_name, OLD.last_name, NEW.first_name, NEW.last_name,
      rd_setting('rd.change_reason'),
      CASE WHEN rd_setting('rd.actor_id') IS NULL THEN 'direct' ELSE 'api' END,
      rd_setting('rd.actor_id'), rd_setting('rd.data_request_id')
    );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guardians_identity_history AFTER UPDATE OF first_name, last_name ON guardians
  FOR EACH ROW EXECUTE FUNCTION guardian_identity_history();

-- Historia jest tylko do dopisywania; wyjątek: przebieg anonimizacji (patrz nagłówek).
CREATE FUNCTION identity_changes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  anonymized_columns TEXT[] := ARRAY['previous_first_name', 'previous_last_name', 'new_first_name', 'new_last_name', 'reason'];
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_active()
     AND (to_jsonb(NEW) - anonymized_columns) = (to_jsonb(OLD) - anonymized_columns)
     AND NEW.previous_first_name = '[zanonimizowano]' AND NEW.previous_last_name = '[zanonimizowano]'
     AND NEW.new_first_name = '[zanonimizowano]' AND NEW.new_last_name = '[zanonimizowano]'
     AND NEW.reason IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'identity_changes_is_append_only';
END $$;
CREATE TRIGGER identity_changes_no_change BEFORE UPDATE OR DELETE ON identity_changes
  FOR EACH ROW EXECUTE FUNCTION identity_changes_immutable();
CREATE TRIGGER identity_changes_no_truncate BEFORE TRUNCATE ON identity_changes
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();
CREATE TRIGGER a0_stamp_created_now BEFORE INSERT ON identity_changes
  FOR EACH ROW EXECUTE FUNCTION stamp_created_now('changed_at');
