-- Spójność powiązań w uzgodnieniu rachunku (#162, część #165).
--
-- Co zmienia:
-- * Widok bank_match_consistency: każde aktywne (niecofnięte) powiązanie
--   z kwotą pozycji wyciągu, aktualną kwotą netto celu (po korektach) oraz
--   dwiema flagami: amount_matches (kwota pozycji = netto celu) i
--   double_counted (w tym samym uzgodnieniu aktywnie powiązano zarówno
--   wpłatę, jak i wpis księgi, który tę wpłatę ujmuje — te same pieniądze
--   liczone dwa razy).
-- * Nowa wersja bank_match_guard (powiązanie):
--   - blokuje wiersz uzgodnienia FOR NO KEY UPDATE, zanim cokolwiek sprawdzi:
--     dwa równoległe powiązania w jednym uzgodnieniu (także bezpośredni INSERT
--     z pominięciem API) wykonują się po kolei;
--   - blokuje wiersz celu (ledger_entries / payment_entries) FOR SHARE przed
--     porównaniem netto. Korekta trzyma ten wiersz FOR UPDATE, więc
--     powiązanie czeka na jej zatwierdzenie i porównuje kwotę z nowym netto
--     (wyścig z komentarza do #165);
--   - odrzuca wpłatę, gdy w tym uzgodnieniu aktywnie powiązano wpis księgi
--     z payment_entry_id = ta wpłata (bank_match_already_matched_via_ledger),
--     i wpis księgi, gdy aktywnie powiązano jego wpłatę
--     (bank_match_already_matched_via_payment);
--   - odrzuca wpłatę inną niż przelew (bank_match_method_mismatch) — ta sama
--     reguła co w trasie z #115, teraz także przy bezpośrednim INSERT.
--   Cofnięcie powiązania (UPDATE revoked_*) działa jak dotąd.
-- * Nowa wersja bank_reconciliation_guard (zatwierdzenie draft -> confirmed):
--   blokuje FOR SHARE wszystkie cele aktywnych powiązań (w kolejności id),
--   a potem odrzuca zatwierdzenie, jeśli któreś powiązanie ma niezgodną kwotę
--   (np. po korekcie wpisu lub wpłaty, także korekcie do zera) albo jest
--   podwójnym ujęciem (bank_reconciliation_inconsistent_matches).
--
-- Skutki dla istniejących danych:
-- * Żaden wiersz nie jest zmieniany ani usuwany; historia powiązań zostaje.
-- * Zatwierdzone uzgodnienia pozostają bez zmian (trigger działa wyłącznie
--   przy przejściu draft -> confirmed). Jeśli zawierają niespójne powiązanie,
--   pokazuje je zapytanie kontrolne poniżej; wyjaśnienie należy do skarbnika
--   i Komisji Rewizyjnej (nie ma ścieżki zmiany zatwierdzonego uzgodnienia).
-- * Szkic z niespójnym powiązaniem nie da się zatwierdzić, dopóki skarbnik nie
--   cofnie tego powiązania (z powodem, jak dotąd) i ewentualnie nie powiąże
--   pozycji ponownie. API zwraca wtedy 409 inconsistent_matches z listą.
-- * Istniejące niespójne powiązania nie blokują migracji; ich liczba jest
--   wypisywana komunikatem NOTICE. Zapytanie kontrolne:
--     SELECT c.*, r.status FROM bank_match_consistency c
--       JOIN bank_reconciliations r ON r.id = c.reconciliation_id
--      WHERE NOT c.amount_matches OR c.double_counted;
-- * Nie powstaje kolumna z kwotą celu w chwili powiązania (#165 pkt 3):
--   niezgodność powiązania zatwierdzonego po późniejszej korekcie widać tylko
--   jako różnicę między kwotą pozycji a dzisiejszym netto w widoku.
--
-- Wycofanie: przywrócenie funkcji z 0015_reconciliation.sql i DROP VIEW
-- bank_match_consistency; dane nie wymagają zmian.

CREATE VIEW bank_match_consistency AS
SELECT m.id AS match_id, m.reconciliation_id, m.statement_line_id, m.ledger_entry_id, m.payment_entry_id,
  l.amount_cents AS line_amount_cents,
  CASE WHEN m.ledger_entry_id IS NOT NULL
       THEN CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END
       ELSE p.net_amount_cents END AS target_net_cents,
  COALESCE(l.amount_cents = CASE WHEN m.ledger_entry_id IS NOT NULL
       THEN CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END
       ELSE p.net_amount_cents END, false) AS amount_matches,
  CASE WHEN m.ledger_entry_id IS NOT NULL THEN
         e.payment_entry_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM bank_reconciliation_matches o
            WHERE o.reconciliation_id = m.reconciliation_id AND o.revoked_at IS NULL
              AND o.payment_entry_id = e.payment_entry_id)
       ELSE EXISTS (
           SELECT 1 FROM bank_reconciliation_matches o
             JOIN ledger_entries le ON le.id = o.ledger_entry_id
            WHERE o.reconciliation_id = m.reconciliation_id AND o.revoked_at IS NULL
              AND le.payment_entry_id = m.payment_entry_id)
  END AS double_counted
FROM bank_reconciliation_matches m
JOIN bank_statement_lines l ON l.id = m.statement_line_id
LEFT JOIN ledger_entry_net e ON e.id = m.ledger_entry_id
LEFT JOIN payment_entry_net p ON p.id = m.payment_entry_id
WHERE m.revoked_at IS NULL;

CREATE OR REPLACE FUNCTION bank_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_parent bank_reconciliations%ROWTYPE;
DECLARE v_line bank_statement_lines%ROWTYPE;
DECLARE v_entry ledger_entry_net%ROWTYPE;
DECLARE v_payment payment_entries%ROWTYPE;
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
    SELECT v_payment.amount_cents - COALESCE(sum(c.amount_cents), 0) INTO v_payment_net
      FROM payment_corrections c WHERE c.payment_entry_id = v_payment.id;
    IF v_line.amount_cents <> v_payment_net THEN RAISE EXCEPTION 'bank_match_amount_mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION bank_reconciliation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- Draft -> confirmed: cele aktywnych powiązań blokowane przed ponownym
  -- sprawdzeniem kwot (korekta w toku kończy się pierwsza), w stałej kolejności.
  PERFORM 1 FROM ledger_entries e
    WHERE e.id IN (SELECT m.ledger_entry_id FROM bank_reconciliation_matches m
                    WHERE m.reconciliation_id = NEW.id AND m.revoked_at IS NULL)
    ORDER BY e.id FOR SHARE;
  PERFORM 1 FROM payment_entries p
    WHERE p.id IN (SELECT m.payment_entry_id FROM bank_reconciliation_matches m
                    WHERE m.reconciliation_id = NEW.id AND m.revoked_at IS NULL)
    ORDER BY p.id FOR SHARE;
  IF EXISTS (
    SELECT 1 FROM bank_match_consistency c
     WHERE c.reconciliation_id = NEW.id AND (NOT c.amount_matches OR c.double_counted)
  ) THEN RAISE EXCEPTION 'bank_reconciliation_inconsistent_matches'; END IF;
  -- Draft -> confirmed: freeze the ledger balance as of the confirmation.
  NEW.ledger_balance_cents := ledger_balance_at(NEW.school_year_id, NEW.statement_date);
  NEW.ledger_non_bank_cents := ledger_non_bank_net_at(NEW.school_year_id, NEW.statement_date);
  RETURN NEW;
END;
$$;

DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM bank_match_consistency WHERE NOT amount_matches OR double_counted;
  IF v_count > 0 THEN
    RAISE NOTICE 'bank_match_consistency: % aktywnych powiązań niespójnych (bez zmian; zob. zapytanie kontrolne w 0024)', v_count;
  END IF;
END;
$$;
