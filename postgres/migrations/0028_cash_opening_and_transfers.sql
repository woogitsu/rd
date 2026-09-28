-- Bilans otwarcia rozdzielony na rachunek i kasę; przeniesienia kasa ↔ rachunek (#199).
-- Kwoty w centach EUR (liczby całkowite).
--
-- Założenie (D-13 nierozstrzygnięte): jedna kasa gotówkowa i jeden rachunek.
-- „Kasa” = wszystko poza rachunkiem bankowym (metody wpisów inne niż 'bank'),
-- jak dotąd w ledger_non_bank_net_at. Kilka rachunków wymaga osobnej decyzji.
--
-- Co zmienia:
-- * ledger_opening_balances.cash_cents: część bilansu otwarcia (amount_cents =
--   całość) będąca poza rachunkiem. ledger_opening_balance_adjustments.cash_cents:
--   zmiana tej części. Poprawka może też tylko przesunąć kwotę między rachunkiem
--   a kasą (amount_cents = 0, cash_cents <> 0).
-- * Funkcja ledger_opening_cash_cents(rok) i widok ledger_year_cash_summary
--   (kasa: otwarcie + wpisy poza rachunkiem + przeniesienia; bez filtra daty,
--   jak ledger_year_summary).
-- * Tabela ledger_transfers: przeniesienie wewnętrzne 'cash_to_bank' (wpłata
--   gotówki na rachunek) albo 'bank_to_cash' (wypłata do kasy). Nie jest
--   przychodem ani wydatkiem — nie zmienia ledger_year_summary, zmienia tylko
--   podział rachunek/kasa. Niezmienna; korekta = storno (nowy wiersz z
--   reverses_id, przeciwny kierunek, ta sama kwota; storna nie można stornować).
--   Data w granicach roku (school_year_contains z 0027), objęta zamrożeniem roku.
-- * ledger_non_bank_net_at(rok, dzień) dolicza gotówkę z bilansu otwarcia
--   (z poprawkami) i przeniesienia do tego dnia.
-- * school_year_closures.opening_cash_cents i closing_cash_cents: utrwalony
--   podział przy zamknięciu (zamknięcie przenosi obie części do bilansu otwarcia).
--
-- Skutki dla istniejących danych:
-- * Istniejące bilanse otwarcia i poprawki dostają cash_cents = 0 — kwoty
--   całkowite bez zmian. Jeśli bilans przeniesiony zamknięciem zawierał gotówkę,
--   rozbicie trzeba wpisać poprawką (POST /api/ledger/opening-balance/adjustments,
--   amountCents 0, cashCents = gotówka), bo historycznego podziału nie da się
--   odtworzyć z bazy bez decyzji skarbnika.
-- * Zatwierdzone uzgodnienia mają utrwalone ledger_non_bank_cents — bez zmian.
--   Szkice przeliczają wartość na bieżąco: przy cash_cents = 0 i braku przeniesień
--   wynik jest identyczny jak przed migracją.
-- * Zamknięcia sprzed migracji mają opening_cash_cents/closing_cash_cents = NULL.
--
-- Wycofanie: przywrócenie ledger_non_bank_net_at z 0015, usunięcie widoku,
-- funkcji, tabeli ledger_transfers (tylko gdy pusta) i nowych kolumn.

ALTER TABLE ledger_opening_balances
  ADD COLUMN cash_cents BIGINT NOT NULL DEFAULT 0
    CHECK (cash_cents BETWEEN -10000000000 AND 10000000000);

ALTER TABLE ledger_opening_balance_adjustments
  ADD COLUMN cash_cents BIGINT NOT NULL DEFAULT 0
    CHECK (cash_cents BETWEEN -10000000000 AND 10000000000);
ALTER TABLE ledger_opening_balance_adjustments
  DROP CONSTRAINT ledger_opening_balance_adjustments_amount_cents_check;
ALTER TABLE ledger_opening_balance_adjustments
  ADD CONSTRAINT ledger_opening_adjustment_nonzero CHECK (amount_cents <> 0 OR cash_cents <> 0);

ALTER TABLE school_year_closures
  ADD COLUMN opening_cash_cents BIGINT,
  ADD COLUMN closing_cash_cents BIGINT;

CREATE TABLE ledger_transfers (
  id TEXT PRIMARY KEY,
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  direction TEXT NOT NULL CHECK (direction IN ('cash_to_bank', 'bank_to_cash')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  transferred_on DATE NOT NULL,
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 500),
  source_document_id TEXT REFERENCES documents(id),
  reverses_id TEXT UNIQUE REFERENCES ledger_transfers(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE INDEX ledger_transfers_year_date_idx ON ledger_transfers(school_year_id, transferred_on, id);

CREATE FUNCTION ledger_transfer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original ledger_transfers%ROWTYPE;
BEGIN
  IF NOT school_year_contains(NEW.school_year_id, NEW.transferred_on)
     AND current_setting('rd.restore', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'date_outside_school_year';
  END IF;
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO original FROM ledger_transfers WHERE id = NEW.reverses_id FOR UPDATE;
    IF NOT FOUND OR original.school_year_id <> NEW.school_year_id
       OR original.reverses_id IS NOT NULL
       OR original.amount_cents <> NEW.amount_cents
       OR original.direction = NEW.direction THEN
      RAISE EXCEPTION 'ledger_transfer_reversal_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON ledger_transfers
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER b0_ledger_transfer_guard BEFORE INSERT ON ledger_transfers
  FOR EACH ROW EXECUTE FUNCTION ledger_transfer_guard();
CREATE TRIGGER ledger_transfers_no_change BEFORE UPDATE OR DELETE ON ledger_transfers
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();

CREATE FUNCTION ledger_opening_cash_cents(p_school_year_id TEXT)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT o.cash_cents FROM ledger_opening_balances o
                    WHERE o.school_year_id = p_school_year_id), 0)
    + COALESCE((SELECT sum(a.cash_cents) FROM ledger_opening_balance_adjustments a
                  JOIN ledger_opening_balances o ON o.id = a.opening_balance_id
                 WHERE o.school_year_id = p_school_year_id), 0)::BIGINT
$$;

-- Zmiana kasy przez przeniesienia: + wypłata do kasy, − wpłata na rachunek.
CREATE FUNCTION ledger_transfers_cash_net_at(p_school_year_id TEXT, p_on DATE)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(CASE WHEN t.direction = 'bank_to_cash' THEN t.amount_cents ELSE -t.amount_cents END), 0)::BIGINT
    FROM ledger_transfers t
   WHERE t.school_year_id = p_school_year_id AND (p_on IS NULL OR t.transferred_on <= p_on)
$$;

-- Część salda księgi poza rachunkiem na koniec dnia: gotówka z bilansu otwarcia
-- (z poprawkami) + wpisy z metodą inną niż 'bank' + przeniesienia do tego dnia.
CREATE OR REPLACE FUNCTION ledger_non_bank_net_at(p_school_year_id TEXT, p_on DATE)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT ledger_opening_cash_cents(p_school_year_id)
    + COALESCE((
      SELECT sum(CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END)
        FROM ledger_entry_net e
       WHERE e.school_year_id = p_school_year_id AND e.occurred_on <= p_on
         AND e.method <> 'bank'), 0)::BIGINT
    + ledger_transfers_cash_net_at(p_school_year_id, p_on)
$$;

CREATE VIEW ledger_year_cash_summary AS
SELECT y.id AS school_year_id,
  ledger_opening_cash_cents(y.id) AS opening_cash_cents,
  COALESCE((
    SELECT sum(CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END)
      FROM ledger_entry_net e WHERE e.school_year_id = y.id AND e.method <> 'bank'), 0)::BIGINT
    AS non_bank_entries_net_cents,
  ledger_transfers_cash_net_at(y.id, NULL) AS transfers_cash_net_cents,
  (ledger_opening_cash_cents(y.id)
    + COALESCE((
      SELECT sum(CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END)
        FROM ledger_entry_net e WHERE e.school_year_id = y.id AND e.method <> 'bank'), 0)
    + ledger_transfers_cash_net_at(y.id, NULL))::BIGINT AS closing_cash_cents
FROM school_years y;
