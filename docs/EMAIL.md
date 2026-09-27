# Dobrowolne składki — przypomnienia e-mail

Stan: prototyp na PostgreSQL (issues #10, #40). **Nie jest wdrożony i nie jest gotowy do pracy na danych rodzin.** Wysyłka do rodziców wymaga decyzji D-05, D-06, D-16 i D-17 ([DECISIONS.md](DECISIONS.md)) oraz osobnej zgody szkoły na produkcję (D-20).

## Dostawca i pojemność
Brevo Free: do 300 wysłanych wiadomości dziennie, limit wspólny dla całego konta. Przy maksymalnie 2000 adresatach jednej kampanii potrzeba co najmniej 7 dni (6 × 300 + 200), jeżeli nie ma innych wiadomości. Liczba adresatów nie wynika wprost z liczby uczniów: liczymy unikalne adresy, politykę wysyłki do jednego lub obu opiekunów i brak duplikatów przy rodzeństwie. Przed produkcją sprawdzić bieżący regulamin dostawcy, domenę i warunki przetwarzania danych.

## Przepływ
1. Skarbnik lub członek zarządu (MFA) tworzy szkic kampanii dla roku szkolnego: temat, treść, odbiorcy (`all_households` albo `no_payment_record` — „brak wpisu wpłaty”).
2. Serwer buduje migawkę odbiorców (`POST …/snapshot`): jedna wiadomość na rodzinę, tylko opiekunowie ze zgodą na kontakt, bez adresów z listy wyłączeń, bez powtórzeń adresu w kampanii. Wykluczenia są zapisane z powodem.
3. Podgląd (`GET …/preview`) pokazuje liczbę odbiorców, wykluczenia, próbkę spersonalizowanej treści, plan dni i skróty treści oraz listy. Podgląd niczego nie wysyła. Lista adresatów (`GET …/recipients`) jest dostępna do weryfikacji, a każdy odczyt trafia do dziennika.
4. Członek zarządu z MFA, **inny niż autor** (tworzący, ostatnio edytujący i budujący listę), zatwierdza dokładne skróty treści i listy, które widział w podglądzie. Każda późniejsza zmiana treści lub przebudowa listy cofa kampanię do szkicu i wymaga ponownego zatwierdzenia.
5. `POST …/queue` tworzy wiersze kolejki `email_outbox` (klucz `campaign:<id>:household:<id>`, unikalny) i ustala dzienny przydział kampanii. Zadanie Railway wysyła każdą wiadomość osobno i nie przekracza limitu.
6. Webhook Brevo zapisuje wynik; bounce, skarga lub wypisanie dopisuje adres (tylko jego skrót) do listy wyłączeń i zapisuje w dzienniku potrzebę poprawy danych opiekuna.
7. `GET /api/email/campaigns/{id}` pokazuje wysłane, oczekujące, błędy, pominięte po wpłacie i wyłączone. Wznowienie nie duplikuje wiadomości.

Anulowanie (`POST …/cancel`) zatrzymuje wiersze oczekujące w kolejce. Wiadomość już przejęta przez zadanie (stan `sending`) może jeszcze wyjść.

## Dobór adresatów (założenie do decyzji D-11 i D-17)
Rodzina = gospodarstwo (`household_id`) ucznia zapisanego w danym roku. Adresat to opiekun, który ma zgodę na kontakt jednocześnie na koncie (`guardians.contact_allowed`) i w aktywnej relacji z dzieckiem z tej rodziny (`student_guardians.contact_allowed`, daty relacji). Kolejność: kontakt główny, potem najmniejszy identyfikator. Jeżeli ten sam adres został już użyty dla innej rodziny w tej kampanii, wybierany jest kolejny opiekun, a przy jego braku rodzina jest wykluczona (`duplicate_address`). Powody wykluczenia: `no_consent`, `no_valid_email`, `suppressed`, `duplicate_address`, `payment_recorded`. Wysyłka do obojga opiekunów wymaga decyzji D-17 i zmiany klucza idempotencji.

## Brak wpisu wpłaty
Lista „brak wpisu wpłaty” może być nieaktualna (np. wpłata nieprzypisana lub gotówka niewpisana). Dlatego zadanie sprawdza wpłaty ponownie tuż przed wysyłką każdej wiadomości i pomija rodzinę, dla której pojawiła się wpłata netto > 0 (stan `skipped`). Nie stosujemy statusu „dłużnik”; treść musi zawierać zdanie o pominięciu wiadomości po wpłacie (podgląd ostrzega, gdy go brak).

## Treść
Neutralna i dyskretna: „przypomnienie o możliwości wniesienia dobrowolnej składki”, bez określenia „dług”, bez nazwiska dziecka w temacie. Podaj zatwierdzone dane do wpłaty, kontakt oraz „jeśli wpłata została już wykonana, prosimy pominąć wiadomość”. Dane konta bankowego pobierać z konfiguracji zatwierdzonej dla danego roku (D-13).

Serwer odrzuca słownictwo sugerujące zadłużenie (ten sam słownik co kartki w `print/core.js`: zaległość, dług, dłużnik, zadłużenie, windykacja, należność, monit, wezwanie). Dozwolone placeholdery: `{rok}` (temat i treść) oraz `{rodzina}` (identyfikator rodziny jako tytuł przelewu, tylko treść). Nieznany placeholder jest błędem. Brak placeholderów z imieniem dziecka lub opiekuna. Wiadomość jest czystym tekstem.

## Bariery bezpieczeństwa wysyłki
- `EMAIL_SENDING_ENABLED` musi mieć dokładnie wartość `true`; inaczej przebieg „live” zatrzymuje się bez zmian w kolejce.
- Transport Brevo odmawia pracy przy `APP_ENV=test` i pod `node --test`, zanim wywoła sieć. Testy używają wyłącznie fałszywego transportu, a globalny `fetch` jest w nich pułapką.
- Poza `APP_ENV=production` każdy adres musi pasować do `EMAIL_TEST_ALLOWLIST` (adresy techniczne, np. `*@example.invalid,ops@example.test`); pusta lista blokuje wszystko. Odmowa jest zapisana jako `failed / recipient_not_allowlisted`.
- Tuż przed wysyłką zadanie sprawdza ponownie: wpłatę (dla „brak wpisu wpłaty”), listę wyłączeń, zgodę na kontakt i zgodność adresu, skrót zatwierdzonej treści.
- Podczas migracji na Railway nie ustawiamy `EMAIL_SENDING_ENABLED=true` na żadnym środowisku z danymi rodzin; staging ma tylko dane syntetyczne i listę adresów technicznych.

## Kolejka i idempotencja
- Jeden wiersz `email_outbox` na (kampania, rodzina), klucz `campaign:<id>:household:<id>` unikalny; ponowne zakolejkowanie nie tworzy duplikatów.
- Stany: `queued → sending → sent → bounced`; `queued → skipped | suppressed | failed | cancelled`; `sending → failed | queued` (tylko po jawnej odmowie 429). Trigger blokuje inne przejścia i usuwanie.
- Zadanie przejmuje wiersze `FOR UPDATE SKIP LOCKED` i w tej samej transakcji zmienia stan na `sending`, więc dwa równoległe przebiegi nie wyślą tego samego wiersza.
- Ponowienie z opóźnieniem (5 min × 2^(próba−1), maks. 6 h, najwyżej `EMAIL_MAX_ATTEMPTS`) tylko przy 429. Timeout, błąd sieci i 5xx dają `failed / delivery_unknown` **bez** automatycznego ponowienia, bo nie wiadomo, czy Brevo przyjęło wiadomość. Wiersz w `sending` dłużej niż 15 min (awaria procesu) też trafia do `delivery_unknown`. Takie przypadki wymagają ręcznego sprawdzenia w logach Brevo (nagłówki `X-Mailin-custom` = id wiersza, `X-RD-Idempotency-Key`). Brevo nie gwarantuje deduplikacji po swojej stronie; idempotencję zapewnia nasza kolejka.

## Dzienny limit
- Dziennik `email_send_ledger` (dzień UTC, tylko dopisywanie) liczy każdą przejętą wiadomość kampanii oraz inne wiadomości konta (`source = 'other'`, funkcja `recordOtherSends`).
- Pula dnia = `EMAIL_DAILY_LIMIT` (domyślnie 300) − `EMAIL_DAILY_RESERVED` (rezerwa na inne wiadomości konta, np. zaproszenia, wysyłki ręczne z panelu Brevo) − wszystkie wpisy dnia.
- Przydział kampanii na dzień = max(ceil(N / `EMAIL_CAMPAIGN_MIN_DAYS`), `EMAIL_CAMPAIGN_MIN_DAILY`), nie więcej niż pula konta. Dla ~2000 adresatów: 286 dziennie, 7 dni.
- Założenie: doba Brevo liczona jest w UTC. Jeżeli dostawca liczy inaczej, rezerwa `EMAIL_DAILY_RESERVED` powinna pokryć różnicę. Wiadomości wysłane poza aplikacją trzeba dopisać do dziennika lub pokryć rezerwą.

## Zadanie na Railway
`npm run email:worker` wykonuje jeden przebieg i kończy proces. Domyślnie jest to **dry-run**: te same sprawdzenia i renderowanie, zapis przebiegu w `email_worker_runs`, bez zmian w kolejce i dzienniku limitu i bez połączenia z Brevo. Wysyłka: `npm run email:worker -- --send` przy `EMAIL_SENDING_ENABLED=true`.

Proponowana konfiguracja (nie jest włączona automatycznie — wymaga decyzji szkoły):
- osobna usługa Railway z tym samym repozytorium, komenda startowa `npm run email:worker -- --send`, harmonogram cron co godzinę w dzień roboczy, np. `15 7-18 * * 1-5` (UTC);
- zmienne: `DATABASE_URL` (sieć prywatna), `APP_ENV`, `EMAIL_*`, `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME`. Serwer HTTP nie potrzebuje `BREVO_API_KEY`.
- Log przebiegu zawiera wyłącznie liczby i kody.

## Webhook Brevo
`POST /api/email/webhooks/brevo`. Brevo nie podpisuje treści HMAC; weryfikacja to wspólny sekret `BREVO_WEBHOOK_SECRET` (min. 32 znaki) przesyłany w nagłówku `Authorization: Bearer <sekret>` (konfiguracja „auth” webhooka Brevo) albo jako hasło Basic Auth. Porównanie w stałym czasie; zły lub brak sekretu → 401, brak konfiguracji → 503. To jedyna trasa API zwolniona z kontroli `Origin`. Zapisujemy tylko zweryfikowane zdarzenia, bez adresu (skrót SHA-256), z deduplikacją. `hard_bounce`, `invalid_email`, `blocked`, `spam`, `unsubscribed` dopisują adres do listy wyłączeń; bounce zmienia stan wiersza na `bounced`. Zdjęcie adresu z listy wyłączeń nie jest zaimplementowane (wymaga procedury i decyzji).

## Zmienne środowiskowe
| Zmienna | Znaczenie |
|---|---|
| `EMAIL_SENDING_ENABLED` | `true` włącza wysyłkę; domyślnie wyłączona |
| `EMAIL_TEST_ALLOWLIST` | poza produkcją: dozwolone adresy techniczne (`*@domena` lub pełny adres, po przecinku) |
| `EMAIL_DAILY_LIMIT` | limit konta Brevo na dobę (domyślnie 300) |
| `EMAIL_DAILY_RESERVED` | rezerwa na inne wiadomości konta (domyślnie 0) |
| `EMAIL_CAMPAIGN_MIN_DAYS` | minimalna liczba dni rozłożenia kampanii (domyślnie 7) |
| `EMAIL_CAMPAIGN_MIN_DAILY` | minimalny dzienny przydział małej kampanii (domyślnie 50) |
| `EMAIL_BATCH_SIZE` | wiersze na jeden przebieg (domyślnie 50) |
| `EMAIL_MAX_ATTEMPTS` | maks. prób przy 429 (domyślnie 5) |
| `BREVO_API_KEY` | sekret usługi zadania; nigdy w repo ani frontendzie |
| `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME` | zweryfikowany nadawca (D-17) |
| `BREVO_WEBHOOK_SECRET` | wspólny sekret webhooka |

## Wdrożenie
Brevo API key w sekrecie serwera, zweryfikowana domena, SPF/DKIM/DMARC, osobny adres nadawcy i uwierzytelniony webhook. Nie wysyłać poczty bezpośrednio z przeglądarki ani nie ujawniać klucza w frontendzie. Najpierw testy na kilku własnych adresach technicznych i potwierdzenie szablonu przez Radę.

Źródło limitu: https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan
