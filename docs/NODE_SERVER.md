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
- `/health` — liveness: wyłącznie techniczny status procesu (`{"status":"ok"}`), bez danych użytkowników i bez zapytań do bazy,
- `/health/ready` — readiness: stan bazy i migracji (opis niżej); `200` gdy gotowy, `503` gdy nie.

Brakujący plik zwraca odpowiedź `404`; serwer nie zastępuje go plikiem `index.html`. Mapy źródłowe (`*.map`), pliki ukryte i ścieżki wychodzące poza `dist/` nie są publikowane. Odpowiedzi HTML i API mają `Cache-Control: no-store`, a statyczne zasoby mają krótki cache wynoszący godzinę.

## Zmienne środowiskowe

| Zmienna | Wymagana | Znaczenie |
|---|---:|---|
| `PORT` | na Railway | Port przydzielony procesowi; lokalnie domyślnie `3000` |
| `PUBLIC_BASE_URL` | opcjonalna | Publiczny adres bazowy używany przy tworzeniu obiektu `Request` |
| `DATABASE_URL` | opcjonalna | Gdy ustawiona, API obsługuje router PostgreSQL (`src/pg/app.js`); bez niej działa dotychczasowy router Workera |
| `PG_POOL_MAX` | opcjonalna | Maksymalna liczba połączeń w puli (domyślnie 10, najwyżej 50) |
| `PG_STATEMENT_TIMEOUT_MS` | opcjonalna | Limit czasu pojedynczego zapytania (domyślnie 10000 ms) |
| `BUCKET_*`, `DOCUMENT_MAX_BYTES` | opcjonalne | Prywatny Storage Bucket i limit pliku — [DOCUMENTS.md](DOCUMENTS.md) |
| `LOG_LEVEL` | opcjonalna | `debug`, `info` (domyślnie), `warn`, `error` lub `silent` |
| `SHUTDOWN_TIMEOUT_MS` | opcjonalna | Maksymalny czas łagodnego zamknięcia po SIGTERM (domyślnie 10000 ms); musi być krótszy niż `drainingSeconds` w `railway.json` |
| `METRICS_LOG_INTERVAL_MS` | opcjonalna | Co ile zapisywać liczniki żądań do logu (domyślnie 300000 ms = 5 min) |

Sekrety i `DATABASE_URL` nie są potrzebne do testu samego serwera. Serwer **nie** uruchamia migracji przy starcie; schemat nakłada się ręcznie (`npm run db:migrate:postgres`).

## API na PostgreSQL (issue #35)

