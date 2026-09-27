# Import uczniów — podgląd lokalny (#2) i zapis w PostgreSQL (#36)

`npm ci`, `npm run dev:import` — lokalna makieta importu. Plik jest parsowany lokalnie w przeglądarce. `npm run build:import` tworzy statyczne `dist/import/`. `npm test` uruchamia testy CSV, syntetycznego XLSX, walidacji oraz API importu na PGlite (`tests/pg-import.test.js`). GitHub Actions wykonuje testy i build po otwarciu PR.

Obsługiwane CSV (kodowanie i separator wykrywane w `import/csv.js`, patrz niżej) i XLSX (pierwszy arkusz). Limit 5 MB, 5000 wierszy i 60 kolumn. Wybór pliku, mapowanie nagłówków, walidacja, możliwe duplikaty, ostrzeżenia o niespójnych danych opiekunów przy tym samym ID rodziny i podgląd 100 pierwszych wierszy. Tabela pokazuje oboje opiekunów, gdy są wpisani. W repo jest fikcyjny `template.csv`.

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
- Aktualizacja istniejącego ucznia: zapis do klasy w nowym roku, nowy opiekun lub nowe powiązanie uczeń–opiekun. Import nie usuwa ani nie nadpisuje istniejących danych.
- Import nie ustawia zgody na kontakt ani kontaktu głównego (`contact_allowed = false`); zakres tych pól należy do decyzji D-03.
- Opiekun „Imię Nazwisko” jest dzielony na imię (wszystko przed ostatnim wyrazem) i nazwisko (ostatni wyraz). Jednowyrazowy wpis trafia do imienia.
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
