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
- tabela przydziałów ról z filtrami (konto, rola, rok, klasa, status) i wycofaniem po potwierdzeniu,
- nadanie roli z zakresem roku/klasy i opcjonalną datą wygaśnięcia,
- zaproszenie: token pokazywany jeden raz, z przyciskiem kopiowania i ostrzeżeniem; panel nie wysyła e-maili,
- lata szkolne i klasy (#207, trasy #78): tabela lat z klasami, utworzenie nowego roku (`POST /api/admin/school-years`) i dodanie klas (`POST /api/admin/school-years/:id/classes`) po potwierdzeniu; bez usuwania i zmiany nazw. Promocja uczniów i kopiowanie klas z podglądem mają dziś wyłącznie API (`/api/admin/promotions/*`; zakładka „Nowy rok” — #78),
- wygaszenie kadencji zakończonego roku szkolnego (potwierdzenie przez wpisanie identyfikatora),
- dziennik zmian kont i ról (identyfikatory, bez adresów e-mail).
- sekcja „Stan systemu” (#149, `ops-status.js`): tabela na podstawie `GET /api/admin/ops-status` (migracje, worker e-mail, kolejka, kopie, eksport, tryb pracy, wersja); tylko liczby, znaczniki czasu i kody, „brak danych” osobno od „w normie”. Runbook incydentów: [docs/RUNBOOK.md](../docs/RUNBOOK.md).

Przyciski wyłączone w interfejsie (np. wycofanie własnego ostatniego przydziału administratora) są tylko podpowiedzią — reguły egzekwuje serwer. Szczegóły i otwarte decyzje: [docs/ACCOUNTS.md](../docs/ACCOUNTS.md).
