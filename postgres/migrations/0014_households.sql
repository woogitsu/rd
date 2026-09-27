-- Wiele gospodarstw ucznia, członkostwo opiekunów w gospodarstwach,
-- historia zmian kontaktu i historia przypisania do klasy (issue #5).
--
-- Skutki dla danych:
-- * Kolumny students.household_id i guardians.household_id (0001_core) zostają
--   bez zmian i nadal są NOT NULL — dla zgodności ze starszym kodem, importem
--   i odtwarzaniem snapshotu D1. students.household_id jest odtąd kopią
--   bieżącego głównego gospodarstwa (synchronizowaną triggerami w obie strony),
--   guardians.household_id — gospodarstwem z chwili utworzenia lub ostatniej
--   bezpośredniej zmiany tej kolumny.
-- * Istniejące wiersze są przepisywane do nowych tabel (backfill): każdy uczeń
--   dostaje jedno główne członkostwo w gospodarstwie z students.household_id,
--   każdy opiekun — członkostwo w gospodarstwie z guardians.household_id,
--   a każde przypisanie do klasy — wpis historii 'enrolled'. Żaden istniejący
--   wiersz nie jest zmieniany ani usuwany.
-- * Nowe tabele są tylko do dopisywania: członkostwo kończy się ustawieniem
--   ends_on (raz), korekta to nowy wiersz. Wpisów historii nie można zmienić
--   ani usunąć. Uczniów, opiekunów i przypisań do klas z historią nie da się
--   usunąć (klucze obce bez CASCADE).
-- * Aktor i powód zmiany są odczytywane z ustawień transakcji
--   (set_config('rd.actor_id' | 'rd.change_reason' | 'rd.effective_on', …, true)).
--   Zmiana bez tych ustawień (np. bezpośredni SQL) też trafia do historii,
--   z aktorem NULL i source = 'direct'.
-- * Jednostka ewidencji składki (rodzina czy dziecko) to otwarta decyzja D-11.
--   Migracja nie wiąże wpłat z nowymi tabelami; wpłaty nadal wskazują
--   payment_entries.household_id.
-- Wycofanie: na pustej bazie usunąć obiekty tej migracji; na bazie z danymi
-- tylko po kopii zapasowej i decyzji o retencji (D-04).

CREATE FUNCTION rd_setting(name TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting(name, true), '')
$$;

-- ---------------------------------------------------------------------------
-- Uczeń ↔ gospodarstwo
-- ---------------------------------------------------------------------------
-- starts_on włącznie, ends_on wyłącznie (przedział [starts_on, ends_on)).
-- starts_on NULL = od początku ewidencji.
CREATE TABLE student_households (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  starts_on DATE,
  ends_on DATE,
  source TEXT NOT NULL DEFAULT 'direct'
    CHECK (source IN ('legacy_backfill', 'student_insert', 'household_id_update', 'api', 'direct')),
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_by TEXT REFERENCES users(id),
  ended_at TIMESTAMPTZ,
  CONSTRAINT student_household_dates CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT student_household_end_consistent CHECK ((ends_on IS NULL) = (ended_at IS NULL))
);
CREATE INDEX student_households_student_idx ON student_households(student_id, ends_on);
CREATE INDEX student_households_household_idx ON student_households(household_id, ends_on);
-- Serializuje równoległe wstawienia: najwyżej jedno otwarte główne gospodarstwo.
CREATE UNIQUE INDEX student_households_one_open_primary
  ON student_households(student_id) WHERE is_primary AND ends_on IS NULL;

CREATE FUNCTION student_household_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'student_household_immutable';
    END IF;
  END IF;
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
CREATE TRIGGER student_households_check BEFORE INSERT OR UPDATE OR DELETE ON student_households
  FOR EACH ROW EXECUTE FUNCTION student_household_check();

-- ---------------------------------------------------------------------------
-- Opiekun ↔ gospodarstwo (bez „głównego” — opiekun może należeć do kilku).
-- ---------------------------------------------------------------------------
CREATE TABLE guardian_households (
  id TEXT PRIMARY KEY,
  guardian_id TEXT NOT NULL REFERENCES guardians(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  starts_on DATE,
  ends_on DATE,
  source TEXT NOT NULL DEFAULT 'direct'
    CHECK (source IN ('legacy_backfill', 'guardian_insert', 'household_id_update', 'api', 'direct')),
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_by TEXT REFERENCES users(id),
  ended_at TIMESTAMPTZ,
  CONSTRAINT guardian_household_dates CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT guardian_household_end_consistent CHECK ((ends_on IS NULL) = (ended_at IS NULL))
);
CREATE INDEX guardian_households_guardian_idx ON guardian_households(guardian_id, ends_on);
CREATE INDEX guardian_households_household_idx ON guardian_households(household_id, ends_on);
CREATE UNIQUE INDEX guardian_households_one_open
  ON guardian_households(guardian_id, household_id) WHERE ends_on IS NULL;

CREATE FUNCTION guardian_household_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guardian_households_cannot_be_deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.ends_on IS NOT NULL THEN
      RAISE EXCEPTION 'guardian_household_already_ended';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
       OR NEW.household_id IS DISTINCT FROM OLD.household_id OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
       OR NEW.source IS DISTINCT FROM OLD.source OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'guardian_household_immutable';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM guardian_households o
     WHERE o.guardian_id = NEW.guardian_id AND o.household_id = NEW.household_id AND o.id <> NEW.id
       AND daterange(o.starts_on, o.ends_on, '[)') && daterange(NEW.starts_on, NEW.ends_on, '[)')
  ) THEN
    RAISE EXCEPTION 'guardian_household_overlap';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guardian_households_check BEFORE INSERT OR UPDATE OR DELETE ON guardian_households
  FOR EACH ROW EXECUTE FUNCTION guardian_household_check();

-- Backfill z kolumn zgodności.
INSERT INTO student_households (id, student_id, household_id, is_primary, source)
SELECT 'sh-legacy-' || s.id, s.id, s.household_id, true, 'legacy_backfill' FROM students s;
INSERT INTO guardian_households (id, guardian_id, household_id, source)
SELECT 'gh-legacy-' || g.id, g.id, g.household_id, 'legacy_backfill' FROM guardians g;

-- ---------------------------------------------------------------------------
-- Synchronizacja z kolumnami zgodności
-- ---------------------------------------------------------------------------
CREATE FUNCTION student_household_from_student() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_primary TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM student_households WHERE student_id = NEW.id AND is_primary AND ends_on IS NULL) THEN
      INSERT INTO student_households (id, student_id, household_id, is_primary, source, created_by)
      VALUES (gen_random_uuid()::text, NEW.id, NEW.household_id, true, 'student_insert', rd_setting('rd.actor_id'));
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.household_id IS NOT DISTINCT FROM OLD.household_id THEN RETURN NEW; END IF;
  SELECT household_id INTO current_primary FROM student_households
   WHERE student_id = NEW.id AND is_primary AND ends_on IS NULL;
  IF current_primary IS NOT DISTINCT FROM NEW.household_id THEN RETURN NEW; END IF;
  -- Bezpośrednia zmiana students.household_id: zamknij bieżące główne
  -- członkostwo (i ewentualne otwarte członkostwo w nowym gospodarstwie)
  -- i otwórz nowe główne od dziś.
  UPDATE student_households
     SET ends_on = GREATEST(CURRENT_DATE, COALESCE(starts_on, CURRENT_DATE)), ended_at = now(), ended_by = rd_setting('rd.actor_id')
   WHERE student_id = NEW.id AND ends_on IS NULL AND (is_primary OR household_id = NEW.household_id);
  INSERT INTO student_households (id, student_id, household_id, is_primary, starts_on, source, created_by)
  VALUES (gen_random_uuid()::text, NEW.id, NEW.household_id, true, CURRENT_DATE, 'household_id_update', rd_setting('rd.actor_id'));
  RETURN NEW;
