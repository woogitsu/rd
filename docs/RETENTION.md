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
tego PR, patrz „Czego nie obejmuje”) z `data_category`, jednym z
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
  zapisuje zdarzenia audytu.
- `audit_events`: `household.anonymization_previewed` (domena `privacy`, obiekt
  `household`; każdy podgląd, z aktorem, czasem, kodem powodu, `planSha256` i
  licznikami) oraz `household.anonymized` (domena `privacy`, obiekt
  `anonymization_run`) z aktorem, czasem i metadanymi: identyfikatory, kod
  powodu, `planSha256`, liczniki i `retainedGuardians`/`retainedStudents`.
  Odmowy (401/403, błędne wejście, brak polityki) nie tworzą wpisu przebiegu
  ani zdarzenia `household.anonymized`; odmowa roli zapisuje `access.denied`.

### Kopie zapasowe i paczki eksportu (dług anonimizacji)

Przebieg zmienia tylko bieżącą bazę. Kopie zapasowe i wcześniej pobrane
paczki roczne ([`docs/EXPORT.md`](EXPORT.md)) zawierają dane sprzed przebiegu.
Procedura założona do czasu D-04/D-07: (1) po odtworzeniu kopii bazy
administrator porównuje ją z dziennikiem operacji przechowywanym POZA bazą
(eksport `anonymization_runs`/zdarzeń `household.anonymized` — w kopii sprzed
przebiegu tych wierszy jeszcze nie ma) i ponawia przebiegi dla wskazanych
gospodarstw; (2) paczki roczne pobrane przed przebiegiem trzeba zniszczyć u
odbiorcy — serwer ich nie przechowuje. Skrypt `scripts/reapply-anonymization.js`
i automatyczne ponowienie przy odtworzeniu **nie są zrobione** (follow-up #91).

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
  migracja (furtka w triggerze w rodzaju `rd_anonymization_active()`), zadanie w
  trybie „propozycja do zatwierdzenia” i test zachowania sum. Do tego czasu
  usunięcie danych osoby oznacza wyłącznie anonimizację gospodarstwa.

## Czego to jeszcze NIE obejmuje (część #91 zostaje otwarta)

- Okresów retencji i ich zatwierdzania — D-04 (kod ich nie zawiera).
- Zadania okresowego w trybie „propozycja do zatwierdzenia” — brak
  automatycznego wykonania; przebieg zawsze uruchamia administrator.
- Skryptu `scripts/reapply-anonymization.js` i testu „odtworzenie eksportu sprzed
  anonimizacji + ponowne zastosowanie przebiegów”.
- Panelu (UI) do podglądu i zatwierdzania przebiegów oraz wstawiania polityk —
  dziś tylko API/baza.
- `users` (członkowie Rady po kadencji), `audit_events`, wolnego tekstu w
  protokołach/uchwałach/księdze (patrz „Poza zakresem” wyżej).
- Drugiego zatwierdzającego przebieg (reguła dwóch osób) — D-01/D-09.

## Zależności od decyzji zarządu/szkoły

D-04 (wartości okresów — repo dostarcza wyłącznie mechanizm rejestru i
wykonania), D-01 (kto zatwierdza wpis polityki i przebieg), D-07 (zakres
usunięcia na żądanie, weryfikacja tożsamości), D-13/D-15 (jak długo musi być
zachowana księga — przebieg jej nie rusza), IOD (anonimizacja zamiast usunięcia,
`email_hash`).
