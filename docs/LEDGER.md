# Księga przychodów, wydatków i preliminarz

Migracja `0007_ledger_schema.sql` rozwija początkową tabelę `ledger_entries` w niezmienną księgę opartą na centach EUR. Ten etap definiuje model i reguły integralności; nie udostępnia jeszcze API ani interfejsu.

## Zapisy księgi

Nowy zapis ma kierunek `income` albo `expense`, aktywną kategorię właściwą dla tego samego roku i kierunku, dodatnią kwotę, opis, datę, metodę oraz unikalny klucz idempotencji. Opcjonalnie wskazuje źródło, prywatny dokument oraz powiązaną wpłatę.

Powiązana wpłata musi mieć status `recorded`, należeć do tego samego roku i może zostać wskazana tylko w jednym wpisie przychodowym. Migracja `0008_ledger_payment_links.sql` chroni przed podwójnym ujęciem wpływu. Migracja `0038` (#138) dodaje kontrolę kwoty: wpis z `paymentEntryId` musi mieć kwotę równą bieżącemu netto wpłaty (kwota − korekty − zwroty) w chwili zapisu — inaczej `422 payment_amount_mismatch`. Zwrot i ponowne przypisanie wpłaty (`payment_refunds`, `payment_reassignments`) opisuje docs/PAYMENTS.md.

Fakty finansowe nie mogą być edytowane ani usuwane. Pomyłkę zmniejszającą kwotę zapisuje się w `ledger_corrections`; suma korekt nie może przekroczyć wpisu. Widok `ledger_entry_net` pokazuje wartość pierwotną, korekty i wartość netto.

Wydatek dokładnie 3000 EUR nie wymaga odwołania do uchwały. Wydatek większy niż 3000 EUR wymaga tekstowej referencji uchwały. Model nie rozstrzyga jej formatu ani procesu zatwierdzania — te zasady musi potwierdzić Rada.

## Bilans i preliminarz

Każdy rok może mieć jeden niezmienny bilans otwarcia. Ewentualne poprawki są osobnymi, podpisanymi zdarzeniami w `ledger_opening_balance_adjustments`. `ledger_year_summary` wylicza przychody, wydatki i bilans zamknięcia.

Preliminarz używa niezmiennych wersji `ledger_budget_lines`. Nowa wersja wskazuje poprzednią przez `supersedes_id`; widok `ledger_current_budget` zwraca tylko bieżącą wersję każdej linii, zachowując pełną historię.

## API księgi

`GET /api/ledger?schoolYearId=...` zwraca stronicowaną listę wpisów z wartością pierwotną, sumą korekt i wartością netto. Opcjonalny filtr `direction` przyjmuje `income` albo `expense`.

Panel może pobrać aktywne kategorie przez `GET /api/ledger/categories`, bilans roku przez `GET /api/ledger/summary` oraz aktualne wersje linii preliminarza przez `GET /api/ledger/budget`. Każda trasa wymaga parametru `schoolYearId`; kategorie można dodatkowo filtrować po kierunku.

`POST /api/ledger` tworzy wpis, a `POST /api/ledger/{id}/corrections` dopisuje korektę. Operacje wymagają aktywnej sesji, potwierdzonego MFA, roli `admin`, `board` albo `treasurer`, zgodnego roku szkolnego, same-origin i nagłówka `Idempotency-Key`. Zapis wpisu lub korekty i odpowiadającego mu zdarzenia audytowego odbywa się atomowo. Audyt nie kopiuje kwoty, opisu ani identyfikatora dokumentu.

### Przeksięgowanie: storno + wpis zastępczy (#144, migracja `0040`)

Zmiana kategorii, daty, metody lub kierunku wpisu (najczęstsze pomyłki skarbnika) nie jest korektą kwoty — to przeksięgowanie. `POST /api/ledger/{id}/replacement` (`Idempotency-Key`; treść jak `POST /api/ledger` plus `reason`) wykonuje w jednej transakcji: **storno** pełnej pozostałej kwoty wpisu (nowy wiersz w `ledger_corrections`, powód „Przeksięgowanie: …”) i **wpis zastępczy** z polem `replacesEntryId` wskazującym wpis pierwotny. Oba zapisy i zdarzenie audytu `ledger.entry.replaced` powstają atomowo — błąd wycofuje wszystko.

- **Bilans bez zmian.** Gdy zmienia się tylko kategoria/data/metoda (ta sama kwota i kierunek), bilans roku przed i po jest identyczny: storno zeruje netto wpisu pierwotnego, wpis zastępczy dodaje tę samą kwotę w tym samym kierunku.
- **Jednorazowość.** Wpis może zostać zastąpiony co najwyżej raz (`ledger_entries_replaces_idx`); druga próba to `409 ledger_entry_already_replaced`. Wpis zastępczy może sam zostać zastąpiony (łańcuch przeksięgowań widoczny przez `replacesEntryId`).
- **Wpis powiązany z wpłatą (`payment_entry_id`) nie może być przeksięgowany tą operacją** — `409 payment_linked_entry_not_replaceable`. Przeniesienie powiązania wpłaty na wpis zastępczy wymagałoby zmiany unikalnego indeksu `ledger_entries_payment_entry_idx` na regułę uwzględniającą netto wpisu, co zazębia się z kontrolą kwoty wpłata↔księga (#138); to świadomie osobna, przyszła zmiana.
- **Rok zamknięty** → `409 school_year_closed` (te same triggery zamrożenia co inne zapisy księgi).
- `GET /api/ledger` i eksport CSV pokazują `replacesEntryId` / kolumnę `zastepuje_wpis`; odwrotny kierunek („zastąpiony przez”) nie jest jeszcze wyliczany po stronie API — panel może go wyprowadzić z listy wpisów po stronie klienta (dalsza praca).
- Zasada czterech oczu dla dużych przeksięgowań (jak w #97) nie jest częścią tego PR — nie ma dziś progu ani decyzji zarządu; do rozważenia osobno.

Dostęp dla dyrekcji i Komisji Rewizyjnej pozostaje wyłączony do zatwierdzenia macierzy kompetencji przez szkołę — dotyczy wszystkich tras tego dokumentu (`GET/POST /api/ledger*`, `export.csv`, przeksięgowanie). Jedyny dziś wyjątek: Komisja Rewizyjna (`audit`) ma odczyt zbiorczego raportu rocznego, osobna trasa `GET /api/reports/audit` opisana w docs/RECONCILIATION.md — bez dostępu do pojedynczych wpisów księgi ani dowodów, więc nie może samodzielnie zweryfikować pozycji raportu. Ten stan (raport tak, wpis i dowód nie) oraz brak ścieżki uwag/ustaleń kontroli to zakres issue #137, zależny od decyzji D-09.

## Dalsze etapy

- uzgadnianie księgi z wyciągiem,
- eksport PDF (eksport CSV: patrz niżej, tylko router PostgreSQL),
- powiązanie wpisów z prywatnymi dokumentami w Railway Storage Bucket ([DOCUMENTS.md](DOCUMENTS.md)),
Interfejs w `ledger/` pokazuje podsumowanie roku, bieżący preliminarz i filtrowane wpisy. Pozwala tworzyć przychody lub wydatki i dopisywać korekty, korzystając wyłącznie z chronionego API. Formularz wymusza referencję uchwały dla wydatku powyżej 3000 EUR i zachowuje klucz idempotencji przy ponowieniu tego samego żądania.

- interfejs uzgadniania rachunku,
- formularze kategorii, wersji preliminarza i przyjęcia w panelu (API: sekcja „Preliminarz przez API”),
- formularz przesyłania prywatnego dokumentu (API: [DOCUMENTS.md](DOCUMENTS.md)).

Nie używać modelu na danych rzeczywistych przed zatwierdzeniem zasad księgowania, korekt, uchwał i dostępu przez Radę oraz szkołę.


## PostgreSQL (Railway) — stan prototypu (issue #38)

`src/pg/routes/ledger.js` przenosi trasy księgi (`GET /api/ledger`, `GET /api/ledger/categories`, `GET /api/ledger/summary`, `GET /api/ledger/budget`, `POST /api/ledger`, `POST /api/ledger/{id}/corrections`) do routera PostgreSQL (`src/pg/app.js`). Kontrakt HTTP panelu z `ledger/` pozostaje bez zmian: te same walidacje, kształty JSON, kody statusu i błędów, nagłówek `Idempotency-Replayed` oraz kursor stronicowania. Test `tests/pg-ledger-api.test.js` wykonuje jeden scenariusz (ścieżki budowane funkcjami panelu z `ledger/core.js`) na starym Workerze/D1 i na PostgreSQL i porównuje odpowiedzi krok po kroku. Kursor `nextCursor` wiąże rok szkolny i filtr zapytania, które go wydało (#192): użycie go z innym `schoolYearId` lub innym filtrem (`direction`) daje `400 invalid_cursor`, zamiast doklejać wiersze innego zapytania. Panel dociąga kolejne strony wyłącznie z zapamiętanego zapytania, a zmienione, niezatwierdzone pola filtra blokują „Wczytaj następne”.

- **Kwoty.** Wszystkie kwoty pozostają w centach EUR (liczby całkowite). Sumy z widoków (`BIGINT`) są zamieniane na liczby tylko w zakresie bezpiecznych liczb całkowitych; poza nim żądanie kończy się błędem technicznym zamiast utraty precyzji.
- **Niezmienność.** Wpisów, korekt, bilansu otwarcia i wersji preliminarza nie można zmienić ani usunąć (triggery z `postgres/migrations/0003_ledger.sql`). Pomyłkę zapisuje się jako korektę.
- **Transakcje i audyt.** Wpis lub korekta oraz zdarzenie `ledger.entry.created` / `ledger.correction.created` powstają w jednej transakcji. Błąd zapisu audytu wycofuje całą operację. Dziennik nie kopiuje kwoty, opisu, referencji uchwały ani identyfikatora dokumentu.
- **Idempotencja.** Ten sam klucz, ta sama treść i ta sama osoba zwracają pierwotny wynik z kodem 200; inna treść lub inna osoba — `409 idempotency_conflict`. Podwójne kliknięcie kończy się jednym wpisem.
- **Równoległe korekty.** Korekta blokuje wiersz wpisu (`SELECT … FOR UPDATE`) i sprawdza pozostałą kwotę; suma korekt nigdy nie przekracza wpisu. Trigger bazy niezależnie odrzuca nadmierną korektę.
- **Powiązana wpłata.** Wpis przychodowy z `paymentEntryId` blokuje wiersz wpłaty. Wpłata musi mieć status `recorded` i ten sam rok; druga próba ujęcia tej samej wpłaty (także równoległa, z innym kluczem) kończy się `409 payment_already_linked`. Unikalny indeks w bazie chroni przed podwójnym ujęciem niezależnie od API.
- **Uchwała.** Wydatek powyżej 3000 EUR (300 000 centów) bez referencji uchwały (co najmniej 3 znaki) kończy się `400 resolution_required`; wydatek dokładnie 3000 EUR jej nie wymaga. Ograniczenie `ledger_large_expense_resolution` obowiązuje też w bazie.
- **Data w roku szkolnym (#169).** `occurredOn` musi leżeć w `[starts_on, ends_on]` roku wpisu (obie granice włącznie); inaczej `422 date_outside_school_year`, bez zapisu. Regułę egzekwuje trigger `b0_date_within_school_year` (`0027_entry_date_within_school_year.sql`), także przy bezpośrednim `INSERT`; działa po zamrożeniu roku, więc zamknięty rok nadal daje `409 school_year_closed`. Założenie: rok obrachunkowy Rady = rok szkolny (D-21). Istniejące wpisy spoza zakresu nie są zmieniane — raport KR pokazuje je w kontroli `dates_within_school_year` i różnicę w `year_end_balance`; poprawka to korekta i nowy wpis (#144). Stary Worker/D1 tej reguły nie ma.
- **Dostęp.** Każda trasa wymaga sesji, MFA i roli `admin`, `board` albo `treasurer` w zakresie roku szkolnego. `representative`, `audit` i `principal` dostają `403`. Zapisy wymagają zgodnego nagłówka `Origin`.
- **Kolejność błędów.** Przy kilku błędach naraz moduł zwraca ten sam kod co Worker (powiązanie wpłaty, uchwała, dokument, kategoria, ponowne ujęcie wpłaty). Jedyna świadoma różnica: przy korekcie osoba bez roli finansowej lub bez MFA dostaje `403` jeszcze przed wyszukaniem wpisu, więc nie może sprawdzić, czy dany identyfikator istnieje (Worker zwracał wtedy `404`).

### Kasa i rachunek (issue #199)

Bilans otwarcia (`ledger_opening_balances.amount_cents` = całość) ma część poza rachunkiem `cash_cents` (0028); poprawki (`ledger_opening_balance_adjustments`) zmieniają całość (`amount_cents`) i/lub część gotówkową (`cash_cents`). Rachunek = całość − kasa. Kwoty w centach EUR.

| Trasa | Kto | Opis |
|---|---|---|
| `GET /api/ledger/transfers?schoolYearId=…` | admin, zarząd, skarbnik + MFA | lista przeniesień roku |
| `POST /api/ledger/transfers` | admin, zarząd, skarbnik + MFA, `Idempotency-Key` | `{ schoolYearId, direction: 'cash_to_bank' \| 'bank_to_cash', amountCents, transferredOn, description, sourceDocumentId? }` → 201; storno: `{ schoolYearId, reversesId, description }` (przeciwny kierunek, ta sama kwota i data; drugie storno i storno storna → 409) |
| `GET /api/ledger/opening-balance?schoolYearId=…` | admin, zarząd, skarbnik + MFA | pierwotny bilans (rachunek/kasa), poprawki, stan bieżący, rok, z którego przeniesiono |
| `POST /api/ledger/opening-balance` | zarząd + MFA, `Idempotency-Key` | `{ schoolYearId, bankCents, cashCents ≥ 0, note, sourceDocumentId? }` → 201; tylko pierwszy rok w systemie (`409 not_first_school_year`), jeden na rok (`409 opening_balance_exists`) |
| `POST /api/ledger/opening-balance/adjustments` | zarząd + MFA, `Idempotency-Key` | `{ schoolYearId, amountCents, cashCents, reason, sourceDocumentId? }` → 201 (nowy wiersz, poprzednia wartość zostaje); kasa poniżej zera → `409 cash_below_zero`; zamknięty rok → `409 school_year_closed` |

- Przeniesienie jest operacją wewnętrzną: nie zmienia przychodów, wydatków ani bilansu (`ledger_year_summary`), zmienia tylko podział rachunek/kasa. Data w granicach roku (`422 date_outside_school_year`), rok zamknięty → `409`.
- Wszystko jest niezmienne (triggery); korekta to nowy wiersz. Zapis i zdarzenie audytu (`ledger.transfer.created`, `ledger.transfer.reversed`, `ledger_opening_balance.created`, `ledger_opening_balance.adjusted`) w jednej transakcji, bez kwot i opisów. Podwójne kliknięcie → jeden zapis.
- Zamknięcie roku przenosi obie części (docs/YEAR_CLOSE.md). Raport KR i zestawienie przekazania pokazują podział.
- Założenia (zarząd nic nie zdecydował — wariant zachowawczy): D-13 — jedna kasa, jeden rachunek, „kasa” = wszystko poza rachunkiem; bilans otwarcia i poprawki wyłącznie zarząd (bez admina i skarbnika); zasada czterech oczu dla poprawek (D-12) nie jest wymuszona; ręczny bilans tylko dla pierwszego roku — kolejne lata dostają bilans z zamknięcia.
- Bilanse przeniesione przed 0028 mają `cash_cents = 0`; jeśli zawierały gotówkę, rozbicie wpisuje zarząd poprawką `{ amountCents: 0, cashCents: <gotówka> }`.

### Eksport CSV (issue #7)

`GET /api/ledger/export.csv?schoolYearId=…` (tylko router PostgreSQL) zwraca wszystkie wpisy roku w kolejności dat, z kwotą pierwotną, sumą korekt i kwotą netto w EUR. Wymaga tych samych ról, MFA i zakresu roku co pozostałe trasy. Plik ma kodowanie UTF-8 z BOM, separator `;` i przecinek dziesiętny (`123,45`), aby otwierał się w arkuszu z polskimi lub belgijskimi ustawieniami — to założenie do potwierdzenia przez skarbnika. Komórki zaczynające się od `=`, `+`, `-`, `@`, tabulatora lub CR dostają prefiks `'`, żeby arkusz nie wykonał ich jako formuły. Eksport ma limit 20 000 wpisów (`413 export_too_large`). Każdy eksport zapisuje zdarzenie `ledger.exported` (osoba, czas, rok, liczba wierszy) bez kwot i treści wpisów. Plik zawiera opisy i źródła wpisane przez skarbnika, więc wolno go przekazywać tylko osobom uprawnionym; zasady przechowywania eksportów wymagają decyzji zarządu.

Schemat nie wymagał zmian — moduł korzysta z tabel, triggerów i widoków z `0003_ledger.sql`. Stary moduł `src/ledger.js` pozostaje bez zmian do czasu testów równoważności na danych syntetycznych i próby odtworzenia. Bilans otwarcia i jego poprawki mają trasy od #199 (sekcja „Kasa i rachunek”); kategorie, wersje preliminarza, jego przyjęcie i zestawienie plan vs wykonanie mają trasy od #107 (sekcja „Preliminarz przez API”; brak ich w Workerze).

### Preliminarz przez API (issue #107; migracja 0073)

Moduł `src/pg/routes/ledger-budget.js`. Zapisy wymagają MFA, same-origin, `Idempotency-Key` (podwójne kliknięcie = jeden zapis, inna treść z tym samym kluczem = `409 idempotency_conflict`); zapis i zdarzenie audytu (aktor, czas, identyfikatory — bez kwot i nazw) powstają w jednej transakcji; zamknięty rok daje `409 school_year_closed`. Rola bez uprawnień dostaje `403` przed sprawdzeniem istnienia obiektów.

| Trasa | Kto | Opis |
| --- | --- | --- |
| `POST /api/ledger/categories` | admin, zarząd, skarbnik | `{ schoolYearId, direction, name }` → 201; nazwa zajęta w roku i kierunku: `409 category_exists` |
| `POST /api/ledger/categories/{id}/deactivation` | jak wyżej | `{ reason }` → 201; wpis historii (`ledger_category_deactivations`), kategoria zostaje w wykonaniu, ale nie przyjmuje nowych wpisów (`400 invalid_category`); ponownie: `409 category_inactive` |
| `POST /api/ledger/budget` | jak wyżej | `{ schoolYearId, categoryId, plannedCents ≥ 0, note? }` → 201; pierwsza wersja linii kategorii (kolejna: `409 budget_line_exists`) |
| `POST /api/ledger/budget/{lineId}/revisions` | jak wyżej | `{ plannedCents, reason }` → 201; nowa wersja z `supersedes_id`, poprzednia zostaje; wersja nieaktualna albo przegrana równoległa rewizja: `409 budget_line_superseded` |
| `POST /api/ledger/budget/adoptions` | zarząd | `{ schoolYearId, adoptedOn, note, resolutionId? }` → 201; zapisuje zestaw bieżących wersji linii („plan przyjęty”); uchwała opcjonalna, a wskazana musi być przyjęta, bieżąca i z zebrania ogólnego tego roku (inaczej 404) |
| `GET /api/ledger/budget/history?schoolYearId=…` | admin, zarząd, skarbnik | wszystkie wersje linii (kto, kiedy, uzasadnienie, która bieżąca) i przyjęcia |
| `GET /api/ledger/budget/execution?schoolYearId=…&asOf=…&format=json` (albo `csv`, `html`) | jak wyżej | per kategoria: plan przyjęty (ostatnie przyjęcie do `asOf`), plan bieżący, wykonanie netto (`ledger_entry_net`, wpisy do `asOf`), różnica, % wykonania, „poza planem”, przekroczenie; bez `asOf` `check` porównuje sumy z `ledger_year_summary`. CSV jak `export.csv` (brak planu = pusta komórka), HTML do druku z CSP raportu KR |

Raport Komisji Rewizyjnej ma sekcję „2a. Preliminarz a wykonanie” z tym samym zestawieniem. Panel `ledger/` pokazuje plan bieżący, wykonanie, % i przekroczenie (tekst, nie tylko kolor). Założenia (D-08, D-09, D-21): kategorie i linie zapisują role finansowe, przyjęcie — wyłącznie zarząd; KR widzi zestawienie w raporcie, nie przez trasę; kto uchwala preliminarz — nierozstrzygnięte, dlatego uchwała jest opcjonalna. Sugerowana składka (D-14) nie jest częścią preliminarza; „planowane wpływy ze składek” to zwykła linia przychodów.

To prototyp: router PostgreSQL działa tylko przy ustawionym `DATABASE_URL`, nie jest wdrożony na Railway i nie jest zatwierdzony do pracy na danych rodzin. Zasady księgowania, korekt, format referencji uchwały i dostęp dyrekcji oraz Komisji Rewizyjnej nadal wymagają decyzji Rady i szkoły.
