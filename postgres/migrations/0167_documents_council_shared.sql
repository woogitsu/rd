-- #167 (część: dokumenty Rady dla przedstawicieli). Nowy rodzaj dokumentu
-- `council_shared` — regulamin, plan pracy, informacja o składce, szablon listy
-- obecności — przesyłany przez admina lub zarząd (przydział bez klasy, jak
-- `board`) i czytany także przez przedstawicieli klas z przydziałem w tym roku
-- (DOCUMENT_POLICIES w src/pg/routes/documents.js, `readRoles`). Które
-- dokumenty tam trafiają, rozstrzyga zarząd (D-08); migracja tylko dopuszcza
-- rodzaj w bazie.
--
-- Zmiana: CHECK `documents_api_row` (0006) dopuszcza kind = 'council_shared'
-- (bez klasy, tak jak `board`; powiązanie z księgą nadal wyłącznie `financial`).
-- Pozostałe warunki wiersza (sha256, klucz obiektu, typ MIME, rozmiar) bez zmian.
-- `news_photo_document_kind_allowed` (0143) zostaje przy `board` — dokument
-- Rady dla przedstawicieli nie może być źródłem zdjęcia publicznej galerii.
--
-- Skutki dla danych: zbiór dozwolonych wartości tylko się powiększa, więc
-- istniejące wiersze `documents` spełniają nowy warunek i nie są zmieniane
-- (trigger niezmienności 0006 działa na UPDATE/DELETE, nie na ADD CONSTRAINT).
-- Brak nowych wierszy ani kolumn; `documents` pozostaje poza eksportem rocznym.
-- Wycofanie: najpierw usunąć (po okresie retencji, D-04) lub zostawić wiersze
-- `council_shared`, potem odtworzyć CHECK z 0006 bez tego rodzaju — przy
-- istniejących wierszach tego rodzaju ADD CONSTRAINT zakończy się błędem.

ALTER TABLE documents DROP CONSTRAINT documents_api_row;

ALTER TABLE documents ADD CONSTRAINT documents_api_row CHECK (
  school_year_id IS NULL OR (
    kind IN ('financial', 'board', 'class', 'council_shared')
    AND (kind = 'class') = (class_id IS NOT NULL)
    AND (linked_entity_type IS NULL OR kind = 'financial')
    AND sha256 IS NOT NULL
    AND idempotency_key IS NOT NULL
    AND object_key ~ '^docs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND mime_type IN ('application/pdf', 'image/png', 'image/jpeg')
    AND byte_size > 0
  )
);
