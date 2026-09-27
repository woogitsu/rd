-- Private documents in Railway Storage Bucket (issue #39, #8).
-- Adds nullable columns, constraints, indexes and an immutability guard.
-- Existing rows are not rewritten or deleted. Rows without school_year_id
-- (e.g. restored from a D1 snapshot) stay unreachable through the API until
-- a separate, reviewed classification migration.

ALTER TABLE documents
  ADD COLUMN school_year_id TEXT REFERENCES school_years(id),
  ADD COLUMN class_id TEXT,
  ADD COLUMN linked_entity_type TEXT,
  ADD COLUMN linked_entity_id TEXT,
  ADD COLUMN sha256 TEXT,
  ADD COLUMN idempotency_key TEXT UNIQUE
    CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  -- Retention is decision D-04 (open). NULL = not decided: keep, never delete automatically.
  ADD COLUMN retention_policy TEXT
    CHECK (retention_policy IS NULL OR length(btrim(retention_policy)) BETWEEN 2 AND 100),
  ADD COLUMN retain_until DATE,
  ADD CONSTRAINT documents_class_in_year
    FOREIGN KEY (class_id, school_year_id) REFERENCES classes(id, school_year_id),
  ADD CONSTRAINT documents_class_requires_year
    CHECK (class_id IS NULL OR school_year_id IS NOT NULL),
  ADD CONSTRAINT documents_link_pair
    CHECK ((linked_entity_type IS NULL) = (linked_entity_id IS NULL)),
  ADD CONSTRAINT documents_link_type
    CHECK (linked_entity_type IS NULL OR linked_entity_type IN ('ledger_entry', 'payment_entry')),
  ADD CONSTRAINT documents_sha256_format
    CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT documents_retention_pair
    CHECK (retain_until IS NULL OR retention_policy IS NOT NULL),
  -- Documents created by the new API: classified, hashed, idempotent, opaque key
  -- without file names or personal data, allowlisted MIME type.
  ADD CONSTRAINT documents_api_row CHECK (
    school_year_id IS NULL OR (
      kind IN ('financial', 'board', 'class')
      AND (kind = 'class') = (class_id IS NOT NULL)
      AND (linked_entity_type IS NULL OR kind = 'financial')
      AND sha256 IS NOT NULL
      AND idempotency_key IS NOT NULL
      AND object_key ~ '^docs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND mime_type IN ('application/pdf', 'image/png', 'image/jpeg')
      AND byte_size > 0
    )
  );

CREATE INDEX documents_year_kind_idx ON documents(school_year_id, kind, class_id, created_at DESC, id);
CREATE INDEX documents_link_idx ON documents(linked_entity_type, linked_entity_id)
  WHERE linked_entity_type IS NOT NULL;

-- Stored document facts are immutable. Deletion after the retention period
-- (D-04) will be a separate, audited mechanism added by its own migration.
CREATE FUNCTION document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'documents_are_immutable';
END $$;
CREATE TRIGGER documents_no_change BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION document_immutable();
