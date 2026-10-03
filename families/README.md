# Katalog rodzin

Prototyp interfejsu do chronionego API rodzin na PostgreSQL (issue #5). Nie zawiera danych demonstracyjnych ani obejścia logowania. Nie używać na danych rodzin przed zamknięciem decyzji D-01–D-06, D-08 i D-09.

## Uruchomienie

```bash
npm run dev:families      # Vite, katalog families/
npm run build:families    # dist/families, serwowane przez src/node-app.js pod /families/
```

API i interfejs muszą działać pod tym samym originem: żądania używają ciasteczka sesji, a zapisy (PATCH/POST) są odrzucane bez zgodnego nagłówka `Origin`.

## Widoki

1. **Klasy** (`GET /api/classes`) — klasy z zakresu uprawnień, pogrupowane po roku szkolnym, z liczbą uczniów.
2. **Uczniowie klasy** (`GET /api/classes/{id}/students`) — uczniowie z listą gospodarstw (główne oznaczone). Admin i zarząd mogą zmienić klasę w tym samym roku (`POST /api/students/{id}/enrollments`, z datą i powodem).
3. **Karta gospodarstwa** (`GET /api/households/{id}`) — uczniowie gospodarstwa widoczni w zakresie, ich klasy i inne gospodarstwa (opieka dzielona), opiekunowie ze zgodą na kontakt. Admin i zarząd mogą zmienić e-mail i zgodę na kontakt (`PATCH /api/guardians/{id}/contact`, z powodem); zmiana trafia do historii i dziennika audytu.

   **Zakończenie opieki (#86, #535)** — admin i zarząd widzą na karcie przyciski „Zakończ naukę” (`POST /api/students/{id}/enrollments/{eid}/end`), „Zakończ członkostwo” ucznia (`POST /api/students/{id}/households/{mid}/end`), „Zakończ opiekę” (`POST /api/guardians/{id}/students/{studentId}/end`) i — tylko w zakresie szerokim — „Zakończ członkostwo” opiekuna (`POST /api/guardians/{id}/households/{mid}/end`). Formularz wymaga daty i powodu (3–500 znaków); przycisk jest blokowany na czas żądania, a ponowienie zwraca `changed: false` („zmiana była już zapisana”). Po zapisie panel pokazuje ostrzeżenia z odpowiedzi: `campaignsToReview` (kampanie do przeglądu), `withoutPrimaryHousehold`, `withoutHousehold`. Tekst powodu z możliwymi danymi osobowymi (422 `possible_personal_data`) wymaga potwierdzenia i jest ponawiany z `confirmPersonalData: true`; e-mail, IBAN i PESEL są odrzucane (`personal_data_forbidden`). Zamknięty rok szkolny daje 409. Identyfikatory zapisów (`membershipId`, `enrollmentId`) pochodzą z `GET /api/households/{id}`. Nie ma jeszcze formularza dodania członkostwa ucznia.

Role finansowe z potwierdzonym MFA widzą dodatkowo sumy wpłat netto na rok. Interfejs nie pokazuje należności ani statusu „dłużnik” — składka jest dobrowolna.

## Zakres ról (założenie do decyzji D-08/D-09)

- admin, zarząd, skarbnik — wszystkie klasy (lub klasy roku z przydziału),
- przedstawiciel klasy — wyłącznie przypisane klasy; rodzeństwo z innych klas jest pomijane, e-mail opiekuna tylko przy zgodzie na kontakt,
- Komisja Rewizyjna, dyrekcja — brak dostępu (403) do czasu decyzji D-09.

Przyciski edycji są ukrywane na podstawie `/api/access`, ale o dostępie decyduje wyłącznie serwer. Obiekt spoza zakresu i nieistniejący dają ten sam komunikat („Nie znaleziono lub brak dostępu”).

## Statystyki klas (pulpit zarządu, #131)

Widok `#/overview` (odnośnik „Statystyki klas” na liście klas dla admina/zarządu) czyta `GET /api/board/overview` i pokazuje wyłącznie liczności: uczniowie, gospodarstwa, przedstawiciele i zaproszenia, kontakt e-mail, „do kartki” oraz — tylko dla roli finansowej z MFA i zakresu szerokiego — odsetek gospodarstw z odnotowanym wpisem wpłaty. Odsetek opisuje ewidencję, nie zobowiązania (składka jest dobrowolna, lista może być nieaktualna); brak sortowania i kolorowania po odsetku, brak list rodzin. Zarząd z przydziałem klasowym widzi tylko swoje klasy, bez kolumny wpłat. Przyciski „Pobierz CSV” i „Pobierz XLSX” pobierają tę samą tabelę z `GET /api/board/overview/export.csv|xlsx?schoolYearId=` (moduły `src/pg/csv.js` i `src/pg/xlsx.js`); serwer stosuje te same uprawnienia, zakres i ograniczenia co widok (zarząd klasowy: tylko swoje klasy, bez kolumny wpłat; kolumna wpisów wpłat tylko dla roli finansowej z MFA; próg 5 gospodarstw), a plik zaczyna się rokiem i stałą notą o dobrowolności składki. Liczby są zapisane jako tekst (wspólne moduły eksportu nie mają typu liczbowego dla zliczeń). Każdy eksport zapisuje zdarzenie `board.overview.exported`.

## Wnioski opiekunów o zmianę kontaktu (#140)

Widok `#/guardian-updates` (odnośnik „Wnioski opiekunów” na liście klas dla admina/zarządu; moduły `guardian-updates-core.js` i `guardian-updates.js`) czyta `GET /api/admin/guardian-update-requests` i wykonuje `POST …/{id}/approve|reject`. Umieszczony w panelu Rodziny, bo trasy obsługują admina i zarząd bez przydziału klasowego (SR-01), a panel administracji `admin/` jest tylko dla roli admin. Przedstawiciel klasy i zarząd z przydziałem klasy dostają z serwera 403 (komunikat w widoku); ukryty odnośnik jest tylko podpowiedzią.

- Filtr statusu (oczekujące / zatwierdzone / odrzucone) i „Pokaż więcej” z kursorem `nextCursor` (strony po 50, bez duplikatów); decyzje tylko dla oczekujących.
- Kolumna „Proponowana zmiana” pokazuje wyłącznie to, co zwraca API: proponowany e-mail (albo usunięcie adresu), zgodę na kontakt, uwagę opiekuna i ostrzeżenie, gdy adres jest na liście wyłączeń (#94; zatwierdzenie nie zdejmuje blokady). Obecnych wartości kontaktu API nie zwraca, więc nie ma pełnej różnicy „stary → nowy”; do porównania służy karta gospodarstwa.
- „Zatwierdź” i „Odrzuć” w oknie z opisem skutku; przycisk blokowany na czas żądania, jedno żądanie na wniosek naraz, a serwer jest idempotentny (ponowna decyzja zwraca aktualny stan).
- Trasy decyzji nie przyjmują treści: brak powodu odrzucenia i brak potwierdzenia bramki danych osobowych (`possible_personal_data` dotyczy uwagi w publicznym formularzu, nie decyzji).
- Bez wydawania linków (`POST /api/admin/guardian-links`): panel nie wydaje tokenów ani ich nie wysyła; rodzic otwiera publiczną stronę `/kontakt/#token=…` ([kontakt/README.md](../kontakt/README.md)), a zarząd przekazuje link poza systemem.
- Weryfikacja nowego adresu kodem (#140 pkt 5, migracja 0184): przy proponowanym nowym e-mailu wiersz pokazuje „Weryfikacja adresu: …” — stan z API (`verification`: nie wysłano kodu / kod wysłany / adres potwierdzony / kod wygasł / wysyłka lub potwierdzenie nieudane) i powód (np. brak zatwierdzonego szablonu, adres na liście wyłączeń, wyczerpany limit prób). Niepotwierdzony adres jest wyróżniony, a okno „Zatwierdzić wniosek?” ostrzega, że zatwierdzenie bez potwierdzenia trafi do dziennika zdarzeń (serwer zapisuje `unverifiedContactChange`). Szablon wiadomości z kodem ma osobny widok (niżej, „Szablon kodu weryfikacyjnego”); rodzic wpisuje kod na publicznej stronie `/kontakt/` ([docs/EMAIL.md](../docs/EMAIL.md)).

## Szablon wiadomości z kodem weryfikacyjnym (#140 pkt 5)

Widok `#/guardian-verify-templates` (odnośnik „Szablon kodu weryfikacyjnego” na liście klas i w widoku wniosków; moduły `guardian-verify-templates-core.js` i `guardian-verify-templates.js`) czyta `GET /api/admin/guardian-verify-templates`, tworzy szkic `POST` i zatwierdza `POST …/{id}/approve` z `contentHash` wersji widzianej w oknie. Jest w panelu Rodziny z tych samych powodów co kolejka wniosków (SR-01); ten ekran niczego nie wysyła do rodziców.

- Tabela wersji: numer, stan (szkic / zatwierdzony, „obowiązuje” przy najnowszej zatwierdzonej), temat z rozwijaną treścią, autor (skrócony identyfikator), daty, zatwierdzający, początek skrótu treści. Zdanie nad tabelą mówi, czy jest obowiązująca wersja i czy serwer w ogóle wysyła kody (`enabled` = flaga `GUARDIAN_VERIFY_EMAIL_ENABLED`; przy wyłączonej flaga żaden kod nie wyjdzie, także po zatwierdzeniu).
- Nowy szkic: temat (bez `{kod}`, bez nawiasów klamrowych) i treść (obowiązkowe `{kod}`, opcjonalne `{waznosc}` = liczba godzin). Walidacja w przeglądarce jest tylko podpowiedzią; serwer zwraca te same kody (`invalid_verify_template`, `verify_code_placeholder_required`, `forbidden_wording`). Kod nie podpowiada treści domyślnej.
- Zatwierdzenie w oknie z pełnym tematem i treścią; jedno żądanie na wersję naraz. Zatwierdzona wersja jest niezmienna; zmiana = nowy szkic.
- Odmowy tłumaczone komunikatem: `403 self_approval_forbidden` (autor szkicu nie zatwierdza), `403 mfa_stale` (potrzebne świeże MFA, ostatnie 15 minut — ekran nie pyta o kod, prosi o ponowne zalogowanie), `403 forbidden` (szkic zapisuje admin albo zarząd bez przydziału klasowego, a zatwierdza wyłącznie zarząd bez przydziału klasowego — administrator dostaje tu odmowę), `409 verify_template_changed|verify_template_not_draft` (lista się odświeża).
