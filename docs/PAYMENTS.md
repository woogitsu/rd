# Dobrowolne wpłaty i korekty

Wpłata jest zdarzeniem finansowym, a nie informacją o zadłużeniu rodziny. System przechowuje wyłącznie faktycznie otrzymane kwoty w centach EUR. Nie wylicza należności, salda „do zapłaty” ani listy dłużników.

## Niezmienność zapisów

Migracja `0005_payment_corrections.sql` zabezpiecza kwotę, rok szkolny, datę otrzymania, metodę, referencję, autora, datę utworzenia i klucz idempotencji przed zmianą lub usunięciem. Przypisanie nierozpoznanej wpłaty do gospodarstwa oraz zmiana statusu `unmatched` na `recorded` pozostają możliwe, ale API musi zapisać te operacje w `audit_events`.

Każda nowa wpłata wymaga unikalnego klucza idempotencji o długości 8–128 znaków. Powtórzenie tego samego żądania nie może utworzyć kolejnego zapisu.

## Korekty

Korekty są osobnymi, niezmiennymi rekordami w `payment_corrections`. Zawierają dodatnią kwotę zmniejszenia, powód, autora i własny klucz idempotencji. Suma korekt nie może przekroczyć pierwotnej kwoty. Nie należy ustawiać statusu `reversed` dla nowych operacji; status pozostaje wyłącznie dla zgodności ze starszymi danymi.

Widok `household_payment_totals` sumuje zarejestrowane wpłaty pomniejszone o korekty dla gospodarstwa i roku szkolnego. Pomija wpłaty nierozpoznane i starsze wpisy ze statusem `reversed`. Widok nie porównuje sumy z sugerowaną składką.

Przed udostępnieniem funkcji produkcyjnej trzeba uzgodnić z Radą zasady korekt oraz uprawnienia do ich zatwierdzania. API i interfejs powstaną w osobnym zakresie po wdrożeniu autoryzacji serwerowej.
