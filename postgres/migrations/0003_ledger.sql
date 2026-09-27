-- Immutable ledger, opening balances and versioned budget lines.
-- Amounts are stored as integer EUR cents.

CREATE TABLE ledger_categories (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 100),
  active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_year_id, direction, name),
  UNIQUE (id, school_year_id, direction)
);
CREATE INDEX ledger_categories_year_direction_idx
  ON ledger_categories(school_year_id, direction, active);

CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category_id TEXT NOT NULL,
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 500),
  occurred_on DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('bank', 'cash', 'card', 'other')),
  source TEXT,
  payment_entry_id TEXT REFERENCES payment_entries(id),
  source_document_id TEXT REFERENCES documents(id),
  resolution_reference TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  FOREIGN KEY (category_id, school_year_id, direction)
    REFERENCES ledger_categories(id, school_year_id, direction),
  CONSTRAINT ledger_large_expense_resolution CHECK (
    direction <> 'expense' OR amount_cents <= 300000
    OR COALESCE(length(btrim(resolution_reference)), 0) >= 3
  ),
  CONSTRAINT ledger_payment_is_income CHECK (
    payment_entry_id IS NULL OR direction = 'income'
  )
);
CREATE INDEX ledger_year_date_idx ON ledger_entries(school_year_id, occurred_on, id);
CREATE UNIQUE INDEX ledger_entries_payment_entry_idx
  ON ledger_entries(payment_entry_id) WHERE payment_entry_id IS NOT NULL;

