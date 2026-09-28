-- Rejestr uchwał roku: relacje zmienia/uchyla, podpowiedź numeru i śledzenie
-- wykonania (issue #102).
--
-- Skutki dla danych:
-- * `resolutions.relation_kind` ('amends'|'repeals'): wymagane razem z
--   `amends_resolution_id` (oba NULL albo oba ustawione). Istniejące wiersze
--   z ustawionym `amends_resolution_id` (jeśli jakieś są) dostają NULL — ich
--   rodzaj relacji nie jest znany wstecznie; trigger odtąd wymaga podania
--   rodzaju przy każdym nowym powiązaniu, więc stare powiązania bez rodzaju
--   trzeba będzie opisać ręcznie, jeśli mają się pojawić w rejestrze jako
--   „zmienia”/„uchyla” (opisane w docs/MEETINGS.md).
-- * `resolutions.relation_cross_year` (domyślnie false): jawna zgoda na to,
--   że `amends_resolution_id` wskazuje uchwałę innego roku szkolnego.
-- * Trigger `resolution_guard`: `amends_resolution_id` musi wskazywać
--   BIEŻĄCĄ rewizję (`resolution_current`) przyjętej uchwały (już tak było —
--   teraz sprawdzane jawnie przez `resolution_current`, a wcześniej można
--   było wskazać nieaktualną rewizję, bo `resolutions` obejmuje wszystkie
--   rewizje); z innego roku tylko z `relation_cross_year = true`.
-- * Widok `resolution_effective_status`: 'in_force' | 'amended' | 'repealed'
--   (dla `draft`/`rejected`/`withdrawn` — ten sam status co w `resolutions`,
--   relacje dotyczą wyłącznie uchwał przyjętych). Liczony z relacji, nie
--   zapisywany — korekta ani nowa uchwała nie nadpisuje żadnego wiersza.
-- * `findAdoptedResolution` i `ledger_resolution_links` (0009) zwracają teraz
--   też `effective_status`, żeby księga i wyszukiwarka pokazały, że uchwała
--   została uchylona, zamiast milcząco traktować ją jak obowiązującą.
-- * Tabela `resolution_execution_events` (tylko dopisywanie, jak
--   `meeting_quorum_checks`): stan wykonania uchwały jako historia zdarzeń,
--   nigdy nadpisywana. Można dopisywać także po zatwierdzeniu protokołu —
--   tabela nie jest objęta `meeting_assert_editable` (osobna sprawa niż
--   zmiana samej uchwały czy zebrania).
-- * `school_years.resolution_number_pattern` (np. '{seq}/{year}'): wyłącznie
--   PODPOWIEDŹ następnego numeru (`suggestedNumber` w odpowiedzi API). Puste
--   pole (domyślnie, do decyzji D-15) wyłącza podpowiedź; nic nie jest
--   narzucane, unikalność numeru nadal pilnuje istniejący indeks
--   `resolutions_number_per_year_idx`.

ALTER TABLE resolutions
  ADD COLUMN relation_kind TEXT CHECK (relation_kind IN ('amends', 'repeals')),
  ADD COLUMN relation_cross_year BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE resolutions
  ADD CONSTRAINT resolution_relation_kind_requires_target
    CHECK ((amends_resolution_id IS NULL) = (relation_kind IS NULL)),
  ADD CONSTRAINT resolution_relation_cross_year_needs_target
    CHECK (NOT relation_cross_year OR amends_resolution_id IS NOT NULL);

ALTER TABLE school_years
  ADD COLUMN resolution_number_pattern TEXT
    CHECK (resolution_number_pattern IS NULL OR length(btrim(resolution_number_pattern)) BETWEEN 1 AND 100);

-- resolution_current (0009) jest zdefiniowany jako "SELECT r.* FROM resolutions
-- r …": lista kolumn widoku jest ustalona w chwili CREATE VIEW i ALTER TABLE
-- powyżej jej nie rozszerza. Trzeba odtworzyć widok (i jego jedyną zależność,
-- ledger_resolution_links), żeby relation_kind/relation_cross_year były w nim
-- widoczne. Sam SELECT jest identyczny jak w 0009.
DROP VIEW ledger_resolution_links;
DROP VIEW resolution_current;
CREATE VIEW resolution_current AS
SELECT r.* FROM resolutions r
WHERE NOT EXISTS (SELECT 1 FROM resolutions newer WHERE newer.corrects_id = r.id);

-- Zastępuje resolution_guard z 0037 (#205, ostatnia wersja na origin/main —
-- patrz 0037_scope_reference_checks.sql): dodaje sprawdzenie bieżącej rewizji
-- i roku dla amends_resolution_id przez relation_cross_year, ZACHOWUJĄC
-- sprawdzenie zakresu klasy z #205 (amended_meeting/this_meeting). Reszta
-- funkcji jest bez zmian względem 0037.
CREATE OR REPLACE FUNCTION resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous resolutions%ROWTYPE;
DECLARE current_status TEXT;
DECLARE present_count INTEGER;
DECLARE amended resolution_current%ROWTYPE;
DECLARE amended_meeting meetings%ROWTYPE;
DECLARE this_meeting meetings%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'resolutions_cannot_be_deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'resolution_final_immutable'; END IF;
    IF ROW(NEW.id, NEW.school_year_id, NEW.meeting_id, NEW.revision, NEW.corrects_id,
           NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.school_year_id, OLD.meeting_id, OLD.revision, OLD.corrects_id,
           OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'resolution_identity_immutable';
    END IF;
  END IF;
  PERFORM meeting_assert_editable(NEW.meeting_id);
  IF TG_OP = 'INSERT' AND NEW.corrects_id IS NOT NULL THEN
    SELECT * INTO previous FROM resolutions WHERE id = NEW.corrects_id FOR UPDATE;
    IF NOT FOUND OR previous.status NOT IN ('adopted', 'rejected')
       OR previous.meeting_id <> NEW.meeting_id
       OR previous.school_year_id <> NEW.school_year_id
       OR previous.number IS DISTINCT FROM NEW.number
       OR NEW.revision <> previous.revision + 1 THEN
      RAISE EXCEPTION 'resolution_correction_mismatch';
    END IF;
  END IF;
  IF NEW.amends_resolution_id IS NOT NULL THEN
    -- #102: musi być bieżąca rewizja (resolution_current) przyjętej uchwały;
    -- z innego roku tylko z jawną zgodą (relation_cross_year).
    SELECT * INTO amended FROM resolution_current WHERE id = NEW.amends_resolution_id;
    IF NOT FOUND OR amended.status <> 'adopted' THEN
      RAISE EXCEPTION 'resolution_amends_requires_adopted';
    END IF;
    IF amended.school_year_id <> NEW.school_year_id AND NOT NEW.relation_cross_year THEN
      RAISE EXCEPTION 'resolution_amends_cross_year_requires_flag';
    END IF;
    -- #205 (zachowane z 0037): zebranie klasowe może zmieniać/uchylać tylko
    -- uchwałę tej samej klasy albo zebrania ogólnego, niezależnie od roku.
    SELECT * INTO this_meeting FROM meetings WHERE id = NEW.meeting_id;
    SELECT * INTO amended_meeting FROM meetings WHERE id = amended.meeting_id;
    IF this_meeting.class_id IS NOT NULL AND amended_meeting.class_id IS NOT NULL
       AND amended_meeting.class_id <> this_meeting.class_id THEN
      RAISE EXCEPTION 'invalid_reference';
    END IF;
  END IF;
  IF NEW.status IN ('adopted', 'rejected') THEN
    SELECT status INTO current_status FROM meetings WHERE id = NEW.meeting_id;
    IF current_status <> 'held' THEN RAISE EXCEPTION 'resolution_requires_held_meeting'; END IF;
    SELECT present_eligible INTO present_count FROM meeting_quorum_checks
      WHERE id = NEW.quorum_check_id AND meeting_id = NEW.meeting_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'resolution_quorum_check_required'; END IF;
    IF COALESCE(NEW.votes_for, 0) + COALESCE(NEW.votes_against, 0)
       + COALESCE(NEW.votes_abstain, 0) > present_count THEN
      RAISE EXCEPTION 'resolution_votes_exceed_present_voters';
    END IF;
    NEW.decided_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Status obowiązywania liczony z relacji, bez modyfikacji wiersza uchwały.
-- Dotyczy tylko uchwał przyjętych; draft/rejected/withdrawn zostają bez zmian.
CREATE VIEW resolution_effective_status AS
SELECT rc.id,
  CASE
    WHEN rc.status <> 'adopted' THEN rc.status
    WHEN EXISTS (
      SELECT 1 FROM resolution_current later
       WHERE later.amends_resolution_id = rc.id AND later.relation_kind = 'repeals' AND later.status = 'adopted'
    ) THEN 'repealed'
    WHEN EXISTS (
      SELECT 1 FROM resolution_current later
       WHERE later.amends_resolution_id = rc.id AND later.relation_kind = 'amends' AND later.status = 'adopted'
    ) THEN 'amended'
    ELSE 'in_force'
  END AS effective_status
FROM resolution_current rc;

-- Śledzenie wykonania uchwały: tylko dopisywanie, jak inne tabele zdarzeń w
-- tym module. Bieżący stan wykonania to ostatnie zdarzenie (created_at DESC).
-- Osoba odpowiedzialna to konto (users), nie opiekun ani nazwisko w tekście.
CREATE TABLE resolution_execution_events (
  id TEXT PRIMARY KEY,
  resolution_id TEXT NOT NULL REFERENCES resolutions(id),
  status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'done', 'will_not_be_done')),
  responsible_user_id TEXT REFERENCES users(id),
  due_on DATE,
  note TEXT CHECK (note IS NULL OR length(btrim(note)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX resolution_execution_events_idx ON resolution_execution_events(resolution_id, created_at);
CREATE TRIGGER resolution_execution_events_no_change BEFORE UPDATE OR DELETE ON resolution_execution_events
  FOR EACH ROW EXECUTE FUNCTION meeting_record_immutable();

-- #102 (punkt 6): księga i wyszukiwarka uchwały pokazują, że uchwała jest
-- uchylona lub zmieniona, zamiast milcząco traktować ją jak obowiązującą.
-- Warunek złączenia (rok, numer, status = 'adopted') jest identyczny jak w
-- 0009 — zmienia się wyłącznie dodana kolumna effective_status. Odtworzony
-- (nie CREATE OR REPLACE), bo został usunięty razem z resolution_current wyżej.
CREATE VIEW ledger_resolution_links AS
SELECT e.id AS ledger_entry_id, e.school_year_id, e.amount_cents,
  e.resolution_reference, r.id AS resolution_id, r.status AS resolution_status,
  es.effective_status
FROM ledger_entries e
LEFT JOIN resolution_current r
  ON r.school_year_id = e.school_year_id
 AND r.number = btrim(e.resolution_reference)
 AND r.status = 'adopted'
LEFT JOIN resolution_effective_status es ON es.id = r.id
WHERE e.resolution_reference IS NOT NULL;
