-- #146 (wariant zachowawczy, bez rozstrzygania D-08/D-10): reset hasła i reset
-- MFA konta z rolą zarządu, skarbnika lub administratora wymaga drugiej osoby
-- (zasada czterech oczu). Pierwszy administrator tylko ZAPISUJE wniosek;
-- token resetu / wyłączenie MFA powstaje dopiero po zatwierdzeniu przez innego
-- administratora, który nie jest właścicielem konta.
--
-- Skutki dla danych: nowa, pusta tabela account_recovery_requests oraz nowa,
-- nullable kolumna password_reset_tokens.request_id (istniejące tokeny mają
-- NULL = wydane bezpośrednio, przed zmianą lub dla konta bez roli chronionej).
-- Żaden istniejący wiersz nie jest zmieniany. Wniosek nie zawiera sekretów ani
-- e-maili; tokenu nie ma w bazie (tylko skrót w password_reset_tokens).
-- Wycofanie na pustej tabeli: usunięcie kolumny request_id, triggera, funkcji
-- i tabeli; z wnioskami — tylko po kopii zapasowej (historia wniosków zniknie).

CREATE TABLE account_recovery_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('password_reset', 'mfa_reset')),
  target_user_id TEXT NOT NULL REFERENCES users(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  ttl_seconds INTEGER CHECK (ttl_seconds IS NULL OR ttl_seconds > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_by TEXT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (kind = 'password_reset' OR ttl_seconds IS NULL),
  CHECK ((status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
      OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
      OR (status = 'expired' AND decided_by IS NULL AND decided_at IS NOT NULL)),
  -- Zasada czterech oczu także w bazie: zatwierdza kto inny niż wnioskodawca
  -- i niż właściciel konta (odrzucić może również wnioskodawca = wycofanie).
  CHECK (status <> 'approved' OR (decided_by <> requested_by AND decided_by <> target_user_id))
);
-- Jeden otwarty wniosek danego rodzaju na konto (podwójne kliknięcie = jeden wniosek).
CREATE UNIQUE INDEX account_recovery_requests_open_uidx
  ON account_recovery_requests(target_user_id, kind) WHERE status = 'pending';
CREATE INDEX account_recovery_requests_status_idx ON account_recovery_requests(status, created_at);

CREATE FUNCTION account_recovery_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'account_recovery_request_immutable'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.target_user_id IS DISTINCT FROM OLD.target_user_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.ttl_seconds IS DISTINCT FROM OLD.ttl_seconds OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'account_recovery_request_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_recovery_requests_guard BEFORE UPDATE OR DELETE ON account_recovery_requests
  FOR EACH ROW EXECUTE FUNCTION account_recovery_request_guard();

ALTER TABLE password_reset_tokens ADD COLUMN request_id TEXT REFERENCES account_recovery_requests(id);

-- Jak inne tabele z triggerem niezmienności (0095): TRUNCATE zabroniony.
CREATE TRIGGER account_recovery_requests_no_truncate BEFORE TRUNCATE ON account_recovery_requests
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();
