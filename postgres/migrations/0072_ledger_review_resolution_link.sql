-- Zasada czterech oczu przy wydatkach (#97) i uchwała jako upoważnienie do
-- wydatku (#93): weryfikacja wpisu przez drugą osobę, jawne powiązanie wpisu
-- księgi z uchwałą i kwota upoważnienia.
--
-- Co zmienia:
-- * ledger_entries.resolution_id (NULL, FK do resolutions): jawne wskazanie
--   uchwały. Tekst resolution_reference zostaje (zgodność z D1 i CHECK
--   ledger_large_expense_resolution z 0003). Wpis jest niezmienny, więc
--   powiązanie ustala się tylko przy zapisie; zmiana powiązania to
--   przeksięgowanie (#144, storno + nowy wpis), nie edycja.
-- * Trigger c0_ledger_resolution_guard (BEFORE INSERT ON ledger_entries):
--   uchwała musi być bieżącą rewizją (bez nowszej poprawki), przyjętą, z
--   zebrania ogólnego (meetings.class_id IS NULL), z roku wpisu albo
--   wcześniejszego; wpis musi być wydatkiem. Gdy uchwała ma kwotę
--   upoważnienia: data wpisu nie później niż valid_until, a suma netto
--   powiązanych wydatków (ledger_entry_net, z korektami) + nowa kwota nie
--   przekracza kwoty. Wiersz uchwały jest blokowany (FOR UPDATE), więc dwa
--   równoległe wydatki serializują się. Jeśli istnieje widok
--   resolution_effective_status (#102/#283), uchwała uchylona jest odrzucana.
-- * Tabela resolution_spending_authorizations (tylko dopisywanie): kwota
--   upoważnienia z uchwały i opcjonalny termin. Zmiana = nowy wiersz z
--   supersedes_id (UNIQUE), poprzedni zostaje. Kwotę wpisuje zarząd/admin
--   przez API; nie jest polem resolutions, bo przyjęta uchwała jest niezmienna
--   (resolution_guard) i ten PR nie zmienia modułu zebrań.
-- * Funkcja resolution_chain_ids(id): bieżąca rewizja i wszystkie
--   poprzednie (corrects_id), żeby wydatki i kwota powiązane z rewizją sprzed
--   poprawki uchwały liczyły się dalej.
-- * Widok resolution_spending: bieżąca rewizja uchwały, kwota upoważnienia,
--   suma netto powiązanych wydatków, pozostało, liczba wpisów. Nie zależy od
--   resolution_current ani ledger_resolution_links (0060/#283 odtwarza te
--   widoki przez DROP VIEW).
-- * Tabela ledger_entry_reviews (tylko dopisywanie): weryfikacja wydatku
--   (verified / questioned) przez osobę inną niż autor wpisu (trigger, poza
--   API też). Stan pochodny (widok ledger_entry_review_status): ostatnia
--   decyzja albo 'unverified'. Weryfikacja NIE zmienia bilansu.
-- * Obie nowe tabele mają school_year_id i trigger a0_year_freeze
--   (year_freeze_direct z 0017), więc zamknięty rok odrzuca zapis bez zmiany
--   year_freeze_via_parent.
--
-- Skutki dla istniejących danych: żaden wiersz nie jest zmieniany ani
-- usuwany. Istniejące wpisy mają resolution_id = NULL (raport KR pokazuje je
-- jako „powiązanie tekstowe”) i nie mają weryfikacji, więc wszystkie
-- historyczne wydatki mają stan „niezweryfikowany”. Istniejące uchwały nie mają
-- kwoty upoważnienia (brak limitu kwoty do czasu jej wpisania — D-15).
--
-- Znane ograniczenie: eksport roczny (src/pg/export.js, PR #281) nie obejmuje
-- jeszcze nowych tabel; kolumna resolution_id eksportuje się razem z
-- ledger_entries.
--
-- Wycofanie: DROP VIEW resolution_spending, ledger_entry_review_status;
-- DROP TABLE ledger_entry_reviews, resolution_spending_authorizations;
-- DROP TRIGGER c0_ledger_resolution_guard ON ledger_entries;
-- DROP FUNCTION ledger_entry_resolution_guard(), ledger_review_guard(),
-- resolution_authorization_guard(), resolution_chain_ids(TEXT);
-- ALTER TABLE ledger_entries DROP COLUMN resolution_id (po sprawdzeniu, że nie
-- ma powiązań do zachowania).

ALTER TABLE ledger_entries ADD COLUMN resolution_id TEXT REFERENCES resolutions(id);
CREATE INDEX ledger_entries_resolution_idx ON ledger_entries(resolution_id) WHERE resolution_id IS NOT NULL;

CREATE FUNCTION resolution_chain_ids(p_resolution_id TEXT) RETURNS SETOF TEXT
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain(id) AS (
    SELECT p_resolution_id
    UNION
    SELECT r.corrects_id FROM resolutions r JOIN chain c ON r.id = c.id WHERE r.corrects_id IS NOT NULL
  )
  SELECT id FROM chain
$$;

CREATE TABLE resolution_spending_authorizations (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  resolution_id TEXT NOT NULL REFERENCES resolutions(id),
  authorized_amount_cents BIGINT NOT NULL CHECK (authorized_amount_cents BETWEEN 1 AND 100000000),
  valid_until DATE,
  note TEXT NOT NULL CHECK (length(btrim(note)) BETWEEN 3 AND 500),
  supersedes_id TEXT UNIQUE REFERENCES resolution_spending_authorizations(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
-- Jeden „pierwszy” wiersz na uchwałę; kolejne tylko jako następcy.
CREATE UNIQUE INDEX resolution_spending_authorizations_root_idx
  ON resolution_spending_authorizations(resolution_id) WHERE supersedes_id IS NULL;

CREATE FUNCTION resolution_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target resolutions%ROWTYPE;
DECLARE previous resolution_spending_authorizations%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'resolution_authorizations_are_immutable'; END IF;
  SELECT * INTO target FROM resolutions WHERE id = NEW.resolution_id;
  IF NOT FOUND OR target.school_year_id <> NEW.school_year_id THEN
    RAISE EXCEPTION 'resolution_authorization_mismatch';
  END IF;
  IF target.status <> 'adopted' OR EXISTS (SELECT 1 FROM resolutions n WHERE n.corrects_id = target.id) THEN
    RAISE EXCEPTION 'resolution_authorization_requires_adopted';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO previous FROM resolution_spending_authorizations WHERE id = NEW.supersedes_id;
    IF NOT FOUND OR previous.resolution_id NOT IN (SELECT resolution_chain_ids(NEW.resolution_id)) THEN
      RAISE EXCEPTION 'resolution_authorization_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resolution_spending_authorizations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON resolution_spending_authorizations
  FOR EACH ROW EXECUTE FUNCTION resolution_authorization_guard();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON resolution_spending_authorizations
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

-- Bieżąca kwota upoważnienia: najnowszy wiersz w łańcuchu rewizji uchwały,
-- który nie ma następcy.
CREATE VIEW resolution_authorization_current AS
SELECT a.* FROM resolution_spending_authorizations a
WHERE NOT EXISTS (SELECT 1 FROM resolution_spending_authorizations n WHERE n.supersedes_id = a.id);

CREATE FUNCTION ledger_entry_resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target resolutions%ROWTYPE;
DECLARE target_class TEXT;
DECLARE target_year_start DATE;
DECLARE entry_year_start DATE;
DECLARE auth resolution_spending_authorizations%ROWTYPE;
DECLARE spent BIGINT;
DECLARE effective TEXT;
BEGIN
  IF NEW.resolution_id IS NULL THEN RETURN NEW; END IF;
  -- Blokada wiersza uchwały: równoległe wydatki na tę samą uchwałę czekają na siebie.
  SELECT * INTO target FROM resolutions WHERE id = NEW.resolution_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger_resolution_not_found'; END IF;
  IF NEW.direction <> 'expense' THEN RAISE EXCEPTION 'ledger_resolution_expense_only'; END IF;
  SELECT class_id INTO target_class FROM meetings WHERE id = target.meeting_id;
  SELECT starts_on INTO target_year_start FROM school_years WHERE id = target.school_year_id;
  SELECT starts_on INTO entry_year_start FROM school_years WHERE id = NEW.school_year_id;
  IF target_class IS NOT NULL OR target_year_start > entry_year_start THEN
    RAISE EXCEPTION 'ledger_resolution_out_of_scope';
  END IF;
  IF EXISTS (SELECT 1 FROM resolutions n WHERE n.corrects_id = target.id) THEN
    RAISE EXCEPTION 'ledger_resolution_not_current';
  END IF;
  IF target.status <> 'adopted' THEN RAISE EXCEPTION 'ledger_resolution_not_adopted'; END IF;
  IF to_regclass('resolution_effective_status') IS NOT NULL THEN
    EXECUTE 'SELECT effective_status FROM resolution_effective_status WHERE id = $1' INTO effective USING target.id;
    IF effective = 'repealed' THEN RAISE EXCEPTION 'ledger_resolution_repealed'; END IF;
  END IF;
  SELECT a.* INTO auth FROM resolution_authorization_current a
   WHERE a.resolution_id IN (SELECT resolution_chain_ids(target.id))
   ORDER BY a.created_at DESC, a.id DESC LIMIT 1;
  IF FOUND THEN
    IF auth.valid_until IS NOT NULL AND NEW.occurred_on > auth.valid_until THEN
      RAISE EXCEPTION 'ledger_resolution_expired';
    END IF;
    SELECT COALESCE(sum(n.net_amount_cents), 0) INTO spent
      FROM ledger_entries e JOIN ledger_entry_net n ON n.id = e.id
     WHERE e.resolution_id IN (SELECT resolution_chain_ids(target.id)) AND e.direction = 'expense';
    IF spent + NEW.amount_cents > auth.authorized_amount_cents THEN
      RAISE EXCEPTION 'ledger_resolution_amount_exceeded';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c0_ledger_resolution_guard BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_resolution_guard();

-- Wykonanie uchwał: bieżąca rewizja, kwota, suma netto wydatków (całego
-- łańcucha rewizji), pozostało. Tylko uchwały z kwotą lub z powiązanym wydatkiem.
CREATE VIEW resolution_spending AS
SELECT r.id AS resolution_id, r.school_year_id, r.number, r.title, r.status,
  auth.authorized_amount_cents, auth.valid_until,
  COALESCE(spending.spent_net_cents, 0) AS spent_net_cents,
  auth.authorized_amount_cents - COALESCE(spending.spent_net_cents, 0) AS remaining_cents,
  COALESCE(spending.entry_count, 0) AS entry_count
FROM resolutions r
LEFT JOIN LATERAL (
  SELECT a.authorized_amount_cents, a.valid_until FROM resolution_authorization_current a
   WHERE a.resolution_id IN (SELECT resolution_chain_ids(r.id))
   ORDER BY a.created_at DESC, a.id DESC LIMIT 1
) auth ON true
LEFT JOIN LATERAL (
  SELECT sum(n.net_amount_cents)::BIGINT AS spent_net_cents, count(*) AS entry_count
    FROM ledger_entries e JOIN ledger_entry_net n ON n.id = e.id
   WHERE e.resolution_id IN (SELECT resolution_chain_ids(r.id)) AND e.direction = 'expense'
) spending ON true
WHERE NOT EXISTS (SELECT 1 FROM resolutions newer WHERE newer.corrects_id = r.id)
  AND (auth.authorized_amount_cents IS NOT NULL OR COALESCE(spending.entry_count, 0) > 0);

CREATE TABLE ledger_entry_reviews (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
  decision TEXT NOT NULL CHECK (decision IN ('verified', 'questioned')),
  note TEXT CHECK (note IS NULL OR length(btrim(note)) BETWEEN 3 AND 500),
  reviewed_by TEXT NOT NULL REFERENCES users(id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  CONSTRAINT ledger_review_question_needs_note CHECK (decision <> 'questioned' OR note IS NOT NULL)
);
CREATE INDEX ledger_entry_reviews_entry_idx ON ledger_entry_reviews(ledger_entry_id, reviewed_at DESC, id);

CREATE FUNCTION ledger_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry ledger_entries%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'ledger_reviews_are_immutable'; END IF;
  SELECT * INTO entry FROM ledger_entries WHERE id = NEW.ledger_entry_id;
  IF NOT FOUND OR entry.school_year_id <> NEW.school_year_id THEN RAISE EXCEPTION 'ledger_review_mismatch'; END IF;
  IF entry.direction <> 'expense' THEN RAISE EXCEPTION 'ledger_review_expense_only'; END IF;
  IF entry.created_by = NEW.reviewed_by THEN RAISE EXCEPTION 'ledger_review_four_eyes'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_entry_reviews_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_entry_reviews
  FOR EACH ROW EXECUTE FUNCTION ledger_review_guard();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_entry_reviews
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();

-- Stan weryfikacji wydatku: ostatnia decyzja albo 'unverified'.
CREATE VIEW ledger_entry_review_status AS
SELECT e.id AS ledger_entry_id, e.school_year_id,
  COALESCE(last.decision, 'unverified') AS review_status,
  last.reviewed_by AS last_reviewed_by, last.reviewed_at AS last_reviewed_at,
  (SELECT count(*) FROM ledger_entry_reviews c WHERE c.ledger_entry_id = e.id) AS review_count
FROM ledger_entries e
LEFT JOIN LATERAL (
  SELECT r.decision, r.reviewed_by, r.reviewed_at FROM ledger_entry_reviews r
   WHERE r.ledger_entry_id = e.id ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1
) last ON true
WHERE e.direction = 'expense';
