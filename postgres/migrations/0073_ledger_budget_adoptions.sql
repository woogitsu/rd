-- Preliminarz przez API: kategorie, wersje linii, przyjęcie przez Radę i
-- zestawienie plan vs wykonanie (#107).
--
-- Co zmienia:
-- * ledger_categories.idempotency_key (NULL, UNIQUE): klucz żądania
--   POST /api/ledger/categories. Istniejące kategorie mają NULL.
-- * ledger_category_deactivations (tylko dopisywanie): kto, kiedy i dlaczego
--   wyłączył kategorię. Samo wyłączenie to istniejąca kolumna
--   ledger_categories.active (0003 pozwala zmienić tylko ją); trigger
--   ledger_category_deactivation_guard pilnuje, że wpis historii powstaje
--   wyłącznie dla aktywnej kategorii i sam ją wyłącza w tej samej transakcji.
--   Ponowne włączenie kategorii nie jest przewidziane (nowa kategoria).
-- * ledger_budget_adoptions + ledger_budget_adoption_lines (tylko
--   dopisywanie): „zamrożona fotografia” preliminarza przyjętego przez
--   zebranie — zestaw bieżących wersji linii w chwili przyjęcia, opcjonalnie
--   z uchwałą (resolutions, bieżąca rewizja, przyjęta, z zebrania ogólnego tego
--   samego roku). Wersjonowane linie ledger_budget_lines się nie zmieniają.
-- * Wszystkie nowe tabele mają school_year_id i trigger a0_year_freeze
--   (year_freeze_direct z 0017), więc zamknięty rok odrzuca zapis bez zmiany
--   year_freeze_via_parent.
--
-- Skutki dla istniejących danych: żaden wiersz nie jest zmieniany ani
-- usuwany. Istniejące linie preliminarza nie mają przyjęcia (zestawienie
-- pokazuje „plan przyjęty” jako brak), istniejące wyłączone kategorie nie mają
-- wpisu historii wyłączenia.
--
-- Znane ograniczenie: eksport roczny (src/pg/export.js, PR #281) nie obejmuje
-- jeszcze nowych tabel.
--
-- Wycofanie: DROP TABLE ledger_budget_adoption_lines, ledger_budget_adoptions,
-- ledger_category_deactivations; DROP FUNCTION ledger_budget_adoption_guard(),
-- ledger_budget_adoption_line_guard(), ledger_category_deactivation_guard();
-- ALTER TABLE ledger_categories DROP COLUMN idempotency_key.

ALTER TABLE ledger_categories
  ADD COLUMN idempotency_key TEXT UNIQUE
    CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 8 AND 128);

CREATE TABLE ledger_category_deactivations (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  category_id TEXT NOT NULL UNIQUE REFERENCES ledger_categories(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);

CREATE FUNCTION ledger_category_deactivation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category ledger_categories%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ledger_category_deactivations_cannot_be_changed'; END IF;
  SELECT * INTO category FROM ledger_categories WHERE id = NEW.category_id FOR UPDATE;
  IF NOT FOUND OR category.school_year_id <> NEW.school_year_id THEN
    RAISE EXCEPTION 'ledger_category_deactivation_mismatch';
  END IF;
  IF NOT category.active THEN RAISE EXCEPTION 'ledger_category_already_inactive'; END IF;
  UPDATE ledger_categories SET active = false WHERE id = NEW.category_id;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_category_deactivations_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_category_deactivations
  FOR EACH ROW EXECUTE FUNCTION ledger_category_deactivation_guard();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_category_deactivations
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

CREATE TABLE ledger_budget_adoptions (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  resolution_id TEXT REFERENCES resolutions(id),
  note TEXT NOT NULL CHECK (length(btrim(note)) BETWEEN 3 AND 500),
  adopted_on DATE NOT NULL,
  adopted_by TEXT NOT NULL REFERENCES users(id),
  adopted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  UNIQUE (id, school_year_id)
);
CREATE INDEX ledger_budget_adoptions_year_idx ON ledger_budget_adoptions(school_year_id, adopted_at DESC, id);

CREATE TABLE ledger_budget_adoption_lines (
  adoption_id TEXT NOT NULL,
  school_year_id TEXT NOT NULL,
  line_id TEXT NOT NULL REFERENCES ledger_budget_lines(id),
  PRIMARY KEY (adoption_id, line_id),
  FOREIGN KEY (adoption_id, school_year_id) REFERENCES ledger_budget_adoptions(id, school_year_id)
);

CREATE FUNCTION ledger_budget_adoption_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target resolutions%ROWTYPE;
DECLARE target_class TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ledger_budget_adoptions_cannot_be_changed'; END IF;
  IF NEW.resolution_id IS NOT NULL THEN
    SELECT * INTO target FROM resolutions WHERE id = NEW.resolution_id;
    SELECT class_id INTO target_class FROM meetings WHERE id = target.meeting_id;
    IF NOT FOUND OR target.school_year_id <> NEW.school_year_id OR target_class IS NOT NULL
       OR target.status <> 'adopted'
       OR EXISTS (SELECT 1 FROM resolutions n WHERE n.corrects_id = target.id) THEN
      RAISE EXCEPTION 'ledger_budget_adoption_resolution_invalid';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_budget_adoptions_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_budget_adoptions
  FOR EACH ROW EXECUTE FUNCTION ledger_budget_adoption_guard();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_budget_adoptions
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

CREATE FUNCTION ledger_budget_adoption_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ledger_budget_adoption_lines_cannot_be_changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger_budget_lines l WHERE l.id = NEW.line_id AND l.school_year_id = NEW.school_year_id) THEN
    RAISE EXCEPTION 'ledger_budget_adoption_line_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_budget_adoption_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_budget_adoption_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_budget_adoption_line_guard();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_budget_adoption_lines
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
