-- Korekta wpisu/wpłaty z aktywnym powiązaniem w SZKICU uzgodnienia (#165, reszta).
--
-- Co zmienia:
-- * ledger_correction_guard, payment_correction_guard: przed zapisaniem korekty
--   sprawdzają, czy wpis księgi / wpłata ma aktywne (niecofnięte) powiązanie
--   w uzgodnieniu o statusie 'draft'. Jeśli tak — odrzucają korektę
--   (`active_bank_match`, API: 409 z `reconciliationId` do cofnięcia).
--   Wariant zachowawczy z #165: system NIE cofa powiązania automatycznie —
--   skarbnik najpierw cofa je sam (z powodem, jak dziś), dopiero potem
--   koryguje wpis/wpłatę. Powiązanie w uzgodnieniu JUŻ ZATWIERDZONYM nie
--   blokuje korekty (zatwierdzone uzgodnienie jest niezmienne — patrz punkt
--   5 raportu KR i sekcja „reconciliation_matches” z licznikiem powiązań,
--   które stały się niezgodne po zatwierdzeniu).
-- * Aplikacja (src/pg/routes/ledger.js, src/pg/routes/payments.js) sprawdza to
--   samo przed zapisem, żeby zwrócić czytelny 409 z identyfikatorem
--   uzgodnienia; ten trigger jest backstopem przy bezpośrednim INSERT.
--
-- Zazębienie z #138 (kolejność scalania ma znaczenie): #138 zmienia też
-- payment_correction_guard (dodaje payment_refunds/payment_reassignments do
-- sumy skorygowanej kwoty i blokadę `ledger_correction_required`, gdy wpłata
-- ma powiązany wpis księgi o innym netto). Funkcja poniżej ZAKŁADA, że #138
-- scala się przed tym PR-em, i zawiera obie kontrole (z #138 i z #165) w
-- jednym ciele funkcji — CREATE OR REPLACE FUNCTION nie łączy definicji
-- przyrostowo. Jeśli #138 zostanie scalony PO tym PR-ze, tę migrację trzeba
-- będzie zaktualizować (bez tego kontrola z #138 zniknie).
--
-- Skutki dla istniejących danych: żaden wiersz nie jest zmieniany ani
-- usuwany. Istniejące niezgodne powiązania w szkicach nie są cofane wstecz —
-- pozostają blokadą dla PRZYSZŁEJ korekty, dopóki skarbnik ich nie cofnie.
-- Zapytanie kontrolne (aktywne powiązania w szkicu, które dziś blokowałyby
-- korektę swojego celu):
--   SELECT m.id AS match_id, m.reconciliation_id, m.ledger_entry_id, m.payment_entry_id
--     FROM bank_reconciliation_matches m JOIN bank_reconciliations r ON r.id = m.reconciliation_id
--    WHERE m.revoked_at IS NULL AND r.status = 'draft';
--
-- Wycofanie: przywrócenie ledger_correction_guard z 0003_ledger.sql i
-- payment_correction_guard z 0002_payments.sql (albo z migracji #138, jeśli
-- już scalona). Dane nie wymagają zmian.

CREATE OR REPLACE FUNCTION ledger_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original ledger_entries%ROWTYPE;
DECLARE corrected BIGINT;
DECLARE active_match TEXT;
BEGIN
  SELECT * INTO original FROM ledger_entries WHERE id = NEW.ledger_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger_entry_not_found'; END IF;
  SELECT r.id INTO active_match FROM bank_reconciliation_matches m
    JOIN bank_reconciliations r ON r.id = m.reconciliation_id
   WHERE m.ledger_entry_id = NEW.ledger_entry_id AND m.revoked_at IS NULL AND r.status = 'draft'
   LIMIT 1;
  IF active_match IS NOT NULL THEN RAISE EXCEPTION 'active_bank_match'; END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO corrected
    FROM ledger_corrections WHERE ledger_entry_id = NEW.ledger_entry_id;
  IF corrected + NEW.amount_cents > original.amount_cents THEN
    RAISE EXCEPTION 'ledger_correction_exceeds_remaining_amount';
  END IF;
  RETURN NEW;
END;
$$;

-- Superset #138 (payment_refunds, payment_reassignments, ledger_correction_required)
-- + #165 (active_bank_match). Patrz uwaga o kolejności scalania powyżej.
CREATE OR REPLACE FUNCTION payment_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original payment_entries%ROWTYPE;
DECLARE corrected BIGINT;
DECLARE refunded BIGINT;
DECLARE new_net BIGINT;
DECLARE active_match TEXT;
DECLARE has_refunds_table BOOLEAN;
DECLARE consistent_fails BOOLEAN;
BEGIN
  SELECT * INTO original FROM payment_entries WHERE id = NEW.payment_entry_id FOR UPDATE;
  IF NOT FOUND OR original.status = 'reversed' THEN
    RAISE EXCEPTION 'legacy_reversed_payment_cannot_be_corrected';
  END IF;
  SELECT r.id INTO active_match FROM bank_reconciliation_matches m
    JOIN bank_reconciliations r ON r.id = m.reconciliation_id
   WHERE m.payment_entry_id = NEW.payment_entry_id AND m.revoked_at IS NULL AND r.status = 'draft'
   LIMIT 1;
  IF active_match IS NOT NULL THEN RAISE EXCEPTION 'active_bank_match'; END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO corrected
    FROM payment_corrections WHERE payment_entry_id = NEW.payment_entry_id;
  -- payment_refunds istnieje dopiero po #138; do czasu scalenia traktujemy
  -- zwroty jako zero, żeby ta migracja dała się zastosować niezależnie od
  -- kolejności (patrz uwaga o zazębieniu powyżej).
  SELECT to_regclass('payment_refunds') IS NOT NULL INTO has_refunds_table;
  IF has_refunds_table THEN
    EXECUTE 'SELECT COALESCE(sum(amount_cents), 0) FROM payment_refunds WHERE payment_entry_id = $1'
      INTO refunded USING NEW.payment_entry_id;
  ELSE
    refunded := 0;
  END IF;
  IF corrected + refunded + NEW.amount_cents > original.amount_cents THEN
    RAISE EXCEPTION 'payment_correction_exceeds_remaining_amount';
  END IF;
  new_net := original.amount_cents - corrected - refunded - NEW.amount_cents;
  -- EXECUTE odracza rozwiązanie nazwy funkcji do czasu wykonania: w przeciwnym
  -- razie PL/pgSQL odrzuciłby całą funkcję już przy tworzeniu, gdyby
  -- payment_ledger_link_consistent (z #138) jeszcze nie istniała.
  IF to_regprocedure('payment_ledger_link_consistent(text, bigint)') IS NOT NULL THEN
    EXECUTE 'SELECT NOT payment_ledger_link_consistent($1, $2)' INTO STRICT consistent_fails
      USING NEW.payment_entry_id, new_net;
    IF consistent_fails THEN RAISE EXCEPTION 'ledger_correction_required'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
