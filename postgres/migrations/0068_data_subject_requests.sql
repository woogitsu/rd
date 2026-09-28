-- Rejestr żądań osób (RODO): dostęp, sprostowanie, usunięcie, ograniczenie,
-- sprzeciw, przenoszenie (#100). Wariant zachowawczy tej migracji: wyłącznie
-- rejestr i przejścia stanu. Eksport danych jednej rodziny, sprostowanie
-- identyfikacyjne i ograniczenie przetwarzania (pkt 2, 3, 4, 5 propozycji w
-- issue) NIE są tu zaimplementowane — zależą od D-07 (kto przyjmuje, termin,
-- weryfikacja tożsamości) i D-08/D-09 (kto ma dostęp do rejestru); patrz opis
-- w PR.
--
-- Skutki dla danych:
--   * nowa tabela; brak wstecznego wypełnienia (żądania sprzed tej migracji
--     nie mają tu wpisu — jeśli istniały poza systemem, zostają poza nim);
--   * bez treści żądania i bez danych kontaktowych wnioskodawcy (tylko
--     identyfikatory obiektu i odwołanie do dokumentu poza repo/panelem —
--     `decision_note_ref` to referencja, nie treść);
--   * wiersz nie jest nigdy usuwany; trigger dopuszcza tylko przejście
--     status → dalszy status z listy oraz uzupełnienie handled_by/
--     decision_note_ref/due_on, nigdy cofnięcie ani zmianę kind/obiektu.
CREATE TABLE data_subject_requests (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'rectification', 'erasure', 'restriction', 'objection', 'portability')),
  household_id TEXT REFERENCES households(id),
  guardian_id TEXT REFERENCES guardians(id),
  student_id TEXT REFERENCES students(id),
  received_on DATE NOT NULL,
  -- Termin odpowiedzi: do decyzji D-07 (liczba dni z konfiguracji). Do tego
  -- czasu wpisywany ręcznie przez obsługującego, może zostać NULL.
  due_on DATE,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'identity_verified', 'in_progress', 'answered', 'rejected')),
  handled_by TEXT REFERENCES users(id),
  decision_note_ref TEXT CHECK (decision_note_ref IS NULL OR length(btrim(decision_note_ref)) BETWEEN 1 AND 200),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (household_id IS NOT NULL OR guardian_id IS NOT NULL OR student_id IS NOT NULL)
);
CREATE INDEX data_subject_requests_status_idx ON data_subject_requests(status, due_on);
CREATE INDEX data_subject_requests_household_idx ON data_subject_requests(household_id) WHERE household_id IS NOT NULL;

-- Kolejność stanów (bez cofania): received -> identity_verified -> in_progress
-- -> answered | rejected. `answered`/`rejected` są końcowe.
CREATE FUNCTION data_subject_request_status_rank(status TEXT) RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE status
    WHEN 'received' THEN 0
    WHEN 'identity_verified' THEN 1
    WHEN 'in_progress' THEN 2
    WHEN 'answered' THEN 3
    WHEN 'rejected' THEN 3
  END
$$;

CREATE FUNCTION data_subject_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'data_subject_request_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.household_id IS DISTINCT FROM OLD.household_id
     OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.received_on IS DISTINCT FROM OLD.received_on
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'data_subject_request_identity_immutable';
  END IF;
  IF data_subject_request_status_rank(NEW.status) < data_subject_request_status_rank(OLD.status) THEN
    RAISE EXCEPTION 'data_subject_request_status_cannot_go_back';
  END IF;
  IF OLD.status IN ('answered', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'data_subject_request_already_closed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER data_subject_requests_guard BEFORE UPDATE OR DELETE ON data_subject_requests
  FOR EACH ROW EXECUTE FUNCTION data_subject_request_guard();
