# Import uczniów — podgląd lokalny (#2) i zapis w PostgreSQL (#36)

`npm ci`, `npm run dev:import` — lokalna makieta importu. Plik jest parsowany lokalnie w przeglądarce. `npm run build:import` tworzy statyczne `dist/import/`. `npm test` uruchamia testy CSV, syntetycznego XLSX, walidacji oraz API importu na PGlite (`tests/pg-import.test.js`). GitHub Actions wykonuje testy i build po otwarciu PR.

Obsługiwane CSV (kodowanie i separator wykrywane w `import/csv.js`, patrz niżej) i XLSX (wybór arkusza — plik bywa wieloarkuszowy, np. arkusz „Instrukcja” przed danymi; domyślnie pierwszy). **.ods (LibreOffice/Calc) nie jest obsługiwane** — patrz niżej. Limit 5 MB, 5000 wierszy i 60 kolumn. Wybór pliku, mapowanie nagłówków, walidacja, możliwe duplikaty, ostrzeżenia o niespójnych danych opiekunów przy tym samym ID rodziny i podgląd 100 pierwszych wierszy. Tabela pokazuje oboje opiekunów, gdy są wpisani. W repo jest fikcyjny `template.csv`.

### XLSX: typy komórek, arkusze, ODS (#88)

- **Kolumny identyfikatorów** (`ID ucznia`, `ID rodziny`): jeśli Excel zapisał komórkę jako liczbę (typowe dla `00123`, które Excel zamienia na `123`), wartość jest zachowywana jako tekst i podgląd dostaje uwagę „zapisany jako liczba — sprawdź zera wiodące; w Excelu ustaw format kolumny na Tekst”. Liczba poza `Number.isSafeInteger` (identyfikator z ponad 15-16 cyframi) jest błędem wiersza, żeby nie ryzykować cichej utraty precyzji.
- **Zera wiodące i duplikaty CSV vs XLSX**: biblioteka `read-excel-file` udostępnia tylko wartość zapisaną w pliku (`123`), a nie tekst widoczny w komórce (`00123` z formatem `00000`) — zer nie da się odzyskać po stronie kodu; pozostaje uwaga w podglądzie i format Tekst w Excelu. Żeby to nie tworzyło drugiego ucznia/rodziny: (1) w jednym pliku `00123` i `123` to ten sam identyfikator (powtórzone ID); (2) serwer, widząc ID (ucznia lub rodziny) z samych cyfr, które różni się od istniejącego w bazie wyłącznie zerami wiodącymi, nie dopasowuje ich ani nie tworzy nowego rekordu, tylko zgłasza wiersz jako konflikt („różni się tylko zerami wiodącymi”). To wariant zachowawczy: dwa naprawdę różne identyfikatory `0123` i `123` też wymagają ręcznej decyzji. Ujednolicenie zapisu identyfikatorów w pliku szkoły należy do decyzji D-03.
- **Limity rozpakowania (zip bomb)**: limit 5 MB dotyczy pliku skompresowanego. Dodatkowo, przed rozpakowaniem, na podstawie nagłówków archiwum: najwyżej 1000 wpisów, 50 MB rozpakowanych XML/relacji łącznie i 50 MB na wpis (`XLSX_LIMITS` w `import/xlsx.js`); powyżej — komunikat z prośbą o zapis jako CSV. Pliki niebędące XML (obrazy) nie są rozpakowywane. Rozmiar `dist/import` (build lokalny): 131 325 B przed, 131 825 B po (+500 B; bundle JS 119 473 → 119 973 B).
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
- **Zapamiętane mapowanie** (`import/mapping-memory.js`): po „Sprawdź dane” przeglądarka zapisuje w `localStorage` słownik „nagłówek → pole” (bez wartości z wierszy; nagłówki z listy wykluczeń, np. PESEL, nie są zapamiętywane) i podpowiada go przy kolejnym pliku o tych samych nagłówkach. Aliasy z `core.js` mają pierwszeństwo. Przycisk „Wyczyść zapamiętane mapowanie” usuwa wpis; przy zablokowanym `localStorage` (try/catch) import działa bez pamięci.
- **Szablon XLSX**: `import/public/template.xlsx` (arkusz „Dane” z kolumnami jako Tekst i walidacją klasy w stylu ostrzeżenia oraz arkusz „Instrukcja”) generuje `node scripts/build-import-template.js` z `import/template-xlsx.js` — bez nowej zależności (fflate już jest w projekcie). Test `tests/import-template.test.js` sprawdza, że plik w repo zgadza się z generatorem i że aliasy mapują się bez ręcznego wyboru. Lista klas w walidacji jest tylko przykładowa.
- **Szablon**: `import/public/template.csv` (dane `@example.invalid`) i `import/public/template-instrukcja.txt` — krótka instrukcja PL (pola wymagane, format identyfikatorów jako tekst, czego nie wpisywać, obsługiwane formaty plików).

