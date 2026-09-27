# Uwierzytelnianie — fundament sesji

Ten etap dodaje wyłącznie serwerową obsługę już utworzonej sesji. Nie udostępnia publicznej rejestracji, formularza logowania, akceptowania zaproszeń ani sposobu nadawania ról.

## Zasady

- Sekret sesji ma 256 bitów losowości i trafia do przeglądarki w cookie HttpOnly, Secure, SameSite=Lax.
- D1 przechowuje wyłącznie SHA-256 sekretu. Surowy sekret nie może znaleźć się w bazie, logach ani dzienniku audytu.
- Sesja jest ważna najwyżej 24 godziny. Zapytanie odrzuca sesję wygasłą, wycofaną i konto wyłączone.
- GET /api/session zwraca minimum danych bieżącego użytkownika i stan potwierdzenia MFA.
- POST /api/logout wymaga zgodnego nagłówka Origin, wycofuje sesję i zapisuje zdarzenie audytowe.
- Tabele invitations i sessions tworzy migracja 0002_auth_sessions.sql. Migracji zdalnej nie uruchamiać bez przeglądu.

## Dalszy zakres issue #3

Do wdrożenia pozostaje wybór i konfiguracja dostawcy logowania, publiczne trasy zaproszeń oraz interfejs zarządzania kontami. Do tego czasu nie ma drogi utworzenia sesji z publicznego API. Przepływ MFA, limity prób i cofanie wszystkich sesji opisuje sekcja „MFA i cofanie sesji” niżej (prototyp na PostgreSQL).

## Warstwa PostgreSQL (issue #35) — prototyp

Status: prototyp na danych syntetycznych, **nie** jest gotowy do pracy na danych rodzin i **nie** jest wdrożony na Railway.

- `src/pg/auth.js` przenosi sesje na PostgreSQL (`env.db`, kontrakt z `src/db.js`): `loadSession`, `revokeSession` (wycofanie i zdarzenie audytu w jednej transakcji, ponowne wylogowanie nie dubluje wpisu), `rotateSession` (stara sesja `revoked_reason='rotated'`, nowa wskazuje ją w `rotated_from`), `revokeUserSessions` i `createSession`.
- Zaproszenia: `createInvitation`, `acceptInvitation`, `revokeInvitation`. Zaproszenie jest jednorazowe (blokada wiersza i `UNIQUE role_grants.source_invitation_id`), wygasa, może zostać wycofane, a adres konta musi odpowiadać adresowi zaproszenia. Odpowiedź HTTP powinna zwracać wyłącznie `invalid_invitation`; pole `reason` służy testom i diagnostyce.
- Te funkcje nie mają jeszcze publicznej trasy HTTP. Kto może zapraszać i do jakich ról, sprawdza wywołujący (`requireAccess`).
- Trasy `/api/session`, `/api/access`, `/api/logout` mają ten sam JSON, kody i cookie co Worker. Każde żądanie POST/PUT/PATCH/DELETE pod `/api/` bez zgodnego nagłówka `Origin` kończy się `403 invalid_origin`.
- Dziennik audytu zapisuje identyfikatory, nie adresy e-mail ani imiona (`assertNoPii`). Logi techniczne zawierają tylko nazwę modułu i kod błędu.

Założenia do potwierdzenia: ważność zaproszenia 72 h (najwyżej 14 dni), sesja najwyżej 24 h, MFA potwierdzane raz na sesję (bez wymogu ponownego potwierdzenia przed operacją finansową).

Otwarte decyzje szkoły/zarządu: dostawca logowania i metoda MFA (od nich zależą limity prób i blokady), kto może zapraszać do których ról, zakres dyrekcji i Komisji Rewizyjnej.

## MFA i cofanie sesji (issue #3) — prototyp, metoda do zatwierdzenia

Status: prototyp na danych syntetycznych, **nie** jest wdrożony. Metoda MFA jest otwartą decyzją (D-10). TOTP opisany niżej to **proponowana** metoda domyślna, zaimplementowana za interfejsem `MFA_METHODS` w `src/pg/mfa.js`; inną metodę (np. klucze sprzętowe) można dodać jako kolejny wpis bez zmiany tras. Parametry limitów i liczba kodów odzyskiwania też czekają na zatwierdzenie.

Proponowane parametry: TOTP według RFC 6238 — HMAC-SHA-1, 6 cyfr, krok 30 s, tolerancja ±1 krok (zegar telefonu może się spieszyć lub spóźniać do 30 s). Sekret ma 160 bitów.

Trasy (wszystkie POST, wymagają aktywnej sesji i zgodnego nagłówka `Origin`; bez sesji `401 unauthenticated`, z obcej domeny `403 invalid_origin`):

