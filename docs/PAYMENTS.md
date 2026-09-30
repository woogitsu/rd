# Dobrowolne wpłaty i korekty

Status (30.09.2026, #175): model w bazie (PostgreSQL: `postgres/migrations/0002_payments.sql` i kolejne; pierwotny model D1 — `migrations/0005_payment_corrections.sql` i `migrations/0006_payment_assignments.sql` — opisany niżej), API na PostgreSQL (`src/pg/routes/payments.js`, #37) i panel (`panel/`). Staging: nie wykonano; produkcja: nie (D-20). Prototyp na danych syntetycznych — **nie jest gotowy do pracy na danych rodzin** (D-01–D-06, D-11–D-14).

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

`GET /api/payments` wymaga roku szkolnego, aktywnej sesji, MFA oraz jednej z zatwierdzonych obecnie ról finansowych: `admin`, `board` albo `treasurer`. Wynik jest stronicowany, może być filtrowany do statusu `recorded` lub `unmatched` oraz (#128, w SQL, razem z zakresem roku i uprawnień) po `dateFrom`/`dateTo` (data wpłaty, włącznie), `method`, `householdId` (wpłata przypisana w całości albo z bieżącą częścią dla tego gospodarstwa; gospodarstwo spoza roku daje pustą listę) i `q` (fraza w tytule przelewu, najwyżej 100 znaków, `%`/`_`/`\` szukane dosłownie). Zły parametr daje `400` z kodem (`invalid_date`, `invalid_date_range`, `invalid_method`, `invalid_request`); zmiana któregokolwiek filtru przy tym samym kursorze daje `400 invalid_cursor`. Lista pokazuje kwotę pierwotną, sumę korekt oraz kwotę netto. Nie wylicza należności ani brakującej składki. Dostęp dla `audit` i `principal` pozostaje wyłączony do zatwierdzenia macierzy kompetencji przez szkołę.

`POST /api/payments/{id}/assignment` przypisuje wyłącznie wpłatę ze statusem `unmatched` do istniejącego gospodarstwa. Migracja `0006_payment_assignments.sql` wymaga wcześniejszego, niezmiennego zdarzenia przypisania i uniemożliwia późniejszą zmianę gospodarstwa. Operacja wymaga MFA, właściwej roli i roku, ochrony same-origin oraz klucza idempotencji. Zdarzenie i wpis `payment.assigned` powstają atomowo; dziennik nie kopiuje identyfikatora gospodarstwa.

## PostgreSQL (docelowy stos Railway, niewdrożony) — stan prototypu (issue #37)

`src/pg/routes/payments.js` przenosi cztery pierwotne trasy Workera (`GET /api/payments`, `POST /api/payments`, `POST /api/payments/{id}/corrections`, `POST /api/payments/{id}/assignment`) do routera PostgreSQL (`src/pg/app.js`); trasy dodane później (zwrot, ponowne przypisanie, podział, eksport CSV) opisują sekcje niżej. Kontrakt HTTP panelu pozostaje bez zmian: te same walidacje, kształty JSON, kody statusu i błędów, nagłówek `Idempotency-Replayed` oraz kursor stronicowania. Test `tests/pg-payments-api.test.js` wykonuje jeden scenariusz na starym Workerze/D1 i na PostgreSQL i porównuje odpowiedzi krok po kroku. Kursor `nextCursor` wiąże rok szkolny i filtr zapytania, które go wydało (#192): użycie go z innym `schoolYearId` lub innym filtrem (`status`) daje `400 invalid_cursor`, zamiast doklejać wiersze innego zapytania. Panel dociąga kolejne strony wyłącznie z zapamiętanego zapytania, a zmienione, niezatwierdzone pola filtra blokują „Wczytaj następne”.

- **Transakcje.** Zapis wpłaty, korekty lub przypisania oraz odpowiadające mu zdarzenie `audit_events` powstają w jednej transakcji (`insertAuditEvent`). Błąd zapisu audytu wycofuje całą operację.
- **Idempotencja.** Ten sam klucz i ta sama treść (oraz ta sama osoba) zwracają pierwotny wynik z kodem 200; ten sam klucz z inną treścią lub od innej osoby kończy się `409 idempotency_conflict`. Wyścig dwóch identycznych żądań (podwójne kliknięcie) kończy się jednym wierszem — drugie żądanie po naruszeniu unikalności odtwarza zapis.
- **Równoległe korekty.** Korekta blokuje wiersz wpłaty (`SELECT … FOR UPDATE`), sprawdza pozostałą kwotę i dopiero wtedy dopisuje rekord. Trigger z `0002_payments.sql` niezależnie odrzuca korektę przekraczającą kwotę wpłaty.
- **Jednokrotne przypisanie.** Przypisanie blokuje wiersz wpłaty; druga próba (także równoległa) kończy się `409 payment_already_assigned`. Status i gospodarstwo zmienia trigger po dodaniu niezmiennego zdarzenia `payment_assignments`.
- **Dostęp.** Każda trasa wymaga sesji, MFA i roli `admin`, `board` albo `treasurer` w zakresie roku wpłaty. `representative`, `audit` i `principal` dostają `403`. Zapisy wymagają zgodnego nagłówka `Origin`.
- **Data w roku szkolnym (#169).** `receivedOn` musi leżeć w `[starts_on, ends_on]` roku wpłaty (obie granice włącznie); inaczej `422 date_outside_school_year`, bez zapisu i bez zdarzenia audytu. Tę samą regułę egzekwuje trigger `b0_date_within_school_year` z `0027_entry_date_within_school_year.sql`, także przy bezpośrednim `INSERT`. Założenie zachowawcze do decyzji skarbnika/zarządu: brak okna „wpłat z wyprzedzeniem” przed 1 września — wpłata z sierpnia trafia do roku, w którym wpłynęła. Okno (np. N dni przed `starts_on`) można dodać osobną migracją po decyzji. Istniejące wpłaty spoza zakresu zostają bez zmian i są wykazywane w raporcie KR. `receivedOn` to sama data (`DATE`, bez godziny i strefy): granica 31.08/01.09 nie zależy od strefy procesu ani sesji bazy (Bruksela, UTC+14, UTC−7 — `tests/pg-school-year-dates.test.js`). Wpłata z pozycji wyciągu dostaje datę pozycji i podlega tej samej regule (docs/RECONCILIATION.md). Dlaczego 422, a nie 400 — docs/LEDGER.md.
- **Kwoty.** Agregaty `SUM` (BIGINT) są zamieniane na liczby tylko w zakresie bezpiecznych liczb całkowitych; poza nim żądanie kończy się błędem technicznym zamiast utraty precyzji.
- **Bez długu.** Odpowiedzi zawierają tylko kwotę pierwotną, sumę korekt i kwotę netto. Nie ma pól należności, salda ani statusu dłużnika; sugerowana składka nie jest znana systemowi (decyzja zarządu).

Schemat nie wymagał zmian — moduł korzysta z tabel, triggerów i widoków z `0002_payments.sql` i `0004_auth_access.sql`. Stary moduł `src/payments.js` pozostaje bez zmian do czasu testów równoważności na danych syntetycznych i próby odtworzenia.

Znane ograniczenie (tak samo jak w Workerze): ponowienie żądania utworzenia wpłaty nierozpoznanej po jej przypisaniu zwraca `409 idempotency_conflict`, bo zapis ma już status `recorded`. Panel generuje nowy klucz dla każdego formularza, więc dotyczy to tylko bardzo spóźnionego ponowienia.

## Zwrot i ponowne przypisanie (#138, migracja `0038`)

Zwrot pieniędzy rodzinie (np. podwójny przelew, pomyłka w kwocie) i błędne przypisanie do gospodarstwa mają teraz własny, niezmienny model — zamiast obejścia „korekta do zera + nowa wpłata”, które gubiło powiązanie z pierwotnym zapisem.

- **`POST /api/payments/{id}/refunds`** (`Idempotency-Key`; `amountCents`, `refundedOn`, `method`, `reason`) tworzy wiersz w `payment_refunds`. Zmniejsza netto wpłaty jak korekta, ale ma własną datę skutku i metodę. Suma korekt + zwrotów nie może przekroczyć pierwotnej kwoty (`409 refund_exceeds_remaining_amount`). Podwójny przelew tej samej rodziny zostaje jako dwie osobne, poprawne wpłaty — system nie zgaduje „duplikatu”; zwrot jest wyłącznie ręcznie zgłoszoną operacją skarbnika.
- **`POST /api/payments/{id}/reassignment`** (`Idempotency-Key`; `householdId`, `reason`) tworzy wiersz w `payment_reassignments` (stare i nowe gospodarstwo, powód, autor) i zmienia `household_id` wpłaty. Trigger `payment_entry_guard` dopuszcza zmianę gospodarstwa wpłaty już `recorded` wyłącznie razem z takim zdarzeniem. Historia zostaje: widok gospodarstwa (`household_payment_totals`) pokazuje wpłatę tylko przy bieżącym `household_id`, a poprzednie przypisania są widoczne w `payment_reassignments` i w dzienniku (`payment.reassigned`, bez identyfikatorów gospodarstw w metadanych). Ponowienie tego samego żądania (ten sam klucz, wpłata, gospodarstwo docelowe, powód i autor) zwraca zapisany wynik (`200`, `Idempotency-Replayed`) także po udanym przypisaniu — stare gospodarstwo jest wynikiem operacji, nie częścią porównania; inna treść, wpłata lub autor przy tym samym kluczu daje `409 idempotency_conflict`. Ten sam klucz użyty przy przypisaniu nierozpoznanej wpłaty (`/assignment`) dla innej wpłaty lub gospodarstwa również kończy się `409 idempotency_conflict`, nie `payment_already_assigned`.
- **Spójność z księgą.** Jeśli wpłata ma powiązany wpis księgi (`ledger_entries.payment_entry_id`), korekta lub zwrot są odrzucane (`409 ledger_correction_required`), dopóki skarbnik najpierw nie skoryguje wpisu księgi o tę samą kwotę (`POST /api/ledger/{id}/corrections`) — w tej samej sesji, przed korektą/zwrotem wpłaty. To wariant zachowawczy: system **nie** tworzy korekty księgi automatycznie. Ten sam trigger (`ledger_entry_insert_guard`) odrzuca też nowy wpis księgi, którego kwota nie odpowiada bieżącemu netto wpłaty (`422 payment_amount_mismatch`) — wpłata 25 EUR nie może zostać ujęta w księdze jako 250 EUR.
- **Uzgodnienie zwrotu (#138, migracja `0152`).** Zwrot można powiązać z ujemną pozycją wyciągu (`POST /api/reconciliations/{id}/matches` z `paymentRefundId`, szczegóły w docs/RECONCILIATION.md). Zwrot po powiązaniu wpłaty z dodatnią pozycją nie unieważnia tego powiązania.
- **Nieobjęte** (dalsza praca): panel (UI) do zgłaszania zwrotu, ponownego przypisania i dopasowania zwrotu — na razie tylko API.

To prototyp: router PostgreSQL działa tylko przy ustawionym `DATABASE_URL`, nie jest wdrożony na Railway i nie jest zatwierdzony do pracy na danych rodzin. Zasady korekt i uprawnienia do ich zatwierdzania nadal wymagają decyzji Rady.

## Podział wpłaty na kilka gospodarstw (#127, część 1, migracja `0104`)

Jeden przelew może dotyczyć kilku gospodarstw: przelew zbiorczy kilku rodzin, dziadkowie za kilkoro wnuków, rodzeństwo w **różnych** gospodarstwach (opieka dzielona, D-11). Taką wpłatę zapisuje się jako **nieprzypisaną** (`householdId: null`, status `unmatched`) i dzieli na części. W interfejsie to „podział wpłaty”, nie „rozliczenie należności”: składka jest dobrowolna, a system nie wylicza, ile gospodarstwo „powinno” wpłacić.

**Zakres `householdId` (#205).** `POST /api/payments` (z `householdId`), `/assignment`, `/reassignment` i `/allocations` przyjmują wyłącznie gospodarstwo niezarchiwizowane, z uczniem zapisanym w roku wpłaty (`enrollments`). Inne — także nieistniejące — daje ten sam `400 invalid_reference`, sprawdzany przed zapisem (odpowiedź nie ujawnia, czy gospodarstwo istnieje). **Założenie do D-11 (wariant zachowawczy):** odmowa zamiast ostrzeżenia z powodem; wpłatę na rodzinę bez ucznia w roku zapisuje się jako nieprzypisaną (`householdId: null`) i wyjaśnia ręcznie. Gospodarstwo zarchiwizowane po zapisie wpłaty nie zmienia wpłaty ani jej powtórzenia (ponowienie z tym samym kluczem zwraca istniejący zapis).

- **`POST /api/payments/{id}/allocations`** (`Idempotency-Key`; `{ householdId, amountCents }`) tworzy jedną niezmienną część (`payment_allocations`). Każde gospodarstwo to osobne żądanie z własnym kluczem. Ten sam klucz powtarza odpowiedź (`Idempotency-Replayed: true`). Zasady:
  - Suma bieżących części nie może przekroczyć netto wpłaty (kwota − korekty − zwroty). Inaczej dostajesz `409 payment_allocation_exceeds_net`. Trigger blokuje wiersz wpłaty, więc z dwóch równoległych części, które razem przekraczają kwotę, jedna zostanie odrzucona.
  - Jedno gospodarstwo może mieć najwyżej jedną bieżącą część danej wpłaty (`409 payment_allocation_household_exists`). To chroni przed podwójnym kliknięciem z nowym kluczem.
  - Wpłata już przypisana do jednego gospodarstwa: `409 payment_already_assigned`.
- **`POST /api/payments/{id}/allocations/{allocationId}/reversal`** (`Idempotency-Key`; `{ reason }`) cofa błędną część nowym zapisem z powodem (`payment_allocation_reversals`). Części nie da się zmienić ani usunąć: błąd poprawia się przez cofnięcie i nową część. Drugie cofnięcie tej samej części daje `409 payment_allocation_already_reversed`.
- **`GET /api/payments/{id}/allocations`** zwraca netto wpłaty, bieżące i cofnięte części, sumę przypisaną oraz `unallocatedCents`, czyli „nieprzypisaną część” do wyjaśnienia.
- **Korekta lub zwrot po podziale.** Jeśli netto spadłoby poniżej sumy bieżących części, operacja zostaje odrzucona (`409 payment_allocation_exceeds_net`). Najpierw cofnij część (albo cofnij i utwórz mniejszą), dopiero potem koryguj wpłatę.
- **Zwykłe przypisanie** (`POST /api/payments/{id}/assignment`) wpłaty z bieżącymi częściami jest odrzucane (`409 payment_has_allocations`).
- **Sumy gospodarstw.** `household_payment_totals` liczy wpłaty przypisane (tak jak dotąd) oraz bieżące części wpłat nieprzypisanych. Dzięki temu karta rodziny, kartki (tylko role finansowe z MFA) i wykluczenie z przypomnienia „brak wpisu wpłaty” widzą część danego gospodarstwa, i tylko ją. Dla danych bez części sumy są identyczne jak przed migracją.
- **Zamknięcie roku.** Podsumowanie wpłat ma dodatkowe pole `unmatchedAllocatedCents`, czyli część kwoty wpłat nieprzypisanych, która została już podzielona na gospodarstwa. Istniejące pola się nie zmieniają.
- **Uzgodnienie.** Podzielona wpłata zostaje jedną wpłatą o pełnej kwocie. Przelew zbiorczy (np. 75 EUR za trzy rodziny) można więc powiązać 1:1 z jedną pozycją wyciągu bez różnicy i bez `confirmationNote`.
- **Dziennik.** Zdarzenia `payment.allocation.created` i `payment.allocation.reversed` mają w metadanych `paymentEntryId` i `schoolYearId`, bez kwot i bez identyfikatorów gospodarstw (tak jak `payment.assigned`). Zapisują się w tej samej transakcji co zapis.
- **Dostęp.** Admin, zarząd i skarbnik z MFA w roku wpłaty. Przedstawiciel klasy, `audit` i `principal` dostają `403` na wszystkich trzech trasach.

**Nieobjęte częścią 1:**
- migracja istniejących wpłat `recorded` do `payment_allocations` w proporcji 1:1 (wariant zachowawczy: istniejące przypisania zostają bez zmian, a wpłata z jednym gospodarstwem dalej liczy się przez `household_id`);
- dopasowania wiele-do-jednego w uzgodnieniu — zrobione w części 2 (migracja `0105`, `bank_reconciliation_group_matches`; `docs/RECONCILIATION.md`, „Dopasowanie zbiorcze”);
- korekta wskazująca konkretną część;
- panel (UI);
- wpłata gotówki zebranej przez przedstawiciela (D-12, D-13);
- pokazanie części w raporcie KR (sumy raportu się nie zmieniają, bo liczy on wpłaty, nie gospodarstwa).

## Pozostałe trasy związane z wpłatami (opis w innych dokumentach)

Stan w kodzie 30.09.2026 (trasy w `tests/helpers/route-matrix.js`, role i odmowy w [AUTHORIZATION.md](AUTHORIZATION.md)):

- `GET /api/payments/export.csv?schoolYearId=` (#141) — eksport CSV wpisów wpłat i korekt, bez imion i nazwisk i bez statusu „dłużnik” (`src/pg/routes/payments.js`).
- `GET /api/payments/export.xlsx?schoolYearId=&from=&to=&method=` (#141) — te same wpisy i korekty w pliku XLSX (moduł `src/pg/xlsx.js`, bez formuł): arkusz „Wpisy” (jeden wiersz na wpis wpłaty: data jako data arkusza w zapisie dd.mm.rrrr, kwota, metoda, stan przypisania, numer rodziny tylko dla wpłaty przypisanej, suma korekt, suma zwrotów, netto) i arkusz „Korekty” (każda korekta osobnym wierszem z identyfikatorem wpisu, datą, kwotą, powodem i rolą aktora — nie e-mailem). Pierwszy wiersz obu arkuszy: „Składki są dobrowolne; brak wpisu nie oznacza braku wpłaty.” Suma kolumny `netto_eur` wierszy „przypisana” jest równa `totals.payments.recordedNetCents` z manifestu eksportu rocznego (wpłaty nieprzypisane są poza tą sumą). Role, MFA, filtry, limit 20 000 wierszy (`413 export_too_large`), zdarzenie `payment.exported` (`format: xlsx`, liczby wierszy, bez kwot) i wpis `payment_export` w dzienniku odczytu — jak w CSV. Komisja Rewizyjna i dyrekcja nie mają eksportu wpłat (D-09, wariant zachowawczy); imion i nazwisk uczniów w eksporcie nie ma (minimalizacja, poszerzenie wymaga D-03/D-09).
- `GET/POST /api/payment-references`, `POST /api/payment-references/{id}/revoke` (#83) — belgijska komunikacja strukturalna OGM-VCS na gospodarstwo i rok (`src/pg/routes/payment-references.js`, migracja `0085_payment_references.sql`).
- `GET/POST /api/payment-instructions` (#92) — zatwierdzone dane do wpłaty (IBAN, BIC, odbiorca) dla kodu QR EPC na kartkach (`src/pg/routes/payment-instructions.js`, migracja `0086_payment_instructions.sql`). Rachunek i kwota czekają na D-13 i D-14; bez zatwierdzonej wersji kartki są szkicem bez kodu QR. Kwota w kodzie QR jest zawsze pusta (składka dobrowolna; sugerowana kwota w QR dopiero po D-14). Stopka kartki pokazuje wersję (data zatwierdzenia i skrót identyfikatora), więc po korekcie rachunku stare wydruki są rozpoznawalne. Te same zatwierdzone dane trafiają do kampanii e-mail przez `{rachunek}`/`{odbiorca}` (tekst, bez kodu QR — HTML i obraz wymagają D-17; szczegóły w `docs/EMAIL.md`).
