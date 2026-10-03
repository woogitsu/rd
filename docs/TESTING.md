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
`tests/pg-year-close-race.test.js`, `tests/pg-real-double-click.test.js`, `tests/pg-real-record-locks.test.js`,
`tests/pg-real-replay-23505.test.js`, uruchamiane z `RD_TEST_PG_URL`; #208, sekcja „Testy na prawdziwym PostgreSQL” niżej).

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
| historia | audit-history | ✓ | ✓ | n/d (odczyt historii jednego obiektu, nie listy rodzin) | n/d (odczyt dziennika, bez kwot w odpowiedzi) | ✓ | n/d (trasa tylko do odczytu) | n/d (brak adresów w odpowiedzi) | ✓ |
| uzgodnienia | reconciliation | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/d (brak adresów) | ✓ |
| zamkniecie | year-close | ✓ | n/d (bilans księgi, nie rodzin) | n/d (bilans księgi, nie wpłaty rodzin) | n/d (bilans księgi, nie wpłaty rodzin) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| email | email | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| dokumenty | documents | ✓ | n/d (dokument nie ma rodziny) | n/d (dokument nie ma rodziny) | n/d (brak kwot) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| wydarzenia | events | ✓ | n/d (wydarzenia bez rodzin) | n/d (wydarzenia bez rodzin) | n/d (brak kwot) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| aktualnosci | news | ✓ | ✓ | ✓ | n/d (brak kwot) | ✓ | ✓ | n/d (brak adresów) | ✓ |
| zebrania | meetings | ✓ | ✓ | ✓ | n/d (brak kwot) | ✓ | ✓ | ✓ | ✓ |
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
- Rola `audit` i flaga `AUDIT_LEDGER_READ` (D-09, wariant b, #137): macierz
  `tests/pg-authz-matrix.test.js` sprawdza stan domyślny (flaga wyłączona) i grupę `auditFlag`
  (osobna baza z flagą włączoną); `tests/pg-audit-ledger-read.test.js` pokrywa redakcję wpisów
  powiązanych z wpłatą (opis, źródło, referencja uchwały, identyfikator wpłaty), kategorie dowodów,
  inny rok, przydział klasowy, brak MFA, brak zapisów i ślad odczytu; liczby tras per moduł
  pilnuje `tests/audit-role-route-inventory.test.js` (tabela „Zakres roli audit” w docs/AUTHORIZATION.md).
  To założenie prototypu do formalnego potwierdzenia przez zarząd, nie decyzja.
- Widok tylko do odczytu `audit` w panelach `ledger/` i `documents/` (D-09, ciąg dalszy #137):
  pole `capabilities.auditLedgerRead` w `GET /api/session` pokrywa `tests/pg-audit-ledger-read.test.js`
  (tylko `audit` z MFA i przydziałem bez klasy, flaga wyłączona = brak pola, kontrakt sesji bez zmian);
  nawigację i parytet ról z serwerem — `tests/shell-core.test.js` i `tests/shell-panels-authz.test.js`
  (`capabilityRoles`); brak akcji zapisu w panelu — `tests/ledger-panel-core.test.js` i
  `tests/documents-core.test.js` (każdy `<dialog>`, formularz i przycisk z HTML musi być na liście
  elementów usuwanych albo na jawnej liście przycisków odczytu, widok audit woła tylko trasy odczytu,
  redakcja wpisu `paymentLinked`); przeglądarka — `tests/e2e/audit-readonly.spec.js` (serwer E2E ma
  `AUDIT_LEDGER_READ=1`, rok `e2e-y-auditro`; kontrast ze skarbnikiem tego samego roku). Ukrycie
  przycisku nie jest kontrolą dostępu — odmowy zapisów po stronie serwera pilnuje `pg-audit-ledger-read`.
- Dyrekcja bez roku (przydział i zaproszenie `principal` sprzed wymogu roku, wskazanie 2026-10-02):
  `tests/pg-access-review.test.js` (aktywny przydział bez roku oznaczony `revoke` / `year_scope_required`
  w przeglądzie każdego roku; z rokiem, cofnięty, wygasły i `audit` bez roku — nie; przegląd nie zmienia
  `role_grants`, odebranie jawną trasą), `tests/pg-auth.test.js` i `tests/pg-login.test.js` (przyjęcie
  zaproszenia `principal` bez roku: `school_year_required`, bez konta, przydziału i zużycia zaproszenia)
  oraz `tests/admin-core.test.js` (etykiety powodów w panelu).
- Samonadanie przy przedłużaniu przedstawicieli (#745, zasada z #146): `tests/pg-promotions.test.js`,
  blok „własne konto admina (#745)” — admin, który był przedstawicielem w roku źródłowym (obok innego
  przedstawiciela i konta wyłączonego): podgląd i zapis oznaczają jego wiersz `cannot_grant_self`, zapis
  nie tworzy mu przydziału, przedłuża pozostałych, `skipped`/`skippedSelf` i metadane
  `promotion.representatives_extended` liczą pominięcie, skrót planu stały (także po ponowieniu, które daje
  `created: 0`), skrót z podglądu innego admina → `409 plan_stale`, pominięty wiersz nie jest obsadą klasy;
  ochrona w głębi: wspólny zapis przydziału (`insertGrantInTx`) odrzuca własne konto `409 cannot_grant_self`.
  Kontrola pozytywna: na kodzie sprzed poprawki zapis daje `created: 4` (admin dostaje dwa przydziały od
  siebie), a sama ochrona w głębi bez poprawki planu odrzuca cały zapis `409 cannot_grant_self`. Ekran:
  `tests/admin-representatives.test.js` (podsumowanie, okno potwierdzenia i wynik).

## Rejestr dowodów

Każde `✓` poza kolumną „Role” ma tu co najmniej jeden wiersz. Fragment nazwy testu musi
występować w linii `test(...)` wskazanego pliku (sprawdza to meta-test).

| Wiersz | Scenariusz | Plik | Fragment nazwy testu |
|---|---|---|---|
| sesja | Ponowienie | tests/pg-mfa.test.js | verify sets MFA only on the calling session and refuses a replayed step |
| sesja | Błędny e-mail | tests/pg-auth.test.js | invitation is one-time, expires, can be revoked and must match the account email |
| admin | Ponowienie | tests/pg-admin.test.js | invitations return the token once, block duplicates |
| admin | Korekty | tests/pg-admin.test.js | revoking grants keeps history |
| admin | Ponowienie | tests/pg-promotions.test.js | zapis: admin bez przydziału, pozostali przedłużeni, skipped i audyt liczą pominięcie; ponowienie idempotentne |
| admin | Korekty | tests/pg-access-review.test.js | przegląd niczego nie odbiera; odebranie to jawna trasa POST /api/admin/grants/{id}/revoke i znika z propozycji |
| sesja | Błędny e-mail | tests/pg-auth.test.js | acceptInvitation: zaproszenie principal bez roku jest blokowane kodem school_year_required |
| rodziny | 2 opiekunów | tests/pg-primary-household.test.js | opieka naprzemienna: dwa obowiązujące gospodarstwa |
| rodziny | Rodzeństwo | tests/pg-families.test.js | zarząd widzi wszystkie klasy i rodzeństwo |
| rodziny | Wpł. częściowe | tests/pg-families.test.js | sumy wpłat netto tylko dla ról finansowych z MFA |
| rodziny | Podw. kliknięcie | tests/pg-families.test.js | dwie osoby edytują ten sam kontakt jednocześnie |
| rodziny | Ponowienie | tests/pg-primary-household.test.js | podwójne kliknięcie zmiany: ponowienie nie tworzy drugiego członkostwa |
| rodziny | Błędny e-mail | tests/pg-families.test.js | zmiana kontaktu opiekuna: tylko zarząd/admin |
| rodziny | Korekty | tests/pg-families.test.js | zmiana kontaktu opiekuna: tylko zarząd/admin, historia i audyt |
| rodziny | 2 opiekunów | tests/pg-guardian-update-verify.test.js | dwoje opiekunów jednego dziecka: kod opiekuna A nie potwierdza wniosku opiekuna B |
| rodziny | Podw. kliknięcie | tests/pg-guardian-update-verify.test.js | podwójne wysłanie formularza i ponowienie workera nie wysyłają drugiej |
| rodziny | Ponowienie | tests/pg-guardian-update-verify.test.js | błąd dostawcy: 429 wraca do kolejki bez zużycia próby |
| rodziny | Błędny e-mail | tests/pg-guardian-update-verify.test.js | adres na liście wyłączeń: brak wysyłki i stan failed z powodem |
| rodziny | Błędny e-mail | tests/kontakt-core.test.js | wniosek: pusty formularz niczego nie wysyła, zgoda wymaga jawnego wyboru, adres jest normalizowany |
| rodziny | Podw. kliknięcie | tests/families-guardian-verify-templates.test.js | widok korzysta z odpowiedzi prawdziwego API: szkic, zatwierdzenie przez inną osobę, odmowy |
| rodziny | Ponowienie | tests/pg-guardian-verify-monitoring.test.js | po przebiegu workera kod wychodzi (transport-atrapa) i kolejka znika z progów; ponowienie nic nie dopisuje |
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
| historia | 2 opiekunów | tests/pg-audit-history-board.test.js | historia wpłaty nieprzypisanej: przypisanie do gospodarstwa dopisuje zdarzenie bez opiekunów |
| historia | Podw. kliknięcie | tests/pg-audit-history-board.test.js | podwójne kliknięcie (ten sam klucz) zostawia w historii jedno zdarzenie utworzenia |
| historia | Korekty | tests/pg-audit-history-board.test.js | skarbnik widzi historię wpłaty: utworzenie, korekty po kolei |
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
| email | Podw. kliknięcie | tests/pg-meeting-board-notice.test.js | podwójne kliknięcie migawki, zatwierdzenia i kolejki |
| email | Ponowienie | tests/pg-meeting-board-notice.test.js | ponowienie zadania bez drugiej wiadomości |
| email | Błędny e-mail | tests/pg-meeting-board-notice.test.js | błędny adres odrzucony przez dostawcę i odbicie |
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
| zebrania | Korekty | tests/pg-meeting-board-notice.test.js | zmiana porządku lub terminu po zatwierdzeniu kampanii |
| zebrania | Błędny e-mail | tests/pg-meeting-board-notice.test.js | błędny adres odrzucony przez dostawcę i odbicie |
| zebrania | 2 opiekunów | tests/pg-meetings-class-recheck.test.js | dwoje opiekunów jednego dziecka |
| zebrania | Rodzeństwo | tests/pg-meetings-class-recheck.test.js | rodzeństwo w 1A i 2B |
| zebrania | Ponowienie | tests/pg-meetings-class-recheck.test.js | ponowienie zadania niczego nie dubluje |
| zebrania | Podw. kliknięcie | tests/pg-meetings-agenda-order.test.js | podwójne kliknięcie to powtórka |
| zebrania | Korekty | tests/pg-meetings-agenda-order.test.js | zmiana kolejności po zatwierdzonym zawiadomieniu |
| druk | 2 opiekunów | tests/pg-primary-household.test.js | opieka naprzemienna: dwa obowiązujące gospodarstwa |
| druk | Rodzeństwo | tests/pg-print.test.js | rodzeństwo: jedna rodzina z uczniami z różnych klas |
| druk | Wpł. częściowe | tests/pg-print.test.js | kwoty netto tylko dla roli finansowej z MFA |
| druk | Korekty | tests/pg-print.test.js | kwoty netto tylko dla roli finansowej z MFA |
| eksport | Ponowienie | tests/pg-export-audit-year.test.js | ponowny eksport daje ten sam wynik |

## Strona dla rodzica, widok szablonu i monitoring kodów weryfikacyjnych (#140 pkt 5)

Żaden z tych testów nie wysyła poczty: worker dostaje transport-atrapę (prawdziwy transport Brevo
odmawia pod `node --test`), a przeglądarkowy spec podstawia odpowiedzi API przez `page.route`.

- `tests/kontakt-core.test.js` — czyste funkcje strony `kontakt/` (token tylko z części `#`, format kodu,
  ciało wniosku, `emailVerification: requested` pokazuje pole kodu) i wymagania statyczne
  (`kontakt/main.js` bez `fetch`, bez `localStorage`, bez powłoki panelu). Test „jedna treść dla każdej porażki”
  przepuszcza przez wspólny klient `shared/api.js` odpowiedzi 400/404/409/429/503 i brak sieci i wymaga
  niepustej listy wyników o tym samym tekście (`assertEvery`).
- `tests/shared-api.test.js` — `kontakt/` jest poza listą paneli (`NON_PANEL_DIRS`, jak `login/` i `site/`:
  bez powłoki i bez przekierowania na logowanie), ale osobny test pilnuje, że używa wspólnego klienta
  i nie woła `fetch` bezpośrednio.
- `tests/e2e/kontakt.spec.js` — przeglądarka (Chromium z `PLAYWRIGHT_BROWSERS_PATH`, bez `playwright install`):
  wniosek z nowym adresem → pole kodu → ta sama treść dla złego kodu przy 400, 404 i 429 → sukces;
  pole kodu tylko przy `emailVerification: requested`; link zużyty albo zły to jedna treść; potwierdzenie
  nie niesie tokenu w adresie żądania (token jest w ciele).
- `tests/e2e/families-class-search.spec.js` — przeglądarka, 320 px (#128): wpisywanie w pole „Szukaj ucznia”
  na liście klasy (osobny rok `e2e-y-search`, klasa 3C z ośmioma wymyślonymi uczniami): zawężanie listy,
  licznik w regionie `role="status"` `aria-live="polite"`, dopasowanie bez polskich znaków (także „ł”),
  komunikat „Brak uczniów pasujących do …”, wpisany tekst jako tekst i brak poziomego przewijania także
  przy długim zapytaniu bez spacji.
- `tests/api-parity-ledger.test.js` — równoważność księgi Worker (D1) ↔ PostgreSQL (#41, część B): status,
  wszystkie nagłówki i ciało po normalizacji oraz granice ról (bez sesji, bez MFA, przedstawiciel klasy,
  konto bez roli, skarbnik innego roku, zarząd); różnice w `ALLOWED` opisuje `docs/EQUIVALENCE.md`.
- `tests/families-guardian-verify-templates.test.js` — czyste funkcje widoku szablonu w `families/`,
  zgodność granic z API i migracją 0184 oraz prawdziwe API na PGlite: szkic, odmowy `self_approval_forbidden`,
  `forbidden` (admin), `mfa_stale` (sesja z MFA sprzed 20 minut), `verify_template_changed`, podwójne
  kliknięcie zatwierdzenia i brak wierszy w `guardian_update_verifications` po zatwierdzeniu szablonu.
- `tests/pg-guardian-verify-monitoring.test.js` — kolejka `guardian_update_verifications` w `GET /health/jobs`,
  `GET /api/admin/ops-status` i `GET /api/email/worker-status`: stany `queued`/`sending`, najstarszy
  oczekujący (zegar `now`, nie przestawianie niezmiennego `created_at`), progi i ich konfiguracja,
  brak progów przy wyłączonej fladze, brak adresów i kodów w odpowiedziach, ponowienie zadania.
  Liczby z `count(*)` są rzutowane `::int` w zapytaniach (w `pg` bez rzutowania wracają jako tekst).

## Prośby o aktualizację kontaktu: MFA na trasie i błędne kodowanie identyfikatora (#748)

Testy na PGlite z danymi syntetycznymi (`@example.invalid`), bez sieci. Środowisko ma `MFA_REQUIRED_ROLES=''`,
więc bramka routera nie zatrzymuje admina ani zarządu bez czynnika — odmowę musi dać sama trasa.

- `tests/pg-guardian-updates.test.js`, opis „trasy zarządu: MFA na trasie niezależnie od MFA_REQUIRED_ROLES”:
  - admin i zarząd bez MFA dostają `403 forbidden` na każdej trasie zarządu modułu (link, kolejka, zatwierdzenie,
    odrzucenie, szablony: lista, szkic, zatwierdzenie). Migawka tabel modułu, `guardians`, historii kontaktu
    i audytu (bez `access.denied`) jest bez zmian. Odmowa zostawia ślad `access.denied` z `requiredRole`.
  - kontrola pozytywna: zarząd z MFA wykonuje te same trasy, zatwierdzenie zmienia adres, odrzucenie nie.
  - podgląd i formularz publiczny działają bez sesji i bez MFA.
  - `%E0%A4%A` i `%ZZ` w `approve`/`reject` oraz w zatwierdzeniu szablonu, bez sesji i z sesją, dają
    `400 invalid_request`. Przechwycony `console.error` nie ma `api_route_error` ani klasy `bug`. `GET` na ścieżce
    decyzji daje 404 i nie rozstrzyga wniosku.
- `tests/pg-guardian-update-verify.test.js`, test „#748: pusty MFA_REQUIRED_ROLES”: pełne potwierdzenie kodu przez
  właściciela tokenu (worker z transportem-atrapą) działa bez sesji. Zarząd bez MFA dostaje 403 na kolejce
  i szablonach.

Kontrola pozytywna: na kodzie sprzed poprawki zarząd bez MFA dostaje `201` z tokenem przy wydaniu linku,
a błędne kodowanie w `approve` daje `503 service_unavailable`. Oba testy wtedy nie przechodzą.

## Katalog rodzin: e-mail opiekuna i zapisy tylko z MFA (#751)

Testy na PGlite z danymi syntetycznymi (`@example.invalid`), bez sieci. Świat testu: rodzeństwo w dwóch klasach
(1A i 1B, wspólne gospodarstwo), dwoje opiekunów dziecka z 1A i opiekun wyłącznie dziecka z 1B.

- `tests/pg-families.test.js`, opis „moduł rodzin: e-mail opiekuna i zapisy tylko z MFA (#751)”:
  - przedstawiciel bez MFA (domyślne `MFA_REQUIRED_ROLES`): lista klasy i karta gospodarstwa bez żadnego adresu,
    karta bez klucza `email`, z imionami, zgodami i relacjami. Z MFA: adresy obojga opiekunów dziecka z własnej klasy.
    Przedstawiciel 1A nie widzi rodzeństwa z 1B ani jego opiekuna, w obu wariantach; przedstawiciel 1B — symetrycznie;
  - eksport listy klasy bez zmian: bez MFA `403 mfa_enrollment_required`, z MFA lista z adresami;
  - `MFA_REQUIRED_ROLES=admin,treasurer`: zarząd szkolny i zarząd z przydziałem klasy bez MFA dostają kartę bez
    adresów, z MFA pełną;
  - `MFA_REQUIRED_ROLES=admin,treasurer`: zarząd (szkolny i klasowy) bez MFA dostaje `403 forbidden` na każdym
    z dziesięciu zapisów modułu i na zapisie nieistniejącego opiekuna (brak wyroczni istnienia). Migawka `guardians`,
    `students`, przypisań, relacji, członkostw, liczników historii i audytu (bez `access.denied`) jest bez zmian.
    Każda odmowa zostawia ślad `access.denied` z `requiredRole: admin,board`;
  - kontrola pozytywna: zarząd z MFA wykonuje te same zapisy (200/201), bez śladu odmowy;
  - domyślne `MFA_REQUIRED_ROLES`: zarząd bez MFA zatrzymuje bramka routera, przedstawiciel nie ma prawa zapisu.
- Starsze testy reguł zgód dla adresu na karcie (#95, #200) używają sesji przedstawiciela z MFA.
- `tests/openapi-contract-families.test.js`: karta przedstawiciela bez MFA przechodzi schemat bez `email`, z MFA ma adresy.
- Macierz (`tests/pg-authz-matrix.test.js`): zapisy modułu mają `mfa: true`. `families.household` ma sprawdzenie
  `householdEmailCheck`: klucz `email` jest wtedy i tylko wtedy, gdy sesja ma MFA, a bez MFA w odpowiedzi nie ma adresu.
- `tests/families-core.test.js`: `guardianEmailText` pokazuje „ukryty — wymaga MFA” przy braku pola.

Kontrola pozytywna: na kodzie sprzed poprawki nie przechodzą trzy nowe testy: karta przedstawiciela, karta zarządu
przy `MFA_REQUIRED_ROLES=admin,treasurer` (adresy bez MFA) oraz zapisy zarządu bez MFA (wcześniej 200 i zmiana danych).

## Jakość asercji i izolacji (#214)

`tests/test-quality-lint.test.js` przegląda wszystkie pliki `tests/*.test.js`.
Każda reguła ma kontrolę pozytywną (kod, który reguła musi wykryć):

- `assert.ok(x.every(...))` jest zakazane w każdym pliku, bo przechodzi na
  pustej kolekcji. Używaj `assertEvery` z `tests/helpers/assertions.js`
  (wymaga niepustej kolekcji) albo kontroli długości w tej samej asercji.
- Obejście triggerów (`ALTER TABLE … DISABLE TRIGGER`, `SET
  session_replication_role = replica`) jest dozwolone tylko w plikach z
  `TRIGGER_BYPASS_ALLOWED`, każdy z uzasadnieniem. Do cofania czasu służy
  wstrzykiwany zegar (`now`), nie wyłączony strażnik.
  Lista ma sufit `TRIGGER_BYPASS_LIMITS` (liczba plików i linii z obejściem,
  dziś 34 i 47): meta-test wymaga równości, więc nowe obejście oblewa test, a
  usunięcie jednego wymaga obniżenia limitu — lista może tylko maleć (#214). `pg-bootstrap-admin` używa
  opcji `now` funkcji `bootstrapAdmin` (zegar kontroli ważnego admina i
  zaproszenia; domyślnie `now()` bazy); `pg-guardian-updates` używa
  `env.now` przy wygasaniu linków opiekunów (#140), a `pg-guardian-update-verify`
  — przy wygasaniu kodu weryfikacyjnego nowego adresu (#140 pkt 5; worker dostaje
  ten sam zegar przez opcję `now` przebiegu).
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

## Kontrakt OpenAPI: schematy i prawdziwe odpowiedzi (#160, etapy 2-14)

`docs/openapi.json` jest generowany (`npm run openapi:build`, sprawdzenie: `npm run openapi:build -- --check`);
`tests/openapi.test.js` pilnuje, że plik zgadza się z generatorem. Operacje modułów z `COVERED_MODULES`
(`src/pg/schemas/index.js`: etap 2 — `payments`, `payment-references`, `payment-instructions`, `ledger`;
etap 3 — `families`, `session`; etap 4 — `ledger-budget`, `ledger-cash`, `ledger-cost-centers`; etap 5 — `reconciliation`;
etap 6 — `email`; etap 7 — `meetings`; etap 8 — `documents`; etap 9 — `events`; etap 10 — `news`; etap 11 — `login`,
`mfa`; etap 12 — `admin`; etap 13 — `audit-history`, `audit-reviews`, `financial-reports`, `exports`, `print`, `board`,
`representative`; etap 14 — `guardian-updates`, `import`, `year-close`, `privacy-notice`; razem 297 operacji)
mają schematy ciał żądań i odpowiedzi
(`src/pg/schemas/<moduł>.js`, opis mechanizmu w `docs/API.md`). `tests/openapi-contract.test.js` sprawdza:

- rejestr pokrycia: każda trasa macierzy pokrytego modułu ma schemat (kontrola pozytywna: detektor wskazuje
  dopisaną trasę bez schematu), każdy schemat ma trasę, moduły macierzy = pokryte + jawnie niepokryte, a lista
  `UNCOVERED_MODULES` nie rośnie (sufit `MAX_UNCOVERED_MODULES`, obniżany w kolejnych PR-ach);
- kody błędów w schematach należą do katalogu `docs/API_ERRORS.md` i występują w źródle trasy (dla `reconciliation`
  także w parserach wyciągów `src/pg/bank/*.js`, dla `meetings` w module domenowym `src/pg/meetings.js`, dla `documents`
  w kontroli struktury pliku `src/documents.js` i kursorze list, dla `events` w module domenowym `src/pg/events.js`,
  dla `news` w module domenowym `src/pg/news.js` i kursorze list, dla `login` w `src/pg/login.js` i polityce haseł
  `src/pg/password.js`, dla `mfa` w `src/pg/mfa.js`, dla `admin` w modułach wniosków, partii zaproszeń, promocji, RODO,
  anonimizacji, resetu kont (`src/pg/login.js`) i kursorze list, dla `guardian-updates` w kursorze list, `ROUTE_HELPER_SOURCES`);
- **prawdziwe odpowiedzi** (PGlite, dane syntetyczne) przez `tests/helpers/contract-client.js` i walidator
  `tests/helpers/json-schema.js` (bez nowej zależności; nieznane słowo kluczowe schematu rzuca wyjątek, więc nie
  przepuszcza po cichu): utworzenie, ponowienie z tym samym kluczem (`Idempotency-Replayed`), korekta częściowa,
  zwrot i ponowne przypisanie wpłaty, podział wpłaty z cofnięciem, lista z kursorem (wpłaty, księga, weryfikacje),
  przeksięgowanie, uchwała z upoważnieniem, widok Komisji Rewizyjnej, eksporty (typ pliku), odmowy 401/403/404,
  konflikty 409 i błędy walidacji; kod błędu musi być w `x-rd-error-codes` danego statusu;
- każda odpowiedź sukcesu opisana w schematach została zwalidowana na prawdziwej odpowiedzi, a pominięcie każdego
  wymaganego pola ciała daje błąd i w schemacie, i na serwerze (400); odpowiedź `204` nie ma treści w schemacie.

Rejestr pokrycia i katalog kodów w tym pliku obejmują wszystkie pokryte moduły. Prawdziwe odpowiedzi etapu 3 sprawdza
`tests/openapi-contract-families.test.js` (ten sam `createContractClient`, PGlite, dane syntetyczne `@example.invalid`):

- `families`: karta gospodarstwa z **rodzeństwem w dwóch klasach i dwojgiem opiekunów** przy obojgu dzieciach
  (kryterium #160), **opieka dzielona** (dziecko w dwóch gospodarstwach, karta drugiego domu i `otherHouseholds`),
  węższy kształt karty i listy klasy dla przedstawiciela (bez rodzeństwa z innej klasy, bez `isPrimary*` i
  `paymentTotals`), suma wpłat dla ról finansowych z MFA; zapisy kontaktu, sprostowania imienia, zgody w relacji,
  przypisania do klasy (201 i zmiana klasy 200), odejścia, zakończenia relacji i członkostw, dodania członkostwa
  (201) — każdy z ponowieniem (`200`, `changed: false`; moduł nie używa `Idempotency-Key`, listy nie mają kursora);
  granice ról: przedstawiciel poza swoją klasą 404, bez prawa zapisu 403, zarząd z przydziałem klasy przy opiekunie
  rodzeństwa z innej klasy `403 guardian_shared_outside_scope`, Komisja Rewizyjna 403, brak sesji 401; błędy
  400 (`invalid_email`, `invalid_person_name`, `invalid_data_request_id`, `class_year_mismatch`, …), 404
  (`class_not_found`, `data_request_not_found`), 409 (`relation_ended`, `student_household_overlap`), 415, 422;
- `session`: logowanie hasłem, `GET /api/session` i `GET /api/access` przed MFA (bramka: `grants: []`,
  `mfaRequired: true`) i po zapisie MFA (rotacja sesji, `mfaVerified: true`), przydział klasowy z terminem,
  `writeMode: read_only`, `capabilities` Komisji Rewizyjnej tylko przy fladze, wylogowanie `204` bez treści
  (sesja cofnięta → 401, ponowienie i brak sesji też 204) i `403 invalid_origin`.

`409 school_year_closed` (zamknięty rok) jest w schematach rodzin, ale nie w tym teście: wymaga obejścia triggerów
(`TRIGGER_BYPASS_ALLOWED` w `tests/test-quality-lint.test.js`), a reakcję tras sprawdza `tests/pg-family-changes.test.js`.

Prawdziwe odpowiedzi etapu 4 sprawdza `tests/openapi-contract-ledger-extra.test.js` (ten sam `createContractClient`,
PGlite, dane syntetyczne; rok testowy jest pierwszym rokiem w systemie):

- `ledger-budget`: pierwsza wersja linii (z uwagą i bez), rewizja wskazująca poprzednią wersję, druga rewizja
  zastąpionej wersji `409 budget_line_superseded` z `currentLineId`, przyjęcie preliminarza bez uchwały i z przyjętą
  uchwałą zebrania ogólnego (tylko zarząd), wyłączenie kategorii z historią (`409 category_inactive` przy ponownym),
  historia wersji i przyjęć, wykonanie w czterech formatach (JSON z `check`, JSON na dzień `asOf` — przed przyjęciem
  i po — oraz CSV, XLSX, HTML); błędy `budget_line_exists`, `budget_empty`, `invalid_category`, `invalid_amount`,
  `invalid_reason`, `resolution_not_found`, `school_year_not_found`, `415`, `422`;
- `ledger-cash`: bilans otwarcia przed zapisem (`null`), zapis z dowodem, ponowienie, `opening_balance_exists`,
  `not_first_school_year`, `invalid_source_document`, `invalid_note`; poprawka z ponowieniem, `cash_below_zero`,
  `opening_balance_not_found`, `invalid_amount`; przeniesienie z ponowieniem, storno, drugie storno
  (`transfer_already_reversed`), storno storna (`invalid_reversal`), `transfer_not_found`, data poza rokiem (`422`),
  `413` i bramka danych osobowych;
- `ledger-cost-centers`: wpis bez przypisania, pierwsza wersja (wydarzenie) z ponowieniem, druga „pierwsza” wersja
  innym kluczem `409 allocation_version_conflict` z `currentVersionId`, nowa wersja z podziałem na dwie klasy,
  `allocation_exceeds_net`, `allocation_reason_required`, `invalid_allocation`, `invalid_cost_center`, `invalid_id`,
  `ledger_entry_not_found`; raport per wydarzenie i per klasa (JSON, CSV, XLSX) i rozliczenie wydarzenia
  (`event_not_found`);
- granice ról na odczytach i zapisach wszystkich trzech modułów: brak sesji `401`, przedstawiciel klasy i Komisja
  Rewizyjna `403 forbidden`, zarząd bez MFA `403 mfa_enrollment_required`, obcy `Origin` `403 invalid_origin`,
  skarbnik przy przyjęciu preliminarza i bilansie otwarcia `403`; pominięcie każdego wymaganego pola ciała → `400`;
- **zamknięty rok** bez obchodzenia triggerów: rok zamykają trasy `year-close` (lista kontrolna i druga osoba
  zarządu), po czym linia, rewizja, przyjęcie, wyłączenie kategorii, poprawka bilansu, przeniesienie i przypisanie
  dają `409 school_year_closed`, a bilans otwarcia następnego roku ma `carriedFromSchoolYearId`;
- trasy z parametrem `format` mają w specyfikacji schemat na każdy typ treści; klient kontraktu wybiera go po
  rzeczywistym `Content-Type` (kontrola pozytywna: nieopisany `Content-Type` jest błędem), a test wymaga walidacji
  każdego formatu.

Prawdziwe odpowiedzi etapu 5 sprawdza `tests/openapi-contract-reconciliation.test.js` (ten sam `createContractClient`,
PGlite, dane syntetyczne: rachunki to przykładowe IBAN z dokumentacji standardów z `tests/helpers/bank-statements.js`,
tytuły „syntetyczne”, adresy `@example.invalid`):

- import: lista JSON (z ponowieniem i `idempotency_conflict`), CSV z możliwym duplikatem, CODA z ponowieniem (węższy
  kształt odtworzenia), drugi plik z pominiętymi ruchami (`skippedDuplicates`), plik w całości już zaimportowany
  (`200`, `Idempotency-Replayed: false`, `import: null`), ten sam plik w innym szkicu (`409 statement_already_imported`),
  CAMT.053 z ostrzeżeniem ciągłości; błędy `statement_account_mismatch`, `invalid_statement_file`, `invalid_line_count`,
  `invalid_statement_line`, `invalid_csv_header`, `ambiguous_csv_delimiter`, `statement_line_after_statement_date`,
  `413`, `415` i `503 bank_import_not_configured` (serwer bez klucza i rachunku);
- widok: pozycje stronami po 3 z `nextCursor` aż do `null`, `invalid_cursor` (także kursor innego uzgodnienia),
  `invalid_limit`, obcięta lista wpisów księgi bez powiązania (`unmatchedLedgerEntriesTruncated`) i brak tytułów
  przelewów w odpowiedzi;
- propozycje: wpis księgi, wpłata ze zgodnym tytułem (`referenceMatch`) i kandydat `household` z komunikacji
  strukturalnej, `invalid_window`;
- dopasowanie 1:1 z ponowieniem, konfliktem klucza i `already_matched`, cofnięcie z ponowieniem (`200` z
  `Idempotency-Replayed: false`, potem `true`), `match_already_revoked`, `match_not_found` i ponowne dopasowanie;
  `match_amount_mismatch`, `match_method_mismatch`; zwrot dopasowany do ujemnej pozycji (`paymentRefundId`);
  wsadowe (ponowienie, `match_batch_rejected` z `failures`, `match_batch_empty`, `match_batch_duplicate`,
  `match_batch_too_large`) i zbiorcze z cofnięciem (`group_match_sum_mismatch`, `invalid_match_target`,
  `invalid_statement_line`); wpłata z pozycji (gospodarstwo i nieprzypisana, ponowienie, `statement_line_not_income`,
  `statement_line_not_found`, `422 date_outside_school_year` dla pozycji sprzed początku roku);
- zatwierdzenie (`four_eyes_required`, `difference_requires_note`, ponowienie, `reconciliation_confirmed` przy
  zapisach po zatwierdzeniu) i porzucenie (ponowienie, `reconciliation_abandoned`, `reconciliation_has_active_matches`);
- raport KR w trzech formatach z danymi w każdej sekcji (korekta, przeksięgowanie, poprawka bilansu, wydatek ponad
  próg, wynik wydarzenia, ścieżka kontroli z odpowiedzią i wnioskiem), `invalid_request`, `school_year_not_found`;
- granice ról na wszystkich 14 trasach: brak sesji `401`, przedstawiciel klasy i Komisja Rewizyjna `403 forbidden`
  (raport KR: KR z MFA ma dostęp, bez MFA `mfa_enrollment_required`), zarząd bez MFA `403 mfa_enrollment_required`,
  obcy `Origin` `403 invalid_origin`; pominięcie każdego wymaganego pola ciała → `400`;
- **zamknięty rok** bez obchodzenia triggerów (trasy `year-close`): utworzenie, import, wpłata z pozycji, dopasowania
  1:1, wsadowe i zbiorcze, cofnięcie, zatwierdzenie i porzucenie dają `409 school_year_closed`, raport zamkniętego
  roku nadal działa.

`409 inconsistent_matches` jest w schemacie zatwierdzenia, ale nie w tym teście (pola `inconsistentMatches` i
`inconsistentGroupMatches` widoku są tu puste): niespójność powstaje po korekcie celu już powiązanego, a tę korektę
API blokuje, dopóki powiązanie w szkicu jest aktywne (#165); `tests/pg-reconciliation.test.js` osiąga ją obejściem
triggerów (`TRIGGER_BYPASS_ALLOWED`).

Prawdziwe odpowiedzi etapu 6 (moduł `email`, 30 operacji) sprawdza `tests/openapi-contract-email.test.js` (ten sam
`createContractClient`, PGlite, dane syntetyczne `@example.invalid`). **Żadnej sieci i żadnej wysyłki:** wysyłka testowa
(`env.emailTransport`) i zadanie kolejki (`runEmailBatch`) dostają wyłącznie atrapę transportu, a test kończy się
sprawdzeniem, że pułapka sieci (`networkGuardCalls()`) nie odnotowała żadnej próby. Scenariusz:

- przebieg kampanii: szkic z ponowieniem i `idempotency_conflict`, edycja z wersją (`revision_conflict`, podwójne
  kliknięcie, termin startu ustawiony i usunięty), migawka odbiorców, podgląd przed i po migawce, **jawne zatwierdzenie**
  skrótów treści i listy przez inną osobę z zarządu (świeże MFA; `forbidden` dla skarbnika, `mfa_stale`, `approval_stale`,
  `self_approval_forbidden` autora), kolejka przed zatwierdzeniem `409 approval_required`, kolejka i jej ponowienie;
- **klucz kampania + rodzina:** rodzina z rodzeństwem w dwóch klasach i dwojgiem opiekunów dostaje jedną wiadomość (kontakt
  główny), druga rodzina — osobną; wiersze kolejki mają klucze `campaign:<id>:household:<id>`, transport dostaje te same
  klucze, a ponowienie kolejki (`queued: 0`) i ponowny przebieg zadania nie wysyłają niczego drugi raz;
- błędne dane: opiekun z błędnym adresem (`no_valid_email`), adres zablokowany webhookiem (`suppressed`), adres użyty już
  dla innej rodziny (`duplicate_address`); błędy treści (`invalid_subject`, `invalid_placeholder`, `forbidden_wording`, …);
- zadanie: odmowa konta dostawcy (401) zapisuje pauzę, jej odczyt i zdjęcie przez zarząd (z ponowieniem, `mfa_stale`,
  `provider_pause_not_found`), wysyłka z wynikiem niepewnym (`delivery_unknown`) i odmową 400; webhook doręczenia, raport
  (JSON i CSV), lista „do sprawdzenia”, rozstrzygnięcia i ich zatwierdzenie (cztery oczy, `resolution_not_approvable`),
  kampania uzupełniająca (`followup_source_not_eligible`, `followup_no_households`), pauza, wznowienie, anulowanie;
- lista wyłączeń i zdjęcie blokady przez dwie osoby (`release_reason_not_allowed` po skardze, `422 possible_personal_data`,
  `request_already_consumed`), limit Brevo i ewidencja wiadomości spoza kolejki z korektą (`quota_correction_exceeds`),
  stan zadania przed pierwszym przebiegiem (`worker_never_ran`) i po nim, wysyłka testowa (tylko adres z
  `EMAIL_PREVIEW_RECIPIENTS`, `preview_recipient_not_allowed`, `sending_disabled`, `429 preview_campaign_limit`),
  wypisanie jednym kliknięciem (idempotentne, `invalid_token`, `429 rate_limited`), webhook (`401`, `415`, `413`, `503`);
- listy z kursorem: kampanie, odbiorcy, „do sprawdzenia”, wyłączenia i ewidencja limitu (`invalid_limit`, `invalid_cursor`);
- granice ról na odczytach i zapisach: brak sesji `401`, przedstawiciel klasy, zarząd z przydziałem klasy i Komisja
  Rewizyjna `403 forbidden`, zarząd bez MFA `403 mfa_enrollment_required`, obcy `Origin` `403 invalid_origin`;
- pominięcie każdego wymaganego pola ciała → `400` i każda odpowiedź sukcesu ze schematu zwalidowana na prawdziwej odpowiedzi.

Klient kontraktu przyjmuje dodatkowe nagłówki (`headers`, np. sekret webhooka, `Content-Type`) i dopuszcza brak
nagłówka `Idempotency-Replayed` wyłącznie wtedy, gdy specyfikacja ma go z `required: false` (zapis bez klucza, który
wysyła `true` tylko przy ponowieniu) — kontrola pozytywna w tym samym pliku. Kody błędów z parsera treści kampanii
(`src/email/content.js`) i odmowy adresu wysyłki testowej (`src/email/brevo.js`) test rejestru szuka także w tych
plikach (`ROUTE_HELPER_SOURCES`), a detektor kodów `tests/pg-api-errors-catalog.test.js` i `tests/shared-api.test.js`
(identyczny w obu plikach) skanuje `src/email/content.js` i zna kody `mfa_stale` i `preview_recipient_not_allowed`
zwracane przez funkcje pomocnicze.

Prawdziwe odpowiedzi etapu 7 (moduł `meetings`, 28 operacji) sprawdza `tests/openapi-contract-meetings.test.js` (ten sam
`createContractClient`, PGlite, dane syntetyczne `@example.invalid`, imiona opiekunów syntetyczne). **Żadnej wysyłki:**
z zawiadomienia powstaje wyłącznie szkic kampanii (`sent: false`, kolejka `email_outbox` pusta), test niczego nie
zatwierdza w module e-mail, a pułapka sieci (`networkGuardCalls()`) kończy się zerem. Scenariusz:

- zebranie ogólne, zarządu i klasowe: utworzenie z ponowieniem (`Idempotency-Replayed`), `idempotency_conflict`, błędy
  reguł (`quorum_rule_source_required`, `invalid_quorum_rule`, `invalid_notice_rule`, `invalid_reference`), lista z kursorem
  (`invalid_limit`, `invalid_cursor`); edycja z rewizją (podwójne kliknięcie bez nowej wersji, `revision_conflict`,
  `invalid_revision`, `meeting_status_transition_invalid`);
- porządek obrad: punkty z ponowieniem, `agenda_position_taken`, bramka danych osobowych (`422`), wycofanie punktu
  z ponowieniem, zmiana kolejności (te same numery pozycji, ponowienie `replayed: true`, `invalid_agenda_order`);
- zawiadomienie: szkic i jego ponowienie, cztery oczy (`notice_four_eyes_required`), `notice_up_to_date`,
  **szkic kampanii bez wysyłki** dla rodzin roku, rodzin klasy (`class_households`) i kont zebrania zarządu
  (`meeting_invitees`), plik kalendarza (`text/calendar`, `notice_calendar_unavailable` dla szkicu i starszej wersji);
  zmiana terminu przez `PATCH` po zatwierdzeniu → `use_reschedule_endpoint`; **zmiana terminu** z powodem (szkic
  zawiadomienia `reschedule`, ponowienie, `reschedule_no_change`, `revision_conflict`, `invalid_reason`), po której podgląd
  kampanii w module e-mail ostrzega `notice_outdated`, a szkic zmiany terminu po zmianie kolejności — `409 notice_outdated`
  przy zatwierdzeniu; nowsza wersja (`update`) i `notice_not_latest`;
- **odwołanie** z powodem (szkic zawiadomienia o odwołaniu, ponowienie, inny powód `meeting_cancelled`, zapisy po
  odwołaniu `409 meeting_cancelled`), publiczne zawiadomienia z kursorem (wyłącznie zebrania ogólne, odwołanie z pustym
  porządkiem);
- zebranie odbyte: **obecność dwojga opiekunów jednego dziecka** (dwa wpisy, ponowienie poprawia ten sam wiersz,
  `invalid_reference`), quorum z ponowieniem i `idempotency_conflict` po zmianie obecności, `quorum_requires_held_meeting`;
- **uchwały z wersjami**: projekt z podpowiedzią numeru, edycja z rewizją, rozstrzygnięcie (`resolution_number_required`,
  `vote_record_required`, `resolution_votes_exceed_present_voters`), `resolution_final_immutable`, korekta jako nowa
  rewizja (ponowienie, `concurrent_version`), nieaktualne quorum (`resolution_quorum_check_stale`), uchwała zmieniająca
  (`resolution_amends_requires_adopted`, `invalid_relation_kind`, `resolution_number_taken`), wycofanie projektu,
  wykonanie uchwały (także po zatwierdzeniu protokołu; `resolution_not_decided`), rejestr z filtrami i wyszukanie po
  numerze (skarbnik);
- protokół: wersje, `minutes_four_eyes_required`, `minutes_open_resolutions` z liczbą projektów, lista kontrolna,
  `minutes_not_latest_version`, `minutes_not_approved`, zatwierdzenie z ponowieniem, blokada zebrania (`meeting_locked`),
  widoczność dla rodziców i publiczna (protokoły udostępnione przedstawicielowi, publiczne bez logowania),
  `minutes_contain_personal_data` dla poprawionej wersji ze znanym imieniem i nazwiskiem;
- granice ról: brak sesji `401`; przedstawiciel 1A — zebranie klasy 1B (i każde inne) `404 meeting_not_found`, listy
  i rejestr `403`, zapisy `403 forbidden`; zarząd z przydziałem 1A — pusta lista i `404` dla zebrania 1B; Komisja
  Rewizyjna i dyrekcja (bez MFA) — odczyt zebrania z listą obecności jak KR (D-09), zapisy `403 forbidden`; skarbnik —
  tylko wyszukanie uchwały; zarząd bez MFA `403 mfa_enrollment_required`, a przy pustym `MFA_REQUIRED_ROLES` —
  `403 mfa_required` modułu; obcy `Origin` `403 invalid_origin`;
- błędy `400` (`invalid_json`, identyfikatory ścieżki), `404`, `413`, `415`, `422` (`personal_data_forbidden`,
  `possible_personal_data` i potwierdzenie) oraz **zamknięty rok** przez trasy `year-close` (zapisy → `409
  school_year_closed`, odczyt działa; przydziały roku wygasają, więc zapisuje zarząd z przydziałem bez roku);
- pominięcie każdego wymaganego pola ciała → `400`, każda odpowiedź sukcesu ze schematu zwalidowana na prawdziwej
  odpowiedzi, a osobny test sprawdza w specyfikacji, które zapisy mają `Idempotency-Key`, a które ponowienie sygnalizują
  polem `replayed`.

Kody reguł bazy przekazywane przez moduł zebrań (lista `DATABASE_CONFLICTS` w `src/pg/meetings.js`) i kody
identyfikatorów ścieżki (`requireId(…, 'invalid_meeting_id')`) wykrywa od etapu 7 detektor kodów (identyczny
w `tests/pg-api-errors-catalog.test.js` i `tests/shared-api.test.js`); są w `docs/API_ERRORS.md` i `shared/messages.js`.

Prawdziwe odpowiedzi etapu 8 (moduł `documents`, 22 operacje) sprawdza `tests/openapi-contract-documents.test.js` (ten sam
`createContractClient`, PGlite, **magazyn plików w pamięci** `createMemoryStorage()` jak w `tests/pg-documents.test.js`,
pliki syntetyczne: PDF z tekstem testowym, PNG i JPEG z `tests/helpers/synthetic-images.js`; pułapka sieci kończy się zerem).
Macierz tras rozdziela `/api/documents/{id}` na cztery rodzaje, więc odczyty i zapisy dokumentu wskazują szablon operacji
opcją `template` klienta, a schemat metadanych przypina `document.kind` do rodzaju (kontrola pozytywna: zły szablon jest
błędem). Klient przyjmuje ciało binarne (`Uint8Array`) i wymaga, by jego `Content-Type` był opisany w `requestBody`
(kontrola pozytywna: `text/html`). Scenariusz:

- przesłanie PDF, PNG i JPEG każdego rodzaju (`financial`, `board`, `class`, `council_shared`), ponowienie tym samym kluczem
  (`200`, `replayed: true`, bez nagłówka `Idempotency-Replayed`, bez drugiego obiektu w magazynie), `idempotency_conflict`,
  dowody powiązane z wpisem księgi i z wpłatą (`invalid_link`), błędy `invalid_kind`, `invalid_school_year`, `invalid_class`,
  `idempotency_key_required`, `empty_document`, **walidacja typu i rozmiaru pliku** (`415 unsupported_media_type` dla HTML
  i sygnatury niezgodnej z nagłówkiem, `415 document_active_content`, `415 document_malformed`, `413 document_too_large`),
  `503 storage_unavailable` (brak magazynu) i `503 upload_busy` (zajęte miejsce uploadu, `Retry-After`);
- lista z kursorem (strony po 4 aż do `nextCursor: null`, ta sama kolejność co jedna strona), filtry rodzaju, klasy, stanu,
  kategorii, wyszukiwania, dat i `validation=outdated`, sortowanie po dacie (bez kursora), przestarzały `offset` i błędy
  (`invalid_limit`, `invalid_cursor` — także kursor innego filtra, `invalid_request`, `invalid_document_date`, …);
- opis z wersjami dla każdego rodzaju (ponowienie, konflikt klucza, historia `descriptionHistory` od najnowszej) i jego błędy
  (`invalid_title`, `invalid_category`, `invalid_document_date`, `invalid_description`, `invalid_request`, `invalid_json`,
  `400 invalid_content_type`, `413 request_too_large`, bramka danych osobowych `422` z potwierdzeniem);
- **treść tylko po autoryzacji każdego żądania**: pobranie każdego typu pliku każdego rodzaju (każdy typ treści ze
  specyfikacji zwalidowany), podgląd obrazu `disposition=inline`, bajty PDF `purpose=preview`, **PDF z `disposition=inline`
  → `400 pdf_inline_not_allowed` (#705)**, `invalid_disposition`, brak sesji i wygasła sesja `401`, plik sprzed bieżących
  reguł z aktywną treścią (`409 document_preview_blocked`, pobranie działa), brak obiektu w magazynie
  (`409 document_content_missing`, także przy ponowieniu przesłania) i niezgodna suma kontrolna (`503 service_unavailable`);
- zastąpienie i unieważnienie każdego rodzaju (ponowienie kluczem i tą samą zmianą innym kluczem, „zastępuje”/„zastąpiony
  przez” w metadanych, unieważniony plik nadal do pobrania), `document_status_conflict`,
  `document_status_replacement_not_active`, `invalid_replacement_document`, `invalid_reason`, `idempotency_conflict`, `422`;
- granice ról: brak sesji `401` na każdej operacji; przedstawiciel klasy wobec dokumentu zarządu, finansowego i innej klasy
  (`404`, przesłanie `403`), przedstawiciel czyta dokument Rady, ale go nie opisuje ani nie zastępuje (`404`); zarząd
  z przydziałem klasy (tylko swoja klasa); dyrekcja (`403` listy, `404` dokumentu); Komisja Rewizyjna z flagą
  `AUDIT_LEDGER_READ` (tylko faktura bez powiązania z wpłatą, opis bez wolnego tekstu, żadnego zapisu), bez MFA
  (`403 mfa_enrollment_required`) i bez flagi (`403`/`404`); zarząd bez MFA w bramce routera (`mfa_enrollment_required`
  i `mfa_required` dla konta z czynnikiem) na każdej operacji, skarbnik bez MFA przy pustym `MFA_REQUIRED_ROLES` (`404`
  dowodu, `403` przesłania); obcy `Origin` `403 invalid_origin` na każdym zapisie;
- **zamknięty rok** przez trasy `year-close`: przesłanie, opis i zastąpienie → `409 school_year_closed`, unieważnienie
  nadal `201`, treść do pobrania; pominięcie każdego wymaganego pola ciała → `400` i każda odpowiedź sukcesu ze schematu
  (także każdy typ treści pliku) zwalidowana na prawdziwej odpowiedzi.

`413 request_too_large` przesłania (serwer Node przed trasą) i `400 document_preview_unsupported` (nieosiągalne dla
dokumentów z API) są w schemacie, ale nie w tym teście (rozbieżności opisuje `docs/API.md`, „Cechy modułu etapu 8”).

Prawdziwe odpowiedzi etapu 9 (moduł `events`, 15 operacji) sprawdza `tests/openapi-contract-events.test.js` (ten sam
`createContractClient`, PGlite, dane syntetyczne `@example.invalid`, imiona opiekunów syntetyczne; moduł niczego nie wysyła,
pułapka sieci kończy się zerem). Osobny test sprawdza w specyfikacji, że nagłówek `Idempotency-Replayed` ma tylko utworzenie
wydarzenia, a zadanie i zapis sygnalizują ponowienie polem `replayed` (`const` w schemacie 201/200). Scenariusz:

- wydarzenie klasowe przedstawiciela 1A: utworzenie z ponowieniem (`Idempotency-Replayed`), `idempotency_conflict`,
  `invalid_idempotency_key`, **odmowa dla klasy spoza przydziału i wydarzenia ogólnoszkolnego** (`403 forbidden`), błędy czasu
  Europe/Brussels (`ambiguous_local_time` 25.10.2026, `nonexistent_local_time` 28.03.2027, `offset_not_valid_in_europe_brussels`,
  `invalid_datetime`, `ends_before_start`), błędy treści (`invalid_title`, `invalid_description`, `invalid_location`,
  `invalid_organizer`, `invalid_audience`, `invalid_school_year`, `invalid_class`), klasa z innego roku albo nieistniejąca
  (`invalid_reference`), bramka danych osobowych (`422` i potwierdzenie);
- wydarzenie ogólnoszkolne zarządu: szczegóły z historią wersji, lista roku (przedstawiciel widzi tylko swoją klasę),
  **zmiana z wersją** (podwójne kliknięcie `replayed: true`, `revision_conflict`, `invalid_revision`), zgłoszenie z ponowieniem,
  zatwierdzenie (`invalid_transition` dla szkicu, **cztery oczy** `four_eyes_required`, `403 forbidden` dla admina i
  przedstawiciela), **publikacja** z ponowieniem, `event_not_public` dla wydarzenia wewnętrznego;
- **zadania i zapisy z limitem**: zadanie publiczne i wewnętrzne, ponowienie kluczem (`replayed: true` bez nagłówka),
  `idempotency_conflict`, `task_time_outside_event`, `invalid_slots_needed`, `422`; opiekunowie do formularza (`class_required`,
  `class_not_found`, `invalid_class`, rodzeństwo w dwóch klasach); **dwoje opiekunów jednego dziecka** to dwa zapisy, podwójny
  zapis innym kluczem — powtórka, trzeci zapis `409 task_full`, wycofanie z ponowieniem i ponowny zapis tego samego wiersza,
  zapis konta (`userId`), `invalid_signup_target`, `invalid_reference`, `event_task_not_found` (także zadanie innego wydarzenia),
  `event_task_signup_not_found`; przedstawiciel zapisuje opiekuna dziecka swojej klasy, opiekun spoza klasy
  `guardian_outside_class`; zmiana czasu wydarzenia wykazuje zadanie poza czasem (`tasksOutsideEventTime`, `outsideEventTime`);
  odwołanie zadania z ponowieniem (zapisy zablokowane `event_cancelled`, `invalid_reason`, `422`);
- **widok publiczny tylko z zatwierdzonymi danymi**: zatwierdzone, ale nieopublikowane wydarzenie poza listą, opublikowane
  bez autorów i osób, `volunteerTasks` tylko z zadań `isPublic` (`stillNeeded`), po zmianie opublikowanego — ostatnia
  opublikowana wersja z `changedAfterPublication: true`, odwołane opublikowane — `cancelled` bez powodu i bez zadań;
  **lista z kursorem** (strony po 2 aż do `nextCursor: null`, ta sama kolejność co jedna strona, kursor innego filtru
  `invalid_cursor`, filtr `from`, `invalid_limit`, `invalid_date`, `invalid_datetime`, `invalid_school_year`);
- **odwołanie** wydarzenia klasowego przez przedstawiciela (ponowienie, potem `event_cancelled` przy zmianie, zgłoszeniu,
  nowym zadaniu i zapisie; wycofanie zapisu nadal działa) i opublikowanego przez zarząd (przedstawiciel `403 forbidden`);
- granice ról: brak sesji `401` na każdej operacji; przedstawiciel 1A — wydarzenie ogólnoszkolne i klasy 1B jak nieistniejące
  (`404 event_not_found`); zarząd z przydziałem klasy, Komisja Rewizyjna, dyrekcja i skarbnik — lista `403`, wydarzenie i zapisy
  `404`, utworzenie `403`; zarząd bez MFA `403 mfa_enrollment_required`, a przy pustym `MFA_REQUIRED_ROLES` szkic i zgłoszenie
  działają, zatwierdzenie i publikacja — `403 mfa_required` modułu; obcy `Origin` `403 invalid_origin` na każdym zapisie;
- błędy `400` (`invalid_event_id` — także dla identyfikatora zadania i zapisu, `invalid_json`), `404`, `413`, `415` oraz
  **zamknięty rok** przez trasy `year-close` (zapisy → `409 school_year_closed`, odczyty i lista publiczna działają; odwołanie
  zadania przechodzi — rozbieżność opisana w `docs/API.md`, „Cechy modułu etapu 9”);
- pominięcie każdego wymaganego pola ciała → `400` i każda odpowiedź sukcesu ze schematu zwalidowana na prawdziwej odpowiedzi.

Prawdziwe odpowiedzi etapu 10 (moduł `news`, 21 operacji) sprawdza `tests/openapi-contract-news.test.js` (ten sam
`createContractClient`, PGlite, dane syntetyczne `@example.invalid`, imiona opiekunów syntetyczne). **Zdjęcia są wyłącznie
syntetyczne**: bajty PNG/JPEG generuje `sharp` z jednolitego koloru (bez wizerunków i EXIF), odwołania do zgód i dokumentów
to fikcyjne identyfikatory; magazyn plików w pamięci (`createMemoryStorage`), pułapka sieci kończy się zerem. Osobny test
sprawdza w specyfikacji, że klucz i nagłówek `Idempotency-Replayed` mają tylko szkic, rejestracja zdjęcia i plik, odwołanie do
zgody sygnalizuje ponowienie polem `replayed` (`const` w 201/200), trasy publiczne nie mają `security`, a schemat rejestracji
wymaga `altText` albo `decorative: true`. Scenariusz:

- **rejestr zdjęć**: utworzenie z ponowieniem (`Idempotency-Replayed`), `idempotency_conflict`, `invalid_idempotency_key`,
  **`alt_text` wymagany** (`422 alt_text_required` bez opisu, z `decorative: false` i z `altText: null`), zdjęcie dekoracyjne
  (`altText: null`, publicznie `""`), `public_copy_requires_license`, błędy pól (`invalid_source`, `invalid_taken_on`,
  `invalid_depicts_children`, `invalid_explicit_license`, `invalid_decorative`, `invalid_document_id`, `invalid_author`,
  `invalid_source_detail`, `invalid_license_text`, `invalid_license_document_ref`, `invalid_rights_note`, `invalid_alt_text`,
  `invalid_identifiable_children`, `invalid_identifiable_adults`, `invalid_consent`, `invalid_consent_scope`,
  `invalid_consent_valid_until`), bramka danych osobowych (`422` i potwierdzenie);
- **zgody i weryfikacja**: rodzeństwo na jednej zgodzie (dwa numery osoby, ten sam dokument), `consent_missing` przed
  dopisaniem drugiej zgody, ponowienie (`200 { replayed: true }`), `consent_conflict`, błędy zgody, odczyt zdjęcia z
  odwołaniami; **cztery oczy** (`four_eyes_required`), admin techniczny nie weryfikuje (`403`), `child_consent_required`,
  `consents_locked` po weryfikacji;
- **plik zdjęcia**: PNG i JPEG (warianty `web`/`thumb`, JPEG bez EXIF), ponowienie tym samym kluczem, `photo_file_exists`,
  `415` (typ niezgodny z sygnaturą, PDF, uszkodzony PNG `photo_file_malformed`), `400 empty_photo_file`, `413
  photo_file_too_large`, `404`, `400 invalid_photo_id`/`invalid_idempotency_key`, `503 upload_busy` (sloty zajęte po kolei)
  i `503 storage_unavailable`;
- **wpisy**: szkic przedstawiciela z ponowieniem, odmowa dla klasy spoza przydziału, wpisu ogólnoszkolnego i zdjęć
  (`photos_require_school_wide_role`), błędy treści, `duplicate_photo`, `422 photo_not_found`, klasa z innego roku albo
  nieistniejąca (`invalid_reference`), bramka (`personal_data_forbidden`, `possible_personal_data` z `known_name`); **zmiana z
  wersją** (podwójne kliknięcie, `revision_conflict`, `invalid_revision`), zgłoszenie z ponowieniem, zatwierdzenie
  (`invalid_transition` dla szkicu, **cztery oczy**, `403` dla admina i przedstawiciela), **publikacja** z ponowieniem;
- **widok publiczny tylko z zatwierdzonymi danymi**: zatwierdzony, ale nieopublikowany wpis `404`; opublikowany bez autorów,
  zgód, dokumentów, klas i roku; **zdjęcie ze zgodą tylko na druk** (bez `rada_website`) zweryfikowane, ale poza `photos[]` i
  bez publicznego pliku; **zdjęcie niezweryfikowane** blokuje zatwierdzenie (`photo_rights_unverified`); nowa wersja czeka, a
  publicznie zostaje opublikowana; **wycofanie zgody** (rodzeństwo) i **cofnięcie praw** (`photo_revoked`) ukrywają zdjęcie
  z listy i z publicznego pliku przy następnym żądaniu; po cofnięciu: weryfikacja, plik, zmiana i nowy wpis z tym zdjęciem
  `409 photo_revoked`; stały adres wpisu (`404` dla szkicu, nieznanego, złego i niepoprawnie zakodowanego identyfikatora);
  publiczny plik z naruszoną integralnością (`409 photo_file_integrity_mismatch`) i bez magazynu (`503`); lata z treściami;
- **wycofanie wpisu**: przedstawiciel nie wycofuje opublikowanego (`403`), `invalid_reason`, `422`, `revision_conflict`,
  ponowienie, wpis znika publicznie, `post_withdrawn` przy zmianie i zgłoszeniu; przedstawiciel wycofuje własny szkic;
- **listy z kursorem**: publiczna (strony po 2 aż do `nextCursor: null`, kursor innego filtru, `invalid_limit`,
  `invalid_cursor`, `invalid_school_year`) i rejestr zdjęć (strony po 2, filtr `status`, kursor innego filtru,
  `invalid_status`, `invalid_limit`, `invalid_cursor`);
- granice ról: brak sesji `401` na każdej operacji; przedstawiciel 1A — wpis ogólnoszkolny i klasy 1B jak nieistniejące
  (`404 post_not_found`), rejestr zdjęć `403`; zarząd z przydziałem klasy, Komisja Rewizyjna, dyrekcja i skarbnik — lista
  `403`, wpis i jego kroki `404`, szkic, rejestr zdjęć, zgody, weryfikacja, cofnięcie, plik i wycofanie zgody `403`; zarząd
  bez MFA `403 mfa_enrollment_required`, a przy pustym `MFA_REQUIRED_ROLES` szkic i zgłoszenie działają, zatwierdzenie i
  publikacja — `403 mfa_required` modułu; obcy `Origin` `403 invalid_origin` na każdym zapisie (także pliku);
- błędy `400` (`invalid_post_id`, `invalid_photo_id`, `invalid_json` — także puste ciało weryfikacji), `404`, `413`, `415`
  oraz **zamknięty rok** przez trasy `year-close` (nowy wpis → `409 school_year_closed`; zmiana i wycofanie istniejącego
  wpisu przechodzą, archiwum publiczne działa, zdjęcia nie należą do roku);
- pominięcie każdego wymaganego pola ciała → `400` i każda odpowiedź sukcesu ze schematu (także plik `image/jpeg`)
  zwalidowana na prawdziwej odpowiedzi.

Prawdziwe odpowiedzi etapu 11 (moduły `login`, 6 operacji, i `mfa`, 7 operacji) sprawdza
`tests/openapi-contract-auth.test.js` (ten sam `createContractClient`, PGlite, dane syntetyczne `@example.invalid`, hasła
generowane w teście, scrypt o najniższym koszcie `SCRYPT_COST_LOG2=15`). Trasy niczego nie wysyłają (reset hasła to token
od administratora, bez e-maila), więc nie ma atrapy transportu, a pułapka sieci kończy się zerem. Kody TOTP liczy test z
sekretu zwróconego przy zapisie (`totp(base32Decode(secret), …)`, jak `tests/pg-mfa.test.js`); adres klienta podaje nagłówek
`x-rd-client-ip` (w produkcji ustawia go serwer Node), a scenariusze limitów mają osobne adresy. Osobny test sprawdza w
specyfikacji, że **schematy odpowiedzi nie mają pól tajnych** (hasło, hash, token, sekret, kod, cookie, IP, User-Agent) poza
jednorazowym sekretem TOTP i URI `otpauth://` przy zapisie MFA oraz kodami odzyskiwania przy potwierdzeniu, że pola z
hasłem, tokenem i kodem w żądaniach mają `writeOnly: true`, że trasy bez sesji mają puste `security`, a żaden zapis nie
używa `Idempotency-Key`. Każdy scenariusz sprawdza też, że żadna prawdziwa odpowiedź nie zawiera użytego hasła ani tokenu
(sekret TOTP i kody odzyskiwania — tylko w odpowiedziach zapisu i potwierdzenia). Scenariusz:

- **logowanie**: sukces (sesja bez MFA w cookie `HttpOnly`, bez identyfikatora konta i ról w treści; adres wielkimi
  literami ze spacjami), **nieznany adres, złe hasło, konto wyłączone, konto bez hasła i adres w złym formacie dają
  identyczną odpowiedź** (status, treść i nagłówki — bez wyroczni istnienia konta); **limit prób**: para (adres, IP) —
  piąty błąd `429 too_many_attempts` z `Retry-After`, ta sama sekwencja dla nieistniejącego konta, w czasie blokady
  poprawne hasło z tego IP też `429`, z innego IP `200`; 20 błędów z jednego IP → `429`; **pełna kolejka scrypt** →
  `503 login_busy` z `Retry-After: 5` bez liczenia próby; logowanie działa w oknie serwisowym (`read_only`);
- **stan sesji i zmiana hasła**: `GET /api/auth/state` (bez sesji `401`, `hasPassword`, stan MFA sesji po samym haśle);
  zmiana: `invalid_current_password`, polityka (`password_too_short`, `password_too_long`, `password_common`,
  `password_contains_email`), `password_unchanged`, sukces z rotacją (stare cookie i inne sesje → `401`), podwójne
  kliknięcie, limit błędnych obecnych haseł (`429`); **bramka MFA routera**: zarząd bez czynnika `403
  mfa_enrollment_required`, konto z czynnikiem po samym haśle `403 mfa_required`, po potwierdzeniu MFA `200`;
- **zaproszenia**: podgląd (zamaskowany adres, rola, klasa, rok, bez sesji, **token nie jest zużyty**), przyjęcie:
  `password_mismatch` (także bez powtórzenia), polityka haseł, `invalid_display_name`, sukces `201` z cookie; **ponowne
  użycie tokenu i podgląd po przyjęciu → `400 invalid_invitation`** (ten sam kod co token nieznany — kodu `already_used`
  nie ma), wygasłe zaproszenie, istniejące konto (`accountExists: true`, złe obecne hasło `401 invalid_credentials`,
  dobre → `201`, `created: false`), dyrekcja bez roku `422 school_year_required` (zaproszenie niezużyte), limit IP
  błędnych tokenów (`429` także dla ważnego tokenu);
- **reset hasła tokenem**: polityka nowego hasła bez zużycia tokenu, token zastąpiony nowszym, nieznany i w złym formacie
  → `400 invalid_token`; sukces `{ ok: true }` bez cookie, wszystkie sesje konta wycofane, **token użyty** i **token
  wygasły** → `invalid_token`, stare hasło `401`, nowe `200`; pełna kolejka scrypt `503 login_busy` bez zużycia tokenu;
  limit IP (`429`);
- **MFA**: bez sesji `401` na każdej trasie; `409 mfa_enrollment_not_found` i `409 mfa_not_enrolled` przed zapisem; brak
  klucza `503 mfa_unavailable`; zapis (ponowny zastępuje oczekujący sekret), potwierdzenie (stary sekret → `invalid_code`;
  10 kodów odzyskiwania, rotacja sesji); **ten sam kod TOTP co przy potwierdzeniu odrzucony w nowej sesji**, następny
  przyjęty i znów odrzucony w kolejnej sesji; kod odzyskiwania małymi literami bez myślników przyjęty, **ponownie
  odrzucony**; piąty błąd w sesji `429 mfa_locked` z `Retry-After` (w czasie blokady poprawny kod i kod odzyskiwania też
  `429`); zapis czynnika z sesji po samym haśle `403 mfa_required`, z MFA sprzed ponad 15 min `403 mfa_stale`; **wymiana
  czynnika**: potwierdzenie z sesji po samym haśle `403 mfa_required`, świeżą sesją `200`, stare kody odzyskiwania
  unieważnione; rotacja klucza: czynnik zaszyfrowany kluczem spoza pierścienia `503 mfa_key_missing`, kod odzyskiwania
  działa bez klucza;
- **sesje własne**: lista tylko własnych sesji (bez IP i User-Agent), cofnięcie innej własnej sesji (cookie żądania bez
  zmian), **cudza, nieistniejąca i już cofnięta sesja → identyczne `404 not_found`**, cofnięcie bieżącej czyści cookie
  (ponowienie `401`), `revoke-all` — `scope: all` dla konta bez czynnika i `current` dla sesji po samym haśle konta z
  czynnikiem (#189);
- błędy wspólne każdego zapisu z ciałem: obcy i brakujący `Origin` (`403 invalid_origin`), `415`, `413`, niepoprawny JSON
  (także `[]`, `null` i puste ciało) i pominięcie każdego wymaganego pola → `400 invalid_json`; hasło ponad 1024 bajty →
  `password_too_long`; każda odpowiedź sukcesu ze schematów obu modułów zwalidowana na prawdziwej odpowiedzi.

`409 conflict` przyjęcia zaproszenia i zmiany hasła (zmiana stanu konta między sprawdzeniem hasła a zapisem) jest w
schemacie, ale nie w tym teście — PGlite wykonuje transakcje po kolei, więc tego przeplotu nie da się odtworzyć bez
prawdziwego PostgreSQL.

Prawdziwe odpowiedzi etapu 12 (moduł `admin`, 46 operacji) sprawdza `tests/openapi-contract-admin.test.js` (ten sam
`createContractClient`, PGlite, dane syntetyczne `@example.invalid`, imiona syntetyczne). Moduł niczego nie wysyła (tokeny
zaproszeń i resetu wracają tylko w odpowiedzi), pułapka sieci kończy się zerem. Osobny test sprawdza w specyfikacji, że klucz
idempotencji mają tylko zapis promocji, zapis partii (wymagany) i rejestracja żądania osoby (opcjonalny), nagłówek
`Idempotency-Replayed` — tylko rejestracja żądania osoby (`201` z `false` i `required: false`, `200` z `true`), odrzucenie
wniosku ma `requestBody.required: false`, schematy list, wniosków, kont, przydziałów i odtworzenia partii nie mają pola
`token`, `mfa_stale` ma dokładnie 12 operacji kroku w górę MFA, a próbki odmów obejmują każdą operację modułu. Scenariusz:

- **granice ról na każdej z 46 operacji**: brak sesji `401`; zarząd, skarbnik, przedstawiciel klasy, Komisja Rewizyjna i
  dyrekcja `403 forbidden`; admin bez czynnika `403 mfa_enrollment_required`, z czynnikiem po samym haśle `403 mfa_required`;
  obcy `Origin` na każdym zapisie `403 invalid_origin`; odmowy niczego nie zapisują;
- **konta**: lista z kursorem (strony po 4 = jedna strona, `invalid_limit`, `invalid_cursor`), wyłączenie z wycofaniem sesji,
  włączenie, ponowienia `changed: false`, `cannot_disable_self`, `user_not_found`, `invalid_id`; wylogowanie; reset hasła
  (token raz, nowy unieważnia poprzedni; konto chronione `202` z wnioskiem, ponowienie ten sam wniosek; `invalid_ttl`,
  `user_disabled`, `mfa_stale`, `400 invalid_json`, `415`, `413`); reset MFA (konto bez roli chronionej od razu, ponowienie
  `changed: false`; chronione `202`; `confirmation_required`, `cannot_reset_own_mfa`, `user_disabled`);
- **wnioski o reset (cztery oczy)**: lista z kursorem związanym ze statusem, wnioskodawca nie zatwierdza
  (`recovery_four_eyes_required`), `mfa_stale`, zatwierdzenie przez drugiego administratora (token resetu; wynik resetu MFA),
  podwójne kliknięcie `recovery_request_closed`, odrzucenie (także wycofanie przez wnioskodawcę);
- **przydziały z audytem**: przedstawiciel z klasą (rok z klasy), podwójne kliknięcie `200` bez nowego przydziału, **zakaz
  samonadania** (`409 cannot_grant_self` także dla roli niechronionej), **dyrekcja bez roku `422 school_year_required`** i z
  rokiem `201`, `class_scope_not_supported`, `class_required`, `class_not_found`, `class_not_in_school_year`,
  `school_year_not_found`, `invalid_expires_at`, `user_not_found`, `user_disabled`, `invalid_role`, `invalid_user_id`,
  `invalid_class_id`; zdarzenia `role_grant.created`/`role_grant.revoked` z aktorem i obiektem w dzienniku; cofnięcie z
  ponowieniem, `last_admin_grant`, `grant_not_found`; lista z kursorem związanym z filtrem i jej błędy;
- **wniosek o rolę chronioną zatwierdzany przez drugą osobę**: przydział zarządu (`202`, wnioskodawca i adresat nie
  zatwierdzają — `grant_four_eyes_required`, `mfa_stale`, zatwierdzenie `granted_by` = zatwierdzający, drugie
  `grant_request_closed`), zaproszenie do zarządu z tokenem dla zatwierdzającego, **ponowne wydanie** takiego zaproszenia
  (`202` z `replacesInvitationId`, po zatwierdzeniu nowy token), odrzucenie z powodem, bramka danych osobowych (`422
  personal_data_forbidden`, `possible_personal_data`), `invalid_reason`, odrzucenie bez treści; lista bez tokenów;
- **zaproszenia**: utworzenie (adres znormalizowany, token raz), `invitation_pending`, dyrekcja z rokiem, `cannot_grant_self`
  (własny adres), `school_year_required`, `invalid_email`, `invalid_ttl`, `invalid_role`, klasy; **ponowne wydanie**
  (`replacesInvitationId`, stare → `invitation_not_pending`, dawne zaproszenie dyrekcji bez roku → `422
  school_year_required`); wycofanie z ponowieniem, przyjęte zaproszenie `invitation_already_accepted`; lista bez tokenów z
  kursorem;
- **partie zaproszeń**: podgląd (numery linii, kody wierszy: `invalid_row_format`, `invalid_email`, `class_not_found`,
  `duplicate_row`, `cannot_grant_self`, `representative_already_assigned`, `invitation_pending`), zapis z kluczem (token na
  wiersz), **ponowienie tym samym kluczem** (`200`, te same zaproszenia bez tokenów), `idempotency_key_reused`,
  `invitation_batch_stale`, `invitation_batch_invalid`, `invitation_batch_empty`, `too_many_rows`, brak klucza;
- **lata, klasy i promocja**: nowy rok i klasy (`school_year_exists`, `class_exists`, `duplicate_name`, daty), kopiowanie
  klas (`201`, ponowienie `200`), promocja uczniów z kluczem (ponowienie `replayed: true` bez nowych przypisań,
  `idempotency_key_reused`, `plan_stale`, `nothing_to_promote`) i błędy mapy klas; **przedłużenie przydziałów
  przedstawicieli** (`201`, powtórzenie `200` `created: 0`, `confirmation_required`, `plan_stale`, `nothing_to_extend`,
  `mfa_stale`) i obsada klas;
- **żądania osób**: rejestracja z kluczem (`Idempotency-Replayed: false`), ponowienie (`200`, `true`), `idempotency_conflict`,
  bez klucza bez nagłówka, błędy podmiotu i dat; przejścia stanu tylko do przodu; **eksport JSON i CSV** po weryfikacji
  tożsamości (skrót w nagłówku, ten sam skrót przy powtórzeniu; `data_request_identity_not_verified`,
  `data_request_kind_not_exportable`, `data_request_closed`, `invalid_format`, `mfa_stale`); ograniczenie przetwarzania i
  jego zdjęcie jako nowe zapisy z historią (`data_request_kind_not_restrictable`, `data_request_subject_not_restrictable`,
  `data_request_closed`); rejestr z kursorem związanym z filtrem;
- **anonimizacja**: podgląd bez danych osobowych, wykonanie `201`, ponowienie `200 replayed`, lista przebiegów; błędy żądania
  (`kind_not_erasable`, `identity_not_verified`, `subject_mismatch`, `closed`), `retention_policy_missing`,
  `anonymization_plan_changed`, `confirmation_required` i formaty pól;
- **dziennik odczytu z kursorem**: odczyt karty przez przedstawiciela (także `not_found`) i eksport, strony po 1 = jedna
  strona, filtry i ich błędy, bez imion i adresów; **przegląd dostępu**: rok zakończony (`school_year_ended`), dyrekcja bez
  roku w przeglądzie każdego roku (`year_scope_required`), przegląd niczego nie odbiera; wygaszenie kadencji z ponowieniem
  i `school_year_not_finished`; **dziennik zdarzeń** z kursorem związanym z filtrem, `denialCount` przy `access.denied`,
  ślady `audit.viewed`, `access_log.viewed`, `access_review.viewed`; raport retencji i stan operacyjny bez adresów;
- pominięcie każdego wymaganego pola ciała → `400` (pusta mapa klas → `422 class_map_required`) i każda odpowiedź sukcesu ze
  schematu (oba formaty eksportu) zwalidowana na prawdziwej odpowiedzi.

Prawdziwe odpowiedzi etapu 13 (moduły `audit-history`, `audit-reviews`, `financial-reports`, `exports`, `print`, `board`,
`representative` — 22 operacje) sprawdza `tests/openapi-contract-reports.test.js` (ten sam `createContractClient`, PGlite,
dane syntetyczne `@example.invalid`, imiona syntetyczne). Kampania e-mail powstaje tylko jako szkic (obiekt historii), nic
nie trafia do kolejki; pułapka sieci kończy się zerem. Osobny test sprawdza w specyfikacji, że `Idempotency-Key` mają tylko
zapisy ścieżki KR, żadna operacja etapu nie ma nagłówka `Idempotency-Replayed`, ciało opcjonalne mają zamknięcie wątku KR i
zatwierdzenie migawki, `mfa_stale` — eksport roczny i zatwierdzenie migawki, typy treści plików (lista klasy JSON/CSV/XLSX,
sprawozdanie i migawka JSON/HTML, eksport zarządu CSV/XLSX, kartki wyłącznie JSON), kartki nie mają pól opiekunów, a próbki
odmów obejmują każdą operację. Scenariusz:

- **granice ról na każdej z 22 operacji**: brak sesji `401`; `403 forbidden` dla ról bez dostępu (admin, zarząd, skarbnik,
  Komisja Rewizyjna, dyrekcja, przedstawiciel, przydział zarządu do klasy, konto bez przydziału — zależnie od trasy;
  przedstawiciel 1B na kartkach i liście klasy 1A); bramka routera `mfa_enrollment_required` i `mfa_required`; obcy `Origin`
  na każdym zapisie `invalid_origin`; odmowy niczego nie zapisują (uwagi KR, przebiegi eksportu);
- **historia obiektu**: wpłata, wpis księgi, uzgodnienie i kampania (zarząd i skarbnik), bez adresów e-mail, rok bez
  przydziału i obiekt nieistniejący — to samo `404 not_found`, zły identyfikator `400`, ślad `audit.viewed` przy każdym odczycie;
- **ścieżka kontroli KR**: pytanie, ustalenie i pytanie o rok; ponowienie tym samym kluczem (`200`, `replayed: true`, bez
  nagłówka), `idempotency_conflict`; odpowiedź skarbnika z ponowieniem, **cztery oczy** (osoba w KR i jako skarbnik nie
  odpowiada na własne pytanie), zamknięcie bez treści z ponowieniem, drugie zamknięcie i odpowiedź po zamknięciu
  `audit_review_closed`, wniosek końcowy z ponowieniem (obowiązuje najnowszy); cel z innego roku i nieistniejący
  `audit_review_target_not_found`, `invalid_request`, `invalid_audit_review_body`, `422 personal_data_forbidden`, brak
  klucza, `invalid_json`, `415`, `413`, `invalid_school_year_id`, `school_year_not_found`, MFA (`mfa_enrollment_required`),
  rok spoza przydziału; lista z licznikami dla KR, zarządu i skarbnika;
- **sprawozdanie i przepływy**: zarząd, skarbnik i dyrekcja (JSON, HTML z CSP), bez opisów wpisów; brak roku, rok
  nieistniejący, rok spoza przydziału, dyrekcja bez MFA, zły `format`/`granularity`;
- **migawki**: utworzenie i ponowienie tej samej treści, zatwierdzenie (`mfa_stale`, `201`, ponowienie `200`), korekta po
  zmianie księgi (`report_snapshot_supersedes_required`, `invalid_reason`, `422`), autor nie zatwierdza
  (`four_eyes_required`), zastąpiona migawka (`report_snapshot_superseded` przy korekcie i zatwierdzeniu), lista z łańcuchem
  korekt, odczyt JSON (bez `generatedAt`) i HTML ze skrótem, migawka innego roku `403`, nieistniejąca `404`, błędy ciała;
- **kartki**: brak opublikowanej informacji `409 privacy_notice_missing`; zakres szeroki z kwotami, danymi do wpłaty i
  komunikacją strukturalną, rodzeństwo z innej klasy przy `classId`, rodzina z ograniczeniem przetwarzania pominięta
  (`skippedRestricted` liczony w zakresie klasy), przedstawiciel bez kwot i tylko własna klasa (`class_required`, cudza klasa i
  inny rok `403`), klasa innego roku `404 class_not_found`, rok nieistniejący, bez adresów opiekunów;
- **lista klasy i eksport roczny**: JSON (skrót w nagłówku, e-mail tylko przy zgodzie, bez identyfikatorów rodzin), CSV,
  XLSX; zarząd, admin, zarząd z przydziałem klasy; cudza klasa, klasa roku bez przydziału, przedstawiciel bez MFA
  (`mfa_enrollment_required`) i z czynnikiem po haśle (`mfa_required`), `class_not_found`, `invalid_class`, `invalid_format`;
  eksport roczny (manifest = pliki paczki, skrót w nagłówku), `mfa_stale`, rok spoza przydziału, `school_year_not_found`,
  `invalid_school_year`, `invalid_json`, `415`, `413`; liczba przebiegów w `export_runs`;
- **pulpity**: zarząd (zakres szkoły, odsetek `null` poniżej 5 gospodarstw, wpłaty nieprzypisane), zarząd z przydziałem klasy
  (tylko klasa, bez kolumny wpłat — także w CSV), admin; brak roku, rok poza przydziałem i nieistniejący `404`; XLSX;
  przedstawiciel — tylko przypisana klasa z datą ostatniego wydruku i najbliższym zebraniem, przydział innego roku `[]`;
- **zamknięty rok** (osobne bazy, zamknięcie trasami listy kontrolnej): zapisy KR i zatwierdzenie migawki `409
  school_year_closed`, odczyt zostaje, migawka o tej samej treści — ponowienie `200`, pierwsza migawka zamkniętego roku `409`,
  eksport archiwum przez zarząd roku następnego (`year_close.archive_read`);
- pominięcie każdego wymaganego pola ciała → `400` i każda odpowiedź sukcesu ze schematu (wszystkie formaty) zwalidowana na
  prawdziwej odpowiedzi.

Prawdziwe odpowiedzi etapu 14 (moduły `guardian-updates`, `import`, `privacy-notice`, `year-close`, 23 operacje) sprawdza
`tests/openapi-contract-guardian-year.test.js` (ten sam `createContractClient`, PGlite, osobna baza na moduł, dane syntetyczne
`@example.invalid`, imiona syntetyczne). Kod weryfikacyjny wysyła worker z transportem-atrapą wyłącznie na nowy adres z wniosku;
pułapka sieci kończy się zerem. Osobny test sprawdza w specyfikacji, że klucz idempotencji ma tylko zapis importu (wymagany),
nagłówek `Idempotency-Replayed` (`true`, `required: false`) — tylko zatwierdzenie szablonu i zatwierdzenie/publikacja wersji
informacji, ciało opcjonalne — tylko punkt listy kontrolnej i zamknięcie roku, cztery trasy publiczne nie mają `401`, token linku
jest tylko w odpowiedzi wydania, publiczna informacja nie ma identyfikatorów kont, `mfa_stale` mają zatwierdzenie szablonu i
zamknięcie roku, a próbki odmów obejmują każdą operację. Scenariusz:

- **granice ról na każdej z 19 operacji z sesją**: brak sesji `401`; skarbnik, przedstawiciel, Komisja Rewizyjna, dyrekcja i zarząd
  zawężony do klasy `403 forbidden` (zamknięcie roku: także admin techniczny; rozpoczęcie i zamknięcie: także skarbnik; zatwierdzenie
  szablonu: także admin); admin bez czynnika `403 mfa_enrollment_required`, z czynnikiem po samym haśle `403 mfa_required`; obcy
  `Origin` `403 invalid_origin`; odmowy niczego nie zapisują;
- **guardian-updates**: szablon (szkic, autor nie zatwierdza `self_approval_forbidden`, `mfa_stale`, `verify_template_changed`,
  zatwierdzenie i ponowienie z `Idempotency-Replayed: true`, `verify_template_not_draft`, błędy treści i kursor wersji); link (token
  raz, w bazie skrót; `guardian_not_found`, `invalid_request`, `400`/`413`/`415`); publiczny podgląd (imię i klasy rodzeństwa) i
  formularz (`requested`, podwójne wysłanie `409 link_used`, zużyty link `404`); **dwoje opiekunów rodzeństwa**: błędy formularza
  drugiego opiekuna nie zużywają linku (`invalid_email`, `invalid_request`, bramka danych osobowych `422`), kod innego wniosku nie
  pasuje; potwierdzenie kodu (zły kod, ponowienie); kolejka z kursorem związanym ze statusem; zatwierdzenie (`changed: true`,
  `verification: confirmed`), ponowienie i odrzucenie rozstrzygniętego wniosku `changed: false`; **zmiana wyłącznie u opiekuna z
  zatwierdzonego wniosku** (drugi opiekun i inna rodzina bez zmian); jedno zdarzenie zatwierdzenia;
- **import i privacy-notice**: opcje (zarząd widzi tylko rok przydziału), zarząd poza rokiem `403`, `APP_ENV=production` bez
  `IMPORT_ENABLED` `403 import_disabled`; podgląd rodzeństwa z dwojgiem opiekunów bez imion i adresów; zapis bez opublikowanej
  informacji `409 privacy_notice_missing`; wersje informacji (autor nie zatwierdza, publikacja bez zatwierdzenia `409`, ponowienia
  z nagłówkiem, zastąpienie poprzedniej, publiczna wersja z `Cache-Control`, błędy pól, `invalid_reference`, `invalid_id`,
  `404`); zapis `201`, **podwójne kliknięcie i te same dane z nowym kluczem** `200 replayed: true` bez duplikatów; konflikty `422
  import_has_conflicts` i jawne `skipConflicts`, `idempotency_key_reused`, `fingerprint_mismatch`, `preview_stale`; błędy treści
  `400` (każde pole formatu), `413 too_many_rows`, `413 request_too_large`, `415 unsupported_media_type`, `422 unknown_school_year`,
  `422 no_classes_in_school_year`, brak klucza i podglądu;
- **year-close**: stan otwartego roku z bilansem, kontrolą końca roku i ostrzeżeniami (liczby i kwoty), przekazanie przed
  zamknięciem; `invalid_school_year_id`, `school_year_not_found` na każdej trasie; przed rozpoczęciem `year_close_not_started`;
  rozpoczęcie (`next_school_year_not_found`, rok wcześniejszy `409 invalid_next_school_year`, `201`, ponowienie `200`,
  `year_close_already_started`); lista kontrolna (`invalid_checklist_item`, `invalid_note`, `invalid_document_id`,
  `invalid_report_snapshot`, bramka danych osobowych, ponowienie nie nadpisuje uwagi, żądanie bez treści); zamknięcie
  (`checklist_incomplete` z brakującymi punktami, **cztery oczy** `four_eyes_required`, `mfa_stale`,
  `invalid_year_end_confirmation`, `200`); ponowienie przez osobę z wygasłym przydziałem `409 school_year_closed`, przez zarząd bez
  roku `200 replayed: true`, jedno zdarzenie; po zamknięciu rozpoczęcie i punkt listy `409 school_year_closed`; przekazanie dla
  zarządu i Rady roku następnego (#195); `next_year_opening_balance_exists` (osobna para lat); **import do zamkniętego roku `409
  school_year_closed`** z wycofaniem całej transakcji;
- pominięcie każdego wymaganego pola ciała → `400` (brak tokenu w formularzu → `404 invalid_or_expired_link`) i każda odpowiedź
  sukcesu ze schematu zwalidowana na prawdziwej odpowiedzi.

Schematy odpowiedzi są ścisłe: nowe pole w odpowiedzi trasy psuje test, dopóki schemat nie zostanie świadomie
zmieniony. Dodając kolejny moduł: plik schematów, wpis w `SCHEMA_MODULES`, usunięcie z `UNCOVERED_MODULES`,
`npm run openapi:build` i scenariusz w teście kontraktu (kolejne moduły rozszerzają
`tests/openapi-contract.test.js` albo dodają osobny plik z `createContractClient`, jak
`tests/openapi-contract-families.test.js`, `tests/openapi-contract-ledger-extra.test.js`,
`tests/openapi-contract-reconciliation.test.js`, `tests/openapi-contract-email.test.js`,
`tests/openapi-contract-meetings.test.js`, `tests/openapi-contract-documents.test.js`,
`tests/openapi-contract-events.test.js`, `tests/openapi-contract-news.test.js`, `tests/openapi-contract-auth.test.js`,
`tests/openapi-contract-admin.test.js`, `tests/openapi-contract-reports.test.js` i `tests/openapi-contract-guardian-year.test.js`).

## Szablon bazy PGlite i czas testów (#111)

`createPgliteTestDb()` (`tests/helpers/pg.js`; `createTestDb()` wywołuje je, gdy backend to PGlite) wykonywało dawniej
wszystkie pliki z `postgres/migrations` przy każdej bazie (~4,5 s). Teraz migracje idą RAZ NA PROCES testowy:
pierwsza baza jest migrowana, jej katalog danych zrzucany przez `dumpDataDir('none')` PRZED oddaniem bazy testowi
(zrzut jest więc czysty, mimo że test zaraz zmienia tę bazę), a każda następna baza to nowa instancja z
`new PGlite({ loadDataDir })` tego zrzutu (~0,6 s). Równoległe pierwsze wywołania czekają na ten sam zrzut,
a nieudana budowa nie zatruwa kolejnych. Zrzut (~67 MB) żyje w pamięci procesu, więc szablon nie przekracza granic
procesów: `node --test` uruchamia każdy plik osobno i każdy płaci za migracje raz (plik z jedną bazą płaci tylko za zrzut,
~0,3 s). Izolację i równoważność z bazą zmigrowaną od zera pilnuje `tests/pg-template-isolation.test.js`
(ten sam schemat, wyzwalacze, funkcje, indeksy i rola `rd_app`; zapis w jednej bazie niewidoczny w drugiej ani w
następnym klonie; wyzwalacz niezmienności działa w klonie).

Instancja z `loadDataDir` trzyma w Node timer do `close()`, więc plik testowy, który nie zamyka baz, nie kończyłby procesu
(wiele testów nie woła `db.close()`). `tests/helpers/pg.js` zamyka niezamknięte bazy PGlite w `after()` pliku testowego,
a `close()` jest idempotentne (własne `after(() => shared.close())` w testach działa bez zmian). Dotyczy tylko baz z
`createPgliteTestDb()`/`createTestDb()`; bazy tworzone bezpośrednio przez `new PGlite()` zachowują się jak dotąd.

`RD_TEST_PGLITE_TEMPLATE=off` wraca do migracji od zera przy każdej bazie (pomiar „przed”, diagnostyka; CI tego nie używa).
Testy, które same budowały `new PGlite()` i pętlę migracji (13 plików: `pg-events*`, `pg-event-tasks`, `pg-meetings*`,
`postgres-ledger`, `postgres-payments`, `d1-postgres-migration`), korzystają z `createPgliteTestDb()` bez zmiany treści testów.
Poza szablonem zostają pliki z jedną współdzieloną bazą na plik albo schematem na test (`pg-reconciliation*`,
`pg-annual-report`, `pg-payment-allocations*`, `pg-report-snapshots`, `pg-bank-statement-import`,
`pg-ledger-cost-centers`, `health-ready`, `jobs-health` — ten ostatni celowo nie importuje `helpers/pg.js`) oraz
testy z częściowym zestawem migracji albo migrujące od zera z założenia (`postgres-migrations-manifest`, `postgres-core`,
`pg-year-close-class-grants`, `pg-schema-consistency-0143`).
`createPgliteTestDb` zostaje osobną funkcją (używa jej `tests/pg-real-type-parity.test.js` do porównania backendów).

Pomiar lokalny (kontener: 4 rdzenie, 16 GB, Node 22, PGlite 0.5.8; `node --test <plik>` po kolei, ten sam kod, różni się
tylko `RD_TEST_PGLITE_TEMPLATE`; GitHub runner ma 2 rdzenie i 7 GB, więc czasy bezwzględne tam będą inne):

| Zestaw | Szablon wyłączony | Szablon włączony |
|---|---|---|
| 17 reprezentatywnych `tests/pg-*.test.js` (`pg-auth`, `pg-access-denied`, `pg-import`, `pg-documents`, `pg-email`, `pg-authz-matrix`, …), razem | 1323 s | 700 s (−47%) |
| `pg-auth` (25 baz) | 58,9 s | 18,2 s |
| `pg-import` (33 bazy) | 79,2 s | 23,6 s |
| `pg-documents` | 181,7 s | 43,1 s |
| 13 przekonwertowanych plików, razem | 314 s | 112 s (−64%) |
| największy proces testowy (RSS) w 17 plikach | 1816 MB | 1710 MB |
| shard 1/6 (`--test-concurrency=2`, jak w CI) | 333 s | 161 s (−52%) |
| szczytowy RSS jednego procesu w shardzie | 5935 MB (`pg-promotions`) | 5589 MB (`pg-promotions`) |

Shard 1/6 to 55 plików, 723 testów (711 zielonych, 12 pominiętych, m.in. testy na prawdziwym
PostgreSQL bez `RD_TEST_PG_URL`), w obu wariantach te same liczby. Szczytowy RSS procesu dla `tests/pg-promotions.test.js` (5,6 GB; baza na każdy test, nigdy niezamykana,
po ok. 270 MB) i `tests/pg-anonymization-reapply.test.js` (4,0 GB; baza źródłowa i 15 docelowych zamykanych dopiero w
`after()`) to ryzyko pamięci, niezależne od szablonu (bez niego: 5,9 i 4,4 GB): na runnerze GitHub z 7 GB dwa takie procesy
naraz (`--test-concurrency=2`) dają górne oszacowanie ponad 9 GB. Oba pliki zamykają już bazę po każdym teście (niżej,
„Podział na shardy według czasu”: 1124 i 1239 MiB).

`pg-authz-matrix` (330 testów, ~6,5 min) praktycznie się nie zmienia: dominuje w nim praca testów, nie migracje
(od podziału na trzy pliki — niżej — ok. 2 min na część).
Czas przebiegów PR na GitHub (kryterium „co najmniej o połowę krótszy, zmierzone na 3 kolejnych przebiegach”) po #722 i
#726: 3:31–3:50 min zamiast 7:54–8:39 min; tabela w `docs/RAILWAY_OPERATIONS.md`, „Wynik #111”.

## Podział na shardy według czasu (#111)

Job `test` w CI ma 6 shardów. `node --test --test-shard=i/N` przydzielał pliki według pozycji na posortowanej liście
(indeks modulo N), a nie według czasu: shard 6/6 dostał `pg-authz-matrix` (ok. 400 s w jednym procesie) i inne dłuższe
pliki, więc na GitHub trwał 467 s wobec 152–218 s pozostałych (przebieg po #717). Zmiany:

- **Podział według wag.** `node scripts/ci-shard-files.js i N` wypisuje pliki shardu i/N. Wagi to zmierzone sekundy
  każdego pliku w `scripts/ci-shard-weights.json` (liczą się proporcje). Metoda zachłanna: pliki od najcięższego, każdy do
  shardu, którego szacowany czas po dołożeniu pliku jest najmniejszy; szacunek symuluje `--test-concurrency=2` (node
  sortuje pliki alfabetycznie, każdy startuje w pierwszym wolnym z dwóch slotów). Plik spoza wag (np. nowy test) dostaje
  `defaultWeight` (mediana plików `tests/pg-*`, dziś 8 s) i nadal trafia do dokładnie jednego shardu. Podgląd planu:
  `node scripts/ci-shard-files.js --plan 6`. W `ci.yml` lista trafia najpierw do zmiennej (`files=$(…)`, krok przerywa
  błąd skryptu) i `test -n "$files"` pilnuje, że shard nie jest pusty: `node --test` bez plików uruchomiłby domyślny wzorzec,
  czyli cały katalog. Krok z `RD_TEST_RSS_LOG` i `scripts/summarize-test-memory.js` jest bez zmian.
- **Strażnik.** `tests/ci-shard-coverage.test.js` sprawdza, że każdy plik `tests/*.test.js` jest w dokładnie jednym
  shardzie (także z dodatkowym plikiem spoza wag), że wynik nie zależy od kolejności wejścia, że CLI dla i = 1..6 daje
  rozłączne listy o sumie równej katalogowi i odrzuca zły numer shardu, że `ci.yml` bierze listę ze skryptu z N równym
  macierzy (bez `--test-shard`) i zachowuje pomiar pamięci, oraz że najdłuższy szacowany shard mieści się w 125% dolnej
  granicy (najcięższy plik albo suma wag / 2N).
- **Macierz uprawnień w trzech plikach.** Fixture, wykonanie przypadku i rejestracja testów tras są w
  `tests/helpers/authz-matrix.js`; `tests/pg-authz-matrix.test.js` uruchamia część 1, testy uzupełniające i meta-testy,
  `pg-authz-matrix-2.test.js` i `pg-authz-matrix-3.test.js` — części 2 i 3. Części to ciągłe fragmenty macierzy z granicą na
  początku modułu (`MATRIX_PART_STARTS`: `ledger`, `audit-reviews`): trasy jednego modułu korzystają ze stanu poprzednich
  (np. `yearClose.close` wymaga pozycji listy kontrolnej, `lift-restriction` — ograniczenia z `restrict`), co pierwsza próba
  z podziałem „co trzecia trasa” pokazała dwoma czerwonymi testami. Meta-test sprawdza, że sklejenie części daje całą macierz
  w tej samej kolejności i że żaden moduł ani grupa z własną bazą nie są rozcięte. Asercje i przypadki bez zmian
  (110 + 147 + 74 testy = 330 dawnych i jeden nowy meta-test). `ALLOWED_TODO` nadal obejmuje wszystkie trasy; test `todo`
  rejestruje teraz helper, którego `tests/test-quality-lint.test.js` nie przegląda (lint obejmuje `tests/*.test.js`).
- **Baza zamykana po teście.** `perTestDb()` z `tests/helpers/pg.js` (wołane raz na poziomie modułu) tworzy bazy zamykane w
  `afterEach`, dla plików, w których każdy test zakłada własną bazę: `pg-promotions`, `pg-audit-history`,
  `pg-audit-history-board`, `pg-invitation-batch`, `pg-enrollment-end`, `pg-data-subject-requests`. W
  `pg-anonymization-reapply` bazy docelowe zamyka `afterEach` w `describe` (baza źródłowa zostaje do `after()`). Zamknięta
  baza wypada też ze zbioru śledzonego przez helper; wcześniej zbiór trzymał referencję do instancji (z pamięcią WASM) do
  końca pliku, więc samo `close()` w teście niczego nie zwalniało.

Pomiar lokalny (kontener: 4 rdzenie, 16 GB, Node 22; shard uruchamiany pojedynczo, jak w CI `--test-concurrency=2` z
`RD_TEST_RSS_LOG`; „przed” to kod z `main` po #717, w kopii bez katalogu `.github`, przez co jeden statyczny test w 6/6 był
czerwony):

| Shard | Czas | Pliki | Testy (zielone / pominięte) | Największy proces (RSS) | Dwa największe naraz |
|---|---|---|---|---|---|
| 6/6 przed (`--test-shard`) | 443,5 s | 54 | 867 (838 / 28) | 3275 MiB `pg-audit-history` | 4963 MiB |
| 1/6 po | 185,1 s | 53 | 591 (567 / 24) | 1005 MiB `pg-payment-references` | 1991 MiB |
| 2/6 po | 174,1 s | 58 | 627 (616 / 11) | 1671 MiB `pg-reconciliation` | 3011 MiB |
| 3/6 po | 181,2 s | 59 | 757 (743 / 14) | 1130 MiB `pg-class-coverage` | 2196 MiB |
| 4/6 po | 183,7 s | 53 | 560 (538 / 22) | 1297 MiB `pg-authz-matrix-3` | 2526 MiB |
| 5/6 po | 183,1 s | 53 | 646 (619 / 27) | 1469 MiB `pg-export-stream-file` | 2679 MiB |
| 6/6 po | 175,0 s | 54 | 655 (599 / 56) | 1138 MiB `audit-write-coverage` | 2255 MiB |

Najdłuższy shard: 443,5 s → 185,1 s (−58%); szacunek z wag dla każdego shardu to 196 s. Po zmianie wszystkie 330 plików
w sześciu shardach: 3836 testów, 0 czerwonych, 154 pominięte (testy na prawdziwym PostgreSQL bez `RD_TEST_PG_URL`).
Pojedyncze pliki (szczytowy RSS procesu, czas `node --test <plik>` po dwa naraz):

| Plik | RSS przed | RSS po | Czas przed | Czas po |
|---|---|---|---|---|
| `pg-promotions` | 5572 MiB | 1124 MiB | 19,9 s | 17,0 s |
| `pg-anonymization-reapply` | 4079 MiB | 1239 MiB | 23,8 s | 23,8 s |
| `pg-audit-history` | 3297 MiB | 939 MiB | 11,1 s | 12,2 s |
| `pg-audit-history-board` | 2056 MiB | 926 MiB | 7,3 s | 9,4 s |
| `pg-invitation-batch` | 2057 MiB | 890 MiB | 7,6 s | 7,7 s |
| `pg-enrollment-end` | 1660 MiB | 940 MiB | 6,3 s | 6,1 s |
| `pg-data-subject-requests` | 1563 MiB | 974 MiB | 6,1 s | 6,1 s |
| `pg-authz-matrix` (przed: jeden plik; po: części 1 / 2 / 3) | 1691 MiB | 833 / 1063 / 1258 MiB | 398,6 s | 124,7 / 115,4 / 93,4 s |

GitHub runner ma 2 rdzenie i 7 GB, więc czasy tam będą inne; wynik z trzech przebiegów wpisać w
`docs/RAILWAY_OPERATIONS.md`, „Pomiar czasu i pamięci testów w CI”.

**Aktualizacja wag.** Wagi nie muszą być dokładne: nowy plik bez wagi działa (waga domyślna), a nieaktualna waga psuje
tylko równowagę, nie pokrycie. Po dodaniu pliku dłuższego niż ok. 30 s albo gdy podsumowania jobów pokażą shard wyraźnie
dłuższy od innych, zmierz pliki (`node --test --test-concurrency=1 --import ./tests/setup.js <plik>`, po dwa naraz, jak w
CI) i popraw `scripts/ci-shard-weights.json`; plan sprawdź `node scripts/ci-shard-files.js --plan 6`. Plik dłuższy niż
średni shard (dziś ok. 200 s) wyznacza czas swojego shardu niezależnie od wag — taki plik dzielimy jak macierz uprawnień.

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
npm run test:pg-real -- --repeat=20 tests/pg-real-double-click.test.js   # te same pliki 20 razy (#111)
npm run test:pg-real -- --repeat=50 --name='zaproszenia' tests/pg-real-record-locks.test.js
```

`--repeat=N` uruchamia wskazany zestaw plików N razy (każdy plik w osobnym procesie; podsumowanie
liczy niepowodzenia ze wszystkich powtórzeń), a `--name=wzorzec` zawęża przebieg do testów o pasującej
nazwie (`node --test-name-pattern`). Używa ich nocny job `nightly-concurrency`.

Przebieg `--all` z `RD_TEST_PG_APP_ROLE` pomija i wypisuje (`# rola rd_app: pominięte pliki …`) pliki, które
do przygotowania danych potrzebują uprawnień właściciela (`DISABLE TRIGGER`, `session_replication_role = replica`;
lista z uzasadnieniami: `TRIGGER_BYPASS_ALLOWED` w `tests/test-quality-lint.test.js`) albo czytają `pg_stat_activity`
(bezpośrednio lub przez `tests/helpers/pg-barrier.js` / `pg-race.js`; cudze zapytania widzi dopiero rola
`pg_read_all_stats`, której aplikacja nie dostaje). Te pliki biegną w przebiegu właściciela, a reszta zestawu
musi przejść na samej roli `rd_app`. To nie jest „pełny zestaw na `rd_app`” z kryterium #101: pominięte pliki
nie mają dowodu na tej roli.

### Klasyfikacja niezgodności z rolą `rd_app` (#101, SR-05)

Nocny przebieg na `rd_app` (run 37124010123, `main` 5c8c73db) dał 65 testów z błędem w 40 plikach. Każdy błąd to
`42501` (`permission denied for table …`, `permission denied for schema public`, `must be owner of table …`,
`permission denied to set parameter "session_replication_role"`). Klasy:

- **A**: test celowo wykonuje operację właściciela: DDL w danych testowych albo bezpośredni `DELETE`/`TRUNCATE`
  na tabeli z historią, żeby sprawdzić strażnika bazy. Rola aplikacji nie ma tego uprawnienia i odpada na `42501`,
  zanim operacja dojdzie do triggera. To nie jest błąd aplikacji.
- **B**: brak uprawnienia, którego aplikacja albo worker potrzebuje w normalnym działaniu (błąd wdrożenia na
  Railway, wymagałby migracji z `GRANT`). **Nie znaleziono żadnego przypadku.**
- **C**: operacja skryptu operatora, która w produkcji idzie przez `DATABASE_MIGRATION_URL` (rola właściciela),
  a test wykonywał ją połączeniem aplikacji. Dotyczy wyłącznie odtworzenia paczki (`restoreBundle`/`restoreBundleFile`
  ustawiają `session_replication_role`; `scripts/verify-export.js --restore-database` używa `migrationDatabaseUrl()`).

Narzędzia w `tests/helpers/pg.js`:

- `ownerDb(db)`: połączenie właściciela tabel. Na PGlite i w przebiegu właściciela to ta sama baza, a z
  `RD_TEST_PG_APP_ROLE` osobna pula bez `-c role=…`. Służy wyłącznie do operacji z klas A i C.
- `assertOwnerGuard(db, sql, oczekiwany, parametry)`: komunikat triggera (albo naruszenie klucza obcego) sprawdza
  na połączeniu właściciela, a z `RD_TEST_PG_APP_ROLE` sprawdza też, że rola aplikacji dostaje `42501`. Asercja
  strażnika zostaje bez zmian, a przebieg na `rd_app` daje dodatkowy dowód, że aplikacja tej operacji nie wykona.
- `assertAppRoleDenied(db, sql, parametry)`: samo sprawdzenie `42501` na roli aplikacji (bez roli nic nie sprawdza).

`UPDATE` zostaje na połączeniu aplikacji: `rd_app` ma `UPDATE` (migracja 0170), więc te asercje sprawdzają trigger
właśnie tą rolą, której używa aplikacja.

| Plik | Testy z błędem | Klasa | Zmiana |
| --- | --- | --- | --- |
| `d1-postgres-restore-compat` | strażniki po odtworzeniu migawki D1 | A | `DELETE` z `audit_events`, `role_grants`, `events` przez `assertOwnerGuard` |
| `email-provider-pause` | pauza niezmienna, bez `DELETE`/`TRUNCATE` | A | `DELETE` i `TRUNCATE` przez `assertOwnerGuard` (`TRUNCATE` sprawdza teraz `truncate_not_allowed`) |
| `pg-access-denied` | `access_denial_windows` bez usuwania | A | jw. |
| `pg-access-log-review` | dwa testy „gwarancja zapisu” | A | sztuczna awaria dziennika (`CREATE FUNCTION`/`TRIGGER` na `data_access_log`) przez `ownerDb`; żądania nadal rolą aplikacji |
| `pg-account-recovery` | granice ról, cztery oczy w bazie | A | `DELETE` przez `assertOwnerGuard` |
| `pg-anonymization` | bezpośredni `UPDATE`/`DELETE` poza przebiegiem | A | `DELETE`/`TRUNCATE` przez `assertOwnerGuard`; `DELETE` w kontekście przebiegu na `ownerDb` + `assertAppRoleDenied` |
| `pg-anonymization-reapply` | wszystkie 14 testów | C (+A) | odtworzenie paczki w `restoredTarget` przez `ownerDb`. Samo ponowienie anonimizacji biegnie połączeniem aplikacji, tak jak skrypt z `DATABASE_URL`, i przechodzi na `rd_app`. `DELETE` po ponowieniu przez `assertOwnerGuard` |
| `pg-auth` | dziennik tylko do dopisywania, przydziały bez usuwania | A | `DELETE` przez `assertOwnerGuard` |
| `pg-data-access-log` | dziennik odczytu tylko do dopisywania | A | jw. |
| `pg-data-subject-requests` | rejestr żądań tylko do dopisywania | A | jw. |
| `pg-email-followup` | zatwierdzenia rozstrzygnięć niezmienne | A | `DELETE`/`TRUNCATE` przez `assertOwnerGuard` |
| `pg-email-quota` | księga wysyłek bez edycji i usuwania | A | `DELETE` przez `assertOwnerGuard` |
| `pg-enrollment-end` | zakończone przypisanie niezmienne | A | jw. |
| `pg-export-audit-year` | odtworzenie paczki roku poprzedniego | C | `restoreBundle(ownerDb(target), …)` |
| `pg-export-stream-file` | `restoreBundleFile` jak `restoreBundle` | C | odtworzenie (także zmienionego pliku) przez `ownerDb` |
| `pg-export-v2` | odtworzenie v2, paczka bez danych pochodnych, paczka v1 | C | odtworzenie przez `ownerDb`. Na `rd_app` dodatkowo `restoreBundle` na połączeniu aplikacji musi dać `42501` i zostawić pustą bazę |
| `pg-families` | zmiana kontaktu, zmiana klasy, model gospodarstw | A | `DELETE` przez `assertOwnerGuard` |
| `pg-grant-requests` | zatwierdzenie wniosku o rolę | A | jw. |
| `pg-guardian-verify-monitoring` | stan kolejki kodów (baza bez tabeli) | A | `DROP TABLE guardian_update_verifications` (symulacja bazy sprzed 0184) przez `ownerDb`; odczyt stanu rolą aplikacji |
| `pg-identity-changes` | `UPDATE`/`DELETE`/`TRUNCATE` sprostowań | A | `DELETE`/`TRUNCATE` przez `assertOwnerGuard` |
| `pg-immutability-hardening` | sesji nie da się usunąć | A | jw. |
| `pg-immutability-stamps` | `BEFORE TRUNCATE` na tabelach z 0090/0144 | A | `TRUNCATE` przez `assertOwnerGuard` |
| `pg-import` | zdarzenie audytu importu | A | `DELETE` przez `assertOwnerGuard` |
| `pg-ledger-api` | korekty księgi, atomowość audytu | A | `DELETE` przez `assertOwnerGuard`; sztuczna awaria audytu (DDL) przez `ownerDb` |
| `pg-ledger-cash` | przeniesienie gotówki | A | `DELETE` przez `assertOwnerGuard` |
| `pg-login` | token resetu hasła | A | jw. |
| `pg-mfa` | czynniki MFA i kody zapasowe | A | jw. |
| `pg-news` | zdjęcie sprzed 0071, historia publikacji | A | `ALTER TABLE news_photos … CONSTRAINT` przez `ownerDb`, `DELETE` przez `assertOwnerGuard` (wspólna baza przekazuje `owner`/`appRole`) |
| `pg-payment-instructions` | zatwierdzona wersja niezmienna | A | `DELETE` przez `assertOwnerGuard` |
| `pg-payment-references` | referencja niezmienna | A | jw. |
| `pg-payments-api` | korekty wpłat, atomowość audytu | A | `DELETE` przez `assertOwnerGuard`; sztuczna awaria audytu (DDL) przez `ownerDb` |
| `pg-processing-restrictions` | zdjęcie ograniczenia jako nowy zapis | A | `DELETE` przez `assertOwnerGuard` |
| `pg-real-tx-conflict` | dwa testy 40001 | A | tabelę próbną zakłada `ownerDb`; zapisy i konflikt idą połączeniem aplikacji (domyślne uprawnienia z 0170) |
| `pg-real-type-parity` | cztery testy typów | A | jw. (`type_parity_probe`) |
| `pg-retention` | `retention_policies` tylko do dopisywania | A | `DELETE` przez `assertOwnerGuard` |
| `pg-school-year-setup` | klasy bez trasy usuwania | A | `DELETE FROM classes` (klucz obcy) przez `assertOwnerGuard` |
| `pg-student-guardian-consent` | strażnik przypisań opiekunów | A | `DELETE` (strażnik i klucze obce) przez `assertOwnerGuard` |
| `pg-year-close` | zapisy w zamkniętym roku | A | `DELETE` przez `assertOwnerGuard` |
| `pg-year-cycle` | cały cykl roku | C | odtworzenie eksportu przez `ownerDb` |
| `privacy-inventory` | sztuczna migracja bez wpisu w spisie | A | `ALTER TABLE guardians ADD COLUMN` przez `ownerDb`; spis kolumn czyta rola aplikacji |

Po zmianach wszystkie 40 plików przechodzi lokalnie na `rd_app` i bez roli (prawdziwy PostgreSQL 16) oraz na PGlite.
Cały zestaw z przebiegu `--all` na `rd_app` (288 plików bez 54 pominiętych) przeszedł lokalnie plik po pliku, dlatego
nocny job `nightly-pg-real-app-role` jest blokujący.

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

Sprzątanie baz i strefa czasowa (nocny `--all`):

- Skrypt uruchamia pliki testowe PO KOLEI (jak `--test-concurrency=1`, osobny proces
  `node --test` na plik) i po każdym pliku usuwa bazy `rd_t_<znacznik>_*` i
  `rd_tpl_<znacznik>_*` swojego przebiegu (`DROP DATABASE … WITH (FORCE)`;
  znacznik `RD_TEST_PG_RUN_TAG` losuje skrypt, więc cudze bazy na tym samym serwerze
  zostają). Wcześniej porzucone bazy (~16 MB każda, także szablon `rd_tpl_*`) kumulowały
  się przez cały przebieg i potrafiły zapełnić dysk (ENOSPC). Podsumowanie na końcu:
  liczba plików, plików z błędem i baz usuniętych przez skrypt (0 = testy posprzątały same).
- `tests/helpers/pg.js` dodatkowo rejestruje `after()` na poziomie pliku testowego:
  zamyka niezamknięte pule, usuwa niezamknięte bazy i szablon. Testy zarządzające bazą same
  (`db.close()`) działają bez zmian — `DROP DATABASE IF EXISTS` jest idempotentne.
- Strefa: serwer własny startuje z `timezone=UTC` i `log_timezone=UTC`, procesy testów
  mają `TZ=UTC`, a sesje `createRealTestDb()` ustawiają `-c timezone=UTC` (także z
  `RD_TEST_PG_APP_ROLE`). UTC to domyślna strefa na Railway; to ustawienie testów, nie
  decyzja o strefie aplikacji (`tests/pg-class-coverage.test.js` pada przy innej strefie
  serwera, bo daty z `timestamptz` zależą od niej). Usługa `postgres` w nocnym workflow
  ma `TZ: UTC`/`PGTZ: UTC`.
- Kontrola dysku po lokalnym pełnym przebiegu: `psql -c '\l'` nie powinno pokazywać baz
  `rd_t_*`; katalog `/tmp/rd-pg-real-*` skrypt usuwa sam (także po SIGINT/SIGTERM).

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

Do tego samego pliku `pg-real-app-role` należą (#101): worker e-mail na `rd_app` (kampania od szkicu do kolejki przez API, potem `runEmailBatch`; ponowienie niczego nie wysyła) i `/health/ready` w produkcji (ostrzeżenie `readiness_database_role_privileged` przy właścicielu, brak przy `rd_app`; wariant na atrapach i PGlite: `tests/health-ready.test.js`).

`tests/pg-real-operator-identity.test.js` (#166, #191, pomijany bez `RD_TEST_PG_URL`): skrypty operatora jako procesy na jednorazowej, pustej bazie z `APP_ENV=staging` w powłoce — `migrate-postgres` i `restore-postgres-snapshot --apply` bez `--expect-database` albo z inną nazwą nic nie zapisują, z właściwą działają; drugie odtworzenie i wiersz w tabeli spoza migawki (`login_rate_limits`) kończą się `Target table is not empty`. Jednostki, `verify-export`, `bootstrap-admin`, `mfa:rotate-key` i adresy bez bazy: `tests/database-identity.test.js` (PGlite, nieosiągalna baza); `ensureEmpty` na PGlite: `tests/d1-postgres-migration.test.js`.

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

`tests/pg-real-payment-locks.test.js` (#208, pomijany bez `RD_TEST_PG_URL`): bariera dla
kolejnych ścieżek finansowych — dwa zwroty wpłaty 70 + 70 € przy 100 €, korekta i zwrot
tej samej wpłaty, dwa ponowne przypisania do tego samego gospodarstwa, dwie części wpłaty
70 + 70 €, cofnięcie części kontra nowa część na całą kwotę, dwa cofnięcia tej samej
części, dwa storna tego samego przeniesienia kasa ↔ rachunek oraz dwa przeksięgowania tego samego
wpisu księgi i przeksięgowanie kontra korekta tego wpisu. Każdy test sprawdza w
`pg_stat_activity`, że drugie żądanie czeka na `FOR UPDATE` z kodu trasy. Mutanty:
`payments-refund`, `payments-reassign`, `payments-allocation`,
`payments-allocation-reversal`, `ledger-transfer-reversal`, `ledger-replacement` (tylko blokada wpisu
księgi; blokadę wpłaty w `createReplacement` powtarza wyzwalacz `ledger_entry_insert_guard`, wyjątek w
inwentaryzacji niżej). Test nie ujawnił błędu współbieżności — blokady działają.

`tests/pg-real-cost-center-locks.test.js` (#208, pomijany bez `RD_TEST_PG_URL`): bariera dla
przypisania wpisu księgi do centrów kosztów (`ledger-cost-centers.js`) — dwa pierwsze
przypisania tego samego wpisu pod różnymi kluczami (drugie: `409 allocation_version_conflict`,
jedna wersja i jeden wpis audytu) oraz korekta wpisu 70 € w toku kontra przypisanie 100 €
(`409 allocation_exceeds_net`, zero wersji). Test sprawdza w `pg_stat_activity`, że drugie
żądanie czeka na `SELECT id FROM ledger_entries WHERE id = $1 FOR UPDATE` z `loadEntry`.
Mutant: `cost-center-allocation`.

`tests/pg-real-budget-locks.test.js` (#208, pomijany bez `RD_TEST_PG_URL`): bariera dla
preliminarza i poprawek bilansu otwarcia — dwie dezaktywacje tej samej kategorii pod różnymi
kluczami (`409 category_inactive`, jedna dezaktywacja i jeden wpis audytu), dwie rewizje tej
samej linii (`409 budget_line_superseded`, jedna rewizja) oraz dwie poprawki kasy -60 € przy
100 € w bilansie otwarcia (`409 cash_below_zero`, jedna poprawka). Test sprawdza w
`pg_stat_activity`, że drugie żądanie czeka na `FOR UPDATE` z `deactivateCategory`,
`reviseLine` (`ledger-budget.js`) albo `createAdjustment` (`ledger-cash.js`). Mutanty:
`budget-category`, `budget-revision`, `opening-adjustment`. Ten sam plik ma test starszej trasy
`POST /api/ledger/categories/{id}/deactivate` (`deactivateCategory` w `ledger.js`): podwójne kliknięcie
czeka na blokadę kategorii i daje jedno zdarzenie audytu (bez blokady drugi UPDATE wykonuje się
ponownie i dopisuje drugie) — mutant `ledger-category-deactivate`. `createOpening` używa
`LOCK TABLE`, nie `FOR UPDATE`, więc zostaje poza listą.

`tests/pg-real-request-locks.test.js` (#208, inwentaryzacja blokad, pomijany bez `RD_TEST_PG_URL`): wnioski
rodziców o zmianę kontaktu i rejestr żądań osób. Podwójne wysłanie formularza rodzica tym samym linkiem
(`409 link_used`, jeden wniosek; bez blokady linku drugie żądanie kończy się błędem wyzwalacza 0087),
podwójne „Zatwierdź” wniosku przez dwie osoby (powtórka `changed: false`, jedno zdarzenie), zatwierdzenie
wniosku dotyczącego samej zgody w trakcie zmiany adresu opiekuna przez zarząd (bez blokady opiekuna
zatwierdzenie nadpisuje nowy adres starym — utracona aktualizacja), podwójna zmiana statusu żądania osoby
(jedno zdarzenie), ograniczenie przetwarzania i sprostowanie imienia z powołaniem na żądanie w trakcie
zamykania tego żądania (`409 data_request_closed`, bez wpisu; bez blokady zapis powstaje na zamkniętym
żądaniu, bo klucz obcy tylko czeka, a nie sprawdza stanu). Mutanty: `guardian-update-submit`,
`guardian-update-decide`, `guardian-update-decide-guardian`, `data-request-status`,
`processing-restriction-request`, `families-rectification-request` (`FOR SHARE`).

`tests/pg-real-auth-locks.test.js` (#208, inwentaryzacja blokad, pomijany bez `RD_TEST_PG_URL`): dwóch
administratorów naraz wydaje token resetu hasła (zostaje jeden ważny token; bez blokady konta dwa),
dwie równoległe próby logowania przy ostatniej wolnej w oknie pary e-mail + IP (druga dostaje 429 bez
sprawdzania hasła; bez blokady liczy hasło ponad limit) oraz nadanie roli w trakcie wyłączania konta
(`409 user_disabled`; bez blokady przydział powstaje na wyłączanym koncie). Mutanty:
`password-reset-issue`, `login-attempt-reserve`, `grant-target-lock`.

`tests/pg-real-email-locks.test.js` (#208, inwentaryzacja blokad, pomijany bez `RD_TEST_PG_URL`): dwa
rozstrzygnięcia tej samej wiadomości naraz („nie wyszła” i „doszła”; drugie zwraca pierwsze, jeden
zapis) i dwa zatwierdzenia zdjęcia blokady adresu (`409 request_already_consumed`, jedno zdjęcie). Bez
blokady w obu przypadkach powstają dwa wiersze — tabele nie mają indeksu unikalnego na rozstrzygany
wiersz. Kampania źródłowa przechodzi przez worker z atrapą transportu; nic nie wychodzi do sieci.
Mutanty: `email-outbox-resolution`, `email-suppression-release`.

`tests/pg-real-guardian-verify-locks.test.js` (#208, dawna luka inwentaryzacji, pomijany bez `RD_TEST_PG_URL`):
kod weryfikacyjny nowego adresu z wniosku rodzica (#140 pkt 5). Kod wysyła worker z atrapą transportu; po czterech
błędnych próbach poprawny kod wpisany razem z piątą błędną czeka na blokadę wiersza weryfikacji (`confirmCode`) i
jest odrzucony (`400`, limit wyczerpany, bez `verification_confirmed`). Bez blokady poprawny kod czyta licznik sprzed
piątej próby i potwierdza adres mimo wyczerpanego limitu (wyzwalacz 0184 nie wiąże potwierdzenia z licznikiem; CHECK
`failed_attempts ≤ 5` przerywa tylko dwie równoległe BŁĘDNE próby — błędem zamiast odmowy). Mutant:
`guardian-verify-confirm`.

`tests/pg-real-mfa-locks.test.js` (#208, dawne luki inwentaryzacji, pomijany bez `RD_TEST_PG_URL`): blokady MFA.
Każda operacja na czynnikach blokuje najpierw wiersz konta, potem wiersz czynnika: weryfikacja i zapis czynnika
(`lockUser`, potem `activeFactors` w `mfa.js`), reset MFA (`adminResetMfaInTx`) i rotacja klucza (`lockAccount`,
potem czynnik w `rotateOneAccount`). Blokady czynnika są więc drugą warstwą (wyjątki „zagnieżdżona”), a dowodem
jest blokada konta. Podwójne „Włącz MFA” przy pierwszym zapisie czynnika: drugie żądanie czeka na blokadę konta i
zastępuje czynnik oczekujący (bez `lockUser` nie ma czego blokować w `activeFactors`, drugie żądanie dostaje 23505
na `user_mfa_factors_one_pending` — mutant `mfa-lock-user`). Dwie weryfikacje tego samego kodu TOTP: druga czeka i
dostaje `400`, kod przyjęty raz; usunięcie obu blokad naraz pokazuje kontrola pozytywna (`rewrite` w `race`: ten sam
kod przyjęty dwa razy). Rotacja w trakcie weryfikacji czeka na blokadę konta i przenosi zużyty krok (kontrola
pozytywna: bez obu blokad rotacji ten sam kod przechodzi drugi raz). Rotacja, która wyłączyła już stary wiersz, a nie
wstawiła nowego: weryfikacja, ponowny zapis czynnika i reset MFA czekają na blokadę konta i po jej zatwierdzeniu
widzą nowy wiersz (weryfikacja `200`, zapis dodaje czynnik oczekujący obok obróconego, reset wyłącza obrócony
czynnik), bez błędów transakcji przy `retries: 0`. Bez blokady konta w rotacji (mutant `mfa-key-rotation-account`)
wraca dawna odwrotna kolejność (czynnik, potem konto przez klucz obcy `INSERT`): zakleszczenie 40P01, przy
`retries: 0` weryfikacja dostaje `503 retry_later`, a z ponowieniami `src/db.js` kończy się poprawnie po ok. 1 s
(`deadlock_timeout`). Tak działał kod przed ujednoliceniem kolejności (luka znaleziona w #723). Weryfikacja czekająca
na wiersz czynnika zamiast konta (np. bez `lockUser`) dostaje po rotacji `409 mfa_not_enrolled`: stary wiersz jest
już wyłączony, a nowego nie ma w migawce czekającego zapytania; z kompletem blokad czeka na konto i czyta czynniki
nowym zapytaniem. Reset MFA przez administratora w trakcie ponownego zapisu czynnika czeka na blokadę konta i
wyłącza też nowy czynnik oczekujący; bez niej `UPDATE` resetu czeka tylko na wiersz wyłączany przez zapis czynnika,
nowego wiersza nie ma w jego migawce — reset kończy się `changed: false` (bez wylogowania i zdarzenia), a czynnik
przetrwa reset (mutant `mfa-admin-reset`). Podwójny reset sam w sobie jest bezpieczny (warunkowe `UPDATE … AND
disabled_at IS NULL`).

`tests/pg-real-webhook-locks.test.js` (#208, dawna luka inwentaryzacji, pomijany bez `RD_TEST_PG_URL`): zdarzenia
dostawcy (atrapa webhooka Brevo, worker z atrapą transportu). Twarde odbicie zgłoszone, gdy worker zapisuje wynik
wysyłki (`sending → sent`, bez COMMIT), czeka na blokadę wiersza kolejki w `recordWebhookEvent` i oznacza wiadomość
jako `bounced`; bez blokady czyta stan `sending` i wiadomość zostaje `sent`. Dwa różne zdarzenia odbicia tej samej
wiadomości dają jedną blokadę adresu (bez blokady — dwie, bo tabela nie ma indeksu unikalnego na aktywną blokadę).
To samo zdarzenie dwa razy daje jeden zapis także bez blokady (UNIQUE `dedupe_key`, `ON CONFLICT DO NOTHING`) —
test dokumentuje tę gwarancję. Mutant: `email-webhook-outbox`.

Każdy z mutantów plików powyżej (od `pg-real-request-locks`) i `ledger-category-deactivate` pada także na samym
skutku (sprawdzone jednorazowo z wyłączonymi asercjami miejsca czekania w `tests/helpers/pg-race.js`), a nie tylko
na tym, gdzie czeka drugie żądanie. `mfa-key-rotation-account` pada na zakleszczeniu (40P01), pozostałe na danych albo
odpowiedzi.

`tests/pg-real-record-locks.test.js` (#208, #111, pomijany bez `RD_TEST_PG_URL`): bariera dla kolejnych blokad
wiersza, których jedynym punktem serializacji jest zapytanie `FOR UPDATE` z kodu trasy. Rodziny: dwie identyczne
zmiany imienia ucznia i nazwiska opiekuna (`updateIdentity`), zgody na kontakt w relacji (`updateRelationContact`),
klasy (`changeEnrollment`), zakończenia przypisania (`endEnrollment`), relacji (`endRelation`), członkostwa ucznia
(`endStudentHousehold`) i opiekuna (`endGuardianHousehold`) w gospodarstwie oraz dodania członkostwa
(`addStudentHousehold`) — drugie żądanie czeka na blokadę wiersza i jest powtórką (`changed: false`, jeden wpis
historii i audytu). Dokumenty: dwa opisy pod różnymi kluczami dostają wersje 1 i 2 (`createDescription`). Aktualności:
cofnięcie praw do zdjęcia kontra weryfikacja (`409 photo_revoked`, `lockPhoto`). Zebrania: dwie edycje zebrania i
projektu uchwały z tej samej rewizji (`409 revision_conflict`) oraz dwie korekty obecności tej samej osoby
(`recordAttendance`). Zaproszenia: podwójne przyjęcie tego samego zaproszenia (`lockInvitation`) kończy się jednym
przydziałem roli i `already_used` — ten test powtarza nocny job 50 razy (#111). Każdy test sprawdza w
`pg_stat_activity`, że drugie żądanie czeka na `SELECT … FOR UPDATE` (zwykły SELECT nie czeka na blokadę wiersza, więc
czekający UPDATE albo INSERT oznaczałby brak blokady). Wspólny szkielet (`race`, `assertWaitsOn`) jest w
`tests/helpers/pg-race.js`. Mutanty: `families-identity`, `families-relation-contact`, `families-change-enrollment`,
`families-end-enrollment`, `families-end-relation`, `families-end-student-household`,
`families-end-guardian-household`, `families-add-student-household`, `documents-description`, `news-photo-lock`,
`meetings-update`, `meetings-resolution-update`, `meetings-attendance`, `invitation-accept`.

`tests/pg-real-replay-23505.test.js` (#208 kryterium 3, pomijany bez `RD_TEST_PG_URL`): gałęzie `23505 → odtworzenie
zapisu`, których na PGlite nie da się wykonać. Tu nie ma blokady wiersza: pierwsze żądanie zatrzymuje się w transakcji
po zapisie wiersza z kluczem, drugie dochodzi do `INSERT` i czeka na transakcję pierwszego (`transactionid`), po jej
zatwierdzeniu dostaje `23505` (kod w `errors`), a kod trasy odtwarza zapis spoza transakcji. Pokryte: wysłanie
dokumentu z tym samym kluczem (`200 replayed`, obiekt przegranego usunięty z bucketu, `document_uploads`
`abandoned`/`duplicate_idempotency_key`), utworzenie wydarzenia, wpisu aktualności i rejestracja zdjęcia z tym samym
kluczem, wysłanie pliku zdjęcia (23505 na `(zdjęcie, wariant)`, istniejące pliki zwrócone, obiekty przegranego
usunięte), utworzenie zebrania (23505 na `meeting_request_keys`, zapis przegranej transakcji wycofany), dwie wersje
dwa zapisy nowej osoby na
liście obecności (`ON CONFLICT DO NOTHING` → `409 concurrent_version`) oraz podwójne „Rozpocznij zamykanie roku”
(23505 na `school_year_closures` → dziś `409 conflict`, ponowienie `200 replayed`; test dokumentuje obecne
zachowanie, nie rozstrzyga, czy powinna to być powtórka; 23505 jest tam mapowany na `conflict` w samej
transakcji, więc dowodem jest czekanie na transakcję pierwszego i ten kod). Dwa testy to wyjątki od „23505”:
wersje protokołu zebrania numeruje wyzwalacz `meeting_minutes_insert_guard` (0009) pod `FOR UPDATE` na zebraniu,
więc druga transakcja dostaje `P0001` i `409 minutes_version_mismatch`, a nie 23505 (ponowienie zapisuje wersję 2);
podwójne potwierdzenie punktu listy kontrolnej zamknięcia roku serializuje `FOR UPDATE` na istniejącym wierszu
zamknięcia (mutant `year-close-closure-lock`). Blokada w wyzwalaczu migracji nie ma mutanta (mutant działa na kodzie
`src/`), ale ma test z barierą.
Poza zakresem: `createSignup` w `events.js` — gałąź `23505` leży za `FOR UPDATE` na wydarzeniu (`lockEvent`),
więc bez usunięcia tamtej blokady jest nieosiągalna, a po błędzie transakcja i tak byłaby przerwana (25P02).

`tests/pg-real-idempotency-quota.test.js` (#6, #84, pomijany bez `RD_TEST_PG_URL`): dwa
wyścigi bez odpowiednika na PGlite. (1) Dwa przypisania dwóch różnych wpłat pod tym samym
`Idempotency-Key`: zwycięzca dostaje `201`, przegrany czeka w bazie na unikalny klucz
(`transactionid`), dostaje `23505` i `409 idempotency_conflict` (nie `payment_already_assigned`);
jego wpłata zostaje `unmatched`, jest jedno przypisanie i jeden wpis audytu, a ponowienie
przegranego nadal jest konfliktem, zwycięzcy — odtworzeniem. (2) Dwa równoległe przebiegi
workera e-mail na przełomie doby konta Brevo (22:30 UTC = 00:30 w Brukseli oraz 01:00 UTC,
gdy doba konta liczy wpis sprzed północy UTC): A trzyma `QUOTA_LOCK_ID` po przejęciu
wierszy, B czeka na blokadę doradczą (`advisory`) i po jej zwolnieniu liczy wiadomości „w
locie” A; razem wychodzi dokładnie tyle, ile wynosi pula z większego zużycia (doba UTC /
doba konta), bez drugiej wysyłki tej samej wiadomości. Kontrola: ten sam układ z kontem w
UTC daje większą pulę. Zegar: `now` jest wstrzykiwany, ale `recorded_at` nowych wpisów
dziennika pochodzi z zegara bazy, więc test nie robi przebiegu po zakończeniu A; wpisy
„other” są zasiewane z jawnym `recorded_at`. Daty scenariuszy nie są sztywne:
`tests/helpers/quota-dates.js` wybiera najbliższy dzień w czasie letnim (CEST, kwiecień–wrzesień)
co najmniej 30 dni po rzeczywistym „dziś” (kolejka powstaje w czasie rzeczywistym, a `claim()`
przejmuje wiersze z `next_attempt_at <= now`, więc `now` z przeszłości zawiesza barierę), a rok
szkolny obejmuje „dziś” i ten dzień; dobór sprawdza `tests/email-quota-dates.test.js` (bez bazy).
Dane syntetyczne, atrapa transportu, brak sieci.

`tests/pg-real-brussels-day.test.js` (pomijany bez `RD_TEST_PG_URL`): daty dzienne wyliczane z czasu (`timestamptz` → data)
liczymy w strefie szkoły `Europe/Brussels` (wskazanie właściciela 2026-10-02), nie w `TimeZone` sesji bazy. Jedyne
źródło to `src/pg/today.js`: `SCHOOL_TIME_ZONE`, `brusselsDaySql(expr)` (tekst `YYYY-MM-DD`), `brusselsDateSql(expr)` (DATE),
`brusselsStartOfDaySql(dateExpr)` (początek dnia jako `timestamptz`); „dziś” w SQL to `rd_today()`, nie `current_date`.
Nowy kod nie używa `to_char(kolumna_timestamptz, …)`, `kolumna::date` ani `current_date` bez tych helperów; kolumny
`DATE` zostają bez zmian. Test sprawdza chwilę 23:30 UTC latem (= 01:30 następnego dnia w Brukseli) i granice
północy lato/zima przy sesji UTC, `Pacific/Kiritimati`, `Pacific/Pago_Pago` i `America/New_York`, także przez trasę
`/api/admin/class-coverage` (`lastRepresentativeLoginOn`). Limit dzienny Brevo ma osobną strefę konta i tej zasady nie dotyczy.

`tests/pg-real-type-parity.test.js` (#208 pkt 5, część na `pg` pomijana bez `RD_TEST_PG_URL`): te same zapytania
(kolumny `bigint`, `integer`, `numeric`, `date`, `timestamptz`, `boolean`, `jsonb`, `uuid`, `text[]`, `bigint[]`, NULL, agregaty
`count`/`sum`/`avg`/`max`) przez adapter na PGlite i na `createPgDatabase` (`src/db.js`); porównuje typy JS.
`src/db.js` nie ma `setTypeParser` ani normalizacji wierszy, więc test DOKUMENTUJE stan, nie naprawia go.
Znane rozbieżności: `bigint`/`int8`, `count(*)`, `sum(integer)`, `max(bigint)`, `bigint[]` to `number` na PGlite,
a `string` na `pg`; `date` to północ UTC na PGlite, a północ lokalna na `pg` (inny `toISOString()` poza UTC).
`sum(bigint)`, `sum(numeric)`, `avg`, `numeric` są tekstem na obu. Test porównawczy wymaga dokładnie tej listy:
dodanie parsera typów albo nowa rozbieżność czerwieni go i wymaga aktualizacji oczekiwań oraz tego opisu.
Konwencja aplikacji (`::int`, `toSafeInteger`, `to_char`) daje identyczny JSON na obu backendach. Nowy kod nie
może porównywać `rows[0].n === 0` ani dodawać wartości `bigint` bez `toSafeInteger`/rzutowania `::int`.

### Kontrola mutacyjna (`npm run test:pg-mutations`)

`scripts/check-lock-mutations.js` usuwa po kolei każdą blokadę z listy `MUTANTS`
(`FOR UPDATE` albo `pg_advisory_xact_lock` w jednej funkcji) w kopii kodu w katalogu
tymczasowym i uruchamia wskazany plik testów na prawdziwym PostgreSQL; mutant musi dać
czerwony test. Najpierw przebieg bez mutacji (musi być zielony). Kod repozytorium nie
jest zmieniany. CI uruchamia to w jobie `test-pg-mutations` podzielonym na 3 części
(`npm run test:pg-mutations -- --shard=i/3`; „Podział mutantów na części” niżej), nocny workflow — wszystkie naraz.
`tests/lock-mutations.test.js` (zwykłe shardy) pilnuje, żeby lista się nie zestarzała.
Obecnie lista obejmuje: korektę i przypisanie wpłaty, zwrot, ponowne przypisanie, części wpłaty i ich cofnięcie, storno przeniesienia kasa ↔ rachunek, przeksięgowanie wpisu księgi, korektę wpisu księgi i ujęcie
wpłaty w księdze, blokadę uzgodnienia, blokadę kampanii (zatwierdzenie i anulowanie),
`rd:role_grants`, blokadę adresu zaproszenia („Zaproś” i „Wyślij ponownie”), `rd_import_commit`, `rd_year_close`
oraz (`tests/pg-real-domain-locks.test.js`) `lockEvent`, `lockPost`, `lockMeeting`, `changeStatus` (dokumenty)
i `updateGuardianContact`, a w `tests/pg-real-cost-center-locks.test.js` blokadę wpisu przy
przypisaniu do centrów kosztów (`loadEntry` w `ledger-cost-centers.js`), a w
`tests/pg-real-budget-locks.test.js` blokady kategorii (dezaktywacja), linii preliminarza (rewizja)
i bilansu otwarcia (poprawka), a w `tests/pg-real-record-locks.test.js` osiem blokad w `families.js`
(tożsamość, zgoda w relacji, klasa, zakończenie przypisania, relacji i członkostw, dodanie członkostwa),
`createDescription` (dokumenty), `lockPhoto` (aktualności), `updateMeeting`, `updateResolution` i
`recordAttendance` (zebrania) oraz `lockInvitation` (przyjęcie zaproszenia), a w
`tests/pg-real-replay-23505.test.js` blokadę wiersza zamknięcia roku (`loadClosure`).
Mutanty z polem `table` usuwają blokadę jednej tabeli w funkcji z kilkoma blokadami (`updateIdentity`:
`families-identity` i `families-identity-guardian`; `createReplacement`; `decideRequest` w
`guardian-updates.js`), a rodzaj `for-share` — `FOR SHARE` (`createSession` w `auth.js`, mutant
`session-create-share` z `tests/pg-disable-session-race.test.js`; `checkRectificationRequest`).
Inwentaryzacja blokad dodała mutanty z `tests/pg-real-request-locks.test.js`,
`tests/pg-real-auth-locks.test.js`, `tests/pg-real-email-locks.test.js` i `ledger-category-deactivate`
(opisy wyżej) oraz blokady z istniejącymi testami z barierą: `lockGrantRequest` (`grant-request-lock`,
`pg-real-double-click`) i `createSession`. Domknięcie luk inwentaryzacji dodało `guardian-verify-confirm`,
`mfa-lock-user`, `mfa-active-factors`, `mfa-key-rotation`, `mfa-admin-reset` i `email-webhook-outbox`; ujednolicenie
kolejności blokad MFA (konto, potem czynnik) zastąpiło `mfa-active-factors` i `mfa-key-rotation` mutantem
`mfa-key-rotation-account` (blokady czynnika są teraz zagnieżdżone). Blokady wierszy spoza listy mają wpis w `LOCK_EXCEPTIONS` — tabela niżej.
Poza skanem zostają blokady doradcze bez mutanta (`promotions.js`, `anonymization.js`,
`invitation-batch.js`, `processing-restrictions.js`, `reconciliation.js` — `bank_statement_file_import`,
`privacy-notice.js`, `email.js` — limit dostawcy), `LOCK TABLE` w `createOpening` i `bootstrap-admin.js`
oraz blokady w wyzwalaczach migracji.

### Podział mutantów na części (#111)

Do #111 job `test-pg-real` uruchamiał po kolei testy na PostgreSQL i wszystkie mutanty; na GitHub trwał 8,3–9,3 min
i wyznaczał czas PR (shardy `test` 2,2–5,4 min). Pomiar z kroków trzech przebiegów z 3 października 2026
(runy 37120800949, 37121017225, 37121057725; `gh api repos/<repo>/actions/jobs/<id>` → `steps`):

| krok jobu `test-pg-real` | przebiegi 1 / 2 / 3 |
|---|---|
| przygotowanie (kontener `postgres`, checkout, `npm ci`) | 21 / 23 / 26 s |
| `npm run test:pg-real` (27 plików) | 127 / 127 / 106 s |
| `npm run test:pg-mutations` (57 mutantów, 13 plików bez mutacji ok. 60 s) | 404 / 399 / 361 s |
| cały job | 555 / 552 / 496 s |

Kontrola mutacyjna to ok. 3/4 czasu jobu, więc biegnie teraz w osobnym jobie `test-pg-mutations` z macierzą `part: [1, 2, 3]`;
każda część ma własną usługę `postgres` (ten sam digest), a `ci-ok` wymaga obu jobów. Job `test-pg-real` uruchamia już tylko
`npm run test:pg-real`.

- **Podział.** `npm run test:pg-mutations -- --shard=i/N` uruchamia część i/N; listę liczy
  `scripts/lock-mutation-shards.js` wyłącznie z listy `MUTANTS` i N (bez stanu maszyny). Mutanty są ułożone grupami według
  pliku testów (kolejność pierwszego wystąpienia), a ciąg jest pocięty na N kolejnych, niepustych kawałków o najmniejszym
  najdłuższym szacunku (programowanie dynamiczne). Kawałki kolejne, bo każda część najpierw uruchamia bez mutacji pliki
  swoich mutantów: plik testów jest przecięty najwyżej na granicy części, więc przebieg bez mutacji powtarza się najwyżej
  N−1 razy. Szacunek części = jeden przebieg pliku na mutant + jeden przebieg bez mutacji na plik; czasy plików
  (`TEST_SECONDS`) to średnie z tych trzech przebiegów, a plik spoza tabeli dostaje `DEFAULT_TEST_SECONDS` (5 s).
  Podgląd: `node scripts/lock-mutation-shards.js --plan 3`; lista części: `npm run test:pg-mutations -- --list --shard=2/3`.
  `--shard` nie łączy się z wyborem mutantów po id. Nocny workflow uruchamia wszystkie mutanty w jednym kroku (bez `--shard`).
- **Strażnicy.** `tests/lock-mutations.test.js`: części 1..N (N = 1..8, także z nowym mutantem i nowym plikiem testów) są
  rozłączne, niepuste, a ich suma to wszystkie mutanty; `shardMutants` zwraca część planu, a plan jest powtarzalny;
  przebiegów bez mutacji jest najwyżej „pliki + N − 1”; `--shard` odrzuca zły numer; `ci.yml` ma macierz 1..N bez luk,
  `--shard=${{ matrix.part }}/N` z N równym macierzy i `fail-fast: false`; CLI `--list --shard=i/N` dla każdej części CI
  daje rozłączne listy o sumie `MUTANTS`; `test-pg-mutations` ma usługę o tym samym obrazie co `test-pg-real` i
  `RD_TEST_PG_URL`; `test-pg-real` nie uruchamia już mutantów; `ci-ok` ma oba joby w `needs` i sprawdza ich wynik;
  najdłuższa szacowana część CI mieści się w 125% średniej. `tests/ci-supply-chain.test.js`: `ci-ok` wymaga obu jobów,
  a wszystkie usługi w `ci.yml` mają ten sam obraz przypięty do digestu.
- **Szacunek i pomiar.** Plan dla N = 3 (57 mutantów, szacunek całości 384 s wobec zmierzonych 361–404 s):

  | część | mutanty | pliki testów | szacunek |
  |---|---|---|---|
  | 1/3 | 11 | `pg-real-double-click` | 132 s |
  | 2/3 | 24 | `pg-real-payment-locks` … `pg-real-budget-locks`, początek `pg-real-record-locks` | 132 s |
  | 3/3 | 22 | reszta `pg-real-record-locks`, `pg-real-replay-23505` … `pg-real-email-locks` | 127 s |

  Oczekiwany najdłuższy job PG na GitHub: ok. 130 s kroku + ok. 25 s przygotowania ≈ 2,6 min (`test-pg-real`: ok.
  2,5 min), czyli poniżej najdłuższego shardu `test`; przed zmianą 8,3–9,3 min.
  Lokalnie (kontener: 4 rdzenie, 16 GB, PostgreSQL 16 bez `RD_TEST_PG_URL`, czyli własny serwer `initdb` na każdy przebieg
  pliku): `npm run test:pg-mutations -- --shard=3/3` — 6 plików bez mutacji, 22 mutanty zabite, 226 s; różnica względem
  szacunku to głównie start własnego serwera przy każdym z 28 przebiegów (w CI serwer jest jeden, z usługi `postgres`).
- **Kiedy zmienić N albo czasy.** Gdy podsumowanie przebiegu pokaże część `test-pg-mutations` dłuższą niż najdłuższy shard
  `test` (np. po dodaniu kilku mutantów do `pg-real-double-click`, ok. 11 s na mutant), dopisz czas nowego pliku do
  `TEST_SECONDS` albo zwiększ N — macierz `part` i `--shard=…/N` w `ci.yml` zmieniają się razem (pilnuje tego strażnik).
  Każda dodatkowa część to osobny runner z ok. 25 s przygotowania i jednym dodatkowym przebiegiem bez mutacji.

### Inwentaryzacja blokad wierszy (`tests/lock-inventory.test.js`)

Kryterium #208 „każda blokada wiersza ma dowód”. `scripts/lock-inventory.js` skanuje `src/pg` w
poszukiwaniu `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` i `FOR KEY SHARE` w kodzie (komentarze
pomija) i przypisuje każde wystąpienie do funkcji najwyższego poziomu (te same granice co mutanty) i
tabeli blokowanych wierszy (dla `OF alias` — tabela aliasu). Klucz to plik + funkcja + tabela + rodzaj
blokady, nie numer linii. `tests/lock-inventory.test.js` (bez bazy, zwykłe shardy) wymaga, żeby każde
wystąpienie miało mutant w `scripts/check-lock-mutations.js` albo wpis w `LOCK_EXCEPTIONS` z kategorią
i powodem — nowa blokada bez mutanta i bez wyjątku oblewa test. Kategorie wyjątków:

- **zagnieżdżona** — ta sama transakcja wcześniej bierze blokadę nadrzędną z mutantem (`outer`), przez
  którą przechodzi każdy zapis chronionej tabeli; usunięcie samej wewnętrznej nie zmienia wyniku
  (mutant równoważny). Test sprawdza, że funkcja (albo każdy, kto woła pomocnika z `{ lock: true }`)
  woła funkcję mutanta nadrzędnego; nieeksportowany pomocnik bez tej opcji (`activeFactors`) — że każda
  funkcja modułu, która go woła, wcześniej woła funkcję mutanta nadrzędnego;
- **ograniczenie** — serializację zapewnia baza: indeks unikalny (+ odtworzenie 23505), wyzwalacz
  migracji albo warunkowy UPDATE; bez blokady zmienia się co najwyżej odpowiedź (kod błędu, stan w
  metadanych audytu), bez podwójnego zapisu i utraconej aktualizacji. Test sprawdza, że
  wskazany dowód istnieje w `postgres/migrations` albo w ciele funkcji;
- **luka** — wyścig jest możliwy, a testu z barierą jeszcze nie ma (dalszy zakres #208); powód opisuje
  skutek.

Funkcja z blokadami kilku tabel wymaga mutanta na konkretną tabelę (`table`), żeby dowód dotyczył
jednej blokady. Stan: 85 blokad wierszy, 56 z mutantem (62 mutanty, w tym blokady doradcze), 29 wyjątków:
10 zagnieżdżonych i 19 ograniczeń; luk nie ma. Sześć dawnych luk (`confirmCode` w `guardian-updates.js`,
`adminResetMfaInTx`, `lockUser`/`activeFactors` w `mfa.js`, `rotateOneAccount`, `recordWebhookEvent`) ma testy z
barierą (blokady czynnika w `activeFactors` i `rotateOneAccount` są zagnieżdżone pod blokadą konta) w `tests/pg-real-guardian-verify-locks.test.js`, `tests/pg-real-mfa-locks.test.js` i
`tests/pg-real-webhook-locks.test.js` (opisy wyżej, w „Testy wyścigów”).
Tabelę poniżej generuje `node scripts/lock-inventory.js --markdown`; test wymaga, żeby była równa
wygenerowanej (po zmianie listy mutantów albo wyjątków wklej nowy wynik).

<!-- lock-inventory:start (generuje: node scripts/lock-inventory.js --markdown) -->
| Plik i funkcja | Tabela | Blokada | Dowód |
| --- | --- | --- | --- |
| `account-recovery.js` `createRecoveryRequest` | `users` | FOR UPDATE | wyjątek, ograniczenie: Jeden otwarty wniosek danego rodzaju na konto trzyma indeks unikalny account_recovery_requests_open_uidx (0125); bez blokady drugi wniosek kończy się 23505 zamiast zwrócenia istniejącego, bez drugiego wiersza. |
| `account-recovery.js` `lockRequest` | `account_recovery_requests` | FOR UPDATE | wyjątek, ograniczenie: Wyzwalacz account_recovery_request_guard (0125) odrzuca zmianę wniosku, który nie jest już pending, więc drugie zatwierdzenie/odrzucenie wycofuje całą transakcję (z tokenem resetu, który i tak serializuje blokada konta z mutantem password-reset-issue). Bez blokady: błąd wyzwalacza zamiast 409 recovery_request_closed. |
| `auth.js` `createSession` | `users` | FOR SHARE | mutant `session-create-share` (`tests/pg-disable-session-race.test.js`) |
| `auth.js` `revokeOwnSession` | `sessions` | FOR UPDATE | wyjątek, ograniczenie: Cofnięcie sesji to warunkowy UPDATE … AND revoked_at IS NULL (revokeSessionWith): drugi UPDATE czeka na pierwszy, po jego zatwierdzeniu nie zmienia wiersza i nie dopisuje zdarzenia. |
| `auth.js` `lockInvitation` | `invitations` | FOR UPDATE | mutant `invitation-accept` (`tests/pg-real-record-locks.test.js`) |
| `events.js` `lockEvent` | `events` | FOR UPDATE | mutant `events-lock` (`tests/pg-real-domain-locks.test.js`) |
| `events.js` `cancelTask` | `event_tasks` | FOR UPDATE | wyjątek, zagnieżdżona (pod `events-lock`): Funkcja zaczyna od lockEvent (wiersz wydarzenia FOR UPDATE); każdy zapis event_tasks (createTask, cancelTask) robi to samo, więc blokada zadania jest drugą warstwą (mutant równoważny). |
| `events.js` `createSignup` | `event_task_signups` | FOR UPDATE | wyjątek, zagnieżdżona (pod `events-lock`): Zapis na zadanie i jego wycofanie zaczynają od lockEvent; nowy zapis tej samej osoby chroni dodatkowo indeks unikalny (gałąź 23505 w kodzie). Blokada istniejącego zapisu jest drugą warstwą (mutant równoważny). |
| `events.js` `withdrawSignup` | `event_task_signups` | FOR UPDATE | wyjątek, zagnieżdżona (pod `events-lock`): Wycofanie zapisu zaczyna od lockEvent, jak każdy zapis event_task_signups; blokada wiersza zapisu jest drugą warstwą (mutant równoważny). |
| `grant-requests.js` `lockGrantRequest` | `role_grant_requests` | FOR UPDATE | mutant `grant-request-lock` (`tests/pg-real-double-click.test.js`) |
| `login.js` `reserveAttempt` | `login_rate_limits` | FOR UPDATE | mutant `login-attempt-reserve` (`tests/pg-real-auth-locks.test.js`) |
| `login.js` `acceptInvitationWithPassword` | `users` | FOR UPDATE | wyjątek, ograniczenie: Zaproszenie blokuje lockInvitation (mutant invitation-accept); nowe konto chroni ON CONFLICT (email) DO NOTHING (409 conflict) i klucz główny user_passwords, a wyłączenie konta w trakcie — FOR SHARE w createSession (mutant session-create-share). Blokada konta ustala tylko porównanie skrótu hasła z chwili sprawdzenia. |
| `login.js` `resetPasswordWithToken` | `password_reset_tokens` | FOR UPDATE | wyjątek, ograniczenie: Wyzwalacz password_reset_token_guard (0020) odrzuca zmianę tokenu już użytego albo cofniętego, więc drugie użycie tego samego tokenu wycofuje całą transakcję (z nowym hasłem); bez blokady: błąd wyzwalacza zamiast 400 invalid_token. |
| `login.js` `issuePasswordResetInTx` | `users` | FOR UPDATE | mutant `password-reset-issue` (`tests/pg-real-auth-locks.test.js`) |
| `login.js` `adminResetMfaInTx` | `users` | FOR UPDATE | mutant `mfa-admin-reset` (`tests/pg-real-mfa-locks.test.js`) |
| `meetings.js` `updateMeeting` | `meetings` | FOR UPDATE | mutant `meetings-update` (`tests/pg-real-record-locks.test.js`) |
| `meetings.js` `recordAttendance` | `meeting_attendees` | FOR UPDATE | mutant `meetings-attendance` (`tests/pg-real-record-locks.test.js`) |
| `meetings.js` `updateResolution` | `resolutions` | FOR UPDATE | mutant `meetings-resolution-update` (`tests/pg-real-record-locks.test.js`) |
| `meetings.js` `lockMeeting` | `meetings` | FOR UPDATE | mutant `meetings-lock` (`tests/pg-real-domain-locks.test.js`) |
| `meetings.js` `withdrawAgendaItem` | `meeting_agenda_items` | FOR UPDATE | wyjątek, zagnieżdżona (pod `meetings-lock`): Wycofanie punktu porządku obrad wywołuje wcześniej lockMeeting; jedyny zapis withdrawn_at jest w tej funkcji, więc blokada punktu jest drugą warstwą (mutant równoważny). |
| `meetings.js` `reorderAgendaItems` | `meeting_agenda_items` | FOR UPDATE | wyjątek, zagnieżdżona (pod `meetings-lock`): Zmiana kolejności wywołuje wcześniej lockMeeting; pozycje zmienia wyłącznie ta funkcja, więc blokada punktów jest drugą warstwą (mutant równoważny). |
| `meetings.js` `loadNotice` | `meeting_notices` | FOR UPDATE | wyjątek, zagnieżdżona (pod `meetings-lock`): loadNotice(…, { lock: true }) wołają tylko approveMeetingNotice i createNoticeCampaignDraft, obie po lockMeeting; zawiadomienia powstają (createNoticeDraft) też pod lockMeeting. |
| `mfa-key-rotation.js` `lockAccount` | `users` | FOR UPDATE | mutant `mfa-key-rotation-account` (`tests/pg-real-mfa-locks.test.js`) |
| `mfa-key-rotation.js` `rotateOneAccount` | `user_mfa_factors` | FOR UPDATE | wyjątek, zagnieżdżona (pod `mfa-key-rotation-account`): Rotacja zaczyna od lockAccount (wiersz konta FOR UPDATE), tak jak weryfikacja i zapis czynnika (lockUser) oraz reset MFA; każdy zapis user_mfa_factors przechodzi przez blokadę konta, więc blokada czynnika jest drugą warstwą (mutant równoważny). Bez obu blokad rotacja przenosi krok sprzed weryfikacji (kontrola pozytywna w tests/pg-real-mfa-locks.test.js). |
| `mfa.js` `lockUser` | `users` | FOR UPDATE | mutant `mfa-lock-user` (`tests/pg-real-mfa-locks.test.js`) |
| `mfa.js` `activeFactors` | `user_mfa_factors` | FOR UPDATE | wyjątek, zagnieżdżona (pod `mfa-lock-user`): activeFactors wołają tylko enrollFactor, attemptFactor i revokeAllOwnSessions, każda zaraz po lockUser (wiersz konta FOR UPDATE). Każdy zapis user_mfa_factors (zapis i potwierdzenie czynnika, reset MFA w adminResetMfaInTx, rotacja klucza po lockAccount) bierze wcześniej blokadę konta, więc blokada czynnika jest drugą warstwą (mutant równoważny). |
| `news.js` `lockPost` | `news_posts` | FOR UPDATE | mutant `news-lock` (`tests/pg-real-domain-locks.test.js`) |
| `news.js` `lockPhoto` | `news_photos` | FOR UPDATE | mutant `news-photo-lock` (`tests/pg-real-record-locks.test.js`) |
| `processing-restrictions.js` `changeProcessingRestriction` | `data_subject_requests` | FOR UPDATE | mutant `processing-restriction-request` (`tests/pg-real-request-locks.test.js`) |
| `routes/admin.js` `setUserDisabled` | `users` | FOR UPDATE | wyjątek, ograniczenie: Wyłączenie i włączenie konta to warunkowe UPDATE (… AND disabled_at IS NULL / IS NOT NULL): drugi UPDATE czeka na pierwszy i po jego zatwierdzeniu nie zmienia wiersza (changed: false, bez zdarzenia). Wyścig z tworzeniem sesji (#256) zamyka FOR SHARE w createSession (mutant session-create-share). |
| `routes/admin.js` `lockGrantTarget` | `users` | FOR UPDATE | mutant `grant-target-lock` (`tests/pg-real-auth-locks.test.js`) |
| `routes/admin.js` `revokeGrant` | `role_grants` | FOR UPDATE | wyjątek, zagnieżdżona (pod `admin-last`): Wcześniej w tej samej transakcji lockGrantChanges bierze blokadę doradczą rd:role_grants (mutant admin-last), pod którą zmieniają się wszystkie przydziały; UPDATE jest dodatkowo warunkowy (… AND g.revoked_at IS NULL). |
| `routes/admin.js` `setDataRequestStatus` | `data_subject_requests` | FOR UPDATE | mutant `data-request-status` (`tests/pg-real-request-locks.test.js`) |
| `routes/documents.js` `changeStatus` | `documents` | FOR UPDATE | mutant `documents-status` (`tests/pg-real-domain-locks.test.js`) |
| `routes/documents.js` `createDescription` | `documents` | FOR UPDATE | mutant `documents-description` (`tests/pg-real-record-locks.test.js`) |
| `routes/email.js` `loadCampaign` | `email_campaigns` | FOR UPDATE | mutant `email-campaign-lock` (`tests/pg-real-double-click.test.js`), mutant `email-cancel` (`tests/pg-real-concurrency.test.js`) |
| `routes/email.js` `providerPauseLift` | `email_provider_pauses` | FOR UPDATE | wyjątek, ograniczenie: Zdjęcie wstrzymania dostawcy to warunkowy UPDATE … AND lifted_at IS NULL: drugi czeka na pierwszy i nie zmienia wiersza, a brak wiersza przerywa transakcję razem z wpisem audytu. Bez blokady: błąd zamiast powtórki, bez podwójnego zapisu. |
| `routes/email.js` `createResolution` | `email_outbox` | FOR UPDATE | mutant `email-outbox-resolution` (`tests/pg-real-email-locks.test.js`) |
| `routes/email.js` `approveResolution` | `email_outbox` | FOR UPDATE | wyjątek, ograniczenie: Jedno zatwierdzenie na rozstrzygnięcie: UNIQUE email_outbox_resolution_approvals.resolution_id (0156); bez blokady drugie kliknięcie dostaje 23505 zamiast powtórki, bez drugiego zapisu. |
| `routes/email.js` `recordWebhookEvent` | `email_outbox` | FOR UPDATE | mutant `email-webhook-outbox` (`tests/pg-real-webhook-locks.test.js`) |
| `routes/email.js` `release` | `email_suppression_release_requests` | FOR UPDATE | mutant `email-suppression-release` (`tests/pg-real-email-locks.test.js`) |
| `routes/families.js` `updateGuardianContact` | `guardians` | FOR UPDATE | mutant `families-contact` (`tests/pg-real-domain-locks.test.js`) |
| `routes/families.js` `checkRectificationRequest` | `data_subject_requests` | FOR SHARE | mutant `families-rectification-request` (`tests/pg-real-request-locks.test.js`) |
| `routes/families.js` `updateIdentity` | `students` | FOR UPDATE | mutant `families-identity` (`tests/pg-real-record-locks.test.js`) |
| `routes/families.js` `updateIdentity` | `guardians` | FOR UPDATE | mutant `families-identity-guardian` (`tests/pg-real-record-locks.test.js`) |
| `routes/families.js` `updateRelationContact` | `student_guardians` | FOR UPDATE | mutant `families-relation-contact` (`tests/pg-real-record-locks.test.js`) |
| `routes/families.js` `changeEnrollment` | `students` | FOR UPDATE | mutant `families-change-enrollment` (`tests/pg-real-record-locks.test.js`) |
| `routes/families.js` `endEnrollment` | `enrollments` | FOR UPDATE | mutant `families-end-enrollment` (`tests/pg-real-record-locks.test.js`) |
| `routes/families.js` `endRelation` | `student_guardians` | FOR UPDATE | mutant `families-end-relation` (`tests/pg-real-record-locks.test.js`) |
| `routes/families.js` `endStudentHousehold` | `student_households` | FOR UPDATE | mutant `families-end-student-household` (`tests/pg-real-record-locks.test.js`) |
| `routes/families.js` `endGuardianHousehold` | `guardian_households` | FOR UPDATE | mutant `families-end-guardian-household` (`tests/pg-real-record-locks.test.js`) |
| `routes/families.js` `addStudentHousehold` | `students` | FOR UPDATE | mutant `families-add-student-household` (`tests/pg-real-record-locks.test.js`) |
| `routes/guardian-updates.js` `submitUpdate` | `guardian_update_links` | FOR UPDATE | mutant `guardian-update-submit` (`tests/pg-real-request-locks.test.js`) |
| `routes/guardian-updates.js` `verificationsByRequest` | `guardian_update_verifications` | FOR UPDATE | wyjątek, ograniczenie: Blokada (tylko z decideRequest, po blokadzie wniosku z mutantem guardian-update-decide) ustala stan weryfikacji zapisany w audycie decyzji. Anulowanie kodu jest warunkowym UPDATE … AND state = 'queued', więc nie nadpisuje wysyłki workera; bez blokady audyt może pokazać stan sprzed równoległego potwierdzenia kodu (bez zmiany danych). |
| `routes/guardian-updates.js` `decideRequest` | `guardian_update_requests` | FOR UPDATE | mutant `guardian-update-decide` (`tests/pg-real-request-locks.test.js`) |
| `routes/guardian-updates.js` `decideRequest` | `guardians` | FOR UPDATE | mutant `guardian-update-decide-guardian` (`tests/pg-real-request-locks.test.js`) |
| `routes/guardian-updates.js` `confirmCode` | `guardian_update_verifications` | FOR UPDATE | mutant `guardian-verify-confirm` (`tests/pg-real-guardian-verify-locks.test.js`) |
| `routes/guardian-updates.js` `approveTemplate` | `guardian_verify_templates` | FOR UPDATE | wyjątek, ograniczenie: Wyzwalacz guardian_verify_template_guard (0184) dopuszcza wyłącznie przejście draft → approved, więc drugie zatwierdzenie nie nadpisze approved_by; bez blokady kończy się błędem wyzwalacza zamiast powtórki/409. |
| `routes/ledger-budget.js` `deactivateCategory` | `ledger_categories` | FOR UPDATE | mutant `budget-category` (`tests/pg-real-budget-locks.test.js`) |
| `routes/ledger-budget.js` `reviseLine` | `ledger_budget_lines` | FOR UPDATE | mutant `budget-revision` (`tests/pg-real-budget-locks.test.js`) |
| `routes/ledger-cash.js` `createTransfer` | `ledger_transfers` | FOR UPDATE | mutant `ledger-transfer-reversal` (`tests/pg-real-payment-locks.test.js`) |
| `routes/ledger-cash.js` `createAdjustment` | `ledger_opening_balances` | FOR UPDATE | mutant `opening-adjustment` (`tests/pg-real-budget-locks.test.js`) |
| `routes/ledger-cost-centers.js` `loadEntry` | `ledger_entries` | FOR UPDATE | mutant `cost-center-allocation` (`tests/pg-real-cost-center-locks.test.js`) |
| `routes/ledger.js` `deactivateCategory` | `ledger_categories` | FOR UPDATE | mutant `ledger-category-deactivate` (`tests/pg-real-budget-locks.test.js`) |
| `routes/ledger.js` `createEntry` | `payment_entries` | FOR UPDATE | mutant `ledger-payment-link` (`tests/pg-real-double-click.test.js`) |
| `routes/ledger.js` `createCorrection` | `ledger_entries` | FOR UPDATE | mutant `ledger-correction` (`tests/pg-real-double-click.test.js`) |
| `routes/ledger.js` `createReplacement` | `payment_entries` | FOR UPDATE | wyjątek, ograniczenie: Wyzwalacz ledger_entry_insert_guard (0142) przy wstawieniu wpisu zastępczego sam blokuje wiersz wpłaty FOR UPDATE i porównuje kwotę z jej netto (ledger_payment_amount_mismatch). Blokada w API ustala tylko kolejność „wpłata, potem wpis” jak w korekcie wpłaty; wpis księgi ma osobny mutant ledger-replacement. |
| `routes/ledger.js` `createReplacement` | `ledger_entries` | FOR UPDATE | mutant `ledger-replacement` (`tests/pg-real-payment-locks.test.js`) |
| `routes/ledger.js` `createReview` | `ledger_entries` | FOR SHARE | wyjątek, ograniczenie: Przegląd wydatku tylko dopisuje wiersz z unikalnym kluczem idempotencji (odtworzenie 23505). Wpis księgi jest niezmienny (kierunek, autor, rok), a wyzwalacz ledger_review_guard (0072) powtarza te same kontrole w transakcji zapisu, więc żadna reguła nie zależy od stanu, który mógłby zmienić się równolegle. |
| `routes/ledger.js` `createAuthorization` | `resolutions` | FOR UPDATE | wyjątek, ograniczenie: Dwie kwoty upoważnienia z tej samej podstawy: indeks unikalny resolution_spending_authorizations_root_idx (pierwsza kwota) i UNIQUE supersedes_id (następca) z 0072 — przegrany dostaje 23505 i 409 authorization_superseded. Stan uchwały (przyjęta, bez korekty) sprawdza też wyzwalacz resolution_authorization_guard. |
| `routes/payment-references.js` `createReference` | `payment_references` | FOR UPDATE | wyjątek, ograniczenie: Przy pierwszej referencji FOR UPDATE nie ma czego blokować (zero wierszy); jedną aktywną referencję na gospodarstwo i rok trzyma indeks unikalny payment_references_active_household_year_idx (0085). Bez blokady drugie żądanie dostaje 23505 → 409 idempotency_conflict zamiast payment_reference_already_active, bez drugiego wiersza. |
| `routes/payment-references.js` `revokeReference` | `payment_references` | FOR UPDATE | wyjątek, ograniczenie: Jedno unieważnienie na referencję: UNIQUE payment_reference_revocations.payment_reference_id (0085), a wyzwalacz zastosowania blokuje referencję FOR UPDATE. Bez blokady drugie unieważnienie kończy się 23505 (odtworzenie po kluczu albo 409), bez drugiego zapisu. |
| `routes/payments.js` `createCorrection` | `payment_entries` | FOR UPDATE | mutant `payments-correction` (`tests/pg-real-double-click.test.js`) |
| `routes/payments.js` `assignPayment` | `payment_entries` | FOR UPDATE | mutant `payments-assign` (`tests/pg-real-double-click.test.js`) |
| `routes/payments.js` `createRefund` | `payment_entries` | FOR UPDATE | mutant `payments-refund` (`tests/pg-real-payment-locks.test.js`) |
| `routes/payments.js` `reassignPayment` | `payment_entries` | FOR UPDATE | mutant `payments-reassign` (`tests/pg-real-payment-locks.test.js`) |
| `routes/payments.js` `createAllocation` | `payment_entries` | FOR UPDATE | mutant `payments-allocation` (`tests/pg-real-payment-locks.test.js`) |
| `routes/payments.js` `reverseAllocation` | `payment_entries` | FOR UPDATE | mutant `payments-allocation-reversal` (`tests/pg-real-payment-locks.test.js`) |
| `routes/privacy-notice.js` `approveNotice` | `privacy_notices` | FOR UPDATE | wyjątek, ograniczenie: Wyzwalacz privacy_notice_guard (0075) dopuszcza zmianę approved_by/approved_at tylko przy przejściu draft → approved (privacy_notice_approval_fields_locked), więc drugie zatwierdzenie nie nadpisze pierwszego; bez blokady: błąd wyzwalacza zamiast powtórki. |
| `routes/privacy-notice.js` `publishNotice` | `privacy_notices` | FOR UPDATE | wyjątek, ograniczenie: Publikację serializuje wcześniej w tej samej transakcji blokada doradcza rd_privacy_notice_publish (każda publikacja ją bierze), a przejścia stanów pilnuje wyzwalacz privacy_notice_guard (0075). Blokada doradcza nie ma osobnego mutanta (poza zakresem skanu blokad wierszy). |
| `routes/reconciliation.js` `loadReconciliation` | `bank_reconciliations` | FOR UPDATE | mutant `reconciliation-lock` (`tests/pg-real-double-click.test.js`) |
| `routes/reconciliation.js` `revokeMatch` | `bank_reconciliation_matches` | FOR UPDATE | wyjątek, zagnieżdżona (pod `reconciliation-lock`): Wcześniej w tej samej transakcji loadReconciliation(…, { lock: true }) blokuje wiersz uzgodnienia; każdy zapis bank_reconciliation_matches (dopasowanie, dopasowanie zbiorcze, pozycja z wyciągu, cofnięcie) przechodzi przez tę blokadę. |
| `routes/reconciliation.js` `confirmGroupMatch` | `ledger_entries` | FOR SHARE | wyjątek, ograniczenie: Wyzwalacz pozycji dopasowania zbiorczego (0105, bank_group_match_items_guard_insert) blokuje cel FOR SHARE i porównuje kwotę z netto po zatwierdzeniu równoległej korekty (bank_match_amount_mismatch), a całe uzgodnienie jest zablokowane przez loadReconciliation. Blokada w API tylko ustala kolejność celów. |
| `routes/reconciliation.js` `confirmGroupMatch` | `payment_entries` | FOR SHARE | wyjątek, ograniczenie: Jak dla ledger_entries: wyzwalacz bank_group_match_items_guard_insert (0105) blokuje wpłatę FOR SHARE i sprawdza netto przy wstawieniu pozycji; blokada w API ustala tylko kolejność celów. |
| `routes/year-close.js` `loadClosure` | `school_year_closures` | FOR UPDATE | mutant `year-close-closure-lock` (`tests/pg-real-replay-23505.test.js`) |
<!-- lock-inventory:end -->

Nazwy testów na PGlite nie obiecują wyścigu: `tests/test-quality-lint.test.js`
(reguła `pglite-race-claim`) odrzuca w plikach bez `RD_TEST_PG_URL` nazwy z
„truly parallel”, „are serialized” i „bez zakleszczenia”. Testy z `Promise.all` na
PGlite mają w nazwie „sequential on PGlite” / „PGlite: po kolei”. „Podwójne
kliknięcie” na PGlite oznacza ponowienie po kolei (odtworzenie zapisu), a nie wyścig.
Reguła `pglite-parallel-unlabeled` wymaga w plikach używających `tests/helpers/pg.js`
(bez `RD_TEST_PG_URL`), by nazwa z „parallel/simultaneous/concurrent/równoległe/naraz”
zawierała „PGlite”, „po kolei” albo „sequential”; prawdziwy wyścig i odpowiedniki z barierą
są w `tests/pg-real-*.test.js`. Reguła `every-without-nonempty` obejmuje każdą asercję
`assert*(…every(…)` we wszystkich `tests/*.test.js` (niepustość w tej samej linii albo `assertEvery`).
Pułapka sieci (`tests/helpers/network-guard.js`) przepuszcza `fetch` tylko do serwerów
nasłuchujących na pętli zwrotnej, które uruchomił ten sam proces testowy (śledzone porty
`net.Server#listen`); inne porty i hosty oblewają przebieg.

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

### CI: joby `test-pg-real` i `test-pg-mutations`

CI działa na runnerach GitHub `ubuntu-latest` (repozytorium jest publiczne).
Job `test-pg-real` (`.github/workflows/ci.yml`, wymagany przez `ci-ok`) uruchamia
`npm run test:pg-real` z usługą `services: postgres` (obraz `postgres@sha256:…`
przypięty do digestu — `tests/ci-supply-chain.test.js`; przy aktualizacji zmień
digest obrazu `postgres:16` we wszystkich jobach PG naraz). Job `test-pg-mutations` (też wymagany przez `ci-ok`)
uruchamia kontrolę mutacyjną w 3 częściach, każdą z własną usługą `postgres` („Podział mutantów na części”). Gdy `RD_TEST_PG_URL` jest ustawione, skrypt
`scripts/test-pg-real.js` nie stawia własnego serwera, tylko używa wskazanego;
bez zmiennej działa jak wcześniej (`initdb` w katalogu tymczasowym).
Zwykłe shardy (`test`) nadal biegną na PGlite i pomijają testy wyścigów.
Nocny przebieg (#111, #101): osobny workflow `.github/workflows/nightly-pg-real.yml`
(`schedule:` codziennie 02:17 UTC oraz ręczne `workflow_dispatch`), trzy joby z własną usługą PostgreSQL i limitem czasu:

- `nightly-pg-real` (120 min): `npm run test:pg-real -- --all` (cały zestaw `tests/*.test.js` na prawdziwym
  PostgreSQL) i `npm run test:pg-mutations`;
- `nightly-pg-real-app-role` (120 min): ten sam zestaw z `RD_TEST_PG_APP_ROLE=rd_app` (punkt 3 z #101). Przebieg
  BLOKUJĄCY (bez `continue-on-error`; pilnuje tego `tests/nightly-workflow.test.js`). Niezgodności z ostatniego
  przebiegu diagnostycznego (65 testów w 40 plikach) są sklasyfikowane w sekcji „Klasyfikacja niezgodności z rolą
  `rd_app`”: operacje właściciela w testach idą przez `ownerDb`/`assertOwnerGuard`, a braku uprawnienia aplikacji nie
  znaleziono. Nowy błąd na tej roli oznacza więc albo brak uprawnienia, którego aplikacja potrzebuje (migracja z
  `GRANT` i wpis w `postgres/README.md`), albo test, który wykonuje operację właściciela połączeniem aplikacji.
  Lista plików z błędem i plików pominiętych (właściciel/`pg_read_all_stats`) trafia do podsumowania joba
  (`### Przebieg na roli rd_app`). Pominięte pliki (54) nie mają dowodu na `rd_app`, biegną w jobie właściciela;
- `nightly-concurrency` (90 min): 20 powtórzeń plików z barierą (`pg-real-double-click`, `pg-real-domain-locks`,
  `pg-real-record-locks`, `pg-real-replay-23505`, `pg-real-payment-locks`, `pg-real-request-locks`, `pg-real-auth-locks`,
  `pg-real-email-locks`, `pg-real-guardian-verify-locks`, `pg-real-mfa-locks`, `pg-real-webhook-locks`) i 50 powtórzeń podwójnego przyjęcia zaproszenia
  (`--repeat=50 --name='zaproszenia'`, kryterium z #111). Testy z barierą wymuszają przeplot, więc powtórzenia nie są
  „szczęśliwymi przebiegami”, tylko wykrywają niestabilność (czas, kolejność zatwierdzeń, ponowienia 40001/40P01).
  `tests/nightly-workflow.test.js` pilnuje, żeby `--name` pasowało do dokładnie jednego testu (wzorzec bez dopasowania to
  zero testów i cichy zielony przebieg).

Workflow nie jest wymaganym checkiem i nie wchodzi w `ci-ok`; `ci.yml` nie ma wyzwalacza `schedule`. Te same
przypięte SHA akcji i digest obrazu `postgres` co w `ci.yml` pilnuje
`tests/ci-supply-chain.test.js` (dla wszystkich plików w `.github/workflows`);
przy aktualizacji digestu zmień go w obu plikach. Shardy `test` pilnuje
`tests/ci-shard-coverage.test.js` (każdy plik `tests/*.test.js` w dokładnie jednym
z 6 shardów wyznaczonych przez `scripts/ci-shard-files.js`; „Podział na shardy według czasu”). Job `test-pg-real` miał limit 45 min
(było 30; 42 mutanty zamiast 27), a po inwentaryzacji blokad (57 mutantów, potem 63 po domknięciu jej luk; po ujednoliceniu
kolejności blokad MFA 62) trwał ok. 9 min. Po wydzieleniu mutantów (#111) `test-pg-real` i każda część `test-pg-mutations`
mają limit 15 min (pomiar: krok testów 106–127 s, szacunek części ok. 130–145 s; zapas wielokrotnie powyżej 20%).

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
- `tests/audit-pii-free-text.test.js`: `assertNoPii` odrzuca w metadanych zdarzeń klucze
  wolnego tekstu (`note`, `title`, `body`, `description`, `subject`, `author`, `comment`,
  `message`, `content`, `text` — także jako ostatni człon, np. `correctionNote`) niezależnie
  od wartości; tekst powodu lub treści zostaje w tabeli biznesowej.

Poza zakresem sprawdzenia: tabele bez kolumny `id` (np. liczniki prób logowania, hasła),
zmiany istniejących wierszy (UPDATE) bez nowego wiersza — te obejmuje poziom trasy — oraz
zadania poza trasami HTTP (worker e-mail, skrypty operatora).
