-- Issue #157: jedna definicja "aktualnej" relacji opiekun-uczen.
--
-- Trzy miejsca (families.js, email.js, export.js) powielaly rownowazny, lecz
-- rozny warunek daty: raz z pominietym starts_on, raz z ends_on wlacznie,
-- raz wylacznie, raz z CURRENT_DATE (strefa serwera) zamiast rd_today()
-- (Europe/Brussels, patrz 0023_student_primary_household.sql). Skutkiem byly
-- rozne zbiory opiekunow na karcie gospodarstwa, w migawce kampanii e-mail
-- i na liscie klasy przedstawiciela dla tych samych danych.
--
-- Ta migracja NIE zmienia zadnych danych, dodaje tylko funkcje i widok:
--   student_guardians_current_on(as_of date) -- relacje obowiazujace w dniu as_of
--   student_guardians_current                -- = student_guardians_current_on(rd_today())
--
-- Semantyka przedzialu dla student_guardians to [starts_on, ends_on] --
-- OBA konce WLACZNIE (starts_on od poczatku tego dnia, ends_on do konca tego
-- dnia; dzien PO ends_on relacja juz nie obowiazuje). To NIE jest ta sama
-- semantyka co [starts_on, ends_on) w 0014_households.sql (student_households/
-- guardian_households) -- te dwie tabele maja odrebne, ustalone juz wczesniej
-- konwencje i nie ujednolicamy ich w tej migracji. Dowod na semantyke wlaczna
-- dla student_guardians: tests/pg-primary-household.test.js (#194) zaklada
-- relacje z opiekunem starej rodziny z ends_on = D-1 i sprawdza, ze migawka
-- kampanii w dniu D-1 nadal go obejmuje (endsOn wlacznie) -- dokladnie
-- zachowanie, ktore mialy juz email.js/export.js PRZED ta migracja
-- (ends_on >= CURRENT_DATE); to family.js/RELATION_ACTIVE mialo wtedy inny,
-- wylaczny warunek (ends_on > CURRENT_DATE) -- ale zaden test karty
-- gospodarstwa nie sprawdzal dnia granicznego, wiec ujednolicenie do WLACZNEJ
-- semantyki (zgodnej z #194) nie psuje istniejacych testow.
--
-- Skutek dla istniejacych odczytow po podmianie w kodzie aplikacji: brak
-- zmiany dla email.js/export.js (juz liczyly ends_on wlacznie); karta
-- gospodarstwa (families.js) zaczyna liczyc ends_on wlacznie zamiast
-- wylacznie -- przesuniecie widocznosci o jeden dzien w date graniczna,
-- bez regresji w istniejacych testach (patrz wyzej).

CREATE FUNCTION student_guardians_current_on(as_of DATE)
RETURNS SETOF student_guardians
LANGUAGE sql STABLE AS $$
  SELECT * FROM student_guardians
   WHERE (starts_on IS NULL OR starts_on <= as_of)
     AND (ends_on IS NULL OR ends_on >= as_of);
$$;

CREATE VIEW student_guardians_current AS
SELECT * FROM student_guardians_current_on(rd_today());

COMMENT ON VIEW student_guardians_current IS
  'Jedyne zrodlo prawdy dla "aktualnej" relacji opiekun-uczen (issue #157). '
  'Uzywaj zamiast wlasnych warunkow na student_guardians.starts_on/ends_on.';

-- Osobna, wazka funkcja: czy relacja JUZ SIE ZAKONCZYLA (dzien po ends_on juz
-- minal), w odroznieniu od "jeszcze nieaktywnej" (starts_on w przyszlosci) --
-- families.js rozroznia te dwa przypadki (komunikat relation_ended vs. brak
-- wiersza w zakresie). Nie zastepuje widoku powyzej; pozwala nie powtarzac
-- warunku na ends_on w kodzie aplikacji.
CREATE FUNCTION student_guardian_relation_ended(p_guardian_id TEXT, p_student_id TEXT, as_of DATE DEFAULT rd_today())
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM student_guardians
     WHERE guardian_id = p_guardian_id AND student_id = p_student_id
       AND ends_on IS NOT NULL AND ends_on < as_of
  );
$$;
