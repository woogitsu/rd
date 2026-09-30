# Serwer Node.js dla Railway

Ten etap dodaje wspólny proces HTTP dla Railway. Serwer nasłuchuje na `0.0.0.0:$PORT`, udostępnia zbudowane aplikacje i przekazuje pozostałe żądania do dotychczasowego routera API.

## Uruchomienie lokalne

```bash
npm ci
npm run build
PORT=3000 npm start
```

Dostępne ścieżki (pełna lista `STATIC_PREFIXES` w `src/node-app.js`):

- `/import/` — import uczniów i rodzin,
- `/panel/` — panel składek,
- `/ledger/` — księga,
- `/print/` — kartki o dobrowolnej składce,
- `/events/` — wydarzenia i kalendarz,
- `/documents/` — prywatne dokumenty,
- `/site/` — strona publiczna tylko do odczytu,
- `/meetings/` — zebrania, protokoły i uchwały,
- `/admin/` — konta, zaproszenia i przydziały ról,
- `/families/` — katalog rodzin, uczniów i opiekunów,
- `/login/` — ekran logowania (`/` przekierowuje tutaj),
- `/email/` — korespondencja i kampanie,
- `/reconciliation/` — uzgodnienie z wyciągiem bankowym,
- `/year-close/` — zamknięcie roku szkolnego,
- `/data-export/` — eksport roczny i lista klasy (pobranie, weryfikacja),
- `/news/` — aktualności: szkic, zatwierdzenie, publikacja, wycofanie (rejestr zdjęć tylko do odczytu),
- `/audit/` — raport roczny dla Komisji Rewizyjnej (tylko odczyt),
- `/health` — liveness: wyłącznie techniczny status procesu (`{"status":"ok"}`), bez danych użytkowników i bez zapytań do bazy,
- `/health/ready` — readiness: stan bazy i migracji (opis niżej); `200` gdy gotowy, `503` gdy nie.

Brakujący plik zwraca odpowiedź `404`; serwer nie zastępuje go plikiem `index.html`. Mapy źródłowe (`*.map`), pliki ukryte i ścieżki wychodzące poza `dist/` nie są publikowane. Odpowiedzi HTML i API mają `Cache-Control: no-store`, a statyczne zasoby mają krótki cache wynoszący godzinę.

## Zmienne środowiskowe

