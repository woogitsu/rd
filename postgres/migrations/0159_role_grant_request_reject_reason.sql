-- #146 (follow-up z PR #587): opcjonalny powód odrzucenia (albo wycofania)
-- wniosku o nadanie roli chronionej. Administrator odrzucający wniosek może
-- krótko wyjaśnić decyzję; powód widzą administratorzy na liście wniosków
-- (GET /api/admin/grant-requests). Pole jest opcjonalne — odrzucenie bez powodu działa jak dotąd.
--
-- Powód to wolny tekst w tabeli niezmiennej (strażnik z 0157), więc przed
-- zapisem przechodzi przez bramkę danych osobowych #152 (src/pg/pii-gate.js,
-- `role_grant_requests.reject_reason`): e-mail, IBAN, numer rejestru krajowego
-- → 422 bez zapisu; telefon → wymaga potwierdzenia. Dziennik zdarzeń nie
-- dostaje treści powodu — tylko flagę `reasonGiven` (i ewentualnie kategorie
-- potwierdzonych danych, bez tekstu).
--
-- Baza pilnuje:
--   * powód tylko przy statusie `rejected` (CHECK) — wniosek oczekujący,
--     zatwierdzony ani wygasły nie ma powodu;
--   * długość 3–500 znaków po obcięciu spacji na brzegach (pusty powód zapisuje
--     się jako NULL po stronie serwera);
--   * strażnik niezmienności pozwala ustawić powód WYŁĄCZNIE w tej samej
--     operacji zamknięcia (pending → rejected); po zamknięciu wiersz, w tym
--     powód, jest niezmienny jak dotąd.
--
-- Skutki dla danych: nowa kolumna `reject_reason` (NULL). Istniejące wiersze —
-- także już odrzucone — zostają bez powodu (NULL); niczego nie uzupełniamy
-- wstecznie, a historia i zdarzenia `role_grant_request.*` są bez zmian.
-- Wycofanie: przywrócenie funkcji strażnika z 0157, usunięcie CHECK i kolumny
-- (zapisane powody znikną — tylko po kopii zapasowej; w dzienniku zdarzeń
-- powodów i tak nie ma).

ALTER TABLE role_grant_requests ADD COLUMN reject_reason TEXT;

ALTER TABLE role_grant_requests ADD CONSTRAINT role_grant_requests_reject_reason_check
  CHECK (reject_reason IS NULL OR (status = 'rejected'
    AND reject_reason = btrim(reject_reason) AND char_length(reject_reason) BETWEEN 3 AND 500));

-- Od najnowszej definicji (0157); jedyna zmiana: gałąź reject_reason.
CREATE OR REPLACE FUNCTION role_grant_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- #146: powód odrzucenia tylko w tej samej operacji zamknięcia pending → rejected.
  IF NEW.reject_reason IS DISTINCT FROM OLD.reject_reason AND NEW.status <> 'rejected' THEN
    RAISE EXCEPTION 'role_grant_request_immutable';
  END IF;
  RETURN NEW;
END $$;
