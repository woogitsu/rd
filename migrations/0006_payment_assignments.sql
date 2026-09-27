-- Auditable, one-time assignment of an unmatched payment to a household.

CREATE TABLE payment_assignments (
  id TEXT PRIMARY KEY,
  payment_entry_id TEXT NOT NULL UNIQUE REFERENCES payment_entries(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 8 AND 128)
);

CREATE INDEX payment_assignments_household_idx
  ON payment_assignments(household_id, created_at);

CREATE TRIGGER payment_assignments_only_for_unmatched
BEFORE INSERT ON payment_assignments
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_entries
  WHERE id = NEW.payment_entry_id
    AND status = 'unmatched'
    AND household_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'payment_not_unmatched');
END;

CREATE TRIGGER payment_entries_assignment_transition_guard
BEFORE UPDATE OF household_id, status ON payment_entries
WHEN NOT (
  NEW.household_id IS OLD.household_id
  AND NEW.status = OLD.status
)
AND NOT (
  OLD.status = 'unmatched'
  AND OLD.household_id IS NULL
  AND NEW.status = 'recorded'
  AND NEW.household_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM payment_assignments assignment
    WHERE assignment.payment_entry_id = OLD.id
      AND assignment.household_id = NEW.household_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'payment_assignment_event_required');
END;

CREATE TRIGGER payment_assignments_no_update
BEFORE UPDATE ON payment_assignments
BEGIN
  SELECT RAISE(ABORT, 'payment_assignments_cannot_be_updated');
END;

CREATE TRIGGER payment_assignments_no_delete
BEFORE DELETE ON payment_assignments
BEGIN
  SELECT RAISE(ABORT, 'payment_assignments_cannot_be_deleted');
END;
