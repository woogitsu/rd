# Księga przychodów, wydatków i preliminarz

Migracja `0007_ledger_schema.sql` rozwija początkową tabelę `ledger_entries` w niezmienną księgę opartą na centach EUR. Ten etap definiuje model i reguły integralności; nie udostępnia jeszcze API ani interfejsu.

## Zapisy księgi

Nowy zapis ma kierunek `income` albo `expense`, aktywną kategorię właściwą dla tego samego roku i kierunku, dodatnią kwotę, opis, datę, metodę oraz unikalny klucz idempotencji. Opcjonalnie wskazuje źródło, prywatny dokument oraz powiązaną wpłatę.

Powiązana wpłata musi mieć status `recorded`, należeć do tego samego roku i może zostać wskazana tylko w jednym wpisie przychodowym. Migracja `0008_ledger_payment_links.sql` chroni przed podwójnym ujęciem wpływu.

Fakty finansowe nie mogą być edytowane ani usuwane. Pomyłkę zmniejszającą kwotę zapisuje się w `ledger_corrections`; suma korekt nie może przekroczyć wpisu. Widok `ledger_entry_net` pokazuje wartość pierwotną, korekty i wartość netto.

Wydatek dokładnie 3000 EUR nie wymaga odwołania do uchwały. Wydatek większy niż 3000 EUR wymaga tekstowej referencji uchwały. Model nie rozstrzyga jej formatu ani procesu zatwierdzania — te zasady musi potwierdzić Rada.

## Bilans i preliminarz

Każdy rok może mieć jeden niezmienny bilans otwarcia. Ewentualne poprawki są osobnymi, podpisanymi zdarzeniami w `ledger_opening_balance_adjustments`. `ledger_year_summary` wylicza przychody, wydatki i bilans zamknięcia.

Preliminarz używa niezmiennych wersji `ledger_budget_lines`. Nowa wersja wskazuje poprzednią przez `supersedes_id`; widok `ledger_current_budget` zwraca tylko bieżącą wersję każdej linii, zachowując pełną historię.

## API księgi

`GET /api/ledger?schoolYearId=...` zwraca stronicowaną listę wpisów z wartością pierwotną, sumą korekt i wartością netto. Opcjonalny filtr `direction` przyjmuje `income` albo `expense`.

Panel może pobrać aktywne kategorie przez `GET /api/ledger/categories`, bilans roku przez `GET /api/ledger/summary` oraz aktualne wersje linii preliminarza przez `GET /api/ledger/budget`. Każda trasa wymaga parametru `schoolYearId`; kategorie można dodatkowo filtrować po kierunku.

`POST /api/ledger` tworzy wpis, a `POST /api/ledger/{id}/corrections` dopisuje korektę. Operacje wymagają aktywnej sesji, potwierdzonego MFA, roli `admin`, `board` albo `treasurer`, zgodnego roku szkolnego, same-origin i nagłówka `Idempotency-Key`. Zapis wpisu lub korekty i odpowiadającego mu zdarzenia audytowego odbywa się atomowo. Audyt nie kopiuje kwoty, opisu ani identyfikatora dokumentu.

Dostęp dla dyrekcji i Komisji Rewizyjnej pozostaje wyłączony do zatwierdzenia macierzy kompetencji przez szkołę.

## Dalsze etapy

- uzgadnianie księgi z wyciągiem,
- eksport PDF (eksport CSV: patrz niżej, tylko router PostgreSQL),
- powiązanie wpisów z prywatnymi dokumentami w Railway Storage Bucket ([DOCUMENTS.md](DOCUMENTS.md)),
Interfejs w `ledger/` pokazuje podsumowanie roku, bieżący preliminarz i filtrowane wpisy. Pozwala tworzyć przychody lub wydatki i dopisywać korekty, korzystając wyłącznie z chronionego API. Formularz wymusza referencję uchwały dla wydatku powyżej 3000 EUR i zachowuje klucz idempotencji przy ponowieniu tego samego żądania.

- interfejs uzgadniania rachunku,
- edycja preliminarza,
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
- **Dostęp.** Każda trasa wymaga sesji, MFA i roli `admin`, `board` albo `treasurer` w zakresie roku szkolnego. `representative`, `audit` i `principal` dostają `403`. Zapisy wymagają zgodnego nagłówka `Origin`.
- **Kolejność błędów.** Przy kilku błędach naraz moduł zwraca ten sam kod co Worker (powiązanie wpłaty, uchwała, dokument, kategoria, ponowne ujęcie wpłaty). Jedyna świadoma różnica: przy korekcie osoba bez roli finansowej lub bez MFA dostaje `403` jeszcze przed wyszukaniem wpisu, więc nie może sprawdzić, czy dany identyfikator istnieje (Worker zwracał wtedy `404`).

### Eksport CSV (issue #7)

`GET /api/ledger/export.csv?schoolYearId=…` (tylko router PostgreSQL) zwraca wszystkie wpisy roku w kolejności dat, z kwotą pierwotną, sumą korekt i kwotą netto w EUR. Wymaga tych samych ról, MFA i zakresu roku co pozostałe trasy. Plik ma kodowanie UTF-8 z BOM, separator `;` i przecinek dziesiętny (`123,45`), aby otwierał się w arkuszu z polskimi lub belgijskimi ustawieniami — to założenie do potwierdzenia przez skarbnika. Komórki zaczynające się od `=`, `+`, `-`, `@`, tabulatora lub CR dostają prefiks `'`, żeby arkusz nie wykonał ich jako formuły. Eksport ma limit 20 000 wpisów (`413 export_too_large`). Każdy eksport zapisuje zdarzenie `ledger.exported` (osoba, czas, rok, liczba wierszy) bez kwot i treści wpisów. Plik zawiera opisy i źródła wpisane przez skarbnika, więc wolno go przekazywać tylko osobom uprawnionym; zasady przechowywania eksportów wymagają decyzji zarządu.

Schemat nie wymagał zmian — moduł korzysta z tabel, triggerów i widoków z `0003_ledger.sql`. Stary moduł `src/ledger.js` pozostaje bez zmian do czasu testów równoważności na danych syntetycznych i próby odtworzenia. Dopisywanie bilansu otwarcia, jego poprawek i nowych wersji preliminarza nadal odbywa się poza API (brak tras także w Workerze).

To prototyp: router PostgreSQL działa tylko przy ustawionym `DATABASE_URL`, nie jest wdrożony na Railway i nie jest zatwierdzony do pracy na danych rodzin. Zasady księgowania, korekt, format referencji uchwały i dostęp dyrekcji oraz Komisji Rewizyjnej nadal wymagają decyzji Rady i szkoły.
