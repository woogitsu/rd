-- Podział jednej wpłaty na kilka gospodarstw (#127, część 1).
--
-- Co zmienia:
-- * payment_allocations — niezmienna część wpłaty przypisana jednemu
--   gospodarstwu (kwota w centach > 0, aktor, czas, klucz idempotencji).
--   Podzielić można WYŁĄCZNIE wpłatę nieprzypisaną (status 'unmatched',
--   household_id IS NULL): przelew zbiorczy kilku rodzin, rodzeństwo
--   w różnych gospodarstwach. Wpłata zostaje 'unmatched' (bez jednego
--   gospodarstwa), a jej części widać w gospodarstwach.
-- * payment_allocation_reversals — cofnięcie błędnej części jako nowy,
--   niezmienny zapis z powodem (najwyżej jedno cofnięcie na część). Części
--   nie da się zmienić ani usunąć; błąd = cofnięcie + nowa część.
-- * payment_allocations_current — części bez cofnięcia.
-- * Suma bieżących części ≤ netto wpłaty (kwota - korekty - zwroty):
--   trigger na payment_allocations blokuje wiersz wpłaty (FOR UPDATE), więc
--   równoległe podziały przekraczające kwotę kończą się jednym odrzuceniem
--   (`payment_allocation_exceeds_net`). Korekta lub zwrot, po których netto
--   spadłoby poniżej sumy bieżących części, są odrzucane tym samym kodem:
--   najpierw cofnięcie części, potem korekta. To OSOBNE triggery na
--   payment_corrections i payment_refunds — payment_correction_guard (0039)
--   i payment_refund_guard (0038) nie są redefiniowane.
-- * Jedno gospodarstwo ma najwyżej jedną bieżącą część danej wpłaty
--   (`payment_allocation_household_exists`) — chroni przed podwójnym
--   kliknięciem z nowym kluczem.
-- * Zwykłe przypisanie (payment_assignments) wpłaty z bieżącymi częściami
--   jest odrzucane (`payment_has_allocations`) — osobny trigger,
--   payment_assignment_guard (0002) nie jest redefiniowany.
-- * household_payment_totals liczy też bieżące części wpłat nieprzypisanych
--   (te same kolumny i typy; CREATE OR REPLACE VIEW). Dla danych bez części
--   wynik jest identyczny jak przed migracją.
-- * Obie tabele: niezmienne (immutable_financial_record) i objęte zamrożeniem
--   roku (year_freeze_direct na własnej kolumnie school_year_id; bez zmiany
--   year_freeze_via_parent).
--
-- Skutki dla istniejących danych: tylko nowe tabele, widok, funkcje
-- i triggery. Żaden wiersz nie jest zmieniany. Istniejące przypisania
-- (payment_entries.household_id, payment_assignments) zostają bez zmian —
-- NIE ma migracji 1:1 istniejących wpłat do payment_allocations (wariant
-- zachowawczy; wpłata z jednym gospodarstwem dalej liczy się przez
-- household_id). Sumy household_payment_totals, raportu KR, zamknięcia roku,
-- kartek i eksportu są przed i po migracji równe, dopóki nikt nie utworzy
-- części.
--
-- Wycofanie: na bazie bez części — DROP VIEW payment_allocations_current po
-- przywróceniu household_payment_totals z 0002_payments.sql, DROP TABLE
-- payment_allocation_reversals, payment_allocations, DROP FUNCTION poniżej.
-- Na bazie z częściami — tylko po kopii zapasowej: sumy gospodarstw
-- zmaleją o części, a wpłaty wrócą do stanu „nieprzypisana”.

CREATE TABLE payment_allocations (
  id TEXT PRIMARY KEY,
  payment_entry_id TEXT NOT NULL REFERENCES payment_entries(id),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations(payment_entry_id, created_at);
CREATE INDEX payment_allocations_household_year_idx ON payment_allocations(household_id, school_year_id);

CREATE TABLE payment_allocation_reversals (
  id TEXT PRIMARY KEY,
  allocation_id TEXT NOT NULL UNIQUE REFERENCES payment_allocations(id),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);

CREATE VIEW payment_allocations_current AS
SELECT a.id, a.payment_entry_id, a.school_year_id, a.household_id, a.amount_cents, a.created_by, a.created_at
FROM payment_allocations a
WHERE NOT EXISTS (SELECT 1 FROM payment_allocation_reversals r WHERE r.allocation_id = a.id);

-- Suma bieżących części wpłaty (bez blokady — wołający blokuje wpłatę).
CREATE FUNCTION payment_allocated_cents(p_payment_id TEXT) RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(amount_cents), 0)::BIGINT FROM payment_allocations_current WHERE payment_entry_id = p_payment_id;
$$;

CREATE FUNCTION payment_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original payment_entries%ROWTYPE;
DECLARE net BIGINT;
BEGIN
  SELECT * INTO original FROM payment_entries WHERE id = NEW.payment_entry_id FOR UPDATE;
  IF NOT FOUND OR original.status <> 'unmatched' OR original.household_id IS NOT NULL THEN
    RAISE EXCEPTION 'payment_not_unmatched';
  END IF;
  IF NEW.school_year_id IS DISTINCT FROM original.school_year_id THEN
    RAISE EXCEPTION 'payment_allocation_year_mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_allocations_current
              WHERE payment_entry_id = NEW.payment_entry_id AND household_id = NEW.household_id) THEN
    RAISE EXCEPTION 'payment_allocation_household_exists';
  END IF;
  SELECT net_amount_cents INTO net FROM payment_entry_net WHERE id = NEW.payment_entry_id;
  IF payment_allocated_cents(NEW.payment_entry_id) + NEW.amount_cents > net THEN
    RAISE EXCEPTION 'payment_allocation_exceeds_net';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER payment_allocations_guard_insert BEFORE INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION payment_allocation_guard();
