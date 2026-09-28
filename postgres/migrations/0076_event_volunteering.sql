-- Wydarzenia: zadania i zapisy wolontariuszy z limitem miejsc (issue #142, Etap 1).
--
-- Etap 1, bez kont rodziców (D-10): zapisy prowadzi przedstawiciel klasy dla
-- wydarzeń WŁASNEJ klasy oraz zarząd, wskazując istniejącego opiekuna albo
-- konto — żadnych nowych danych osobowych (telefonów, uwag zdrowotnych) nie
-- zbieramy. Etap 2 (samodzielny zapis rodzica) czeka na D-10.
--
-- event_tasks: zadanie w obrębie wydarzenia (np. stoisko z ciastami). Treść
-- (tytuł, czas, limit miejsc) jest niezmienna po utworzeniu — jedyna dozwolona
-- zmiana to odwołanie (cancelled_at/cancelled_by/cancellation_reason), i to
-- tylko raz. is_public kontroluje, czy strona publiczna może pokazać liczbę
-- wolnych miejsc (bez ŻADNYCH danych osób) — domyślnie nie.
--
-- event_task_signups: zapis opiekuna (guardian_id) ALBO konta (user_id) — jak
-- meeting_attendees (0009) — bez imion/adresów poza tym odwołaniem. Status
-- (confirmed/withdrawn) może się zmieniać (wycofanie i ponowny zapis), ale
-- identyfikator zadania i osoby są niezmienne — trigger pilnuje, że UPDATE
-- zmienia wyłącznie status, nigdy tożsamość zapisu; DELETE jest zawsze
-- zabronione. Unikalny indeks (task_id, user_id)/(task_id, guardian_id)
-- (niezależny od statusu) zapewnia jeden wiersz na parę zadanie+osoba przez
-- cały cykl życia — wycofanie i ponowny zapis to przejście stanu tego samego
-- wiersza, z pełną historią w audit_events (document „wycofanie i ponowny
-- zapis: nowy wiersz albo przejście stanu z historią” — wybieramy drugie,
-- konsekwentnie z resztą schematu, żeby limit miejsc liczył się prostym
-- COUNT(*) WHERE status='confirmed').
--
-- Limit miejsc: trigger BEFORE INSERT OR UPDATE blokuje wiersz zadania
-- (SELECT ... FOR UPDATE) i odrzuca zapis, gdy aktywnych (confirmed) zapisów
-- jest już tyle, ile slots_needed — "task_full". Ten sam trigger odrzuca
-- zapis do zadania odwołanego wydarzenia ("event_cancelled").
--
-- Zamrożenie roku (issue #142, kryterium akceptacji "Rok zamknięty: 409
-- school_year_closed"): rozszerza WSPÓLNĄ funkcję year_freeze_via_parent()
-- (0017/0036/0038, ostatnio scaloną w 0049_year_freeze_union.sql — WYCHODZIMY
-- Z TEJ, najnowszej wersji na origin/main, nie z 0036 ani 0038, żeby nie
-- powtórzyć incydentu z #279 opisanego w fix-common.md) o dwie gałęzie:
-- event_tasks (rok wydarzenia-rodzica) i event_task_signups (rok przez
-- event_tasks -> events, dwa poziomy, jak meeting_minutes_publications niżej).
--
-- Skutki dla danych: dwie nowe, puste tabele; documents/events/inne nie są
-- ruszane. Wycofanie na pustej bazie: usunięcie obu tabel, ich triggerów i
-- funkcji, oraz przywrócenie year_freeze_via_parent() do wersji z
-- 0049_year_freeze_union.sql (bez dwóch nowych gałęzi ELSIF).

CREATE TABLE event_tasks (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  event_id TEXT NOT NULL REFERENCES events(id),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  slots_needed INTEGER NOT NULL CHECK (slots_needed BETWEEN 1 AND 200),
  is_public BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_by TEXT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR length(btrim(cancellation_reason)) BETWEEN 3 AND 500),
  idempotency_key TEXT UNIQUE
    CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  CONSTRAINT event_tasks_end_after_start CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT event_tasks_cancellation_complete CHECK (
    (cancelled_at IS NOT NULL) = (cancelled_by IS NOT NULL)
    AND (cancelled_at IS NULL OR length(btrim(cancellation_reason)) BETWEEN 3 AND 500)
  )
);
CREATE INDEX event_tasks_event_idx ON event_tasks(event_id);

CREATE FUNCTION event_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'event_tasks_are_immutable'; END IF;
  IF OLD.event_id <> NEW.event_id OR OLD.title <> NEW.title
     OR OLD.starts_at IS DISTINCT FROM NEW.starts_at OR OLD.ends_at IS DISTINCT FROM NEW.ends_at
     OR OLD.slots_needed <> NEW.slots_needed OR OLD.is_public <> NEW.is_public
     OR OLD.created_by <> NEW.created_by OR OLD.created_at <> NEW.created_at
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
    RAISE EXCEPTION 'event_tasks_are_immutable';
  END IF;
  IF OLD.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'event_task_already_cancelled'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_tasks_guard BEFORE UPDATE OR DELETE ON event_tasks
  FOR EACH ROW EXECUTE FUNCTION event_task_guard();

CREATE TABLE event_task_signups (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  task_id TEXT NOT NULL REFERENCES event_tasks(id),
  user_id TEXT REFERENCES users(id),
  guardian_id TEXT REFERENCES guardians(id),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'withdrawn')),
  recorded_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_task_signups_single_reference CHECK ((user_id IS NULL) <> (guardian_id IS NULL)),
  UNIQUE (task_id, user_id),
  UNIQUE (task_id, guardian_id)
);
CREATE INDEX event_task_signups_task_idx ON event_task_signups(task_id, status);

