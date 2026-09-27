# Serwer Node.js dla Railway

Ten etap dodaje wspólny proces HTTP dla Railway. Serwer nasłuchuje na `0.0.0.0:$PORT`, udostępnia zbudowane aplikacje i przekazuje pozostałe żądania do dotychczasowego routera API.

## Uruchomienie lokalne

```bash
npm ci
npm run build
PORT=3000 npm start
```

Dostępne ścieżki:

- `/import/` — import uczniów i rodzin,
- `/panel/` — panel składek,
- `/ledger/` — księga,
- `/health` — wyłącznie techniczny status procesu (`{"status":"ok"}`), bez danych użytkowników.

Brakujący plik zwraca odpowiedź `404`; serwer nie zastępuje go plikiem `index.html`. Mapy źródłowe (`*.map`), pliki ukryte i ścieżki wychodzące poza `dist/` nie są publikowane. Odpowiedzi HTML i API mają `Cache-Control: no-store`, a statyczne zasoby mają krótki cache wynoszący godzinę.

## Zmienne środowiskowe

| Zmienna | Wymagana | Znaczenie |
|---|---:|---|
| `PORT` | na Railway | Port przydzielony procesowi; lokalnie domyślnie `3000` |
| `PUBLIC_BASE_URL` | opcjonalna | Publiczny adres bazowy używany przy tworzeniu obiektu `Request` |
| `DATABASE_URL` | opcjonalna | Gdy ustawiona, API obsługuje router PostgreSQL (`src/pg/app.js`); bez niej działa dotychczasowy router Workera |
| `PG_POOL_MAX` | opcjonalna | Maksymalna liczba połączeń w puli (domyślnie 10, najwyżej 50) |
| `PG_STATEMENT_TIMEOUT_MS` | opcjonalna | Limit czasu pojedynczego zapytania (domyślnie 10000 ms) |

Sekrety i `DATABASE_URL` nie są potrzebne do testu samego serwera. Serwer **nie** uruchamia migracji przy starcie; schemat nakłada się ręcznie (`npm run db:migrate:postgres`).

## API na PostgreSQL (issue #35)

`src/db.js` (`createPgDatabase`) opakowuje ograniczoną pulę `pg.Pool` (limity połączeń, bezczynności i czasu zapytania) i udostępnia `query(sql, params)`, `transaction(async tx => …)` i `close()` — ten sam kształt co PGlite w testach. `src/pg/app.js` zawiera rejestr modułów tras (`ROUTES`); każdy moduł eksportuje `name` i `handle(request, env, url, json)` zwracające `Response` albo `null`. Router sprawdza zgodność `Origin` dla metod zmieniających stan, a błędy loguje bez danych osobowych i zwraca `503 service_unavailable`. Na razie zawiera `/health`, `/api/session`, `/api/access` i `/api/logout`; wpłaty i księga pozostają w starym routerze do czasu #37/#38.

## Granice tego etapu

Serwer statyczny i punkt `/health` są gotowe do testów. Bez `DATABASE_URL` chronione API korzysta z adaptera Worker/D1. Z `DATABASE_URL` działa prototyp routera PostgreSQL z sesjami i rolami (issue #35), bez tras finansowych; nie jest wdrożony ani zatwierdzony do pracy na danych rodzin. Z tego powodu ten etap nie uruchamia wdrożenia produkcyjnego ani nie konfiguruje publicznej domeny.

Testy HTTP sprawdzają przekierowania, pliki statyczne, nagłówki bezpieczeństwa, brak publikacji map źródłowych, odpowiedzi `404`, brak cache API oraz limit ciała żądania 1 MiB.
