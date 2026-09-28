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
zatwierdzania wymaga nadal decyzji Rady. Tabele przypomnień dodaje `0007_email.sql`.

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

`0009_meetings.sql` dodaje zebrania (rok, rodzaj, klasa dla zebrania
klasowego, status i konfigurowalną regułę quorum), porządek obrad, listę
obecności, niezmienne ustalenia quorum, wersjonowane protokoły z
zatwierdzeniem i historią widoczności, uchwały z rewizjami oraz klucze
idempotencji. Skutki dla danych: migracja tylko dodaje tabele, funkcje,
triggery i widoki; nie zmienia ani nie przenosi istniejących wierszy, a
reguła księgi dla wydatków powyżej 3000 EUR pozostaje bez zmian (widok
`ledger_resolution_links` jedynie łączy referencję z uchwałą). Lista obecności
przechowuje wyłącznie identyfikator konta lub opiekuna, funkcję, prawo głosu i
obecność — bez imion i adresów. Nie da się usunąć zebrania, wpisu obecności,
protokołu, uchwały ani ustalenia quorum; zatwierdzony protokół i uchwała
przyjęta lub odrzucona są niezmienne, a poprawka to nowa wersja lub rewizja.
Pierwsze zatwierdzenie protokołu blokuje dane zebrania. Wycofanie migracji na
pustej bazie wymaga usunięcia tych obiektów; na bazie z danymi — tylko po
kopii zapasowej i decyzji o retencji (D-04). Szczegóły:
[`docs/MEETINGS.md`](../docs/MEETINGS.md).

