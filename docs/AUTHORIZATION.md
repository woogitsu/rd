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

Trasy, dla których rozróżnienie powodu odmowy ma znaczenie dla ekranu logowania — dziś lista klasy (`GET /api/exports/class-roster`) i raport Komisji Rewizyjnej (`GET /api/reports/audit`), bo ich role (`representative`, `audit`) nie są domyślnie na liście `MFA_REQUIRED_ROLES` — używają zamiast ogólnego `403 forbidden` funkcji `mfaAwareForbiddenCode(context, requirement, env)` (`src/pg/authorization.js`): najpierw sprawdza rolę i zakres **bez** `requireMfa` (sama odmowa z powodu roli/zakresu zostaje `forbidden` i nie ujawnia stanu MFA konta ani istnienia zasobu, SR-07), a dopiero gdy to przechodzi, zwraca `403 mfa_required` (czynnik zapisany, sesja bez potwierdzonego kodu) albo `403 mfa_enrollment_required` (konto bez czynnika) — #161. Kolejność sprawdzeń (najpierw zakres) jest bez zmian; zmienia się tylko treść pola `error` w odpowiedzi. Konto z już zapisanym, ale w tej sesji niepotwierdzonym czynnikiem i tak dostanie `mfa_required` wcześniej, na poziomie bramki routera (`mfaGate`, reguła 1 niżej) — dla **dowolnej** chronionej trasy, niezależnie od zakresu.

