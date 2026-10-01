# Railway — środowiska, backup, monitoring i odbiór

Status: konfiguracja w repozytorium i procedury **do wykonania**. Nie utworzono
projektu Railway, nie wykonano deployu, backupu ani próbnego odtworzenia.
Produkcyjne uruchomienie wymaga osobnej decyzji szkoły i IOD
([D-20 w rejestrze decyzji](DECISIONS.md)). Zakres: issue #41 oraz część
monitoringu z #16. Kontekst: [plan migracji](RAILWAY_MIGRATION.md),
[serwer Node](NODE_SERVER.md), [przeniesienie D1](D1_POSTGRES_MIGRATION.md),
[runbook incydentów](RUNBOOK.md) (#149: reakcja na typowe zdarzenia, szablon
protokołu, `/api/admin/ops-status` i `/health/jobs`).

## Co jest w repozytorium

| Element | Plik | Znaczenie |
|---|---|---|
| Konfiguracja usługi | `railway.json` | build `npm ci && npm run build`, start `node src/server.js` (bezpośrednio, aby SIGTERM trafił do serwera), healthcheck `/health` (liveness), `drainingSeconds: 15`, restart `ON_FAILURE` (maks. 5 prób), region `europe-west4-drams3a` (Amsterdam), bez usypiania |
| Usługa cron e-mail | `railway.email-worker.json` | osobna usługa (#130): build `npm ci`, start `node scripts/email-worker.js` (**dry-run**, bez `--send`), `cronSchedule` `15 * * * *`, restart `NEVER`, region `europe-west4-drams3a`; nie jest utworzona w żadnym środowisku (sekcja „Zadanie wysyłki e-mail”) |
| Test konfiguracji | `tests/railway-config.test.js` | brak migracji/odtworzenia przy starcie, brak sekretów, region UE; usługa cron e-mail bez `--send` i bez restartu |
| Smoke test | `npm run smoke` (`scripts/smoke-postgres.js`) | migracje na PGlite w pamięci (dwukrotnie, druga bez zmian), readiness po migracjach, serwer na losowym porcie `127.0.0.1`, `/health`, `/health/ready` bez bazy (`503`) i przez prawdziwy HTTP z migracjami (`200`), wszystkich 17 paneli (`STATIC_PREFIXES`), nagłówki, `404` dla ścieżek prywatnych/traversal i brak `*.map`, granice ról na poziomie HTTP |
| Smoke test zdalny | `npm run smoke:remote` (`scripts/smoke-remote.js`) | wyłącznie `GET`, po deployu stagingu (sekcja „Smoke test po deployu” niżej) |
| Test wolumenu | `tests/postgres-volume.test.js` | 1000 uczniów, 2000 kontaktów opiekunów, 50 użytkowników z uprawnieniami, wpłaty częściowe i korekty |
| Test wydajności | `npm run load:test` (`scripts/load-test.js`), wariant skrócony `tests/load-smoke.test.js` | 50 równoczesnych użytkowników na danych 1000/2000/50; lokalnie PGlite, zdalnie wyłącznie staging (sekcja „Test wydajności”) |
| Pierwszy administrator | `npm run auth:bootstrap-admin` (`scripts/bootstrap-admin.js`, `src/pg/bootstrap-admin.js`) | jednorazowe zaproszenie do roli `admin` na pustej bazie (sekcja „Pierwszy administrator (bootstrap)”) |
| Integralność migracji | `.github/workflows/ci.yml` (job `migrations-order`), `scripts/check-migrations-order.js`, `scripts/generate-migrations-manifest.js` | manifest sum kontrolnych aktualny; PR nie zmienia scalonego pliku migracji ani nie dokłada numeru ≤ maksimum na `main` (sekcja „Numeracja migracji…” w [postgres/README.md](../postgres/README.md)) |
| CI | `.github/workflows/ci.yml` | testy, buildy, smoke, integralność migracji, lokalne migracje D1 (stara ścieżka pozostaje) |

`railway.json` nie zawiera zmiennych ani nadpisań środowisk; zmienne ustawia
się wyłącznie w usługach Railway. Migracje PostgreSQL **nie** są uruchamiane
przy starcie ani jako `preDeployCommand` — uruchamia się je ręcznie
(`npm run db:migrate:postgres`, patrz [postgres/README.md](../postgres/README.md)).
Builder `RAILPACK` jest w schemacie Railway oznaczony jako eksperymentalny;
jeśli build na stagingu zawiedzie, dopuszczalna jest zmiana na `NIXPACKS`
w osobnym PR. Wersja Node jest przypięta w `package.json` (`engines`: `22.x`).

Ograniczenie: PGlite to PostgreSQL skompilowany do WASM w procesie testów.
Smoke test i test wolumenu nie zastępują próby na prawdziwym PostgreSQL
Railway (staging). Czasy z PGlite nie są wynikiem wydajności produkcyjnej.

## Środowiska

| | staging | production |
|---|---|---|
| Projekt Railway | osobne środowisko (lub osobny projekt) | osobne środowisko |
| PostgreSQL | własna baza, wyłącznie dane syntetyczne | własna baza; import dopiero po D-01–D-07 i D-20 |
| Storage Bucket | własny bucket, pliki syntetyczne | własny bucket |
| Brevo | klucz testowy / tryb bez wysyłki, odbiorcy `@example.invalid` lub skrzynki zespołu | zatwierdzony nadawca (decyzja szkoły, rejestr decyzji) |
| Deploy | z gałęzi `main` po zielonym CI | wyłącznie ręcznie, po decyzji D-20 |
| Domena | techniczna domena Railway | domena zatwierdzona przez szkołę |

Zasady: żadnych kopii baz produkcyjnych na staging; żadnego współdzielenia
zmiennych między środowiskami; staging nie wysyła wiadomości do rodziców;
automatyczny deploy produkcji wyłączony.

## Zmienne usług (tylko nazwy)

Wartości ustawia się w Railway (Variables / sealed variables), nigdy w repo,
logach, zgłoszeniach ani buildzie frontendu.

| Zmienna | Usługa | Uwagi |
|---|---|---|
| `PORT` | aplikacja | ustawia Railway |
| `APP_ENV` | aplikacja / skrypty | `staging` lub `production`; lokalne: `development`, `test` (wielkość liter bez znaczenia, `prod` = `production`; wspólna normalizacja `src/app-env.js`). Brak lub nieznana wartość (literówka) jest zachowawczo traktowana jak produkcja przy niebezpiecznych operacjach: import wymaga `IMPORT_ENABLED=true`, a migracja, odtworzenie, kopia storage, test odtworzenia, bootstrap administratora i `storage:smoke` odmawiają bez `--allow-production` (skrypty wypisują ostrzeżenie); walidacja startowa serwera opisana niżej: serwer HTTP **nie startuje** z nieznaną wartością ani bez `APP_ENV` w usłudze Railway (#166). Ustaw jawnie |
| `PUBLIC_BASE_URL` | aplikacja | **wymagana** poza środowiskiem lokalnym: `https://host` bez ścieżki, osobny dla każdego środowiska |
| `MFA_ENCRYPTION_KEY` (albo `MFA_ENCRYPTION_KEYS`) | aplikacja | **wymagany** poza środowiskiem lokalnym: klucz 32 bajty (sekret), rotacja: sekcja niżej |
| `TRUST_PROXY` | aplikacja | **wymagana** poza środowiskiem lokalnym: `1` lub `true` (za proxy Railway; inaczej wspólny licznik prób logowania na IP) |
| `BREVO_WEBHOOK_SECRET` | aplikacja | **wymagany** poza środowiskiem lokalnym: co najmniej 32 znaki (sekret) |
| `DATABASE_URL` | aplikacja | referencja do prywatnego adresu PostgreSQL (`*.railway.internal`), nie publiczny TCP proxy |
| `BUCKET_ENDPOINT`, `BUCKET_REGION`, `BUCKET_NAME`, `BUCKET_ACCESS_KEY_ID`, `BUCKET_SECRET_ACCESS_KEY` | aplikacja | referencje do zmiennych Storage Bucket (#39); aplikacja czyta nazwy z prefiksem `BUCKET_` (`src/storage.js`), a nie nazwy źródłowe bucketu (`BUCKET`, `ENDPOINT` itd.); wszystkie pięć albo żadna |
| `BREVO_API_KEY` | aplikacja / worker | dopiero w #40; na stagingu klucz bez możliwości wysyłki do rodziców |
| `APP_WRITE_MODE` | aplikacja i worker e-mail | `normal` (domyślnie, także gdy brak) albo `read_only` (#143); inna wartość to błąd konfiguracji — serwer nie startuje, worker kończy z błędem. Procedura: sekcja „Tryb tylko do odczytu” |
| `EMAIL_SEND_WINDOW_ENABLED`, `EMAIL_SEND_WINDOW_START`, `EMAIL_SEND_WINDOW_END`, `EMAIL_SEND_WINDOW_TIMEZONE`, `EMAIL_SEND_WINDOW_DAYS` | aplikacja i worker e-mail | te same wartości w obu usługach (#130): zadanie liczy okno w strefie Brukseli, aplikacja pokazuje na tej podstawie szacowany start/koniec kampanii; godziny i dni ustala zarząd (D-16) |
| `EMAIL_WORKER_ALARM_HOURS` | aplikacja | próg alarmu „brak przebiegów” dla zarządu (`GET /api/email/worker-status`, domyślnie 2 h, #130); przy cronie co godzinę 2 h = jeden opuszczony przebieg zapasu |

Pełna lista wszystkich zmiennych (z wartościami domyślnymi i skutkiem braku) jest w katalogu poniżej.

### Katalog zmiennych środowiskowych (#166)

Jedyna pełna lista zmiennych czytanych przez kod (`src/`, `scripts/`, pliki w
katalogach modułów). Pilnuje jej `tests/env-catalog.test.js`: nowa zmienna w
kodzie bez wiersza tutaj oraz wiersz bez użycia w kodzie wywracają test (wyjątki
mają jawną listę z uzasadnieniem w teście). Tabela wyżej opisuje zasady
konfiguracji usług Railway; inne dokumenty (`EMAIL.md`, `AUTH.md`,
`NODE_SERVER.md`, `DOCUMENTS.md`) linkują tutaj. Tabela zawiera wyłącznie
**nazwy**, znaczenie i wartości domyślne, bez sekretów ani prawdziwych wartości.
Kolumna „Wymagana”: `tak` (brak = start odmówiony lub funkcja niedostępna),
`poza lokalnie` (wymagana, gdy `APP_ENV` jest inny niż lokalny), `nie`
(działa wartość domyślna), `skrypt` (tylko dla wskazanego polecenia). Opis ze
słowem „sekret” oznacza zmienną ustawianą wyłącznie w Railway.

| Zmienna | Usługa | Wymagana | Domyślna | Opis |
|---|---|---|---|---|
| `APP_ENV` | aplikacja, worker, skrypty | tak (Railway) | `development` lokalnie | `development`, `test`, `staging`, `production`; pozostałe traktowane zachowawczo, patrz tabela wyżej |
| `PORT` | aplikacja | tak (ustawia Railway) | `3000` lokalnie | port nasłuchu HTTP |
| `PUBLIC_BASE_URL` | aplikacja, worker | poza lokalnie | brak | `https://host` bez ścieżki; baza linków w e-mailach (wypisanie) |
| `DATABASE_URL` | aplikacja, worker, skrypty | tak | brak | prywatny adres PostgreSQL (`*.railway.internal`), sekret |
| `PG_POOL_MAX` | aplikacja, worker | nie | `10` | maksymalna liczba połączeń puli |
| `PG_STATEMENT_TIMEOUT_MS` | aplikacja, worker | nie | `10000` | limit czasu zapytania |
| `PG_LOCK_TIMEOUT_MS` | aplikacja, worker | nie | `3000` | limit oczekiwania na blokadę wiersza |
| `LOG_LEVEL` | aplikacja, worker | nie | `info` | poziom logów strukturalnych |
| `SHUTDOWN_TIMEOUT_MS` | aplikacja | nie | `10000` | czas łagodnego zamknięcia po SIGTERM |
| `METRICS_LOG_INTERVAL_MS` | aplikacja | nie | `300000` | odstęp wpisów z metrykami w logu |
| `TRUST_PROXY` | aplikacja | poza lokalnie | brak | `1` lub `true` za proxy Railway; inaczej wspólny licznik prób na adres |
| `MFA_ENCRYPTION_KEY` | aplikacja, `rotate-mfa-key` | poza lokalnie | brak | klucz 32 bajty (hex lub base64), sekret; bez niego MFA zwraca `503 mfa_unavailable` |
| `MFA_ENCRYPTION_KEYS` | aplikacja, `rotate-mfa-key` | nie | brak | lista kluczy przy rotacji, sekret; sekcja „Rotacja klucza szyfrowania MFA” |
| `MFA_REQUIRED_ROLES` | aplikacja | nie | `admin,board,treasurer` | role z obowiązkowym MFA; pusty ciąg = bez obowiązku |
| `SCRYPT_COST_LOG2` | aplikacja | nie | `17` | koszt haszowania haseł (15–20) |
| `PASSWORD_CONTEXT_STEMS` | aplikacja | nie | brak | rdzenie słabych haseł oddzielone przecinkami |
| `LOGIN_EMAIL_DELAY_MS` | aplikacja | nie | `1000`/`2000` | opóźnienie po błędach logowania na adres e-mail; `0` = brak |
| `LOGIN_PRESSURE_THRESHOLD` | aplikacja | nie | `15` | błędne próby na konto w 15 min, od których administrator dostaje sygnał |
| `LOGIN_QUEUE_MAX_PER_IP` | aplikacja | nie | `5` | limit kolejki obliczeń haseł na adres klienta |
| `SESSION_IDLE_TIMEOUT_SECONDS` | aplikacja | nie | `1800` | wygaśnięcie sesji po bezczynności; `0` wyłącza (tylko lokalnie) |
| `ALLOW_PENDING_ROLES` | aplikacja | nie | wyłączone | `true` zezwala na rolę `pending_decision` (D-09); domyślnie odrzucana |
| `MEETINGS_CLASS_HOST` | aplikacja | nie | wyłączone | `representative` pozwala przedstawicielowi prowadzić zebranie klasy |
| `ICAL_UID_DOMAIN` | aplikacja | nie | `rd.example.invalid` | domena w UID kalendarza do czasu D-20 |
| `IMPORT_ENABLED` | aplikacja | nie | wyłączony poza lokalnymi | `true` odblokuje import na produkcji po decyzji szkoły (D-01–D-06) |
| `RECONCILIATION_BANK_ACCOUNT_IBAN` | aplikacja | nie | brak | rachunek Rady do importu wyciągu (D-13) |
| `BANK_TRANSACTION_HASH_KEY` | aplikacja | nie | brak | klucz HMAC (min. 32 znaki), sekret; bez niego import wyciągu jest niedostępny |
| `RATE_LIMIT_DISABLED` | aplikacja | nie | wyłączone | `1` wyłącza ogólny limiter (tylko lokalnie/testy) |
| `RATE_LIMIT_PUBLIC_PER_MIN` | aplikacja | nie | `300` | żądania publiczne na minutę; `0` = bez limitu |
| `RATE_LIMIT_WEBHOOK_PER_MIN` | aplikacja | nie | `600` | żądania webhooka na minutę |
| `RATE_LIMIT_SESSION_PER_MIN` | aplikacja | nie | `1200` | żądania zalogowanej sesji na minutę |
| `RATE_LIMIT_SESSION_ADDRESS_PER_MIN` | aplikacja | nie | `3000` | suma sesji z jednego adresu na minutę |
| `RATE_LIMIT_HEAVY_CONCURRENCY` | aplikacja | nie | `2` | równoległe kosztowne trasy (eksport, import, raporty) na sesję |
| `APP_WRITE_MODE` | aplikacja, worker | nie | `normal` | `read_only` blokuje zapisy (#143); inna wartość = błąd konfiguracji |
| `RAILWAY_GIT_COMMIT_SHA` | aplikacja | nie (ustawia Railway) | brak | wersja pokazywana w `ops-status` |
| `HEALTH_JOBS_TOKEN` | aplikacja | nie | brak | token Bearer dla `GET /health/jobs`, sekret; brak = zawsze 401 |
| `BACKUP_MAX_AGE_HOURS` | aplikacja | nie | `26` | próg alarmu „stara kopia” w `/health/jobs` |
| `EMAIL_WORKER_MAX_AGE_HOURS` | aplikacja | nie | `6` | próg alarmu „brak przebiegu workera” w `/health/jobs` |
| `EMAIL_QUEUE_MAX_AGE_HOURS` | aplikacja | nie | `24` | próg alarmu „stara wiadomość w kolejce” |
| `EMAIL_WORKER_ALARM_HOURS` | aplikacja | nie | `2` | alarm „brak przebiegów” dla zarządu (`/api/email/worker-status`) |
| `DOCUMENT_MAX_BYTES` | aplikacja | nie | `10485760` | limit pliku dokumentu w bajtach (najwyżej 25 MiB) |
| `DOCUMENT_MAX_CONCURRENT_UPLOADS` | aplikacja | nie | `4` | równoległe wysyłki dokumentów |
| `BUCKET_ENDPOINT` | aplikacja | tak (dokumenty) | brak | adres Storage Bucket; wszystkie pięć `BUCKET_*` albo żadna (częściowa konfiguracja zatrzymuje start) |
| `BUCKET_REGION` | aplikacja | tak (dokumenty) | brak | region bucketu |
| `BUCKET_NAME` | aplikacja | tak (dokumenty) | brak | nazwa bucketu |
| `BUCKET_ACCESS_KEY_ID` | aplikacja | tak (dokumenty) | brak | identyfikator klucza bucketu, sekret |
| `BUCKET_SECRET_ACCESS_KEY` | aplikacja | tak (dokumenty) | brak | klucz dostępu bucketu, sekret |
| `BUCKET_URL_STYLE` | aplikacja | nie | `virtual` | `virtual` albo `path`, zgodnie z zakładką Credentials bucketu |
| `BREVO_API_KEY` | worker, `email-preflight` | tak (wysyłka) | brak | klucz Brevo, sekret; na stagingu bez możliwości wysyłki do rodziców |
| `BREVO_FROM_EMAIL` | worker, aplikacja | tak (wysyłka) | brak | adres nadawcy zatwierdzony przez szkołę |
| `BREVO_FROM_NAME` | worker, aplikacja | nie | `Rada Rodziców` | nazwa nadawcy |
| `BREVO_REPLY_TO` | worker, aplikacja | tak (produkcja) | brak | adres odpowiedzi; pusty na produkcji = odmowa wysyłki |
| `BREVO_WEBHOOK_SECRET` | aplikacja | poza lokalnie | brak | min. 32 znaki, sekret; brak = `503 webhook_not_configured` |
| `BREVO_WEBHOOK_SECRET_PREVIOUS` | aplikacja | nie | brak | poprzedni sekret w oknie rotacji, sekret |
| `BREVO_WEBHOOK_ALLOWED_CIDRS` | aplikacja | nie | brak | lista CIDR adresów Brevo (sprawdzana przy `TRUST_PROXY`) |
| `EMAIL_UNSUBSCRIBE_SECRET` | aplikacja, worker | tak (wysyłka) | brak | sekret podpisu linku wypisania; brak = brak stopki |
| `EMAIL_SENDING_ENABLED` | worker | nie | wyłączone | wysyłka tylko przy dokładnie `true` |
| `EMAIL_TEST_ALLOWLIST` | worker, `email-preflight` | nie | brak | poza produkcją jedyni dozwoleni odbiorcy, np. `*@example.invalid` |
| `EMAIL_PREVIEW_RECIPIENTS` | worker, `email-preflight` | nie | brak | adresy techniczne dla wiadomości testowej kampanii |
| `EMAIL_PREVIEW_REQUIRED_BEFORE_APPROVAL` | aplikacja | nie | wyłączone | `true` wymaga testu przed zatwierdzeniem (D-16) |
| `EMAIL_DAILY_LIMIT` | aplikacja, worker | nie | `300` | dzienny limit wiadomości (plan Brevo) |
| `EMAIL_DAILY_RESERVED` | aplikacja, worker | nie | `0` | część limitu zarezerwowana poza kampaniami |
| `EMAIL_QUOTA_TIMEZONE` | aplikacja, worker | nie | `Europe/Brussels` | strefa doby limitu |
| `EMAIL_CAMPAIGN_MIN_DAYS` | aplikacja, worker | nie | `7` | najmniejsza liczba dni rozłożenia kampanii |
| `EMAIL_CAMPAIGN_MIN_DAILY` | aplikacja, worker | nie | `50` | najmniejszy dzienny udział kampanii |
| `EMAIL_BATCH_SIZE` | worker | nie | `50` | wiadomości na partię |
| `EMAIL_MAX_ATTEMPTS` | worker | nie | `5` | liczba prób dostarczenia |
| `EMAIL_BREAKER_UNCERTAIN` | worker | nie | `2` | wyłącznik: kolejne wyniki niepewne zatrzymują przebieg |
| `EMAIL_SEND_WINDOW_ENABLED` | aplikacja, worker | nie | wyłączone | `true` włącza okno wysyłki (D-16) |
| `EMAIL_SEND_WINDOW_START` | aplikacja, worker | nie | `09:00` | początek okna (`GG:MM`) |
| `EMAIL_SEND_WINDOW_END` | aplikacja, worker | nie | `18:00` | koniec okna (`GG:MM`) |
| `EMAIL_SEND_WINDOW_TIMEZONE` | aplikacja, worker | nie | `Europe/Brussels` | strefa okna |
| `EMAIL_SEND_WINDOW_DAYS` | aplikacja, worker | nie | `1-5` | dni tygodnia okna (1 = poniedziałek) |
| `EMAIL_PREFERENCES_RATE_LIMIT` | aplikacja | nie | `200` | żądań na minutę do publicznej trasy preferencji |
| `EMAIL_DKIM_HOSTS` | `email-preflight` | skrypt | brak | selektory DKIM do sprawdzenia |
| `BACKUP_ENCRYPTION_PUBLIC_KEY` | `backup:postgres` | skrypt | brak | klucz publiczny szyfrowania kopii |
| `BACKUP_DECRYPTION_PRIVATE_KEY` | `restore:drill` | skrypt | brak | klucz prywatny, sekret, tylko na czas próby odtworzenia |
| `BACKUP_S3_ENDPOINT` | `backup:postgres`, `restore:drill` | skrypt | brak | magazyn kopii baz |
| `BACKUP_S3_REGION` | `backup:postgres`, `restore:drill` | skrypt | brak | region magazynu kopii baz |
| `BACKUP_S3_BUCKET` | `backup:postgres`, `restore:drill` | skrypt | brak | bucket kopii baz |
| `BACKUP_S3_ACCESS_KEY_ID` | `backup:postgres`, `restore:drill` | skrypt | brak | identyfikator klucza, sekret |
| `BACKUP_S3_SECRET_ACCESS_KEY` | `backup:postgres`, `restore:drill` | skrypt | brak | klucz dostępu, sekret |
| `BACKUP_S3_URL_STYLE` | `backup:postgres`, `restore:drill` | skrypt | `virtual` | `virtual` albo `path` |
| `STORAGE_BACKUP_S3_ENDPOINT` | `backup:storage` | skrypt | brak | magazyn docelowy kopii dokumentów (drugi dostawca) |
| `STORAGE_BACKUP_S3_REGION` | `backup:storage` | skrypt | brak | region magazynu docelowego |
| `STORAGE_BACKUP_S3_BUCKET` | `backup:storage` | skrypt | brak | bucket docelowy |
| `STORAGE_BACKUP_S3_ACCESS_KEY_ID` | `backup:storage` | skrypt | brak | identyfikator klucza, sekret |
| `STORAGE_BACKUP_S3_SECRET_ACCESS_KEY` | `backup:storage` | skrypt | brak | klucz dostępu, sekret |
| `STORAGE_BACKUP_S3_URL_STYLE` | `backup:storage` | skrypt | `virtual` | `virtual` albo `path` |
| `RESTORE_DRILL_TARGET_DATABASE_URL` | `restore:drill` | skrypt | brak | baza docelowa próby, musi różnić się od `DATABASE_URL` |
| `RD_LOCAL_PG_ADMIN_URL` | `restore:drill:local` | skrypt | brak | lokalny PostgreSQL administratora do próby na danych syntetycznych |
| `LOAD_TEST_ALLOWED_HOSTS` | `load:test`, `smoke:remote` | skrypt | brak | hosty dozwolone dla testu zdalnego (wyłącznie staging) |
| `LOAD_TEST_SCHOOL_YEAR_ID` | `load:test` | skrypt | brak | rok szkolny syntetyczny dla testu zdalnego |
| `NODE_ENV` | `demo:seed` | nie | brak | wartość inna niż lokalna blokuje seed demo |
| `NODE_TEST_CONTEXT` | testy | nie (ustawia `node --test`) | brak | wyłącza opóźnienia i pętle czasowe w testach |
| `RD_TEST_PG_URL` | testy, `restore:drill:local` | nie | brak | prawdziwy PostgreSQL do testów `test:pg-real` (baza testowa) |
| `RD_TEST_PG_BACKEND` | testy | nie | `pglite` | `real` uruchamia testy na prawdziwym PostgreSQL |
| `PG_BIN` | `test:pg-real` | nie | `pg_config --bindir` | katalog z `initdb` i `pg_ctl` |
| `E2E_PORT` | testy e2e | nie | zob. `playwright.config.js` | port serwera testów przeglądarkowych |
| `PLAYWRIGHT_BROWSERS_PATH` | testy e2e | nie | domyślna Playwright | katalog przeglądarek |
| `CI` | testy e2e | nie (ustawia runner CI) | brak | `true` włącza ponowienia testu i raport HTML Playwright |
| `RAILWAY_ENVIRONMENT_ID` | aplikacja | nie (ustawia Railway) | brak | znacznik platformy: brak `APP_ENV` w usłudze Railway zatrzymuje start |
| `RAILWAY_ENVIRONMENT_NAME` | aplikacja | nie (ustawia Railway) | brak | jak wyżej |
| `RAILWAY_ENVIRONMENT` | aplikacja | nie (ustawia Railway) | brak | jak wyżej |
| `RAILWAY_PROJECT_ID` | aplikacja | nie (ustawia Railway) | brak | jak wyżej |
| `RAILWAY_SERVICE_ID` | aplikacja | nie (ustawia Railway) | brak | jak wyżej |

Nie ma tu zmiennych dla `--expect-database=<nazwa bazy>` ani znacznika
środowiska w bazie (część #166 zależna od D-20): to osobny, jeszcze nie
zrealizowany zakres.

### Walidacja konfiguracji przy starcie (#114)

Przy `APP_ENV` innym niż brak wartości, `development` i `test` serwer
(`src/server.js`, `validateConfig` w `src/config.js`) odmawia startu z kodem
wyjścia `1` i zdarzeniem `config_invalid`, gdy `PUBLIC_BASE_URL` nie jest
`https://host` bez ścieżki, `MFA_ENCRYPTION_KEY` (albo `MFA_ENCRYPTION_KEYS`) nie
jest poprawnym kluczem 32 bajtów, `TRUST_PROXY` nie jest `1`/`true` albo
`BREVO_WEBHOOK_SECRET` ma mniej niż 32 znaki. Log zawiera wyłącznie **nazwy**
niepoprawnych zmiennych, nigdy wartości. Nieznana wartość `APP_ENV` (np.
literówka `prodution`) zatrzymuje start niezależnie od pozostałych zmiennych
(`config_invalid` ze zmienną `APP_ENV`, bez samej wartości w logu). Brak
`APP_ENV` lokalnie oznacza `development`, ale w usłudze Railway (ustawione
`RAILWAY_ENVIRONMENT_ID`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_ENVIRONMENT`,
`RAILWAY_PROJECT_ID` albo `RAILWAY_SERVICE_ID`) również zatrzymuje start —
zapomniana zmienna nie może przełączyć usługi w tryb lokalny (cookie bez
`__Host-`, brak walidacji konfiguracji) (#166). Całe rozpoznanie `APP_ENV`
jest w `src/app-env.js`; `tests/app-env-single-source.test.js` odrzuca
bezpośrednie porównania `APP_ENV` w innych plikach.
Założenie do potwierdzenia: `BREVO_WEBHOOK_SECRET` jest wymagany także na
stagingu bez włączonej poczty (zachowawczo, zgodnie z treścią #114).

### Cookie sesji `__Host-rd_session` (#114)

Poza środowiskiem lokalnym sesja jest zapisywana w cookie `__Host-rd_session`
(`Secure`, `Path=/`, bez `Domain` — przeglądarka odrzuca przy próbie podstawienia
z subdomeny). Lokalny dev na `http://localhost` (brak `APP_ENV`, `development`,
`test`) nadal używa nazwy `rd_session`, bo prefiks `__Host-` wymaga `Secure`, a nie
każda przeglądarka przyjmuje Secure na `http://localhost`. Odczyt przyjmuje obie
nazwy (nowa ma pierwszeństwo), a wylogowanie i cofnięcie bieżącej sesji czyści
obie. Wdrożenie tej zmiany nie wylogowuje nikogo od razu: stare cookie działa do
końca życia sesji (najwyżej 24 h), potem trzeba się zalogować ponownie — prototyp
bez produkcji, więc bez osobnej migracji sesji. Odczyt starej nazwy można usunąć
po 24 h od wdrożenia (`readSessionToken` w `src/auth.js`). Skrypty
obciążeniowe i smoke wysyłają cookie pod starą nazwą `rd_session=` — działa to,
dopóki serwer czyta starą nazwę; przy jej usunięciu skrypty trzeba przełączyć na
`__Host-rd_session=`.

## Region i sieć

- Aplikacja, PostgreSQL i Storage Bucket w regionie UE Amsterdam
  (`europe-west4-drams3a`). Region bucketu jest nieodwracalny — wybrać przy
  tworzeniu. Region sprawdzić osobno dla każdej usługi i zapisać w protokole.
- Aplikacja łączy się z bazą przez prywatną sieć Railway. Publiczny TCP proxy
  PostgreSQL wyłączony; jeżeli potrzebny do jednorazowego `pg_dump`, użyć
  `railway connect` / tunelu i wyłączyć proxy po operacji.
- Region nie zastępuje oceny prawnej ani umowy powierzenia (decyzje szkoły i IOD w rejestrze decyzji).

## Limity kosztów

- W ustawieniach Usage workspace ustawić alert e-mail (soft limit) i twardy
  limit. Po osiągnięciu twardego limitu Railway **wyłącza wszystkie usługi** —
  dla produkcji ustawić go z zapasem, a alerty (75/90/100%) kierować do
  skarbnika i administratora technicznego.
- Kwoty limitów zatwierdza zarząd (budżet); do czasu decyzji staging ma niski
  limit twardy.
- Przegląd kosztów raz w miesiącu razem z księgą; zapisać w protokole.

## Monitoring i alerty (#16)

| Obszar | Sygnał | Źródło | Reakcja |
|---|---|---|---|
| Dostępność | healthcheck `/health` przy deployu (liveness); zewnętrzny monitor `/health/ready` co 5 min | Railway, monitor zewnętrzny | restart, rollback wersji |
| Baza i schemat | `/health/ready` = `503` (`database: error/timeout`, `migrations: pending`) | monitor zewnętrzny, zdarzenia `readiness_*` w logu | sprawdzić usługę PostgreSQL; brakujące migracje nałożyć ręcznie po backupie |
| Błędy | odsetek odpowiedzi 5xx (`http_metrics.status_5xx`, `http_request` na poziomie `error`, `api_route_error`), awarie deployu, restart pętli | Railway Observability / logi JSON | analiza logów bez danych osobowych |
| PostgreSQL | CPU, pamięć, zajętość wolumenu, liczba połączeń | metryki usługi PostgreSQL | alert przy 80% wolumenu |
| Storage Bucket | rozmiar, liczba obiektów, odrzucone uploady | metryki bucketu, audyt aplikacji | przegląd retencji |
| Brevo | dzienny limit planu, odbicia, błędne adresy, błędy API | panel Brevo, stan kolejki (#40) | wstrzymanie kampanii, korekta adresów |
| Zadania | zadania w stanie błędu lub zbyt długo w kolejce | tabela kolejki (#40) | ponowienie z tym samym kluczem idempotencji |
| Backup | brak nowego backupu > 26 h, nieudana próba odtworzenia | `backup_runs` (po uruchomieniu usług cron), Railway Backups, protokół | ręczny backup, eskalacja |
| Koszty | alerty Usage | Railway | patrz wyżej |

**Liveness a readiness.** `/health` potwierdza tylko działanie procesu i
pozostaje healthcheckiem Railway: gdyby healthcheck zależał od bazy, awaria
PostgreSQL albo nienałożona migracja blokowałaby deploy poprawnej wersji lub
wywoływała pętlę restartów, która nie naprawia bazy. Stan bazy sprawdza
`/health/ready` (`SELECT 1` z limitem 2 s egzekwowanym przez PostgreSQL — `SET LOCAL statement_timeout` na jednym połączeniu sondy, #244 — i porównanie `schema_migrations` z
`postgres/migrations`); `503` oznacza brak bazy, błąd lub timeout, brakujące
migracje albo zamykanie procesu. Odpowiedź zawiera tylko stan techniczny oraz
liczbę i nazwy brakujących plików migracji. Po każdym deployu i każdej
migracji uruchomić `npm run smoke:remote` (patrz niżej) zamiast sprawdzać
`/health/ready` ręcznie; to także warunek listy odbioru.
Szczegóły: [serwer Node](NODE_SERVER.md#monitoring-logi-i-zamykanie-16-41).

**Smoke test po deployu (`smoke:remote`, issue #119).** Wyłącznie odczyty
(`GET`), bez żadnych zapisów; te same bezpieczniki co test wydajności
(sekcja „Test wydajności” niżej): odmawia bez `--i-confirm-staging`, dla
`http://`, dla `APP_ENV=production` i dla hosta spoza `LOAD_TEST_ALLOWED_HOSTS`
— odmowa następuje przed pierwszym żądaniem. Sprawdza `/health`, `/health/ready`,
wszystkie panele (`STATIC_PREFIXES` z `src/node-app.js`, jedno źródło prawdy),
nagłówki bezpieczeństwa oraz `404` dla ścieżek prywatnych i `*.map`. Wynik
JSON wkleić do listy odbioru.

```sh
LOAD_TEST_ALLOWED_HOSTS=rd-staging.up.railway.app APP_ENV=staging \
  npm run smoke:remote -- --target https://rd-staging.up.railway.app --i-confirm-staging
```

**Logi.** Serwer zapisuje jedną linię JSON na zdarzenie (`level`, `event`,
`method`, ścieżka bez query stringu z `:id` zamiast identyfikatorów, `status`,
`duration_ms`, `module`, `code`); Railway odczytuje z nich `level` i `message`.
Warstwa redakcji usuwa pola z e-mailami, imionami, cookies, tokenami, IBAN i
treściami oraz maskuje takie wartości w tekście. Co 5 min (`METRICS_LOG_INTERVAL_MS`)
proces zapisuje zdarzenie `http_metrics` z licznikami żądań wg klasy statusu i
czasami — metryki nie są wystawiane przez HTTP. W widoku logów Railway
filtrować wpisy o poziomie `error` oraz zdarzenia `http_metrics` z
`status_5xx > 0`; jeśli plan nie obsługuje alertów z logów — przegląd dzienny.
Logi nie mogą zawierać danych rodzin, tokenów ani treści wiadomości.
Czas przechowywania logów w Railway zależy od planu — do potwierdzenia przy
decyzji o retencji.

**Redeploy i zamykanie.** Railway wysyła SIGTERM do poprzedniej wersji i po
`drainingSeconds` (15 s w `railway.json`; domyślnie 0) SIGKILL. Serwer kończy
trwające żądania, zamyka pulę bazy i najpóźniej po `SHUTDOWN_TIMEOUT_MS`
(10 s) kończy proces. Zdarzenie `server_shutdown_timeout` w logu oznacza
przerwane żądania — sprawdzić, czy nie dotyczyły zapisów (idempotencja
wpłat chroni przed dublowaniem przy ponowieniu).
Konkretne narzędzie monitora zewnętrznego i adresaci alertów — do decyzji
zarządu.

## Test wydajności (#16, #41)

Kryterium: API działa dla 1000 uczniów, 2000 kontaktów opiekunów i 50
użytkowników pracujących równocześnie. Skrypt `scripts/load-test.js`
(`npm run load:test`) uruchamia 50 wirtualnych użytkowników przez N sekund
i zwraca JSON: p50/p95/p99/max opóźnienia, odsetek błędów, przepustowość
(żądania/s), liczby statusów i podział na operacje. Kod wyjścia `1` przy
przekroczeniu progu, `2` przy odmowie lub błędzie użycia.

Mieszanka operacji (losowana z wagami, według roli użytkownika):

| Operacja | Role | Oczekiwany status |
|---|---|---|
| `GET /api/session`, `GET /api/access` | wszyscy | 200 |
| `GET /api/public/events` (bez sesji) | wszyscy | 200 |
| `GET /api/events?schoolYearId=…` | admin, zarząd, przedstawiciel (tylko swoje klasy) | 200 |
| `GET /api/meetings?schoolYearId=…` | admin, zarząd | 200 |
| `GET /api/payments?schoolYearId=…&limit=50` | admin, zarząd, skarbnik (MFA) | 200 |
| `GET /api/payments`, `GET /api/meetings` | przedstawiciel | 403 (granica ról) |
| `POST /api/payments` z nowym `Idempotency-Key` | admin, zarząd, skarbnik | 201 |
| `POST /api/payments` ×2 równolegle z tym samym kluczem (podwójne kliknięcie) | admin, zarząd, skarbnik | dokładnie jedno 201, drugie 200 |
| `POST /api/events` (szkic wewnętrzny) | admin, zarząd | 201 |

Błąd = status inny niż oczekiwany, przekroczony czas (`--timeout-ms`,
domyślnie 10 s) lub błąd sieci. Oczekiwane 403 nie są błędem.

### Tryb lokalny

```sh
npm run load:test                                  # 50 użytkowników, 30 s
npm run load:test -- --users 50 --duration 60 --out wynik.json
```

Serwer Node startuje w tym samym procesie na `127.0.0.1` (losowy port) z
PGlite w pamięci, wszystkimi migracjami `postgres/migrations` i danymi
syntetycznymi z `scripts/lib/synthetic-seed.js` (ten sam zestaw co
`tests/postgres-volume.test.js`: 20 klas, 800 rodzin, rodzeństwo, dwoje
opiekunów przy dziecku, wpłaty częściowe z korektami; 2 admin, 6 zarząd,
2 skarbników, 40 przedstawicieli). Każdy z 50 użytkowników ma sesję z MFA;
dodatkowo 15 opublikowanych wydarzeń, 5 szkiców i 10 zebrań. Zapisy są
włączone. Nic nie opuszcza procesu.

`tests/load-smoke.test.js` (część `npm test`) uruchamia wariant 5
użytkowników / 3 s z luźnymi progami i sprawdza brak błędów, pokrycie
wszystkich ról i kompletność raportu oraz bezpieczniki trybu zdalnego.

### Tryb zdalny (wyłącznie staging, dane syntetyczne)

```sh
LOAD_TEST_ALLOWED_HOSTS=<host stagingu> APP_ENV=staging \
LOAD_TEST_SCHOOL_YEAR_ID=<id roku> \
LOAD_TEST_SESSION_BOARD=… LOAD_TEST_SESSION_TREASURER=… LOAD_TEST_SESSION_REPRESENTATIVE=… \
npm run load:test -- --target https://<host stagingu> --i-confirm-staging [--allow-writes]
```

Skrypt odmawia (kod `2`, zanim wyśle obciążenie), gdy:

- brak flagi `--i-confirm-staging`;
- `APP_ENV` w środowisku uruchomienia to `production`;
- adres nie jest `https://`, zawiera dane logowania albo jego host nie jest
  **dokładnie** jedną z pozycji `LOAD_TEST_ALLOWED_HOSTS` (lista po przecinku;
  pusta lista = odmowa);
- brak `LOAD_TEST_SCHOOL_YEAR_ID` lub żadnej sesji;
- którakolwiek sesja jest nieważna lub należy do konta z adresem spoza domen
  syntetycznych (`.invalid`, `.test`, `.example`) — sprawdzane przez
  `GET /api/session` przed startem.

Zmienne z sesjami (tylko nazwy; wartość = wartość cookie `rd_session`
syntetycznego konta stagingowego, z prefiksem `rd_session=` lub bez):
`LOAD_TEST_SESSION_ADMIN`, `LOAD_TEST_SESSION_BOARD`,
`LOAD_TEST_SESSION_TREASURER`, `LOAD_TEST_SESSION_REPRESENTATIVE`,
`LOAD_TEST_SESSION_AUDIT` (Komisja Rewizyjna; używana przez scenariusz „heavy”).
Wirtualni użytkownicy dzielą te sesje rotacyjnie. Wartości ustawiać wyłącznie
w powłoce operatora, nie w repo, CI ani protokole; po teście wycofać sesje.
Zdalnie domyślnie wykonywane są tylko odczyty; `--allow-writes` dodaje wpłaty
bez przypisania rodziny (`unmatched`, opis „LOAD-TEST syntetyczny”) i szkice
wydarzeń — dopuszczalne tylko na stagingu, który potem się czyści lub
odtwarza. Skrypt nie wysyła e-maili i nie dotyka tras wysyłek.

### Progi

| Flaga | Domyślnie | Znaczenie |
|---|---|---|
| `--p95-ms` | 1000 | maks. p95 opóźnienia (ms) |
| `--p99-ms` | 2000 | maks. p99 opóźnienia (ms) |
| `--max-error-rate` | 0.01 | maks. odsetek błędów (0–1) |
| `--min-rps` | 0 | min. przepustowość (żądania/s) |
| `--users`, `--duration`, `--think-ms`, `--timeout-ms` | 50, 30, 0, 10000 | liczba użytkowników, czas (s), pauza między żądaniami, limit czasu żądania |

Progi domyślne są założeniem technicznym, nie wymaganiem szkoły. Wartości
docelowe dla stagingu ustalić po pierwszym pomiarze i zapisać w tabeli.
`--think-ms 0` to obciążenie ciągłe — znacznie ostrzejsze niż 50 osób
klikających w panelu.

### Wyniki

Wynik lokalny to **PGlite (WASM, jeden proces, jedno połączenie, zapytania
szeregowane) — niereprezentatywny** dla PostgreSQL na Railway. Pokazuje
jedynie, że mieszanka działa bez błędów przy 50 równoczesnych użytkownikach.
Trasy faktycznie zmierzone tym scenariuszem to wyłącznie te z tabeli operacji
wyżej (`GET /api/session`, `/api/access`, `/api/public/events`, `/api/events`,
`/api/meetings`, `/api/payments`, `POST /api/payments`, `POST /api/events`) —
wniosek o braku rażąco złego planu zapytań dotyczy tylko tych tras i danych
jednego roku. Karty z sumami wielu lat, kartki dla całej szkoły, eksporty,
dziennik zdarzeń, uzgodnienia rachunku, migawki kampanii, import i zamknięcie
roku mierzy osobno scenariusz „heavy” niżej (#217). Kryterium odbioru
spełnia dopiero pomiar na stagingu.

| Data | Środowisko | Kto | Użytkownicy / czas | Zapisy | Żądania | Przepustowość | p50 | p95 | p99 | Błędy | Progi | Wynik / uwagi |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 27.09.2026 | lokalnie, PGlite w procesie (niereprezentatywny) | agent (Claude) | 50 / 30 s, bez pauz | tak | 4560 | 151,7 req/s | 300 ms | 537 ms | 1315 ms | 0 (0%) | domyślne | zaliczony; max 3230 ms; kontener 4 vCPU współdzielony z innymi procesami (load average ~60), przygotowanie danych 16 s |
| do wykonania | staging | | 50 / 60 s | nie | | | | | | | | |
| do wykonania | staging | | 50 / 60 s | tak (`--allow-writes`) | | | | | | | | |

### Scenariusz „heavy” (#217): trasy pominięte przez scenariusz domyślny

`npm run load:test -- --scenario heavy` mierzy osobno trasy najbardziej
obciążające bazę i serwer, których koszt rośnie z **wiekiem systemu**
(historia lat, `audit_events`, korekty, uzgodnienia) — seed jednego roku ze
scenariusza domyślnego tego nie pokazuje. Każda trasa: `--heavy-iterations`
(domyślnie 3) wywołań sekwencyjnie, a odczyty dodatkowo tyle samo rund po
`--heavy-concurrency` (domyślnie 5) równoczesnych żądań — lokalnie każde z
innej sesji tej samej osoby (limiter kosztownych tras z `src/rate-limit.js`
ogranicza równoczesne żądania jednej sesji; zdalnie, przy jednej sesji na
rolę, odpowiedzi `429` są liczone osobno jako `rateLimited`, nie jako błędy).

| Grupa | Operacje (nazwa w raporcie) |
|---|---|
| Rodziny i klasy | `GET /api/classes` (wszystkie lata), `GET /api/classes/{id}/students`, `GET /api/households/{id}` (sumy wielu lat) |
| Wydruki i listy | `GET /api/print/cards` (cała szkoła, z kwotami), `GET /api/exports/class-roster (xlsx)` |
| Finanse i KR | `GET /api/ledger/export.csv`, `GET /api/reports/audit` (json i html), `GET /api/payments (kursor, 5 stron)` |
| Dziennik zdarzeń | `GET /api/admin/audit (finance, rok)` (filtr roku #174), `GET /api/admin/audit (kursor, 5 stron)` |
| Uzgodnienie rachunku | `GET /api/reconciliations`, `POST …/{id}/lines` (200 pozycji), `GET …/{id}`, `GET …/{id}/suggestions` |
| Eksport roczny | `POST /api/exports` (#216 — scenariusz tylko mierzy, kodu eksportu nie zmienia) |
| Kampanie (bez wysyłki) | `POST …/snapshot (no_payment_record)`, `POST …/snapshot (all_households)`, `GET …/preview`, `POST …/snapshot (double click)` |
| Import | `POST /api/import/preview`, `POST /api/import/commit`, `POST /api/import/commit (double click)` (dwa równoległe zapisy tym samym kluczem → jedno `201`, jedno `200`, potem ponowienie → `200` z `replayed: true`) |
| Zamknięcie roku | `POST /api/year-close/{id}/close` (najstarszy rok, druga osoba zarządu), `GET /api/year-close/{id}/handover` |
| Granice ról | `GET /api/households/{id} (representative, out of scope)`, `POST /api/exports (representative, 403)` — oczekiwane `403`/`404`, nie błąd |

Dane: `scripts/lib/heavy-scenario.js` (`buildHistoricalData`) — kilka lat
syntetycznej historii: rotacja uczniów między latami (co roku ok. 1/4 odchodzi
i tyle samo dochodzi, więc karta gospodarstwa sumuje kilka lat), rodzeństwo w
różnych klasach, dwoje opiekunów na gospodarstwo (część bez zgody na
kontakt), wpłaty częściowe (dwie raty) i brak wpisu wpłaty części rodzin,
korekty w każdym roku, wpisy księgi powiązane z wpłatami i wydatki, szkic
uzgodnienia w najnowszym roku, opublikowana syntetyczna informacja o
przetwarzaniu danych (wymagana przez zapis importu), zdarzenia audytu
wstawiane `generate_series` po stronie bazy (część z rokiem w metadanych,
część bez — filtr roku przypisuje je wtedy do roku obiektu). Najnowszy rok
zawiera dzisiejszą datę. Po wstawieniu danych skrypt wykonuje `ANALYZE`:
bez statystyk PGlite (brak autovacuum) wybierał pętle zagnieżdżone, a
`GET /api/print/cards` i `GET /api/admin/audit` wyglądały na kilkukrotnie
wolniejsze niż są. Wszystkie adresy w domenie `example.invalid`.

Skala domyślna (`--heavy-years 2 --heavy-classes 5 --heavy-students 40
--heavy-audit-events 3000 --heavy-import-rows 60`) jest **celowo mała**
(ok. 15 s z przygotowaniem). `--heavy-full` ustawia skalę z opisu issue
#217: 5 lat, 50 klas/rok, 1000 uczniów/rok (2000 łącznie), 100 000 zdarzeń
audytu, import 1000 wierszy — ok. 1 min na współdzielonym kontenerze, do
przebiegu nocnego (#111) albo ręcznego, niewymagany na PR. Flagi `--heavy-*`
podane **po** `--heavy-full` nadpisują pojedyncze wymiary. W CI działa tylko
wariant skrócony z `tests/load-heavy-smoke.test.js` (2 lata, 2 klasy, 12
uczniów/rok).

Wynik (JSON, `--out plik.json`): dla każdej operacji `latencyMs`
(`p50`/`p95`/`max` przebiegu sekwencyjnego), `responseBytes`,
`maxEventLoopDelayMs`, `concurrent` (to samo przy N równoczesnych), a lokalnie
także `memory` (`heapDeltaMb` — szczyt sterty w trakcie trasy minus stan przed
nią, `peakRssMb`) i `db` (opakowanie `env.db`: liczba zapytań i transakcji,
łączny czas zapytań, najwolniejsze zapytanie — sam tekst SQL, bez parametrów
— i `maxTxJsGapMs`, najdłuższa przerwa JS między zapytaniami w otwartej
transakcji). Dla całego przebiegu: `peakHeapUsedMb`, `peakRssMb`,
`maxEventLoopDelayMs`, `skipped` i lokalnie `emailOutboxRows`. Uwaga: PGlite
działa w wątku serwera, więc lokalne opóźnienie pętli zdarzeń obejmuje też
czas zapytań — na Railway (osobny PostgreSQL) będzie niższe.

Budżety (`HEAVY_ROUTE_BUDGETS_MS` — p50 przebiegu sekwencyjnego; oraz
`HEAVY_ROUTE_HEAP_BUDGETS_MB` — dziś tylko `POST /api/exports`: 64 MB, próg
z opisu #217 po strumieniowaniu eksportu z #216; klient testu tylko zlicza
bajty odpowiedzi, nie buforuje ich) są orientacyjne,
luźniejsze niż docelowe dla Railway — łapią rażącą regresję, nie
mikroopóźnienia. Są założeniem technicznym, nie wymaganiem szkoły.
Przekroczenie budżetu którejkolwiek trasy, błędna odpowiedź (także w fazie
równoczesnej) albo wiersz w `email_outbox` dają kod wyjścia `1` z nazwą trasy
w komunikacie.

Scenariusz **nie wysyła żadnej wiadomości**: nie wywołuje `…/approve`,
`…/queue`, `…/test-send` ani workera e-mail; kampanie zostają szkicami z
migawką odbiorców, a po przebiegu skrypt sprawdza zero wierszy
`email_outbox`. Zapisy (import, pozycje wyciągu, kampanie, eksport roczny,
zamknięcie roku) są wykonywane **wyłącznie lokalnie**.

Tryb zdalny (`--target … --i-confirm-staging`, wyłącznie staging na danych
syntetycznych): te same bezpieczniki co scenariusz domyślny, wyłącznie
odczyty (operacje oznaczone `remoteSafe`), `--allow-writes` jest odrzucane.
Identyfikatory obiektów stagingu podaje się zmiennymi `LOAD_TEST_CLASS_ID`,
`LOAD_TEST_HOUSEHOLD_ID`, `LOAD_TEST_OTHER_HOUSEHOLD_ID` (gospodarstwo spoza
klasy przedstawiciela), `LOAD_TEST_RECONCILIATION_ID`, `LOAD_TEST_CAMPAIGN_ID`
(kampania z migawką — tylko podgląd); operacja bez identyfikatora albo bez
sesji swojej roli jest pomijana i wymieniona w `skipped`. Odczyty zostawiają
na stagingu zwykłe wpisy dziennika (audyt, odczyty danych rodzin, wiersze
`export_runs` listy klasy), tak jak otwarcie tych widoków w panelu.

| Data | Środowisko | Skala | Wynik / uwagi |
|---|---|---|---|
| 28.09.2026 | lokalnie, PGlite w procesie (niereprezentatywny) | domyślna (2 lata, 5 klas/rok, 40 uczniów/rok, 3000 zdarzeń audytu) | zaliczony, bez naruszeń budżetu (10 tras, przed rozszerzeniem scenariusza) |
| 30.09.2026 | lokalnie, PGlite w procesie (niereprezentatywny); kontener 4 vCPU współdzielony, load average 3–7 | domyślna (2 lata, 5 klas/rok, 40 uczniów/rok, 3000 zdarzeń audytu, import 60 wierszy) | zaliczony, bez naruszeń; 27 operacji, przygotowanie 4 s, całość 14 s; najwolniejsza `POST /api/exports` p50 545 ms |
| 30.09.2026 | jw. | pełna (`--heavy-full`: 5 lat, 50 klas/rok, 2000 uczniów, 3638 opiekunów, 5196 wpłat, 2227 wpisów księgi, 100 000 zdarzeń audytu, import 1000 wierszy) | zaliczony, bez naruszeń (po scaleniu #216); przygotowanie 14 s, całość 53 s; szczyt sterty 129 MB, RSS 839 MB; 0 wierszy `email_outbox`. Wybrane p50 (sekwencyjnie / p95 przy 5 równoczesnych): `households` 16 ms / 98 ms, `print/cards` 36 ms / 212 ms (151 KB), `ledger/export.csv` 35 ms / 173 ms, `reports/audit` 89 ms / 391 ms, `admin/audit (finance, rok)` 14 ms / 83 ms, `reconciliations/{id}/suggestions` **1217 ms** / 5,7 s (475 KB, najwolniejsze zapytanie 919 ms), `POST /api/exports` **1465 ms** (9,3 MB, sterta +18 MB, 1042 zapytania w jednej transakcji), `import/commit` 1000 wierszy **1030 ms** (podwójne kliknięcie + ponowienie 1410 ms), `snapshot (all_households)` 196 ms, `year-close close` 56 ms |
| do wykonania | staging (tylko odczyt) | pełna (5 lat, 50 klas/rok, 100 000 zdarzeń audytu) | `npm run load:test -- --scenario heavy --target https://<host stagingu> --i-confirm-staging` z identyfikatorami jak wyżej |

## Pierwszy administrator (bootstrap, #187)

Nowa baza PostgreSQL (staging lub produkcja) nie ma żadnego konta, a
zaproszenia i resety haseł wydaje wyłącznie administrator z MFA. D1 nie ma
danych do przeniesienia (#227), więc krok ten wykonuje się przy każdym
pierwszym uruchomieniu, także na stagingu. Nie wpisywać kont ręcznym SQL-em.

Krok startowy stagingu (po `npm run db:migrate:postgres`, przed pierwszym
logowaniem):

```sh
DATABASE_URL=<referencja z Railway> APP_ENV=staging \
  npm run auth:bootstrap-admin -- <adres-pierwszego-administratora> [--ttl-hours=24]
```

- Skrypt działa tylko, gdy **nie ma aktywnego administratora** (przydział
  `admin` niecofnięty, niewygasły, konto niewyłączone) i **nie czeka ważne
  zaproszenie** do roli `admin`. W przeciwnym razie kończy się czytelną
  odmową (kod 2) bez zmian w bazie. Dwa równoległe uruchomienia dają
  najwyżej jedno ważne zaproszenie (blokada tabel w transakcji).
- Zakłada konto z podanym adresem (albo używa istniejącego, niewyłączonego
  konta z tym adresem) i wydaje jednorazowe zaproszenie do roli `admin`
  (domyślnie ważne 24 h, najwyżej 72 h — założenie do potwierdzenia, D-08/D-10).
  Rolę nadaje dopiero przyjęcie zaproszenia.
- Token jest wypisany **jeden raz** na stdout (linia `token: …`). Nie jest
  zapisany w bazie (tylko SHA-256), w logach ani w audycie. Nie kopiować go
  do zgłoszeń, czatów ani protokołu. Kanał przekazania tokenu pierwszemu
  administratorowi (osobiście/telefonicznie) ustala zarząd.
- Dziennik: `user.created` (gdy konto powstało), `invitation.created`
  i `auth.bootstrap_issued` z aktorem technicznym `system:bootstrap`
  (`actor_id = NULL`), identyfikatorem konta i zaproszenia — bez e-maila
  i tokenu. Przyjęcie zaproszenia zapisuje `role_grant.created` z
  `metadata.source = 'bootstrap'`.
- `APP_ENV=production` wymaga jawnego `--allow-production` i wolno go użyć
  tylko w ramach zatwierdzonego cutover (D-20).
- Przyjęcie zaproszenia: `/login/#invite=<token>` (`POST /api/invitations/accept`)
  ustawia hasło i nadaje rolę; potem administrator włącza MFA i dalsze konta
  (zarząd, skarbnik, przedstawiciele) zaprasza przez panel. Logowanie hasłem
  i ta trasa są na gałęzi logowania (issue #3) — do jej scalenia zaproszenie
  można przyjąć wyłącznie funkcją `acceptInvitation` w testach.
- Jeśli token zaginął, poczekać do wygaśnięcia zaproszenia i uruchomić
  skrypt ponownie (poprzedniego zaproszenia bez administratora nie da się
  cofnąć przez API).

## Rotacja klucza szyfrowania MFA (`MFA_ENCRYPTION_KEY(S)`, #134)

Klucz szyfruje sekrety TOTP (`user_mfa_factors.secret_ciphertext`), nigdy nie
jest w repozytorium — tylko jako sekret usługi Railway. Wiersz czynnika jest
niezmienny (trigger), więc rotacja nie nadpisuje szyfrogramu w miejscu: nowy
wiersz na nowym kluczu, stary wyłączony (`disabled_at`). Szczegóły techniczne
i format `MFA_ENCRYPTION_KEYS`: `docs/AUTH.md`.

**Rotacja planowa** (np. cykliczna, bez podejrzenia wycieku):
1. Wygenerować nowy klucz (32 losowe bajty, np. `openssl rand -hex 32`).
2. Ustawić w zmiennych usługi Railway pierścień z OBOMA kluczami, nowym jako
   wyższa wersja: `MFA_ENCRYPTION_KEYS=2:<nowy>,1:<stary>` (usunąć osobne
   `MFA_ENCRYPTION_KEY`, jeśli była ustawiona — pierścień ją zastępuje).
   Redeploy usługi.
3. Tryb próbny: `DATABASE_URL=<referencja> MFA_ENCRYPTION_KEYS=2:<nowy>,1:<stary> npm run mfa:rotate-key`
   — sprawdzić liczbę kont do rotacji i `missing key` (musi być 0).
4. Zapis: to samo z `-- --apply`. Skrypt jest idempotentny — bezpiecznie
   uruchomić ponownie, gdyby coś przerwało pierwsze uruchomienie.
5. Po potwierdzeniu, że raport pokazuje 0 kont na starej wersji (kolejne
   uruchomienie skryptu, `rotated: 0`), usunąć stary klucz z pierścienia
   (`MFA_ENCRYPTION_KEYS=2:<nowy>` albo z powrotem `MFA_ENCRYPTION_KEY=<nowy>`)
   i zrobić redeploy.
6. Dziennik: `mfa.key_rotated` na koncie (identyfikatory czynników i wersje,
   bez sekretów) plus wynik skryptu na stdout (wyłącznie liczby).

**Rotacja po incydencie** (podejrzenie wycieku klucza): jak wyżej, ale krok 5
(usunięcie starego klucza z pierścienia) wykonać NATYCHMIAST po kroku 4, bez
czekania — ryzyko jest w tym, że stary klucz nadal działa, dopóki jest
w pierścieniu. Poinformować zarząd/IOD zgodnie z `docs/SECURITY.md`.

**Utrata klucza** (zmienna skasowana, brak kopii): nie da się odzyskać
istniejących czynników — `MFA_ENCRYPTION_KEYS`/`MFA_ENCRYPTION_KEY` bez
starej wersji daje `mfa_key_missing` (503) zamiast cichego błędu przy próbie
weryfikacji. Jedyne wyjście to reset MFA każdego dotkniętego konta
(`POST /api/admin/users/{id}/mfa-reset`, panel admina, gałąź logowania) —
każda osoba zapisuje czynnik ponownie po zalogowaniu. Komunikacja z rodzinami
o masowym resecie MFA to decyzja zarządu (szablon, kanał — D-16/D-17, jak
przy innych wysyłkach).

## Zadanie wysyłki e-mail (cron, #130)

Stan: plik konfiguracji jest w repozytorium, **usługa nie jest utworzona** w
żadnym środowisku (D-20). Szczegóły kolejki, limitów i okna: [EMAIL.md](EMAIL.md).

1. Utworzyć osobną usługę (np. `rd-email-worker`) z tym samym repozytorium i w
   ustawieniach usługi wskazać plik konfiguracji `railway.email-worker.json`
   (config as code). `railway.json` aplikacji zostaje bez crona.
2. Plik uruchamia `node scripts/email-worker.js` co godzinę (`15 * * * *`,
   UTC), z `restartPolicyType: NEVER`. To **zawsze dry-run**: przebieg zapisuje
   się w `email_worker_runs`, kolejka i dziennik limitu się nie zmieniają,
   połączenia z Brevo nie ma. Sama zmienna `EMAIL_SENDING_ENABLED=true` nie
   włącza wysyłki.
3. Włączenie wysyłki (dopiero po D-20, na stagingu wyłącznie z odbiorcami
   syntetycznymi): przeglądany PR zmieniający `startCommand` na
   `node scripts/email-worker.js --send`, w usłudze `EMAIL_SENDING_ENABLED=true`,
   `EMAIL_SEND_WINDOW_ENABLED=true` z godzinami ustalonymi przez zarząd (D-16;
   propozycja zachowawcza: pon.–pt. 09:00–18:00 `Europe/Brussels`) i te same
   `EMAIL_SEND_WINDOW_*` w usłudze aplikacji. Okno liczy zadanie w strefie
   Brukseli, więc cron w UTC nie przesuwa go przy zmianie czasu.
4. Zmienne usługi: `DATABASE_URL` (sieć prywatna), `APP_ENV`, `APP_WRITE_MODE`,
   `EMAIL_*`, `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME`.
5. Kontrola działania: zarząd i skarbnik widzą w panelu `email/` alarm
   „Zadanie wysyłki nie działa” (`GET /api/email/worker-status`:
   `worker_never_ran`, `worker_stale`, `worker_dry_run_only`), gdy kampania roku
   czeka na wysyłkę, a przebiegu (albo przebiegu wysyłki) nie było dłużej niż
   `EMAIL_WORKER_ALARM_HOURS`. Admin techniczny: `/api/admin/ops-status` i
   `/health/jobs` (`email_worker_stale`, sekcja „Stan systemu”).

## Backup PostgreSQL

Stan: skrypty i dziennik przebiegów są w repozytorium (#90, `npm run backup:postgres`,
`npm run restore:drill`, tabela `backup_runs`); **żadna usługa cron nie jest
uruchomiona** — nie ma deploymentu Railway, a miejsce kopii poza Railway to
decyzje D-01/D-20 (nierozstrzygnięte).

1. Włączyć w usłudze PostgreSQL harmonogram backupów wolumenu
   (dzienny/tygodniowy/miesięczny; retencja wg Railway: ok. 6 dni / 1 miesiąc /
   3 miesiące). Sprawdzić, czy plan workspace obejmuje backupy — dokumentacja
   Railway nie opisuje PITR dla wolumenów, więc **nie zakładać PITR**: bez niego
   RPO = odstęp między kopiami (backup wolumenu: do doby, zrzut logiczny: wg
   harmonogramu poniżej).
2. Przed każdą migracją schematu lub importem wykonać ręczny backup i zapisać
   jego identyfikator w protokole (ręczny backup wolumenu nie może przekroczyć
   50% pojemności wolumenu; funkcja Railway jest oznaczona jako „w rozwoju”).
3. Kopia logiczna poza Railway — `npm run backup:postgres` (usługa cron
   `rd-backup`, **do uruchomienia po decyzji D-01/D-20**): `pg_dump --format=custom`
   w migawce (`pg_export_snapshot`), szyfrowanie po stronie klienta kluczem
   publicznym, zapis do drugiego magazynu S3 poza Railway, wpis w `backup_runs`.
   Skrypt odmawia działania bez klucza szyfrującego i celu, nie loguje adresu
   bazy, nazwy bucketu ani kluczy, a plik tymczasowy (katalog 0700) usuwa też
   przy błędzie. Klucz prywatny jest poza Railway; kto go trzyma — decyzja
   zarządu. Czas przechowywania kopii — D-04 (retencja).
   Wraz z kopią zapisywany jest **raport zgodności** (liczności wszystkich
   tabel, sumy kwot w centach, skróty SHA-256 zawartości tabel finansowych,
   powiązań rodzina–uczeń–opiekun i audytu, lista wyzwalaczy i migracji) —
   z tej samej migawki co zrzut, bez danych osobowych (`backup_runs.row_counts`,
   `backup_runs.sums`).
4. Harmonogram do uruchomienia po decyzji (propozycja, nie konfiguracja):

   | Usługa | Harmonogram (UTC) | Polecenie | Uwagi |
   |---|---|---|---|
   | `rd-backup` | codziennie, np. `17 2 * * *` | `npm run backup:postgres` | osobna usługa Railway z własnym plikiem konfiguracji z `cronSchedule` (np. `railway.backup.json`); `railway.json` aplikacji zostaje bez crona (`tests/railway-config.test.js`); przebieg nakładający się w tym samym dniu jest pomijany (klucz dnia) |
   | `rd-restore-drill` | co tydzień, np. `43 4 * * 1`, najpierw staging | `npm run restore:drill` | odtwarza do OSOBNEJ bazy „drill” (inny host lub nazwa bazy niż `DATABASE_URL` — twarda kontrola); na produkcji wymaga `--allow-production` |

   Alert „brak udanej kopii > 26 h” ma źródło danych: ostatni wiersz
   `kind = 'backup'`, `result = 'success'` w `backup_runs`
   (`GET /health/jobs`, `backup_too_old`; opis w sekcji „Stan systemu”).
   Pliki usług cron i zmienne (`BACKUP_*`, `RESTORE_DRILL_*`) dodać dopiero
   po wyborze magazynu; do tego czasu skrypty można uruchamiać wyłącznie
   lokalnie (patrz niżej).

## Próbne odtworzenie PostgreSQL

**Zasada:** backupu wolumenu Railway nie da się przywrócić do innego projektu
ani środowiska — przywrócenie montuje nowy wolumen w TEJ SAMEJ usłudze
(staged change). Dlatego „próba odtworzenia” wolumenu na stagingu jest
niemożliwa, a na produkcji podmieniłaby wolumen produkcyjny. Przywrócenie
wolumenu (wariant A) jest wyłącznie **awaryjnym odtworzeniem w miejscu**, po
osobnej decyzji zarządu/szkoły i backupie stanu bieżącego — nigdy próbą.
Próby wykonujemy wariantem B (zrzut logiczny) lub C (eksport roczny).
Źródło: [Railway: backup i odtworzenie PostgreSQL](https://docs.railway.com/guides/postgres-backups-restores)
(sprawdzone 27.09.2026; dokumentacja zmienia się — przed decyzją sprawdzić ponownie).

### Lokalnie na danych syntetycznych (można uruchamiać dziś)

`npm run restore:drill:local` (wymaga lokalnego PostgreSQL z `pg_dump`/`pg_restore`
i zmiennej `RD_LOCAL_PG_ADMIN_URL` albo `RD_TEST_PG_URL`; odmawia hosta innego
niż lokalny, nie używa Railway ani sekretów produkcji). Skrypt tworzy dwie
tymczasowe bazy, nakłada migracje i zestaw `scripts/lib/synthetic-seed.js`
(rodzeństwo, dwoje opiekunów przy dziecku, wpłaty częściowe, korekty, wpisy
księgi i audytu), wykonuje kopię z szyfrowaniem, odtwarza ją prawdziwym
`pg_restore` i porównuje raport zgodności. Niezgodność, uszkodzona kopia
(zła suma SHA-256) albo zaległe migracje = kod wyjścia 1. Test:
`RD_TEST_PG_URL=… node --test tests/restore-drill-local.test.js` (bez zmiennej
pomijany; testy raportu na PGlite działają zawsze). Tabele tylko do
dopisywania odtwarzają się z zachowanymi wyzwalaczami bez `--disable-triggers`
(format custom ładuje dane przed utworzeniem wyzwalaczy) — test sprawdza, że
`UPDATE` na `audit_events` po odtworzeniu nadal jest odrzucany.
Ograniczenia: w zestawie syntetycznym `email_outbox` jest pusty (jego
wyzwalacze są sprawdzane, wiersze nie), a lokalna baza nie odtwarza
parametrów Railway ani czasu przez sieć — RTO z tej próby to tylko dolna granica.

### Procedura na stagingu i przed cutover (`npm run restore:drill`, po decyzji D-01/D-20)

1. Kopia z punktu 3 wyżej (raport zgodności jest zapisany razem z kopią).
2. Pobrać kopię z drugiego magazynu, sprawdzić SHA-256, odszyfrować kluczem
   prywatnym (poza Railway), `pg_restore` do **osobnej, jednorazowej** bazy
   „drill” — skrypt to robi i sam sprawdza, że baza docelowa różni się od źródłowej.
3. Migrator na odtworzonej bazie — oczekiwany wynik: `No pending migrations.`
   (sumy kontrolne migracji zgodne); zaległe migracje = błąd próby.
4. Raport z odtworzonej bazy jest porównywany z raportem z chwili kopii;
   jakakolwiek różnica = błąd. Wynik (`kind = 'restore_drill'`) trafia do
   `backup_runs` bez danych osobowych.
5. Sprawdzić ręcznie rodzinę z rodzeństwem, dziecko z dwojgiem opiekunów,
   wpłatę częściową z korektą (lokalnie robi to test).
6. Zmierzyć czas odtworzenia (RTO) i wiek kopii (RPO); usunąć bazę „drill”.
   Wpisać wynik do tabeli.

Kopia bez raportu (sprzed tego mechanizmu) daje wynik `comparison: no_baseline`
— to nie jest zgodność i nie zamyka pozycji „próbne odtworzenie” na liście odbioru.

Uzupełnieniem backupu jest wersjonowany eksport roczny z manifestem SHA-256
i testem odtworzenia do pustej bazy (`scripts/verify-export.js`), opisany w
[EXPORT.md](EXPORT.md). Wynik takiej próby także wpisać do tabeli poniżej
(wariant C — eksport roczny).

| Data | Środowisko | Kto | Backup (id/czas) | Wariant | Czas odtworzenia | Zgodność raportu | Wynik / uwagi |
|---|---|---|---|---|---|---|---|
| 29.09.2026 | lokalnie, PostgreSQL 16, dane syntetyczne (`npm run restore:drill:local`) | agent (test automatyczny) | tymczasowa baza źródłowa | B (zrzut logiczny, szyfrowany) | ok. 3 s (dolna granica, lokalnie) | zgodny (liczności, sumy, skróty) | nie zastępuje próby na stagingu |
| do wykonania | staging | | | | | | |
| do wykonania | production (przed cutover) | | | | | | |

## Backup dokumentów (Storage Bucket)

Railway nie oferuje automatycznych backupów, wersjonowania ani blokad obiektów
w bucketach. Dlatego:

1. Metadane (`documents`: klucz obiektu, typ, rozmiar, autor, `sha256`) są w
   PostgreSQL i podlegają backupowi bazy.
2. **Lokalizacja i dostawca drugiej kopii oraz umowa powierzenia nie są
   wybrane (D-01, D-20, IOD).** Dopóki nie ma decyzji, procedura cykliczna
   poniżej jest tylko opisem — nie jest uruchomiona ani zaplanowana, a
   `railway.json` nie zawiera usługi cron kopii.
3. Retencja kopii i usuwanie z kopii — D-04. **Usunięcie dokumentu po okresie
   retencji musi objąć także kopię** (i kopie starszych przebiegów):
   skrypt kopii celowo niczego nie usuwa w celu, więc usunięcie z kopii to
   osobna, zatwierdzona i zapisana w dzienniku operacja operatora. Do czasu
   decyzji D-04 nie usuwamy niczego ani ze źródła, ani z kopii.

### Kopia cykliczna (do uruchomienia po decyzji D-01/D-20)

Gotowe narzędzia (kod w repozytorium, testy na atrapie magazynu):

- `npm run backup:storage` (`scripts/backup-storage.js`, `src/pg/storage-backup.js`)
  kopiuje wyłącznie **nowe** obiekty `docs/*` (dokumenty) i `photos/*` (pliki zdjęć
  galerii, tabela `news_photo_files`) z bucketu źródłowego (`BUCKET_*`,
  poświadczenia tylko do odczytu) do drugiego magazynu S3 w UE
  (`STORAGE_BACKUP_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_ACCESS_KEY_ID`,
  `_SECRET_ACCESS_KEY`, opcjonalnie `_URL_STYLE`; poświadczenia celu tylko do
  zapisu, bez `DeleteObject`, jeśli dostawca na to pozwala). Nigdy nie usuwa w
  celu. Liczy SHA-256 źródła i kopii względem `documents.sha256` / `news_photo_files.sha256`; niezgodny
  skrót lub brak obiektu w źródle daje kod wyjścia 1. Odmawia pracy w
  `APP_ENV=production` (lub nieznanym) bez `--allow-production`. Raport (liczby,
  bez nazw plików; sumy oraz rozbicie `bySet` na dokumenty i zdjęcia, w tym
  obiekty osierocone w źródle) trafia na stdout i do `backup_runs`
  (`storage_backup`).
- `npm run backup:storage:verify` (`scripts/verify-storage-backup.js`,
  `src/pg/storage-backup-verify.js`) — niezależna weryfikacja kopii: buduje
  manifest SHA-256 z faktycznej treści kopii (katalog pobrany przez operatora),
  porównuje go z `documents` i `news_photo_files` (brakujące obiekty, niezgodne skróty i rozmiary,
  osierocone w kopii) i opcjonalnie wykonuje **próbę odtworzenia** próbki
  (`--restore-dir`, `--sample N`) do lokalnego katalogu, sprawdzając SHA-256
  odtworzonych bajtów. Cel odtworzenia może być tylko lokalny (katalog albo
  pamięć) — narzędzie nie zapisuje do bucketu. Raport zawiera liczby i
  identyfikatory techniczne wierszy `documents`, bez kluczy obiektów i nazw
  plików. Kod wyjścia 1 przy brakach lub niezgodnościach. Osierocone obiekty w
  kopii są tylko zgłaszane (nie psują wyniku).
- `reportStorageConsistency` (`src/pg/storage-backup-verify.js`) — raport
  zgodności bucketu z bazą bez pobierania treści: dla `docs/` i `photos/`
  liczba wierszy, obiektów, obiektów osieroconych (w buckecie bez wiersza,
  tylko ostrzeżenie) i wierszy bez obiektu (identyfikatory techniczne, psują
  wynik). Test `tests/storage-backup-photos.test.js` potwierdza też, że plik
  odtworzony z kopii do nowego magazynu nadal wymaga sesji i uprawnień do klasy.
- Usunięcie dokumentu lub zdjęcia po okresie retencji (D-04) musi objąć także
  kopię; narzędzia nigdy nie usuwają, więc czyszczenie kopii to osobna,
  jawnie zatwierdzona operacja.

Procedura po decyzji (nie wykonana):

1. Wybrać dostawcę i lokalizację (D-01/D-20), podpisać umowę powierzenia,
   utworzyć prywatny bucket kopii z szyfrowaniem; włączyć wersjonowanie lub
   Object Lock, jeśli dostawca je oferuje.
2. Dodać osobną usługę cron Railway (`npm run backup:storage`, harmonogram co
   najmniej tygodniowo oraz ręcznie przed operacją masową; wspólna z #90 albo
   obok) ze zmiennymi `DATABASE_URL` (tylko odczyt), `BUCKET_*` (tylko odczyt),
   `STORAGE_BACKUP_S3_*`. Najpierw staging na plikach syntetycznych.
3. Po każdym przebiegu sprawdzić raport; niezerowy kod wyjścia lub brak wpisu
   w `backup_runs` > 8 dni traktować jako alarm (`/api/admin/ops-status`).
4. Co kwartał: pobrać kopię do katalogu roboczego i uruchomić
   `npm run backup:storage:verify -- --backup-dir <kopia> --restore-dir <cel> --sample 20`
   na bazie stagingowej lub odtworzonej; wynik wpisać do tabeli poniżej.
5. Na stagingu dodatkowo: przywrócić próbkę do bucketu stagingu i pobrać przez
   API aplikacji (autoryzacja + krótki podpisany URL); dla dokumentu klasowego i
   finansowego próba przez przedstawiciela innej klasy musi dać `403` (kopia
   nie omija autoryzacji — dostęp zależy wyłącznie od wiersza `documents` i
   sesji, nie od pochodzenia obiektu).
6. Ręczny `rclone sync`/`aws s3 sync` zostaje wyłącznie wariantem awaryjnym; nie
   stosować `rclone copy` (nie `sync`) i nigdy opcji usuwania w celu.

Zakres obecnej kopii to prefiks `docs/` (dokumenty z `documents`). Zdjęcia
aktualności (`photos/`, `news_photos`) **nie są jeszcze objęte** ani kopią, ani
weryfikacją — osobny follow-up po decyzji o publikacji zdjęć.

| Data | Kto | Liczba obiektów źródło/kopia | Zgodność z `documents` | Wynik / uwagi |
|---|---|---|---|---|
| do wykonania (po D-01/D-20) | | | | |

## Tryb tylko do odczytu (#143)

Wstrzymanie zapisów bez wyłączania panelu: okno serwisowe, cutover, incydent.
Sterowanie wyłącznie zmienną `APP_WRITE_MODE` (`normal` domyślnie, `read_only`).
To opis procedury do wykonania po decyzji zarządu — repozytorium nie zmienia
zmiennych ani nie wykonuje redeployu Railway.

**Zachowanie w `read_only`** (kod: `src/write-mode.js`, `src/pg/app.js`):

- Każde żądanie `/api/*` metodą zmieniającą stan (`POST`, `PUT`, `PATCH`, `DELETE`)
  dostaje `503` z `{ "error": "read_only" }` i nagłówkiem `Retry-After`
  (300 s), **przed** routingiem modułów i przed jakimkolwiek zapisem — także dla
  webhooka Brevo (dostawca ponowi zdarzenie). Kod `read_only` jest inny niż
  `service_unavailable`; komunikat w `shared/messages.js`, opis w
  [API_ERRORS.md](API_ERRORS.md). Odrzucenie jest logowane jako
  `write_mode_rejected` (metoda i ścieżka, bez danych osobowych).
- `GET` i `/health` działają bez zmian, z zachowaniem granic ról; przedstawiciel
  klasy nadal widzi wyłącznie przypisane klasy. `/health/ready` dodaje
  `write_mode`, ale pozostaje `200`, gdy proces i baza są zdrowe.
- Odchylenie od pierwotnej propozycji: poza `/api/logout` zwolnione jest też
  `/api/login` (logowanie hasłem), by w oknie serwisowym dało się sprawdzić
  dostęp. Logowanie zapisuje sesję, więc to świadomy wyjątek; inne trasy konta
  (zaproszenia, zmiana i reset hasła, MFA) są blokowane.
- Worker e-mail (`scripts/email-worker.js`) kończy przebieg z
  `stoppedReason: 'read_only'`, bez połączenia z bazą i bez zmian w
  `email_outbox`. **Worker jest osobnym procesem** — zmienna musi być ustawiona
  także w jego usłudze (lub jako zmienna współdzielona), inaczej kolejka będzie
  dalej wysyłana.
- `GET /api/session` zwraca `writeMode`; wspólna powłoka paneli
  (`shared/shell.js`) pokazuje wtedy baner „Trwają prace serwisowe — zapisy
  wstrzymane”. Baner to tylko informacja; kontrolę wykonuje serwer. Przyciski
  zapisu nie są osobno wyłączane — użytkownik po próbie zapisu widzi komunikat
  `read_only`.
- Nieznana wartość zmiennej: serwer nie startuje (log błędu konfiguracji), nie
  przyjmuje po cichu `normal`. Przy starcie tryb `read_only` jest logowany
  (`write_mode_active`). Administrator widzi tryb w `GET /api/admin/ops-status`.
- Brak licznika odrzuconych zapisów w `http_metrics` — jest tylko log
  `write_mode_rejected`. Czy licznik jest wymagany, to decyzja do podjęcia
  (nie ma dla niej wpisu w [DECISIONS.md](DECISIONS.md)).

**Włączenie (po decyzji, wykonuje administrator techniczny):**

1. Uzgodnić z zarządem okno i osobę ogłaszającą je użytkownikom panelu (nie
   rodzicom). Wpis w protokole otwierany przed zmianą: kto, kiedy, powód,
   przewidywany czas.
2. W Railway ustawić `APP_WRITE_MODE=read_only` w usłudze aplikacji **i** workera
   e-mail. Zmiana zmiennej powoduje redeploy (kilka minut) — założenie:
   akceptowalne dla okna serwisowego; w incydencie przełącznik w bazie z
   wpisem do `audit_events` byłby szybszy, ale to osobny krok, nieobjęty tym PR.
3. Sprawdzić: `/health/ready` zwraca `write_mode: "read_only"`, panel pokazuje
   baner, próba zapisu na koncie testowym daje `503 read_only`, log zawiera
   `write_mode_active`.
4. Zapisy przyjęte przed redeployem są w bazie; żądania w trakcie redeployu
   mogły zostać przerwane — po powrocie sprawdzić ostatnie wpłaty w panelu
   (ponowienie z tym samym `Idempotency-Key` nie tworzy duplikatu).

**Wyłączenie:** ustawić `APP_WRITE_MODE=normal` (lub usunąć zmienną) w obu
usługach, poczekać na redeploy, sprawdzić `/health/ready` (`write_mode:
"normal"`), zniknięcie banera i jeden zapis testowy na koncie testowym.
Dopisać do protokołu: kto, kiedy, wynik. Po wyłączeniu worker wznawia wysyłkę
z kolejki — przejrzeć ją, jeśli okno trwało długo (nie wysyłać przypomnień bez
zatwierdzenia, AGENTS.md).

## Plan cutover (do wykonania po D-20)

Warunki wstępne: wszystkie punkty listy odbioru poniżej zielone, decyzja
D-20 zapisana, okno serwisowe uzgodnione z zarządem.

1. Ogłosić okno serwisowe użytkownikom panelu (nie rodzicom).
2. Wykonać backup D1 i PostgreSQL produkcji (pusta baza po migracjach);
   zapisać identyfikatory.
3. Zatrzymać zapisy w starym Workerze (tryb tylko do odczytu lub wyłączenie
   tras zapisu). Nowe API na Railway w trakcie importu i porównania raportu
   trzymać w `APP_WRITE_MODE=read_only` (sekcja „Tryb tylko do odczytu”);
   powrót do `normal` dopiero po podpisanym raporcie zgodności (pkt 5) i
   udanym pierwszym logowaniu administratora (pkt 6–7). Pierwszy administrator
   powstaje skryptem (`auth:bootstrap-admin`), nie trasą API, więc tryb go nie
   blokuje.
4. Eksport D1, snapshot i transakcyjny import do pustej bazy wg
   [D1_POSTGRES_MIGRATION.md](D1_POSTGRES_MIGRATION.md).
5. Porównać raport zgodności (liczności, sumy wpłat, przychody/wydatki);
   podpis dwóch osób (np. skarbnik + członek zarządu).
6. Wydać zaproszenie pierwszemu administratorowi (`npm run auth:bootstrap-admin
   -- <adres> --allow-production`, sekcja „Pierwszy administrator”); administrator
   ustawia hasło i MFA, potem zaprasza pozostałe konta.
7. Wykonać ręczny deploy produkcji na Railway, sprawdzić `/health`, logowanie,
   panel wpłat i księgi na koncie testowym.
8. Przełączyć domenę/DNS na Railway; stary Worker pozostaje zatrzymany do
   zapisu, ale nie usunięty (#42).
9. Obserwacja 72 h: błędy, logowania, koszty.

## Plan rollback

- **Przed przełączeniem domeny** (raport niezgodny, błąd importu): nie
  uruchamiać nowego API; usunąć/wyczyścić docelową bazę, przywrócić zapisy w
  niezmienionym D1. Nie scalać baz.
- **Po przełączeniu, błąd aplikacji bez utraty danych**: rollback do
  poprzedniego deploymentu w Railway (Deployments → Redeploy/Rollback).
- **Po przełączeniu, uszkodzenie danych**: wstrzymać zapisy (`APP_WRITE_MODE=read_only`,
  sekcja „Tryb tylko do odczytu”; odczyt dla skarbnika pozostaje), przywrócić
  PostgreSQL z backupu sprzed operacji (wolumen lub PITR do nowej usługi),
  porównać raport, dopiero potem wznowić. Zapisy wykonane po backupie
  odtworzyć ręcznie z dziennika zdarzeń jako nowe wpisy/korekty.
- **Powrót do D1** po przełączeniu jest możliwy tylko wtedy, gdy w PostgreSQL
  nie było nowych zapisów; w przeciwnym razie wymaga osobnej decyzji zarządu,
  bo grozi dwoma źródłami prawdy.
- Każdy rollback zapisać w protokole: kto, kiedy, przyczyna, wynik.

## Stan systemu (#149)

Prototyp — nie do pracy na danych rodzin. Administrator widzi stan techniczny
bez potrzeby dostępu do Railway:

- **`GET /api/admin/ops-status`** (wyłącznie rola `admin`, `Cache-Control: no-store`):
  migracje (nałożone/zaległe), ostatni przebieg workera e-mail, stan kolejki
  (`email_outbox`), ostatnia udana kopia PostgreSQL/bucketu/próba odtworzenia
  (#90, #103 — dziennik `backup_runs`, jeśli już scalone; w przeciwnym razie
  `no_data`, nie fałszywe „w normie”), ostatni eksport roczny, tryb pracy
  (`APP_WRITE_MODE`, #143), wersja aplikacji (`RAILWAY_GIT_COMMIT_SHA`) i
  `loginPressure` — konta z wieloma błędnymi próbami logowania w oknie (#126;
  identyfikator konta i liczby, bez e-maili i adresów IP; próg
  `LOGIN_PRESSURE_THRESHOLD`, domyślnie 15; to sygnał, nie blokada).
  Tylko liczby, znaczniki czasu i kody — bez adresów, nazw rodzin i treści.
- **`GET /health/jobs`** — heartbeat dla monitora zewnętrznego, osobny od
  `/health/ready` (Railway). Chroniony tokenem stałej długości porównania
  (`HEALTH_JOBS_TOKEN` w nagłówku `Authorization: Bearer …`); brak lub zły
  token → `401`. Zwraca `503` z nazwą przekroczonego progu (`backup_too_old`,
  `email_worker_stale`, `email_queue_too_old`) — bez liczb i dat w
  odpowiedzi. Progi są konfiguracją (`BACKUP_MAX_AGE_HOURS`,
  `EMAIL_WORKER_MAX_AGE_HOURS`, `EMAIL_QUEUE_MAX_AGE_HOURS`), nie kodem.
- Widok „Stan systemu” w panelu `admin/` (`admin/ops-status.js`, czyste
  funkcje w `admin/ops-status-core.js`): tabela nad odpowiedzią `ops-status`,
  kolor wyłącznie dla stanu (w normie / uwaga / błąd / brak danych, zawsze z
  etykietą tekstową). Widok nie zna progów `/health/jobs` — stan „uwaga/błąd”
  wynika tylko z faktów w odpowiedzi (nieudany przebieg, zaległa migracja,
  wiadomości `failed`); widzi go wyłącznie `admin` (serwer sprawdza rolę).
- Runbook incydentów, który się na to powołuje: [`RUNBOOK.md`](RUNBOOK.md).
- Narzędzie monitora zewnętrznego, jego adresaci i dyżur/zastępstwa — do
  decyzji zarządu (nierozstrzygnięte tutaj).

## CI i runnery (#153)

- **Od upublicznienia repozytorium CI działa wyłącznie na runnerach GitHub
  `ubuntu-latest`.** Kod z PR-ów spoza zespołu nie może wykonywać się na
  naszych maszynach. Workflow używa `pull_request` (nie `pull_request_target`),
  nie ma sekretów, a `permissions` to `contents: read`.
- **Do zrobienia przez administratora organizacji (poza repozytorium)**:
  odłączyć runnery self-hosted od publicznego repozytorium (Settings → Actions →
  Runners → usunąć albo wyłączyć dostęp repozytorium do grupy runnerów) i
  ustawić „Require approval for all outside collaborators” (Settings → Actions →
  General → Fork pull request workflows). Opisy poniżej o runnerze self-hosted
  są historyczne i dotyczą wyłącznie takiego runnera, gdyby był używany
  do prywatnych repozytoriów.
- Usługa PostgreSQL w jobie `test-pg-real` jest efemeryczna, dostępna tylko na
  runnerze; jej hasło (`rd_ci_only`) nie jest sekretem i nie chroni żadnych
  danych.

### Historia: runner self-hosted

- **Kto zarządza runnerem i organizacją GitHub**: ustalenie zespołu
  technicznego (oddzielenie dostępu technicznego od roli skarbnika —
  `docs/SECURITY.md`, sekcja „Dostęp”). Nie jest to decyzja zarządu.
- **Stan dziś (do potwierdzenia przez administratora runnera, brak dostępu
  do konfiguracji maszyny z tego repozytorium)**: 17 runnerów self-hosted
  współdzielonych między agentami (`.github/workflows/ci.yml`, komentarz o
  `concurrency`, #111). Runner wykonuje `npm ci` i skrypty z każdego PR,
  także z forka w organizacji (repozytorium ma widoczność `internal`).
  `permissions: contents: read` i `persist-credentials: false` są ustawione
  na wszystkich krokach `checkout`.
- **Wymagane docelowo** (do potwierdzenia/wdrożenia przez administratora
  runnera — poza zakresem tego repozytorium):
  - runner efemeryczny (nowa maszyna/kontener na job) albo czyszczony po
    każdym jobie (workspace, `~/.npmrc`, zmienne środowiskowe);
  - brak sekretów Railway i Brevo na runnerze — CI nie ma i nie powinno mieć
    dostępu do `DATABASE_URL`, kluczy Brevo ani `MFA_ENCRYPTION_KEY(S)`
    (żaden krok w `ci.yml` ich nie odczytuje: testy używają PGlite, e-mail
    nie jest wysyłany w CI);
  - brak dostępu do sieci lokalnej szkoły;
  - w ustawieniach repozytorium: „Require approval for all outside
    collaborators” (uruchomienie CI dla PR spoza zaufanych współpracowników
    wymaga ręcznego zatwierdzenia).
- **Higiena zależności**:
  - job `audit` (`ci.yml`) uruchamia `npm audit --omit=dev --audit-level=high`
    (blokujący dla zależności produkcyjnych), `npm audit --audit-level=critical`
    (blokujący dla całego drzewa) i `npm audit signatures`; pełny raport trafia
    jako artefakt `npm-audit-report` (14 dni);
  - `.github/dependabot.yml`: `npm` co tydzień (zależności deweloperskie w
    jednej grupie, produkcyjne osobno) i `github-actions` co miesiąc — bez
    automatycznego scalania, każdy PR przechodzi pełne CI;
  - **wyjątki od blokady audytu** (podatność bez dostępnej poprawki):
    zapisać tutaj z datą wpisu, numerem CVE/advisory, uzasadnieniem i datą
    przeglądu (maks. 90 dni); dziś lista jest pusta (`npm audit
    --package-lock-only`, 2026-09-27: 0 podatności, 177 pakietów);
  - `npm ci --ignore-scripts` we wszystkich jobach CI: skrypty instalacyjne
    zależności (`workerd`, `esbuild` z `wrangler`, `fsevents`) nie
    uruchamiają się na runnerze. Sprawdzone lokalnie: `npm run build`,
    `npm run smoke`, `npm audit signatures` i testy przechodzą bez nich
    (binaria dostarczają pakiety platformowe). Nowa zależność wymagająca
    skryptu instalacyjnego wymaga świadomej decyzji i wpisu tutaj;
  - `npm audit signatures` działa w jobie `audit` po `npm ci` (wymaga dostępu
    runnera do rejestru npm, nie do sieci lokalnej); `permissions` w
    `ci.yml`: wyłącznie `contents: read` na poziomie workflow, brak
    `pull_request_target` i sekretów (pilnuje `tests/ci-supply-chain.test.js`);
  - **procedura dla administratora runnera/organizacji** (nie zmieniana z
    repozytorium): (1) potwierdzić i zapisać tu, czy runner jest
    efemeryczny lub czyszczony po jobie; (2) hook `actions-runner-cleanup.sh`
    zgłasza `flock: Permission denied` na `docker-prune.lock` — naprawić
    uprawnienia pliku blokady; (3) ustawić „Require approval for all outside
    collaborators”; (4) po wdrożeniu Dependabota jednorazowo sprawdzić na
    gałęzi testowej z celowo podatną wersją pakietu, że job `audit` oblewa
    (bez scalania); (5) po #42 usunąć `wrangler`;
  - akcje GitHub w `ci.yml` przypięte do pełnego SHA (komentarz z numerem
    wersji obok); Dependabot aktualizuje SHA automatycznie.
  - po zamknięciu starej ścieżki Worker/D1 (#42): usunięcie `wrangler` z
    `devDependencies` zmniejszy powierzchnię audytu.

## Lista odbioru (#31, #41, #16)

| Kryterium | Dowód | Stan |
|---|---|---|
| Pełne CI (testy, buildy, smoke, migracje D1) | `.github/workflows/ci.yml` | w repo |
| Konfiguracja Railway bez sekretów, region UE, bez migracji przy starcie | `railway.json`, `tests/railway-config.test.js` | w repo |
| Test wolumenu 1000 uczniów / 2000 kontaktów / 50 użytkowników | `tests/postgres-volume.test.js` (PGlite) | w repo; powtórzyć na stagingu |
| Testy bezpieczeństwa: role, MFA, zakres przedstawiciela, ochrona plików | #35, #39 | do wykonania |
| Równoważność starego i nowego API (te same żądania, porównanie statusów i JSON na danych syntetycznych) | `docs/EQUIVALENCE.md`, `tests/api-parity-session.test.js`, `tests/pg-payments-api.test.js`, `tests/pg-ledger-api.test.js` (#35–#38) | w repo (na danych syntetycznych); powtórzyć na stagingu |
| Staging Railway na danych syntetycznych | protokół | do wykonania |
| Test 50 równoczesnych użytkowników na stagingu | `npm run load:test -- --target … --i-confirm-staging`, tabela „Wyniki” | skrypt w repo, pomiar lokalny (PGlite, niereprezentatywny); staging do wykonania |
| Backup PostgreSQL i próbne odtworzenie | tabela wyżej | do wykonania |
| Backup i próbne odtworzenie dokumentów | tabela wyżej | do wykonania |
| Limity kosztów i alerty | ustawienia Usage, protokół | do wykonania |
| Readiness, logi JSON z redakcją, łagodne zamykanie | `/health/ready`, `src/log.js`, `tests/health-ready.test.js`, `tests/log.test.js`, `tests/server-shutdown.test.js` | w repo; sprawdzić na stagingu |
| Monitoring i adresaci alertów | tabela monitoringu | do wykonania, adresaci do decyzji |
| Plan cutover i rollback | ten dokument | spisany, niezatwierdzony |
| Zgoda na produkcję | [D-20](DECISIONS.md) | otwarta |

**Żaden produkcyjny deploy, import danych rodzin ani wysyłka do rodziców nie
może nastąpić bez decyzji szkoły/IOD zapisanej w D-20.**

Źródła techniczne sprawdzone 27.09.2026:

- [Railway: schemat config-as-code](https://railway.com/railway.schema.json)
- [Railway: regiony](https://docs.railway.com/deployments/regions)
- [Railway: backup i odtworzenie PostgreSQL](https://docs.railway.com/guides/postgres-backups-restores)
- [Railway: Storage Buckets](https://docs.railway.com/storage-buckets)
- [Railway: limity użycia](https://docs.railway.com/reference/usage-limits)
