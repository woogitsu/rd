-- Ograniczenia spójności schematu (#198), część 2: news_photos.document_id
-- oraz walidacja role_grants_class_in_year.
--
-- Zmiana:
-- * news_photos.document_id dostaje klucz obcy do documents(id) (punkt 5 issue;
--   0018 zostawiła go „do czasu modułu dokumentów", a documents istnieje od
--   0001/0006) oraz trigger news_photo_document_guard (INSERT i UPDATE
--   document_id): dokument musi istnieć i mieć rodzaj dozwolony dla galerii.
-- * role_grants_class_in_year (dodany w 0081 jako NOT VALID) jest walidowany.
--
-- WARIANT ZACHOWAWCZY (rodzaj dokumentu galerii to zakres #96 i decyzja
-- zarządu o dostępie/przechowywaniu, D-04/D-18): rodzaj 'gallery' NIE jest
-- tworzony. Dozwolony jest wyłącznie rodzaj 'board' — dokumenty zarządu są
-- dostępne dokładnie tym rolom, które rejestrują zdjęcia (admin, zarząd;
-- src/pg/routes/documents.js DOCUMENT_POLICIES, NEWS_POLICY.photoRegister).
-- Rodzaje 'financial' (skan faktury, wyciąg) i 'class' (materiały klasy) oraz
-- dokumenty spoza API (np. z odtworzenia D1, rodzaj 'receipt') są odrzucane.
-- Lista dozwolonych rodzajów jest w jednej funkcji
-- news_photo_document_kind_allowed(); wprowadzenie 'gallery' w #96 to
-- CREATE OR REPLACE tej funkcji, bez zmiany triggera. Plik zdjęcia publicznej
-- galerii jest serwowany z news_photo_files (0084) po photo_id, nie po
-- document_id — document_id pozostaje odwołaniem do dokumentu źródłowego.
--
-- Kontrola istniejących danych (każde zapytanie powinno zwrócić 0 wierszy;
-- migracja sama je wykonuje i ZATRZYMUJE SIĘ z czytelnym błędem z
-- identyfikatorami wierszy, niczego nie naprawiając po cichu):
--   -- (a) przydziały klasy, których klasa nie należy do roku przydziału albo
--   --     bez roku (identyfikatory przydziałów, bez danych osobowych):
--   SELECT g.id FROM role_grants g
--    WHERE g.class_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM classes c
--                       WHERE c.id = g.class_id AND c.school_year_id = g.school_year_id);
--   -- (b) zdjęcia wskazujące nieistniejący dokument:
--   SELECT p.id FROM news_photos p
--    WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = p.document_id);
--   -- (c) zdjęcia wskazujące dokument niedozwolonego rodzaju:
--   SELECT p.id FROM news_photos p JOIN documents d ON d.id = p.document_id
--    WHERE d.kind <> 'board';
-- To samo, jako liczby bez identyfikatorów, wypisuje
-- scripts/check-schema-consistency.mjs (reguły role_grants_* i news_photos_*).
--
-- Skutki dla danych: żaden wiersz nie jest zmieniany ani usuwany. Po błędzie
-- migracji administrator rozstrzyga każdy wiersz jawnie i ponawia migrację.
-- Zdjęcia (b)/(c): są niezmienne (0018) — zdjęcie z błędnym odwołaniem zostaje
-- cofnięte (revoked, nigdy niepubliczne) i zarejestrowane ponownie z
-- właściwym dokumentem; ale wiersz nadal wskazuje zły dokument, więc FK i tak
-- go nie przyjmie — korekta odwołania wymaga tej samej procedury właściciela
-- bazy co poniżej (UPDATE document_id z wyłączonym triggerem
-- news_photos_before_update, na czas jednej instrukcji, i zdarzeniem audytu).
-- Przydziały (a): 0022 CELOWO zostawia wiersze z rokiem różnym od roku klasy
-- (możliwe tylko przy wpisach poza API), więc na prawdziwej bazie mogą istnieć.
-- Przydziały są niezmienne i nieusuwalne (0004), a VALIDATE sprawdza także
-- przydziały cofnięte i wygasłe, więc samo wygaszenie starego przydziału i
-- dodanie nowego NIE usuwa naruszenia (chroni dostęp, nie migrację). Procedura
-- (administrator, właściciel bazy, okno serwisowe, jedna transakcja, wzorem
-- 0022): wyłączyć `role_grants_guard` na czas jednej instrukcji, ustawić
-- school_year_id przydziału na rok jego klasy, włączyć trigger i dopisać
-- zdarzenie audytu, np.:
--   BEGIN;
--   ALTER TABLE role_grants DISABLE TRIGGER role_grants_guard;
--   WITH fixed AS (
--     UPDATE role_grants g SET school_year_id = c.school_year_id
--       FROM classes c WHERE c.id = g.class_id AND g.id = '<id przydziału>'
--       RETURNING g.id, g.class_id, c.school_year_id)
--   INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, metadata_json)
--   SELECT gen_random_uuid()::text, '<id administratora>', 'role_grant.school_year_corrected',
--          'role_grant', id, jsonb_build_object('classId', class_id, 'schoolYearId', school_year_id,
--          'previousSchoolYearId', '<dotychczasowy rok>') FROM fixed;
--   ALTER TABLE role_grants ENABLE TRIGGER role_grants_guard;
--   COMMIT;
-- Decyzję, czy właściwy jest rok klasy, czy inny przydział, podejmuje
-- administrator (zmiana zakresu dostępu). Migracja jest w jednej transakcji,
-- więc przy błędzie nic nie zostaje zastosowane.
-- Tabele są małe (kilkaset wierszy), ale ograniczenia mimo to dodawane są
-- NOT VALID + VALIDATE CONSTRAINT po kontroli, żeby VALIDATE nie utrzymywało
-- blokady ACCESS EXCLUSIVE dłużej niż zapis metadanych.
--
-- Wycofanie: DROP TRIGGER news_photo_document_guard ON news_photos; DROP
-- FUNCTION news_photo_document_guard(); DROP FUNCTION
-- news_photo_document_kind_allowed(TEXT); ALTER TABLE news_photos DROP
-- CONSTRAINT news_photos_document_fk. Walidacji role_grants nie trzeba cofać.

