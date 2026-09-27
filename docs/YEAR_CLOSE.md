# Zamknięcie roku i przekazanie dokumentacji nowej Radzie

Zakres: issue #15. Migracja `postgres/migrations/0017_year_close.sql`, trasy `src/pg/routes/year-close.js`, testy `tests/pg-year-close.test.js`. Prototyp na PostgreSQL (Railway), testowany wyłącznie na danych syntetycznych. **Nie jest gotowy do pracy na danych rodzin** — wymaga decyzji wymienionych na końcu.

## Stany roku

| Stan | Znaczenie | Jak powstaje |
|---|---|---|
| `open` | rok bez wiersza w `school_year_closures`; zwykła praca | domyślnie |
| `closing` | zamknięcie rozpoczęte, zbierane są potwierdzenia listy kontrolnej; zapisy nadal możliwe | `POST …/start` |
| `closed` | rok zamrożony; bilans przeniesiony; role starej kadencji wygaszone | `POST …/close` |

Przejście jest jednokierunkowe. Wiersza zamknięcia nie można usunąć ani cofnąć (`school_year_closure_is_final`).

## Lista kontrolna

Każdy punkt potwierdza osoba z rolą zarządu albo skarbnika (MFA). Zapisywane są: kto, kiedy, opcjonalna notatka (3–500 znaków) i opcjonalny identyfikator prywatnego dokumentu (`documents.id`). Potwierdzenia nie da się zmienić ani usunąć; ponowne potwierdzenie zwraca istniejący wpis (`replayed: true`).

| Punkt | Co oznacza |
|---|---|
| `financial_report` | raport finansowy za rok przygotowany |
| `audit_commission_report` | raport Komisji Rewizyjnej przekazany |
| `minutes_approved` | protokoły zebrań zatwierdzone |
| `resolutions_archived` | uchwały zebrane w archiwum |
| `reconciliation_confirmed` | księga uzgodniona z rachunkiem (moduł uzgodnień, migracja 0015, powstaje osobno) |
| `documents_handed_over` | dokumenty przekazane nowej Radzie |

Aplikacja nie sprawdza treści raportów — to potwierdzenie ludzkie. Zestawienie przekazania pokazuje pomocniczo np. liczbę odbytych zebrań bez zatwierdzonego protokołu.

## Zamknięcie

`POST /api/year-close/{rok}/close` wykonuje w jednej transakcji:

1. blokuje tabele księgi (`LOCK … IN SHARE MODE`) i wiersz zamknięcia — trwające zapisy księgi kończą się przed wyliczeniem, nowe czekają i po zamknięciu są odrzucane,
2. sprawdza komplet listy kontrolnej i zasadę czterech oczu (zamyka inna osoba niż rozpoczynająca; także `CHECK` w bazie),
3. liczy bilans z widoku `ledger_year_summary` (bilans otwarcia + poprawki + przychody netto − wydatki netto),
4. tworzy `ledger_opening_balances` następnego roku z dokładnie tą kwotą (klucz idempotencji `year-close:{id zamknięcia}`); poprawka późniejsza tylko przez `ledger_opening_balance_adjustments`,
5. ustawia `expires_at = now()` na aktywnych przydziałach ról zawężonych do zamykanego roku (jedyna zmiana dozwolona przez trigger z 0004; wiersze zostają) i zapisuje zdarzenie `role_grant.expired` dla każdego,
6. utrwala w wierszu zamknięcia bilans otwarcia, przychody, wydatki, bilans zamknięcia, identyfikator przeniesionego bilansu i liczbę wygaszonych ról,
7. zapisuje zdarzenia `ledger_opening_balance.carried_forward` i `year_close.closed`.

Zamknięcie jest odrzucane, gdy następny rok ma już bilans otwarcia (`next_year_opening_balance_exists`) — trzeba wyjaśnić rozbieżność, a nie nadpisywać. Ponowne zamknięcie zamkniętego roku zwraca stan z `replayed: true` bez nowych zapisów.

## Zamrożenie

Po zamknięciu triggery `a0_year_freeze` odrzucają (`school_year_closed`) nowe lub zmieniane rekordy przypisane do zamkniętego roku:

- wpłaty, przypisania wpłat, korekty wpłat,
- wpisy i korekty księgi, kategorie, preliminarz, bilans otwarcia i jego poprawki,
- wydarzenia (również zmiana stanu i odwołanie),
- zebrania, porządek, obecność, sprawdzenia quorum, protokoły, publikacje protokołów, uchwały,
- nowe przydziały ról w tym roku (wygaszenie i cofnięcie istniejących pozostaje możliwe).

