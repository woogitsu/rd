-- Osobny skrót komunikacji strukturalnej OGM-VCS pozycji wyciągu (#83, follow-up #580).
--
-- Problem: serwer przechowuje tylko solony skrót CAŁEGO znormalizowanego tytułu
-- pozycji (bank_statement_lines.reference_hash). Propozycje dopasowania (#115)
-- rozpoznają więc referencję rodziny wyłącznie wtedy, gdy tytuł składa się
-- z samej referencji. Tytuł „Składka +++123/4567/89002+++ Jan” nie daje
-- propozycji, choć zawiera poprawną komunikację.
--
-- Co zmienia:
-- * Nowa kolumna bank_statement_lines.structured_ref_hash: SHA-256 z
--   „<sól uzgodnienia>:ogm:<12 cyfr>”, liczony przy imporcie z referencji
--   wyodrębnionej z tytułu przez extractStructuredReference (src/pg/ogm.js).
--   Ekstrakcja przyjmuje tylko 12 cyfr z poprawną sumą kontrolną mod 97 i tylko
--   jedną jednoznaczną referencję w tytule — literówka albo dwie różne
--   referencje dają NULL (pozycja do ręcznego przypisania).
--   Przedrostek „ogm:” oddziela ten skrót od skrótu całego tytułu.
-- * CHECK: format 64 znaków hex; skrót referencji tylko przy pozycji, która ma
--   też skrót tytułu (referencja pochodzi z tytułu).
--
-- Nie zapisujemy: tytułu ani samej referencji (nadal tylko solone skróty).
-- Kolumna nie trafia do paczki eksportu rocznego (lista kolumn w src/pg/export.js),
-- tak jak rejestr payment_references (D-04, wariant zachowawczy).
--
-- Skutki dla istniejących danych: kolumna jest NULL we wszystkich istniejących
-- pozycjach; żaden wiersz nie jest zmieniany (pozycje wyciągu są niezmienne,
-- trigger immutable_financial_record). Przeliczenie wstecz NIE jest możliwe —
-- serwer nie zna tytułów zaimportowanych pozycji, tylko ich skróty — i nie jest
-- wykonywane. Stare pozycje są rozpoznawane jak dotąd tylko wtedy, gdy cały
-- tytuł to referencja (porównanie wariantów z reference_hash zostaje).
-- Stara pozycja z referencją w dłuższym tytule nadal wymaga ręcznego
-- dopasowania (jak przed migracją). Zapytanie kontrolne — pozycje z tytułem,
-- ale bez skrótu referencji, w szkicach (sprzed migracji albo z tytułem bez
-- poprawnej komunikacji):
--   SELECT r.id, count(*) FROM bank_statement_lines l
--     JOIN bank_reconciliations r ON r.id = l.reconciliation_id
--    WHERE r.status = 'draft' AND l.reference_hash IS NOT NULL AND l.structured_ref_hash IS NULL
--    GROUP BY r.id;
--
-- Wycofanie: ALTER TABLE bank_statement_lines DROP CONSTRAINT
-- bank_statement_line_structured_ref_requires_title, DROP COLUMN
-- structured_ref_hash. Znikają tylko skróty referencji; propozycje wracają do
-- porównania całego tytułu.

ALTER TABLE bank_statement_lines
  ADD COLUMN structured_ref_hash TEXT
    CHECK (structured_ref_hash IS NULL OR structured_ref_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT bank_statement_line_structured_ref_requires_title
    CHECK (structured_ref_hash IS NULL OR reference_hash IS NOT NULL);
