# Dobrowolne wpłaty i korekty

Wpłata jest zdarzeniem finansowym, a nie informacją o zadłużeniu rodziny. System przechowuje wyłącznie faktycznie otrzymane kwoty w centach EUR. Nie wylicza należności, salda „do zapłaty” ani listy dłużników.

## Niezmienność zapisów

Migracja `0005_payment_corrections.sql` zabezpiecza kwotę, rok szkolny, datę otrzymania, metodę, referencję, autora, datę utworzenia i klucz idempotencji przed zmianą lub usunięciem. Przypisanie nierozpoznanej wpłaty do gospodarstwa oraz zmiana statusu `unmatched` na `recorded` pozostają możliwe, ale API musi zapisać te operacje w `audit_events`.

Każda nowa wpłata wymaga unikalnego klucza idempotencji o długości 8–128 znaków. Powtórzenie tego samego żądania nie może utworzyć kolejnego zapisu.

## Korekty

Korekty są osobnymi, niezmiennymi rekordami w `payment_corrections`. Zawierają dodatnią kwotę zmniejszenia, powód, autora i własny klucz idempotencji. Suma korekt nie może przekroczyć pierwotnej kwoty. Nie należy ustawiać statusu `reversed` dla nowych operacji; status pozostaje wyłącznie dla zgodności ze starszymi danymi.

Widok `household_payment_totals` sumuje zarejestrowane wpłaty pomniejszone o korekty dla gospodarstwa i roku szkolnego. Pomija wpłaty nierozpoznane i starsze wpisy ze statusem `reversed`. Widok nie porównuje sumy z sugerowaną składką.

Przed udostępnieniem funkcji produkcyjnej trzeba uzgodnić z Radą zasady korekt oraz uprawnienia do ich zatwierdzania. API i interfejs powstaną w osobnym zakresie po wdrożeniu autoryzacji serwerowej.

## API zapisu

`POST /api/payments` tworzy wpłatę, a `POST /api/payments/{id}/corrections` tworzy korektę. Obie trasy wymagają aktywnej sesji, potwierdzonego MFA, roli `admin`, `board` albo `treasurer`, zgodnego roku szkolnego, nagłówka `Idempotency-Key` i żądania z tej samej domeny. Identyczne ponowienie zwraca istniejący rekord; ponowne użycie klucza z inną treścią kończy się konfliktem.

Wpłata i odpowiadający jej wpis `payment.created` są zapisywane atomowo. Tak samo korekta oraz `payment.correction.created`. Dziennik nie kopiuje kwoty, referencji bankowej ani danych rodziny.

## Odczyt i przypisanie

`GET /api/payments` wymaga roku szkolnego, aktywnej sesji, MFA oraz jednej z zatwierdzonych obecnie ról finansowych: `admin`, `board` albo `treasurer`. Wynik jest stronicowany, może być filtrowany do statusu `recorded` lub `unmatched` i pokazuje kwotę pierwotną, sumę korekt oraz kwotę netto. Nie wylicza należności ani brakującej składki. Dostęp dla `audit` i `principal` pozostaje wyłączony do zatwierdzenia macierzy kompetencji przez szkołę.

`POST /api/payments/{id}/assignment` przypisuje wyłącznie wpłatę ze statusem `unmatched` do istniejącego gospodarstwa. Migracja `0006_payment_assignments.sql` wymaga wcześniejszego, niezmiennego zdarzenia przypisania i uniemożliwia późniejszą zmianę gospodarstwa. Operacja wymaga MFA, właściwej roli i roku, ochrony same-origin oraz klucza idempotencji. Zdarzenie i wpis `payment.assigned` powstają atomowo; dziennik nie kopiuje identyfikatora gospodarstwa.

## PostgreSQL (Railway) — stan prototypu (issue #37)

`src/pg/routes/payments.js` przenosi te same cztery trasy (`GET /api/payments`, `POST /api/payments`, `POST /api/payments/{id}/corrections`, `POST /api/payments/{id}/assignment`) do routera PostgreSQL (`src/pg/app.js`). Kontrakt HTTP panelu pozostaje bez zmian: te same walidacje, kształty JSON, kody statusu i błędów, nagłówek `Idempotency-Replayed` oraz kursor stronicowania. Test `tests/pg-payments-api.test.js` wykonuje jeden scenariusz na starym Workerze/D1 i na PostgreSQL i porównuje odpowiedzi krok po kroku.

- **Transakcje.** Zapis wpłaty, korekty lub przypisania oraz odpowiadające mu zdarzenie `audit_events` powstają w jednej transakcji (`insertAuditEvent`). Błąd zapisu audytu wycofuje całą operację.
- **Idempotencja.** Ten sam klucz i ta sama treść (oraz ta sama osoba) zwracają pierwotny wynik z kodem 200; ten sam klucz z inną treścią lub od innej osoby kończy się `409 idempotency_conflict`. Wyścig dwóch identycznych żądań (podwójne kliknięcie) kończy się jednym wierszem — drugie żądanie po naruszeniu unikalności odtwarza zapis.
- **Równoległe korekty.** Korekta blokuje wiersz wpłaty (`SELECT … FOR UPDATE`), sprawdza pozostałą kwotę i dopiero wtedy dopisuje rekord. Trigger z `0002_payments.sql` niezależnie odrzuca korektę przekraczającą kwotę wpłaty.
- **Jednokrotne przypisanie.** Przypisanie blokuje wiersz wpłaty; druga próba (także równoległa) kończy się `409 payment_already_assigned`. Status i gospodarstwo zmienia trigger po dodaniu niezmiennego zdarzenia `payment_assignments`.
- **Dostęp.** Każda trasa wymaga sesji, MFA i roli `admin`, `board` albo `treasurer` w zakresie roku wpłaty. `representative`, `audit` i `principal` dostają `403`. Zapisy wymagają zgodnego nagłówka `Origin`.
- **Kwoty.** Agregaty `SUM` (BIGINT) są zamieniane na liczby tylko w zakresie bezpiecznych liczb całkowitych; poza nim żądanie kończy się błędem technicznym zamiast utraty precyzji.
- **Bez długu.** Odpowiedzi zawierają tylko kwotę pierwotną, sumę korekt i kwotę netto. Nie ma pól należności, salda ani statusu dłużnika; sugerowana składka nie jest znana systemowi (decyzja zarządu).

Schemat nie wymagał zmian — moduł korzysta z tabel, triggerów i widoków z `0002_payments.sql` i `0004_auth_access.sql`. Stary moduł `src/payments.js` pozostaje bez zmian do czasu testów równoważności na danych syntetycznych i próby odtworzenia.

Znane ograniczenie (tak samo jak w Workerze): ponowienie żądania utworzenia wpłaty nierozpoznanej po jej przypisaniu zwraca `409 idempotency_conflict`, bo zapis ma już status `recorded`. Panel generuje nowy klucz dla każdego formularza, więc dotyczy to tylko bardzo spóźnionego ponowienia.

To prototyp: router PostgreSQL działa tylko przy ustawionym `DATABASE_URL`, nie jest wdrożony na Railway i nie jest zatwierdzony do pracy na danych rodzin. Zasady korekt i uprawnienia do ich zatwierdzania nadal wymagają decyzji Rady.
