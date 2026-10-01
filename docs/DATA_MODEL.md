# Model rodzin i opiekunów

Status (30.09.2026, #175): model w bazie (PostgreSQL: `postgres/migrations/0001_core.sql`, `0014_households.sql`, `0026_student_guardian_history.sql` i kolejne; „migracja 0003” niżej to pierwotny model D1 `migrations/0003_student_guardians.sql`), API na PostgreSQL (`src/pg/routes/families.js`) i panel (`families/`). Staging: nie wykonano; produkcja: nie (D-20). Prototyp na danych syntetycznych — **nie jest gotowy do pracy na danych rodzin** (import czeka na D-01–D-06).

Migracja 0003 oddziela relację dziecko–opiekun od przynależności do jednego gospodarstwa. Dzięki tabeli student_guardians:

- dziecko może mieć kilku opiekunów;
- jeden opiekun może być powiązany z kilkorgiem dzieci;
- opiekun z innego gospodarstwa może być powiązany z dzieckiem;
- zgoda na kontakt i kontakt główny są zapisane dla konkretnej relacji;
- relacja może mieć datę początku i końca.

Pole household_id przy uczniu pozostaje na razie głównym przypisaniem organizacyjnym. Nie wolno na jego podstawie automatycznie ustalać obowiązku, wysokości ani adresata dobrowolnej składki. Zasady wpłat dla opieki dzielonej wymagają decyzji Rady i szkoły.

## Relacja "aktualna" (issue #157)

Jedyna definicja tego, czy relacja `student_guardians` obowiązuje w danym dniu, to
widok `student_guardians_current` i funkcja `student_guardians_current_on(as_of)`
(`postgres/migrations/0035_student_guardians_current.sql`). Semantyka przedziału to
`[starts_on, ends_on]`: **oba końce włącznie** (`NULL` = odpowiednio „od początku
ewidencji” / „relacja nadal trwa”; dzień PO `ends_on` relacja jest już zakończona).
Dzień odniesienia to `rd_today()` (Europe/Brussels, migracja 0023), nie
`CURRENT_DATE` serwera bazy. To **inna** semantyka niż `[starts_on, ends_on)` w
`0014_households.sql` (`student_households`/`guardian_households`) — te dwie
tabele mają odrębne, ustalone już wcześniej konwencje; ta migracja ich nie
ujednolica, tylko ujednolica trzy moduły czytające `student_guardians`.

`src/pg/routes/families.js` (karta gospodarstwa), `src/pg/routes/email.js`
(migawka adresatów kampanii) i `src/pg/export.js` (lista klasy dla przedstawiciela)
oraz worker wysyłki (`src/email/worker.js`, kontrola zgody tuż przed wysyłką)
czytają wyłącznie z tego widoku/funkcji — żaden z nich nie powtarza warunku
`starts_on`/`ends_on` samodzielnie (pilnuje tego test statyczny w
`tests/pg-routes-wiring.test.js`, obejmuje `src/pg` i `src/email`). W migawce
kampanii priorytet „kontakt główny” liczy się wyłącznie z relacji bieżącej ze
zgodą (`contact_allowed`): wygasła, przyszła lub pozbawiona zgody relacja
`is_primary_contact` nie podnosi priorytetu opiekuna (założenie do D-17). Wcześniej te trzy moduły liczyły "aktualność"
inaczej (patrz issue #157): `email.js`/`export.js` już liczyły `ends_on` włącznie
(zgodnie z tą migracją — brak zmiany zachowania), `families.js` liczył `ends_on`
wyłącznie. Ujednolicenie do wariantu włącznego (zgodnego z
`tests/pg-primary-household.test.js`, #194) przesuwa widoczność na karcie
gospodarstwa o jeden dzień w dniu granicznym `ends_on` — bez regresji w
istniejących testach (żaden nie sprawdzał tam dnia granicznego).

Migracja zachowuje stare dane deweloperskie, tworząc relacje pomiędzy uczniami i opiekunami z tego samego gospodarstwa. Przed migracją jakichkolwiek danych produkcyjnych taki podgląd musi zostać ręcznie sprawdzony — wspólny household_id nie dowodzi uprawnienia do kontaktu w sprawie każdego dziecka.

## Klasa i rok szkolny

Migracja 0004 dopisuje rok szkolny bezpośrednio do przypisania klasy. Istniejące wpisy otrzymują rok wynikający z klasy. Unikalny indeks pozwala uczniowi mieć tylko jedną klasę w danym roku, ale zachowuje osobne wpisy historyczne w kolejnych latach. Wyzwalacze odrzucają brak roku i sytuację, w której wskazana klasa należy do innego roku.

Jeżeli przed migracją istnieją dwa przypisania jednego ucznia do klas tego samego roku, utworzenie indeksu celowo się nie powiedzie. Takiego konfliktu nie wolno rozstrzygać automatycznie — trzeba go pokazać w raporcie i poprawić przed migracją.

## Identyfikatory źródłowe i import (PostgreSQL, #36)

Migracja PostgreSQL `0005_import.sql` dodaje `source_ref` przy uczniu i rodzinie. Import dopasowuje istniejące rekordy wyłącznie po tych identyfikatorach — nigdy po samym nazwisku lub e-mailu. Opiekun jest rozpoznawany tylko w obrębie już ustalonej rodziny. Zmiana klasy w tym samym roku, zmiana rodziny lub rozbieżne imię/nazwisko przy tym samym ID ucznia są zgłaszane jako konflikt do ręcznej decyzji, a nie nadpisywane. Import tworzy powiązania uczeń–opiekun z `contact_allowed = false`. Szczegóły: [import/README.md](../import/README.md).

## PostgreSQL: wiele gospodarstw ucznia (0014, issue #5) — prototyp

Migracja `postgres/migrations/0014_households.sql` dodaje:

- `student_households` — uczeń może należeć do kilku gospodarstw (np. opieka dzielona). Najwyżej jedno gospodarstwo jest **główne** w danym okresie: przedziały `[starts_on, ends_on)` głównych członkostw jednego ucznia nie mogą się nakładać (trigger), a otwarte główne jest tylko jedno (indeks unikalny). To samo gospodarstwo nie może mieć dwóch nakładających się członkostw ucznia.
- `guardian_households` — opiekun może należeć do kilku gospodarstw (bez pojęcia „głównego”).
- `guardian_contact_changes` — historia zmian e-maila i zgody na kontakt opiekuna (poprzednia i nowa wartość, powód, aktor). Tabela zawiera dane osobowe jak `guardians`; retencja wymaga decyzji D-04. Do `audit_events` trafia wyłącznie identyfikator opiekuna i nazwy zmienionych pól.
- `identity_changes` (0182, #100) — historia sprostowań imienia i nazwiska ucznia lub opiekuna (art. 16 RODO): `subject_type` (`student`/`guardian`), poprzednie i nowe imię i nazwisko, powód (3–500 znaków, przez bramkę danych osobowych #152), `source` (`api`/`direct`), aktor, czas z zegara bazy i opcjonalne `data_request_id` z rejestru żądań. Wpis tworzy trigger na `students`/`guardians` (`UPDATE OF first_name, last_name`; aktor i powód z `rd.actor_id`/`rd.change_reason`, żądanie z `rd.data_request_id`), tylko gdy wartość się zmienia. Tylko do dopisywania (UPDATE/DELETE/TRUNCATE odrzucane); jedyny wyjątek to przebieg anonimizacji, który zastępuje imiona wartością `[zanonimizowano]` i zeruje powód. Zawiera dane osobowe; retencja — D-04. Do `audit_events` trafiają wyłącznie identyfikatory i nazwy pól (`student.identity.updated`, `guardian.identity.updated`, `fields`), nigdy imiona. Poza eksportem rocznym (`EXPORT_EXCLUDED_TABLES`), w eksporcie danych rodziny (bez powodu).
- `enrollment_history` — każde przypisanie do klasy (`enrolled`) i każda zmiana klasy w roku (`class_changed`) z datą, powodem i aktorem.
- widoki `student_households_current` i `guardian_households_current` — członkostwa obowiązujące dziś.

Zasady historii: członkostwa nie są usuwane ani zmieniane — można je raz zakończyć (`ends_on`, `ended_at`, `ended_by`); korekta to nowy wiersz. Wpisy `guardian_contact_changes` i `enrollment_history` są tylko do dopisywania. Przypisania do klasy nie da się usunąć ani przenieść na inny rok/ucznia. Aktor, powód i data zmiany pochodzą z ustawień transakcji (`set_config('rd.actor_id' …, true)`), które ustawia API; zmiana wykonana bezpośrednio w SQL też trafia do historii, z `source = 'direct'` i bez aktora.

### Relacja opiekun–dziecko i zgoda na kontakt (0026, #190)

Zgoda używana przez kampanię (`computeSnapshot`, worker przed wysyłką) i przez e-mail na liście klasy to **obie** flagi: `guardians.contact_allowed` (konto opiekuna, `PATCH /api/guardians/{id}/contact`) i `student_guardians.contact_allowed` (relacja z konkretnym dzieckiem, `PATCH /api/guardians/{id}/students/{studentId}`). Import tworzy relacje z `contact_allowed = false` (D-03), więc bez ustawienia zgody relacji kampania nie ma odbiorców.

- `PATCH /api/guardians/{guardianId}/students/{studentId}` `{ contactAllowed, reason }` — role jak przy zmianie kontaktu opiekuna (admin, zarząd). Zakres klasowy (zarząd z przydziałem klasy): tylko aktywna relacja (widok `student_guardians_current`, `[starts_on, ends_on]` — oba końce włącznie) z uczniem przypisanej klasy; inaczej `404` jak nieistniejąca. Relacja zakończona dla zakresu szerokiego: `409 relation_ended`. Ta sama wartość: `200` z `changed: false`, bez historii i audytu (podwójne kliknięcie, ponowienie). Odpowiedź podaje `guardianContactAllowed`, bo bez zgody opiekuna relacja nadal nie daje adresata.
- `student_guardian_changes` — historia zmian `contact_allowed`, `is_primary_contact`, `starts_on`, `ends_on` relacji (poprzednia i nowa wartość, powód, aktor, czas, `source` `api`/`direct`). Tylko do dopisywania. Tabela zawiera identyfikatory i flagi, bez e-maili; retencja jak pozostała historia rodzin (D-04). Do `audit_events` trafia `student_guardian.contact.updated` z identyfikatorami ucznia i opiekuna oraz nową wartością, bez powodu i danych osobowych.
- Relacji nie da się usunąć (także kaskadą — klucze obce bez `CASCADE`) ani przenieść na innego ucznia/opiekuna. Kończy się ją raz, ustawiając `ends_on`.
- Zmiana `is_primary_contact` i `starts_on` relacji nie ma trasy API (poza zakresem #190); bezpośredni SQL zostawia wpis `source = 'direct'`. Zakończenie relacji (`ends_on`) ma od #86 trasę `POST /api/guardians/{guardianId}/students/{studentId}/end` (sekcja „Zmiana opieki w trakcie roku” niżej).

### Kolumny zgodności

`students.household_id` i `guardians.household_id` z `0001_core.sql` pozostają `NOT NULL` i nie są usuwane — korzysta z nich import, odtwarzanie snapshotu D1 i starszy kod.

- Migracja przepisuje je do nowych tabel (`source = 'legacy_backfill'`): każdy uczeń dostaje jedno główne członkostwo, każdy opiekun — członkostwo w swoim gospodarstwie, każde przypisanie do klasy — wpis `enrolled`.
- Nowy uczeń lub opiekun (np. z importu) automatycznie dostaje członkostwo w gospodarstwie z tej kolumny.
- Bezpośrednia zmiana `students.household_id` kończy bieżące główne członkostwo i otwiera nowe od dziś. Dodanie nowego, już obowiązującego głównego członkostwa aktualizuje `students.household_id`. Zakończenie głównego członkostwa bez dodania nowego zostawia w kolumnie poprzednią wartość.
- `guardians.household_id` oznacza gospodarstwo z chwili utworzenia lub ostatniej bezpośredniej zmiany tej kolumny; pełny obraz daje `guardian_households`.

### Bieżące główne gospodarstwo (0023, issue #194)

`students.household_id` jest **wyłącznie kolumną zgodności** (import nowych uczniów, snapshot D1) i nie służy żadnym decyzjom. Może być nieaktualna: członkostwo z datą przyszłą nie aktualizuje jej, gdy data nadejdzie, a zakończenie głównego członkostwa bez następcy zostawia w niej stare gospodarstwo.

- „Dziś” = data kalendarzowa w strefie Europe/Brussels: `rd_today()` w SQL i `brusselsDay()` w `src/pg/today.js`, niezależnie od `TimeZone` sesji PostgreSQL. Z tej definicji korzystają widoki `student_households_current`, `guardian_households_current` i triggery synchronizacji z 0014 (wcześniej `CURRENT_DATE`).
- `student_primary_household_on(dzień)` zwraca główne gospodarstwo obowiązujące w danym dniu (najwyżej jedno na ucznia), a widok `student_primary_household_current` — na dziś. Czytają je: migawka kampanii (`computeSnapshot`), worker e-mail przed wysyłką, kartki (`/api/print/cards`) i dopasowanie istniejącego ucznia w imporcie.
- Kartki (`/api/print/cards`) wyznaczają gospodarstwo na dzień „dziś” ograniczony do zakresu roku szkolnego kartki: dla roku już zakończonego to ostatni dzień tego roku (`school_years.ends_on`), dla przyszłego — jego pierwszy dzień. Kartka starszego roku nie pokazuje więc dzisiejszego gospodarstwa. Zmiana z datą równą `ends_on` roku liczy się jako obowiązująca w tym dniu (założenie zachowawcze).
- Końcowe atomowe sprawdzenie workera e-mail (`confirmSend`) porównuje gospodarstwo z wiersza kolejki z `student_primary_household_on(dzień Brukseli)`, tak jak `recheckRow` i migawka.
- Uczeń bez obowiązującego głównego członkostwa nie trafia do kampanii ani na kartki, a import zgłasza konflikt do ręcznego powiązania.
- Opieka naprzemienna (dwa obowiązujące członkostwa, jedno główne): kampania i kartka tylko dla głównego gospodarstwa; karta gospodarstwa pokazuje oba. To założenie do D-11/D-17.
- Sprawdzanie nakładania zakresów blokuje wiersz ucznia (opiekuna) `FOR NO KEY UPDATE`, więc równoległe zmiany członkostw jednego ucznia wykonują się po kolei (poziom izolacji READ COMMITTED).
- Wpłaty nie są przepisywane: wpłata zapisana przed zmianą zostaje przy starym gospodarstwie.

### Klasa w roku

`enrollments` zachowuje ograniczenia z `0001_core.sql` (jeden wiersz na ucznia i rok) i opisuje stan bieżący. Zmiana klasy w tym samym roku aktualizuje `class_id` i dopisuje wpis `class_changed`; nowy rok szkolny to nowy wiersz `enrollments`. Ponowienie tej samej zmiany (podwójne kliknięcie) niczego nie zapisuje.

#### Konfiguracja roku i klas (0054, issue #78)

`POST /api/admin/school-years` i `POST /api/admin/school-years/{id}/classes` (wyłącznie admin, MFA — patrz nagłówek `src/pg/routes/admin.js`) tworzą rok i jego klasy z audytem (`school_year.created`, `class.created`). Bez trasy usuwania — AC #78 wprost tego zabrania; korekta błędnie utworzonej klasy to nowa klasa i przeniesienie uczniów, nie usunięcie (zgodne z niezmiennością `enrollments`/`enrollment_history`). Migracja 0054 rozszerza zamrożenie roku (`a0_year_freeze`, 0017/0036) o `enrollments` — zmiana lub nowe przypisanie w zamkniętym roku zwraca `school_year_closed`.

Poza zakresem tej migracji (patrz PR — „Część #78"): kopiowanie struktury klas między latami i masowa promocja uczniów z podglądem (`plan`/`digest`/`apply`) — osobny, większy zakres.

#### Odejście ze szkoły w trakcie roku (0055, issue #86)

`enrollments.ended_on/ended_reason/ended_by/ended_at` zapisują odejście ucznia bez usuwania wiersza. `ended_on` ustawia się raz — trigger `enrollment_guard` blokuje każdą dalszą zmianę wiersza (łącznie ze zmianą klasy) po ustawieniu tej kolumny; ponowienie tego samego żądania (`POST .../enrollments/{id}/end`) zwraca `changed: false` bez drugiego zapisu. `enrollment_history` dostaje wpis `withdrawn` (data = `ended_on`, powód = `ended_reason`), zapisywany automatycznie osobnym triggerem (`enrollments_withdrawal_history`), niezależnym od istniejącego triggera historii zmian klasy.

Widok `enrollments_current` (`ended_on IS NULL OR ended_on > CURRENT_DATE` — ta sama konwencja co `student_households_current`) zastępuje `enrollments` w miejscach liczących/wyświetlających uczniów **dziś**: lista klasy i licznik uczniów (`families.js`), kartki (`print.js`), dobór adresatów kampanii (`computeSnapshot`, `email.js`) i eksport listy klasy dla przedstawiciela (`buildClassRoster`, `export.js`). Data zakończenia może być przyszła — uczeń pozostaje widoczny do tej daty. Wpłaty zapisane wcześniej nie są zmieniane; odejście nie tworzy ani nie usuwa żadnej należności (decyzja o ewentualnym zwrocie — Rada, D-04).

#### Zmiana opieki w trakcie roku (0136, issue #86)

Trzy trasy zamykają lukę „SQL bez aktora”: `POST /api/guardians/{id}/students/{studentId}/end` (relacja opiekun–dziecko; `ends_on` włącznie, historia w `student_guardian_changes` z aktorem i powodem), `POST /api/students/{id}/households/{membershipId}/end` oraz `POST /api/students/{id}/households` (członkostwo ucznia w gospodarstwie; `ends_on` wyłącznie). Żaden wiersz nie jest usuwany; zakończenie ustawia datę raz, korekta to nowy wiersz (zmiana głównego gospodarstwa = zakończenie starego od dnia D i nowe główne od D). Migracja 0136 dodaje `student_households.created_reason/ended_reason` (wolny tekst — DPIA jak `enrollments.ended_reason`; do `audit_events` powód nie trafia). Data zmiany w zamkniętym roku szkolnym: `409 school_year_closed`. Zakres klasowy: kończyć można tylko dla ucznia własnej klasy, dodawać członkostwo — tylko zakres szeroki (wariant zachowawczy do D-08).

Kampanie zatwierdzone przed zmianą: worker (`recheckRow` i `confirmSend`) sprawdza przy wysyłce bieżącą relację (`student_guardians_current_on`), główne gospodarstwo i — od #86 — bieżące przypisanie ucznia (`enrollments_current`); wiadomość do opiekuna bez relacji albo do rodziny wyłącznie z dzieckiem, które odeszło, nie wychodzi (`suppressed`: `consent_or_address_changed` / `student_withdrawn`), a nowy adresat nie jest dobierany automatycznie — wymaga przebudowy migawki i nowego zatwierdzenia. Podgląd kampanii pokazuje `staleRecipients` (`{powód: liczba}`) przed wysyłką.

Zakończenie członkostwa opiekuna w gospodarstwie (0163, #86/#535): `POST /api/guardians/{id}/households/{membershipId}/end` ustawia raz `guardian_households.ends_on` (wyłącznie, jak u ucznia), `ended_at`, `ended_by` i `ended_reason` (wolny tekst przez bramkę #152; do `audit_events` trafia `guardian_household.ended` z identyfikatorami i datą, bez powodu). Tylko zakres szeroki (admin, zarząd bez przydziału klasy) — gospodarstwo może obejmować dzieci innych klas (wariant zachowawczy do D-08). Relacje opiekun–dziecko (`student_guardians`) i kolumna zgodności `guardians.household_id` się nie zmieniają; kampanie i kartki biorą adresatów z relacji, więc zakończenie samego członkostwa zmienia kartę gospodarstwa, a nie listę adresatów. Opiekun bez bieżącego gospodarstwa: `withoutHousehold: true` w odpowiedzi. Ograniczenie: import dopasowuje istniejących opiekunów po `guardians.household_id`, więc ponowny import tej rodziny nie przywraca zakończonego członkostwa (przywrócenie = nowe członkostwo; trasy dodania członkostwa opiekuna jeszcze nie ma). Ekran w panelu `families/` (#535): na karcie gospodarstwa przyciski „Zakończ …” otwierają formularz (data, powód 3–500 znaków) dla odejścia ucznia ze szkoły, relacji opiekun–dziecko oraz członkostwa ucznia i opiekuna (to ostatnie tylko dla zakresu szerokiego); ekranu dodawania członkostwa (`POST /api/students/{id}/households`) nadal nie ma. `GET /api/households/{id}` zwraca w tym celu same identyfikatory zapisów: `students[].membershipId`, `students[].classes[].enrollmentId`, `guardians[].membershipId`.

Nie zrobione (Część #86): przełącznik „pokaż zakończone” w panelu i ponowne przyjęcie ucznia w tym samym roku (UNIQUE `student_id, school_year_id`) — do rozstrzygnięcia przez zarząd/szkołę.

Stan po 0136 (#86): zakończenie relacji opiekun–dziecko i członkostwa ucznia w gospodarstwie ma trasy API (wyżej), a worker i podgląd kampanii uwzględniają odejście ucznia (`student_withdrawn`, `staleRecipients`). Otwarte pozostają tylko punkty z akapitu „Nie zrobione” wyżej.

### Jednostka ewidencji składki (D-11)

Model nie rozstrzyga, czy składkę ewidencjonujemy na rodzinę czy na dziecko. Wpłaty nadal wskazują `payment_entries.household_id`; nowe tabele nie są powiązane z wpłatami i nie wyznaczają adresata ani wysokości składki. Główne gospodarstwo jest pojęciem organizacyjnym, nie finansowym.

### API i zakres (założenie do decyzji D-08/D-09)

`src/pg/routes/families.js`:

| Trasa | Role | Uwagi |
| --- | --- | --- |
| `GET /api/classes[?schoolYearId]` | admin, board, treasurer, representative | lista filtrowana w SQL po przydziałach |
| `GET /api/classes/{id}/students` | jw. | przedstawiciel tylko własna klasa |
| `GET /api/households/{id}` | jw. | tylko gdy co najmniej jeden uczeń gospodarstwa jest w zakresie; rodzeństwo spoza zakresu pomijane |
| `PATCH /api/guardians/{id}/contact` | admin, board | historia + audyt; wymagany powód |
| `PATCH /api/students/{id}/identity`, `PATCH /api/guardians/{id}/identity` | admin, board | sprostowanie imienia/nazwiska `{ firstName?, lastName?, reason, dataRequestId?, confirmPersonalData? }`; historia `identity_changes` + audyt; brak zmiany: `changed: false`; opiekun z dziećmi także poza zakresem klasowym: `403 guardian_shared_outside_scope`; `dataRequestId` tylko admin |
| `POST /api/students/{id}/enrollments` | admin, board | przypisanie lub zmiana klasy w roku; historia + audyt |
| `POST /api/students/{id}/enrollments/{enrollmentId}/end` | admin, board | odejście ze szkoły (#86); wymagany powód i data; ponowienie: `changed: false` |

- Przydział z `class_id` zawęża do tej klasy; admin/board/treasurer bez `class_id` widzą wszystkie klasy (lub klasy roku z `school_year_id`).
- `audit` i `principal` dostają `403` do czasu decyzji D-09.
- Obiekt nieistniejący i obiekt poza zakresem dają ten sam `404 not_found`.
- Zakres wyłącznie klasowy (przedstawiciel, także zarząd z przydziałem klasy) — założenie do D-08/D-11, wariant zachowawczy (#95):
  - widzi tylko opiekunów z aktywną relacją `student_guardians` (widok `student_guardians_current`, `[starts_on, ends_on]` — oba końce włącznie) do ucznia swojej klasy; opiekun związany wyłącznie z rodzeństwem spoza klasy jest pomijany (także imię i nazwisko);
  - e-mail i `contactAllowed = true` tylko przy obu zgodach: opiekuna (`guardians.contact_allowed`) i relacji do widocznego ucznia (`student_guardians.contact_allowed`) — ta sama reguła co lista klasy w eksporcie;
  - gospodarstwa ucznia (lista klasy `households[]`, `otherHouseholds`, dostęp do karty) tylko „kontaktowe”: należy do nich opiekun z aktywną relacją do tego ucznia i obiema zgodami. Pozostałe gospodarstwa dają `404` jak nieistniejące. Bez `isPrimary`/`isPrimaryHousehold` — fakt opieki dzielonej i gospodarstwo główne nie są potrzebne do pracy przedstawiciela.
- Role szerokie (admin, board, treasurer bez `class_id`) widzą wszystkich opiekunów gospodarstwa, wszystkie gospodarstwa ucznia i e-mail niezależnie od zgody (bez zmian; założenie do decyzji D-08). Zgoda na kontakt ogranicza wysyłkę, nie wgląd zarządu.
- `PATCH /api/guardians/{id}/contact` przy zakresie wyłącznie klasowym (zarząd z przydziałem klasy, #200): opiekun tylko z aktywną relacją `student_guardians` (widok `student_guardians_current`, `[starts_on, ends_on]` — oba końce włącznie) do ucznia z przypisanej klasy. Samo wspólne gospodarstwo (rodzeństwo z innej klasy, drugie gospodarstwo przy opiece dzielonej) nie wystarcza; odmowa to `404` jak nieistniejący, bez zapisu. Zarząd/admin bez przydziału klasy bez zmian. Otwarte (D-08): czy zakres klasowy może zmieniać globalny e-mail/zgodę opiekuna, który ma też dziecko w klasie spoza zakresu — obecnie może.
- Karta gospodarstwa nie zawiera pól należności ani zadłużenia. Sumy wpłat netto (widok `household_payment_totals`) widzą wyłącznie role finansowe z MFA, w zakresie lat z przydziału.