CREATE TRIGGER payment_allocations_no_change BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();

CREATE FUNCTION payment_allocation_reversal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation payment_allocations%ROWTYPE;
BEGIN
  SELECT * INTO allocation FROM payment_allocations WHERE id = NEW.allocation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_allocation_not_found'; END IF;
  IF NEW.school_year_id IS DISTINCT FROM allocation.school_year_id THEN
    RAISE EXCEPTION 'payment_allocation_year_mismatch';
  END IF;
  -- Ta sama kolejność blokad co przy nowej części, korekcie i przypisaniu.
  PERFORM 1 FROM payment_entries WHERE id = allocation.payment_entry_id FOR UPDATE;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON payment_allocation_reversals
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER payment_allocation_reversals_guard_insert BEFORE INSERT ON payment_allocation_reversals
  FOR EACH ROW EXECUTE FUNCTION payment_allocation_reversal_guard();
CREATE TRIGGER payment_allocation_reversals_no_change BEFORE UPDATE OR DELETE ON payment_allocation_reversals
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();

-- Korekta i zwrot nie mogą zejść poniżej sumy bieżących części. Nazwy triggerów
-- z prefiksem `z_`: uruchamiają się PO dotychczasowych strażnikach (kolejność
-- alfabetyczna), więc przekroczenie kwoty wpłaty i niezgodność z księgą dalej
-- dają dotychczasowe kody błędów.
CREATE FUNCTION payment_net_covers_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE net BIGINT;
BEGIN
  PERFORM 1 FROM payment_entries WHERE id = NEW.payment_entry_id FOR UPDATE;
  SELECT net_amount_cents INTO net FROM payment_entry_net WHERE id = NEW.payment_entry_id;
  IF net - NEW.amount_cents < payment_allocated_cents(NEW.payment_entry_id) THEN
    RAISE EXCEPTION 'payment_allocation_exceeds_net';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_corrections_z_allocation_guard BEFORE INSERT ON payment_corrections
  FOR EACH ROW EXECUTE FUNCTION payment_net_covers_allocations();
CREATE TRIGGER payment_refunds_z_allocation_guard BEFORE INSERT ON payment_refunds
  FOR EACH ROW EXECUTE FUNCTION payment_net_covers_allocations();

-- Wpłata podzielona nie dostaje jednego gospodarstwa, dopóki ma bieżące części.
CREATE FUNCTION payment_assignment_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM payment_entries WHERE id = NEW.payment_entry_id FOR UPDATE;
  IF payment_allocated_cents(NEW.payment_entry_id) > 0 THEN
    RAISE EXCEPTION 'payment_has_allocations';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_assignments_z_allocation_guard BEFORE INSERT ON payment_assignments
  FOR EACH ROW EXECUTE FUNCTION payment_assignment_allocation_guard();

-- Sumy gospodarstw: wpłaty przypisane (jak w 0002) + bieżące części wpłat nieprzypisanych.
CREATE OR REPLACE VIEW household_payment_totals AS
SELECT household_id, school_year_id, sum(net_amount_cents) AS net_amount_cents,
  count(*) AS payment_count
FROM (
  SELECT household_id, school_year_id, net_amount_cents
    FROM payment_entry_net
   WHERE status = 'recorded' AND household_id IS NOT NULL
  UNION ALL
  SELECT a.household_id, a.school_year_id, a.amount_cents::BIGINT
    FROM payment_allocations_current a
    JOIN payment_entries p ON p.id = a.payment_entry_id
   WHERE p.status = 'unmatched'
) parts
GROUP BY household_id, school_year_id;
