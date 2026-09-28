-- Porzucenie szkicu uzgodnienia rachunku i unikalność pliku/ruchu banku tylko
-- wśród nieporzuconych uzgodnień (przegląd #344, #105).
--
-- Problem: docs/RECONCILIATION.md każe przy niezgodnym saldzie pliku założyć
-- nowy szkic, ale 0089 ma globalne UNIQUE na bank_statement_imports.file_hash
-- i bank_statement_lines.bank_transaction_hash, a szkicu nie da się porzucić
-- ani pozycji usunąć. Ponowny import tego samego pliku do nowego szkicu dawał
-- 409 statement_already_imported — udokumentowana ścieżka naprawy była
-- zablokowana.
--
-- Co zmienia:
-- * bank_reconciliations.status dopuszcza 'abandoned'; nowe kolumny
--   abandoned_by, abandoned_at, abandon_reason (wolny tekst, 3–500 znaków).
--   Porzucenie to przejście stanu, NIE usunięcie: szkic, jego importy,
--   pozycje i historia cofniętych powiązań zostają. Porzuconego uzgodnienia
--   nie można zmienić, zatwierdzić ani do niego importować/wiązać
--   (bank_reconciliation_require_draft -> 'bank_reconciliation_abandoned').
-- * Porzucić można tylko szkic (draft), który nie ma aktywnych powiązań 1:1
--   (bank_reconciliation_matches.revoked_at IS NULL) ani aktywnych dopasowań
--   zbiorczych — te drugie sprawdzane dynamicznie, jeżeli istnieje widok
--   bank_reconciliation_group_matches_current (0105, #390, osobny PR). Ta
--   migracja nie zależy od #390: bez widoku sprawdzenie jest pomijane, a po
--   scaleniu #390 działa bez zmian (widok jest wyszukiwany przy każdym
--   wywołaniu, nie przy tworzeniu funkcji). Równoległe powiązanie w tym samym
--   uzgodnieniu czeka na blokadę wiersza uzgodnienia (FOR NO KEY UPDATE
--   w bank_match_guard, FOR SHARE w require_draft), więc nie przejdzie obok
--   porzucenia. Przy porzuceniu saldo księgi jest utrwalane (jak przy
--   zatwierdzeniu), żeby porzucony szkic nie pokazywał salda „na bieżąco”.
-- * Globalne indeksy UNIQUE z 0089 (bank_statement_imports_file_hash_idx,
--   bank_statement_lines_transaction_idx) zastąpione zwykłymi indeksami
--   i triggerami BEFORE INSERT: ten sam plik (file_hash) albo ten sam ruch
--   banku (bank_transaction_hash) nie może występować w dwóch NIEPORZUCONYCH
--   uzgodnieniach. Triggery biorą tę samą blokadę doradczą co API
--   (hashtext('bank_statement_file_import'), 0089/#105), więc dwa równoległe
--   importy nie przejdą obok siebie. Porzucenie konfliktu tylko usuwa
--   (nigdy go nie tworzy), więc wyścig porzucenia z importem kończy się
--   najwyżej zachowawczą odmową 409 i ponowieniem.
-- * Rok zamknięty: bez zmian — a0_year_freeze na bank_reconciliations (0036)
--   odrzuca też UPDATE porzucenia (school_year_closed).
--
-- Funkcje redefiniowane od najnowszych wersji: bank_reconciliation_guard
-- (0024), bank_reconciliation_require_draft (0015).
--
-- Skutki dla istniejących danych: żaden wiersz nie jest zmieniany ani
-- usuwany; nowe kolumny są NULL. Wszystkie istniejące uzgodnienia są
-- 'draft' albo 'confirmed', więc dotychczasowa globalna unikalność implikuje
-- nową (węższą) — migracja nie może trafić na konflikt. Kontrola (powinna
-- zwrócić 0 wierszy):
--   SELECT file_hash FROM bank_statement_imports WHERE file_hash IS NOT NULL
--    GROUP BY 1 HAVING count(*) > 1;
--
-- Wycofanie: tylko gdy nie ma porzuconych uzgodnień ani zduplikowanych
-- skrótów (po porzuceniu i ponownym imporcie ten sam skrót występuje dwa
-- razy — przywrócenie UNIQUE z 0089 by się nie udało). Wtedy: DROP TRIGGER/
-- FUNCTION poniżej, DROP INDEX *_lookup_idx, odtworzenie indeksów UNIQUE
-- z 0089, przywrócenie funkcji z 0024/0015, CHECK status IN ('draft',
-- 'confirmed') i DROP COLUMN abandoned_*. Na bazie z porzuconymi szkicami —
-- wyłącznie po kopii zapasowej; retencja zależy od D-04.

ALTER TABLE bank_reconciliations DROP CONSTRAINT bank_reconciliations_status_check;
ALTER TABLE bank_reconciliations ADD CONSTRAINT bank_reconciliations_status_check
  CHECK (status IN ('draft', 'confirmed', 'abandoned'));

ALTER TABLE bank_reconciliations
  ADD COLUMN abandoned_by TEXT REFERENCES users(id),
  ADD COLUMN abandoned_at TIMESTAMPTZ,
  ADD COLUMN abandon_reason TEXT
    CHECK (abandon_reason IS NULL OR length(btrim(abandon_reason)) BETWEEN 3 AND 500);

ALTER TABLE bank_reconciliations DROP CONSTRAINT bank_reconciliation_confirmation;
ALTER TABLE bank_reconciliations ADD CONSTRAINT bank_reconciliation_confirmation CHECK (
  (status IN ('draft', 'abandoned') AND confirmed_by IS NULL AND confirmed_at IS NULL AND confirmation_note IS NULL)
  OR (status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
);
ALTER TABLE bank_reconciliations ADD CONSTRAINT bank_reconciliation_abandonment CHECK (
  (status = 'abandoned' AND abandoned_by IS NOT NULL AND abandoned_at IS NOT NULL AND abandon_reason IS NOT NULL)
  OR (status <> 'abandoned' AND abandoned_by IS NULL AND abandoned_at IS NULL AND abandon_reason IS NULL)
);

CREATE OR REPLACE FUNCTION bank_reconciliation_require_draft(p_reconciliation_id TEXT)
RETURNS bank_reconciliations LANGUAGE plpgsql AS $$
DECLARE parent bank_reconciliations%ROWTYPE;
BEGIN
  SELECT * INTO parent FROM bank_reconciliations WHERE id = p_reconciliation_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bank_reconciliation_not_found'; END IF;
  IF parent.status = 'abandoned' THEN RAISE EXCEPTION 'bank_reconciliation_abandoned'; END IF;
  IF parent.status <> 'draft' THEN RAISE EXCEPTION 'bank_reconciliation_confirmed_immutable'; END IF;
  RETURN parent;
END;
$$;

-- Aktywne dopasowania (1:1 i — jeśli istnieje, #390 — zbiorcze) uzgodnienia.
CREATE FUNCTION bank_reconciliation_has_active_matches(p_reconciliation_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_found BOOLEAN;
BEGIN
  IF EXISTS (SELECT 1 FROM bank_reconciliation_matches m
              WHERE m.reconciliation_id = p_reconciliation_id AND m.revoked_at IS NULL) THEN
    RETURN TRUE;
  END IF;
  IF to_regclass('bank_reconciliation_group_matches_current') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM bank_reconciliation_group_matches_current g WHERE g.reconciliation_id = $1)'
      INTO v_found USING p_reconciliation_id;
    RETURN v_found;
  END IF;
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION bank_reconciliation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE year school_years%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'bank_reconciliations_cannot_be_deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'bank_reconciliation_must_start_as_draft'; END IF;
    SELECT * INTO year FROM school_years WHERE id = NEW.school_year_id;
    IF NOT FOUND OR NEW.statement_date < year.starts_on OR NEW.statement_date > year.ends_on THEN
      RAISE EXCEPTION 'bank_reconciliation_date_outside_year';
    END IF;
    NEW.ledger_balance_cents := ledger_balance_at(NEW.school_year_id, NEW.statement_date);
    NEW.ledger_non_bank_cents := ledger_non_bank_net_at(NEW.school_year_id, NEW.statement_date);
    RETURN NEW;
  END IF;
  IF OLD.status = 'confirmed' THEN RAISE EXCEPTION 'bank_reconciliation_confirmed_immutable'; END IF;
  IF OLD.status = 'abandoned' THEN RAISE EXCEPTION 'bank_reconciliation_abandoned'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.statement_date IS DISTINCT FROM OLD.statement_date
     OR NEW.statement_balance_cents IS DISTINCT FROM OLD.statement_balance_cents
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.reference_salt IS DISTINCT FROM OLD.reference_salt
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.status NOT IN ('confirmed', 'abandoned') THEN
    RAISE EXCEPTION 'bank_reconciliation_facts_immutable';
  END IF;
  IF NEW.status = 'abandoned' THEN
    -- Draft -> abandoned: tylko bez aktywnych powiązań; historia zostaje.
    IF bank_reconciliation_has_active_matches(NEW.id) THEN
      RAISE EXCEPTION 'bank_reconciliation_has_active_matches';
    END IF;
    NEW.ledger_balance_cents := ledger_balance_at(NEW.school_year_id, NEW.statement_date);
    NEW.ledger_non_bank_cents := ledger_non_bank_net_at(NEW.school_year_id, NEW.statement_date);
    RETURN NEW;
  END IF;
  -- Draft -> confirmed: cele aktywnych powiązań blokowane przed ponownym
  -- sprawdzeniem kwot (korekta w toku kończy się pierwsza), w stałej kolejności.
  PERFORM 1 FROM ledger_entries e
    WHERE e.id IN (SELECT m.ledger_entry_id FROM bank_reconciliation_matches m
                    WHERE m.reconciliation_id = NEW.id AND m.revoked_at IS NULL)
    ORDER BY e.id FOR SHARE;
  PERFORM 1 FROM payment_entries p
    WHERE p.id IN (SELECT m.payment_entry_id FROM bank_reconciliation_matches m
                    WHERE m.reconciliation_id = NEW.id AND m.revoked_at IS NULL)
    ORDER BY p.id FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM bank_match_consistency c
     WHERE c.reconciliation_id = NEW.id AND (NOT c.amount_matches OR c.double_counted)
  ) THEN RAISE EXCEPTION 'bank_reconciliation_inconsistent_matches'; END IF;
  -- Draft -> confirmed: freeze the ledger balance as of the confirmation.
  NEW.ledger_balance_cents := ledger_balance_at(NEW.school_year_id, NEW.statement_date);
  NEW.ledger_non_bank_cents := ledger_non_bank_net_at(NEW.school_year_id, NEW.statement_date);
  RETURN NEW;
END;
$$;

-- Unikalność pliku i ruchu banku tylko wśród nieporzuconych uzgodnień.
DROP INDEX bank_statement_imports_file_hash_idx;
CREATE INDEX bank_statement_imports_file_hash_lookup_idx
  ON bank_statement_imports(file_hash) WHERE file_hash IS NOT NULL;
DROP INDEX bank_statement_lines_transaction_idx;
CREATE INDEX bank_statement_lines_transaction_lookup_idx
  ON bank_statement_lines(bank_transaction_hash) WHERE bank_transaction_hash IS NOT NULL;

CREATE FUNCTION bank_statement_import_file_unique_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.file_hash IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bank_statement_file_import'));
  IF EXISTS (
    SELECT 1 FROM bank_statement_imports i JOIN bank_reconciliations r ON r.id = i.reconciliation_id
     WHERE i.file_hash = NEW.file_hash AND r.status <> 'abandoned'
  ) THEN RAISE EXCEPTION 'bank_statement_file_already_imported'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_statement_imports_file_unique BEFORE INSERT ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION bank_statement_import_file_unique_guard();

CREATE FUNCTION bank_statement_line_transaction_unique_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bank_transaction_hash IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bank_statement_file_import'));
  IF EXISTS (
    SELECT 1 FROM bank_statement_lines l JOIN bank_reconciliations r ON r.id = l.reconciliation_id
     WHERE l.bank_transaction_hash = NEW.bank_transaction_hash AND r.status <> 'abandoned'
  ) THEN RAISE EXCEPTION 'bank_statement_transaction_already_imported'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_statement_lines_transaction_unique BEFORE INSERT ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION bank_statement_line_transaction_unique_guard();
