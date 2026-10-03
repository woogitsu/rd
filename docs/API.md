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

## Schematy żądań i odpowiedzi (OpenAPI, #160, etapy 2-13)

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
per status, wyłącznie z katalogu (od etapu 11 wpis `errorDescriptions` nadaje błędowi opis właściwy trasie, np. `401`
logowania to złe dane logowania, a nie brak sesji; kody przy statusie wspólnej odpowiedzi `Unauthenticated` generator
odrzuca). Pusta lista kodów oznacza status, który macierz tras przypisuje operacji,
ale trasa go nie zwraca (dziś: `403` przy `GET /api/session`, `GET /api/access`, `GET /api/auth/state` i
`GET /api/sessions`, patrz niżej). Pola tajne żądań (hasło, token zaproszenia i resetu, kod MFA) mają `writeOnly: true`. Wspólne
elementy (`Id`, kwoty w eurocentach, daty) są w `src/pg/schemas/common.js`. Schematy odpowiedzi są ścisłe
(`additionalProperties: false`): nowe pole w odpowiedzi trasy wymaga świadomej zmiany schematu;
schematy żądań nie zakazują nieznanych pól (trasy je ignorują).

Pilnują tego `tests/openapi-contract.test.js`, `tests/openapi-contract-families.test.js`,
`tests/openapi-contract-ledger-extra.test.js`, `tests/openapi-contract-reconciliation.test.js`,
`tests/openapi-contract-email.test.js`, `tests/openapi-contract-meetings.test.js`, `tests/openapi-contract-documents.test.js`,
`tests/openapi-contract-events.test.js`, `tests/openapi-contract-news.test.js`, `tests/openapi-contract-auth.test.js`,
`tests/openapi-contract-admin.test.js` i `tests/openapi-contract-reports.test.js` (opis w `docs/TESTING.md`): każda trasa pokrytego modułu ma
schemat, a **prawdziwe odpowiedzi** tras (utworzenie, ponowienie z tym samym kluczem, korekta częściowa, lista
z kursorem, karta gospodarstwa z rodzeństwem i opieką dzieloną, sesja przed i po MFA, wersje linii preliminarza
i przypisania do centrów kosztów, bilans otwarcia z poprawkami, import wyciągów JSON/CSV/CODA/CAMT.053,
dopasowania z cofnięciem, raport Komisji Rewizyjnej, zebranie z porządkiem obrad, zawiadomieniem, obecnością,
uchwałami i protokołem, dokumenty z opisem, zastąpieniem, unieważnieniem i treścią po autoryzacji, wydarzenia od szkicu
do publikacji i odwołania z zadaniami wolontariuszy, zapisami i widokiem publicznym, aktualności z galerią — zgody na
wizerunek, weryfikacja, cofnięcie praw, plik zdjęcia i widok publiczny tylko z zatwierdzonymi danymi, logowanie hasłem
z limitem prób, zaproszenia, reset i zmiana hasła, zapis i weryfikacja MFA z kodami odzyskiwania, sesje własne,
administracja kont i ról z czterema oczami, przeglądem dostępu, dziennikami i żądaniami osób, historia obiektu, ścieżka
kontroli KR, sprawozdanie roczne z migawkami, eksport roczny i lista klasy, kartki, pulpity zarządu i przedstawiciela,
zamknięty rok, odmowy i błędy) przechodzą
walidację tymi schematami. Schematy opisują obecny kontrakt
tras; nie są jeszcze używane do walidacji wejścia po stronie serwera (parsery pozostają źródłem prawdy).

| Stan | Moduły |
| --- | --- |
| Pokryte (274 z 297 operacji) | etap 2 (32): `payments`, `payment-references`, `payment-instructions`, `ledger`; etap 3 (16): `families` (13), `session` (3); etap 4 (15): `ledger-budget` (6), `ledger-cash` (5), `ledger-cost-centers` (4); etap 5 (14): `reconciliation` (13 tras uzgodnień i `GET /api/reports/audit`); etap 6 (30): `email`; etap 7 (28): `meetings`; etap 8 (22): `documents`; etap 9 (15): `events`; etap 10 (21): `news`; etap 11 (13): `login` (6), `mfa` (7); etap 12 (46): `admin`; etap 13 (22): `audit-history` (4), `audit-reviews` (5), `financial-reports` (6), `exports` (2), `print` (1), `board` (3), `representative` (1) |
| Jeszcze bez schematów (`UNCOVERED_MODULES` w `src/pg/schemas/index.js` i `x-rd-schema-coverage` w specyfikacji) | `guardian-updates`, `import`, `privacy-notice`, `year-close` |

Cechy modułów etapu 3, które schematy odwzorowują wprost (opis stanu, nie zmiana tras):

