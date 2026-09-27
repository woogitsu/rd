# Uzgodnienie rachunku i raport dla Komisji Rewizyjnej

Zakres: issue #7 (uzgodnienie księgi z wyciągiem bankowym) i przygotowanie raportu rocznego dla Komisji Rewizyjnej (#15). Prototyp na PostgreSQL (`src/pg/routes/reconciliation.js`, `src/pg/audit-report.js`, migracja `postgres/migrations/0015_reconciliation.sql`). Nie jest wdrożony i nie jest zatwierdzony do pracy na danych rodzin ani na prawdziwych wyciągach.

## Otwarte decyzje i przyjęte założenia

- **D-13 (rachunek, gotówka, uzgadnianie)** — nieustalone: który rachunek, format wyciągu, częstotliwość i kto uzgadnia. Moduł przyjmuje wyłącznie **ogólny CSV** (data, kwota, tytuł) albo wiersze JSON wpisane ręcznie. Nie ma importu formatu konkretnego banku (CODA, MT940, CAMT.053) — to osobny zakres po decyzji.
- **Gotówka** — saldo księgi obejmuje wszystkie metody (`bank`, `cash`, `card`, `other`), bo bilans otwarcia nie jest rozdzielony na rachunek i kasę. Uzgodnienie pokazuje osobno `ledgerNonBankCents` (netto wpisów innych niż `bank`), co wyjaśnia część różnicy. Do czasu decyzji D-13 różnica może więc zawierać gotówkę.
- **Cztery oczy (założenie, nie decyzja)** — uzgodnienie zatwierdza inna osoba niż jego autor (`confirmed_by <> created_by`, sprawdzane w API i w bazie). Role: `admin`, `board`, `treasurer` z MFA w zakresie roku. Zasady zatwierdzania musi potwierdzić Rada.
- **D-09 (dyrekcja i Komisja Rewizyjna)** — raport roczny otrzymują zgodnie z zakresem zadania role `audit`, `board` i `treasurer` z MFA. Rola `admin` (techniczna), `principal` i `representative` dostają `403`. Uzgodnienia (szczegóły, pozycje wyciągu) pozostają dla ról finansowych; `audit` widzi ich status i różnice w raporcie. Zakres dostępu wymaga decyzji szkoły.
- **D-15 (uchwały powyżej 3000 EUR)** — raport łączy `resolution_reference` z przyjętą uchwałą przez widok `ledger_resolution_links` (0009). Brak zgodnej przyjętej uchwały jest **oznaczany**, a nie blokowany. Nie sprawdzamy, czy uchwała poprzedziła wydatek ani czy kwota mieści się w uchwale.

## Model danych (0015_reconciliation.sql)

- `bank_reconciliations` — rok, data wyciągu (w granicach roku szkolnego), saldo z wyciągu podane przez skarbnika (centy EUR, może być ujemne), saldo księgi i netto wpisów niebankowych **wyliczane przez bazę** (`ledger_balance_at`, `ledger_non_bank_net_at`), różnica jako kolumna generowana, status `draft`/`confirmed`, notatka, autor, zatwierdzający, wyjaśnienie różnicy, klucz idempotencji. Klient nie może podać salda księgi — trigger je nadpisuje.
- Saldo księgi na dzień D = bilans otwarcia z wszystkimi korektami bilansu + przychody netto − wydatki netto wpisów z datą ≤ D. Korekta wpisu liczy się z datą korygowanego wpisu (w księdze nie ma osobnej daty skutku korekty).
- Szkic pokazuje saldo księgi **na bieżąco**. Zatwierdzenie przelicza je ostatni raz i zamraża. Późniejszy wpis z wcześniejszą datą nie zmienia zatwierdzonego uzgodnienia; trzeba utworzyć nowe uzgodnienie.
- Różnica ≠ 0 wymaga wyjaśnienia (`confirmationNote`) przy zatwierdzeniu (ograniczenie w bazie).
- `bank_statement_imports` i `bank_statement_lines` — paczka importu (źródło `manual`/`csv`, liczba pozycji, skrót treści do idempotencji) i pozycje: data księgowania (≤ data wyciągu), kwota ze znakiem (+ wpływ, − wypływ), opcjonalny skrót tytułu. Pozycji nie można zmienić ani usunąć.
- `bank_reconciliation_matches` — ręcznie zatwierdzone powiązanie pozycji z **jednym** wpisem księgi albo **jedną** wpłatą. Baza sprawdza rok, kierunek i równość kwoty netto. Jedna aktywna para na pozycję i na wpis/wpłatę w uzgodnieniu. Błędne powiązanie cofa się (`revoked_at`, `revoked_by`, powód) — wiersz zostaje.
- Po zatwierdzeniu uzgodnienia baza odrzuca każdy nowy import, powiązanie, cofnięcie i zmianę. Niczego nie można usunąć.

