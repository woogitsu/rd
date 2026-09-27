-- Issue #157: jedna definicja "aktualnej" relacji opiekun-uczen.
--
-- Trzy miejsca (families.js, email.js, export.js) powielaly rownowazny, lecz
-- rozny warunek daty: raz z pominietym starts_on, raz z ends_on wlacznie
-- zamiast wylacznie, raz z CURRENT_DATE (strefa serwera) zamiast rd_today()
-- (Europe/Brussels, patrz 0023_student_primary_household.sql). Skutkiem byly
-- rozne zbiory opiekunow na karcie gospodarstwa, w migawce kampanii e-mail
-- i na liscie klasy przedstawiciela dla tych samych danych.
--
-- Ta migracja NIE zmienia zadnych danych, dodaje tylko funkcje i widok:
--   student_guardians_current_on(as_of date) -- relacje obowiazujace w dniu as_of
--   student_guardians_current                -- = student_guardians_current_on(rd_today())
--
-- Semantyka przedzialu jest ta sama co w 0014_households.sql i DATA_MODEL.md:
-- [starts_on, ends_on) -- starts_on wlacznie, ends_on WYLACZNIE. NULL starts_on
-- = od poczatku ewidencji, NULL ends_on = relacja nadal trwa.
--
-- Skutek dla istniejacych odczytow po podmianie w kodzie aplikacji: relacja
-- z ends_on = dzis przestaje byc liczona w kampaniach e-mail i na liscie klasy
-- o jeden dzien wczesniej niz dotychczas (byla tam liczona do ends_on wlacznie);
-- karta gospodarstwa juz stosowala wariant wylaczny, wiec dla niej zmiany nie ma.

CREATE FUNCTION student_guardians_current_on(as_of DATE)
RETURNS SETOF student_guardians
LANGUAGE sql STABLE AS $$
  SELECT * FROM student_guardians
   WHERE (starts_on IS NULL OR starts_on <= as_of)
     AND (ends_on IS NULL OR ends_on > as_of);
$$;

CREATE VIEW student_guardians_current AS
SELECT * FROM student_guardians_current_on(rd_today());

COMMENT ON VIEW student_guardians_current IS
  'Jedyne zrodlo prawdy dla "aktualnej" relacji opiekun-uczen (issue #157). '
  'Uzywaj zamiast wlasnych warunkow na student_guardians.starts_on/ends_on.';