`0005_import.sql` (issue #36) dodaje tabelę `import_batches` — dziennik
zatwierdzonych importów z aktorem, rokiem, licznikami, skrótem SHA-256
znormalizowanych wierszy (`fingerprint`, unikalny — te same dane zapisują się
najwyżej raz), skrótem planu i kluczem idempotencji. Tabela nie przechowuje
imion, e-maili ani treści pliku i jest tylko do dopisywania (trigger).
`households` i `students` dostają kolumny `source_ref` (stabilny
identyfikator ze źródła szkoły, do 80 znaków, unikalny bez rozróżniania
wielkości liter; jedna szkoła na bazę) oraz `import_batch_id`; `guardians`
dostaje `import_batch_id`. Wszystkie nowe kolumny są `NULL` dla istniejących
wierszy, więc stare rekordy nie są przepisywane, a przywracanie snapshotu D1
działa bez zmian. Rekordy bez `source_ref` nie są dopasowywane przez import —
import tworzy nowe albo zgłasza konflikt. Utworzenie unikalnych indeksów
nie może się nie powieść na istniejących danych, bo kolumny są nowe i puste.

`0006_documents.sql` (issue #39) rozszerza `documents` o rok szkolny, klasę
(zgodną z rokiem), powiązanie z wpisem księgi lub wpłatą, SHA-256, klucz
idempotencji (unikalny) oraz pola retencji `retention_policy`/`retain_until`
(czekają na D-04; `NULL` = nie usuwać). Nowe kolumny są puste dla istniejących
wierszy; żaden wiersz nie jest przepisywany ani usuwany. Ograniczenie
`documents_api_row` obowiązuje tylko wiersze z rokiem szkolnym: rodzaj
`financial`/`board`/`class`, klasa wyłącznie dla `class`, dozwolony typ MIME,
losowy klucz `docs/<uuid>` bez nazwy pliku. Wiersze bez roku (np. z
odtworzonego D1) są dla API niewidoczne do czasu osobnej migracji
klasyfikującej. Trigger blokuje `UPDATE` i `DELETE` na `documents` — usuwanie
po okresie retencji będzie osobnym, audytowanym mechanizmem. Opis API i
bucketu: [`docs/DOCUMENTS.md`](../docs/DOCUMENTS.md).

`0007_email.sql` (issues #10, #40) dodaje wyłącznie nowe tabele, funkcje i
triggery; istniejące dane nie są zmieniane. `email_campaigns` przechowuje szkic,
skrót treści, skrót migawki odbiorców i zatwierdzenie (inna osoba niż autor —
ograniczenie CHECK); trigger cofa kampanię do szkicu przy każdej zmianie treści
lub listy i blokuje zmiany po zakolejkowaniu, a kampanii nie można usunąć.
`email_campaign_recipients` to migawka: unikalne (kampania, rodzina) i
(kampania, skrót adresu); **zawiera adresy e-mail opiekunów** (kopia potrzebna do
wysyłki), więc podlega tej samej retencji co dane opiekunów (D-04) i musi być
usuwana razem z kampanią po okresie retencji — procedura usuwania nie jest
jeszcze zaprojektowana. `email_campaign_exclusions` zapisuje powód pominięcia
rodziny. `email_outbox` to kolejka z kluczem `campaign:<id>:household:<id>`
(unikalnym i sprawdzanym CHECK), stanem, liczbą prób i identyfikatorem
wiadomości dostawcy; trigger pilnuje przejść stanów i zabrania usuwania.
`email_send_ledger` (dzienne zużycie limitu, także inne wiadomości konta),
`email_suppressions` (wyłączenia po bounce/skardze), `email_webhook_events`
(tylko zweryfikowane zdarzenia) i `email_worker_runs` są tylko do dopisywania.
Wyłączenia i zdarzenia webhooka przechowują wyłącznie skrót SHA-256 adresu —
to pseudonimizacja, nie anonimizacja. Wycofanie migracji = usunięcie tych tabel
i funkcji na bazie bez kampanii; na bazie z historią wysyłek nie cofać.

`0018_news.sql` dodaje aktualności i galerię: `news_photos` (odwołanie do
pliku w prywatnym magazynie, autor, źródło, data, publiczny podpis licencji,
liczba rozpoznawalnych dzieci i dorosłych, weryfikacja praw przez inną osobę
niż rejestrująca, cofnięcie praw), `news_photo_consents` (tylko odwołania do
dokumentów zgód, bez imion), `news_posts` z niezmiennymi wersjami w
`news_post_revisions` oraz widok `public_news`. Triggery blokują zatwierdzenie
i publikację wpisu ze zdjęciem bez zweryfikowanych praw, weryfikację zdjęcia z
dziećmi bez odwołania do zgody oraz kopię z publicznej strony bez wyraźnej
licencji; metadanych zdjęć, zgód i wersji nie można zmienić ani usunąć.
Skutki dla danych: migracja tylko dodaje obiekty, nie zmienia istniejących
tabel ani wierszy. Wycofanie na bazie z danymi — tylko po kopii zapasowej i
decyzji o retencji (D-04). Szczegóły: [`docs/NEWS.md`](../docs/NEWS.md).

`0022_role_grant_class_year.sql` (#201) wprowadza jedną regułę „przydział
należy do roku”: `school_year_id` tego roku albo klasa tego roku (funkcja
`role_grant_in_school_year`, używana przez zamknięcie roku i `expire-grants`).
Trigger zamrożenia z 0017 uzupełnia brakujący rok przydziału klasy rokiem
klasy, odrzuca rok inny niż rok klasy i blokuje przydział klasy zamkniętego
roku także bez `school_year_id`. Skutki dla danych: istniejące przydziały z
klasą i bez roku (aktywne, wygasłe i cofnięte) dostają rok klasy w miejscu —
zakres faktyczny się nie zmienia, nic nie jest usuwane, `expires_at` i
`revoked_at` zostają; każdy taki wiersz ma zdarzenie
`role_grant.school_year_backfilled` (bez aktora i danych osobowych). Trigger
z 0004 jest wyłączony tylko na czas tej jednej instrukcji w transakcji
migracji. Następnie ograniczenie `role_grant_class_requires_year` (klasa
wymaga roku). Wpisy z rokiem różnym od roku klasy nie są przepisywane.
Wycofanie: usunięcie ograniczenia i funkcji oraz przywrócenie funkcji
triggera z 0017; uzupełnionego roku nie cofać (historia w `audit_events`).

`0025_email_send_confirmation.sql` (issues #210, #177) dodaje do `email_outbox`
kolumny `claim_token` (uuid przebiegu, który przejął wiersz) i
`send_started_at` (chwila przekazania wiadomości dostawcy) oraz zastępuje
funkcję `email_outbox_guard`: przejścia `sending → cancelled | skipped |
suppressed` są dozwolone tylko przed rozpoczęciem wysyłki, a raz ustawionego
`send_started_at` nie można wyczyścić w stanie `sending`. Skutki dla danych:
istniejące wiersze bez zmian (nowe kolumny puste); wiersz `sending` sprzed
migracji po wygaśnięciu dzierżawy trafia jak dotąd do `delivery_unknown`.
Wycofanie: przywrócenie funkcji z `0007_email.sql` i usunięcie kolumn —
bezpieczne tylko, gdy żaden wiersz nie jest w stanie `sending`.

`0027_entry_date_within_school_year.sql` (#169) dodaje funkcję
`school_year_contains(rok, dzień)`, triggery `b0_date_within_school_year`
(BEFORE INSERT) na `ledger_entries.occurred_on` i `payment_entries.received_on`
— data spoza `[starts_on, ends_on]` roku kończy się wyjątkiem
`date_outside_school_year` (API: `422`) — oraz widok tylko do odczytu
`school_year_date_deviations`. Skutki dla danych: żaden wiersz nie jest
zmieniany ani usuwany; istniejące wpisy i wpłaty spoza zakresu zostają w
sumach i są raportowane (widok, raport KR). Trigger działa tylko przy INSERT,
więc przypisanie i korekta starych wpłat działają jak dotąd. Odtworzenie
istniejących danych (`src/d1-postgres-migration.js`) ustawia w swojej
transakcji `SET LOCAL rd.restore = 'on'` i przenosi historyczne wiersze bez
zmian. Założenie zachowawcze: bez okna wpłat z wyprzedzeniem (decyzja
skarbnika/zarządu). Wycofanie: usunięcie widoku, triggerów i funkcji; dane
nie wymagają cofania.

`0028_cash_opening_and_transfers.sql` (#199) dodaje `cash_cents` do
`ledger_opening_balances` i `ledger_opening_balance_adjustments` (część poza
rachunkiem; poprawka może tylko przesunąć kwotę między rachunkiem a kasą),
kolumny `opening_cash_cents`/`closing_cash_cents` w `school_year_closures`,
niezmienną tabelę `ledger_transfers` (kasa ↔ rachunek, storno przez
`reverses_id`, zamrożenie roku, data w roku), funkcje
`ledger_opening_cash_cents`, `ledger_transfers_cash_net_at`, widok
`ledger_year_cash_summary` i nową wersję `ledger_non_bank_net_at` (dolicza
gotówkę otwarcia i przeniesienia). Skutki dla danych: istniejące bilanse i
poprawki dostają `cash_cents = 0` (kwoty całkowite bez zmian); zatwierdzone
uzgodnienia mają utrwalone wartości i się nie zmieniają; szkice bez przeniesień
i z `cash_cents = 0` dają ten sam wynik co przed migracją; zamknięcia sprzed
migracji mają puste kolumny gotówki. Gotówkę zawartą w bilansie przeniesionym
przed migracją trzeba rozbić poprawką (decyzja skarbnika). Wycofanie:
przywrócenie funkcji z 0015, usunięcie widoku, funkcji, pustej tabeli
`ledger_transfers` i kolumn.

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

`0015_reconciliation.sql` (issue #7) dodaje uzgodnienia rachunku
(`bank_reconciliations`), paczki i pozycje wyciągu oraz ręcznie zatwierdzane
powiązania pozycji z wpisami księgi lub wpłatami. Saldo księgi na dzień
wyciągu wylicza baza (`ledger_balance_at`); zatwierdzenie wymaga drugiej osoby
i zamraża uzgodnienie, a różnica ≠ 0 wymaga wyjaśnienia. Tytuł przelewu nie
jest zapisywany — tylko solony skrót SHA-256. Skutki dla danych: migracja
wyłącznie dodaje obiekty; istniejące wiersze nie są zmieniane. Szczegóły:
[`docs/RECONCILIATION.md`](../docs/RECONCILIATION.md).

`0021_meetings_integrity.sql` (#81) dodaje tabelę `meeting_attendance_state`
(licznik zmian listy obecności zebrania, podbijany triggerem przy każdym
INSERT/UPDATE `meeting_attendees`), kolumnę
`meeting_quorum_checks.attendance_revision` oraz triggery: zatwierdzenie
protokołu przy projekcie uchwały daje `minutes_open_resolutions`, a przyjęcie
lub odrzucenie uchwały na ustaleniu quorum sprzed zmiany obecności —
`resolution_quorum_check_stale`. Skutki dla danych: istniejące ustalenia
dostają `attendance_revision = NULL` (stan nieznany, traktowany jako
nieaktualny — nowe rozstrzygnięcie na już odbytym zebraniu wymaga ponownego
ustalenia quorum); żaden istniejący wiersz uchwał, obecności ani protokołów nie
jest zmieniany. Zebrania zatwierdzone wcześniej z projektem uchwały pozostają
zablokowane bez zmian. Numer 0021 wybrano jako pierwszy wolny po 0018 (main),
0013/0017 (kolejka) i 0020 (logowanie hasłem). Wycofanie na pustej bazie:
usunięcie triggerów, funkcji, kolumny i tabeli; na bazie z danymi — po kopii.
Szczegóły: [`docs/MEETINGS.md`](../docs/MEETINGS.md).

`0016_exports.sql` dodaje tabelę `export_runs` — rejestr eksportów rocznych
i list klas (rodzaj, rok, klasa, wersja formatu, kto i kiedy, SHA-256
manifestu, liczności wierszy per tabela). Skutki dla danych: migracja tylko
dodaje tabelę, funkcję i trigger; nie zmienia istniejących wierszy. Tabela nie
przechowuje treści eksportu ani danych osobowych; wierszy nie da się zmienić
ani usunąć. Wycofanie na pustej bazie: usunięcie tabeli i funkcji
`export_run_immutable`; na bazie z danymi — po kopii i decyzji o retencji
(D-04). Szczegóły: [`docs/EXPORT.md`](../docs/EXPORT.md).

`0017_year_close.sql` (issue #15) dodaje tabele `school_year_closures` i
`school_year_closure_checklist`. Skutki dla danych: migracja tylko dodaje
tabele; żaden istniejący wiersz nie jest zmieniany ani usuwany. Rok bez
wiersza w `school_year_closures` jest „otwarty”; rozpoczęcie zamknięcia
tworzy wiersz `closing`, zamknięcie zmienia go na `closed`. Bilans zamknięcia
jest liczony z `ledger_year_summary` (0003) i przenoszony jako
`ledger_opening_balances` następnego roku. Po zamknięciu triggery odrzucają
nowe zapisy przypisane do zamkniętego roku (wpłaty, księga, wydarzenia,
zebrania, przydziały ról w tym roku…) — odczyt pozostaje bez zmian; korekta
po zamknięciu nie ma dziś ścieżki w aplikacji. Przydziały ról zawężone do
zamykanego roku dostają `expires_at` (jedyna zmiana dozwolona przez trigger
0004); wiersze zostają. Wycofanie na pustej bazie: usunięcie tabel i
triggerów zamrożenia; na bazie z danymi — po kopii, bo cofnięcie zgubiłoby
zapis, które lata były zamknięte. Szczegóły: [`docs/YEAR_CLOSE.md`](../docs/YEAR_CLOSE.md).

`0014_households.sql` (issue #5) dodaje wiele gospodarstw ucznia
(`student_households`, jedno główne na okres), członkostwo opiekunów w
gospodarstwach (`guardian_households`), historię zmian kontaktu
(`guardian_contact_changes`) i historię przypisania do klasy
(`enrollment_history`). Skutki dla danych: kolumny `students.household_id` i
`guardians.household_id` zostają (NOT NULL) i są przepisywane do nowych tabel;
istniejące przypisania do klas dostają wpis historii `enrolled`. Żaden
istniejący wiersz nie jest zmieniany ani usuwany. Od tej migracji nie da się
usunąć przypisania do klasy ani zmienić jego ucznia lub roku, a uczniów i
opiekunów z historią nie da się usunąć. Szczegóły:
[`docs/DATA_MODEL.md`](../docs/DATA_MODEL.md).

`0023_student_primary_household.sql` (issue #194) dodaje `rd_today()` (data
w strefie Europe/Brussels), `student_primary_household_on(dzień)` i widok
`student_primary_household_current`; odtwarza widoki `*_households_current` i
triggery synchronizacji z 0014 z `rd_today()` zamiast `CURRENT_DATE` oraz
dodaje blokadę wiersza ucznia/opiekuna w sprawdzaniu nakładania zakresów. Nie
zmienia żadnego wiersza. Kampanie, worker, kartki i import czytają odtąd
główne gospodarstwo z `student_households`, nie `students.household_id`.
Szczegóły: [`docs/DATA_MODEL.md`](../docs/DATA_MODEL.md).

`0026_student_guardian_history.sql` (issue #190) dodaje strażnika relacji
opiekun–dziecko (`student_guardians`: bez DELETE, `student_id`/`guardian_id`/
`created_at` niezmienne, `ends_on` ustawiane raz) i tabelę
`student_guardian_changes` (historia zgody na kontakt, kontaktu głównego i dat
relacji; aktor i powód z ustawień transakcji, `source = 'direct'` dla
bezpośredniego SQL; tylko do dopisywania). Klucze obce relacji do `students`
i `guardians` zmieniają się z `ON DELETE CASCADE` na `NO ACTION`: usunięcie
ucznia lub opiekuna z relacją kończy się błędem zamiast cichego usunięcia
relacji. Skutki dla danych: istniejące wiersze bez zmian, nowa tabela pusta;
import, odtworzenie snapshotu D1 i eksportu (same INSERT-y) działają bez
zmian. Szczegóły: [`docs/DATA_MODEL.md`](../docs/DATA_MODEL.md).

`0013_mfa.sql` (issue #3) dodaje tabele `user_mfa_factors` (sekret TOTP
wyłącznie jako szyfrogram AES-256-GCM z IV i tagiem; `confirmed_at`,
`disabled_at`, `last_used_step`), `mfa_recovery_codes` (tylko SHA-256 kodu,
jednorazowe `used_at`, `invalidated_at`) i `mfa_rate_limits` (liczniki błędów
i blokady osobno dla konta i sesji). Indeksy częściowe dopuszczają najwyżej
jeden aktywny czynnik potwierdzony i jeden oczekujący na konto. Triggery
blokują usunięcie czynnika lub kodu, zmianę szyfrogramu, cofnięcie
`last_used_step` oraz przywrócenie wyłączonego czynnika lub użytego kodu.
Ograniczenie `sessions.revoked_reason` zostaje poszerzone o
`user_revoke_all`. Skutki dla danych: migracja nie zmienia ani nie przenosi
istniejących wierszy; istniejące wartości `revoked_reason` nadal spełniają
nowe ograniczenie. Utrata klucza `MFA_ENCRYPTION_KEY` oznacza konieczność
ponownego zapisu wszystkich czynników. Metoda MFA (TOTP) jest propozycją do
decyzji D-10. Opis: [`docs/AUTH.md`](../docs/AUTH.md).

`0020_password_login.sql` (issue #3, D-10) dodaje logowanie hasłem.
`user_passwords` przechowuje na konto jeden skrót hasła w formacie
`scrypt$N$r$p$<sól>$<klucz>` (parametry w ciągu, sól 16 bajtów na hasło),
datę i powód ustawienia (`invitation`, `change`, `reset`, `rehash`) oraz
flagę `must_change`; hasła w postaci jawnej nie ma nigdzie. `login_rate_limits`
liczy błędne logowania osobno dla SHA-256 znormalizowanego adresu e-mail i
adresu IP (z separacją dziedziny) — bez adresów w postaci jawnej; to
pseudonimizacja, więc aplikacja usuwa wiersze starsze niż doba.
`password_reset_tokens` przechowuje wyłącznie SHA-256 jednorazowego tokenu
wydanego przez administratora, z autorem, czasem wygaśnięcia i zamknięciem
(`used_at` albo `revoked_at`); trigger blokuje usunięcie i ponowne otwarcie
tokenu. Ograniczenie `sessions.revoked_reason` zostaje poszerzone o
`password_changed`, `password_reset` i `mfa_reset`. Skutki dla danych:
migracja tylko dodaje obiekty; istniejące konta nie dostają hasła (logowanie
wymaga przyjęcia zaproszenia albo tokenu resetu od administratora), a
istniejące wartości `revoked_reason` nadal spełniają nowe ograniczenie.
Wycofanie na pustej bazie: usunięcie trzech tabel, funkcji
`password_reset_token_guard` i przywrócenie poprzedniego ograniczenia; na
bazie z kontami — tylko po kopii zapasowej (wszyscy stracą hasła). Okres
przechowywania skrótów haseł wyłączonych kont i tokenów zależy od D-04.

`0081_scope_and_email_consistency.sql` (issue #198, część 1) dodaje trzy
złożone klucze obce `(class_id, school_year_id) -> classes(id, school_year_id)`
(`role_grants`, `invitations`, `export_runs` — dotąd pilnowane tylko przez
walidację API albo, dla `role_grants`, przez trigger `role_grant_year_freeze`
z #201/0022) oraz unikalny indeks na `lower(btrim(email))` i CHECK wymuszający
tę samą postać na `users.email` i `invitations.email` (dotąd `UNIQUE`
rozróżniał wielkość liter — dwa konta różniące się tylko wielkością liter były
możliwe, a logowanie po `lower(email)` po cichu wybierało starsze z nich).
Skutki dla danych: migracja tylko dodaje ograniczenia (`NOT VALID` +
`VALIDATE` w tej samej migracji, bo baza docelowa nie ma jeszcze prawdziwych
danych rodzin — patrz `docs/RAILWAY_MIGRATION.md`); nie zmienia i nie usuwa
żadnego wiersza. Przed zastosowaniem na bazie z realnymi danymi uruchom
**tylko do odczytu** `DATABASE_URL=... node scripts/check-schema-consistency.mjs`
— wypisuje liczby naruszeń każdej reguły bez identyfikatorów ani e-maili.
Naruszenie (klasa spoza roku, duplikat konta po wielkości liter) rozstrzyga
administrator PRZED migracją: duplikat e-maila — wyłączenie jednego konta
(`disabled_at`) i przeniesienie przydziałów ról nowymi wierszami (0004 nie
pozwala zmienić `user_id`); niespójna klasa/rok — poprawka danych albo
cofnięcie wiersza. Bez tego `CREATE UNIQUE INDEX` i `VALIDATE CONSTRAINT`
zatrzymają migrację czytelnym błędem zamiast cichego zapisania niespójności
(spójnie z #179). Świadomie poza zakresem tej migracji: `news_photos.document_id`
(#198, punkt 5) — wymaga rodzaju dokumentu przeznaczonego dla galerii, decyzja
i zakres #96; osobna migracja i PR.
Opis: [`docs/AUTH.md`](../docs/AUTH.md).

`0065_document_descriptions.sql` (issue #76) dodaje tytuł, kategorię, datę
dokumentu i opcjonalny opis dla wpisów `documents` (samych `documents` nie
rusza — pozostaje niezmienne, 0006). Nowa tabela `document_descriptions` jest
dopisywana: zmiana tytułu/kategorii to zawsze NOWY wiersz (kolejny
`revision_no`), nigdy edycja poprzedniego; trigger blokuje `UPDATE`/`DELETE`,
a drugi trigger pilnuje, że `revision_no` jest kolejnym numerem po
najnowszym istniejącym dla danego dokumentu. Kategoria to lista zamknięta
(`faktura`, `potwierdzenie_przelewu`, `wyciag`, `protokol`, `uchwala`,
`umowa`, `regulamin`, `sprawozdanie_rewizyjne`, `inne`) — założenie
techniczne do zatwierdzenia przez zarząd i skarbnika, niezależne od `kind`
dokumentu. Skutki dla danych: nowa, pusta tabela; istniejące dokumenty nie
dostają wpisu opisu i panel pokazuje dla nich „Bez tytułu” (brak wpisu, nie
błąd). **Poza zakresem tej migracji:** tabela nie ma jeszcze triggera
zamrożenia roku szkolnego (`a0_year_freeze`/0036) — dodanie opisu do
dokumentu z zamkniętego roku jest dziś możliwe; rozszerzenie
`year_freeze_via_parent` na tę tabelę to osobny, świadomie odłożony PR (żeby
wyjść od najnowszej wersji tej funkcji na `main` i nie powtórzyć incydentu z
#279). Wycofanie na pustej bazie: usunięcie tabeli i dwóch funkcji. Opis:
[`docs/DOCUMENTS.md`](../docs/DOCUMENTS.md).

`0074_retention_policies.sql` (issue #91, D-04) dodaje `retention_policies` —
rejestr polityk retencji, tylko dopisywanie (trigger blokuje UPDATE/DELETE).
Wiele wierszy per `data_category` w czasie; obowiązująca polityka to
najnowszy wg `effective_from`. `retain_for` (interval) i `retain_until_rule`
(opis) są rozłączne (dokładnie jedno wypełnione). `approved_by`, jeśli
ustawiony, musi różnić się od `created_by` (zasada czterech oczu). Skutki dla
danych: nowa, pusta tabela; brak zmian w istniejących tabelach. Brak wiersza
dla kategorii oznacza „nie usuwaj” (ta sama semantyka co `documents.retain_until`
sprzed tej migracji). Raport kandydatów `GET /api/admin/retention/preview`
(`src/pg/routes/admin.js`) liczy wyłącznie wiersze per kategoria i rok/rok
szkolny — nie usuwa ani nie anonimizuje żadnych danych. **Mechanizm wykonania
retencji (usuwanie/anonimizacja) świadomie nie jest częścią tej migracji ani
tego PR** — wymaga osobnej decyzji o kształcie funkcji anonimizującej,
testów rodzeństwa/opieki dzielonej i przeglądu bezpieczeństwa (patrz #91).
Wycofanie na pustej bazie: `DROP TABLE retention_policies` i funkcji guard.

`0082_immutability_hardening.sql` (issue #204, część: punkty 1, 2 i 5 z
propozycji) zamyka trzy furtki, przez które kilka faktów traktowanych jako
trwałe dało się zmienić albo sfałszować mimo istniejących triggerów
niezmienności: (1) `email_campaign_guard` — w stanie `approved` nie da się
już podmienić zatwierdzającego, czasu zatwierdzenia, skrótów zatwierdzenia
ani migawki bez zmiany stanu; przejście `approved -> draft` musi wyczyścić
wszystkie pola zatwierdzenia naraz; (2) nowy trigger `session_guard` —
`token_hash`, `user_id`, `created_at`, `rotated_from` niezmienne,
`revoked_at`/`revoked_reason` ustawiane raz, `mfa_verified_at` tylko rośnie,
wiersza sesji nie da się usunąć; (3) nowy trigger `email_outbox_insert_guard`
(BEFORE INSERT) — wiersz kolejki wysyłki idzie wyłącznie do kampanii w
stanie `approved` lub `sending`, zawsze jako świeży `state='queued'`,
`attempts=0`, bez `sent_at`/`claimed_at`/`send_started_at`/`claim_token`.
Skutki dla danych: same nowe/rozszerzone triggery na przyszłe zapisy; żaden
istniejący wiersz nie jest zmieniany. Świadomie poza zakresem tej migracji
(patrz komentarz w pliku i PR): wspólna funkcja stamp znacznika czasu dla
tabel append-only (`payment_entries`, `ledger_entries`, `audit_events`,
`*_corrections`, bilanse otwarcia) i analogiczny trigger „ustawiane raz” dla
`ended_at`/`cancelled_at`/`withdrawn_at` w pozostałych tabelach — oba
dotykają wielu tabel i seedów testowych naraz, osobny PR. Wycofanie na
pustej bazie: usunięcie dwóch nowych triggerów/funkcji i przywrócenie
`email_campaign_guard()` z `0063_email_campaign_schedule_pause.sql`; na
bazie z danymi — bezpieczne, żaden wiersz nie jest zmieniany ani usuwany.

## Migracje bez osobnego przeglądu wyżej (#175)

Poniższe migracje mają pełny opis skutków dla danych w nagłówku własnego
pliku SQL (`postgres/migrations/`); tu tylko streszczenie i odwołanie do
issue, żeby test spójności dokumentacji (`tests/docs-consistency.test.js`)
wymuszał wpis dla każdego pliku migracji.

`0024_reconciliation_match_integrity.sql` (#162, część #165) dodaje widok
`bank_match_consistency`: dla każdego aktywnego powiązania uzgodnienia
pokazuje, czy kwota pozycji wyciągu zgadza się z bieżącym netto celu i czy
te same pieniądze nie są policzone podwójnie (wpłata i wpis księgi, który ją
ujmuje, powiązane jednocześnie). Wyłącznie odczyt — bez zmiany danych.

`0032_document_uploads.sql` (#168) dodaje tabelę `document_uploads`:
zamiar przesłania dokumentu zapisywany w stanie `pending` przed `PUT` do
bucketu, potem w jednej transakcji zamieniany na `documents` + `committed` +
zdarzenie audytu. Chroni przed obiektem osieroconym po awarii w trakcie
przesyłania. Bez zmiany istniejących wierszy.

`0035_student_guardians_current.sql` (#157) ujednolica trzy niezależne,
rozjeżdżające się warunki daty „aktualnego” opiekuna (karta gospodarstwa,
kampania e-mail, lista klasy) w jedną funkcję/widok korzystający z
`rd_today()` (Europe/Brussels, jak `0023`). Bez zmiany istniejących wierszy.

`0036_year_freeze_finance.sql` (#80) rozszerza zamrożenie zamkniętego roku
(`0017`) na tabele uzgodnienia rachunku (`bank_reconciliations`,
`bank_statement_imports`, `bank_statement_lines`,
`bank_reconciliation_matches`, `0015`), które dotąd nie były objęte. Bez
zmiany istniejących wierszy; zmienia się wyłącznie zachowanie przyszłych
zapisów w zamkniętym roku.

`0037_scope_reference_checks.sql` (#205) rozszerza dwie istniejące funkcje
triggerów (`CREATE OR REPLACE`, te same triggery z `0009` nadal ich
używają) tak, by identyfikatory w treści żądań były sprawdzane względem
zakresu (klasa/rok), a nie tylko względem istnienia przez klucz obcy. Bez
zmiany danych ani nowych triggerów.

`0038_payment_ledger_consistency.sql` (#138) wymusza w
`ledger_entry_insert_guard`, że wpis księgi powiązany z wpłatą
(`payment_entry_id`) ma kwotę równą bieżącemu netto tej wpłaty (kwota minus
korekty minus zwroty) w chwili zapisu — inaczej `422
ledger_payment_amount_mismatch`; wyjątek dla trybu odtworzenia (wzorem
`0027`). Dodaje też `payment_refunds` i `payment_reassignments`. Zobacz też
`0049` (naprawa kolizji z `0036`).

`0039_reconciliation_correction_guard.sql` (#165) rozszerza
`ledger_correction_guard`/`payment_correction_guard`: korekta wpisu/wpłaty
z aktywnym powiązaniem w uzgodnieniu o statusie `draft` jest odrzucana
(`409 active_bank_match`) zamiast po cichu rozjeżdżać uzgodnienie. System
świadomie nie cofa powiązania automatycznie.

`0040_ledger_replacement.sql` (#144) dodaje `ledger_entries.replaces_entry_id`
(nullable, sprawdzane triggerem — wymaga też zgodności `school_year_id`) i
unikalny częściowy indeks: wpis może zostać zastąpiony co najwyżej raz.
Wspiera przeksięgowanie jako storno + wpis zastępczy (`docs/LEDGER.md`).

`0049_year_freeze_union.sql` naprawia kolizję dwóch wersji
`year_freeze_via_parent()`: `0036` i `0038`, pisane równolegle na tej samej
bazowej wersji z `0017`, nadpisały się nawzajem (migracje stosowane są w
kolejności nazw) — `0038` gubił gałąź `0036` dla tabel uzgodnienia. Ta
migracja łączy obie gałęzie w jedną funkcję. Bez zmiany danych.

`0054_enrollment_freeze.sql` (#78, punkt 4) dodaje trigger `a0_year_freeze`
na `enrollments`, spójny z `payment_entries`/`ledger_entries`/`events`/…
(`0017`): zapis wskazujący zamknięty rok dostaje `school_year_closed`. Bez
nowych kolumn ani zmiany istniejących wierszy.

`0055_enrollment_end.sql` (#86, część) dodaje
`enrollments.ended_on`/`ended_reason`/`ended_by`/`ended_at` — odejście ze
szkoły w trakcie roku kończy przypisanie do klasy zamiast go usuwać.
Wszystkie istniejące wiersze dostają `ended_on = NULL` (bez zmian).
Zakończenie relacji opiekun–dziecko i członkostwa w gospodarstwie zostaje
poza zakresem (osobna migracja/PR).

`0056_email_preview_sends.sql` (#104) dodaje wysyłkę testową kampanii na
adresy techniczne Rady: rozszerza `CHECK` dziennika limitu dostawcy
(`email_send_ledger`) o `source = 'preview'` (kampania bez wiersza kolejki
`email_outbox`), tak by wysyłka testowa liczyła się do dziennego limitu
konta. Bez nowej tabeli ani zmiany istniejących wierszy.

`0057_email_preferences.sql` (#110) dodaje kategorię kampanii
(`email_campaigns.category`, domyślnie `contribution_reminder` — wszystkie
dotychczasowe kampanie to przypomnienia o składce, bez zmiany istniejących
wierszy poza tym uzupełnieniem) i tabelę append-only
`email_preferences_events` — wypisanie/zapisanie się z kategorii komunikatów
jednym kliknięciem, bez identyfikatora rodziny/opiekuna (adres jest jedynym
kluczem, jak w `email_suppressions`). Rozszerza też `CHECK` powodu wykluczenia
kampanii o `opted_out`.

`0058_backup_runs.sql` (#90) dodaje tabelę append-only `backup_runs` —
dziennik przebiegów kopii zapasowej PostgreSQL i próbnego odtworzenia (jak
`email_worker_runs` w `0007`), obejmujący też `storage_backup` (kopia
prywatnego bucketu dokumentów, #103) dla jednego źródła „ostatni udany
backup” (#149). Nowa tabela; nic wstecznego.

`0059_list_indexes.sql` (#159, część 2) dodaje wyłącznie indeksy pod listy z
kursorem (m.in. `audit_events(occurred_at DESC, id)`). Bez nowych kolumn,
tabel ani zmiany danych; zapis robi nieco więcej pracy (utrzymanie
indeksów), zaniedbywalne przy obecnej skali.

`0060_resolution_register.sql` (#102) dodaje rejestr uchwał: relacje
„zmienia”/„uchyla” (`resolutions.relation_kind` + `amends_resolution_id`,
wymagane razem), zgodę na powiązanie z innym rokiem
(`relation_cross_year`), widok `resolution_effective_status`
(`in_force`/`amended`/`repealed`, liczony z relacji, nic nie nadpisuje),
tabelę append-only `resolution_execution_events` (historia wykonania) i
opcjonalną podpowiedź numeru uchwały
(`school_years.resolution_number_pattern`, puste domyślnie — decyzja
D-15). Istniejące wiersze z `amends_resolution_id` bez rodzaju relacji
dostają NULL (nie jest znany wstecznie); trigger odtąd wymaga rodzaju
przy nowych powiązaniach.

`0061_meetings_mfa_four_eyes.sql` (#135, SR-10) aktualizuje wyłącznie ciało
funkcji `meeting_minutes_change_guard()`: zatwierdzenie protokołu przez tę
samą osobę, która go napisała, kończy się `minutes_four_eyes_required` — też
przy bezpośrednim `UPDATE` z pominięciem API. Bez zmiany danych.

`0064_email_outbox_resolutions.sql` (#139) dodaje tabelę append-only
`email_outbox_resolutions` — rozstrzyganie `delivery_unknown`/soft bounce bez
zmiany historii wiersza `email_outbox`, wypełnianą wyłącznie przez
`POST /api/email/campaigns/{id}/resolutions`. Nowa tabela; bez zmian w
istniejących.

`0067_data_access_log.sql` (#133) dodaje osobną (nie `audit_events`) tabelę
`data_access_log` — dziennik odczytu danych dzieci i opiekunów (lista
klasy, karta gospodarstwa, kartki, lista wpłat). Nowa tabela; brak historii
odczytów sprzed tej migracji. Retencja nieustalona (D-04) — domyślnie nie
usuwać.

`0069_mfa_key_rotation.sql` (#134) dodaje
`mfa_recovery_codes.rotated_to_factor_id` (nullable FK), żeby rotacja
`MFA_ENCRYPTION_KEY` (`scripts/rotate-mfa-key.js`) mogła wstawić nowy wiersz
czynnika MFA zamiast nadpisywać niezmienny `user_mfa_factors` (trigger
`0013`) i przenieść nieużyte kody odzyskiwania na nowy czynnik zamiast je
logicznie unieważniać. Wyłącznie nowa kolumna; bez zmiany istniejących
wierszy (domyślnie `NULL`).

`0070_session_idle_revoke_reason.sql` (#150) rozszerza wyłącznie listę
dozwolonych powodów wycofania sesji (`sessions_revoked_reason_check`) o
`idle` — sesja bez aktywności dłużej niż limit jest odtąd jawnie wycofywana
(`session.revoked`) zamiast tylko przestać działać po cichu. Żaden istniejący
wiersz się nie zmienia.

`0071_news_photo_alt_text_required.sql` (#124) dodaje
`news_photos.decorative` (domyślnie `false`) i ograniczenie
`news_photo_alt_text_required` (`alt_text IS NOT NULL OR decorative`),
dodane z `NOT VALID` — Postgres nie sprawdza wstecznie istniejących
wierszy. Zdjęcie wgrane wcześniej bez `alt_text` i bez `decorative` nie da
się zweryfikować (`verifyPhoto()`), dopóki nie powstanie jego poprawka
(nowy rekord); metadane zdjęć pozostają niezmienne.

`0093_resolution_meeting_campaign_revision.sql` (#215) dodaje
`revision_no` (`DEFAULT 1`) do `resolutions`, `meetings` i
`email_campaigns` oraz trigger `bump_revision_no()`, który zwiększa numer
wersji przy każdym `UPDATE` wiersza — niezależnie od tego, czy trasa API
sprawdza wersję (optimistic concurrency), tak jak już działa dla
`events`/`news`. Żadne istniejące wiersze nie zmieniają treści, tylko
dostają numer wersji startowej.

`0095_close_legacy_d1_and_truncate_guard.sql` (SR-05/SR-06, #101) zamyka
dwie luki bez rozdziału ról bazy: (1) `event_before_insert()` (redefinicja
z najnowszej wersji, `0008`) pozwala wstawić wydarzenie od razu jako
`published` już tylko w trybie odtworzenia migawki
(`SET LOCAL rd.restore = 'on'`) — zwykły `INSERT` z tym statusem poza tym
trybem kończy się `legacy_publish_restore_only`; (2) nowa funkcja
`deny_truncate()` i trigger `BEFORE TRUNCATE` na każdej tabeli chronionej
dziś triggerem niezmienności UPDATE/DELETE. Żaden istniejący wiersz nie
jest zmieniany ani usuwany; zmienia się wyłącznie zachowanie przyszłych
operacji.

`0084_news_photo_files.sql` (#96, część) dodaje tabelę `news_photo_files` —
magazyn wariantów plików zdjęć galerii (`web`, `thumb`) w prywatnym
Storage Bucket pod osobnym prefiksem `photos/` (oddzielnym od `docs/`
dokumentów). Przetwarzanie usuwa metadane EXIF/GPS; wariant `original`
świadomie nie jest zapisywany (wariant zachowawczy do czasu decyzji
zarządu D-18/D-04/D-05). Publiczny odczyt tylko dla zweryfikowanych zdjęć
opublikowanej wersji. Skutki dla danych: nowa, pusta tabela;
`news_photos.document_id` i istniejące metadane zdjęć bez pliku pozostają
bez zmian (plik jest opcjonalnym uzupełnieniem). Wycofanie: usunięcie
tabeli `news_photo_files` (obiekty pod `photos/` w buckecie zostają
osierocone do ręcznego sprzątania).

`0089_bank_statement_formats.sql` (#105) rozszerza import wyciągu bankowego
o formaty CODA i CAMT.053: `bank_statement_imports.source` dopuszcza
`'coda'`/`'camt053'`, dochodzą skrót pliku (`file_hash`, blokada
podwójnego importu), numer wyciągu i salda z pliku;
`bank_statement_lines.bank_transaction_hash` (HMAC-SHA256 identyfikatora
transakcji banku, unikalny globalnie) wykrywa ten sam ruch bankowy w
każdym uzgodnieniu; nowy trigger pilnuje, by wpłata/wpis księgi nie miały
aktywnego powiązania w dwóch uzgodnieniach tego samego roku jednocześnie
(`bank_match_guard` nie jest redefiniowana). Nie zapisujemy treści pliku
ani numerów rachunków — tylko solone skróty. Skutki dla danych: nowe
kolumny są `NULL`/`0` dla istniejących wierszy; żaden wiersz nie jest
zmieniany ani usuwany; istniejące powiązania w kilku uzgodnieniach roku
zostają (trigger działa tylko dla nowych). Wycofanie na bazie bez
importów z plików: usunięcie triggera/funkcji, indeksu i kolumn oraz
przywrócenie poprzedniego `CHECK source IN ('manual','csv')`; na bazie z
importami CODA/CAMT — tylko po kopii zapasowej.
