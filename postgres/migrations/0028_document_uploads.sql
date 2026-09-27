-- Zamiar uploadu dokumentu zapisywany przed PUT do bucketu (#168).
--
-- POST /api/documents najpierw zapisuje wiersz document_uploads w stanie
-- 'pending' (aktor, czas, klucz obiektu, skrót i rozmiar), potem wysyła
-- obiekt do bucketu, a na końcu w JEDNEJ transakcji dodaje wiersz documents,
-- zmienia stan uploadu na 'committed' i zapisuje zdarzenie audytu.
-- Dzięki temu:
--   * obiekt osierocony po timeoucie PUT, SIGTERM lub awarii bazy ma zawsze
--     wpis z aktorem i czasem — zadanie porządkowe (scripts/document-uploads-
--     cleanup.js) usuwa go i oznacza 'abandoned' ze zdarzeniem audytu;
--   * utracone potwierdzenie COMMIT nie prowadzi do usunięcia obiektu, który
--     ma wiersz documents — obiekt jest usuwany tylko wtedy, gdy wiersza
--     documents na pewno nie ma.
--
-- Skutki dla danych:
--   * nowa tabela; istniejące dokumenty i obiekty nie są zmieniane ani
--     uzupełniane wstecz (dokumenty sprzed migracji nie mają wpisu uploadu);
--   * wpisy nie są usuwane (trigger), stan zmienia się tylko
--     pending -> committed | abandoned; dane osobowe nie są zapisywane
--     (klucz obiektu jest losowy, bez nazwy pliku).

CREATE TABLE document_uploads (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  object_key TEXT NOT NULL UNIQUE
    CHECK (object_key ~ '^docs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'committed', 'abandoned')),
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IS NULL OR resolution ~ '^[a-z_]{1,60}$'),
  CONSTRAINT document_uploads_resolved CHECK ((state = 'pending') = (resolved_at IS NULL))
);
CREATE INDEX document_uploads_pending_idx ON document_uploads(created_at) WHERE state = 'pending';
CREATE INDEX document_uploads_key_idx ON document_uploads(idempotency_key);

CREATE FUNCTION document_upload_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document_uploads_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'document_upload_identity_immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (OLD.state = 'pending' AND NEW.state IN ('committed', 'abandoned')) THEN
    RAISE EXCEPTION 'document_upload_invalid_transition';
  END IF;
  IF OLD.state <> 'pending' AND (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.resolution IS DISTINCT FROM OLD.resolution) THEN
    RAISE EXCEPTION 'document_upload_resolved';
  END IF;
  -- Nie oznaczamy jako porzucony uploadu, który ma wiersz documents.
  IF NEW.state = 'abandoned' AND EXISTS (SELECT 1 FROM documents d WHERE d.id = NEW.id OR d.object_key = NEW.object_key) THEN
    RAISE EXCEPTION 'document_upload_has_document';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_uploads_guard BEFORE UPDATE OR DELETE ON document_uploads
  FOR EACH ROW EXECUTE FUNCTION document_upload_guard();
