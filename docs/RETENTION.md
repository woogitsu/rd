# Retencja (D-04) — rejestr polityk i raport kandydatów

> Ten dokument opisuje mechanizm, nie treść decyzji. Okresy przechowywania,
> kto je zatwierdza i na jakiej podstawie ustala zarząd/szkoła z IOD (D-04,
> patrz [`docs/DECISIONS.md`](DECISIONS.md)). Kod **nie zawiera żadnej
> wartości domyślnej** retencji — brak wiersza w `retention_policies` znaczy
> „nie usuwaj”, tak jak dziś działa `documents.retain_until = NULL`.

## Co jest w tym PR

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
| `export_package` | `export_runs` (rok szkolny) |
| `import_file` | `import_batches` (rok szkolny) |

## Jak wpisać decyzję D-04

Administrator/zarząd wstawia wiersz `retention_policies` (dziś: bezpośrednio
w bazie przez administratora technicznego — panel do tego nie jest częścią
tego PR, patrz „Czego nie obejmuje”) z `data_category`, jednym z
`retain_for`/`retain_until_rule`, `decision_ref` wskazującym uchwałę i, jeśli
zatwierdzenie jest oddzielone od wpisania, `approved_by` innej osoby. Wiersz
sam w sobie **niczego nie usuwa** — to wyłącznie rejestr.

## Czego ten PR NIE obejmuje (świadomie, część #91)

- **Wykonania retencji** — funkcji `rd_anonymize_household` i jakiegokolwiek
  mechanizmu usuwania/anonimizacji. Propozycja z issue #91 (anonimizacja z
  zachowaniem sum księgi, ominięcie guardów przez `rd.anonymization_run`,
  `anonymization_runs`) wymaga osobnego PR z pełnym zestawem testów rodzeństwa,
  opieki dzielonej, wpłat częściowych i podwójnego uruchomienia — zbyt duże i
  zbyt ryzykowne ryzyko (błąd w guardach mógłby dotknąć kwoty/daty w księdze),
  by łączyć z samym rejestrem polityk.
- Panelu do wstawiania polityk przez UI — dziś tylko przez bazę/API
  bezpośrednio (bez roli w panelu).
- Procedury dla kopii zapasowych i paczek eksportu („dług anonimizacji”,
  `scripts/reapply-anonymization.js`) — zależy od funkcji wykonującej powyżej.
- Żądania usunięcia na życzenie (D-07) — ta sama uwaga: wymaga funkcji
  wykonującej.

## Zależności od decyzji zarządu/szkoły

D-04 (wartości okresów — repo dostarcza wyłącznie mechanizm rejestru),
D-01 (kto zatwierdza wpis), D-07 (usuwanie na żądanie, gdy powstanie funkcja
wykonująca).
