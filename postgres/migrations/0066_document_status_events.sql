-- Wersje dokumentu i unieważnienie bez usuwania (issue #82).
--
-- documents pozostaje niezmienne (0006_documents.sql) — plik w buckecie i
-- wpis metadanych nie znikają. Nowa, dopisywana tabela zapisuje TYLKO
-- zdarzenie zmiany stanu (zastąpiony / unieważniony); trigger blokuje
-- UPDATE/DELETE. Stan dokumentu jest wyliczany widokiem, nie kolumną —
-- "aktywny" to po prostu "bez zdarzenia".
--
-- Zasady wymuszone triggerem BEFORE INSERT (document_status_event_guard):
--   * dokument nie może mieć więcej niż jedno zdarzenie stanu (unikalny
--     indeks na document_id) — ani ponowne unieważnienie, ani zastąpienie
--     dokumentu już zastąpionego/unieważnionego;
--   * dokument zastępujący (replacement_document_id) musi być AKTYWNY
--     (bez własnego zdarzenia stanu) — to samo w sobie odrzuca cykl
--     A -> B -> A, bo po kroku "A zastąpiony przez B" dokument A przestaje
--     być aktywny i nie może już posłużyć jako zastępstwo dla B;
--   * zastępstwo nie może wskazywać samego siebie.
-- Zgodność rodzaju/roku/klasy zastępstwa sprawdza aplikacja (src/pg/routes/
-- documents.js) przed wstawieniem wiersza — wymaga odczytania obu wierszy
-- documents, czego CHECK/trigger tej tabeli nie robi.
--
-- Skutki dla danych: nowa, pusta tabela; istniejące dokumenty są "active"
-- (widok bez wiersza w tej tabeli = active), nic nie jest przepisywane.

CREATE TABLE document_status_events (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  document_id TEXT NOT NULL REFERENCES documents(id),
  action TEXT NOT NULL CHECK (action IN ('superseded', 'voided')),
  replacement_document_id TEXT REFERENCES documents(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT UNIQUE
    CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  CONSTRAINT document_status_events_replacement_pair
    CHECK ((action = 'superseded') = (replacement_document_id IS NOT NULL)),
  CONSTRAINT document_status_events_no_self_reference
    CHECK (replacement_document_id IS NULL OR replacement_document_id <> document_id)
);

-- Co najwyżej jedno zdarzenie stanu na dokument: pierwsza zmiana jest ostateczna.
CREATE UNIQUE INDEX document_status_events_one_per_document ON document_status_events(document_id);
CREATE INDEX document_status_events_replacement_idx ON document_status_events(replacement_document_id)
  WHERE replacement_document_id IS NOT NULL;

CREATE FUNCTION document_status_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_status_events_are_immutable';
END $$;
CREATE TRIGGER document_status_events_no_change BEFORE UPDATE OR DELETE ON document_status_events
  FOR EACH ROW EXECUTE FUNCTION document_status_event_immutable();

CREATE FUNCTION document_status_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.replacement_document_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM document_status_events WHERE document_id = NEW.replacement_document_id) THEN
    RAISE EXCEPTION 'document_status_replacement_not_active';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_status_events_guard BEFORE INSERT ON document_status_events
  FOR EACH ROW EXECUTE FUNCTION document_status_event_guard();

-- Stan wyliczony: 'active' dla dokumentu bez zdarzenia, w przeciwnym razie
-- 'superseded' albo 'voided'. Lista domyślnie pokazuje tylko active
-- (aplikacja filtruje po tym widoku, nie po samej tabeli documents).
CREATE VIEW document_current_status AS
SELECT d.id AS document_id,
       COALESCE(e.action, 'active') AS status,
       e.replacement_document_id,
       e.created_at AS status_changed_at
  FROM documents d
  LEFT JOIN document_status_events e ON e.document_id = d.id;
