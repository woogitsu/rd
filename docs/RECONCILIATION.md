# Uzgodnienie rachunku i raport dla Komisji Rewizyjnej

Zakres: issue #7 (uzgodnienie księgi z wyciągiem bankowym) i przygotowanie raportu rocznego dla Komisji Rewizyjnej (#15). Prototyp na PostgreSQL (`src/pg/routes/reconciliation.js`, `src/pg/audit-report.js`, migracja `postgres/migrations/0015_reconciliation.sql`). Nie jest wdrożony i nie jest zatwierdzony do pracy na danych rodzin ani na prawdziwych wyciągach.

## Otwarte decyzje i przyjęte założenia

- **D-13 (rachunek, gotówka, uzgadnianie)** — nieustalone: który rachunek, format wyciągu, częstotliwość i kto uzgadnia. Moduł przyjmuje **ogólny CSV** (data, kwota, tytuł), wiersze JSON wpisane ręcznie oraz — od #105 — pliki **CODA** (Febelfin) i **CAMT.053** (ISO 20022). Import z pliku jest **wyłączony**, dopóki serwer nie ma zatwierdzonego rachunku Rady (`RECONCILIATION_BANK_ACCOUNT_IBAN`) i klucza HMAC (`BANK_TRANSACTION_HASH_KEY`) — patrz „Import CODA / CAMT.053” niżej. Profile CSV konkretnych banków i MT940 nie są objęte.
- **Gotówka** — saldo księgi obejmuje wszystkie metody (`bank`, `cash`, `card`, `other`). Uzgodnienie pokazuje osobno `ledgerNonBankCents` — część salda poza rachunkiem: gotówka z bilansu otwarcia (z poprawkami), netto wpisów innych niż `bank` i przeniesienia kasa ↔ rachunek do daty wyciągu (0028, #199). Dzięki temu gotówka przeniesiona zamknięciem roku nadal wyjaśnia różnicę w nowym roku, a wpłata gotówki na rachunek (przeniesienie `cash_to_bank`) zeruje ją bez fikcyjnego przychodu i wydatku. Szkice przeliczają wartość na bieżąco; zatwierdzone uzgodnienia mają ją utrwaloną. Założenie D-13: jedna kasa i jeden rachunek. Powiązanie pozycji wyciągu z przeniesieniem (`transfer_id`) nie jest jeszcze możliwe.
- **Cztery oczy (założenie, nie decyzja)** — uzgodnienie zatwierdza inna osoba niż jego autor (`confirmed_by <> created_by`, sprawdzane w API i w bazie). Role: `admin`, `board`, `treasurer` z MFA w zakresie roku. Zasady zatwierdzania musi potwierdzić Rada.
- **D-09 (dyrekcja i Komisja Rewizyjna)** — raport roczny otrzymują zgodnie z zakresem zadania role `audit`, `board` i `treasurer` z MFA. Rola `admin` (techniczna), `principal` i `representative` dostają `403`. Uzgodnienia (szczegóły, pozycje wyciągu) pozostają dla ról finansowych; `audit` widzi ich status i różnice w raporcie. Zakres dostępu wymaga decyzji szkoły.
- **D-15 (uchwały powyżej 3000 EUR)** — raport łączy `resolution_reference` z przyjętą uchwałą przez widok `ledger_resolution_links` (0009). Brak zgodnej przyjętej uchwały jest **oznaczany**, a nie blokowany. Nie sprawdzamy, czy uchwała poprzedziła wydatek ani czy kwota mieści się w uchwale.

## Model danych (0015_reconciliation.sql)

- `bank_reconciliations` — rok, data wyciągu (w granicach roku szkolnego), saldo z wyciągu podane przez skarbnika (centy EUR, może być ujemne), saldo księgi i netto wpisów niebankowych **wyliczane przez bazę** (`ledger_balance_at`, `ledger_non_bank_net_at`), różnica jako kolumna generowana, status `draft`/`confirmed`, notatka, autor, zatwierdzający, wyjaśnienie różnicy, klucz idempotencji. Klient nie może podać salda księgi — trigger je nadpisuje.
- Saldo księgi na dzień D = bilans otwarcia z wszystkimi korektami bilansu + przychody netto − wydatki netto wpisów z datą ≤ D. Korekta wpisu liczy się z datą korygowanego wpisu (w księdze nie ma osobnej daty skutku korekty).
- Szkic pokazuje saldo księgi **na bieżąco**. Zatwierdzenie przelicza je ostatni raz i zamraża. Późniejszy wpis z wcześniejszą datą nie zmienia zatwierdzonego uzgodnienia; trzeba utworzyć nowe uzgodnienie.
- Różnica ≠ 0 wymaga wyjaśnienia (`confirmationNote`) przy zatwierdzeniu (ograniczenie w bazie).
- `bank_statement_imports` i `bank_statement_lines` — paczka importu (źródło `manual`/`csv`/`coda`/`camt053`, liczba pozycji, skrót treści do idempotencji) i pozycje: data księgowania (≤ data wyciągu), kwota ze znakiem (+ wpływ, − wypływ), opcjonalny skrót tytułu. Pozycji nie można zmienić ani usunąć.
- `bank_reconciliation_matches` — ręcznie zatwierdzone powiązanie pozycji z **jednym** wpisem księgi albo **jedną** wpłatą. Baza sprawdza rok, kierunek i równość kwoty netto. Jedna aktywna para na pozycję i na wpis/wpłatę w uzgodnieniu. Błędne powiązanie cofa się (`revoked_at`, `revoked_by`, powód) — wiersz zostaje.
- Po zatwierdzeniu uzgodnienia baza odrzuca każdy nowy import, powiązanie, cofnięcie i zmianę. Niczego nie można usunąć.

Skutki dla danych: migracja wyłącznie dodaje tabele, funkcje, triggery i indeksy; nie zmienia istniejących wierszy księgi, wpłat ani uchwał. Wycofanie na pustej bazie = usunięcie tych obiektów; na bazie z danymi — tylko po kopii zapasowej i decyzji o retencji (D-04).

Ograniczenia: od #105 jedno aktywne powiązanie wpłaty/wpisu w całym roku (nie tylko w uzgodnieniu). Brak dopasowań wiele-do-jednego (np. jeden przelew zbiorczy za kilka wpłat) i dopasowań z różną kwotą — różnicę opisuje się w wyjaśnieniu. Brak porzucania szkicu (szkic pozostaje; tworzy się nowy).

## Tytuł przelewu i dane osobowe

Tytuł przelewu z wyciągu może zawierać imiona, nazwiska i numery. Serwer **nie zapisuje go**. Po normalizacji (NFKC, małe litery, pojedyncze spacje) zapisuje tylko SHA-256 z losową solą właściwą dla uzgodnienia. Skrót służy do wykrycia możliwych duplikatów importu i do wskazania, że tytuł zgadza się z referencją wpłaty (`referenceMatch` w propozycjach).

To pseudonimizacja, nie anonimizacja: sól leży obok skrótu, więc przy znanej liście nazwisk skrót można sprawdzić słownikowo. Dane traktujemy nadal jako osobowe (retencja D-04). Nie zapisujemy numeru rachunku kontrahenta ani salda z pozycji. Dziennik audytu nie zawiera kwot, tytułów ani identyfikatorów rodzin.

## API

Wszystkie zapisy wymagają sesji, MFA, zgodnego `Origin` i — poza zatwierdzeniem i cofnięciem — nagłówka `Idempotency-Key`. Ponowienie z tym samym kluczem i treścią zwraca `200` z `Idempotency-Replayed: true`; inna treść lub inna osoba — `409 idempotency_conflict`.

| Trasa | Opis |
| --- | --- |
| `GET /api/reconciliations?schoolYearId=` | lista uzgodnień roku |
| `POST /api/reconciliations` | szkic: `schoolYearId`, `statementDate`, `statementBalanceCents`, `notes?` |
| `GET /api/reconciliations/{id}` | szczegóły, pozycje (bez tytułu, tylko `hasReference`), powiązania z historią cofnięć, niedopasowane pozycje i niedopasowane wpisy bankowe księgi do daty wyciągu |
| `POST /api/reconciliations/{id}/lines` | import: `{ "lines": [{ "bookedOn", "amountCents", "reference?" }] }`, `{ "csv": "…" }`, `{ "coda": "…" }` albo `{ "camt053": "…" }`, do 500 pozycji; CSV/JSON: `possibleDuplicateCount`; plik: `skippedDuplicates`, `warnings`, `fileBalances` |
| `GET /api/reconciliations/{id}/suggestions?windowDays=7` | propozycje po kwocie i dacie (0–31 dni); **nic nie zatwierdza** |
| `POST /api/reconciliations/{id}/matches` | zatwierdzenie powiązania: `statementLineId` i `ledgerEntryId` albo `paymentEntryId` |
| `POST /api/reconciliations/{id}/matches/{matchId}/revocation` | cofnięcie powiązania z powodem |
| `POST /api/reconciliations/{id}/confirm` | zatwierdzenie przez drugą osobę; `confirmationNote` wymagane przy różnicy |
| `GET /api/reports/audit?schoolYearId=&format=json\|html` | raport roczny |

Propozycje obejmują wpisy księgi oraz wpłaty, które nie są jeszcze ujęte w księdze (wpłata ujęta w księdze jest proponowana jako wpis księgi).

### Spójność powiązań (0024_reconciliation_match_integrity.sql, #162, część #165)

- Wpłata i wpis księgi z `payment_entry_id` tej wpłaty to te same pieniądze. W jednym uzgodnieniu aktywne może być tylko jedno z nich: `409 already_matched_via_ledger` (wpłata, której wpis jest już powiązany) albo `409 already_matched_via_payment` (wpis, którego wpłata jest już powiązana). To samo sprawdza trigger `bank_match_guard`, także przy bezpośrednim `INSERT`; powiązania jednego uzgodnienia wykonują się po kolei (blokada wiersza uzgodnienia). Cofnięcie powiązania zwalnia drugą stronę pary. Wpis wyjaśniony przez powiązaną wpłatę nie jest na liście `unmatchedLedgerEntries`.
- Trigger blokuje wiersz celu (`FOR SHARE`) przed porównaniem kwoty netto, więc równoległa korekta kończy się pierwsza, a powiązanie porównuje kwotę z nowym netto.
- Zatwierdzenie ponownie sprawdza wszystkie aktywne powiązania (kwota pozycji = dzisiejsze netto celu, brak podwójnego ujęcia) pod blokadą celów: `409 inconsistent_matches` z listą `matches` (`matchId`, `statementLineId`, `ledgerEntryId`/`paymentEntryId`, `lineAmountCents`, `targetNetCents`, `reasons`: `amount_mismatch`, `double_counted`). Skarbnik cofa takie powiązanie z powodem i wiąże pozycję ponownie. Trigger zatwierdzenia odrzuca to samo przy bezpośrednim `UPDATE`.
- Szczegóły uzgodnienia podają `summary.inconsistentMatchCount` i `inconsistentMatches`. Widok `bank_match_consistency` pokazuje aktywne powiązania z flagami `amount_matches` i `double_counted`; migracja niczego nie zmienia, istniejące niespójne powiązania (także w zatwierdzonych uzgodnieniach) wykazuje zapytanie kontrolne z nagłówka migracji.
- **Korekta z aktywnym powiązaniem w szkicu (0039, reszta #165).** `POST /api/ledger/{id}/corrections` i `POST /api/payments/{id}/corrections` sprawdzają, czy cel ma aktywne (niecofnięte) powiązanie w uzgodnieniu o statusie `draft`; jeśli tak — `409 active_bank_match` z `reconciliationId` do cofnięcia. Wariant zachowawczy: system NIE cofa powiązania automatycznie — skarbnik najpierw cofa je sam (z powodem, jak dziś), dopiero potem koryguje wpis/wpłatę. Powiązanie w uzgodnieniu już zatwierdzonym NIE blokuje korekty (zatwierdzone uzgodnienie jest niezmienne — nie ma ścieżki jego poprawy); triggery `ledger_correction_guard`/`payment_correction_guard` sprawdzają to samo przy bezpośrednim `INSERT`.
- **Nadal poza zakresem:** kwota celu w chwili powiązania nie jest zapisywana w wierszu powiązania (`target_net_cents_at_match` z propozycji #165 pkt 3) — niezgodność po zatwierdzeniu jest widoczna tylko jako różnica z dzisiejszym netto (patrz `amountMismatchConfirmedCount` w raporcie KR niżej), bez historycznego zapisu „ile było w chwili powiązania”.

### Import CODA / CAMT.053 (0089_bank_statement_formats.sql, #105)

`POST /api/reconciliations/{id}/lines` przyjmuje też `{ "coda": "<treść pliku>" }` albo `{ "camt053": "<treść XML>" }` (do 256 KiB, do 500 ruchów). Parsery `src/pg/bank/coda.js` i `src/pg/bank/camt053.js` to czyste funkcje: treść pliku nie jest zapisywana ani logowana. Błąd pliku zwraca `400` z kodem i numerem rekordu (`record`: wiersz CODA albo kolejny element `Ntry`/`Bal` w CAMT), bez fragmentu treści.

- **Rachunek.** IBAN z pliku (suma kontrolna mod 97; CODA: struktura 0 — belgijski BBAN przeliczany na IBAN, 2/3 — IBAN) porównujemy z `RECONCILIATION_BANK_ACCOUNT_IBAN`; inny rachunek → `400 statement_account_mismatch`. Brak konfiguracji → `503 bank_import_not_configured`. Rachunek nie jest zapisywany. Rachunków i nazw kontrahentów (CODA rekord 23, CAMT `RltdPties`) parser nie odczytuje.
- **Identyfikator transakcji banku.** CODA: rok salda początkowego + numer wyciągu + numer kolejny ruchu + referencja banku; CAMT: `AcctSvcrRef`, a bez niego `NtryRef` (brak obu → `400 statement_transaction_id_missing`). W bazie jest wyłącznie `bank_transaction_hash` = HMAC-SHA256(`BANK_TRANSACTION_HASH_KEY`, rachunek + identyfikator) — stały dla rachunku, więc ten sam ruch jest rozpoznawany w **każdym** uzgodnieniu. Indeks unikalny w bazie; ponowny import ruchu → pozycja pominięta i wykazana w `skippedDuplicates` (`record`, data, kwota, `reconciliationId` wcześniejszej pozycji, jeśli osoba ma dostęp do tamtego roku). Dwie wpłaty o tej samej kwocie i dacie z różnymi identyfikatorami to dwie pozycje. Plik, którego wszystkie ruchy już są, zwraca `200` z `import: null`.
- **Ten sam plik.** `file_hash` = HMAC treści (po ujednoliceniu końców linii). Drugi import tego pliku innym kluczem, także do innego uzgodnienia → `409 statement_already_imported` z `importId` i `reconciliationId`. Ten sam `Idempotency-Key` → powtórzenie odpowiedzi (`200`, `Idempotency-Replayed: true`). Importy z plików są szeregowane blokadą doradczą, więc równoległe żądania nie omijają tych kontroli.
- **Ciągłość (ostrzeżenia, nic nie blokują).** `warnings`: `closing_balance_mismatch` (saldo początkowe + ruchy ≠ końcowe), `opening_balance_discontinuity` (saldo początkowe ≠ saldo końcowe poprzedniego importu z pliku w roku), `statement_date_differs` / `statement_balance_differs` (data albo saldo końcowe pliku ≠ dane szkicu). Salda z pliku są w `fileBalances`; saldo szkicu jest niezmienne — przy różnicy skarbnik zakłada nowy szkic z saldem z pliku.
- **Komunikat strukturalny** (CODA typ 101, CAMT `Strd/CdtrRefInf/Ref`) i tytuł wolny są — jak w CSV — zapisywane wyłącznie jako solony skrót (`reference_hash`).
- **Ruchy zbiorcze CODA**: liczy się tylko rekord 21 ze szczegółem `0000`. CAMT: tylko wpisy `BOOK`. Tylko EUR; plik z kilkoma wyciągami → `400 statement_multiple_not_supported`.
- **Założenie**: układ pól według ogólnego opisu standardów; szczegóły trzeba sprawdzić na pliku syntetycznym wybranego banku (D-13). Pliki testowe: `tests/fixtures/coda-synthetic.cod`, `tests/fixtures/camt053-synthetic.xml` (generator `tests/helpers/bank-statements.js`, przykładowe IBAN z dokumentacji standardów). Retencja skrótów i identyfikatorów — D-04.

### Jedno aktywne powiązanie celu w roku (0089, #105 pkt 6)

Wybrany wariant: globalna unikalność w roku (bez „przenoszenia” powiązań). Wpłata, wpis księgi albo wpłata i wpis, który ją ujmuje, mogą mieć aktywne powiązanie tylko w **jednym** uzgodnieniu roku: `409 matched_in_other_reconciliation` z `reconciliationId`. Trigger `bank_match_year_unique_guard` sprawdza to samo pod blokadą doradczą roku (także przy bezpośrednim `INSERT`). Propozycje nie podsuwają celów powiązanych w innym uzgodnieniu roku. Skutek: skarbnik, który chce powiązać cel w nowym uzgodnieniu, najpierw cofa powiązanie w szkicu, w którym jest; powiązanie w uzgodnieniu zatwierdzonym zostaje na stałe (cel jest „rozliczony”). Istniejące podwójne powiązania nie są zmieniane — wykazuje je zapytanie kontrolne z nagłówka migracji.

Ogólny CSV: pierwszy wiersz to nagłówek z kolumnami `date`/`data`, `amount`/`kwota` i opcjonalnie `reference`/`tytuł`/`opis`. Separator `,` albo `;` (wykrywany z nagłówka), pola w cudzysłowach, BOM dopuszczalny. Data `RRRR-MM-DD` lub `DD.MM.RRRR`/`DD/MM/RRRR`; kwota w EUR z kropką lub przecinkiem, np. `-12,50`. Błędny wiersz zwraca `400 invalid_statement_line` z numerem wiersza danych. Używać wyłącznie danych syntetycznych.

## Raport dla Komisji Rewizyjnej

`format=json` (domyślnie) albo `format=html`. Zawiera: bilans otwarcia (z korektami), przychody, wydatki i bilans zamknięcia z `ledger_year_summary`; przychody i wydatki według kategorii (kwota pierwotna, korekty, netto); wydatki o kwocie pierwotnej powyżej 3000 EUR (dokładnie 3000 EUR nie jest wykazywane) z referencją uchwały i oznaczeniem braku zgodnej przyjętej uchwały; listę korekt wpisów i bilansu otwarcia (autor jako identyfikator konta); uzgodnienia rachunku z różnicą, liczbą niedopasowanych pozycji i wyjaśnieniem.

Kontrole krzyżowe (`report.checks.items`, #169) porównują niezależnie liczone źródła i podają liczby; wynik `ok` to wskaźnik do sprawdzenia (`null` = nie liczono), nic nie blokują:

| `id` | Co porównuje |
|---|---|
| `year_end_balance` | `ledger_balance_at(rok, ends_on)` (wpisy datowane do ostatniego dnia roku, jak w uzgodnieniu) z bilansem zamknięcia z `ledger_year_summary` (wszystkie wpisy roku). Różnica = wpisy z datą po końcu roku. |
| `dates_within_school_year` | Liczba wpisów księgi i wpłat z datą spoza `[starts_on, ends_on]` (widok `school_year_date_deviations`, 0027) i do 50 pierwszych identyfikatorów. |
| `payments_in_ledger` | Suma netto wpłat `recorded` (moduł wpłat) z sumą netto wpisów księgi z `payment_entry_id`; liczba wpłat bez wpisu księgi (#138). |
| `reconciliation_matches` | Liczba aktywnych powiązań niezgodnych kwotowo (#165) i podwójnych ujęć (#162) we wszystkich uzgodnieniach roku, w tym osobno `amountMismatchConfirmedCount` — niezgodne w uzgodnieniach JUŻ zatwierdzonych (powstałe z korekty po zatwierdzeniu; zatwierdzone uzgodnienie jest niezmienne, więc to jest to, co KR musi wyjaśnić ręcznie). |
| `latest_confirmed_reconciliation` | Data i utrwalona różnica ostatniego zatwierdzonego uzgodnienia oraz liczba wpisów `bank` z datą po dacie wyciągu. |

Raport nie pisze już „Sumy kategorii są zgodne z bilansem roku” — tamta kontrola porównywała widok sam ze sobą i zawsze wychodziła zgodna. Pola `checks.categoryIncomeMatchesSummary` i `checks.categoryExpenseMatchesSummary` zostały usunięte.

Wersja HTML jest przeznaczona do druku (A4, `@page`); PDF powstaje przez „Drukuj → Zapisz jako PDF” w przeglądarce. Strona nie zawiera skryptów, a wszystkie teksty z bazy są escapowane. Odpowiedź ma `Content-Security-Policy: default-src 'none'` z wyjątkiem wbudowanego arkusza stylów dopuszczonego skrótem SHA-256, `Cache-Control: no-store`, `X-Frame-Options: DENY`. Każde wygenerowanie raportu zapisuje zdarzenie `report.audit.generated` (bez treści raportu).

Raport nie jest zatwierdzonym sprawozdaniem finansowym. Zakres i forma sprawozdania Komisji Rewizyjnej wymagają decyzji Rady (#15, D-09).

## Testy

`tests/pg-reconciliation.test.js` (PGlite, dane syntetyczne): wyliczenie salda i różnicy przez bazę, pozycje po dacie wyciągu, brak tytułu w bazie i odpowiedzi, propozycje bez automatycznego zatwierdzania, niezgodna kwota, podwójne kliknięcie, cofnięcie i ponowne powiązanie, zasada czterech oczu (API i baza), wymagane wyjaśnienie różnicy, niezmienność zatwierdzonego uzgodnienia, odmowa dla przedstawiciela, `audit` przy zapisie, braku MFA, innego roku i obcego `Origin`, zgodność sum raportu z księgą, oznaczenie wydatku bez przyjętej uchwały, escapowanie HTML i nagłówek CSP, parser CSV, idempotencja importu i duplikaty. Spójność powiązań: podwójne ujęcie wpłaty i jej wpisu (obie kolejności, bezpośredni `INSERT`, równoległe żądania), dwoje opiekunów i rodzeństwo, korekta po powiązaniu (wpłata częściowa, wpis do zera) → `409 inconsistent_matches`, podwójne kliknięcie zatwierdzenia, zasada czterech oczu przed kontrolą kwot, wcześniejsze niespójne powiązania. `tests/pg-bank-statement-import.test.js` (#105): parsery CODA/CAMT na plikach syntetycznych, błędy z numerem rekordu bez treści, DOCTYPE odrzucony, ruchy zbiorcze, brak rachunków/nazw/tytułów w bazie i dzienniku, dwie wpłaty dwojga opiekunów o tej samej kwocie i dacie, ten sam plik i ten sam ruch w dwóch uzgodnieniach, ponowienie z tym samym kluczem, podwójne kliknięcie, rachunek niezgodny, brak konfiguracji, pozycja po dacie wyciągu, uzgodnienie zatwierdzone, ostrzeżenia ciągłości, odmowa dla przedstawiciela, `audit`, `principal`, braku MFA i obcego `Origin`. `tests/pg-reconciliation-race.test.js` — przeploty na prawdziwym PostgreSQL (tylko z `RD_TEST_PG_URL`, bez niej pomijany): powiązanie i zatwierdzenie czekają na niezatwierdzoną korektę celu, powiązanie wpisu czeka na niezatwierdzone powiązanie jego wpłaty.
