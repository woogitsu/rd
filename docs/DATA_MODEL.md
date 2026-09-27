# Model rodzin i opiekunów

Migracja 0003 oddziela relację dziecko–opiekun od przynależności do jednego gospodarstwa. Dzięki tabeli student_guardians:

- dziecko może mieć kilku opiekunów;
- jeden opiekun może być powiązany z kilkorgiem dzieci;
- opiekun z innego gospodarstwa może być powiązany z dzieckiem;
- zgoda na kontakt i kontakt główny są zapisane dla konkretnej relacji;
- relacja może mieć datę początku i końca.

Pole household_id przy uczniu pozostaje na razie głównym przypisaniem organizacyjnym. Nie wolno na jego podstawie automatycznie ustalać obowiązku, wysokości ani adresata dobrowolnej składki. Zasady wpłat dla opieki dzielonej wymagają decyzji Rady i szkoły.

Migracja zachowuje stare dane deweloperskie, tworząc relacje pomiędzy uczniami i opiekunami z tego samego gospodarstwa. Przed migracją jakichkolwiek danych produkcyjnych taki podgląd musi zostać ręcznie sprawdzony — wspólny household_id nie dowodzi uprawnienia do kontaktu w sprawie każdego dziecka.
