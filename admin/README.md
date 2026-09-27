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
- wygaszenie kadencji zakończonego roku szkolnego (potwierdzenie przez wpisanie identyfikatora),
- dziennik zmian kont i ról (identyfikatory, bez adresów e-mail).

Przyciski wyłączone w interfejsie (np. wycofanie własnego ostatniego przydziału administratora) są tylko podpowiedzią — reguły egzekwuje serwer. Szczegóły i otwarte decyzje: [docs/ACCOUNTS.md](../docs/ACCOUNTS.md).
