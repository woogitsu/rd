# Równoważność starego i nowego API

Status: testy automatyczne na danych syntetycznych (issue #31, kryterium z #41
„testy równoważności API / porównanie wyników starego i nowego API”). To nie jest
raport z danych szkoły ani zgoda na cutover. Stary Worker/D1 jest tu wyłącznie
kontraktem referencyjnym, nie wdrożeniem Railway.

## Metoda

- Ten sam scenariusz żądań trafia do starego Workera (`src/index.js`, D1
  zastąpione przez `node:sqlite` z migracjami `migrations/*.sql`) i do
  `handlePgRequest` (`src/pg/app.js`, PGlite z `postgres/migrations/*.sql`).
  Oba backendy mają ten sam stan syntetyczny (użytkownicy, role, sesje).
- Porównywane są: kod statusu, **wszystkie** nagłówki (m.in. `Cache-Control`,
  `Content-Type`, `X-Content-Type-Options`, `Set-Cookie`) i ciało odpowiedzi.
  Normalizacja: losowe UUID zamieniane na etykiety w kolejności pojawienia się,
  kursory dekodowane, znaczniki czasu `expiresAt` sprowadzane do ISO 8601.
- Każda różnica, której nie ma na liście uzasadnionych różnic w teście, kończy
  test błędem. Różnica z listy musi faktycznie wystąpić (lista nie może się
  zestarzeć po cichu).
- Oprócz odpowiedzi test sprawdza skutki w bazie: wycofanie sesji i jedno
  zdarzenie audytu `session.logout` z aktorem mimo podwójnego kliknięcia.
- Pliki: `tests/api-parity-session.test.js`, `tests/pg-payments-api.test.js`
  (wpłaty), `tests/d1-postgres-restore-compat.test.js` (odtworzenie),
  wspólne narzędzia `tests/helpers/parity.js`.

## Wyniki: trasy

