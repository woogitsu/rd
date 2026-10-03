# Retencja (D-04) — rejestr polityk i raport kandydatów

> Ten dokument opisuje mechanizm, nie treść decyzji. Okresy przechowywania,
> kto je zatwierdza i na jakiej podstawie ustala zarząd/szkoła z IOD (D-04,
> patrz [`docs/DECISIONS.md`](DECISIONS.md)). Kod **nie zawiera żadnej
> wartości domyślnej** retencji — brak wiersza w `retention_policies` znaczy
> „nie usuwaj”, tak jak dziś działa `documents.retain_until = NULL`.

## Rejestr polityk i raport kandydatów (#91, migracja 0074)

- **`postgres/migrations/0074_retention_policies.sql`** — tabela
  `retention_policies`: wersjonowany rejestr decyzji retencyjnych, tylko
  dopisywanie (korekta = nowy wiersz, nigdy UPDATE/DELETE istniejącego).
  Kolumny: `data_category` (jedna z ośmiu kategorii zgodnych z
  `privacy/data-inventory.json`, #123), `retain_for` (interval) albo
  `retain_until_rule` (opis, dokładnie jedno z dwóch), `decision_ref`
  (odwołanie do uchwały/decyzji), `effective_from`, `approved_by` (musi różnić
  się od `created_by` — zasada czterech oczu).
- **`GET /api/admin/retention/preview`** (admin + MFA) — raport kandydatów:
  liczność wierszy per kategoria i rok/rok szkolny, wyłącznie liczby i
  identyfikatory techniczne (nigdy imiona, nazwiska, e-maile, referencje).
  Zwraca też zarejestrowane polityki (bez danych osobowych — te kolumny ich
  nie zawierają).

## Kategorie danych

| Kategoria | Źródło liczności w raporcie |
|---|---|
| `guardian_contact` | `guardian_contact_changes` (rok zmiany) |
| `student_identity` | `enrollments` (rok szkolny) |
| `email_snapshot` | `email_campaign_recipients` (rok szkolny kampanii) |
| `payment_reference` | `payment_entries.reference` niepuste (rok szkolny) |
| `document_financial` | `documents` (rok utworzenia) |
| `audit_event` | `audit_events` (rok zdarzenia) |
| `export_package` | `export_runs` (rok szkolny) — metadane przebiegów; serwer nie przechowuje samych paczek (bufor tymczasowy eksportu rocznego znika po wysyłce, [`docs/EXPORT.md`](EXPORT.md)) |
| `import_file` | `import_batches` (rok szkolny) |

## Jak wpisać decyzję D-04

Administrator/zarząd wstawia wiersz `retention_policies` (dziś: bezpośrednio
w bazie przez administratora technicznego — panel do tego nie jest częścią
tego mechanizmu, patrz „Czego to jeszcze NIE obejmuje”) z `data_category`, jednym z
`retain_for`/`retain_until_rule`, `decision_ref` wskazującym uchwałę i, jeśli
zatwierdzenie jest oddzielone od wpisania, `approved_by` innej osoby. Wiersz
sam w sobie **niczego nie usuwa** — to wyłącznie rejestr.

## Anonimizacja gospodarstwa (#91, migracja 0174)

> Prototyp — nie jest wdrożony i nie jest gotowy do pracy na danych rodzin.
> To **mechanizm**, nie decyzja: żaden okres retencji nie jest wpisany w kod.
> Dziś rejestr `retention_policies` jest pusty, więc przebieg „z polityki”
> odmawia; działa tryb żądania osoby (D-07) oraz testy na danych syntetycznych.

`POST /api/admin/anonymizations` (wyłącznie `admin` z MFA potwierdzonym w ciągu
15 minut; krok w górę jak reset hasła, także dla podglądu). Kod:
`src/pg/anonymization.js`.

```json
{ "householdId": "…", "reasonCode": "retention_policy | data_subject_request",
  "dataRequestId": "… (tylko data_subject_request)",
  "dryRun": true, "confirm": "<id gospodarstwa>", "expectedPlanSha256": "<z podglądu>" }
```

1. **Podgląd** (`dryRun` — domyślnie `true`): zwraca `planSha256`, liczniki per
   tabela (`counts`) i liczbę osób wspólnych z innymi gospodarstwami
   (`retained`). Nie zmienia danych i nie zapisuje wiersza `anonymization_runs`,
   ale zostawia ślad w audycie: zdarzenie `household.anonymization_previewed`
   (aktor, czas, gospodarstwo, kod powodu i liczniki — bez danych osobowych).
   Odpowiedź nie zawiera imion, e-maili ani tekstów.
2. **Wykonanie** (`dryRun: false`): wymaga `confirm` równego `householdId` i
   `expectedPlanSha256` z podglądu — zatwierdzenie dokładnie tego planu. Dane
   zmienione od podglądu → `409 anonymization_plan_changed`. Wynik `201
   applied` albo `200 replayed`.
3. **Ponowienie / podwójne kliknięcie**: przebieg bez niczego do zmiany zwraca
   `replayed`, bez nowego wiersza `anonymization_runs` i bez zdarzenia audytu.
   Równoległe wywołania dla jednego gospodarstwa serializuje blokada doradcza.

### Dwa tryby (powód jako kod)

| `reasonCode` | Warunek | Odmowa |
|---|---|---|
| `retention_policy` | w `retention_policies` istnieje obowiązująca (`effective_from` ≤ teraz, najnowsza wersja) polityka **dla każdej z czterech kategorii**: `guardian_contact`, `student_identity`, `email_snapshot`, `payment_reference`; każda zatwierdzona (`approved_by`) i z okresem `retain_for`; od końca ostatniego roku szkolnego gospodarstwa (wpłaty, zapisy dzieci, kampanie; bez aktywności — od założenia gospodarstwa) upłynął najdłuższy z tych okresów | `409 retention_policy_missing`, `retention_policy_not_approved`, `retention_rule_not_evaluable` (polityka ma tylko opis `retain_until_rule`), `retention_period_not_elapsed` |
| `data_subject_request` | `dataRequestId` wskazuje żądanie rodzaju `erasure` (#100), po weryfikacji tożsamości (`identity_verified`/`in_progress`), niezamknięte, dotyczące tego gospodarstwa (bezpośrednio albo przez opiekuna/ucznia z jego składu) | `409 data_request_kind_not_erasable`, `data_request_identity_not_verified`, `data_request_closed`, `data_request_subject_mismatch`, `404 data_request_not_found` |

Założenia (do potwierdzenia D-04/D-07/IOD, nie rozstrzygnięcia prawne):

- Tryb `retention_policy` jest **zachowawczy**: bez kompletu zatwierdzonych,
  wyliczalnych polityk nic nie jest anonimizowane „domyślnie”. Reguła opisowa
  (`retain_until_rule`) nie jest interpretowana przez kod.
- Żądanie usunięcia dotyczy **całego gospodarstwa** wskazanego przez
  obsługującego — żądanie jednego opiekuna lub dziecka nie zawęża zakresu.
  Anonimizacja (a nie fizyczne usunięcie) jako sposób realizacji dla danych
  powiązanych z księgą — do potwierdzenia przez IOD.
- Reguła dwóch osób: nie jest wymuszona na trasie (D-01/D-09). W trybie
  polityki dwie osoby już uczestniczą (autor i zatwierdzający wpis w
  `retention_policies`, CHECK `created_by <> approved_by`); w trybie żądania
  osoby decyduje jeden administrator po weryfikacji tożsamości i zatwierdza
  dokładny plan (`expectedPlanSha256`). Dodanie drugiego zatwierdzającego
  (wzorem `grant-requests`) to osobna zmiana.

### Co zmienia, a czego nie

Zmienia wyłącznie pola tekstowe z `privacy/data-inventory.json` (`personal:
direct`) powiązane z gospodarstwem — na `NULL` albo `[zanonimizowano]`:

| Tabela | Kolumny |
|---|---|
| `guardians` | imię, nazwisko → `[zanonimizowano]`; `email` → `NULL`; `contact_allowed` → `false` |
| `students` | imię, nazwisko → `[zanonimizowano]` |
| `guardian_contact_changes` | `previous_email`, `new_email`, `reason` → `NULL` (wiersze zostają: historia zmian kontaktu jest zanonimizowana, nie usunięta) |
| `identity_changes` (0182) | `previous_first_name`, `previous_last_name`, `new_first_name`, `new_last_name` → `[zanonimizowano]`; `reason` → `NULL` (wiersze, aktor, czas i powiązanie z żądaniem zostają; plan liczy osobno historię opiekunów i uczniów: `identity_changes_guardians`, `identity_changes_students`) |
| `student_guardian_changes`, `enrollment_history` | `reason` → `NULL` |
| `guardian_households`, `student_households`, `enrollments` | powody zakończenia/utworzenia → `NULL` |
| `guardian_update_requests` | `proposed_email`, `note` → `NULL` |
| `email_campaign_recipients` | `email` → `zanonimizowano@anonim.invalid` (kolumna NOT NULL); **`email_hash` zostaje** — potrzebny do tłumienia adresów i unikalności migawki; skrót adresu jest nadal daną pseudonimową — do oceny IOD, czy usunąć go po okresie tłumienia |
| `payment_entries` | `reference` → `NULL` (tytuł przelewu) |
| `payment_corrections`, `payment_refunds`, `payment_reassignments`, `payment_allocation_reversals` | `reason` → `[zanonimizowano]` (NOT NULL) |

**Nie zmienia**: identyfikatorów, kwot, dat, statusów, `household_id` wpłaty,
roku szkolnego, kluczy idempotencji, wpisów księgi (`ledger_*`), uzgodnień
bankowych, powiązań `student_guardians`/`student_households`/`guardian_households`
(wiersze, daty, role) ani dziennika audytu. Test sprawdza równość sum netto
(`household_payment_totals`), wpłat, korekt, zwrotów, księgi i liczb w
manifeście paczki rocznej (`*_cents`, `totals`) przed i po przebiegu.

Poza zakresem tego mechanizmu (wymagają osobnego przeglądu, nie są
„należące do gospodarstwa”): konta członków Rady (`users`), wolny tekst
w protokołach, uchwałach, kampaniach (`email_campaigns.subject/body_text`),
księdze (`ledger_*.description/reason`), uzgodnieniach, dokumentach,
zdjęciach archiwalnych i `audit_events`/`data_access_log`.

### Opieka dzielona i rodzeństwo (wybrane zachowanie)

Opiekun lub uczeń z więcej niż jednego gospodarstwa (gospodarstwo główne +
`guardian_households`/`student_households`, każdy okres) jest anonimizowany
dopiero, gdy **wszystkie** jego gospodarstwa są zanonimizowane — w tym
przebiegu albo w wcześniejszym (`anonymization_runs`). Do tego czasu zostaje
nietknięty i jest liczony w `retained`; kolejny przebieg drugiego gospodarstwa
dokończy anonimizację (stąd wynik nie zależy od kolejności). Wiersze powiązań
uczeń–opiekun nigdy nie są usuwane: drugi opiekun dziecka z innego
gospodarstwa zachowuje swoje dane i relację, a dziecko tylko w jego
gospodarstwie jest anonimizowane razem z nim. Zapisy e-mail adresata wspólnego
opiekuna są zmieniane dopiero razem z opiekunem. Wpłaty zmienia się wyłącznie
w gospodarstwie, do którego należą w chwili przebiegu (`payment_entries.household_id`).

### Furtka w triggerach niezmienności

`UPDATE` pól osobowych przechodzi przez strażników (`family_history_immutable`,
`immutable_financial_record`, `immutable_payment_event`, `email_snapshot_guard`,
`payment_entry_guard`, `guardian_update_request_guard`, `enrollment_guard`,
`guardian_household_check`, `student_household_check`, `year_freeze_direct`)
wyłącznie, gdy transakcja ustawiła `rd.anonymization_run` (UUID przebiegu),
**tabela jest na liście migracji 0174** i zmieniają się tylko wymienione
kolumny, tylko na `NULL` lub wartość zastępczą (`rd_anonymization_update_allowed`).
Kwoty, daty, status, gospodarstwo i klucz idempotencji pozostają chronione
dotychczasowymi wyjątkami; `DELETE`, `TRUNCATE` i `UPDATE` poza przebiegiem są
odrzucane jak dotąd (test: `tests/pg-anonymization.test.js`). Tak jak
`rd.restore`, to ustawienie sesji — po rozdziale ról (#101/SR-05) powinna je
mieć wyłącznie rola aplikacji.

### Dziennik i audyt

- `anonymization_runs` (append-only, bez `UPDATE`/`DELETE`/`TRUNCATE`): `id`,
  `household_id`, `reason_code`, `data_subject_request_id`, identyfikatory
  polityk, `plan_sha256` (SHA-256 listy zmienionych identyfikatorów), `counts`,
  `executed_by`, `executed_at`. Bez imion, e-maili i tekstów.
- `GET /api/admin/anonymizations` (`admin` z MFA, bez kroku w górę): lista
  przebiegów od najnowszego z kursorem (`limit`, `cursor`, `nextCursor`,
  `truncated`): `id`, `householdId`, `reasonCode`, `dataSubjectRequestId`,
  `retentionPolicyIds`, `planSha256`, `counts`, `totalChanged` (suma liczników),
  `executedBy`, `executedAt` — dokładnie to, co przechowuje tabela. Odczyt nie
  zapisuje zdarzenia audytu. `reasonCode` jest dodatkowo `restore_reapply` dla
  przebiegu ponowionego skryptem po odtworzeniu kopii (migracja 0185, niżej);
  `executedBy` to wtedy osoba, która uruchomiła ponowienie.
- `audit_events`: `household.anonymization_previewed` (domena `privacy`, obiekt
  `household`; każdy podgląd, z aktorem, czasem, kodem powodu, `planSha256` i
  licznikami) oraz `household.anonymized` (domena `privacy`, obiekt
  `anonymization_run`) z aktorem, czasem i metadanymi: identyfikatory, kod
  powodu, `planSha256`, liczniki i `retainedGuardians`/`retainedStudents`.
  Odmowy (401/403, błędne wejście, brak polityki) nie tworzą wpisu przebiegu
  ani zdarzenia `household.anonymized`; odmowa roli zapisuje `access.denied`.

### Kopie zapasowe i paczki eksportu (dług anonimizacji)

Przebieg zmienia tylko bieżącą bazę. Kopie zapasowe i wcześniej pobrane
paczki roczne ([`docs/EXPORT.md`](EXPORT.md)) zawierają dane sprzed przebiegu,
a w kopii sprzed przebiegu nie ma jeszcze wiersza `anonymization_runs` (paczka
roczna w ogóle go nie niesie: tabela jest w `EXPORT_EXCLUDED_TABLES`). Po
odtworzeniu baza nie wie więc, co zanonimizowano. Do tego służy dziennik
przechowywany **poza bazą** i skrypt ponownego zastosowania (migracja 0185).
Opis procedury krok po kroku dla operatora:
[`docs/RAILWAY_OPERATIONS.md`](RAILWAY_OPERATIONS.md), „Po odtworzeniu: ponowne
zastosowanie anonimizacji”.

**Dziennik poza bazą** — `npm run anonymization:export-log -- --out=<nowy-plik.json>`
(`scripts/export-anonymization-log.js`, format `rd-anonymization-log` v1:
`src/pg/anonymization-log.js`). Plik zawiera dla każdego przebiegu wyłącznie:
`runId`, `householdId`, `reasonCode`, `dataSubjectRequestId` (albo `null`),
`retentionPolicyIds`, `planSha256`, `executedAt` (mikrosekundy, UTC) i
`executedBy` — identyfikatory techniczne, kody i skróty, bez imion, e-maili,
tekstów i liczników osób. Odczyt odrzuca każde dodatkowe pole i każdą wartość
spoza wzorca identyfikatora (np. z „@” albo spacją), a suma `runsSha256`
wykrywa przypadkowe uszkodzenie lub ręczną edycję. Skrypt nie nadpisuje
istniejącego pliku (eksport z bazy odtworzonej ze starej kopii mógłby zgubić
przebiegi), tworzy plik z prawami 0600 i nic nie wypisuje o adresie bazy.
Eksportuj po **każdym** przebiegu; kolejne pliki zapisuj pod nowymi nazwami —
ponowienie przyjmuje wiele plików i łączy je po `runId`.

**Ponowne zastosowanie** — `npm run anonymization:reapply -- --log=<plik.json>
[--log=…] --actor=<userId> [--dry-run] [--allow-production]`
(`scripts/reapply-anonymization.js`, `src/pg/anonymization-reapply.js`):

- `--actor` jest wymagany: aktywny administrator odtworzonej bazy (konto bez
  wyłączenia z nieodwołanym przydziałem `admin`). Po odtworzeniu z paczki
  rocznej konta nie wracają — najpierw bootstrap pierwszego administratora (#187).
- Wpisy są stosowane w kolejności wykonania pierwotnego, wszystkie w **jednej**
  transakcji (błąd wycofuje całość). `--dry-run` wykonuje tę samą pracę i ją
  wycofuje, więc podgląd jest dokładny także dla osób wspólnych kilku gospodarstw;
  zostaje po nim tylko zdarzenie audytu `household.anonymization_previewed` z
  kodem `restore_reapply`.
- Zmiany wylicza ten sam plan co przebieg z trasy (`planAnonymization`; te same
  tabele, kolumny i wartości zastępcze, ta sama furtka `rd.anonymization_run`;
  bez `DISABLE TRIGGER`). Kwot, dat, statusów, `household_id`, księgi i `email_hash`
  skrypt nie rusza.
- **Idempotencja**: wpis, którego `runId` jest już w `anonymization_runs`
  (`already_recorded`), pomijany; gospodarstwo, którego nie ma w odtworzonej bazie
  (`household_missing`), pomijane bez błędu; gospodarstwo z pustym planem
  (już zanonimizowane, `nothing_to_change`) pomijane bez wiersza i bez zdarzenia —
  tak jak `replayed` z trasy.
- **Zapis**: wiersz `anonymization_runs` z `reason_code = restore_reapply`,
  identyfikatorem równym `runId` przebiegu pierwotnego i danymi pierwotnego
  przebiegu w `source_run` oraz zdarzenie audytu `household.anonymized` z
  aktorem uruchamiającym ponowienie, czasem i metadanymi (`sourceReasonCode`,
  `sourcePlanSha256`, `sourceExecutedAt`, `sourceExecutedBy`; bez danych
  osobowych). Kolejny eksport dziennika z takiej bazy zapisuje te przebiegi w
  terminach pierwotnych, więc jest równoważny wcześniejszemu. Trasa
  `POST /api/admin/anonymizations` nadal przyjmuje tylko `retention_policy` i
  `data_subject_request`.
- Poza testami i stagingiem wymaga `--allow-production` (`APP_ENV=production` albo
  nierozpoznane/brak); podgląd go nie wymaga. Wynik na stdout (JSON: wynik per
  przebieg, `planMatchesSource`, liczniki, `retained`) i komunikaty na stderr nie
  zawierają danych osobowych.

Założenia (do potwierdzenia D-01/D-04/D-07/IOD, nie rozstrzygnięcia prawne):

- Ponowienie **nie jest nową decyzją**: zatwierdzenie (polityka D-04 albo żądanie
  D-07 i plan) zapadło przy przebiegu pierwotnym i jest w dzienniku, więc skrypt nie
  sprawdza ponownie polityk ani żądania (w odtworzonej bazie mogą nie istnieć).
  Skutek: dziennik jest tu jedyną bramką. Suma kontrolna nie jest podpisem i nie
  dowodzi pochodzenia pliku; kto i gdzie przechowuje dziennik oraz kto może
  uruchomić ponowienie — D-01/D-20, kod tego nie rozstrzyga.
- Skrót planu z dziennika (`planSha256`) nie jest warunkiem wykonania: baza z kopii
  ma inny stan niż baza w chwili przebiegu. `planMatchesSource: false` to
  informacja do przeglądu, nie błąd.
- Ponowienie obejmuje wszystko, co w gospodarstwie wymaga zmiany w chwili
  ponowienia — zachowawczo względem prywatności (jeśli kopia zawiera dane dopisane
  po przebiegu pierwotnym, także one zostaną zanonimizowane).
- Dziennik, który nie obejmuje przebiegów wykonanych po jego eksporcie, nie pomoże
  w ich ponowieniu: częstotliwość eksportu i miejsce przechowywania to decyzja
  operacyjna (zalecenie: po każdym przebiegu).

Paczki roczne pobrane przed przebiegiem i kopie u odbiorców (serwer ich nie
przechowuje) nadal trzeba zniszczyć ręcznie. Kopie zapasowe są przechowywane przez
czas ustalony w D-04 (kod nie zakłada okresu); stara kopia przywrócona po latach
zawiera dane sprzed przebiegów, więc ponowienie jest częścią każdego odtworzenia,
a nie tylko świeżej kopii.

## Propozycja do zatwierdzenia (raport kandydatów z polityki)

`npm run anonymization:proposals [-- --json]`
(`scripts/anonymization-proposals.js`, `src/pg/anonymization-proposals.js`) —
raport **tylko do odczytu** (transakcja `READ ONLY`): niczego nie zmienia, nie
zapisuje wiersza `anonymization_runs`, zdarzenia audytu ani wpisu w kolejce, nie ma
harmonogramu (żaden plik usługi Railway go nie uruchamia) i nie ma ścieżki
wykonania. Zgodnie ze wskazaniem z 2026-10-02 (D-04, „bez automatycznego usuwania”)
administrator przegląda listę i **ręcznie** wykonuje wybrane gospodarstwa istniejącą
trasą `POST /api/admin/anonymizations` albo ekranem „Anonimizacja” (podgląd, potem
`confirm` i `expectedPlanSha256`).

- Kandydat = gospodarstwo spełniające warunki trybu `retention_policy` (te same
  funkcje co trasa: obowiązujące, zatwierdzone polityki `retain_for` dla czterech
  kategorii i upłynięty najdłuższy okres od końca ostatniego roku szkolnego
  gospodarstwa), którego plan ma coś do zmiany.
- **Bez kompletu polityk (D-04 nieustalone, rejestr pusty) raport mówi „brak
  polityk”** i nikogo nie wskazuje; polityki niezatwierdzone albo tylko opisowe
  (`retain_until_rule`) dają „polityki niezatwierdzone” / „bez okresu retain_for”.
  Kod nie ma wartości domyślnej okresu.
- Wynik: identyfikatory gospodarstw, `planSha256`, liczniki per tabela i liczba osób
  wspólnych z innymi gospodarstwami (`retained`). Bez imion, e-maili i tekstów.
  Plan dotyczy bieżącego stanu — po przebiegu dla innego gospodarstwa (opieka
  dzielona) może się zmienić, więc przed wykonaniem zawsze jest świeży podgląd.
- Raport nie zapisuje zdarzenia audytu (jak `GET /api/admin/retention/preview`);
  wykonanie przebiegu zostawia zwykły ślad (`household.anonymization_previewed`,
  `household.anonymized`).
- Wprowadzenie automatycznego wykonania albo zadania okresowego wymagałoby decyzji
  zarządu i IOD (D-04, D-01) oraz osobnej zmiany; ten raport jej nie zastępuje.

## Dziennik odczytów i historia sprostowań (wskazanie D-04 z 2026-10-02)

Wskazanie użytkownika z 2026-10-02 ([`docs/DECISIONS.md`](DECISIONS.md),
„Wskazania użytkownika 2026-10-02”): **bez automatycznego usuwania**. To opis
obecnego stanu kodu przyjęty jako wariant do oceny. Nie jest to decyzja zarządu
ani IOD i wymaga formalnego potwierdzenia w D-04.

- **`data_access_log`** (dziennik odczytów, migracja 0067): żaden proces nie
  usuwa ani nie skraca tej tabeli. Trigger `data_access_log_guard` odrzuca
  `DELETE` (`data_access_log_cannot_be_deleted`) i każdą zmianę wpisu poza
  scaleniem powtórzeń w oknie. Wiersze zawierają wyłącznie identyfikatory
  (aktor, rok, klasa, gospodarstwo), rodzaj odczytu, wynik i liczniki, bez
  imion, e-maili i adresów IP. Anonimizacja gospodarstwa **nie zmienia** tej
  tabeli (wpisy zostają, zob. „Co zmienia, a czego nie”).
- **`identity_changes`** (historia sprostowań imion i nazwisk, migracja 0182):
  tabela tylko do dopisywania. Trigger `identity_changes_immutable` odrzuca
  `UPDATE` i `DELETE`. Jedynym wyjątkiem jest anonimizacja gospodarstwa: w
  trakcie przebiegu zastępuje imiona wartością `[zanonimizowano]` i zeruje powód.
  Wiersz, aktor, czas i powiązanie z żądaniem zostają.
- Żadna z tych tabel nie jest źródłem kategorii w „Kategorie danych” wyżej
  (`student_identity` liczy `enrollments`, nie `identity_changes`). Wpis w
  `retention_policies` i tak niczego by nie usunął, bo kod nie ma zadania
  okresowego.
- Gdyby zarząd i IOD ustalili okres przechowywania, potrzebna będzie osobna
  migracja (furtka w triggerze w rodzaju `rd_anonymization_active()`) i test
  zachowania sum; „propozycją do zatwierdzenia” jest dziś wyłącznie ręczny raport
  kandydatów (niżej), niczego nie wykonujący. Do tego czasu usunięcie danych osoby
  oznacza wyłącznie anonimizację gospodarstwa.

## Czego to jeszcze NIE obejmuje (część #91 zostaje otwarta)

- Okresów retencji i ich zatwierdzania — D-04 (kod ich nie zawiera).
- Zadania okresowego, które wykonuje anonimizację — celowo brak (wskazanie
  2026-10-02: bez automatycznego usuwania). Jest wyłącznie raport propozycji do
  ręcznego przeglądu (`npm run anonymization:proposals`); przebieg zawsze uruchamia
  administrator.
- Automatycznego eksportu dziennika poza bazą po każdym przebiegu i automatycznego
  ponowienia przy odtworzeniu — operator eksportuje dziennik i uruchamia
  `anonymization:reapply` ręcznie (procedura w `RAILWAY_OPERATIONS.md`). Miejsce
  przechowywania dziennika poza Railway i kto je prowadzi (D-01/D-20) jest
  nierozstrzygnięte; plik ma sumę kontrolną, nie podpis.
- Zniszczenia paczek rocznych i kopii u odbiorców oraz kopii zapasowych po okresie
  przechowywania — procedura organizacyjna, nie kod (okres: D-04).
- Ekranu do wpisywania i zatwierdzania polityk retencji — ekran „Anonimizacja” w
  panelu administratora (`admin/`) podgląda i wykonuje przebiegi oraz pokazuje ich
  historię (w tym przebiegi ponowione), ale wiersze `retention_policies` wpisuje się
  dziś w bazie, a raportu propozycji nie ma w panelu (tylko skrypt).
- `users` (członkowie Rady po kadencji), `audit_events`, wolnego tekstu w
  protokołach/uchwałach/księdze (patrz „Poza zakresem” wyżej).
- Drugiego zatwierdzającego przebieg (reguła dwóch osób) — D-01/D-09.

## Zależności od decyzji zarządu/szkoły

D-04 (wartości okresów — repo dostarcza wyłącznie mechanizm rejestru i
wykonania), D-01 (kto zatwierdza wpis polityki i przebieg), D-07 (zakres
usunięcia na żądanie, weryfikacja tożsamości), D-13/D-15 (jak długo musi być
zachowana księga — przebieg jej nie rusza), IOD (anonimizacja zamiast usunięcia,
`email_hash`).
