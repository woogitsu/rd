-- Zamknięcie roku szkolnego i przekazanie dokumentacji nowej Radzie (#15).
--
-- Skutki dla danych:
-- * Dodaje tabele school_year_closures i school_year_closure_checklist.
--   Żaden istniejący wiersz nie jest zmieniany ani usuwany.
-- * Rok bez wiersza w school_year_closures jest „otwarty” (open). Rozpoczęcie
--   zamknięcia tworzy wiersz 'closing'; zamknięcie zmienia go na 'closed'.
-- * Bilans zamknięcia jest liczony z widoku ledger_year_summary (0003) i
--   przenoszony jako ledger_opening_balances następnego roku (ten sam
--   mechanizm co ręczny bilans otwarcia; poprawki tylko przez
--   ledger_opening_balance_adjustments).
-- * Po zamknięciu triggery odrzucają nowe zapisy przypisane do zamkniętego
--   roku: wpłaty, przypisania i korekty wpłat, wpisy i korekty księgi,
--   kategorie, preliminarz, bilans otwarcia i jego poprawki, wydarzenia,
--   zebrania z częściami składowymi, protokoły, publikacje protokołów,
--   uchwały oraz nowe przydziały ról w tym roku. Odczyt pozostaje bez zmian.
--   Korekta po zamknięciu nie ma ścieżki w aplikacji — patrz docs/YEAR_CLOSE.md.
-- * Przydziały ról zawężone do zamykanego roku dostają expires_at
--   (jedyna zmiana dozwolona przez trigger z 0004); wiersze zostają.

CREATE TABLE school_year_closures (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL UNIQUE REFERENCES school_years(id),
  next_school_year_id TEXT NOT NULL REFERENCES school_years(id),
  status TEXT NOT NULL DEFAULT 'closing' CHECK (status IN ('closing', 'closed')),
  initiated_by TEXT NOT NULL REFERENCES users(id),
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by TEXT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  income_cents BIGINT,
  expense_cents BIGINT,
  opening_balance_cents BIGINT,
  closing_balance_cents BIGINT,
  carried_opening_balance_id TEXT UNIQUE REFERENCES ledger_opening_balances(id),
  expired_grant_count INTEGER CHECK (expired_grant_count IS NULL OR expired_grant_count >= 0),
  CONSTRAINT year_close_next_year_differs CHECK (next_school_year_id <> school_year_id),
  -- Założenie: zasada czterech oczu — zamyka inna osoba niż ta, która rozpoczęła.
  CONSTRAINT year_close_four_eyes CHECK (closed_by IS NULL OR closed_by <> initiated_by),
  CONSTRAINT year_close_closed_fields CHECK (
    (status = 'closed') = (
      closed_by IS NOT NULL AND closed_at IS NOT NULL AND closing_balance_cents IS NOT NULL
      AND income_cents IS NOT NULL AND expense_cents IS NOT NULL
      AND opening_balance_cents IS NOT NULL AND carried_opening_balance_id IS NOT NULL
      AND expired_grant_count IS NOT NULL
    )
  )
);
CREATE INDEX school_year_closures_next_idx ON school_year_closures(next_school_year_id);

CREATE TABLE school_year_closure_checklist (
  closure_id TEXT NOT NULL REFERENCES school_year_closures(id),
  item TEXT NOT NULL CHECK (item IN (
    'financial_report', 'audit_commission_report', 'minutes_approved',
    'resolutions_archived', 'reconciliation_confirmed', 'documents_handed_over'
  )),
  note TEXT CHECK (note IS NULL OR length(btrim(note)) BETWEEN 3 AND 500),
  document_id TEXT REFERENCES documents(id),
  confirmed_by TEXT NOT NULL REFERENCES users(id),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (closure_id, item)
);

-- Rok jest zamknięty? Blokada FOR SHARE na wierszu zamknięcia serializuje
-- zapis z równoległym zamknięciem (zamknięcie bierze FOR UPDATE).
CREATE FUNCTION school_year_assert_open(p_school_year_id TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE current_status TEXT;
BEGIN
  IF p_school_year_id IS NULL THEN RETURN; END IF;
  SELECT status INTO current_status FROM school_year_closures
    WHERE school_year_id = p_school_year_id FOR SHARE;
  IF current_status = 'closed' THEN
    RAISE EXCEPTION 'school_year_closed';
  END IF;
END $$;

CREATE FUNCTION year_close_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'school_year_closures_cannot_be_deleted'; END IF;
  IF OLD.status = 'closed' THEN RAISE EXCEPTION 'school_year_closure_is_final'; END IF;
  IF ROW(NEW.id, NEW.school_year_id, NEW.next_school_year_id, NEW.initiated_by, NEW.initiated_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.school_year_id, OLD.next_school_year_id, OLD.initiated_by, OLD.initiated_at) THEN
    RAISE EXCEPTION 'school_year_closure_facts_immutable';
  END IF;
  IF NEW.status = 'closed' THEN
    IF (SELECT count(*) FROM school_year_closure_checklist WHERE closure_id = NEW.id) < 6 THEN
      RAISE EXCEPTION 'year_close_checklist_incomplete';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_year_closures_guard BEFORE UPDATE OR DELETE ON school_year_closures
  FOR EACH ROW EXECUTE FUNCTION year_close_guard();

CREATE FUNCTION year_close_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE closing_year school_years%ROWTYPE;
DECLARE next_year school_years%ROWTYPE;
BEGIN
  IF NEW.status <> 'closing' THEN RAISE EXCEPTION 'year_close_must_start_as_closing'; END IF;
  SELECT * INTO closing_year FROM school_years WHERE id = NEW.school_year_id;
  SELECT * INTO next_year FROM school_years WHERE id = NEW.next_school_year_id;
  IF next_year.starts_on <= closing_year.starts_on THEN
    RAISE EXCEPTION 'year_close_next_year_must_follow';
  END IF;
  IF EXISTS (SELECT 1 FROM school_year_closures
             WHERE school_year_id = NEW.next_school_year_id) THEN
    RAISE EXCEPTION 'year_close_next_year_not_open';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_year_closures_guard_insert BEFORE INSERT ON school_year_closures
  FOR EACH ROW EXECUTE FUNCTION year_close_insert_guard();

CREATE FUNCTION year_close_checklist_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'school_year_closure_checklist_cannot_be_changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM school_year_closures WHERE id = NEW.closure_id AND status = 'closing') THEN
    RAISE EXCEPTION 'year_close_not_in_progress';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_year_closure_checklist_guard
  BEFORE INSERT OR UPDATE OR DELETE ON school_year_closure_checklist
  FOR EACH ROW EXECUTE FUNCTION year_close_checklist_guard();

-- Zamrożenie zamkniętego roku ----------------------------------------------
-- Każdy trigger zamrożenia nazywa się a0_year_freeze, aby w danej tabeli
-- uruchamiał się przed pozostałymi triggerami BEFORE (kolejność alfabetyczna).

-- Tabele z własną kolumną school_year_id.
CREATE FUNCTION year_freeze_direct() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM school_year_assert_open(OLD.school_year_id); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM school_year_assert_open(NEW.school_year_id); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON payment_entries
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON ledger_categories
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_budget_lines
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_opening_balances
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON resolutions
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

-- Nowe przydziały ról w zamkniętym roku są odrzucane. Zmiana expires_at
-- i cofnięcie istniejących przydziałów pozostają możliwe (0004).
CREATE FUNCTION role_grant_year_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM school_year_assert_open(NEW.school_year_id);
  RETURN NEW;
END $$;
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON role_grants
  FOR EACH ROW EXECUTE FUNCTION role_grant_year_freeze();

-- Tabele, których rok wynika z rekordu nadrzędnego.
CREATE FUNCTION year_freeze_via_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target RECORD;
DECLARE year_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD; ELSE target := NEW; END IF;
  IF TG_TABLE_NAME IN ('payment_assignments', 'payment_corrections') THEN
    SELECT school_year_id INTO year_id FROM payment_entries WHERE id = target.payment_entry_id;
  ELSIF TG_TABLE_NAME = 'ledger_corrections' THEN
    SELECT school_year_id INTO year_id FROM ledger_entries WHERE id = target.ledger_entry_id;
  ELSIF TG_TABLE_NAME = 'ledger_opening_balance_adjustments' THEN
    SELECT school_year_id INTO year_id FROM ledger_opening_balances WHERE id = target.opening_balance_id;
  ELSIF TG_TABLE_NAME IN ('meeting_agenda_items', 'meeting_attendees', 'meeting_quorum_checks', 'meeting_minutes') THEN
    SELECT school_year_id INTO year_id FROM meetings WHERE id = target.meeting_id;
  ELSIF TG_TABLE_NAME = 'meeting_minutes_publications' THEN
    SELECT m.school_year_id INTO year_id FROM meeting_minutes mm
      JOIN meetings m ON m.id = mm.meeting_id WHERE mm.id = target.minutes_id;
  ELSE
    RAISE EXCEPTION 'year_freeze_unknown_table';
  END IF;
  PERFORM school_year_assert_open(year_id);
  RETURN target;
END $$;

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON payment_assignments
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON payment_corrections
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_corrections
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_opening_balance_adjustments
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE OR DELETE ON meeting_agenda_items
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE OR DELETE ON meeting_attendees
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON meeting_quorum_checks
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON meeting_minutes
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON meeting_minutes_publications
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
