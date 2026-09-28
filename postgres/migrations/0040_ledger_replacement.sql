-- Przeksięgowanie wpisu księgi (kategoria/data/metoda/kierunek) jako storno +
-- wpis zastępczy, powiązane ze sobą (#144).
--
-- Co zmienia:
-- * Nullable ledger_entries.replaces_entry_id (FK do ledger_entries, ten sam
--   rok szkolny, sprawdzane triggerem — nie zwykłym FK, bo wymaga też
--   zgodności school_year_id). Wpis zastępczy wskazuje wpis, który zastępuje.
-- * Unikalny (częściowy) indeks: wpis może zostać zastąpiony co najwyżej raz
--   (ledger_entries_replaces_idx). Wpis zastępczy — może zostać zastąpiony
--   ponownie (łańcuch przeksięgowań), to nie jest ograniczone.
-- * ledger_entry_insert_guard: sprawdza replaces_entry_id (ten sam rok;
--   zastępowany wpis nie może mieć payment_entry_id — patrz niżej) i odrzuca
--   drugie zastąpienie tego samego wpisu (409 przez unikalny indeks; kod
--   API `ledger_entry_already_replaced`).
--
-- ŚWIADOME OGRANICZENIE ZAKRESU (wariant zachowawczy, do decyzji D-12/D-15):
-- wpis z payment_entry_id (ujęcie wpłaty w księdze) NIE MOŻE być przeksięgowany
-- tą operacją. Unikalny indeks ledger_entries_payment_entry_idx (0003_ledger.sql)
-- pozwala na najwyżej jeden wpis księgi na wpłatę; przeniesienie powiązania na
-- wpis zastępczy wymagałoby zmiany tego indeksu na regułę „jedno powiązanie
-- WŚRÓD WPISÓW O NETTO > 0” (trigger zamiast zwykłego indeksu), co dotyka
-- ochrony przed podwójnym ujęciem wpłaty i zazębia się z kontrolą kwoty
-- wpłata<->księga z #138. Zostawiamy to jako osobną, przyszłą zmianę (opisaną
-- w PR) zamiast ryzykować regresję w #138 w tym samym PR-ze. Do tego czasu
-- przeksięgowanie wpisu powiązanego z wpłatą zwraca
-- 409 `payment_linked_entry_not_replaceable`.
--
-- Skutki dla istniejących danych: żaden wiersz nie jest zmieniany ani
-- usuwany; replaces_entry_id nowej kolumny jest NULL dla wszystkich
-- istniejących wpisów.
--
-- Wycofanie: DROP INDEX ledger_entries_replaces_idx; ALTER TABLE ledger_entries
-- DROP COLUMN replaces_entry_id; przywrócenie ledger_entry_insert_guard z
-- 0003_ledger.sql (lub z migracji #138, jeśli już scalona — patrz uwaga niżej).

ALTER TABLE ledger_entries ADD COLUMN replaces_entry_id TEXT REFERENCES ledger_entries(id);
CREATE UNIQUE INDEX ledger_entries_replaces_idx
  ON ledger_entries(replaces_entry_id) WHERE replaces_entry_id IS NOT NULL;

-- `e.*` w CREATE VIEW jest rozwijane na listę kolumn W CHWILI utworzenia
-- widoku — ALTER TABLE ADD COLUMN z tej migracji sam z siebie NIE dopisuje
-- nowej kolumny do już istniejącego ledger_entry_net (0003_ledger.sql).
-- CREATE OR REPLACE VIEW z jawną listą kolumn (replaces_entry_id na końcu,
-- po corrected_cents/net_amount_cents) dopisuje ją bez zmiany pozycji
-- pozostałych kolumn (wymóg CREATE OR REPLACE VIEW w PostgreSQL).
CREATE OR REPLACE VIEW ledger_entry_net AS
SELECT e.id, e.school_year_id, e.direction, e.amount_cents, e.category_id, e.description,
  e.occurred_on, e.method, e.source, e.payment_entry_id, e.source_document_id,
  e.resolution_reference, e.created_by, e.created_at, e.idempotency_key,
  COALESCE(c.corrected_cents, 0) AS corrected_cents,
  e.amount_cents::BIGINT - COALESCE(c.corrected_cents, 0) AS net_amount_cents,
  e.replaces_entry_id
FROM ledger_entries e
LEFT JOIN (
  SELECT ledger_entry_id, sum(amount_cents) AS corrected_cents
  FROM ledger_corrections GROUP BY ledger_entry_id
) c ON c.ledger_entry_id = e.id;

-- Zazębienie z #138: ta migracja zakłada, że #138 (kontrola kwoty wpłata<->księga
-- w ledger_entry_insert_guard) mogła już scalić się wcześniej — sprawdzamy
-- obecność jej kontroli dynamicznie (to_regclass na payment_refunds), żeby ta
-- migracja dała się zastosować niezależnie od kolejności scalania PR-ów.
CREATE OR REPLACE FUNCTION ledger_entry_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked payment_entries%ROWTYPE;
DECLARE linked_net BIGINT;
DECLARE replaced ledger_entries%ROWTYPE;
DECLARE has_refunds_table BOOLEAN;
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
    SELECT to_regclass('payment_refunds') IS NOT NULL INTO has_refunds_table;
    IF has_refunds_table THEN
      -- payment_refunds istnieje dopiero po #138; EXECUTE odracza parsowanie
      -- do czasu wykonania, żeby ta migracja dała się zastosować niezależnie
      -- od kolejności scalania PR-ów (patrz uwaga o zazębieniu w nagłówku).
      EXECUTE 'SELECT $2 - COALESCE((SELECT sum(amount_cents) FROM payment_corrections WHERE payment_entry_id = $1), 0)
                        - COALESCE((SELECT sum(amount_cents) FROM payment_refunds WHERE payment_entry_id = $1), 0)'
        INTO linked_net USING linked.id, linked.amount_cents;
    ELSE
      SELECT linked.amount_cents
        - COALESCE((SELECT sum(amount_cents) FROM payment_corrections WHERE payment_entry_id = linked.id), 0)
        INTO linked_net;
    END IF;
    -- Wyjątek wzorem 0027/0038: odtworzenie historycznych danych (import z D1)
    -- ustawia SET LOCAL rd.restore = 'on' i przenosi niezgodne historyczne
    -- wiersze bez zmian (D1 nigdy nie miało prawdziwych danych). API nigdy
    -- tego ustawienia nie włącza.
    IF NEW.amount_cents <> linked_net
       AND current_setting('rd.restore', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'ledger_payment_amount_mismatch';
    END IF;
  END IF;
  IF NEW.replaces_entry_id IS NOT NULL THEN
    SELECT * INTO replaced FROM ledger_entries WHERE id = NEW.replaces_entry_id FOR UPDATE;
    IF NOT FOUND OR replaced.school_year_id <> NEW.school_year_id THEN
      RAISE EXCEPTION 'ledger_replacement_mismatch';
    END IF;
    IF replaced.payment_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'payment_linked_entry_not_replaceable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
