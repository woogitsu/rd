# Panel księgi

Uruchom razem z API według „Uruchomienie lokalne” w [README głównym](../README.md) (`npm ci && npm run build`, `DATABASE_URL=… npm run db:migrate:postgres`, `DATABASE_URL=… PORT=3000 npm start`) — `npm run dev` (Worker) + `npm run dev:ledger` (Vite) nie są dziś połączone (brak proxy `/api`). Panel nie ma danych demonstracyjnych i korzysta wyłącznie z chronionych tras `/api/ledger`; użytkownik musi mieć aktywną sesję, MFA, rolę finansową oraz dostęp do wskazanego roku.

Panel udostępnia podsumowanie roku, aktualny preliminarz, filtrowaną listę wpisów, formularz przychodu lub wydatku oraz addytywne korekty. Wydatek można powiązać z uchwałą wybraną z listy przyjętych uchwał zebrań ogólnych (bieżący i poprzedni rok; numer, tytuł i kwoty, bez treści); powyżej 3000 EUR wybór jest wymagany. Panel pokazuje limit upoważnienia i pozostałą kwotę, a przekroczenie odrzuca serwer (409). Identyfikator dokumentu można podać wyłącznie dla dokumentu już utworzonego w chronionym magazynie — przesyłanie plików będzie osobnym etapem.

Nie używać na danych rzeczywistych przed zatwierdzeniem zasad dostępu, księgowania i korekt.
