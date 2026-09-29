-- #2: ten sam plik (fingerprint) może mieć więcej niż jedną partię importu.
-- Wcześniej UNIQUE(fingerprint) wymuszał "najwyżej raz", więc po usunięciu
-- przyczyny konfliktu (import z pominięciem wierszy) ponowny import tego samego
-- pliku zwracał starą partię i pominięte wiersze nigdy nie trafiały do bazy.
-- Serwer sam pilnuje powtórek (ten sam Idempotency-Key albo brak zapisów do
-- wykonania), a idempotency_key pozostaje UNIQUE.
-- Skutki dla danych: żaden wiersz nie jest zmieniany ani usuwany; znika tylko
-- ograniczenie unikalności, w jego miejsce zwykły indeks do wyszukiwania.
-- Wycofanie: DROP INDEX import_batches_fingerprint_idx; potem
-- ALTER TABLE import_batches ADD CONSTRAINT import_batches_fingerprint_key UNIQUE (fingerprint)
-- (możliwe tylko dopóki żaden fingerprint nie ma dwóch partii).
ALTER TABLE import_batches DROP CONSTRAINT import_batches_fingerprint_key;
CREATE INDEX import_batches_fingerprint_idx ON import_batches (fingerprint, created_at);
