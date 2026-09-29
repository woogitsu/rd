# Macierz testów: moduł × scenariusz

Dokument śledzi, które scenariusze wymagane przez `AGENTS.md` (granice ról, dwie
osoby opiekujące się jednym dzieckiem, rodzeństwo, wpłaty częściowe, podwójne
kliknięcie, ponowienie zadania, błędny e-mail, korekty) mają test w repozytorium.
Tabelę utrzymuje się przy każdym PR, który dodaje moduł tras albo test scenariusza.
Pilnuje jej `tests/testing-matrix.test.js`. Dane w testach są wyłącznie syntetyczne
(`@example.invalid`), czas jest wstrzykiwany (`env.now`) tam, gdzie wynik zależy od dnia.

Legenda: `✓` pokryte testem wskazanym w rejestrze dowodów poniżej (dla kolumny „Role”
dowodem jest `tests/pg-authz-matrix.test.js`, 16 modułów × aktorzy × MFA × zakres);
`~` częściowo (tylko sekwencyjnie, bez skutków albo niesprawdzone pole po polu);
`n/d (powód)` scenariusz nie dotyczy modułu; `— (#N)` puste pole z odwołaniem do zgłoszenia.
Pole puste bez powodu i bez odwołania nie jest dozwolone.

Uwaga o współbieżności: testy oparte na PGlite wykonują transakcje po kolei, więc
„równoległe” scenariusze sprawdzają niezmiennik wyniku, a nie realny wyścig
(realne wyścigi na PostgreSQL: `tests/pg-reconciliation-race.test.js`,
`tests/pg-export-race.test.js`, uruchamiane z `RD_TEST_PG_URL`; #208).

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
