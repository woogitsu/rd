-- Bieżące główne gospodarstwo ucznia z student_households zamiast kolumny
-- zgodności students.household_id; jedna definicja „dziś”; serializacja
-- sprawdzania nakładania zakresów (issue #194, por. #157).
--
-- Skutki dla danych:
-- * Żaden wiersz nie jest zmieniany, dodawany ani usuwany. Kolumny
--   students.household_id i guardians.household_id zostają (NOT NULL, import,
--   odtwarzanie snapshotu D1), ale nie służą już decyzjom o kontakcie,
--   kartkach ani imporcie. Mogą być nieaktualne: członkostwo z datą przyszłą
--   (starts_on > dziś) nie aktualizuje kolumny, gdy data nadejdzie, a
--   zakończenie głównego członkostwa bez następcy zostawia w kolumnie stare
--   gospodarstwo.
-- * rd_today() = dzisiejsza data w strefie Europe/Brussels, niezależnie od
--   TimeZone sesji PostgreSQL (na Railway zwykle UTC). Wcześniej widoki
--   *_current i triggery synchronizacji z 0014 używały CURRENT_DATE, czyli
--   daty w strefie sesji. Różnica dotyczy tylko okna 22:00/23:00–24:00 UTC:
--   wtedy „dziś” jest już datą następnego dnia w Brukseli. Widoki
--   student_households_current i guardian_households_current oraz funkcje
--   triggerów synchronizacji są odtwarzane z rd_today() (te same kolumny,
--   ta sama logika). Karta gospodarstwa (families.js) czyta te widoki, więc
--   też przechodzi na datę brukselską bez zmiany kodu.
-- * student_primary_household_on(d) zwraca główne gospodarstwo obowiązujące
--   w dniu d (najwyżej jedno na ucznia — zakresy głównych członkostw nie
--   mogą się nakładać, zob. student_household_check). Uczeń bez głównego
--   członkostwa obowiązującego w dniu d nie ma wiersza — nie trafia do
--   kampanii ani na kartki (wariant zachowawczy do D-11).
--   Widok student_primary_household_current = student_primary_household_on(rd_today()).
-- * Opieka naprzemienna (dwa obowiązujące członkostwa, jedno główne):
--   kampanie i kartki biorą wyłącznie główne gospodarstwo (założenie do
--   D-11/D-17 — jedna wiadomość i jedna kartka na dziecko); karta
--   gospodarstwa nadal pokazuje oba.
-- * Sprawdzanie nakładania zakresów (student_household_check,
--   guardian_household_check) blokuje najpierw wiersz ucznia/opiekuna
--   (SELECT … FOR NO KEY UPDATE). Dwie równoległe transakcje zmieniające
--   członkostwa tego samego ucznia wykonują się po kolei; druga widzi
--   zatwierdzony wiersz pierwszej i dostaje student_household_overlap.
--   Nie użyto EXCLUDE USING gist: wymaga rozszerzenia btree_gist
--   (CREATE EXTENSION z uprawnieniami właściciela bazy na Railway oraz
--   jawnego ładowania w każdym PGlite testów), a istniejące dane musiałyby
--   być wolne od nakładań już w chwili migracji. Blokada działa na poziomie
--   izolacji READ COMMITTED (domyślny w aplikacji); w REPEATABLE READ druga
--   transakcja nie zobaczy wiersza pierwszej. FOR NO KEY UPDATE nie koliduje
--   z FOR KEY SHARE, więc nie blokuje wstawiania zapisów do klas ani relacji
--   opiekun–dziecko odwołujących się do ucznia.
-- Wycofanie: odtworzyć widoki i funkcje z 0014 (CURRENT_DATE, bez blokady)
-- i usunąć rd_today(), student_primary_household_on() oraz widok
-- student_primary_household_current. Dane nie wymagają zmian.

CREATE FUNCTION rd_today() RETURNS DATE LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Europe/Brussels')::date
$$;

CREATE FUNCTION student_primary_household_on(on_date DATE)
RETURNS TABLE (student_id TEXT, household_id TEXT, membership_id TEXT, starts_on DATE, ends_on DATE)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (sh.student_id) sh.student_id, sh.household_id, sh.id, sh.starts_on, sh.ends_on
    FROM student_households sh
   WHERE sh.is_primary
     AND (sh.starts_on IS NULL OR sh.starts_on <= on_date)
     AND (sh.ends_on IS NULL OR sh.ends_on > on_date)
   ORDER BY sh.student_id, sh.starts_on DESC NULLS LAST, sh.id
$$;

CREATE VIEW student_primary_household_current AS
SELECT * FROM student_primary_household_on(rd_today());

CREATE OR REPLACE VIEW student_households_current AS
SELECT * FROM student_households
 WHERE (starts_on IS NULL OR starts_on <= rd_today())
   AND (ends_on IS NULL OR ends_on > rd_today());
CREATE OR REPLACE VIEW guardian_households_current AS
SELECT * FROM guardian_households
 WHERE (starts_on IS NULL OR starts_on <= rd_today())
   AND (ends_on IS NULL OR ends_on > rd_today());

-- ---------------------------------------------------------------------------
-- Sprawdzanie nakładania z blokadą wiersza ucznia / opiekuna.
-- ---------------------------------------------------------------------------
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
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
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

CREATE OR REPLACE FUNCTION guardian_household_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
  PERFORM 1 FROM guardians WHERE id = NEW.guardian_id FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM guardian_households o
     WHERE o.guardian_id = NEW.guardian_id AND o.household_id = NEW.household_id AND o.id <> NEW.id
       AND daterange(o.starts_on, o.ends_on, '[)') && daterange(NEW.starts_on, NEW.ends_on, '[)')
  ) THEN
    RAISE EXCEPTION 'guardian_household_overlap';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Synchronizacja z kolumnami zgodności: logika bez zmian, „dziś” = rd_today().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION student_household_from_student() RETURNS trigger LANGUAGE plpgsql AS $$
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
  UPDATE student_households
     SET ends_on = GREATEST(rd_today(), COALESCE(starts_on, rd_today())), ended_at = now(), ended_by = rd_setting('rd.actor_id')
   WHERE student_id = NEW.id AND ends_on IS NULL AND (is_primary OR household_id = NEW.household_id);
  INSERT INTO student_households (id, student_id, household_id, is_primary, starts_on, source, created_by)
  VALUES (gen_random_uuid()::text, NEW.id, NEW.household_id, true, rd_today(), 'household_id_update', rd_setting('rd.actor_id'));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION student_from_student_household() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_primary AND NEW.ends_on IS NULL AND (NEW.starts_on IS NULL OR NEW.starts_on <= rd_today()) THEN
    UPDATE students SET household_id = NEW.household_id
     WHERE id = NEW.student_id AND household_id IS DISTINCT FROM NEW.household_id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guardian_household_from_guardian() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.household_id IS NOT DISTINCT FROM OLD.household_id THEN RETURN NEW; END IF;
    UPDATE guardian_households
       SET ends_on = GREATEST(rd_today(), COALESCE(starts_on, rd_today())), ended_at = now(), ended_by = rd_setting('rd.actor_id')
     WHERE guardian_id = NEW.id AND household_id = OLD.household_id AND ends_on IS NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM guardian_households WHERE guardian_id = NEW.id AND household_id = NEW.household_id AND ends_on IS NULL) THEN
    INSERT INTO guardian_households (id, guardian_id, household_id, starts_on, source, created_by)
    VALUES (gen_random_uuid()::text, NEW.id, NEW.household_id,
            CASE WHEN TG_OP = 'UPDATE' THEN rd_today() END,
            CASE WHEN TG_OP = 'UPDATE' THEN 'household_id_update' ELSE 'guardian_insert' END,
            rd_setting('rd.actor_id'));
  END IF;
  RETURN NEW;
END $$;
