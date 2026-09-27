-- Auditable ledger, opening balances and immutable budget revisions.
-- Existing ledger rows remain readable; all new rows use controlled categories and idempotency keys.

CREATE TABLE ledger_categories (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  direction TEXT NOT NULL CHECK(direction IN ('income', 'expense')),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 100),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(school_year_id, direction, name)
);

CREATE INDEX ledger_categories_year_direction_idx
  ON ledger_categories(school_year_id, direction, active);

CREATE TRIGGER ledger_categories_facts_immutable
BEFORE UPDATE ON ledger_categories
WHEN NEW.school_year_id IS NOT OLD.school_year_id
  OR NEW.direction IS NOT OLD.direction
  OR NEW.name IS NOT OLD.name
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'ledger_category_facts_immutable');
END;

CREATE TRIGGER ledger_categories_no_delete
BEFORE DELETE ON ledger_categories
BEGIN
  SELECT RAISE(ABORT, 'ledger_categories_cannot_be_deleted');
END;

ALTER TABLE ledger_entries ADD COLUMN method TEXT
  CHECK(method IN ('bank', 'cash', 'card', 'other'));
ALTER TABLE ledger_entries ADD COLUMN source TEXT;
ALTER TABLE ledger_entries ADD COLUMN resolution_reference TEXT;
ALTER TABLE ledger_entries ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX ledger_entries_idempotency_idx
  ON ledger_entries(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER ledger_entries_require_complete_facts
BEFORE INSERT ON ledger_entries
WHEN NEW.method IS NULL
  OR NEW.idempotency_key IS NULL
  OR length(trim(NEW.idempotency_key)) NOT BETWEEN 8 AND 128
  OR length(trim(NEW.description)) NOT BETWEEN 3 AND 500
BEGIN
  SELECT RAISE(ABORT, 'ledger_entry_required_facts_missing');
END;

CREATE TRIGGER ledger_entries_require_matching_category
BEFORE INSERT ON ledger_entries
WHEN NOT EXISTS (
  SELECT 1
  FROM ledger_categories category
  WHERE category.id = NEW.category
    AND category.school_year_id = NEW.school_year_id
    AND category.direction = NEW.direction
    AND category.active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'ledger_category_mismatch');
END;

CREATE TRIGGER ledger_entries_require_existing_document
BEFORE INSERT ON ledger_entries
WHEN NEW.source_document_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.source_document_id)
BEGIN
  SELECT RAISE(ABORT, 'ledger_source_document_not_found');
END;

CREATE TRIGGER ledger_expense_over_3000_requires_resolution
BEFORE INSERT ON ledger_entries
WHEN NEW.direction = 'expense'
  AND NEW.amount_cents > 300000
  AND (NEW.resolution_reference IS NULL OR length(trim(NEW.resolution_reference)) < 3)
BEGIN
  SELECT RAISE(ABORT, 'ledger_expense_resolution_required');
END;

CREATE TRIGGER ledger_entries_financial_facts_immutable
BEFORE UPDATE ON ledger_entries
WHEN NEW.school_year_id IS NOT OLD.school_year_id
  OR NEW.direction IS NOT OLD.direction
  OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.category IS NOT OLD.category
  OR NEW.description IS NOT OLD.description
  OR NEW.occurred_on IS NOT OLD.occurred_on
  OR NEW.payment_entry_id IS NOT OLD.payment_entry_id
  OR NEW.source_document_id IS NOT OLD.source_document_id
  OR NEW.approval_id IS NOT OLD.approval_id
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.method IS NOT OLD.method
  OR NEW.source IS NOT OLD.source
  OR NEW.resolution_reference IS NOT OLD.resolution_reference
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'ledger_entry_financial_facts_immutable');
END;

CREATE TRIGGER ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries_cannot_be_deleted');
END;

CREATE TABLE ledger_corrections (
  id TEXT PRIMARY KEY,
  ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 8 AND 128)
);

CREATE INDEX ledger_corrections_entry_idx
  ON ledger_corrections(ledger_entry_id, created_at);

CREATE TRIGGER ledger_corrections_do_not_exceed_entry
BEFORE INSERT ON ledger_corrections
WHEN NEW.amount_cents > (
  SELECT entry.amount_cents - COALESCE((
    SELECT SUM(existing.amount_cents)
    FROM ledger_corrections existing
    WHERE existing.ledger_entry_id = entry.id
  ), 0)
  FROM ledger_entries entry
  WHERE entry.id = NEW.ledger_entry_id
)
BEGIN
  SELECT RAISE(ABORT, 'ledger_correction_exceeds_remaining_amount');
END;

CREATE TRIGGER ledger_corrections_no_update
BEFORE UPDATE ON ledger_corrections
BEGIN
  SELECT RAISE(ABORT, 'ledger_corrections_cannot_be_updated');
END;

CREATE TRIGGER ledger_corrections_no_delete
BEFORE DELETE ON ledger_corrections
BEGIN
  SELECT RAISE(ABORT, 'ledger_corrections_cannot_be_deleted');
END;

CREATE TABLE ledger_opening_balances (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL UNIQUE REFERENCES school_years(id),
  amount_cents INTEGER NOT NULL,
  source_document_id TEXT REFERENCES documents(id),
  note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 8 AND 128)
);