| Zmienna | Wymagana | Znaczenie |
|---|---:|---|
| `PORT` | na Railway | Port przydzielony procesowi; lokalnie domyślnie `3000` |
| `PUBLIC_BASE_URL` | obowiązkowa poza development/test | Publiczny adres bazowy (`https://host` bez ścieżki) używany przy tworzeniu obiektu `Request`; bez niej za proxy TLS zapisy kończą się `403 invalid_origin`. Serwer nie startuje z `APP_ENV` innym niż lokalny bez poprawnej wartości — [RAILWAY_OPERATIONS.md](RAILWAY_OPERATIONS.md#walidacja-konfiguracji-przy-starcie-114) |
| `MFA_ENCRYPTION_KEY`, `TRUST_PROXY`, `BREVO_WEBHOOK_SECRET` | obowiązkowe poza development/test | Sprawdzane przy starcie tak samo jak `PUBLIC_BASE_URL` (`validateConfig`, `src/config.js`) |
| `DATABASE_URL` | opcjonalna | Gdy ustawiona, API obsługuje router PostgreSQL (`src/pg/app.js`); bez niej działa dotychczasowy router Workera |
| `PG_POOL_MAX` | opcjonalna | Maksymalna liczba połączeń w puli (domyślnie 10, najwyżej 50) |
| `PG_STATEMENT_TIMEOUT_MS` | opcjonalna | Limit czasu pojedynczego zapytania (domyślnie 10000 ms) |
| `PG_LOCK_TIMEOUT_MS` | opcjonalna | `lock_timeout` każdej transakcji (domyślnie 3000 ms, najwyżej 60000): oczekiwanie na blokadę wiersza kończy się `503 retry_later` zamiast dopiero po limicie zapytania — [API_ERRORS.md](API_ERRORS.md#błędy-bazy-w-routerze-klasy-ponowienia-limity-156) |
| `BUCKET_*`, `DOCUMENT_MAX_BYTES` | opcjonalne | Prywatny Storage Bucket i limit pliku — [DOCUMENTS.md](DOCUMENTS.md) |
| `LOG_LEVEL` | opcjonalna | `debug`, `info` (domyślnie), `warn`, `error` lub `silent` |
| `SHUTDOWN_TIMEOUT_MS` | opcjonalna | Maksymalny czas łagodnego zamknięcia po SIGTERM (domyślnie 10000 ms); musi być krótszy niż `drainingSeconds` w `railway.json` |
| `METRICS_LOG_INTERVAL_MS` | opcjonalna | Co ile zapisywać liczniki żądań do logu (domyślnie 300000 ms = 5 min) |
| `DOCUMENT_MAX_CONCURRENT_UPLOADS` | opcjonalna | Limit równoczesnych `POST /api/documents` i `POST /api/news-photos/:id/file` na proces (domyślnie 4; dodatkowo 2 na użytkownika) — [DOCUMENTS.md](DOCUMENTS.md) |

**Limity połączenia (#185).** `server.requestTimeout` (120 s) i `server.headersTimeout` (60 s) są ustawiane na stałe w `startServer` (`src/server.js`, `DEFAULT_REQUEST_TIMEOUT_MS`/`DEFAULT_HEADERS_TIMEOUT_MS`) — bez tego wolny albo złośliwy klient trzymałby bufor żądania (i gniazdo) bez ograniczenia czasowego. Bez osobnej zmiennej środowiskowej na razie; do zmiany bezpośrednio w kodzie, jeśli okaże się to za krótkie/za długie na stagingu.

Sekrety i `DATABASE_URL` nie są potrzebne do testu samego serwera. Serwer **nie** uruchamia migracji przy starcie; schemat nakłada się ręcznie (`npm run db:migrate:postgres`).

## API na PostgreSQL (issue #35)

`src/db.js` (`createPgDatabase`) opakowuje ograniczoną pulę `pg.Pool` (limity połączeń, bezczynności i czasu zapytania) i udostępnia `query(sql, params)`, `transaction(async tx => …)` i `close()` — ten sam kształt co PGlite w testach. `src/pg/app.js` zawiera rejestr modułów tras (`ROUTES`); każdy moduł eksportuje `name` i `handle(request, env, url, json)` zwracające `Response` albo `null`. Router sprawdza zgodność `Origin` dla metod zmieniających stan, a błędy loguje bez danych osobowych i zwraca `503 service_unavailable`. Aktualna lista modułów jest w `ROUTES`; każdy moduł ma własny opis w `docs/` (m.in. [PAYMENTS.md](PAYMENTS.md), [LEDGER.md](LEDGER.md) — w tym eksport CSV księgi, [DOCUMENTS.md](DOCUMENTS.md), [EVENTS.md](EVENTS.md), [MEETINGS.md](MEETINGS.md), [EMAIL.md](EMAIL.md) — kampanie e-mail `/api/email/…` z webhookiem Brevo (issue #40); trasy niczego nie wysyłają, robi to wyłącznie `npm run email:worker`).

## Monitoring, logi i zamykanie (#16, #41)

**Liveness i readiness.** `/health` odpowiada bez sprawdzania bazy — Railway używa go jako healthchecku deployu (`railway.json`), aby chwilowa niedostępność bazy lub brak migracji nie powodował pętli restartów ani odrzucenia deployu, który sam z siebie jest poprawny. `/health/ready` (`src/health.js`) jest przeznaczony dla zewnętrznego monitora i ręcznej kontroli po deployu/migracji:

1. gdy `env.db` nie istnieje (brak `DATABASE_URL`) — `503` i `checks.database: "not_configured"`,
2. `SELECT 1` z limitem 2 s — przy błędzie `503` i `database: "error"`, przy przekroczeniu czasu `database: "timeout"`,
   Limit jest realny po stronie bazy (#244): sonda działa przez `db.probe` (`src/db.js`) na jednym własnym połączeniu, w transakcji z `SET LOCAL statement_timeout`/`lock_timeout` równym pozostałemu budżetowi 2 s, więc PostgreSQL sam anuluje zapytanie, a połączenie wraca do puli po ≤ 2 s (nie po `statement_timeout` puli, 10 s). Równoległe sondy dzielą jedno sprawdzenie (single-flight), a sonda uruchomiona, gdy poprzednia jeszcze trwa, kończy się `database: "timeout"` bez zajmowania kolejnego połączenia ani miejsca w kolejce puli. Atrapy i PGlite (bez `probe`) używają samego wyścigu z czasem.
3. porównanie `schema_migrations` z plikami `postgres/migrations/*.sql` — przy brakach `503`, `migrations: "pending"` oraz liczba i nazwy brakujących plików migracji,
4. w trakcie zamykania procesu — `503` i `checks.server: "shutting_down"`.

Odpowiedź nigdy nie zawiera danych z tabel, adresu bazy ani treści błędu; w logu zapisywany jest wyłącznie kod techniczny (np. `ECONNREFUSED`). Nazwy migracji to nazwy plików z publicznego repozytorium. Punkt nie wymaga logowania, dlatego nie ujawnia niczego ponad stan techniczny.

**Logi strukturalne.** `src/log.js` zapisuje jedną linię JSON na zdarzenie (stdout dla `debug`/`info`, stderr dla `warn`/`error`): `time`, `level`, `event` (kod zdarzenia, np. `http_request`, `api_route_error`, `db_idle_client_error`, `readiness_database_error`, `server_shutdown_timeout`), `message` (= `event`, dla widoku logów Railway) i pola techniczne (`method`, `path`, `status`, `duration_ms`, `module`, `code`). Każdy wpis przechodzi przez warstwę redakcji:

- pola o nazwach wskazujących na dane osobowe lub sekrety (e-mail, imię, nazwisko, telefon, adres, IBAN/konto, cookie, nagłówki, token, sesja, hasło, treść, `query`, `body`) są usuwane; wpis podaje tylko ich liczbę (`redacted`),
- w wartościach tekstowych obcinany jest query string i fragment URL, a adresy e-mail, numery podobne do IBAN, nagłówki `Bearer`, JWT, pary `session=…`/`token=…` i długie losowe ciągi są zastępowane znacznikami (`[email]`, `[iban]`, `[token]`),
- błędy są zapisywane jako `{ code, kind }` bez `message`/`detail`.

Redakcja jest zabezpieczeniem dodatkowym — kod nadal nie może przekazywać do logu ciał żądań, danych rodzin ani treści wiadomości.

**Log żądań.** `src/node-app.js` po zakończeniu każdej odpowiedzi zapisuje `http_request` z metodą, ścieżką bez query stringu, w której segmenty podobne do identyfikatorów (liczby, UUID, ciągi z cyframi, adresy e-mail) są zastąpione `:id`, statusem i czasem w ms. Nie zapisuje nagłówków, cookies, adresu IP ani ciał. Sondy `/health` i `/health/ready` są logowane na poziomie `debug`, odpowiedzi 5xx na poziomie `error`, przerwane połączenia (`status: 0`) na poziomie `warn`.

**Liczniki.** Proces liczy żądania według klasy statusu (2xx–5xx) oraz czas średni i maksymalny, a co `METRICS_LOG_INTERVAL_MS` zapisuje zdarzenie `http_metrics` i zeruje liczniki (okresy bez ruchu są pomijane). Zdarzenie zawiera też `login_queue_depth` i `login_busy_total` kolejki scrypt (#203, patrz docs/AUTH.md). Liczniki nie są wystawiane przez HTTP — nie ma publicznego punktu metryk, więc nie trzeba go chronić.

**Zamykanie.** Po SIGTERM/SIGINT serwer przestaje przyjmować połączenia, `/health/ready` zwraca `503`, trwające żądania są kończone, bezczynne połączenia keep-alive zamykane, a następnie zamykana jest pula PostgreSQL (`db.close()`). Po `SHUTDOWN_TIMEOUT_MS` pozostałe połączenia są zamykane siłą i proces kończy się kodem 1. Railway domyślnie wysyła SIGKILL zaraz po SIGTERM, dlatego `railway.json` ustawia `drainingSeconds: 15`, a start odbywa się bezpośrednio przez `node src/server.js` (npm nie przekazuje sygnału do procesu potomnego).

## Granice tego etapu

Serwer statyczny i punkt `/health` są gotowe do testów. Bez `DATABASE_URL` serwer uruchamia stary router Workera (`src/index.js`) bez żadnego bindingu D1 (nie ma adaptera Worker/D1 w Node — `env = {}`): `/health`, sesja i przydziały działają, ale każda chroniona trasa (wpłaty, księga) zwraca `503`, bo nie ma bazy do odpytania. Z `DATABASE_URL` działa router PostgreSQL (`src/pg/app.js`) z sesjami, rolami (issue #35) i 27 modułami tras — wpłaty (#37), księga (#38) i pozostałe wymienione w README; nie jest wdrożony ani zatwierdzony do pracy na danych rodzin. Z tego powodu ten etap nie uruchamia wdrożenia produkcyjnego ani nie konfiguruje publicznej domeny.

Testy HTTP sprawdzają przekierowania, pliki statyczne, nagłówki bezpieczeństwa, brak publikacji map źródłowych, odpowiedzi `404`, brak cache API oraz limit ciała żądania 1 MiB. Wyjątek: `POST /api/documents` ma własny limit `DOCUMENT_MAX_BYTES` (domyślnie 10 MiB), a `POST /api/news-photos/:id/file` 10 MiB, ustawiane przez `bodyLimit` w `createNodeHandler`. Ciało tych dwóch tras nie jest buforowane przed wywołaniem trasy (`isStreamedUploadRoute`, #185); `tests/node-upload-memory.test.js` mierzy bajty odebrane przez serwer i wzrost `arrayBuffers` przy 20 równoległych anonimowych żądaniach po 10 MB.
