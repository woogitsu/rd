# Panel księgi

Uruchom razem z API według „Uruchomienie lokalne” w [README głównym](../README.md) (`npm ci && npm run build`, `DATABASE_URL=… npm run db:migrate:postgres`, `DATABASE_URL=… PORT=3000 npm start`) — `npm run dev` (Worker) + `npm run dev:ledger` (Vite) nie są dziś połączone (brak proxy `/api`). Panel nie ma danych demonstracyjnych i korzysta wyłącznie z chronionych tras `/api/ledger`; użytkownik musi mieć aktywną sesję, MFA, rolę finansową oraz dostęp do wskazanego roku.

Panel udostępnia podsumowanie roku, aktualny preliminarz, filtrowaną listę wpisów, formularz przychodu lub wydatku oraz addytywne korekty. Wydatek można powiązać z uchwałą wybraną z listy przyjętych uchwał zebrań ogólnych (bieżący i poprzedni rok; numer, tytuł i kwoty, bez treści); powyżej 3000 EUR wybór jest wymagany. Panel pokazuje limit upoważnienia i pozostałą kwotę, a przekroczenie odrzuca serwer (409). Identyfikator dokumentu można podać wyłącznie dla dokumentu już utworzonego w chronionym magazynie — przesyłanie plików będzie osobnym etapem.

Cykl nowego roku bez SQL (#207): sekcja „Historia preliminarza” ma „Kopiuj kategorie z innego roku” (`POST /api/ledger/categories/copy` — najpierw podgląd `dryRun`, potem potwierdzenie z listą nowych i pominiętych kategorii; ponowienie niczego nie dubluje). Gdy wczytany rok nie ma żadnej aktywnej kategorii, „Dodaj wpis” jest wyłączony z komunikatem „Brak kategorii dla tego roku”. Zarząd widzi „Wpisz bilans otwarcia” tylko dla roku bez bilansu (`POST /api/ledger/opening-balance`, rachunek i kasa osobno); serwer przyjmuje go wyłącznie dla pierwszego roku w systemie (409 `not_first_school_year`) — kolejne lata dostają bilans z zamknięcia roku. Poprawki bilansu (`/opening-balance/adjustments`) nie mają jeszcze formularza.

Tabela „Wynik wydarzeń” pokazuje przypisania wpisów do wydarzeń (centra kosztów, tylko odczyt, z pozycją „Bez przypisania” i eksportem CSV).

Widok tylko do odczytu dla Komisji Rewizyjnej (D-09, #137): gdy serwer ma flagę `AUDIT_LEDGER_READ=1`, `GET /api/session` zwraca kontu z rolą `audit` pole `capabilities.auditLedgerRead`, a panel pokazuje wyłącznie listę, kategorie, podsumowanie i eksport CSV/XLSX; formularze, przyciski zapisu i sekcje preliminarza są usuwane z DOM. Wpisy powiązane z wpłatą rodziny mają stały opis i znacznik „wpłata rodziny”. Szczegóły: [docs/AUTHORIZATION.md](../docs/AUTHORIZATION.md), „Zakres roli audit”.

Nie używać na danych rzeczywistych przed zatwierdzeniem zasad dostępu, księgowania i korekt.
