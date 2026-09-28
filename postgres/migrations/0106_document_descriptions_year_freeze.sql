-- Zamrożenie roku dla document_descriptions (follow-up #76/#313, issue #80).
--
-- 0065_document_descriptions.sql świadomie odłożył trigger zamrożenia roku
-- szkolnego dla document_descriptions ("Poza zakresem tej migracji" w opisie
-- pliku i postgres/README.md) — dopisanie opisu (tytuł/kategoria/data/opis)
-- do dokumentu z zamkniętego roku było dotąd możliwe, mimo że sam upload
-- nowego dokumentu (documents) jest już zamrożony trigerem year_freeze_direct
-- od 0036_year_freeze_finance.sql (#80).
--
-- document_descriptions NIE ma własnej kolumny school_year_id — rok ustala
-- dokument-rodzic (documents.school_year_id, przez document_id). Dlatego to
-- gałąź WSPÓLNEJ funkcji year_freeze_via_parent() (0017), nie
-- year_freeze_direct(). Dokumenty bez school_year_id (np. przywrócone z D1,
-- patrz docs/DOCUMENTS.md/docs/DATA_MODEL.md) nie są objęte —
-- school_year_assert_open() pomija NULL, dokładnie jak przy samym documents.
--
-- WYCHODZIMY OD NAJNOWSZEJ WERSJI year_freeze_via_parent() na origin/main w
-- chwili tej migracji: 0076_event_volunteering.sql (issue #142, PR #330),
-- która rozszerzyła 0049_year_freeze_union.sql o gałęzie event_tasks i
-- event_task_signups. Ta migracja dopisuje TYLKO jedną nową gałąź
-- (document_descriptions) przed ELSE — żeby nie powtórzyć incydentu z #279
-- (main zepsuty przez nadpisanie tej funkcji nie od najnowszej wersji).
--
-- Skutki dla danych: sama redefinicja funkcji (CREATE OR REPLACE) i nowy
-- trigger BEFORE INSERT na document_descriptions — działa tylko na przyszłe
-- zapisy, żaden istniejący wiersz nie jest zmieniany ani usuwany.
-- document_descriptions jest dopisywane (0065: trigger blokuje UPDATE/DELETE),
-- więc trigger zamrożenia obejmuje wyłącznie INSERT (bez UPDATE, w
-- przeciwieństwie do np. bank_reconciliation_matches, które dopuszcza zmianę
-- stanu istniejącego wiersza).
--
-- Zapytanie kontrolne przed migracją (powinno zwrócić 0 wierszy — nic nie
-- blokujemy wstecz, trigger działa tylko na nowe INSERT):
--   SELECT count(*) FROM document_descriptions dd
--     JOIN documents d ON d.id = dd.document_id
--     JOIN school_year_closures c ON c.school_year_id = d.school_year_id AND c.status = 'closed';
--
-- Wycofanie na pustej bazie: DROP TRIGGER a0_year_freeze ON document_descriptions;
-- i przywrócenie year_freeze_via_parent() do wersji z
-- 0076_event_volunteering.sql (bez gałęzi document_descriptions). Na bazie
-- z danymi: bezpieczne w tę stronę też — usunięcie triggera tylko przestaje
-- blokować nowe zapisy, nic nie zmienia w istniejących wierszach.

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
  ELSIF TG_TABLE_NAME = 'document_descriptions' THEN
    SELECT school_year_id INTO year_id FROM documents WHERE id = target.document_id;
  ELSE
    RAISE EXCEPTION 'year_freeze_unknown_table';
  END IF;
  PERFORM school_year_assert_open(year_id);
  RETURN target;
END $$;

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON document_descriptions
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
