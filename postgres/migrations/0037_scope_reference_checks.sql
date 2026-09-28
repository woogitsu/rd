-- Issue #205: identyfikatory w treści żądań nie są sprawdzane względem
-- zakresu — pilnowane najwyżej kluczem obcym (FK jako wyrocznia istnienia:
-- 200 dla identyfikatora z innej klasy/roku, 400/422 tylko dla identyfikatora,
-- który nie istnieje wcale).
--
-- Ta migracja NIE zmienia żadnych danych, tylko rozszerza dwie istniejące
-- funkcje triggerów (CREATE OR REPLACE — te same triggery z 0009 nadal ich
-- używają, więc nic nie trzeba dodatkowo podłączać):
--
-- 1. meeting_attendee_guard (0009, trigger meeting_attendees_guard): dodano
--    warunek na guardian_id, TYLKO gdy capacity='guardian' (opiekun obecny w
--    tej roli — dokładnie przypadek z reprodukcji #205 i ten, który liczy
--    się do quorum jako głos rodzica): musi mieć aktywną relację
--    student_guardians z uczniem zapisanym (enrollments) w klasie zebrania
--    (zebranie klasowe) albo w dowolnej klasie roku zebrania (zebranie
--    plenarne/zarządu, class_id NULL). Odrzucenie: RAISE EXCEPTION
--    'invalid_reference' — ten sam kod co przy nieistniejącym identyfikatorze
--    (FK), więc odpowiedź nie jest wyrocznią istnienia. Bez tego warunku
--    quorum (determineQuorum, 0009) liczyło obecność i prawo głosu opiekunów
--    spoza klasy/roku zebrania.
--
--    ŚWIADOMIE POMINIĘTE w tej migracji: capacity inne niż 'guardian' z
--    wypełnionym guardian_id (np. 'guest' — opiekun obecny jako gość, a nie
--    jako rodzic konkretnego ucznia) oraz analogiczny warunek na user_id
--    (np. "aktywny przydział roli w roku zebrania"). Istniejące dane i testy
--    (tests/pg-meetings.test.js) zakładają, że userId w meeting_attendees
--    może być dowolnym kontem bez przydziału roli — reprezentuje gościa,
--    nauczyciela albo dyrekcję zaproszoną na zebranie, nie tylko osobę z
--    formalną rolą. Zawężenie tego pola wymaga decyzji Rady (D-19: kto ma
--    prawo głosu na zebraniu klasowym/plenarnym) i osobnej migracji.
--
--    Uwaga: korekta obecności (upsert) dla opiekuna, którego relacja
--    zakończyła się MIĘDZY zebraniem a korektą, też zostanie odrzucona — ten
--    sam warunek sprawdza się przy każdym INSERT i UPDATE. To świadomy wybór
--    zachowawczy (spójny z resztą systemu, który liczy "aktualność" na dziś);
--    jeśli Rada uzna to za zbyt surowe dla poprawek historycznych, potrzebna
--    będzie osobna decyzja i zmiana (np. warunek na dzień zebrania zamiast
--    dnia zapisu).
--
-- 2. resolution_guard (0009, trigger resolutions_guard): amends_resolution_id
--    musi wskazywać uchwałę PRZYJĘTĄ (już sprawdzane) z TEGO SAMEGO roku
--    szkolnego i (dla zebrania klasowego) tej samej klasy albo uchwałę
--    zebrania ogólnego (class_id NULL). Bez tego uchwała klasy 1A mogła
--    formalnie "zmieniać" uchwałę innej klasy albo innego roku.
--
-- Poza tą migracją (poziom JS, patrz PR):
-- 3. src/pg/routes/year-close.js (confirmChecklistItem): documentId musi mieć
--    school_year_id zamykanego roku i rodzaj 'board' albo 'financial'.
--
-- ŚWIADOMIE POZA ZAKRESEM CAŁEGO ISSUE #205 (do osobnego PR): wpłata na
-- gospodarstwo bez ucznia w roku wpłaty (propozycja #4, householdId w
-- payments.js) — próba wymuszenia tego warunku psuje 9 istniejących testów,
-- które celowo tworzą gospodarstwa bez powiązanych uczniów/zapisów, bo
-- sprawdzają zakres RÓL, nie kompletność danych finansowych
-- (tests/pg-authz-matrix.test.js, tests/pg-payments-api.test.js). Wymaga
-- decyzji D-11 i przeglądu tych fixture'ów, nie tylko nowego triggera.
--
-- Wycofanie: przywrócić obie funkcje do wersji z 0009 (bez sprawdzania
-- zakresu). Dane nie wymagają zmian.

