-- Zasada czterech oczu przy zatwierdzeniu protokołu zebrania (issue #135,
-- SR-10). Nie zmienia danych: aktualizuje wyłącznie ciało funkcji triggera.
--
-- Co się zmienia:
-- * meeting_minutes_change_guard(): zatwierdzenie wersji protokołu
--   (status -> 'approved') przez tę samą osobę, która ją napisała
--   (approved_by = created_by), kończy się wyjątkiem
--   minutes_four_eyes_required. Działa też przy bezpośrednim UPDATE z
--   pominięciem API — serwis (src/pg/meetings.js, approveMinutes) sprawdza
--   to samo wcześniej i zwraca 403; trigger jest drugą linią obrony i przy
--   naruszeniu daje 409 (mapowanie w meetings.js, databaseError()).
-- * Wymóg MFA przy rozstrzygnięciu uchwały, zatwierdzeniu i publikacji
--   protokołu (parents/public) jest sprawdzany wyłącznie w serwisie:
--   sesja z potwierdzonym MFA to własność żądania (cookie), a nie danych
--   w tabeli, więc nie da się tego wyrazić w triggerze SQL.
--
-- Skutki dla danych: brak. Istniejące zatwierdzone protokoły (status =
-- 'approved') nie są sprawdzane wstecz — trigger UPDATE/DELETE i tak
-- odrzuca każdą zmianę wiersza już zatwierdzonego (minutes_approved_immutable,
-- sprawdzane przed nowym warunkiem), więc reguła czterech oczu dotyczy tylko
-- przyszłych zatwierdzeń.

CREATE OR REPLACE FUNCTION meeting_minutes_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'meeting_minutes_cannot_be_deleted'; END IF;
  IF OLD.status = 'approved' THEN RAISE EXCEPTION 'minutes_approved_immutable'; END IF;
  IF NEW.status <> 'approved' OR
     ROW(NEW.id, NEW.meeting_id, NEW.version, NEW.supersedes_id, NEW.body, NEW.change_note,
         NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.meeting_id, OLD.version, OLD.supersedes_id, OLD.body, OLD.change_note,
         OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'minutes_version_immutable';
  END IF;
  -- #135: zatwierdzający musi być inną osobą niż autor tej wersji.
  IF NEW.approved_by IS NOT DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'minutes_four_eyes_required';
  END IF;
  SELECT status INTO current_status FROM meetings WHERE id = OLD.meeting_id FOR UPDATE;
  IF current_status <> 'held' THEN RAISE EXCEPTION 'meeting_locked'; END IF;
  IF EXISTS (SELECT 1 FROM meeting_minutes WHERE supersedes_id = OLD.id) THEN
    RAISE EXCEPTION 'minutes_not_latest_version';
  END IF;
  NEW.approved_at := now();
  RETURN NEW;
END;
$$;
