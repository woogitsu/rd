-- Przydział klasy należy do roku tej klasy (#201, fragment #198).
--
-- Jedna reguła „przydział należy do roku Y”: school_year_id = Y albo klasa
-- przydziału jest klasą roku Y. Używają jej zamknięcie roku
-- (src/pg/routes/year-close.js), wygaszenie kadencji przez administratora
-- (src/pg/routes/admin.js, expire-grants) i trigger zamrożenia z 0017.
--
-- Skutki dla danych:
-- * Przydziały z class_id i school_year_id = NULL (np. skopiowane z D1,
--   wpisane skryptem lub przez createInvitation bez roku) dostają
--   school_year_id = rok klasy. Dotyczy to wierszy aktywnych, wygasłych
--   i cofniętych. Zakres faktyczny się nie zmienia (klasa należy do
--   dokładnie jednego roku), nic nie jest usuwane, expires_at i revoked_at
--   zostają bez zmian. Każdy uzupełniony wiersz dostaje zdarzenie audytu
--   role_grant.school_year_backfilled (actor_id = NULL, poprzednia wartość
--   NULL w metadanych, bez danych osobowych).
-- * Do uzupełnienia trigger role_grants_guard (0004) jest wyłączony tylko
--   na czas jednej instrukcji UPDATE w transakcji migracji. Nowe wiersze
--   i cofnięcie starych (propozycja z #201) nie wchodzą w grę: przydziału
--   cofniętego nie da się już zmienić, a cofnięcie wymaga aktora
--   (role_grant_revocation_actor), którego migracja nie ma.
-- * Nowe ograniczenie role_grant_class_requires_year: przydział z klasą
--   musi mieć rok. Nowy wiersz z class_id i bez roku dostaje rok klasy
--   w triggerze; wiersz z rokiem innym niż rok klasy jest odrzucany
--   (class_not_in_school_year).
-- * Istniejące wiersze z rokiem różnym od roku klasy (niespójne, możliwe
--   tylko przy wpisach poza API) zostają bez zmian; reguła „albo” wygasza
--   je przy zamknięciu któregokolwiek z tych dwóch lat.
-- * Trigger zamrożenia odrzuca także przydział klasy zamkniętego roku
--   wstawiany bez school_year_id (wcześniej przechodził).
-- * Przydziały bez klasy i bez roku (np. zarząd „bezterminowo”) zostają
--   poza zakresem, jak dotąd.

CREATE FUNCTION role_grant_in_school_year(p_class_id TEXT, p_school_year_id TEXT, p_year TEXT)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p_school_year_id = p_year, false)
      OR EXISTS (SELECT 1 FROM classes WHERE id = p_class_id AND school_year_id = p_year)
$$;

-- Zastępuje funkcję z 0017 (trigger a0_year_freeze uruchamia się pierwszy).
CREATE OR REPLACE FUNCTION role_grant_year_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE class_year TEXT;
BEGIN
  IF NEW.class_id IS NOT NULL THEN
    SELECT school_year_id INTO class_year FROM classes WHERE id = NEW.class_id;
    IF NEW.school_year_id IS NULL THEN
      NEW.school_year_id := class_year;
    ELSIF class_year IS NOT NULL AND class_year <> NEW.school_year_id THEN
      RAISE EXCEPTION 'class_not_in_school_year';
    END IF;
  END IF;
  PERFORM school_year_assert_open(NEW.school_year_id);
  RETURN NEW;
END $$;

ALTER TABLE role_grants DISABLE TRIGGER role_grants_guard;
WITH filled AS (
  UPDATE role_grants AS g SET school_year_id = c.school_year_id
    FROM classes c
   WHERE c.id = g.class_id AND g.school_year_id IS NULL
  RETURNING g.id, g.role, g.class_id, g.school_year_id
)
INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
SELECT gen_random_uuid()::text, NULL, 'role_grant.school_year_backfilled', 'role_grant', id,
       jsonb_build_object('role', role, 'classId', class_id, 'schoolYearId', school_year_id,
                          'previousSchoolYearId', NULL::text, 'migration', '0022_role_grant_class_year')
  FROM filled;
ALTER TABLE role_grants ENABLE TRIGGER role_grants_guard;

ALTER TABLE role_grants ADD CONSTRAINT role_grant_class_requires_year
  CHECK (class_id IS NULL OR school_year_id IS NOT NULL) NOT VALID;
ALTER TABLE role_grants VALIDATE CONSTRAINT role_grant_class_requires_year;
