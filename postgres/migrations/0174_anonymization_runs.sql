-- Anonimizacja gospodarstwa z zachowaniem księgi i sum wpłat (#91, D-04/D-07).
--
-- Problem: schemat celowo nie pozwala zmienić ani usunąć wpisów księgi, ale
-- tym samym nie dawał żadnej ścieżki wykonania przyszłej decyzji retencyjnej
-- (D-04) ani żądania usunięcia (D-07) — bez ręcznego wyłączania triggerów.
-- Ta migracja dodaje MECHANIZM, nie okresy: żadnej wartości retencji nie
-- ustala (kod odmawia bez polityki w `retention_policies`, patrz
-- docs/RETENTION.md), i nie usuwa żadnego wiersza.
--
-- Zmiany:
-- 1. `anonymization_runs` — dziennik przebiegów, tylko do dopisywania (UPDATE/
--    DELETE/TRUNCATE odrzucane): kto, kiedy, które gospodarstwo, powód jako
--    KOD (`retention_policy` | `data_subject_request`), odwołania do polityk
--    lub żądania, liczniki per tabela i SHA-256 listy zmienionych
--    identyfikatorów. Bez imion, e-maili i tekstów wolnych.
-- 2. `rd_anonymization_update_allowed(tabela, stary, nowy)` — JEDYNA furtka w
--    strażnikach niezmienności: UPDATE przechodzi wyłącznie, gdy w transakcji
--    ustawiono `rd.anonymization_run` (set_config(..., true)), tabela jest na
--    liście poniżej, a zmieniają się TYLKO wymienione kolumny tekstowe i tylko
--    na NULL albo wartość zastępczą. Kwoty, daty, identyfikatory, status,
--    gospodarstwo, rok i klucze idempotencji są poza listą — próba ich zmiany
--    nadal kończy się dotychczasowym błędem strażnika.
--    Tabele i kolumny: guardian_contact_changes (previous_email, new_email,
--    reason -> NULL), student_guardian_changes.reason, enrollment_history.reason,
--    guardian_households.ended_reason, student_households.created_reason/
--    ended_reason, enrollments.ended_reason, guardian_update_requests.
--    proposed_email/note (-> NULL), payment_entries.reference (-> NULL),
--    payment_corrections/payment_refunds/payment_reassignments/
--    payment_allocation_reversals.reason (-> '[zanonimizowano]', kolumny NOT
--    NULL z CHECK długości) oraz email_campaign_recipients.email (->
--    'zanonimizowano@anonim.invalid', NOT NULL; email_hash zostaje — patrz
--    docs/RETENTION.md).
-- 3. Strażnicy z furtką (każdy dostaje wyłącznie wczesny `RETURN NEW` na
--    początku, reszta gałęzi bez zmian — redefinicje skopiowane z żywych
--    definicji): family_history_immutable, immutable_financial_record,
--    immutable_payment_event, email_snapshot_guard, payment_entry_guard,
--    guardian_update_request_guard, enrollment_guard, year_freeze_direct
--    (rok zamknięty nie blokuje anonimizacji — to nie zmiana księgi),
--    guardian_household_check, student_household_check.
-- 4. guardian_contact_history pomija wpis historii w kontekście przebiegu
--    (inaczej UPDATE guardians.email zapisałby stary e-mail w nowym wierszu
--    guardian_contact_changes); zdarzenie przebiegu jest w anonymization_runs
--    i audit_events.
--
-- Skutki dla danych: żaden istniejący wiersz nie jest zmieniany przez samą
-- migrację (nowa, pusta tabela i nowe funkcje). Zmieniają je dopiero przebiegi
-- wywołane przez administratora (POST /api/admin/anonymizations). Zmiana jest
-- NIEODWRACALNA dla bazy — odtworzenie z kopii sprzed przebiegu przywraca dane
-- osobowe (procedura w docs/RETENTION.md: przebiegi trzeba zastosować ponownie).
-- Bezpośredni UPDATE/DELETE tych tabel poza przebiegiem jest odrzucany tak jak
-- dotąd. Uwaga: tak jak `rd.restore` (0144), `rd.anonymization_run` jest
-- ustawieniem sesji — po rozdziale ról (#101/SR-05) powinna je ustawiać tylko
-- rola aplikacji, nie konta tylko do odczytu.
--
-- Wycofanie: przywrócić poprzednie definicje wymienionych funkcji (0014, 0017,
-- 0023, 0055, 0087, 0136, 0038, 0003, 0007 — patrz `git log`), DROP FUNCTION
-- rd_anonymization_update_allowed, rd_anonymization_active, DROP TABLE
-- anonymization_runs (na bazie z danymi tylko po kopii zapasowej: tabela jest
-- jedynym dowodem, co zanonimizowano).

CREATE TABLE anonymization_runs (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  household_id TEXT NOT NULL REFERENCES households(id),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('retention_policy', 'data_subject_request')),
  data_subject_request_id TEXT REFERENCES data_subject_requests(id),
  -- Identyfikatory polityk z retention_policies obowiązujących w chwili przebiegu.
  retention_policy_ids TEXT[] NOT NULL DEFAULT '{}',
  plan_sha256 TEXT NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  -- Liczniki per tabela (liczby całkowite), bez identyfikatorów i danych osobowych.
  counts JSONB NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  executed_by TEXT NOT NULL REFERENCES users(id),
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT anonymization_runs_reason_shape CHECK (
    (reason_code = 'data_subject_request') = (data_subject_request_id IS NOT NULL)
    AND (reason_code = 'retention_policy') = (cardinality(retention_policy_ids) > 0)
  )
);
CREATE INDEX anonymization_runs_household_idx ON anonymization_runs(household_id, executed_at DESC);

CREATE FUNCTION anonymization_runs_no_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'anonymization_runs_is_append_only';
END;
$$;
CREATE TRIGGER anonymization_runs_no_change BEFORE UPDATE OR DELETE ON anonymization_runs
  FOR EACH ROW EXECUTE FUNCTION anonymization_runs_no_change();
CREATE TRIGGER anonymization_runs_no_truncate BEFORE TRUNCATE ON anonymization_runs
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();
CREATE TRIGGER a0_stamp_created_now BEFORE INSERT ON anonymization_runs
  FOR EACH ROW EXECUTE FUNCTION stamp_created_now('executed_at');

-- ---------------------------------------------------------------------------
-- Furtka: kontekst przebiegu + lista dozwolonych kolumn
-- ---------------------------------------------------------------------------
CREATE FUNCTION rd_anonymization_active() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('rd.anonymization_run', true), '')
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

