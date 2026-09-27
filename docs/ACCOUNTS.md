# Konta, zaproszenia i przydziały ról

Issues #3 (interfejs zapraszania i zarządzania kontami), #4 (wygaszanie przydziałów), #9 (audyt zmian ról).

Status: **prototyp** na PostgreSQL i danych syntetycznych. Nie jest wdrożony na Railway i nie jest gotowy do pracy na danych rodzin.

## Elementy

- API: `src/pg/routes/admin.js`, podłączone w `src/pg/app.js`.
- Interfejs: `admin/` (Vite), serwowany przez `src/node-app.js` pod `/admin/` po `npm run build:admin`.
- Testy: `tests/pg-admin.test.js` (API na PGlite), `tests/admin-core.test.js` (czyste funkcje UI).
- Migracja: brak. Wystarcza schemat z `0001_core.sql` i `0004_auth_access.sql` (kolumny `granted_by`, `revoked_at/by`, `expires_at`, trigger niezmienności przydziałów). Żadne istniejące dane nie są przepisywane.

## Dostęp

Wszystkie trasy `/api/admin/*` — także odczyt — wymagają aktywnego przydziału roli `admin` i sesji z potwierdzonym MFA (`requireAccess` po stronie serwera). Brak sesji: `401 unauthenticated`; inna rola lub brak MFA: `403 forbidden`. Każde żądanie POST bez zgodnego nagłówka `Origin` kończy się `403 invalid_origin` (router).

**Założenie do decyzji D-08/D-09:** zarząd, dyrekcja i Komisja Rewizyjna nie mają dostępu do tego modułu, również tylko do odczytu. Po zatwierdzeniu macierzy kompetencji można dodać np. odczyt przydziałów i dziennika dla zarządu — jako osobną zmianę.

## Trasy

| Metoda i ścieżka | Działanie | Audyt |
| --- | --- | --- |
| `GET /api/admin/users` | konta: id, e-mail, nazwa wyświetlana, status, liczba aktywnych ról i sesji | — |
| `POST /api/admin/users/{id}/disable` | wyłączenie konta i wycofanie wszystkich sesji | `user.disabled`, `session.revoked` × n |
| `POST /api/admin/users/{id}/enable` | ponowne włączenie; sesje nie wracają, przydziały bez zmian | `user.enabled` |
| `POST /api/admin/users/{id}/revoke-sessions` | wylogowanie ze wszystkich urządzeń | `session.revoked` × n |
| `GET /api/admin/grants` | filtry `userId`, `role`, `schoolYearId`, `classId`, `status` (`active` domyślnie, `expired`, `revoked`, `all`) | — |
| `POST /api/admin/grants` | nadanie roli `{ userId, role, classId?, schoolYearId?, expiresAt? }` | `role_grant.created` |
| `POST /api/admin/grants/{id}/revoke` | wycofanie przydziału (wiersz zostaje) | `role_grant.revoked` |
| `POST /api/admin/school-years/{id}/expire-grants` | wygaszenie kadencji, body `{ confirm: "<id>" }` | `role_grant.expired` × n, `school_year.grants_expired` |
| `GET /api/admin/invitations` | zaproszenia ze statusem (`pending`, `accepted`, `revoked`, `expired`), bez tokenów | — |
| `POST /api/admin/invitations` | `{ email, role, classId?, schoolYearId?, ttlHours? }`, zwraca token **jeden raz** | `invitation.created` |
| `POST /api/admin/invitations/{id}/revoke` | wycofanie oczekującego zaproszenia | `invitation.revoked` |
| `GET /api/admin/school-years` | lata szkolne (z flagą „zakończony”) i klasy do formularzy | — |
| `GET /api/admin/audit?limit=` | ostatnie zdarzenia kont i ról (maks. 500) | — |

## Reguły

