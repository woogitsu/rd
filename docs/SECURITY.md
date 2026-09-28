# Prywatność i bezpieczeństwo

System będzie przechowywał dane dzieci i opiekunów oraz informacje o wpłatach. Przed rozpoczęciem importu dyrekcja i IOD powinni uzgodnić administratora danych, podstawę i cele przetwarzania, zakres udostępnienia Radzie, role dostawców, informację dla rodziców, okresy retencji i procedurę incydentową. Polski status szkoły nie wyłącza RODO.

## Minimalizacja
Imię i nazwisko ucznia, klasa/rok, powiązanie z opiekunem, niezbędny e-mail i historia wpłat. Adres zamieszkania, PESEL, dane zdrowotne i oceny nie są potrzebne w tym produkcie. Unikać danych osobowych w URL, tytułach plików i logach.

Pełny techniczny spis, które kolumny schematu zawierają dane osobowe, czyje i w jakim celu, jest wygenerowany w [`docs/PRIVACY_INVENTORY.md`](PRIVACY_INVENTORY.md) ze `privacy/data-inventory.json` (test CI `tests/privacy-inventory.test.js` odrzuca nową kolumnę bez wpisu). Lista dostawców danych i lokalizacji jest w [`docs/PROCESSORS.md`](PROCESSORS.md), a lista kontrolna do DPIA w [`docs/DPIA_CHECKLIST.md`](DPIA_CHECKLIST.md). Żaden z tych dokumentów nie jest rejestrem czynności ani oceną DPIA — to materiał dla administratora danych (D-01).

## Dostęp
Zaproszenia, silne sesje, MFA dla finansów, najmniejsze uprawnienia, zakres klasy sprawdzany po stronie serwera, natychmiastowe wycofanie konta po kadencji. Odczyt dowodów finansowych i eksport też wymagają rejestracji w dzienniku. Oddzielić dostęp techniczny od roli skarbnika.

Fundament walidacji sesji opisuje [AUTH.md](AUTH.md). W bazie przechowujemy wyłącznie skrót sekretu sesji; sam sekret pozostaje w bezpiecznym cookie przeglądarki.

## Operacje
Szyfrowanie transmisji, prywatne zasoby, kopie i test odtworzenia, ograniczenie prób logowania, skan plików, monitoring i rotacja sekretów. Stosować okres przechowywania uzgodniony z administratorem danych i udokumentowany proces sprostowania lub usunięcia. Dokumenty szkolne archiwizować zgodnie z regulaminem i decyzją szkoły.

## Trasy publiczne zwolnione z kontroli Origin
`POST /api/email/webhooks/brevo` (wspólny sekret) oraz `GET`/`POST /api/email/preferences?t=…` (wypisanie jednym kliknięciem, #110) nie wymagają zgodnego nagłówka `Origin` — pierwsza, bo wywołuje ją dostawca poczty, druga, bo klika ją klient poczty rodzica, nie przeglądarka z otwartą sesją aplikacji. Bezpieczeństwo trasy preferencji opiera się na tokenie podpisanym HMAC (bez adresu ani czytelnych identyfikatorów w URL), braku skutku dla `GET` i prostym limicie żądań. Ryzyko: enumeracja i CSRF na trasie publicznej — ograniczone przez podpis tokenu, brak stanu po stronie `GET` i limit żądań (patrz `docs/EMAIL.md`, ograniczenia prototypu).

## Zdjęcia
Przed publikacją każdej fotografii zidentyfikować autora, źródło i prawo do wykorzystania. Przy rozpoznawalnych dzieciach zweryfikować zakres zgód i szkolne zasady publikowania wizerunku. Fotografia znaleziono na oficjalnej stronie szkoły nie oznacza automatycznie prawa do skopiowania jej do nowego serwisu.
