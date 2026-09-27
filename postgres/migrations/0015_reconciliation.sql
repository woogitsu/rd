-- Bank reconciliation (issue #7): statement balance vs. ledger balance,
-- statement lines and manual matches to ledger entries or payments.
-- Amounts are integer EUR cents. Only adds tables, functions, triggers and
-- indexes; existing rows are not changed.
--
-- Invariants enforced here (the API relies on them, not only on its own checks):
--   * the ledger balance is always computed by the database, never sent by a client,
--   * a confirmed reconciliation, its lines and its matches cannot be changed,
--   * confirmation needs a second person (confirmed_by <> created_by),
--   * a non-zero difference needs a written explanation at confirmation,
--   * nothing can be deleted; a wrong match is revoked (kept with reason).

-- Balance of the ledger at the end of a given day: opening balance with all
-- its adjustments plus net income minus net expense of entries dated on or
-- before that day. Corrections count with the date of the corrected entry.
CREATE FUNCTION ledger_balance_at(p_school_year_id TEXT, p_on DATE)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
      SELECT s.opening_balance_cents FROM ledger_year_summary s
       WHERE s.school_year_id = p_school_year_id), 0)
    + COALESCE((
      SELECT sum(CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END)
        FROM ledger_entry_net e
       WHERE e.school_year_id = p_school_year_id AND e.occurred_on <= p_on), 0)::BIGINT
$$;

-- Net of entries recorded with a method other than 'bank' up to a day. The
-- bank statement does not show them; the value explains part of a difference
-- until D-13 decides how cash is kept.
CREATE FUNCTION ledger_non_bank_net_at(p_school_year_id TEXT, p_on DATE)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
      SELECT sum(CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END)
        FROM ledger_entry_net e
       WHERE e.school_year_id = p_school_year_id AND e.occurred_on <= p_on
         AND e.method <> 'bank'), 0)::BIGINT
$$;

CREATE TABLE bank_reconciliations (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  statement_date DATE NOT NULL,
  statement_balance_cents BIGINT NOT NULL
    CHECK (statement_balance_cents BETWEEN -10000000000 AND 10000000000),
  ledger_balance_cents BIGINT NOT NULL,
  ledger_non_bank_cents BIGINT NOT NULL,
  difference_cents BIGINT GENERATED ALWAYS AS (statement_balance_cents - ledger_balance_cents) STORED,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  notes TEXT CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 3 AND 1000),
  -- Random per-reconciliation salt for statement line reference hashes.
  reference_salt TEXT NOT NULL CHECK (reference_salt ~ '^[0-9a-f]{32}$'),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  confirmation_note TEXT
    CHECK (confirmation_note IS NULL OR length(btrim(confirmation_note)) BETWEEN 3 AND 1000),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  UNIQUE (id, school_year_id),
  CONSTRAINT bank_reconciliation_confirmation CHECK (
    (status = 'draft' AND confirmed_by IS NULL AND confirmed_at IS NULL AND confirmation_note IS NULL)
    OR (status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
  ),
  CONSTRAINT bank_reconciliation_four_eyes CHECK (confirmed_by IS NULL OR confirmed_by <> created_by),
  CONSTRAINT bank_reconciliation_difference_explained CHECK (
    status <> 'confirmed' OR difference_cents = 0 OR confirmation_note IS NOT NULL
  )
);
CREATE INDEX bank_reconciliations_year_idx
  ON bank_reconciliations(school_year_id, statement_date, created_at);

