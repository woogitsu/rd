-- Issue #80: luki w zamrożeniu zamkniętego roku szkolnego.
--
-- 0017_year_close.sql zamraża wpłaty, księgę, wydarzenia, zebrania i nowe
-- przydziały ról triggerami "a0_year_freeze" wywołującymi
-- school_year_assert_open(). Poza zamrożeniem zostały tabele przypisane do
-- roku, które też dotyczą finansów i dokumentacji roku:
--   * bank_reconciliations, bank_statement_imports, bank_statement_lines,
--     bank_reconciliation_matches (0015) — uzgodnienie rachunku,
--   * documents (0006) — w tym dowody finansowe (kind='financial'),
--   * email_campaigns (0007) — nowa kampania.
--
-- Ta migracja NIE zmienia żadnych danych, dodaje tylko triggery — dokładnie
-- ten sam wzorzec co 0017 (funkcje year_freeze_direct/year_freeze_via_parent,
-- nazwa triggera "a0_year_freeze", blokada wiersza zamknięcia przez
-- school_year_assert_open() z FOR SHARE — NIE przez LOCK TABLE ... SHARE
-- MODE). Issue #212 pokazuje, że rozszerzanie table-level LOCK ... SHARE MODE
-- w year-close.js grozi zakleszczeniem; ta migracja świadomie tego nie robi
-- i nie dotyka year-close.js.
--
-- Zakres i wyjątki. Kryterium akceptacji #80 dotyczy zakresu finansowego tego
-- issue (uzgodnienia, dokumenty, kampanie); baza ma więcej tabel z własną
-- kolumną school_year_id (classes, enrollments, enrollment_history,
-- invitations, import_batches, news_posts) bez triggera a0_year_freeze — to
-- dane organizacyjne, poza zakresem #80, i decyzja o ich zamrożeniu (jeśli
-- w ogóle potrzebna) należy do osobnego issue, żeby nie zablokować przy okazji
-- niewinnych poprawek administracyjnych. Tu opisane są tylko wyjątki
-- bezpośrednio sąsiadujące z zakresem finansowym:
--   * export_runs (0016): CELOWO bez zamrożenia — eksport archiwum roku musi
--     działać także po zamknięciu (opisane w docs/YEAR_CLOSE.md).
--   * audit_events: bez zamrożenia — dziennik zdarzeń nie ma school_year_id
--     i musi przyjmować zapisy zawsze (np. przy odczytach zamkniętego roku).
--   * role_grants (0012/0022): trigger role_grant_year_freeze już istnieje
--     w 0017 i obejmuje też nowsze ścieżki nadawania ról — nie mają one
--     własnej tabeli, tylko wstawiają do role_grants.
--   * ledger_entries/payment_entries: data poza rokiem szkolnym jest już
--     osobno pokryta przez 0027_entry_date_within_school_year.sql (#169) —
--     nie powtarzamy tu tej logiki.
--   * documents: BLOKUJEMY insert dla KAŻDEGO rodzaju (financial/board/class)
--     przypisanego do zamkniętego roku, nie tylko finansowego — założenie
--     do zatwierdzenia przez Radę (patrz DATA_MODEL/YEAR_CLOSE): "dokumenty
--     do zamkniętego roku dodaje się po zamknięciu wyłącznie przez rok
--     następny z odwołaniem". Dokumenty bez school_year_id (D1) nie są
--     objęte (year_freeze_direct pomija NULL).
--   * email_campaigns: blokujemy tylko UTWORZENIE nowej kampanii
--     (BEFORE INSERT). Zmianę stanu istniejącej kampanii na wysyłkę po
--     zamknięciu roku w trakcie jej trwania CELOWO zostawiamy poza tą
--     migracją — wymaga decyzji Rady, czy kampanię rozpoczętą przed
--     zamknięciem dokończyć czy wstrzymać (D-13/D-21), a wymuszenie
--     zamrożenia w złym miejscu kolejki mogłoby zdublować albo urwać
--     wysyłkę w połowie. Opisane też w PR.
--
-- Skutki dla istniejących danych: żaden wiersz nie jest zmieniany. Zapytanie
-- kontrolne przed migracją (powinno zwrócić 0 wierszy — nic nie blokujemy
-- wstecz, trigger działa tylko na nowe INSERT/UPDATE):
--   SELECT count(*) FROM bank_reconciliations br
--     JOIN school_year_closures c ON c.school_year_id = br.school_year_id AND c.status = 'closed';
--
-- Wycofanie: DROP TRIGGER a0_year_freeze ON <każda z tabel poniżej>;
-- przywrócić year_freeze_via_parent() do wersji z 0017 (bez nowych gałęzi).

CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON email_campaigns
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

-- Rozszerzenie year_freeze_via_parent (0017) o tabele podrzędne uzgodnienia
-- rachunku (0015). CREATE OR REPLACE zachowuje wszystkie dotychczasowe
-- gałęzie — tylko dopisuje nowe TG_TABLE_NAME.
CREATE OR REPLACE FUNCTION year_freeze_via_parent() RETURNS trigger LANGUAGE plpgsql AS $$
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
  ELSIF TG_TABLE_NAME IN ('bank_statement_imports', 'bank_statement_lines', 'bank_reconciliation_matches') THEN
    SELECT school_year_id INTO year_id FROM bank_reconciliations WHERE id = target.reconciliation_id;
  ELSE
    RAISE EXCEPTION 'year_freeze_unknown_table';
  END IF;
  PERFORM school_year_assert_open(year_id);
  RETURN target;
END $$;

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
-- INSERT OR UPDATE: dopasowanie (INSERT) i cofnięcie dopasowania (UPDATE
-- revoked_at) obie liczą się jako zapis dotyczący uzgodnienia zamkniętego
-- roku i mają być odrzucone.
CREATE TRIGGER a0_year_freeze BEFORE INSERT OR UPDATE ON bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