Skutki dla danych: migracja wyłącznie dodaje tabele, funkcje, triggery i indeksy; nie zmienia istniejących wierszy księgi, wpłat ani uchwał. Wycofanie na pustej bazie = usunięcie tych obiektów; na bazie z danymi — tylko po kopii zapasowej i decyzji o retencji (D-04).

Ograniczenia: brak dopasowań wiele-do-jednego (np. jeden przelew zbiorczy za kilka wpłat) i dopasowań z różną kwotą — różnicę opisuje się w wyjaśnieniu. Brak porzucania szkicu (szkic pozostaje; tworzy się nowy).

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
| `POST /api/reconciliations/{id}/lines` | import: `{ "lines": [{ "bookedOn", "amountCents", "reference?" }] }` albo `{ "csv": "…" }`, do 500 pozycji; odpowiedź podaje `possibleDuplicateCount` |
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
- Poza zakresem (#165): korekta wpisu/wpłaty z aktywnym powiązaniem w szkicu nadal przechodzi (wybór „odrzuć” albo „cofnij automatycznie” należy do D-12); kwota celu w chwili powiązania nie jest zapisywana, a raport KR nie wykazuje powiązań zatwierdzonych, które po późniejszej korekcie stały się niezgodne.

Ogólny CSV: pierwszy wiersz to nagłówek z kolumnami `date`/`data`, `amount`/`kwota` i opcjonalnie `reference`/`tytuł`/`opis`. Separator `,` albo `;` (wykrywany z nagłówka), pola w cudzysłowach, BOM dopuszczalny. Data `RRRR-MM-DD` lub `DD.MM.RRRR`/`DD/MM/RRRR`; kwota w EUR z kropką lub przecinkiem, np. `-12,50`. Błędny wiersz zwraca `400 invalid_statement_line` z numerem wiersza danych. Używać wyłącznie danych syntetycznych.

## Raport dla Komisji Rewizyjnej

`format=json` (domyślnie) albo `format=html`. Zawiera: bilans otwarcia (z korektami), przychody, wydatki i bilans zamknięcia z `ledger_year_summary`; przychody i wydatki według kategorii (kwota pierwotna, korekty, netto) z kontrolą zgodności sum z bilansem; wydatki o kwocie pierwotnej powyżej 3000 EUR (dokładnie 3000 EUR nie jest wykazywane) z referencją uchwały i oznaczeniem braku zgodnej przyjętej uchwały; listę korekt wpisów i bilansu otwarcia (autor jako identyfikator konta); uzgodnienia rachunku z różnicą, liczbą niedopasowanych pozycji i wyjaśnieniem.

Wersja HTML jest przeznaczona do druku (A4, `@page`); PDF powstaje przez „Drukuj → Zapisz jako PDF” w przeglądarce. Strona nie zawiera skryptów, a wszystkie teksty z bazy są escapowane. Odpowiedź ma `Content-Security-Policy: default-src 'none'` z wyjątkiem wbudowanego arkusza stylów dopuszczonego skrótem SHA-256, `Cache-Control: no-store`, `X-Frame-Options: DENY`. Każde wygenerowanie raportu zapisuje zdarzenie `report.audit.generated` (bez treści raportu).

Raport nie jest zatwierdzonym sprawozdaniem finansowym. Zakres i forma sprawozdania Komisji Rewizyjnej wymagają decyzji Rady (#15, D-09).

## Testy

`tests/pg-reconciliation.test.js` (PGlite, dane syntetyczne): wyliczenie salda i różnicy przez bazę, pozycje po dacie wyciągu, brak tytułu w bazie i odpowiedzi, propozycje bez automatycznego zatwierdzania, niezgodna kwota, podwójne kliknięcie, cofnięcie i ponowne powiązanie, zasada czterech oczu (API i baza), wymagane wyjaśnienie różnicy, niezmienność zatwierdzonego uzgodnienia, odmowa dla przedstawiciela, `audit` przy zapisie, braku MFA, innego roku i obcego `Origin`, zgodność sum raportu z księgą, oznaczenie wydatku bez przyjętej uchwały, escapowanie HTML i nagłówek CSP, parser CSV, idempotencja importu i duplikaty. Spójność powiązań: podwójne ujęcie wpłaty i jej wpisu (obie kolejności, bezpośredni `INSERT`, równoległe żądania), dwoje opiekunów i rodzeństwo, korekta po powiązaniu (wpłata częściowa, wpis do zera) → `409 inconsistent_matches`, podwójne kliknięcie zatwierdzenia, zasada czterech oczu przed kontrolą kwot, wcześniejsze niespójne powiązania. `tests/pg-reconciliation-race.test.js` — przeploty na prawdziwym PostgreSQL (tylko z `RD_TEST_PG_URL`, bez niej pomijany): powiązanie i zatwierdzenie czekają na niezatwierdzoną korektę celu, powiązanie wpisu czeka na niezatwierdzone powiązanie jego wpłaty.