CREATE TRIGGER ledger_opening_balances_no_update
BEFORE UPDATE ON ledger_opening_balances
BEGIN
  SELECT RAISE(ABORT, 'ledger_opening_balances_cannot_be_updated');
END;

CREATE TRIGGER ledger_opening_balances_no_delete
BEFORE DELETE ON ledger_opening_balances
BEGIN
  SELECT RAISE(ABORT, 'ledger_opening_balances_cannot_be_deleted');
END;

CREATE TABLE ledger_opening_balance_adjustments (
  id TEXT PRIMARY KEY,
  opening_balance_id TEXT NOT NULL REFERENCES ledger_opening_balances(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents <> 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 8 AND 128)
);

CREATE TRIGGER ledger_opening_balance_adjustments_no_update
BEFORE UPDATE ON ledger_opening_balance_adjustments
BEGIN
  SELECT RAISE(ABORT, 'ledger_opening_balance_adjustments_cannot_be_updated');
END;

CREATE TRIGGER ledger_opening_balance_adjustments_no_delete
BEFORE DELETE ON ledger_opening_balance_adjustments
BEGIN
  SELECT RAISE(ABORT, 'ledger_opening_balance_adjustments_cannot_be_deleted');
END;

CREATE TABLE ledger_budget_lines (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  category_id TEXT NOT NULL REFERENCES ledger_categories(id),
  planned_cents INTEGER NOT NULL CHECK(planned_cents >= 0),
  note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 3 AND 500),
  supersedes_id TEXT UNIQUE REFERENCES ledger_budget_lines(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 8 AND 128)
);

CREATE UNIQUE INDEX ledger_budget_initial_category_idx
  ON ledger_budget_lines(school_year_id, category_id)
  WHERE supersedes_id IS NULL;

CREATE TRIGGER ledger_budget_lines_require_matching_category
BEFORE INSERT ON ledger_budget_lines
WHEN NOT EXISTS (
  SELECT 1 FROM ledger_categories category
  WHERE category.id = NEW.category_id
    AND category.school_year_id = NEW.school_year_id
)
BEGIN
  SELECT RAISE(ABORT, 'ledger_budget_category_mismatch');
END;

CREATE TRIGGER ledger_budget_lines_require_matching_revision
BEFORE INSERT ON ledger_budget_lines
WHEN NEW.supersedes_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ledger_budget_lines previous
    WHERE previous.id = NEW.supersedes_id
      AND previous.school_year_id = NEW.school_year_id
      AND previous.category_id = NEW.category_id
  )
BEGIN
  SELECT RAISE(ABORT, 'ledger_budget_revision_mismatch');
END;

CREATE TRIGGER ledger_budget_lines_no_update
BEFORE UPDATE ON ledger_budget_lines
BEGIN
  SELECT RAISE(ABORT, 'ledger_budget_lines_cannot_be_updated');
END;

CREATE TRIGGER ledger_budget_lines_no_delete
BEFORE DELETE ON ledger_budget_lines
BEGIN
  SELECT RAISE(ABORT, 'ledger_budget_lines_cannot_be_deleted');
END;

CREATE VIEW ledger_entry_net AS
SELECT
  entry.*,
  COALESCE(correction.corrected_cents, 0) AS corrected_cents,
  entry.amount_cents - COALESCE(correction.corrected_cents, 0) AS net_amount_cents
FROM ledger_entries entry
LEFT JOIN (
  SELECT ledger_entry_id, SUM(amount_cents) AS corrected_cents
  FROM ledger_corrections
  GROUP BY ledger_entry_id
) correction ON correction.ledger_entry_id = entry.id;

CREATE VIEW ledger_current_budget AS
SELECT line.*
FROM ledger_budget_lines line
WHERE NOT EXISTS (
  SELECT 1 FROM ledger_budget_lines newer WHERE newer.supersedes_id = line.id
);

CREATE VIEW ledger_year_summary AS
SELECT
  year.id AS school_year_id,
  COALESCE(opening.amount_cents, 0) + COALESCE(adjustment.amount_cents, 0) AS opening_balance_cents,
  COALESCE(SUM(CASE WHEN entry.direction = 'income' THEN entry.net_amount_cents ELSE 0 END), 0) AS income_cents,
  COALESCE(SUM(CASE WHEN entry.direction = 'expense' THEN entry.net_amount_cents ELSE 0 END), 0) AS expense_cents,
  COALESCE(opening.amount_cents, 0) + COALESCE(adjustment.amount_cents, 0)
    + COALESCE(SUM(CASE WHEN entry.direction = 'income' THEN entry.net_amount_cents ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN entry.direction = 'expense' THEN entry.net_amount_cents ELSE 0 END), 0)
    AS closing_balance_cents
FROM school_years year
LEFT JOIN ledger_opening_balances opening ON opening.school_year_id = year.id
LEFT JOIN (
  SELECT opening_balance_id, SUM(amount_cents) AS amount_cents
  FROM ledger_opening_balance_adjustments
  GROUP BY opening_balance_id
) adjustment ON adjustment.opening_balance_id = opening.id
LEFT JOIN ledger_entry_net entry ON entry.school_year_id = year.id
GROUP BY year.id, opening.amount_cents, adjustment.amount_cents;
