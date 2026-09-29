-- Przegląd dziennika odczytu danych dzieci i opiekunów (#133, ciąg dalszy 0067).
--
-- Zmiany:
--   * access_kind przyjmuje trzy nowe rodzaje: 'class_roster_export' (eksport
--     listy klasy, GET /api/exports/class-roster), 'yearly_export' (eksport
--     roczny, POST /api/exports) i 'payment_export' (GET /api/payments/
--     export.csv, identyfikatory gospodarstw). Eksporty listy klasy i roczny
--     zapisują wpis w tej samej transakcji co export_runs i audyt export.created;
--   * indeksy pod trasę tylko-do-odczytu GET /api/admin/access-log (kursor
--     po (occurred_at, id) i filtr po rodzaju).
--
-- Skutki dla danych: żaden istniejący wiersz nie jest zmieniany ani usuwany;
-- rozszerzenie CHECK jest zgodne wstecz (dotychczasowe wartości pozostają
-- dozwolone). Trigger data_access_log_guard (0067) bez zmian. Wycofanie:
-- przywrócenie CHECK z czterema wartościami możliwe tylko dopóki żaden wiersz
-- nie ma nowych rodzajów; indeksy można usunąć bez skutków dla danych.
-- Retencja tabeli nadal nieustalona (D-04) — nic nie jest usuwane.
ALTER TABLE data_access_log DROP CONSTRAINT data_access_log_access_kind_check;
ALTER TABLE data_access_log ADD CONSTRAINT data_access_log_access_kind_check CHECK (access_kind IN (
  'class_students', 'household_card', 'print_cards', 'payment_list', 'class_roster_export', 'yearly_export', 'payment_export'
));
CREATE INDEX data_access_log_cursor_idx ON data_access_log(occurred_at DESC, id DESC);
CREATE INDEX data_access_log_kind_idx ON data_access_log(access_kind, occurred_at DESC);
