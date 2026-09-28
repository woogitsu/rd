-- Spójność wpłata <-> księga: kontrola kwoty, zwroty i ponowne przypisanie (#138).
--
-- Co zmienia:
-- * ledger_entry_insert_guard: wpis księgi z payment_entry_id musi mieć
--   amount_cents równe bieżącemu netto wpłaty (kwota - korekty - zwroty) w
--   chwili zapisu wpisu. Inaczej `ledger_payment_amount_mismatch` (API: 422).
--   Wyjątek wzorem 0027: odtworzenie historycznych danych (import z D1,
--   src/d1-postgres-migration.js) ustawia w swojej transakcji
--   SET LOCAL rd.restore = 'on' i przenosi niezgodne historyczne wiersze bez
--   zmian (D1 nigdy nie miało prawdziwych danych — docs/RAILWAY_MIGRATION.md,
--   „Stan wyjściowy”); API nigdy tego ustawienia nie włącza, więc normalny
--   zapis jest sprawdzany zawsze.
-- * payment_correction_guard: korekta wpłaty powiązanej z wpisem księgi jest
--   odrzucana (`ledger_correction_required`, API: 409), chyba że wpis księgi
--   ma już (w tej samej lub wcześniejszej transakcji) korektę sprowadzającą
--   jego netto do tej samej wartości co nowe netto wpłaty. Zachowawczy
--   wariant z #138/#165: system NIE tworzy korekty księgi automatycznie —
--   skarbnik najpierw koryguje wpis księgi (POST /api/ledger/{id}/corrections
--   o tę samą kwotę), dopiero potem koryguje wpłatę, w tej samej sesji.
-- * Nowa tabela payment_refunds (zwrot pieniędzy rodzinie): niezmienny zapis,
--   zmniejsza netto wpłaty jak korekta, ale ma własną datę skutku i metodę
--   oraz podlega tej samej kontroli spójności z księgą co korekta.
-- * Nowa tabela payment_reassignments (błędne przypisanie do gospodarstwa):
--   niezmienne zdarzenie z poprzednim i nowym gospodarstwem; payment_entry_guard
--   dopuszcza zmianę household_id tylko przez to zdarzenie (oprócz istniejącej
--   ścieżki payment_assignments dla wpłat 'unmatched'). Widok gospodarstwa
--   (household_payment_totals) nadal pokazuje wpłatę tylko przy household_id
--   bieżącym; historia zostaje w payment_reassignments i dzienniku zdarzeń.
-- * payment_entry_net: dodaje kolumnę refunded_cents (na końcu, zgodnie z
--   regułą CREATE OR REPLACE VIEW) i wlicza zwroty do net_amount_cents.
--
-- Skutki dla istniejących danych:
-- * Żaden istniejący wiersz nie jest zmieniany ani usuwany.
-- * Wpisy księgi powiązane z wpłatą o dziś już niezgodnej kwocie (sprzed tej
--   migracji) NIE są poprawiane ani blokowane wstecznie — kontrola dotyczy
--   tylko nowych wpisów. Istniejące niespójności wykazuje zapytanie kontrolne:
--     SELECT e.id AS ledger_entry_id, e.payment_entry_id, e.amount_cents AS ledger_amount_cents,
--            p.net_amount_cents AS payment_net_cents
--       FROM ledger_entries e JOIN payment_entry_net p ON p.id = e.payment_entry_id
--      WHERE e.amount_cents <> p.net_amount_cents;
--   (patrz też sekcja audytu w raporcie KR, punkt "payments_in_ledger").
--
-- Świadomie NIE objęte tym PR (opisane w PR jako dalsza praca):
-- * Dopasowanie zwrotu do ujemnej pozycji wyciągu w uzgodnieniu
--   (bank_reconciliation_matches.payment_refund_id) — wymaga osobnej zmiany
--   triggerów uzgodnienia (0015/0024) i jest z rozmysłem poza tym PR.
-- * Automatyczne tworzenie korekty księgi przy korekcie/zwrocie wpłaty —
--   wariant zachowawczy: blokada z czytelnym kodem błędu zamiast automatu.
--
-- Wycofanie: DROP TABLE payment_refunds, payment_reassignments (CASCADE na
-- ich triggery i funkcje), przywrócenie definicji payment_entry_guard,
-- payment_correction_guard, ledger_entry_insert_guard i payment_entry_net
-- z 0002_payments.sql / 0003_ledger.sql. Dane wpłat i księgi nie wymagają zmian.

-- Sprawdza, czy netto wpisu księgi powiązanego z wpłatą (jeśli istnieje) po
-- korekcie/zwrocie nadal odpowiada nowemu netto wpłaty. Blokuje wiersz wpisu
-- księgi (FOR SHARE), więc czeka na równoległą korektę tego wpisu.
CREATE FUNCTION payment_ledger_link_consistent(p_payment_id TEXT, p_new_net_cents BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_ledger ledger_entries%ROWTYPE;
DECLARE v_ledger_net BIGINT;
BEGIN
  SELECT * INTO v_ledger FROM ledger_entries WHERE payment_entry_id = p_payment_id FOR SHARE;
  IF NOT FOUND THEN RETURN true; END IF;
  SELECT v_ledger.amount_cents - COALESCE(sum(amount_cents), 0) INTO v_ledger_net
    FROM ledger_corrections WHERE ledger_entry_id = v_ledger.id;
  RETURN v_ledger_net = p_new_net_cents;
END $$;

-- 1. Wpis księgi <-> wpłata: kontrola kwoty przy zapisie wpisu ----------------

CREATE OR REPLACE FUNCTION ledger_entry_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked payment_entries%ROWTYPE;
DECLARE linked_net BIGINT;
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
    SELECT linked.amount_cents
      - COALESCE((SELECT sum(amount_cents) FROM payment_corrections WHERE payment_entry_id = linked.id), 0)
      - COALESCE((SELECT sum(amount_cents) FROM payment_refunds WHERE payment_entry_id = linked.id), 0)
      INTO linked_net;
    -- Odtworzenie historycznych danych (import z D1, src/d1-postgres-migration.js)
    -- ustawia w swojej transakcji SET LOCAL rd.restore = 'on' (wzorem 0027) i
    -- przenosi wiersze bez zmian, nawet gdy stara wpłata i wpis się rozjeżdżają
    -- (D1 nigdy nie miało prawdziwych danych — docs/RAILWAY_MIGRATION.md). API
    -- nigdy tego ustawienia nie włącza, więc normalny zapis nadal jest sprawdzany.
    IF NEW.amount_cents <> linked_net
       AND current_setting('rd.restore', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'ledger_payment_amount_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 2. Korekta wpłaty powiązanej z księgą: blokada zamiast automatu -----------

CREATE OR REPLACE FUNCTION payment_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original payment_entries%ROWTYPE;
DECLARE corrected BIGINT;
DECLARE refunded BIGINT;
DECLARE new_net BIGINT;
BEGIN
  SELECT * INTO original FROM payment_entries WHERE id = NEW.payment_entry_id FOR UPDATE;
  IF NOT FOUND OR original.status = 'reversed' THEN
    RAISE EXCEPTION 'legacy_reversed_payment_cannot_be_corrected';
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO corrected
    FROM payment_corrections WHERE payment_entry_id = NEW.payment_entry_id;
  SELECT COALESCE(sum(amount_cents), 0) INTO refunded
    FROM payment_refunds WHERE payment_entry_id = NEW.payment_entry_id;
  IF corrected + refunded + NEW.amount_cents > original.amount_cents THEN
    RAISE EXCEPTION 'payment_correction_exceeds_remaining_amount';
  END IF;
  new_net := original.amount_cents - corrected - refunded - NEW.amount_cents;
  IF NOT payment_ledger_link_consistent(NEW.payment_entry_id, new_net) THEN
    RAISE EXCEPTION 'ledger_correction_required';
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Zwrot pieniędzy rodzinie (payment_refunds) ------------------------------

CREATE TABLE payment_refunds (
  id TEXT PRIMARY KEY,
  payment_entry_id TEXT NOT NULL REFERENCES payment_entries(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  refunded_on DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('bank', 'cash', 'other')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE INDEX payment_refunds_entry_idx ON payment_refunds(payment_entry_id, created_at);

CREATE FUNCTION payment_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original payment_entries%ROWTYPE;
DECLARE corrected BIGINT;
DECLARE refunded BIGINT;
DECLARE new_net BIGINT;
BEGIN
  SELECT * INTO original FROM payment_entries WHERE id = NEW.payment_entry_id FOR UPDATE;
  IF NOT FOUND OR original.status = 'reversed' THEN
    RAISE EXCEPTION 'payment_cannot_be_refunded';
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO corrected
    FROM payment_corrections WHERE payment_entry_id = NEW.payment_entry_id;
  SELECT COALESCE(sum(amount_cents), 0) INTO refunded
    FROM payment_refunds WHERE payment_entry_id = NEW.payment_entry_id;
  IF corrected + refunded + NEW.amount_cents > original.amount_cents THEN
    RAISE EXCEPTION 'payment_refund_exceeds_remaining_amount';
  END IF;
  new_net := original.amount_cents - corrected - refunded - NEW.amount_cents;
  IF NOT payment_ledger_link_consistent(NEW.payment_entry_id, new_net) THEN
    RAISE EXCEPTION 'ledger_correction_required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_refunds_guard_insert BEFORE INSERT ON payment_refunds
  FOR EACH ROW EXECUTE FUNCTION payment_refund_guard();
CREATE TRIGGER payment_refunds_no_change BEFORE UPDATE OR DELETE ON payment_refunds
  FOR EACH ROW EXECUTE FUNCTION immutable_payment_event();

-- 4. Ponowne przypisanie do gospodarstwa (payment_reassignments) -----------

CREATE TABLE payment_reassignments (
  id TEXT PRIMARY KEY,
  payment_entry_id TEXT NOT NULL REFERENCES payment_entries(id),
  old_household_id TEXT NOT NULL REFERENCES households(id),
  new_household_id TEXT NOT NULL REFERENCES households(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128),
  CONSTRAINT payment_reassignment_household_differs CHECK (old_household_id <> new_household_id)
);
CREATE INDEX payment_reassignments_entry_idx ON payment_reassignments(payment_entry_id, created_at);
CREATE INDEX payment_reassignments_new_household_idx ON payment_reassignments(new_household_id, created_at);

CREATE FUNCTION payment_reassignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original payment_entries%ROWTYPE;
BEGIN
  SELECT * INTO original FROM payment_entries WHERE id = NEW.payment_entry_id FOR UPDATE;
  IF NOT FOUND OR original.status <> 'recorded'
     OR original.household_id IS DISTINCT FROM NEW.old_household_id THEN
    RAISE EXCEPTION 'payment_reassignment_household_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_reassignments_guard_insert BEFORE INSERT ON payment_reassignments
  FOR EACH ROW EXECUTE FUNCTION payment_reassignment_guard();

-- Zastosowanie: zmienia household_id wpłaty (payment_entry_guard poniżej
-- dopuszcza tę zmianę wyłącznie razem z pasującym wierszem tego zdarzenia).
CREATE FUNCTION payment_reassignment_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE payment_entries SET household_id = NEW.new_household_id WHERE id = NEW.payment_entry_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_reassignments_apply_insert AFTER INSERT ON payment_reassignments
  FOR EACH ROW EXECUTE FUNCTION payment_reassignment_apply();
CREATE TRIGGER payment_reassignments_no_change BEFORE UPDATE OR DELETE ON payment_reassignments
  FOR EACH ROW EXECUTE FUNCTION immutable_payment_event();

-- payment_entry_guard: dopuszcza zmianę household_id wpłaty 'recorded' na
-- 'recorded' o inne gospodarstwo wyłącznie razem z odpowiadającym wierszem
-- payment_reassignments (oprócz istniejącej ścieżki payment_assignments dla
-- wpłat 'unmatched').
CREATE OR REPLACE FUNCTION payment_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NOT (
      (OLD.status = 'unmatched' AND OLD.household_id IS NULL
        AND NEW.status = 'recorded' AND NEW.household_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM payment_assignments a
          WHERE a.payment_entry_id = OLD.id AND a.household_id = NEW.household_id))
      OR
      (OLD.status = 'recorded' AND NEW.status = 'recorded'
        AND OLD.household_id IS NOT NULL AND NEW.household_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM payment_reassignments r
          WHERE r.payment_entry_id = OLD.id AND r.old_household_id = OLD.household_id
            AND r.new_household_id = NEW.household_id))
    ) THEN
      RAISE EXCEPTION 'payment_assignment_event_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 5. payment_entry_net: wlicza zwroty do netto (kolumna refunded_cents na końcu) --

CREATE OR REPLACE VIEW payment_entry_net AS
SELECT p.*, COALESCE(c.corrected_cents, 0) AS corrected_cents,
  p.amount_cents::BIGINT - COALESCE(c.corrected_cents, 0) - COALESCE(r.refunded_cents, 0) AS net_amount_cents,
  COALESCE(r.refunded_cents, 0) AS refunded_cents
FROM payment_entries p
LEFT JOIN (
  SELECT payment_entry_id, sum(amount_cents) AS corrected_cents
  FROM payment_corrections GROUP BY payment_entry_id
) c ON c.payment_entry_id = p.id
LEFT JOIN (
  SELECT payment_entry_id, sum(amount_cents) AS refunded_cents
  FROM payment_refunds GROUP BY payment_entry_id
) r ON r.payment_entry_id = p.id;

-- 6. Zamrożenie zamkniętego roku dla nowych tabel ---------------------------

CREATE OR REPLACE FUNCTION year_freeze_via_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target RECORD;
DECLARE year_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD; ELSE target := NEW; END IF;
  IF TG_TABLE_NAME IN ('payment_assignments', 'payment_corrections', 'payment_refunds', 'payment_reassignments') THEN
    SELECT school_year_id INTO year_id FROM payment_entries WHERE id = target.payment_entry_id;
  ELSIF TG_TABLE_NAME = 'ledger_corrections' THEN
    SELECT school_year_id INTO year_id FROM ledger_entries WHERE id = target.ledger_entry_id;
  ELSIF TG_TABLE_NAME = 'ledger_opening_balance_adjustments' THEN
    SELECT school_year_id INTO year_id FROM ledger_opening_balances WHERE id = target.opening_balance_id;
  ELSIF TG_TABLE_NAME IN ('meeting_agenda_items', 'meeting_attendees', 'meeting_quorum_checks', 'meeting_minutes') THEN
    SELECT school_year_id INTO year_id FROM meetings WHERE id = target.meeting_id;
  ELSIF TG_TABLE_NAME = 'meeting_minutes_publications' THEN
    SELECT m.school_year_id INTO year_id FROM meeting_minutes mm
      JOIN meetings m ON m.id = mm.meeting_id WHERE mm.id = target.minutes_id;
  ELSE
    RAISE EXCEPTION 'year_freeze_unknown_table';
  END IF;
  PERFORM school_year_assert_open(year_id);
  RETURN target;
END $$;

CREATE TRIGGER a0_year_freeze BEFORE INSERT ON payment_refunds
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON payment_reassignments
  FOR EACH ROW EXECUTE FUNCTION year_freeze_via_parent();
