-- Kod weryfikacyjny na NOWY adres e-mail z wniosku rodzica o aktualizację
-- kontaktu (#140, punkt 5). Wskazania właściciela 2026-10-02 (docs/DECISIONS.md,
-- „Wskazania użytkownika 2026-10-02”): weryfikacja opcjonalna z ostrzeżeniem,
-- kod wychodzi automatycznie po złożeniu wniosku. Prototyp — nie jest wdrożony.
-- NICZEGO ta migracja nie wysyła.
--
-- Co się zmienia:
-- 1. `guardian_verify_templates` — wersjonowany szablon wiadomości z kodem
--    (temat + treść z obowiązkowym `{kod}`), zatwierdzany RAZ przez zarząd:
--    stan `draft -> approved`, zatwierdza inna osoba niż autor (CHECK
--    guardian_verify_template_four_eyes; MFA „krok w górę” sprawdza trasa).
--    Zatwierdzona wersja jest niezmienna (guardian_verify_template_guard);
--    nowa treść = nowa wersja. Bez zatwierdzonej wersji kod nie wychodzi.
-- 2. `guardian_update_verifications` — jeden wiersz na wniosek z nowym adresem
--    (UNIQUE request_id, klucz idempotencji `verify:<request_id>`): stan kolejki
--    (`queued`/`sending`/`sent`/`failed`/`cancelled`, `skipped` = nic nie
--    zlecono — flaga wyłączona, brak szablonu, brak informacji o przetwarzaniu
--    albo ograniczenie przetwarzania), dzierżawa przebiegu workera (claim_token,
--    jak email_outbox), skrót kodu z solą (kod jawny istnieje wyłącznie
--    w pamięci workera i w wiadomości), termin ważności, licznik błędnych prób
--    (CHECK 0–5) i chwila potwierdzenia. ADRESU NIE MA w tym wierszu — worker
--    czyta go z niezmiennego guardian_update_requests.proposed_email, więc
--    odbiorcą może być wyłącznie adres wpisany przez rodzica w tym wniosku.
--    Strażnik guardian_update_verification_guard: bez DELETE, identyfikatory
--    i powiązania niezmienne, dozwolone przejścia stanów, potwierdzenie raz,
--    licznik prób tylko rośnie, kod zmienia się tylko przy przejęciu do wysyłki.
-- 3. `email_send_ledger`: źródło `verification` z kolumną `verification_id`
--    (FK) — wiadomość z kodem zużywa ten sam dzienny limit Brevo co kampanie
--    (jeden wpis na próbę: UNIQUE (verification_id, attempt)). Redefinicja
--    trzech CHECK dziennika (źródło, powiązanie wiersza, pola ręcznego wpisu);
--    gałęzie `campaign`/`preview`/`other` bez zmian.
-- 4. BEFORE TRUNCATE (deny_truncate() z 0095) na obu nowych tabelach.
--
-- Skutki dla danych: dwie nowe, puste tabele i jedna kolumna NULL w
-- email_send_ledger (ADD COLUMN bez DEFAULT nie przepisuje tabeli). Istniejące
-- wiersze dziennika mają source campaign/other/preview i verification_id NULL,
-- więc spełniają nowe CHECK (sprawdzane przy ADD CONSTRAINT). Istniejące
-- wnioski (guardian_update_requests) zostają bez zmian i bez wiersza weryfikacji
-- (API pokazuje dla nich `verification: none`). Nowe tabele nie zawierają adresów
-- ani kodu jawnego — wyłącznie identyfikatory, stany, kody powodów i skróty.
--
-- Wycofanie: na bazie bez wierszy weryfikacji — DROP TRIGGER/FUNCTION obu
-- strażników, DROP TABLE guardian_update_verifications, guardian_verify_templates,
-- DROP SEQUENCE guardian_verify_template_version_seq, a w email_send_ledger
-- przywrócenie CHECK z 0056/0177 i DROP COLUMN verification_id. Z wierszami —
-- tylko po kopii zapasowej (wpisy dziennika limitu są tylko do dopisywania
-- i wskazują wiersze weryfikacji; ślad zdarzeń zostaje w audit_events).

