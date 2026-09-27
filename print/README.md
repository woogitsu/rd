# Kartki o dobrowolnej składce

Moduł do druku indywidualnych informacji o dobrowolnej składce Rady Rodziców (issue #11). Jedna dyskretna kartka na rodzinę: zawiera wyłącznie uczniów tej rodziny, bez innych adresatów i bez określeń sugerujących zadłużenie.

To prototyp. Nie używać na danych rodzin przed zatwierdzeniem treści (D-16), kwoty (D-14), danych rachunku (D-13) oraz zakresu i sposobu przekazania danych przez szkołę.

## Uruchomienie

```bash
npm run dev:print     # lokalnie
npm run build:print   # wynik w dist/print
```

Serwer Node (`src/node-app.js`) jeszcze nie serwuje `dist/print` — wymaga to dopisania `print` do statycznych ścieżek w osobnym PR.

## Dane wejściowe

Plik jest czytany wyłącznie w przeglądarce (`File.text()`); nic nie jest wysyłane ani zapisywane. Limit: 2 MB, 5000 wierszy.

CSV (separator `;` lub `,`), jeden wiersz na ucznia:

| Kolumna | Wymagana | Uwagi |
| --- | --- | --- |
| `ID rodziny` | tak | ten sam identyfikator dla rodzeństwa |
| `Imię ucznia`, `Nazwisko ucznia` albo `Uczeń` | tak | |
| `Klasa` | tak | |
| `Wpłaty netto EUR` | nie | wyłącznie informacja dla operatora |

JSON: tablica obiektów albo `{ "rows": [...] }` z polami `householdId`, `firstName` + `lastName` lub `studentName`, `className`, opcjonalnie `recordedNetCents`.

Uczeń przypisany do dwóch rodzin (np. rodzice mieszkający osobno) pojawi się na dwóch osobnych kartkach; każda kartka zawiera tylko uczniów z wierszy swojej rodziny. Plik z błędami (brak ID, klasy, niespójne kwoty w jednej rodzinie) nie jest wczytywany.

Docelowo dane będą pobierane z chronionego API (`/api/print/cards`, oznaczone `TODO` w `main.js`). Endpoint nie istnieje; musi sprawdzać sesję, MFA, rolę i przypisanie klas po stronie serwera.

## Przepływ

1. Uzupełnij treść: nazwa Rady, rok szkolny, kontakt. Kwota sugerowana i rachunek są opcjonalne — puste pole pomija zdanie. Bez zaznaczenia „Treść zatwierdzona przez Radę” każda kartka ma oznaczenie „WZÓR”.
2. Wczytaj plik. Po wczytaniu **żadna rodzina nie jest zaznaczona**.
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
