# Autoryzacja i zakres ról

Każda chroniona trasa najpierw ładuje aktywną sesję, a następnie aktywne wpisy z tabeli role_grants. Frontend może ukrywać niedostępne funkcje, ale nie jest granicą bezpieczeństwa.

## Semantyka zakresu

- Trasa jawnie podaje dozwolone role. Pusta lub błędna polityka zawsze odmawia dostępu.
- class_id w przydziale ogranicza dostęp do jednej klasy. Brak class_id oznacza zakres wszystkich klas, ale wyłącznie wtedy, gdy dana trasa jawnie dopuszcza tę rolę.
- school_year_id ogranicza przydział do roku szkolnego. Brak wartości oznacza przydział niezależny od roku.
- Przydziały po expires_at nie są ładowane.
- Polityka operacji finansowej może wymagać sesji z potwierdzonym MFA.

Przedstawiciel klasy ma w schemacie obowiązkowy class_id, dlatego nie może przejść kontroli dla innej klasy. Zakresy poszczególnych funkcji nadal wymagają zatwierdzenia szkoły; ten moduł nie przypisuje rolom domyślnych zdolności.

GET /api/access zwraca zalogowanemu użytkownikowi wyłącznie jego własne aktywne przydziały. Nie zwraca danych innych użytkowników.

## PostgreSQL (issue #35) — prototyp

`src/pg/authorization.js` ładuje przydziały z PostgreSQL i używa tej samej funkcji `isAuthorized`. Pomija przydziały wygasłe oraz cofnięte (`revoked_at`). Cofnięcie (`revokeRoleGrant`) nie usuwa wiersza: zapisuje `revoked_at`, `revoked_by` i zdarzenie `role_grant.revoked` w jednej transakcji; działa od następnego żądania. Przydziału nie da się usunąć ani zmienić jego zakresu — nowy zakres to nowy wiersz (trigger z migracji 0004).

Moduły tras używają `requireAccess(request, env, { roles, classId, schoolYearId, requireMfa }, json)`: `401 unauthenticated` bez sesji, `403 forbidden` bez roli, zakresu lub MFA. Trasa dotycząca klasy **musi** podać `classId`, a trasa roczna `schoolYearId`. Bez `classId` bramka bierze pod uwagę wyłącznie przydziały bez `class_id` (`isAuthorizedScoped`, SR-02) — przydział klasowy nie działa wtedy jak szkolny. Ten sam wariant (`isAuthorizedScoped` lub jawne odfiltrowanie przydziałów klasowych) stosują trasy ogólnoszkolne poza `requireAccess`: wpłaty, księga, kampanie e-mail, uzgodnienie wyciągu, eksport roczny, dane finansowe rodzin, zamknięcie roku, dokumenty ogólnoszkolne (SR-01). Operacje finansowe podają `requireMfa: true`. Role `principal` i `audit` nie mają domyślnych uprawnień; trasa dopuszcza je tylko jawnie, po decyzji szkoły.

