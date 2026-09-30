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
| `POST /api/admin/users/{id}/password-reset` | `{ ttlHours? }` (1–24, domyślnie 2), zwraca jednorazowy token resetu hasła **jeden raz**; nowy token unieważnia poprzedni; konto wyłączone: `409 user_disabled`; **konto z rolą `admin`/`board`/`treasurer` (poza własnym) — `202` i wniosek do zatwierdzenia przez drugą osobę, bez tokenu (#146)** | `auth.password_reset_issued`, `auth.password_reset_revoked`, dla kont chronionych `account_recovery.requested` |
| `POST /api/admin/users/{id}/mfa-reset` | `{ confirm: "<id>" }`; wyłącza czynniki MFA i niewykorzystane kody odzyskiwania, zeruje limity MFA, wylogowuje konto; nie dla własnego konta (`409 cannot_reset_own_mfa`); ponowienie: `changed: false`; konto z rolą `admin`/`board`/`treasurer` — `202` i wniosek do zatwierdzenia przez drugą osobę (#146) | `mfa.reset`, `session.revoked` × n, dla kont chronionych `account_recovery.requested` |
| `GET /api/admin/account-requests` | `?status=` (`pending` domyślnie, `approved`, `rejected`, `expired`, `all`): wnioski o reset hasła/MFA kont chronionych (#146); bez tokenów i e-maili | — |
| `POST /api/admin/account-requests/{id}/approve` | zatwierdza INNY administrator niż wnioskodawca i właściciel konta (`403 recovery_four_eyes_required`); wykonuje reset w tej samej transakcji; token resetu hasła dostaje zatwierdzający, jeden raz; wniosek zamknięty: `409 recovery_request_closed`, wygasły (24 h): `409 recovery_request_expired`; krok w górę MFA | `account_recovery.approved` + zdarzenia resetu z `requestId`, `requestedBy`, `approvedBy` |
| `POST /api/admin/account-requests/{id}/reject` | odrzucenie albo wycofanie wniosku przez dowolnego administratora | `account_recovery.rejected` |
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
- **Podwójne kliknięcie.** Drugie nadanie identycznego aktywnego przydziału zwraca istniejący (`200`, `created: false`) bez nowego zdarzenia. Ponowne wycofanie przydziału, zaproszenia lub wyłączenie konta zwraca `changed: false`. Drugie zaproszenie na ten sam adres i zakres przy oczekującym zaproszeniu: `409 invitation_pending` — także przy dwóch żądaniach naraz (sprawdzenie w transakcji zapisu pod blokadą doradczą adresu, #208).
- **Ochrona przed zablokowaniem.** Administrator nie może wycofać ani wygasić (także przez wygaszenie kadencji) swojego ostatniego aktywnego przydziału `admin` — transakcja jest wycofywana, `409 last_admin_grant`, bez wpisu audytu. Nie może też wyłączyć własnego konta (`409 cannot_disable_self`). Zmiany przydziałów są serializowane blokadą doradczą PostgreSQL, aby dwóch administratorów nie odebrało sobie nawzajem dostępu w tym samym momencie.
- **Wygaszenie kadencji.** Tylko dla roku, którego `ends_on` minął (`409 school_year_not_finished`), po wpisaniu identyfikatora roku. Obejmuje aktywne przydziały z `school_year_id` tego roku oraz przydziały klas tego roku — ta sama reguła (`role_grant_in_school_year`, 0022) co zamknięcie roku. Od 0022 przydział klasy zawsze ma rok klasy: trigger uzupełnia brakujący rok, odrzuca rok inny niż rok klasy, a ograniczenie `role_grant_class_requires_year` nie dopuszcza klasy bez roku. Ustawia `expires_at = now()`; wiersze zostają. Ponowienie niczego nie zmienia (0 przydziałów, jedno zdarzenie podsumowujące). Przydziały bez roku (np. zarząd „bezterminowo”) nie są objęte — wymagają ręcznego wycofania albo daty wygaśnięcia.
- **Wyłączenie konta.** `users.disabled_at` ustawiane w transakcji ze zdarzeniem `user.disabled`; od tej chwili `loadSession` odrzuca wszystkie sesje konta. Ustawienie `disabled_at`, zdarzenie `user.disabled`, unieważnienie tokenów resetu hasła i trwałe wycofanie sesji (`revokeUserSessionsWith`, powód `user_disabled`, zdarzenie `session.revoked` na każdą sesję) zatwierdzają się w **jednej** transakcji (#256): awaria któregokolwiek kroku cofa całość, więc konto nie zostaje „wyłączone”, a sesje w bazie aktywne (po ponownym włączeniu konta mogłyby znów zadziałać). Dowód: `tests/pg-admin.test.js` (błąd wstrzyknięty przed i po zapytaniu `UPDATE sessions`, PGlite) oraz `tests/pg-disable-session-race.test.js` (przeplot na prawdziwym PostgreSQL, wymaga `RD_TEST_PG_URL`; w CI jest pomijany bez tej zmiennej). Przydziały ról nie są zmieniane.
- **Konta nie powstają w tym module.** Konto tworzy przyjęcie zaproszenia: `POST /api/invitations/accept` (src/pg/routes/login.js, ekran `/login/#invite=<token>`) z adresem e-mail z zaproszenia i hasłem ustawionym przez zapraszaną osobę. Gdy konto o tym adresie już istnieje, trzeba podać jego obecne hasło — zaproszenie tylko dopisuje rolę (token zaproszenia nie może przejąć istniejącego konta).
- **Reset hasła i MFA.** Tylko administrator z MFA; token resetu przekazuje osobnym, zaufanym kanałem (moduł nie wysyła e-maili, D-16/D-17). Reset hasła wylogowuje wszystkie sesje konta, ale nie zmienia MFA. Reset MFA to procedura na utratę telefonu i wszystkich kodów odzyskiwania — sposób potwierdzenia tożsamości osoby przed resetem wymaga decyzji (D-10). Panel `admin/` nie ma jeszcze przycisków dla tych dwóch operacji — dostępne przez API.

## Zaproszenia i token

`createInvitation` (src/pg/auth.js) zapisuje wyłącznie SHA-256 tokenu. API zwraca surowy token jednorazowo w odpowiedzi `201` (`Cache-Control: no-store`); lista zaproszeń go nie zawiera. Moduł **nie wysyła e-maili** — operator przekazuje token osobnym, zaufanym kanałem. Utracony token: wycofać zaproszenie i utworzyć nowe. Ważność domyślnie 72 h, najwyżej 14 dni (założenie z AUTH.md).

**Podgląd zaproszenia (#164):** `POST /api/invitations/preview` `{ token }` (bez sesji, tylko odczyt, token nie jest konsumowany) zwraca `{ email, role, className, schoolYear, expiresAt, accountExists }`: adres zamaskowany (`j…@domena`), bez zapraszającego i identyfikatorów; `accountExists` = konto ma już hasło (przyjęcie wymaga obecnego hasła). Limit prób jak przy `accept` (zakres IP); każda odmowa to `400 invalid_invitation`, błędy w audycie jako `auth.invitation_preview_failed`, sukces bez zdarzenia. Założenie do potwierdzenia przez IOD: posiadacz ważnego tokenu może zobaczyć zamaskowany adres (token i tak pozwala utworzyć konto na ten adres).

**Przyjęcie zaproszenia przez HTTP:** `POST /api/invitations/accept` `{ token, password, displayName? }` — jednorazowe (blokada wiersza zaproszenia), sprawdza wygaśnięcie i wycofanie, tworzy konto (jeśli brak), zapisuje skrót hasła, nadaje rolę z zaproszenia i tworzy sesję bez MFA. Odmowa zawsze jako `400 invalid_invitation`. Metoda logowania (e-mail + hasło + TOTP) to wskazanie użytkownika do formalnego potwierdzenia (D-10); szczegóły w [AUTH.md](AUTH.md). Link dla zapraszanej osoby: `/login/#invite=<token>` (token w części po `#`, nie trafia do logów serwera).

## Audyt i dane osobowe

Każda zmiana i jej zdarzenie powstają w jednej transakcji (również wyłączenie konta: wycofanie sesji jest w tej samej transakcji, #256). Metadane zdarzeń zawierają wyłącznie identyfikatory: `userId`, `role`, `classId`, `schoolYearId`, `expiresAt`, `reason`, `count` — bez adresów e-mail i nazw (`assertNoPii`). `actor_id` to wykonujący administrator; `occurred_at` — czas. Dziennik jest tylko do dopisywania (trigger z 0004).

Adres e-mail i nazwa wyświetlana konta są pokazywane wyłącznie administratorowi w odpowiedziach API i w panelu; moduł nie łączy kont z danymi rodzin.

## Ryzyka i otwarte decyzje

- D-08/D-09: kto poza administratorem może przeglądać lub zmieniać przydziały.
- D-10: metoda logowania (e-mail + hasło + TOTP) jest wskazaniem użytkownika, nie decyzją zarządu; do potwierdzenia wraz z procedurą resetu hasła i MFA oraz listą ról z obowiązkowym MFA (`MFA_REQUIRED_ROLES`, domyślnie admin, zarząd, skarbnik).
- D-04: okres przechowywania wyłączonych kont, wygasłych przydziałów i dziennika.
- Sprawdzenie „oczekującego zaproszenia” nie jest w jednej transakcji z `createInvitation`; dwa równoczesne żądania mogą utworzyć dwa zaproszenia (oba ważne, oba w audycie). Ryzyko niskie; można je usunąć indeksem częściowym w osobnej migracji.
- Lista kont i przydziałów ma limit 500 wierszy bez stronicowania — wystarcza dla Rady, do przeglądu przy większej skali.
- Limity prób logowania istnieją (AUTH.md); brak alertów na wielokrotne zmiany ról i nieudane logowania (zależne od monitoringu Railway).

## Reset hasła i MFA kont chronionych (#146, wariant zachowawczy)

Konto z aktywną rolą `admin`, `board` lub `treasurer` (`PROTECTED_ACCOUNT_ROLES`
w `src/pg/account-recovery.js`) nie może mieć hasła ani MFA zresetowanego przez
jedną osobę: pierwszy administrator zapisuje wniosek (`202`, ważny 24 h, jeden
otwarty wniosek na konto i rodzaj), a token resetu lub wyłączenie MFA powstaje
dopiero przy zatwierdzeniu przez innego administratora, który nie jest
właścicielem konta. Zasadę pilnuje też baza (`CHECK` w
`account_recovery_requests`, migracja 0125). Token dostaje zatwierdzający i
przekazuje go właścicielowi osobnym, zaufanym kanałem.

`auth.password_reset_completed` niesie `metadata.issuedBy` (kto wydał token) i
`requestId`, więc dziennik odróżnia konto po resecie administracyjnym; wpisy
resetu zawierają `requestedBy` i `approvedBy`. Reset hasła własnego konta oraz
konta bez roli chronionej działają bezpośrednio jak dotąd.

Poza zakresem (zależy od decyzji): powiadomienie właściciela konta (D-16/D-17 —
brak zatwierdzonego szablonu i nadawcy, moduł nic nie wysyła), ścieżka awaryjna
przy jednym administratorze (D-10), zakres ról zatwierdzających (D-08; dziś
wyłącznie administrator), sekcja „operacje administracyjne na kontach” w
raporcie audytu oraz odebranie roli `admin` z modułów finansowych (D-08).
