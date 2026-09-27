# Model rodzin i opiekunów

Migracja 0003 oddziela relację dziecko–opiekun od przynależności do jednego gospodarstwa. Dzięki tabeli student_guardians:

- dziecko może mieć kilku opiekunów;
- jeden opiekun może być powiązany z kilkorgiem dzieci;
- opiekun z innego gospodarstwa może być powiązany z dzieckiem;
- zgoda na kontakt i kontakt główny są zapisane dla konkretnej relacji;
- relacja może mieć datę początku i końca.

Pole household_id przy uczniu pozostaje na razie głównym przypisaniem organizacyjnym. Nie wolno na jego podstawie automatycznie ustalać obowiązku, wysokości ani adresata dobrowolnej składki. Zasady wpłat dla opieki dzielonej wymagają decyzji Rady i szkoły.

Migracja zachowuje stare dane deweloperskie, tworząc relacje pomiędzy uczniami i opiekunami z tego samego gospodarstwa. Przed migracją jakichkolwiek danych produkcyjnych taki podgląd musi zostać ręcznie sprawdzony — wspólny household_id nie dowodzi uprawnienia do kontaktu w sprawie każdego dziecka.

## Klasa i rok szkolny

Migracja 0004 dopisuje rok szkolny bezpośrednio do przypisania klasy. Istniejące wpisy otrzymują rok wynikający z klasy. Unikalny indeks pozwala uczniowi mieć tylko jedną klasę w danym roku, ale zachowuje osobne wpisy historyczne w kolejnych latach. Wyzwalacze odrzucają brak roku i sytuację, w której wskazana klasa należy do innego roku.

Jeżeli przed migracją istnieją dwa przypisania jednego ucznia do klas tego samego roku, utworzenie indeksu celowo się nie powiedzie. Takiego konfliktu nie wolno rozstrzygać automatycznie — trzeba go pokazać w raporcie i poprawić przed migracją.

## Identyfikatory źródłowe i import (PostgreSQL, #36)

Migracja PostgreSQL `0005_import.sql` dodaje `source_ref` przy uczniu i rodzinie. Import dopasowuje istniejące rekordy wyłącznie po tych identyfikatorach — nigdy po samym nazwisku lub e-mailu. Opiekun jest rozpoznawany tylko w obrębie już ustalonej rodziny. Zmiana klasy w tym samym roku, zmiana rodziny lub rozbieżne imię/nazwisko przy tym samym ID ucznia są zgłaszane jako konflikt do ręcznej decyzji, a nie nadpisywane. Import tworzy powiązania uczeń–opiekun z `contact_allowed = false`. Szczegóły: [import/README.md](../import/README.md).
