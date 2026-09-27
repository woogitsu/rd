# Zebrania, obecność, quorum, protokoły i uchwały

Zakres issue #13 na docelowym stosie Node.js + PostgreSQL: migracja `postgres/migrations/0009_meetings.sql`, usługi i obsługa HTTP w `src/pg/meetings.js`, testy w `tests/pg-meetings.test.js` (PGlite, dane syntetyczne). To **prototyp**, nie funkcja gotowa do pracy na danych rodzin. Trasy nie są jeszcze podłączone do serwera Node; `handle()` otrzyma `env.db` i `env.loadAuthorizationContext` w osobnym PR-ze.

## Czego moduł świadomie nie robi

- **Nie ma głosowania elektronicznego** (D-19). Sekretarz wpisuje wyłącznie wyniki głosowania przeprowadzonego na zebraniu: liczby głosów „za”, „przeciw” i „wstrzymało się”.
- **Nie koduje zasad regulaminu** (D-21). Regulaminu nie ma w repozytorium, więc próg quorum, liczebność składu uprawnionego do głosowania i prawo głosu każdej osoby wpisuje ręcznie uprawniona osoba dla konkretnego zebrania. Aplikacja nie ustala, czy uchwała przeszła — status „przyjęta” lub „odrzucona” wpisuje sekretarz.
- **Nie wysyła zawiadomień.** Powiadomienie o zebraniu przejdzie przez moduł kampanii e-mail (#10, #40) z jawnym zatwierdzeniem treści i listy odbiorców. Status `scheduled` niczego nie wysyła.
- **Nie ma kont rodziców.** Funkcja `listMinutesForParents` jest przygotowana dla przyszłej sesji rodzica; lista klas musi być wyliczona po stronie serwera z dzieci danego opiekuna.

## Zebranie

| Pole | Znaczenie |
|---|---|
| rodzaj | `plenary` (ogólne), `board` (zarząd), `class` (klasowe — wymaga klasy z tego samego roku) |
| status | `draft` → `scheduled` → `held` → `archived`; `scheduled` może wrócić do `draft` |
| porządek obrad | punkty z numerem pozycji, dodawane do zablokowania zebrania; bez usuwania (API edycji punktu — osobny zakres) |

Archiwizacja wymaga zatwierdzonego protokołu. Zebrania nie można usunąć.

## Lista obecności i prawo głosu

Wpis wskazuje osobę przez identyfikator konta (`users`) albo opiekuna (`guardians`) i funkcję na zebraniu (np. przedstawiciel, członek zarządu, gość). Nie przechowujemy imion, nazwisk ani adresów w tej tabeli. `votingEligible` jest polem obowiązkowym bez wartości domyślnej — prawo głosu wpisuje się jawnie. Obecność można poprawiać do zablokowania zebrania; każda zmiana trafia do dziennika zdarzeń.

## Quorum

Reguła jest konfigurowana dla każdego zebrania:

- `fraction`: licznik/mianownik liczebności składu uprawnionego (`votingBodySize`) z wyborem „co najmniej” (`quorumInclusive = true`, zaokrąglenie w górę) albo „więcej niż” (`false`);
- `minimum_count`: minimalna liczba obecnych osób uprawnionych;
- `not_configured`: brak reguły — ustalenie quorum jest wtedy niemożliwe.

Pole `quorumRuleSource` zapisuje, skąd pochodzi reguła (np. paragraf regulaminu). Dla reguły `fraction` i `minimum_count` jest obowiązkowe także po stronie serwera (`400 quorum_rule_source_required`), tak jak w formularzu.

`PATCH /api/meetings/:id` łączy przesłane pola reguły z regułą zapisaną: pole pominięte zostaje bez zmian, jawne `null` czyści pole. Zmiana samego `votingBodySize` nie zeruje więc trybu ani źródła. Przy zmianie trybu pola nieużywane przez nowy tryb (np. licznik i mianownik przy `minimum_count`) są zerowane. **Założenie:** liczebność składu uprawnionego jest wpisywana ręcznie, bo regulamin i lista członków Rady nie są w systemie.

Ustalenie quorum (`determineQuorum`) oblicza baza danych z reguły i listy obecności. Liczone są tylko osoby obecne z prawem głosu. Wynik jest niezmienną migawką (reguła, liczba obecnych uprawnionych, wymagana liczba, wynik); ponowne ustalenie tworzy nowy wpis, historia zostaje. Liczba obecnych uprawnionych większa niż skład uprawniony jest błędem danych.

## Protokół

- Każda treść to nowa, niezmienna wersja (1, 2, 3…), wskazująca poprzednią. Edycja projektu także tworzy nową wersję.
- Zatwierdzić można tylko najnowszą wersję. Zatwierdzona wersja jest niezmienna (trigger w bazie).
- Pierwsze zatwierdzenie **blokuje zebranie**: listę obecności, porządek obrad, ustalenia quorum, uchwały i dane zebrania. Dalej można dodać wersję poprawioną protokołu i ją zatwierdzić oraz zmienić widoczność.
- **Zatwierdzenie wymaga rozstrzygnięcia wszystkich projektów uchwał** (#81, migracja `0021_meetings_integrity.sql`). Dopóki zebranie ma uchwałę w stanie `draft`, zatwierdzenie daje `409 minutes_open_resolutions` — także przy bezpośrednim `UPDATE` w bazie (trigger). Projekt trzeba przyjąć, odrzucić albo wycofać (`PATCH …/resolutions/:id` ze `status: "withdrawn"`; wiersz zostaje w rejestrze, zmiana trafia do dziennika zdarzeń jako `resolution.updated`). Podwójne kliknięcie „Zatwierdź” przy otwartym projekcie daje dwie odmowy i nie zmienia danych.
- Po archiwizacji nie powstają nowe wersje.
- Zatwierdzenie w systemie odnotowuje fakt przyjęcia protokołu; kto i w jakim trybie przyjmuje protokół wynika z regulaminu i można to opisać w `approvalNote`.

## Widoczność protokołów

Widoczność ustala się jawnie dla zatwierdzonej wersji: `internal` (domyślnie), `parents`, `public`. Każda zmiana to nowy zapis z autorem i czasem. Projekt protokołu nie może zostać udostępniony (trigger w bazie).

Udostępniana jest wyłącznie **najnowsza zatwierdzona wersja** zebrania. Nowa zatwierdzona poprawka startuje jako `internal`, więc do czasu ponownego udostępnienia rodzice nie widzą żadnej wersji tego protokołu — wybór ostrożniejszy od automatycznego przeniesienia widoczności.

Rodzice widzą protokoły zebrań ogólnych i zarządu udostępnione rodzicom oraz protokoły zebrań klas swoich dzieci. `public` jest dostępne bez logowania przez `GET /api/meetings/public-minutes`. Przed publikacją należy sprawdzić, czy treść nie zawiera danych osobowych dzieci ani opiekunów.

## Uchwały

- Numer nadaje sekretarz; format jest decyzją D-15. Numer jest unikalny w roku szkolnym, obowiązkowy dla uchwały przyjętej, opcjonalny dla projektu i odrzuconej.
- Status: `draft`, `adopted`, `rejected`, `withdrawn`. Przyjęcie lub odrzucenie wymaga zebrania w statusie `held`, wszystkich trzech liczb głosów i wskazania ustalenia quorum z tego zebrania. Suma głosów nie może przekroczyć liczby obecnych uprawnionych w tym ustaleniu.
- **Ustalenie quorum musi być aktualne** (#81). Każdy wpis lub poprawka obecności podbija licznik zmian listy obecności zebrania (`meeting_attendance_state`); ustalenie quorum zapisuje stan licznika (`attendance_revision`). Przyjęcie lub odrzucenie uchwały na ustaleniu sprzed późniejszej zmiany obecności baza odrzuca kodem `409 resolution_quorum_check_stale` — trzeba ponownie ustalić quorum. Wyjątek: poprawka zapisu (`correctResolution`) może zachować ustalenie poprawianej rewizji, bo opisuje to samo głosowanie. Ustalenia sprzed migracji mają stan nieznany i liczą się jako nieaktualne. `GET /api/meetings/:id` zwraca przy ustaleniu `current: true|false`; panel opisuje nieaktualne ustalenie. **Założenie (D-21 otwarte):** nieaktualne ustalenie blokuje rozstrzygnięcie, a nie tylko ostrzega — wariant ostrożniejszy do czasu decyzji regulaminowej.
- **Aplikacja nie wymaga, by quorum było osiągnięte**, ani nie ocenia większości głosów — to zasady regulaminu. Wynik quorum jest widoczny przy uchwale.
- Uchwała przyjęta lub odrzucona jest niezmienna. Pomyłkę w zapisie (np. liczbie głosów) poprawia się nową rewizją z tym samym numerem i powodem (`correctResolution`) — tylko przed zatwierdzeniem protokołu. Później zmiana wymaga nowej uchwały zmieniającej (`amendsResolutionId`).

## Związek z księgą

Wydatek powyżej 3000 EUR wymaga w `ledger_entries.resolution_reference` tekstowej referencji uchwały. Ta migracja **nie zmienia** tej reguły (D-15). Należy wpisywać dokładnie numer uchwały; widok `ledger_resolution_links` łączy wpis księgi z aktualną rewizją przyjętej uchwały z tego samego roku i pokazuje wpisy bez dopasowania. `findAdoptedResolution` (`GET /api/meetings/resolutions/lookup`) pozwala sprawdzić numer przy tworzeniu wydatku.

## Uprawnienia — założenie do zatwierdzenia (D-08, D-09)

| Rola | Zakres w tym module |
|---|---|
| admin, board | zarządzanie zebraniami, obecnością, protokołami, uchwałami i widocznością |
| audit (Komisja Rewizyjna) | odczyt wszystkich zebrań, także projektów protokołów |
| treasurer | wyłącznie sprawdzenie przyjętej uchwały po numerze |
| representative | wyłącznie udostępnione rodzicom zatwierdzone protokoły: zebrania ogólne i zarządu oraz własnej klasy |
| principal | brak dostępu do decyzji D-09 |

Przydział z `classId` działa tylko dla zebrań tej klasy; nigdy dla zebrań ogólnych lub zarządu. Przydział z `schoolYearId` działa tylko w swoim roku. MFA nie jest wymagane, bo moduł nie wykonuje operacji finansowych; szkoła może to zmienić.

## API

Wszystkie mutacje wymagają nagłówka `Origin` zgodnego z serwerem. Odmowy reguł bazy (np. zablokowane zebranie, `minutes_must_start_as_draft`, `meetings_cannot_be_deleted`, zapis w zamkniętym roku — `school_year_closed`) dają `409` z kodem reguły, nie `503`. Trasy zarządzania zebraniem nadal odpowiadają `403` dla zebrania spoza zakresu (SR-07 w docs/SECURITY_REVIEW.md). Tworzenie wymaga `Idempotency-Key` (8–128 znaków); powtórzenie tego samego żądania zwraca pierwotny obiekt z `Idempotency-Replayed: true`, a inne dane z tym samym kluczem dają `409 idempotency_conflict`.

| Metoda i ścieżka | Funkcja |
|---|---|
| `GET /api/meetings?schoolYearId=` | `listMeetings` |
| `POST /api/meetings` | `createMeeting` |
| `GET /api/meetings/:id` | `getMeeting` (brak uprawnień = `404 meeting_not_found`, jak brak zebrania) |
| `PATCH /api/meetings/:id` | `updateMeeting` (dane, status, reguła quorum — scalana z zapisaną) |
| `POST /api/meetings/:id/agenda-items` | `addAgendaItem` |
| `POST /api/meetings/:id/attendance` | `recordAttendance` (wpis lub poprawka) |
| `POST /api/meetings/:id/quorum-checks` | `determineQuorum` |
| `POST /api/meetings/:id/minutes` | `createMinutesVersion` |
| `POST /api/meetings/:id/minutes/:minutesId/approval` | `approveMinutes` |
| `POST /api/meetings/:id/minutes/:minutesId/visibility` | `setMinutesVisibility` |
| `POST /api/meetings/:id/resolutions` | `createResolution` |
| `PATCH /api/meetings/:id/resolutions/:resolutionId` | `updateResolution` (tylko projekt) |
| `POST /api/meetings/:id/resolutions/:resolutionId/corrections` | `correctResolution` |
| `GET /api/meetings/shared-minutes?schoolYearId=` | `listSharedMinutes` |
| `GET /api/meetings/public-minutes?schoolYearId=` | `listPublicMinutes` (bez logowania) |
| `GET /api/meetings/resolutions/lookup?schoolYearId=&number=` | `findAdoptedResolution` |

## Dziennik zdarzeń

Każda zmiana zapisuje `audit_events` z aktorem, czasem, typem i identyfikatorem obiektu. Metadane zawierają wyłącznie identyfikatory, statusy, numery wersji i wynik quorum — bez treści protokołu, uchwały ani identyfikatorów osób z listy obecności.

## Ryzyka i otwarte sprawy

- Reguły quorum i prawa głosu są wpisywane ręcznie; błąd we wpisie da błędny wynik. Przed użyciem na prawdziwych danych potrzebny jest obowiązujący regulamin (D-21).
- Po zatwierdzeniu protokołu nie można poprawić struktury listy obecności; poprawkę opisuje nowa wersja protokołu.
- Treść protokołu jest tekstem wpisanym przez człowieka: system nie wykrywa w niej danych osobowych przed publikacją.
- Retencja protokołów i uchwał wymaga decyzji D-04.
