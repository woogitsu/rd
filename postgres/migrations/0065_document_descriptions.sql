-- Tytuł, kategoria i data dokumentu (issue #76).
--
-- documents pozostaje niezmienne (0006_documents.sql). Ta migracja dodaje
-- osobną, dopisywaną tabelę: każda zmiana opisu to NOWY wiersz (kolejny
-- revision_no), a nie edycja poprzedniego. Obowiązuje najnowsza wersja
-- (MAX(revision_no)) na dokument; poprzednie zostają w historii.
--
-- Lista kategorii jest założeniem technicznym do zatwierdzenia przez zarząd
-- i skarbnika (issue #76, sekcja „Zależności”) — nie jest ograniczona do
-- rodzaju dokumentu w tej wersji.
--
-- Skutki dla danych: nowa, pusta tabela. Istniejące dokumenty nie mają
-- wiersza opisu — panel pokazuje dla nich „Bez tytułu” (brak wpisu, nie błąd).

CREATE TABLE document_descriptions (
  document_id TEXT NOT NULL REFERENCES documents(id),
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  category TEXT NOT NULL CHECK (category IN (
    'faktura', 'potwierdzenie_przelewu', 'wyciag', 'protokol', 'uchwala',
    'umowa', 'regulamin', 'sprawozdanie_rewizyjne', 'inne'
  )),
  document_date DATE,
  description TEXT CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT UNIQUE
    CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  PRIMARY KEY (document_id, revision_no)
);

-- Najnowsza wersja na dokument: ORDER BY revision_no DESC LIMIT 1 korzysta z PK.
CREATE INDEX document_descriptions_search_idx ON document_descriptions(document_id, revision_no DESC);

CREATE FUNCTION document_description_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_descriptions_are_immutable';
END $$;
CREATE TRIGGER document_descriptions_no_change BEFORE UPDATE OR DELETE ON document_descriptions
  FOR EACH ROW EXECUTE FUNCTION document_description_immutable();

-- Kolejność wersji: revision_no musi być MAX(istniejące) + 1 (albo 1, gdy
-- brak wcześniejszych). API blokuje wiersz documents (SELECT ... FOR UPDATE)
-- przed obliczeniem numeru, więc to dodatkowa, obronna warstwa w bazie.
CREATE FUNCTION document_description_next_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected INTEGER;
BEGIN
  SELECT COALESCE(MAX(revision_no), 0) + 1 INTO expected
    FROM document_descriptions WHERE document_id = NEW.document_id;
  IF NEW.revision_no IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'document_description_revision_out_of_order';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_descriptions_revision_order BEFORE INSERT ON document_descriptions
  FOR EACH ROW EXECUTE FUNCTION document_description_next_revision();
