# Import uczniów — podgląd lokalny (#2) i zapis w PostgreSQL (#36)

`npm ci`, `npm run dev:import` — lokalna makieta importu. Plik jest parsowany lokalnie w przeglądarce. `npm run build:import` tworzy statyczne `dist/import/`. `npm test` uruchamia testy CSV, syntetycznego XLSX, walidacji oraz API importu na PGlite (`tests/pg-import.test.js`). GitHub Actions wykonuje testy i build po otwarciu PR.

Obsługiwane CSV (kodowanie i separator wykrywane w `import/csv.js`, patrz niżej) i XLSX (wybór arkusza — plik bywa wieloarkuszowy, np. arkusz „Instrukcja” przed danymi; domyślnie pierwszy). **.ods (LibreOffice/Calc) nie jest obsługiwane** — patrz niżej. Limit 5 MB, 5000 wierszy i 60 kolumn. Wybór pliku, mapowanie nagłówków, walidacja, możliwe duplikaty, ostrzeżenia o niespójnych danych opiekunów przy tym samym ID rodziny i podgląd 100 pierwszych wierszy. Tabela pokazuje oboje opiekunów, gdy są wpisani. W repo jest fikcyjny `template.csv`.

### XLSX: typy komórek, arkusze, ODS (#88)

- **Kolumny identyfikatorów** (`ID ucznia`, `ID rodziny`): jeśli Excel zapisał komórkę jako liczbę (typowe dla `00123`, które Excel zamienia na `123`), wartość jest zachowywana jako tekst i podgląd dostaje uwagę „zapisany jako liczba — sprawdź zera wiodące; w Excelu ustaw format kolumny na Tekst”. Liczba poza `Number.isSafeInteger` (identyfikator z ponad 15-16 cyframi) jest błędem wiersza, żeby nie ryzykować cichej utraty precyzji.
- **Komórka typu data** w dowolnym mapowanym polu (Excel czasem zamienia wpis typu `1-2` na datę) jest błędem wiersza z czytelnym komunikatem, zamiast trafić do pola jako `Mon Jan 02 2026 …`.
- **Wybór arkusza**: po wczytaniu pliku XLSX widoczna jest lista arkuszy z liczbą wierszy; zmiana wyboru przelicza mapowanie i podgląd bez ponownego odczytu pliku (`import/xlsx.js: readXlsxSheets` czyta wszystkie arkusze raz).
- **Nazwa klasy** jest porównywana z listą klas roku bez rozróżniania wielkości liter i nadmiarowych spacji (`1a`, ` 1A ` i `1A` to ta sama klasa) i zapisywana w pisowni z bazy. Dwie różne klasy roku, które po normalizacji dają ten sam klucz (np. `1a` i `1A` jako osobne klasy), są błędem „niejednoznaczna nazwa klasy” — wymaga poprawki nazw klas w bazie, nie da się rozstrzygnąć automatycznie.
- **ODS** (LibreOffice/Calc): plik jest odrzucany z instrukcją zapisania jako `.xlsx` albo `.csv`. `read-excel-file` nie czyta ODS; jedyna popularna biblioteka czytająca oba formaty (`xlsx`/SheetJS) ma znane podatności (CVE-2023-30533, CVE-2024-22363) w wersji z rejestru npm, a poprawione wersje są dostępne tylko poza npm — decyzja audytu (#88): najpierw instrukcja, bibliotekę dodać dopiero, gdy szkoła rzeczywiście dostarcza ODS.

### Zgodność z CSP serwera Node (#188, #223)

- Style są w `import/styles.css` (podpięte `<link rel="stylesheet">`), bez bloku `<style>` i atrybutów `style=`. Serwer wysyła `style-src 'self'` i `script-src 'self'` (`src/node-app.js`); polityki nie luzujemy.
- XLSX jest czytany przez `import/xlsx.js`: plik rozpakowuje `unzipSync` z `fflate` w głównym wątku i przepakowuje bez kompresji, dopiero potem czyta go `read-excel-file`. Bez tego `fflate` oddaje pozycje większe niż 512 KiB (duży `sheet1.xml` lub `sharedStrings.xml`) do `Worker` z adresu `blob:`, który CSP blokuje, a strona zostaje na „Odczyt pliku…”. Przy 5 MB rozpakowanie może na chwilę zablokować kartę — przy jednorazowym imporcie to akceptowalne.
- `tests/csp-static.test.js` sprawdza źródłowe `*/index.html` i zbudowane `dist/**/*.html` (w CI po buildzie z `REQUIRE_DIST=1`): brak `<style>`, `style=`, skryptów inline, `on*=` i `javascript:`.

### Kodowanie i separator CSV (#77)

- Kodowanie: BOM UTF-8 lub UTF-16 LE/BE → odpowiedni dekoder; bez BOM próba UTF-8 w trybie ścisłym, a przy niepoprawnych bajtach Windows-1250 (eksport „CSV (rozdzielany średnikami)” z polskiego Excela). Pole „Kodowanie CSV” pozwala wymusić UTF-8, Windows-1250 lub Windows-1252 (Excel BE/FR).
- Status pliku podaje użyte kodowanie i separator, np. „Windows-1250 (Excel PL), średnik”. Znaki typowe dla ISO-8859-2 lub Windows-1252 odczytanych jako Windows-1250 dają ostrzeżenie — sprawdź nazwiska i w razie potrzeby wybierz kodowanie ręcznie.
- Znak zastępczy `�`, NUL (UTF-16 bez BOM) lub bajt nieopisany przez kodowanie → błąd „Plik ma nieznane kodowanie…”; plik nie przechodzi do mapowania.
- Separator `;`, `,` albo tabulator liczony w pierwszej niepustej linii poza cudzysłowami; remis jest sygnalizowany w statusie.

Kroki 1–3 (plik, mapowanie, sprawdzenie) nadal działają wyłącznie lokalnie i niczego nie wysyłają.

### Raport importu i pominięte kolumny (#109)

- **Raport błędów do pobrania** (`import/report.js`, przycisk „Pobierz raport błędów (CSV)” w kroku 3): CSV z kolumnami `Wiersz; Etap; Rodzaj; Komunikat`, generowany w przeglądarce przez wspólny eskaper formuł `src/pg/csv.js` (#206) — obejmuje wszystkie komunikaty walidacji lokalnej i, jeśli wysłano, podglądu serwera (nie tylko pierwsze 40 pokazane na ekranie). **Nie zawiera** imion, nazwisk ani e-maili — tylko numer wiersza źródłowego i treść komunikatu (te same komunikaty co w interfejsie, które już nie zawierają danych osobowych). Można go bezpiecznie przekazać szkole.
- **Kolumny, które nie zostaną użyte**: po dopasowaniu kolumn (krok 2) lista nagłówków z pliku bez przypisanego pola. Nagłówek pasujący do listy wykluczeń (`PESEL`, `adres`, `telefon`, `oceny`, dane zdrowotne, numer dokumentu) dostaje wyraźne ostrzeżenie „Ten plik zawiera dane, których nie importujemy”. Pokazywane są tylko nazwy nagłówków, nigdy wartości komórek.
- **Szablon**: `import/public/template.csv` (dane `@example.invalid`) i `import/public/template-instrukcja.txt` — krótka instrukcja PL (pola wymagane, format identyfikatorów jako tekst, czego nie wpisywać, obsługiwane formaty plików).

## Krok 4: podgląd i zapis na serwerze (prototyp)

Opcjonalny, dostępny tylko w nowym API na PostgreSQL (`src/pg/routes/import.js`). **To nie jest zgoda na import danych rodzin** — do czasu decyzji D-01–D-06 w [rejestrze decyzji](../docs/DECISIONS.md) używamy wyłącznie danych fikcyjnych. Na środowisku `APP_ENV=production` trasy zwracają `403 import_disabled`, dopóki administrator nie ustawi `IMPORT_ENABLED=true` po decyzji szkoły.

Przepływ:

1. `GET /api/import/options` — lata szkolne i nazwy klas dostępne dla zalogowanej osoby.
2. `POST /api/import/preview` — serwer ponownie waliduje wiersze tą samą funkcją `validateRows` (z listą klas roku z bazy) i porównuje je z bazą. Zwraca liczniki: nowe, aktualizacje, bez zmian, konflikty, pominięte (błędy), plan tworzonych rekordów, uwagi, `fingerprint` i `planDigest`. **Niczego nie zapisuje** — ani danych, ani audytu.
3. `POST /api/import/commit` z nagłówkiem `Idempotency-Key` oraz `fingerprint` i `planDigest` z podglądu — jedna transakcja, wszystko albo nic.

### Co wysyła przeglądarka

Tylko znormalizowane wiersze w JSON (`toServerPayload` z `core.js`): `{ version: 1, schoolYearId, columns, rows, rowNumbers, options }`. **Plik źródłowy nie trafia na serwer** i nie jest nigdzie przechowywany, więc nie wymaga osobnego okresu retencji (D-04). Wiersze istnieją na serwerze tylko w pamięci na czas żądania; w bazie zostają wyłącznie zaimportowane rekordy i partia `import_batches` (liczniki i skróty SHA-256, bez treści pliku).

Limit ciała żądania wynosi 1 MB — tyle samo co globalny limit `src/node-app.js`, który nie został zmieniony. 1200 syntetycznych wierszy to ok. 160 KB. Plik bliski 5000 wierszy z długimi polami może przekroczyć limit (`413 request_too_large`); wtedy trzeba go podzielić, np. na klasy.

### Dopasowanie do istniejących danych

- Uczeń jest rozpoznawany **wyłącznie** po `ID ucznia` (`students.source_ref`, bez rozróżniania wielkości liter). Wiersz bez ID ucznia to konflikt „wymaga ręcznego powiązania” — bez stabilnego ID ponowny import mógłby zdublować ucznia.
- Rodzina jest rozpoznawana **wyłącznie** po `ID rodziny` (`households.source_ref`). Rodzeństwo z tym samym ID rodziny trafia do jednej rodziny.
- Wiersz nowego ucznia bez ID rodziny to konflikt, chyba że zaznaczono „Utwórz osobną rodzinę dla wierszy bez ID rodziny”. Wtedy każdy taki wiersz dostaje osobną rodzinę bez `source_ref`; rodzeństwa nie łączymy.
- Opiekun jest rozpoznawany tylko w obrębie już ustalonej rodziny, po imieniu i nazwisku oraz e-mailu. **Nigdy nie łączymy rodzin po samym nazwisku lub e-mailu.** Ten sam e-mail w innej rodzinie daje tylko uwagę do ręcznego sprawdzenia.
- Konflikty (nie są zapisywane): inne imię/nazwisko niż w bazie przy tym samym ID ucznia, inne ID rodziny niż w bazie, inna klasa w tym samym roku. Zmiana klasy lub rodziny wymaga ręcznej decyzji uprawnionej osoby.
- **Dopasowanie opiekuna jest dwuetapowe (#98).** Pełne dopasowanie (imię + nazwisko + e-mail identyczne z bazą) aktualizuje istniejące powiązanie jak dotąd. Dopasowanie częściowe w obrębie tej samej rodziny — ten sam e-mail przy innej pisowni imienia/nazwiska, albo to samo imię i nazwisko przy innym e-mailu — jest **konfliktem** „Możliwa zmiana danych opiekuna”: import niczego nie tworzy ani nie nadpisuje, wymaga ręcznej, audytowanej korekty poza importem. Dzięki temu poprawka literówki albo zmiana adresu e-mail nie mnoży opiekunów tego samego dziecka.
- Podgląd zawiera sekcję „W bazie, brak w pliku”: liczbę i identyfikatory źródłowe (`source_ref`) uczniów zapisanych w wybranym roku, których nie ma w przesłanym pliku (choćby w wierszu z błędem). Wyłącznie informacyjnie — import niczego nie usuwa ani nie archiwizuje; bez imion i nazwisk.
- Aktualizacja istniejącego ucznia: zapis do klasy w nowym roku, nowy opiekun lub nowe powiązanie uczeń–opiekun. Import nie usuwa ani nie nadpisuje istniejących danych.
- Import nie ustawia zgody na kontakt ani kontaktu głównego (`contact_allowed = false`); zakres tych pól należy do decyzji D-03.
- Opiekun „Imię Nazwisko” jest dzielony na imię i nazwisko od ostatniego wyrazu, ale przedrostki nazwisk (np. „de”, „van”, „van der”, „von”) zostają przy nazwisku: „Anna Maria de Smet” → imię „Anna Maria”, nazwisko „de Smet” (#98). Jednowyrazowy wpis trafia do imienia. Wpis z więcej niż dwoma wyrazami dostaje ostrzeżenie „sprawdź podział na imię i nazwisko” — osobne kolumny imienia i nazwiska opiekuna to decyzja D-03.
- Nazwa klasy jest dopasowywana do listy klas roku bez rozróżniania wielkości liter i spacji (#88) — zapisywana jest pisownia z bazy.
- Wartości wyglądające jak formuły (`=`, `+`, `-`, `@`) są zapisywane jako zwykły tekst. Przyszły eksport do CSV/XLSX musi je neutralizować.

### Zatwierdzenie

- Jeżeli podgląd ma konflikty lub błędy, zatwierdzenie zwraca `422 import_has_conflicts`, chyba że użytkownik zaznaczy pominięcie tych wierszy (`skipConflicts`). Pominięte wiersze są liczone w partii.
- Serwer w transakcji, pod blokadą advisory lock, ponownie wylicza plan. Inny `fingerprint` niż w podglądzie → `409 fingerprint_mismatch`; inny plan (baza zmieniła się od podglądu) → `409 preview_stale`.
- Ten sam zestaw danych (`fingerprint`) jest zapisywany najwyżej raz. Podwójne kliknięcie, ponowienie po zerwaniu połączenia lub ponowne wczytanie tego samego pliku zwraca zapisany wynik (`replayed: true`) bez dublowania. Ten sam `Idempotency-Key` z innymi danymi → `409 idempotency_key_reused`.
- Błąd w trakcie zapisu wycofuje całą transakcję: partię, rodziny, opiekunów, uczniów, zapisy do klas, powiązania i audyt.
- Dziennik: jedno zdarzenie `import.committed` z aktorem, identyfikatorem partii, rokiem i licznikami — bez imion, nazwisk, e-maili i identyfikatorów ze źródła.

### Uprawnienia (założenie do D-08)

Rola `admin` lub `board`, sesja z potwierdzonym MFA, przydział **bez ograniczenia do klasy** i obejmujący wybrany rok (albo wszystkie lata). Przedstawiciel klasy, skarbnik, `audit` i `principal` są odrzucani. Zakres ról wymaga zatwierdzenia w decyzji D-08; do tego czasu jest to założenie techniczne. Kontrola odbywa się na serwerze; walidacja w przeglądarce nie jest zabezpieczeniem.

Odpowiedzi API nie zawierają imion, nazwisk ani adresów — tylko numery wierszy, komunikaty i liczniki.

Nie używaj produkcyjnego arkusza przed zamknięciem decyzji D-01–D-06 i odbiorem z #31/#41.
