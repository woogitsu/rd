# PostgreSQL na Railway — etap przygotowawczy

`0001_core.sql` tworzy nowy schemat dla lat i klas, rodzin, uczniów i opiekunów,
kont użytkowników, zakresów ról, zaproszeń, sesji, metadanych dokumentów,
wydarzeń i audytu. `0002_payments.sql` dodaje fakty dobrowolnych wpłat,
niezmienne korekty i jednokrotne przypisanie wpłaty nierozpoznanej. Blokada
wiersza wpłaty serializuje korekty; samo dodanie zdarzenia przypisania
atomowo zmienia status wpłaty. Widok sumuje tylko zarejestrowane wpłaty
pomniejszone o korekty, bez wyliczania długu. Agregaty PostgreSQL typu BIGINT
mogą wracać z `pg` jako tekst; API musi je bezpiecznie przeliczyć przed
wysłaniem JSON. `0003_ledger.sql` dodaje kategorie, niezmienne wpisy księgi
i korekty, bilans otwarcia z osobnymi korektami oraz wersjonowany preliminarz.
Widoki wyliczają kwoty netto, aktualną wersję preliminarza i bilans roku.
Powiązana wpłata może zasilić tylko jeden wpis przychodowy w tym samym roku.
Wydatek powyżej 3000 EUR wymaga referencji uchwały; dokładny proces
zatwierdzania wymaga nadal decyzji Rady. Tabele przypomnień powstaną w
kolejnych etapach.

`0004_auth_access.sql` (issue #35) dodaje tylko kolumny z wartością `NULL` lub
domyślną oraz ograniczenia; istniejące wiersze nie są przepisywane ani usuwane.
`role_grants` dostaje `granted_by`, `granted_at` (dla istniejących wierszy
czas wykonania migracji), `revoked_at`, `revoked_by` i `source_invitation_id`
(unikalne — jedno zaproszenie daje najwyżej jeden przydział). Trigger blokuje
usunięcie przydziału, zmianę jego zakresu i przywrócenie cofniętego.
`invitations` dostaje `accepted_by` i `revoked_by`; zaproszenie przyjęte lub
wycofane jest ostateczne i nie da się go usunąć. `sessions` dostaje
`revoked_reason` i `rotated_from`. `audit_events` staje się tabelą tylko do
dopisywania (UPDATE i DELETE zwracają błąd) — korekta to nowe zdarzenie.
Przywracanie snapshotu D1 (same INSERT-y) działa bez zmian. Wycofanie
migracji wymaga osobnego skryptu i przeglądu; nie cofać jej na bazie z danymi.

`0008_events.sql` rozszerza istniejącą tabelę `events` o miejsce,
organizatora, koniec wydarzenia, stałą strefę `Europe/Brussels`, opcjonalną
klasę (z tego samego roku), odbiorców (`internal`/`public`), status
(`draft`/`submitted`/`approved`/`published`/`cancelled`), dane zgłoszenia,
zatwierdzenia, publikacji i odwołania oraz klucz idempotencji. Nowa tabela
`event_revisions` przechowuje każdą wersję treści; trigger dopisuje wersję
przy każdej zmianie treści i cofa status do `draft`, a wersji nie można
zmienić ani usunąć. Wydarzeń nie można usuwać; odwołanie wymaga powodu i jest
stanem końcowym. Trigger pilnuje kolejności przejść i zasady czterech oczu
(zatwierdzający ≠ autor wydarzenia i ≠ autor zatwierdzanej wersji). Widok
`public_events` pokazuje wyłącznie opublikowaną wersję, bez autorów i bez
powodu odwołania. Skutki dla danych: istniejące wiersze dostają wersję 1;
wiersze z `visibility='published'` (także odtwarzane ze snapshotu D1) stają
się opublikowane bez zapisu zatwierdzenia (`source='legacy_d1'`), pozostałe
stają się szkicami. Kolumna `visibility` jest odtąd wyliczana przez trigger.
Opis:
[`docs/EVENTS.md`](../docs/EVENTS.md).

To **nie** jest migracja istniejących rekordów D1 i nie oznacza gotowości
produkcyjnej. Stary Worker nie korzysta z nowych tabel. Przeniesienie zapisu
audytu do transakcji nowego API jest osobnym zakresem.

Kontrolowany eksport, snapshot, transakcyjny import do pustej bazy i rollback
opisuje [`docs/D1_POSTGRES_MIGRATION.md`](../docs/D1_POSTGRES_MIGRATION.md).

Migrator uruchamia się **wyłącznie ręcznie**: `DATABASE_URL=... npm run
db:migrate:postgres`. Nie startuje wraz z aplikacją. Każdy plik SQL jest
zatwierdzany w osobnej transakcji, pod blokadą advisory lock. Ponowne
uruchomienie pomija zapisane migracje, a zmiana sumy kontrolnej lub brak
wcześniej wykonanej migracji zatrzymują proces. Nie należy edytować wykonanych
plików SQL; zmianę schematu dodaje się jako następny plik.

Na środowisku z `APP_ENV=production` trzeba dodatkowo przekazać argument
`--allow-production`; użycie wymaga wcześniej kopii zapasowej, zatwierdzonego
planu przywracania i decyzji administratora szkoły. Nie wpisywać URL bazy ani
jej zawartości do repozytorium, logów czy zgłoszeń. Najpierw testować na
pustej bazie z danymi syntetycznymi.
