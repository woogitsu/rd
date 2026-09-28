-- Centra kosztów w księdze: przypisanie wpisu do wydarzenia lub klasy (#117).
--
-- Co zmienia:
-- * ledger_allocation_versions — wersja przypisania jednego wpisu księgi
--   (numer wersji, poprzednia wersja `supersedes_id`, powód zmiany, aktor, czas,
--   klucz idempotencji). Wersje tworzą jedną linię: każda wersja może mieć
--   najwyżej jednego następcę (UNIQUE supersedes_id), więc dwa równoległe
--   „przepięcia” tej samej wersji kończą się jednym zapisem.
-- * ledger_allocation_items — pozycje wersji: wydarzenie ALBO klasa i kwota
--   w centach (> 0). Wersja bez pozycji = cały wpis wraca do „ogólne”.
--   Wydarzenie i klasa muszą być z roku wpisu (złożone FK do events/classes).
-- * Suma pozycji wersji ≤ kwota netto wpisu (trigger odroczony do końca
--   transakcji, bo pozycje wstawia się po wersji).
-- * Korekta wpisu, po której netto spadłoby poniżej sumy BIEŻĄCEJ wersji
--   przypisania, jest odrzucana (`ledger_allocation_exceeds_net`): najpierw
--   nowa wersja przypisania z mniejszymi kwotami, potem korekta. To osobny
--   trigger na ledger_corrections — ledger_correction_guard (0039) NIE jest
--   redefiniowany.
-- * Obie tabele są niezmienne (immutable_financial_record) i objęte
--   zamrożeniem roku (year_freeze_direct na własnej kolumnie school_year_id).
-- * Kolumny event_id/class_id w ledger_entries (propozycja #117 pkt 1) NIE są
--   dodawane: przypisanie nowego wpisu to pierwsza wersja w tej tabeli, więc
--   jest jedno źródło prawdy.
--
-- Skutki dla istniejących danych: tylko nowe tabele, indeksy, ograniczenia
-- unikalności (events(id, school_year_id), ledger_entries(id, school_year_id)
-- — obie prawdziwe z definicji, bo id jest kluczem głównym) i triggery. Żaden
-- wiersz nie jest zmieniany; wszystkie istniejące wpisy są „ogólne”.
--
-- Wycofanie: DROP TABLE ledger_allocation_items, ledger_allocation_versions,
-- DROP FUNCTION poniżej i dodanych ograniczeń. Na bazie z przypisaniami —
-- tylko po kopii zapasowej (historia przypisań zniknie).

ALTER TABLE events ADD CONSTRAINT events_id_school_year_key UNIQUE (id, school_year_id);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_id_school_year_key UNIQUE (id, school_year_id);

CREATE TABLE ledger_allocation_versions (
  id TEXT PRIMARY KEY,
  ledger_entry_id TEXT NOT NULL,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  supersedes_id TEXT UNIQUE REFERENCES ledger_allocation_versions(id),
  reason TEXT CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  FOREIGN KEY (ledger_entry_id, school_year_id) REFERENCES ledger_entries(id, school_year_id),
  UNIQUE (ledger_entry_id, version_no),
  UNIQUE (id, school_year_id),
  CONSTRAINT ledger_allocation_version_chain CHECK ((version_no = 1) = (supersedes_id IS NULL)),
  CONSTRAINT ledger_allocation_change_reason CHECK (version_no = 1 OR reason IS NOT NULL)
);
CREATE INDEX ledger_allocation_versions_year_idx ON ledger_allocation_versions(school_year_id, ledger_entry_id);

CREATE TABLE ledger_allocation_items (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  school_year_id TEXT NOT NULL,
  event_id TEXT,
  class_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  FOREIGN KEY (version_id, school_year_id) REFERENCES ledger_allocation_versions(id, school_year_id),
  FOREIGN KEY (event_id, school_year_id) REFERENCES events(id, school_year_id),
  FOREIGN KEY (class_id, school_year_id) REFERENCES classes(id, school_year_id),
  CONSTRAINT ledger_allocation_item_single_center CHECK ((event_id IS NULL) <> (class_id IS NULL))
);
CREATE UNIQUE INDEX ledger_allocation_items_event_idx
  ON ledger_allocation_items(version_id, event_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_allocation_items_class_idx
  ON ledger_allocation_items(version_id, class_id) WHERE class_id IS NOT NULL;
CREATE INDEX ledger_allocation_items_event_lookup_idx ON ledger_allocation_items(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX ledger_allocation_items_class_lookup_idx ON ledger_allocation_items(class_id) WHERE class_id IS NOT NULL;

-- Bieżąca wersja przypisania każdego wpisu = wersja bez następcy.
CREATE VIEW ledger_current_allocations AS
SELECT v.ledger_entry_id, v.school_year_id, v.id AS version_id, v.version_no,
       i.event_id, i.class_id, i.amount_cents
  FROM ledger_allocation_versions v
  JOIN ledger_allocation_items i ON i.version_id = v.id
 WHERE NOT EXISTS (SELECT 1 FROM ledger_allocation_versions n WHERE n.supersedes_id = v.id);

CREATE FUNCTION ledger_allocation_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_previous ledger_allocation_versions%ROWTYPE;
BEGIN
  -- Serializacja wersji jednego wpisu i kolejności z korektą (ta sama blokada).
  PERFORM 1 FROM ledger_entries WHERE id = NEW.ledger_entry_id FOR UPDATE;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO v_previous FROM ledger_allocation_versions WHERE id = NEW.supersedes_id;
    IF NOT FOUND OR v_previous.ledger_entry_id <> NEW.ledger_entry_id
       OR v_previous.version_no <> NEW.version_no - 1 THEN
      RAISE EXCEPTION 'ledger_allocation_version_mismatch';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM ledger_allocation_versions WHERE ledger_entry_id = NEW.ledger_entry_id) THEN
    RAISE EXCEPTION 'ledger_allocation_version_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_allocation_versions_guard BEFORE INSERT ON ledger_allocation_versions
  FOR EACH ROW EXECUTE FUNCTION ledger_allocation_version_guard();

CREATE FUNCTION ledger_allocation_sum_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_entry TEXT;
DECLARE v_net BIGINT;
DECLARE v_sum BIGINT;
BEGIN
  SELECT ledger_entry_id INTO v_entry FROM ledger_allocation_versions WHERE id = NEW.version_id;
  SELECT net_amount_cents INTO v_net FROM ledger_entry_net WHERE id = v_entry;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_sum FROM ledger_allocation_items WHERE version_id = NEW.version_id;
  IF v_sum > COALESCE(v_net, 0) THEN RAISE EXCEPTION 'ledger_allocation_exceeds_net'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_allocation_items_sum AFTER INSERT ON ledger_allocation_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_allocation_sum_guard();

-- Korekta wpisu nie może zejść poniżej sumy bieżącego przypisania (#117).
CREATE FUNCTION ledger_correction_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_net BIGINT;
DECLARE v_allocated BIGINT;
BEGIN
  SELECT net_amount_cents INTO v_net FROM ledger_entry_net WHERE id = NEW.ledger_entry_id;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_allocated
    FROM ledger_current_allocations WHERE ledger_entry_id = NEW.ledger_entry_id;
  -- Bez przypisania nic tu nie sprawdzamy (przekroczenie kwoty wpisu zgłasza ledger_correction_guard).
  IF v_allocated > 0 AND v_allocated > COALESCE(v_net, 0) - NEW.amount_cents THEN
    RAISE EXCEPTION 'ledger_allocation_exceeds_net';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_corrections_allocation_guard BEFORE INSERT ON ledger_corrections
  FOR EACH ROW EXECUTE FUNCTION ledger_correction_allocation_guard();

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_allocation_versions
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_allocation_items
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER ledger_allocation_versions_no_change BEFORE UPDATE OR DELETE ON ledger_allocation_versions
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER ledger_allocation_items_no_change BEFORE UPDATE OR DELETE ON ledger_allocation_items
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
