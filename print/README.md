# Kartki o dobrowolnej składce

Moduł do druku indywidualnych informacji o dobrowolnej składce Rady Rodziców (issue #11). Jedna dyskretna kartka na rodzinę: zawiera wyłącznie uczniów tej rodziny, bez innych adresatów i bez określeń sugerujących zadłużenie.

To prototyp. Nie używać na danych rodzin przed zatwierdzeniem treści (D-16), kwoty (D-14), danych rachunku (D-13) oraz zakresu i sposobu przekazania danych przez szkołę.

## Uruchomienie

```bash
npm run dev:print     # lokalnie
npm run build:print   # wynik w dist/print
```

Serwer Node (`src/node-app.js`) serwuje zbudowany moduł spod `/print/`; tylko wtedy przycisk „Wczytaj z serwera” działa (to samo pochodzenie co API).

## Dane wejściowe

Plik jest czytany wyłącznie w przeglądarce jako bajty (`File.arrayBuffer()`); nic nie jest wysyłane ani zapisywane. Limit: 2 MB, 5000 wierszy.

Kodowanie CSV wykrywa wspólny moduł `import/csv.js` (#77): UTF-8 z BOM lub bez, UTF-16 z BOM, a przy niepoprawnym UTF-8 Windows-1250 (Excel PL). Można je wybrać ręcznie (UTF-8, Windows-1250, Windows-1252). Komunikat po wczytaniu podaje użyte kodowanie i separator. Separator jest wykrywany w nagłówku poza cudzysłowami albo wybierany ręcznie w polu „Separator”; przy remisie (tyle samo np. średników i przecinków) plik jest odrzucany z prośbą o ręczny wybór — nie powstaje żadna kartka. Plik z nierozpoznanymi bajtami (`�`) jest odrzucany i nie powstaje żadna kartka. JSON musi być w UTF-8.

CSV (separator `;`, `,` lub tabulator), jeden wiersz na ucznia:

| Kolumna | Wymagana | Uwagi |
| --- | --- | --- |
| `ID rodziny` | tak | ten sam identyfikator dla rodzeństwa |
| `Imię ucznia`, `Nazwisko ucznia` albo `Uczeń` | tak | |
| `Klasa` | tak | |
| `Wpłaty netto EUR` | nie | wyłącznie informacja dla operatora |

JSON: tablica obiektów albo `{ "rows": [...] }` z polami `householdId`, `firstName` + `lastName` lub `studentName`, `className`, opcjonalnie `recordedNetCents`.

Uczeń przypisany do dwóch rodzin (np. rodzice mieszkający osobno) pojawi się na dwóch osobnych kartkach; każda kartka zawiera tylko uczniów z wierszy swojej rodziny. Plik z błędami (brak ID, klasy, niespójne kwoty w jednej rodzinie) nie jest wczytywany.

## Wczytanie z serwera (API PostgreSQL)

Przycisk „Wczytaj z serwera” pobiera `GET /api/print/cards?schoolYearId=…&classId=…` (to samo pochodzenie, `credentials: "include"`) i przekazuje wynik do tego samego podglądu i wyboru co plik. Tryb pliku lokalnego pozostaje bez zmian. Trasa: `src/pg/routes/print.js` (router PostgreSQL, prototyp — niewdrożony).

Odpowiedź (`Cache-Control: no-store`) ma kształt wejścia JSON: `{ schoolYearId, classId, paymentInfoIncluded, rows: [{ householdId, firstName, lastName, className, recordedNetCents? }] }` — jeden wiersz na ucznia zapisanego w danym roku, bez rodzin zarchiwizowanych. Nie zawiera żadnych danych opiekunów (e-maili, imion, zgód).

| Rola | Zakres | Kwota netto wpisów wpłat |
| --- | --- | --- |
| `admin`, `board`, `treasurer` (przydział bez klasy) | wszystkie klasy roku; `classId` opcjonalny — wtedy rodziny z uczniem w tej klasie, razem z rodzeństwem z innych klas | tylko przy potwierdzonym MFA |
| `representative` | wyłącznie `classId` z własnych przydziałów (wymagany, inaczej `400 class_required`, cudza klasa `403`); tylko uczniowie tej klasy, rodzeństwo z innych klas pominięte | nigdy |
| `audit`, `principal` | `403` do decyzji D-09 | — |

Założenie (D-08, macierz kompetencji — otwarta): przedstawiciel klasy może drukować kartki wyłącznie dla swojej klasy i bez informacji o wpłatach. Dostęp bez MFA do samych imion i klas jest dopuszczony tak jak w innych trasach przedstawiciela; jeśli szkoła zdecyduje inaczej, wystarczy wymusić MFA w `printScope`.

Bez `recordedNetCents` kolumna pomocnicza pokazuje „nie podano”. Kwota netto to suma wpisów wpłat pomniejszona o korekty (`household_payment_totals`); „brak wpisu wpłaty” może być nieaktualny i nie jest statusem rodziny.

Każde udane żądanie zapisuje w `audit_events` zdarzenie `print.cards_requested` (aktor, rok szkolny jako obiekt, metadane: `classId`, liczba rodzin, liczba uczniów, czy dołączono kwoty) — bez identyfikatorów rodzin, imion ani kwot. Limit 5000 wierszy (`413 too_many_rows`).

## Przepływ

1. Uzupełnij treść: nazwa Rady, rok szkolny, kontakt. Kwota sugerowana i rachunek są opcjonalne — puste pole pomija zdanie. Bez zaznaczenia „Treść zatwierdzona przez Radę” każda kartka ma oznaczenie „WZÓR”.
2. Wczytaj plik albo dane z serwera. Po wczytaniu **żadna rodzina nie jest zaznaczona**.
3. Wybierz rodziny ręcznie (pojedynczo, filtr klasy, „Zaznacz widoczne”). Filtr „Ukryj rodziny z wpisem wpłaty” jest opcjonalny i domyślnie wyłączony. „Brak wpisu wpłaty” może być nieaktualny i nie jest statusem rodziny; nie trafia na kartkę.
4. Sprawdź podgląd, zaznacz potwierdzenie wyboru i dopiero wtedy użyj „Drukuj”. Każda zmiana wyboru lub treści wymaga ponownego potwierdzenia.

## PDF

Nie ma generowania PDF po stronie serwera ani dodatkowej biblioteki. W oknie druku przeglądarki wybierz „Zapisz jako PDF” (Chrome/Edge: „Miejsce docelowe”, Firefox: „Drukarka”), format A4, skala 100%, wyłącz nagłówki i stopki. Arkusz `@page { size: A4 }` wymusza jedną kartkę na stronę; opcjonalny układ „dwie na stronę” dodaje przerywaną linię cięcia i przycina bardzo długie kartki (np. rodzina z wieloma dziećmi) — sprawdź podgląd wydruku.

Wygenerowany PDF zawiera dane osobowe: nie zapisywać go w repozytorium ani w publicznych folderach, usunąć po wydruku.

## Treść kartki

- nazwa Rady, szkoła, rok szkolny, tytuł „Informacja o dobrowolnej składce”,
- „Dla rodziców i opiekunów:” i lista uczniów tej rodziny z klasą,
- zdanie o dobrowolnym charakterze składki,
- opcjonalnie kwota sugerowana (D-14) i dane do przelewu (D-13, szablon tytułu z `{rodzina}` i `{rok}`),
- „Jeśli wpłata została już wykonana, prosimy pominąć tę informację.”,
- kontakt i drobny numer rodziny ułatwiający rozdanie kartek.

Kontrola słownictwa odrzuca konfigurację i kartki ze słowami „zaległość”, „dług”, „dłużnik”, „zadłużenie”, „windykacja”, „należność”, „monit”, „wezwanie”. Imiona i nazwiska uczniów nie są sprawdzane (np. „Długosz”).

## Testy

`tests/print-core.test.js`: kartki tylko dla wybranych rodzin, brak cudzych uczniów na kartce, rodzeństwo razem, brak słów o zadłużeniu, escapowanie HTML, pominięcie zdania bez kwoty, walidacja wejścia.

`tests/pg-print.test.js`: przedstawiciel i cudza klasa (403), brak kwot bez MFA lub dla roli niefinansowej, rodzeństwo, dwoje opiekunów jednego dziecka, brak e-maili w odpowiedzi, audyt bez danych osobowych, zgodność odpowiedzi z `print/core.js`.
