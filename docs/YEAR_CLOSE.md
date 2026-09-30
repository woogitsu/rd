# Zamknięcie roku i przekazanie dokumentacji nowej Radzie

Status (30.09.2026, #175): model w bazie (`postgres/migrations/0017_year_close.sql` i kolejne), API na PostgreSQL (`src/pg/routes/year-close.js`) i panel (`year-close/`). Staging: nie wykonano; produkcja: nie (D-20). Prototyp na danych syntetycznych — **nie jest gotowy do pracy na danych rodzin**.

Zakres: issue #15. Migracja `postgres/migrations/0017_year_close.sql`, trasy `src/pg/routes/year-close.js`, testy `tests/pg-year-close.test.js` (współbieżność na prawdziwym PostgreSQL: `tests/pg-year-close-race.test.js`). Prototyp na PostgreSQL (docelowy stos Railway, niewdrożony), testowany wyłącznie na danych syntetycznych. **Nie jest gotowy do pracy na danych rodzin** — wymaga decyzji wymienionych na końcu.

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
| `reconciliation_confirmed` | księga uzgodniona z rachunkiem (moduł uzgodnień istnieje — `src/pg/routes/reconciliation.js`, migracja `0015`, [docs/RECONCILIATION.md](RECONCILIATION.md)) |
| `documents_handed_over` | dokumenty przekazane nowej Radzie |

Aplikacja nie sprawdza treści raportów — to potwierdzenie ludzkie. Zestawienie przekazania pokazuje pomocniczo np. liczbę odbytych zebrań bez zatwierdzonego protokołu.

### Ostrzeżenia informacyjne i przegląd dziennika odczytu (#80, #133)

`GET /api/year-close/{rok}` zwraca dodatkowo `warnings` (lista `{ code, count, amountCents }`, pusta gdy brak) i `accessReview`. To wyłącznie **informacja z liczbami — nie blokuje** rozpoczęcia, potwierdzenia punktu ani zamknięcia; blokuje nadal tylko to, co blokowało serwer (komplet listy kontrolnej, cztery oczy, zgodność salda końca roku). Odpowiedź nie zawiera opisów wpisów, nazw ani identyfikatorów osób i gospodarstw. Kody, w stałej kolejności: `unallocated_payments` (wpłaty w stanie `unmatched` z niepokrytą kwotą netto; kwota = suma niepokrytej części), `expenses_without_evidence` (wydatki netto > 0 bez dokumentu; te same reguły co raport KR, #87), `large_expenses_without_resolution` (wydatki > 3000 EUR bez przyjętej uchwały; ta sama reguła `flagged` co w raporcie KR, #93), `reconciliation_missing` (brak zatwierdzonego uzgodnienia), `reconciliation_before_year_end` (data wyciągu ostatniego zatwierdzonego uzgodnienia przed `ends_on`), `reconciliation_difference` (różnica salda ostatniego zatwierdzonego uzgodnienia ≠ 0; kwota = różnica), `reconciliation_drafts` (szkice), `unmatched_statement_lines` (pozycje wyciągu bez dopasowania w uzgodnieniach niezarzuconych; kwota = suma modułów), `open_email_campaigns` (kampanie w stanie szkic, zatwierdzona lub w wysyłce). „Brak wpisu wpłaty” nie jest statusem dłużnika — składki są dobrowolne, lista może być nieaktualna.

`accessReview` (informacyjna pozycja przeglądu, #133): odczyty z `data_access_log` w zakresie roku (`school_year_id` roku albo klasa roku), z wynikiem `ok`, wg rodzaju (`reads`: wpisy, odczyty, liczba kont), `readsWithoutValidGrant` (odczyty, przy których konto nie miało w chwili odczytu ważnego przydziału — wygasłego, cofniętego albo jeszcze nieprzyznanego) oraz `activeGrantsInScope` (przydziały, które zamknięcie roku wygasi). Bez identyfikatorów kont — szczegóły w przeglądzie dziennika odczytu w panelu administratora. **Wariant zachowawczy (D-13/D-21):** nie jest to kolejny punkt blokujący listy kontrolnej (`CHECKLIST_ITEMS`); nowy punkt wymagałby migracji (`CHECK` na `school_year_closure_checklist.item`) i zmieniłby warunek zamknięcia, więc do decyzji Rady. Ekran `year-close/` pokazuje obie sekcje pod listą kontrolną.

## Zamknięcie

`POST /api/year-close/{rok}/close` wykonuje w jednej transakcji, w tej kolejności blokad (#212 — nie odwracać, ani w tej, ani w innej trasie):

0. `SELECT pg_advisory_xact_lock(hashtext('rd_year_close'))` — jedna globalna blokada doradcza dla WSZYSTKICH zamknięć, dowolnego roku, zwalniana automatycznie na koniec transakcji. Musi być pierwszym zapytaniem, przed `LOCK TABLE`. Bez niej dwa równoległe zamknięcia (dwie osoby albo podwójne kliknięcie) dostawały obie `LOCK … IN SHARE MODE` naraz (tryb `SHARE` nie wyklucza sam siebie), a potem każda transakcja czekała na blokadę wiersza zamknięcia / `INSERT` bilansu otwarcia — zakleszczenie (`40P01`) wykrywane dopiero po `deadlock_timeout`, w trakcie którego zapisy księgi WSZYSTKICH lat czekały. Założenie: zamknięcie jest rzadkie, więc globalna serializacja nie wpływa na wydajność (D-21).
1. blokuje tabele księgi (`LOCK … IN SHARE MODE`) i wiersz zamknięcia — trwające zapisy księgi kończą się przed wyliczeniem, nowe czekają i po zamknięciu są odrzucane,
2. sprawdza komplet listy kontrolnej i zasadę czterech oczu (zamyka inna osoba niż rozpoczynająca; także `CHECK` w bazie),
3. (#169) sprawdza saldo końca roku: bilans zamknięcia (`ledger_year_summary`, cała część gotówkowa z `ledger_year_cash_summary`) porównuje z saldem księgi na `ends_on` (`ledger_balance_at` i `ledger_non_bank_net_at`, jak w uzgodnieniu rachunku), osobno dla całości, kasy i rachunku. Różnica ≠ 0 (np. wpis datowany po końcu roku, wiersz sprzed walidacji 0027) daje `409 year_end_balance_mismatch` z liczbami (`yearEndCheck`), dopóki zarząd jawnie nie potwierdzi rozbieżności: ciało `POST …/close` `{ "confirmYearEndDiscrepancy": { "reason": <kod>, "balanceDifferenceCents": <int>, "cashDifferenceCents": <int> } }`. Kwoty muszą zgadzać się z liczonymi pod blokadą (inaczej `409 year_end_confirmation_mismatch`), a `reason` to jeden z kodów: `entry_dated_after_year_end`, `explained_by_resolution`, `explained_outside_system` (wolny tekst nie trafia do audytu — wariant zachowawczy do decyzji Rady; osobna kolumna na opis wymagałaby migracji). Potwierdzenie zapisuje zdarzenie `year_close.year_end_discrepancy_confirmed` (aktor, kod powodu, różnice, `schoolYearId`) w tej samej transakcji; `year_close.closed` ma `yearEndDiscrepancyConfirmed`. Zasada czterech oczu i role bez zmian; przy zgodnym saldzie potwierdzenie jest zbędne i ignorowane. Ten sam wskaźnik jest w `GET /api/year-close/{rok}` (`yearEndCheck`). Panel zamknięcia pokazuje komunikat o rozbieżności, ale nie ma jeszcze formularza potwierdzenia (tylko API).
3a. liczy bilans z widoku `ledger_year_summary` (bilans otwarcia + poprawki + przychody netto − wydatki netto) oraz część poza rachunkiem z `ledger_year_cash_summary` (gotówka z bilansu otwarcia + wpisy z metodą inną niż `bank` + przeniesienia kasa ↔ rachunek; #199),
4. tworzy `ledger_opening_balances` następnego roku z dokładnie tą kwotą i tą częścią gotówkową (`cash_cents`; rachunek = całość − kasa) (klucz idempotencji `year-close:{id zamknięcia}`); poprawka późniejsza tylko przez `ledger_opening_balance_adjustments` — w otwartym roku przez `POST /api/ledger/opening-balance/adjustments` (docs/LEDGER.md),
5. ustawia `expires_at = now()` na aktywnych przydziałach ról należących do zamykanego roku — `school_year_id` tego roku albo klasa tego roku (funkcja `role_grant_in_school_year` z 0022, ta sama reguła co `expire-grants`; jedyna zmiana dozwolona przez trigger z 0004; wiersze zostają) i zapisuje zdarzenie `role_grant.expired` dla każdego,
6. utrwala w wierszu zamknięcia bilans otwarcia, przychody, wydatki, bilans zamknięcia, gotówkę na otwarcie i zamknięcie (`opening_cash_cents`, `closing_cash_cents`; zamknięcia sprzed 0028 mają tu `NULL`), identyfikator przeniesionego bilansu i liczbę wygaszonych ról,
7. zapisuje zdarzenia `ledger_opening_balance.carried_forward` i `year_close.closed`.

Zamknięcie jest odrzucane, gdy następny rok ma już bilans otwarcia (`next_year_opening_balance_exists`) — trzeba wyjaśnić rozbieżność, a nie nadpisywać. Ponowne zamknięcie zamkniętego roku (przed rozpoczęciem transakcji albo po niej — druga transakcja widzi już `closed` po zwolnieniu advisory locka przez pierwszą) zwraca stan z `replayed: true` bez nowych zapisów, `200`, bez zakleszczenia (#212).

Inne trasy a blokady zamknięcia (#212, weryfikacja na prawdziwym PostgreSQL — `tests/pg-year-close-race.test.js`, `npm run test:pg-real`; PGlite wykonuje transakcje po kolei i zakleszczeń nie pokazuje):

- zapis i korekta księgi (`ledger_entries`, `ledger_corrections`, …) czekają na `SHARE` z kroku 1; po zamknięciu w zamykanym roku dostają `409 school_year_closed`, w innym roku przechodzą po zwolnieniu blokady;
- tabele wpłat (`payment_entries`, `payment_corrections`, …) nie są blokowane przez `LOCK TABLE`; trigger zamrożenia (`school_year_assert_open`, 0017) bierze `FOR SHARE` na wierszu zamknięcia. Korekta wpłaty w trakcie zamknięcia czeka na ten wiersz i dostaje `409 school_year_closed`; korekta niezatwierdzona przed zamknięciem wstrzymuje zamknięcie do swojego COMMIT (albo przed, albo `409`, nigdy w połowie);
- ręczny bilans otwarcia (`POST /api/ledger/opening-balance`) bierze `LOCK ledger_opening_balances IN SHARE ROW EXCLUSIVE MODE` jako pierwszą blokadę — czeka na zamknięcie i widzi bilans przeniesiony (`409 opening_balance_exists`);
- promocja uczniów (`src/pg/promotions.js`) ma własną blokadę doradczą `rd_promotion` i nie bierze blokad księgi ani `rd_year_close`, więc nie tworzy cyklu; zapis przydziału ucznia do zamykanego roku odrzuca trigger zamrożenia `enrollments` (0054);
- ponowienie 40P01/40001 po stronie serwera (#156) robi `src/db.js` dla każdej transakcji, także tej — ale test wymusza `retries: 0`, żeby zakleszczenie nie było ukryte za ponowieniem.

Krok 5 (wygaszenie przydziałów zawężonych do zamykanego roku) ma skutek uboczny przy dwóch równoległych `/close` (#212, dopisek): jeśli osoba B ma rolę `board` zawężoną WŁAŚNIE do zamykanego roku (jak osoba A, zwykle w tej samej kadencji), a osoba A zamknie rok jako pierwsza, przydział B do tego roku jest już wygaszony, zanim żądanie B dotrze do sprawdzenia roli (`authorize()` w `src/pg/routes/year-close.js` biegnie PRZED transakcją, więc kolejność wejścia do samej autoryzacji nie jest chroniona advisory lockiem). Zwykłe sprawdzenie roli zwróciłoby wtedy mylące `403 forbidden` osobie, która miała prawo zamknąć rok w chwili wysłania żądania. `wasAuthorizedAtOwnClosure` rozpoznaje ten dokładny przypadek — przydział wygasł w TEJ SAMEJ transakcji, która zamknęła TEN rok (`role_grants.expires_at = school_year_closures.closed_at`, oba `now()` tej samej transakcji SQL).

Wariant zachowawczy (najmniej uprawnień, D-08/D-09 jeszcze nierozstrzygnięte): taka osoba NIE dostaje pełnej odpowiedzi `replayed: true` z bilansem i identyfikatorami zamknięcia — jej przydział do tego roku już nie istnieje, więc nie ma dziś prawa tych danych czytać. Dostaje zamiast tego zwykłe `409 school_year_closed` (ten sam kod, którego już używa `start` po zamknięciu), bez wymogu świeżego MFA (nic się nie zmienia w tej gałęzi) i bez nowego zdarzenia audytu (stan bazy się nie zmienia — to czysty odczyt uprawnień, nie zapis). Nie dotyczy osoby, która nigdy nie miała odpowiedniej roli w tym roku, ani przydziału wygasłego z innego powodu (rewokacja, wcześniejsze naturalne wygaśnięcie sprzed TEGO konkretnego zamknięcia) — te dostają zwykłe `403 forbidden`, jak dotąd.

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

- (#80, 0130) `school_years` (UPDATE/DELETE granic, etykiety i samego wiersza zamkniętego roku) oraz `classes` (INSERT/UPDATE/DELETE: nazwy i skład klas zamkniętego roku),
- (#80, 0130) nowe wiersze `enrollment_history`, `import_batches`, `invitations`, `payment_instructions`, `payment_references` (także jej unieważnienie) i `news_posts` przypisane do zamkniętego roku. Wariant zachowawczy do decyzji Rady: dla `invitations`, `import_batches`, `news_posts` i `enrollment_history` blokowany jest tylko INSERT — zmiana stanu istniejącego wiersza (wycofanie zaproszenia, cofnięcie publikacji aktualności, np. po wycofaniu zgody na wizerunek) pozostaje możliwa.

Świadome wyjątki (tabele z `school_year_id` lub `class_id`, bez triggera zamrożenia). Lista jest utrzymywana w `FREEZE_EXCEPTIONS` w `tests/pg-year-close-finance-freeze.test.js`; test wylicza z katalogu bazy wszystkie takie tabele i wymaga triggera `a0_year_freeze` albo wpisu wyjątku, więc nowa tabela bez decyzji psuje test:
- `school_year_closures`: sam rekord zamknięcia, chroniony przez `year_close_guard` (0017).
- `export_runs` (0016): eksport archiwum zamkniętego roku ma działać także po zamknięciu.
- `data_access_log` (0067): rejestr dostępu musi przyjmować zapisy zawsze.
- `privacy_notices` (0075): informacja o przetwarzaniu danych nie zależy od stanu roku (D-06).
- `audit_events`: dziennik zdarzeń nie ma `school_year_id` i musi przyjmować zapisy zawsze, także dotyczące odczytu zamkniętego roku.

Odczyt i dziennik audytu nie są blokowane przez triggery, ale po zamknięciu **dostęp** do odczytu zależy od przydziałów (sekcja „Odczyt archiwum”). **Korekta po zamknięciu nie ma ścieżki w aplikacji.** Pomyłkę wykrytą po zamknięciu ujmuje się w otwartym roku następnym (np. poprawka bilansu otwarcia z uzasadnieniem odwołującym się do uchwały) — sposób musi zatwierdzić Rada. Ponowne otwarcie roku wymagałoby osobnej migracji i decyzji.

API wpłat, księgi, wydarzeń, zebrań, uzgodnień rachunku, kampanii e-mail i dokumentów tłumaczy odmowę triggera na `409 school_year_closed` (SR-14 w docs/SECURITY_REVIEW.md). Nowe wiersze aktualności (`news_posts`, `school_year_id NOT NULL`) są od 0130 objęte zamrożeniem (INSERT); odmowę tłumaczy sieć bezpieczeństwa routera (`src/pg/db-errors.js`) na `409 school_year_closed`.

Data wpisu poza rokiem szkolnym (`occurred_on`/`received_on` księgi i wpłat) jest osobno pokryta triggerem `b0_date_within_school_year` (#169, 0027) — patrz `docs/DATA_MODEL.md`.

## API

Wszystkie trasy: aktywna sesja, MFA, przydział bez zawężenia do klasy, w zakresie zamykanego roku albo bez zakresu roku. Zapisy wymagają zgodnego nagłówka `Origin`.

| Trasa | Role | Wynik |
|---|---|---|
| `GET /api/year-close/{rok}` | zarząd, skarbnik | stan, lista kontrolna, brakujące punkty, bilans (`live` przed zamknięciem, `closed` po) |
| `POST /api/year-close/{rok}/start` `{ nextSchoolYearId }` | zarząd | 201; 200 przy powtórzeniu; 409 gdy rok następny nie jest późniejszy albo nie jest otwarty |
| `POST /api/year-close/{rok}/checklist/{punkt}` `{ note?, documentId? }` | zarząd, skarbnik | 201; 200 przy powtórzeniu; 409 poza stanem `closing` |
| `POST /api/year-close/{rok}/close` | zarząd | 200; 409 `checklist_incomplete` (z listą braków), `four_eyes_required`, `next_year_opening_balance_exists`, `year_end_balance_mismatch` / `year_end_confirmation_mismatch` (z `yearEndCheck`); 400 `invalid_year_end_confirmation` |
| `GET /api/year-close/{rok}/handover` | zarząd, skarbnik; po zamknięciu także zarząd/skarbnik roku następnego i admin (tylko odczyt) | zestawienie przekazania (JSON) |

Zestawienie i widok stanu zamknięcia są odczytywane w jednej transakcji `REPEATABLE READ, READ ONLY` (#213); pole `asOf` w zestawieniu to czas migawki (`now()` transakcji), nie zegar serwera aplikacji. Zestawienie przekazania zawiera wyłącznie liczby, sumy w centach EUR i identyfikatory: bilans (z podziałem rachunek/kasa: `openingCashCents`, `closingCashCents`, `closingBankCents`; bilans otwarcia nowego roku z `cashCents`), liczby wpisów i korekt księgi, sumy wpłat zapisanych i niewyjaśnionych (bez rodzin), zebrania według stanu i liczbę odbytych bez zatwierdzonego protokołu, uchwały według stanu (bieżące wersje), wydarzenia według stanu, listę kontrolną z identyfikatorami osób, liczbę wygaszonych ról i aktywne role nowego roku. Nie zawiera imion, adresów e-mail ani danych dzieci. Suma wpłat nie jest listą „dłużników” — składki są dobrowolne. Eksport roczny (0016, `docs/EXPORT.md`, `POST /api/exports`) już istnieje dla listy klasy (JSON/CSV) i archiwum kadencji, ale **nie** dla samego zestawienia przekazania: `GET /api/year-close/{rok}/handover` zwraca dziś wyłącznie JSON — drukowalny PDF/CSV tego konkretnego dokumentu (do podpisu przy przekazaniu) nie istnieje i pozostaje przyszłym etapem.

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

## Nowy rok szkolny bez ręcznego SQL (#207)

Pełny cykl przechodzi przez API i panele, bez `INSERT` w bazie; kolejność sprawdza test `tests/pg-year-cycle.test.js` (jeden PGlite, wyłącznie `handlePgRequest`). Uprawnienia bez zmian (wariant zachowawczy D-08/D-09 — panel tylko pokazuje akcje istniejących tras, serwer autoryzuje każde żądanie).

| Krok | Trasa | Panel | Kto |
|---|---|---|---|
| Nowy rok | `POST /api/admin/school-years` | Konta i role → „Lata szkolne i klasy” | admin |
| Klasy nowego roku | `POST /api/admin/school-years/:id/classes` albo kopia z mapą `POST /api/admin/promotions/classes/preview` i `…/apply` | Konta i role (dodanie klas); kopia z mapą — tylko API (#78) | admin |
| Promocja uczniów | `POST /api/admin/promotions/preview` i `…/apply` (planDigest, Idempotency-Key) | tylko API (zakładka „Nowy rok” — #78) | admin |
| Kategorie księgi | `POST /api/ledger/categories/copy` (`dryRun` → zapis) albo `POST /api/ledger/categories` | Księga → „Kopiuj kategorie z innego roku”, „Nowa kategoria” | admin, zarząd, skarbnik roku docelowego |
| Preliminarz | `POST /api/ledger/budget` | Księga → „Dodaj linię planu” | jak wyżej |
| Bilans otwarcia | pierwszy rok: `POST /api/ledger/opening-balance`; kolejne lata: zamknięcie roku poprzedniego | Księga → „Wpisz bilans otwarcia” (tylko rok bez bilansu) | zarząd |
| Przydziały ról | `POST /api/admin/grants` / zaproszenia | Konta i role | admin |
| Zamknięcie poprzedniego roku | `/api/year-close/:id/*` | Zamknięcie roku | wg sekcji „Zamknięcie” |

Poza zakresem (osobne decyzje): akceptacja zaproszeń i konta w teście są seedowane (D-10); formularz poprawki bilansu otwarcia (`/opening-balance/adjustments`, #199) i zakładka promocji w `families/` (#78) nie istnieją jeszcze w panelach.

## Założenia

- Zasada czterech oczu przy zamknięciu (inna osoba niż rozpoczynająca) — założenie, nie przepis regulaminu (D-21).
- Rozpoczyna i zamyka zarząd; skarbnik tylko potwierdza punkty listy. Komisja Rewizyjna, dyrekcja i admin techniczny nie mają dostępu do czasu D-08/D-09 — z wyjątkiem odczytu archiwum zamkniętego roku przez admina (#195).
- Wygaszane są przydziały z `school_year_id` zamykanego roku oraz przydziały klas tego roku (#201). Przydziały bez zakresu roku (np. admin techniczny) nie wygasają automatycznie — obsługuje je zarządzanie rolami (`src/pg/routes/admin.js`, `POST /api/admin/grants/:id/revoke`, `docs/ACCOUNTS.md`; nie ma osobnej migracji dla samego zarządzania rolami).
- Następny rok musi zaczynać się później niż zamykany i nie może mieć rozpoczętego zamknięcia.
- Bilans liczony jest z księgi, nie z wpłat; wpłata wpływa na bilans dopiero przez wpis przychodu.

## Ryzyka

- Brak ścieżki „korekta po zamknięciu”: błąd wykryty później wymaga decyzji Rady.
- Lista kontrolna jest deklaratywna; aplikacja nie weryfikuje raportów ani uzgodnienia z bankiem.
- Blokada `SHARE` na tabelach księgi na czas zamknięcia wstrzymuje zapisy księgi wszystkich lat na kilka milisekund–sekund.
- Zamrożenie obejmuje publikację protokołów starego roku; jeśli Rada zechce publikować archiwalne protokoły po zamknięciu, potrzebna będzie osobna decyzja i zmiana.

## Decyzje do podjęcia

D-04 (czas przechowywania archiwum), D-08/D-09 (kto rozpoczyna, potwierdza i zamyka, dostęp Komisji Rewizyjnej i dyrekcji do zestawienia), D-13 (uzgodnienie rachunku przed zamknięciem), D-21 (regulamin: termin i tryb przekazania kadencji, zatwierdzenie sprawozdania).


## Punkt `financial_report` i migawka sprawozdania (#125, 0138)

`POST /api/year-close/{rok}/checklist/financial_report` przyjmuje opcjonalne `reportSnapshotId`: zatwierdzoną (`POST /api/reports/annual/snapshots/{id}/approve`), bieżącą (niezastąpioną) migawkę tego roku; inne, cudze i nieistniejące dają `400 invalid_report_snapshot`. Dla pozostałych punktów pole jest odrzucane. Bez migawki punkt nadal można potwierdzić jak dotąd (wariant zachowawczy do D-21). Identyfikator trafia do listy kontrolnej, zestawienia przekazania i audytu.