Import uczniów (`/api/import/*`, #36) dopuszcza role `admin` i `board` z MFA i tylko z przydziałem bez `class_id` (wszystkie klasy) obejmującym wybrany rok. Przydział zarządu ograniczony do klasy nie wystarcza — kontrola jest dodatkowa względem `isAuthorized`, która przy braku `classId` w wymaganiu przepuszcza przydziały klasowe. Zakres ról importu to założenie do decyzji D-08.

## Macierz tras API (issue #4) — testy negatywne

Tabela opisuje stan kodu routera PostgreSQL (`src/pg/app.js`, `ROUTES`), a nie zatwierdzoną politykę. Zakresy ról zarządu, przedstawiciela, dyrekcji i Komisji Rewizyjnej to nadal założenia do decyzji D-08/D-09 (docs/DECISIONS.md). Źródłem prawdy dla testów jest `tests/helpers/route-matrix.js`; `tests/pg-authz-matrix.test.js` wykonuje każdą trasę dla wszystkich aktorów, MFA wł./wył. i każdego zakresu, a meta-test nie przepuści modułu z `ROUTES` ani ścieżki z kodu modułu bez wpisu w macierzy i wiersza w tej tabeli.

Aktorzy testu: admin, zarząd, skarbnik, przedstawiciel 1A, przedstawiciel 1B, Komisja Rewizyjna (`audit`), dyrekcja (`principal`) — wszyscy z przydziałem na rok 1 — oraz zalogowany bez przydziału, przydział wygasły, przydział cofnięty, konto wyłączone, sesja wygasła, sesja cofnięta i brak sesji. Zakresy: **1A** (własna klasa przedstawiciela A), **1B** (inna klasa), **R1** (dane ogólnoszkolne roku 1, bez klasy), **R2** (klasa w innym roku). „Rok 1” = 1A, 1B i R1.

Dla każdego przypadku test sprawdza: status; brak jakichkolwiek syntetycznych znaczników danych w odpowiedzi odmownej; brak w odpowiedzi 2xx znaczników zakresu, do którego aktor nie ma przydziału (np. dane 1B u przedstawiciela 1A, dane roku 2 u zarządu roku 1); brak zapisu w tabelach i dzienniku zdarzeń po odmowie żądania zmieniającego stan.

Wspólne reguły: bez ważnej sesji (brak cookie, sesja wygasła lub cofnięta, konto wyłączone) każda chroniona trasa zwraca `401 unauthenticated`. Przydział wygasły lub cofnięty działa jak brak przydziału. Rola `principal` nie ma dziś dostępu do żadnej trasy chronionej.

| Trasa | Dozwolone role i zakres | MFA | Odmowa dla zalogowanego | Uwagi |
|---|---|---|---|---|
| `GET /api/session` | każdy zalogowany | nie | — | zwraca wyłącznie własną sesję |
| `GET /api/access` | każdy zalogowany | nie | — | wyłącznie własne aktywne przydziały; wygasłe i cofnięte pominięte |
| `POST /api/logout` | każdy (także bez sesji) | nie | — | zawsze 204; po wylogowaniu sesja zwraca 401 |
| `GET /api/payments?schoolYearId=:year` | admin, zarząd, skarbnik — rok 1 | tak | 403 | inny rok: 403 |
| `POST /api/payments` | admin, zarząd, skarbnik — rok 1 | tak | 403 | walidacja klucza i treści przed sprawdzeniem sesji |
| `POST /api/payments/:paymentId/corrections` | admin, zarząd, skarbnik — rok wpłaty | tak | 403 | wpłata z innego roku: 403; nieistniejąca: 404 |
| `POST /api/payments/:paymentId/assignment` | admin, zarząd, skarbnik — rok wpłaty | tak | 403 | jak wyżej |
| `GET /api/public/events` | publiczna | nie | — | tylko opublikowane rewizje, bez danych klas |
| `GET /api/events?schoolYearId=:year` | admin, zarząd — cały rok 1; przedstawiciel — rok 1, tylko wydarzenia własnej klasy | nie | 403 | lista przedstawiciela 1A nie zawiera 1B ani wydarzeń ogólnoszkolnych |
| `POST /api/events` | admin, zarząd — rok 1 (klasa lub ogólnoszkolne); przedstawiciel — własna klasa | nie | 403 | |
| `GET /api/events/:eventId` | jak wyżej | nie | 404 | brak uprawnień nieodróżnialny od braku wydarzenia |
| `PATCH /api/events/:eventId` | jak wyżej | nie | 404 | wydarzenie spoza zakresu nieodróżnialne od braku (SR-07) |
| `POST /api/events/:eventId/submit` | jak wyżej | nie | 404 | |
| `POST /api/events/:eventId/approve` | zarząd — rok 1 | nie | 403 / 404 | 403, gdy aktor widzi wydarzenie (admin, przedstawiciel własnej klasy); 404 poza zakresem podglądu; zasada czterech oczu w bazie |
| `POST /api/events/:eventId/publish` | zarząd — rok 1 | nie | 403 / 404 | jak przy zatwierdzeniu |
| `POST /api/events/:eventId/cancel` | szkic: admin, zarząd — rok 1; przedstawiciel — własna klasa; opublikowane: tylko zarząd | nie | 404 | macierz testuje szkic; opublikowane wydarzenie własnej klasy: przedstawiciel dostaje 403 |
| `GET /api/meetings?schoolYearId=:year` | admin, zarząd, Komisja Rewizyjna — rok 1 | nie | 403 | przedstawiciel: 403 |
| `POST /api/meetings` | admin, zarząd — rok 1 | nie | 403 | |
| `GET /api/meetings/shared-minutes?schoolYearId=:year` | admin, zarząd, Komisja Rewizyjna — rok 1; przedstawiciel — rok 1 | nie | 403 | przedstawiciel widzi protokoły ogólne i własnej klasy, nigdy innej klasy |
| `GET /api/meetings/public-minutes?schoolYearId=:year` | publiczna | nie | — | tylko protokoły o widoczności `public` |
| `GET /api/meetings/resolutions/lookup?schoolYearId=:year&number=:number` | admin, zarząd, Komisja Rewizyjna, skarbnik — rok 1 | nie | 403 | inny rok: 403 |
| `GET /api/meetings/:meetingId` | admin, zarząd, Komisja Rewizyjna — rok 1 | nie | 404 | brak uprawnień nieodróżnialny od braku zebrania (SR-07); przedstawiciel: 404 także dla zebrania własnej klasy |
| `PATCH /api/meetings/:meetingId` | admin, zarząd — rok 1 | nie | 403 | |
| `POST /api/meetings/:meetingId/agenda-items` | admin, zarząd — rok 1 | nie | 403 | |
| `POST /api/meetings/:meetingId/attendance` | admin, zarząd — rok 1 | nie | 403 | |
| `POST /api/meetings/:meetingId/quorum-checks` | admin, zarząd — rok 1 | nie | 403 | |
| `POST /api/meetings/:meetingId/minutes` | admin, zarząd — rok 1 | nie | 403 | |
| `POST /api/meetings/:meetingId/minutes/:minutesId/approval` | admin, zarząd — rok 1 | nie | 403 | |
| `POST /api/meetings/:meetingId/minutes/:minutesId/visibility` | admin, zarząd — rok 1 | nie | 403 | |
| `POST /api/meetings/:meetingId/resolutions` | admin, zarząd — rok 1 | nie | 403 | |
| `PATCH /api/meetings/:meetingId/resolutions/:resolutionId` | admin, zarząd — rok 1 | nie | 403 | |
| `POST /api/meetings/:meetingId/resolutions/:resolutionId/corrections` | admin, zarząd — rok 1 | nie | 403 | |

Uwagi do decyzji (nie są rozstrzygnięciem): wydarzenia i zebrania nie wymagają dziś MFA, także zatwierdzanie i publikacja; admin techniczny może tworzyć i edytować szkice wydarzeń oraz zarządzać zebraniami; Komisja Rewizyjna czyta również projekty protokołów. Każde z tych zachowań wymaga potwierdzenia w D-08/D-09.

Dodając moduł do `ROUTES` lub ścieżkę do istniejącego modułu: dopisz wpis w `tests/helpers/route-matrix.js` (role, MFA, zakres, przykładowa treść) i wiersz w tej tabeli.
