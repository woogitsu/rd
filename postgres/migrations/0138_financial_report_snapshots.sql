-- Niezmienne, zatwierdzane migawki sprawozdania rocznego dla zebrania
-- ogólnego (#125). Prototyp — nie jest wdrożony.
--
-- Problem: GET /api/reports/annual (PR #382) składa sprawozdanie z bieżących
-- danych księgi, więc po korekcie w roku następnym wydruk różni się od tego,
-- co przedstawiono zebraniu. AGENTS.md: widok publiczny tylko z zatwierdzonych
-- danych — dotąd nie było mechanizmu zatwierdzenia sprawozdania.
--
-- Co dodaje:
-- * financial_report_snapshots — migawka: JSON sprawozdania (payload, bez pola
--   generatedAt; czas zapisu to created_at), skrót SHA-256 kanonicznego JSON-a
--   (content_sha256; liczy go aplikacja, odczyt sprawdza zgodność), autor,
--   opcjonalne odwołanie do poprzedniej migawki (supersedes_id) z powodem.
--   Korekta = NOWA migawka wskazująca poprzednią; wiersza nie zmienia się ani
--   nie usuwa (immutable_financial_record, BEFORE TRUNCATE deny_truncate).
--   Ten sam rok i ta sama treść (skrót) mogą wystąpić najwyżej raz — podwójne
--   kliknięcie i ponowienie zwracają istniejącą migawkę. W roku jest najwyżej
--   jedna migawka bez poprzednika i każda ma najwyżej jednego następcę, więc
--   historia jest łańcuchem, nie drzewem. Zamknięty rok odrzuca nowe migawki
--   (a0_year_freeze / school_year_closed).
-- * financial_report_snapshot_approvals — zatwierdzenie migawki (jedno na
--   migawkę): approved_by, approved_at. Zatwierdzić może INNA osoba niż autor
--   migawki (report_snapshot_four_eyes) i tylko migawkę bez następcy
--   (report_snapshot_superseded). Też niezmienne i objęte zamrożeniem roku.
--   Kto może zatwierdzać (zarząd; rola Komisji Rewizyjnej) i forma sprawozdania
--   (D-09, D-12, D-21) — rozstrzyga zarząd; aplikacja przyjmuje wariant
--   zachowawczy (tylko zarząd, świeże MFA).
-- * financial_report_snapshot_status — widok: migawka + następca + zatwierdzenie.
-- * school_year_closure_checklist.report_snapshot_id — punkt financial_report
--   listy zamknięcia może wskazywać zatwierdzoną migawkę (kolumna opcjonalna).
--
-- Skutki dla istniejących danych: tylko nowe tabele, widok, funkcje i
-- triggery oraz jedna nowa kolumna NULL w school_year_closure_checklist.
-- Żaden wiersz nie jest zmieniany ani usuwany. Migawki zawierają wyłącznie
-- dane zagregowane (bez opisów wpisów, osób i rodzin); powód korekty
-- (supersede_reason) to wolny tekst — patrz docs/DPIA_CHECKLIST.md.
--
-- Wycofanie: DROP VIEW financial_report_snapshot_status; ALTER TABLE
-- school_year_closure_checklist DROP COLUMN report_snapshot_id; DROP TABLE
-- financial_report_snapshot_approvals, financial_report_snapshots; DROP
-- FUNCTION financial_report_snapshot_guard(), financial_report_approval_guard().
-- Na bazie z zatwierdzonymi migawkami — wyłącznie po kopii zapasowej; wiersze
-- są dowodem tego, co przedstawiono zebraniu (retencja: D-04).

CREATE TABLE financial_report_snapshots (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  kind TEXT NOT NULL DEFAULT 'annual' CHECK (kind IN ('annual')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  supersedes_id TEXT REFERENCES financial_report_snapshots(id),
  supersede_reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT financial_report_snapshot_not_self CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT financial_report_snapshot_reason CHECK (
    (supersedes_id IS NULL AND supersede_reason IS NULL)
    OR (supersedes_id IS NOT NULL AND length(btrim(supersede_reason)) BETWEEN 3 AND 500)
  ),
  CONSTRAINT financial_report_snapshot_content_unique UNIQUE (school_year_id, kind, content_sha256)
);
CREATE UNIQUE INDEX financial_report_snapshots_root_idx
  ON financial_report_snapshots(school_year_id, kind) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX financial_report_snapshots_successor_idx
  ON financial_report_snapshots(supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE FUNCTION financial_report_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous financial_report_snapshots%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO previous FROM financial_report_snapshots WHERE id = NEW.supersedes_id;
    IF previous.school_year_id IS DISTINCT FROM NEW.school_year_id OR previous.kind IS DISTINCT FROM NEW.kind THEN
      RAISE EXCEPTION 'report_snapshot_supersedes_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON financial_report_snapshots
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER financial_report_snapshots_guard_insert BEFORE INSERT ON financial_report_snapshots
  FOR EACH ROW EXECUTE FUNCTION financial_report_snapshot_guard();
CREATE TRIGGER financial_report_snapshots_no_change BEFORE UPDATE OR DELETE ON financial_report_snapshots
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER financial_report_snapshots_no_truncate BEFORE TRUNCATE ON financial_report_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();

CREATE TABLE financial_report_snapshot_approvals (
  snapshot_id TEXT PRIMARY KEY REFERENCES financial_report_snapshots(id),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  approved_by TEXT NOT NULL REFERENCES users(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION financial_report_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot financial_report_snapshots%ROWTYPE;
BEGIN
  -- FOR UPDATE koliduje z FOR KEY SHARE, które bierze wstawienie następcy
  -- (klucz obcy supersedes_id): zatwierdzenie i korekta się szeregują.
  SELECT * INTO snapshot FROM financial_report_snapshots WHERE id = NEW.snapshot_id FOR UPDATE;
  IF NOT FOUND OR snapshot.school_year_id <> NEW.school_year_id THEN
    RAISE EXCEPTION 'report_snapshot_not_found';
  END IF;
  IF snapshot.created_by = NEW.approved_by THEN
    RAISE EXCEPTION 'report_snapshot_four_eyes';
  END IF;
  IF EXISTS (SELECT 1 FROM financial_report_snapshots WHERE supersedes_id = NEW.snapshot_id) THEN
    RAISE EXCEPTION 'report_snapshot_superseded';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON financial_report_snapshot_approvals
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER financial_report_approvals_guard_insert BEFORE INSERT ON financial_report_snapshot_approvals
  FOR EACH ROW EXECUTE FUNCTION financial_report_approval_guard();
CREATE TRIGGER financial_report_approvals_no_change BEFORE UPDATE OR DELETE ON financial_report_snapshot_approvals
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER financial_report_approvals_no_truncate BEFORE TRUNCATE ON financial_report_snapshot_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();

CREATE VIEW financial_report_snapshot_status AS
SELECT s.id, s.school_year_id, s.kind, s.content_sha256, s.supersedes_id, s.supersede_reason,
       s.created_by, s.created_at,
       n.id AS superseded_by_id,
       a.approved_by, a.approved_at
  FROM financial_report_snapshots s
  LEFT JOIN financial_report_snapshots n ON n.supersedes_id = s.id
  LEFT JOIN financial_report_snapshot_approvals a ON a.snapshot_id = s.id;

ALTER TABLE school_year_closure_checklist
  ADD COLUMN report_snapshot_id TEXT REFERENCES financial_report_snapshots(id);
