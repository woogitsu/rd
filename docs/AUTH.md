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
