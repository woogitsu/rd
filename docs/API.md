# Kontrakt list w API (kursor keyset)

Ten dokument opisuje wspólny kontrakt list, które mogą urosnąć ponad jedną stronę
(issue #159). Wcześniej część tras obcinała wynik po cichu (`LIMIT 500`/`LIMIT 100`
bez sygnału) albo używała `OFFSET`; administrator po kilku kadencjach mógł
oglądać niepełną historię przydziałów lub zdarzeń bez informacji, że to nie całość.

Implementacja wspólna: `src/pg/list-cursor.js`. Wzorzec kursora zgodny z już
istniejącymi `GET /api/payments` i `GET /api/ledger`.

## Trasy objęte kontraktem

| Trasa | Kolejność | Domyślny / maks. `limit` | Kursor związany z filtrem |
| --- | --- | --- | --- |
| `GET /api/admin/users` | `lower(email)`, `id` | 500 / 500 | — |
| `GET /api/admin/grants` | `granted_at` malejąco, `id` | 500 / 500 | `userId`, `classId`, `schoolYearId`, `role`, `status` |
| `GET /api/admin/invitations` | `created_at` malejąco, `id` | 500 / 500 | — |
| `GET /api/admin/audit` | `occurred_at` malejąco, `id` | 100 / 500 | `domain`, `actorId`, `schoolYearId`, `from`, `to` |
| `GET /api/email/campaigns?schoolYearId=` | `created_at` malejąco, `id` | 100 / 100 | rok szkolny |
| `GET /api/documents?schoolYearId=` | `created_at` malejąco, `id` | 50 / 100 | rok, `kind`, `classId`, `status`, `category`, `q` |
| `GET /api/email/campaigns/{id}/recipients` (#543) | `household_id`, `id` (kampania do kont `meeting_invitees`, 0183: `user_id`, `id`) | 200 / 200 | kampania |
| `GET /api/email/campaigns/{id}/attention` (#543) | `outbox_id` | 200 / 200 | kampania |
| `GET /api/email/suppressions?schoolYearId=` (#543) | `created_at` malejąco, `email_hash` | 500 / 500 | rok szkolny |
| `GET /api/meetings?schoolYearId=` | `scheduled_at` malejąco, `id` | 500 / 500 | rok szkolny |
| `GET /api/admin/guardian-update-requests` (#140 pkt 5: każdy wiersz ma `verification`, `verificationReason`, `verificationDelivery`, `verificationExpiresAt`) | `created_at`, `id` rosnąco | 200 / 200 | `status` |
| `GET /api/admin/guardian-verify-templates` (#159, #140 pkt 5: `currentTemplateId` to najnowsza zatwierdzona wersja z całej tabeli, także gdy leży poza stroną) | `version` malejąco | 100 / 100 | — |
| `GET /api/admin/account-requests` | `created_at` malejąco, `id` | 200 / 200 | `status` |
| `GET /api/admin/grant-requests` | `created_at` malejąco, `id` | 200 / 200 | `status` |
| `GET /api/admin/data-requests` (#543) | `received_on`, `created_at`, `id` rosnąco | 500 / 500 | `status`, `kind` |
| `GET /api/meetings/public-notices?schoolYearId=` (publiczna) | `scheduled_at`, `id` rosnąco | 200 / 200 | rok szkolny |
| `GET /api/news-photos` | `uploaded_at` malejąco, `id` | 200 / 200 | `status` |
| `GET /api/public/events` (publiczna) | `begins_at`, `id` rosnąco | 100 / 200 | rok szkolny, `from` |
| `GET /api/ledger/reviews?schoolYearId=` | `occurred_on` malejąco, `id` malejąco | 500 / 500 | rok szkolny, `reviewStatus` |

Uprawnienia tras nie zmieniły się: kursor niczego nie odblokowuje, a każde
żądanie przechodzi to samo sprawdzenie sesji, roli, MFA i zakresu po stronie
serwera (`docs/AUTHORIZATION.md`). Kursor nie zawiera danych osobowych: to
znacznik czasu i identyfikator, a dla kont wyłącznie identyfikator konta (adres
e-mail nie trafia do URL-a ani do logów dostępu).

## Odpowiedź

Dotychczasowe pola (`users`, `grants`, `invitations`, `events`, `campaigns`,
`documents`, `reviews`) pozostają bez zmian. Doszły pola:

- `nextCursor` — nieprzezroczysty tekst albo `null`, gdy to ostatnia strona;
- `truncated` — `true` wtedy i tylko wtedy, gdy `nextCursor` nie jest `null`
  (są dalsze wiersze, a lista NIE jest kompletna);
- `limit` — zastosowana wielkość strony.

Klient, który czyta tylko dotychczasowe pola, dostaje pierwszą stronę
(o tej samej wielkości co dawny stały limit) i może sprawdzić `truncated`.
`GET /api/documents` zwraca dodatkowo dotychczasowe `offset` (zawsze `0` przy
kursorze).

## Zapytanie

- `limit` — liczba całkowita od 1 do maksimum trasy. Wartość spoza zakresu lub
  nieliczbowa daje `400 invalid_limit` (wcześniej `GET /api/documents` przycinał
  ją po cichu).
- `cursor` — wartość `nextCursor` z poprzedniej odpowiedzi tej samej trasy z tymi
  samymi filtrami. Uszkodzony kursor, kursor innej trasy albo wydany dla innego
  filtru daje `400 invalid_cursor` — nigdy nie miesza wierszy dwóch zapytań.
- `GET /api/documents`: parametr `offset` działa nadal, ale tylko bez `cursor`
  (przestarzały; zostanie usunięty po aktualizacji klientów).

## Stabilność

Stronicowanie jest keyset, nie `OFFSET`:

- remis znacznika czasu rozstrzyga `id`, więc kolejność jest całkowita;
- znacznik czasu w kursorze ma mikrosekundy (tekst z bazy), a nie milisekundy z JS;
- ponowne użycie tego samego kursora (podwójne kliknięcie) zwraca identyczną stronę;
- zdarzenie dodane między stronami ma nowszy czas, więc nie powtarza się na
  kolejnych stronach i nie przesuwa starszych; wiersze dodane „w przeszłości”
  (czas wcześniejszy niż kursor) pojawią się na dalszych stronach.

`GET /api/admin/audit` przy każdym odczycie zapisuje zdarzenie `audit.viewed`
(bez parametrów zapytania) — dotyczy to także kolejnych stron.

`GET /api/audit/entity/{entityType}/{entityId}` (#181; `payment_entry`,
`ledger_entry`, `reconciliation`, `email_campaign`) to historia jednego obiektu
dla zarządu i skarbnika z przydziałem ogólnoszkolnym na rok obiektu (admin ma
`/api/admin/audit/entity/...`). Obiekt nieistniejący albo z roku bez przydziału
daje 404 `not_found`; Komisja Rewizyjna, dyrekcja i przedstawiciel klasy — 403
(założenie zachowawcze do D-08/D-09). Zwraca tylko zdarzenia domeny obiektu
(`finance` albo `email`), w kolejności czasu, w tym samym kształcie co trasa
admina, i sama zapisuje `audit.viewed`.

Każde zdarzenie w odpowiedzi (`GET /api/admin/audit` i `.../entity/...`) ma
pola `actorKind` (`user`, `system`, `anonymous`) i `source` (#181). Dla
zdarzeń bez aktora (`actorId: null`) `source` wskazuje pochodzenie: `email_worker`,
`brevo_webhook`, `unsubscribe_link`, `login` (próby bez sesji), `bootstrap` albo
`system`; dla zdarzeń użytkownika `source` jest `null`. To pochodna akcji i
`metadata.source` liczona przy odczycie (`auditEventSource` w
`shared/audit-actions.js`) — bez migracji i bez zmiany zapisanych wierszy.

Domeny filtra `domain` (#181) to dokładne listy akcji ze słownika
`shared/audit-actions.js` (`access`, `security`, `finance`, `email`,
`documents`, `year_close`, `families`, `privacy`, `meetings`, `events`,
`news`), a nie przedrostki nazw — każda akcja zapisywana w `src/pg/**` i
`src/email/**` ma tam jedną domenę i polską etykietę (test
`tests/audit-actions-catalog.test.js`). Każde zdarzenie w odpowiedzi ma pole
`domain`; metadane przechodzą przez `auditMetadataForView` (`src/pg/audit.js`):
tylko liczby, wartości logiczne i napisy w kształcie identyfikatora/kodu/daty.
Wolny tekst i klucze z danymi osobowymi są pomijane, a ich ścieżki (bez
wartości) podaje `redactedFields`.

## Panele

Panele `admin/` (konta, przydziały, zaproszenia, dziennik), `email/` (kampanie)
i `documents/` pokazują przycisk „Pokaż więcej” / „Wczytaj następne”, gdy
odpowiedź ma `nextCursor`. Zmiana filtra zaczyna listę od początku.

## Indeksy i plany zapytań

Migracja `0132_keyset_list_indexes.sql` dodaje indeksy zgodne z kolejnością list
(tylko `CREATE INDEX`, bez zmian danych). `tests/pg-query-plans.test.js` zapełnia
tabele ponad 10 000 wierszy, robi `ANALYZE` i sprawdza `EXPLAIN` zapytań
faktycznie wysyłanych przez trasy (z kursorem): brak `Seq Scan` na tabeli listy.
Zapytanie `GET /api/documents` łączy `document_status_events` bezpośrednio zamiast
widoku `document_current_status` (ten sam wynik, bo najwyżej jedno zdarzenie na
dokument), żeby planer mógł użyć indeksu.

## Listy o stałym limicie z jawnym `truncated`

Tam, gdzie kursor nie ma sensu (krótkie rejestry, widok publiczny), serwer pobiera
o jeden wiersz więcej niż pokazuje i zwraca `truncated: true`, gdy lista jest
niepełna; panel wtedy pokazuje komunikat o obcięciu:

| Trasa | Pokazane | Pole |
| --- | --- | --- |
| `GET /api/meetings/shared-minutes` | 200 najnowszych | `truncated` |
| `GET /api/admin/access-review?schoolYearId=` | 500 przydziałów | `truncated` |

Przegląd dostępu zwraca przydziały roku oraz aktywne przydziały `principal` bez roku
szkolnego (sprzed wymogu roku, 2026-10-02) — te ostatnie w przeglądzie każdego roku, z
`schoolYearId: null`, `proposal: revoke` i `reason: year_scope_required`. Odpowiedź ma ten
sam kształt co dotąd (bez nowych pól); nic nie jest odbierane automatycznie.

Kanał `GET /api/public/events.ics` nie ma kursora (format iCal nie niesie sygnału
obcięcia): zwraca najwyżej `limit` (domyślnie 200) najbliższych wydarzeń. Pełną
listę daje `GET /api/public/events` z kursorem.

`GET /api/ledger/reviews` (#159) miał wcześniej `LIMIT 20000` bez sygnału; domyślna
strona to teraz 500 wierszy, a klient czytający tylko `reviews` ma sprawdzić
`truncated`. Żaden panel w repozytorium nie woła tej trasy (tylko API), więc
przycisku „Pokaż więcej” nie ma.

Panel zebrań dociąga kolejne strony `GET /api/meetings`, dopóki jest `nextCursor`.

## Monitoring kolejki kodów weryfikacyjnych (#140 pkt 5)

Trasy się nie zmieniają (nowych ścieżek nie ma; od #160 etapu 6 kształt `GET /api/email/worker-status` opisuje
schemat `EmailWorkerStatus`, dwa pozostałe odczyty nie mają jeszcze schematów odpowiedzi, patrz „Schematy żądań
i odpowiedzi” niżej). Zmieniły się kształty trzech odczytów
techniczno-operacyjnych; wszystkie niosą wyłącznie liczby, znaczniki czasu i kody — bez adresów,
kodów weryfikacyjnych, skrótów i identyfikatorów wniosków:

| Odczyt | Nowe pola |
|---|---|
| `GET /health/jobs` (token) | nazwa progu `guardian_verify_queue_too_old` w `failedThresholds`; kod czekający w kolejce włącza też `email_worker_stale` (ten sam worker) |
| `GET /api/admin/ops-status` (admin) | `guardianVerifyQueue`: `queued`, `sending`, `oldestPendingAt` (`created_at` najstarszego `queued`), `overdue`; `null`, gdy tabeli nie ma (baza sprzed 0184) |
| `GET /api/email/worker-status?schoolYearId=` (zarząd, skarbnik) | `guardianVerifications`: `enabled`, `queued`, `sending`, `oldestQueuedAt` (`null`, gdy brak tabeli); alarm `guardian_verify_queue_stale` w `alarms`; czekający kod liczy się dla alarmów `worker_*` jak kampania do wysyłki |

Próg: `GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS` (domyślnie 2 h, niepoprawna wartość = domyślna); alarm
`worker-status` używa progu `EMAIL_WORKER_ALARM_HOURS`. Przy wyłączonej fladze
`GUARDIAN_VERIFY_EMAIL_ENABLED` w procesie aplikacji liczby są widoczne, ale `overdue`/progi/alarmy
nie włączają się (wiersze w kolejce czekają celowo). Liczby kolejki kodów są ogólnoszkolne (kolejka
nie należy do roku szkolnego), jak przebiegi zadania w `worker-status`. Szczegóły: docs/EMAIL.md,
docs/RAILWAY_OPERATIONS.md („Stan systemu”).

## Poza zakresem (nadal ograniczone)

Cztery listy wymienione tu wcześniej jako ograniczone (lista wyłączeń e-mail,
lista „do sprawdzenia” kampanii, odbiorcy kampanii i rejestr żądań osób) mają od
#543 kursor keyset — są w tabeli wyżej (testy
`tests/pg-list-cursor-email-requests.test.js`). Lista, której tabela nie
wymienia, nie jest objęta tym kontraktem — zakres sprawdzać w module trasy.

## Pole `capabilities` w `GET /api/session` (D-09, #137)

Odpowiedź sesji ma dodatkowe, opcjonalne pole `capabilities`, którego panele używają
wyłącznie do pokazania interfejsu (nawigacja i widok tylko do odczytu):

| Pole | Kiedy `true` | Gdy brak |
| --- | --- | --- |
| `capabilities.auditLedgerRead` | konto z rolą `audit` (przydział bez klasy, potwierdzone MFA) i włączona flaga `AUDIT_LEDGER_READ` | cały obiekt `capabilities` jest pominięty |

Dla pozostałych kont (także `audit` przy fladze wyłączonej) pole nie występuje, więc
odpowiedź nie zdradza konfiguracji serwera, a kształt sesji pozostaje jak dotąd
(`sessionId`, `user`, `expiresAt`, `mfaVerified`, `writeMode`). Pole niczego nie
odblokowuje: trasy księgi i dokumentów autoryzuje serwer przy każdym żądaniu
(`docs/AUTHORIZATION.md`, „Zakres roli audit”). Od #160 etapu 3 kształt sesji (z opcjonalnym
`capabilities`) opisuje schemat `Session` w `docs/openapi.json` (`src/pg/schemas/session.js`).

## Schematy żądań i odpowiedzi (OpenAPI, #160, etapy 2-8)

`docs/openapi.json` (OpenAPI 3.1) jest generowany poleceniem `npm run openapi:build` (sprawdzenie bez
zapisu: `npm run openapi:build -- --check`) z trzech źródeł: macierzy tras
(`tests/helpers/route-matrix.js`: ścieżki, metody, role, MFA, statusy), katalogu kodów
(`docs/API_ERRORS.md`) i **schematów ręcznie pisanych obok tras** w `src/pg/schemas/<moduł>.js`.
Plik nie jest edytowany ręcznie; role w `x-rd-roles` pozostają założeniami D-08/D-09 do zatwierdzenia.

Schemat modułu eksportuje `name`, `components` (schematy współdzielone) i `routes`:
`{ 'POST /api/payments': { body, idempotencyKey, query, responses, errors } }`. Generator dołącza do
operacji `requestBody` (JSON z `body`; ciało inne niż JSON — od etapu 8 surowe bajty przesyłanego dokumentu — z mapy
`bodyContent` typ treści → schemat), parametry (zapytanie, `Idempotency-Key`), odpowiedzi sukcesu z kształtem
(200 odtworzenia i 201 zapisu, z nagłówkiem `Idempotency-Replayed`; `replayed` może być listą `['false', 'true']`,
gdy ten sam status zwraca obie wartości — od etapu 5 zatwierdzenie, porzucenie i cofnięcia uzgodnień; zapis bez klucza,
który wysyła nagłówek `true` tylko przy ponowieniu, ma w specyfikacji nagłówek z `required: false` — helper
`replayedOnRetry`, etap 6; eksporty CSV/XLSX, plik kalendarza `.ics` i treść dokumentu z typem pliku;
trasa z kilkoma formatami wybieranymi parametrem `format` ma mapę `content` typ treści → schemat, helper
`formatsResponse` w `src/pg/schemas/common.js`; wpis bez `schema`, np. `204` wylogowania, nie ma treści) oraz `x-rd-error-codes` — kody błędów danej trasy
per status, wyłącznie z katalogu. Pusta lista kodów oznacza status, który macierz tras przypisuje operacji,
ale trasa go nie zwraca (dziś: `403` przy `GET /api/session` i `GET /api/access`, patrz niżej). Wspólne
elementy (`Id`, kwoty w eurocentach, daty) są w `src/pg/schemas/common.js`. Schematy odpowiedzi są ścisłe
(`additionalProperties: false`): nowe pole w odpowiedzi trasy wymaga świadomej zmiany schematu;
schematy żądań nie zakazują nieznanych pól (trasy je ignorują).

Pilnują tego `tests/openapi-contract.test.js`, `tests/openapi-contract-families.test.js`,
`tests/openapi-contract-ledger-extra.test.js`, `tests/openapi-contract-reconciliation.test.js`,
`tests/openapi-contract-email.test.js`, `tests/openapi-contract-meetings.test.js` i `tests/openapi-contract-documents.test.js`
(opis w `docs/TESTING.md`): każda trasa pokrytego modułu ma
schemat, a **prawdziwe odpowiedzi** tras (utworzenie, ponowienie z tym samym kluczem, korekta częściowa, lista
z kursorem, karta gospodarstwa z rodzeństwem i opieką dzieloną, sesja przed i po MFA, wersje linii preliminarza
i przypisania do centrów kosztów, bilans otwarcia z poprawkami, import wyciągów JSON/CSV/CODA/CAMT.053,
dopasowania z cofnięciem, raport Komisji Rewizyjnej, zebranie z porządkiem obrad, zawiadomieniem, obecnością,
uchwałami i protokołem, dokumenty z opisem, zastąpieniem, unieważnieniem i treścią po autoryzacji, zamknięty rok,
odmowy i błędy) przechodzą
walidację tymi schematami. Schematy opisują obecny kontrakt
tras; nie są jeszcze używane do walidacji wejścia po stronie serwera (parsery pozostają źródłem prawdy).

| Stan | Moduły |
| --- | --- |
| Pokryte (157 z 297 operacji) | etap 2 (32): `payments`, `payment-references`, `payment-instructions`, `ledger`; etap 3 (16): `families` (13), `session` (3); etap 4 (15): `ledger-budget` (6), `ledger-cash` (5), `ledger-cost-centers` (4); etap 5 (14): `reconciliation` (13 tras uzgodnień i `GET /api/reports/audit`); etap 6 (30): `email`; etap 7 (28): `meetings`; etap 8 (22): `documents` |
| Jeszcze bez schematów (`UNCOVERED_MODULES` w `src/pg/schemas/index.js` i `x-rd-schema-coverage` w specyfikacji) | `admin`, `audit-history`, `audit-reviews`, `board`, `events`, `exports`, `financial-reports`, `guardian-updates`, `import`, `login`, `mfa`, `news`, `print`, `privacy-notice`, `representative`, `year-close` |

Cechy modułów etapu 3, które schematy odwzorowują wprost (opis stanu, nie zmiana tras):

- `families`: zapisy **nie** używają `Idempotency-Key` — ponowienie tej samej zmiany (podwójne kliknięcie)
  zwraca `200` z `changed: false` bez drugiego wpisu historii (dodanie członkostwa i nowe przypisanie do klasy:
  `201` przy zapisie, `200` przy ponowieniu). Listy klas i uczniów klasy nie są stronicowane (bez kursora).
  Zakres klasowy dostaje węższy kształt karty gospodarstwa: bez `isPrimaryHousehold`, bez `isPrimary` przy
  gospodarstwach i bez `paymentTotals` (te pola są w schemacie opcjonalne). Obiekt poza zakresem i błędny
  identyfikator w ścieżce dają `404 not_found` jak nieistniejący.
- `session`: logowanie (`login`) i MFA (`mfa`) są osobnymi modułami, jeszcze bez schematów. Macierz tras
  przypisuje `GET /api/session` i `GET /api/access` status odmowy `403`, choć trasy są dostępne dla każdego
  zalogowanego i zwolnione z bramki MFA, więc `403` nie występuje (stąd pusta lista kodów).

Cechy modułów etapu 4 (preliminarz, kasa, centra kosztów — opis stanu, nie zmiana tras):

- `GET /api/ledger/budget/execution` (`format` = `json`, `csv`, `xlsx`, `html`) i `GET /api/ledger/cost-centers`
  (`format` = `json`, `csv`, `xlsx`) mają w specyfikacji po jednym schemacie na format odpowiedzi `200`;
  `csv`, `xlsx` i `html` zestawienia preliminarza zapisują zdarzenie eksportu w dzienniku.
- Wszystkie zapisy wymagają `Idempotency-Key` (ponowienie: `200`, `Idempotency-Replayed: true`). Bilans
  otwarcia (`POST /api/ledger/opening-balance`) odtwarza zapis tylko dla tego samego klucza i autora; ten sam
  rok innym kluczem to `409 opening_balance_exists`, a ten sam klucz z inną treścią `409 idempotency_conflict`.
- Kilka odpowiedzi `409` niesie pole ponad `error` (schemat `Error` je dopuszcza): `budget_line_superseded`
  z `currentLineId`, `allocation_version_conflict` z `currentVersionId`; `422` bramki danych osobowych
  z `categories`.
- Odczyty nie są stronicowane (pełna historia wersji, przeniesień i przypisań roku). Bilans otwarcia bez zapisu
  zwraca `openingBalance: null`, `adjustments: []`, `current: null`; bilans przeniesiony zamknięciem roku ma
  `carriedFromSchoolYearId`. Kwota kasy w bilansie (`cashCents`) jest w schemacie liczbą ze znakiem, bo bilans
  przeniesiony z zamknięcia roku kopiuje stan kasy; ręczny bilans przyjmuje tylko `cashCents ≥ 0`.

Cechy modułu etapu 5 (uzgodnienia wyciągów i raport Komisji Rewizyjnej — opis stanu, nie zmiana tras):

- Moduł `reconciliation` w macierzy tras obejmuje też `GET /api/reports/audit` (`format` = `json`, `xlsx`, `html`;
  w specyfikacji schemat na każdy typ treści). Raport ma ścisły schemat `AuditReport` ze wszystkimi sekcjami
  (bilans, kategorie, preliminarz `LedgerBudgetExecution`, wydatki ponad próg, wyniki wydarzeń, uchwały, weryfikacje,
  korekty, przeksięgowania, poprawki bilansu, uzgodnienia, pięć kontroli krzyżowych, dowody, operacje na kontach,
  ścieżka kontroli KR). Nazwy komponentów raportu mają przedrostek `AuditReport`, żeby nie zderzyć się z przyszłym
  schematem modułu `audit-reviews`.
- Zapisy z kluczem (`POST /api/reconciliations`, `…/lines`, `…/lines/{lineId}/payment`, `…/matches`,
  `…/matches/batch`, `…/group-matches`): `201` z `Idempotency-Replayed: false`, ponowienie `200` z `true`.
  Zatwierdzenie, porzucenie i oba cofnięcia nie mają klucza: zwracają `200` z `Idempotency-Replayed: false` przy
  pierwszym wykonaniu i `200` z `true` przy ponowieniu tej samej osoby z tą samą treścią (stąd lista w `replayed`).
- Import (`…/lines`) ma różne kształty: lista JSON i CSV — `{ import, possibleDuplicateCount }`; plik CODA/CAMT.053 —
  `{ import, skippedDuplicateCount, skippedDuplicates, warnings, fileBalances }`. Ponowienie po kluczu zwraca węższy
  kształt (`{ import }`, a przy pliku `{ import, skippedDuplicateCount }`). Plik, którego wszystkie ruchy są już
  zaimportowane, daje `200` z `Idempotency-Replayed: false`, `import: null` i `lineCount: 0` (bez nowej paczki).
  Brak konfiguracji importu z pliku to `503 bank_import_not_configured`; kody błędów parserów (`src/pg/bank/*.js`)
  są w schemacie tej trasy, a test kontraktu szuka ich także w tych plikach.
- `GET /api/reconciliations/{id}` stronicuje `lines` kursorem (`limit` 1-500, `nextCursor` ważny tylko dla tego
  uzgodnienia), a `unmatchedLedgerEntries` obcina do 1000 z `unmatchedLedgerEntriesTruncated: true`. Lista uzgodnień
  roku nie jest stronicowana. Odpowiedzi nie zawierają tytułów przelewów (tylko `hasReference`).
- Pole `paymentRefundId` powiązania (i `match` pozycji) występuje wyłącznie przy dopasowaniu zwrotu (#138), w
  schemacie jest opcjonalne. Kandydat propozycji to `oneOf`: wpis księgi lub wpłata albo `household` (nowa wpłata
  dla gospodarstwa z komunikacji strukturalnej; `date` i `dayDistance` = null).
- Kilka odpowiedzi błędu niesie pola ponad `error` (schemat `Error` je dopuszcza): `match_batch_rejected` z
  `failures`, `inconsistent_matches` z `matches` i `groupMatches`, `group_match_sum_mismatch` z kwotami,
  `matched_in_other_reconciliation` i `statement_already_imported` z identyfikatorami (tylko dla osoby z dostępem
  do roku), `reconciliation_has_active_matches` z `activeMatchCount`, błędy pozycji z `line` albo `record`.
- Brak MFA: zarząd i skarbnik zatrzymuje bramka routera (`mfa_enrollment_required`/`mfa_required`); trasy
  uzgodnień dla pozostałych ról zwracają ogólne `forbidden`, a raport KR rozróżnia kody MFA także dla roli `audit`.

Cechy modułu etapu 6 (`email`, kampanie e-mail — opis stanu, nie zmiana tras):

- `Idempotency-Key` mają tylko szkic kampanii, kampania uzupełniająca, wysyłka testowa i wpis ewidencji limitu
  (`201` z `Idempotency-Replayed: false`, ponowienie `200` z `true`). Zatwierdzenie, kolejka, pauza, wznowienie,
  anulowanie i zdjęcie pauzy dostawcy nie mają klucza: pierwsze wykonanie zwraca `200` **bez** nagłówka, a ponowienie
  rozpoznane po stanie obiektu — `200` z `true` (w specyfikacji nagłówek `required: false`). Rozstrzygnięcie wiersza
  „do sprawdzenia” i jego zatwierdzenie: `201` bez nagłówka, ponowienie `200` z `true`; wniosek o zdjęcie blokady:
  `201`, ponowienie `200`, bez nagłówka; `PUT` kampanii: zawsze `200` (ta sama treść = odtworzenie). Ponowienie szkicu
  uzupełniającego zwraca samo `campaign`, bez `eligibleHouseholds` i `pendingApprovals` z odpowiedzi `201`.
- Migawka i kolejka: jedna wiadomość na rodzinę (klucz `campaign:<id>:household:<id>`, dla kont `…:user:<id>`);
  rodzeństwo i dwoje opiekunów jednej rodziny dostają jedną wiadomość (kontakt główny), adres użyty już dla innej
  rodziny — wykluczenie `duplicate_address`. Wysyłka do obojga opiekunów wymaga decyzji D-17 (`docs/EMAIL.md`).
- Listy kampanii, odbiorców, „do sprawdzenia”, wyłączeń i ewidencji limitu mają kursor (`limit`, `cursor` →
  `nextCursor`, `truncated`, `limit`). Lista odbiorców zawiera pełny adres (weryfikacja przed zatwierdzeniem,
  odczyt w dzienniku); lista „do sprawdzenia”, lista wyłączeń i próbka podglądu — wyłącznie adres maskowany.
- Mapy liczników (`exclusions`, `outbox`, `staleRecipients`, `lastProviderEvent`, `resolutions`) mają zamknięty słownik
  kluczy: nowy powód wykluczenia albo stan kolejki wymaga świadomej zmiany schematu.
- `POST …/test-send` może zwrócić `502` z kodem błędu transportu dostawcy (`src/email/brevo.js`, np.
  `provider_rejected_400`); te kody nie należą do katalogu `docs/API_ERRORS.md`, więc specyfikacja tego statusu
  nie opisuje (rozbieżność do uporządkowania osobno). Webhook i wypisanie są publiczne: `401 invalid_signature`,
  `503 webhook_not_configured` i `429 rate_limited` są w specyfikacji jako kody tych tras.
- `409 school_year_closed` (zamknięty rok, trigger zamrożenia) jest w schematach zapisów kampanii, ale nie w teście
  kontraktu (reakcję triggera sprawdzają testy zamknięcia roku).

Cechy modułu etapu 7 (`meetings`, zebrania — opis stanu, nie zmiana tras):

- `Idempotency-Key` (wymagany) mają: utworzenie zebrania, punkt porządku obrad, ustalenie quorum, wersja protokołu,
  widoczność protokołu, uchwała, korekta uchwały i zdarzenie wykonania uchwały (`201` z `Idempotency-Replayed: false`,
  ponowienie `200` z `true`). Szkic zawiadomienia i szkic kampanii z zawiadomienia nie mają klucza, ale odpowiadają tak
  samo (ponowienie rozpoznane po stanie: ten sam szkic, istniejąca kampania). Zatwierdzenie protokołu, odwołanie, zmiana
  terminu, wycofanie punktu, zmiana kolejności i zatwierdzenie zawiadomienia zwracają zawsze `200` **bez** nagłówka,
  a ponowienie sygnalizuje pole `replayed` w treści; `PATCH` zebrania i uchwały oraz zapis obecności — `200` bez nagłówka
  i bez `replayed`. `PATCH` zebrania i uchwały, odwołanie i zmiana terminu wymagają `revision` (`400 invalid_revision`,
  `409 revision_conflict`).
- Odmowy reguł bazy (blokada zebrania po zatwierdzeniu protokołu, odwołanie, quorum, uchwały, numer wersji) przechodzą
  jako `409` z kodem reguły (`DATABASE_CONFLICTS` w `src/pg/meetings.js`, np. `meeting_locked`,
  `minutes_open_resolutions` z `openResolutions`, `resolution_quorum_check_stale`); od etapu 7 te kody i identyfikatory
  ścieżki (`invalid_meeting_id`, `invalid_minutes_id`, `invalid_resolution_id`, `invalid_notice_id`,
  `invalid_agenda_item_id`) są w `docs/API_ERRORS.md` i w `shared/messages.js` (detektor kodów zna listę
  `DATABASE_CONFLICTS` i `requireId(…, 'kod')`). `409 resolution_number_taken` niesie `suggestedNumber`, `422` bramki
  danych osobowych — `categories`, `409 invalid_notice_content` — `field` (schemat `Error` dopuszcza pola ponad `error`).
- Zebranie poza zakresem: odczyt (`GET` zebrania, lista kontrolna, plik kalendarza) → `404 meeting_not_found` jak brak
  zebrania; zapis → `403 forbidden`. Komisja Rewizyjna i dyrekcja (`principal`, bez MFA) czytają zebranie z listą
  obecności (wyłącznie identyfikatory, D-09), rejestr uchwał i listę kontrolną; każdy zapis — `403 forbidden`.
  Wymóg MFA modułu (`403 mfa_required`, #150) widać tylko wtedy, gdy bramka routera przepuści sesję bez MFA (rola spoza
  `MFA_REQUIRED_ROLES`); zarząd bez czynnika zatrzymuje wcześniej `403 mfa_enrollment_required`.
- Kształty: `GET /api/meetings/{id}` zwraca jeden obiekt z porządkiem (także wycofanymi punktami), obecnością,
  ustaleniami quorum, wszystkimi wersjami protokołu, wszystkimi rewizjami uchwał, wersjami porządku, zmianami terminu
  i zawiadomieniami. Przedstawiciel-gospodarz zebrania klasowego (flaga `MEETINGS_CLASS_HOST`, #171) dostaje ten sam
  kształt z `null` w polach wewnętrznych (powód i autor odwołania, powody i autorzy zmian terminu, kampania i autorzy
  zawiadomień). Szkic kampanii z zawiadomienia zwraca `{ campaign: { id, status, audience, classId }, sent: false }`
  (`all_households`, `class_households` z klasą, `meeting_invitees` dla zebrania zarządu); ponowienie zwraca bieżący
  status kampanii. Plik kalendarza: `text/calendar; charset=utf-8`.
- Listy: `GET /api/meetings` (`limit` 1-500) i `GET /api/meetings/public-notices` (`limit` 1-200) mają kursor; protokoły
  udostępnione i publiczne obcinają do 200 z `truncated`; rejestr uchwał nie jest stronicowany.
- Rozbieżności z dokumentacją (opis, trasy bez zmian): `effectiveStatus` w rejestrze uchwał dla uchwały nieprzyjętej
  to kopia `status` (`draft`, `rejected`, `withdrawn`), a nie tylko `in_force`/`amended`/`repealed` z
  `docs/MEETINGS.md`; wyszukanie po numerze (`…/resolutions/lookup`) nie zwraca `revisionNo` (widok
  `resolution_current` nie ma tej kolumny). Macierz tras ma dla `POST /api/meetings/resolutions/{id}/execution`
  `mfa: false`, choć trasa wymaga MFA jak każde zarządzanie zebraniem (`meetingForManage`).
- `409 school_year_closed` (zamknięty rok) jest w schematach zapisów i w teście kontraktu — rok zamykają trasy
  `year-close`; zamknięcie wygasza przydziały roku, więc zapis próbuje zarząd z przydziałem bez roku.

Cechy modułu etapu 8 (`documents`, prywatne dokumenty Rady i dowody finansowe — opis stanu, nie zmiana tras):

- Macierz tras rozdziela jedną trasę serwera `/api/documents/{id}` (z `/content`, `/description`, `/supersede`, `/void`) na
  cztery rodzaje dokumentu z osobnym parametrem ścieżki (`{financialDocumentId}`, `{boardDocumentId}`, `{classDocumentId}`,
  `{council_sharedDocumentId}`), więc specyfikacja ma 20 operacji dla 5 tras serwera (razem z listą i przesłaniem — 22).
  Schemat jest ten sam dla każdego rodzaju; odczyt metadanych przypina `document.kind` do rodzaju ścieżki. Rodzaj nie
  pochodzi z żądania: serwer czyta go z bazy (klient kontraktu wybiera szablon opcją `template`).
- Przesłanie (`POST /api/documents?kind=…&schoolYearId=…[&classId=…][&linkedEntityType=…&linkedEntityId=…]`): ciało to
  **surowe bajty pliku** (`application/pdf`, `image/png`, `image/jpeg` — `requestBody` z trzema typami treści i schematem
  `string`/`binary`), nie JSON ani multipart; typ musi zgadzać się z sygnaturą, a plik przejść kontrolę struktury
  (`415 unsupported_media_type`, `document_active_content`, `document_malformed`); `413 document_too_large` po limicie
  `DOCUMENT_MAX_BYTES`, `400 empty_document`, `503 upload_busy` (z `Retry-After`) i `503 storage_unavailable` bez odczytu ciała.
  Dowód `financial` może wskazywać wpis księgi albo wpłatę tego samego roku (`linkedEntityType`, `400 invalid_link`).
- Treść (`GET …/content`): odpowiedź `200` to plik o typie z bazy, opisany w specyfikacji typem treści bez schematu JSON
  (jak eksporty wpłat; `string`/`binary` dla każdego z trzech typów). Każde żądanie przechodzi autoryzację (sesja, rola, MFA,
  rok, klasa) — nie ma adresu z tokenem ani podpisanego linku; wygasła sesja daje `401`. `?disposition=inline` tylko dla
  obrazów (PDF → `400 pdf_inline_not_allowed`, #705), `?purpose=preview` wydaje bajty PDF do PDF.js jako załącznik po ponownej
  kontroli struktury (`409 document_preview_blocked`); inna wartość → `400 invalid_disposition`. Brak obiektu w buckecie to
  `409 document_content_missing`, niezgodny rozmiar lub SHA-256 — `503 service_unavailable`.
- Zapisy (przesłanie, opis, zastąpienie, unieważnienie) wymagają `Idempotency-Key`, ale **nie** wysyłają nagłówka
  `Idempotency-Replayed`: zapis zwraca `201`, a ponowienie — `200` z polem `replayed: true` w treści (przesłanie i opis: ten
  sam klucz i treść; zastąpienie i unieważnienie także ta sama zmiana innym kluczem). Brak klucza to
  `400 idempotency_key_required` (inne moduły: `invalid_idempotency_key`), a zły typ treści zapisu JSON — `400
  invalid_content_type` (inne moduły: `415`).
- Odczyt i zapis dokumentu poza zakresem, brak MFA modułu dla `financial` i nieznany identyfikator dają to samo
  `404 not_found`; przesłanie poza zakresem — `403 forbidden`. `403` przy odczycie dokumentu to wyłącznie bramka MFA routera
  (`mfa_enrollment_required`/`mfa_required`), której macierz tras nie wymienia w `x-rd-deny-status` (tam tylko `404`).
  Komisja Rewizyjna za flagą `AUDIT_LEDGER_READ` czyta listę, metadane (z `description: null` w historii opisu) i treść
  dowodów `financial` z kategorii bez danych płatników, niepowiązanych z wpłatą; bez MFA lista daje `403
  mfa_enrollment_required`/`mfa_required`, bez flagi — `403 forbidden` i `404`.
- Lista ma kursor (`limit` 1-100, `cursor` → `nextCursor`, `truncated`; przy `sort=documentDate` stronicuje przestarzały
  `offset`, a `nextCursor` jest zawsze `null`); filtry `from`, `to` i `validation` też należą do zakresu kursora (tabela
  list z kursorem wyżej wymienia tylko część filtrów).
- **Zamknięty rok** (trasy `year-close`): przesłanie, opis i zastąpienie dają `409 school_year_closed`; unieważnienie
  pozostaje możliwe (`201`, wariant zachowawczy do D-04/D-07, docs/DOCUMENTS.md), odczyt treści działa.
- Rozbieżności z dokumentacją (opis, trasy bez zmian): `docs/API_ERRORS.md` wymienia `document_integrity_mismatch`, ale
  klient go nie dostaje (wyjątek trasy zamienia router na `503 service_unavailable`, jak opisuje docs/DOCUMENTS.md);
  `400 document_preview_unsupported` jest nieosiągalne dla dokumentów przesłanych przez API (ograniczenie `documents_api_row`
  dopuszcza tylko typy podglądu) — kod jest w schemacie jako obrona; `413 request_too_large` przesłania zwraca serwer Node
  przed trasą (`Content-Length` ponad limit), więc test kontraktu na PGlite go nie osiąga; docs/DOCUMENTS.md pisze o `404`
  przy braku MFA dla `financial`, a zarząd i skarbnik bez czynnika dostają wcześniej `403` bramki routera.

Kolejny moduł obejmuje się, dodając plik schematów, wpisując go do `SCHEMA_MODULES`, usuwając z
`UNCOVERED_MODULES` i uruchamiając `npm run openapi:build`; test nie pozwala, by lista niepokrytych rosła.

