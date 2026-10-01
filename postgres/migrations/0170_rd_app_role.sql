-- SR-05 (audyt bezpieczeństwa, #101): osobna rola aplikacji `rd_app`.
--
-- Cel: aplikacja (serwer HTTP, scripts/email-worker.js) łączy się rolą, która
-- NIE jest właścicielem tabel, więc nie może: TRUNCATE, DDL (CREATE/ALTER/DROP),
-- ALTER TABLE … DISABLE TRIGGER, SET session_replication_role = replica ani
-- DELETE na tabelach z historią. Triggery niezmienności (0002–0009, 0095,
-- 0144 itd.) przestają być jedyną barierą — resztę zamyka brak uprawnień.
-- Migracje i odtworzenie z paczki wykonuje rola właściciela (`rd_owner` albo
-- domyślny użytkownik Railway) przez DATABASE_MIGRATION_URL
-- (scripts/migrate-postgres.js; docs/RAILWAY_OPERATIONS.md).
--
-- Nazwa roli jest stała: `rd_app`. Rola jest tworzona jako NOLOGIN, bez hasła
-- i bez żadnego sekretu w repozytorium. Operator nadaje logowanie i hasło
-- poza repozytorium (ALTER ROLE rd_app LOGIN PASSWORD '…', patrz
-- docs/RAILWAY_OPERATIONS.md) i dopiero wtedy przełącza DATABASE_URL aplikacji.
--
-- Warunkowość: rola jest tworzona tylko wtedy, gdy nie istnieje i bieżący
-- użytkownik migracji ma SUPERUSER albo CREATEROLE. W przeciwnym razie krok
-- jest pomijany z komunikatem NOTICE (np. zarządzana baza bez CREATEROLE —
-- wtedy operator tworzy rolę ręcznie i ponawia GRANT-y z tej migracji).
-- PGlite (testy) obsługuje role, więc migracja przechodzi tam bez zmian.
--
-- Uprawnienia roli `rd_app` (wszystko w schemacie public):
--   * USAGE na schemacie; brak CREATE (zabrane także PUBLIC);
--   * SELECT, INSERT, UPDATE na istniejących tabelach. UPDATE jest nadane
--     szeroko celowo: wiele tras używa SELECT … FOR UPDATE i LOCK TABLE, które
--     w PostgreSQL wymagają UPDATE, a niezmienność historii pilnują triggery
--     (nadpisanie wpłaty nadal kończy się błędem triggera);
--   * DELETE wyłącznie na tabelach technicznych/roboczych, na których kod
--     aplikacji legalnie kasuje wiersze (sprawdzone w src/ i scripts/):
--     login_rate_limits, mfa_rate_limits (retencja liczników prób) oraz
--     email_campaign_recipients, email_campaign_exclusions (przeliczenie
--     odbiorców KONCEPTU kampanii, src/pg/routes/email.js);
--   * brak TRUNCATE, REFERENCES, TRIGGER;
--   * schema_migrations: tylko SELECT (migrator pisze rolą właściciela);
--   * USAGE, SELECT na sekwencjach; EXECUTE na funkcjach;
--   * ALTER DEFAULT PRIVILEGES: przyszłe tabele/sekwencje/funkcje tworzone przez
--     rolę uruchamiającą migracje dostają te same uprawnienia (bez DELETE).
--     Nowa tabela, na której aplikacja ma kasować wiersze, wymaga jawnego
--     GRANT DELETE w jej migracji ORAZ wpisu na liście w
--     tests/pg-real-app-role.test.js (meta-test wykrywa rozjazd).
--
-- Skutki dla istniejących danych: żaden wiersz nie jest zmieniany ani usuwany.
-- Zmieniają się wyłącznie uprawnienia (nowa rola; REVOKE CREATE ON SCHEMA
-- public FROM PUBLIC — na PostgreSQL 15+ to już wartość domyślna). Dotychczasowy
-- użytkownik/właściciel działa bez zmian, dopóki operator nie przełączy
-- DATABASE_URL na rd_app.
--
-- Ograniczenia (zostają otwarte, SECURITY_REVIEW.md SR-05): rola z UPDATE może
-- zmieniać wiersze tabel bez triggera niezmienności; tryb odtworzenia
-- `SET LOCAL rd.restore = 'on'` to zwykły parametr sesji i nie da się go
-- ograniczyć uprawnieniami; rola nadal ma domyślne prawo TEMPORARY (PUBLIC).
-- Odtworzenie paczki (`session_replication_role`) wymaga roli właściciela.
--
-- Wycofanie: REASSIGN/DROP OWNED nie jest potrzebne — wystarczy
-- REVOKE ALL ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public FROM rd_app;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES/SEQUENCES/FUNCTIONS FROM rd_app;
-- REVOKE USAGE ON SCHEMA public FROM rd_app; DROP ROLE rd_app;

DO $$
DECLARE
  app_role CONSTANT text := 'rd_app';
  can_create boolean;
  delete_tables CONSTANT text[] := ARRAY[
    'login_rate_limits', 'mfa_rate_limits',
    'email_campaign_recipients', 'email_campaign_exclusions'
  ];
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    SELECT rolsuper OR rolcreaterole INTO can_create FROM pg_roles WHERE rolname = current_user;
    IF NOT COALESCE(can_create, false) THEN
      RAISE NOTICE 'rd_app: pominięto — rola nie istnieje, a użytkownik migracji nie ma CREATEROLE/SUPERUSER. Utwórz rolę ręcznie (CREATE ROLE rd_app NOLOGIN) i powtórz GRANT-y z migracji 0170.';
      RETURN;
    END IF;
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', app_role);
  END IF;

  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', app_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);

  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO %I', app_role);
  EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM %I', app_role);
  -- Tabela dziennika migracji powstaje w migratorze (src/postgres-migrations.js),
  -- nie w plikach SQL; przy nakładaniu plików bez migratora (testy) jej nie ma.
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE ON TABLE public.schema_migrations FROM %I', app_role);
  END IF;
  FOREACH t IN ARRAY delete_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('GRANT DELETE ON TABLE public.%I TO %I', t, app_role);
    END IF;
  END LOOP;

  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', app_role);

  -- Obiekty tworzone w przyszłości przez rolę uruchamiającą migracje.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO %I', app_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', app_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', app_role);
END
$$;