## Krok 4: podgląd i zapis na serwerze (prototyp)

Opcjonalny, dostępny tylko w nowym API na PostgreSQL (`src/pg/routes/import.js`). **To nie jest zgoda na import danych rodzin** — do czasu decyzji D-01–D-06 w [rejestrze decyzji](../docs/DECISIONS.md) używamy wyłącznie danych fikcyjnych. Import jest dostępny bez `IMPORT_ENABLED=true` wyłącznie przy jawnym `APP_ENV=development`, `test` albo `staging` (wielkość liter bez znaczenia). Przy `production`/`prod`, przy braku `APP_ENV` i przy każdej nieznanej wartości (literówce) trasy zwracają `403 import_disabled`, dopóki administrator nie ustawi `IMPORT_ENABLED=true` po decyzji szkoły (wspólna normalizacja: `src/app-env.js`, #166; założenie zachowawcze, do potwierdzenia w D-20).

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
- Powtórki (#2): ten sam `Idempotency-Key` (podwójne kliknięcie, ponowienie po zerwaniu połączenia) zwraca zapisany wynik (`replayed: true`). Ponowne wczytanie tego samego pliku z nowym kluczem zwraca zapisany wynik tylko wtedy, gdy plan nie ma już nic do zapisania. Jeżeli po usunięciu przyczyny konfliktu plan ma nowe zapisy (np. wcześniej pominięty wiersz), powstaje nowa partia (`replayed: false`) — pominięte wiersze nie znikają po cichu. Równoległe zatwierdzenia są szeregowane blokadą, więc drugie widzi już zapisany stan i nie dubluje rekordów. Ten sam `Idempotency-Key` z innymi danymi → `409 idempotency_key_reused`.
- Błąd w trakcie zapisu wycofuje całą transakcję: partię, rodziny, opiekunów, uczniów, zapisy do klas, powiązania i audyt.
- Dziennik: jedno zdarzenie `import.committed` z aktorem, identyfikatorem partii, rokiem i licznikami — bez imion, nazwisk, e-maili i identyfikatorów ze źródła.

### Uprawnienia (założenie do D-08)

Rola `admin` lub `board`, sesja z potwierdzonym MFA, przydział **bez ograniczenia do klasy** i obejmujący wybrany rok (albo wszystkie lata). Przedstawiciel klasy, skarbnik, `audit` i `principal` są odrzucani. Zakres ról wymaga zatwierdzenia w decyzji D-08; do tego czasu jest to założenie techniczne. Kontrola odbywa się na serwerze; walidacja w przeglądarce nie jest zabezpieczeniem.

Odpowiedzi API nie zawierają imion, nazwisk ani adresów — tylko numery wierszy, komunikaty i liczniki.

Nie używaj produkcyjnego arkusza przed zamknięciem decyzji D-01–D-06 i odbiorem z #31/#41.
