# Architektura docelowa

Frontend (publiczny i chroniony) → serwer Node.js na Railway → prywatny PostgreSQL. Prywatne pliki → Railway Storage Bucket za autoryzowanym API. Zadania pocztowe → kolejka PostgreSQL, Railway cron/worker i Brevo API; zdarzenia dostarczenia → weryfikowany webhook → historia. Granica publiczna nigdy nie wykonuje zapytań do list rodzin.

To stan docelowy, nie opis gotowego wdrożenia. Serwer Node.js i większość API (`src/pg/app.js`, 29 modułów tras) działają dziś wyłącznie na PostgreSQL; oryginalny Worker/D1 (`src/index.js`) ma tylko 5 tras (sesja, przydziały, wpłaty, księga, wylogowanie) i pozostaje jako kontrakt równoważności ([docs/EQUIVALENCE.md](EQUIVALENCE.md)) na czas [migracji](RAILWAY_MIGRATION.md), nie jako produkcyjna ścieżka.

## Główne encje

Nazwy niżej to rzeczywiste tabele z `postgres/migrations/` (nie projekt — poprzednia wersja tej listy wymieniała tabele, których w schemacie nie ma, np. „contributions”, „payment_allocations”, „accounts”, „budgets”, „expense_approvals”, „document_objects”, „email_templates”, „campaigns”, „campaign_recipients”, „delivery_events”, „attendance”, „class_enrollments”):

- `users`, `role_grants` (zakres klasy, rok, data końca), `sessions`, `invitations`
- `households`/`student_households`/`guardian_households`, `guardians`, `students`, `student_guardians` (bieżący stan) i `student_guardian_changes` (historia), `enrollments` i `enrollment_history`. Relacja `student_guardians` przechowuje opiekunów konkretnego dziecka niezależnie od gospodarstwa; `household_id` ucznia pozostaje głównym przypisaniem organizacyjnym do czasu zatwierdzenia zasad składek.
- `payment_entries`, `payment_assignments`, `payment_corrections`, `payment_refunds`, `payment_reassignments`
- `ledger_entries`, `ledger_corrections`, `ledger_categories`, `ledger_budget_lines`, `ledger_opening_balances`, `ledger_opening_balance_adjustments`, `ledger_transfers`
- `documents`, `document_uploads`
- `events`, `event_revisions`, `meetings`, `meeting_agenda_items`, `meeting_attendees`, `meeting_minutes`, `meeting_quorum_checks`, `resolutions`
- `email_campaigns`, `email_campaign_recipients`, `email_campaign_exclusions`, `email_outbox`, `email_send_ledger`, `email_webhook_events`
- `audit_events` (aktor, typ, encja, identyfikator, poprzedni/nowy stan w dozwolonym zakresie)

Kwoty przechowywać w centach EUR jako liczby całkowite. Każdy zapis pieniężny ma rok, datę operacji, metodę, źródło, autora i stan uzgodnienia. Korekta nie usuwa zdarzenia pierwotnego.

## Zasady techniczne
- Parametryzowane zapytania, indeksy po klasie/roku i rodzinie, transakcje przy wpłatach i księdze.
- Autoryzacja na poziomie każdego zapytania: ograniczenie do klas użytkownika, także przy eksporcie, plikach i webhookach.
- Idempotentne operacje dla wpłat i kampanii; unikalne identyfikatory zewnętrznych operacji.
- Dokumenty niewidoczne publicznie, nazwy bez danych osobowych, walidacja typu i rozmiaru, skan bezpieczeństwa jeśli dostępny.
- Kopie zapasowe i okresowa próba przywrócenia; udokumentowana retencja i usuwanie.
- Sekrety tylko w menedżerze środowiska. Osobne test i produkcja. Sztuczne dane w testach.
- API wiadomości nie przyjmuje dowolnej listy e-mail z przeglądarki: odbiorcy są ponownie wyliczani i sprawdzani na serwerze.

Użytkownik wybrał Railway jako docelowy hosting. Lokalizację usług planujemy w UE; zakres przetwarzania, umowy dostawców i retencję musi zatwierdzić szkoła oraz IOD przed produkcją.
