# Wykrywanie możliwych danych osobowych w polach wolnego tekstu (#152)

Deterministyczny, lokalny moduł `src/pg/pii-check.js` wykrywa w tekście prawdopodobne dane osobowe — e-mail, IBAN (BE/PL, walidacja mod-97), telefon PL/BE oraz **znane imię i nazwisko** (uczniowie zapisani w danym roku szkolnym i opiekunowie ich gospodarstw, porównanie znormalizowane, bez diakrytyków). Nic nie jest wysyłane na zewnątrz; wynik zawiera **wyłącznie kategorie i liczby trafień**, nigdy dopasowany fragment ani nazwisko — ani w odpowiedzi API, ani w `audit_events`, ani w logach.

To środek wspierający, nie zastępuje odpowiedzialności osoby zapisującej (fałszywe alarmy są możliwe, np. nazwisko identyczne z nazwą ulicy).

## Co ten PR obejmuje

- **Korekta wpłaty** (`POST /api/payments/:id/corrections`, pole `reason`, tabela `payment_corrections` — niezmienna po zapisie): przy wykryciu trafienia serwer zwraca `422 possible_personal_data` z listą kategorii. Ponowne wysłanie z `confirmPersonalData: true` i tym samym `Idempotency-Key` zapisuje korektę; `audit_events` dostaje metadane `piiConfirmed: true` + `piiCategories` (bez treści). Podwójne kliknięcie z potwierdzeniem i tym samym kluczem = jeden wpis (istniejąca idempotencja trasy).
- **Publikacja protokołu jako publiczny** (`setMinutesVisibility`, widoczność `public`, `src/pg/meetings.js`): przy wykryciu trafienia w treści zatwierdzonego protokołu serwer **twardo blokuje** publikację (`409 minutes_contain_personal_data`) — zgodnie z AGENTS.md „widok publiczny wyłącznie zatwierdzone dane”. Widoczność `internal`/`parents` nie jest blokowana.

## Czego ten PR świadomie NIE obejmuje

- Pozostałych pól z tabeli w issue #152: `payment_entries.reference` (sama wpłata — patrz #83 dla nowych wpłat i D-04 dla `reference_hash`/retencji historycznych), `ledger_entries.description`, `ledger_corrections.reason`, `ledger_opening_balance_adjustments.reason`, `bank_reconciliations.notes`, `bank_reconciliation_matches.revoke_reason`, `meeting_agenda_items.description`, `resolutions.correction_reason`, `guardian_contact_changes.reason`, `news_photos.rights_note`/`revocation_reason`. Każde z nich wymaga osobnej integracji z `pii-check.js` w swojej trasie zapisu — zrobione tu tylko dwa reprezentatywne przypadki z kryteriów akceptacji (korekta wpłaty, publikacja protokołu), żeby nie łączyć zbyt wielu tras w jednym PR.
- Wyjątku „druga osoba zatwierdza publikację mimo trafienia” (np. nazwisko członka Rady pełniącego funkcję) — patrz założenie techniczne przy D-08 i D-21 w `docs/DECISIONS.md`. Dziś: zawsze twarda blokada `public`.
- Listy dozwolonej `users.display_name` członków Rady.
- Podpowiedzi UI przy polach („Nie wpisuj imion dzieci…”) — brak zmian w panelach w tym PR.
- Kolumny `reference_hash` na `payment_entries` — czeka na D-04 (okres retencji jawnej referencji).

## Wydajność

`detectPossiblePersonalData` przy ~1000 znanych imionach/nazwiskach wykonuje się poniżej 50 ms (test `tests/pii-check.test.js`) — dopasowanie liniowe po zbiorze znormalizowanych słów tekstu, bez zapytań do bazy poza jednorazowym pobraniem listy imion/nazwisk dla roku szkolnego.