- `families`: zapisy **nie** używają `Idempotency-Key` — ponowienie tej samej zmiany (podwójne kliknięcie)
  zwraca `200` z `changed: false` bez drugiego wpisu historii (dodanie członkostwa i nowe przypisanie do klasy:
  `201` przy zapisie, `200` przy ponowieniu). Listy klas i uczniów klasy nie są stronicowane (bez kursora).
  Zakres klasowy dostaje węższy kształt karty gospodarstwa: bez `isPrimaryHousehold`, bez `isPrimary` przy
  gospodarstwach i bez `paymentTotals` (te pola są w schemacie opcjonalne). Obiekt poza zakresem i błędny
  identyfikator w ścieżce dają `404 not_found` jak nieistniejący.
- `session`: logowanie (`login`) i MFA (`mfa`) są osobnymi modułami (schematy od etapu 11, niżej). Macierz tras
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

Cechy modułu etapu 9 (`events`, wydarzenia, zadania i zapisy wolontariuszy — opis stanu, nie zmiana tras):

- Specyfikacja obejmuje 15 operacji z macierzy tras: lista roku, utworzenie, odczyt i zmiana wydarzenia, cztery kroki przebiegu
  (`submit`, `approve`, `publish`, `cancel`), zadania (lista, opiekunowie do formularza, utworzenie, odwołanie), zapisy (zapis,
  wycofanie) i `GET /api/public/events`. Moduł obsługuje jeszcze `GET /api/public/events.ics`, `GET /api/public/events/{id}.ics`
  i `GET /api/public/events/{id}/tasks` (publiczne, bez logowania), których **nie ma w macierzy tras**, więc nie ma ich też w
  `docs/openapi.json` (generator bierze ścieżki z macierzy). „Wynik wydarzenia” (rozliczenie kosztów i wpływów) nie należy do
  tego modułu: to `GET /api/ledger/cost-centers/events/{eventId}` (`ledger-cost-centers`, etap 4) i sekcja raportu KR (etap 5).
  Schemat `EventStatus` jest wspólny z `ledger-cost-centers`.
- `Idempotency-Key` (wymagany) mają utworzenie wydarzenia, zadania i zapisu, ale **tylko utworzenie wydarzenia** wysyła
  `Idempotency-Replayed` (`201`/`false`, ponowienie `200`/`true`, ciało `{ event }` bez pola `replayed`). Zadanie i zapis
  odpowiadają `201`/`200` bez nagłówka, z polem `replayed` (`false`/`true`) w treści — jak dokumenty (etap 8). Ten sam klucz
  zadania z inną treścią → `409 idempotency_conflict`; zapis tej samej osoby do tego samego zadania jest powtórką niezależnie od
  klucza (konfliktu klucza nie ma). Wycofana osoba zapisana ponownie to ten sam wiersz (`201`, ten sam `id`, status `confirmed`).
- `PATCH`, kroki przebiegu, odwołanie zadania i wycofanie zapisu nie mają klucza: zawsze `200` bez nagłówka, ponowienie
  sygnalizuje `replayed: true`. `PATCH` i kroki wymagają `revision` (`400 invalid_revision`, `409 revision_conflict`); `PATCH`
  zwraca też `tasksOutsideEventTime`. Czasy wejściowe to czas lokalny Europe/Brussels (`ambiguous_local_time`,
  `nonexistent_local_time`, `offset_not_valid_in_europe_brussels`, `invalid_datetime`), odpowiedzi — czas lokalny z
  przesunięciem i UTC. Wycofanie zapisu nie czyta ciała (brak `requestBody`, brak `415`/`413`).
- Zatwierdzenie z tą samą osobą co autor wydarzenia albo wersji → `409 four_eyes_required` (zebrania: `403
  notice_four_eyes_required`/`minutes_four_eyes_required`). Publikacja wydarzenia wewnętrznego → `409 event_not_public`.
  Wymóg MFA modułu (`403 mfa_required`) przy zatwierdzeniu i publikacji widać tylko wtedy, gdy bramka routera przepuści sesję
  bez MFA; zarząd bez czynnika dostaje wcześniej `403 mfa_enrollment_required`.
- Wydarzenie spoza zakresu podglądu: każdy odczyt i zapis wydarzenia, jego zadań i zapisów → `404 event_not_found` jak nieznany
  identyfikator (SR-07); `403 forbidden` — lista roku, utworzenie poza zakresem (przedstawiciel: inna klasa albo wydarzenie
  ogólnoszkolne) i krok bez prawa przy widocznym wydarzeniu (zatwierdzenie i publikacja przez przedstawiciela lub admina,
  odwołanie opublikowanego przez przedstawiciela). Skarbnik, Komisja Rewizyjna, dyrekcja i zarząd z przydziałem klasy: lista
  `403`, wydarzenie `404`.
