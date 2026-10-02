# Aktualizacja kontaktu (strona publiczna dla rodzica)

Strona `/kontakt/#token=<jednorazowy token>` do tras publicznych #140: wniosek o zmianę adresu e-mail lub zgody na kontakt oraz wpisanie 8-cyfrowego kodu weryfikacyjnego nowego adresu. Prototyp na danych syntetycznych; nie jest to gotowy mechanizm do pracy na danych rodzin. Strona nie ma sesji, nie montuje powłoki paneli i nie ma nawigacji.

## Uruchomienie

```bash
npm run dev:kontakt     # Vite, sam interfejs
npm run build:kontakt   # dist/kontakt, serwowane przez src/node-app.js pod /kontakt/
```

Interfejs i API muszą działać pod tym samym originem (router odrzuca POST bez zgodnego `Origin`).

## Założenie o linku

Dotąd istniały tylko trasy API (`POST /api/admin/guardian-links` zwraca token raz); żadna strona nie przyjmowała tokenu, a `families/README.md` zapisywało, że publiczny formularz „jeszcze nie istnieje”. Ta strona jest więc pierwszym formularzem, a jej adres (`/kontakt/#token=…`) to założenie techniczne do potwierdzenia — nie decyzja Rady. Panel nadal nie wydaje linków ani nie wysyła ich rodzicom: zarząd przekazuje link poza systemem (AGENTS.md: bez automatycznej wysyłki). Token jest w części po `#`, więc nie trafia do serwera ani do jego logów; `<meta name="referrer" content="no-referrer">`; strona trzyma go wyłącznie w pamięci (nic w `localStorage` ani `sessionStorage`).

## Widoki

1. **Formularz** — `GET /api/public/guardian-update?token=` pokazuje imię opiekuna i klasy (tyle, ile zwraca API). Pola: nowy adres e-mail (opcjonalny), zgoda na kontakt (bez zmiany / wyrażam / wycofuję) i uwaga dla Rady. Pusty formularz niczego nie wysyła. Wniosek `POST /api/public/guardian-update` nie zmienia danych — czeka na zatwierdzenie zarządu (kolejka w panelu `families/`). Uwaga z możliwymi danymi osobowymi (422 `possible_personal_data`) przechodzi przez to samo okno potwierdzenia co panele (`shared/pii-confirm.js`). Usunięcia adresu strona nie oferuje (API je przyjmuje, ale to osobna decyzja o treści formularza).
2. **Wniosek wysłany** — komunikat, że dane zmienią się dopiero po zatwierdzeniu.
3. **Kod weryfikacyjny** — gdy odpowiedź ma `emailVerification: requested`, strona pokazuje pole na 8 cyfr (`inputmode="numeric"`, `autocomplete="one-time-code"`, spacje i myślniki w kodzie są pomijane) i wywołuje `POST /api/public/guardian-update/verify` z tym samym tokenem. Krok jest dobrowolny; bez potwierdzenia wniosek też trafia do zarządu, a kolejka pokazuje stan „kod wysłany, czeka na potwierdzenie”. Odpowiedź `requested` nie obiecuje dostarczenia wiadomości (serwer nie zdradza, czy adres jest zablokowany), a tekst na stronie mówi „może dotrzeć”.
4. **Link nieaktywny** — zły, wygasły albo już użyty token to jedna treść (jak API). Pole kodu zostaje wtedy dostępne, bo wiadomość z kodem przychodzi po złożeniu wniosku, a link jest już zużyty.

## Jedna treść dla każdej porażki kodu

Zły format, zły kod, kod wygasły, wyczerpany limit prób, wniosek już rozpatrzony, zły token, limit żądań (429) i brak sieci pokazują ten sam tekst (`VERIFY_FAILURE_TEXT` w `core.js`). Strona nie pokazuje, ile prób zostało, nie pokazuje adresu, na który wysłano kod, i nie rozróżnia przyczyn. Sukces to jedna linia „Adres został potwierdzony kodem”.

## Testy

`tests/kontakt-core.test.js` (czyste funkcje i wymagania statyczne: wspólny klient bez `fetch`, brak powłoki, brak `localStorage`), `tests/e2e/kontakt.spec.js` (przeglądarka, odpowiedzi API podstawione przez `page.route` — żadna wiadomość nie wychodzi). Strażnicy wspólne: `tests/shared-api.test.js`, `tests/csp-static.test.js`, `tests/a11y-static.test.js`.
