# Macierz testów: moduł × scenariusz

Dokument śledzi, które scenariusze wymagane przez `AGENTS.md` (granice ról, dwie
osoby opiekujące się jednym dzieckiem, rodzeństwo, wpłaty częściowe, podwójne
kliknięcie, ponowienie zadania, błędny e-mail, korekty) mają test w repozytorium.
Tabelę utrzymuje się przy każdym PR, który dodaje moduł tras albo test scenariusza.
Pilnuje jej `tests/testing-matrix.test.js`. Dane w testach są wyłącznie syntetyczne
(`@example.invalid`), czas jest wstrzykiwany (`env.now`) tam, gdzie wynik zależy od dnia.

Legenda: `✓` pokryte testem wskazanym w rejestrze dowodów poniżej (dla kolumny „Role”
dowodem jest `tests/pg-authz-matrix.test.js`, 27 modułów × aktorzy × MFA × zakres);
`~` częściowo (tylko sekwencyjnie, bez skutków albo niesprawdzone pole po polu);
`n/d (powód)` scenariusz nie dotyczy modułu; `— (#N)` puste pole z odwołaniem do zgłoszenia.
Pole puste bez powodu i bez odwołania nie jest dozwolone.

Uwaga o współbieżności: testy oparte na PGlite wykonują transakcje po kolei, więc
„równoległe” scenariusze sprawdzają niezmiennik wyniku, a nie realny wyścig
(realne wyścigi na PostgreSQL: `tests/pg-reconciliation-race.test.js`,
`tests/pg-export-race.test.js`, `tests/pg-real-concurrency.test.js`,
`tests/pg-year-close-race.test.js`, uruchamiane z `RD_TEST_PG_URL`; #208, sekcja „Testy na prawdziwym PostgreSQL” niżej).

## Macierz

| Wiersz | Moduły ROUTES | Role | 2 opiekunów | Rodzeństwo | Wpł. częściowe | Podw. kliknięcie | Ponowienie | Błędny e-mail | Korekty |
|---|---|---|---|---|---|---|---|---|---|
| sesja | session, login, mfa | ✓ | n/d (moduł nie zna opiekunów) | n/d (moduł nie zna rodzin) | n/d (brak kwot) | ~ (#208) | ✓ | ✓ | n/d (brak danych do korekty) |
| admin | admin, privacy-notice | ✓ | n/d (role, nie rodziny) | n/d (moduł nie zna rodzin) | n/d (brak kwot) | ~ (#208) | ✓ | n/d (adres e-mail konta to dane logowania, patrz sesja) | ✓ |
| rodziny | families, guardian-updates, representative, board | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| import | import | ✓ | ✓ | ✓ | n/d (import nie zapisuje kwot) | ✓ | ✓ | ✓ | ~ (#98) |
| wplaty | payments, payment-references, payment-instructions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/d (wpłata nie ma adresu; powód korekty z adresem: #152) | ✓ |
| ksiega | ledger, ledger-cash, ledger-budget, ledger-cost-centers, financial-reports | ✓ | n/d (księga nie zna rodzin) | n/d (księga nie zna rodzin) | ~ (powiązana wpłata księgowana raz, bez wpłat częściowych rodzin) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| uzgodnienia | reconciliation | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/d (brak adresów) | ✓ |
| zamkniecie | year-close | ✓ | n/d (bilans księgi, nie rodzin) | n/d (bilans księgi, nie wpłaty rodzin) | n/d (bilans księgi, nie wpłaty rodzin) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| email | email | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| dokumenty | documents | ✓ | n/d (dokument nie ma rodziny) | n/d (dokument nie ma rodziny) | n/d (brak kwot) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| wydarzenia | events | ✓ | n/d (wydarzenia bez rodzin) | n/d (wydarzenia bez rodzin) | n/d (brak kwot) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| aktualnosci | news | ✓ | ✓ | ✓ | n/d (brak kwot) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| zebrania | meetings | ✓ | ✓ | ✓ | n/d (brak kwot) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| druk | print | ✓ | ✓ | ✓ | ✓ | n/d (odczyt bez zapisu) | n/d (odczyt bez zapisu) | n/d (kartki bez adresów e-mail) | ✓ |
| eksport | exports | ✓ | ~ (niesprawdzone pole po polu) | ~ (niesprawdzone pole po polu) | ~ (niesprawdzone pole po polu) | ~ (wyścig tylko z `RD_TEST_PG_URL`) | ✓ | n/d (brak adresów) | ~ (niesprawdzone pole po polu) |

## Znane luki i założenia

- Ta sama osoba zapisana w zebraniu raz jako konto (`user_id`), raz jako opiekun
  (`guardian_id`) liczy się do quorum dwa razy: `0009_meetings.sql` wymusza
  unikalność osobno dla każdej kolumny, a konto nie ma powiązania z opiekunem.
  Test `known gap` w `tests/pg-meetings.test.js` opisuje obecne zachowanie.
  Naprawa wymaga migracji i decyzji (D-21), więc jest osobnym zakresem.
- Dwoje opiekunów jednego dziecka głosuje osobno w obecnym kodzie (ręczny wpis,
  D-21 nierozstrzygnięte); test dokumentuje to zachowanie, nie rozstrzyga regulaminu.
- Opieka naprzemienna: kampania i kartka dotyczą gospodarstwa głównego, wpłata drugiego
  gospodarstwa liczy się do jego salda (założenie D-11/D-17, `tests/pg-primary-household.test.js`).
- Zamknięcie roku równolegle z zapisem w księdze: wpis jest w bilansie albo dostaje
  `409 school_year_closed`, nigdy po bilansie (`tests/pg-matrix-concurrency.test.js`).
  Uprawnienia zawężone do roku wygasają z zamknięciem, więc skarbnik roku dostaje wtedy 403.
- Aktualności: wycofanie wygrywa z równoległym zatwierdzeniem i publikacją; blokują to
  trzy warstwy (sprawdzenie stanu w `transition()`, wyzwalacze w `0018_news.sql`
  i blokada wiersza), dlatego test mutacyjny jednej warstwy nie wystarcza do czerwonego wyniku.

## Rejestr dowodów

Każde `✓` poza kolumną „Role” ma tu co najmniej jeden wiersz. Fragment nazwy testu musi
występować w linii `test(...)` wskazanego pliku (sprawdza to meta-test).

| Wiersz | Scenariusz | Plik | Fragment nazwy testu |
|---|---|---|---|
| sesja | Ponowienie | tests/pg-mfa.test.js | verify sets MFA only on the calling session and refuses a replayed step |
| sesja | Błędny e-mail | tests/pg-auth.test.js | invitation is one-time, expires, can be revoked and must match the account email |
| admin | Ponowienie | tests/pg-admin.test.js | invitations return the token once, block duplicates |
| admin | Korekty | tests/pg-admin.test.js | revoking grants keeps history |
| rodziny | 2 opiekunów | tests/pg-primary-household.test.js | opieka naprzemienna: dwa obowiązujące gospodarstwa |
| rodziny | Rodzeństwo | tests/pg-families.test.js | zarząd widzi wszystkie klasy i rodzeństwo |
| rodziny | Wpł. częściowe | tests/pg-families.test.js | sumy wpłat netto tylko dla ról finansowych z MFA |
| rodziny | Podw. kliknięcie | tests/pg-families.test.js | dwie osoby edytują ten sam kontakt jednocześnie |
| rodziny | Ponowienie | tests/pg-primary-household.test.js | podwójne kliknięcie zmiany: ponowienie nie tworzy drugiego członkostwa |
| rodziny | Błędny e-mail | tests/pg-families.test.js | zmiana kontaktu opiekuna: tylko zarząd/admin |
| rodziny | Korekty | tests/pg-families.test.js | zmiana kontaktu opiekuna: tylko zarząd/admin, historia i audyt |
| import | 2 opiekunów | tests/pg-import.test.js | 1200 synthetic rows from a BOM CSV: siblings, two guardians |
| import | Rodzeństwo | tests/pg-import.test.js | commit is atomic, siblings share guardians |
| import | Podw. kliknięcie | tests/pg-import.test.js | double-click and retry after a guardian conflict do not duplicate guardians |
| import | Ponowienie | tests/pg-import.test.js | failure in the middle of a commit rolls back everything |
| import | Błędny e-mail | tests/pg-import.test.js | invalid e-mail only degrades to a warning |
| wplaty | 2 opiekunów | tests/pg-payments-api.test.js | partial payments, siblings and two guardians sum per household |
| wplaty | Rodzeństwo | tests/pg-primary-household.test.js | opieka naprzemienna: wpłata drugiego gospodarstwa liczy się poprawnie |
| wplaty | Wpł. częściowe | tests/pg-payments-api.test.js | partial payments, siblings and two guardians sum per household |
| wplaty | Podw. kliknięcie | tests/pg-payments-api.test.js | double click with the same Idempotency-Key creates one payment |
| wplaty | Ponowienie | tests/pg-payments-api.test.js | audit events are atomic with the write and carry no amounts, references or family data |
| wplaty | Korekty | tests/pg-payments-api.test.js | parallel corrections are serialized and never exceed the payment amount |
| ksiega | Podw. kliknięcie | tests/pg-ledger-api.test.js | double click with the same Idempotency-Key creates one entry |
| ksiega | Ponowienie | tests/pg-ledger-api.test.js | audit events are atomic with the write and carry no amounts, descriptions or documents |
| ksiega | Korekty | tests/pg-ledger-api.test.js | parallel corrections are serialized and never exceed the entry amount |
| uzgodnienia | 2 opiekunów | tests/pg-reconciliation.test.js | two guardians of one child and one sibling transfer |
| uzgodnienia | Rodzeństwo | tests/pg-reconciliation.test.js | two guardians of one child and one sibling transfer |
| uzgodnienia | Wpł. częściowe | tests/pg-reconciliation.test.js | a correction after matching blocks confirmation with a list of inconsistent matches |
| uzgodnienia | Podw. kliknięcie | tests/pg-reconciliation.test.js | double-click makes only one payment and one match |
| uzgodnienia | Ponowienie | tests/pg-reconciliation.test.js | a line payment cannot be created twice for the same statement line |
| uzgodnienia | Korekty | tests/pg-reconciliation.test.js | a correction after matching blocks confirmation with a list of inconsistent matches |
| zamkniecie | Podw. kliknięcie | tests/pg-year-close.test.js | podwójne kliknięcie „Zamknij rok” przez tę samą osobę |
| zamkniecie | Ponowienie | tests/pg-year-close.test.js | ponowne zamknięcie jest idempotentne |
| zamkniecie | Korekty | tests/pg-year-close.test.js | zapisy przypisane do zamkniętego roku są odrzucane |
| zamkniecie | Podw. kliknięcie | tests/pg-matrix-concurrency.test.js | zamknięcie roku równolegle z zapisem w księdze |
| email | 2 opiekunów | tests/pg-email.test.js | siblings and two guardians deduplicated |
| email | Rodzeństwo | tests/pg-email.test.js | siblings and two guardians deduplicated |
| email | Wpł. częściowe | tests/pg-email.test.js | partial payment recorded during a no_payment_record batch skips only that household |
| email | Podw. kliknięcie | tests/pg-email.test.js | live run sends each message separately; rerun and double queue never duplicate |
| email | Ponowienie | tests/pg-email.test.js | job retried while the first run is still sending |
| email | Błędny e-mail | tests/pg-email.test.js | invalid address at the provider (400) fails only that message |
| email | Korekty | tests/pg-email.test.js | any change after approval invalidates it |
| dokumenty | Podw. kliknięcie | tests/pg-documents.test.js | double click and retry reuse the idempotency key |
| dokumenty | Ponowienie | tests/pg-documents.test.js | genuine rollback (object written, insert rolled back) |
| dokumenty | Korekty | tests/pg-documents.test.js | treasurer supersedes a financial document |
| wydarzenia | Podw. kliknięcie | tests/pg-events.test.js | double-click create is idempotent |
| wydarzenia | Ponowienie | tests/pg-events.test.js | stale revision is a conflict before content validation; double submit still replays |
| wydarzenia | Korekty | tests/pg-events.test.js | edits after publication keep the published revision public until re-approved |
| aktualnosci | 2 opiekunów | tests/pg-news.test.js | zgoda na wizerunek: zakres, wygaśnięcie i wycofanie (rodzeństwo, dwoje opiekunów) |
| aktualnosci | Rodzeństwo | tests/pg-news.test.js | zgoda na wizerunek: zakres, wygaśnięcie i wycofanie (rodzeństwo, dwoje opiekunów) |
| aktualnosci | Podw. kliknięcie | tests/pg-news.test.js | withdrawal and photo revocation hide content from the public view immediately |
| aktualnosci | Ponowienie | tests/pg-matrix-concurrency.test.js | równoległe zatwierdzenie/publikacja i wycofanie |
| aktualnosci | Korekty | tests/pg-news.test.js | edits after publication keep the published revision public |
| zebrania | 2 opiekunów | tests/pg-meetings.test.js | quorum: two guardians of one child both vote |
| zebrania | Rodzeństwo | tests/pg-meetings.test.js | siblings do not inflate the count |
| zebrania | Podw. kliknięcie | tests/pg-meetings.test.js | double submit with the same Idempotency-Key creates one record |
| zebrania | Ponowienie | tests/pg-meetings.test.js | double submit with the same Idempotency-Key creates one record |
| zebrania | Korekty | tests/pg-meetings.test.js | approved minutes are immutable, lock the meeting and are corrected by new versions |
| druk | 2 opiekunów | tests/pg-primary-household.test.js | opieka naprzemienna: dwa obowiązujące gospodarstwa |
| druk | Rodzeństwo | tests/pg-print.test.js | rodzeństwo: jedna rodzina z uczniami z różnych klas |
| druk | Wpł. częściowe | tests/pg-print.test.js | kwoty netto tylko dla roli finansowej z MFA |
| druk | Korekty | tests/pg-print.test.js | kwoty netto tylko dla roli finansowej z MFA |
| eksport | Ponowienie | tests/pg-export-audit-year.test.js | ponowny eksport daje ten sam wynik |

## Testy na prawdziwym PostgreSQL (#208)

PGlite ma jedno połączenie i wykonuje transakcje po kolei, więc **nie nadaje się do
testów współbieżności**: testy „parallel / double click” na nim sprawdzają wynik
końcowy, a usunięcie `FOR UPDATE` zwykle nie zmienia ich wyniku. Wyścigi, blokady
i gałęzie `23505 → odtworzenie zapisu` wymagają serwera PostgreSQL 16.

### Uruchomienie lokalne

```
npm run test:pg-real                       # pliki czytające RD_TEST_PG_URL (wyścigi)
npm run test:pg-real -- tests/pg-x.test.js # wskazane pliki
npm run test:pg-real -- --all              # CAŁY zestaw na PostgreSQL zamiast PGlite
```

`scripts/test-pg-real.js`: `initdb` w katalogu tymczasowym → serwer na losowym porcie
(wyłącznie `127.0.0.1`, uwierzytelnianie `trust`, `fsync=off`) → `node --test
--test-concurrency=1` z `RD_TEST_PG_URL` → zatrzymanie serwera → usunięcie katalogu
(także po błędzie i po SIGINT/SIGTERM). Nie łączy się z żadną istniejącą bazą ani z
siecią zewnętrzną. Binaria: `PG_BIN`, potem `pg_config --bindir`, potem
`/usr/lib/postgresql/*/bin`, potem `PATH`. Uruchomiony jako root skrypt startuje serwer
jako użytkownik `postgres` (PostgreSQL odmawia startu jako root); katalog tymczasowy
(`TMPDIR`, domyślnie `/tmp`) musi być wtedy dostępny dla tego użytkownika.

Z `--all` ustawiane jest `RD_TEST_PG_BACKEND=real`: `createTestDb()` z
`tests/helpers/pg.js` zwraca zamiast PGlite bazę na prawdziwym PostgreSQL przez
`createPgDatabase` (`src/db.js`, pula `pg`) — osobna baza na wywołanie, klonowana z
szablonu z migracjami. Dzięki temu każdy istniejący test można sprawdzić na serwerze
docelowym. Różnice widoczne dopiero tam (typy `bigint` jako tekst, brak `rowCount`,
mikrosekundy `timestamptz`, prawdziwe blokady, ponowienia 40001 w `src/db.js`) to
realne ryzyka wdrożenia na Railway. Pełny przebieg trwa kilkanaście minut.

### Testy wyścigów

`tests/pg-real-concurrency.test.js` (pomijany bez `RD_TEST_PG_URL`): podwójne kliknięcie
zapisu wpłaty (aż do wykonania gałęzi 23505), dwoje opiekunów płacących równolegle,
trzy równoległe korekty 40/40/40 €, dwa i pięć równoległych wydatków na jedną uchwałę
(#93), podwójne kliknięcie wydatku z uchwałą, dwa równoległe przebiegi kolejki e-mail,
anulowanie kampanii w trakcie przebiegu i podwójne anulowanie (#210), udane logowania
zwalniające limit IP.

Wzorzec „bariera” (`gatedEnv`): pierwsze żądanie jest wstrzymywane w transakcji po
zapisie, przed COMMIT; drugie musi czekać na blokadę (`pg_stat_activity`,
`wait_event_type = 'Lock'`) i po zatwierdzeniu pierwszego zobaczyć jego wynik. Samo
`Promise.all` przeplata się zbyt rzadko (okno wyścigu to mikrosekundy). Kontrola
mutacyjna wykonana ręcznie: usunięcie `FOR UPDATE` z triggera
`ledger_entry_resolution_guard` (0072) czerwieni testy #93 (bariera i pięć wydatków),
a zdjęcie blokady kampanii w `cancel` (`loadCampaign(..., { lock: true })`) — test
bariery anulowania. Wpłaty mają kilka warstw blokad (API i triggery 0002/0038/0039/
0104): po zdjęciu `FOR UPDATE` z API korekty i z triggerów 0002 test bariery korekt
nadal przechodzi, bo pozostałe warstwy trzymają blokadę.
Automatycznej kontroli mutacyjnej w CI jeszcze nie ma (#208, punkt 4).

`tests/pg-year-close-race.test.js` (#212, pomijany bez `RD_TEST_PG_URL`): równoległe
„Zamknij rok” — dwie osoby z zarządu, podwójne kliknięcie tej samej osoby (i ponowienie
po zamknięciu), rozpoczynający (`four_eyes_required`) i inna osoba, dwa różne lata naraz;
zapis księgi, korekta księgi, korekta wpłaty (wpłata częściowa) i bilans otwarcia
(`LOCK … SHARE ROW EXCLUSIVE` w `ledger-cash`) w chwili zamknięcia; korekta wpłaty
niezatwierdzona przed zamknięciem. Pierwsze zamknięcie jest wstrzymywane w transakcji
zaraz po `LOCK TABLE … IN SHARE MODE` albo przed COMMIT, a kolejne żądania muszą
czekać na blokadę (`wait_event = 'advisory'` dla drugiego zamknięcia). Transakcje
biegną z `retries: 0`, bo ponowienie 40P01 w `src/db.js` ukryłoby zakleszczenie.
Kontrola pozytywna w tym samym pliku: po pominięciu `pg_advisory_xact_lock('rd_year_close')`
te same przeploty (ten sam rok i dwa różne lata) kończą się `40P01` i `503`.
Kontrola mutacyjna wykonana ręcznie: usunięcie tej blokady z `src/pg/routes/year-close.js`
czerwieni cztery testy równoległych zamknięć (dwie osoby, podwójne kliknięcie, cztery oczy, dwa lata).

`tests/pg-db-contract.test.js` (działa w CI bez PostgreSQL): `src/` nie czyta
`rowCount`/`affectedRows` — kontrakt `src/db.js` zwraca tylko `{ rows }`, a PGlite
dodaje `rowCount`, więc taki kod przechodził testy i psuł się na serwerze.

### CI: job `test-pg-real`

CI działa na runnerach GitHub `ubuntu-latest` (repozytorium jest publiczne).
Job `test-pg-real` (`.github/workflows/ci.yml`, wymagany przez `ci-ok`) uruchamia
`npm run test:pg-real` z usługą `services: postgres` (obraz `postgres@sha256:…`
przypięty do digestu — `tests/ci-supply-chain.test.js`; przy aktualizacji zmień
digest obrazu `postgres:16`). Gdy `RD_TEST_PG_URL` jest ustawione, skrypt
`scripts/test-pg-real.js` nie stawia własnego serwera, tylko używa wskazanego;
bez zmiennej działa jak wcześniej (`initdb` w katalogu tymczasowym).
Zwykłe shardy (`test`) nadal biegną na PGlite i pomijają testy wyścigów.
Nocny przebieg `npm run test:pg-real -- --all` (powtarzanie testów
współbieżności, #111) pozostaje opcją — nie jest jeszcze w `ci.yml`.