`src/db.js` (`createPgDatabase`) opakowuje ograniczoną pulę `pg.Pool` (limity połączeń, bezczynności i czasu zapytania) i udostępnia `query(sql, params)`, `transaction(async tx => …)` i `close()` — ten sam kształt co PGlite w testach. `src/pg/app.js` zawiera rejestr modułów tras (`ROUTES`); każdy moduł eksportuje `name` i `handle(request, env, url, json)` zwracające `Response` albo `null`. Router sprawdza zgodność `Origin` dla metod zmieniających stan, a błędy loguje bez danych osobowych i zwraca `503 service_unavailable`. Aktualna lista modułów jest w `ROUTES`; każdy moduł ma własny opis w `docs/` (m.in. [PAYMENTS.md](PAYMENTS.md), [LEDGER.md](LEDGER.md) — w tym eksport CSV księgi, [DOCUMENTS.md](DOCUMENTS.md), [EVENTS.md](EVENTS.md), [MEETINGS.md](MEETINGS.md), [EMAIL.md](EMAIL.md) — kampanie e-mail `/api/email/…` z webhookiem Brevo (issue #40); trasy niczego nie wysyłają, robi to wyłącznie `npm run email:worker`).

## Monitoring, logi i zamykanie (#16, #41)

**Liveness i readiness.** `/health` odpowiada bez sprawdzania bazy — Railway używa go jako healthchecku deployu (`railway.json`), aby chwilowa niedostępność bazy lub brak migracji nie powodował pętli restartów ani odrzucenia deployu, który sam z siebie jest poprawny. `/health/ready` (`src/health.js`) jest przeznaczony dla zewnętrznego monitora i ręcznej kontroli po deployu/migracji:

1. gdy `env.db` nie istnieje (brak `DATABASE_URL`) — `503` i `checks.database: "not_configured"`,
2. `SELECT 1` z limitem 2 s — przy błędzie `503` i `database: "error"`, przy przekroczeniu czasu `database: "timeout"`,
3. porównanie `schema_migrations` z plikami `postgres/migrations/*.sql` — przy brakach `503`, `migrations: "pending"` oraz liczba i nazwy brakujących plików migracji,
4. w trakcie zamykania procesu — `503` i `checks.server: "shutting_down"`.

Odpowiedź nigdy nie zawiera danych z tabel, adresu bazy ani treści błędu; w logu zapisywany jest wyłącznie kod techniczny (np. `ECONNREFUSED`). Nazwy migracji to nazwy plików z publicznego repozytorium. Punkt nie wymaga logowania, dlatego nie ujawnia niczego ponad stan techniczny.

**Logi strukturalne.** `src/log.js` zapisuje jedną linię JSON na zdarzenie (stdout dla `debug`/`info`, stderr dla `warn`/`error`): `time`, `level`, `event` (kod zdarzenia, np. `http_request`, `api_route_error`, `db_idle_client_error`, `readiness_database_error`, `server_shutdown_timeout`), `message` (= `event`, dla widoku logów Railway) i pola techniczne (`method`, `path`, `status`, `duration_ms`, `module`, `code`). Każdy wpis przechodzi przez warstwę redakcji:

- pola o nazwach wskazujących na dane osobowe lub sekrety (e-mail, imię, nazwisko, telefon, adres, IBAN/konto, cookie, nagłówki, token, sesja, hasło, treść, `query`, `body`) są usuwane; wpis podaje tylko ich liczbę (`redacted`),
- w wartościach tekstowych obcinany jest query string i fragment URL, a adresy e-mail, numery podobne do IBAN, nagłówki `Bearer`, JWT, pary `session=…`/`token=…` i długie losowe ciągi są zastępowane znacznikami (`[email]`, `[iban]`, `[token]`),
- błędy są zapisywane jako `{ code, kind }` bez `message`/`detail`.

Redakcja jest zabezpieczeniem dodatkowym — kod nadal nie może przekazywać do logu ciał żądań, danych rodzin ani treści wiadomości.

**Log żądań.** `src/node-app.js` po zakończeniu każdej odpowiedzi zapisuje `http_request` z metodą, ścieżką bez query stringu, w której segmenty podobne do identyfikatorów (liczby, UUID, ciągi z cyframi, adresy e-mail) są zastąpione `:id`, statusem i czasem w ms. Nie zapisuje nagłówków, cookies, adresu IP ani ciał. Sondy `/health` i `/health/ready` są logowane na poziomie `debug`, odpowiedzi 5xx na poziomie `error`, przerwane połączenia (`status: 0`) na poziomie `warn`.

**Liczniki.** Proces liczy żądania według klasy statusu (2xx–5xx) oraz czas średni i maksymalny, a co `METRICS_LOG_INTERVAL_MS` zapisuje zdarzenie `http_metrics` i zeruje liczniki (okresy bez ruchu są pomijane). Liczniki nie są wystawiane przez HTTP — nie ma publicznego punktu metryk, więc nie trzeba go chronić.

**Zamykanie.** Po SIGTERM/SIGINT serwer przestaje przyjmować połączenia, `/health/ready` zwraca `503`, trwające żądania są kończone, bezczynne połączenia keep-alive zamykane, a następnie zamykana jest pula PostgreSQL (`db.close()`). Po `SHUTDOWN_TIMEOUT_MS` pozostałe połączenia są zamykane siłą i proces kończy się kodem 1. Railway domyślnie wysyła SIGKILL zaraz po SIGTERM, dlatego `railway.json` ustawia `drainingSeconds: 15`, a start odbywa się bezpośrednio przez `node src/server.js` (npm nie przekazuje sygnału do procesu potomnego).

## Granice tego etapu

Serwer statyczny i punkt `/health` są gotowe do testów. Bez `DATABASE_URL` chronione API korzysta z adaptera Worker/D1. Z `DATABASE_URL` działa prototyp routera PostgreSQL z sesjami i rolami (issue #35) oraz trasami wpłat (issue #37) i księgi (issue #38); nie jest wdrożony ani zatwierdzony do pracy na danych rodzin. Z tego powodu ten etap nie uruchamia wdrożenia produkcyjnego ani nie konfiguruje publicznej domeny.

Testy HTTP sprawdzają przekierowania, pliki statyczne, nagłówki bezpieczeństwa, brak publikacji map źródłowych, odpowiedzi `404`, brak cache API oraz limit ciała żądania 1 MiB. Wyjątek: `POST /api/documents` ma własny limit `DOCUMENT_MAX_BYTES` (domyślnie 10 MiB), ustawiany przez `bodyLimit` w `createNodeHandler`.
