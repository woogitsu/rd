-- Utwardzenie niezmienności (#204, część): zatwierdzenie kampanii e-mail,
-- odwołanie sesji i wstawianie do kolejki wysyłki dają się dziś zmienić albo
-- sfałszować już przy INSERT, mimo że triggery z 0002-0069 blokują większość
-- UPDATE/DELETE. Aplikacja dziś nie ustawia tych pól z danych klienta — luki
-- otwiera każdy zapis spoza API (SQL w oknie serwisowym, skrypt, przyszła
-- trasa) oraz rola aplikacji, która zachowuje prawo INSERT/UPDATE.
--
-- W tej migracji (punkty 1, 2 i 5 z propozycji w #204):
-- 1. email_campaign_guard: w stanie 'approved' nie da się podmienić
--    zatwierdzającego/czasu/skrótów zatwierdzenia ani migawki bez zmiany
--    stanu (dotąd guard pilnował tylko treści, listy i przejść — blokada
--    approved_* działała dopiero w stanie 'sending'/'paused'). Przejście
--    approved -> draft musi wyczyścić wszystkie pola zatwierdzenia (dotąd
--    mogło je zostawić, bo CHECK email_campaign_approval_complete tego nie
--    wymagał — aplikacja i tak je czyści, patrz src/pg/routes/email.js,
--    trigger tylko zamyka furtkę na zapis poza API).
-- 2. Nowy trigger session_guard: token_hash, user_id, created_at,
--    rotated_from niezmienne; revoked_at (i revoked_reason) ustawiane raz —
--    odwołanej sesji nie da się „odwołać” drugi raz na nowo (dziś aplikacja
--    i tak robi to warunkowym UPDATE ... WHERE revoked_at IS NULL, trigger
--    zamyka tę samą furtkę na poziomie bazy); mfa_verified_at może się tylko
--    ustawiać, nie czyścić. Wiersza sesji nie da się usunąć (żaden kod
--    dziś tego nie robi).
-- 3. Nowy trigger email_outbox_insert_guard (BEFORE INSERT — dotychczasowy
--    email_outbox_guard pilnuje tylko UPDATE/DELETE): wiersz kolejki idzie
--    wyłącznie do kampanii w stanie 'approved' lub 'sending' i zawsze jako
--    state='queued', attempts=0, sent_at/claimed_at/send_started_at/
--    claim_token IS NULL. Zgodne z jedynym miejscem, które dziś wstawia do
--    tej tabeli (queue() w src/pg/routes/email.js — INSERT idzie, gdy
--    kampania jest jeszcze 'approved', UPDATE na 'sending' jest po).
--
-- Świadomie POZA zakresem tej migracji (osobny PR — patrz #204, punkty 3, 4,
-- 6): wspólna funkcja stamp_created_now() dla wszystkich tabel append-only
-- (payment_entries, ledger_entries, audit_events, *_corrections,
-- ledger_opening_*...) i trigger "ustawiane raz przy przejściu z NULL" dla
-- revoked_at/ended_at/cancelled_at/withdrawn_at w pozostałych tabelach —
-- oba dotykają dużej liczby tabel i seedów testowych naraz (ryzyko opisane w
-- issue), a role_grant_guard (0004) ma tę ochronę już od #201/0022. Test
-- "lint niezmienności" (punkt 6) zostaje na czas, gdy zakres 3-4 powstanie,
-- żeby lintował całość naraz.
--
-- Skutki dla danych: same nowe/rozszerzone triggery, żaden wiersz nie jest
-- zmieniany. Zmienia się wyłącznie zachowanie przyszłych INSERT/UPDATE:
-- * kampania zatwierdzona sprzed tej migracji, której nikt nie próbuje
--   zmieniać, nie jest dotknięta;
-- * sesja odwołana sprzed migracji pozostaje odwołana (trigger tylko
--   odrzuca PONOWNE ustawienie revoked_at, nie zmienia istniejących
--   wartości);
-- * email_outbox_insert_guard działa tylko na nowe wiersze.

CREATE OR REPLACE FUNCTION email_campaign_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email_campaigns_cannot_be_deleted';
  END IF;
  IF OLD.status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'email_campaign_closed';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'email_campaign_identity_immutable';
  END IF;
  IF NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body_text IS DISTINCT FROM OLD.body_text
     OR NEW.audience IS DISTINCT FROM OLD.audience OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.recipients_hash IS DISTINCT FROM OLD.recipients_hash
     OR NEW.recipients_count IS DISTINCT FROM OLD.recipients_count
     OR NEW.send_not_before IS DISTINCT FROM OLD.send_not_before THEN
    -- Zmiana treści, listy lub terminu startu: tylko przed wysyłką i zawsze z utratą zatwierdzenia.
    IF OLD.status NOT IN ('draft', 'approved') THEN
      RAISE EXCEPTION 'email_campaign_content_locked';
    END IF;
    IF NEW.status <> 'draft' OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'email_campaign_change_requires_reapproval';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'sending', 'cancelled'))
    OR (OLD.status = 'sending' AND NEW.status IN ('done', 'paused', 'cancelled'))
    OR (OLD.status = 'paused' AND NEW.status IN ('sending', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'email_campaign_invalid_transition';
  END IF;
  IF OLD.status IN ('sending', 'paused') AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.daily_cap IS DISTINCT FROM OLD.daily_cap
     OR NEW.queued_at IS DISTINCT FROM OLD.queued_at) THEN
    RAISE EXCEPTION 'email_campaign_sending_locked';
  END IF;
  -- #204 (punkt 1): w stanie 'approved' zatwierdzający, czas zatwierdzenia,
  -- skróty zatwierdzenia i migawka są niezmienne, dopóki stan pozostaje
  -- 'approved' — dotąd dało się je podmienić UPDATE-em bez zmiany stanu
  -- (guard sprawdzał tylko treść/listę/przejścia).
  IF OLD.status = 'approved' AND NEW.status = 'approved' AND (
       NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.approved_content_hash IS DISTINCT FROM OLD.approved_content_hash
    OR NEW.approved_recipients_hash IS DISTINCT FROM OLD.approved_recipients_hash
    OR NEW.snapshot_built_by IS DISTINCT FROM OLD.snapshot_built_by
    OR NEW.snapshot_built_at IS DISTINCT FROM OLD.snapshot_built_at
  ) THEN
    RAISE EXCEPTION 'email_campaign_approval_immutable';
  END IF;
  -- #204 (punkt 1): cofnięcie do szkicu musi wyczyścić WSZYSTKIE pola
  -- zatwierdzenia i migawki naraz — inaczej kampania w 'draft' mogłaby nadal
  -- nosić zatwierdzenie sprzed cofnięcia.
  IF OLD.status = 'approved' AND NEW.status = 'draft' AND (
       NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
    OR NEW.approved_content_hash IS NOT NULL OR NEW.approved_recipients_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'email_campaign_approval_must_clear_on_revert';
  END IF;
  -- paused_by/paused_at i resumed_by/resumed_at zmieniają się wyłącznie razem
  -- z przejściem, którego dotyczą (trasy pause/resume) — nie da się ich
  -- ustawić przy okazji innej zmiany.
  IF (NEW.paused_by IS DISTINCT FROM OLD.paused_by OR NEW.paused_at IS DISTINCT FROM OLD.paused_at)
     AND NOT (OLD.status = 'sending' AND NEW.status = 'paused') THEN
    RAISE EXCEPTION 'email_campaign_pause_fields_locked';
  END IF;
  IF (NEW.resumed_by IS DISTINCT FROM OLD.resumed_by OR NEW.resumed_at IS DISTINCT FROM OLD.resumed_at)
     AND NOT (OLD.status = 'paused' AND NEW.status = 'sending') THEN
    RAISE EXCEPTION 'email_campaign_resume_fields_locked';
  END IF;
  RETURN NEW;
END $$;

-- #204 (punkt 2): sesje — tożsamość i odwołanie niezmienne.
CREATE FUNCTION session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sessions_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.rotated_from IS DISTINCT FROM OLD.rotated_from THEN
    RAISE EXCEPTION 'session_identity_immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (
       NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason
  ) THEN
    RAISE EXCEPTION 'session_revocation_final';
  END IF;
  IF OLD.mfa_verified_at IS NOT NULL AND NEW.mfa_verified_at IS NULL THEN
    RAISE EXCEPTION 'session_mfa_verified_at_cannot_be_cleared';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_guard_trigger BEFORE UPDATE OR DELETE ON sessions
  FOR EACH ROW EXECUTE FUNCTION session_guard();

-- #204 (punkt 5): kolejka wysyłki tylko dla kampanii zatwierdzonej/wysyłanej,
-- zawsze jako świeży wiersz kolejki. Osobna funkcja BEFORE INSERT, bo
-- dotychczasowy email_outbox_guard (0025) jest BEFORE UPDATE OR DELETE i
-- odwołuje się do OLD, którego INSERT nie ma.
CREATE FUNCTION email_outbox_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  campaign_status TEXT;
BEGIN
  SELECT status INTO campaign_status FROM email_campaigns WHERE id = NEW.campaign_id;
  IF campaign_status IS NULL OR campaign_status NOT IN ('approved', 'sending') THEN
    RAISE EXCEPTION 'email_outbox_campaign_not_ready';
  END IF;
  IF NEW.state <> 'queued' OR NEW.attempts <> 0 OR NEW.sent_at IS NOT NULL
     OR NEW.claimed_at IS NOT NULL OR NEW.send_started_at IS NOT NULL OR NEW.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'email_outbox_insert_must_be_fresh_queued';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_outbox_insert_guard_trigger BEFORE INSERT ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION email_outbox_insert_guard();

-- Wycofanie na pustej/testowej bazie: DROP TRIGGER session_guard_trigger ON
-- sessions; DROP FUNCTION session_guard(); DROP TRIGGER
-- email_outbox_insert_guard_trigger ON email_outbox; DROP FUNCTION
-- email_outbox_insert_guard(); przywrócenie email_campaign_guard() z 0063.
-- Na bazie z danymi: bezpieczne, żaden wiersz nie jest zmieniany ani usuwany.
