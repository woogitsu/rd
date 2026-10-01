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
`tests/pg-year-close-race.test.js`, `tests/pg-real-double-click.test.js`, uruchamiane z `RD_TEST_PG_URL`; #208, sekcja „Testy na prawdziwym PostgreSQL” niżej).

## Macierz

| Wiersz | Moduły ROUTES | Role | 2 opiekunów | Rodzeństwo | Wpł. częściowe | Podw. kliknięcie | Ponowienie | Błędny e-mail | Korekty |
|---|---|---|---|---|---|---|---|---|---|
| sesja | session, login, mfa | ✓ | n/d (moduł nie zna opiekunów) | n/d (moduł nie zna rodzin) | n/d (brak kwot) | ~ (#208) | ✓ | ✓ | n/d (brak danych do korekty) |
| admin | admin, privacy-notice | ✓ | n/d (role, nie rodziny) | n/d (moduł nie zna rodzin) | n/d (brak kwot) | ~ (#208) | ✓ | n/d (adres e-mail konta to dane logowania, patrz sesja) | ✓ |
| rodziny | families, guardian-updates, representative, board | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| import | import | ✓ | ✓ | ✓ | n/d (import nie zapisuje kwot) | ✓ | ✓ | ✓ | ~ (#98) |
| wplaty | payments, payment-references, payment-instructions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/d (wpłata nie ma adresu; powód korekty z adresem: #152) | ✓ |
| ksiega | ledger, ledger-cash, ledger-budget, ledger-cost-centers, financial-reports | ✓ | n/d (księga nie zna rodzin) | n/d (księga nie zna rodzin) | ~ (powiązana wpłata księgowana raz, bez wpłat częściowych rodzin) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| kontrola KR | audit-reviews | ✓ | n/d (moduł nie zna opiekunów) | n/d (moduł nie zna rodzin) | n/d (brak kwot) | ✓ | ✓ | ✓ | ✓ |
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
| wplaty | Korekty | tests/pg-real-double-click.test.js | dwie korekty wpłaty 70 + 70 € przy 100 € |
| ksiega | Podw. kliknięcie | tests/pg-ledger-api.test.js | double click with the same Idempotency-Key creates one entry |
| ksiega | Ponowienie | tests/pg-ledger-api.test.js | audit events are atomic with the write and carry no amounts, descriptions or documents |
| ksiega | Korekty | tests/pg-real-double-click.test.js | dwie korekty wpisu księgi 70 + 70 € przy 100 € |
| kontrola KR | Podw. kliknięcie | tests/pg-audit-reviews.test.js | podwójne kliknięcie i ponowienie: jeden zapis i jedno zdarzenie; ten sam klucz z inną treścią to 409 |
| kontrola KR | Ponowienie | tests/pg-audit-reviews.test.js | podwójne kliknięcie odpowiedzi i zamknięcia: jeden zapis każdego rodzaju |
| kontrola KR | Błędny e-mail | tests/pg-audit-reviews.test.js | bramka danych osobowych: e-mail odrzucony, telefon wymaga potwierdzenia; audyt bez treści |
| kontrola KR | Korekty | tests/pg-audit-reviews.test.js | wątek: pytanie KR → odpowiedź skarbnika → zamknięcie; wniosek końcowy; lista i raport KR |
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

## Jakość asercji i izolacji (#214)

`tests/test-quality-lint.test.js` przegląda wszystkie pliki `tests/*.test.js`.
Każda reguła ma kontrolę pozytywną (kod, który reguła musi wykryć):

- `assert.ok(x.every(...))` jest zakazane w każdym pliku, bo przechodzi na
  pustej kolekcji. Używaj `assertEvery` z `tests/helpers/assertions.js`
  (wymaga niepustej kolekcji) albo kontroli długości w tej samej asercji.
- Obejście triggerów (`ALTER TABLE … DISABLE TRIGGER`, `SET
  session_replication_role = replica`) jest dozwolone tylko w plikach z
  `TRIGGER_BYPASS_ALLOWED`, każdy z uzasadnieniem. Do cofania czasu służy
  wstrzykiwany zegar (`now`), nie wyłączony strażnik. Wpis `pg-bootstrap-admin`
  czeka na taki zegar w kodzie aplikacji; `pg-guardian-updates` używa już
  `env.now` przy wygasaniu linków opiekunów (#140).
- Negatywna asercja na krótkim podciągu cyfr (`!meta.includes('470')`) jest
  zakazana. Taki podciąg losowo trafia w UUID lub skrót w metadanych (#548).
  Szukaj całej wartości (`SYNTHETIC_PHONE_IN_TEXT`) albo liczby jako osobnego
  tokenu (`/(?<![\w-])2500(?![\w-])/`).

Node 22 nie ma `--test-shuffle`. Niezależność testów od kolejności sprawdza
ręczna permutacja: `npm run test:reverse -- tests/<plik>.test.js` uruchamia
plik z odwróconą kolejnością testów i zestawów na każdym poziomie
(`tests/helpers/reverse-order.js`). `tests/pg-families.test.js` przechodzi w
obu kolejnościach.

## Sprawdzanie typów JSDoc (#160)

`npm run typecheck` (`tsc -p jsconfig.json --noEmit`) sprawdza typy w plikach
wymienionych w `include` w `jsconfig.json` (obecnie `src/pg/input.js`, `scope.js`,
`pii-gate.js`, `audit.js`; `strict` wyłączone, `checkJs` włączone). Job `typecheck`
w CI jest wymagany przez `ci-ok`. Nowy plik obejmuje się kontrolą, dopisując go do
`include` i poprawiając błędy adnotacjami JSDoc bez zmiany zachowania.

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
RD_TEST_PG_APP_ROLE=rd_app npm run test:pg-real -- --all  # jw., ale połączenia testów rolą rd_app (SR-05, #101)
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

`tests/pg-real-domain-locks.test.js` (#208, pomijany bez `RD_TEST_PG_URL`): bariera jak w
`pg-real-double-click` dla modułów domenowych — dwa zapisy na ostatnie miejsce zadania
wydarzenia (`409 task_full`), dwie edycje szkicu wydarzenia z tej samej rewizji, wycofanie
wpisu aktualności kontra zatwierdzenie (`409 post_withdrawn`), dwie zmiany terminu zebrania
z tej samej rewizji, zastąpienie dokumentu dwoma różnymi dokumentami i dwie identyczne zmiany
kontaktu opiekuna (druga: `changed: false`, jeden wpis historii i audytu). Test sprawdza w
`pg_stat_activity`, że drugie żądanie czeka na blokadę wiersza z kodu trasy (tekst zapytania
jest obcinany do 1024 znaków, więc wzorce opisują jego początek). Usunięcie blokady w
`lockEvent`, `lockPost`, `lockMeeting`, `changeStatus` i `updateGuardianContact` czerwieni
odpowiedni test (`npm run test:pg-mutations`).

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

`tests/pg-real-app-role.test.js` (SR-05, #101, pomijany bez `RD_TEST_PG_URL`): rola `rd_app` z migracji 0170 — `TRUNCATE`, DDL, `DISABLE TRIGGER`, `session_replication_role` i `DELETE` na tabelach z historią kończą się `42501`; meta-test każdej tabeli i nowej tabeli (domyślne uprawnienia); wpłata i korekta przez `handlePgRequest` działają, nadpisanie wpłaty odrzuca trigger.

`tests/pg-real-tx-conflict.test.js` (#156, pomijany bez `RD_TEST_PG_URL`): dwie transakcje
`REPEATABLE READ` czytają ten sam wiersz z migawki i obie go zwiększają; serwer zgłasza
prawdziwe `40001`. `db.transaction` ponawia funkcję (oba przyrosty zapisane, trzy próby
łącznie), a z `{ retries: 0 }` błąd trafia do wywołującego bez zapisu przegranej transakcji
i klasyfikuje się jako `503 retry_later`. Atrapa w `tests/pg-tx-retry.test.js` tego nie dowodzi.

`tests/pg-real-double-click.test.js` (#208, pomijany bez `RD_TEST_PG_URL`): bariera
(`tests/helpers/pg-barrier.js`) dla kluczowych ścieżek — zapis wpłaty z tym samym
`Idempotency-Key` (druga transakcja czeka na klucz, dostaje `23505` i odtwarza zapis;
ta sama treść → `200 Idempotency-Replayed: true`, inna → `409 idempotency_conflict`;
ponowienie po utracie odpowiedzi), korekta wpłaty i korekta wpisu księgi 70 + 70 €
przy 100 €, podwójne kliknięcie korekty księgi, przypisanie wpłaty do dwóch rodzin,
dwa ujęcia tej samej wpłaty w księdze, podwójne kliknięcie „Dopasuj” i dwa dopasowania
jednej pozycji wyciągu, zatwierdzenie kampanii e-mail (podwójne kliknięcie i dwie osoby
z zarządu; nic nie jest kolejkowane ani wysyłane), „Zaproś” (dwa równoległe
zaproszenia tego samego adresu), dwóch administratorów odbierających sobie rolę
(`409 last_admin_grant`) i dwa commity importu z różnymi kluczami. Każdy test sprawdza
w `pg_stat_activity`, na czym drugie żądanie czeka — tekst czekającego zapytania musi
być blokadą z kodu trasy (`FOR UPDATE`, `pg_advisory_xact_lock`), a nie dopiero
`INSERT` na indeksie unikalnym. Kontrole pozytywne w tym samym pliku (mutacja przez
`rewrite` bariery): bez blokady kampanii drugie zatwierdzenie kończy się `409` z
triggera zamiast odtworzeniem; bez blokady adresu powstają dwa ważne tokeny
zaproszenia; bez `rd:role_grants` nie zostaje żaden administrator; bez
`rd_import_commit` drugi commit dostaje `409` zamiast odtworzenia.

Test „Zaproś” wykrył błąd: sprawdzenie „oczekujące zaproszenie już jest” działało
przed transakcją, więc dwa równoległe żądania tworzyły dwa ważne tokeny. Teraz
sprawdzenie jest w transakcji zapisu pod blokadą doradczą adresu
(`createInvitation(..., { rejectPending: true })` w `src/pg/auth.js`).

„Wyślij ponownie” (#293, follow-up #576/#557) wycofywał stare zaproszenie i tworzył
nowe w dwóch osobnych transakcjach bez blokady adresu, więc równoległe „Zaproś” albo
drugie „Wyślij ponownie” mogło zostawić dwa ważne tokeny. Teraz `reissueInvitation`
(`src/pg/auth.js`) robi oba kroki w jednej transakcji pod `rd:invitation:<email>`;
testy z barierą: drugie ponowienie i „Zaproś” czekają na blokadę doradczą, zostaje
jeden ważny token. Kontrola pozytywna: bez blokady adresu drugie ponowienie czeka
dopiero na wiersz (warunkowy `UPDATE`) — mutant `invitation-reissue`.

### Kontrola mutacyjna (`npm run test:pg-mutations`)

`scripts/check-lock-mutations.js` usuwa po kolei każdą blokadę z listy `MUTANTS`
(`FOR UPDATE` albo `pg_advisory_xact_lock` w jednej funkcji) w kopii kodu w katalogu
tymczasowym i uruchamia wskazany plik testów na prawdziwym PostgreSQL; mutant musi dać
czerwony test. Najpierw przebieg bez mutacji (musi być zielony). Kod repozytorium nie
jest zmieniany. CI uruchamia to w jobie `test-pg-real` po `npm run test:pg-real`.
`tests/lock-mutations.test.js` (zwykłe shardy) pilnuje, żeby lista się nie zestarzała.
Obecnie lista obejmuje: korektę i przypisanie wpłaty, korektę wpisu księgi i ujęcie
wpłaty w księdze, blokadę uzgodnienia, blokadę kampanii (zatwierdzenie i anulowanie),
`rd:role_grants`, blokadę adresu zaproszenia („Zaproś” i „Wyślij ponownie”), `rd_import_commit`, `rd_year_close`
oraz (`tests/pg-real-domain-locks.test.js`) `lockEvent`, `lockPost`, `lockMeeting`, `changeStatus` (dokumenty)
i `updateGuardianContact`.
Poza listą (brak testu z barierą, #208): pozostałe `FOR UPDATE` w `families.js` (relacje, gospodarstwa,
zapisy do klas), `events.js` (zadania, wycofanie zapisu), `news.js` (zdjęcia), `meetings.js` (uchwały,
porządek obrad, zawiadomienia), `documents.js` (opis), pozostałe w `payments.js`/`ledger.js`
(zwroty, przeksięgowania, części wpłat, autoryzacje) oraz blokady w triggerach migracji.

Nazwy testów na PGlite nie obiecują wyścigu: `tests/test-quality-lint.test.js`
(reguła `pglite-race-claim`) odrzuca w plikach bez `RD_TEST_PG_URL` nazwy z
„truly parallel”, „are serialized” i „bez zakleszczenia”. Testy z `Promise.all` na
PGlite mają w nazwie „sequential on PGlite” / „PGlite: po kolei”. „Podwójne
kliknięcie” na PGlite oznacza ponowienie po kolei (odtworzenie zapisu), a nie wyścig.

`tests/pg-year-close-race.test.js` (#212, pomijany bez `RD_TEST_PG_URL`): równoległe
„Zamknij rok” — dwie osoby z zarządu, podwójne kliknięcie tej samej osoby (i ponowienie
po zamknięciu), rozpoczynający (`four_eyes_required`) i inna osoba, dwa różne lata naraz;
zapis księgi, korekta księgi, korekta wpłaty (wpłata częściowa) i bilans otwarcia
(`LOCK … SHARE ROW EXCLUSIVE` w `ledger-cash`) w chwili zamknięcia; korekta wpłaty
niezatwierdzona przed zamknięciem; (#80) dopasowanie, nowe uzgodnienie i import wyciągu w chwili zamknięcia (`409 school_year_closed`), dopasowanie niezatwierdzone przed zamknięciem oraz cofnięcie i zatwierdzenie po zamknięciu. Pierwsze zamknięcie jest wstrzymywane w transakcji
zaraz po `LOCK TABLE … IN SHARE MODE` albo przed COMMIT, a kolejne żądania muszą
czekać na blokadę (`wait_event = 'advisory'` dla drugiego zamknięcia). Transakcje
biegną z `retries: 0`, bo ponowienie 40P01 w `src/db.js` ukryłoby zakleszczenie.
Kontrola pozytywna w tym samym pliku: po pominięciu `pg_advisory_xact_lock('rd_year_close')`
te same przeploty (ten sam rok i dwa różne lata) kończą się `40P01` i `503`.
Kampania e-mail rozpoczęta przed zamknięciem roku: `tests/pg-email-year-close-resume.test.js` (PGlite, #80) — worker dokańcza wysyłkę, każda rodzina raz, ponowienie nic nie dubluje.
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

## Pokrycie dziennikiem zdarzeń (#184)

`AGENTS.md` wymaga trwałego dziennika z aktorem, czasem i identyfikatorem obiektu dla
wpłat, operacji finansowych, zmian ról i wysyłek. Pilnują tego trzy warstwy:

- `tests/pg-authz-matrix.test.js`, poziom trasy: każda trasa POST/PATCH/PUT/DELETE
  z `tests/helpers/route-matrix.js` ma co najmniej jeden udany przypadek, a udane wywołania
  zostawiają zdarzenie z `actor_id`, `entity_type` i `entity_id`. Wyjątek wymaga wpisu
  z uzasadnieniem w `AUDIT_EXEMPT_ROUTES` (podglądy, powtórki) albo `AUDIT_ACTORLESS_ROUTES`
  (publiczne linki z tokenem).
- Ten sam plik, poziom wiersza: po każdym udanym zapisie każdy **nowy** wiersz tabeli
  z kolumną `id` (poza `audit_events`) ma zdarzenie z tego żądania, którego `entity_id`
  to id wiersza albo id obiektu nadrzędnego. Listy wyjątków są w
  `tests/helpers/audit-row-coverage.js`: `AUDIT_ROW_PARENTS` (wiersze podrzędne i historia,
  np. storno podziału wpłaty → podział), `AUDIT_ROW_TECHNICAL` (liczniki, klucze
  deduplikacji, dziennik dostępu) i `AUDIT_ROW_ROUTE_EXEMPT` (import: jedno zdarzenie
  `import.committed` na partię). Kontrola pozytywna detektora:
  `tests/audit-row-coverage.test.js`.
- `tests/audit-transaction-boundary.test.js`: zdarzenie zmieniające stan zapisuje się
  w transakcji zmiany (`insertAuditEvent(tx, …)` oraz lokalne pomocniki `audit(tx, …)`),
  a `tests/audit-actions-catalog.test.js` wymaga etykiety i domeny każdej akcji
  w `shared/audit-actions.js`.

Poza zakresem sprawdzenia: tabele bez kolumny `id` (np. liczniki prób logowania, hasła),
zmiany istniejących wierszy (UPDATE) bez nowego wiersza — te obejmuje poziom trasy — oraz
zadania poza trasami HTTP (worker e-mail, skrypty operatora).
