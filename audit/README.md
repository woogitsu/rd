# Komisja Rewizyjna — raport roczny

Lokalnie uruchom serwer (`npm start`) oraz interfejs (`npm run dev:audit`). Ekran korzysta wyłącznie z istniejącej trasy `GET /api/reports/audit` (src/pg/routes/reconciliation.js); użytkownik musi mieć aktywną sesję, MFA oraz rolę Komisji Rewizyjnej (albo zarządu lub skarbnika) w wybranym roku szkolnym. Kontrolę dostępu wykonuje wyłącznie serwer; ukrycie linku w nawigacji nie jest zabezpieczeniem.

Ekran jest **tylko do odczytu**: pokazuje bilans, kontrole krzyżowe, kategorie, wydatki powyżej 3000 EUR, wykonanie uchwał, weryfikację wydatków, korekty, uzgodnienia i dowody oraz odnośnik do wersji HTML do druku (otwierana w nowej karcie — odpowiedź ma `X-Frame-Options: DENY`, więc nie jest osadzana). Każde wygenerowanie raportu zapisuje zdarzenie `report.audit.generated`. W tabelach nie ma identyfikatorów autorów korekt ani zatwierdzających. Daty mają polski zapis `20.10.2026`, a godziny są w strefie Europe/Brussels. Identyfikatory wpisów księgi są skrócone (`shared/short-id.js`), pełna wartość jest w podpowiedzi komórki (docs/RECONCILIATION.md).

Zakres uprawnień Komisji Rewizyjnej wymaga decyzji zarządu (D-09); ekran odwzorowuje tylko to, co wdrożono po stronie serwera. Prototyp — nie używać na danych rzeczywistych rodzin przed tą decyzją.
