-- Naprawa kolizji dwóch wersji year_freeze_via_parent() (#80 + #138).
--
-- 0036_year_freeze_finance.sql dodał do funkcji gałąź dla tabel uzgodnienia
-- rachunku (bank_statement_imports, bank_statement_lines,
-- bank_reconciliation_matches), a 0038_payment_ledger_consistency.sql, pisany
-- równolegle na bazie wersji z 0017, dodał payment_refunds i
-- payment_reassignments. Migracje stosowane są w kolejności nazw, więc 0038
-- nadpisywało wersję z 0036 i każdy zapis do tabel uzgodnienia kończył się
-- błędem year_freeze_unknown_table.
--
-- Skutki dla danych: brak — zmienia się tylko treść funkcji triggera (suma obu
-- wersji). Żaden wiersz nie jest zmieniany, triggery pozostają przypięte bez zmian.

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
  ELSE
    RAISE EXCEPTION 'year_freeze_unknown_table';
  END IF;
  PERFORM school_year_assert_open(year_id);
  RETURN target;
END $$;
