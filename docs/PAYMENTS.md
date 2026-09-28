# Dobrowolne wpłaty i korekty

Wpłata jest zdarzeniem finansowym, a nie informacją o zadłużeniu rodziny. System przechowuje wyłącznie faktycznie otrzymane kwoty w centach EUR. Nie wylicza należności, salda „do zapłaty” ani listy dłużników.

## Niezmienność zapisów

Migracja `0005_payment_corrections.sql` zabezpiecza kwotę, rok szkolny, datę otrzymania, metodę, referencję, autora, datę utworzenia i klucz idempotencji przed zmianą lub usunięciem. Przypisanie nierozpoznanej wpłaty do gospodarstwa oraz zmiana statusu `unmatched` na `recorded` pozostają możliwe, ale API musi zapisać te operacje w `audit_events`.

Każda nowa wpłata wymaga unikalnego klucza idempotencji o długości 8–128 znaków. Powtórzenie tego samego żądania nie może utworzyć kolejnego zapisu.

## Korekty

Korekty są osobnymi, niezmiennymi rekordami w `payment_corrections`. Zawierają dodatnią kwotę zmniejszenia, powód, autora i własny klucz idempotencji. Suma korekt nie może przekroczyć pierwotnej kwoty. Nie należy ustawiać statusu `reversed` dla nowych operacji; status pozostaje wyłącznie dla zgodności ze starszymi danymi.

Widok `household_payment_totals` sumuje zarejestrowane wpłaty pomniejszone o korekty dla gospodarstwa i roku szkolnego. Pomija wpłaty nierozpoznane i starsze wpisy ze statusem `reversed`. Widok nie porównuje sumy z sugerowaną składką.

Przed udostępnieniem funkcji produkcyjnej trzeba uzgodnić z Radą zasady korekt oraz uprawnienia do ich zatwierdzania. API (`src/pg/routes/payments.js`, sekcja niżej) i interfejs (`panel/`) już istnieją jako prototyp na danych syntetycznych — status: API na PostgreSQL, panel; nie wdrożone na Railway ani zatwierdzone do pracy na danych rodzin.

## API zapisu

`POST /api/payments` tworzy wpłatę, a `POST /api/payments/{id}/corrections` tworzy korektę. Obie trasy wymagają aktywnej sesji, potwierdzonego MFA, roli `admin`, `board` albo `treasurer`, zgodnego roku szkolnego, nagłówka `Idempotency-Key` i żądania z tej samej domeny. Identyczne ponowienie zwraca istniejący rekord; ponowne użycie klucza z inną treścią kończy się konfliktem.

Wpłata i odpowiadający jej wpis `payment.created` są zapisywane atomowo. Tak samo korekta oraz `payment.correction.created`. Dziennik nie kopiuje kwoty, referencji bankowej ani danych rodziny.

## Odczyt i przypisanie

`GET /api/payments` wymaga roku szkolnego, aktywnej sesji, MFA oraz jednej z zatwierdzonych obecnie ról finansowych: `admin`, `board` albo `treasurer`. Wynik jest stronicowany, może być filtrowany do statusu `recorded` lub `unmatched` i pokazuje kwotę pierwotną, sumę korekt oraz kwotę netto. Nie wylicza należności ani brakującej składki. Dostęp dla `audit` i `principal` pozostaje wyłączony do zatwierdzenia macierzy kompetencji przez szkołę.

`POST /api/payments/{id}/assignment` przypisuje wyłącznie wpłatę ze statusem `unmatched` do istniejącego gospodarstwa. Migracja `0006_payment_assignments.sql` wymaga wcześniejszego, niezmiennego zdarzenia przypisania i uniemożliwia późniejszą zmianę gospodarstwa. Operacja wymaga MFA, właściwej roli i roku, ochrony same-origin oraz klucza idempotencji. Zdarzenie i wpis `payment.assigned` powstają atomowo; dziennik nie kopiuje identyfikatora gospodarstwa.

## PostgreSQL (Railway) — stan prototypu (issue #37)