- Zły identyfikator zadania lub zapisu w ścieżce daje `400 invalid_event_id` (moduł nie ma osobnych kodów jak
  `invalid_meeting_id`/`invalid_agenda_item_id` w zebraniach). Zła data kalendarzowa w `from` listy publicznej (np.
  `2027-02-30`) daje `400 invalid_datetime`, zły zapis — `400 invalid_date`.
- Listy: tylko `GET /api/public/events` ma kursor (`limit` 1-200, domyślnie 100; `cursor` związany z filtrem roku i `from`).
  Wewnętrzna lista roku i lista zadań nie są stronicowane. `personName` zapisu jest wyłącznie w liście zadań (w schemacie
  opcjonalne). Widok publiczny czyta wyłącznie ostatnią **opublikowaną** wersję z odbiorcami `public`; `volunteerTasks` ma
  tylko nieodwołane zadania z `isPublic` (`{ id, title, stillNeeded }`), a dla odwołanego wydarzenia jest puste.
- **Zamknięty rok** (trasy `year-close`): utworzenie, zmiana, kroki przebiegu, odwołanie wydarzenia, nowe zadanie, odwołanie
  zadania, zapis i wycofanie zapisu → `409 school_year_closed`; odczyty i lista publiczna działają. Odwołanie zadania jest
  zamrożone od `postgres/migrations/0186_event_tasks_year_freeze_update.sql` (#80: trigger `a0_year_freeze` na `event_tasks`
  obejmuje `INSERT` i `UPDATE`; wcześniej tylko `INSERT` i odwołanie przechodziło z `200`).

Cechy modułu etapu 10 (`news`, aktualności i galeria z prawami do zdjęć — opis stanu, nie zmiana tras):

- Specyfikacja obejmuje 21 operacji z macierzy tras: wpisy (lista roku, szkic, odczyt z historią wersji, zmiana, `submit`,
  `approve`, `publish`, `withdraw`), rejestr zdjęć (lista, rejestracja, odczyt z odwołaniami do zgód, `consents`, `verify`,
  `revoke`, `file`), wycofanie jednej zgody (`POST /api/news-photo-consents/{consentDocumentRef}/withdraw`) i pięć tras
  publicznych (`GET /api/public/news`, `GET /api/public/news/{postId}`, `GET /api/public/school-years`,
  `GET /api/public/news-photos/{photoId}/web|thumb`). Lata z treściami publicznymi należą do tego modułu, choć obejmują też
  wydarzenia, zawiadomienia i protokoły.
- `Idempotency-Key` (wymagany) mają szkic wpisu, rejestracja zdjęcia i przesłanie pliku zdjęcia: `201` z
  `Idempotency-Replayed: false`, ponowienie `200` z `true` (plik: ten sam klucz albo te same bajty dla zdjęcia, które ma
  już warianty; inne bajty → `409 photo_file_exists`, korekta = nowe zdjęcie). Odwołanie do zgody nie ma klucza ani
  nagłówka: `201 { replayed: false }`, ten sam wpis ponownie `200 { replayed: true }`, inny pod tym samym numerem
  `409 consent_conflict`. `PATCH`, kroki przebiegu, weryfikacja, cofnięcie praw i wycofanie zgody — zawsze `200` bez
  nagłówka, z polem `replayed`. Weryfikacja wymaga ciała `{}` (puste ciało → `400 invalid_json`), wycofanie zgody nie czyta
  ciała.
- Przesłanie pliku: surowe bajty `image/png` albo `image/jpeg` (`requestBody` z dwoma typami treści), do 10 MiB
  (`413 photo_file_too_large`), typ zgodny z sygnaturą i strukturą (`415 unsupported_media_type`, `photo_file_malformed`),
  `400 empty_photo_file`, `503 upload_busy` (z `Retry-After`) i `503 storage_unavailable`. Odpowiedź to dwa warianty JPEG bez
  metadanych (`files[]`: `web`, `thumb`); oryginał nie jest przechowywany. Publiczny odczyt pliku: `image/jpeg` wyłącznie
  dla zdjęcia z `news_photo_is_public` (zweryfikowane, zgody obejmują `rada_website`, niewygasłe i niewycofane, opublikowana
  wersja niewycofanego wpisu); inaczej identyczne `404 photo_not_found`; niezgodny SHA-256 obiektu → `409
  photo_file_integrity_mismatch`, brak magazynu → `503 service_unavailable`.
- Widok publiczny czyta wyłącznie `public_news`: zdjęcie niezweryfikowane blokuje zatwierdzenie i publikację
  (`409 photo_rights_unverified`), zdjęcie ze zgodą bez zakresu `rada_website` jest weryfikowalne, ale nie trafia do
  `photos[]` ani do publicznego pliku; wycofanie zgody i cofnięcie praw (`photo_revoked`) ukrywają zdjęcie przy następnym
  żądaniu (także w już opublikowanej wersji), a zmiana wpisu z cofniętym zdjęciem → `409 photo_revoked`. Tekst
  alternatywny (#124) jest w schemacie żądania rejestracji jako `anyOf` (`altText` albo `decorative: true`, inaczej
  `422 alt_text_required`); zdjęcie dekoracyjne ma publicznie `altText: ""`.
