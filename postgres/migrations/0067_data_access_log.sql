-- Dziennik odczytu danych dzieci i opiekunów (#133): lista klasy, karta
-- gospodarstwa, kartki, lista wpłat. Osobna tabela, nie audit_events, żeby
-- dziennik zmian pozostał czytelny i miał inną retencję (D-04 nie ustala
-- jeszcze retencji tej tabeli — domyślnie nieustalona = nie usuwać).
--
-- Skutki dla danych:
--   * nowa tabela; nic wstecznego się nie zapisuje (brak historii odczytów
--     sprzed tej migracji);
--   * bez danych osobowych, bez parametrów zapytania, bez adresu IP
--     (IP celowo pominięte — do decyzji administratora, patrz issue);
--   * wiersz nie jest nigdy usuwany. Ten sam aktor + ten sam obiekt w oknie
--     5 minut aktualizuje TYLKO last_seen_at i row_count/hit_count (licznik
--     odświeżeń) tego samego wiersza — trigger blokuje zmianę pozostałych
--     pól i każde DELETE, więc historia poza tymi dwoma polami jest
--     niezmienna (ten sam wzorzec co role_grants_guard w 0004).
CREATE TABLE data_access_log (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  actor_id TEXT NOT NULL REFERENCES users(id),
  access_kind TEXT NOT NULL CHECK (access_kind IN (
    'class_students', 'household_card', 'print_cards', 'payment_list'
  )),
  -- Bez FK na school_year_id/class_id/household_id: outcome='not_found'
  -- celowo pozwala na identyfikator, którego obiekt nie istnieje (maskowanie
  -- istnienia, jak w odpowiedzi API — patrz recordDataAccess w print.js).
  school_year_id TEXT,
  class_id TEXT,
  household_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'not_found')),
  row_count INTEGER NOT NULL DEFAULT 1 CHECK (row_count >= 0),
  hit_count INTEGER NOT NULL DEFAULT 1 CHECK (hit_count >= 1),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX data_access_log_actor_idx ON data_access_log(actor_id, occurred_at);
CREATE INDEX data_access_log_household_idx ON data_access_log(household_id) WHERE household_id IS NOT NULL;
CREATE INDEX data_access_log_class_idx ON data_access_log(class_id) WHERE class_id IS NOT NULL;

CREATE FUNCTION data_access_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'data_access_log_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.access_kind IS DISTINCT FROM OLD.access_kind
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.class_id IS DISTINCT FROM OLD.class_id
     OR NEW.household_id IS DISTINCT FROM OLD.household_id
     OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'data_access_log_entry_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER data_access_log_guard BEFORE UPDATE OR DELETE ON data_access_log
  FOR EACH ROW EXECUTE FUNCTION data_access_log_guard();
