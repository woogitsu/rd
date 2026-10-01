-- Idempotencja rejestracji żądania osoby (#100): POST /api/admin/data-requests
-- z nagłówkiem Idempotency-Key. Prototyp — nie jest wdrożony.
--
-- Problem: ponowienie po zerwanym połączeniu albo podwójne kliknięcie
-- tworzyło drugi wpis w rejestrze (i drugie zdarzenie
-- data_subject_request.created).
--
-- Co dodaje: kolumnę data_subject_requests.idempotency_key (opcjonalną,
-- z CHECK na format jak w pozostałych trasach) oraz unikalny indeks częściowy
-- (WHERE idempotency_key IS NOT NULL). Ten sam klucz i ten sam ładunek zwraca
-- zapisany wiersz (200, Idempotency-Replayed: true); ten sam klucz z innym
-- ładunkiem to 409 idempotency_conflict — rozstrzyga trasa.
--
-- Skutki dla istniejących danych: istniejące wiersze dostają NULL i nie są
-- zmieniane; indeks częściowy ich nie obejmuje, więc nie ma konfliktów.
-- Trigger data_subject_request_guard nie dotyka nowej kolumny (kolumna jest
-- ustawiana tylko w INSERT). Klucz nie zawiera danych osobowych — to losowy
-- token klienta.
ALTER TABLE data_subject_requests
  ADD COLUMN idempotency_key TEXT
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$');
CREATE UNIQUE INDEX data_subject_requests_idempotency_key_key
  ON data_subject_requests(idempotency_key) WHERE idempotency_key IS NOT NULL;
