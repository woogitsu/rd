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
  "formatVersion": 1,
  "manifest": {
    "format": "rd-yearly-export", "formatVersion": 1, "schoolYearId": "…",
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
| `ledger_*` | kategorie, bilans otwarcia i jego korekty, wpisy, korekty wpisów, preliminarz roku |
| `events`, `event_revisions` | wydarzenia roku i ich rewizje |
| `meetings`, `meeting_*`, `resolutions` | zebrania roku, porządek, obecność, kworum, protokoły, publikacje, uchwały |
| `audit_events` | zdarzenia oznaczone tym rokiem (`schoolYearId`), a bez oznaczenia — z dat roku (Europe/Brussels); bez `export.*` |

Tabele z modułów, których migracji nie ma w bazie, są pomijane (wykrywanie
przez `information_schema`); tabele rdzenia są wymagane.

Pola osobowe są ograniczone jawną listą w kodzie (`src/pg/export.js`), zgodną
z projektem listy D-03: uczeń — imię, nazwisko, gospodarstwo; opiekun —
imię, nazwisko, e-mail, zgoda na kontakt, gospodarstwo; relacja — zgoda,
kontakt główny, daty. Nowa kolumna w tych tabelach nie trafi do eksportu bez
zmiany kodu. Jeżeli D-03 zawęzi listę, zawęża się też eksport.

Nie są eksportowane: konta użytkowników (`users`: e-mail, nazwa), sesje,
zaproszenia, przydziały ról, klucze idempotencji zebrań, metadane i pliki
dokumentów. Kolumny `created_by`, `actor_id`, `source_document_id` itp.
zawierają więc identyfikatory, które w odtworzonej bazie nie mają
odpowiednika. Pliki dokumentów kopiuje się osobno (patrz
[RAILWAY_OPERATIONS.md](RAILWAY_OPERATIONS.md), backup Storage Bucket).

## Weryfikacja i test odtworzenia

```sh
# 1. Tylko manifest, sumy i format (bez bazy)
node scripts/verify-export.js /private/path/rd-eksport-y-2026-v1.json

# 2. Odtworzenie do pustego PGlite w pamięci (migracje z repozytorium)
node scripts/verify-export.js /private/path/rd-eksport-y-2026-v1.json --restore-pglite

# 3. Odtworzenie do PUSTEJ bazy PostgreSQL po `npm run db:migrate:postgres`
DATABASE_URL='…' APP_ENV=staging node scripts/verify-export.js \
  /private/path/rd-eksport-y-2026-v1.json --restore-database
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
- na czas transakcji wyłącza triggery i klucze obce
  (`session_replication_role = replica`, wymaga roli superużytkownika, jak
  domyślny użytkownik PostgreSQL w Railway). Paczka odtwarza stan końcowy,
  a nie przebieg operacji, więc triggery pilnujące przebiegu (np. przypisanie
  wpłaty tylko ze stanu `unmatched`) nie mogą działać przy odtwarzaniu. Po
  zatwierdzeniu triggery działają normalnie — historii nie da się zmienić;
- przestawia sekwencje kolumn `IDENTITY` za najwyższą wartość;
- po zatwierdzeniu wykonuje ponowny eksport z odtworzonej bazy i porównuje
  SHA-256, liczności i sumy każdego pliku oraz sumy wpłat i księgi. Raport
  zawiera tylko liczby i skróty.

Odtworzona baza służy do kontroli i archiwum. Nie jest bazą produkcyjną: brak
kont, sesji i dokumentów.

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
- Zmiana schematu wymaga oceny, czy trzeba podnieść `formatVersion`.
  Weryfikator odrzuca nieznaną wersję; odtworzenie wymaga, by docelowy
  schemat miał wszystkie kolumny z manifestu.
- Test odtworzenia w CI działa na PGlite (WASM), nie na PostgreSQL Railway.
- Lista klasy jest pobierana metodą GET z ciasteczkiem `SameSite=Lax`:
  przekierowanie z obcej strony może wywołać zapis przebiegu w dzienniku, ale
  nie daje obcej stronie dostępu do treści.
