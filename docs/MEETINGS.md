# Zebrania, obecność, quorum, protokoły i uchwały

Zakres issue #13 na docelowym stosie Node.js + PostgreSQL: migracja `postgres/migrations/0009_meetings.sql`, usługi i obsługa HTTP w `src/pg/meetings.js`, testy w `tests/pg-meetings.test.js` (PGlite, dane syntetyczne). To **prototyp**, nie funkcja gotowa do pracy na danych rodzin. Trasy są podłączone do routera PostgreSQL (`src/pg/routes/meetings.js`, `ROUTES` w `src/pg/app.js`), a panel `meetings/` woła je z tego samego originu.

Status: API na PostgreSQL i panel `meetings/` — prototyp na danych syntetycznych, niewdrożony na Railway. Głosowanie elektroniczne między zebraniami nie istnieje (czeka na D-19), a wymagania wobec regulaminu (D-15, D-21) nie są rozstrzygnięte.

## Czego moduł świadomie nie robi

- **Nie ma głosowania elektronicznego** (D-19). Sekretarz wpisuje wyłącznie wyniki głosowania przeprowadzonego na zebraniu: liczby głosów „za”, „przeciw” i „wstrzymało się”.
- **Nie koduje zasad regulaminu** (D-21). Regulaminu nie ma w repozytorium, więc próg quorum, liczebność składu uprawnionego do głosowania i prawo głosu każdej osoby wpisuje ręcznie uprawniona osoba dla konkretnego zebrania. Aplikacja nie ustala, czy uchwała przeszła — status „przyjęta” lub „odrzucona” wpisuje sekretarz.
- **Nie wysyła zawiadomień.** Zawiadomienie o zebraniu przechodzi przez moduł kampanii e-mail (#10, #40) z jawnym zatwierdzeniem treści i listy odbiorców; z zebrania powstaje wyłącznie SZKIC kampanii (patrz „Zawiadomienie o zebraniu”). Status `scheduled`, zatwierdzenie zawiadomienia ani odwołanie niczego nie wysyłają.
- **Nie ma kont rodziców.** Funkcja `listMinutesForParents` jest przygotowana dla przyszłej sesji rodzica; lista klas musi być wyliczona po stronie serwera z dzieci danego opiekuna.

## Zebranie

| Pole | Znaczenie |
|---|---|
| rodzaj | `plenary` (ogólne), `board` (zarząd), `class` (klasowe — wymaga klasy z tego samego roku) |
| status | `draft` → `scheduled` → `held` → `archived`; `scheduled` może wrócić do `draft`; `draft` i `scheduled` mogą przejść do `cancelled` (odwołane, stan końcowy — #113) |
| porządek obrad | punkty z numerem pozycji, dodawane do zablokowania zebrania; bez usuwania (API edycji punktu — osobny zakres) |

Archiwizacja wymaga zatwierdzonego protokołu. Zebrania nie można usunąć.

## Lista obecności i prawo głosu

Wpis wskazuje osobę przez identyfikator konta (`users`) albo opiekuna (`guardians`) i funkcję na zebraniu (np. przedstawiciel, członek zarządu, gość). Nie przechowujemy imion, nazwisk ani adresów w tej tabeli. `votingEligible` jest polem obowiązkowym bez wartości domyślnej — prawo głosu wpisuje się jawnie. Obecność można poprawiać do zablokowania zebrania; każda zmiana trafia do dziennika zdarzeń.

**Zakres identyfikatorów (#205).** Baza (trigger `meeting_attendee_guard`, migracje `0037` i `0123`) odrzuca wpis z `invalid_reference`, gdy: opiekun w funkcji `guardian` nie ma aktywnej relacji z uczniem zapisanym w klasie zebrania (klasowe) albo w klasie roku zebrania (pozostałe); konto (`userId`) nie ma aktywnego przydziału w roku zebrania (a dla zebrania klasowego — bez zawężenia do innej klasy). Ten sam kod dostaje identyfikator nieistniejący, więc odpowiedź nie ujawnia, czy konto lub opiekun istnieje w szkole; odrzucenie nie zostawia wpisu w `meeting_attendees` ani w dzienniku zdarzeń (transakcja). Zakres sprawdza się przy dodaniu wpisu i przy zmianie funkcji na `guardian`; zwykła poprawka istniejącego wpisu (odniesienie jest niezmienne) nie jest blokowana, gdy relacja lub przydział zakończyły się później. **Założenie do D-19 (wariant zachowawczy):** gość bez konta z przydziałem nie może być dziś wpisany przez `userId`; osobny wariant (wpis bez odniesienia i bez prawa głosu) wymaga decyzji Rady.

## Quorum

Reguła jest konfigurowana dla każdego zebrania:

- `fraction`: licznik/mianownik liczebności składu uprawnionego (`votingBodySize`) z wyborem „co najmniej” (`quorumInclusive = true`, zaokrąglenie w górę) albo „więcej niż” (`false`);
- `minimum_count`: minimalna liczba obecnych osób uprawnionych;
- `not_configured`: brak reguły — ustalenie quorum jest wtedy niemożliwe.

Pole `quorumRuleSource` zapisuje, skąd pochodzi reguła (np. paragraf regulaminu). Dla reguły `fraction` i `minimum_count` jest obowiązkowe także po stronie serwera (`400 quorum_rule_source_required`), tak jak w formularzu.

`PATCH /api/meetings/:id` łączy przesłane pola reguły z regułą zapisaną: pole pominięte zostaje bez zmian, jawne `null` czyści pole. Zmiana samego `votingBodySize` nie zeruje więc trybu ani źródła. Przy zmianie trybu pola nieużywane przez nowy tryb (np. licznik i mianownik przy `minimum_count`) są zerowane. **Założenie:** liczebność składu uprawnionego jest wpisywana ręcznie, bo regulamin i lista członków Rady nie są w systemie.

Ustalenie quorum (`determineQuorum`) oblicza baza danych z reguły i listy obecności. Liczone są tylko osoby obecne z prawem głosu. Wynik jest niezmienną migawką (reguła, liczba obecnych uprawnionych, wymagana liczba, wynik); ponowne ustalenie tworzy nowy wpis, historia zostaje. Skrót żądania (`Idempotency-Key`) obejmuje stan listy obecności (#81): ponowienie tego samego klucza po zmianie obecności daje `409 idempotency_conflict`, a nie stare ustalenie — nowe ustalenie wymaga nowego klucza. Liczba obecnych uprawnionych większa niż skład uprawniony jest błędem danych.

## Protokół

- Każda treść to nowa, niezmienna wersja (1, 2, 3…), wskazująca poprzednią. Edycja projektu także tworzy nową wersję.
- Zatwierdzić można tylko najnowszą wersję. Zatwierdzona wersja jest niezmienna (trigger w bazie).
- Pierwsze zatwierdzenie **blokuje zebranie**: listę obecności, porządek obrad, ustalenia quorum, uchwały i dane zebrania. Dalej można dodać wersję poprawioną protokołu i ją zatwierdzić oraz zmienić widoczność.
- **Zatwierdzenie wymaga sesji z MFA i innej osoby niż autor wersji** (#135, SR-10): `approveMinutes` sprawdza `actor.mfaVerified` (`403 mfa_required`) i to, że zatwierdzający nie jest autorem zatwierdzanej wersji (`403 minutes_four_eyes_required`). Ta sama reguła czterech oczu działa w triggerze bazy (`0061_meetings_mfa_four_eyes.sql`) i chroni przed bezpośrednim `UPDATE` z pominięciem serwisu — tam odmowa to `409` (kod jak wyżej). Reguła jest **założeniem** do decyzji D-08; nie jest dziś konfigurowalna (włączona na stałe), bo synchronizacja przełącznika między serwisem a triggerem wymagałaby dodatkowej migracji.
- **Zatwierdzenie wymaga rozstrzygnięcia wszystkich projektów uchwał** (#81, migracja `0021_meetings_integrity.sql`). Dopóki zebranie ma uchwałę w stanie `draft`, zatwierdzenie daje `409 minutes_open_resolutions` — także przy bezpośrednim `UPDATE` w bazie (trigger). Projekt trzeba przyjąć, odrzucić albo wycofać (`PATCH …/resolutions/:id` ze `status: "withdrawn"`; wiersz zostaje w rejestrze, zmiana trafia do dziennika zdarzeń jako `resolution.updated`). Podwójne kliknięcie „Zatwierdź” przy otwartym projekcie daje dwie odmowy i nie zmienia danych.
- **Lista kontrolna przed zatwierdzeniem** (#81): `GET /api/meetings/:id/approval-checklist` (tylko odczyt, bez wpisu w `audit_events`) zwraca `ready`, `minutesId` i pozycje `{ code, blocking, count? }` — wyłącznie kody i liczby, bez tytułów i treści uchwał. Blokujące (serwer i tak odrzuci zatwierdzenie): `meeting_not_held`, `open_resolutions`. Ostrzeżenia: `quorum_rule_missing`, `quorum_rule_source_missing`, `no_quorum_check`, `stale_quorum_check`, `resolutions_on_stale_check` (uchwały wsparte ustaleniem quorum sprzed późniejszej zmiany obecności). Dostęp jak do `GET /api/meetings/:id`: admin, zarząd, Komisja Rewizyjna (odczyt), zarząd klasowy tylko własnej klasy; pozostali, także przedstawiciel, dostają `404` (SR-07). Panel pokazuje listę w oknie „Zatwierdź”; jest to podpowiedź, a kontrola należy do serwera. Odmowa `409 minutes_open_resolutions` zawiera `openResolutions` (liczbę projektów).
- **Po zatwierdzeniu** zebranie jest zablokowane (wariant zachowawczy, **D-21 otwarte**): nic się nie nadpisuje, a korekta to nowy zapis — nowa wersja protokołu albo nowa uchwała zmieniająca (`amendsResolutionId`). Nieaktualne ustalenie quorum blokuje rozstrzygnięcie, a nie tylko ostrzega; jeśli regulamin każe tylko ostrzegać, wystarczy zdjąć trigger `resolutions_quorum_current_guard`.
- Po archiwizacji nie powstają nowe wersje.
- Zatwierdzenie w systemie odnotowuje fakt przyjęcia protokołu; kto i w jakim trybie przyjmuje protokół wynika z regulaminu i można to opisać w `approvalNote`.

## Widoczność protokołów

Widoczność ustala się jawnie dla zatwierdzonej wersji: `internal` (domyślnie), `parents`, `public`. Każda zmiana to nowy zapis z autorem i czasem. Projekt protokołu nie może zostać udostępniony (trigger w bazie). Każda zmiana widoczności (`internal`, `parents`, `public`) wymaga sesji z MFA: od #150 sprawdza je już wejście do zarządzania zebraniem (`meetingForManage`), a przy `parents`/`public` dodatkowo `setMinutesVisibility` (#135) — wymóg nie zależy od wybranej widoczności.

Udostępniana jest wyłącznie **najnowsza zatwierdzona wersja** zebrania. Nowa zatwierdzona poprawka startuje jako `internal`, więc do czasu ponownego udostępnienia rodzice nie widzą żadnej wersji tego protokołu — wybór ostrożniejszy od automatycznego przeniesienia widoczności.

Rodzice widzą protokoły zebrań ogólnych i zarządu udostępnione rodzicom oraz protokoły zebrań klas swoich dzieci. `public` jest dostępne bez logowania przez `GET /api/meetings/public-minutes`. Przed publikacją należy sprawdzić, czy treść nie zawiera danych osobowych dzieci ani opiekunów.

## Uchwały

- Numer nadaje sekretarz; format jest decyzją D-15. Numer jest unikalny w roku szkolnym, obowiązkowy dla uchwały przyjętej, opcjonalny dla projektu i odrzuconej.
- Status: `draft`, `adopted`, `rejected`, `withdrawn`. Przyjęcie lub odrzucenie wymaga zebrania w statusie `held`, wszystkich trzech liczb głosów i wskazania ustalenia quorum z tego zebrania. Suma głosów nie może przekroczyć liczby obecnych uprawnionych w tym ustaleniu.
- **Ustalenie quorum musi być aktualne** (#81). Każdy wpis lub poprawka obecności podbija licznik zmian listy obecności zebrania (`meeting_attendance_state`); ustalenie quorum zapisuje stan licznika (`attendance_revision`). Przyjęcie lub odrzucenie uchwały na ustaleniu sprzed późniejszej zmiany obecności baza odrzuca kodem `409 resolution_quorum_check_stale` — trzeba ponownie ustalić quorum. Wyjątek: poprawka zapisu (`correctResolution`) może zachować ustalenie poprawianej rewizji, bo opisuje to samo głosowanie. Ustalenia sprzed migracji mają stan nieznany i liczą się jako nieaktualne. `GET /api/meetings/:id` zwraca przy ustaleniu `current: true|false`; panel opisuje nieaktualne ustalenie. **Założenie (D-21 otwarte):** nieaktualne ustalenie blokuje rozstrzygnięcie, a nie tylko ostrzega — wariant ostrożniejszy do czasu decyzji regulaminowej.
- **Aplikacja nie wymaga, by quorum było osiągnięte**, ani nie ocenia większości głosów — to zasady regulaminu. Wynik quorum jest widoczny przy uchwale.
- Uchwała przyjęta lub odrzucona jest niezmienna. Pomyłkę w zapisie (np. liczbie głosów) poprawia się nową rewizją z tym samym numerem i powodem (`correctResolution`) — tylko przed zatwierdzeniem protokołu. Później zmiana wymaga nowej uchwały zmieniającej (`amendsResolutionId`).
- **Rozstrzygnięcie wymaga MFA** (#135, SR-10): zapis uchwały ze statusem `adopted` lub `rejected` (`createResolution`, `updateResolution`) oraz każda korekta (`correctResolution`, zawsze zapisuje rozstrzygnięcie) wymagają `actor.mfaVerified` (`403 mfa_required`). Od #150 także projekt (`draft`) i jego edycja wymagają MFA, bo cały zapis uchwały to zarządzanie zebraniem (patrz „MFA i zasada czterech oczu” niżej).
- **Kontrola wersji edycji projektu** (#215): `revisionNo` (osobne od `revision` — łańcucha korekt opisanego wyżej) rośnie przy każdej zmianie wiersza. `updateResolution`/`updateMeeting` czytają wiersz pod blokadą (`SELECT … FOR UPDATE`) i scalają zmianę w tej samej transakcji, więc dwie równoległe edycje różnych pól już się nie gubią po cichu. Pole `revision` (numer `revisionNo` widziany przez edytującego) jest **wymagane** przy `PATCH /api/meetings/{id}` i `PATCH /api/meetings/{id}/resolutions/{rid}` (etap 2 #215): brak lub wartość niecałkowita daje `400 invalid_revision`, niezgodność z bieżącym `revisionNo` (także przy przyjęciu uchwały na nieaktualnej treści) daje `409 revision_conflict`. Uprawnienia sprawdzane są przed tym (403 przed 400). Panel po `409` pokazuje komunikat z przyciskiem „Wczytaj ponownie” i nie zapisuje niczego po cichu. Powtórzenie dokładnie tej samej edycji (podwójne kliknięcie) jest odtwarzane bez błędu i bez drugiego zdarzenia audytu.

## Rejestr uchwał roku (#102)

- `GET /api/meetings/resolutions?schoolYearId=&status=&q=&executionStatus=` — bieżące rewizje (`resolution_current`) z numerem, tytułem, wynikiem głosowania, datą i zebraniem, relacjami „zmieniona przez”/„uchylona przez” i bieżącym stanem wykonania. Dostęp: role odczytu (admin, zarząd, Komisja Rewizyjna); przydział klasowy widzi wyłącznie uchwały zebrań tej klasy. Przedstawiciel dostaje `403` — rejestr nie jest dziś dla niego przewidziany (do potwierdzenia w D-08/D-09).
- **Podpowiedź numeru** (`suggestedNumber` w odpowiedzi `POST .../resolutions`): z ustawienia roku `resolution_number_pattern` (np. `{seq}/{year}`, `{year}` = rok kalendarzowy początku roku szkolnego). Bez ustawionego wzorca (domyślnie, do decyzji D-15) `suggestedNumber` jest `null` i nic nie jest narzucane — sekretarz wpisuje numer ręcznie jak dotąd. Podpowiedź nigdy nie zastępuje kontroli unikalności: dwa równoległe projekty z tą samą podpowiedzią kończą się dla drugiego `409 resolution_number_taken` ze świeżą podpowiedzią w odpowiedzi.
- **Relacja zmienia/uchyla**: `amendsResolutionId` wymaga `relationKind` (`amends` albo `repeals`) — oba pola albo żadne. Musi wskazywać **bieżącą rewizję** przyjętej uchwały (`resolution_current`); nieaktualna rewizja albo uchwała, która nie jest `adopted`, daje `409 resolution_amends_requires_adopted`. Wskazanie uchwały z innego roku wymaga jawnego `relationCrossYear: true`, inaczej `409 resolution_amends_cross_year_requires_flag`.
- **Status obowiązywania** (`effectiveStatus` w rejestrze, wyszukiwarce i odpowiedzi `findAdoptedResolution`): `in_force` (obowiązuje), `amended` (zmieniona) albo `repealed` (uchylona) — liczony z relacji przez widok `resolution_effective_status`, bez modyfikacji wiersza samej uchwały. Uchwała uchylona zostaje w rejestrze i w historii; przestaje być traktowana jak obowiązująca w `findAdoptedResolution` i `ledger_resolution_links` (oba zwracają `effectiveStatus`/`effective_status`, ale nadal odnajdują wpis — ocena należy do człowieka sprawdzającego wydatek).
- **Śledzenie wykonania**: `POST /api/meetings/resolutions/:id/execution` (`status`: `not_started`/`in_progress`/`done`/`will_not_be_done`, opcjonalnie `responsibleUserId` — konto, nie opiekun ani nazwisko w tekście — `dueOn` i `note` do 500 znaków) dopisuje zdarzenie do `resolution_execution_events` (tylko dopisywanie, jak `meeting_quorum_checks`). Bieżący stan to najnowsze zdarzenie; korekta to nowy wpis, nigdy nadpisanie. Dozwolone także **po zatwierdzeniu protokołu** — tabela nie jest objęta blokadą zebrania (`meeting_assert_editable` dotyczy samej uchwały, obecności i protokołu, nie tej tabeli). Uprawnienia jak przy innych mutacjach uchwał (zarządzanie zebraniem).

## Związek z księgą

Wydatek powyżej 3000 EUR wymaga w `ledger_entries.resolution_reference` tekstowej referencji uchwały. Ta migracja **nie zmienia** tej reguły (D-15). Należy wpisywać dokładnie numer uchwały; widok `ledger_resolution_links` łączy wpis księgi z aktualną rewizją przyjętej uchwały z tego samego roku i pokazuje wpisy bez dopasowania. `findAdoptedResolution` (`GET /api/meetings/resolutions/lookup`) pozwala sprawdzić numer przy tworzeniu wydatku.

## Uprawnienia — założenie do zatwierdzenia (D-08, D-09)

| Rola | Zakres w tym module |
|---|---|
| admin, board | zarządzanie zebraniami, obecnością, protokołami, uchwałami i widocznością |
| audit (Komisja Rewizyjna) | odczyt wszystkich zebrań, także projektów protokołów |
| treasurer | wyłącznie sprawdzenie przyjętej uchwały po numerze |
| representative | wyłącznie udostępnione rodzicom zatwierdzone protokoły: zebrania ogólne i zarządu oraz własnej klasy (patrz niżej: zebranie klasowe za flagą) |
| principal | brak dostępu do decyzji D-09 |

Przydział z `classId` działa tylko dla zebrań tej klasy; nigdy dla zebrań ogólnych lub zarządu. Przydział z `schoolYearId` działa tylko w swoim roku. Całe zarządzanie zebraniem (utworzenie i zmiana danych zebrania, obecność, porządek obrad, ustalenie quorum, projekt i rozstrzygnięcie uchwały, protokół, widoczność) wymaga sesji z potwierdzonym MFA — od #150 także dla przedstawiciela prowadzącego zebranie klasowe własnej klasy (#171); szczegóły w sekcji niżej. Brak roli lub zakresu daje `403 forbidden` przed sprawdzeniem MFA. **Założenie do D-08:** `admin` (techniczny) ma dziś te same uprawnienia zarządzania co `board`, choć PRODUCT.md mówi, że admin techniczny nie publikuje — nie zawężono tego w tym PR, wymaga osobnej decyzji.

## MFA i zasada czterech oczu (#135, SR-10)

Od #150 MFA jest wymagane dla **całego** zarządzania zebraniem. Wejście do każdej operacji zapisu (`meetingForManage`, `meetingForManageOrClassHost`, `createMeeting`) sprawdza `actor.mfaVerified` zaraz po sprawdzeniu roli i zakresu, niezależnie od bramki MFA routera. Lista `MFA_REQUIRED_ACTIONS` w `src/pg/meetings.js` (`resolution.decide`, `meeting.minutes.approve`, `meeting.minutes.publish`) opisuje operacje z **dodatkowym**, własnym sprawdzeniem w usłudze wprowadzonym w #135 (dokumentacja macierzy: docs/AUTHORIZATION.md); dla nich wymóg wynika więc dwukrotnie i nie zależy od kolejności wywołań. Odmowa bez MFA to `403 mfa_required`, tak jak obsługuje to panel (#99), i nie zapisuje nic w bazie ani w dzienniku.

**Odejście od kryterium akceptacji #135 („szkic uchwały i porządek obrad bez MFA”).** Pierwotnie (#135, część A) szkic uchwały, porządek obrad, obecność, quorum i widoczność `internal` miały działać bez MFA. #150 (SR-10) zastąpiło to wariantem zachowawczym (mniej uprawnień bez drugiego czynnika): jedna zasada „zarządzanie zebraniem = MFA”, bez rozróżniania szkiców, do czasu decyzji D-10 (metoda MFA i zakres jej wymagania). Koszt: sekretariat bez potwierdzonego MFA nie przygotuje nawet szkicu w systemie. Testy: `tests/pg-meetings-mfa.test.js` (szkic i `internal` bez MFA — `403 mfa_required`). Powrót do luźniejszej reguły wymaga decyzji zarządu, nie zmiany w kodzie „przy okazji”.

**Nie zrealizowano** opcjonalnego punktu 3 z #135: publikacja `public` przez drugą osobę (propozycja i akceptacja). Publikację `public` wykonuje dziś jedna osoba z MFA, ale wyłącznie po zatwierdzeniu protokołu przez inną osobę niż autor (cztery oczy przy zatwierdzeniu); treść protokołu nie jest automatycznie sprawdzana pod kątem danych osobowych, więc to ryzyko pozostaje po stronie osoby publikującej.

| Operacja | Wymóg |
|---|---|
| `createResolution`, `updateResolution` ze statusem `adopted`/`rejected` | MFA (także przez wejście do zarządzania, #150) |
| `correctResolution` | zawsze MFA (zawsze zapisuje rozstrzygnięcie) |
| `approveMinutes` | MFA **i** zatwierdzający ≠ autor zatwierdzanej wersji |
| `setMinutesVisibility` (`internal`, `parents`, `public`) | MFA; `parents`/`public` dodatkowo sprawdzane w usłudze (#135) |
| projekt uchwały, edycja porządku obrad, obecność, ustalenie quorum, dane zebrania | MFA (#150; wcześniej bez MFA) |

Kolejność sprawdzeń jest ustalona i testowana: najpierw uprawnienia i zakres (rola, klasa, rok — `403`/`404`), potem MFA (`403 mfa_required`) i zasada czterech oczu (`403 minutes_four_eyes_required`), dopiero na końcu reguły bazy sprawdzane w transakcji (np. `409 school_year_closed`, `409 resolution_quorum_check_stale`). Odmowa na każdym z tych kroków nie zapisuje nic w bazie.

## Głosowanie obiegowe — wymagania do D-19 (projekt, nie decyzja)

Elektroniczne lub zdalne głosowanie zarządu między zebraniami (np. pilna zgoda na wydatek) **nie istnieje** i czeka na decyzję D-19. Poniższe wymagania minimalne są projektem do tej decyzji, żeby po jej podjęciu nie przebudowywać modelu danych:

- **Zamknięta lista uprawnionych jako migawka**, ustalona w chwili otwarcia głosowania (jak lista obecności przy quorum) — nie zmienia się w trakcie głosowania.
- **Jeden głos na osobę**: unikalność `(vote_round_id, user_id)`.
- **Głos oddany tylko w sesji z potwierdzonym MFA** — ta sama reguła co przy rozstrzygnięciu uchwały na zebraniu.
- **Termin zamknięcia** w strefie `Europe/Brussels`; głos po terminie jest odrzucany.
- **Quorum liczone z oddanych głosów** według reguły z `quorumRuleSource` zebrania/roku, tak jak dziś przy zebraniu stacjonarnym.
- **Wynik jako niezmienna migawka**, tak jak `resolutions` i `meeting_quorum_checks` — bez nadpisywania.
- **Jawność lub tajność głosu — do decyzji.** Tajność wymaga oddzielenia tożsamości głosującego od treści głosu (osobna tabela potwierdzeń „kto głosował” bez powiązania z „jak głosował”); przy tajnym głosowaniu `user_id` nie jest przechowywany przy samym głosie.
- **Rozstrzygnięcie trafia do rejestru uchwał** (#102) **i do protokołu najbliższego zebrania** — tak samo jak uchwała przyjęta na zebraniu, żeby rejestr pozostał jednym źródłem prawdy.

## Panel `meetings/` — co widzi przedstawiciel (#167)

Panel sprawdza `GET /api/access` **przed** pierwszym żądaniem listy i wybiera jeden z dwóch widoków (`meetings/core.js`, `meetingsViewMode`):

- role z listy wyżej z dostępem do `GET /api/meetings` (`admin`, `board`, `audit`) → obecny widok bez zmian (lista zebrań, szczegóły, obecność, quorum, protokoły, uchwały);
- sam `representative` (bez żadnej z tych ról) → widok „Protokoły udostępnione” z `GET /api/meetings/shared-minutes`: data, rodzaj, klasa (nazwa z `GET /api/classes`, który zwraca tylko klasy z zakresu roli; awaryjnie identyfikator), tytuł, wersja, data zatwierdzenia i podgląd treści tylko do odczytu (bez listy obecności, quorum i projektów uchwał). Panel nigdy nie woła `GET /api/meetings` dla tej roli, więc nie ma odmowy 403 na starcie. Pozycja listy ma identyfikator protokołu w polu `minutesId` (nie `id`) — przycisk „Pokaż” szuka po tym polu (`findSharedMinutes` w `meetings/core.js`).
- inne role bez żadnej z powyższych (np. sam `principal`) → obie sekcje ukryte, tak jak dziś (403 przy próbie odczytu, bez zmiany funkcji tego PR).

Widoczność `parents` w widoku przedstawiciela oznacza, że wolno przekazać treść rodzicom klasy; wydruk/PDF tego widoku korzysta ze wspólnego arkusza druku (#151). Wydruk protokołu (przycisk „Drukuj / zapisz jako PDF”) zawiera listę obecności wg funkcji (bez nazwisk i e-maili — API ich nie zwraca; pusta kolumna „Imię i nazwisko” do wpisania ręcznie obok kolumny „Podpis”), wynik quorum, treść i dwa puste pola podpisu (prowadzący, protokolant) — układ podpisów to założenie zachowawcze do decyzji D-21. Daty i godziny na wydruku w zapisie dd.mm.rrrr gg:mm (Europe/Brussels).

Wydruk z widoku przedstawiciela (to samo okno podglądu, przycisk „Drukuj / zapisz jako PDF”) bierze dane wyłącznie z odpowiedzi `shared-minutes`, bez dodatkowych zapytań: tytuł, rodzaj, klasa, termin, wersja, data zatwierdzenia, widoczność i treść. **Nie zawiera** listy obecności, wyniku quorum, miejsca zebrania ani pól podpisu — przedstawiciel przekazuje rodzicom treść zatwierdzonej wersji, a nie oryginał do podpisu (założenie zachowawcze do D-08 i D-21; oryginał z podpisami drukuje zarząd z pełnego widoku).

Granice zakresu (testy `tests/pg-meetings.test.js`): przedstawiciel 1A widzi zebrania ogólne i zarządu oraz zebrania 1A, nie widzi 1B ani protokołów `internal`; przydział bez roku działa w każdym roku; przydział z innego roku albo bez klasy → `403 forbidden`; przedstawiciel dwóch klas (rodzeństwo) widzi zebrania obu; cofnięcie widoczności do `internal` usuwa protokół z listy od następnego żądania.

### Zebranie klasowe prowadzone przez przedstawiciela — za flagą `MEETINGS_CLASS_HOST` (#171, D-08)

Domyślnie wyłączone (wariant najbardziej zachowawczy do czasu decyzji D-08 — mniej uprawnień, patrz AGENTS.md). Ustawienie zmiennej środowiskowej `MEETINGS_CLASS_HOST=representative` pozwala przydziałowi `representative` z `classId = X` dla zebrań `kind = 'class'` i `class_id = X` (nigdy dla zebrania ogólnego, zarządu ani innej klasy — sprawdzane PRZED walidacją pozostałych danych):

- utworzyć zebranie, zmienić jego dane i status (`createMeeting`, `updateMeeting`),
- dodać punkt porządku obrad (`addAgendaItem`),
- zapisać obecność (`recordAttendance`) — **wyłącznie siebie** (`userId` równy własnemu identyfikatorowi) albo opiekuna z tej samej klasy (sprawdzane zapytaniem do `student_guardians`/`enrollments`; opiekun spoza klasy → `422 invalid_reference` bez ujawniania, czy istnieje),
- dodać wersję protokołu (`createMinutesVersion`).

**Świadomie NIE obejmuje** (zawężenie zakresu względem propozycji w issue, zgodnie z AGENTS.md „przy niejasności regulaminu zaimplementuj wariant najbardziej zachowawczy”):
- zatwierdzenia protokołu ani zmiany widoczności (`approveMinutes`, `setMinutesVisibility` zostają `MANAGE_ROLES`-only bez zmian — realizuje to samo kryterium akceptacji „przedstawiciel nie zatwierdza własnego protokołu” prościej niż reguła czterech oczu z propozycji issue; zatwierdza wyłącznie admin/board),
- ustalenia quorum (`determineQuorum` zostaje `MANAGE_ROLES`-only — zebranie klasowe w tym PR nie tworzy uchwał, więc wynik quorum nie ma tu zastosowania),
- uchwał (`createResolution`/`updateResolution`/`correctResolution` zostają `MANAGE_ROLES`-only, zgodnie z założeniem issue że zebranie klasowe nie podejmuje uchwał Rady — D-21),
- listy/wyszukiwania zebrań klasowych przedstawiciela — `GET /api/meetings` nadal wymaga `READ_ROLES` (patrz #167: przedstawiciel korzysta z `shared-minutes`, który pokazuje tylko zatwierdzone i udostępnione protokoły, nie szkice). Ekran panelu do prowadzenia zebrania klasowego **nie jest częścią tego PR** — potrzebny endpoint/widok listy własnych zebrań to osobny, przyszły zakres,
- pola `proposedRepresentative` w protokole i powiązania z `role_grants`/zaproszeniem (#108) — osobny zakres.

Zamknięty rok blokuje zapis jak dotychczas (trigger `a0_year_freeze`) — flaga nie omija reguł bazy.

## API

Wszystkie mutacje wymagają nagłówka `Origin` zgodnego z serwerem. Odmowy reguł bazy (np. zablokowane zebranie, `minutes_must_start_as_draft`, `meetings_cannot_be_deleted`, zapis w zamkniętym roku — `school_year_closed`) dają `409` z kodem reguły, nie `503`. Trasy zarządzania zebraniem nadal odpowiadają `403` dla zebrania spoza zakresu (SR-07 w docs/SECURITY_REVIEW.md). Tworzenie wymaga `Idempotency-Key` (8–128 znaków); powtórzenie tego samego żądania zwraca pierwotny obiekt z `Idempotency-Replayed: true`, a inne dane z tym samym kluczem dają `409 idempotency_conflict`.

| Metoda i ścieżka | Funkcja |
|---|---|
| `GET /api/meetings?schoolYearId=` | `listMeetings` |
| `POST /api/meetings` | `createMeeting` |
| `GET /api/meetings/:id` | `getMeeting` (brak uprawnień = `404 meeting_not_found`, jak brak zebrania) |
| `PATCH /api/meetings/:id` | `updateMeeting` (dane, status, reguła quorum — scalana z zapisaną) |
| `POST /api/meetings/:id/agenda-items` | `addAgendaItem` |
| `POST /api/meetings/:id/cancellation` | `cancelMeeting` (#113; powód 3–500 znaków, `revision`) |
| `POST /api/meetings/:id/reschedule` | `rescheduleMeeting` (#113; `scheduledAt`, powód, `revision`) |
| `POST /api/meetings/:id/agenda-items/:itemId/withdrawal` | `withdrawAgendaItem` (#113) |
| `POST /api/meetings/:id/agenda-order` | `reorderAgendaItems` (#113; `itemIds` — wszystkie niewycofane punkty w nowej kolejności) |
| `POST /api/meetings/:id/notices` | `createMeetingNotice` (#113; szkic zawiadomienia = nowa wersja) |
| `POST /api/meetings/:id/notices/:noticeId/approval` | `approveMeetingNotice` (#113) |
| `POST /api/meetings/:id/notices/:noticeId/campaign-draft` | `createNoticeCampaignDraft` (#113; wyłącznie szkic kampanii) |
| `GET /api/meetings/:id/notices/:noticeId/calendar` | `getMeetingNoticeCalendar` (#113; plik `.ics` najnowszego zatwierdzonego zawiadomienia) |
| `GET /api/meetings/public-notices?schoolYearId=` | `listPublicMeetingNotices` (#113; bez logowania) |
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
| `GET /api/meetings/resolutions?schoolYearId=&status=&q=&executionStatus=` | `listResolutionRegister` (#102) |
| `POST /api/meetings/resolutions/:resolutionId/execution` | `recordResolutionExecution` (#102; działa też po zatwierdzeniu protokołu) |

## Dziennik zdarzeń

Każda zmiana zapisuje `audit_events` z aktorem, czasem, typem i identyfikatorem obiektu. Metadane zawierają wyłącznie identyfikatory, statusy, numery wersji i wynik quorum — bez treści protokołu, uchwały ani identyfikatorów osób z listy obecności.

- **Zmiana terminu (#113):** `PATCH /api/meetings/:id` ze zmienionym `scheduledAt` zapisuje osobne zdarzenie `meeting.rescheduled` obok `meeting.updated`, z `fromScheduledAt`/`toScheduledAt` jako znacznikami czasu — bez tytułu, miejsca ani innej treści zebrania. Ponowienie tego samego `scheduledAt` (podwójne kliknięcie, ponowienie żądania) nie tworzy drugiego zdarzenia, bo porównanie jest z zapisaną wartością, nie z poprzednim żądaniem.

## Zawiadomienie o zebraniu, odwołanie i zmiana terminu (#113)

Migracja `0139_meeting_cancel_notice.sql`. **Prototyp — niczego nie wysyła i nie jest gotowy do pracy na danych rodzin.**

- **Odwołanie** (`POST …/cancellation`): przejście `draft|scheduled → cancelled` z powodem (3–500 znaków, wewnętrzny), `cancelled_by`, `cancelled_at`; wymaga `revision`. Stan jest końcowy: odwołane zebranie nie przyjmuje obecności, porządku obrad, quorum, protokołu, uchwał ani edycji (`409 meeting_cancelled`, także przy bezpośrednim `UPDATE` w bazie); zebrań nadal nie usuwa się. `PATCH` ze `status: "cancelled"` jest odrzucony — odwołuje się tylko tą trasą. Podwójne kliknięcie z tym samym powodem to `200` z `replayed: true` i bez drugiego zdarzenia; inny powód po odwołaniu to `409 meeting_cancelled`. Powód jest wolnym tekstem: zostaje w wierszu zebrania (widok wewnętrzny), nigdy w dzienniku ani na stronie publicznej. Odwołać może zarząd/admin z MFA (nie przedstawiciel-gospodarz z #171). Dziennik: `meeting.cancelled` (`fromStatus`, `scheduledAt`, `hadApprovedNotice`).
- **Zmiana terminu** (`POST …/reschedule`): nowy termin z powodem (3–500 znaków) i `revision`; wpis w dopisywanej tabeli `meeting_reschedules` (stara i nowa data, aktor, powód) oraz zdarzenie `meeting.rescheduled` (znaczniki czasu, `rescheduleId`, `hadApprovedNotice`, bez treści). Dozwolona dla `draft` i `scheduled`. `PATCH scheduledAt` nadal działa, dopóki nie ma zatwierdzonego zawiadomienia; potem `409 use_reschedule_endpoint`, żeby zmiana zawsze miała powód i nowy szkic zawiadomienia.
- **Porządek obrad**: punktu nie usuwa się — `POST …/agenda-items/:itemId/withdrawal` ustawia `withdrawn_at/by` (raz, nieodwracalnie; zdarzenie `meeting.agenda_item.withdrawn`). Wersją porządku jest niezmienna migawka (`meeting_agenda_versions`: JSON z niewycofanymi punktami + skrót SHA-256); nowa wersja powstaje przy przygotowaniu zawiadomienia, gdy treść porządku się zmieniła (`meeting.agenda_version.created`). **Zmiana kolejności** (`POST …/agenda-order`, `{ itemIds }`): lista musi zawierać dokładnie wszystkie niewycofane punkty, każdy raz (inaczej `400 invalid_agenda_order`); punkty zajmują te same numery pozycji co dotąd, w nowej kolejności, a wycofane zachowują swoje numery. Unikalność `position` jest sprawdzana przy każdym wierszu, więc serwer przenosi punkty przez wolną pozycję w jednej transakcji (bez migracji). Ta sama kolejność (podwójne kliknięcie) to `200` z `replayed: true` bez zdarzenia; zmiana zapisuje `meeting.agenda.reordered` (poprzednia i nowa lista identyfikatorów, bez treści). Kolejność wchodzi do skrótu migawki, więc po zmianie zatwierdzone zawiadomienie jest nieaktualne i potrzebna jest nowa wersja (`update`) do zatwierdzenia — nic nie jest wysyłane. Odwołane zebranie: `409 meeting_cancelled`; zebranie z zatwierdzonym protokołem: `409 meeting_locked`.
- **Zawiadomienie** (`meeting_notices`, wersje 1, 2, …): szkic (`POST …/notices`) zapisuje tytuł, termin, miejsce i wersję porządku; treść jest niezmienna, poprawka to nowa wersja. Rodzaje: `invitation`, `update` (po zmianie porządku/miejsca/tytułu), `reschedule`, `cancellation` — dwa ostatnie powstają automatycznie jako **szkic**, jeśli wcześniej było zatwierdzone zawiadomienie. Ponowienie identycznego szkicu to powtórka. Zatwierdza inna osoba niż autor (`403 notice_four_eyes_required`, wariant zachowawczy do D-08), tylko najnowszą wersję (`409 notice_not_latest`), aktualną wobec zebrania i porządku (`409 notice_outdated` — zmiana porządku po sporządzeniu unieważnia szkic i zatwierdzenie kampanii), dla zebrania `scheduled` i z co najmniej jednym niewycofanym punktem. Dziennik: `meeting.notice.created`, `meeting.notice.approved` (skrót treści, `noticeDaysBefore`, `noticeLate`).
- **Plik kalendarza** (`GET …/notices/:noticeId/calendar`, `text/calendar`, RFC 5545): tylko dla NAJNOWSZEGO ZATWIERDZONEGO zawiadomienia (szkic lub starsza wersja: `409 notice_calendar_unavailable`); dostęp jak `GET` zebrania (brak dostępu = `404`), tylko odczyt, bez wpisu w dzienniku, `Cache-Control: private, no-store`. Treść wyłącznie z migawki zawiadomienia: tytuł, termin (UTC), miejsce i tytuły punktów porządku — bez opisów punktów, powodów i danych osób. UID jest stały dla zebrania (`meeting-<id>@…`, domena `ICAL_UID_DOMAIN` do D-20), `SEQUENCE` = wersja zawiadomienia, odwołanie to `STATUS:CANCELLED`, więc import nowszego pliku aktualizuje wpis. Brak `DTEND` (zebranie nie ma godziny końca). Założenie zachowawcze: `METHOD:PUBLISH`, a nie `REQUEST`/`CANCEL` — iTIP (RFC 5546) wymaga `ORGANIZER` z adresem nadawcy, a nadawca to decyzja D-17; plik nie jest też dołączany do wiadomości e-mail (moduł e-mail bez zmian).
- **Termin zawiadomienia** (`notice_min_days` + `notice_rule_source`, jak `quorum_rule_source`; wartość z regulaminu — D-21): serwer zapisuje przy zatwierdzeniu `notice_days_before` i `notice_late` (tylko odnotowanie), panel ostrzega, nic nie blokuje.
- **Szkic kampanii e-mail** (`POST …/notices/:noticeId/campaign-draft`): tylko z zatwierdzonego, najnowszego i aktualnego zawiadomienia; powstaje `email_campaigns` w stanie `draft`, kategoria `organizational`, klucz `meeting-notice-<id>` (jedna kampania na zawiadomienie; ponowienie zwraca istniejącą). Odbiorcy: zebranie ogólne — `all_households`; klasowe — `class_households` (rodziny dzieci zapisanych do tej klasy w roku; rodzeństwo z 1A i 2B daje jedną wiadomość na rodzinę, a dwoje opiekunów jednego dziecka — jedną wiadomość wg istniejącej reguły migawki, D-17). Zebranie zarządu: `409 notice_campaign_audience_unsupported`. Migawka odbiorców, zatwierdzenie treści i listy (cztery oczy), kolejka, limit Brevo i klucz `kampania + rodzina` zostają w module e-mail; trigger bazy nie pozwala utworzyć kampanii powiązanej z zebraniem w innym stanie niż szkic z zatwierdzonego zawiadomienia ani zmienić powiązania. Odbiorców takiej kampanii nie można zmienić (`409 campaign_audience_locked`), a zwykły szkic nie może dostać `class_households`.
- **Widoczność:** panel `meetings/` pokazuje wersje zawiadomienia (także szkice) wyłącznie osobom z dostępem wewnętrznym; przedstawiciel-gospodarz klasy nie widzi powodów ani kampanii. Strona publiczna (`GET /api/meetings/public-notices`, widok `public_meeting_notices`) pokazuje wyłącznie najnowsze ZATWIERDZONE zawiadomienie zebrania OGÓLNEGO (nie klasowego i nie zarządu), bez powodu odwołania i bez opisów punktów; zebranie cofnięte do szkicu znika. Założenie zachowawcze: dopóki zawiadomienie o odwołaniu nie jest zatwierdzone, publicznie nadal widać ostatnie zatwierdzone.
- **Zamknięty rok:** nowe tabele mają własny `school_year_id` i odrzucają zapis w zamkniętym roku (`409 school_year_closed`); to samo dla zmian samego zebrania.
- **Poza zakresem (osobne PR-y):** audience `meeting_invitees` (członkowie zarządu, przedstawiciele klas i Komisja Rewizyjna jako konta `users` — dziś odbiorca kampanii to rodzina, więc wymaga to odbiorców-kont i migracji), załącznik `.ics` w samej wiadomości e-mail (`METHOD:REQUEST/CANCEL` po decyzji D-17 o nadawcy; wymaga zmiany modułu e-mail), ponowne sprawdzenie klasy w workerze tuż przed wysyłką (migawka jest zamrożona przy zatwierdzeniu; zmiana logiki workera).
- Zależy od D-16 (szablon wiadomości — treść szkicu jest robocza), D-17 (nadawca, jeden czy obaj opiekunowie), D-21 (termin i forma zawiadomienia, kto jest zapraszany), D-08 (kto zatwierdza wysyłkę), D-10 (konta rodziców).

## Ryzyka i otwarte sprawy

- Reguły quorum i prawa głosu są wpisywane ręcznie; błąd we wpisie da błędny wynik. Przed użyciem na prawdziwych danych potrzebny jest obowiązujący regulamin (D-21).
- Po zatwierdzeniu protokołu nie można poprawić struktury listy obecności; poprawkę opisuje nowa wersja protokołu.
- Treść protokołu jest tekstem wpisanym przez człowieka: system nie wykrywa w niej danych osobowych przed publikacją.
- Retencja protokołów i uchwał wymaga decyzji D-04.
- **Rejestr uchwał (#102):** format numeru (D-15), czy regulamin w ogóle przewiduje uchylanie i zmianę uchwał (D-21), czy dyrekcja widzi rejestr (D-09) — do czasu tych decyzji `resolution_number_pattern` zostaje pusty (brak podpowiedzi), a relacje zmienia/uchyla działają, ale nikt nie musi ich używać. Osoba odpowiedzialna za wykonanie uchwały to konto (`users`); nie przechowujemy w rejestrze nazwisk ani stanowisk poza kontem systemowym.