-- (a) role_grants: kontrola, potem VALIDATE.
DO $$
DECLARE
  bad_ids TEXT;
  bad_count INTEGER;
BEGIN
  SELECT count(*), string_agg(id, ', ' ORDER BY id) FILTER (WHERE rn <= 20)
    INTO bad_count, bad_ids
    FROM (
      SELECT g.id, row_number() OVER (ORDER BY g.id) AS rn
        FROM role_grants g
       WHERE g.class_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM classes c
                          WHERE c.id = g.class_id AND c.school_year_id = g.school_year_id)
    ) violations;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'role_grants_class_out_of_year: % przydziałów klasy poza rokiem klasy lub bez roku (pierwsze: %); rozstrzygnij je ręcznie (patrz nagłówek 0143) i ponów migrację',
      bad_count, bad_ids;
  END IF;
END $$;
ALTER TABLE role_grants VALIDATE CONSTRAINT role_grants_class_in_year;

-- (b), (c) news_photos.document_id: kontrola istniejących wierszy.
CREATE FUNCTION news_photo_document_kind_allowed(p_kind TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  -- Wariant zachowawczy do czasu #96 (rodzaj 'gallery'): tylko dokumenty zarządu.
  SELECT p_kind = 'board'
$$;

DO $$
DECLARE
  bad_ids TEXT;
  bad_count INTEGER;
BEGIN
  SELECT count(*), string_agg(id, ', ' ORDER BY id) FILTER (WHERE rn <= 20)
    INTO bad_count, bad_ids
    FROM (
      SELECT p.id, row_number() OVER (ORDER BY p.id) AS rn
        FROM news_photos p
        LEFT JOIN documents d ON d.id = p.document_id
       WHERE d.id IS NULL
    ) violations;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'news_photo_document_not_found: % zdjęć wskazuje nieistniejący dokument (pierwsze: %); rozstrzygnij je ręcznie (patrz nagłówek 0143) i ponów migrację',
      bad_count, bad_ids;
  END IF;

  SELECT count(*), string_agg(id, ', ' ORDER BY id) FILTER (WHERE rn <= 20)
    INTO bad_count, bad_ids
    FROM (
      SELECT p.id, row_number() OVER (ORDER BY p.id) AS rn
        FROM news_photos p
        JOIN documents d ON d.id = p.document_id
       WHERE NOT news_photo_document_kind_allowed(d.kind)
    ) violations;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'news_photo_document_not_allowed: % zdjęć wskazuje dokument niedozwolonego rodzaju (pierwsze: %); rozstrzygnij je ręcznie (patrz nagłówek 0143) i ponów migrację',
      bad_count, bad_ids;
  END IF;
END $$;

ALTER TABLE news_photos
  ADD CONSTRAINT news_photos_document_fk
    FOREIGN KEY (document_id) REFERENCES documents(id) NOT VALID;
ALTER TABLE news_photos VALIDATE CONSTRAINT news_photos_document_fk;

CREATE FUNCTION news_photo_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc_kind TEXT;
BEGIN
  SELECT kind INTO doc_kind FROM documents WHERE id = NEW.document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'news_photo_document_not_found';
  END IF;
  IF NOT news_photo_document_kind_allowed(doc_kind) THEN
    RAISE EXCEPTION 'news_photo_document_not_allowed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER news_photos_document_guard
  BEFORE INSERT OR UPDATE OF document_id ON news_photos
  FOR EACH ROW EXECUTE FUNCTION news_photo_document_guard();
