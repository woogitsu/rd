-- Immutable voluntary payment facts. Amounts are integer EUR cents.
-- A new payment never represents a receivable or debt.

CREATE TABLE payment_entries (
  id TEXT PRIMARY KEY,
  household_id TEXT REFERENCES households(id),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  received_on DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('bank', 'cash', 'other')),
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded', 'unmatched', 'reversed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  CONSTRAINT payment_household_status CHECK (
    (status = 'unmatched' AND household_id IS NULL)
    OR (status = 'recorded' AND household_id IS NOT NULL)
    OR status = 'reversed'
  )
);
CREATE INDEX payment_household_year_idx ON payment_entries(household_id, school_year_id);
CREATE INDEX payment_year_status_idx ON payment_entries(school_year_id, status, received_on);

CREATE TABLE payment_assignments (
  id TEXT PRIMARY KEY,
  payment_entry_id TEXT NOT NULL UNIQUE REFERENCES payment_entries(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE INDEX payment_assignments_household_idx ON payment_assignments(household_id, created_at);

CREATE TABLE payment_corrections (
  id TEXT PRIMARY KEY,
  payment_entry_id TEXT NOT NULL REFERENCES payment_entries(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE INDEX payment_corrections_entry_idx ON payment_corrections(payment_entry_id, created_at);

CREATE FUNCTION payment_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_entries_cannot_be_deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.school_year_id IS DISTINCT FROM OLD.school_year_id
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.received_on IS DISTINCT FROM OLD.received_on
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'payment_financial_facts_immutable';
  END IF;
  IF NEW.household_id IS DISTINCT FROM OLD.household_id
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status = 'unmatched' AND OLD.household_id IS NULL
      AND NEW.status = 'recorded' AND NEW.household_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM payment_assignments a
        WHERE a.payment_entry_id = OLD.id AND a.household_id = NEW.household_id)) THEN
      RAISE EXCEPTION 'payment_assignment_event_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_entries_guard_update BEFORE UPDATE ON payment_entries
  FOR EACH ROW EXECUTE FUNCTION payment_entry_guard();
CREATE TRIGGER payment_entries_guard_delete BEFORE DELETE ON payment_entries
  FOR EACH ROW EXECUTE FUNCTION payment_entry_guard();

CREATE FUNCTION payment_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original payment_entries%ROWTYPE;
BEGIN
  SELECT * INTO original FROM payment_entries WHERE id = NEW.payment_entry_id FOR UPDATE;
  IF NOT FOUND OR original.status <> 'unmatched' OR original.household_id IS NOT NULL THEN
    RAISE EXCEPTION 'payment_not_unmatched';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_assignments_guard_insert BEFORE INSERT ON payment_assignments
  FOR EACH ROW EXECUTE FUNCTION payment_assignment_guard();

CREATE FUNCTION payment_assignment_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE payment_entries SET household_id = NEW.household_id, status = 'recorded'
    WHERE id = NEW.payment_entry_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_assignments_apply_insert AFTER INSERT ON payment_assignments
  FOR EACH ROW EXECUTE FUNCTION payment_assignment_apply();

CREATE FUNCTION payment_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original payment_entries%ROWTYPE;
DECLARE corrected BIGINT;
BEGIN
  SELECT * INTO original FROM payment_entries WHERE id = NEW.payment_entry_id FOR UPDATE;
  IF NOT FOUND OR original.status = 'reversed' THEN
    RAISE EXCEPTION 'legacy_reversed_payment_cannot_be_corrected';
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO corrected
    FROM payment_corrections WHERE payment_entry_id = NEW.payment_entry_id;
  IF corrected + NEW.amount_cents > original.amount_cents THEN
    RAISE EXCEPTION 'payment_correction_exceeds_remaining_amount';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_corrections_guard_insert BEFORE INSERT ON payment_corrections
  FOR EACH ROW EXECUTE FUNCTION payment_correction_guard();

CREATE FUNCTION immutable_payment_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%_cannot_be_changed', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER payment_assignments_no_change BEFORE UPDATE OR DELETE ON payment_assignments
  FOR EACH ROW EXECUTE FUNCTION immutable_payment_event();
CREATE TRIGGER payment_corrections_no_change BEFORE UPDATE OR DELETE ON payment_corrections
  FOR EACH ROW EXECUTE FUNCTION immutable_payment_event();

CREATE VIEW payment_entry_net AS
SELECT p.*, COALESCE(c.corrected_cents, 0) AS corrected_cents,
  p.amount_cents::BIGINT - COALESCE(c.corrected_cents, 0) AS net_amount_cents
FROM payment_entries p
LEFT JOIN (
  SELECT payment_entry_id, sum(amount_cents) AS corrected_cents
  FROM payment_corrections GROUP BY payment_entry_id
) c ON c.payment_entry_id = p.id;

CREATE VIEW household_payment_totals AS
SELECT household_id, school_year_id, sum(net_amount_cents) AS net_amount_cents,
  count(*) AS payment_count
FROM payment_entry_net
WHERE status = 'recorded' AND household_id IS NOT NULL
GROUP BY household_id, school_year_id;