Odczyt, eksport i dziennik audytu działają bez zmian. **Korekta po zamknięciu nie ma ścieżki w aplikacji.** Pomyłkę wykrytą po zamknięciu ujmuje się w otwartym roku następnym (np. poprawka bilansu otwarcia z uzasadnieniem odwołującym się do uchwały) — sposób musi zatwierdzić Rada. Ponowne otwarcie roku wymagałoby osobnej migracji i decyzji.

Obecne API wpłat, księgi, wydarzeń i zebrań nie tłumaczy jeszcze błędu `school_year_closed` na kod 409 — zapis jest odrzucany, ale odpowiedź to ogólne 503. Do poprawy w tych modułach.

## API

Wszystkie trasy: aktywna sesja, MFA, przydział bez zawężenia do klasy, w zakresie zamykanego roku albo bez zakresu roku. Zapisy wymagają zgodnego nagłówka `Origin`.

| Trasa | Role | Wynik |
|---|---|---|
| `GET /api/year-close/{rok}` | zarząd, skarbnik | stan, lista kontrolna, brakujące punkty, bilans (`live` przed zamknięciem, `closed` po) |
| `POST /api/year-close/{rok}/start` `{ nextSchoolYearId }` | zarząd | 201; 200 przy powtórzeniu; 409 gdy rok następny nie jest późniejszy albo nie jest otwarty |
| `POST /api/year-close/{rok}/checklist/{punkt}` `{ note?, documentId? }` | zarząd, skarbnik | 201; 200 przy powtórzeniu; 409 poza stanem `closing` |
| `POST /api/year-close/{rok}/close` | zarząd | 200; 409 `checklist_incomplete` (z listą braków), `four_eyes_required`, `next_year_opening_balance_exists` |
| `GET /api/year-close/{rok}/handover` | zarząd, skarbnik | zestawienie przekazania (JSON) |

Zestawienie przekazania zawiera wyłącznie liczby, sumy w centach EUR i identyfikatory: bilans, liczby wpisów i korekt księgi, sumy wpłat zapisanych i niewyjaśnionych (bez rodzin), zebrania według stanu i liczbę odbytych bez zatwierdzonego protokołu, uchwały według stanu (bieżące wersje), wydarzenia według stanu, listę kontrolną z identyfikatorami osób, liczbę wygaszonych ról i aktywne role nowego roku. Nie zawiera imion, adresów e-mail ani danych dzieci. Suma wpłat nie jest listą „dłużników” — składki są dobrowolne. Eksport PDF/CSV (0016) powstaje osobno.

Po zamknięciu osoby, których jedyny przydział był zawężony do starego roku, tracą dostęp — także do tego zestawienia. Odczyt archiwum zapewnia przydział nowego roku albo przydział bez zakresu roku.

## Założenia

- Zasada czterech oczu przy zamknięciu (inna osoba niż rozpoczynająca) — założenie, nie przepis regulaminu (D-21).
- Rozpoczyna i zamyka zarząd; skarbnik tylko potwierdza punkty listy. Komisja Rewizyjna, dyrekcja i admin techniczny nie mają dostępu do czasu D-08/D-09.
- Wygaszane są tylko przydziały z `school_year_id` zamykanego roku. Przydziały bez zakresu roku (np. admin techniczny) nie wygasają automatycznie — obsługuje je zarządzanie rolami (0012).
- Następny rok musi zaczynać się później niż zamykany i nie może mieć rozpoczętego zamknięcia.
- Bilans liczony jest z księgi, nie z wpłat; wpłata wpływa na bilans dopiero przez wpis przychodu.

## Ryzyka

- Brak ścieżki „korekta po zamknięciu”: błąd wykryty później wymaga decyzji Rady.
- Lista kontrolna jest deklaratywna; aplikacja nie weryfikuje raportów ani uzgodnienia z bankiem.
- Blokada `SHARE` na tabelach księgi na czas zamknięcia wstrzymuje zapisy księgi wszystkich lat na kilka milisekund–sekund.
- Zamrożenie obejmuje publikację protokołów starego roku; jeśli Rada zechce publikować archiwalne protokoły po zamknięciu, potrzebna będzie osobna decyzja i zmiana.

## Decyzje do podjęcia

D-04 (czas przechowywania archiwum), D-08/D-09 (kto rozpoczyna, potwierdza i zamyka, dostęp Komisji Rewizyjnej i dyrekcji do zestawienia), D-13 (uzgodnienie rachunku przed zamknięciem), D-21 (regulamin: termin i tryb przekazania kadencji, zatwierdzenie sprawozdania).
