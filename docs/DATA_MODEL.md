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

## PostgreSQL: wiele gospodarstw ucznia (0014, issue #5) — prototyp

Migracja `postgres/migrations/0014_households.sql` dodaje:

- `student_households` — uczeń może należeć do kilku gospodarstw (np. opieka dzielona). Najwyżej jedno gospodarstwo jest **główne** w danym okresie: przedziały `[starts_on, ends_on)` głównych członkostw jednego ucznia nie mogą się nakładać (trigger), a otwarte główne jest tylko jedno (indeks unikalny). To samo gospodarstwo nie może mieć dwóch nakładających się członkostw ucznia.
- `guardian_households` — opiekun może należeć do kilku gospodarstw (bez pojęcia „głównego”).
- `guardian_contact_changes` — historia zmian e-maila i zgody na kontakt opiekuna (poprzednia i nowa wartość, powód, aktor). Tabela zawiera dane osobowe jak `guardians`; retencja wymaga decyzji D-04. Do `audit_events` trafia wyłącznie identyfikator opiekuna i nazwy zmienionych pól.
- `enrollment_history` — każde przypisanie do klasy (`enrolled`) i każda zmiana klasy w roku (`class_changed`) z datą, powodem i aktorem.
- widoki `student_households_current` i `guardian_households_current` — członkostwa obowiązujące dziś.

Zasady historii: członkostwa nie są usuwane ani zmieniane — można je raz zakończyć (`ends_on`, `ended_at`, `ended_by`); korekta to nowy wiersz. Wpisy `guardian_contact_changes` i `enrollment_history` są tylko do dopisywania. Przypisania do klasy nie da się usunąć ani przenieść na inny rok/ucznia. Aktor, powód i data zmiany pochodzą z ustawień transakcji (`set_config('rd.actor_id' …, true)`), które ustawia API; zmiana wykonana bezpośrednio w SQL też trafia do historii, z `source = 'direct'` i bez aktora.

### Kolumny zgodności

`students.household_id` i `guardians.household_id` z `0001_core.sql` pozostają `NOT NULL` i nie są usuwane — korzysta z nich import, odtwarzanie snapshotu D1 i starszy kod.

- Migracja przepisuje je do nowych tabel (`source = 'legacy_backfill'`): każdy uczeń dostaje jedno główne członkostwo, każdy opiekun — członkostwo w swoim gospodarstwie, każde przypisanie do klasy — wpis `enrolled`.
- Nowy uczeń lub opiekun (np. z importu) automatycznie dostaje członkostwo w gospodarstwie z tej kolumny.
- Bezpośrednia zmiana `students.household_id` kończy bieżące główne członkostwo i otwiera nowe od dziś. Dodanie nowego, już obowiązującego głównego członkostwa aktualizuje `students.household_id`. Zakończenie głównego członkostwa bez dodania nowego zostawia w kolumnie poprzednią wartość.
- `guardians.household_id` oznacza gospodarstwo z chwili utworzenia lub ostatniej bezpośredniej zmiany tej kolumny; pełny obraz daje `guardian_households`.

### Klasa w roku

`enrollments` zachowuje ograniczenia z `0001_core.sql` (jeden wiersz na ucznia i rok) i opisuje stan bieżący. Zmiana klasy w tym samym roku aktualizuje `class_id` i dopisuje wpis `class_changed`; nowy rok szkolny to nowy wiersz `enrollments`. Ponowienie tej samej zmiany (podwójne kliknięcie) niczego nie zapisuje.

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
| `POST /api/students/{id}/enrollments` | admin, board | przypisanie lub zmiana klasy w roku; historia + audyt |

- Przydział z `class_id` zawęża do tej klasy; admin/board/treasurer bez `class_id` widzą wszystkie klasy (lub klasy roku z `school_year_id`).
- `audit` i `principal` dostają `403` do czasu decyzji D-09.
- Obiekt nieistniejący i obiekt poza zakresem dają ten sam `404 not_found`.
- Zakres wyłącznie klasowy (przedstawiciel, także zarząd z przydziałem klasy) — założenie do D-08/D-11, wariant zachowawczy (#95):
  - widzi tylko opiekunów z aktywną relacją `student_guardians` (`[starts_on, ends_on)`) do ucznia swojej klasy; opiekun związany wyłącznie z rodzeństwem spoza klasy jest pomijany (także imię i nazwisko);
  - e-mail i `contactAllowed = true` tylko przy obu zgodach: opiekuna (`guardians.contact_allowed`) i relacji do widocznego ucznia (`student_guardians.contact_allowed`) — ta sama reguła co lista klasy w eksporcie;
  - gospodarstwa ucznia (lista klasy `households[]`, `otherHouseholds`, dostęp do karty) tylko „kontaktowe”: należy do nich opiekun z aktywną relacją do tego ucznia i obiema zgodami. Pozostałe gospodarstwa dają `404` jak nieistniejące. Bez `isPrimary`/`isPrimaryHousehold` — fakt opieki dzielonej i gospodarstwo główne nie są potrzebne do pracy przedstawiciela.
- Role szerokie (admin, board, treasurer bez `class_id`) widzą wszystkich opiekunów gospodarstwa, wszystkie gospodarstwa ucznia i e-mail niezależnie od zgody (bez zmian; założenie do decyzji D-08). Zgoda na kontakt ogranicza wysyłkę, nie wgląd zarządu.
- `PATCH /api/guardians/{id}/contact` przy zakresie wyłącznie klasowym (zarząd z przydziałem klasy, #200): opiekun tylko z aktywną relacją `student_guardians` (`[starts_on, ends_on)`) do ucznia z przypisanej klasy. Samo wspólne gospodarstwo (rodzeństwo z innej klasy, drugie gospodarstwo przy opiece dzielonej) nie wystarcza; odmowa to `404` jak nieistniejący, bez zapisu. Zarząd/admin bez przydziału klasy bez zmian. Otwarte (D-08): czy zakres klasowy może zmieniać globalny e-mail/zgodę opiekuna, który ma też dziecko w klasie spoza zakresu — obecnie może.
- Karta gospodarstwa nie zawiera pól należności ani zadłużenia. Sumy wpłat netto (widok `household_payment_totals`) widzą wyłącznie role finansowe z MFA, w zakresie lat z przydziału.
