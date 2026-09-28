-- SR-05/SR-06 (audyt bezpieczeństwa, #101, komentarze na issue).
--
-- Zakres tej migracji jest celowo wąski: zamyka dwie luki, które nie
-- wymagają rozdziału ról bazy (rd_owner/rd_app z propozycji SR-05 — osobny,
-- większy zakres, patrz uwaga w PR). Nie czeka na import z D1 (#42): D1
-- nigdy nie miało danych szkoły (#227, komentarz na #101).
--
-- 1) SR-06 — ścieżka legacy_d1: `event_before_insert()` (0008) pozwalała
--    wstawić wydarzenie od razu jako `published` (bez wniosku/zatwierdzenia)
--    dla dowolnego INSERT z visibility='published'. Aplikacja z tego nie
--    korzysta; korzysta z tego wyłącznie odtworzenie migawki
--    (`src/d1-postgres-migration.js`, `SET LOCAL rd.restore = 'on'` — ten sam
--    mechanizm co 0027 dla dat spoza roku szkolnego). Od tej migracji ścieżka
--    jest dostępna wyłącznie w trybie odtworzenia; zwykły INSERT z
--    visibility='published' (np. bezpośredni SQL) kończy się wyjątkiem
--    `legacy_publish_restore_only`.
--    Funkcja jest redefiniowana z jej najnowszej wersji na origin/main
--    (0008_events.sql — jedyna definicja, brak późniejszych nadpisań).
--
-- 2) SR-05 (częściowo, tania i niezależna od podziału ról poprawka z
--    komentarza na #101): żaden strażnik niezmienności (`*_guard`,
--    `*_no_change`, `*_append_only`, `*_no_delete`) nie chronił przed
--    TRUNCATE — polecenie czyści tabelę bez wywołania triggerów wierszowych.
--    Dodajemy wspólną funkcję `deny_truncate()` i statement-level trigger
--    `BEFORE TRUNCATE` na każdej tabeli, która ma dziś trigger niezmienności
--    UPDATE/DELETE. Nie zastępuje to pełnego rozdziału ról (nadal wymagane:
--    bez osobnej roli aplikacji `TRUNCATE` jest dostępny właścicielowi tabel
--    — patrz SR-05 w SECURITY_REVIEW.md, pozostaje otwarte), ale zamyka
--    najprostszą ścieżkę: pomyłkowy `TRUNCATE` w skrypcie lub teście
--    uruchomionym na złej bazie.
--
-- Skutki dla istniejących danych: żaden wiersz nie jest zmieniany ani
-- usuwany. Zmienia się wyłącznie zachowanie przyszłych `INSERT ... visibility
-- = 'published'` poza trybem odtworzenia i przyszłych `TRUNCATE` na tabelach
-- niżej.
--
-- Wycofanie: DROP TRIGGER <nazwa>_no_truncate ON <tabela>; dla każdej tabeli
-- niżej, DROP FUNCTION deny_truncate(); oraz przywrócenie poprzedniej wersji
-- event_before_insert() z 0008_events.sql.

CREATE OR REPLACE FUNCTION event_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision_no := 1;
  NEW.updated_by := COALESCE(NEW.updated_by, NEW.created_by);
  IF NEW.updated_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'event_first_revision_author_mismatch';
  END IF;
  IF NEW.audience IS NULL THEN
    NEW.audience := CASE WHEN NEW.visibility = 'internal' THEN 'internal' ELSE 'public' END;
  END IF;
  IF NEW.visibility = 'published' THEN
    -- Legacy D1 restore only: the old system published without a recorded
    -- approval. The application never inserts published rows directly, and
    -- since #101/SR-06 neither does anything else outside restore mode.
    IF current_setting('rd.restore', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'legacy_publish_restore_only';
    END IF;
    IF NEW.status IS NOT NULL AND NEW.status <> 'published' THEN
      RAISE EXCEPTION 'event_invalid_initial_status';
    END IF;
    NEW.status := 'published';
    NEW.audience := 'public';
    NEW.published_revision_no := 1;
    NEW.published_at := COALESCE(NEW.published_at, now());
    NEW.first_published_at := NEW.published_at;
  ELSE
    IF COALESCE(NEW.status, 'draft') <> 'draft'
       OR NEW.published_at IS NOT NULL OR NEW.published_revision_no IS NOT NULL
       OR NEW.submitted_revision_no IS NOT NULL OR NEW.approved_revision_no IS NOT NULL
       OR NEW.approved_by IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'event_must_start_as_draft';
    END IF;
    NEW.status := 'draft';
    NEW.visibility := CASE WHEN NEW.audience = 'public' THEN 'draft_public' ELSE 'internal' END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION deny_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'truncate_not_allowed: %', TG_TABLE_NAME;
END;
$$;

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'audit_events', 'backup_runs', 'bank_reconciliation_matches', 'bank_reconciliations',
    'bank_statement_imports', 'bank_statement_lines', 'data_access_log', 'document_uploads',
    'documents', 'email_campaign_exclusions', 'email_campaign_recipients', 'email_campaigns',
    'email_outbox', 'email_send_ledger', 'email_suppressions', 'email_webhook_events',
    'email_worker_runs', 'enrollment_history', 'enrollments', 'event_revisions', 'events',
    'export_runs', 'guardian_contact_changes', 'guardian_households', 'import_batches',
    'invitations', 'ledger_budget_lines', 'ledger_categories', 'ledger_corrections',
    'ledger_entries', 'ledger_opening_balance_adjustments', 'ledger_opening_balances',
    'ledger_transfers', 'meeting_agenda_items', 'meeting_attendance_state', 'meeting_attendees',
    'meeting_minutes', 'meeting_minutes_publications', 'meeting_quorum_checks',
    'meeting_request_keys', 'meetings', 'mfa_recovery_codes', 'news_photo_consents',
    'news_photos', 'news_post_revisions', 'news_posts', 'password_reset_tokens',
    'payment_assignments', 'payment_corrections', 'payment_entries', 'payment_reassignments',
    'payment_refunds', 'resolutions', 'role_grants', 'school_year_closures',
    'student_guardian_changes', 'student_guardians', 'student_households', 'user_mfa_factors'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();',
      t || '_no_truncate', t
    );
  END LOOP;
END $$;
