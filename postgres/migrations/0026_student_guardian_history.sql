-- Relacja opiekun–dziecko: strażnik i historia zgody na kontakt (#190).
--
-- student_guardians.contact_allowed decyduje o doborze adresatów kampanii
-- (computeSnapshot), ponownym sprawdzeniu zgody w workerze i e-mailu na liście
-- klasy. Do tej pory relację można było usunąć (także kaskadą z students /
-- guardians), a zmiana zgody nie zostawiała śladu.
--
-- Skutki dla danych:
-- * Istniejące wiersze student_guardians NIE są zmieniane ani usuwane.
--   Nowa tabela student_guardian_changes startuje pusta (nie ma danych, z których
--   dałoby się odtworzyć wcześniejsze zmiany; import tworzy relacje z
--   contact_allowed = false, D-03).
-- * Klucze obce student_guardians → students i → guardians zmieniają się
--   z ON DELETE CASCADE na domyślne NO ACTION. Usunięcie ucznia lub opiekuna,
--   który ma relację, kończy się teraz błędem klucza obcego zamiast cichego
--   usunięcia relacji. Aplikacja, import, odtworzenie snapshotu D1 i eksportu
--   niczego nie usuwają, więc nie zmienia to ich działania. Wcześniej takie
--   usunięcie i tak blokowały klucze obce z 0014 (student_households,
--   guardian_households, enrollment_history) dla większości wierszy.
-- * DELETE na student_guardians zwraca błąd student_guardians_cannot_be_deleted.
--   Relację kończy się ustawieniem ends_on (raz; potem data końca jest stała).
--   student_id, guardian_id i created_at są niezmienne.
-- * Każda zmiana contact_allowed, is_primary_contact, starts_on lub ends_on
--   zostawia wiersz w student_guardian_changes (poprzednia i nowa wartość,
--   powód, aktor, czas). Aktor i powód pochodzą z ustawień transakcji
--   (rd.actor_id, rd.change_reason) jak w 0014; zmiana bezpośrednim SQL trafia
--   do historii z source = 'direct' i bez aktora. UPDATE bez różnicy wartości
--   nie tworzy wpisu. Historii nie da się zmienić ani usunąć
--   (family_history_immutable z 0014).
-- * Tabela historii zawiera tylko identyfikatory i flagi, bez adresów e-mail
--   i nazwisk; retencja jak pozostała historia rodzin — decyzja D-04. Eksport
--   roczny (src/pg/export.js) jej nie obejmuje, tak jak guardian_contact_changes.
-- Wycofanie: na pustej bazie usunąć trigger, funkcje i tabelę oraz przywrócić
-- CASCADE; na bazie z danymi — tylko po kopii i decyzji o retencji (D-04).

ALTER TABLE student_guardians
  DROP CONSTRAINT student_guardians_student_id_fkey,
  DROP CONSTRAINT student_guardians_guardian_id_fkey,
  ADD CONSTRAINT student_guardians_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id),
  ADD CONSTRAINT student_guardians_guardian_id_fkey FOREIGN KEY (guardian_id) REFERENCES guardians(id);

CREATE FUNCTION student_guardian_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'student_guardians_cannot_be_deleted';
  END IF;
  IF NEW.student_id IS DISTINCT FROM OLD.student_id OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'student_guardian_identity_immutable';
  END IF;
  IF OLD.ends_on IS NOT NULL AND NEW.ends_on IS DISTINCT FROM OLD.ends_on THEN
    RAISE EXCEPTION 'student_guardian_already_ended';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER student_guardians_guard BEFORE UPDATE OR DELETE ON student_guardians
  FOR EACH ROW EXECUTE FUNCTION student_guardian_guard();

CREATE TABLE student_guardian_changes (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  guardian_id TEXT NOT NULL REFERENCES guardians(id),
  previous_contact_allowed BOOLEAN NOT NULL,
  new_contact_allowed BOOLEAN NOT NULL,
  previous_is_primary_contact BOOLEAN NOT NULL,
  new_is_primary_contact BOOLEAN NOT NULL,
  previous_starts_on DATE,
  new_starts_on DATE,
  previous_ends_on DATE,
  new_ends_on DATE,
  reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('api', 'direct')),
  changed_by TEXT REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX student_guardian_changes_relation_idx ON student_guardian_changes(student_id, guardian_id, changed_at);

CREATE FUNCTION student_guardian_record_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.contact_allowed IS DISTINCT FROM OLD.contact_allowed
     OR NEW.is_primary_contact IS DISTINCT FROM OLD.is_primary_contact
     OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
     OR NEW.ends_on IS DISTINCT FROM OLD.ends_on THEN
    INSERT INTO student_guardian_changes (
      id, student_id, guardian_id,
      previous_contact_allowed, new_contact_allowed,
      previous_is_primary_contact, new_is_primary_contact,
      previous_starts_on, new_starts_on, previous_ends_on, new_ends_on,
      reason, source, changed_by
    ) VALUES (
      gen_random_uuid()::text, NEW.student_id, NEW.guardian_id,
      OLD.contact_allowed, NEW.contact_allowed,
      OLD.is_primary_contact, NEW.is_primary_contact,
      OLD.starts_on, NEW.starts_on, OLD.ends_on, NEW.ends_on,
      rd_setting('rd.change_reason'),
      CASE WHEN rd_setting('rd.actor_id') IS NULL THEN 'direct' ELSE 'api' END,
      rd_setting('rd.actor_id')
    );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER student_guardians_history AFTER UPDATE ON student_guardians
  FOR EACH ROW EXECUTE FUNCTION student_guardian_record_history();

CREATE TRIGGER student_guardian_changes_no_change BEFORE UPDATE OR DELETE ON student_guardian_changes
  FOR EACH ROW EXECUTE FUNCTION family_history_immutable();
