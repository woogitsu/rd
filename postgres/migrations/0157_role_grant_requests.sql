-- #146 (wariant zachowawczy do D-08): nadanie roli chronionej (administrator,
-- zarząd, skarbnik) wymaga drugiej osoby — zasada czterech oczu, jak reset
-- hasła/MFA kont chronionych (0125). Pierwszy administrator tylko ZAPISUJE
-- wniosek; przydział (POST /api/admin/grants) albo zaproszenie z tokenem
-- (POST /api/admin/invitations, …/reissue) powstaje dopiero po zatwierdzeniu
-- przez INNEGO administratora, który nie jest wnioskodawcą ani adresatem.
--
-- Wyjątek (jawny, w dzienniku zdarzeń): gdy poza wnioskodawcą (i adresatem) nie
-- ma innego aktywnego administratora, który mógłby zatwierdzić — pierwsze
-- uruchomienie po scripts/bootstrap-admin.js — nadanie działa bezpośrednio,
-- a obok zdarzenia nadania powstaje `role_grant.four_eyes_waived`. Ten wyjątek
-- nie jest zapisywany w tej tabeli (żaden wniosek nie powstaje).
--
-- Skutki dla danych: nowa, pusta tabela role_grant_requests. Żaden istniejący
-- wiersz (role_grants, invitations, audit_events) nie jest zmieniany; przydziały
-- i zaproszenia sprzed migracji zostają ważne. Wniosek o zaproszenie zawiera
-- adres e-mail adresata (target_email, jak invitations.email) — potrzebny, by
-- zatwierdzający wiedział, kogo zaprasza; bez tokenu (token powstaje przy
-- zatwierdzeniu i jest zwracany raz zatwierdzającemu). Wniosek o przydział ma
-- tylko identyfikatory. Tabela jest dopisywana: zmienić można wyłącznie stan
-- wniosku oczekującego (trigger), bez DELETE i TRUNCATE.
-- Wycofanie na pustej tabeli: usunięcie triggerów, funkcji i tabeli; z wnioskami
-- tylko po kopii zapasowej (historia wniosków zniknie; zdarzenia
-- `role_grant_request.*` zostają w audit_events).

CREATE TABLE role_grant_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('grant', 'invitation')),
  role TEXT NOT NULL CHECK (role IN ('admin', 'board', 'treasurer')),
  target_user_id TEXT REFERENCES users(id),
  target_email TEXT,
  school_year_id TEXT REFERENCES school_years(id),
  grant_expires_at TIMESTAMPTZ,
  invitation_ttl_seconds INTEGER CHECK (invitation_ttl_seconds IS NULL OR invitation_ttl_seconds > 0),
  replaces_invitation_id TEXT REFERENCES invitations(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_by TEXT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  -- Identyfikator powstałego przydziału (kind = grant) albo zaproszenia (kind = invitation).
  result_id TEXT,
  CHECK (expires_at > created_at),
  CHECK ((kind = 'grant' AND target_user_id IS NOT NULL AND target_email IS NULL
          AND invitation_ttl_seconds IS NULL AND replaces_invitation_id IS NULL)
      OR (kind = 'invitation' AND target_user_id IS NULL AND target_email IS NOT NULL
          AND grant_expires_at IS NULL)),
  CHECK (target_email IS NULL OR (target_email = lower(btrim(target_email)) AND length(target_email) BETWEEN 3 AND 254)),
  CHECK ((status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND result_id IS NULL)
      OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND result_id IS NOT NULL)
      OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND result_id IS NULL)
      OR (status = 'expired' AND decided_by IS NULL AND decided_at IS NOT NULL AND result_id IS NULL)),
  -- Samonadanie nie ma drogi nawet przez wniosek.
  CHECK (target_user_id IS NULL OR target_user_id <> requested_by),
  -- Zasada czterech oczu także w bazie: zatwierdza kto inny niż wnioskodawca
  -- i niż adresat przydziału (odrzucić może również wnioskodawca = wycofanie).
  CONSTRAINT role_grant_requests_four_eyes
    CHECK (status <> 'approved' OR (decided_by <> requested_by
      AND (target_user_id IS NULL OR decided_by <> target_user_id)))
);
-- Jeden otwarty wniosek o ten sam zakres (podwójne kliknięcie = jeden wniosek).
CREATE UNIQUE INDEX role_grant_requests_open_uidx
  ON role_grant_requests(kind, COALESCE(target_user_id, target_email), role, COALESCE(school_year_id, ''))
  WHERE status = 'pending';
CREATE INDEX role_grant_requests_status_idx ON role_grant_requests(status, created_at);

CREATE FUNCTION role_grant_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'role_grant_request_immutable'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id OR NEW.target_email IS DISTINCT FROM OLD.target_email
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id OR NEW.grant_expires_at IS DISTINCT FROM OLD.grant_expires_at
     OR NEW.invitation_ttl_seconds IS DISTINCT FROM OLD.invitation_ttl_seconds
     OR NEW.replaces_invitation_id IS DISTINCT FROM OLD.replaces_invitation_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'role_grant_request_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_grant_requests_guard BEFORE UPDATE OR DELETE ON role_grant_requests
  FOR EACH ROW EXECUTE FUNCTION role_grant_request_guard();

-- Jak inne tabele z triggerem niezmienności (0095): TRUNCATE zabroniony.
CREATE TRIGGER role_grant_requests_no_truncate BEFORE TRUNCATE ON role_grant_requests
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();

-- #80: jak invitations (0130) — nowy wniosek do zamkniętego roku nie mógłby
-- zostać wykonany (role_grants jest zamrożone). Zmiana stanu (UPDATE) pozostaje
-- możliwa: odrzucenie i wygaśnięcie zmniejszają uprawnienia.
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON role_grant_requests
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
