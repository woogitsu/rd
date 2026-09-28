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

`POST /api/year-close/{rok}/close` wykonuje w jednej transakcji, w tej kolejności blokad (#212 — nie odwracać, ani w tej, ani w innej trasie):

0. `SELECT pg_advisory_xact_lock(hashtext('rd_year_close'))` — jedna globalna blokada doradcza dla WSZYSTKICH zamknięć, dowolnego roku, zwalniana automatycznie na koniec transakcji. Musi być pierwszym zapytaniem, przed `LOCK TABLE`. Bez niej dwa równoległe zamknięcia (dwie osoby albo podwójne kliknięcie) dostawały obie `LOCK … IN SHARE MODE` naraz (tryb `SHARE` nie wyklucza sam siebie), a potem każda transakcja czekała na blokadę wiersza zamknięcia / `INSERT` bilansu otwarcia — zakleszczenie (`40P01`) wykrywane dopiero po `deadlock_timeout`, w trakcie którego zapisy księgi WSZYSTKICH lat czekały. Założenie: zamknięcie jest rzadkie, więc globalna serializacja nie wpływa na wydajność (D-21).
1. blokuje tabele księgi (`LOCK … IN SHARE MODE`) i wiersz zamknięcia — trwające zapisy księgi kończą się przed wyliczeniem, nowe czekają i po zamknięciu są odrzucane,
2. sprawdza komplet listy kontrolnej i zasadę czterech oczu (zamyka inna osoba niż rozpoczynająca; także `CHECK` w bazie),
3. liczy bilans z widoku `ledger_year_summary` (bilans otwarcia + poprawki + przychody netto − wydatki netto) oraz część poza rachunkiem z `ledger_year_cash_summary` (gotówka z bilansu otwarcia + wpisy z metodą inną niż `bank` + przeniesienia kasa ↔ rachunek; #199),
4. tworzy `ledger_opening_balances` następnego roku z dokładnie tą kwotą i tą częścią gotówkową (`cash_cents`; rachunek = całość − kasa) (klucz idempotencji `year-close:{id zamknięcia}`); poprawka późniejsza tylko przez `ledger_opening_balance_adjustments` — w otwartym roku przez `POST /api/ledger/opening-balance/adjustments` (docs/LEDGER.md),
5. ustawia `expires_at = now()` na aktywnych przydziałach ról należących do zamykanego roku — `school_year_id` tego roku albo klasa tego roku (funkcja `role_grant_in_school_year` z 0022, ta sama reguła co `expire-grants`; jedyna zmiana dozwolona przez trigger z 0004; wiersze zostają) i zapisuje zdarzenie `role_grant.expired` dla każdego,
6. utrwala w wierszu zamknięcia bilans otwarcia, przychody, wydatki, bilans zamknięcia, gotówkę na otwarcie i zamknięcie (`opening_cash_cents`, `closing_cash_cents`; zamknięcia sprzed 0028 mają tu `NULL`), identyfikator przeniesionego bilansu i liczbę wygaszonych ról,
7. zapisuje zdarzenia `ledger_opening_balance.carried_forward` i `year_close.closed`.

Zamknięcie jest odrzucane, gdy następny rok ma już bilans otwarcia (`next_year_opening_balance_exists`) — trzeba wyjaśnić rozbieżność, a nie nadpisywać. Ponowne zamknięcie zamkniętego roku (przed rozpoczęciem transakcji albo po niej — druga transakcja widzi już `closed` po zwolnieniu advisory locka przez pierwszą) zwraca stan z `replayed: true` bez nowych zapisów, `200`, bez zakleszczenia (#212).

## Zamrożenie

Po zamknięciu triggery `a0_year_freeze` odrzucają (`school_year_closed`) nowe lub zmieniane rekordy przypisane do zamkniętego roku:

- wpłaty, przypisania wpłat, korekty wpłat,
- wpisy i korekty księgi, kategorie, preliminarz, bilans otwarcia i jego poprawki,
- wydarzenia (również zmiana stanu i odwołanie),
- zebrania, porządek, obecność, sprawdzenia quorum, protokoły, publikacje protokołów, uchwały,
- nowe przydziały ról w tym roku, także przydziały klasy tego roku wstawiane bez `school_year_id` (0022; API administratora zwraca `409 school_year_closed`); wygaszenie i cofnięcie istniejących pozostaje możliwe.
- (#80, 0036) uzgodnienia rachunku: nowe uzgodnienie i każda jego zmiana (m.in. zatwierdzenie), import wyciągu, wiersze wyciągu, dopasowania oraz cofnięcie dopasowania,
- (#80, 0036) nowy dokument (`documents`, każdy rodzaj: `financial`, `board`, `class`) przypisany do zamkniętego roku — dokumenty bez `school_year_id` (np. przywrócone z D1) nie są objęte,
- (#80, 0036) nowa kampania e-mail (`email_campaigns`) przypisana do zamkniętego roku. Zmiana stanu **istniejącej** kampanii (np. wysyłka rozpoczęta przed zamknięciem) NIE jest blokowana — decyzja, czy taką kampanię dokończyć czy wstrzymać, wymaga ustalenia Rady (D-13/D-21); wymuszenie blokady w złym miejscu kolejki mogłoby zdublować albo urwać wysyłkę w połowie.

Świadome wyjątki (tabele z `school_year_id`, bez triggera zamrożenia):
- `export_runs` (0016): eksport archiwum zamkniętego roku ma działać także po zamknięciu.
- `audit_events`: dziennik zdarzeń nie ma `school_year_id` i musi przyjmować zapisy zawsze, także dotyczące odczytu zamkniętego roku.

Odczyt i dziennik audytu nie są blokowane przez triggery, ale po zamknięciu **dostęp** do odczytu zależy od przydziałów (sekcja „Odczyt archiwum”). **Korekta po zamknięciu nie ma ścieżki w aplikacji.** Pomyłkę wykrytą po zamknięciu ujmuje się w otwartym roku następnym (np. poprawka bilansu otwarcia z uzasadnieniem odwołującym się do uchwały) — sposób musi zatwierdzić Rada. Ponowne otwarcie roku wymagałoby osobnej migracji i decyzji.

API wpłat, księgi, wydarzeń, zebrań, uzgodnień rachunku, kampanii e-mail i dokumentów tłumaczy odmowę triggera na `409 school_year_closed` (SR-14 w docs/SECURITY_REVIEW.md). Aktualności nie mają `school_year_id` i triggera zamrożenia nie dotyczą.

Data wpisu poza rokiem szkolnym (`occurred_on`/`received_on` księgi i wpłat) jest osobno pokryta triggerem `b0_date_within_school_year` (#169, 0027) — patrz `docs/DATA_MODEL.md`.

## API

Wszystkie trasy: aktywna sesja, MFA, przydział bez zawężenia do klasy, w zakresie zamykanego roku albo bez zakresu roku. Zapisy wymagają zgodnego nagłówka `Origin`.

| Trasa | Role | Wynik |
|---|---|---|
| `GET /api/year-close/{rok}` | zarząd, skarbnik | stan, lista kontrolna, brakujące punkty, bilans (`live` przed zamknięciem, `closed` po) |
| `POST /api/year-close/{rok}/start` `{ nextSchoolYearId }` | zarząd | 201; 200 przy powtórzeniu; 409 gdy rok następny nie jest późniejszy albo nie jest otwarty |
| `POST /api/year-close/{rok}/checklist/{punkt}` `{ note?, documentId? }` | zarząd, skarbnik | 201; 200 przy powtórzeniu; 409 poza stanem `closing` |
| `POST /api/year-close/{rok}/close` | zarząd | 200; 409 `checklist_incomplete` (z listą braków), `four_eyes_required`, `next_year_opening_balance_exists` |
| `GET /api/year-close/{rok}/handover` | zarząd, skarbnik; po zamknięciu także zarząd/skarbnik roku następnego i admin (tylko odczyt) | zestawienie przekazania (JSON) |

Zestawienie przekazania zawiera wyłącznie liczby, sumy w centach EUR i identyfikatory: bilans (z podziałem rachunek/kasa: `openingCashCents`, `closingCashCents`, `closingBankCents`; bilans otwarcia nowego roku z `cashCents`), liczby wpisów i korekt księgi, sumy wpłat zapisanych i niewyjaśnionych (bez rodzin), zebrania według stanu i liczbę odbytych bez zatwierdzonego protokołu, uchwały według stanu (bieżące wersje), wydarzenia według stanu, listę kontrolną z identyfikatorami osób, liczbę wygaszonych ról i aktywne role nowego roku. Nie zawiera imion, adresów e-mail ani danych dzieci. Suma wpłat nie jest listą „dłużników” — składki są dobrowolne. Eksport PDF/CSV (0016) powstaje osobno.

Po zamknięciu osoby, których jedyny przydział był zawężony do starego roku, tracą dostęp — także do tego zestawienia (zamknięcie wygasza przydziały roku, również `audit` i `treasurer`).

## Odczyt archiwum (#195)

Wariant zachowawczy do czasu decyzji D-08/D-09 (zarząd jeszcze nie zdecydował): **tylko odczyt, tylko trzy trasy**. Reguła w `src/pg/archive-access.js`.

| Trasa | Kto czyta zamknięty rok N |
|---|---|
| `GET /api/year-close/{N}/handover` | zarząd lub skarbnik z przydziałem roku N+1; admin |
| `GET /api/reports/audit?schoolYearId={N}` (JSON i HTML) | zarząd lub skarbnik z przydziałem roku N+1; admin |
| `POST /api/exports { schoolYearId: N }` | zarząd z przydziałem roku N+1; admin (jak dotąd) — skarbnik nie ma eksportu także w bieżącym roku |

- N+1 to wyłącznie `school_year_closures.next_school_year_id` zamkniętego roku N, a N musi mieć stan `closed`. Jeden rok wstecz, bez łańcucha: przydział roku N+2 nie otwiera roku N. Przed zamknięciem przydział N+1 nie daje żadnego dostępu do N.
- Wymagane: MFA i przydział bez zawężenia do klasy. Przedstawiciel klasy, dyrekcja i Komisja Rewizyjna (także nowego roku) dostają `403`. Admin — przydział bez roku albo roku N+1.
- Przydział bez zakresu roku działa jak dotąd (otwiera wszystkie lata, także bieżący).
- Każdy odczyt przez tę regułę zapisuje zdarzenie `year_close.archive_read` (aktor, rok N w `entity_id`, `metadata.route`, `metadata.viaSchoolYearId`) bez danych osobowych; raport i eksport zapisują też swoje zwykłe zdarzenia.
- Pozostałe trasy roku N (stan zamknięcia, księga, wpłaty, uzgodnienia) nadal wymagają przydziału roku N albo bez zakresu roku. Zapis w roku N kończy się `403` (brak roli w roku N) albo `409 school_year_closed` (trigger zamrożenia).
- Nie ma przydziału „tylko do odczytu” w zamkniętym roku: `POST /api/admin/grants` z `schoolYearId` zamkniętego roku kończy się `409 school_year_closed` (nie `503`), bez zapisu.
- Komisja Rewizyjna traci odczyt w chwili zamknięcia (D-09: czy i jak długo KR ma dostęp po zamknięciu). Jeśli Rada zdecyduje inaczej, regułę trzeba rozszerzyć osobną zmianą.

## Założenia

- Zasada czterech oczu przy zamknięciu (inna osoba niż rozpoczynająca) — założenie, nie przepis regulaminu (D-21).
- Rozpoczyna i zamyka zarząd; skarbnik tylko potwierdza punkty listy. Komisja Rewizyjna, dyrekcja i admin techniczny nie mają dostępu do czasu D-08/D-09 — z wyjątkiem odczytu archiwum zamkniętego roku przez admina (#195).
- Wygaszane są przydziały z `school_year_id` zamykanego roku oraz przydziały klas tego roku (#201). Przydziały bez zakresu roku (np. admin techniczny) nie wygasają automatycznie — obsługuje je zarządzanie rolami (0012).
- Następny rok musi zaczynać się później niż zamykany i nie może mieć rozpoczętego zamknięcia.
- Bilans liczony jest z księgi, nie z wpłat; wpłata wpływa na bilans dopiero przez wpis przychodu.

## Ryzyka

- Brak ścieżki „korekta po zamknięciu”: błąd wykryty później wymaga decyzji Rady.
- Lista kontrolna jest deklaratywna; aplikacja nie weryfikuje raportów ani uzgodnienia z bankiem.
- Blokada `SHARE` na tabelach księgi na czas zamknięcia wstrzymuje zapisy księgi wszystkich lat na kilka milisekund–sekund.
- Zamrożenie obejmuje publikację protokołów starego roku; jeśli Rada zechce publikować archiwalne protokoły po zamknięciu, potrzebna będzie osobna decyzja i zmiana.

## Decyzje do podjęcia

D-04 (czas przechowywania archiwum), D-08/D-09 (kto rozpoczyna, potwierdza i zamyka, dostęp Komisji Rewizyjnej i dyrekcji do zestawienia), D-13 (uzgodnienie rachunku przed zamknięciem), D-21 (regulamin: termin i tryb przekazania kadencji, zatwierdzenie sprawozdania).
