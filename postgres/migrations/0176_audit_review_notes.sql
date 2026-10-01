-- Ścieżka kontroli Komisji Rewizyjnej: niezmienne uwagi, odpowiedzi,
-- zamknięcia i wnioski końcowe (#137, część niezależna od D-09). Prototyp —
-- nie jest wdrożony.
--
-- Problem: raport KR (GET /api/reports/audit) ma pustą sekcję „Uwagi Komisji
-- Rewizyjnej” do wypełnienia ręcznie na wydruku; nie ma gdzie zapisać pytania
-- do wpisu księgi lub uzgodnienia, odpowiedzi skarbnika ani wniosku z kontroli.
--
-- Co dodaje:
-- * audit_review_notes — jedna tabela dopisywana (append-only), cztery rodzaje
--   zapisów (kind):
--     question   uwaga/pytanie KR do obiektu (target_type + target_id);
--     finding    ustalenie KR do obiektu (jak pytanie, ale nie oczekuje
--                odpowiedzi — rozróżnienie jest tylko opisowe);
--     answer     odpowiedź zarządu/skarbnika na pytanie lub ustalenie
--                (parent_id wskazuje korzeń; kilka odpowiedzi na jeden korzeń
--                jest dozwolone);
--     closed     zamknięcie pytania/ustalenia przez KR (parent_id; najwyżej
--                jedno na korzeń; treść opcjonalna);
--     conclusion wniosek końcowy KR dla roku (target_type='year'). Wniosków
--                może być kilka — obowiązuje najnowszy; poprzedni nie jest
--                zmieniany (korekta = nowy zapis).
--   Cel (target_type): ledger_entry (wpis księgi roku), reconciliation
--   (uzgodnienie roku), year (cały rok; target_id = school_year_id). Istnienie
--   celu w tym samym roku pilnuje trigger audit_review_notes_guard (404 w API).
--   Nic nie jest edytowane ani usuwane: immutable_financial_record na UPDATE/
--   DELETE, deny_truncate na TRUNCATE, created_at ustawia zegar bazy
--   (a0_stamp_created_now). Zamknięcie pytania blokuje dalsze odpowiedzi
--   (audit_review_closed); odpowiedzieć musi INNA osoba niż autor pytania
--   (audit_review_four_eyes). Który rodzaj zapisu wolno któremu rolą —
--   KR: question/finding/closed/conclusion; zarząd i skarbnik: answer —
--   rozstrzyga trasa (src/pg/routes/audit-reviews.js), nie baza.
--   idempotency_key (UNIQUE, wymagany) — podwójne kliknięcie i ponowienie
--   dają jeden zapis. Zamknięty rok szkolny odrzuca nowe zapisy
--   (a0_year_freeze / school_year_closed) — wariant zachowawczy; czy KR może
--   dopisać wniosek po zamknięciu roku, rozstrzyga zarząd (D-09, D-21).
--
-- Skutki dla istniejących danych: tylko nowa tabela, funkcja i triggery;
-- żaden istniejący wiersz nie jest zmieniany ani usuwany. body to wolny tekst
-- (może zawierać imię i nazwisko) — przechodzi bramkę danych osobowych
-- (src/pg/pii-gate.js, audit_review_notes.body), a w audit_events zapisujemy
-- wyłącznie identyfikatory i rodzaj, nigdy treść. Tabela trafia do eksportu
-- rocznego (where school_year_id).
--
-- Wycofanie: DROP TABLE audit_review_notes; DROP FUNCTION
-- audit_review_notes_guard(). Na bazie z zapisami wyłącznie po kopii zapasowej
-- (wiersze są dowodem przebiegu kontroli; retencja: D-04).

CREATE TABLE audit_review_notes (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  kind TEXT NOT NULL CHECK (kind IN ('question', 'finding', 'answer', 'closed', 'conclusion')),
  target_type TEXT NOT NULL CHECK (target_type IN ('ledger_entry', 'reconciliation', 'year')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  parent_id TEXT REFERENCES audit_review_notes(id),
  body TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$'),
  CONSTRAINT audit_review_notes_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT audit_review_notes_parent_kind CHECK (
    (kind IN ('question', 'finding', 'conclusion') AND parent_id IS NULL)
    OR (kind IN ('answer', 'closed') AND parent_id IS NOT NULL)
  ),
  CONSTRAINT audit_review_notes_not_self CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT audit_review_notes_body CHECK (
    (kind = 'closed' AND (body IS NULL OR length(btrim(body)) BETWEEN 3 AND 2000))
    OR (kind <> 'closed' AND length(btrim(body)) BETWEEN 3 AND 2000)
  ),
  CONSTRAINT audit_review_notes_year_target CHECK (target_type <> 'year' OR target_id = school_year_id),
  CONSTRAINT audit_review_notes_conclusion_target CHECK (kind <> 'conclusion' OR target_type = 'year')
);
CREATE UNIQUE INDEX audit_review_notes_one_closure_idx
  ON audit_review_notes(parent_id) WHERE kind = 'closed';
CREATE INDEX audit_review_notes_year_idx ON audit_review_notes(school_year_id, created_at, id);
CREATE INDEX audit_review_notes_parent_idx ON audit_review_notes(parent_id) WHERE parent_id IS NOT NULL;

CREATE FUNCTION audit_review_notes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent audit_review_notes%ROWTYPE;
BEGIN
  IF NEW.parent_id IS NULL THEN
    IF NEW.target_type = 'ledger_entry' THEN
      IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE id = NEW.target_id AND school_year_id = NEW.school_year_id) THEN
        RAISE EXCEPTION 'audit_review_target_not_found';
      END IF;
    ELSIF NEW.target_type = 'reconciliation' THEN
      IF NOT EXISTS (SELECT 1 FROM bank_reconciliations WHERE id = NEW.target_id AND school_year_id = NEW.school_year_id) THEN
        RAISE EXCEPTION 'audit_review_target_not_found';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- FOR UPDATE szereguje równoległą odpowiedź i zamknięcie tego samego korzenia
  -- (oraz koliduje z FOR KEY SHARE z klucza obcego parent_id).
  SELECT * INTO parent FROM audit_review_notes WHERE id = NEW.parent_id FOR UPDATE;
  IF NOT FOUND OR parent.school_year_id <> NEW.school_year_id
     OR parent.kind NOT IN ('question', 'finding')
     OR parent.target_type <> NEW.target_type OR parent.target_id <> NEW.target_id THEN
    RAISE EXCEPTION 'audit_review_parent_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_review_notes WHERE parent_id = NEW.parent_id AND kind = 'closed') THEN
    RAISE EXCEPTION 'audit_review_closed';
  END IF;
  IF NEW.kind = 'answer' AND parent.created_by = NEW.created_by THEN
    RAISE EXCEPTION 'audit_review_four_eyes';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON audit_review_notes
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER a0_stamp_created_now BEFORE INSERT ON audit_review_notes
  FOR EACH ROW EXECUTE FUNCTION stamp_created_now('created_at');
CREATE TRIGGER audit_review_notes_guard_insert BEFORE INSERT ON audit_review_notes
  FOR EACH ROW EXECUTE FUNCTION audit_review_notes_guard();
CREATE TRIGGER audit_review_notes_no_change BEFORE UPDATE OR DELETE ON audit_review_notes
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER audit_review_notes_no_truncate BEFORE TRUNCATE ON audit_review_notes
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();
