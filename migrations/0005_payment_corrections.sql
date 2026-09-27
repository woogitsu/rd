-- Immutable payment facts and additive corrections.
-- A correction reduces a recorded amount without replacing the original entry.

CREATE TABLE payment_corrections (
  id TEXT PRIMARY KEY,
  payment_entry_id TEXT NOT NULL REFERENCES payment_entries(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) BETWEEN 8 AND 128)
);

CREATE INDEX payment_corrections_entry_idx
  ON payment_corrections(payment_entry_id, created_at);

CREATE TRIGGER payment_entries_require_idempotency_key
BEFORE INSERT ON payment_entries
WHEN NEW.idempotency_key IS NULL
  OR length(trim(NEW.idempotency_key)) NOT BETWEEN 8 AND 128
BEGIN
  SELECT RAISE(ABORT, 'payment_idempotency_key_required');
END;

CREATE TRIGGER payment_entries_financial_facts_immutable
BEFORE UPDATE ON payment_entries
WHEN NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.school_year_id IS NOT OLD.school_year_id
  OR NEW.received_on IS NOT OLD.received_on
  OR NEW.method IS NOT OLD.method
  OR NEW.reference IS NOT OLD.reference
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'payment_financial_facts_immutable');
END;

CREATE TRIGGER payment_entries_use_correction_instead_of_reversed_status
BEFORE UPDATE OF status ON payment_entries
WHEN NEW.status = 'reversed' AND OLD.status <> 'reversed'
BEGIN
  SELECT RAISE(ABORT, 'payment_correction_required');
END;

CREATE TRIGGER payment_entries_no_delete
BEFORE DELETE ON payment_entries
BEGIN
  SELECT RAISE(ABORT, 'payment_entries_cannot_be_deleted');
END;

CREATE TRIGGER payment_corrections_do_not_exceed_payment
BEFORE INSERT ON payment_corrections
WHEN NEW.amount_cents > (
  SELECT payment.amount_cents - COALESCE((
    SELECT SUM(existing.amount_cents)
    FROM payment_corrections existing
    WHERE existing.payment_entry_id = payment.id
  ), 0)
  FROM payment_entries payment
  WHERE payment.id = NEW.payment_entry_id
)
BEGIN
  SELECT RAISE(ABORT, 'payment_correction_exceeds_remaining_amount');
END;

CREATE TRIGGER payment_corrections_reject_legacy_reversed_payment
BEFORE INSERT ON payment_corrections
WHEN (SELECT status FROM payment_entries WHERE id = NEW.payment_entry_id) = 'reversed'
BEGIN
  SELECT RAISE(ABORT, 'legacy_reversed_payment_cannot_be_corrected');
END;

CREATE TRIGGER payment_corrections_no_update
BEFORE UPDATE ON payment_corrections
BEGIN
  SELECT RAISE(ABORT, 'payment_corrections_cannot_be_updated');
END;

CREATE TRIGGER payment_corrections_no_delete
BEFORE DELETE ON payment_corrections
BEGIN
  SELECT RAISE(ABORT, 'payment_corrections_cannot_be_deleted');
END;

CREATE VIEW household_payment_totals AS
SELECT
  payment.household_id,
  payment.school_year_id,
  SUM(payment.amount_cents - COALESCE(correction.corrected_cents, 0)) AS net_amount_cents,
  COUNT(*) AS payment_count
FROM payment_entries payment
LEFT JOIN (
  SELECT payment_entry_id, SUM(amount_cents) AS corrected_cents
  FROM payment_corrections
  GROUP BY payment_entry_id
) correction ON correction.payment_entry_id = payment.id
WHERE payment.status = 'recorded'
  AND payment.household_id IS NOT NULL
GROUP BY payment.household_id, payment.school_year_id;
