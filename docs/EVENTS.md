# Wydarzenia i publiczny kalendarz (#12)

Stan: moduł dla nowego stosu Node.js + PostgreSQL. Nie jest jeszcze podłączony do rejestru tras ani do warstwy sesji PostgreSQL. To prototyp na danych syntetycznych, nie gotowa funkcja do pracy na danych rodzin.

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
- `GET /api/public/events.ics?schoolYearId=&from=RRRR-MM-DD&limit=` i `GET /api/public/events/:id.ics` (#122) — kanał iCalendar (RFC 5545) z tych samych danych co `listPublic`, do subskrypcji w kalendarzu telefonu (`text/calendar`, `ETag`, `Cache-Control: public, max-age=60`, `If-None-Match` → `304`). `UID` jest stały (`event-<id>@<domena>`, zmienna `ICAL_UID_DOMAIN` do decyzji D-20), `SEQUENCE` rośnie dopiero po ponownej publikacji (nie przy oczekującej, niezatwierdzonej zmianie), odwołane wydarzenie ma `STATUS:CANCELLED` bez powodu. Strefa `Europe/Brussels` jako `VTIMEZONE`, nie UTC. Bez pola `ORGANIZER` (wymagałoby adresu e-mail jako `CAL-ADDRESS`) — tekst organizatora trafia do `CONTACT`. Wspólny moduł formatujący, bez dostępu do bazy: `src/ical.js`.
- `GET /api/events?schoolYearId=` — lista wewnętrzna.
- `POST /api/events` — nowy szkic; wymaga nagłówka `Idempotency-Key` (ponowne kliknięcie zwraca ten sam szkic).
- `GET /api/events/:id` — szczegóły z historią wersji.
- `PATCH /api/events/:id` — nowa wersja; body z `revision` i zmienianymi polami treści (bez `classId`/`schoolYearId`).
- `POST /api/events/:id/submit|approve|publish|cancel` — body z `revision` (i `reason` przy odwołaniu). Ponowne wykonanie tego samego kroku zwraca `replayed: true` bez nowego wpisu w dzienniku.

Zmiany wymagają nagłówka `Origin` tej samej domeny, `Content-Type: application/json` i body do 16 KiB. Zapis w zamkniętym roku szkolnym daje `409 school_year_closed`.

## Dziennik

Każdy krok zapisuje `audit_events` (aktor, czas, `entity_type='event'`, identyfikator) w tej samej transakcji. Metadane zawierają tylko numer wersji i status, bez tytułów, powodów ani danych osobowych.

## Do decyzji

D-08 (kto tworzy, zatwierdza i publikuje), D-09 (dostęp dyrekcji i Komisji Rewizyjnej), ewentualna publikacja powodu odwołania oraz czas przechowywania historii wersji (D-04), D-20 (domena produkcyjna do `UID` kalendarza iCal).

**Poza zakresem (#122):** prywatny kanał iCal wewnętrzny (wydarzenia klasowe, zebrania) z tokenem w adresie. Token w URL wycieka przez historię przeglądarki i udostępnianie, więc wymaga osobnej decyzji o unieważnianiu tokenów i zakresie dostępu (D-08) — nie jest tu implementowany.
