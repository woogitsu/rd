-- Import wyciągu CODA i CAMT.053 z identyfikatorem transakcji banku oraz blokada
-- podwójnego importu i podwójnego powiązania między uzgodnieniami (#105).
--
-- Co zmienia:
-- * bank_statement_imports.source dopuszcza też 'coda' i 'camt053'.
-- * bank_statement_imports: file_hash (HMAC-SHA256 kluczem serwera z treści
--   pliku; ten sam plik drugi raz -> 409 w API, UNIQUE w bazie), numer wyciągu,
--   saldo początkowe i końcowe z pliku (do kontroli ciągłości) oraz liczba
--   pozycji pominiętych jako już zaimportowane. Import z pliku musi mieć skrót
--   i oba salda; import ręczny/CSV — nie może.
-- * bank_statement_lines.bank_transaction_hash: HMAC-SHA256 kluczem serwera
--   z rachunku i identyfikatora transakcji banku — stała „sól” na rachunek,
--   nie na uzgodnienie, więc ten sam ruch wykrywamy w każdym uzgodnieniu.
--   UNIQUE globalnie (pozycji nie można usunąć, więc każda jest „aktywna”;
--   ruch bankowy jest księgowany raz, niezależnie od roku). Pozycja z pliku
--   CODA/CAMT musi mieć skrót; pozycja ręczna/CSV go nie ma (brak
--   identyfikatora transakcji — dotychczasowe zachowanie bez zmian).
-- * bank_reconciliation_matches: wpłata ani wpis księgi (ani wpłata i wpis,
--   który ją ujmuje, #162) nie mogą mieć aktywnego powiązania w DWÓCH
--   uzgodnieniach tego samego roku. Wybrany wariant z #105 pkt 6: globalna
--   unikalność w roku (nie „przeniesienie” powiązań). Trigger wstawienia bierze
--   blokadę doradczą roku, żeby równoległe powiązania w dwóch uzgodnieniach
--   nie przeszły obok siebie. Funkcja bank_match_guard NIE jest redefiniowana
--   (osobny trigger), więc zmiany z 0024/0039 pozostają nietknięte.
--
-- Nie zapisujemy: treści pliku, tytułów (nadal tylko solony skrót), numeru
-- rachunku Rady ani rachunków kontrahentów.
--
-- Skutki dla istniejących danych: nowe kolumny są NULL (albo 0 dla licznika);
-- żaden wiersz nie jest zmieniany ani usuwany. Istniejące powiązania tego
-- samego celu w kilku uzgodnieniach roku zostają (trigger działa tylko przy
-- nowych powiązaniach). Zapytanie kontrolne — cele powiązane aktywnie
-- w więcej niż jednym uzgodnieniu roku:
--   SELECT r.school_year_id, COALESCE(m.ledger_entry_id, m.payment_entry_id) AS target,
--          array_agg(DISTINCT m.reconciliation_id) AS reconciliations
--     FROM bank_reconciliation_matches m JOIN bank_reconciliations r ON r.id = m.reconciliation_id
--    WHERE m.revoked_at IS NULL
--    GROUP BY 1, 2 HAVING count(DISTINCT m.reconciliation_id) > 1;
--
-- Wycofanie (baza bez importów z plików): DROP TRIGGER/FUNCTION poniżej,
-- DROP INDEX, DROP COLUMN i przywrócenie CHECK source IN ('manual','csv').
-- Na bazie z importami CODA/CAMT — tylko po kopii zapasowej; retencja skrótów
-- i identyfikatorów transakcji zależy od D-04.

ALTER TABLE bank_statement_imports DROP CONSTRAINT bank_statement_imports_source_check;
ALTER TABLE bank_statement_imports ADD CONSTRAINT bank_statement_imports_source_check
  CHECK (source IN ('manual', 'csv', 'coda', 'camt053'));

ALTER TABLE bank_statement_imports
  ADD COLUMN file_hash TEXT CHECK (file_hash IS NULL OR file_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN statement_number TEXT
    CHECK (statement_number IS NULL OR length(statement_number) BETWEEN 1 AND 35),
  ADD COLUMN opening_balance_cents BIGINT
    CHECK (opening_balance_cents IS NULL OR opening_balance_cents BETWEEN -10000000000 AND 10000000000),
  ADD COLUMN closing_balance_cents BIGINT
    CHECK (closing_balance_cents IS NULL OR closing_balance_cents BETWEEN -10000000000 AND 10000000000),
  ADD COLUMN skipped_duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_duplicate_count >= 0),
  ADD CONSTRAINT bank_statement_import_file_fields CHECK (
    (source IN ('coda', 'camt053')
       AND file_hash IS NOT NULL AND opening_balance_cents IS NOT NULL AND closing_balance_cents IS NOT NULL)
    OR (source IN ('manual', 'csv')
       AND file_hash IS NULL AND statement_number IS NULL
       AND opening_balance_cents IS NULL AND closing_balance_cents IS NULL AND skipped_duplicate_count = 0)
  );
CREATE UNIQUE INDEX bank_statement_imports_file_hash_idx
  ON bank_statement_imports(file_hash) WHERE file_hash IS NOT NULL;

ALTER TABLE bank_statement_lines
  ADD COLUMN bank_transaction_hash TEXT
    CHECK (bank_transaction_hash IS NULL OR bank_transaction_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX bank_statement_lines_transaction_idx
  ON bank_statement_lines(bank_transaction_hash) WHERE bank_transaction_hash IS NOT NULL;

CREATE FUNCTION bank_statement_line_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_source TEXT;
BEGIN
  SELECT source INTO v_source FROM bank_statement_imports WHERE id = NEW.import_id;
  IF v_source IN ('coda', 'camt053') AND NEW.bank_transaction_hash IS NULL THEN
    RAISE EXCEPTION 'bank_statement_line_transaction_required';
  END IF;
  IF v_source IN ('manual', 'csv') AND NEW.bank_transaction_hash IS NOT NULL THEN
    RAISE EXCEPTION 'bank_statement_line_transaction_unexpected';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_statement_lines_transaction_guard BEFORE INSERT ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION bank_statement_line_transaction_guard();

CREATE FUNCTION bank_match_year_unique_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_year TEXT;
DECLARE v_payment TEXT;
BEGIN
  SELECT school_year_id INTO v_year FROM bank_reconciliations WHERE id = NEW.reconciliation_id;
  IF v_year IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bank_match_year:' || v_year));
  IF NEW.ledger_entry_id IS NOT NULL THEN
    SELECT payment_entry_id INTO v_payment FROM ledger_entries WHERE id = NEW.ledger_entry_id;
  ELSE
    v_payment := NEW.payment_entry_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM bank_reconciliation_matches m
      JOIN bank_reconciliations r ON r.id = m.reconciliation_id
      LEFT JOIN ledger_entries le ON le.id = m.ledger_entry_id
     WHERE r.school_year_id = v_year AND m.reconciliation_id <> NEW.reconciliation_id
       AND m.revoked_at IS NULL
       AND ((NEW.ledger_entry_id IS NOT NULL AND m.ledger_entry_id = NEW.ledger_entry_id)
         OR (v_payment IS NOT NULL AND (m.payment_entry_id = v_payment OR le.payment_entry_id = v_payment)))
  ) THEN
    RAISE EXCEPTION 'bank_match_in_other_reconciliation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_matches_year_unique_insert BEFORE INSERT ON bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION bank_match_year_unique_guard();
