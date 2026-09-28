-- #215: kontrola wersji (optimistic concurrency) dla edycji uchwał, zebrań
-- i kampanii e-mail — te trzy trasy edycji, w odróżnieniu od wydarzeń
-- (events.js) i aktualności (news.js), nie miały numeru wersji, więc druga
-- równoległa edycja po cichu nadpisywała zmianę pierwszej osoby.
--
-- Skutki dla danych:
--   * revision_no dodane z DEFAULT 1 — żaden istniejący wiersz nie zmienia
--     treści, tylko dostaje numer wersji startowej;
--   * trigger BEFORE UPDATE zwiększa revision_no o 1 przy KAŻDEJ zmianie
--     wiersza (także wykonanej przez workera e-mail, np. status kampanii),
--     niezależnie od tego, czy trasa API sprawdza wersję. Jawne ustawienie
--     revision_no w SET jest ignorowane (trigger nadpisuje wyliczoną wartością);
--   * nie zmienia istniejących ograniczeń ani wyzwalaczy z 0009/0037.

CREATE OR REPLACE FUNCTION bump_revision_no() RETURNS trigger AS $$
BEGIN
  NEW.revision_no := OLD.revision_no + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE resolutions ADD COLUMN revision_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meetings ADD COLUMN revision_no INTEGER NOT NULL DEFAULT 1;
ALTER TABLE email_campaigns ADD COLUMN revision_no INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER resolutions_bump_revision BEFORE UPDATE ON resolutions
  FOR EACH ROW EXECUTE FUNCTION bump_revision_no();
CREATE TRIGGER meetings_bump_revision BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION bump_revision_no();
CREATE TRIGGER email_campaigns_bump_revision BEFORE UPDATE ON email_campaigns
  FOR EACH ROW EXECUTE FUNCTION bump_revision_no();
