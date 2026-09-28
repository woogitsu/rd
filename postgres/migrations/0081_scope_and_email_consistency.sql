-- Ograniczenia spójności schematu (#198), część 1: klasa z innego roku
-- w role_grants/invitations/export_runs oraz konta różniące się tylko
-- wielkością liter e-maila.
--
-- Poza zakresem tej migracji (świadomie): news_photos.document_id (#198,
-- punkt 5). Dodanie FK do documents wymaga rodzaju dokumentu przeznaczonego
-- dla galerii (documents_api_row dopuszcza dziś tylko 'financial', 'board',
-- 'class') i zmiany src/pg/news.js + wszystkich fixture'ów testowych, które
-- dziś wpisują document_id bez odpowiadającego wiersza w documents. To
-- decyzja i zakres #96 (moduł dokumentów galerii); zostawiamy osobnej migracji
-- i osobnemu PR, żeby nie mieszać dwóch niezależnych zakresów w jednym PR.
--
-- Skutki dla danych:
-- * role_grants, invitations, export_runs: nowe złożone FK (class_id,
--   school_year_id) -> classes(id, school_year_id), NOT VALID. Dla
--   invitations i export_runs VALIDATE od razu (baza jest dziś pusta poza
--   danymi syntetycznymi/testowymi — patrz scripts/check-schema-consistency.mjs).
--   Dla role_grants ŚWIADOMIE bez natychmiastowego VALIDATE: reguła „albo”
--   z #201/0022 (role_grant_in_school_year) pozwala, żeby przydział klasy
--   miał school_year_id inny niż rok tej klasy, gdy wiersz powstał poza API
--   (import D1, ręczna poprawka SQL) — patrz komentarz w 0022 i scenariusz
--   w tests/pg-year-close-class-grants.test.js (g-mismatch). Natychmiastowe
--   VALIDATE odrzuciłoby taki, świadomie tolerowany, historyczny wiersz przy
--   wdrożeniu tej migracji. NOT VALID i tak pilnuje każdego NOWEGO zapisu
--   (INSERT lub UPDATE zmieniającej class_id/school_year_id) od razu — cel
--   #198 (odrzucić niespójność przy zapisie zamiast cicho ją zapisać) jest
--   spełniony dla przyszłych zapisów; tylko istniejące wiersze nie są
--   skanowane. Administrator może później zweryfikować dane i odpalić
--   ręcznie `ALTER TABLE role_grants VALIDATE CONSTRAINT
--   role_grants_class_in_year;` po uporządkowaniu historycznych wpisów
--   (decyzja poza zakresem tej migracji). role_grants ma już od #201/0022
--   trigger role_grant_year_freeze, który świeżo wstawiany wiersz bez roku
--   uzupełnia rokiem klasy (i odrzuca jawną niezgodność); FK jest dodatkową,
--   niezależną gwarancją dla zapisów spoza API/triggera (np. bezpośredni
--   SQL) — patrz uwaga w tests/pg-schema-consistency.test.js.
-- * invitations: dodatkowo CHECK invitation_class_requires_year, analogiczny
--   do role_grant_class_requires_year (0022) — zaproszenie z klasą musi mieć
--   rok. createInvitation (src/pg/auth.js) zawsze ustawia oba pola razem, więc
--   istniejące wiersze spełniają warunek.
-- * users.email: nowy unikalny indeks po lower(btrim(email)) i CHECK
--   wymuszający, że e-mail jest już zapisany w tej postaci. Aplikacja
--   (src/pg/login.js normalizeLoginEmail, src/pg/bootstrap-admin.js
--   normalizeEmail) zawsze normalizuje przed zapisem — CHECK tylko zamyka
--   furtkę na zapis poza API (import D1: src/d1-postgres-migration.js kopiuje
--   e-maile 1:1, patrz #198 tabela punkt 4). Jeżeli w bazie docelowej istnieją
--   już dwa konta różniące się wielkością liter, CREATE UNIQUE INDEX
--   CONCURRENTLY nie zadziała i migracja musi się zatrzymać — administrator
--   rozstrzyga duplikat (wyłączenie jednego konta, przeniesienie przydziałów
--   nowymi wierszami — 0004 nie pozwala zmienić user_id) PRZED ponowieniem tej
--   migracji. invitations.email dostaje ten sam CHECK (createInvitation
--   normalizuje tak samo).
--
-- Wycofanie na pustej/testowej bazie: usunięcie wszystkich obiektów poniżej.
-- Na bazie z danymi: bezpieczne, żaden wiersz nie jest zmieniany ani usuwany.

-- Bez VALIDATE tutaj (patrz komentarz wyżej): pilnuje każdego nowego zapisu
-- od razu, ale toleruje istniejące, świadomie niespójne wiersze sprzed tej
-- migracji (reguła „albo” z #201/0022).
ALTER TABLE role_grants
  ADD CONSTRAINT role_grants_class_in_year
    FOREIGN KEY (class_id, school_year_id) REFERENCES classes(id, school_year_id) NOT VALID;

ALTER TABLE invitations
  ADD CONSTRAINT invitations_class_in_year
    FOREIGN KEY (class_id, school_year_id) REFERENCES classes(id, school_year_id) NOT VALID,
  ADD CONSTRAINT invitation_class_requires_year
    CHECK (class_id IS NULL OR school_year_id IS NOT NULL) NOT VALID;
ALTER TABLE invitations VALIDATE CONSTRAINT invitations_class_in_year;
ALTER TABLE invitations VALIDATE CONSTRAINT invitation_class_requires_year;

ALTER TABLE export_runs
  ADD CONSTRAINT export_runs_class_in_year
    FOREIGN KEY (class_id, school_year_id) REFERENCES classes(id, school_year_id) NOT VALID;
ALTER TABLE export_runs VALIDATE CONSTRAINT export_runs_class_in_year;

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(btrim(email)));

ALTER TABLE users
  ADD CONSTRAINT users_email_lower_form CHECK (email = lower(btrim(email))) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_email_lower_form;

ALTER TABLE invitations
  ADD CONSTRAINT invitations_email_lower_form CHECK (email = lower(btrim(email))) NOT VALID;
ALTER TABLE invitations VALIDATE CONSTRAINT invitations_email_lower_form;