- `POST /api/mfa/enroll` — tworzy oczekujący czynnik i **jeden raz** zwraca sekret (base32) oraz URI `otpauth://` do zeskanowania. Poprzedni niepotwierdzony czynnik zostaje wyłączony. Gdy konto ma już potwierdzony czynnik, wymiana wymaga sesji z potwierdzonym MFA (`403 mfa_required`) — inaczej przejęta sesja pozwoliłaby obejść MFA. Bez poprawnego klucza szyfrowania: `503 mfa_unavailable`.
- `POST /api/mfa/confirm` z `{ "code": "123456" }` — potwierdza czynnik pierwszym kodem, wyłącza poprzedni potwierdzony czynnik (i unieważnia jego kody odzyskiwania), generuje 10 kodów odzyskiwania i zwraca je **jeden raz**. Sesja zostaje oznaczona jako potwierdzona MFA i zrotowana.
- `POST /api/mfa/verify` z `{ "code": "123456" }` — ustawia `sessions.mfa_verified_at` wyłącznie dla **bieżącej** sesji, po czym od razu ją rotuje (`rotateSession`): stara sesja dostaje `revoked_reason='rotated'`, nowy sekret trafia tylko do cookie (ochrona przed utrwaleniem sesji). Inne sesje tego samego konta pozostają bez MFA.
- `POST /api/mfa/recovery` z `{ "code": "XXXX-XXXX-XXXX-XXXX" }` — zamiast kodu TOTP; kod odzyskiwania jest jednorazowy. Wielkość liter, spacje i myślniki nie mają znaczenia.
- `POST /api/sessions/revoke-all` — wycofuje wszystkie aktywne sesje **własnego** konta, także bieżącą (`revoked_reason='user_revoke_all'`), czyści cookie i zwraca `{ "revoked": n }`. Nie dotyka sesji innych kont.

Ochrona:

- Sekret czynnika jest przechowywany wyłącznie jako szyfrogram AES-256-GCM (`secret_ciphertext`, `secret_iv`, `secret_tag`). Klucz pochodzi ze zmiennej `MFA_ENCRYPTION_KEY` (32 bajty: 64 znaki hex albo base64), ustawianej tylko jako sekret usługi Railway, nigdy w repozytorium. Dane uwierzytelniające szyfrowania (AAD) wiążą szyfrogram z identyfikatorem czynnika i konta, więc przeniesienie go do innego wiersza nie zadziała. Zmiana klucza wymaga ponownego zapisu czynników (kolumna `key_version` jest przygotowana; procedury rotacji klucza jeszcze nie ma).
- Kody są porównywane w czasie stałym (`timingSafeEqual`) dla każdego kroku okna, bez wczesnego wyjścia.
- Powtórzenie: zapamiętywany jest ostatni przyjęty krok (`last_used_step`); kod z tego samego lub starszego kroku jest odrzucany także w innej sesji. Trigger nie pozwala cofnąć tej wartości.
- Limity: błędne kody (także powtórzone i źle sformatowane) liczą się osobno dla konta i dla sesji. Proponowane: 5 błędów w 15 minut → blokada na 15 minut (`429 mfa_locked` z nagłówkiem `Retry-After`). W czasie blokady kod nie jest sprawdzany ani zużywany. Poprawny kod zeruje liczniki konta i bieżącej sesji. Licznik i wpis audytu są zapisywane w tej samej transakcji; próby jednego konta są serializowane blokadą wiersza.
- Kody odzyskiwania mają 80 bitów losowości; w bazie jest tylko SHA-256. Użycie zapisuje czas i sesję; ponowne użycie jest odrzucane i liczone jako błąd.
- Czynników ani kodów nie da się usunąć ani przepisać (triggery); wyłączenie to `disabled_at`, unieważnienie kodów to `invalidated_at`.
- Dziennik audytu: `mfa.enrollment_started`, `mfa.enrolled`, `mfa.verified`, `mfa.failed` (z powodem `invalid_code`/`replay`), `mfa.locked` (zakres `user` lub `session`), `mfa.recovery_used` (z liczbą pozostałych kodów) oraz `session.revoked` dla każdej sesji. Metadane zawierają tylko identyfikatory i kody powodów — nigdy sekretu, kodu, adresu e-mail ani imienia.

Migracja: `postgres/migrations/0013_mfa.sql` (opis skutków w `postgres/README.md`).

Założenia do potwierdzenia (D-10): metoda TOTP i jej parametry, progi blokady, 10 kodów odzyskiwania, etykieta `RD` w aplikacji uwierzytelniającej, brak wymogu MFA dla cofnięcia wszystkich własnych sesji (to działanie ochronne), procedura odzyskania dostępu po utracie telefonu i wszystkich kodów (dziś tylko ręcznie przez administratora — trasy administracyjnej nie ma).
