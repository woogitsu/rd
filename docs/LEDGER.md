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
- eksport CSV/PDF,
- prywatne dokumenty źródłowe w R2 po autoryzacji,
- interfejs księgi oraz preliminarza.

Nie używać modelu na danych rzeczywistych przed zatwierdzeniem zasad księgowania, korekt, uchwał i dostępu przez Radę oraz szkołę.
