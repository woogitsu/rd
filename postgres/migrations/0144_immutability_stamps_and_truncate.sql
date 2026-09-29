-- Utwardzenie niezmienności, ciąg dalszy (#204, punkty 3, 4 i 6; punkty 1, 2
-- i 5 zrobiła 0082) oraz domknięcie luki BEFORE TRUNCATE.
--
-- Problem: „niezmienne” dzienniki blokowały UPDATE/DELETE, ale przyjmowały
-- antydatowany INSERT (audit_events.occurred_at, payment_entries.created_at,
-- ...), a znaczniki odwołania/anulowania (revoked_at, cancelled_at, ...)
-- dawało się ustawić datą wsteczną. Raporty Komisji Rewizyjnej i eksporty
-- sortują po tych kolumnach, więc data z klienta zmieniała ich wynik.
-- Osobno: tabele z 0082, 0084-0107 itd. mają strażnika UPDATE/DELETE, ale nie
-- miały BEFORE TRUNCATE (0095 objęła tylko stan z tamtej chwili).
--
-- Zmiany:
-- 1. stamp_created_now() — wspólna funkcja BEFORE INSERT (argument: nazwa
--    kolumny): NEW.<kolumna> := now(). Trigger a0_stamp_created_now (nazwa
--    sortuje się przed innymi triggerami INSERT, więc strażnicy widzą już
--    wartość serwera) na tabelach append-only: wpłaty i ich korekty/
--    przypisania/zwroty/alokacje, księga i jej korekty/przelewy/salda
--    otwarcia, uzgodnienia bankowe, dzienniki (audit_events, data_access_log), zdarzenia statusu dokumentów, zgody na wizerunek i
--    ich wycofania, potwierdzenia doręczenia informacji o prywatności.
-- 2. stamp_transition_now() — BEFORE UPDATE: przy przejściu z NULL na wartość
--    NEW.<kolumna> := now() dla revoked_at (sessions, role_grants,
--    invitations, password_reset_tokens, bank_reconciliation_matches,
--    payment_references, news_photos), abandoned_at, withdrawn_at,
--    cancelled_at (email_campaigns, events, event_tasks), enrollments.ended_at.
--    Dzień obowiązywania pozostaje osobnym polem (ended_on, effective_on...).
-- 3. Jedyna furtka: tryb odtworzenia `SET LOCAL rd.restore = 'on'` (ten sam
--    mechanizm co 0027/0038/0040/0095; ustawiają go restoreSnapshot z
--    src/d1-postgres-migration.js i import eksportu z src/pg/export.js).
--    W tym trybie oryginalne znaczniki czasu są zachowane. Po rozdziale ról
--    (#101/SR-05) tylko rola migracyjna powinna móc go ustawić.
-- 4. BEFORE TRUNCATE (deny_truncate() z 0095) na wszystkich tabelach ze
--    strażnikiem UPDATE/DELETE, które go jeszcze nie miały (m.in. tabele z
--    0090: ledger_allocation_versions/_items). guardians pozostaje poza
--    listą — to mutowalne dane główne z historią w guardian_contact_changes.
--
-- Świadomie POZA zakresem: email_send_ledger.recorded_at (licznik dziennego
-- limitu wysyłki liczy po nim i po strefie czasowej konta, testy #84),
-- guardian_households/student_households.ended_at
-- (ustawiane przez triggery synchronizacji z datą biznesową), email_webhook_events.
-- occurred_at (czas zdarzenia u dostawcy, nie zapisu), created_at tabel
-- mutowalnych i importowanych (bank_statement_*).
--
-- Skutki dla danych: żaden istniejący wiersz nie jest zmieniany. Zmienia się
-- zachowanie przyszłych INSERT (znacznik zapisu zawsze z zegara bazy, poza
-- trybem odtworzenia) i UPDATE (pierwsze ustawienie znacznika odwołania =
-- now()), oraz TRUNCATE na dopisanych tabelach jest blokowany. Seedy i testy
-- z historycznymi datami zapisu muszą używać trybu odtworzenia albo pól
-- daty biznesowej.
--
-- Wycofanie: DROP TRIGGER a0_stamp_created_now / a0_stamp_transition_now /
-- <tabela>_no_truncate na wskazanych tabelach; DROP FUNCTION
-- stamp_created_now(), stamp_transition_now(). Na bazie z danymi bezpieczne.

CREATE FUNCTION stamp_created_now() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rd.restore', true) IS NOT DISTINCT FROM 'on' THEN
    RETURN NEW;
  END IF;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now()));
  RETURN NEW;