CREATE FUNCTION event_task_signup_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'event_task_signups_are_immutable'; END IF;
  IF OLD.task_id <> NEW.task_id OR OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.guardian_id IS DISTINCT FROM NEW.guardian_id
     OR OLD.recorded_by <> NEW.recorded_by OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'event_task_signups_identity_is_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_task_signups_identity_guard BEFORE UPDATE OR DELETE ON event_task_signups
  FOR EACH ROW EXECUTE FUNCTION event_task_signup_identity_guard();

-- Limit miejsc i zamrożenie odwołanego wydarzenia. Blokada wiersza zadania
-- (FOR UPDATE) serializuje równoległe zapisy do tego samego zadania.
CREATE FUNCTION event_task_signup_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task RECORD;
  active_count INTEGER;
BEGIN
  IF NEW.status <> 'confirmed' THEN RETURN NEW; END IF;
  SELECT t.slots_needed, t.cancelled_at, e.status AS event_status
    INTO task
    FROM event_tasks t JOIN events e ON e.id = t.event_id
    WHERE t.id = NEW.task_id FOR UPDATE OF t;
  IF task IS NULL THEN RAISE EXCEPTION 'event_task_not_found'; END IF;
  IF task.cancelled_at IS NOT NULL OR task.event_status = 'cancelled' THEN
    RAISE EXCEPTION 'event_cancelled';
  END IF;
  SELECT count(*) INTO active_count FROM event_task_signups
    WHERE task_id = NEW.task_id AND status = 'confirmed' AND id <> NEW.id;
  IF active_count >= task.slots_needed THEN RAISE EXCEPTION 'task_full'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_task_signups_capacity BEFORE INSERT OR UPDATE ON event_task_signups
  FOR EACH ROW EXECUTE FUNCTION event_task_signup_capacity();

-- Rozszerzenie year_freeze_via_parent() — wychodzimy z pełnej, najnowszej
-- wersji z 0049_year_freeze_union.sql i dopisujemy tylko dwie gałęzie na
-- końcu (przed ELSE), żeby nie zgubić żadnej z istniejących.
CREATE OR REPLACE FUNCTION year_freeze_via_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target RECORD;
DECLARE year_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD; ELSE target := NEW; END IF;
  IF TG_TABLE_NAME IN ('payment_assignments', 'payment_corrections', 'payment_refunds', 'payment_reassignments') THEN
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
  ELSIF TG_TABLE_NAME IN ('bank_statement_imports', 'bank_statement_lines', 'bank_reconciliation_matches') THEN
    SELECT school_year_id INTO year_id FROM bank_reconciliations WHERE id = target.reconciliation_id;
  ELSIF TG_TABLE_NAME = 'event_tasks' THEN
    SELECT school_year_id INTO year_id FROM events WHERE id = target.event_id;
  ELSIF TG_TABLE_NAME = 'event_task_signups' THEN
    SELECT e.school_year_id INTO year_id FROM event_tasks t
      JOIN events e ON e.id = t.event_id WHERE t.id = target.task_id;
  ELSE
    RAISE EXCEPTION 'year_freeze_unknown_table';
  END IF;
  PERFORM school_year_assert_open(year_id);
  RETURN target;
END $$;

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON event_tasks
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON event_task_signups
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
