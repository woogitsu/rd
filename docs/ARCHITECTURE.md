# Architektura wstępna

Frontend (publiczny i chroniony) → Worker/API → D1. Prywatne pliki → R2 za autoryzowanym API. Zadania pocztowe → kolejka i Brevo API; zdarzenia dostarczenia → podpisany webhook → historia. Granica publiczna nigdy nie wykonuje zapytań do list rodzin.

## Główne encje
- users, role_grants (zakres klasy, rok, data końca), sessions
- households, guardians, students, student_guardians, class_enrollments\n\nRelacja `student_guardians` przechowuje opiekunów konkretnego dziecka niezależnie od gospodarstwa; `household_id` ucznia pozostaje głównym przypisaniem organizacyjnym do czasu zatwierdzenia zasad składek.
- contributions, payment_entries, payment_allocations, payment_corrections
- ledger_entries, accounts, budgets, expense_approvals, document_objects
- events, meetings, attendance, resolutions
- email_templates, campaigns, campaign_recipients, delivery_events
- audit_events (aktor, typ, encja, identyfikator, poprzedni/nowy stan w dozwolonym zakresie)

Kwoty przechowywać w centach EUR jako liczby całkowite. Każdy zapis pieniężny ma rok, datę operacji, metodę, źródło, autora i stan uzgodnienia. Korekta nie usuwa zdarzenia pierwotnego.

## Zasady techniczne
- Parametryzowane zapytania, indeksy po klasie/roku i rodzinie, transakcje przy wpłatach i księdze.
- Autoryzacja na poziomie każdego zapytania: ograniczenie do klas użytkownika, także przy eksporcie, plikach i webhookach.
- Idempotentne operacje dla wpłat i kampanii; unikalne identyfikatory zewnętrznych operacji.
- Dokumenty niewidoczne publicznie, nazwy bez danych osobowych, walidacja typu i rozmiaru, skan bezpieczeństwa jeśli dostępny.
- Kopie zapasowe i okresowa próba przywrócenia; udokumentowana retencja i usuwanie.
- Sekrety tylko w menedżerze środowiska. Osobne test i produkcja. Sztuczne dane w testach.
- API wiadomości nie przyjmuje dowolnej listy e-mail z przeglądarki: odbiorcy są ponownie wyliczani i sprawdzani na serwerze.

Decyzje o dostawcy hostingu, lokalizacji danych i okresie retencji zapisać po rozmowie z dyrekcją i IOD.
