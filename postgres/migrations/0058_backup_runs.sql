-- Dziennik przebiegów kopii zapasowej PostgreSQL i próbnego odtworzenia
-- (issue #90). Tabela wyłącznie do dopisywania (jak email_worker_runs w
-- 0007_email.sql) — korekta to nowy wiersz, historia nigdy nie jest
-- nadpisywana ani czyszczona.
--
-- Kolumna `kind` obejmuje też 'storage_backup' (kopia prywatnego bucketu
-- dokumentów, issue #103) — ten sam dziennik, żeby #149 (widok „Stan
-- systemu”) miał jedno źródło dla „ostatni udany backup”. Jeśli #103
-- scali się przed tym PR-em, ten plik nie koliduje: nazwa tabeli i kolumny
-- są z nim zgodne (patrz uzasadnienie w scripts/backup-storage.js, gdy
-- powstanie).
--
-- Brak nazw plików, adresu bazy, nazwy bucketu i danych osobowych — tylko
-- liczby, znaczniki czasu, kody i skróty SHA-256 zaszyfrowanej paczki.
CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('backup', 'restore_drill', 'storage_backup')),
  environment TEXT NOT NULL CHECK (environment ~ '^[a-z0-9_-]{1,40}$'),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
  -- Klucz obiektu w magazynie kopii (np. backups/rd-postgres-2026-09-28.enc).
  -- Nigdy nie jest kluczem obiektu dokumentu rodzica/ucznia.
  object_key TEXT CHECK (object_key ~ '^[a-z0-9/_.-]{1,200}$'),
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 TEXT CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Liczności i sumy kontrolne (np. household_payment_totals, ledger_year_summary,
  -- documents) — bez danych osobowych, tylko techniczne zestawienie.
  row_counts JSONB,
  sums JSONB,
  error_code TEXT CHECK (error_code ~ '^[a-z0-9_]{1,60}$'),
  CHECK (result = 'success' OR error_code IS NOT NULL),
  CHECK (finished_at >= started_at)
);
CREATE INDEX backup_runs_kind_finished_idx ON backup_runs(kind, finished_at DESC);

CREATE FUNCTION backup_runs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%_are_append_only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER backup_runs_append_only BEFORE UPDATE OR DELETE ON backup_runs
  FOR EACH ROW EXECUTE FUNCTION backup_runs_append_only();
