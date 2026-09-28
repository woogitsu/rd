# Panel uzgodnień wyciągu bankowego

Lokalnie uruchom serwer (`npm start`) oraz interfejs (`npm run dev:reconciliation`). Panel korzysta wyłącznie z chronionych tras `/api/reconciliations/*` i `/api/reports/audit` (src/pg/routes/reconciliation.js); użytkownik musi mieć aktywną sesję, MFA i rolę administratora, zarządu lub skarbnika w wybranym roku szkolnym.

Ekran pokazuje listę uzgodnień roku, saldo z wyciągu i wyliczone saldo księgi, import pozycji wyciągu z pliku CSV (data, kwota, tytuł — tytuł zapisywany wyłącznie jako solony skrót), propozycje dopasowań (nigdy automatyczne zatwierdzenie), cofnięcie dopasowania z powodem i potwierdzenie uzgodnienia zgodnie z zasadą czterech oczu (potwierdza inna osoba niż ta, która je utworzyła). Różnica salda wymaga wyjaśnienia przed potwierdzeniem. Link do raportu dla Komisji Rewizyjnej (`GET /api/reports/audit?format=html`) otwiera osobną kartę — sam raport jest osobnym, istniejącym ekranem HTML renderowanym przez serwer.

Prototyp — nie używać na danych rzeczywistych przed decyzją zarządu o banku i rozliczaniu wpłat (D-13).
