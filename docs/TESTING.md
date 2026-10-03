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

## Rejestr dowodów

Każde `✓` poza kolumną „Role” ma tu co najmniej jeden wiersz. Fragment nazwy testu musi
występować w linii `test(...)` wskazanego pliku (sprawdza to meta-test).

| Wiersz | Scenariusz | Plik | Fragment nazwy testu |
|---|---|---|---|
| sesja | Ponowienie | tests/pg-mfa.test.js | verify sets MFA only on the calling session and refuses a replayed step |
| sesja | Błędny e-mail | tests/pg-auth.test.js | invitation is one-time, expires, can be revoked and must match the account email |
| admin | Ponowienie | tests/pg-admin.test.js | invitations return the token once, block duplicates |
| admin | Korekty | tests/pg-admin.test.js | revoking grants keeps history |
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
`payments-allocation-reversal`, `ledger-transfer-reversal`, `ledger-replacement`. Test nie ujawnił błędu
współbieżności — blokady działają. Poza listą zostają m.in. `ledger.js` (kategoria).

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
`budget-category`, `budget-revision`, `opening-adjustment`. `createOpening` używa
`LOCK TABLE`, nie `FOR UPDATE`, więc zostaje poza listą.

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
jest zmieniany. CI uruchamia to w jobie `test-pg-real` po `npm run test:pg-real`.
`tests/lock-mutations.test.js` (zwykłe shardy) pilnuje, żeby lista się nie zestarzała.
Obecnie lista obejmuje: korektę i przypisanie wpłaty, zwrot, ponowne przypisanie, części wpłaty i ich cofnięcie, storno przeniesienia kasa ↔ rachunek, przeksięgowanie wpisu księgi, korektę wpisu księgi i ujęcie
wpłaty w księdze, blokadę uzgodnienia, blokadę kampanii (zatwierdzenie i anulowanie),
`rd:role_grants`, blokadę adresu zaproszenia („Zaproś” i „Wyślij ponownie”), `rd_import_commit`, `rd_year_close`
oraz (`tests/pg-real-domain-locks.test.js`) `lockEvent`, `lockPost`, `lockMeeting`, `changeStatus` (dokumenty)
i `updateGuardianContact`, a w `tests/pg-real-cost-center-locks.test.js` blokadę wpisu przy
przypisaniu do centrów kosztów (`loadEntry` w `ledger-cost-centers.js`), a w
`tests/pg-real-budget-locks.test.js` blokady kategorii (dezaktywacja), linii preliminarza (rewizja)
i bilansu otwarcia (poprawka).
Poza listą (brak testu z barierą, #208): pozostałe `FOR UPDATE` w `families.js` (relacje, gospodarstwa,
zapisy do klas), `events.js` (zadania, wycofanie zapisu), `news.js` (zdjęcia), `meetings.js` (uchwały,
porządek obrad, zawiadomienia), `documents.js` (opis), pozostałe w `payments.js`/`ledger.js`
(autoryzacje uchwał), `LOCK TABLE` w `createOpening` oraz blokady w triggerach migracji.

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

### CI: job `test-pg-real`

CI działa na runnerach GitHub `ubuntu-latest` (repozytorium jest publiczne).
Job `test-pg-real` (`.github/workflows/ci.yml`, wymagany przez `ci-ok`) uruchamia
`npm run test:pg-real` z usługą `services: postgres` (obraz `postgres@sha256:…`
przypięty do digestu — `tests/ci-supply-chain.test.js`; przy aktualizacji zmień
digest obrazu `postgres:16`). Gdy `RD_TEST_PG_URL` jest ustawione, skrypt
`scripts/test-pg-real.js` nie stawia własnego serwera, tylko używa wskazanego;
bez zmiennej działa jak wcześniej (`initdb` w katalogu tymczasowym).
Zwykłe shardy (`test`) nadal biegną na PGlite i pomijają testy wyścigów.
Nocny przebieg (#111): osobny workflow `.github/workflows/nightly-pg-real.yml`
(`schedule:` codziennie 02:17 UTC oraz ręczne `workflow_dispatch`) uruchamia
`npm run test:pg-real -- --all` (cały zestaw `tests/*.test.js` na prawdziwym
PostgreSQL) i `npm run test:pg-mutations`, timeout 120 min. Nie jest wymaganym
checkiem i nie wchodzi w `ci-ok`; `ci.yml` nie ma wyzwalacza `schedule`. Te same
przypięte SHA akcji i digest obrazu `postgres` co w `ci.yml` pilnuje
`tests/ci-supply-chain.test.js` (dla wszystkich plików w `.github/workflows`);
przy aktualizacji digestu zmień go w obu plikach. Shardy `test` pilnuje
`tests/ci-shard-coverage.test.js` (każdy plik `tests/*.test.js` w dokładnie jednym
z 6 shardów).

## Anonimizacja: odtworzenie i ponowne zastosowanie (#91)

Trzy pliki, wyłącznie dane syntetyczne (znaczniki `MRK-*`, domeny `.invalid`):

- `tests/pg-anonymization.test.js` — przebieg z trasy: rodzeństwo i opieka
  dzielona, sumy netto, paczka roczna bez zmian liczb, wpłaty częściowe i korekty,
  podwójne kliknięcie, odmowa bez polityki, granice ról, furtka w strażnikach.
- `tests/pg-anonymization-reapply.test.js` — „odtworzenie eksportu sprzed
  anonimizacji + ponowne zastosowanie przebiegów”: źródło → paczka roczna PRZED
  przebiegami → dwa przebiegi (opieka dzielona) → dziennik do pliku poza bazą →
  `restoreBundle` do pustej bazy (dane osobowe wracają, `anonymization_runs` puste)
  → `scripts/reapply-anonymization.js`. Sprawdza: dane osobowe zastąpione i stan
  równy źródłu po przebiegach; sumy wpłat (`household_payment_totals`), korekty,
  zwroty, księga, relacje i sumy `*_cents` paczki rocznej bez zmian; `--dry-run`
  niczego nie zmienia i zostawia tylko ślad podglądu; idempotencja (ponowienie,
  równoległe uruchomienie, kopia już zawierająca pierwszy przebieg, gospodarstwo
  nieobecne albo już zanonimizowane); kolejność dla osoby wspólnej; wiele plików
  dziennika; jedna transakcja (wstrzyknięty błąd wycofuje całość); odmowy: brak
  `--actor`, aktor bez roli `admin` (brak konta, inna rola, zablokowany, cofnięty
  przydział), blokada środowiska bez `--allow-production`, plik uszkodzony,
  edytowany albo z danymi osobowymi (np. e-mail zamiast identyfikatora
  gospodarstwa); strażniki niezmienności po ponowieniu; dziennik i audyt bez danych
  osobowych; eksport dziennika po ponowieniu równoważny pierwotnemu.
- `tests/pg-anonymization-proposals.test.js` — raport „propozycja do
  zatwierdzenia”: „brak polityk” przy pustym rejestrze, polityki niezatwierdzone i
  opisowe, kandydaci przy komplecie polityk, gospodarstwa z nieupłyniętym okresem poza listą,
  transakcja `READ ONLY` bez żadnego zapisu, zgodność skrótu planu z podglądem trasy,
  brak ścieżki wykonania i brak crona w plikach `railway*.json`.

Na prawdziwym PostgreSQL (odtworzenie paczki wymaga uprawnień
superużytkownika, `session_replication_role`):
`RD_TEST_PG_BACKEND=real node scripts/test-pg-real.js tests/pg-anonymization-reapply.test.js`
(analogicznie `tests/pg-anonymization-proposals.test.js`). Nie `--all`.

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
