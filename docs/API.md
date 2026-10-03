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

Trasy się nie zmieniają (nowych ścieżek nie ma, więc `docs/openapi.json` jest bez zmian — te trasy
nie mają jeszcze schematów odpowiedzi, patrz „Schematy żądań i odpowiedzi” niżej). Zmieniły się kształty trzech odczytów
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
(`docs/AUTHORIZATION.md`, „Zakres roli audit”). Moduł `session` nie ma jeszcze
schematów w `docs/openapi.json` (jest na liście niepokrytych modułów), więc
`npm run openapi:build` nie zmienia pliku.

## Schematy żądań i odpowiedzi (OpenAPI, #160, etap 2)

`docs/openapi.json` (OpenAPI 3.1) jest generowany poleceniem `npm run openapi:build` (sprawdzenie bez
zapisu: `npm run openapi:build -- --check`) z trzech źródeł: macierzy tras
(`tests/helpers/route-matrix.js`: ścieżki, metody, role, MFA, statusy), katalogu kodów
(`docs/API_ERRORS.md`) i **schematów ręcznie pisanych obok tras** w `src/pg/schemas/<moduł>.js`.
Plik nie jest edytowany ręcznie; role w `x-rd-roles` pozostają założeniami D-08/D-09 do zatwierdzenia.

Schemat modułu eksportuje `name`, `components` (schematy współdzielone) i `routes`:
`{ 'POST /api/payments': { body, idempotencyKey, query, responses, errors } }`. Generator dołącza do
operacji `requestBody`, parametry (zapytanie, `Idempotency-Key`), odpowiedzi sukcesu z kształtem
(200 odtworzenia i 201 zapisu, z nagłówkiem `Idempotency-Replayed`; eksporty CSV/XLSX z typem pliku)
oraz `x-rd-error-codes` — kody błędów danej trasy per status, wyłącznie z katalogu. Wspólne
elementy (`Id`, kwoty w eurocentach, daty) są w `src/pg/schemas/common.js`. Schematy odpowiedzi są ścisłe
(`additionalProperties: false`): nowe pole w odpowiedzi trasy wymaga świadomej zmiany schematu;
schematy żądań nie zakazują nieznanych pól (trasy je ignorują).

Pilnuje tego `tests/openapi-contract.test.js` (opis w `docs/TESTING.md`): każda trasa pokrytego modułu ma
schemat, a **prawdziwe odpowiedzi** tras (utworzenie, ponowienie z tym samym kluczem, korekta częściowa,
lista z kursorem, odmowy i błędy) przechodzą walidację tymi schematami. Schematy opisują obecny kontrakt
tras; nie są jeszcze używane do walidacji wejścia po stronie serwera (parsery pozostają źródłem prawdy).

| Stan | Moduły |
| --- | --- |
| Pokryte (32 operacje) | `payments`, `payment-references`, `payment-instructions`, `ledger` |
| Jeszcze bez schematów (`UNCOVERED_MODULES` w `src/pg/schemas/index.js` i `x-rd-schema-coverage` w specyfikacji) | `admin`, `audit-history`, `audit-reviews`, `board`, `documents`, `email`, `events`, `exports`, `families`, `financial-reports`, `guardian-updates`, `import`, `ledger-budget`, `ledger-cash`, `ledger-cost-centers`, `login`, `meetings`, `mfa`, `news`, `print`, `privacy-notice`, `reconciliation`, `representative`, `session`, `year-close` |

Kolejny moduł obejmuje się, dodając plik schematów, wpisując go do `SCHEMA_MODULES`, usuwając z
`UNCOVERED_MODULES` i uruchamiając `npm run openapi:build`; test nie pozwala, by lista niepokrytych rosła.

