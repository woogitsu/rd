# Autoryzacja i zakres ról

Każda chroniona trasa najpierw ładuje aktywną sesję, a następnie aktywne wpisy z tabeli role_grants. Frontend może ukrywać niedostępne funkcje, ale nie jest granicą bezpieczeństwa.

## Semantyka zakresu

- Trasa jawnie podaje dozwolone role. Pusta lub błędna polityka zawsze odmawia dostępu.
- class_id w przydziale ogranicza dostęp do jednej klasy. Brak class_id oznacza zakres wszystkich klas, ale wyłącznie wtedy, gdy dana trasa jawnie dopuszcza tę rolę.
- school_year_id ogranicza przydział do roku szkolnego. Brak wartości oznacza przydział niezależny od roku.
- Przydziały po expires_at nie są ładowane.
- Polityka operacji finansowej może wymagać sesji z potwierdzonym MFA.

Przedstawiciel klasy ma w schemacie obowiązkowy class_id, dlatego nie może przejść kontroli dla innej klasy. Które role widzą które dane w poszczególnych modułach nadal wymaga zatwierdzenia szkoły (D-08/D-09, docs/DECISIONS.md) — ten dokument opisuje wyłącznie mechanizm sprawdzenia sesji/roli/zakresu, nie listę uprawnień. Same stałe ról (`FINANCIAL_ROLES`, `WIDE_ROLES`, `EDITOR_ROLES`…) są dziś wpisane na stałe w 13 modułach tras (`src/pg/routes/*.js`) jako założenie prototypu — do zatwierdzenia lub odrzucenia wierszami w `docs/PRODUCT.md` i `docs/DECISIONS.md` (#163). Do tego czasu obowiązują te założenia, a nie brak dostępu.

GET /api/access zwraca zalogowanemu użytkownikowi wyłącznie jego własne aktywne przydziały. Nie zwraca danych innych użytkowników.

## PostgreSQL (issue #35) — prototyp

`src/pg/authorization.js` ładuje przydziały z PostgreSQL i używa tej samej funkcji `isAuthorized`. Pomija przydziały wygasłe oraz cofnięte (`revoked_at`). Cofnięcie (`revokeRoleGrant`) nie usuwa wiersza: zapisuje `revoked_at`, `revoked_by` i zdarzenie `role_grant.revoked` w jednej transakcji; działa od następnego żądania. Przydziału nie da się usunąć ani zmienić jego zakresu — nowy zakres to nowy wiersz (trigger z migracji 0004).

Moduły tras używają `requireAccess(request, env, { roles, classId, schoolYearId, requireMfa }, json)`: `401 unauthenticated` bez sesji, `403 forbidden` bez roli, zakresu lub MFA. Trasa dotycząca klasy **musi** podać `classId`, a trasa roczna `schoolYearId`. Bez `classId` bramka bierze pod uwagę wyłącznie przydziały bez `class_id` (`isAuthorizedScoped`, SR-02) — przydział klasowy nie działa wtedy jak szkolny. Ten sam wariant (`isAuthorizedScoped` lub jawne odfiltrowanie przydziałów klasowych) stosują trasy ogólnoszkolne poza `requireAccess`: wpłaty, księga, kampanie e-mail, uzgodnienie wyciągu, eksport roczny, dane finansowe rodzin, zamknięcie roku, dokumenty ogólnoszkolne (SR-01). Operacje finansowe podają `requireMfa: true`. Role `principal` i `audit` nie mają domyślnych uprawnień; trasa dopuszcza je tylko jawnie, po decyzji szkoły.

Trasy, dla których rozróżnienie powodu odmowy ma znaczenie dla ekranu logowania — dziś lista klasy (`GET /api/exports/class-roster`) i raport Komisji Rewizyjnej (`GET /api/reports/audit`), bo ich role (`representative`, `audit`) nie są domyślnie na liście `MFA_REQUIRED_ROLES` — używają zamiast ogólnego `403 forbidden` funkcji `mfaAwareForbiddenCode(context, requirement, env)` (`src/pg/authorization.js`): najpierw sprawdza rolę i zakres **bez** `requireMfa` (sama odmowa z powodu roli/zakresu zostaje `forbidden` i nie ujawnia stanu MFA konta ani istnienia zasobu, SR-07), a dopiero gdy to przechodzi, zwraca `403 mfa_required` (czynnik zapisany, sesja bez potwierdzonego kodu) albo `403 mfa_enrollment_required` (konto bez czynnika) — #161. Kolejność sprawdzeń (najpierw zakres) jest bez zmian; zmienia się tylko treść pola `error` w odpowiedzi. Konto z już zapisanym, ale w tej sesji niepotwierdzonym czynnikiem i tak dostanie `mfa_required` wcześniej, na poziomie bramki routera (`mfaGate`, reguła 1 niżej) — dla **dowolnej** chronionej trasy, niezależnie od zakresu.

Reguła ogólna (#161, kryterium „każda rola × każda trasa z MFA”): dla każdej roli z `ROLES` i każdej trasy z `requireMfa`, która tę rolę dopuszcza, odmowa wyłącznie z powodu MFA prowadzi do zapisu MFA — dla ról z `MFA_REQUIRED_ROLES` robi to bramka routera, dla pozostałych kod odmowy trasy (`mfa_enrollment_required`/`mfa_required`, klient odsyła na `/login/` do zapisu). Pilnują tego testy generowane z macierzy: `tests/pg-authz-matrix.test.js` sprawdza kod `error` każdej takiej odmowy (`mfaOnlyDenial` w `tests/helpers/route-matrix.js`), a `tests/mfa-route-role-policy.test.js` — że macierz obejmuje każdą rolę, że żadna trasa nie odpowiada roli spoza listy celowym 404 bez MFA i że każda para „rola spoza listy × trasa z MFA” jest opisana w tabeli niżej kodem `mfa_enrollment_required`. Lista `MFA_REQUIRED_ROLES` zostaje bez zmian (admin, zarząd, skarbnik) — to założenie do D-10; zapis MFA dla przedstawiciela i Komisji Rewizyjnej jest dobrowolny albo wywołany odmową trasy.

Import uczniów (`/api/import/*`, #36) dopuszcza role `admin` i `board` z MFA i tylko z przydziałem bez `class_id` (wszystkie klasy) obejmującym wybrany rok. Przydział zarządu ograniczony do klasy nie wystarcza. `requireAccess` (bez `classId` w wymaganiu) już odfiltrowuje przydziały klasowe (`isAuthorizedScoped`, SR-02, akapit wyżej) — moduł importu dodatkowo powtarza ten sam filtr wprost (`qualifyingGrants`, `!grant.classId`), zanim policzy, czy przydział obejmuje wybrany rok. To powtórzenie, nie inna reguła: usunięcie go nie zmieniłoby dziś zachowania, zostaje jako obrona w głąb dla modułu przetwarzającego dane importu z plików. Zakres ról importu to założenie do decyzji D-08.

## Stan roli i konto bez funkcji (#176)

Nadanie roli, która dziś nie daje żadnej trasy chronionej (np. `principal`, decyzja D-09 nierozstrzygnięta — docs/DECISIONS.md), tworzy konto z danymi osobowymi bez celu (D-01/D-06). `ROLE_STATUS` w `src/pg/auth.js` jest jedynym źródłem prawdy o tym, co rola dziś potrafi — `'active'` (co najmniej jedna trasa), `'partial'` (`audit`: tylko raport Komisji Rewizyjnej — #137), `'pending_decision'` (`principal`: żadna trasa). Z tego wynikają trzy zachowania:

- `POST /api/admin/invitations` i `POST /api/admin/grants` odrzucają rolę `pending_decision` kodem `422 role_pending_decision`, chyba że `ALLOW_PENDING_ROLES=true` (przygotowanie kont z wyprzedzeniem przed D-09, testy).
- `resolveScope` (`src/pg/routes/admin.js`) odrzuca `classId` dla roli bez tras klasowych (`CLASS_SCOPE_ROLES` — dziś tylko `representative`) kodem `422 class_scope_not_supported`; dotychczas taki przydział zapisywał się i po cichu nie robił niczego.
- `GET /api/access` zwraca dodatkowo `hasActiveRole` (`false`, gdy żaden aktywny przydział konta nie ma statusu innego niż `pending_decision`). Ekran startowy `login/` pokazuje wtedy komunikat o braku uprawnień zamiast listy paneli kończących się odmową (lista startowa dla pozostałych kont pochodzi z `visiblePanels` — panele wynikające z przydziałów, bez stałej listy dla każdej roli; to nawigacja, dostęp egzekwuje serwer); treść komunikatu (kontakt, dokładne sformułowanie) czeka na zatwierdzenie przez zarząd, dziś jest robocza i nie obiecuje funkcji, których nie ma (AGENTS.md).

Istniejące przed tą zmianą przydziały klasowe dla ról spoza `CLASS_SCOPE_ROLES` (jeśli takie powstały) nie są usuwane ani migrowane — nowa reguła działa tylko dla przyszłych zaproszeń/nadań. Przegląd takich wierszy (`SELECT * FROM role_grants WHERE role NOT IN ('representative') AND class_id IS NOT NULL`) zostawiamy administratorowi jako zapytanie, nie migrację danych.

## Macierz tras API (issue #4) — testy negatywne

Tabela opisuje **zamierzoną** politykę tras routera PostgreSQL (`src/pg/app.js`, `ROUTES`) wynikającą z dokumentacji modułów, a nie zatwierdzone przez szkołę kompetencje. Zakresy ról zarządu, przedstawiciela, dyrekcji i Komisji Rewizyjnej to nadal założenia do decyzji D-08/D-09 (docs/DECISIONS.md). Źródłem prawdy dla testów jest `tests/helpers/route-matrix.js`; `tests/pg-authz-matrix.test.js` wykonuje każdą trasę dla wszystkich aktorów, MFA wł./wył. i każdego zakresu, a meta-test nie przepuści modułu z `ROUTES` ani ścieżki z kodu modułu bez wpisu w macierzy i wiersza w tej tabeli. Gdzie kod odbiega od zamierzonej polityki, przypadki są oznaczone w macierzy jako `todo`: nadal się wykonują, ale ich rozbieżność trafia do osobnego testu „znana luka”, więc CI jest zielone, a luka pozostaje widoczna (sekcja „Znane luki” niżej).

Aktorzy testu: admin, zarząd, skarbnik, przedstawiciel 1A, przedstawiciel 1B, **zarząd z przydziałem ograniczonym do klasy 1A**, Komisja Rewizyjna (`audit`), dyrekcja (`principal`) — wszyscy z przydziałem na rok 1 — oraz zalogowany bez przydziału, przydział wygasły, przydział cofnięty, konto wyłączone, sesja wygasła, sesja cofnięta i brak sesji. Zakresy: **1A** (własna klasa przedstawiciela A), **1B** (inna klasa), **R1** (dane ogólnoszkolne roku 1, bez klasy), **R2** (klasa albo dane innego roku). „Rok 1” = 1A, 1B i R1. Zarząd z przydziałem klasy 1A ma — zgodnie z semantyką `class_id` — co najwyżej uprawnienia zarządu w klasie 1A (tam, gdzie moduł dopuszcza zarząd w zakresie klasy) i nigdy do danych ogólnoszkolnych: finansów, kampanii e-mail, eksportu rocznego, importu, uzgodnień, raportu i zamknięcia roku.

Dla każdego przypadku test sprawdza: status; brak jakichkolwiek syntetycznych znaczników danych w odpowiedzi odmownej; brak w odpowiedzi 2xx znaczników zakresu, do którego aktor nie ma przydziału (np. dane 1B u przedstawiciela 1A, dane roku 2 u zarządu roku 1); brak zapisu w tabelach i dzienniku zdarzeń po odmowie żądania zmieniającego stan (liczniki ok. 50 tabel, w tym `audit_events`). Wybrane trasy mają dodatkowe asercje: rodzaje dokumentów na liście, lista klas, kwoty na kartkach tylko przy MFA. Dane są syntetyczne; dokumenty trafiają do magazynu w pamięci, żadna trasa nie wysyła poczty (kampanie trafiają najwyżej do kolejki), a trasy zamknięcia roku mają osobną bazę, bo zamknięcie wygasza przydziały roku 1.

Identyfikatory w **treści** żądania (nie w ścieżce) opisuje osobna lista `REFERENCE_CASES` w `tests/helpers/route-matrix.js` (#205, SR-07): `guardianId` i `userId` w `POST /api/meetings/:id/attendance` oraz `householdId` w `POST /api/payments`, `/assignment` i `/allocations`. Test sprawdza, że identyfikator spoza zakresu (opiekun z innej klasy albo roku, konto bez przydziału w roku zebrania, gospodarstwo zarchiwizowane, bez ucznia w roku wpłaty albo z dzieckiem tylko w innym roku) i identyfikator nieistniejący dają **identyczną** odpowiedź (`400 invalid_reference`, ten sam tekst) oraz nie zmieniają żadnej tabeli — odpowiedź nie jest wyrocznią istnienia. Kontrola zakresu jest po stronie serwera: w bazie (trigger `meeting_attendee_guard`, migracje `0037` i `0150`) i w `assertHouseholdInScope` (`src/pg/routes/payments.js`). Przedstawiciel klasy prowadzący zebranie (flaga `MEETINGS_CLASS_HOST`) zapisuje wyłącznie siebie albo opiekuna z własnej klasy; cudze konto dostaje `403 forbidden` także wtedy, gdy nie istnieje (`tests/pg-meetings-class-host.test.js`).

Wspólne reguły: bez ważnej sesji (brak cookie, sesja wygasła lub cofnięta, konto wyłączone) każda chroniona trasa zwraca `401 unauthenticated`. Przydział wygasły lub cofnięty działa jak brak przydziału. Rola `principal` nie ma dziś dostępu do żadnej trasy chronionej; `audit` — wyłącznie do odczytu zebrań, wyszukiwania uchwał i raportu dla Komisji Rewizyjnej.

Bramka MFA routera (issue #3, `src/pg/mfa-policy.js`, opis w [AUTH.md](AUTH.md)): sesja bez potwierdzonego MFA konta z aktywną rolą z `MFA_REQUIRED_ROLES` (domyślnie admin, zarząd, skarbnik) i bez zapisanego czynnika dostaje `403 mfa_enrollment_required` na każdej trasie poza zwolnionymi (sesja, przydziały, wylogowanie, logowanie, MFA, trasy publiczne); konto z zapisanym czynnikiem i sesją bez MFA — `403 mfa_required`. Dlatego w macierzy admin, zarząd i skarbnik z „MFA wył.” dostają 403 także na trasach z kolumną MFA = „nie” (`mfaGateBlocks` w `tests/helpers/route-matrix.js`). Kolumna MFA niżej opisuje wymóg samej trasy (`requireMfa`).

| Trasa | Dozwolone role i zakres | MFA | Odmowa dla zalogowanego | Uwagi |
|---|---|---|---|---|
| `GET /api/session` | każdy zalogowany | nie | — | zwraca wyłącznie własną sesję |
| `GET /api/access` | każdy zalogowany | nie | — | wyłącznie własne aktywne przydziały; wygasłe i cofnięte pominięte; sesja czekająca na MFA (bramka by ją zatrzymała): pusta lista i `mfaRequired` (#189) |
| `POST /api/logout` | każdy (także bez sesji) | nie | — | zawsze 204; po wylogowaniu sesja zwraca 401 |
| `GET /api/payments?schoolYearId=:year` | admin, zarząd, skarbnik — rok 1 | tak | 403 | inny rok: 403 |
| `POST /api/payments` | admin, zarząd, skarbnik — rok 1 | tak | 403 | walidacja klucza i treści przed sprawdzeniem sesji |
| `POST /api/payments/:paymentId/corrections` | admin, zarząd, skarbnik — rok wpłaty | tak | 403 | wpłata z innego roku: 403; nieistniejąca: 404 |
| `POST /api/payments/:paymentId/assignment` | admin, zarząd, skarbnik — rok wpłaty | tak | 403 | jak wyżej |
| `POST /api/payments/:paymentId/refunds` | admin, zarząd, skarbnik — rok wpłaty | tak | 403 | zwrot jako osobny, niezmienny zapis (#138); powiązanie z księgą o innym netto: 409 `ledger_correction_required` |
| `POST /api/payments/:paymentId/reassignment` | admin, zarząd, skarbnik — rok wpłaty | tak | 403 | ponowne przypisanie jako osobne zdarzenie zamiast korekty do zera (#138); historia w `payment_reassignments` |
| `GET /api/payment-references?schoolYearId=:year&householdId=:id` | admin, zarząd, skarbnik — rok 1 | tak | 403 | komunikacja strukturalna OGM-VCS (#83); przedstawiciel zawsze 403 (widoczność ograniczona do własnej klasy jest poza zakresem tego PR — integracja z kartkami #92) |
| `POST /api/payment-references` | admin, zarząd, skarbnik — rok 1 | tak | 403 | generuje aktywną referencję (12 cyfr, suma kontrolna mod 97); aktywna już istnieje: 409 `payment_reference_already_active` |
| `POST /api/payment-references/:id/revoke` | admin, zarząd, skarbnik — rok referencji | tak | 403 | unieważnienie jako osobny, niezmienny zapis (`payment_reference_revocations`); już unieważniona: 409 |
| `GET /api/payments/:paymentId/allocations` | admin, zarząd, skarbnik — rok wpłaty | tak | 403 | części wpłaty, suma przypisana i „nieprzypisana część” (#127); przedstawiciel: 403; nieistniejąca: 404 |
| `POST /api/payments/:paymentId/allocations` | admin, zarząd, skarbnik — rok wpłaty | tak | 403 | podział wyłącznie wpłaty nieprzypisanej, suma części ≤ netto (#127); przedstawiciel: 403 |
| `POST /api/payments/:paymentId/allocations/:allocationId/reversal` | admin, zarząd, skarbnik — rok wpłaty | tak | 403 | cofnięcie części jako nowy zapis z powodem (#127) |
| `GET /api/payment-instructions?schoolYearId=:year` | admin, zarząd, skarbnik — rok 1 | tak | 403 | zatwierdzone dane do wpłaty (#92) do kodu QR EPC; brak zatwierdzonej wersji: `{ paymentInstructions: null }`, status 200 |
| `POST /api/payment-instructions` | admin, zarząd — rok 1 (BEZ skarbnika — wariant zachowawczy do decyzji D-08) | tak | 403 | nowe zatwierdzenie = nowa, niezmienna wersja (IBAN nigdy w metadanych audytu) |
| `GET /api/payments/export.csv?schoolYearId=:year` | admin, zarząd, skarbnik — rok 1 | tak | 403 | eksport CSV (#141): wpisy wpłat + korekty w jednym pliku (`typ_wiersza`); bez imion/nazwisk, bez statusu „dłużnik”; limit `MAX_EXPORT_ROWS`: 413 `export_too_large` |
| `GET /api/public/events` | publiczna | nie | — | tylko opublikowane rewizje, bez danych klas |
| `GET /api/events?schoolYearId=:year` | admin, zarząd — cały rok 1; przedstawiciel — rok 1, tylko wydarzenia własnej klasy | nie | 403 | lista przedstawiciela 1A nie zawiera 1B ani wydarzeń ogólnoszkolnych |
| `POST /api/events` | admin, zarząd — rok 1 (klasa lub ogólnoszkolne); przedstawiciel — własna klasa | nie | 403 | |
| `GET /api/events/:eventId` | jak wyżej | nie | 404 | brak uprawnień nieodróżnialny od braku wydarzenia |
| `PATCH /api/events/:eventId` | jak wyżej | nie | 404 | wydarzenie spoza zakresu nieodróżnialne od braku (SR-07) |
| `POST /api/events/:eventId/submit` | jak wyżej | nie | 404 | |
| `POST /api/events/:eventId/approve` | zarząd — rok 1 | tak (#150) | 403 / 404 | 403, gdy aktor widzi wydarzenie (admin, przedstawiciel własnej klasy); 404 poza zakresem podglądu; zasada czterech oczu w bazie |
| `POST /api/events/:eventId/publish` | zarząd — rok 1 | tak (#150) | 403 / 404 | jak przy zatwierdzeniu |
| `POST /api/events/:eventId/cancel` | szkic: admin, zarząd — rok 1; przedstawiciel — własna klasa; opublikowane: tylko zarząd | nie | 404 | macierz testuje szkic; opublikowane wydarzenie własnej klasy: przedstawiciel dostaje 403 |
| `GET /api/events/:eventId/tasks` | jak `PATCH /api/events/:eventId` (ten sam canEdit) | nie | 404 | zadania i zapisy wolontariuszy wydarzenia (#142); wydarzenie spoza zakresu nieodróżnialne od braku (SR-07) |
| `POST /api/events/:eventId/tasks` | jak wyżej | nie | 404 | nowe zadanie wolontariatu |
| `POST /api/events/:eventId/tasks/:taskId/cancel` | jak wyżej | nie | 404 | odwołanie zadania |
| `POST /api/events/:eventId/tasks/:taskId/signups` | jak wyżej | nie | 404 | zapis opiekuna/konta na zadanie |
| `POST /api/events/:eventId/tasks/:taskId/signups/:signupId/withdraw` | jak wyżej | nie | 404 | wypisanie się z zadania |
| `GET /api/meetings?schoolYearId=:year` | admin, zarząd, Komisja Rewizyjna — rok 1; zarząd z przydziałem klasy — rok 1, tylko zebrania tej klasy | nie | 403 | przedstawiciel: 403 |
| `POST /api/meetings` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | |
| `GET /api/meetings/shared-minutes?schoolYearId=:year` | admin, zarząd, Komisja Rewizyjna — rok 1; przedstawiciel — rok 1 | nie | 403 | przedstawiciel widzi protokoły ogólne i własnej klasy, nigdy innej klasy |
| `GET /api/meetings/public-minutes?schoolYearId=:year` | publiczna | nie | — | tylko protokoły o widoczności `public` |
| `GET /api/meetings/resolutions/lookup?schoolYearId=:year&number=:number` | admin, zarząd, Komisja Rewizyjna, skarbnik — rok 1 | nie | 403 | inny rok: 403 |
| `GET /api/meetings/:meetingId` | admin, zarząd, Komisja Rewizyjna — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | nie | 404 | brak uprawnień nieodróżnialny od braku zebrania (SR-07); przedstawiciel: 404 także dla zebrania własnej klasy |
| `GET /api/meetings/:meetingId/approval-checklist` | jak `GET /api/meetings/:meetingId` (admin, zarząd, Komisja Rewizyjna — rok 1; zarząd z przydziałem klasy — zebrania tej klasy); tylko odczyt (#81) | nie | 404 | brak uprawnień nieodróżnialny od braku zebrania (SR-07); przedstawiciel: 404 także dla własnej klasy; bez wpisu w audit_events |
| `PATCH /api/meetings/:meetingId` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy; #171: przedstawiciel-gospodarz własnej klasy | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/agenda-items` | jak wyżej | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/cancellation` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | #113: powód 3–500 znaków, przejście `draft|scheduled → cancelled`; przedstawiciel-gospodarz (#171) nie odwołuje; powtórka z tym samym powodem to `200` z `replayed` |
| `POST /api/meetings/:meetingId/reschedule` | jak wyżej | tak (#150) | 403 | #113: nowy termin z powodem; po zatwierdzonym zawiadomieniu powstaje wyłącznie szkic zawiadomienia o zmianie terminu |
| `POST /api/meetings/:meetingId/agenda-items/:itemId/withdrawal` | jak `POST …/agenda-items` | tak (#150) | 403 | #113: wycofanie punktu (wiersz zostaje) |
| `POST /api/meetings/:meetingId/notices` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | #113: szkic zawiadomienia z migawką porządku obrad; przedstawiciel-gospodarz: 403 |
| `POST /api/meetings/:meetingId/notices/:noticeId/approval` | jak wyżej | tak (#150) | 403 | #113: zatwierdza inna osoba niż autor (`403 notice_four_eyes_required`); odsłania zawiadomienie zebrania ogólnego na stronie publicznej |
| `POST /api/meetings/:meetingId/notices/:noticeId/campaign-draft` | jak wyżej | tak (#150) | 403 | #113: wyłącznie SZKIC kampanii z zatwierdzonego zawiadomienia; listę odbiorców i wysyłkę zatwierdza się w module e-mail (`board`, cztery oczy) |
| `GET /api/meetings/public-notices?schoolYearId=:year` | publiczna | nie | — | #113: tylko najnowsze zatwierdzone zawiadomienie zebrania ogólnego, bez powodu odwołania i opisów punktów |
| `POST /api/meetings/:meetingId/attendance` | jak wyżej | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/quorum-checks` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/minutes` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy; #171: przedstawiciel-gospodarz własnej klasy | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/minutes/:minutesId/approval` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | #135: zatwierdzający ≠ autor wersji (`403 minutes_four_eyes_required`) |
| `POST /api/meetings/:meetingId/minutes/:minutesId/visibility` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/resolutions` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | |
| `PATCH /api/meetings/:meetingId/resolutions/:resolutionId` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/resolutions/:resolutionId/corrections` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | #135: korekta zawsze zapisuje rozstrzygnięcie |
| `GET /api/meetings/resolutions?schoolYearId=:year` | admin, zarząd, Komisja Rewizyjna — rok 1; zarząd z przydziałem klasy — tylko uchwały zebrań tej klasy | nie | 403 | #102: rejestr roku; przyjmuje też `status=`, `q=` i `executionStatus=` (filtry, nieujęte w ścieżce macierzy); przedstawiciel: 403; macierz sprawdza tylko granicę roli (pusty rejestr), zakres klasowy ma dedykowany test w `tests/pg-meetings-resolutions.test.js` |
| `POST /api/meetings/resolutions/:resolutionId/execution` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | #102: dopisywanie zdarzenia wykonania; działa też po zatwierdzeniu protokołu (osobna tabela, nie objęta blokadą zebrania); MFA po scaleniu z #150 — trasa idzie przez `meetingForManage`, które od #150 zawsze wymaga świeżo potwierdzonego MFA |
| `GET /api/import/options` | admin, zarząd — przydział bez klasy | tak | 403 | tylko lata z przydziału; zarząd z przydziałem klasy: 403 |
| `POST /api/import/preview` | admin, zarząd — przydział bez klasy obejmujący rok importu | tak | 403 | nic nie zapisuje; inny rok: 403 |
| `POST /api/import/commit` | jak wyżej | tak | 403 | wymaga podglądu (fingerprint, planDigest) i Idempotency-Key |
| `POST /api/documents?kind=financial&schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | inny rok: 403 |
| `POST /api/documents?kind=board&schoolYearId=:year` | admin, zarząd — przydział bez klasy, rok 1 | nie | 403 | skarbnik, przedstawiciel: 403 |
| `POST /api/documents?kind=class&schoolYearId=:year&classId=:class` | admin, zarząd — klasy roku 1; przedstawiciel i zarząd z przydziałem klasy — własna klasa | nie | 403 | |
| `GET /api/documents?schoolYearId=:year` | admin, zarząd — rok 1 (finansowe tylko z MFA); skarbnik — finansowe, z MFA; przedstawiciel i zarząd z przydziałem klasy — dokumenty własnej klasy | skarbnik: tak | 403 | przydział klasowy roku 1 i rok 2: 403, nie pusta lista (DOC-01, naprawione) |
| `GET /api/documents/:financialDocumentId` | admin, zarząd, skarbnik — przydział bez klasy, rok dokumentu | tak | 404 | brak uprawnień lub MFA nieodróżnialny od braku dokumentu |
| `GET /api/documents/:boardDocumentId` | admin, zarząd — przydział bez klasy, rok dokumentu | nie | 404 | |
| `GET /api/documents/:classDocumentId` | admin, zarząd — klasy roku 1; przedstawiciel i zarząd z przydziałem klasy — własna klasa | nie | 404 | |
| `GET /api/documents/:financialDocumentId/content` | jak metadane dokumentu finansowego | tak | 404 | odmowa zapisuje `document.access_denied`, pobranie — `document.downloaded`; `?disposition=inline` (podgląd PDF/PNG/JPEG, ta sama macierz) — `document.viewed` |
| `GET /api/documents/:boardDocumentId/content` | jak metadane dokumentu zarządu | nie | 404 | |
| `GET /api/documents/:classDocumentId/content` | jak metadane dokumentu klasy | nie | 404 | |
| `POST /api/documents/:financialDocumentId/supersede` | admin, zarząd, skarbnik — przydział bez klasy, rok dokumentu | tak | 404 | issue #82: te same reguły dostępu co odczyt dokumentu finansowego (canAccessDocument); zastąpienie tylko dokumentem tego samego rodzaju/roku/klasy; powtórka tym samym kluczem — `replayed:true` |
| `POST /api/documents/:boardDocumentId/supersede` | admin, zarząd — przydział bez klasy, rok dokumentu | nie | 404 | issue #82: te same reguły dostępu co odczyt dokumentu zarządu; skarbnik, przedstawiciel — 404 |
| `POST /api/documents/:classDocumentId/supersede` | admin, zarząd — klasy roku 1; przedstawiciel i zarząd z przydziałem klasy — własna klasa | nie | 404 | issue #82: zastąpienie tylko dokumentem tego samego rodzaju/roku/klasy; powtórka tym samym kluczem — `replayed:true` |
| `POST /api/documents/:financialDocumentId/void` | jak wyżej (supersede, dokument finansowy) | tak | 404 | issue #82: unieważnienie bez usuwania pliku; ponowne unieważnienie tego samego dokumentu — `replayed:true`, inna akcja — 409 |
| `POST /api/documents/:boardDocumentId/void` | jak wyżej (supersede, dokument zarządu) | nie | 404 | issue #82: unieważnienie bez usuwania pliku; ponowne unieważnienie tego samego dokumentu — `replayed:true`, inna akcja — 409 |
| `POST /api/documents/:classDocumentId/void` | jak wyżej (supersede, dokument klasy) | nie | 404 | issue #82: unieważnienie bez usuwania pliku; ponowne unieważnienie tego samego dokumentu — `replayed:true`, inna akcja — 409 |
| `POST /api/documents/:financialDocumentId/description` | jak metadane dokumentu finansowego | tak | 404 | tytuł/kategoria (#76); dopisuje wersję, `documents` niezmienne |
| `POST /api/documents/:boardDocumentId/description` | jak metadane dokumentu zarządu | nie | 404 | #76 |
| `POST /api/documents/:classDocumentId/description` | jak metadane dokumentu klasy | nie | 404 | #76 |
| `GET /api/ledger?schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | zarząd z przydziałem klasy: 403 (SR-01) |
| `GET /api/ledger/categories?schoolYearId=:year` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/ledger/summary?schoolYearId=:year` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/ledger/budget?schoolYearId=:year` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/ledger/export.csv?schoolYearId=:year` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/ledger/export.xlsx?schoolYearId=:year` | jak wyżej | tak | 403 | SR-01; te same dane co CSV (#121), zdarzenie `ledger.exported` z `format: xlsx` |
| `POST /api/ledger` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/ledger/:ledgerEntryId/corrections` | jak wyżej, rok wpisu | tak | 403 | SR-01 |
| `POST /api/ledger/:ledgerEntryId/replacement` | jak wyżej, rok wpisu | tak | 403 | SR-01; przeksięgowanie (storno + wpis zastępczy) atomowo (#144); wpis powiązany z wpłatą przechodzi na wpis zastępczy (0142, kwota = netto wpłaty); szkic uzgodnienia z powiązaniem wpisu: 409 `active_bank_match`; wpis już zastąpiony: 409 `ledger_entry_already_replaced` |
| `POST /api/ledger/categories/:categoryId/deactivation` | jak wyżej, rok kategorii | tak | 403 | #107; wpis historii z powodem; już wyłączona: 409 `category_inactive` |
| `POST /api/ledger/budget` | jak wyżej | tak | 403 | #107; pierwsza wersja linii; kolejna: 409 `budget_line_exists` |
| `POST /api/ledger/budget/:lineId/revisions` | jak wyżej, rok linii | tak | 403 | #107; nowa wersja z `supersedes_id`; nieaktualna wersja lub równoległa rewizja: 409 `budget_line_superseded` |
| `POST /api/ledger/budget/adoptions` | zarząd — przydział bez klasy, rok 1 | tak | 403 | #107; admin i skarbnik: 403; fotografia bieżących wersji linii, opcjonalnie z uchwałą zebrania ogólnego |
| `GET /api/ledger/budget/history?schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | #107; wszystkie wersje linii i przyjęcia |
| `GET /api/ledger/budget/execution?schoolYearId=:year` | jak wyżej | tak | 403 | #107; plan vs wykonanie, `format` = json, csv albo html; KR widzi zestawienie w raporcie (D-09) |
| `GET /api/ledger/reviews?schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | #97; stan weryfikacji wydatków, filtr `reviewStatus` |
| `POST /api/ledger/:ledgerEntryId/reviews` | jak wyżej, rok wpisu; nie autor wpisu | tak | 403 | #97; autor wpisu: 403 `four_eyes_required` (także trigger bazy); przychód: 409 `review_expense_only`; zamknięty rok: 409 |
| `GET /api/ledger/resolutions?schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | #93; przyjęte uchwały zebrań ogólnych roku i roku poprzedniego: numer, tytuł, kwoty — bez treści (D-09) |
| `POST /api/ledger/resolutions/:resolutionId/authorizations` | admin, zarząd — przydział bez klasy w roku uchwały | tak | 403 | #93; skarbnik: 403; uchwała spoza zakresu lub nieistniejąca: 404; zmiana kwoty = nowy wiersz z `supersedesId` (nieaktualny: 409 `authorization_superseded`) |
| `GET /api/ledger/cost-centers?schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | SR-01; centra kosztów (#117), `type=event\|class`, `format=json\|csv`: wynik per wydarzenie/klasa + „ogólne”; przedstawiciel, audit, principal 403 (D-08/D-09) |
| `GET /api/ledger/:ledgerEntryId/allocations` | jak wyżej, rok wpisu | tak | 403 | SR-01; historia wersji przypisania (#117) |
| `POST /api/ledger/:ledgerEntryId/allocations` | jak wyżej, rok wpisu | tak | 403 | SR-01; nowa wersja przypisania (#117); nieaktualna `supersedesId`: 409 `allocation_version_conflict` |
| `GET /api/ledger/cost-centers/events/:eventId` | jak wyżej, rok wydarzenia | tak | 403 | SR-01; rozliczenie wydarzenia (#117); nieistniejące: 404 |
| `GET /api/ledger/transfers?schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | #199 |
| `POST /api/ledger/transfers` | jak wyżej | tak | 403 | #199; przeniesienie kasa ↔ rachunek, storno jako nowy wpis |
| `GET /api/ledger/opening-balance?schoolYearId=:year` | jak wyżej | tak | 403 | #199 |
| `POST /api/ledger/opening-balance` | zarząd — przydział bez klasy, rok 1 | tak | 403 | #199; admin i skarbnik: 403; tylko pierwszy rok (409 `not_first_school_year`) |
| `POST /api/ledger/opening-balance/adjustments` | zarząd — przydział bez klasy, rok 1 | tak | 403 | #199; admin i skarbnik: 403; zamknięty rok: 409 |
| `POST /api/ledger/categories` | admin, zarząd, skarbnik — przydział bez klasy, rok kategorii | tak | 403 | SR-01; nagłówek `Idempotency-Key` opcjonalny (#207 bez niego, #107/ledger-budget.js z nim zawsze) — bez klucza: ta sama nazwa+kierunek+rok co istniejąca kategoria zwraca 200 z istniejącym wierszem (podwójne kliknięcie), nie 201; z kluczem: ten sam klucz i treść — 200 (replay); ten sam klucz, inna treść — 409 `idempotency_conflict`; nowy klucz na zajętą nazwę+kierunek+rok — 409 `category_exists`; zamknięty rok: 409 `school_year_closed` (trigger a0_year_freeze z 0017, bez zmian w #207) |
| `POST /api/ledger/categories/:categoryId/deactivate` | jak wyżej, rok kategorii (sprawdzany po odczycie wiersza) | tak | 403 / 404 | już nieaktywna: 200 bez drugiego zdarzenia audytu (idempotentne) |
| `POST /api/ledger/categories/copy` | jak wyżej, przydział bez klasy w roku DOCELOWYM (rok źródłowy nie wymaga osobnego dostępu — kopiowane są wyłącznie nazwy i kierunki kategorii, bez kwot) | tak | 403 | #207; `dryRun: true` — podgląd bez zapisu; zapis: jeden wielowierszowy INSERT z `ON CONFLICT … DO NOTHING`, nie duplikuje przy ponowieniu; zamknięty rok docelowy: 409 `school_year_closed` |
| `GET /api/email/campaigns?schoolYearId=:year` | zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | admin techniczny: 403; SR-01 |
| `POST /api/email/campaigns` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/email/campaigns/:campaignId` | jak wyżej, rok kampanii | tak | 403 | SR-01 |
| `PUT /api/email/campaigns/:campaignId` | jak wyżej | tak | 403 | zmiana cofa zatwierdzenie; SR-01 |
| `POST /api/email/campaigns/:campaignId/snapshot` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/email/campaigns/:campaignId/preview` | jak wyżej | tak | 403 | bez wysyłki; SR-01 |
| `GET /api/email/campaigns/:campaignId/recipients` | jak wyżej | tak | 403 | odczyt w dzienniku; SR-01 |
| `GET /api/email/campaigns/:campaignId/report` | jak wyżej | tak | 403 | wyłącznie agregaty, bez adresów/imion/identyfikatorów rodzin (#139); `?format=csv` — plik z tymi samymi liczbami, pobranie w dzienniku (`email.report.exported`) |
| `GET /api/email/campaigns/:campaignId/attention` | jak wyżej | tak | 403 | adres maskowany, odczyt w dzienniku (`email.attention_list.viewed`, #139) |
| `POST /api/email/campaigns/:campaignId/approve` | zarząd — przydział bez klasy, rok 1; inna osoba niż autor | tak, krok w górę: ≤15 min (#150) | 403 | skarbnik: 403; SR-01; MFA starsze niż 15 min → `403 mfa_stale` |
| `POST /api/email/campaigns/:campaignId/queue` | zarząd, skarbnik — jak wyżej | tak | 403 | tylko kolejka, bez wysyłki; SR-01 |
| `POST /api/email/campaigns/:campaignId/resolutions` | zarząd, skarbnik — jak wyżej | tak | 403 | `confirmed_not_sent` wymaga zarządu; podwójne kliknięcie zwraca istniejący zapis (#139) |
| `POST /api/email/campaigns/:campaignId/pause` | zarząd, skarbnik — jak wyżej | tak | 403 | wstrzymanie wysyłki (#130); SR-01 |
| `POST /api/email/campaigns/:campaignId/resume` | zarząd, skarbnik — jak wyżej | tak | 403 | wznowienie (#130); SR-01 |
| `POST /api/email/campaigns/:campaignId/cancel` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/email/campaigns/:campaignId/test-send` | zarząd, skarbnik — jak wyżej | tak | 403 | tylko adres z `EMAIL_PREVIEW_RECIPIENTS`, nie adres opiekuna; `EMAIL_SENDING_ENABLED≠true` → 409 bez sieci; limit 5/kampanię i 20/konto na dobę → 429 (#104) |
| `POST /api/email/webhooks/brevo` | bez sesji; wspólny sekret w `Authorization` | nie | — | brak lub zły sekret: 401 bez zapisu (test uzupełniający) |
| `GET /api/email/suppressions?schoolYearId=:year` | zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | adres tylko maskowany; odczyt w dzienniku; `pendingRequest` bez identyfikatora zgłaszającego (#94) |
| `POST /api/email/suppressions/:emailHash/release-request` | zarząd, skarbnik — jak wyżej | tak | 403 | blokada po `complaint`/`unsubscribed`: tylko powód `parent_request`, inaczej 409; powtórzenie tego samego wniosku zwraca istniejący (#94) |
| `POST /api/email/suppressions/:emailHash/release` | zarząd, skarbnik — jak wyżej; inna osoba niż zgłaszająca wniosek | tak | 403 | ta sama osoba: 403 `self_approval_forbidden`; zużyty wniosek: 409 (#94) |
| `GET /api/email/provider-pause?schoolYearId=:year` | zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | aktywna pauza wysyłki po odmowie konta przez dostawcę (401/402/403) albo `null`; same kody i identyfikatory (#209) |
| `POST /api/email/provider-pause/lift` | zarząd — przydział bez klasy, rok 1 | tak, krok w górę: ≤15 min (jak zatwierdzenie kampanii) | 403 | potwierdzenie naprawy klucza/nadawcy; skarbnik, admin techniczny, przedstawiciel, KR: 403; pauza już zdjęta: 200 bez drugiego zdarzenia (`Idempotency-Replayed`); nieznana: 404 `provider_pause_not_found` (#209) |
| `GET /api/email/preferences?t=:token` | publiczna, bez sesji | nie | — | tylko odczyt kategorii z tokenu, bez skutku; zły/zmieniony token → 400; limit żądań → 429 (#110) |
| `POST /api/email/preferences?t=:token` | publiczna, bez sesji; zwolniona z `Origin` (jak webhook) | nie | — | wypisanie z kategorii kampanii, idempotentne; zły/zmieniony token → 400; limit żądań → 429 (#110) |
| `GET /api/public/news` | publiczna | nie | — | tylko opublikowane wpisy |
| `GET /api/public/news/:postId` | publiczna | nie | 404 | tylko opublikowana wersja niewycofanego wpisu (widok `public_news`); szkic, nieopublikowany, wycofany i nieznany = identyczne 404 (#116) |
| `GET /api/public/news-photos/:photoId/web` | publiczna | nie | 404 | tylko zdjęcie zweryfikowane w opublikowanej wersji; nieznane/niepubliczne = 404 identyczne (#96) |
| `GET /api/public/news-photos/:photoId/thumb` | publiczna | nie | 404 | jak wyżej |
| `GET /api/news?schoolYearId=:year` | admin, zarząd — cały rok 1; przedstawiciel — rok 1, tylko wpisy własnej klasy | nie | 403 | |
| `POST /api/news` | admin, zarząd — rok 1 (klasa lub ogólnoszkolne); przedstawiciel — własna klasa | nie | 403 | zarząd z przydziałem klasy: 403 (szkice klasy tylko przedstawiciel) |
| `GET /api/news/:postId` | jak wyżej | nie | 404 | |
| `PATCH /api/news/:postId` | jak wyżej | nie | 404 | brak uprawnień nieodróżnialny od braku wpisu |
| `POST /api/news/:postId/submit` | jak wyżej | nie | 404 | |
| `POST /api/news/:postId/approve` | zarząd — rok 1 | tak (#150) | 403 / 404 | 403 dla osoby, która może edytować wpis; 404 dla pozostałych |
| `POST /api/news/:postId/publish` | zarząd — rok 1 | tak (#150) | 403 / 404 | jak wyżej |
| `POST /api/news/:postId/withdraw` | nieopublikowany: jak edycja; opublikowany: tylko zarząd | nie | 404 | macierz testuje szkic |
| `GET /api/news-photos` | admin, zarząd — przydział bez klasy | nie | 403 | |
| `POST /api/news-photos` | admin, zarząd — przydział bez klasy | nie | 403 | metadane praw i zgód |
| `GET /api/news-photos/:photoId` | admin, zarząd — przydział bez klasy | nie | 403 | |
| `POST /api/news-photos/:photoId/consents` | admin, zarząd — przydział bez klasy | nie | 403 | |
| `POST /api/news-photos/:photoId/verify` | zarząd — przydział bez klasy; inna osoba niż rejestrująca | nie | 403 | |
| `POST /api/news-photos/:photoId/revoke` | zarząd — przydział bez klasy | nie | 403 | |
| `POST /api/news-photo-consents/:consentDocumentRef/withdraw` | zarząd — przydział bez klasy | nie | 403 | wycofuje jedną zgodę; ukrywa publicznie każde zdjęcie, które się na nią powołuje (#106) |
| `POST /api/news-photos/:photoId/file` | admin, zarząd — przydział bez klasy | nie | 403 | plik obrazu (PNG/JPEG); warianty web/thumb bez EXIF/GPS (#96) |
| `GET /api/admin/users` | wyłącznie admin | tak | 403 | moduł obejmuje konta całej szkoły |
| `POST /api/admin/users/:userId/disable` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/users/:userId/enable` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/users/:userId/revoke-sessions` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/users/:userId/password-reset` | wyłącznie admin | tak, krok w górę: ≤15 min (#150) | 403 | jednorazowy token resetu hasła, zwracany raz; nowy unieważnia poprzedni; MFA starsze niż 15 min → `403 mfa_stale`; konto z rolą admin/board/treasurer (poza własnym) → `202` i wniosek zamiast tokenu (#146) |
| `POST /api/admin/users/:userId/mfa-reset` | wyłącznie admin (nie własne konto) | tak, krok w górę: ≤15 min (#150) | 403 | wymaga `confirm` = id konta; wyłącza czynniki i kody odzyskiwania, wylogowuje konto; MFA starsze niż 15 min → `403 mfa_stale`; konto z rolą admin/board/treasurer → `202` i wniosek zamiast resetu (#146) |
| `GET /api/admin/account-requests` | wyłącznie admin | tak | 403 | wnioski o reset hasła/MFA kont chronionych (#146); bez tokenów |
| `POST /api/admin/account-requests/:requestId/approve` | wyłącznie admin, nie wnioskodawca i nie właściciel konta | tak, krok w górę: ≤15 min (#150) | 403 | zasada czterech oczu (`403 recovery_four_eyes_required`, także `CHECK` w bazie); zamknięty → 409; token resetu zwracany raz zatwierdzającemu |
| `POST /api/admin/account-requests/:requestId/reject` | wyłącznie admin | tak | 403 | odrzucenie lub wycofanie wniosku; zamknięty → 409 |
| `GET /api/admin/grants` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/grants` | wyłącznie admin | tak, krok w górę: ≤15 min (#150) | 403 | nadanie roli; MFA starsze niż 15 min → `403 mfa_stale` |
| `POST /api/admin/grants/:grantId/revoke` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/school-years/:schoolYearId/expire-grants` | wyłącznie admin | tak | 403 | macierz: zakończony rok syntetyczny |
| `GET /api/admin/invitations` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/invitations` | wyłącznie admin | tak, krok w górę: ≤15 min (#150) | 403 | token zwracany raz; bez wysyłki e-mail; nadaje rolę przy przyjęciu, więc MFA starsze niż 15 min → `403 mfa_stale`; zaproszenie na własny adres: `409 cannot_grant_self`, a zaproszenie wystawione przez to samo konto nie nadaje mu roli przy przyjęciu (#146) |
| `POST /api/admin/invitations/:invitationId/revoke` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/invitations/:invitationId/reissue` | wyłącznie admin | tak, krok w górę: ≤15 min (#150) | 403 | odejście od stanu innego niż „oczekujące”: 409 (#108); MFA starsze niż 15 min → `403 mfa_stale` |
| `GET /api/admin/school-years` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/school-years` | wyłącznie admin | tak | 403 | nowy rok szkolny (#78); zły zakres dat: 400; duplikat id/etykiety: 409 |
| `POST /api/admin/school-years/:schoolYearId/classes` | wyłącznie admin | tak | 403 | nowe klasy roku (#78); nieistniejący rok: 404; duplikat nazwy: 409; bez trasy usuwania |
| `POST /api/admin/promotions/classes/preview` | wyłącznie admin | tak | 403 | podgląd kopii klas wg jawnej mapy (#78); nic nie zapisuje; bez mapy: 422 |
| `POST /api/admin/promotions/classes/apply` | wyłącznie admin | tak | 403 | tworzy brakujące klasy roku docelowego, audyt `class.created`; zamknięty rok docelowy: 409 |
| `POST /api/admin/promotions/preview` | wyłącznie admin | tak | 403 | plan promocji uczniów (#78) z `planDigest`; nic nie zapisuje; bez jawnej mapy klas: 422 |
| `POST /api/admin/promotions/apply` | wyłącznie admin | tak | 403 | nagłówek `Idempotency-Key`; nowe wiersze `enrollments` w jednej transakcji z audytem; zmiana danych od podglądu: `409 plan_stale`; zamknięty rok docelowy: 409 |
| `GET /api/admin/class-coverage?schoolYearId=:year` | wyłącznie admin | tak | 403 | obsada klas roku, bez tokenów i e-maili (#108) |
| `GET /api/admin/audit` | wyłącznie admin | tak | 403 | #181: filtry `domain`/`actorId`/`from`/`to`/`schoolYearId`; domeny i etykiety akcji w `shared/audit-actions.js`, każda domena ma `readRoles` sprawdzane na serwerze (dziś wyłącznie admin — D-08/D-09); metadane bez wolnego tekstu (`redactedFields`); sam zapisuje `audit.viewed` |
| `GET /api/admin/access-log` | wyłącznie admin | tak | 403 | #133: przegląd `data_access_log` (tylko odczyt): filtry `kind`/`actorId`/`householdId`/`classId`/`schoolYearId`/`outcome`/`from`/`to`, kursor; bez imion, e-maili i adresów IP; sam zapisuje `access_log.viewed`. Zarząd, skarbnik, audit, principal, przedstawiciel: 403 (D-04/D-07/D-08/D-09 nierozstrzygnięte) |
| `GET /api/admin/audit/entity/:entityType/:entityId` | wyłącznie admin | tak | 403 | #181: wariant zachowawczy — role finansowe/kampanii własnego zakresu do D-08/D-09; wymaga odczytu domeny obiektu (finance/email), zdarzenia innych nieczytelnych domen pominięte; nieistniejący obiekt: 404 |
| `GET /api/admin/data-requests` | wyłącznie admin | tak | 403 | #100: wariant zachowawczy — zakres do D-08/D-09; #159: kursor keyset (`limit`, `cursor`, `nextCursor`, `truncated`), kursor związany z filtrami `status`/`kind` |
| `POST /api/admin/data-requests` | wyłącznie admin | tak | 403 | #100: rejestr żądania, bez eksportu danych rodziny |
| `POST /api/admin/data-requests/:requestId/status` | wyłącznie admin | tak | 403 | #100: przejście stanu bez cofania; nieistniejące żądanie: 404 |
| `GET /api/admin/retention/preview` | wyłącznie admin | tak | 403 | rejestr polityk retencji i raport kandydatów (D-04, #91); bez adresów i nazw rodzin |
| `GET /api/admin/ops-status` | wyłącznie admin | tak | 403 | stan operacyjny: kolejka e-mail, ostatnie kopie zapasowe — bez adresów, nazw rodzin i treści (#149) |
| `GET /api/reconciliations?schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | SR-01 |
| `POST /api/reconciliations` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/reconciliations/:reconciliationId` | jak wyżej, rok uzgodnienia | tak | 403 | nieistniejące: 404; SR-01 |
| `POST /api/reconciliations/:reconciliationId/lines` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/reconciliations/:reconciliationId/lines/:lineId/payment` | jak wyżej | tak | 403 | wpłata z pozycji wyciągu i jej powiązanie w jednej transakcji (#115); SR-01 |
| `GET /api/reconciliations/:reconciliationId/suggestions` | jak wyżej | tak | 403 | tylko propozycje; SR-01 |
| `POST /api/reconciliations/:reconciliationId/matches` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/reconciliations/:reconciliationId/matches/batch` | jak wyżej | tak | 403 | wsadowe zatwierdzenie wskazanych par pozycja–wpłata, wszystko albo nic (#115); SR-01 |
| `POST /api/reconciliations/:reconciliationId/matches/:matchId/revocation` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/reconciliations/:reconciliationId/group-matches` | jak wyżej | tak | 403 | przelew zbiorczy (#127); SR-01 |
| `POST /api/reconciliations/:reconciliationId/group-matches/:groupMatchId/revocation` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/reconciliations/:reconciliationId/confirm` | jak wyżej; inna osoba niż autor | tak | 403 | SR-01 |
| `POST /api/reconciliations/:reconciliationId/abandon` | jak wyżej (także autor szkicu) | tak | 403 | tylko szkic bez aktywnych dopasowań; rok zamknięty: 409; SR-01 |
| `GET /api/reports/audit?schoolYearId=:year&format=json` | Komisja Rewizyjna, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | admin: 403; SR-01. Zamknięty rok: także zarząd/skarbnik roku następnego i admin, tylko odczyt (#195, docs/YEAR_CLOSE.md). Rola i rok pasują, jedyną przeszkodą jest MFA bieżącej sesji: `403 mfa_required`/`mfa_enrollment_required` zamiast `forbidden` (#161) |
| `GET /api/reports/annual?schoolYearId=:year&format=json` | zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | także `format=html`; admin, audit, principal, przedstawiciel: 403 (D-08/D-09, #125); SR-01. Brak MFA przy pasującej roli: `403 mfa_required`/`mfa_enrollment_required` |
| `GET /api/reports/cash-flow?schoolYearId=:year` | jak wyżej | tak | 403 | przepływy per miesiąc i metoda, saldo kasy (#125); SR-01 |
| `GET /api/reports/annual/snapshots?schoolYearId=:year` | zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | lista migawek sprawozdania rocznego bez treści (#125, 0138); admin, audit, principal, przedstawiciel: 403; SR-01 |
| `POST /api/reports/annual/snapshots` | jak wyżej | tak | 403 | zapis niezmiennej migawki z bieżącej księgi (JSON + SHA-256) i zdarzenie audytu `report.snapshot.created` w jednej transakcji; ta sama treść = `200 replayed`; rok zamknięty: `409 school_year_closed`; następna migawka wymaga `supersedesId` i powodu (#125); SR-01 |
| `GET /api/reports/annual/snapshots/:id?format=json` | jak wyżej (rok migawki) | tak | 403 | także `format=html` (druk); odczyt sprawdza skrót SHA-256 zapisanej treści; nieistniejąca migawka: `404` tylko dla aktora z rolą (#125); SR-01 |
| `POST /api/reports/annual/snapshots/:id/approve` | wyłącznie zarząd — przydział bez klasy, rok migawki | tak (świeże MFA, `mfa_stale`) | 403 | zatwierdza inna osoba niż autor (`four_eyes_required` 403); skarbnik, admin, audit, principal, przedstawiciel: 403; powtórka `200 replayed`; zdarzenie `report.snapshot.approved`; kto zatwierdza — D-09/D-12/D-21, wariant zachowawczy (#125) |
| `POST /api/exports` | admin, zarząd — przydział bez klasy, rok 1 | tak, krok w górę: ≤15 min (#150) | 403 | skarbnik: 403; SR-01. Zamknięty rok: także zarząd roku następnego (#195); MFA starsze niż 15 min → `403 mfa_stale` |
| `GET /api/exports/class-roster?classId=:class` | admin, zarząd — klasy roku 1; przedstawiciel i zarząd z przydziałem klasy — własna klasa | tak | 403 | Rola i klasa pasują, jedyną przeszkodą jest MFA bieżącej sesji: `403 mfa_required`/`mfa_enrollment_required` zamiast `forbidden` (#161); opcjonalny `format=json\|csv\|xlsx` (#132) nie zmienia zakresu, a audyt `export.created` zapisuje `format` bez danych osobowych |
| `GET /api/classes` | admin, zarząd, skarbnik — klasy roku przydziału; przedstawiciel i zarząd z przydziałem klasy — własna klasa | nie | 403 | Komisja Rewizyjna, dyrekcja: 403 |
| `GET /api/classes/:classId/students` | jak wyżej | nie | 403 / 404 | rola bez dostępu do rodzin: 403; klasa poza zakresem: 404 |
| `GET /api/households/:householdId` | jak wyżej (dzieci spoza zakresu pominięte) | nie | 403 / 404 | rodzeństwo w 1A i 1B: przedstawiciel widzi tylko swoje dziecko (test uzupełniający) |
| `PATCH /api/guardians/:guardianId/contact` | admin, zarząd — klasy roku 1; zarząd z przydziałem klasy — własna klasa | nie | 403 / 404 | rola bez prawa edycji: 403; opiekun bez relacji z uczniem z zakresu: 404; opiekun z aktywną relacją także z uczniem poza zakresem przydziału klasowego: `403 guardian_shared_outside_scope` (#200, zachowawczo do D-08; 403, nie 404, bo opiekun jest już widoczny w zakresie, więc nie ma wyroczni istnienia — SR-07); pełny zarząd/admin: 200; odmowa nie zapisuje nic w `guardians`, historii ani audycie |
| `PATCH /api/guardians/:guardianId/students/:studentId` | jak wyżej; zakres klasowy — tylko aktywna relacja z uczniem własnej klasy | nie | 403 / 404 | zgoda na kontakt w relacji (#190); relacja poza zakresem lub nieistniejąca: 404; zakończona: 409 |
| `POST /api/students/:studentId/enrollments` | jak wyżej | nie | 403 / 404 | macierz: przypisanie do tej samej klasy (200) |
| `POST /api/students/:studentId/enrollments/:enrollmentId/end` | jak wyżej | nie | 403 / 404 | odejście ze szkoły (#86); po zakończeniu przypisanie niezmienne; ponowienie: `changed: false` |
| `POST /api/guardians/:guardianId/students/:studentId/end` | jak wyżej; zakres klasowy — tylko relacja z uczniem własnej klasy | nie | 403 / 404 | zakończenie relacji opiekun–dziecko (#86), powód wymagany; data w zamkniętym roku: `409 school_year_closed`; ponowienie: `changed: false`; odpowiedź wymienia aktywne kampanie z tym opiekunem (`campaignsToReview`); powód przechodzi bramkę danych osobowych #152 (`422 personal_data_forbidden` / `possible_personal_data`, bez zapisu) |
| `POST /api/students/:studentId/households/:membershipId/end` | jak wyżej | nie | 403 / 404 | zakończenie członkostwa ucznia w gospodarstwie (#86); zakończenie głównego bez następcy: `withoutPrimaryHousehold: true`; zamknięty rok: 409 |
| `POST /api/students/:studentId/households` | admin, zarząd — zakres szeroki; zarząd z przydziałem klasy i przedstawiciel: 403 | nie | 403 / 404 | dodanie członkostwa (#86); nakładające się: `409 student_household_overlap`; ponowienie: 200 `changed: false` |
| `GET /api/print/cards?schoolYearId=:year&classId=:class` | admin, zarząd, skarbnik — rok 1 (z klasą lub bez); przedstawiciel i zarząd z przydziałem klasy — własna klasa | nie | 400 / 403 | przydział klasowy bez classId: 400; kwoty wpłat tylko rola finansowa z MFA |
| `GET /api/representative/overview?schoolYearId=:year` | wyłącznie przedstawiciel (bez decyzji D-08: bez sekcji wpłat; tylko liczności, daty i tytuł najbliższego zebrania własnej klasy) | nie | 400 / 403 | konto bez żadnego przydziału `representative`: 403; przydział innego roku: `classes: []` (#118) |
| `POST /api/admin/guardian-links` | admin, zarząd — przydział bez klasy (SR-01) | tak (już wymuszone bramką routera) | 403 / 404 | #140; token w treści odpowiedzi tylko raz, w bazie wyłącznie skrót SHA-256; nieistniejący opiekun: 404 |
| `GET /api/public/guardian-update?token=:token` | publiczna (bez sesji) | nie dotyczy | — | zły/wygasły/zużyty token: 404 `invalid_or_expired_link` (bez wyroczni istnienia); odpowiedź: wyłącznie imię opiekuna i nazwy klas dzieci |
| `POST /api/public/guardian-update` | publiczna (bez sesji) | nie dotyczy | — | tworzy WNIOSEK (`pending`), nie zmienia `guardians`; token jednorazowy: ponowne użycie → 409 `link_used`, bez drugiego wniosku |
| `GET /api/admin/guardian-update-requests` | admin, zarząd — przydział bez klasy (SR-01) | tak | 403 | #140; przedstawiciel klasy: 403 (do decyzji D-08) |
| `POST /api/admin/guardian-update-requests/:requestId/approve` | jak wyżej | tak | 403 / 404 | zatwierdzenie stosuje zmianę przez `rd.change_reason = 'parent_request:{id}'` (ta sama historia co PATCH /api/guardians/:id/contact); już rozstrzygnięty wniosek: 200 bez drugiej zmiany (idempotentne) |
| `POST /api/admin/guardian-update-requests/:requestId/reject` | jak wyżej | tak | 403 / 404 | odrzucenie nie zmienia `guardians`; już rozstrzygnięty wniosek: 200 (idempotentne) |
| `GET /api/board/overview?schoolYearId=:year` | admin, zarząd — przydział bez klasy, rok przydziału | tak (już wymuszone bramką routera dla admin/zarząd) | 400 / 403 / 404 | zarząd z przydziałem ograniczonym do klas: 200 wyłącznie z tymi klasami (wiersze i sumy tylko z nich), bez kolumny wpłat i bez licznika wpłat nieprzypisanych (wariant zachowawczy do D-08/D-09); odczyt w jednej migawce `readSnapshot`; skarbnik, Komisja Rewizyjna, dyrekcja, przedstawiciel: 403; rok poza przydziałem: 404 `school_year_not_found`; kolumna wpisów wpłat wymaga dodatkowo roli finansowej z MFA (#131) — bez niej pole `paymentEntryRatePercent` nie występuje w odpowiedzi; klasa z mniej niż 5 gospodarstwami: `null` zamiast odsetka; bez rankingu/sortowania po odsetku |
| `GET /api/board/overview/export.csv?schoolYearId=:year` | jak widok `board/overview` | tak | 400 / 403 / 404 | ta sama tabela co widok (#131), moduły `src/pg/csv.js` i `src/pg/xlsx.js`: identyczny zakres i ograniczenia — zarząd klasowy tylko swoje klasy i bez kolumny wpłat, kolumna wpisów wpłat tylko z rolą finansową i MFA, próg 5 gospodarstw (`—`), bez rankingu i list rodzin; zdarzenie `board.overview.exported` (rok, format, liczba wierszy) |
| `GET /api/board/overview/export.xlsx?schoolYearId=:year` | jak widok `board/overview` | tak | 400 / 403 / 404 | te same dane i reguły co CSV, format XLSX, zdarzenie `board.overview.exported` z `format: xlsx` |
| `POST /api/mfa/enroll` | każdy zalogowany (własny czynnik) | nie | — | |
| `POST /api/mfa/confirm` | każdy zalogowany | nie | — | rotuje sesję |
| `POST /api/mfa/verify` | każdy zalogowany z potwierdzonym czynnikiem | nie | — | |
| `POST /api/mfa/recovery` | jak wyżej | nie | — | kod odzyskiwania jednorazowy |
| `POST /api/sessions/revoke-all` | każdy zalogowany (własne sesje) | nie | — | konto z czynnikiem, sesja bez potwierdzonego MFA: wyłącznie bieżąca sesja (#189) |
| `GET /api/sessions` | każdy zalogowany (wyłącznie własne sesje) | nie | — | id, created_at, last_seen_at, stan MFA, czy bieżąca — bez IP i User-Agent (#150) |
| `POST /api/sessions/:id/revoke` | każdy zalogowany (wyłącznie własna sesja) | nie | 404 | cudza/nieistniejąca sesja: 404 jak brak obiektu (SR-07); bieżąca sesja: czyści cookie (#150) |
| `POST /api/login` | publiczna (bez sesji; uwierzytelnia e-mail i hasło) | nie | — | cookie żądania ignorowane; zgodny `Origin`; zwolniona z bramki MFA; sesja bez MFA |
| `GET /api/auth/state` | każdy zalogowany (stan własnej sesji) | nie | — | zwolniona z bramki MFA |
| `POST /api/invitations/accept` | publiczna (uwierzytelnia jednorazowy token zaproszenia) | nie | — | zgodny `Origin`; zwolniona z bramki MFA; istniejące konto z hasłem: wymagane jego obecne hasło |
| `POST /api/invitations/preview` | publiczna (odczyt po jednorazowym tokenie zaproszenia; nie konsumuje go) | nie | — | zgodny `Origin`; zwolniona z bramki MFA; limit prób jak `accept` (zakres IP); każda odmowa to `400 invalid_invitation`; bez zapraszającego, identyfikatorów i pełnego adresu (maska `j…@domena`) |
| `POST /api/password/reset` | publiczna (uwierzytelnia jednorazowy token od administratora) | nie | — | zgodny `Origin`; zwolniona z bramki MFA; wylogowuje wszystkie sesje konta |
| `POST /api/password/change` | każdy zalogowany (własne hasło) | nie | — | **nie** jest zwolniona z bramki MFA: admin, zarząd, skarbnik bez MFA — 403; wylogowuje inne sesje konta |
| `GET /api/year-close/:schoolYearId` | zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | admin, Komisja Rewizyjna: 403 |
| `POST /api/year-close/:schoolYearId/start` | zarząd — przydział bez klasy, rok 1 | tak | 403 | macierz: zamknięcie rozpoczęte wcześniej, powtórzenie 200 |
| `POST /api/year-close/:schoolYearId/checklist/:item` | zarząd, skarbnik — jak wyżej | tak | 403 | |
| `GET /api/year-close/:schoolYearId/handover` | zarząd, skarbnik — jak wyżej | tak | 403 | Zamknięty rok: także zarząd/skarbnik roku następnego i admin, tylko odczyt (#195) |
| `POST /api/year-close/:schoolYearId/close` | zarząd — jak wyżej; inna osoba niż rozpoczynająca | tak, krok w górę: ≤15 min (#150) | 403 | osobna baza testowa; wygasza przydziały roku; MFA starsze niż 15 min → `403 mfa_stale` |
| `GET /api/public/privacy-notice` | publiczna | nie | — | tylko opublikowana wersja; szkic/zatwierdzona niewidoczna (404) (#145, D-06) |
| `GET /api/admin/privacy-notices` | admin, zarząd | tak | 403 | wszystkie wersje, bez zakresu roku (#145) |
| `POST /api/admin/privacy-notices` | admin, zarząd | tak | 403 | nowy szkic; treść i `decisionRef` bez wartości domyślnej |
| `POST /api/admin/privacy-notices/:id/approve` | admin, zarząd; inna osoba niż autor | tak | 403 | autor własnej wersji: 403 i trigger bazy |
| `POST /api/admin/privacy-notices/:id/publish` | admin, zarząd | tak | 403 | wymaga zatwierdzenia; idempotentne (druga publikacja: `Idempotency-Replayed`); poprzednia opublikowana wersja przechodzi w `superseded` |

Trasy logowania (`src/pg/routes/login.js`, moduł `login`) nie działają na danych Rady. W macierzy trasy publiczne dostają poprawne dane uwierzytelniające (konto z hasłem, świeży token zaproszenia albo resetu) niezależnie od cookie aktora — odpowiedź zależy wyłącznie od hasła lub tokenu; błędne dane, limity prób i CSRF logowania sprawdza `tests/pg-login.test.js`. Trasy administratora `password-reset` i `mfa-reset` są częścią modułu `admin` (wyłącznie admin z MFA).

Uwagi do decyzji (nie są rozstrzygnięciem): zatwierdzanie i publikacja wydarzeń wymagają MFA także na poziomie usługi (`requireMfa: true` w `approve`/`publish`, `src/pg/events.js`, #150), a pozostałe operacje na wydarzeniach — tylko bramki MFA routera (dla admina, zarządu i skarbnika; przedstawiciel jej nie podlega); admin techniczny może tworzyć i edytować szkice wydarzeń oraz zarządzać zebraniami; Komisja Rewizyjna czyta również projekty protokołów. Każde z tych zachowań wymaga potwierdzenia w D-08/D-09.

**Zebrania — MFA na poziomie usługi (#135, SR-10):** niezależnie od bramki MFA routera, `src/pg/meetings.js` sam sprawdza `actor.mfaVerified` — od #150 przy **każdym** zarządzaniu zebraniem (dane, obecność, porządek, quorum, uchwały łącznie ze szkicem, protokół, widoczność, także dla przedstawiciela-gospodarza zebrania klasowego), a osobno (#135) przy rozstrzygnięciu uchwały, jej korekcie, zatwierdzeniu protokołu i udostępnieniu go rodzicom/publicznie (lista `MFA_REQUIRED_ACTIONS`, opis w docs/MEETINGS.md). Odmowa: `403 mfa_required`, bez zapisu. Zatwierdzenie protokołu wymaga dodatkowo, by zatwierdzający nie był autorem zatwierdzanej wersji (`403 minutes_four_eyes_required` w serwisie, `409` z tym samym kodem w triggerze bazy przy bezpośrednim `UPDATE`). To sprawdzenie działa również wtedy, gdy trasa wywoływana jest bezpośrednio (np. w testach usługi z pominięciem routera) — dlatego kolumna MFA niżej dla tych tras pokazuje wymóg trasy, osobny od bramki routera.

## Akcje w panelach (issue #225)

Panele ukrywają akcje, których rola nie może wykonać. Robią to na podstawie `GET /api/access`; sesja przed MFA dostaje tam `grants: []`, więc nie widzi żadnych akcji. To wyłącznie skrót dla użytkownika, a każdą operację nadal autoryzuje serwer.

| Panel | Akcja | Kto ją widzi |
|---|---|---|
| Wpłaty, Księga | formularze i „Dodaj wpłatę”/„Dodaj wpis” | role z `FINANCIAL_ROLES` z przydziałem bez klasy; pozostali widzą jeden komunikat o braku dostępu |
| Dokumenty | rodzaj w formularzu przesyłania | według `DOCUMENT_POLICIES`; przedstawiciel widzi tylko „Materiał klasy” z podpowiedzią własnych klas |
| Zebrania | „Nowe zebranie” | `MANAGE_ROLES` |
| Wydarzenia | „Nowy szkic”, „Zgłoś”, „Zatwierdź”, „Opublikuj”, „Odwołaj” | według `EVENT_POLICY`; „Zatwierdź” nie jest pokazywane autorowi wydarzenia ani autorowi bieżącej wersji, który zamiast tego widzi wyjaśnienie zasady czterech oczu |

Listy ról w panelach (`*/core.js`) porównuje ze stałymi serwera test `tests/role-policy-parity.test.js`. Odpowiedź 403 panele Wpłat i Księgi opisują jako brak uprawnień, a nie jako „Błąd serwera”.

## Znane luki (przypadki `todo` w macierzy)

Obecnie brak — macierz nie ma przypadków `todo`. Naprawione wcześniej luki pozostają jako zwykłe asercje:

- **SR-01** — przydział zarządu ograniczony do klasy nie działa już jak ogólnoszkolny na trasach roku bez klasy (księga, kampanie e-mail, uzgodnienia, raport dla Komisji Rewizyjnej, pełny eksport roczny): 403 i brak zapisu.
- **DOC-01** — `GET /api/documents?schoolYearId=<inny rok>` dla przydziału klasowego roku 1 zwraca 403 zamiast pustej listy; `ownClasses` uwzględnia rok (i MFA) przydziału. Regresja także w `tests/pg-documents.test.js`.
- **SR-07** — PATCH/submit/cancel cudzego wydarzenia oraz `GET /api/meetings/:meetingId` poza zakresem odpowiadają 404 jak brak obiektu (test regresji w tym samym pliku).

Dodając moduł do `ROUTES` lub ścieżkę do istniejącego modułu: dopisz wpis w `tests/helpers/route-matrix.js` (role, MFA, zakres, przykładowa treść, fixture), pliki źródłowe modułu w `MODULE_SOURCES` w `tests/pg-authz-matrix.test.js` i wiersz w tej tabeli. Rozbieżność kodu z zamierzoną polityką oznacz `todo` w wpisie (z opisem luki), zamiast zmieniać oczekiwany status na stan kodu. Każde `todo` wymaga też wpisu `id trasy: '#NNN'` w `ALLOWED_TODO` (`tests/pg-authz-matrix.test.js`, dziś pusta lista) — meta-test oblewa `todo` bez wpisu, wpis bez `todo` i wpis bez numeru issue (#214).