CREATE TABLE bank_statement_imports (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES bank_reconciliations(id),
  source TEXT NOT NULL CHECK (source IN ('manual', 'csv')),
  line_count INTEGER NOT NULL CHECK (line_count BETWEEN 1 AND 1000),
  -- SHA-256 of the normalized request (references already hashed): replay check.
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE INDEX bank_statement_imports_reconciliation_idx
  ON bank_statement_imports(reconciliation_id, created_at);

CREATE TABLE bank_statement_lines (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES bank_reconciliations(id),
  import_id TEXT NOT NULL REFERENCES bank_statement_imports(id),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  booked_on DATE NOT NULL,
  -- Signed: positive = money in, negative = money out.
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0 AND amount_cents BETWEEN -100000000 AND 100000000),
  -- Only a salted SHA-256 of the normalized reference text; never the text itself.
  reference_hash TEXT CHECK (reference_hash IS NULL OR reference_hash ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (import_id, line_no)
);
CREATE INDEX bank_statement_lines_reconciliation_idx
  ON bank_statement_lines(reconciliation_id, booked_on, id);

CREATE TABLE bank_reconciliation_matches (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES bank_reconciliations(id),
  statement_line_id TEXT NOT NULL REFERENCES bank_statement_lines(id),
  ledger_entry_id TEXT REFERENCES ledger_entries(id),
  payment_entry_id TEXT REFERENCES payment_entries(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT REFERENCES users(id),
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 500),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  CONSTRAINT bank_match_single_target CHECK ((ledger_entry_id IS NULL) <> (payment_entry_id IS NULL)),
  CONSTRAINT bank_match_revocation CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX bank_matches_active_line_idx
  ON bank_reconciliation_matches(statement_line_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX bank_matches_active_ledger_idx
  ON bank_reconciliation_matches(reconciliation_id, ledger_entry_id)
  WHERE revoked_at IS NULL AND ledger_entry_id IS NOT NULL;
CREATE UNIQUE INDEX bank_matches_active_payment_idx
  ON bank_reconciliation_matches(reconciliation_id, payment_entry_id)
  WHERE revoked_at IS NULL AND payment_entry_id IS NOT NULL;

CREATE FUNCTION bank_reconciliation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE year school_years%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'bank_reconciliations_cannot_be_deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'bank_reconciliation_must_start_as_draft'; END IF;
    SELECT * INTO year FROM school_years WHERE id = NEW.school_year_id;
    IF NOT FOUND OR NEW.statement_date < year.starts_on OR NEW.statement_date > year.ends_on THEN
      RAISE EXCEPTION 'bank_reconciliation_date_outside_year';
    END IF;
    NEW.ledger_balance_cents := ledger_balance_at(NEW.school_year_id, NEW.statement_date);
    NEW.ledger_non_bank_cents := ledger_non_bank_net_at(NEW.school_year_id, NEW.statement_date);
    RETURN NEW;
  END IF;
  IF OLD.status = 'confirmed' THEN RAISE EXCEPTION 'bank_reconciliation_confirmed_immutable'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.statement_date IS DISTINCT FROM OLD.statement_date
     OR NEW.statement_balance_cents IS DISTINCT FROM OLD.statement_balance_cents
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.reference_salt IS DISTINCT FROM OLD.reference_salt
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.status <> 'confirmed' THEN
    RAISE EXCEPTION 'bank_reconciliation_facts_immutable';
  END IF;
  -- Draft -> confirmed: freeze the ledger balance as of the confirmation.
  NEW.ledger_balance_cents := ledger_balance_at(NEW.school_year_id, NEW.statement_date);
  NEW.ledger_non_bank_cents := ledger_non_bank_net_at(NEW.school_year_id, NEW.statement_date);
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_reconciliations_guard_insert BEFORE INSERT ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_guard();
CREATE TRIGGER bank_reconciliations_guard_change BEFORE UPDATE OR DELETE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_guard();

CREATE FUNCTION bank_reconciliation_require_draft(p_reconciliation_id TEXT)
RETURNS bank_reconciliations LANGUAGE plpgsql AS $$
DECLARE parent bank_reconciliations%ROWTYPE;
BEGIN
  SELECT * INTO parent FROM bank_reconciliations WHERE id = p_reconciliation_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bank_reconciliation_not_found'; END IF;
  IF parent.status <> 'draft' THEN RAISE EXCEPTION 'bank_reconciliation_confirmed_immutable'; END IF;
  RETURN parent;
END;
$$;

CREATE FUNCTION bank_statement_import_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bank_reconciliation_require_draft(NEW.reconciliation_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_statement_imports_guard_insert BEFORE INSERT ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION bank_statement_import_guard();

CREATE FUNCTION bank_statement_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent bank_reconciliations%ROWTYPE;
BEGIN
  parent := bank_reconciliation_require_draft(NEW.reconciliation_id);
  IF NOT EXISTS (
    SELECT 1 FROM bank_statement_imports i
     WHERE i.id = NEW.import_id AND i.reconciliation_id = NEW.reconciliation_id
  ) THEN RAISE EXCEPTION 'bank_statement_line_import_mismatch'; END IF;
  IF NEW.booked_on > parent.statement_date THEN
    RAISE EXCEPTION 'bank_statement_line_after_statement_date';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_statement_lines_guard_insert BEFORE INSERT ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION bank_statement_line_guard();

CREATE FUNCTION bank_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_parent bank_reconciliations%ROWTYPE;
DECLARE v_line bank_statement_lines%ROWTYPE;
DECLARE v_entry ledger_entry_net%ROWTYPE;
DECLARE v_payment payment_entries%ROWTYPE;
DECLARE v_payment_net BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'bank_reconciliation_matches_cannot_be_deleted'; END IF;
  v_parent := bank_reconciliation_require_draft(COALESCE(NEW.reconciliation_id, OLD.reconciliation_id));
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'bank_match_already_revoked'; END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id
       OR NEW.statement_line_id IS DISTINCT FROM OLD.statement_line_id
       OR NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id
       OR NEW.payment_entry_id IS DISTINCT FROM OLD.payment_entry_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'bank_match_facts_immutable';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO v_line FROM bank_statement_lines WHERE id = NEW.statement_line_id;
  IF NOT FOUND OR v_line.reconciliation_id <> NEW.reconciliation_id THEN
    RAISE EXCEPTION 'bank_match_line_mismatch';
  END IF;
  IF NEW.ledger_entry_id IS NOT NULL THEN
    SELECT * INTO v_entry FROM ledger_entry_net WHERE id = NEW.ledger_entry_id;
    IF NOT FOUND OR v_entry.school_year_id <> v_parent.school_year_id THEN
      RAISE EXCEPTION 'bank_match_target_mismatch';
    END IF;
    IF v_line.amount_cents <> (CASE WHEN v_entry.direction = 'income'
                                 THEN v_entry.net_amount_cents ELSE -v_entry.net_amount_cents END) THEN
      RAISE EXCEPTION 'bank_match_amount_mismatch';
    END IF;
  ELSE
    SELECT * INTO v_payment FROM payment_entries WHERE id = NEW.payment_entry_id;
    IF NOT FOUND OR v_payment.school_year_id <> v_parent.school_year_id
       OR v_payment.status NOT IN ('recorded', 'unmatched') THEN
      RAISE EXCEPTION 'bank_match_target_mismatch';
    END IF;
    SELECT v_payment.amount_cents - COALESCE(sum(c.amount_cents), 0) INTO v_payment_net
      FROM payment_corrections c WHERE c.payment_entry_id = v_payment.id;
    IF v_line.amount_cents <> v_payment_net THEN RAISE EXCEPTION 'bank_match_amount_mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_matches_guard_insert BEFORE INSERT ON bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION bank_match_guard();
CREATE TRIGGER bank_matches_guard_change BEFORE UPDATE OR DELETE ON bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION bank_match_guard();

CREATE TRIGGER bank_statement_imports_no_change BEFORE UPDATE OR DELETE ON bank_statement_imports
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER bank_statement_lines_no_change BEFORE UPDATE OR DELETE ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
