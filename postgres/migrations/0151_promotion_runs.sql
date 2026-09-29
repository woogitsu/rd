-- Masowa promocja uczniów na nowy rok szkolny (#78, punkty 2-3 propozycji).
--
-- Skutki dla danych:
-- * Nowa tabela promotion_runs: jeden wiersz na zatwierdzoną promocję
--   (aktor, rok źródłowy i docelowy, klucz idempotencji, skrót planu, liczby).
--   Unikalny idempotency_key pozwala serwerowi zwrócić ten sam wynik przy
--   ponowieniu; wiersze są tylko do dopisywania (trigger z 0014).
-- * Bez nazwisk, imion i list uczniów — tylko identyfikatory lat i liczby.
--   Lista przypisań to zwykłe wiersze enrollments (nowe, w roku docelowym)
--   z historią w enrollment_history (powód 'promotion').
-- * Istniejące dane (enrollments, enrollment_history, klasy, przydziały) nie
--   są zmieniane. Zamrożenie zamkniętego roku dla enrollments już działa (0054).
-- Wycofanie: na pustej bazie usunąć tabelę i indeks; na bazie z promocjami
-- tylko po kopii zapasowej (znika rejestr idempotencji, nie same przypisania).

CREATE TABLE promotion_runs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  from_school_year_id TEXT NOT NULL REFERENCES school_years(id),
  to_school_year_id TEXT NOT NULL REFERENCES school_years(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  plan_digest TEXT NOT NULL CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
  promoted_count INTEGER NOT NULL CHECK (promoted_count > 0),
  graduating_count INTEGER NOT NULL CHECK (graduating_count >= 0),
  unmapped_count INTEGER NOT NULL CHECK (unmapped_count >= 0),
  excluded_count INTEGER NOT NULL CHECK (excluded_count >= 0),
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0),
  withdrawn_count INTEGER NOT NULL CHECK (withdrawn_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT promotion_runs_years_differ CHECK (from_school_year_id <> to_school_year_id)
);
CREATE INDEX promotion_runs_years_idx ON promotion_runs(to_school_year_id, from_school_year_id, created_at);

CREATE TRIGGER promotion_runs_no_change BEFORE UPDATE OR DELETE ON promotion_runs
  FOR EACH ROW EXECUTE FUNCTION family_history_immutable();
