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
Opis: [`docs/AUTH.md`](../docs/AUTH.md).
