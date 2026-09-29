# Prywatność i bezpieczeństwo

System będzie przechowywał dane dzieci i opiekunów oraz informacje o wpłatach. Przed rozpoczęciem importu dyrekcja i IOD powinni uzgodnić administratora danych, podstawę i cele przetwarzania, zakres udostępnienia Radzie, role dostawców, informację dla rodziców, okresy retencji i procedurę incydentową. Polski status szkoły nie wyłącza RODO.

## Minimalizacja
Imię i nazwisko ucznia, klasa/rok, powiązanie z opiekunem, niezbędny e-mail i historia wpłat. Adres zamieszkania, PESEL, dane zdrowotne i oceny nie są potrzebne w tym produkcie. Unikać danych osobowych w URL, tytułach plików i logach.

Pełny techniczny spis, które kolumny schematu zawierają dane osobowe, czyje i w jakim celu, jest wygenerowany w [`docs/PRIVACY_INVENTORY.md`](PRIVACY_INVENTORY.md) ze `privacy/data-inventory.json` (test CI `tests/privacy-inventory.test.js` odrzuca nową kolumnę bez wpisu). Lista dostawców danych i lokalizacji jest w [`docs/PROCESSORS.md`](PROCESSORS.md), a lista kontrolna do DPIA w [`docs/DPIA_CHECKLIST.md`](DPIA_CHECKLIST.md). Żaden z tych dokumentów nie jest rejestrem czynności ani oceną DPIA — to materiał dla administratora danych (D-01).

## Dostęp
Zaproszenia, silne sesje, MFA dla finansów, najmniejsze uprawnienia, zakres klasy sprawdzany po stronie serwera, natychmiastowe wycofanie konta po kadencji. Odczyt dowodów finansowych i eksport też wymagają rejestracji w dzienniku. Oddzielić dostęp techniczny od roli skarbnika.

Fundament walidacji sesji opisuje [AUTH.md](AUTH.md). W bazie przechowujemy wyłącznie skrót sekretu sesji; sam sekret pozostaje w bezpiecznym cookie przeglądarki.

### Dziennik odczytu danych dzieci i opiekunów (#133)
Tabela `data_access_log` (migracje 0067 i 0140, tylko dopisywanie) rejestruje: aktora, czas, rodzaj zasobu (`access_kind`), identyfikatory zakresu (rok, klasa, gospodarstwo), wynik (`ok`/`not_found`) i liczbę rekordów — **bez imion, nazwisk, e-maili, parametrów zapytania i adresów IP** (IP: decyzja administratora, D-01). Wpis dostają: lista klasy, karta gospodarstwa, kartki do druku, lista wpłat, eksport CSV wpłat, eksport listy klasy i eksport roczny. Rejestr tych tras to `DATA_ACCESS_ROUTES` (`src/pg/data-access.js`); meta-test `tests/pg-data-access-coverage.test.js` sprawdza, że każda trasa z rejestru zapisuje wpis, a nowy plik tras czytający tabele rodzin bez wpisu w rejestrze lub uzasadnionego wyjątku wywraca test.

Gwarancja zapisu (wariant zachowawczy do D-04/D-07/D-08):
- **eksporty** (lista klasy, roczny, CSV wpłat): wpis powstaje w tej samej transakcji co eksport; gdy zapis się nie uda, eksport jest wycofany i plik nie jest wydawany;
- **listy i karty** (odczyt interaktywny): zapis jest wykonywany przed wysłaniem odpowiedzi, ale jego awaria nie blokuje odczytu — w logu serwera zostaje zdarzenie `access_log_failed` bez danych. Zmiana na „nie wydawaj danych bez wpisu” wymaga decyzji zarządu.

Przeglądanie: `GET /api/admin/access-log` (tylko odczyt, filtry, kursor, bez danych osobowych) — wyłącznie admin z MFA; zarząd, skarbnik, Komisja Rewizyjna, dyrekcja i przedstawiciele dostają 403 do czasu D-08/D-09. Aktor jest pokazywany jako identyfikator konta i bieżące role, bez e-maila i nazwy. Samo przeglądanie zapisuje zdarzenie audytu `access_log.viewed` (bez parametrów).

Retencja: kategoria nieustalona (D-04) — wiersze nie są usuwane ani anonimizowane, trigger blokuje `DELETE` i zmianę pól poza licznikiem odświeżeń. Dziennik sam jest zbiorem danych o członkach Rady, więc jego okres przechowywania i informacja dla przedstawicieli klas (rejestrowanie odczytów jako środek bezpieczeństwa, nie ocena pracy wolontariuszy) czekają na decyzję zarządu. Nie zrealizowano jeszcze: raportu „dostęp do danych rodziny” w eksporcie wniosku osoby (#100, zależy od D-07) i punktu listy kontrolnej zamknięcia roku.

## Operacje
Szyfrowanie transmisji, prywatne zasoby, kopie i test odtworzenia, ograniczenie prób logowania, skan plików, monitoring i rotacja sekretów. Stosować okres przechowywania uzgodniony z administratorem danych i udokumentowany proces sprostowania lub usunięcia. Dokumenty szkolne archiwizować zgodnie z regulaminem i decyzją szkoły.

## Trasy publiczne zwolnione z kontroli Origin
`POST /api/email/webhooks/brevo` (wspólny sekret) oraz `GET`/`POST /api/email/preferences?t=…` (wypisanie jednym kliknięciem, #110) nie wymagają zgodnego nagłówka `Origin` — pierwsza, bo wywołuje ją dostawca poczty, druga, bo klika ją klient poczty rodzica, nie przeglądarka z otwartą sesją aplikacji. Bezpieczeństwo trasy preferencji opiera się na tokenie podpisanym HMAC (bez adresu ani czytelnych identyfikatorów w URL), braku skutku dla `GET` i prostym limicie żądań. Ryzyko: enumeracja i CSRF na trasie publicznej — ograniczone przez podpis tokenu, brak stanu po stronie `GET` i limit żądań (patrz `docs/EMAIL.md`, ograniczenia prototypu).

## Zdjęcia
Przed publikacją każdej fotografii zidentyfikować autora, źródło i prawo do wykorzystania. Przy rozpoznawalnych dzieciach zweryfikować zakres zgód i szkolne zasady publikowania wizerunku. Fotografia znaleziono na oficjalnej stronie szkoły nie oznacza automatycznie prawa do skopiowania jej do nowego serwisu.