-- ---------- szablon ----------

CREATE SEQUENCE guardian_verify_template_version_seq;

CREATE TABLE guardian_verify_templates (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE DEFAULT nextval('guardian_verify_template_version_seq'),
  subject TEXT NOT NULL CHECK (length(btrim(subject)) BETWEEN 3 AND 200 AND position('{kod}' IN subject) = 0),
  body_text TEXT NOT NULL CHECK (length(btrim(body_text)) BETWEEN 20 AND 4000 AND position('{kod}' IN body_text) > 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  CONSTRAINT guardian_verify_template_four_eyes CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT guardian_verify_template_approved_pair CHECK (
    (status = 'approved') = (approved_by IS NOT NULL) AND (approved_by IS NULL) = (approved_at IS NULL)
  )
);
CREATE INDEX guardian_verify_templates_approved_idx ON guardian_verify_templates(version) WHERE status = 'approved';

CREATE FUNCTION guardian_verify_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guardian_verify_templates_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body_text IS DISTINCT FROM OLD.body_text
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'guardian_verify_template_immutable_fields';
  END IF;
  IF NOT (OLD.status = 'draft' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'guardian_verify_template_invalid_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guardian_verify_template_guard BEFORE UPDATE OR DELETE ON guardian_verify_templates
  FOR EACH ROW EXECUTE FUNCTION guardian_verify_template_guard();
CREATE TRIGGER guardian_verify_templates_no_truncate BEFORE TRUNCATE ON guardian_verify_templates
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();

-- ---------- weryfikacja wniosku ----------

CREATE TABLE guardian_update_verifications (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES guardian_update_requests(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  template_id TEXT REFERENCES guardian_verify_templates(id),
  privacy_notice_id TEXT REFERENCES privacy_notices(id),
  state TEXT NOT NULL CHECK (state IN ('skipped', 'queued', 'sending', 'sent', 'failed', 'cancelled')),
  last_error TEXT CHECK (last_error ~ '^[a-z0-9_]{1,60}$'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token TEXT CHECK (claim_token IS NULL OR claim_token ~ '^[A-Za-z0-9-]{1,64}$'),
  claimed_at TIMESTAMPTZ,
  send_started_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  provider_message_id TEXT CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  code_salt TEXT CHECK (code_salt ~ '^[0-9a-f]{32}$'),
  code_hash TEXT CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at TIMESTAMPTZ,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT guardian_update_verification_key CHECK (idempotency_key = 'verify:' || request_id),
  -- Zlecona wysyłka zawsze wskazuje zatwierdzony szablon i informację o przetwarzaniu.
  CONSTRAINT guardian_update_verification_sources CHECK (
    state = 'skipped' OR (template_id IS NOT NULL AND privacy_notice_id IS NOT NULL)
  ),
  CONSTRAINT guardian_update_verification_skipped_reason CHECK (
    state NOT IN ('skipped', 'failed', 'cancelled') OR last_error IS NOT NULL
  ),
  CONSTRAINT guardian_update_verification_code_triplet CHECK (
    (code_hash IS NULL) = (code_salt IS NULL) AND (code_hash IS NULL) = (code_expires_at IS NULL)
  ),
  CONSTRAINT guardian_update_verification_confirm_needs_send CHECK (
    confirmed_at IS NULL OR (code_hash IS NOT NULL AND send_started_at IS NOT NULL)
  )
);
CREATE INDEX guardian_update_verifications_queue_idx ON guardian_update_verifications(state, next_attempt_at)
  WHERE state IN ('queued', 'sending');

CREATE FUNCTION guardian_update_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guardian_update_verifications_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.privacy_notice_id IS DISTINCT FROM OLD.privacy_notice_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'guardian_update_verification_immutable_fields';
  END IF;
  IF OLD.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'guardian_update_verification_already_confirmed';
  END IF;
  IF OLD.state IN ('skipped', 'cancelled') THEN
    RAISE EXCEPTION 'guardian_update_verification_closed';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'queued' AND NEW.state IN ('sending', 'failed', 'cancelled'))
    OR (OLD.state = 'sending' AND NEW.state IN ('queued', 'sent', 'failed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'guardian_update_verification_invalid_transition';
  END IF;
  IF NEW.failed_attempts < OLD.failed_attempts THEN
    RAISE EXCEPTION 'guardian_update_verification_attempts_decreased';
  END IF;
  -- Nowy kod powstaje wyłącznie przy przejęciu wiersza do wysyłki (queued -> sending).
  IF (NEW.code_hash IS DISTINCT FROM OLD.code_hash OR NEW.code_salt IS DISTINCT FROM OLD.code_salt
      OR NEW.code_expires_at IS DISTINCT FROM OLD.code_expires_at)
     AND NOT (OLD.state = 'queued' AND NEW.state = 'sending') THEN
    RAISE EXCEPTION 'guardian_update_verification_code_locked';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guardian_update_verification_guard BEFORE UPDATE OR DELETE ON guardian_update_verifications
  FOR EACH ROW EXECUTE FUNCTION guardian_update_verification_guard();
CREATE TRIGGER guardian_update_verifications_no_truncate BEFORE TRUNCATE ON guardian_update_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();

-- ---------- dziennik limitu Brevo ----------

ALTER TABLE email_send_ledger ADD COLUMN verification_id TEXT REFERENCES guardian_update_verifications(id);
ALTER TABLE email_send_ledger ADD CONSTRAINT email_send_ledger_verification_attempt_key UNIQUE (verification_id, attempt);

ALTER TABLE email_send_ledger DROP CONSTRAINT email_send_ledger_source_check;
ALTER TABLE email_send_ledger ADD CONSTRAINT email_send_ledger_source_check
  CHECK (source IN ('campaign', 'other', 'preview', 'verification'));

ALTER TABLE email_send_ledger DROP CONSTRAINT email_ledger_campaign_row;
ALTER TABLE email_send_ledger ADD CONSTRAINT email_ledger_campaign_row CHECK (
  (source = 'campaign' AND campaign_id IS NOT NULL AND outbox_id IS NOT NULL AND attempt IS NOT NULL AND message_count = 1
     AND verification_id IS NULL)
  OR (source = 'preview' AND campaign_id IS NOT NULL AND outbox_id IS NULL AND attempt IS NULL AND message_count = 1
     AND verification_id IS NULL)
  OR (source = 'other' AND campaign_id IS NULL AND outbox_id IS NULL AND attempt IS NULL AND verification_id IS NULL)
  OR (source = 'verification' AND campaign_id IS NULL AND outbox_id IS NULL AND attempt IS NOT NULL
     AND verification_id IS NOT NULL AND message_count = 1)
);

ALTER TABLE email_send_ledger DROP CONSTRAINT email_ledger_other_manual;
ALTER TABLE email_send_ledger ADD CONSTRAINT email_ledger_other_manual CHECK (
  (source IN ('campaign', 'preview', 'verification') AND message_count = 1 AND actor_id IS NULL AND reason_code IS NULL
     AND idempotency_key IS NULL AND corrects_id IS NULL)
  OR (source = 'other' AND actor_id IS NULL AND reason_code IS NULL AND idempotency_key IS NULL
        AND corrects_id IS NULL AND message_count > 0)
  OR (source = 'other' AND actor_id IS NOT NULL AND reason_code IS NOT NULL AND idempotency_key IS NOT NULL
        AND ((reason_code = 'correction' AND message_count < 0 AND corrects_id IS NOT NULL)
          OR (reason_code <> 'correction' AND message_count > 0 AND corrects_id IS NULL)))
);
