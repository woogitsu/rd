-- Dopasowanie zwrotu wpłaty do ujemnej pozycji wyciągu (#138).
--
-- Problem: zwrot (payment_refunds, 0038) zmniejsza netto wpłaty, ale
-- bank_reconciliation_matches nie miało celu „zwrot”. Ujemnej pozycji wyciągu
-- (wypływ) nie dało się powiązać z niczym, a bank_match_guard (0024) liczył
-- kwotę celu wpłaty jako kwotę − korekty (bez zwrotów), podczas gdy widok
-- bank_match_consistency porównywał ją z payment_entry_net.net_amount_cents
-- (po zwrotach). Powiązanie przyjęte przez trigger mogło więc być od razu
-- „niezgodne” w widoku, a zwrot po powiązaniu wpłaty blokował zatwierdzenie szkicu.
--
-- Model: wpływ i zwrot to dwa osobne zdarzenia bankowe.
-- * Dodatnia pozycja ↔ wpłata: kwota = wpłata − korekty (zwroty NIE zmniejszają
--   kwoty wpływu; tak liczył już trigger i propozycje w API).
-- * Ujemna pozycja ↔ zwrot: kwota pozycji = −kwota zwrotu (zwrot częściowy
--   = własna, niezmienna kwota zwrotu). Zwrot musi być metodą 'bank' i należeć
--   do wpłaty z roku uzgodnienia. Pozycja dodatnia albo o innej kwocie:
--   bank_match_amount_mismatch (API 409 match_amount_mismatch).
--
-- Co zmienia:
-- * Kolumna bank_reconciliation_matches.payment_refund_id (FK payment_refunds).
--   Cel powiązania: dokładnie jedno z ledger_entry_id, payment_entry_id,
--   payment_refund_id (CHECK bank_match_single_target zastąpiony).
-- * Unikalny indeks aktywnych powiązań zwrotu w uzgodnieniu.
-- * bank_match_guard: gałąź zwrotu (blokada wiersza zwrotu i wpłaty FOR SHARE,
--   rok, metoda, kwota, jedno aktywne powiązanie zwrotu w roku pod tą samą
--   blokadą doradczą roku co 0089/0105); UPDATE nie zmienia payment_refund_id.
--   Poza gałęzią zwrotu ciało funkcji jest identyczne z 0024.
-- * bank_match_consistency: cel zwrotu = −kwota zwrotu; cel wpłaty = wpłata −
--   korekty (jak w triggerze). Nowa kolumna payment_refund_id na końcu.
--
-- Skutki dla istniejących danych:
-- * Żaden wiersz nie jest zmieniany ani usuwany; nowa kolumna jest NULL dla
--   wszystkich istniejących powiązań, a CHECK jest spełniony przez każde z nich.
-- * Zmiana widoku dotyczy wyłącznie powiązań wpłat, których wpłata ma zwroty:
--   dotąd taki cel liczył się po zwrotach (i powiązanie z kwotą wpływu było
--   „niezgodne”), teraz przed zwrotami. Powiązania niezgodne wyłącznie z tego
--   powodu przestają być raportowane jako amount_mismatch (także w raporcie KR
--   i w zatwierdzonych uzgodnieniach). Sprawdzenie przed migracją:
--     SELECT c.match_id, c.reconciliation_id, c.line_amount_cents, c.target_net_cents
--       FROM bank_match_consistency c JOIN payment_entry_net p ON p.id = c.payment_entry_id
--      WHERE p.refunded_cents > 0;
-- * Dopasowania zbiorcze (0105) i cele „wpis księgi” bez zmian: wpłata z
--   pozycją zbiorczą nadal wymaga kwoty po zwrotach; wpis księgi powiązany
--   z wpłatą ma netto po korekcie księgi (ledger_correction_required).
-- * Zwroty już zapisane mogą zostać powiązane z pozycją dopiero w szkicu
--   uzgodnienia; zatwierdzone uzgodnienia są niezmienne.
--
-- Wycofanie: na bazie bez powiązań zwrotów — przywrócić bank_match_guard
-- i widok z 0024, CHECK z 0015, DROP INDEX bank_matches_active_refund_idx,
-- DROP COLUMN payment_refund_id. Z powiązaniami zwrotów — tylko po kopii
-- zapasowej i decyzji o retencji (D-04): pozycje wypływu wrócą do „niedopasowanych”.

ALTER TABLE bank_reconciliation_matches
  ADD COLUMN payment_refund_id TEXT REFERENCES payment_refunds(id);

ALTER TABLE bank_reconciliation_matches DROP CONSTRAINT bank_match_single_target;
ALTER TABLE bank_reconciliation_matches ADD CONSTRAINT bank_match_single_target
  CHECK (num_nonnulls(ledger_entry_id, payment_entry_id, payment_refund_id) = 1);

CREATE UNIQUE INDEX bank_matches_active_refund_idx
  ON bank_reconciliation_matches(reconciliation_id, payment_refund_id)
  WHERE revoked_at IS NULL AND payment_refund_id IS NOT NULL;

CREATE OR REPLACE VIEW bank_match_consistency AS
SELECT m.id AS match_id, m.reconciliation_id, m.statement_line_id, m.ledger_entry_id, m.payment_entry_id,
  l.amount_cents AS line_amount_cents,
  CASE WHEN m.ledger_entry_id IS NOT NULL
       THEN CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END
       WHEN m.payment_refund_id IS NOT NULL THEN -rf.amount_cents::BIGINT
       ELSE p.net_amount_cents + p.refunded_cents END AS target_net_cents,
  COALESCE(l.amount_cents = CASE WHEN m.ledger_entry_id IS NOT NULL
       THEN CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END
       WHEN m.payment_refund_id IS NOT NULL THEN -rf.amount_cents::BIGINT
       ELSE p.net_amount_cents + p.refunded_cents END, false) AS amount_matches,
  CASE WHEN m.ledger_entry_id IS NOT NULL THEN
         e.payment_entry_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM bank_reconciliation_matches o
            WHERE o.reconciliation_id = m.reconciliation_id AND o.revoked_at IS NULL
              AND o.payment_entry_id = e.payment_entry_id)
       WHEN m.payment_refund_id IS NOT NULL THEN false
       ELSE EXISTS (
           SELECT 1 FROM bank_reconciliation_matches o
             JOIN ledger_entries le ON le.id = o.ledger_entry_id
            WHERE o.reconciliation_id = m.reconciliation_id AND o.revoked_at IS NULL
              AND le.payment_entry_id = m.payment_entry_id)
  END AS double_counted,
  m.payment_refund_id
