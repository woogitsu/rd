-- A recorded payment can be represented by at most one income entry in the same school year.

CREATE UNIQUE INDEX ledger_entries_payment_entry_idx
  ON ledger_entries(payment_entry_id)
  WHERE payment_entry_id IS NOT NULL;

CREATE TRIGGER ledger_entries_validate_payment_link
BEFORE INSERT ON ledger_entries
WHEN NEW.payment_entry_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM payment_entries payment
    WHERE payment.id = NEW.payment_entry_id
      AND payment.school_year_id = NEW.school_year_id
      AND payment.status = 'recorded'
      AND NEW.direction = 'income'
  )
BEGIN
  SELECT RAISE(ABORT, 'ledger_payment_link_mismatch');
END;
