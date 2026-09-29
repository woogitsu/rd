-- Przeksięgowanie wpisu księgi powiązanego z wpłatą (#144, część 2).
--
-- Reguła (wariant wybrany do czasu decyzji D-12/D-15; opisany w PR):
-- * wpis z payment_entry_id MOŻE być przeksięgowany (kategoria, data, metoda,
--   opis, dowód) — wpis zastępczy przejmuje powiązanie z TĄ SAMĄ wpłatą;
-- * KWOTA i kierunek nie zmieniają się przez przeksięgowanie: wpis zastępczy
--   musi mieć kwotę równą bieżącemu netto wpłaty (kontrola z 0038 działa bez
--   zmian). Zmiana kwoty = korekta wpłaty (docs/PAYMENTS.md), potem korekta
--   wpisu — jak dotąd (#138);
-- * wpłata jest ujęta w księdze dokładnie raz: co najwyżej jeden wpis
--   łańcucha przeksięgowań ma netto > 0.
--
-- Co zmienia:
-- 1. Unikalny indeks ledger_entries_payment_entry_idx (0003) zostaje zastąpiony
--    zwykłym indeksem wyszukiwania. Jedno powiązanie „wśród wpisów o netto > 0”
--    nie da się wyrazić indeksem (netto zależy od ledger_corrections), więc
--    pilnuje tego ledger_entry_insert_guard (niżej) pod blokadą wiersza wpłaty
--    (FOR UPDATE), tak że równoległe zapisy tej samej wpłaty się serializują.
-- 2. ledger_entry_insert_guard (od najnowszej wersji, 0040): dla wpisu z
--    payment_entry_id, jeśli wpłata ma już inne wpisy księgi, nowy wpis musi
--    być wpisem zastępczym jednego z nich, a suma netto pozostałych wpisów tej
--    wpłaty musi wynosić 0 (`ledger_payment_already_linked`). Wpis zastępczy
--    musi mieć to samo powiązanie z wpłatą co wpis zastępowany
--    (`ledger_replacement_payment_link_mismatch`), więc przeksięgowanie ani nie
--    gubi, ani nie tworzy powiązania z wpłatą. Usunięty zakaz
--    `payment_linked_entry_not_replaceable` z 0040.
-- 3. payment_ledger_link_consistent (0038): porównuje nowe netto wpłaty z SUMĄ
--    netto wszystkich wpisów księgi tej wpłaty (łańcuch przeksięgowań), nie z
--    jednym wierszem. Dla wpłaty z jednym wpisem wynik jest identyczny.
--
-- Skutki dla istniejących danych: żaden wiersz nie jest zmieniany ani usuwany.
-- Dotychczas każda wpłata miała najwyżej jeden wpis, więc reguła „jedno
-- powiązanie” pozostaje spełniona dla całej istniejącej historii. Zapytanie
-- kontrolne po migracji (powinno zwrócić 0 wierszy):
--   SELECT payment_entry_id FROM ledger_entry_net
--    WHERE payment_entry_id IS NOT NULL AND net_amount_cents > 0
--    GROUP BY payment_entry_id HAVING count(*) > 1;
--
-- Wycofanie: DROP INDEX ledger_entries_payment_entry_lookup_idx; przywrócenie
-- unikalnego indeksu z 0003 (możliwe tylko dopóki żadna wpłata nie ma dwóch
-- wpisów, czyli przed pierwszym przeksięgowaniem wpisu powiązanego z wpłatą) i
-- funkcji ledger_entry_insert_guard z 0040 oraz payment_ledger_link_consistent
-- z 0038.

DROP INDEX ledger_entries_payment_entry_idx;
CREATE INDEX ledger_entries_payment_entry_lookup_idx
  ON ledger_entries(payment_entry_id) WHERE payment_entry_id IS NOT NULL;

CREATE OR REPLACE FUNCTION payment_ledger_link_consistent(p_payment_id TEXT, p_new_net_cents BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_ledger_net BIGINT;
BEGIN
  PERFORM 1 FROM ledger_entries WHERE payment_entry_id = p_payment_id FOR SHARE;
  IF NOT FOUND THEN RETURN true; END IF;
  SELECT COALESCE(sum(e.amount_cents - COALESCE(c.corrected_cents, 0)), 0) INTO v_ledger_net
    FROM ledger_entries e
    LEFT JOIN (SELECT ledger_entry_id, sum(amount_cents) AS corrected_cents
                 FROM ledger_corrections GROUP BY ledger_entry_id) c ON c.ledger_entry_id = e.id
   WHERE e.payment_entry_id = p_payment_id;
  RETURN v_ledger_net = p_new_net_cents;
END $$;

CREATE OR REPLACE FUNCTION ledger_entry_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked payment_entries%ROWTYPE;
DECLARE linked_net BIGINT;
DECLARE replaced ledger_entries%ROWTYPE;
DECLARE other_count INTEGER;
DECLARE other_net BIGINT;
DECLARE replaces_other BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ledger_categories c WHERE c.id = NEW.category_id AND c.active
  ) THEN
    RAISE EXCEPTION 'ledger_category_inactive';
  END IF;
  IF NEW.payment_entry_id IS NOT NULL THEN
    -- FOR UPDATE (nie SHARE): serializuje równoległe ujęcia i przeksięgowania
    -- tej samej wpłaty; kolejność blokad jak w payment_correction_guard
    -- (najpierw wpłata, potem wpisy księgi).
    SELECT * INTO linked FROM payment_entries WHERE id = NEW.payment_entry_id FOR UPDATE;
    IF NOT FOUND OR linked.school_year_id <> NEW.school_year_id
       OR linked.status <> 'recorded' THEN
      RAISE EXCEPTION 'ledger_payment_link_mismatch';
    END IF;
    SELECT linked.amount_cents
      - COALESCE((SELECT sum(amount_cents) FROM payment_corrections WHERE payment_entry_id = linked.id), 0)
      - COALESCE((SELECT sum(amount_cents) FROM payment_refunds WHERE payment_entry_id = linked.id), 0)
      INTO linked_net;
    -- Wyjątek wzorem 0027/0038: odtworzenie historycznych danych (import z D1)
    -- ustawia SET LOCAL rd.restore = 'on'; API nigdy tego ustawienia nie włącza.
    IF NEW.amount_cents <> linked_net
       AND current_setting('rd.restore', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'ledger_payment_amount_mismatch';
    END IF;
    -- Jedno ujęcie wpłaty: inne wpisy tej wpłaty dopuszczalne tylko w łańcuchu
    -- przeksięgowań i tylko z zerowym netto (storno powstaje przed wpisem
    -- zastępczym, w tej samej transakcji).
    SELECT count(*), COALESCE(sum(e.amount_cents - COALESCE(c.corrected_cents, 0)), 0),
           COALESCE(bool_or(e.id = NEW.replaces_entry_id), false)
      INTO other_count, other_net, replaces_other
      FROM ledger_entries e
      LEFT JOIN (SELECT ledger_entry_id, sum(amount_cents) AS corrected_cents
                   FROM ledger_corrections GROUP BY ledger_entry_id) c ON c.ledger_entry_id = e.id
     WHERE e.payment_entry_id = NEW.payment_entry_id AND e.id <> NEW.id;
    IF other_count > 0 AND (NOT replaces_other OR other_net <> 0) THEN
      RAISE EXCEPTION 'ledger_payment_already_linked';
    END IF;
  END IF;
  IF NEW.replaces_entry_id IS NOT NULL THEN
    SELECT * INTO replaced FROM ledger_entries WHERE id = NEW.replaces_entry_id FOR UPDATE;
    IF NOT FOUND OR replaced.school_year_id <> NEW.school_year_id THEN
      RAISE EXCEPTION 'ledger_replacement_mismatch';
    END IF;
    IF replaced.payment_entry_id IS DISTINCT FROM NEW.payment_entry_id THEN
      RAISE EXCEPTION 'ledger_replacement_payment_link_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