| Trasa / przypadek | Status | Uwagi |
| --- | --- | --- |
| `GET /health` (także z zapytaniem, z cookie sesji) | zgodne | `200 {"status":"ok"}`, te same nagłówki JSON |
| `HEAD /health`, `POST /health` | zgodne | `404 not_found` w obu (tylko `GET` jest obsługiwany) |
| `GET /api/session` — brak cookie, zły format, nieznany token, wygasła, wycofana sesja, wyłączone konto | zgodne | `401 unauthenticated` |
| `GET /api/session` — ważna sesja (z MFA i bez), cookie wśród innych, zduplikowane cookie (wygrywa pierwsze) | zgodne | treść identyczna po normalizacji `expiresAt` |
| `GET /api/session` — zapis `expiresAt` | uzasadniona różnica | D1 zwraca tekst zapisany w bazie (np. `2099-01-01 00:00:00`), PostgreSQL ISO 8601 (`2099-01-01T00:00:00.000Z`). Ta sama chwila; żaden panel nie czyta tego pola |
| `GET /api/access` — brak sesji, wygasła, wyłączone konto | zgodne | `401 unauthenticated` |
| `GET /api/access` — admin, przedstawiciel, konto bez ról | uzasadniona różnica | przedstawiciel widzi tylko przypisane klasy; wygasły przydział pominięty; ta sama kolejność. Nowy dodaje pole `hasActiveRole` (#176, ROLE_STATUS — src/pg/auth.js): ekran startowy `login/` pokazuje komunikat zamiast listy paneli, gdy konto nie ma żadnej roli z aktywnymi trasami (np. samo `principal`). Worker tego pola nie ma |
| `PUT /api/access`, `POST /api/session` ze zgodnym Origin | zgodne | `404 not_found` |
| `POST /api/session` bez Origin | uzasadniona różnica | stary: `404 not_found`; nowy: `403 invalid_origin`. Router PostgreSQL sprawdza Origin dla każdej metody zmieniającej stan pod `/api/` przed wyborem trasy (ostrzejsza ochrona CSRF) |
| `POST /api/logout` — brak Origin, obcy Origin, `null`, inny schemat | zgodne | `403 invalid_origin`, sesja pozostaje ważna, brak wpisu audytu |
| `POST /api/logout` — bez cookie, nieznany token, wygasła sesja | zgodne | `204`, `Cache-Control: no-store`, `Set-Cookie` czyszczące cookie |
| `POST /api/logout` — ważna sesja i podwójne kliknięcie | zgodne | `204`; potem `401` dla sesji; jedno zdarzenie `session.logout`. Nowy zapisuje dodatkowo `revoked_reason = 'logout'` (tylko w bazie) |
| `GET /api/logout` | zgodne | `404 not_found` |
| 404: `/`, `/api`, `/api/`, `/api/session/`, `/API/session`, `/api/sessions`, `/api/unknown`, `/secret.txt`, `DELETE /api/unknown` ze zgodnym Origin | zgodne | `404 not_found`, nagłówki JSON |
| `DELETE /api/unknown` bez Origin | uzasadniona różnica | jak wyżej: `403 invalid_origin` zamiast `404` |
| Awaria bazy: `/api/session`, `/api/access`, `/api/logout` z cookie | zgodne | `503 service_unavailable`; `/health` nadal `200`; bez cookie brak zapytania do bazy (`401`/`204`). Log nowego API zawiera tylko moduł i kod błędu, bez tokenu i e-maila |
| `/api/events`, `/api/public/events`, `/api/meetings` | uzasadniona różnica | nowe funkcje (#12, #13), w Workerze `404`. `/api/public/events` ma celowo `Cache-Control: public, max-age=60` |
| `/api/payments…` (tworzenie, ponowienie, konflikt klucza, korekty, przypisanie, lista, walidacja, odmowy i błędy) | zgodne | istniejący scenariusz krok po kroku w `tests/pg-payments-api.test.js`, teraz na wspólnym `tests/helpers/parity.js` |
| `/api/ledger…` | w toku | porównanie księgi prowadzi osobne zadanie; w routerze PostgreSQL brak jeszcze tras księgi (#38) |

Poziom Node (`src/node-app.js`) nie był tu porównywany: dla `/api/` ustawia
zawsze `Cache-Control: no-store` (nadpisuje `public, max-age=60` z
`/api/public/events`) i przepisuje wiele nagłówków `Set-Cookie`. To dotyczy obu
routerów jednakowo i jest opisane w [NODE_SERVER.md](NODE_SERVER.md).

## Wyniki: odtworzenie D1 → PostgreSQL (#47)

Test buduje bazę D1 z wszystkimi migracjami `migrations/*.sql` przez `sql.js`
(jak `scripts/create-d1-snapshot.js`), wypełnia **każdą** tabelę snapshotu
syntetycznymi danymi (rodzeństwo, dwie osoby opiekujące się jednym dzieckiem,
wpłaty częściowe, dwie korekty, przypisana nierozpoznana wpłata, role także
wygasłe, dokument, wydarzenia każdej widoczności, księga z korektą, saldo
otwarcia z korektą, łańcuch preliminarza, audyt) i odtwarza ją do PGlite ze
**wszystkimi** migracjami PostgreSQL (w tym 0004, 0008, 0009).

| Obszar | Status | Uwagi |
| --- | --- | --- |
| Liczności wszystkich tabel, suma netto wpłat, przychody i wydatki | zgodne | raport po odtworzeniu = raport źródłowy; `restoreSnapshot` sam wycofuje przy różnicy |
| 0004: `audit_events` tylko do dopisywania, strażnik `role_grants` | zgodne | import to wyłącznie `INSERT`; po odtworzeniu `UPDATE`/`DELETE` są blokowane, cofnięcie roli przez `revokeRoleGrant` działa i dopisuje audyt |
| 0004: nowe kolumny `role_grants` | zgodne | `granted_by`, `source_invitation_id` puste, `granted_at` = czas importu (D1 nie zna daty nadania) |
| 0008: wydarzenia `published` z D1 | zgodne | status `published`, rewizja 1 ze źródłem `legacy_d1`, `published_at` z D1 (albo czas importu, gdy brak) |
| 0008: wydarzenia `internal` / `draft_public` | zgodne | szkice z rewizją 1; publiczny widok pokazuje tylko opublikowane; edycja tworzy rewizję 2, publicznie zostaje rewizja 1 |
| 0008: nieopublikowane wydarzenie z pozostawionym `published_at` | poprawione | wcześniej przerwanie z nieczytelnym `event_must_start_as_draft`; teraz czytelny błąd `Unpublished event has published_at: <id>` przed transakcją. Narzędzie nie zgaduje, czy wydarzenie było publiczne — decyzja należy do osoby prowadzącej migrację |
| 0009: zebrania | zgodne | nowe tabele puste i używalne; import do bazy z istniejącymi danymi jest odrzucany |
| Czas bez strefy z D1 (`YYYY-MM-DD HH:MM:SS`) | poprawione | przy strefie sesji serwera innej niż UTC (np. `Europe/Brussels`) czasy przesuwały się o 1–2 h. `restoreSnapshot` ustawia teraz `SET LOCAL TIME ZONE 'UTC'` w transakcji importu |
| Błąd w połowie transakcji (po rolach, wydarzeniach i rewizjach z triggera) | zgodne | całość wycofana, również `event_revisions` i `audit_events`; ta sama baza przyjmuje potem poprawny snapshot |
| Sesje z D1 | uzasadniona różnica | nie są przenoszone (zgodnie z [D1_POSTGRES_MIGRATION.md](D1_POSTGRES_MIGRATION.md)); nowa sesja odtworzonego użytkownika widzi tylko jego niewygasłe role, wyłączone konto pozostaje wyłączone |

## Co pozostaje

- **Księga** (`/api/ledger…`): porównanie starego i nowego API po dodaniu tras
  księgi do routera PostgreSQL (#38; osobne zadanie).
- **Import** uczniów i rodzin: brak trasy importu w obu API; porównanie wyników
  importu (1000+ syntetycznych uczniów, rodzeństwo, wspólna opieka) po #36.
- **Dokumenty**: snapshot przenosi tylko metadane; transfer obiektów do
  prywatnego Storage Bucket, krótkotrwały dostęp po autoryzacji i porównanie
  sum kontrolnych plików — do zaprojektowania i przetestowania.
- **E-mail** (Brevo): brak wysyłek w obu API; testy kolejki, idempotentnego
  klucza (kampania + rodzina), limitów i zatwierdzania treści oraz odbiorców —
  po wdrożeniu modułu, wyłącznie z odbiorcami testowymi.
- **Próba na stagingu**: odtworzenie prawdziwego eksportu D1 na Railway, raport
  uzgodnienia i backup wymagają decyzji administratora danych (#41).