- **Zakres przydziału.** Rola z listy `ROLES`. Rok i klasa muszą istnieć (`422 school_year_not_found`, `class_not_found`); klasa musi należeć do wskazanego roku (`422 class_not_in_school_year`). Przedstawiciel klasy wymaga klasy (`400 class_required`). Klasa bez podanego roku dziedziczy rok klasy — dzięki temu przydział podlega wygaszeniu kadencji. Przydziału nie da się przenieść na inny zakres; nowy zakres to nowy wiersz (trigger z 0004).
- **Wygaśnięcie.** `expiresAt` opcjonalne, w przyszłości, najwyżej 3 lata (założenie). Przydział wygasły przestaje działać natychmiast, bo przydziały są czytane przy każdym żądaniu.
- **Podwójne kliknięcie.** Drugie nadanie identycznego aktywnego przydziału zwraca istniejący (`200`, `created: false`) bez nowego zdarzenia. Ponowne wycofanie przydziału, zaproszenia lub wyłączenie konta zwraca `changed: false`. Drugie zaproszenie na ten sam adres i zakres przy oczekującym zaproszeniu: `409 invitation_pending`.
- **Ochrona przed zablokowaniem.** Administrator nie może wycofać ani wygasić (także przez wygaszenie kadencji) swojego ostatniego aktywnego przydziału `admin` — transakcja jest wycofywana, `409 last_admin_grant`, bez wpisu audytu. Nie może też wyłączyć własnego konta (`409 cannot_disable_self`). Zmiany przydziałów są serializowane blokadą doradczą PostgreSQL, aby dwóch administratorów nie odebrało sobie nawzajem dostępu w tym samym momencie.
- **Wygaszenie kadencji.** Tylko dla roku, którego `ends_on` minął (`409 school_year_not_finished`), po wpisaniu identyfikatora roku. Obejmuje aktywne przydziały z `school_year_id` tego roku oraz przydziały klas tego roku bez wpisanego roku. Ustawia `expires_at = now()`; wiersze zostają. Ponowienie niczego nie zmienia (0 przydziałów, jedno zdarzenie podsumowujące). Przydziały bez roku (np. zarząd „bezterminowo”) nie są objęte — wymagają ręcznego wycofania albo daty wygaśnięcia.
- **Wyłączenie konta.** `users.disabled_at` ustawiane w transakcji ze zdarzeniem `user.disabled`; od tej chwili `loadSession` odrzuca wszystkie sesje konta. Następnie `revokeUserSessions` (osobna transakcja) trwale wycofuje sesje z powodem `user_disabled` i zdarzeniem na każdą sesję. Przydziały ról nie są zmieniane.
- **Konta nie powstają w tym module.** Konto tworzy dopiero przyjęcie zaproszenia przez przyszłego dostawcę logowania.

## Zaproszenia i token

`createInvitation` (src/pg/auth.js) zapisuje wyłącznie SHA-256 tokenu. API zwraca surowy token jednorazowo w odpowiedzi `201` (`Cache-Control: no-store`); lista zaproszeń go nie zawiera. Moduł **nie wysyła e-maili** — operator przekazuje token osobnym, zaufanym kanałem. Utracony token: wycofać zaproszenie i utworzyć nowe. Ważność domyślnie 72 h, najwyżej 14 dni (założenie z AUTH.md).

**Przyjęcie zaproszenia przez HTTP jest poza zakresem.** Funkcja `acceptInvitation` istnieje, ale nie ma trasy: sposób logowania, tworzenia konta i MFA zależy od decyzji D-10 (dostawca logowania). Do tego czasu nie ma drogi utworzenia sesji z publicznego API.

## Audyt i dane osobowe

Każda zmiana i jej zdarzenie powstają w jednej transakcji (wyjątek opisany przy wyłączeniu konta: wycofanie sesji to druga transakcja, ale wyłączenie już blokuje sesje). Metadane zdarzeń zawierają wyłącznie identyfikatory: `userId`, `role`, `classId`, `schoolYearId`, `expiresAt`, `reason`, `count` — bez adresów e-mail i nazw (`assertNoPii`). `actor_id` to wykonujący administrator; `occurred_at` — czas. Dziennik jest tylko do dopisywania (trigger z 0004).

Adres e-mail i nazwa wyświetlana konta są pokazywane wyłącznie administratorowi w odpowiedziach API i w panelu; moduł nie łączy kont z danymi rodzin.

## Ryzyka i otwarte decyzje

- D-08/D-09: kto poza administratorem może przeglądać lub zmieniać przydziały.
- D-10: przyjmowanie zaproszeń i dostawca logowania; do tego czasu panel jest używalny tylko z sesjami utworzonymi poza publicznym API (testy, skrypty operatorskie).
- D-04: okres przechowywania wyłączonych kont, wygasłych przydziałów i dziennika.
- Sprawdzenie „oczekującego zaproszenia” nie jest w jednej transakcji z `createInvitation`; dwa równoczesne żądania mogą utworzyć dwa zaproszenia (oba ważne, oba w audycie). Ryzyko niskie; można je usunąć indeksem częściowym w osobnej migracji.
- Lista kont i przydziałów ma limit 500 wierszy bez stronicowania — wystarcza dla Rady, do przeglądu przy większej skali.
- Brak limitów prób i alertów na wielokrotne zmiany ról (zależne od dostawcy logowania i monitoringu Railway).
