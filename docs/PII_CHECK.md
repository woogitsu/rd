# Wykrywanie możliwych danych osobowych w polach wolnego tekstu (#152)

Deterministyczny, lokalny moduł `src/pg/pii-check.js` wykrywa w tekście prawdopodobne dane osobowe — e-mail, IBAN (BE/PL, walidacja mod-97), telefon PL/BE oraz **znane imię i nazwisko** (uczniowie zapisani w danym roku szkolnym i opiekunowie ich gospodarstw, porównanie znormalizowane, bez diakrytyków). Nic nie jest wysyłane na zewnątrz; wynik zawiera **wyłącznie kategorie i liczby trafień**, nigdy dopasowany fragment ani nazwisko — ani w odpowiedzi API, ani w `audit_events`, ani w logach.

To środek wspierający, nie zastępuje odpowiedzialności osoby zapisującej (fałszywe alarmy są możliwe, np. nazwisko identyczne z nazwą ulicy).

## Zakres pierwszego PR (#339)

- **Korekta wpłaty** (`POST /api/payments/:id/corrections`, pole `reason`, tabela `payment_corrections` — niezmienna po zapisie): przy wykryciu trafienia serwer zwraca `422 possible_personal_data` z listą kategorii (po rozszerzeniu bramki e-mail, IBAN i numer rejestru krajowego są odrzucane bez możliwości potwierdzenia, patrz niżej). Ponowne wysłanie z `confirmPersonalData: true` i tym samym `Idempotency-Key` zapisuje korektę; `audit_events` dostaje metadane `piiConfirmed: true` + `piiCategories` (bez treści). Podwójne kliknięcie z potwierdzeniem i tym samym kluczem = jeden wpis (istniejąca idempotencja trasy).
- **Publikacja protokołu jako publiczny** (`setMinutesVisibility`, widoczność `public`, `src/pg/meetings.js`): przy wykryciu trafienia w treści zatwierdzonego protokołu serwer **twardo blokuje** publikację (`409 minutes_contain_personal_data`) — zgodnie z AGENTS.md „widok publiczny wyłącznie zatwierdzone dane”. Widoczność `internal`/`parents` nie jest blokowana.

## Stan dziś: zakres bramki

Od pierwszego PR bramka została rozszerzona na wspólny moduł `src/pg/pii-gate.js`. Wszystkie pola wolnego tekstu z tabeli w issue #152 mają dziś bramkę po stronie serwera (lista `GATED_FIELDS`, ok. 60 pól, m.in. `payment_entries.reference`, `payment_corrections.reason`, `ledger_entries.description`, `ledger_corrections.reason`, `ledger_opening_balance_adjustments.reason`, `bank_reconciliations.notes`, `bank_reconciliation_matches.revoke_reason`, `meeting_agenda_items.description`, `meeting_minutes.body`, `resolutions.correction_reason`, `guardian_contact_changes.reason`, `news_photos.rights_note` i `revocation_reason`). Pole wolnego tekstu bez bramki musi mieć jawny wpis w `EXEMPT_FIELDS` z uzasadnieniem, a pokrycie każdego pola `free_text` tabeli niezmiennej z `privacy/data-inventory.json` pilnuje `tests/pii-gate-coverage.test.js`. Reguły odrzucenia i potwierdzenia: e-mail, IBAN i numer rejestru krajowego to zawsze `422 personal_data_forbidden`; telefon i znane imię i nazwisko to `422 possible_personal_data` i ponowienie z `confirmPersonalData: true` (szczegóły w sekcji „Aktualności i wydarzenia” niżej).

## Czego bramka nie obejmuje

- Wyjątku „druga osoba zatwierdza publikację mimo trafienia” (np. nazwisko członka Rady pełniącego funkcję) — patrz założenie techniczne przy D-08 i D-21 w `docs/DECISIONS.md`. Dziś: zawsze twarda blokada `public`.
- Listy dozwolonej `users.display_name` członków Rady.
- Kolumny `reference_hash` na `payment_entries` — czeka na D-04 (okres retencji jawnej referencji).

## Aktualności i wydarzenia (rewizje niezmienne)

Każda zmiana treści aktualności (`news_post_revisions`) i wydarzenia (`event_revisions`) jest niezmienną rewizją, więc wpisane dane osobowe zostają w historii i w eksporcie. Bramka (`src/pg/pii-gate.js`) działa po stronie serwera w `createDraft` i `updateDraft` obu modułów (`src/pg/news.js`, `src/pg/events.js`) i obejmuje pola `news_post_revisions.title`, `news_post_revisions.body`, `event_revisions.title`, `event_revisions.description`:

- e-mail, IBAN i numer rejestru krajowego — odrzucane zawsze (`422 personal_data_forbidden`), bez flagi obejścia;
- telefon i znane imię i nazwisko ucznia lub opiekuna z roku szkolnego wpisu — `422 possible_personal_data`, zapis po ponowieniu z `confirmPersonalData: true`; dotyczy także przedstawiciela klasy zapisującego szkic (zakres klasy bez zmian);
- przy aktualizacji sprawdzane są wyłącznie pola zmienione w tej rewizji (niezmieniony tekst nie wymaga ponownego potwierdzenia);
- `audit_events` dostaje `piiConfirmed` i `piiCategories` (bez treści); ponowienie tego samego żądania z kluczem idempotencji nie tworzy drugiego wpisu;
- zatwierdzenie i publikacja nadal wymagają osobnej osoby z zarządu (cztery oczy) — bramka ich nie zastępuje.

Powody **odwołania wydarzenia** (`POST /api/events/{eventId}/cancel`, kolumna `events.cancellation_reason`) i **wycofania aktualności** (`POST /api/news/{postId}/withdraw`, kolumna `news_posts.withdrawal_reason`) przechodzą tę samą bramkę (znane imiona z roku szkolnego wpisu, `confirmPersonalData: true` w treści żądania, metadane `piiConfirmed`/`piiCategories` w `audit_events`). Bramka działa dopiero po sprawdzeniu roli, zakresu i stanu, więc ponowienie odwołania/wycofania (już wykonanego) nie wymaga ponownego potwierdzenia i nie tworzy drugiego zapisu.

Założenie zachowawcze (do decyzji zarządu/IOD): publiczny kontakt e-mail w treści aktualności lub wydarzenia jest odrzucany tak samo jak w polach finansowych; adres kontaktowy Rady podaje się przez stałe dane strony, nie w treści. Pola `location` i `organizer` wydarzenia nie są objęte bramką (nazwy miejsc i organizacji; nie są polem wolnego tekstu o osobach) — do rewizji, jeśli zarząd uzna inaczej. Wydłużenie okresu przechowywania i `reference_hash` dla `payment_entries.reference` nadal czekają na D-04.

## Wydajność

`detectPossiblePersonalData` przy ~1000 znanych imionach/nazwiskach wykonuje się poniżej 50 ms (test `tests/pii-check.test.js`) — dopasowanie liniowe po zbiorze znormalizowanych słów tekstu, bez zapytań do bazy poza jednorazowym pobraniem listy imion/nazwisk dla roku szkolnego.