Import uczniów (`/api/import/*`, #36) dopuszcza role `admin` i `board` z MFA i tylko z przydziałem bez `class_id` (wszystkie klasy) obejmującym wybrany rok. Przydział zarządu ograniczony do klasy nie wystarcza — kontrola jest dodatkowa względem `isAuthorized`, która przy braku `classId` w wymaganiu przepuszcza przydziały klasowe. Zakres ról importu to założenie do decyzji D-08.

## Macierz tras API (issue #4) — testy negatywne

Tabela opisuje **zamierzoną** politykę tras routera PostgreSQL (`src/pg/app.js`, `ROUTES`) wynikającą z dokumentacji modułów, a nie zatwierdzone przez szkołę kompetencje. Zakresy ról zarządu, przedstawiciela, dyrekcji i Komisji Rewizyjnej to nadal założenia do decyzji D-08/D-09 (docs/DECISIONS.md). Źródłem prawdy dla testów jest `tests/helpers/route-matrix.js`; `tests/pg-authz-matrix.test.js` wykonuje każdą trasę dla wszystkich aktorów, MFA wł./wył. i każdego zakresu, a meta-test nie przepuści modułu z `ROUTES` ani ścieżki z kodu modułu bez wpisu w macierzy i wiersza w tej tabeli. Gdzie kod odbiega od zamierzonej polityki, przypadki są oznaczone w macierzy jako `todo`: nadal się wykonują, ale ich rozbieżność trafia do osobnego testu „znana luka”, więc CI jest zielone, a luka pozostaje widoczna (sekcja „Znane luki” niżej).

Aktorzy testu: admin, zarząd, skarbnik, przedstawiciel 1A, przedstawiciel 1B, **zarząd z przydziałem ograniczonym do klasy 1A**, Komisja Rewizyjna (`audit`), dyrekcja (`principal`) — wszyscy z przydziałem na rok 1 — oraz zalogowany bez przydziału, przydział wygasły, przydział cofnięty, konto wyłączone, sesja wygasła, sesja cofnięta i brak sesji. Zakresy: **1A** (własna klasa przedstawiciela A), **1B** (inna klasa), **R1** (dane ogólnoszkolne roku 1, bez klasy), **R2** (klasa albo dane innego roku). „Rok 1” = 1A, 1B i R1. Zarząd z przydziałem klasy 1A ma — zgodnie z semantyką `class_id` — co najwyżej uprawnienia zarządu w klasie 1A (tam, gdzie moduł dopuszcza zarząd w zakresie klasy) i nigdy do danych ogólnoszkolnych: finansów, kampanii e-mail, eksportu rocznego, importu, uzgodnień, raportu i zamknięcia roku.

Dla każdego przypadku test sprawdza: status; brak jakichkolwiek syntetycznych znaczników danych w odpowiedzi odmownej; brak w odpowiedzi 2xx znaczników zakresu, do którego aktor nie ma przydziału (np. dane 1B u przedstawiciela 1A, dane roku 2 u zarządu roku 1); brak zapisu w tabelach i dzienniku zdarzeń po odmowie żądania zmieniającego stan (liczniki ok. 50 tabel, w tym `audit_events`). Wybrane trasy mają dodatkowe asercje: rodzaje dokumentów na liście, lista klas, kwoty na kartkach tylko przy MFA. Dane są syntetyczne; dokumenty trafiają do magazynu w pamięci, żadna trasa nie wysyła poczty (kampanie trafiają najwyżej do kolejki), a trasy zamknięcia roku mają osobną bazę, bo zamknięcie wygasza przydziały roku 1.

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
| `GET /api/public/events` | publiczna | nie | — | tylko opublikowane rewizje, bez danych klas |
| `GET /api/events?schoolYearId=:year` | admin, zarząd — cały rok 1; przedstawiciel — rok 1, tylko wydarzenia własnej klasy | nie | 403 | lista przedstawiciela 1A nie zawiera 1B ani wydarzeń ogólnoszkolnych |
| `POST /api/events` | admin, zarząd — rok 1 (klasa lub ogólnoszkolne); przedstawiciel — własna klasa | nie | 403 | |
| `GET /api/events/:eventId` | jak wyżej | nie | 404 | brak uprawnień nieodróżnialny od braku wydarzenia |
| `PATCH /api/events/:eventId` | jak wyżej | nie | 404 | wydarzenie spoza zakresu nieodróżnialne od braku (SR-07) |
| `POST /api/events/:eventId/submit` | jak wyżej | nie | 404 | |
| `POST /api/events/:eventId/approve` | zarząd — rok 1 | tak (#150) | 403 / 404 | 403, gdy aktor widzi wydarzenie (admin, przedstawiciel własnej klasy); 404 poza zakresem podglądu; zasada czterech oczu w bazie |
| `POST /api/events/:eventId/publish` | zarząd — rok 1 | tak (#150) | 403 / 404 | jak przy zatwierdzeniu |
| `POST /api/events/:eventId/cancel` | szkic: admin, zarząd — rok 1; przedstawiciel — własna klasa; opublikowane: tylko zarząd | nie | 404 | macierz testuje szkic; opublikowane wydarzenie własnej klasy: przedstawiciel dostaje 403 |
| `GET /api/meetings?schoolYearId=:year` | admin, zarząd, Komisja Rewizyjna — rok 1; zarząd z przydziałem klasy — rok 1, tylko zebrania tej klasy | nie | 403 | przedstawiciel: 403 |
| `POST /api/meetings` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | |
| `GET /api/meetings/shared-minutes?schoolYearId=:year` | admin, zarząd, Komisja Rewizyjna — rok 1; przedstawiciel — rok 1 | nie | 403 | przedstawiciel widzi protokoły ogólne i własnej klasy, nigdy innej klasy |
| `GET /api/meetings/public-minutes?schoolYearId=:year` | publiczna | nie | — | tylko protokoły o widoczności `public` |
| `GET /api/meetings/resolutions/lookup?schoolYearId=:year&number=:number` | admin, zarząd, Komisja Rewizyjna, skarbnik — rok 1 | nie | 403 | inny rok: 403 |
| `GET /api/meetings/:meetingId` | admin, zarząd, Komisja Rewizyjna — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | nie | 404 | brak uprawnień nieodróżnialny od braku zebrania (SR-07); przedstawiciel: 404 także dla zebrania własnej klasy |
| `PATCH /api/meetings/:meetingId` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy; #171: przedstawiciel-gospodarz własnej klasy | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/agenda-items` | jak wyżej | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/attendance` | jak wyżej | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/quorum-checks` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/minutes` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy; #171: przedstawiciel-gospodarz własnej klasy | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/minutes/:minutesId/approval` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | #135: zatwierdzający ≠ autor wersji (`403 minutes_four_eyes_required`) |
| `POST /api/meetings/:meetingId/minutes/:minutesId/visibility` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/resolutions` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | |
| `PATCH /api/meetings/:meetingId/resolutions/:resolutionId` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | |
| `POST /api/meetings/:meetingId/resolutions/:resolutionId/corrections` | admin, zarząd — rok 1; zarząd z przydziałem klasy — zebrania tej klasy | tak (#150) | 403 | #135: korekta zawsze zapisuje rozstrzygnięcie |
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
| `GET /api/documents/:financialDocumentId/content` | jak metadane dokumentu finansowego | tak | 404 | odmowa zapisuje `document.access_denied`, pobranie — `document.downloaded` |
| `GET /api/documents/:boardDocumentId/content` | jak metadane dokumentu zarządu | nie | 404 | |
| `GET /api/documents/:classDocumentId/content` | jak metadane dokumentu klasy | nie | 404 | |
| `GET /api/ledger?schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | zarząd z przydziałem klasy: 403 (SR-01) |
| `GET /api/ledger/categories?schoolYearId=:year` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/ledger/summary?schoolYearId=:year` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/ledger/budget?schoolYearId=:year` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/ledger/export.csv?schoolYearId=:year` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/ledger` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/ledger/:ledgerEntryId/corrections` | jak wyżej, rok wpisu | tak | 403 | SR-01 |
| `POST /api/ledger/:ledgerEntryId/replacement` | jak wyżej, rok wpisu | tak | 403 | SR-01; przeksięgowanie (storno + wpis zastępczy) atomowo (#144); wpis powiązany z wpłatą: 409 `payment_linked_entry_not_replaceable`; wpis już zastąpiony: 409 `ledger_entry_already_replaced` |
| `GET /api/ledger/transfers?schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | #199 |
| `POST /api/ledger/transfers` | jak wyżej | tak | 403 | #199; przeniesienie kasa ↔ rachunek, storno jako nowy wpis |
| `GET /api/ledger/opening-balance?schoolYearId=:year` | jak wyżej | tak | 403 | #199 |
| `POST /api/ledger/opening-balance` | zarząd — przydział bez klasy, rok 1 | tak | 403 | #199; admin i skarbnik: 403; tylko pierwszy rok (409 `not_first_school_year`) |
| `POST /api/ledger/opening-balance/adjustments` | zarząd — przydział bez klasy, rok 1 | tak | 403 | #199; admin i skarbnik: 403; zamknięty rok: 409 |
| `GET /api/email/campaigns?schoolYearId=:year` | zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | admin techniczny: 403; SR-01 |
| `POST /api/email/campaigns` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/email/campaigns/:campaignId` | jak wyżej, rok kampanii | tak | 403 | SR-01 |
| `PUT /api/email/campaigns/:campaignId` | jak wyżej | tak | 403 | zmiana cofa zatwierdzenie; SR-01 |
| `POST /api/email/campaigns/:campaignId/snapshot` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/email/campaigns/:campaignId/preview` | jak wyżej | tak | 403 | bez wysyłki; SR-01 |
| `GET /api/email/campaigns/:campaignId/recipients` | jak wyżej | tak | 403 | odczyt w dzienniku; SR-01 |
| `POST /api/email/campaigns/:campaignId/approve` | zarząd — przydział bez klasy, rok 1; inna osoba niż autor | tak | 403 | skarbnik: 403; SR-01 |
| `POST /api/email/campaigns/:campaignId/queue` | zarząd, skarbnik — jak wyżej | tak | 403 | tylko kolejka, bez wysyłki; SR-01 |
| `POST /api/email/campaigns/:campaignId/pause` | zarząd, skarbnik — jak wyżej | tak | 403 | wstrzymanie wysyłki (#130); SR-01 |
| `POST /api/email/campaigns/:campaignId/resume` | zarząd, skarbnik — jak wyżej | tak | 403 | wznowienie (#130); SR-01 |
| `POST /api/email/campaigns/:campaignId/cancel` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/email/webhooks/brevo` | bez sesji; wspólny sekret w `Authorization` | nie | — | brak lub zły sekret: 401 bez zapisu (test uzupełniający) |
| `GET /api/public/news` | publiczna | nie | — | tylko opublikowane wpisy |
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
| `GET /api/admin/users` | wyłącznie admin | tak | 403 | moduł obejmuje konta całej szkoły |
| `POST /api/admin/users/:userId/disable` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/users/:userId/enable` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/users/:userId/revoke-sessions` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/users/:userId/password-reset` | wyłącznie admin | tak | 403 | jednorazowy token resetu hasła, zwracany raz; nowy unieważnia poprzedni |
| `POST /api/admin/users/:userId/mfa-reset` | wyłącznie admin (nie własne konto) | tak | 403 | wymaga `confirm` = id konta; wyłącza czynniki i kody odzyskiwania, wylogowuje konto |
| `GET /api/admin/grants` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/grants` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/grants/:grantId/revoke` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/school-years/:schoolYearId/expire-grants` | wyłącznie admin | tak | 403 | macierz: zakończony rok syntetyczny |
| `GET /api/admin/invitations` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/invitations` | wyłącznie admin | tak | 403 | token zwracany raz; bez wysyłki e-mail |
| `POST /api/admin/invitations/:invitationId/revoke` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/invitations/:invitationId/reissue` | wyłącznie admin | tak | 403 | odejście od stanu innego niż „oczekujące”: 409 (#108) |
| `GET /api/admin/school-years` | wyłącznie admin | tak | 403 | |
| `POST /api/admin/school-years` | wyłącznie admin | tak | 403 | nowy rok szkolny (#78); zły zakres dat: 400; duplikat id/etykiety: 409 |
| `POST /api/admin/school-years/:schoolYearId/classes` | wyłącznie admin | tak | 403 | nowe klasy roku (#78); nieistniejący rok: 404; duplikat nazwy: 409; bez trasy usuwania |
| `GET /api/admin/class-coverage?schoolYearId=:year` | wyłącznie admin | tak | 403 | obsada klas roku, bez tokenów i e-maili (#108) |
| `GET /api/admin/audit` | wyłącznie admin | tak | 403 | |
| `GET /api/reconciliations?schoolYearId=:year` | admin, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | SR-01 |
| `POST /api/reconciliations` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/reconciliations/:reconciliationId` | jak wyżej, rok uzgodnienia | tak | 403 | nieistniejące: 404; SR-01 |
| `POST /api/reconciliations/:reconciliationId/lines` | jak wyżej | tak | 403 | SR-01 |
| `GET /api/reconciliations/:reconciliationId/suggestions` | jak wyżej | tak | 403 | tylko propozycje; SR-01 |
| `POST /api/reconciliations/:reconciliationId/matches` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/reconciliations/:reconciliationId/matches/:matchId/revocation` | jak wyżej | tak | 403 | SR-01 |
| `POST /api/reconciliations/:reconciliationId/confirm` | jak wyżej; inna osoba niż autor | tak | 403 | SR-01 |
| `GET /api/reports/audit?schoolYearId=:year&format=json` | Komisja Rewizyjna, zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | admin: 403; SR-01. Zamknięty rok: także zarząd/skarbnik roku następnego i admin, tylko odczyt (#195, docs/YEAR_CLOSE.md). Rola i rok pasują, jedyną przeszkodą jest MFA bieżącej sesji: `403 mfa_required`/`mfa_enrollment_required` zamiast `forbidden` (#161) |
| `POST /api/exports` | admin, zarząd — przydział bez klasy, rok 1 | tak, krok w górę: ≤15 min (#150) | 403 | skarbnik: 403; SR-01. Zamknięty rok: także zarząd roku następnego (#195); MFA starsze niż 15 min → `403 mfa_stale` |
| `GET /api/exports/class-roster?classId=:class` | admin, zarząd — klasy roku 1; przedstawiciel i zarząd z przydziałem klasy — własna klasa | tak | 403 | Rola i klasa pasują, jedyną przeszkodą jest MFA bieżącej sesji: `403 mfa_required`/`mfa_enrollment_required` zamiast `forbidden` (#161) |
| `GET /api/classes` | admin, zarząd, skarbnik — klasy roku przydziału; przedstawiciel i zarząd z przydziałem klasy — własna klasa | nie | 403 | Komisja Rewizyjna, dyrekcja: 403 |
| `GET /api/classes/:classId/students` | jak wyżej | nie | 403 / 404 | rola bez dostępu do rodzin: 403; klasa poza zakresem: 404 |
| `GET /api/households/:householdId` | jak wyżej (dzieci spoza zakresu pominięte) | nie | 403 / 404 | rodzeństwo w 1A i 1B: przedstawiciel widzi tylko swoje dziecko (test uzupełniający) |
| `PATCH /api/guardians/:guardianId/contact` | admin, zarząd — klasy roku 1; zarząd z przydziałem klasy — własna klasa | nie | 403 / 404 | rola bez prawa edycji: 403; opiekun poza zakresem: 404 |
| `PATCH /api/guardians/:guardianId/students/:studentId` | jak wyżej; zakres klasowy — tylko aktywna relacja z uczniem własnej klasy | nie | 403 / 404 | zgoda na kontakt w relacji (#190); relacja poza zakresem lub nieistniejąca: 404; zakończona: 409 |
| `POST /api/students/:studentId/enrollments` | jak wyżej | nie | 403 / 404 | macierz: przypisanie do tej samej klasy (200) |
| `POST /api/students/:studentId/enrollments/:enrollmentId/end` | jak wyżej | nie | 403 / 404 | odejście ze szkoły (#86); po zakończeniu przypisanie niezmienne; ponowienie: `changed: false` |
| `GET /api/print/cards?schoolYearId=:year&classId=:class` | admin, zarząd, skarbnik — rok 1 (z klasą lub bez); przedstawiciel i zarząd z przydziałem klasy — własna klasa | nie | 400 / 403 | przydział klasowy bez classId: 400; kwoty wpłat tylko rola finansowa z MFA |
| `GET /api/representative/overview?schoolYearId=:year` | wyłącznie przedstawiciel (bez decyzji D-08: bez sekcji wpłat) | nie | 400 / 403 | konto bez żadnego przydziału `representative`: 403; przydział innego roku: `classes: []` (#118) |
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
| `POST /api/password/reset` | publiczna (uwierzytelnia jednorazowy token od administratora) | nie | — | zgodny `Origin`; zwolniona z bramki MFA; wylogowuje wszystkie sesje konta |
| `POST /api/password/change` | każdy zalogowany (własne hasło) | nie | — | **nie** jest zwolniona z bramki MFA: admin, zarząd, skarbnik bez MFA — 403; wylogowuje inne sesje konta |
| `GET /api/year-close/:schoolYearId` | zarząd, skarbnik — przydział bez klasy, rok 1 | tak | 403 | admin, Komisja Rewizyjna: 403 |
| `POST /api/year-close/:schoolYearId/start` | zarząd — przydział bez klasy, rok 1 | tak | 403 | macierz: zamknięcie rozpoczęte wcześniej, powtórzenie 200 |
| `POST /api/year-close/:schoolYearId/checklist/:item` | zarząd, skarbnik — jak wyżej | tak | 403 | |
| `GET /api/year-close/:schoolYearId/handover` | zarząd, skarbnik — jak wyżej | tak | 403 | Zamknięty rok: także zarząd/skarbnik roku następnego i admin, tylko odczyt (#195) |
| `POST /api/year-close/:schoolYearId/close` | zarząd — jak wyżej; inna osoba niż rozpoczynająca | tak | 403 | osobna baza testowa; wygasza przydziały roku |

Trasy logowania (`src/pg/routes/login.js`, moduł `login`) nie działają na danych Rady. W macierzy trasy publiczne dostają poprawne dane uwierzytelniające (konto z hasłem, świeży token zaproszenia albo resetu) niezależnie od cookie aktora — odpowiedź zależy wyłącznie od hasła lub tokenu; błędne dane, limity prób i CSRF logowania sprawdza `tests/pg-login.test.js`. Trasy administratora `password-reset` i `mfa-reset` są częścią modułu `admin` (wyłącznie admin z MFA).

Uwagi do decyzji (nie są rozstrzygnięciem): wydarzenia nie wymagają na poziomie trasy MFA (dla admina, zarządu i skarbnika wymusza je bramka MFA routera), także zatwierdzanie i publikacja; admin techniczny może tworzyć i edytować szkice wydarzeń oraz zarządzać zebraniami; Komisja Rewizyjna czyta również projekty protokołów. Każde z tych zachowań wymaga potwierdzenia w D-08/D-09.

**Zebrania — MFA na poziomie usługi (#135, SR-10):** niezależnie od bramki MFA routera, `src/pg/meetings.js` sam sprawdza `actor.mfaVerified` dla rozstrzygnięcia uchwały, jej korekty, zatwierdzenia protokołu i udostępnienia go rodzicom/publicznie (lista `MFA_REQUIRED_ACTIONS`, opis w docs/MEETINGS.md). Odmowa: `403 mfa_required`, bez zapisu. Zatwierdzenie protokołu wymaga dodatkowo, by zatwierdzający nie był autorem zatwierdzanej wersji (`403 minutes_four_eyes_required` w serwisie, `409` z tym samym kodem w triggerze bazy przy bezpośrednim `UPDATE`). To sprawdzenie działa również wtedy, gdy trasa wywoływana jest bezpośrednio (np. w testach usługi z pominięciem routera) — dlatego kolumna MFA niżej dla tych tras pokazuje wymóg trasy, osobny od bramki routera.

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

Dodając moduł do `ROUTES` lub ścieżkę do istniejącego modułu: dopisz wpis w `tests/helpers/route-matrix.js` (role, MFA, zakres, przykładowa treść, fixture), pliki źródłowe modułu w `MODULE_SOURCES` w `tests/pg-authz-matrix.test.js` i wiersz w tej tabeli. Rozbieżność kodu z zamierzoną polityką oznacz `todo` w wpisie (z opisem luki), zamiast zmieniać oczekiwany status na stan kodu.
