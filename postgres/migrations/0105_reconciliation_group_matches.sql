-- Dopasowanie wiele-do-jednego w uzgodnieniu rachunku (#127, część 2).
--
-- Jedna pozycja wyciągu (przelew zbiorczy: kilka rodzin jednym przelewem,
-- dziadkowie za wnuki, rodzeństwo w różnych gospodarstwach, wpłata gotówki
-- zebranej przez przedstawiciela) ↔ kilka wpłat albo kilka wpisów księgi.
-- Wpłata podzielona na części (payment_allocations, 0104) jest jedną pozycją
-- dopasowania o pełnej kwocie netto — podział na gospodarstwa nie zmienia
-- strony bankowej.
--
-- Co zmienia:
-- * bank_reconciliation_group_matches — nagłówek dopasowania zbiorczego:
--   uzgodnienie, rok, pozycja wyciągu, autor, czas, klucz idempotencji.
-- * bank_reconciliation_group_match_items — pozycje dopasowania: dokładnie
--   jeden cel (wpłata albo wpis księgi) i jego kwota netto ze znakiem
--   w chwili dopasowania (amount_cents; + wpływ, − wypływ). Kwota musi
--   równać się dzisiejszemu netto celu (bank_match_amount_mismatch) i mieć
--   ten sam znak co pozycja wyciągu (bank_group_match_direction_mismatch).
-- * Suma pozycji = kwota pozycji wyciągu i co najmniej dwie pozycje:
--   sprawdzane przy COMMIT (CONSTRAINT TRIGGER … DEFERRABLE INITIALLY
--   DEFERRED) po każdym wstawieniu nagłówka i pozycji. Nie ma dopasowań
--   „z różnicą”, a późniejsze dopisanie pozycji do istniejącego
--   dopasowania zmieniłoby sumę i zostaje odrzucone
--   (bank_group_match_sum_mismatch, bank_group_match_too_few_items).
-- * bank_reconciliation_group_match_revocations — cofnięcie jako NOWY,
--   niezmienny zapis z powodem (najwyżej jedno na dopasowanie). Nagłówka
--   i pozycji nie da się zmienić ani usunąć; błąd = cofnięcie + nowe
--   dopasowanie. bank_reconciliation_group_matches_current = bez cofnięcia.
-- * Wyłączność w uzgodnieniu (pod blokadą wiersza uzgodnienia FOR NO KEY
--   UPDATE, tą samą co w bank_match_guard z 0024, więc dopasowania 1:1
--   i zbiorcze jednego uzgodnienia wykonują się po kolei):
--   - pozycja wyciągu ma najwyżej jedno aktywne dopasowanie — 1:1 ALBO
--     zbiorcze (bank_group_match_line_taken);
--   - wpłata/wpis jest aktywnie w najwyżej jednym dopasowaniu 1:1 albo
--     zbiorczym (bank_group_match_target_taken);
--   - wpłata i wpis księgi z jej payment_entry_id to te same pieniądze:
--     bank_match_already_matched_via_ledger / …_via_payment jak w 0024.
--   - w ROKU (#105 pkt 6): wpłata/wpis (także para wpłata–wpis, #162) aktywnie
--     w dopasowaniu zbiorczym jednego uzgodnienia nie może być aktywnie
--     dopasowana (1:1 ani zbiorczo) w INNYM uzgodnieniu tego roku
--     (bank_match_in_other_reconciliation), pod blokadą doradczą roku tą samą
--     co bank_match_year_unique_guard z 0089 — bez tego dopasowanie zbiorcze
--     omijałoby unikalność w roku i ta sama wpłata liczyłaby się w dwóch
--     uzgodnieniach. 1:1 ↔ 1:1 w różnych uzgodnieniach pilnuje 0089.
--   Dla dopasowań 1:1 dochodzi OSOBNY trigger bank_matches_z_group_guard
--   (po bank_matches_guard_insert, kolejność alfabetyczna) — bank_match_guard
--   z 0024 NIE jest redefiniowany, a istniejące dopasowania 1:1 zostają bez
--   zmian.
-- * Cele: wpłata 'recorded'/'unmatched' metodą 'bank' (jak 1:1) albo wpis
--   księgi; rok celu = rok uzgodnienia; wiersz celu blokowany FOR SHARE
--   przed odczytem netto (równoległa korekta kończy się pierwsza).
-- * Widok bank_group_match_consistency: aktywne dopasowania zbiorcze z sumą
--   kwot z chwili dopasowania, sumą dzisiejszego netto celów i flagą
--   consistent (suma dzisiejszego netto = kwota pozycji wyciągu i każda
--   pozycja bez zmiany netto). Zatwierdzenie uzgodnienia (osobny trigger
--   bank_reconciliations_z_group_guard, po bank_reconciliations_guard_change;
--   bank_reconciliation_guard NIE jest redefiniowany) blokuje cele FOR SHARE
--   i odrzuca niespójne dopasowanie tym samym kodem co 0024
--   (bank_reconciliation_inconsistent_matches).
-- * Korekta wpłaty/wpisu, który jest pozycją aktywnego dopasowania
--   zbiorczego w SZKICU: active_bank_match, jak 0039 dla 1:1. Osobne
--   triggery z prefiksem z_ na payment_corrections i ledger_corrections;
--   payment_correction_guard i ledger_correction_guard (0039) NIE są
--   redefiniowane. Zwroty (payment_refunds) — jak dla 1:1 nie są blokowane;
--   niezgodność wychodzi przy zatwierdzeniu.
-- * Zamrożenie roku: wszystkie trzy tabele mają własną kolumnę
--   school_year_id (= rok uzgodnienia) i trigger year_freeze_direct; bez
--   zmiany year_freeze_via_parent. Niezmienność: immutable_financial_record
--   oraz — jak tabele z 0095 (SR-05, #101) — trigger BEFORE TRUNCATE
--   z deny_truncate() na każdej z trzech tabel.
--
-- Skutki dla istniejących danych: tylko nowe tabele, widoki, funkcje
-- i triggery. Żaden wiersz nie jest zmieniany ani usuwany. Istniejące
-- dopasowania 1:1 (także w zatwierdzonych uzgodnieniach) zostają bez zmian;
-- dopóki nikt nie utworzy dopasowania zbiorczego, liczniki uzgodnienia,
-- raport KR i eksport dają te same wyniki co przed migracją.
--
-- Wycofanie: na bazie bez dopasowań zbiorczych — DROP TRIGGER
-- bank_matches_z_group_guard, bank_reconciliations_z_group_guard,
-- payment_corrections_z_group_match_guard, ledger_corrections_z_group_match_guard,
-- DROP VIEW bank_group_match_consistency, bank_reconciliation_group_matches_current,
-- DROP TABLE (revocations, items, group_matches) i funkcji poniżej (w tym
-- bank_target_matched_elsewhere_in_year). Na bazie
-- z dopasowaniami zbiorczymi — tylko po kopii zapasowej i decyzji o retencji
-- (D-04): pozycje wyciągu wrócą do stanu „niedopasowana”.

CREATE TABLE bank_reconciliation_group_matches (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES bank_reconciliations(id),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  statement_line_id TEXT NOT NULL REFERENCES bank_statement_lines(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 128)
);
CREATE INDEX bank_group_matches_reconciliation_idx
  ON bank_reconciliation_group_matches(reconciliation_id, created_at, id);
CREATE INDEX bank_group_matches_line_idx
  ON bank_reconciliation_group_matches(statement_line_id);

CREATE TABLE bank_reconciliation_group_match_items (
  id TEXT PRIMARY KEY,
  group_match_id TEXT NOT NULL REFERENCES bank_reconciliation_group_matches(id),
  reconciliation_id TEXT NOT NULL REFERENCES bank_reconciliations(id),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  ledger_entry_id TEXT REFERENCES ledger_entries(id),
  payment_entry_id TEXT REFERENCES payment_entries(id),
  -- Netto celu ze znakiem w chwili dopasowania (+ wpływ, − wypływ).
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0 AND amount_cents BETWEEN -100000000 AND 100000000),
  CONSTRAINT bank_group_match_item_single_target CHECK ((ledger_entry_id IS NULL) <> (payment_entry_id IS NULL)),
  UNIQUE (group_match_id, ledger_entry_id),
  UNIQUE (group_match_id, payment_entry_id)
);
CREATE INDEX bank_group_match_items_group_idx ON bank_reconciliation_group_match_items(group_match_id);
CREATE INDEX bank_group_match_items_payment_idx
  ON bank_reconciliation_group_match_items(payment_entry_id) WHERE payment_entry_id IS NOT NULL;
CREATE INDEX bank_group_match_items_ledger_idx
  ON bank_reconciliation_group_match_items(ledger_entry_id) WHERE ledger_entry_id IS NOT NULL;

CREATE TABLE bank_reconciliation_group_match_revocations (
  id TEXT PRIMARY KEY,
  group_match_id TEXT NOT NULL UNIQUE REFERENCES bank_reconciliation_group_matches(id),
  reconciliation_id TEXT NOT NULL REFERENCES bank_reconciliations(id),
  school_year_id TEXT NOT NULL REFERENCES school_years(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE VIEW bank_reconciliation_group_matches_current AS
SELECT g.id, g.reconciliation_id, g.school_year_id, g.statement_line_id, g.created_by, g.created_at
FROM bank_reconciliation_group_matches g
WHERE NOT EXISTS (SELECT 1 FROM bank_reconciliation_group_match_revocations r WHERE r.group_match_id = g.id);

-- Aktywne pozycje dopasowań zbiorczych (bez cofniętych).
CREATE VIEW bank_group_match_items_current AS
SELECT i.* FROM bank_reconciliation_group_match_items i
WHERE NOT EXISTS (SELECT 1 FROM bank_reconciliation_group_match_revocations r WHERE r.group_match_id = i.group_match_id);

-- Dzisiejsze netto celu pozycji ze znakiem (jak w bank_match_consistency z 0024).
CREATE VIEW bank_group_match_consistency AS
SELECT g.id AS group_match_id, g.reconciliation_id, g.statement_line_id,
  l.amount_cents AS line_amount_cents,
  count(i.id) AS item_count,
  COALESCE(sum(i.amount_cents), 0)::BIGINT AS matched_total_cents,
  COALESCE(sum(CASE WHEN i.ledger_entry_id IS NOT NULL
      THEN CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END
      ELSE p.net_amount_cents END), 0)::BIGINT AS target_net_cents,
  COALESCE(bool_and(i.amount_cents = CASE WHEN i.ledger_entry_id IS NOT NULL
      THEN CASE WHEN e.direction = 'income' THEN e.net_amount_cents ELSE -e.net_amount_cents END
      ELSE p.net_amount_cents END), false) AS items_unchanged
FROM bank_reconciliation_group_matches_current g
JOIN bank_statement_lines l ON l.id = g.statement_line_id
LEFT JOIN bank_reconciliation_group_match_items i ON i.group_match_id = g.id
LEFT JOIN ledger_entry_net e ON e.id = i.ledger_entry_id
LEFT JOIN payment_entry_net p ON p.id = i.payment_entry_id
GROUP BY g.id, g.reconciliation_id, g.statement_line_id, l.amount_cents;

-- Czy wpłata/wpis są już aktywnie w jakimkolwiek dopasowaniu tego uzgodnienia
-- (1:1 albo zbiorczym). p_except_group — pomija pozycje wskazanego dopasowania.
CREATE FUNCTION bank_reconciliation_target_taken(
  p_reconciliation_id TEXT, p_ledger_entry_id TEXT, p_payment_entry_id TEXT, p_except_group TEXT
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM bank_reconciliation_matches m
     WHERE m.reconciliation_id = p_reconciliation_id AND m.revoked_at IS NULL
       AND ((p_ledger_entry_id IS NOT NULL AND m.ledger_entry_id = p_ledger_entry_id)
         OR (p_payment_entry_id IS NOT NULL AND m.payment_entry_id = p_payment_entry_id))
  ) OR EXISTS (
    SELECT 1 FROM bank_group_match_items_current i
     WHERE i.reconciliation_id = p_reconciliation_id
       AND i.group_match_id IS DISTINCT FROM p_except_group
       AND ((p_ledger_entry_id IS NOT NULL AND i.ledger_entry_id = p_ledger_entry_id)
         OR (p_payment_entry_id IS NOT NULL AND i.payment_entry_id = p_payment_entry_id))
  );
$$;

-- Wpłata p_payment_entry_id jest aktywnie ujęta przez wpis księgi (1:1 albo zbiorczo).
CREATE FUNCTION bank_reconciliation_payment_via_ledger(p_reconciliation_id TEXT, p_payment_entry_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM bank_reconciliation_matches m JOIN ledger_entries le ON le.id = m.ledger_entry_id
     WHERE m.reconciliation_id = p_reconciliation_id AND m.revoked_at IS NULL
       AND le.payment_entry_id = p_payment_entry_id
  ) OR EXISTS (
    SELECT 1 FROM bank_group_match_items_current i JOIN ledger_entries le ON le.id = i.ledger_entry_id
     WHERE i.reconciliation_id = p_reconciliation_id AND le.payment_entry_id = p_payment_entry_id
  );
$$;

-- Uzgodnienie INNE niż p_reconciliation_id w tym samym roku, w którym cel jest
-- aktywnie dopasowany (#105 pkt 6). Cel = wpis księgi albo wpłata; wpłata i wpis,
-- który ją ujmuje, to te same pieniądze (#162). p_include_simple: także
-- dopasowania 1:1 (dla nowej pozycji zbiorczej); dla nowego 1:1 tylko zbiorcze.
CREATE FUNCTION bank_target_matched_elsewhere_in_year(
  p_school_year_id TEXT, p_reconciliation_id TEXT, p_ledger_entry_id TEXT, p_payment_entry_id TEXT,
  p_include_simple BOOLEAN
) RETURNS TEXT LANGUAGE sql STABLE AS $$
  WITH target AS (
    SELECT COALESCE(p_payment_entry_id,
      (SELECT payment_entry_id FROM ledger_entries WHERE id = p_ledger_entry_id)) AS payment_id
  )
  SELECT found.reconciliation_id FROM (
    SELECT m.reconciliation_id FROM bank_reconciliation_matches m
      JOIN bank_reconciliations r ON r.id = m.reconciliation_id
      LEFT JOIN ledger_entries le ON le.id = m.ledger_entry_id
      CROSS JOIN target t
     WHERE p_include_simple AND r.school_year_id = p_school_year_id
       AND m.reconciliation_id <> p_reconciliation_id AND m.revoked_at IS NULL
       AND ((p_ledger_entry_id IS NOT NULL AND m.ledger_entry_id = p_ledger_entry_id)
         OR (t.payment_id IS NOT NULL AND (m.payment_entry_id = t.payment_id OR le.payment_entry_id = t.payment_id)))
    UNION ALL
    SELECT i.reconciliation_id FROM bank_group_match_items_current i
      LEFT JOIN ledger_entries le ON le.id = i.ledger_entry_id
      CROSS JOIN target t
     WHERE i.school_year_id = p_school_year_id AND i.reconciliation_id <> p_reconciliation_id
       AND ((p_ledger_entry_id IS NOT NULL AND i.ledger_entry_id = p_ledger_entry_id)
         OR (t.payment_id IS NOT NULL AND (i.payment_entry_id = t.payment_id OR le.payment_entry_id = t.payment_id)))
  ) found
  LIMIT 1;
$$;

CREATE FUNCTION bank_group_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_parent bank_reconciliations%ROWTYPE;
DECLARE v_line bank_statement_lines%ROWTYPE;
BEGIN
  -- Ta sama kolejność blokad co bank_match_guard (0024).
  PERFORM 1 FROM bank_reconciliations WHERE id = NEW.reconciliation_id FOR NO KEY UPDATE;
  v_parent := bank_reconciliation_require_draft(NEW.reconciliation_id);
  IF NEW.school_year_id IS DISTINCT FROM v_parent.school_year_id THEN
    RAISE EXCEPTION 'bank_match_target_mismatch';
  END IF;
  SELECT * INTO v_line FROM bank_statement_lines WHERE id = NEW.statement_line_id;
  IF NOT FOUND OR v_line.reconciliation_id <> NEW.reconciliation_id THEN
    RAISE EXCEPTION 'bank_match_line_mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM bank_reconciliation_matches m
              WHERE m.statement_line_id = NEW.statement_line_id AND m.revoked_at IS NULL)
     OR EXISTS (SELECT 1 FROM bank_reconciliation_group_matches_current g
                 WHERE g.statement_line_id = NEW.statement_line_id) THEN
    RAISE EXCEPTION 'bank_group_match_line_taken';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON bank_reconciliation_group_matches
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER bank_group_matches_guard_insert BEFORE INSERT ON bank_reconciliation_group_matches
  FOR EACH ROW EXECUTE FUNCTION bank_group_match_guard();
CREATE TRIGGER bank_group_matches_no_change BEFORE UPDATE OR DELETE ON bank_reconciliation_group_matches
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER bank_reconciliation_group_matches_no_truncate BEFORE TRUNCATE ON bank_reconciliation_group_matches
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();

CREATE FUNCTION bank_group_match_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_parent bank_reconciliations%ROWTYPE;
DECLARE v_group bank_reconciliation_group_matches%ROWTYPE;
DECLARE v_line bank_statement_lines%ROWTYPE;
DECLARE v_entry ledger_entry_net%ROWTYPE;
DECLARE v_payment payment_entries%ROWTYPE;
DECLARE v_net BIGINT;
BEGIN
  PERFORM 1 FROM bank_reconciliations WHERE id = NEW.reconciliation_id FOR NO KEY UPDATE;
  v_parent := bank_reconciliation_require_draft(NEW.reconciliation_id);
  SELECT * INTO v_group FROM bank_reconciliation_group_matches WHERE id = NEW.group_match_id;
  IF NOT FOUND OR v_group.reconciliation_id <> NEW.reconciliation_id
     OR NEW.school_year_id IS DISTINCT FROM v_parent.school_year_id THEN
    RAISE EXCEPTION 'bank_match_target_mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM bank_reconciliation_group_match_revocations r WHERE r.group_match_id = NEW.group_match_id) THEN
    RAISE EXCEPTION 'bank_match_already_revoked';
  END IF;
  SELECT * INTO v_line FROM bank_statement_lines WHERE id = v_group.statement_line_id;
  IF sign(NEW.amount_cents) <> sign(v_line.amount_cents) THEN
    RAISE EXCEPTION 'bank_group_match_direction_mismatch';
  END IF;
  IF bank_reconciliation_target_taken(NEW.reconciliation_id, NEW.ledger_entry_id, NEW.payment_entry_id, NEW.group_match_id) THEN
    RAISE EXCEPTION 'bank_group_match_target_taken';
  END IF;
  -- Jedno aktywne dopasowanie celu w roku (#105): blokada doradcza roku jak w 0089.
  PERFORM pg_advisory_xact_lock(hashtext('bank_match_year:' || v_parent.school_year_id));
  IF bank_target_matched_elsewhere_in_year(v_parent.school_year_id, NEW.reconciliation_id,
       NEW.ledger_entry_id, NEW.payment_entry_id, true) IS NOT NULL THEN
    RAISE EXCEPTION 'bank_match_in_other_reconciliation';
  END IF;
  IF NEW.ledger_entry_id IS NOT NULL THEN
    PERFORM 1 FROM ledger_entries WHERE id = NEW.ledger_entry_id FOR SHARE;
    SELECT * INTO v_entry FROM ledger_entry_net WHERE id = NEW.ledger_entry_id;
    IF NOT FOUND OR v_entry.school_year_id <> v_parent.school_year_id THEN
      RAISE EXCEPTION 'bank_match_target_mismatch';
    END IF;
    -- Wpłata tego wpisu jest już ujęta (1:1 albo pozycją dopasowania zbiorczego, także tego samego).
    IF v_entry.payment_entry_id IS NOT NULL AND (
      EXISTS (SELECT 1 FROM bank_reconciliation_matches o
               WHERE o.reconciliation_id = NEW.reconciliation_id AND o.revoked_at IS NULL
                 AND o.payment_entry_id = v_entry.payment_entry_id)
      OR EXISTS (SELECT 1 FROM bank_group_match_items_current o
                  WHERE o.reconciliation_id = NEW.reconciliation_id AND o.payment_entry_id = v_entry.payment_entry_id)
    ) THEN RAISE EXCEPTION 'bank_match_already_matched_via_payment'; END IF;
    v_net := CASE WHEN v_entry.direction = 'income' THEN v_entry.net_amount_cents ELSE -v_entry.net_amount_cents END;
  ELSE
    SELECT * INTO v_payment FROM payment_entries WHERE id = NEW.payment_entry_id FOR SHARE;
    IF NOT FOUND OR v_payment.school_year_id <> v_parent.school_year_id
       OR v_payment.status NOT IN ('recorded', 'unmatched') THEN
      RAISE EXCEPTION 'bank_match_target_mismatch';
    END IF;
    IF v_payment.method <> 'bank' THEN RAISE EXCEPTION 'bank_match_method_mismatch'; END IF;
    IF bank_reconciliation_payment_via_ledger(NEW.reconciliation_id, NEW.payment_entry_id) THEN
      RAISE EXCEPTION 'bank_match_already_matched_via_ledger';
    END IF;
    SELECT net_amount_cents INTO v_net FROM payment_entry_net WHERE id = NEW.payment_entry_id;
  END IF;
  IF NEW.amount_cents <> v_net THEN RAISE EXCEPTION 'bank_match_amount_mismatch'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON bank_reconciliation_group_match_items
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER bank_group_match_items_guard_insert BEFORE INSERT ON bank_reconciliation_group_match_items
  FOR EACH ROW EXECUTE FUNCTION bank_group_match_item_guard();
CREATE TRIGGER bank_group_match_items_no_change BEFORE UPDATE OR DELETE ON bank_reconciliation_group_match_items
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER bank_reconciliation_group_match_items_no_truncate BEFORE TRUNCATE ON bank_reconciliation_group_match_items
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();

-- Przy COMMIT: suma pozycji = kwota pozycji wyciągu, co najmniej dwie pozycje.
CREATE FUNCTION bank_group_match_sum_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_group_id TEXT;
DECLARE v_line_amount BIGINT;
DECLARE v_total BIGINT;
DECLARE v_count INTEGER;
BEGIN
  -- Osobne gałęzie: NEW nagłówka nie ma pola group_match_id (i odwrotnie).
  IF TG_TABLE_NAME = 'bank_reconciliation_group_matches' THEN
    v_group_id := NEW.id;
  ELSE
    v_group_id := NEW.group_match_id;
  END IF;
  SELECT l.amount_cents INTO v_line_amount
    FROM bank_reconciliation_group_matches g JOIN bank_statement_lines l ON l.id = g.statement_line_id
   WHERE g.id = v_group_id;
  SELECT COALESCE(sum(amount_cents), 0), count(*) INTO v_total, v_count
    FROM bank_reconciliation_group_match_items WHERE group_match_id = v_group_id;
  IF v_count < 2 THEN RAISE EXCEPTION 'bank_group_match_too_few_items'; END IF;
  IF v_total <> v_line_amount THEN RAISE EXCEPTION 'bank_group_match_sum_mismatch'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER bank_group_matches_sum_check AFTER INSERT ON bank_reconciliation_group_matches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_group_match_sum_check();
CREATE CONSTRAINT TRIGGER bank_group_match_items_sum_check AFTER INSERT ON bank_reconciliation_group_match_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_group_match_sum_check();

CREATE FUNCTION bank_group_match_revocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_parent bank_reconciliations%ROWTYPE;
DECLARE v_group bank_reconciliation_group_matches%ROWTYPE;
BEGIN
  PERFORM 1 FROM bank_reconciliations WHERE id = NEW.reconciliation_id FOR NO KEY UPDATE;
  v_parent := bank_reconciliation_require_draft(NEW.reconciliation_id);
  SELECT * INTO v_group FROM bank_reconciliation_group_matches WHERE id = NEW.group_match_id;
  IF NOT FOUND OR v_group.reconciliation_id <> NEW.reconciliation_id
     OR NEW.school_year_id IS DISTINCT FROM v_parent.school_year_id THEN
    RAISE EXCEPTION 'bank_match_target_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a0_year_freeze BEFORE INSERT ON bank_reconciliation_group_match_revocations
  FOR EACH ROW EXECUTE FUNCTION year_freeze_direct();
CREATE TRIGGER bank_group_match_revocations_guard_insert BEFORE INSERT ON bank_reconciliation_group_match_revocations
  FOR EACH ROW EXECUTE FUNCTION bank_group_match_revocation_guard();
CREATE TRIGGER bank_group_match_revocations_no_change BEFORE UPDATE OR DELETE ON bank_reconciliation_group_match_revocations
  FOR EACH ROW EXECUTE FUNCTION immutable_financial_record();
CREATE TRIGGER bank_reconciliation_group_match_revocations_no_truncate BEFORE TRUNCATE ON bank_reconciliation_group_match_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION deny_truncate();

-- Dopasowanie 1:1: wyłączność z dopasowaniami zbiorczymi. Uruchamia się po
-- bank_matches_guard_insert (0024), który już zablokował wiersz uzgodnienia.
CREATE FUNCTION bank_match_group_exclusive_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_payment_of_entry TEXT;
DECLARE v_year TEXT;
BEGIN
  -- Cel dopasowany zbiorczo w INNYM uzgodnieniu tego roku (#105): pod blokadą roku.
  SELECT school_year_id INTO v_year FROM bank_reconciliations WHERE id = NEW.reconciliation_id;
  IF v_year IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('bank_match_year:' || v_year));
    IF bank_target_matched_elsewhere_in_year(v_year, NEW.reconciliation_id,
         NEW.ledger_entry_id, NEW.payment_entry_id, false) IS NOT NULL THEN
      RAISE EXCEPTION 'bank_match_in_other_reconciliation';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM bank_reconciliation_group_matches_current g
              WHERE g.statement_line_id = NEW.statement_line_id) THEN
    RAISE EXCEPTION 'bank_group_match_line_taken';
  END IF;
  IF EXISTS (SELECT 1 FROM bank_group_match_items_current i
              WHERE i.reconciliation_id = NEW.reconciliation_id
                AND ((NEW.ledger_entry_id IS NOT NULL AND i.ledger_entry_id = NEW.ledger_entry_id)
                  OR (NEW.payment_entry_id IS NOT NULL AND i.payment_entry_id = NEW.payment_entry_id))) THEN
    RAISE EXCEPTION 'bank_group_match_target_taken';
  END IF;
  IF NEW.ledger_entry_id IS NOT NULL THEN
    SELECT payment_entry_id INTO v_payment_of_entry FROM ledger_entries WHERE id = NEW.ledger_entry_id;
    IF v_payment_of_entry IS NOT NULL AND EXISTS (
      SELECT 1 FROM bank_group_match_items_current i
       WHERE i.reconciliation_id = NEW.reconciliation_id AND i.payment_entry_id = v_payment_of_entry
    ) THEN RAISE EXCEPTION 'bank_match_already_matched_via_payment'; END IF;
  ELSIF EXISTS (
    SELECT 1 FROM bank_group_match_items_current i JOIN ledger_entries le ON le.id = i.ledger_entry_id
     WHERE i.reconciliation_id = NEW.reconciliation_id AND le.payment_entry_id = NEW.payment_entry_id
  ) THEN RAISE EXCEPTION 'bank_match_already_matched_via_ledger';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_matches_z_group_guard BEFORE INSERT ON bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION bank_match_group_exclusive_guard();

-- Zatwierdzenie: dopasowania zbiorcze sprawdzane ponownie pod blokadą celów.
CREATE FUNCTION bank_reconciliation_group_confirm_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'confirmed' THEN
    PERFORM 1 FROM ledger_entries e
      WHERE e.id IN (SELECT i.ledger_entry_id FROM bank_group_match_items_current i WHERE i.reconciliation_id = NEW.id)
      ORDER BY e.id FOR SHARE;
    PERFORM 1 FROM payment_entries p
      WHERE p.id IN (SELECT i.payment_entry_id FROM bank_group_match_items_current i WHERE i.reconciliation_id = NEW.id)
      ORDER BY p.id FOR SHARE;
    IF EXISTS (
      SELECT 1 FROM bank_group_match_consistency c
       WHERE c.reconciliation_id = NEW.id
         AND (c.target_net_cents <> c.line_amount_cents OR NOT c.items_unchanged)
    ) THEN RAISE EXCEPTION 'bank_reconciliation_inconsistent_matches'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_reconciliations_z_group_guard BEFORE UPDATE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_group_confirm_guard();

-- Korekta celu aktywnego dopasowania zbiorczego w szkicu: active_bank_match (jak 0039).
CREATE FUNCTION bank_group_match_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_taken BOOLEAN;
BEGIN
  -- Osobne gałęzie: NEW korekty wpisu nie ma pola payment_entry_id (i odwrotnie).
  IF TG_TABLE_NAME = 'payment_corrections' THEN
    SELECT EXISTS (SELECT 1 FROM bank_group_match_items_current i
                     JOIN bank_reconciliations r ON r.id = i.reconciliation_id
                    WHERE r.status = 'draft' AND i.payment_entry_id = NEW.payment_entry_id) INTO v_taken;
  ELSE
    SELECT EXISTS (SELECT 1 FROM bank_group_match_items_current i
                     JOIN bank_reconciliations r ON r.id = i.reconciliation_id
                    WHERE r.status = 'draft' AND i.ledger_entry_id = NEW.ledger_entry_id) INTO v_taken;
  END IF;
  IF v_taken THEN RAISE EXCEPTION 'active_bank_match'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_corrections_z_group_match_guard BEFORE INSERT ON payment_corrections
  FOR EACH ROW EXECUTE FUNCTION bank_group_match_correction_guard();
CREATE TRIGGER ledger_corrections_z_group_match_guard BEFORE INSERT ON ledger_corrections
  FOR EACH ROW EXECUTE FUNCTION bank_group_match_correction_guard();
