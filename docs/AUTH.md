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

Do wdrożenia pozostaje wybór i konfiguracja dostawcy logowania, wystawianie i akceptacja jednorazowych zaproszeń, rotacja sesji, pełny przepływ MFA, limity prób oraz interfejs zarządzania kontami. Do tego czasu nie ma drogi utworzenia sesji z publicznego API.

## Warstwa PostgreSQL (issue #35) — prototyp

Status: prototyp na danych syntetycznych, **nie** jest gotowy do pracy na danych rodzin i **nie** jest wdrożony na Railway.

- `src/pg/auth.js` przenosi sesje na PostgreSQL (`env.db`, kontrakt z `src/db.js`): `loadSession`, `revokeSession` (wycofanie i zdarzenie audytu w jednej transakcji, ponowne wylogowanie nie dubluje wpisu), `rotateSession` (stara sesja `revoked_reason='rotated'`, nowa wskazuje ją w `rotated_from`), `revokeUserSessions` i `createSession`.
- Zaproszenia: `createInvitation`, `acceptInvitation`, `revokeInvitation`. Zaproszenie jest jednorazowe (blokada wiersza i `UNIQUE role_grants.source_invitation_id`), wygasa, może zostać wycofane, a adres konta musi odpowiadać adresowi zaproszenia. Odpowiedź HTTP powinna zwracać wyłącznie `invalid_invitation`; pole `reason` służy testom i diagnostyce.
- Te funkcje nie mają jeszcze publicznej trasy HTTP. Kto może zapraszać i do jakich ról, sprawdza wywołujący (`requireAccess`).
- Trasy `/api/session`, `/api/access`, `/api/logout` mają ten sam JSON, kody i cookie co Worker. Każde żądanie POST/PUT/PATCH/DELETE pod `/api/` bez zgodnego nagłówka `Origin` kończy się `403 invalid_origin`.
- Dziennik audytu zapisuje identyfikatory, nie adresy e-mail ani imiona (`assertNoPii`). Logi techniczne zawierają tylko nazwę modułu i kod błędu.

Założenia do potwierdzenia: ważność zaproszenia 72 h (najwyżej 14 dni), sesja najwyżej 24 h, MFA potwierdzane raz na sesję (bez wymogu ponownego potwierdzenia przed operacją finansową).

Otwarte decyzje szkoły/zarządu: dostawca logowania i metoda MFA (od nich zależą limity prób i blokady), kto może zapraszać do których ról, zakres dyrekcji i Komisji Rewizyjnej.
