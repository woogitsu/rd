# Wydarzenia i publiczny kalendarz (#12)

Status: API na PostgreSQL (`src/pg/routes/events.js`, w `ROUTES` routera `src/pg/app.js`) i panel `events/` — prototyp na danych syntetycznych, niewdrożony na Railway, nie gotowa funkcja do pracy na danych rodzin. Panel ma widok zadań i zapisów wolontariuszy (#579, issue #142, Etap 1) — zob. sekcję „Zadania i zapisy wolontariuszy” niżej.

## Przebieg

Szkic → zgłoszenie → zatwierdzenie → publikacja. Odwołanie jest możliwe na każdym etapie i jest stanem końcowym.

- Każda zmiana treści (tytuł, opis, początek, koniec, miejsce, organizator, odbiorcy) tworzy nową, niezmienną wersję w `event_revisions` i cofa wydarzenie do szkicu. Historia wersji nie jest nadpisywana ani usuwana.
- Zmiana wymaga podania numeru wersji, którą użytkownik widział (`revision`). Nieaktualny numer daje `409 revision_conflict` zamiast nadpisania cudzej zmiany. Numer wersji jest sprawdzany **przed** walidacją treści: nieaktualna zmiana, która po połączeniu z nowszą treścią byłaby błędna (np. koniec przed nowym początkiem), też daje `409 revision_conflict`, a nie błąd walidacji. Wyjątek: ponowne wysłanie tej samej zmiany przez autora następnej wersji zwraca ją z `replayed: true`.
- Klasa (`classId`) i rok szkolny są ustalane przy tworzeniu i nie zmieniają się (trigger `event_identity_immutable`). `PATCH` zmienia tylko treść; `classId` w body jest pomijane. Wydarzenie przypisane do złej klasy odwołuje się i tworzy nowe.
- Zatwierdzenie dotyczy konkretnej wersji. Zatwierdzający musi być inną osobą niż autor wydarzenia i autor tej wersji (zasada czterech oczu, sprawdzana w serwisie i w triggerze bazy). **Założenie** do czasu decyzji D-08.
- Publikować można tylko zatwierdzoną wersję z odbiorcami `public`. Wydarzenie wewnętrzne nie trafia na stronę publiczną.
- Po zmianie opublikowanego wydarzenia strona publiczna nadal pokazuje ostatnią opublikowaną wersję, dopóki nowa nie zostanie zatwierdzona i opublikowana. Publiczny wpis ma wtedy znacznik `changedAfterPublication: true` (od zapisania zmiany do jej publikacji). Znacznik pozostaje `true` także po opublikowaniu nowej wersji (publikacja inna niż pierwsza). Dla odwołanego wydarzenia oczekująca zmiana nie ustawia znacznika.
- Odwołanie wymaga powodu (3–500 znaków). Opublikowane wydarzenie pozostaje na stronie publicznej ze statusem `cancelled`; powód jest widoczny tylko wewnętrznie (**założenie**: powód może zawierać informacje niepubliczne).
- Wydarzeń nie można usuwać.

## Czas

Baza przechowuje chwile w UTC (`TIMESTAMPTZ`). Jedyna strefa to `Europe/Brussels`. API przyjmuje czas lokalny `RRRR-MM-DDTGG:MM`. W godzinie powtórzonej przy zmianie czasu (np. 25.10.2026, 02:00–02:59) trzeba dodać przesunięcie (`+02:00` lub `+01:00`), inaczej API zwraca `ambiguous_local_time`. Czas nieistniejący (np. 29.03.2026, 02:30) daje `nonexistent_local_time`. Odpowiedzi zawierają czas lokalny z przesunięciem oraz UTC.

## Uprawnienia (założenie do decyzji D-08)

| Działanie | Kto |
|---|---|
| Szkic, zmiana, zgłoszenie, podgląd wewnętrzny | admin, zarząd (przydział bez klasy); przedstawiciel klasy tylko dla wydarzeń własnej klasy |
| Zatwierdzenie, publikacja | zarząd |
| Odwołanie opublikowanego | zarząd |
| Wycofanie nieopublikowanego | jak przy szkicu |

Przedstawiciel nie tworzy wydarzeń ogólnoszkolnych i nie widzi wydarzeń innych klas. Odczyt, zmiana i każdy krok (`submit`, `approve`, `publish`, `cancel`) wydarzenia spoza zakresu podglądu dają `404 event_not_found` — tak samo jak nieistniejący identyfikator (SR-07). `403 forbidden` oznacza, że aktor widzi wydarzenie, ale nie może wykonać kroku (np. przedstawiciel zatwierdzający wydarzenie własnej klasy albo odwołujący opublikowane). Przydział zarządu lub admina z `classId` nie daje dostępu (tylko przydział bez klasy). Skarbnik, Komisja Rewizyjna i dyrekcja nie mają dostępu wewnętrznego do czasu decyzji D-08/D-09. Zgodnie z PRODUCT.md admin techniczny nie publikuje.

## API

- `GET /api/public/events?schoolYearId=&from=RRRR-MM-DD&limit=` — bez logowania. Tylko opublikowane wersje: tytuł, opis, miejsce, organizator, czas, status `scheduled`/`cancelled`. Bez autorów, klas, numerów wersji i powodu odwołania.
- `GET /api/public/events.ics?schoolYearId=&from=RRRR-MM-DD&limit=` i `GET /api/public/events/:id.ics` (#122) — kanał iCalendar (RFC 5545) z tych samych danych co `listPublic`, do subskrypcji w kalendarzu telefonu (`text/calendar`, `ETag`, `Cache-Control: public, max-age=60`, `If-None-Match` → `304`). `UID` jest stały (`event-<id>@<domena>`, zmienna `ICAL_UID_DOMAIN` do decyzji D-20), `SEQUENCE` rośnie dopiero po ponownej publikacji (nie przy oczekującej, niezatwierdzonej zmianie), odwołane wydarzenie ma `STATUS:CANCELLED` bez powodu. `DTSTART`/`DTEND`/`DTSTAMP` w UTC (`...Z`), bez `VTIMEZONE`: wydarzenia są w bazie jako `timestamptz`, więc UTC jest jednoznaczne także dla powtórzonej godziny 02:00–02:59 (25.10.2026) i nieistniejącej 02:00–02:59 (29.03.2026); czas lokalny z `TZID` byłby tam niejednoznaczny. Strefa `Europe/Brussels` zostaje tylko jako podpowiedź `X-WR-TIMEZONE`. Bez pola `ORGANIZER` (wymagałoby adresu e-mail jako `CAL-ADDRESS`) — tekst organizatora trafia do `CONTACT`. Wspólny moduł formatujący, bez dostępu do bazy: `src/ical.js`.
- `GET /api/events?schoolYearId=` — lista wewnętrzna.
- `POST /api/events` — nowy szkic; wymaga nagłówka `Idempotency-Key` (ponowne kliknięcie zwraca ten sam szkic).
- `GET /api/events/:id` — szczegóły z historią wersji.
- `PATCH /api/events/:id` — nowa wersja; body z `revision` i zmienianymi polami treści (bez `classId`/`schoolYearId`).
- `POST /api/events/:id/submit|approve|publish|cancel` — body z `revision` (i `reason` przy odwołaniu). Ponowne wykonanie tego samego kroku zwraca `replayed: true` bez nowego wpisu w dzienniku.

Zmiany wymagają nagłówka `Origin` tej samej domeny, `Content-Type: application/json` i body do 16 KiB. Zapis w zamkniętym roku szkolnym daje `409 school_year_closed`.

## Dziennik

Każdy krok zapisuje `audit_events` (aktor, czas, `entity_type='event'`, identyfikator) w tej samej transakcji. Metadane zawierają tylko numer wersji i status, bez tytułów, powodów ani danych osobowych.

## Zadania i zapisy wolontariuszy (issue #142, Etap 1)

Bez kont rodziców (D-10): zapisy prowadzi przedstawiciel klasy dla wydarzeń **własnej klasy** oraz zarząd/admin (bez ograniczenia klasy), wskazując istniejącego opiekuna (`guardianId`) albo konto (`userId`) — nigdy nowe dane osobowe. Etap 2 (samodzielny zapis rodzica) czeka na konta rodziców.

- `event_tasks`: zadanie w obrębie wydarzenia (tytuł, opcjonalny czas w obrębie czasu wydarzenia, liczba potrzebnych miejsc 1–200, `isPublic`). Treść jest niezmienna po utworzeniu; jedyna dozwolona zmiana to odwołanie (`cancel`), stan końcowy.
- `event_task_signups`: zapis opiekuna albo konta. Status (`confirmed`/`withdrawn`) może się zmieniać (wycofanie i ponowny zapis tej samej osoby to przejście stanu **tego samego wiersza**, z historią w `audit_events` — nie nowy wiersz, nie nadpisanie: tożsamość zapisu, wraz z `recorded_by`/`created_at`, jest niezmienna, zmienia się wyłącznie `status`). Dwoje opiekunów tego samego dziecka to dwa osobne wiersze (różne `guardian_id`).
- Limit miejsc: trigger blokuje wiersz zadania i odrzuca zapis, gdy liczba aktywnych (`confirmed`) zapisów osiągnęła `slots_needed` — `409 task_full`. Ten sam trigger zamraża zapisy odwołanego zadania i odwołanego wydarzenia — `409 event_cancelled`; wcześniejsze zapisy zostają (historia, nie usuwanie). Do odwołanego wydarzenia nie dodaje się też nowych zadań (`409 event_cancelled`; ponowienie wcześniejszego utworzenia z tym samym kluczem nadal zwraca `replayed: true`). Zadanie, którego `eventId` nie zgadza się z adresem, daje `404 event_task_not_found` (zapis, odwołanie).
- Przedstawiciel może wskazać wyłącznie opiekuna z **bieżącą** relacją (`student_guardians_current`) do dziecka **bieżąco** przypisanego (`enrollments_current`) do klasy wydarzenia w jego roku szkolnym — `400 guardian_outside_class` w przeciwnym razie (także po zakończeniu relacji albo odejściu dziecka z klasy). Zarząd/admin (przydział bez klasy) nie mają tego ograniczenia.
- Rok zamknięty: `409 school_year_closed` (rozszerza wspólny trigger zamrożenia — patrz `postgres/README.md`).

### API

- `GET /api/events/:id/tasks` — lista zadań z zapisanymi osobami (imię i nazwisko opiekuna albo nazwa konta) — tylko dla ról z dostępem do wydarzenia (ta sama reguła co reszta modułu: `404 event_not_found` dla nieznanego i niedostępnego wydarzenia).
- `GET /api/events/:id/tasks/candidates[?classId=]` — opiekunowie do wyboru w formularzu zapisu: tylko `{ id, name }` (imię i nazwisko) opiekunów z bieżącą relacją do dziecka bieżąco przypisanego do klasy wydarzenia; bez e-maili, dzieci i gospodarstw. Wydarzenie ogólnoszkolne (zarząd/admin) wymaga `classId` klasy z roku wydarzenia (`400 class_required`, `404 class_not_found`); przedstawiciel nie może wskazać innej klasy niż klasa wydarzenia (`400 invalid_class`). Każdy odczyt zapisuje wpis `class_students` w `data_access_log` (#133).
- `POST /api/events/:id/tasks` — `{ title, slotsNeeded, startsAt?, endsAt?, isPublic? }`, wymaga `Idempotency-Key`.
- `POST /api/events/:id/tasks/:taskId/cancel` — `{ reason }`; ponowienie zwraca `replayed: true` bez nowego stanu.
- `POST /api/events/:id/tasks/:taskId/signups` — `{ guardianId }` albo `{ userId }` (dokładnie jedno), wymaga `Idempotency-Key`. Podwójny zapis tej samej osoby jest bezpieczną powtórką (`replayed: true`), niezależnie od klucza.
- `POST /api/events/:id/tasks/:taskId/signups/:signupId/withdraw` — wycofanie; ponowne wycofanie już wycofanego zapisu jest bezpieczną powtórką. Zapis szukany jest wyłącznie w zadaniu należącym do wydarzenia z adresu (niezgodny `eventId` daje `404 event_task_signup_not_found`, bez zmiany cudzego zapisu).
- `GET /api/events/:id/tasks` zwraca przy każdym zadaniu `outsideEventTime` (okno zadania wykracza poza **obecny** czas wydarzenia), a `PATCH /api/events/:id` — listę `tasksOutsideEventTime: [{ id, title }]` nieodwołanych zadań poza nowym czasem. Zmiana czasu wydarzenia nie odwołuje zadań ani zapisów; decyzję (np. odwołanie zadania) podejmuje osoba prowadząca zapisy.
- `GET /api/public/events` — przy każdym nieodwołanym wydarzeniu pole `volunteerTasks: [{ id, title, stillNeeded }]` (to samo źródło co niżej, jedno zapytanie dla całej listy); strona `site/` pokazuje „potrzebni jeszcze: N” albo „komplet chętnych”.
- `GET /api/public/events/:id/tasks` — bez logowania, tylko dla wydarzenia **opublikowanego**: `{ id, title, stillNeeded }` dla zadań jawnie oznaczonych `isPublic` i nieodwołanych. Bez `guardianId`/`userId`, bez liczby zapisów zadań niepublicznych, bez zadań odwołanych.

Dziennik: `event.task_created`, `event.task_cancelled`, `event.task_signup_created`, `event.task_signup_withdrawn` — identyfikatory i numer wersji, **bez** imienia/nazwiska, powodu ani identyfikatora opiekuna/konta w metadanych.

### Panel (`events/`)

W szczegółach wydarzenia sekcja „Zadania i zapisy wolontariuszy”: tabela zadań (czas, „zapisani / potrzebni”, czy liczba trafia na stronę publiczną, stan, działania), lista zapisanych z imieniem i nazwiskiem opiekuna (widoczna tylko dla ról z dostępem do wydarzenia — ta sama reguła co cały panel) oraz formularze: nowe zadanie (klucz idempotencji utrzymywany do sukcesu — ponowienie po błędzie sieci nie tworzy drugiego zadania), zapis opiekuna wybranego z listy klasy (`/tasks/candidates`; przy wydarzeniu ogólnoszkolnym najpierw wybór klasy), wycofanie zapisu (z potwierdzeniem) i odwołanie zadania (powód przez bramkę danych osobowych #152). Przyciski są blokowane na czas żądania (podwójne kliknięcie); o limicie miejsc i tak rozstrzyga serwer (`409 task_full` odświeża tabelę). Wydarzenie odwołane: zapisy zamrożone, historia widoczna. Po zmianie czasu wydarzenia panel pokazuje ostrzeżenie o zadaniach poza nowym czasem.

**Poza zakresem tej wersji (Etap 1):** retencja zapisów po zakończeniu roku (D-04); Etap 2 (samodzielny zapis i wycofanie przez rodzica, przypomnienie przez kampanię — wyłącznie po jawnym zatwierdzeniu treści i listy, nigdy automatycznie).

## Do decyzji

D-08 (kto tworzy, zatwierdza i publikuje), D-09 (dostęp dyrekcji i Komisji Rewizyjnej), ewentualna publikacja powodu odwołania oraz czas przechowywania historii wersji (D-04), D-20 (domena produkcyjna do `UID` kalendarza iCal).

**Poza zakresem (#122):** prywatny kanał iCal wewnętrzny (wydarzenia klasowe, zebrania) z tokenem w adresie. Token w URL wycieka przez historię przeglądarki i udostępnianie, więc wymaga osobnej decyzji o unieważnianiu tokenów i zakresie dostępu (D-08) — nie jest tu implementowany.