END $$;
CREATE TRIGGER students_household_sync AFTER INSERT OR UPDATE OF household_id ON students
  FOR EACH ROW EXECUTE FUNCTION student_household_from_student();

-- Nowe otwarte główne członkostwo (już obowiązujące) aktualizuje kolumnę zgodności.
CREATE FUNCTION student_from_student_household() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_primary AND NEW.ends_on IS NULL AND (NEW.starts_on IS NULL OR NEW.starts_on <= CURRENT_DATE) THEN
    UPDATE students SET household_id = NEW.household_id
     WHERE id = NEW.student_id AND household_id IS DISTINCT FROM NEW.household_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER student_households_sync AFTER INSERT ON student_households
  FOR EACH ROW EXECUTE FUNCTION student_from_student_household();

CREATE FUNCTION guardian_household_from_guardian() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.household_id IS NOT DISTINCT FROM OLD.household_id THEN RETURN NEW; END IF;
    UPDATE guardian_households
       SET ends_on = GREATEST(CURRENT_DATE, COALESCE(starts_on, CURRENT_DATE)), ended_at = now(), ended_by = rd_setting('rd.actor_id')
     WHERE guardian_id = NEW.id AND household_id = OLD.household_id AND ends_on IS NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM guardian_households WHERE guardian_id = NEW.id AND household_id = NEW.household_id AND ends_on IS NULL) THEN
    INSERT INTO guardian_households (id, guardian_id, household_id, starts_on, source, created_by)
    VALUES (gen_random_uuid()::text, NEW.id, NEW.household_id,
            CASE WHEN TG_OP = 'UPDATE' THEN CURRENT_DATE END,
            CASE WHEN TG_OP = 'UPDATE' THEN 'household_id_update' ELSE 'guardian_insert' END,
            rd_setting('rd.actor_id'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guardians_household_sync AFTER INSERT OR UPDATE OF household_id ON guardians
  FOR EACH ROW EXECUTE FUNCTION guardian_household_from_guardian();

-- ---------------------------------------------------------------------------
-- Historia zmian kontaktu opiekuna
-- ---------------------------------------------------------------------------
-- Zawiera dane osobowe (poprzedni i nowy e-mail) — jak tabela guardians.
-- Retencja wymaga decyzji D-04. Do audit_events trafia tylko identyfikator.
CREATE TABLE guardian_contact_changes (
  id TEXT PRIMARY KEY,
  guardian_id TEXT NOT NULL REFERENCES guardians(id),
  previous_email TEXT,
  new_email TEXT,
  previous_contact_allowed BOOLEAN NOT NULL,
  new_contact_allowed BOOLEAN NOT NULL,
  reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('api', 'direct')),
  changed_by TEXT REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guardian_contact_changes_guardian_idx ON guardian_contact_changes(guardian_id, changed_at);

CREATE FUNCTION guardian_contact_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email OR NEW.contact_allowed IS DISTINCT FROM OLD.contact_allowed THEN
    INSERT INTO guardian_contact_changes (
      id, guardian_id, previous_email, new_email, previous_contact_allowed, new_contact_allowed,
      reason, source, changed_by
    ) VALUES (
      gen_random_uuid()::text, NEW.id, OLD.email, NEW.email, OLD.contact_allowed, NEW.contact_allowed,
      rd_setting('rd.change_reason'),
      CASE WHEN rd_setting('rd.actor_id') IS NULL THEN 'direct' ELSE 'api' END,
      rd_setting('rd.actor_id')
    );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guardians_contact_history AFTER UPDATE OF email, contact_allowed ON guardians
  FOR EACH ROW EXECUTE FUNCTION guardian_contact_history();

-- ---------------------------------------------------------------------------
-- Historia przypisania do klasy
-- ---------------------------------------------------------------------------
-- enrollments nadal ma jeden wiersz na ucznia i rok (UNIQUE z 0001_core) —
-- to stan bieżący. Każde utworzenie i każda zmiana klasy zostawia wpis tutaj.
CREATE TABLE enrollment_history (
  id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  kind TEXT NOT NULL CHECK (kind IN ('enrolled', 'class_changed')),
  from_class_id TEXT REFERENCES classes(id),
  to_class_id TEXT NOT NULL REFERENCES classes(id),
  effective_on DATE,
  reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('legacy_backfill', 'api', 'direct')),
  changed_by TEXT REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enrollment_history_kind_from CHECK ((kind = 'enrolled') = (from_class_id IS NULL))
);
CREATE INDEX enrollment_history_student_idx ON enrollment_history(student_id, school_year_id, changed_at);

INSERT INTO enrollment_history (id, enrollment_id, student_id, school_year_id, kind, to_class_id, source)
SELECT 'eh-legacy-' || e.id, e.id, e.student_id, e.school_year_id, 'enrolled', e.class_id, 'legacy_backfill'
  FROM enrollments e;

CREATE FUNCTION enrollment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'enrollments_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id THEN
    RAISE EXCEPTION 'enrollment_identity_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enrollments_guard BEFORE UPDATE OR DELETE ON enrollments
  FOR EACH ROW EXECUTE FUNCTION enrollment_guard();

CREATE FUNCTION enrollment_record_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.class_id IS NOT DISTINCT FROM OLD.class_id THEN RETURN NEW; END IF;
  INSERT INTO enrollment_history (
    id, enrollment_id, student_id, school_year_id, kind, from_class_id, to_class_id,
    effective_on, reason, source, changed_by
  ) VALUES (
    gen_random_uuid()::text, NEW.id, NEW.student_id, NEW.school_year_id,
    CASE WHEN TG_OP = 'INSERT' THEN 'enrolled' ELSE 'class_changed' END,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.class_id END,
    NEW.class_id,
    rd_setting('rd.effective_on')::date,
    rd_setting('rd.change_reason'),
    CASE WHEN rd_setting('rd.actor_id') IS NULL THEN 'direct' ELSE 'api' END,
    rd_setting('rd.actor_id')
  );
  RETURN NEW;
END $$;
CREATE TRIGGER enrollments_history AFTER INSERT OR UPDATE OF class_id ON enrollments
  FOR EACH ROW EXECUTE FUNCTION enrollment_record_history();

-- Historia jest tylko do dopisywania.
CREATE FUNCTION family_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'family_history_is_append_only';
END $$;
CREATE TRIGGER guardian_contact_changes_no_change BEFORE UPDATE OR DELETE ON guardian_contact_changes
  FOR EACH ROW EXECUTE FUNCTION family_history_immutable();
CREATE TRIGGER enrollment_history_no_change BEFORE UPDATE OR DELETE ON enrollment_history
  FOR EACH ROW EXECUTE FUNCTION family_history_immutable();

-- Bieżące członkostwa (obowiązujące dziś).
CREATE VIEW student_households_current AS
SELECT * FROM student_households
 WHERE (starts_on IS NULL OR starts_on <= CURRENT_DATE)
   AND (ends_on IS NULL OR ends_on > CURRENT_DATE);
CREATE VIEW guardian_households_current AS
SELECT * FROM guardian_households
 WHERE (starts_on IS NULL OR starts_on <= CURRENT_DATE)
   AND (ends_on IS NULL OR ends_on > CURRENT_DATE);
