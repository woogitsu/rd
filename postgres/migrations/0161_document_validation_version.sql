-- #89 (część: ślad wersji reguł kontroli struktury). Kolumna
-- `documents.validation_version` zapisuje, którą wersją reguł
-- `validateStructure` (src/documents.js, stała DOCUMENT_VALIDATION_VERSION)
-- serwer sprawdził plik przy przesłaniu.
--
-- Po co:
--   * podgląd w panelu (`GET /api/documents/{id}/content?disposition=inline`)
--     nie musi ponownie przeszukiwać bajtów pliku, jeśli plik sprawdzono
--     BIEŻĄCĄ wersją reguł, a jego rozmiar i SHA-256 w buckecie zgadzają się
--     z zapisanymi (te same bajty + te same reguły = ten sam wynik). Plik
--     sprawdzony starszymi regułami (albo bez zapisanej wersji) jest nadal
--     sprawdzany ponownie przy każdym podglądzie, jak dotąd (409
--     document_preview_blocked przy niezgodności);
--   * lista `GET /api/documents?validation=outdated` pokazuje dokumenty
--     sprawdzone starszymi regułami (w granicach dotychczasowych uprawnień).
--
-- Wartość to liczba całkowita >= 1 albo NULL. Wiersz `documents` jest
-- niezmienny (trigger documents_no_change, 0006), więc wersja nie jest
-- podbijana po późniejszym sprawdzeniu — ponowna kontrola przy podglądzie
-- nie zmienia zapisu (ewentualny zapis ponownej kontroli to osobny zakres).
--
-- Skutki dla danych: nowa kolumna bez wartości domyślnej. Istniejące wiersze
-- dostają NULL = „wersja nieznana” (plik przyjęty przed zapisem wersji:
-- sprawdzony samą sygnaturą albo wcześniejszą wersją reguł). Niczego nie
-- uzupełniamy wstecznie — takie pliki są traktowane jak sprawdzone starszymi
-- regułami (ponowna kontrola przy każdym podglądzie, widoczne w filtrze
-- `validation=outdated`). ADD COLUMN bez DEFAULT nie przepisuje tabeli i nie
-- uruchamia triggera niezmienności. Dokumenty są poza eksportem rocznym
-- (EXPORT_EXCLUDED_TABLES), bez zmian.
-- Wycofanie: DROP COLUMN (znika tylko ślad wersji; podgląd wraca do ponownej
-- kontroli każdego pliku).

ALTER TABLE documents ADD COLUMN validation_version INTEGER;

ALTER TABLE documents ADD CONSTRAINT documents_validation_version_check
  CHECK (validation_version IS NULL OR validation_version >= 1);