CREATE FUNCTION rd_anonymization_update_allowed(p_table TEXT, p_old JSONB, p_new JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
  null_columns TEXT[];
  placeholder_columns TEXT[];
  col TEXT;
  expected TEXT;
BEGIN
  IF NOT rd_anonymization_active() THEN
    RETURN false;
  END IF;
  null_columns := CASE p_table
    WHEN 'guardian_contact_changes' THEN ARRAY['previous_email', 'new_email', 'reason']
    WHEN 'student_guardian_changes' THEN ARRAY['reason']
    WHEN 'enrollment_history' THEN ARRAY['reason']
    WHEN 'guardian_households' THEN ARRAY['ended_reason']
    WHEN 'student_households' THEN ARRAY['created_reason', 'ended_reason']
    WHEN 'enrollments' THEN ARRAY['ended_reason']
    WHEN 'guardian_update_requests' THEN ARRAY['proposed_email', 'note']
    WHEN 'payment_entries' THEN ARRAY['reference']
    ELSE ARRAY[]::text[]
  END;
  placeholder_columns := CASE p_table
    WHEN 'payment_corrections' THEN ARRAY['reason']
    WHEN 'payment_refunds' THEN ARRAY['reason']
    WHEN 'payment_reassignments' THEN ARRAY['reason']
    WHEN 'payment_allocation_reversals' THEN ARRAY['reason']
    WHEN 'email_campaign_recipients' THEN ARRAY['email']
    ELSE ARRAY[]::text[]
  END;
  IF cardinality(null_columns) = 0 AND cardinality(placeholder_columns) = 0 THEN
    RETURN false;
  END IF;
  FOR col IN
    SELECT k FROM jsonb_object_keys(p_new) AS k WHERE (p_old -> k) IS DISTINCT FROM (p_new -> k)
  LOOP
    IF col = ANY (null_columns) THEN
      IF (p_new -> col) <> 'null'::jsonb THEN RETURN false; END IF;
    ELSIF col = ANY (placeholder_columns) THEN
      expected := CASE WHEN col = 'email' THEN 'zanonimizowano@anonim.invalid' ELSE '[zanonimizowano]' END;
      IF (p_new ->> col) IS DISTINCT FROM expected THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Strażnicy: wczesne wyjście w kontekście przebiegu, reszta bez zmian
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION family_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_update_allowed(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'family_history_is_append_only';
END $$;

CREATE OR REPLACE FUNCTION immutable_financial_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_update_allowed(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%_cannot_be_changed', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION immutable_payment_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_update_allowed(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%_cannot_be_changed', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION email_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_update_allowed(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  SELECT status INTO campaign_status FROM email_campaigns
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.campaign_id ELSE NEW.campaign_id END;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'email_snapshot_rows_immutable';
  END IF;
  IF campaign_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'email_snapshot_locked';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION payment_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_update_allowed(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_entries_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.received_on IS DISTINCT FROM OLD.received_on
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'payment_financial_facts_immutable';
  END IF;
  IF NEW.household_id IS DISTINCT FROM OLD.household_id
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'unmatched' AND OLD.household_id IS NULL
        AND NEW.status = 'recorded' AND NEW.household_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM payment_assignments a
          WHERE a.payment_entry_id = OLD.id AND a.household_id = NEW.household_id))
      OR
      (OLD.status = 'recorded' AND NEW.status = 'recorded'
        AND OLD.household_id IS NOT NULL AND NEW.household_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM payment_reassignments r
          WHERE r.payment_entry_id = OLD.id AND r.old_household_id = OLD.household_id
            AND r.new_household_id = NEW.household_id))
    ) THEN
      RAISE EXCEPTION 'payment_assignment_event_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guardian_update_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_update_allowed(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guardian_update_requests_cannot_be_deleted';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'guardian_update_request_already_decided';
  END IF;
  IF NEW.link_id <> OLD.link_id OR NEW.guardian_id <> OLD.guardian_id
     OR NEW.proposed_email IS DISTINCT FROM OLD.proposed_email
     OR NEW.proposed_email_set <> OLD.proposed_email_set
     OR NEW.proposed_contact_allowed IS DISTINCT FROM OLD.proposed_contact_allowed
     OR NEW.proposed_contact_allowed_set <> OLD.proposed_contact_allowed_set
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'guardian_update_request_immutable_fields';
  END IF;
  IF NEW.status = 'pending' THEN
    RAISE EXCEPTION 'guardian_update_request_no_op_update';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enrollment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_update_allowed(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'enrollments_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id THEN
    RAISE EXCEPTION 'enrollment_identity_immutable';
  END IF;
  IF OLD.ended_on IS NOT NULL THEN
    RAISE EXCEPTION 'enrollment_already_ended';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION year_freeze_direct() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_update_allowed(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM school_year_assert_open(OLD.school_year_id); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM school_year_assert_open(NEW.school_year_id); END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guardian_household_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_update_allowed(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
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

CREATE OR REPLACE FUNCTION student_household_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND rd_anonymization_update_allowed(TG_TABLE_NAME, to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
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
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_reason IS DISTINCT FROM OLD.created_reason THEN
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

CREATE OR REPLACE FUNCTION guardian_contact_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Przebieg anonimizacji nie tworzy wiersza historii (kopiowałby stary e-mail).
  IF rd_anonymization_active() THEN
    RETURN NEW;
  END IF;
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