END;
$$;

CREATE FUNCTION stamp_transition_now() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('rd.restore', true) IS NOT DISTINCT FROM 'on' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(OLD) -> TG_ARGV[0]) = 'null'::jsonb AND (to_jsonb(NEW) -> TG_ARGV[0]) <> 'null'::jsonb THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now()));
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  spec TEXT[];
  insert_stamps TEXT[][] := ARRAY[
    ['audit_events', 'occurred_at'], ['data_access_log', 'occurred_at'],
    ['payment_entries', 'created_at'], ['payment_corrections', 'created_at'],
    ['payment_reassignments', 'created_at'], ['payment_refunds', 'created_at'],
    ['payment_assignments', 'created_at'], ['payment_allocations', 'created_at'],
    ['payment_allocation_reversals', 'created_at'], ['payment_reference_revocations', 'created_at'],
    ['ledger_entries', 'created_at'], ['ledger_corrections', 'created_at'],
    ['ledger_transfers', 'created_at'], ['ledger_opening_balances', 'created_at'],
    ['ledger_opening_balance_adjustments', 'created_at'],
    ['bank_reconciliation_matches', 'created_at'], ['bank_reconciliation_group_matches', 'created_at'],
    ['bank_reconciliation_group_match_revocations', 'created_at'],
    ['document_status_events', 'created_at'], ['resolution_execution_events', 'created_at'],
    ['email_suppression_releases', 'created_at'], ['email_outbox_resolutions', 'created_at'],
    ['email_preferences_events', 'created_at'],
    ['news_photo_consents', 'recorded_at'], ['news_photo_consent_withdrawals', 'recorded_at'],
    ['privacy_notice_deliveries', 'recorded_at']
  ];
  transition_stamps TEXT[][] := ARRAY[
    ['sessions', 'revoked_at'], ['role_grants', 'revoked_at'], ['invitations', 'revoked_at'],
    ['password_reset_tokens', 'revoked_at'], ['bank_reconciliation_matches', 'revoked_at'],
    ['payment_references', 'revoked_at'], ['news_photos', 'revoked_at'],
    ['bank_reconciliations', 'abandoned_at'], ['news_posts', 'withdrawn_at'],
    ['email_campaigns', 'cancelled_at'], ['events', 'cancelled_at'], ['event_tasks', 'cancelled_at'],
    ['enrollments', 'ended_at']
  ];
  t TEXT;
  i INT;
BEGIN
  FOR i IN 1 .. array_length(insert_stamps, 1) LOOP
    EXECUTE format(
      'CREATE TRIGGER a0_stamp_created_now BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION stamp_created_now(%L)',
      insert_stamps[i][1], insert_stamps[i][2]
    );
  END LOOP;
  FOR i IN 1 .. array_length(transition_stamps, 1) LOOP
    EXECUTE format(
      'CREATE TRIGGER a0_stamp_transition_now BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION stamp_transition_now(%L)',
      transition_stamps[i][1], transition_stamps[i][2]
    );
  END LOOP;

  -- BEFORE TRUNCATE dla tabel ze strażnikiem UPDATE/DELETE, które go nie mają.
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
    WHERE c.relkind = 'r' AND c.relname <> 'guardians'
      AND EXISTS (
        SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = c.oid AND NOT tg.tgisinternal
          AND (tg.tgtype & 1) = 1 AND (tg.tgtype & (8 | 16)) <> 0
          AND tg.tgname ~ '(no_change|append_only|no_delete|guard)')
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger x WHERE x.tgrelid = c.oid AND NOT x.tgisinternal AND (x.tgtype & 32) <> 0)
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate()',
      t || '_no_truncate', t
    );
  END LOOP;
END $$;
