# Eksport roczny, kopie zapasowe i test odtworzenia

Status: prototyp na PostgreSQL (issue #9), testowany wyłącznie na danych
syntetycznych w PGlite. Nie wykonano eksportu ani odtworzenia na Railway.
Okres przechowywania paczek i kopii wymaga decyzji [D-04](DECISIONS.md);
zakres pól osobowych — decyzji D-03; uprawnienia do eksportu — D-08/D-09.

Eksport roczny **nie zastępuje** backupu bazy (wolumen, PITR, `pg_dump`)
opisanego w [RAILWAY_OPERATIONS.md](RAILWAY_OPERATIONS.md). Jest drugą,
niezależną od dostawcy kopią danych jednego roku szkolnego w czytelnym
formacie, z manifestem i sumami kontrolnymi, którą da się sprawdzić i
odtworzyć do pustej bazy.

## Trasy API

| Trasa | Kto | Zawartość |
|---|---|---|
| `POST /api/exports` z `{"schoolYearId": "…"}` | admin albo zarząd, sesja z MFA, przydział bez roku lub dla tego roku | pełna paczka roku (dane rodzin i finanse) |
| `GET /api/exports/class-roster?classId=…&format=json\|csv\|xlsx` | przedstawiciel **wyłącznie własnej klasy** (i roku), a także admin i zarząd; MFA | lista uczniów klasy z opiekunami; bez wpłat, sum i identyfikatorów rodzin |

**Założenie do decyzji zarządu i szkoły (D-08, D-09):** pełny eksport mają
tylko admin i zarząd. Skarbnik, Komisja Rewizyjna i dyrekcja nie mają
dostępu, dopóki szkoła nie określi ich zakresu. Lista klasy także wymaga MFA,
bo zawiera dane dzieci i adresy e-mail opiekunów.

### Lista klasy: JSON i CSV (#132)

`format=json` (domyślny) zwraca kanoniczny JSON — bajt w bajt deterministyczny,
sortowany `COLLATE "C"`, z SHA-256 do weryfikacji. `format=csv` zwraca ten sam
zestaw danych do wydruku/otwarcia w Excelu: jeden wiersz na ucznia (nazwisko,
imię, do dwóch opiekunów w kolumnach, e-mail tylko przy zgodzie na kontakt,
pusta kolumna „Uwagi”), posortowany `Intl.Collator('pl')` (Ćwik, Łukasik,
Śliwa, Zieliński, Żak w kolejności alfabetu polskiego — nie bajtowo), z
wierszem nagłówkowym (klasa, rok, data wygenerowania) i stopką „Zawiera dane
osobowe — nie przesyłać dalej, usunąć po wykorzystaniu”. Nazwa pliku nie
zawiera nazwisk: `lista-klasy-<nazwa-klasy>-<YYYYMMDD>.csv` / `.xlsx`. Każde pobranie
(niezależnie od formatu) zapisuje `export_runs` i `export.created`; format
trafia tylko do metadanych audytu, bez migracji schematu. Format `xlsx` (#132)
składa wspólny moduł `src/pg/xlsx.js` (#121) na tych samych kolumnach i wierszach
co CSV (jeden arkusz, wiersz tytułu i stopka jak w CSV, tekst jako `inlineStr` —
imię zaczynające się od `=` zostaje tekstem); zakres ról, klasy, roku i MFA jest
identyczny jak dla JSON/CSV, a kolumny to wyłącznie dane, które ta rola widzi w
JSON (bez nowych danych osobowych, D-03). Nie ma jeszcze zbiorczego pliku „arkusz
na klasę” dla zarządu (pkt 5 issue #132 — osobny zakres, wymaga rozstrzygnięcia
D-08).
Plik ma BOM UTF-8, separator `;` i CRLF jak pozostałe eksporty CSV (wspólny
moduł `src/pg/csv.js`, #121: `toCsv`, `csvResponse`, `csvCell`). Pola tekstowe
(nazwiska, e-maile) zaczynające się od `= + - @`, tabulatora lub CR — także po
spacjach i w wersji pełnej szerokości — dostają prefiks `'`.

Odpowiedź to plik JSON jako załącznik (`Content-Disposition: attachment`,
`Cache-Control: no-store`). Nagłówki `X-Export-Run-Id` i
`X-Export-Manifest-Sha256` identyfikują przebieg. Nazwa pliku zawiera tylko
identyfikator roku lub klasy, bez danych osobowych.

Każdy przebieg zapisuje w jednej transakcji:

- wiersz `export_runs` (migracja `0016_exports.sql`): rodzaj, rok, klasa,
  wersja formatu, kto i kiedy, SHA-256 manifestu oraz liczności wierszy per
  tabela — bez treści eksportu i bez danych osobowych; wiersza nie da się
  zmienić ani usunąć;
- zdarzenie audytu `export.created` z tymi samymi licznościami.

Podwójne kliknięcie tworzy dwa przebiegi z identycznym skrótem — to
zamierzone: każde pobranie danych jest odnotowane.

## Format paczki (wersja 1)

```json
{
  "format": "rd-yearly-export",
  "formatVersion": 2,
  "manifest": {
    "format": "rd-yearly-export", "formatVersion": 2, "schoolYearId": "…",
    "schema": { "migrations": ["0001_core.sql", "…"] },
    "files": [
      { "path": "payment_entries.jsonl", "table": "payment_entries",
        "columns": ["amount_cents", "…"], "rows": 2,
        "sha256": "…", "sums": { "amount_cents": 7500 } }
    ],
    "totals": {
      "payments": { "recordedNetCents": 6500, "recordedCount": 2 },
      "ledger": { "openingBalanceCents": 0, "incomeCents": 0, "expenseCents": 0, "closingBalanceCents": 0 }
    }
  },
  "manifestSha256": "…",
  "files": { "payment_entries.jsonl": "{…}\n{…}\n" }
}
```

Reguły determinizmu (te same dane → ten sam plik bajt w bajt):

- każdy plik to JSON Lines: jeden wiersz tabeli na linię, klucze posortowane,
  kolejność wierszy według klucza głównego (`COLLATE "C"`, niezależnie od
  ustawień regionalnych serwera);
- czasy w UTC z mikrosekundami (`2026-09-15T10:00:00.000000Z`), daty
  `YYYY-MM-DD`, kwoty jako liczby całkowite w centach EUR;
- `manifestSha256` = SHA-256 kanonicznego JSON manifestu; manifest zawiera
  SHA-256, liczność i sumy `*_cents` każdego pliku;
- paczka nie zawiera identyfikatora przebiegu ani czasu utworzenia, a dziennik
  audytu w paczce pomija zdarzenia `export.*` (inaczej każdy eksport zmieniałby
  następny).

### Zakres roku

| Plik | Zakres |
|---|---|
| `school_years`, `classes`, `enrollments` | rok szkolny i jego klasy oraz przypisania |
| `students` | uczniowie z przypisaniem w danym roku |
| `student_guardians` | relacje tych uczniów (wszyscy opiekunowie, także z innych gospodarstw) |
| `guardians` | opiekunowie z tych relacji oraz opiekunowie odnotowani na zebraniach roku |
| `households` | gospodarstwa uczniów, opiekunów oraz gospodarstwa z wpłat i przypisań roku |
| `payment_entries`, `payment_corrections`, `payment_assignments` | wpłaty roku, ich korekty i przypisania |
| `payment_allocations`, `payment_allocation_reversals` | części wpłat podzielonych na gospodarstwa i ich cofnięcia z powodem (0104, #127) |
| `ledger_*` | kategorie i historia ich wyłączenia, bilans otwarcia i jego korekty, wpisy, korekty wpisów, preliminarz roku i jego przyjęcie przez zebranie (0073, #107) |
| `events`, `event_revisions` | wydarzenia roku i ich rewizje |
| `event_tasks`, `event_task_signups` | zadania i zapisy wolontariuszy wydarzeń roku (0076, #142) |
| `meetings`, `meeting_*`, `resolutions`, `resolution_execution_events` | zebrania roku, porządek, obecność, kworum, protokoły, publikacje, uchwały i historia ich wykonania (#102), wersje porządku obrad, zmiany terminu i zawiadomienia zebrań (0139, #113) |
| `student_households`, `guardian_households` | członkostwo uczniów roku (także drugie gospodarstwo przy opiece dzielonej, `is_primary`) i opiekunów z zakresu w gospodarstwach, z historią (0014) |
| `enrollment_history` | historia przypisań do klas w danym roku (0014) |
| `guardian_contact_changes` | zmiany kontaktu opiekunów z zakresu, dokonane w datach roku — **bez** poprzedniego i nowego e-maila oraz bez treści powodu (tylko identyfikatory, flagi zgody, źródło, czas; do decyzji D-03) |
| `student_guardian_changes` | historia relacji opiekun–dziecko uczniów roku (zgoda, kontakt główny, daty) z dat roku — bez treści powodu (0026, D-03) |
| `ledger_transfers` | przeniesienia kasa ↔ rachunek roku (0028) |
| `ledger_entry_reviews` | weryfikacja wydatku przez drugą osobę (decyzja, uwaga przy zakwestionowaniu) roku (0072, #97) |
| `resolution_spending_authorizations` | kwota upoważnienia z uchwały do wydatku i jej historia (0072, #93) roku |
| `ledger_allocation_versions`, `ledger_allocation_items` | wersje przypisania wpisów księgi roku do wydarzeń i klas (centra kosztów, 0090, #117) |
| `bank_reconciliations`, `bank_statement_imports`, `bank_statement_lines`, `bank_reconciliation_matches` | uzgodnienia roku z pozycjami wyciągu (tylko skróty tytułów) i powiązaniami, także cofniętymi z powodem (0015/0024) |
| `bank_reconciliation_group_matches`, `bank_reconciliation_group_match_items`, `bank_reconciliation_group_match_revocations` | dopasowania zbiorcze (jedna pozycja wyciągu ↔ kilka wpłat/wpisów), ich pozycje i cofnięcia z powodem (0105, #127) |
| `meeting_attendance_state` | licznik rewizji obecności zebrań roku (0021) |
| `document_status_events` | zastąpienie/unieważnienie dokumentu z powodem, wpisane w datach roku — dane Rady, w odróżnieniu od samego pliku (`documents` pozostaje poza paczką, patrz niżej); `document_id`/`replacement_document_id` po odtworzeniu nie mają odpowiednika, jak `source_document_id` (0066, #82) |
| `document_descriptions` | tytuł, kategoria, data i opis dokumentu (wszystkie wersje), wpisane w datach roku — dane Rady, w odróżnieniu od samego pliku (`documents` pozostaje poza paczką, patrz niżej); `document_id` po odtworzeniu nie ma odpowiednika, jak `source_document_id` (0065, #76/#313) |
| `financial_report_snapshots`, `financial_report_snapshot_approvals` | niezmienne migawki sprawozdania rocznego (JSON zagregowany, SHA-256, poprzednia migawka i powód korekty) oraz ich zatwierdzenia roku (0138, #125) |
| `school_year_closures`, `school_year_closure_checklist` | stan zamknięcia roku i lista kontrolna (0017) |
| `audit_events` | zdarzenia z `metadata.schoolYearId` = rok eksportu (nigdy wg daty); stare zdarzenia bez roku — wg roku obiektu (`entity_type`/`entity_id`: wpłaty, korekty, przypisania, zwroty, księga, przeniesienia, uzgodnienia, zamknięcie roku, klasy, zapisy, `school_year`); pozostałe (sesje, MFA, konta, role, dokumenty, importy) oraz zdarzenia typu rocznego z nieosiągalnym obiektem — wg dat roku (Europe/Brussels); bez `export.*`. Szczegóły niżej |

Zdarzenia dotyczące obiektu przypisanego do roku (wiersz ma kolumnę
`school_year_id`) niosą `metadata.schoolYearId` wzięte z TEGO wiersza, nie z
daty zapisu (#174) — inaczej wpłata dopisana we wrześniu za poprzedni rok
trafiłaby do eksportu złego roku. `insertAuditEvent` (`src/pg/audit.js`)
odrzuca (`audit_event_missing_school_year`) zdarzenie z przedrostkiem
`payment.`/`ledger.`/`reconciliation.` (część 1) albo `email.`/`meeting.`/
`resolution.`/`event.`/`news_post.` (część 2) albo `year_close.`/`report.` i
każdą rodziną finansową z podkreśleniem — `payment_*.`/`ledger_*.`/
`reconciliation_*.`, np. `ledger_opening_balance.*` (bilans otwarcia),
`ledger_category.*`, `payment_reference.*`, `payment_instructions.*` (część 3)
— bez `schoolYearId`; błąd programisty wychodzi w testach, nie po cichu
zniekształca eksport. Test statyczny `tests/audit-school-year-static.test.js`
sprawdza każdą nazwę akcji z tych rodzin w `src/pg`, więc nowa trasa (także
nieobjęta testem scenariusza) nie ominie wymogu. Wyjątki
świadomie bez tego wymogu: `news_photo.*` (biblioteka zdjęć nie ma kolumny
`school_year_id` — nie jest przypisana do jednego roku),
`email.address_suppressed` (dotyczy adresu w `email_suppressions`, bez
kolumny roku — niezależne od kampanii; `schoolYearId` jest dopisywane, gdy
zdarzenie dało się powiązać z konkretną wysyłką, ale nie jest wymagane) i
`email.webhook.previous_secret_used` (rotacja sekretu webhooka Brevo — zdarzenie
bezpieczeństwa integracji, niezwiązane z żadną konkretną kampanią ani rokiem).
Sesje, MFA i konta pozostają bez roku, jak dotąd.

### Przypisanie zdarzeń audytu do roku (#174)

Późna wpłata za rok poprzedni, korekta lub uzgodnienie wykonane po 31 sierpnia
mają w dzienniku datę nowego roku kalendarzowego, ale należą do roku obiektu.
Kolejność rozstrzygania: (1) `metadata.schoolYearId` (zdarzenia `payment.*`,
`ledger.*`, `reconciliation.*` muszą go mieć — `insertAuditEvent` odrzuca
zdarzenie bez niego); (2) dla starych zdarzeń bez roku — rok wiersza obiektu;
(3) zdarzenia bez roku z natury (sesje, MFA, konta) lub o nieosiągalnym
obiekcie trafiają do roku, w którego datach zapisano zdarzenie. Wybrano wariant
zachowawczy: dziennik jest tylko do dopisywania, więc roku nie da się dopisać,
a wyłączenie tych zdarzeń zgubiłoby ślad. Każde zdarzenie trafia do dokładnie
jednego roku z rozłącznych dat. Zdarzenie z `schoolYearId` nie jest dołączane
wg daty do żadnego innego roku. Skutek: eksport lat już wyeksportowanych może
mieć inną zawartość `audit_events` i nowy SHA-256 manifestu (stare paczki
zachowują własny manifest i nadal przechodzą weryfikację). Kolumna
`audit_events.school_year_id` — nie wprowadzono (bez migracji).

Ta sama reguła (1)–(2) działa w filtrze roku dziennika
(`GET /api/admin/audit?schoolYearId=`): stare zdarzenia bez roku w metadanych
są przypisywane przy odczycie do roku obiektu; zapisanych zdarzeń nie
zmieniamy. Reguły (3) (wg dat) filtr nie stosuje — sesje, MFA czy konta nie
należą do żadnego roku; do zawężenia po czasie służą `from`/`to`.

Tabele z modułów, których migracji nie ma w bazie, są pomijane (wykrywanie
przez `information_schema`); tabele rdzenia są wymagane.

Pola osobowe są ograniczone jawną listą w kodzie (`src/pg/export.js`), zgodną
z projektem listy D-03: uczeń — imię, nazwisko, gospodarstwo; opiekun —
imię, nazwisko, e-mail, zgoda na kontakt, gospodarstwo; relacja — zgoda,
kontakt główny, daty. Nowa kolumna w tych tabelach nie trafi do eksportu bez
zmiany kodu. Jeżeli D-03 zawęzi listę, zawęża się też eksport.

Nie są eksportowane (jawna lista `EXPORT_EXCLUDED_TABLES` w
`src/pg/export.js`, każda z uzasadnieniem; test kompletności w
`tests/pg-export-v2.test.js` zawodzi, gdy nowa tabela nie jest ani w eksporcie,
ani na tej liście): konta użytkowników (`users`: e-mail, nazwa), sesje,
zaproszenia, sekrety i limity MFA, skróty haseł, tokeny resetu hasła i limity logowania (0020), przydziały ról, wersjonowaną informację o przetwarzaniu danych `privacy_notices` i ewidencję jej przekazania `privacy_notice_deliveries` (0075, #145, D-06 — dokument organizacji, nie zawsze przypisany do jednego roku), rejestr polityk retencji `retention_policies` (0074, #91, D-04 — konfiguracja/decyzje zarządu, nie dane roku), klucze idempotencji zebrań,
metadane i pliki dokumentów (także zamiary uploadu `document_uploads`, 0032), dziennik kopii zapasowych `backup_runs` (0058, dane operacyjne), `data_access_log`, rejestr żądań osób RODO `data_subject_requests` (0068, #100 — rozliczalność wobec osób, nie dane Rady; dostęp i retencja do D-07/D-08/D-09), metadane importów (`import_batches`, D-04), rejestr idempotencji promocji uczniów `promotion_runs` (0151, #78 — same liczby; przypisania w `enrollments`),
dziennik eksportów, kampanie e-mail z odbiorcami, wykluczeniami, kolejką,
blokadami i zdarzeniami dostawcy (adresy e-mail; zakres i retencja — D-04),
pauzy wysyłki po odmowie konta przez dostawcę `email_provider_pauses` (0155, #209 — stan operacyjny kolejki jak `email_worker_runs`; zdjęcie pauzy także w `audit_events`)
oraz aktualności i zdjęcia (zgody na wizerunek, w tym rejestr wycofań
`news_photo_consent_withdrawals` (0083) — osobny zakres, D-04), w tym pliki wariantów zdjęć `news_photo_files` (#96 — jak news_photos, ten sam zakres D-04), a także zatwierdzone dane do wpłaty `payment_instructions` (IBAN/BIC generatora EPC, #92 — dane wrażliwe finansowo, niepotrzebne do odtworzenia stanu klasy/gospodarstwa; wariant zachowawczy do rewizji po D-08) oraz belgijskie referencje płatności OGM-VCS `payment_references`/`payment_reference_revocations` (#83 — pseudonim gospodarstwa jak `payment_entries.reference`; zakres i retencja do decyzji D-04, wariant zachowawczy do rewizji). Kolumny `created_by`, `actor_id`, `source_document_id` itp.
zawierają więc identyfikatory, które w odtworzonej bazie nie mają
odpowiednika. Pliki dokumentów kopiuje się osobno (patrz
[RAILWAY_OPERATIONS.md](RAILWAY_OPERATIONS.md), backup Storage Bucket).

## Weryfikacja i test odtworzenia

```sh
# 1. Tylko manifest, sumy i format (bez bazy)
node scripts/verify-export.js /private/path/rd-eksport-y-2026-v2.json

# 2. Odtworzenie do pustego PGlite w pamięci (migracje z repozytorium)
node scripts/verify-export.js /private/path/rd-eksport-y-2026-v2.json --restore-pglite

# 3. Odtworzenie do PUSTEJ bazy PostgreSQL po `npm run db:migrate:postgres`
DATABASE_URL='…' APP_ENV=staging node scripts/verify-export.js \
  /private/path/rd-eksport-y-2026-v2.json --restore-database
```

(`npm run db:verify-export -- …` jest skrótem do tego samego skryptu.)

Udane odtworzenie (`--restore-pglite` i `--restore-database`) po pozytywnej
weryfikacji sum i ponownego eksportu dopisuje zdarzenie audytu
`export.restored` (`entity_type = export`, `entity_id` = SHA-256 manifestu,
`actor_id = NULL` — operator z dostępem do bazy; metadane: skrót manifestu,
`schoolYearId`, wersja formatu, liczba tabel i wierszy, bez danych osobowych).
Nieudane odtworzenie nie zostawia zdarzenia. Zdarzenia `export.*` nie wchodzą do
kolejnych paczek, więc skrót ponownego eksportu się nie zmienia.

Kontrole weryfikacji: format i wersja, SHA-256 manifestu, zgodność listy
plików z manifestem (brak plików nadmiarowych i nieznanych tabel), SHA-256 i
liczność każdego pliku, kanoniczna postać każdej linii, zgodność kolumn oraz
sum w centach.

Odtworzenie:

- odmawia bazy, w której jakakolwiek tabela (poza `schema_migrations`) ma
  wiersze; odmawia `APP_ENV=production` (także `prod`, brak lub nieznaną wartość) bez `--allow-production`;
- działa w jednej transakcji — pierwszy błąd wycofuje całość;
- przyjmuje paczki w wersji 2 i 1 (patrz „Wersje formatu”);
- na czas transakcji wyłącza triggery i klucze obce
  (`session_replication_role = replica`, wymaga roli superużytkownika, jak
  domyślny użytkownik PostgreSQL w Railway). Paczka odtwarza stan końcowy,
  a nie przebieg operacji, więc triggery pilnujące przebiegu (np. przypisanie
  wpłaty tylko ze stanu `unmatched`) nie mogą działać przy odtwarzaniu. Po
  zatwierdzeniu triggery działają normalnie — historii nie da się zmienić;
- wyłączenie triggerów nie gubi danych: wszystko, co w działającej bazie
  wypełniają triggery (członkostwo w gospodarstwach, historia klas, licznik
  obecności zebrań), jest w paczce wersji 2. Kolumny generowane (np.
  `difference_cents`) baza wylicza sama;
- przed zatwierdzeniem transakcji porównuje z manifestem **pełną** liczność i
  sumy `*_cents` każdej odtworzonej tabeli w bazie docelowej
  (`restore_verification_failed:rows|sums:<tabela>`), sprawdza, że tabele spoza
  paczki pozostały puste (`restore_unexpected_rows:<tabela>`) i że każdy uczeń
  i opiekun ma członkostwo w gospodarstwie
  (`restore_verification_failed:derived:<tabela>`); błąd wycofuje całość;
- przestawia sekwencje kolumn `IDENTITY` za najwyższą wartość;
- po zatwierdzeniu wykonuje ponowny eksport z odtworzonej bazy i porównuje
  SHA-256, liczności i sumy każdego pliku oraz sumy wpłat i księgi. Raport
  zawiera tylko liczby i skróty.

Odtworzona baza służy do kontroli i archiwum. Nie jest bazą produkcyjną: brak
kont, sesji i dokumentów.

## Wersje formatu

| `formatVersion` | Zawartość | Weryfikacja i odtworzenie |
|---|---|---|
| 2 (od #202) | jak wyżej, z tabelami 0014, 0015/0024, 0017, 0021 i 0028 | pełne |
| 1 | bez tych tabel | przyjmowana z ostrzeżeniem `bundle_incomplete` i listą `missingTables` (skrypt wypisuje ostrzeżenie na stderr). Przy odtworzeniu członkostwo w gospodarstwach powstaje z kolumn zgodności jak backfill 0014 (`source = 'legacy_backfill'`, ostrzeżenie `households_backfilled_from_v1`) — bez drugiego gospodarstwa, historii klas, uzgodnień, przeniesień i stanu zamknięcia roku. Paczka v1 z tabelą wersji 2 jest odrzucana (`table_not_in_format_version`). |

Nieznana wersja → `unsupported_format_version`. Plik paczki ma w nazwie
wersję (`rd-eksport-<rok>-v2.json`).

## Zasady przechowywania

- Paczka i lista klasy zawierają dane osobowe dzieci i opiekunów. Zapisywać
  wyłącznie na szyfrowanym nośniku, poza repozytorium, CI, logami i
  zgłoszeniami, z prawami `0600`. Nie przesyłać e-mailem.
- Przedstawiciel klasy usuwa listę po wykorzystaniu; czas przechowywania — D-04.
- Liczbę kopii, miejsce i czas przechowywania paczek rocznych ustala
  administrator danych (D-01, D-04). Do czasu decyzji: eksport na danych
  syntetycznych i stagingu.
- Wynik testu odtworzenia wpisać do tabeli w
  [RAILWAY_OPERATIONS.md](RAILWAY_OPERATIONS.md) (bez danych osobowych).
- 0087 (#140): `guardian_update_links` (token jednorazowego linku) i
  `guardian_update_requests` (wniosek rodzica o zmianę kontaktu, z proponowanym
  e-mailem) są poza paczką roku — wariant zachowawczy do czasu decyzji zarządu
  o retencji wniosków (D-04), jak `guardian_contact_changes` (D-03).

## Ryzyka i ograniczenia

- **Pamięć i pętla zdarzeń** (#216): trasa `POST /api/exports` czyta każdą
  tabelę partiami po 2000 wierszy przez kursor w transakcji (limit 500 000
  wierszy na tabelę bez zmian), liczy SHA-256 pliku i sumy `*_cents`
  przyrostowo i po każdej partii oddaje pętlę zdarzeń (`setImmediate`), także
  wewnątrz `audit_events`. Paczka powstaje od razu jako lista buforów (poza
  stertą JS) — bez obiektów wierszy, pełnych tekstów plików i drugiej kopii
  `canonicalJson(bundle)`; bajty są te same co dotąd (format i SHA-256
  manifestu bez zmian, `formatVersion` 2). Odpowiedź ma `Content-Length` i
  adapter Node (`src/node-app.js`) przesyła ją strumieniowo z obsługą
  przeciążenia gniazda; zerwanie pobierania przez klienta anuluje strumień
  (transakcja i wiersz `export_runs` są wtedy już zatwierdzone — paczka
  powstaje przed wysyłką). Transakcja dostaje lokalnie
  `idle_in_transaction_session_timeout = 60s`. Pomiar (PGlite, dane
  syntetyczne, 200 tys. zdarzeń audytu, paczka 52 MB): szczyt sterty JS
  252 MB → 39 MB przy `--max-old-space-size=256` (skrypt
  `scripts/measure-export-memory.js`; czasy i blokada pętli PGlite nie są
  reprezentatywne, bo silnik działa w procesie — pomiar na Railway zależy od
  #41). Test wolumenowy (nocny): `RD_EXPORT_VOLUME_EVENTS=200000 node
  --max-old-space-size=256 --test tests/pg-export-streaming.test.js`.
  **Nadal nieobsłużone**: `scripts/verify-export.js` wczytuje całą paczkę
  jednym `JSON.parse` (weryfikacja i odtworzenie); paczka w buforach nadal
  zajmuje ok. jednej kopii rozmiaru pliku w pamięci procesu (poza stertą),
  a `restoreBundle` i tryb bez `{ stream: true }` (testy) budują ją jak dotąd
  w stringach.
- **Blokada jednego eksportu na rok** (#216): `POST /api/exports` bierze
  `pg_try_advisory_xact_lock(hashtext('rd_export:'||rok))` na czas transakcji
  budującej paczkę. Drugi równoczesny przebieg tego samego roku dostaje od
  razu `409 export_in_progress` (bez czekania) zamiast budować drugą paczkę
  naraz — to zapobiega podwójnemu zużyciu pamięci i dwóm wierszom
  `export_runs` przy podwójnym kliknięciu „Eksportuj”. Blokada zwalnia się
  sama na COMMIT/ROLLBACK; różne lata eksportują się równolegle bez
  przeszkód.
- Zmiana schematu wymaga oceny, czy trzeba podnieść `formatVersion`.
  Weryfikator odrzuca nieznaną wersję; odtworzenie wymaga, by docelowy
  schemat miał wszystkie kolumny z manifestu.
- Test odtworzenia w CI działa na PGlite (WASM), nie na PostgreSQL Railway.
- Lista klasy jest pobierana metodą GET z ciasteczkiem `SameSite=Lax`:
  przekierowanie z obcej strony może wywołać zapis przebiegu w dzienniku, ale
  nie daje obcej stronie dostępu do treści.
