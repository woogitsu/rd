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
| Test konfiguracji | `tests/railway-config.test.js` | brak migracji/odtworzenia przy starcie, brak sekretów, region UE |
| Smoke test | `npm run smoke` (`scripts/smoke-postgres.js`) | migracje na PGlite w pamięci (dwukrotnie, druga bez zmian), readiness po migracjach, serwer na losowym porcie `127.0.0.1`, `/health`, `/health/ready` bez bazy (`503`) i przez prawdziwy HTTP z migracjami (`200`), wszystkich 13 paneli (`STATIC_PREFIXES`), nagłówki, `404` dla ścieżek prywatnych/traversal i brak `*.map`, granice ról na poziomie HTTP |
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
| `APP_ENV` | aplikacja / skrypty | `staging` lub `production`; lokalne: `development`, `test` (wielkość liter bez znaczenia, `prod` = `production`; wspólna normalizacja `src/app-env.js`). Brak lub nieznana wartość (literówka) jest zachowawczo traktowana jak produkcja przy niebezpiecznych operacjach: import wymaga `IMPORT_ENABLED=true`, a migracja, odtworzenie, kopia storage, test odtworzenia, bootstrap administratora i `storage:smoke` odmawiają bez `--allow-production` (skrypty wypisują ostrzeżenie); walidacja startowa serwera opisana niżej. Ustaw jawnie |
| `PUBLIC_BASE_URL` | aplikacja | **wymagana** poza środowiskiem lokalnym: `https://host` bez ścieżki, osobny dla każdego środowiska |
| `MFA_ENCRYPTION_KEY` (albo `MFA_ENCRYPTION_KEYS`) | aplikacja | **wymagany** poza środowiskiem lokalnym: klucz 32 bajty (sekret), rotacja: sekcja niżej |
| `TRUST_PROXY` | aplikacja | **wymagana** poza środowiskiem lokalnym: `1` lub `true` (za proxy Railway; inaczej wspólny licznik prób logowania na IP) |
| `BREVO_WEBHOOK_SECRET` | aplikacja | **wymagany** poza środowiskiem lokalnym: co najmniej 32 znaki (sekret) |
| `DATABASE_URL` | aplikacja | referencja do prywatnego adresu PostgreSQL (`*.railway.internal`), nie publiczny TCP proxy |
| `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` | aplikacja | referencje do zmiennych Storage Bucket (#39) |
| `BREVO_API_KEY` | aplikacja / worker | dopiero w #40; na stagingu klucz bez możliwości wysyłki do rodziców |

Sesje i MFA mogą wymagać dodatkowych sekretów — ich nazwy dopisuje PR #35.

### Walidacja konfiguracji przy starcie (#114)

Przy `APP_ENV` innym niż brak wartości, `development` i `test` serwer
(`src/server.js`, `validateConfig` w `src/config.js`) odmawia startu z kodem
wyjścia `1` i zdarzeniem `config_invalid`, gdy `PUBLIC_BASE_URL` nie jest
`https://host` bez ścieżki, `MFA_ENCRYPTION_KEY` (albo `MFA_ENCRYPTION_KEYS`) nie
jest poprawnym kluczem 32 bajtów, `TRUST_PROXY` nie jest `1`/`true` albo
`BREVO_WEBHOOK_SECRET` ma mniej niż 32 znaki. Log zawiera wyłącznie **nazwy**
niepoprawnych zmiennych, nigdy wartości. Nieznana wartość `APP_ENV` (np.
literówka `prodution`) jest traktowana zachowawczo, czyli jak staging/production
— pełne ujednolicenie obsługi `APP_ENV` w pozostałym kodzie to #166.
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
| Backup | brak nowego backupu > 26 h, nieudana próba odtworzenia | Railway Backups, protokół | ręczny backup, eskalacja |
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
`LOAD_TEST_SESSION_TREASURER`, `LOAD_TEST_SESSION_REPRESENTATIVE`.
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
żadna z nich nie ma rażąco złego planu zapytań, ale scenariusz **nie**
obejmuje kart z sumami wielu lat, kartek dla całej szkoły, eksportów,
uzgodnień rachunku ani kampanii e-mail (patrz scenariusz „heavy” niżej,
#217). Kryterium odbioru spełnia dopiero pomiar na stagingu.

| Data | Środowisko | Kto | Użytkownicy / czas | Zapisy | Żądania | Przepustowość | p50 | p95 | p99 | Błędy | Progi | Wynik / uwagi |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 27.09.2026 | lokalnie, PGlite w procesie (niereprezentatywny) | agent (Claude) | 50 / 30 s, bez pauz | tak | 4560 | 151,7 req/s | 300 ms | 537 ms | 1315 ms | 0 (0%) | domyślne | zaliczony; max 3230 ms; kontener 4 vCPU współdzielony z innymi procesami (load average ~60), przygotowanie danych 16 s |
| do wykonania | staging | | 50 / 60 s | nie | | | | | | | | |
| do wykonania | staging | | 50 / 60 s | tak (`--allow-writes`) | | | | | | | | |

### Scenariusz „heavy” (#217): trasy pominięte przez scenariusz domyślny

`npm run load:test -- --scenario heavy` mierzy osobno, sekwencyjnie, trasy
najbardziej obciążające bazę i serwer, których koszt rośnie z **wiekiem
systemu** (historia lat, `audit_events`, korekty, uzgodnienia) — seed
jednego roku ze scenariusza domyślnego tego nie pokazuje:

`GET /api/classes`, `GET /api/classes/{id}/students`,
`GET /api/households/{id}`, `GET /api/print/cards`,
`GET /api/ledger/export.csv`, `GET /api/reports/audit`,
`GET /api/reconciliations`, `POST /api/reconciliations/{id}/lines`,
`GET /api/reconciliations/{id}`, `GET /api/reconciliations/{id}/suggestions`.

Dane: `scripts/lib/heavy-scenario.js` (`buildHistoricalData`) — kilka lat
syntetycznej historii zamiast jednego roku: kilka klas na rok, rodzeństwo w
różnych klasach, dwoje opiekunów na gospodarstwo, wpłaty częściowe i korekty
w każdym roku, kilka wpisów księgi i jeden szkic uzgodnienia w najnowszym
roku, zdarzenia audytu wstawiane `generate_series` po stronie bazy. Domyślna
skala (`--heavy-years 2 --heavy-classes 5 --heavy-students 40
--heavy-audit-events 3000`) jest **celowo mniejsza** niż baseline z opisu
issue #217 (5 lat, 50 klas/rok, 100 000 zdarzeń audytu) — pełny seed trwa
dziesiątki sekund i spowalnia PR-y; pełną skalę odtwarza się na żądanie tymi
samymi flagami (nocny przebieg, #111), nie jest to wymagane na PR.

Wynik: dla każdej trasy `p50`/`max` opóźnienia, rozmiar odpowiedzi (bajty),
liczba błędów, oraz dla całego przebiegu szczyt `heapUsed` (MB) i maks.
opóźnienie pętli zdarzeń (`monitorEventLoopDelay`, ms). Budżety
(`HEAVY_ROUTE_BUDGETS_MS` w `scripts/lib/heavy-scenario.js`) są orientacyjne
i luźniejsze niż docelowe dla Railway — kontener testowy jest współdzielony i
przeciążony (patrz zasady pracy nad poprawkami), więc łapią tylko rażącą
regresję, nie mikroopóźnienia. Przekroczenie budżetu którejkolwiek trasy albo
błędna odpowiedź dają kod wyjścia `1` z nazwą trasy w komunikacie. Scenariusz
zapisuje dane (import wyciągu, #217 pkt 4) — **wyłącznie lokalnie**; tryb
zdalny (tylko odczyt, tylko staging) nie jest jeszcze zaimplementowany.
Scenariusz nie wywołuje żadnej trasy e-mail/`…/queue` (test sprawdza brak
wierszy `email_outbox` po przebiegu).

| Data | Środowisko | Skala | Wynik / uwagi |
|---|---|---|---|
| 28.09.2026 | lokalnie, PGlite w procesie (niereprezentatywny) | domyślna (2 lata, 5 klas/rok, 40 uczniów/rok, 3000 zdarzeń audytu) | zaliczony, bez naruszeń budżetu; zob. `tests/load-heavy-smoke.test.js` dla wariantu skróconego uruchamianego w CI |
| do wykonania | staging (tylko odczyt) | pełna (5 lat, 50 klas/rok, 100 000 zdarzeń audytu) | tryb zdalny sceny „heavy” do zaimplementowania |

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

## Backup PostgreSQL

1. Włączyć w usłudze PostgreSQL harmonogram backupów wolumenu
   (dzienny/tygodniowy/miesięczny; retencja wg Railway: ok. 6 dni / 1 miesiąc /
   3 miesiące). Sprawdzić, czy plan workspace obejmuje backupy i PITR.
2. Przed każdą migracją schematu lub importem wykonać ręczny backup i zapisać
   jego identyfikator w protokole.
3. Co tydzień (produkcja) wykonać dodatkowo logiczny zrzut
   `pg_dump --format=custom` przez tunel Railway na szyfrowany nośnik poza
   Railway, prawa `0600`. Nie przechowywać zrzutu w repo, CI ani na
   prywatnych laptopach bez szyfrowania. Czas przechowywania zrzutów
   — decyzja szkoły (retencja).

## Próbne odtworzenie PostgreSQL (do wykonania)

Najpierw na stagingu z danymi syntetycznymi, potem przed cutover.

1. Zapisać stan źródła: liczności tabel, suma `household_payment_totals`,
   `ledger_year_summary`, lista `schema_migrations` (raport bez danych
   osobowych).
2. Utworzyć backup (ręczny) i zanotować jego czas.
3. Wariant A — backup wolumenu: przywrócić w usłudze testowej lub w
   stagingu (Railway montuje nowy wolumen jako staged change; poprzedni
   wolumen zostaje zachowany). Wariant B — `pg_restore` zrzutu do pustej
   bazy tymczasowej.
4. Uruchomić `npm run db:migrate:postgres` na odtworzonej bazie — oczekiwany
   wynik: `No pending migrations.` (sumy kontrolne zgodne).
5. Porównać raport z punktu 1; sprawdzić ręcznie rodzinę z rodzeństwem,
   dziecko z dwojgiem opiekunów, wpłatę częściową z korektą.
6. Zmierzyć czas odtworzenia (RTO) i wiek backupu (RPO).
7. Usunąć bazę/usługę tymczasową. Wpisać wynik do tabeli.

Uzupełnieniem backupu jest wersjonowany eksport roczny z manifestem SHA-256
i testem odtworzenia do pustej bazy (`scripts/verify-export.js`), opisany w
[EXPORT.md](EXPORT.md). Wynik takiej próby także wpisać do tabeli poniżej
(wariant C — eksport roczny).

| Data | Środowisko | Kto | Backup (id/czas) | Wariant | Czas odtworzenia | Zgodność raportu | Wynik / uwagi |
|---|---|---|---|---|---|---|---|
| do wykonania | staging | | | | | | |
| do wykonania | production (przed cutover) | | | | | | |

## Backup dokumentów (Storage Bucket)

Railway nie oferuje automatycznych backupów, wersjonowania ani blokad obiektów
w bucketach. Dlatego:

1. Metadane (`documents`: klucz obiektu, typ, rozmiar, autor) są w PostgreSQL
   i podlegają backupowi bazy.
2. Obiekty kopiować narzędziem S3 (np. `rclone sync` lub `aws s3 sync` z
   endpointem bucketu) do drugiej prywatnej lokalizacji w UE, zatwierdzonej
   przez szkołę/IOD, z szyfrowaniem. Poświadczenia tylko do odczytu, w
   zmiennych, nie w skryptach w repo. Częstotliwość: co najmniej tygodniowo
   i przed każdą operacją masową.
3. Kopia nie usuwa obiektów w miejscu docelowym automatycznie w tym samym
   przebiegu (ochrona przed propagacją usunięcia); retencja kopii wg decyzji
   szkoły.
4. Próba odtworzenia (do wykonania): przywrócić próbkę obiektów do bucketu
   stagingowego, porównać liczbę obiektów i sumy rozmiarów z tabelą
   `documents`, pobrać wybrane pliki przez aplikację (autoryzacja + krótki
   podpisany URL). Wynik zapisać w tabeli.

| Data | Kto | Liczba obiektów źródło/kopia | Zgodność z `documents` | Wynik / uwagi |
|---|---|---|---|---|
| do wykonania | | | | |

## Plan cutover (do wykonania po D-20)

Warunki wstępne: wszystkie punkty listy odbioru poniżej zielone, decyzja
D-20 zapisana, okno serwisowe uzgodnione z zarządem.

1. Ogłosić okno serwisowe użytkownikom panelu (nie rodzicom).
2. Wykonać backup D1 i PostgreSQL produkcji (pusta baza po migracjach);
   zapisać identyfikatory.
3. Zatrzymać zapisy w starym Workerze (tryb tylko do odczytu lub wyłączenie
   tras zapisu).
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
- **Po przełączeniu, uszkodzenie danych**: wstrzymać zapisy, przywrócić
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
  (`APP_WRITE_MODE`, #143) i wersja aplikacji (`RAILWAY_GIT_COMMIT_SHA`).
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

## CI i runner self-hosted (#153)

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