CREATE TABLE ledger_corrections (
  id TEXT PRIMARY KEY,
  ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE INDEX ledger_corrections_entry_idx
  ON ledger_corrections(ledger_entry_id, created_at);

CREATE TABLE ledger_opening_balances (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL UNIQUE REFERENCES school_years(id),
  amount_cents INTEGER NOT NULL,
  source_document_id TEXT REFERENCES documents(id),
  note TEXT CHECK (note IS NULL OR length(btrim(note)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);

CREATE TABLE ledger_opening_balance_adjustments (
  id TEXT PRIMARY KEY,
  opening_balance_id TEXT NOT NULL REFERENCES ledger_opening_balances(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE INDEX ledger_opening_adjustments_balance_idx
  ON ledger_opening_balance_adjustments(opening_balance_id, created_at);

CREATE TABLE ledger_budget_lines (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  category_id TEXT NOT NULL REFERENCES ledger_categories(id),
  planned_cents INTEGER NOT NULL CHECK (planned_cents >= 0),
  note TEXT CHECK (note IS NULL OR length(btrim(note)) BETWEEN 3 AND 500),
  supersedes_id TEXT UNIQUE REFERENCES ledger_budget_lines(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE UNIQUE INDEX ledger_budget_initial_category_idx
  ON ledger_budget_lines(school_year_id, category_id)
  WHERE supersedes_id IS NULL;

CREATE FUNCTION ledger_entry_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked payment_entries%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ledger_categories c WHERE c.id = NEW.category_id AND c.active
  ) THEN
    RAISE EXCEPTION 'ledger_category_inactive';
  END IF;
  IF NEW.payment_entry_id IS NOT NULL THEN
    SELECT * INTO linked FROM payment_entries WHERE id = NEW.payment_entry_id FOR SHARE;
    IF NOT FOUND OR linked.school_year_id <> NEW.school_year_id
       OR linked.status <> 'recorded' THEN
      RAISE EXCEPTION 'ledger_payment_link_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_entries_guard_insert BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_insert_guard();

CREATE FUNCTION ledger_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original ledger_entries%ROWTYPE;
DECLARE corrected BIGINT;
BEGIN
  SELECT * INTO original FROM ledger_entries WHERE id = NEW.ledger_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger_entry_not_found'; END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO corrected
    FROM ledger_corrections WHERE ledger_entry_id = NEW.ledger_entry_id;
  IF corrected + NEW.amount_cents > original.amount_cents THEN
    RAISE EXCEPTION 'ledger_correction_exceeds_remaining_amount';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_corrections_guard_insert BEFORE INSERT ON ledger_corrections
  FOR EACH ROW EXECUTE FUNCTION ledger_correction_guard();

CREATE FUNCTION ledger_budget_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous ledger_budget_lines%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ledger_categories c
    WHERE c.id = NEW.category_id AND c.school_year_id = NEW.school_year_id
  ) THEN RAISE EXCEPTION 'ledger_budget_category_mismatch'; END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO previous FROM ledger_budget_lines
      WHERE id = NEW.supersedes_id FOR UPDATE;
    IF NOT FOUND OR previous.school_year_id <> NEW.school_year_id
       OR previous.category_id <> NEW.category_id THEN
      RAISE EXCEPTION 'ledger_budget_revision_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_budget_guard_insert BEFORE INSERT ON ledger_budget_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_budget_guard();

CREATE FUNCTION immutable_financial_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%_cannot_be_changed', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER ledger_entries_no_change BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER ledger_corrections_no_change BEFORE UPDATE OR DELETE ON ledger_corrections
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER ledger_opening_balances_no_change BEFORE UPDATE OR DELETE ON ledger_opening_balances
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER ledger_opening_adjustments_no_change BEFORE UPDATE OR DELETE ON ledger_opening_balance_adjustments
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER ledger_budget_lines_no_change BEFORE UPDATE OR DELETE ON ledger_budget_lines
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();

CREATE FUNCTION ledger_category_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ledger_categories_cannot_be_deleted'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ledger_category_facts_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_categories_guard_update BEFORE UPDATE ON ledger_categories
  FOR EACH ROW EXECUTE FUNCTION ledger_category_guard();
CREATE TRIGGER ledger_categories_guard_delete BEFORE DELETE ON ledger_categories
  FOR EACH ROW EXECUTE FUNCTION ledger_category_guard();

CREATE VIEW ledger_entry_net AS
SELECT e.*, COALESCE(c.corrected_cents, 0) AS corrected_cents,
  e.amount_cents::BIGINT - COALESCE(c.corrected_cents, 0) AS net_amount_cents
FROM ledger_entries e
LEFT JOIN (
  SELECT ledger_entry_id, sum(amount_cents) AS corrected_cents
  FROM ledger_corrections GROUP BY ledger_entry_id
) c ON c.ledger_entry_id = e.id;

CREATE VIEW ledger_current_budget AS
SELECT line.* FROM ledger_budget_lines line
WHERE NOT EXISTS (
  SELECT 1 FROM ledger_budget_lines newer WHERE newer.supersedes_id = line.id
);

CREATE VIEW ledger_year_summary AS
SELECT y.id AS school_year_id,
  COALESCE(o.amount_cents, 0)::BIGINT + COALESCE(a.amount_cents, 0) AS opening_balance_cents,
  COALESCE(e.income_cents, 0) AS income_cents,
  COALESCE(e.expense_cents, 0) AS expense_cents,
  COALESCE(o.amount_cents, 0)::BIGINT + COALESCE(a.amount_cents, 0)
    + COALESCE(e.income_cents, 0) - COALESCE(e.expense_cents, 0) AS closing_balance_cents
FROM school_years y
LEFT JOIN ledger_opening_balances o ON o.school_year_id = y.id
LEFT JOIN (
  SELECT opening_balance_id, sum(amount_cents) AS amount_cents
  FROM ledger_opening_balance_adjustments GROUP BY opening_balance_id
) a ON a.opening_balance_id = o.id
LEFT JOIN (
  SELECT school_year_id,
    sum(net_amount_cents) FILTER (WHERE direction = 'income') AS income_cents,
    sum(net_amount_cents) FILTER (WHERE direction = 'expense') AS expense_cents
  FROM ledger_entry_net GROUP BY school_year_id
) e ON e.school_year_id = y.id;