FROM bank_reconciliation_matches m
JOIN bank_statement_lines l ON l.id = m.statement_line_id
LEFT JOIN ledger_entry_net e ON e.id = m.ledger_entry_id
LEFT JOIN payment_entry_net p ON p.id = m.payment_entry_id
LEFT JOIN payment_refunds rf ON rf.id = m.payment_refund_id
WHERE m.revoked_at IS NULL;

-- Od 0024 (najnowsza wersja): dodana wyłącznie gałąź zwrotu i niezmienność payment_refund_id.
CREATE OR REPLACE FUNCTION bank_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_parent bank_reconciliations%ROWTYPE;
DECLARE v_line bank_statement_lines%ROWTYPE;
DECLARE v_entry ledger_entry_net%ROWTYPE;
DECLARE v_payment payment_entries%ROWTYPE;
DECLARE v_refund payment_refunds%ROWTYPE;
DECLARE v_payment_net BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'bank_reconciliation_matches_cannot_be_deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    -- Powiązania jednego uzgodnienia po kolei (przed FOR SHARE w require_draft,
    -- żeby dwie transakcje nie czekały na siebie nawzajem).
    PERFORM 1 FROM bank_reconciliations WHERE id = NEW.reconciliation_id FOR NO KEY UPDATE;
  END IF;
  v_parent := bank_reconciliation_require_draft(COALESCE(NEW.reconciliation_id, OLD.reconciliation_id));
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'bank_match_already_revoked'; END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.reconciliation_id IS DISTINCT FROM OLD.reconciliation_id
       OR NEW.statement_line_id IS DISTINCT FROM OLD.statement_line_id
       OR NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id
       OR NEW.payment_entry_id IS DISTINCT FROM OLD.payment_entry_id
       OR NEW.payment_refund_id IS DISTINCT FROM OLD.payment_refund_id
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
    -- Blokada celu przed odczytem netto: równoległa korekta kończy się pierwsza.
    PERFORM 1 FROM ledger_entries WHERE id = NEW.ledger_entry_id FOR SHARE;
    SELECT * INTO v_entry FROM ledger_entry_net WHERE id = NEW.ledger_entry_id;
    IF NOT FOUND OR v_entry.school_year_id <> v_parent.school_year_id THEN
      RAISE EXCEPTION 'bank_match_target_mismatch';
    END IF;
    IF v_entry.payment_entry_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM bank_reconciliation_matches o
       WHERE o.reconciliation_id = NEW.reconciliation_id AND o.revoked_at IS NULL
         AND o.payment_entry_id = v_entry.payment_entry_id
    ) THEN RAISE EXCEPTION 'bank_match_already_matched_via_payment'; END IF;
    IF v_line.amount_cents <> (CASE WHEN v_entry.direction = 'income'
                                 THEN v_entry.net_amount_cents ELSE -v_entry.net_amount_cents END) THEN
      RAISE EXCEPTION 'bank_match_amount_mismatch';
    END IF;
  ELSIF NEW.payment_refund_id IS NOT NULL THEN
    -- Zwrot (wypływ) ↔ ujemna pozycja o kwocie równej −kwota zwrotu (#138).
    SELECT * INTO v_refund FROM payment_refunds WHERE id = NEW.payment_refund_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'bank_match_target_mismatch'; END IF;
    SELECT * INTO v_payment FROM payment_entries WHERE id = v_refund.payment_entry_id FOR SHARE;
    IF NOT FOUND OR v_payment.school_year_id <> v_parent.school_year_id THEN
      RAISE EXCEPTION 'bank_match_target_mismatch';
    END IF;
    IF v_refund.method <> 'bank' THEN RAISE EXCEPTION 'bank_match_method_mismatch'; END IF;
    IF v_line.amount_cents <> -v_refund.amount_cents::BIGINT THEN
      RAISE EXCEPTION 'bank_match_amount_mismatch';
    END IF;
    -- Zwrot aktywnie powiązany w innym uzgodnieniu tego roku: ta sama blokada
    -- doradcza roku co bank_match_year_unique_guard (0089).
    PERFORM pg_advisory_xact_lock(hashtext('bank_match_year:' || v_parent.school_year_id));
    IF EXISTS (
      SELECT 1 FROM bank_reconciliation_matches o
        JOIN bank_reconciliations r ON r.id = o.reconciliation_id
       WHERE r.school_year_id = v_parent.school_year_id AND o.reconciliation_id <> NEW.reconciliation_id
         AND o.revoked_at IS NULL AND o.payment_refund_id = NEW.payment_refund_id
    ) THEN RAISE EXCEPTION 'bank_match_in_other_reconciliation'; END IF;
  ELSE
    SELECT * INTO v_payment FROM payment_entries WHERE id = NEW.payment_entry_id FOR SHARE;
    IF NOT FOUND OR v_payment.school_year_id <> v_parent.school_year_id
       OR v_payment.status NOT IN ('recorded', 'unmatched') THEN
      RAISE EXCEPTION 'bank_match_target_mismatch';
    END IF;
    IF v_payment.method <> 'bank' THEN RAISE EXCEPTION 'bank_match_method_mismatch'; END IF;
    IF EXISTS (
      SELECT 1 FROM bank_reconciliation_matches o
        JOIN ledger_entries le ON le.id = o.ledger_entry_id
       WHERE o.reconciliation_id = NEW.reconciliation_id AND o.revoked_at IS NULL
         AND le.payment_entry_id = NEW.payment_entry_id
    ) THEN RAISE EXCEPTION 'bank_match_already_matched_via_ledger'; END IF;
    -- Kwota wpływu = wpłata − korekty. Zwroty są osobnym zdarzeniem bankowym
    -- (wypływ), więc jej NIE zmniejszają — widok bank_match_consistency liczy tak samo.
    SELECT v_payment.amount_cents - COALESCE(sum(c.amount_cents), 0) INTO v_payment_net
      FROM payment_corrections c WHERE c.payment_entry_id = v_payment.id;
    IF v_line.amount_cents <> v_payment_net THEN RAISE EXCEPTION 'bank_match_amount_mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
