-- Indeksy pod listy z kursorem (issue #159, część 2 "Indeksy" z propozycji).
--
-- Skutki dla danych:
-- * Wyłącznie CREATE INDEX — bez nowych kolumn, tabel ani zmiany danych.
--   Istniejące wiersze bez zmian; zapis do audit_events/payment_entries robi
--   odtąd nieco więcej pracy (utrzymanie dodatkowych indeksów), zaniedbywalne
--   przy obecnej skali (#16/#41: rosnące dane jednej szkoły).
-- * audit_events(occurred_at DESC, id): pod listAudit (ORDER BY occurred_at
--   DESC z kursorem po (occurred_at, id)) — dziś Seq Scan + sort przy dużej
--   liczbie zdarzeń (patrz EXPLAIN w opisie issue #159).
-- * audit_events(action, occurred_at DESC): pod filtr `action = ANY(...)`
--   z listAudit, żeby nie skanować całej tabeli przy zawężeniu do kilku akcji.
-- * payment_entries(school_year_id, received_on DESC, id DESC) WHERE status
--   IN ('recorded','unmatched'): pod listę wpłat GET /api/payments (sortowanie
--   po (received_on DESC, id DESC), status IN (...)) — istniejący
--   payment_year_status_idx nie zawiera `id` (drugi klucz sortowania kursora)
--   i obejmuje też status 'reversed', którego lista nie pokazuje.
-- Wycofanie: DROP INDEX (bezpieczne na każdej bazie — same indeksy).
-- Na dużej produkcyjnej bazie: rozważyć CREATE INDEX CONCURRENTLY poza
-- transakcją migratora (poza zakresem tego prototypu — patrz issue #159).

CREATE INDEX audit_occurred_at_idx ON audit_events(occurred_at DESC, id);
CREATE INDEX audit_action_occurred_at_idx ON audit_events(action, occurred_at DESC);
CREATE INDEX payment_list_idx ON payment_entries(school_year_id, received_on DESC, id DESC)
  WHERE status IN ('recorded', 'unmatched');
