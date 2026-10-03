-- Ponowne zastosowanie przebiegów anonimizacji po odtworzeniu kopii (#91,
-- scripts/reapply-anonymization.js). Prototyp — nie jest wdrożony i nie jest
-- gotowy do pracy na danych rodzin. Zmiana nie zawiera żadnej decyzji D-04:
-- nie dodaje okresów, nie zmienia warunków przebiegu z trasy API.
--
-- Problem: przebieg anonimizacji (0174) zmienia tylko bieżącą bazę. Kopia lub
-- paczka sprzed przebiegu zawiera dane osobowe, a wiersza `anonymization_runs`
-- jeszcze w niej nie ma — po odtworzeniu nie wiadomo, co należy zanonimizować
-- ponownie. Dziennik przechowywany POZA bazą (eksport `anonymization_runs`,
-- scripts/export-anonymization-log.js) wskazuje gospodarstwa; ponowne
-- zastosowanie musi zostawić w bazie ślad, że to powtórzenie przebiegu, a nie
-- nowa decyzja, i musi mieć nośnik na dane źródłowego przebiegu (żądanie osoby
-- i polityki z oryginalnego przebiegu mogą nie istnieć w odtworzonej bazie, więc
-- klucz obcy `data_subject_request_id` nie może ich wskazywać).
--
-- Zmiany w `anonymization_runs`:
-- 1. Nowy kod powodu `restore_reapply` (obok `retention_policy` i
--    `data_subject_request`). Trasa POST /api/admin/anonymizations dalej
--    przyjmuje wyłącznie dwa dotychczasowe kody (ANONYMIZATION_REASON_CODES);
--    `restore_reapply` zapisuje wyłącznie skrypt ponownego zastosowania.
-- 2. Kolumna `source_run` (JSONB, NULL dla zwykłych przebiegów): dane
--    ŹRÓDŁOWEGO przebiegu z dziennika poza bazą — `reasonCode`,
--    `dataSubjectRequestId`, `retentionPolicyIds`, `planSha256`, `executedAt`,
--    `executedBy`. Same identyfikatory, kody i skróty; bez imion, e-maili i
--    tekstów. Identyfikator wiersza (`id`) jest identyfikatorem przebiegu ze
--    źródła, więc ponowne uruchomienie skryptu jest idempotentne (klucz główny)
--    i eksport dziennika po ponownym zastosowaniu jest równoważny wcześniejszemu.
-- 3. Zamiast dwóch CHECK-ów (kod powodu, kształt) — te same reguły dla dwóch
--    dotychczasowych kodów plus reguła dla `restore_reapply`: `source_run`
--    obowiązkowe i kompletne, `data_subject_request_id` NULL, brak polityk w
--    `retention_policy_ids`. Dotychczasowe wiersze spełniają nowe reguły
--    (`source_run` = NULL, kody bez zmian).
--
-- Skutki dla danych: żaden istniejący wiersz nie jest zmieniany (ADD COLUMN bez
-- wartości domyślnej nie przepisuje tabeli, triggery tabeli nie są wołane). Nowe
-- wiersze powstają dopiero z przebiegów skryptu po odtworzeniu kopii; skrypt
-- zmienia dane osobowe tak samo jak przebieg z trasy (te same funkcje, ta sama
-- furtka `rd.anonymization_run`) i nigdy kwot, dat ani księgi. Tabela nadal jest
-- tylko do dopisywania (UPDATE/DELETE/TRUNCATE odrzucane).
--
-- Wycofanie: na bazie bez wierszy `restore_reapply` — DROP CONSTRAINT
-- `anonymization_runs_reason_shape` i `anonymization_runs_reason_code_check`,
-- DROP COLUMN `source_run`, przywrócenie obu CHECK-ów z 0174. Z wierszami
-- `restore_reapply` — tylko po kopii zapasowej (tabela jest jedynym dowodem, co
-- zanonimizowano po odtworzeniu).

ALTER TABLE anonymization_runs DROP CONSTRAINT anonymization_runs_reason_shape;
ALTER TABLE anonymization_runs DROP CONSTRAINT anonymization_runs_reason_code_check;

ALTER TABLE anonymization_runs ADD COLUMN source_run JSONB;

ALTER TABLE anonymization_runs ADD CONSTRAINT anonymization_runs_reason_code_check
  CHECK (reason_code IN ('retention_policy', 'data_subject_request', 'restore_reapply'));

ALTER TABLE anonymization_runs ADD CONSTRAINT anonymization_runs_reason_shape CHECK (
  CASE reason_code
    WHEN 'restore_reapply' THEN
      data_subject_request_id IS NULL
      AND cardinality(retention_policy_ids) = 0
      AND source_run IS NOT NULL
      AND jsonb_typeof(source_run) = 'object'
      AND source_run ?& ARRAY['reasonCode', 'planSha256', 'executedAt', 'executedBy']
      AND source_run->>'reasonCode' IN ('retention_policy', 'data_subject_request')
      AND source_run->>'planSha256' ~ '^[0-9a-f]{64}$'
    ELSE
      source_run IS NULL
      AND (reason_code = 'data_subject_request') = (data_subject_request_id IS NOT NULL)
      AND (reason_code = 'retention_policy') = (cardinality(retention_policy_ids) > 0)
  END
);
