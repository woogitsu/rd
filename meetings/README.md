# Panel zebrań

Interfejs do chronionego API zebrań `/api/meetings…` (issue #13, kontrakt w [docs/MEETINGS.md](../docs/MEETINGS.md) i `src/pg/meetings.js`). **Prototyp** — nie jest zatwierdzony do pracy na danych rodzin. Nie zawiera danych demonstracyjnych ani obejścia logowania; uprawnienia sprawdza wyłącznie serwer.

## Uruchomienie

```bash
npm run build:meetings
DATABASE_URL=… PORT=3000 npm start   # panel pod /meetings/
```

API zebrań istnieje tylko w routerze PostgreSQL, więc panel działa pod tym samym originem co serwer Node z `DATABASE_URL`. `npm run dev:meetings` służy do pracy nad samym interfejsem (bez proxy API).

## Zakres

- lista zebrań wybranego roku szkolnego (identyfikator roku wpisywany ręcznie),
- nowe zebranie: rodzaj (ogólne, zarządu, klasowe z klasą), data i godzina w strefie **Europe/Brussels** niezależnie od strefy przeglądarki, miejsce, status początkowy (szkic / zaplanowane — niczego nie wysyła),
- edycja danych zebrania i reguły quorum; zmiana statusu tylko na dozwolone przejścia,
- reguła quorum: ułamek składu uprawnionego („co najmniej” / „więcej niż”, bez wartości domyślnej) albo minimalna liczba obecnych; **źródło reguły jest w panelu obowiązkowe** dla każdej reguły,
- porządek obrad (dodawanie punktów),
- lista obecności: identyfikator konta lub opiekuna, funkcja, obecność i **prawo głosu zaznaczane jawnie** (brak wartości domyślnej); poprawka to ponowny zapis tej samej osoby,
- „Ustal quorum”: wynik oblicza serwer; panel pokazuje liczby, regułę i zastrzeżenie, że wynik opiera się na ręcznie wpisanych danych; historia ustaleń zostaje,
- protokół: każda zmiana to nowa wersja (edytor tekstowy), zatwierdzenie najnowszej wersji, widoczność wewnętrzny / rodzice / publiczny tylko dla wersji zatwierdzonych,
- uchwały: numer, tytuł, treść, status i liczby głosów za / przeciw / wstrzymało się **wpisywane przez sekretarza** (to nie jest głosowanie elektroniczne), wskazanie ustalenia quorum, poprawka zapisu jako nowa rewizja (do zatwierdzenia protokołu), uchwała zmieniająca wskazywana numerem przyjętej uchwały z tego samego roku.

## Zachowanie przy wysyłce

- Każde tworzenie (zebranie, punkt, quorum, wersja protokołu, widoczność, uchwała, poprawka) wysyła `Idempotency-Key`. Klucz zostaje przy błędzie sieci lub 5xx — ponowienie odtwarza pierwotny wynik zamiast tworzyć duplikat — i znika po sukcesie, zamknięciu okna albo odpowiedzi rozstrzygającej.
- `409` (np. `idempotency_conflict`, `meeting_locked`, `resolution_votes_exceed_present_voters`) daje polski komunikat przy formularzu i odświeża dane zebrania.
- Przycisk jest blokowany na czas żądania (podwójne kliknięcie).
- Walidacja w przeglądarce (`meetings/core.js`) powtarza reguły serwera tylko dla wygody: suma głosów nie może przekroczyć liczby obecnych uprawnionych w wybranym ustaleniu quorum, wynik wymaga wszystkich trzech liczb i ustalenia quorum. Panel nie ocenia większości ani nie wymaga osiągnięcia quorum — to zasady regulaminu (D-21).

## Ograniczenia

- Lista obecności pokazuje identyfikatory, nie imiona — API ich nie zwraca, a tabela obecności nie przechowuje danych osobowych.
- Formularze są widoczne także dla ról tylko do odczytu (np. Komisja Rewizyjna); serwer odrzuci zapis (`403`).
- Punkty porządku obrad można wycofać (wiersz zostaje), ale nie edytować, usuwać ani przestawiać (#113: zmiana kolejności — osobny zakres). Odwołanie, zmiana terminu i zawiadomienie: sekcja „Zawiadomienie, termin i odwołanie” panelu; panel niczego nie wysyła — szkic wiadomości trafia do modułu e-mail.
- Treść protokołu nie jest sprawdzana pod kątem danych osobowych przed udostępnieniem — robi to człowiek.
