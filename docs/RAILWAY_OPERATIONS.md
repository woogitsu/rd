# Railway — środowiska, backup, monitoring i odbiór

Status: konfiguracja w repozytorium i procedury **do wykonania**. Nie utworzono
projektu Railway, nie wykonano deployu, backupu ani próbnego odtworzenia.
Produkcyjne uruchomienie wymaga osobnej decyzji szkoły i IOD
([D-20 w rejestrze decyzji](DECISIONS.md)). Zakres: issue #41 oraz część
monitoringu z #16. Kontekst: [plan migracji](RAILWAY_MIGRATION.md),
[serwer Node](NODE_SERVER.md), [przeniesienie D1](D1_POSTGRES_MIGRATION.md).

## Co jest w repozytorium

| Element | Plik | Znaczenie |
|---|---|---|
| Konfiguracja usługi | `railway.json` | build `npm ci && npm run build`, start `npm start`, healthcheck `/health`, restart `ON_FAILURE` (maks. 5 prób), region `europe-west4-drams3a` (Amsterdam), bez usypiania |
| Test konfiguracji | `tests/railway-config.test.js` | brak migracji/odtworzenia przy starcie, brak sekretów, region UE |
| Smoke test | `npm run smoke` (`scripts/smoke-postgres.js`) | migracje na PGlite w pamięci (dwukrotnie, druga bez zmian), serwer na losowym porcie `127.0.0.1`, `/health`, trzy panele, nagłówki, `404` |
| Test wolumenu | `tests/postgres-volume.test.js` | 1000 uczniów, 2000 kontaktów opiekunów, 50 użytkowników z uprawnieniami, wpłaty częściowe i korekty |
| CI | `.github/workflows/ci.yml` | testy, buildy, smoke, lokalne migracje D1 (stara ścieżka pozostaje) |

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
| `APP_ENV` | aplikacja | `staging` lub `production` |
| `PUBLIC_BASE_URL` | aplikacja | osobny dla każdego środowiska |
| `DATABASE_URL` | aplikacja | referencja do prywatnego adresu PostgreSQL (`*.railway.internal`), nie publiczny TCP proxy |
| `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` | aplikacja | referencje do zmiennych Storage Bucket (#39) |
| `BREVO_API_KEY` | aplikacja / worker | dopiero w #40; na stagingu klucz bez możliwości wysyłki do rodziców |

Sesje i MFA mogą wymagać dodatkowych sekretów — ich nazwy dopisuje PR #35.

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
| Dostępność | healthcheck `/health` przy deployu, zewnętrzny monitor co 5 min | Railway, monitor zewnętrzny | restart, rollback wersji |
| Błędy | odsetek odpowiedzi 5xx, awarie deployu, restart pętli | Railway Observability / logi | analiza logów bez danych osobowych |
| PostgreSQL | CPU, pamięć, zajętość wolumenu, liczba połączeń | metryki usługi PostgreSQL | alert przy 80% wolumenu |
| Storage Bucket | rozmiar, liczba obiektów, odrzucone uploady | metryki bucketu, audyt aplikacji | przegląd retencji |
| Brevo | dzienny limit planu, odbicia, błędne adresy, błędy API | panel Brevo, stan kolejki (#40) | wstrzymanie kampanii, korekta adresów |
| Zadania | zadania w stanie błędu lub zbyt długo w kolejce | tabela kolejki (#40) | ponowienie z tym samym kluczem idempotencji |
| Backup | brak nowego backupu > 26 h, nieudana próba odtworzenia | Railway Backups, protokół | ręczny backup, eskalacja |
| Koszty | alerty Usage | Railway | patrz wyżej |

Uwaga: `/health` potwierdza tylko działanie procesu, nie połączenie z bazą.
Rozszerzenie o sprawdzenie bazy (bez ujawniania szczegółów) należy do #35.
Logi nie mogą zawierać danych rodzin, tokenów ani treści wiadomości.
Konkretne narzędzie monitora zewnętrznego i adresaci alertów — do decyzji
zarządu.

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
6. Wykonać ręczny deploy produkcji na Railway, sprawdzić `/health`, logowanie,
   panel wpłat i księgi na koncie testowym.
7. Przełączyć domenę/DNS na Railway; stary Worker pozostaje zatrzymany do
   zapisu, ale nie usunięty (#42).
8. Obserwacja 72 h: błędy, logowania, koszty.

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

## Lista odbioru (#31, #41, #16)

| Kryterium | Dowód | Stan |
|---|---|---|
| Pełne CI (testy, buildy, smoke, migracje D1) | `.github/workflows/ci.yml` | w repo |
| Konfiguracja Railway bez sekretów, region UE, bez migracji przy starcie | `railway.json`, `tests/railway-config.test.js` | w repo |
| Test wolumenu 1000 uczniów / 2000 kontaktów / 50 użytkowników | `tests/postgres-volume.test.js` (PGlite) | w repo; powtórzyć na stagingu |
| Testy bezpieczeństwa: role, MFA, zakres przedstawiciela, ochrona plików | #35, #39 | do wykonania |
| Równoważność starego i nowego API (te same żądania, porównanie statusów i JSON na danych syntetycznych) | #35–#38 | do wykonania |
| Staging Railway na danych syntetycznych | protokół | do wykonania |
| Test 50 równoczesnych użytkowników na stagingu | protokół | do wykonania |
| Backup PostgreSQL i próbne odtworzenie | tabela wyżej | do wykonania |
| Backup i próbne odtworzenie dokumentów | tabela wyżej | do wykonania |
| Limity kosztów i alerty | ustawienia Usage, protokół | do wykonania |
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
