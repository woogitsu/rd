# Panel wpłat

Lekki interfejs do chronionego API ewidencji dobrowolnych wpłat. Nie zawiera danych demonstracyjnych ani obejścia uwierzytelniania.

## Uruchomienie

```bash
npm ci && npm run build
DATABASE_URL=postgres://… npm run db:migrate:postgres
DATABASE_URL=postgres://… PORT=3000 npm start
```

Panel i API (dziś na PostgreSQL, `src/pg/routes/payments.js`) muszą działać pod tym samym originem — patrz „Uruchomienie lokalne” w [README głównym](../README.md); żądania używają ciasteczka sesji i serwerowych reguł ról. `npm run dev` + `npm run dev:panel` (Vite, brak proxy `/api`) nie łączą się dziś ze sobą — nadają się wyłącznie do pracy nad samym interfejsem bez API. Stary router Workera (`npm run dev`) ma równoważne trasy `/api/payments*` jako kontrakt równoważności ([docs/EQUIVALENCE.md](../docs/EQUIVALENCE.md)), nie jako droga dev.

## Zakres

- filtrowanie listy po roku szkolnym i statusie,
- rejestracja wpłaty z kluczem idempotencji,
- dopisywanie korekty bez zmiany historycznego rekordu,
- jednokrotne przypisanie nierozpoznanej wpłaty do rodziny,
- kwota netto obliczana jako wpłata plus suma korekt.

Panel celowo nie wylicza zadłużenia: składka jest dobrowolna. Identyfikatory roku i rodziny są na tym etapie wprowadzane ręcznie, dopóki nie powstanie chroniony katalog rodzin i konfiguracja lat szkolnych.