-- meeting_attendee_guard z 0009_meetings.sql, z dodanym sprawdzeniem zakresu
-- guardian_id (reszta funkcji identyczna co w 0009).
CREATE OR REPLACE FUNCTION meeting_attendee_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m meetings%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'meeting_attendees_cannot_be_deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.meeting_id, NEW.user_id, NEW.guardian_id)
       IS DISTINCT FROM ROW(OLD.id, OLD.meeting_id, OLD.user_id, OLD.guardian_id) THEN
      RAISE EXCEPTION 'meeting_attendee_reference_immutable';
    END IF;
    NEW.updated_at := now();
  END IF;
  PERFORM meeting_assert_editable(NEW.meeting_id);

  SELECT * INTO m FROM meetings WHERE id = NEW.meeting_id;
  -- Zakres sprawdzamy tylko dla capacity='guardian' (opiekun obecny W TEJ
  -- ROLI — dokładnie przypadek z reprodukcji #205, i ten, który liczy się do
  -- quorum jako głos rodzica). Inne capacity z guardian_id (np. 'guest' —
  -- opiekun obecny jako gość, niekoniecznie rodzic ucznia TEJ klasy/roku)
  -- zostają bez zmian, zgodnie z istniejącym zachowaniem i testami.
  IF NEW.guardian_id IS NOT NULL AND NEW.capacity = 'guardian' AND NOT EXISTS (
    SELECT 1 FROM student_guardians sg
      JOIN enrollments e ON e.student_id = sg.student_id
     WHERE sg.guardian_id = NEW.guardian_id
       AND e.school_year_id = m.school_year_id
       AND (m.class_id IS NULL OR e.class_id = m.class_id)
       AND (sg.starts_on IS NULL OR sg.starts_on <= rd_today())
       AND (sg.ends_on IS NULL OR sg.ends_on > rd_today())
  ) THEN
    RAISE EXCEPTION 'invalid_reference';
  END IF;

  RETURN NEW;
END;
$$;

-- resolution_guard z 0009_meetings.sql, z dodanym sprawdzeniem zakresu
-- amends_resolution_id (reszta funkcji identyczna co w 0009).
CREATE OR REPLACE FUNCTION resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous resolutions%ROWTYPE;
DECLARE current_status TEXT;
DECLARE present_count INTEGER;
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
    IF NOT EXISTS (
      SELECT 1 FROM resolutions WHERE id = NEW.amends_resolution_id AND status = 'adopted'
    ) THEN
      RAISE EXCEPTION 'resolution_amends_requires_adopted';
    END IF;
    -- #205: uchwała "zmieniana" (amends) musi być z tego samego roku, i dla
    -- zebrania klasowego — tej samej klasy albo zebrania ogólnego.
    SELECT m2.* INTO amended_meeting FROM resolutions r2
      JOIN meetings m2 ON m2.id = r2.meeting_id WHERE r2.id = NEW.amends_resolution_id;
    SELECT * INTO this_meeting FROM meetings WHERE id = NEW.meeting_id;
    IF amended_meeting.school_year_id <> this_meeting.school_year_id
       OR (this_meeting.class_id IS NOT NULL AND amended_meeting.class_id IS NOT NULL
           AND amended_meeting.class_id <> this_meeting.class_id) THEN
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
