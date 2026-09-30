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

Role finansowe z potwierdzonym MFA widzą dodatkowo sumy wpłat netto na rok. Interfejs nie pokazuje należności ani statusu „dłużnik” — składka jest dobrowolna.

## Zakres ról (założenie do decyzji D-08/D-09)

- admin, zarząd, skarbnik — wszystkie klasy (lub klasy roku z przydziału),
- przedstawiciel klasy — wyłącznie przypisane klasy; rodzeństwo z innych klas jest pomijane, e-mail opiekuna tylko przy zgodzie na kontakt,
- Komisja Rewizyjna, dyrekcja — brak dostępu (403) do czasu decyzji D-09.

Przyciski edycji są ukrywane na podstawie `/api/access`, ale o dostępie decyduje wyłącznie serwer. Obiekt spoza zakresu i nieistniejący dają ten sam komunikat („Nie znaleziono lub brak dostępu”).

## Statystyki klas (pulpit zarządu, #131)

Widok `#/overview` (odnośnik „Statystyki klas” na liście klas dla admina/zarządu) czyta `GET /api/board/overview` i pokazuje wyłącznie liczności: uczniowie, gospodarstwa, przedstawiciele i zaproszenia, kontakt e-mail, „do kartki” oraz — tylko dla roli finansowej z MFA i zakresu szerokiego — odsetek gospodarstw z odnotowanym wpisem wpłaty. Odsetek opisuje ewidencję, nie zobowiązania (składka jest dobrowolna, lista może być nieaktualna); brak sortowania i kolorowania po odsetku, brak list rodzin. Zarząd z przydziałem klasowym widzi tylko swoje klasy, bez kolumny wpłat. Przyciski „Pobierz CSV” i „Pobierz XLSX” pobierają tę samą tabelę z `GET /api/board/overview/export.csv|xlsx?schoolYearId=` (moduły `src/pg/csv.js` i `src/pg/xlsx.js`); serwer stosuje te same uprawnienia, zakres i ograniczenia co widok (zarząd klasowy: tylko swoje klasy, bez kolumny wpłat; kolumna wpisów wpłat tylko dla roli finansowej z MFA; próg 5 gospodarstw), a plik zaczyna się rokiem i stałą notą o dobrowolności składki. Liczby są zapisane jako tekst (wspólne moduły eksportu nie mają typu liczbowego dla zliczeń). Każdy eksport zapisuje zdarzenie `board.overview.exported`.
