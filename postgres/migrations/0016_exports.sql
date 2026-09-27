-- Rejestr eksportów rocznych i list klas (issue #9).
--
-- Skutki dla danych: nowa tabela, bez zmian w istniejących tabelach i bez
-- migracji danych. Tabela przechowuje wyłącznie metadane przebiegu: rok,
-- (opcjonalnie) klasę, wersję formatu, kto i kiedy zlecił, SHA-256 manifestu
-- i liczby wierszy per tabela. Nie przechowuje treści eksportu ani danych
-- osobowych — sam plik eksportu trafia wyłącznie do osoby zlecającej.
-- Wiersze są niezmienne (trigger); korekta = nowy przebieg.

CREATE TABLE export_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('yearly', 'class_roster')),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  class_id TEXT REFERENCES classes(id),
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  requested_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  row_counts JSONB NOT NULL CHECK (jsonb_typeof(row_counts) = 'object'),
  CONSTRAINT export_runs_roster_class CHECK ((kind = 'class_roster') = (class_id IS NOT NULL))
);
CREATE INDEX export_runs_year_idx ON export_runs(school_year_id, created_at);

CREATE FUNCTION export_run_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'export_runs_cannot_be_changed';
END;
$$;
CREATE TRIGGER export_runs_no_change BEFORE UPDATE OR DELETE ON export_runs
  FOR EACH ROW EXECUTE FUNCTION export_run_immutable();
