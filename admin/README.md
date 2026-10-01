# Panel kont i ról

Lekki interfejs do chronionego API `/api/admin/*` (src/pg/routes/admin.js). Prototyp na danych syntetycznych; nie zawiera danych demonstracyjnych ani obejścia logowania.

## Uruchomienie

```bash
npm run dev:admin      # Vite, sam interfejs
npm run build:admin    # dist/admin, serwowane przez src/node-app.js pod /admin/
```

API działa na serwerze Node (PostgreSQL). Panel i API muszą działać pod tym samym originem — żądania używają ciasteczka sesji, a serwer odrzuca POST bez zgodnego nagłówka `Origin`.

## Zakres

- tabela kont (e-mail, nazwa, status, liczba aktywnych ról i sesji), wyłączanie i włączanie konta, wylogowanie ze wszystkich urządzeń,
- wnioski o nadanie roli chronionej (#146, `GET /api/admin/grant-requests`, `…/{id}/approve|reject`): kto wnioskuje, dla kogo, rola, zakres i wiek wniosku; „Zatwierdź” w oknie ze skutkami i z krokiem w górę MFA, niedostępne przy własnym wniosku i wniosku o własne konto (reguły egzekwuje serwer); link zaproszenia z zatwierdzenia pokazany raz, wyłącznie w pamięci strony; „Odrzuć” (albo „Wycofaj wniosek” dla własnego) bez pola powodu,
- tabela przydziałów ról z filtrami (konto, rola, rok, klasa, status) i wycofaniem po potwierdzeniu,
- nadanie roli z zakresem roku/klasy i opcjonalną datą wygaśnięcia,
- zaproszenie: token pokazywany jeden raz, z przyciskiem kopiowania i ostrzeżeniem; panel nie wysyła e-maili,
- „Wyślij ponownie” przy oczekującym zaproszeniu (#108, `POST /api/admin/invitations/:id/reissue`): stary link przestaje działać, nowy jest pokazany raz,
- obsada klas roku (#108, `GET /api/admin/class-coverage`): przedstawiciele, oczekujące zaproszenia, najbliższe wygaśnięcie i data ostatniego logowania — bez adresów e-mail,
- zaproszenia zbiorcze przedstawicieli (#108, `POST /api/admin/invitation-batches/preview|apply`, `onboarding.js`): wklejone wiersze `klasa; e-mail`, podgląd z numerem wiersza przy błędzie, jedno zatwierdzenie z kluczem partii (podwójne kliknięcie i ponowienie nie tworzą drugiej partii), linki pokazane raz jako lista do skopiowania i kartki do wydruku z projektem instrukcji pierwszego logowania (treść do zatwierdzenia przez zarząd). Linki istnieją wyłącznie w pamięci strony: „Zamknij”, wydruk i opuszczenie strony usuwają je z DOM; panel nie wysyła e-maili,
- lata szkolne i klasy (#207, trasy #78): tabela lat z klasami, utworzenie nowego roku (`POST /api/admin/school-years`) i dodanie klas (`POST /api/admin/school-years/:id/classes`) po potwierdzeniu; bez usuwania i zmiany nazw. Sekcja „Nowy rok: promocja uczniów” (#78, `admin/promotion.js`): mapa klas (klasa docelowa, „klasa końcowa” albo „nie przenoś”), wykluczenia po identyfikatorach uczniów, podgląd (`POST /api/admin/promotions/preview`) z licznościami per klasa, bez imion, oraz zatwierdzenie z potwierdzeniem (`/promotions/apply`, jeden `Idempotency-Key` na podgląd, `planDigest`; przy `plan_stale` podgląd trzeba wygenerować od nowa). Kopiowanie klas (`/promotions/classes/*`) i przedłużanie przydziałów przedstawicieli nie mają ekranu: API promocji tylko wskazuje klasy bez przedstawiciela, a nowych przedstawicieli zaprasza się partią zaproszeń,
- wygaszenie kadencji zakończonego roku szkolnego (potwierdzenie przez wpisanie identyfikatora),
- żądania osób, których dane dotyczą (#100, `admin/data-requests.js`; `GET/POST /api/admin/data-requests`, `…/{id}/status`, `…/{id}/export`): lista z filtrem stanu i rodzaju oraz kursorem, rejestracja żądania, zmiana stanu do przodu po potwierdzeniu, eksport danych rodziny JSON/CSV (tylko dostęp i przenoszenie, po potwierdzeniu tożsamości) z oknem ostrzeżenia o danych osobowych i krokiem w górę MFA; plik tylko do pobrania, bez zapisu w przeglądarce i bez logów. Szczegóły i otwarte decyzje D-07: [docs/DATA_REQUESTS.md](../docs/DATA_REQUESTS.md),
- anonimizacja gospodarstwa (#91, `admin/anonymization.js`; `POST /api/admin/anonymizations`, wyłącznie administrator z MFA, kontrola po stronie serwera, 403 → komunikat o braku uprawnień): formularz (powód: żądanie usunięcia z rejestru „Żądania osób” albo okres retencji; identyfikator gospodarstwa i żądania), podgląd `dryRun` z licznikami per kategoria i liczbą osób wspólnych z innymi gospodarstwami (bez imion, e-maili i tekstów), wykonanie dopiero po oknie z opisem nieodwracalnego skutku i przepisaniu identyfikatora gospodarstwa (`confirm`), z `expectedPlanSha256` z podglądu (dane zmienione od podglądu → trzeba powtórzyć podgląd). Przyciski są blokowane na czas żądania; API nie używa `Idempotency-Key` — powtórzenie jest idempotentne po stronie serwera (`replayed`), więc panel go nie wysyła. „Historia przebiegów” czyta `GET /api/admin/anonymizations` (identyfikatory, kod powodu, suma zmian, skrót planu, wykonawca; „Pokaż więcej” dociąga kolejne strony po `nextCursor`). Powód „okres retencji” serwer odrzuca do czasu zatwierdzenia polityk (D-04). Szczegóły: [docs/RETENTION.md](../docs/RETENTION.md),
- dziennik zmian kont i ról (identyfikatory, bez adresów e-mail).
- sekcja „Stan systemu” (#149, `ops-status.js`): tabela na podstawie `GET /api/admin/ops-status` (migracje, worker e-mail, kolejka, kopie, eksport, tryb pracy, wersja); tylko liczby, znaczniki czasu i kody, „brak danych” osobno od „w normie”. Runbook incydentów: [docs/RUNBOOK.md](../docs/RUNBOOK.md).

Przyciski wyłączone w interfejsie (np. wycofanie własnego ostatniego przydziału administratora) są tylko podpowiedzią — reguły egzekwuje serwer. Szczegóły i otwarte decyzje: [docs/ACCOUNTS.md](../docs/ACCOUNTS.md).