- Weryfikacja zdjęcia: cztery oczy (`409 four_eyes_required`), zdjęcie z dziećmi bez zgody dziecka (`409
  child_consent_required`) i zgody nie pokrywające rozpoznawalnych osób (`409 consent_missing`); po weryfikacji zgód nie
  można dopisać (`409 consents_locked`). Kody reguł bazy (`DB_ERRORS` w `src/pg/news.js`: `photo_rights_unverified`,
  `child_consent_required`, `consent_missing`) oraz kody z `reference(…)`/`count(…)` (`invalid_license_document_ref`,
  `invalid_identifiable_children`, `invalid_identifiable_adults`) są od etapu 10 w `docs/API_ERRORS.md` i w
  `shared/messages.js` — detektor kodów zna trójki `['komunikat', 'kod', status]` i te dwa helpery (przy okazji wykrył
  `next_school_year_not_open` i `year_close_not_in_progress` z mapowania błędów `year-close`, też dopisane).
- Bramka danych osobowych (#152): tytuł i treść wpisu (ze znanymi imionami i nazwiskami roku), powód wycofania, pola
  tekstowe zdjęcia (autor, opis źródła, licencja, notatka, `altText`) i powód cofnięcia praw → `422 personal_data_forbidden`
  albo `possible_personal_data` z `categories`.
- Wpis spoza zakresu (przedstawiciel innej klasy, zarząd z przydziałem klasy, Komisja Rewizyjna, dyrekcja, skarbnik): odczyt,
  zmiana i każdy krok → `404 post_not_found` jak nieznany (SR-07); lista roku i szkic poza zakresem → `403 forbidden`;
  krok bez prawa przy widocznym wpisie (zatwierdzenie i publikacja przez przedstawiciela lub admina, wycofanie
  opublikowanego przez przedstawiciela) → `403 forbidden`. Rejestr zdjęć (wszystkie trasy `news-photos` i wycofanie zgody)
  — wyłącznie admin i zarząd z przydziałem bez klasy (weryfikacja, cofnięcie i wycofanie zgody: tylko zarząd), inni → `403
  forbidden`. Wymóg MFA modułu (`403 mfa_required`) przy zatwierdzeniu i publikacji widać tylko wtedy, gdy bramka routera
  przepuści sesję bez MFA.
- Listy: `GET /api/public/news` (`limit` 1-50, domyślnie 20, kursor związany z filtrem roku) i `GET /api/news-photos` (`limit`
  1-200, domyślnie 200, kursor związany ze `status`) mają kursor; lista wpisów roku nie jest stronicowana.
- **Zamknięty rok** (trasy `year-close`): nowy wpis → `409 school_year_closed` (trigger `a0_year_freeze` na `INSERT` do
  `news_posts`, 0130); zmiana, przebieg i wycofanie istniejącego wpisu zamkniętego roku przechodzą — wariant zachowawczy
  opisany w migracji (wycofanie publikacji, np. po wycofaniu zgody na wizerunek, musi działać zawsze). Zdjęcia nie należą do
  roku. Schemat wymienia `school_year_closed` tylko przy utworzeniu.
- Rozbieżności i uwagi (opis, trasy bez zmian): `415 photo_file_active_content` z kodu trasy jest nieosiągalny (kontrola
  struktury PNG/JPEG zwraca wyłącznie `document_malformed`), więc nie ma go ani w schemacie, ani w katalogu; `createdAt`
  wariantu pliku jest `null` tylko przy odtworzeniu po przegranym wyścigu dwóch przesłań (ten odczyt pomija kolumnę) — w
  schemacie `nullable`; zgłoszenie (`submit`) nie zwraca `invalid_transition` ani `403 forbidden` (każdy, kto widzi wpis,
  może go zgłosić; zgłoszenie zgłoszonego to odtworzenie); zły identyfikator w ścieżce (`invalid_post_id`, `invalid_photo_id`,
  `invalid_consent`) daje `400` także osobie bez uprawnienia — format jest sprawdzany po sesji, ale przed rolą (bez
  ujawniania istnienia obiektu). Pola tekstowe zdjęcia
  (w tym publiczny `altText`) i powód cofnięcia praw przechodzą bramkę danych osobowych z listą znanych imion i nazwisk
  ze wszystkich otwartych lat szkolnych (#741, `loadKnownNamesForOpenYears`, `docs/PII_CHECK.md`), bo zdjęcie nie należy do roku.

Cechy modułów etapu 11 (`login` — logowanie hasłem, stan sesji ekranu logowania, zaproszenia, reset i zmiana hasła;
`mfa` — zapis i weryfikacja TOTP, kody odzyskiwania, sesje własne; opis stanu, nie zmiana tras; zasady w `docs/AUTH.md`):

- Specyfikacja obejmuje 13 operacji z macierzy tras: `POST /api/login`, `GET /api/auth/state`,
  `POST /api/invitations/preview`, `POST /api/invitations/accept`, `POST /api/password/reset`, `POST /api/password/change`,
  `POST /api/mfa/enroll`, `/confirm`, `/verify`, `/recovery`, `GET /api/sessions`, `POST /api/sessions/{id}/revoke` i
  `POST /api/sessions/revoke-all`. Logowanie, zaproszenia i reset działają bez sesji (`security: []`, cookie jest
  ignorowane), pozostałe wymagają sesji; wszystkie poza zmianą hasła są zwolnione z bramki MFA routera.
- **Pola tajne**: żaden schemat odpowiedzi nie ma hasła, hasha, tokenu zaproszenia ani resetu; sekret TOTP (base32 i URI
  `otpauth://`) zwraca wyłącznie `POST /api/mfa/enroll` (raz), kody odzyskiwania — wyłącznie `POST /api/mfa/confirm` (raz);
  sekret sesji jest tylko w cookie `Set-Cookie` (logowanie, przyjęcie zaproszenia, zmiana hasła i potwierdzenia MFA rotują
  sesję). Lista sesji nie ma adresu IP ani User-Agent (nie są zapisywane). Pola tajne żądań mają `writeOnly: true`.
- **Bez wyroczni istnienia konta**: nieznany adres, złe hasło, konto wyłączone, konto bez hasła i adres w złym formacie →
  jedna odpowiedź `401 invalid_credentials` (ta sama treść i nagłówki, ten sam koszt scrypt); limit pary (adres, IP) działa
  tak samo dla nieistniejących adresów. Każda odmowa tokenu zaproszenia (nieznany, wygasły, wycofany, **już użyty**, konto
  wyłączone) to `400 invalid_invitation`, tokenu resetu — `400 invalid_token`; cudza, nieistniejąca i już cofnięta sesja
  w `POST /api/sessions/{id}/revoke` → `404 not_found`. Podgląd zaproszenia ujawnia `accountExists` i zamaskowany adres
  wyłącznie posiadaczowi ważnego tokenu (#164).
- **Limity**: `429 too_many_attempts` z `Retry-After` (para adres+IP 5 błędów, IP 20 błędów w 15 min; także błędne tokeny
  i błędne obecne hasło przy zmianie i przy przyjęciu zaproszenia na istniejące konto), `429 mfa_locked` z `Retry-After`
  (5 błędnych kodów w sesji, 20 na konto); w czasie blokady hasło ani kod nie są sprawdzane. Pełna kolejka scrypt →
  `503 login_busy` z `Retry-After: 5` (logowanie, przyjęcie zaproszenia, reset, zmiana) bez liczenia próby i bez zużycia
  tokenu. Ogólny limiter żądań (`429 rate_limited`) działa w serwerze Node przed routerem i nie jest w schematach tras.
- **Bez `Idempotency-Key`**: ponowione logowanie tworzy nową sesję; ponowione przyjęcie zaproszenia albo reset tym samym
  tokenem → `invalid_invitation`/`invalid_token`; ponowiona zmiana hasła → `invalid_current_password`; ten sam kod TOTP
  (także w innej sesji) albo zużyty kod odzyskiwania → `400 invalid_code` liczony do limitu.
- Kody zwracane tylko przez te moduły, a dotąd nieobecne w katalogu (detektor ich nie widział — polityka haseł zwraca
  `return 'kod'`, a `attemptFactor` wybiera kod operatorem `?:`), są od etapu 11 w `docs/API_ERRORS.md` i w
  `shared/messages.js`: `password_too_short`, `password_common`, `password_contains_email`, `mfa_enrollment_not_found`,
  `mfa_not_enrolled` (ekran logowania miał już własne teksty w `login/core.js`).
- Rozbieżności i uwagi (opis, trasy bez zmian): ponowne użycie tokenu zaproszenia daje `400 invalid_invitation`, a nie
  osobny kod `already_used` (celowo — bez rozróżniania stanów tokenu); brak pola i pole złego typu w ciele dają
  `400 invalid_json`, a nie `invalid_request` jak w modułach finansowych; `password_required` (z `checkPasswordPolicy` i
  `acceptInvitationWithPassword`) i `invalid_method` (`enrollFactor`) są przez HTTP nieosiągalne — trasa wcześniej odrzuca
  brak hasła jako `invalid_json`, a metody MFA nie przyjmuje — więc nie ma ich w schematach; `401 invalid_credentials`
  przyjęcia zaproszenia (złe obecne hasło istniejącego konta) ma inny status niż złe obecne hasło przy zmianie hasła
  (`400 invalid_current_password`); `409 conflict` przyjęcia zaproszenia i zmiany hasła wymaga przeplotu transakcji,
  którego PGlite nie odtwarza (jest w schemacie, bez testu kontraktu); lista zwolnień w sekcji „Bramka MFA” w
  `docs/AUTH.md` pomija `/api/invitations/preview`, `/api/sessions` i `/api/sessions/{id}/revoke` (zwolnienie sesji
  opisuje sekcja #150), choć `MFA_GATE_EXEMPT_EXACT`/`MFA_GATE_EXEMPT_PREFIXES` je obejmują.

Cechy modułu etapu 12 (`admin` — konta, przydziały ról, wnioski o rolę chronioną, zaproszenia i partie, lata i klasy,
promocja, dzienniki, przegląd dostępu, żądania osób, retencja, anonimizacja i stan operacyjny; opis stanu, nie zmiana tras;
zasady w `docs/ACCOUNTS.md`, `docs/AUTHORIZATION.md`, `docs/DATA_REQUESTS.md`):

- Specyfikacja obejmuje 46 operacji z macierzy tras. Każda — także odczyt — wymaga roli `admin` z potwierdzonym MFA
  (wariant zachowawczy D-08/D-09): zarząd, skarbnik, przedstawiciel, Komisja Rewizyjna i dyrekcja → `403 forbidden`,
  admin bez MFA → bramka routera (`mfa_enrollment_required`/`mfa_required`). Krok w górę MFA (`403 mfa_stale`, #150) mają
  reset hasła i MFA, zatwierdzenie wniosków o reset i o rolę, nadanie roli, zaproszenie i jego ponowne wydanie, partie
  zaproszeń (także podgląd), przedłużenie przydziałów przedstawicieli, eksport danych rodziny i anonimizacja (także podgląd).
- **Tokeny i pola tajne**: token zaproszenia i resetu hasła jest w odpowiedzi WYŁĄCZNIE tej, która go tworzy (zaproszenie,
  ponowne wydanie, zapis partii, zatwierdzenie wniosku, reset hasła); listy zaproszeń i wniosków, odtworzenie partii i
  wnioski `202` go nie mają. Żadna odpowiedź nie zawiera hasha hasła ani sekretu MFA (schemat `AdminUser` ma tylko
  `mfaEnrolled`). Lista kont pokazuje adres e-mail i nazwę wyświetlaną wyłącznie administratorowi.
- **Cztery oczy** (#146): rola chroniona (`admin`, `board`, `treasurer`) przy drugim aktywnym administratorze — nadanie,
  zaproszenie i ponowne wydanie zaproszenia dają `202` z wnioskiem (`AdminGrantRequestPending`), reset hasła/MFA konta
  chronionego — `202` z wnioskiem (`AdminRecoveryRequestPending`); zatwierdza inna osoba (`403 grant_four_eyes_required`,
  `recovery_four_eyes_required` dla wnioskodawcy i adresata), drugie zatwierdzenie → `409 grant_request_closed`/
  `recovery_request_closed`. Zatwierdzenie zwraca `oneOf`: przydział albo zaproszenie z tokenem; token resetu albo wynik
  resetu MFA. Samonadanie → `409 cannot_grant_self` (przydział, zaproszenie na własny adres, wiersz partii).
- **Dyrekcja tylko z rokiem**: przydział i zaproszenie `principal` bez roku → `422 school_year_required` (także ponowne
  wydanie dawnego zaproszenia bez roku); przegląd dostępu pokazuje dawne aktywne przydziały dyrekcji bez roku w każdym roku
  z `schoolYearId: null`, `proposal: revoke`, `reason: year_scope_required` — nic nie jest odbierane automatycznie.
- **Idempotencja**: `Idempotency-Key` mają wyłącznie zapis promocji uczniów i zapis partii zaproszeń (wymagany; 201, a
  ponowienie 200 z polem `replayed`, bez nagłówka `Idempotency-Replayed`; ten sam klucz z innym planem → `409
  idempotency_key_reused`, zmiana od podglądu → `409 plan_stale`/`invitation_batch_stale`) oraz rejestracja żądania osoby
  (klucz opcjonalny: `201` z `Idempotency-Replayed: false` tylko przy kluczu, bez klucza bez nagłówka — generator ma do tego
  `replayed: 'false'` z `replayedOptional`; ponowienie `200` + `true`, inna treść `409 idempotency_conflict`). Pozostałe
  zapisy są idempotentne po stanie (`changed: false`, `created: false`, ten sam otwarty wniosek, kopiowanie klas i
  przedłużenie przedstawicieli `200` bez nowych wierszy). Odrzucenie wniosku o rolę przyjmuje żądanie bez treści i bez
  `Content-Type` — w specyfikacji `requestBody.required: false` (wpis `bodyOptional: true`, etap 12).
- Listy z kursorem (`GET /users`, `/grants`, `/invitations`, `/account-requests`, `/grant-requests`, `/data-requests`,
  `/anonymizations`, `/audit`) mają `nextCursor`, `truncated`, `limit` i kursor związany z filtrem; dziennik odczytu
  (`/access-log`) ma własny kursor bez `truncated` i `limit` (koniec listy to `nextCursor: null`), niezwiązany z filtrem.
  Zły identyfikator w ścieżce → `400 invalid_id` (po roli, przed odczytem obiektu). Eksport danych rodziny ma dwa formaty
  (`format=json|csv`, `formatsResponse`); paczka JSON zawiera dane osobowe i jest opisana schematem `AdminFamilyExport` z
  ogólnymi tabelami (`tables`, `lookups`), a skrót SHA-256 jest też w nagłówku `X-Export-Manifest-Sha256`.
- Kody przekazywane przez `optionalId(…, 'kod')` (`invalid_actor_id`, `invalid_class_id`, `invalid_guardian_id`,
  `invalid_student_id`) były dotąd poza katalogiem — detektor kodów (identyczny w `tests/pg-api-errors-catalog.test.js` i
  `tests/shared-api.test.js`) zna od etapu 12 ten helper; kody są w `docs/API_ERRORS.md` i `shared/messages.js`.
- Rozbieżności i uwagi (opis, trasy bez zmian; zbiorczo w #736): **`POST /api/admin/promotions/representatives/apply` nie
  sprawdza samonadania** — administrator, który był przedstawicielem klasy roku źródłowego, przedłuża przydział SAM SOBIE
  (nowy `role_grants` z `granted_by` = on sam), choć `POST /grants` i partia zaproszeń odrzucają to `cannot_grant_self`
  (rola niechroniona, ale omija zasadę z #146); `GET /api/admin/audit/entity/{entityType}/{entityId}` jest trasą modułu,
  ale nie ma jej w macierzy tras, więc nie ma jej w specyfikacji; zapis partii zaproszeń i tworzenie klas nie mapują w kodzie
  trasy błędu `school_year_closed` z triggera zamrożenia (pojedyncze zaproszenie i przydział mapują) — reakcji na zamknięty
  rok nie sprawdzono, więc kodu nie ma w ich schematach; wzorzec klucza
  promocji i partii (`readIdempotencyKey`: 8-128 znaków, może zaczynać się od `_`) jest luźniejszy niż `IdempotencyKey`
  w schemacie; kody nieosiągalne bez zegara albo przeplotu transakcji (`recovery_request_expired`, `grant_request_expired`,
  `data_request_export_in_progress`, `anonymization_row_mismatch`) oraz `role_pending_decision` (dziś żadna rola nie ma
  stanu `pending_decision`) są w schematach, ale nie w teście kontraktu; dziennik odczytu nie ma `truncated`/`limit` jak
  pozostałe listy (#159).

Cechy modułów etapu 13 (`audit-history` — historia obiektu; `audit-reviews` — ścieżka kontroli Komisji Rewizyjnej;
`financial-reports` — sprawozdanie roczne, przepływy i migawki; `exports` — eksport roczny i lista klasy; `print` — dane
kartek; `board` i `representative` — pulpity; opis stanu, nie zmiana tras; zasady w `docs/AUTHORIZATION.md`,
`docs/EXPORT.md`, `docs/RECONCILIATION.md`):

- Specyfikacja obejmuje 22 operacje z macierzy tras. Zakresy odczytu ról „tylko do odczytu”: Komisja Rewizyjna czyta i
  prowadzi wyłącznie ścieżkę kontroli (`audit-reviews`), dyrekcja wyłącznie zbiorcze sumy (`GET /api/reports/annual`,
  `GET /api/reports/cash-flow`, z MFA); obie role dostają `403 forbidden` na historii obiektu, migawkach, eksportach,
  kartkach i pulpitach. Przedstawiciel widzi tylko klasy z własnych przydziałów (kartki `classId` wymagany — `400
  class_required`, cudza klasa `403`; lista klasy z MFA; pulpit bez parametru klasy, przydział innego roku → `classes: []`).
- **Bez nagłówka `Idempotency-Replayed`**: `Idempotency-Key` (wymagany) mają wyłącznie zapisy ścieżki KR; ponowienie tym
  samym kluczem i treścią → `200` z polem `replayed: true`, inna treść → `409 idempotency_conflict`. Migawki sprawozdania
  nie mają klucza — ta sama treść księgi to ta sama migawka (`200`, `replayed: true`), powtórne zatwierdzenie → `200`.
  Zamknięcie wątku KR i zatwierdzenie migawki przyjmują żądanie bez treści (`bodyOptional`, `requestBody.required: false`).
- **Pliki i formaty**: `format=html` sprawozdania i migawki (dokument do druku z CSP), lista klasy `json|csv|xlsx`
  (`formatsResponse`), eksport zarządu jako osobne ścieżki `export.csv`/`export.xlsx` (`fileResponse`). Eksport roczny to
  załącznik JSON (`ExportYearlyBundle`: `files` ścieżka → JSONL z PEŁNYMI danymi rodzin i finansów, `manifest` z
  kolumnami, liczbami wierszy, sumami kwot i skrótami), lista klasy JSON — `ClassRoster` (e-mail opiekuna tylko przy
  zgodzie opiekuna i relacji, bez wpłat i identyfikatorów rodzin). **Kartki (`GET /api/print/cards`) to JSON** dla panelu
  `print/`, nie HTML ani PDF: bez danych opiekunów, `recordedNetCents` tylko przy roli finansowej z MFA (pole pomijane, nie
  null), `skippedRestricted` — sama liczba rodzin z ograniczeniem przetwarzania w zakresie wydruku.
- Krok w górę MFA (`403 mfa_stale`): eksport roczny i zatwierdzenie migawki. Cztery oczy (`403 four_eyes_required`):
  zatwierdzenie migawki przez autora i odpowiedź KR złożona przez autora pytania (konflikt ról audit + skarbnik). Zamknięty
  rok: zapisy KR i zatwierdzenie migawki → `409 school_year_closed`, odczyt zostaje; eksport archiwum przez zarząd roku
  następnego (`year_close.archive_read` w dzienniku).
- Rozbieżności i uwagi (opis, trasy bez zmian): **walidacja przed sesją** — brak/zły `schoolYearId` sprawozdania,
  przepływów i listy migawek, ciało zapisu i zatwierdzenia migawki, ciało eksportu rocznego, `classId`/`format` listy klasy
  i identyfikator roku w ścieżce KR dają `400` także bez sesji (zamiast `401`; pozostałe moduły etapu sprawdzają sesję
  najpierw); zły identyfikator uwagi KR w ścieżce → `400 audit_review_not_found` (kod „nie znaleziono” ze statusem 400);
  **wyrocznie istnienia sprzeczne z SR-07** (niski poziom ryzyka, identyfikatory losowe, treść nie wycieka): odczyt migawki
  innego roku przez zarząd/skarbnika z przydziałem tylko na inny rok → `403`, a nieistniejącej → `404` (historia obiektu
  daje w obu przypadkach `404`); lista klasy dla zarządu innego roku → `403` dla istniejącej klasy, `404 class_not_found`
  dla nieistniejącej; pytanie KR do wpisu księgi albo uzgodnienia → `404 audit_review_target_not_found` vs `201`, choć
  `audit` bez flagi AUDIT_LEDGER_READ nie czyta księgi; trasa historii przyjmuje dowolny segment rodzaju obiektu, a
  nieznany (`400 invalid_entity_type`) leży poza czterema operacjami specyfikacji; historia obiektu nie używa
  `mfaAwareForbiddenCode`, więc przy `MFA_REQUIRED_ROLES` bez zarządu/skarbnika odmowa z braku MFA byłaby `forbidden`
  (dziś kody MFA daje bramka routera); komentarz macierzy przy `board.overview` mówi, że przydział zarządu do klasy nie
  otwiera widoku, a `allow` i trasa dają mu `200` z `scope: classes` (zachowanie zgodne z `docs/AUTHORIZATION.md`); pulpit
  przedstawiciela liczy gospodarstwa po wszystkich bieżących członkostwach, a pulpit zarządu — po gospodarstwach głównych
  (przy opiece dzielonej liczby dla tej samej klasy mogą się różnić); w zamkniętym roku zapis migawki o niezmienionej treści
  to ponowienie `200`, a `409 school_year_closed` daje tylko pierwsza migawka roku. Kody nieosiągalne bez przeplotu
  transakcji, obejścia triggera albo dużych danych (`409 export_in_progress`, `409 conflict` migawek, `409
  report_snapshot_content_exists`, `500 report_snapshot_integrity_failed` — test w `tests/pg-report-snapshots.test.js`,
  `413 too_many_rows` powyżej 5000 wierszy kartek) są w schematach, ale nie w teście kontraktu.

Kolejny moduł obejmuje się, dodając plik schematów, wpisując go do `SCHEMA_MODULES`, usuwając z
`UNCOVERED_MODULES` i uruchamiając `npm run openapi:build`; test nie pozwala, by lista niepokrytych rosła.