`src/pg/routes/payments.js` przenosi te same cztery trasy (`GET /api/payments`, `POST /api/payments`, `POST /api/payments/{id}/corrections`, `POST /api/payments/{id}/assignment`) do routera PostgreSQL (`src/pg/app.js`). Kontrakt HTTP panelu pozostaje bez zmian: te same walidacje, kształty JSON, kody statusu i błędów, nagłówek `Idempotency-Replayed` oraz kursor stronicowania. Test `tests/pg-payments-api.test.js` wykonuje jeden scenariusz na starym Workerze/D1 i na PostgreSQL i porównuje odpowiedzi krok po kroku. Kursor `nextCursor` wiąże rok szkolny i filtr zapytania, które go wydało (#192): użycie go z innym `schoolYearId` lub innym filtrem (`status`) daje `400 invalid_cursor`, zamiast doklejać wiersze innego zapytania. Panel dociąga kolejne strony wyłącznie z zapamiętanego zapytania, a zmienione, niezatwierdzone pola filtra blokują „Wczytaj następne”.

- **Transakcje.** Zapis wpłaty, korekty lub przypisania oraz odpowiadające mu zdarzenie `audit_events` powstają w jednej transakcji (`insertAuditEvent`). Błąd zapisu audytu wycofuje całą operację.
- **Idempotencja.** Ten sam klucz i ta sama treść (oraz ta sama osoba) zwracają pierwotny wynik z kodem 200; ten sam klucz z inną treścią lub od innej osoby kończy się `409 idempotency_conflict`. Wyścig dwóch identycznych żądań (podwójne kliknięcie) kończy się jednym wierszem — drugie żądanie po naruszeniu unikalności odtwarza zapis.
- **Równoległe korekty.** Korekta blokuje wiersz wpłaty (`SELECT … FOR UPDATE`), sprawdza pozostałą kwotę i dopiero wtedy dopisuje rekord. Trigger z `0002_payments.sql` niezależnie odrzuca korektę przekraczającą kwotę wpłaty.
- **Jednokrotne przypisanie.** Przypisanie blokuje wiersz wpłaty; druga próba (także równoległa) kończy się `409 payment_already_assigned`. Status i gospodarstwo zmienia trigger po dodaniu niezmiennego zdarzenia `payment_assignments`.
- **Dostęp.** Każda trasa wymaga sesji, MFA i roli `admin`, `board` albo `treasurer` w zakresie roku wpłaty. `representative`, `audit` i `principal` dostają `403`. Zapisy wymagają zgodnego nagłówka `Origin`.
- **Data w roku szkolnym (#169).** `receivedOn` musi leżeć w `[starts_on, ends_on]` roku wpłaty (obie granice włącznie); inaczej `422 date_outside_school_year`, bez zapisu i bez zdarzenia audytu. Tę samą regułę egzekwuje trigger `b0_date_within_school_year` z `0027_entry_date_within_school_year.sql`, także przy bezpośrednim `INSERT`. Założenie zachowawcze do decyzji skarbnika/zarządu: brak okna „wpłat z wyprzedzeniem” przed 1 września — wpłata z sierpnia trafia do roku, w którym wpłynęła. Okno (np. N dni przed `starts_on`) można dodać osobną migracją po decyzji. Istniejące wpłaty spoza zakresu zostają bez zmian i są wykazywane w raporcie KR.
- **Kwoty.** Agregaty `SUM` (BIGINT) są zamieniane na liczby tylko w zakresie bezpiecznych liczb całkowitych; poza nim żądanie kończy się błędem technicznym zamiast utraty precyzji.
- **Bez długu.** Odpowiedzi zawierają tylko kwotę pierwotną, sumę korekt i kwotę netto. Nie ma pól należności, salda ani statusu dłużnika; sugerowana składka nie jest znana systemowi (decyzja zarządu).

Schemat nie wymagał zmian — moduł korzysta z tabel, triggerów i widoków z `0002_payments.sql` i `0004_auth_access.sql`. Stary moduł `src/payments.js` pozostaje bez zmian do czasu testów równoważności na danych syntetycznych i próby odtworzenia.

Znane ograniczenie (tak samo jak w Workerze): ponowienie żądania utworzenia wpłaty nierozpoznanej po jej przypisaniu zwraca `409 idempotency_conflict`, bo zapis ma już status `recorded`. Panel generuje nowy klucz dla każdego formularza, więc dotyczy to tylko bardzo spóźnionego ponowienia.

## Zwrot i ponowne przypisanie (#138, migracja `0038`)

Zwrot pieniędzy rodzinie (np. podwójny przelew, pomyłka w kwocie) i błędne przypisanie do gospodarstwa mają teraz własny, niezmienny model — zamiast obejścia „korekta do zera + nowa wpłata”, które gubiło powiązanie z pierwotnym zapisem.

- **`POST /api/payments/{id}/refunds`** (`Idempotency-Key`; `amountCents`, `refundedOn`, `method`, `reason`) tworzy wiersz w `payment_refunds`. Zmniejsza netto wpłaty jak korekta, ale ma własną datę skutku i metodę. Suma korekt + zwrotów nie może przekroczyć pierwotnej kwoty (`409 refund_exceeds_remaining_amount`). Podwójny przelew tej samej rodziny zostaje jako dwie osobne, poprawne wpłaty — system nie zgaduje „duplikatu”; zwrot jest wyłącznie ręcznie zgłoszoną operacją skarbnika.
- **`POST /api/payments/{id}/reassignment`** (`Idempotency-Key`; `householdId`, `reason`) tworzy wiersz w `payment_reassignments` (stare i nowe gospodarstwo, powód, autor) i zmienia `household_id` wpłaty. Trigger `payment_entry_guard` dopuszcza zmianę gospodarstwa wpłaty już `recorded` wyłącznie razem z takim zdarzeniem. Historia zostaje: widok gospodarstwa (`household_payment_totals`) pokazuje wpłatę tylko przy bieżącym `household_id`, a poprzednie przypisania są widoczne w `payment_reassignments` i w dzienniku (`payment.reassigned`, bez identyfikatorów gospodarstw w metadanych).
- **Spójność z księgą.** Jeśli wpłata ma powiązany wpis księgi (`ledger_entries.payment_entry_id`), korekta lub zwrot są odrzucane (`409 ledger_correction_required`), dopóki skarbnik najpierw nie skoryguje wpisu księgi o tę samą kwotę (`POST /api/ledger/{id}/corrections`) — w tej samej sesji, przed korektą/zwrotem wpłaty. To wariant zachowawczy: system **nie** tworzy korekty księgi automatycznie. Ten sam trigger (`ledger_entry_insert_guard`) odrzuca też nowy wpis księgi, którego kwota nie odpowiada bieżącemu netto wpłaty (`422 payment_amount_mismatch`) — wpłata 25 EUR nie może zostać ujęta w księdze jako 250 EUR.
- **Nieobjęte tym PR** (dalsza praca, opisana w PR #138): dopasowanie zwrotu do ujemnej pozycji wyciągu w uzgodnieniu (`bank_reconciliation_matches.payment_refund_id`); panel (UI) do zgłaszania zwrotu i ponownego przypisania — na razie tylko API.

To prototyp: router PostgreSQL działa tylko przy ustawionym `DATABASE_URL`, nie jest wdrożony na Railway i nie jest zatwierdzony do pracy na danych rodzin. Zasady korekt i uprawnienia do ich zatwierdzania nadal wymagają decyzji Rady.
