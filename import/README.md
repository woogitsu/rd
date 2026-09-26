# Import uczniów — etap podglądu (#2)

`npm ci`, `npm run dev:import` — lokalna makieta importu. Plik jest parsowany lokalnie w przeglądarce. `npm run build:import` tworzy statyczne `dist/import/`. `npm test` uruchamia testy CSV, syntetycznego XLSX i walidacji. GitHub Actions wykonuje testy i build po otwarciu PR.

Obsługiwane CSV (UTF-8 z opcjonalnym BOM, średnik/przecinek) i XLSX (pierwszy arkusz). Limit 5 MB, 5000 wierszy i 60 kolumn. Wybór pliku, mapowanie nagłówków, walidacja, możliwe duplikaty, ostrzeżenia o niespójnych danych opiekunów przy tym samym ID rodziny i podgląd 100 pierwszych wierszy. Tabela pokazuje oboje opiekunów, gdy są wpisani. W repo jest fikcyjny `template.csv`.

Ten etap niczego nie wysyła do serwera ani nie zapisuje w bazie. Przycisk zatwierdzenia jest celowo wyłączony. Kolejny etap wymaga serwerowej sesji, RBAC, importu w transakcji, stabilnych identyfikatorów źródłowych, raportu konfliktów z istniejącą bazą, idempotencji i audytu. Nie wolno opierać bezpieczeństwa na walidacji w przeglądarce. Nie używaj produkcyjnego arkusza przed wdrożeniem tych zabezpieczeń.

Nie łączymy rodzin automatycznie po nazwisku lub e-mailu. Pole `ID rodziny` służy do przeglądu powiązań, ale jego przypisanie wymaga zatwierdzenia przez uprawnioną osobę.
