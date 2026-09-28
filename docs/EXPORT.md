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
| `GET /api/exports/class-roster?classId=…&format=json\|csv` | przedstawiciel **wyłącznie własnej klasy** (i roku), a także admin i zarząd; MFA | lista uczniów klasy z opiekunami; bez wpłat, sum i identyfikatorów rodzin |

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
zawiera nazwisk: `lista-klasy-<nazwa-klasy>-<YYYYMMDD>.csv`. Każde pobranie
(niezależnie od formatu) zapisuje `export_runs` i `export.created`; format
trafia tylko do metadanych audytu, bez migracji schematu. XLSX celowo
pominięty — brak lekkiej biblioteki do zapisu bez nowej ciężkiej zależności.

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
| `ledger_*` | kategorie, bilans otwarcia i jego korekty, wpisy, korekty wpisów, preliminarz roku |
| `events`, `event_revisions` | wydarzenia roku i ich rewizje |
| `meetings`, `meeting_*`, `resolutions`, `resolution_execution_events` | zebrania roku, porządek, obecność, kworum, protokoły, publikacje, uchwały i historia ich wykonania (#102) |
| `student_households`, `guardian_households` | członkostwo uczniów roku (także drugie gospodarstwo przy opiece dzielonej, `is_primary`) i opiekunów z zakresu w gospodarstwach, z historią (0014) |
| `enrollment_history` | historia przypisań do klas w danym roku (0014) |
| `guardian_contact_changes` | zmiany kontaktu opiekunów z zakresu, dokonane w datach roku — **bez** poprzedniego i nowego e-maila oraz bez treści powodu (tylko identyfikatory, flagi zgody, źródło, czas; do decyzji D-03) |
| `student_guardian_changes` | historia relacji opiekun–dziecko uczniów roku (zgoda, kontakt główny, daty) z dat roku — bez treści powodu (0026, D-03) |
| `ledger_transfers` | przeniesienia kasa ↔ rachunek roku (0028) |
| `bank_reconciliations`, `bank_statement_imports`, `bank_statement_lines`, `bank_reconciliation_matches` | uzgodnienia roku z pozycjami wyciągu (tylko skróty tytułów) i powiązaniami, także cofniętymi z powodem (0015/0024) |
| `meeting_attendance_state` | licznik rewizji obecności zebrań roku (0021) |
| `school_year_closures`, `school_year_closure_checklist` | stan zamknięcia roku i lista kontrolna (0017) |
| `audit_events` | zdarzenia oznaczone tym rokiem (`schoolYearId`), a bez oznaczenia — z dat roku (Europe/Brussels); bez `export.*` |

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
zaproszenia, sekrety i limity MFA, skróty haseł, tokeny resetu hasła i limity logowania (0020), przydziały ról, klucze idempotencji zebrań,
metadane i pliki dokumentów (także zamiary uploadu `document_uploads`, 0032), dziennik kopii zapasowych `backup_runs` (0058, dane operacyjne), `data_access_log`, metadane importów (`import_batches`, D-04),
dziennik eksportów, kampanie e-mail z odbiorcami, wykluczeniami, kolejką,
blokadami i zdarzeniami dostawcy (adresy e-mail; zakres i retencja — D-04)
oraz aktualności i zdjęcia (zgody na wizerunek — osobny zakres). Kolumny `created_by`, `actor_id`, `source_document_id` itp.
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

Kontrole weryfikacji: format i wersja, SHA-256 manifestu, zgodność listy
plików z manifestem (brak plików nadmiarowych i nieznanych tabel), SHA-256 i
liczność każdego pliku, kanoniczna postać każdej linii, zgodność kolumn oraz
sum w centach.

Odtworzenie:

- odmawia bazy, w której jakakolwiek tabela (poza `schema_migrations`) ma
  wiersze; odmawia `APP_ENV=production` bez `--allow-production`;
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

## Ryzyka i ograniczenia

- Paczka jest budowana w pamięci (limit 500 000 wierszy na tabelę). Dla
  jednej szkoły wystarcza; przy większych danych potrzebny będzie strumień.
  **Nie jest jeszcze zaimplementowane** (#216, poza zakresem PR, który dodał
  punkty niżej): strumieniowy format v2 (kursor, partie, SHA-256 przyrostowo),
  odpowiedź HTTP jako `ReadableStream` bez buforowania w `node-app.js` i
  podniesienie/pilnowanie `idle_in_transaction_session_timeout` w trakcie
  budowania paczki. Rok z ok. 200 tys. zdarzeń audytu nadal może wyczerpać
  stertę procesu przy niskim limicie pamięci usługi.
- **Blokada jednego eksportu na rok** (#216): `POST /api/exports` bierze
  `pg_try_advisory_xact_lock(hashtext('rd_export:'||rok))` na czas transakcji
  budującej paczkę. Drugi równoczesny przebieg tego samego roku dostaje od
  razu `409 export_in_progress` (bez czekania) zamiast budować drugą paczkę
  naraz — to zapobiega podwójnemu zużyciu pamięci i dwóm wierszom
  `export_runs` przy podwójnym kliknięciu „Eksportuj”. Blokada zwalnia się
  sama na COMMIT/ROLLBACK; różne lata eksportują się równolegle bez
  przeszkód. Między kolejnymi tabelami paczki proces oddaje pętlę zdarzeń
  (`setImmediate`) — zmniejsza to, ale nie eliminuje, blokowanie innych
  żądań podczas budowania bardzo dużej paczki (patrz punkt wyżej).
- Zmiana schematu wymaga oceny, czy trzeba podnieść `formatVersion`.
  Weryfikator odrzuca nieznaną wersję; odtworzenie wymaga, by docelowy
  schemat miał wszystkie kolumny z manifestu.
- Test odtworzenia w CI działa na PGlite (WASM), nie na PostgreSQL Railway.
- Lista klasy jest pobierana metodą GET z ciasteczkiem `SameSite=Lax`:
  przekierowanie z obcej strony może wywołać zapis przebiegu w dzienniku, ale
  nie daje obcej stronie dostępu do treści.
