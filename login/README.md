# Ekran logowania

Lekki interfejs Vite do tras `POST /api/login`, `/api/mfa/*`, `/api/invitations/preview`, `/api/invitations/accept`, `/api/password/*` (src/pg/routes/login.js, src/pg/routes/mfa.js). Prototyp na danych syntetycznych; bez danych demonstracyjnych i bez obejścia logowania.

## Uruchomienie

```bash
npm run dev:login      # Vite, sam interfejs
npm run build:login    # dist/login, serwowane przez src/node-app.js pod /login/
```

`/` przekierowuje (308) na `/login/`; strona publiczna jest pod `/site/`. Interfejs i API muszą działać pod tym samym originem — cookie sesji jest `HttpOnly; Secure; SameSite=Lax`, a router odrzuca POST bez zgodnego nagłówka `Origin`.

## Widoki

1. **Logowanie** — e-mail (`autocomplete="username"`) i hasło (`autocomplete="current-password"`), przycisk „Pokaż hasło”, wklejanie i menedżery haseł dozwolone, bez CAPTCHA (WCAG 3.3.8). Ten sam komunikat dla nieznanego adresu i złego hasła.
2. **Kod z aplikacji** — pole `inputmode="numeric"`, `autocomplete="one-time-code"`; link do kodu odzyskiwania.
3. **Konfiguracja MFA** — kod QR generowany w przeglądarce (`qrcode-generator`, bez zewnętrznych usług i CDN), klucz do wpisania ręcznie, potwierdzenie pierwszym kodem, 10 kodów odzyskiwania pokazanych raz i pole „Zapisałem kody w bezpiecznym miejscu” przed przejściem dalej. Po potwierdzeniu klucz i kod QR znikają z ekranu.
4. **Zaproszenie** — `/login/#invite=<token>`: token w części po `#` nie trafia do serwera ani jego logów; skrypt przenosi go do pola i usuwa z paska adresu (`history.replaceState`). Nowe konto ustawia hasło; istniejące konto podaje obecne hasło.
5. **Reset hasła** — `/login/#reset=<token>`; kod wydaje wyłącznie administrator (`POST /api/admin/users/{id}/password-reset`). Panel nie wysyła e-maili.
6. **Zmiana hasła** — obecne i nowe hasło; pozostałe sesje zostają wylogowane.
7. **Start** — lista paneli wynikająca z przydziałów konta (`visiblePanels` z `shared/shell.js`; to tylko nawigacja, dostęp sprawdza serwer) i link do strony publicznej, wylogowanie i wylogowanie ze wszystkich urządzeń.

Wspólny komputer (#197): ekran to jedna strona, więc przy wylogowaniu, „Wróć do logowania”, zmianie części „#…”, przejściu do kolejnego etapu i `pagehide` funkcja `clearSensitiveViews` (login/core.js) usuwa z DOM klucz TOTP, kod QR, kody odzyskiwania i wszystkie pola haseł i kodów oraz wyłącza „Pokaż hasło”. Komunikat „Wylogowano” pojawia się tylko po odpowiedzi 204 lub 401; przy błędzie sieci lub serwera ekran mówi, że sesja może być nadal aktywna, i zostaje w bieżącym widoku. Wygasła lub zastąpiona konfiguracja MFA (`mfa_enrollment_not_found`) wraca do przycisku „Rozpocznij”. Poza zakresem: znikanie kodów odzyskiwania po czasie i potwierdzenie „Zapisałem kody” przed wylogowaniem (propozycja 2 w #197).

Powrót do panelu (#99): wspólny klient paneli (`shared/api.js`) po 401 oraz 403 `mfa_required` / `mfa_enrollment_required` przekierowuje na `/login/#next=<ścieżka panelu>`. Krok (logowanie, kod, konfiguracja MFA) wybiera `nextView` jak zwykle. `next` jest przyjmowany wyłącznie jako ścieżka względna tego samego origin (`safeNextPath`: zaczyna się od `/`, nie od `//`, bez `\`, znaków sterujących, `/login/` i `/api/`); po zakończeniu logowania w tej karcie strona wraca na tę ścieżkę. Gdy sesja jest już pełna przy samym wejściu na `/login/`, ekran pokazuje listę paneli z odnośnikiem „Powrót do poprzedniej strony” zamiast przekierowania (ochrona przed pętlą). `next` jest trzymany tylko w pamięci strony — nic nie trafia do localStorage.

Kolejność widoków po zalogowaniu wybiera `nextView` (core.js) na podstawie `GET /api/auth/state`. Walidacja w przeglądarce (długość hasła, format kodu) jest tylko podpowiedzią — reguły egzekwuje serwer.

Testy czystych funkcji i statycznych wymagań HTML/CSS: `tests/login-core.test.js`. Szczegóły przepływu i otwarte decyzje: [docs/AUTH.md](../docs/AUTH.md).
