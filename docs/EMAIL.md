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

Anulowanie (`POST …/cancel`) zatrzymuje wiersze oczekujące w kolejce (`cancelledMessages`). Wiersze już przejęte przez zadanie (`sending`) zadanie samo oznacza jako `cancelled` przy potwierdzeniu przed wysyłką — wyjść może najwyżej wiadomość, której przekazanie do Brevo już trwa (jedna na proces zadania). Wiadomości przyjętej przez Brevo nie da się cofnąć.

## Dobór adresatów (założenie do decyzji D-11 i D-17)
Rodzina = główne gospodarstwo ucznia zapisanego w danym roku, obowiązujące dziś w Brukseli (`student_primary_household_on`, #194; nie kolumna `students.household_id`). Worker przed wysyłką sprawdza to samo członkostwo i daty relacji w tym samym dniu; dzień limitu Brevo pozostaje w UTC. Adresat to opiekun, który ma zgodę na kontakt jednocześnie na koncie (`guardians.contact_allowed`) i w aktywnej relacji z dzieckiem z tej rodziny (`student_guardians.contact_allowed`, daty relacji). Kolejność: kontakt główny, potem najmniejszy identyfikator. Jeżeli ten sam adres został już użyty dla innej rodziny w tej kampanii, wybierany jest kolejny opiekun, a przy jego braku rodzina jest wykluczona (`duplicate_address`). Powody wykluczenia: `no_consent`, `no_valid_email`, `suppressed`, `duplicate_address`, `payment_recorded`. Wysyłka do obojga opiekunów wymaga decyzji D-17 i zmiany klucza idempotencji.

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
- Stany: `queued → sending → sent → bounced`; `queued → skipped | suppressed | failed | cancelled`; `sending → failed | queued` (`queued` tylko po jawnej odmowie dostawcy — 429, 401/402/403 — albo dla wiadomości, której wysyłka się nie rozpoczęła: zatrzymany przebieg, wygasła dzierżawa); `sending → cancelled | skipped | suppressed` tylko przed przekazaniem wiadomości dostawcy (`send_started_at` puste). Trigger blokuje inne przejścia i usuwanie.
- Zadanie przejmuje wiersze `FOR UPDATE SKIP LOCKED` i w tej samej transakcji zmienia stan na `sending`, więc dwa równoległe przebiegi nie wyślą tego samego wiersza.
- Przejęcie zapisuje token przebiegu (`claim_token`, UUID). Przed **każdą** wysyłką zadanie jedną instrukcją `UPDATE … RETURNING` potwierdza, że wiersz nadal należy do tego przebiegu, jest `sending`, kampania jest nadal `sending`, a odbiorca nadal się kwalifikuje (brak wpłaty dla „brak wpisu wpłaty”, adres poza listą wyłączeń, zgoda na kontakt). Dopiero wtedy ustawia `send_started_at` i woła dostawcę. Inaczej — w tej samej transakcji — wiersz dostaje `cancelled` / `skipped` / `suppressed` z powodem i zdarzeniem audytu (`stage = before_send`); wiersz przejęty już przez inny przebieg jest pomijany (`email.send_aborted`, powód `lease_lost`). Dzierżawa (15 min) liczy się od potwierdzenia danej wiadomości.
- Wynik zapisywany jest tylko, gdy wiersz nadal należy do przebiegu. Jeżeli dzierżawa wygasła w trakcie wysyłki, zamiast `email.sent` powstaje `email.sent_after_lease_lost` (z identyfikatorem wiadomości dostawcy), a wiersz pozostaje `delivery_unknown`; `email_worker_runs.sent` liczy tylko wiersze faktycznie zapisane jako `sent`. W raporcie przebiegu wiersze anulowane przed wysyłką są liczone w `skipped`.
- Timeout, zerwane połączenie i 5xx dają `failed / delivery_unknown` **bez** automatycznego ponowienia, bo nie wiadomo, czy Brevo przyjęło wiadomość. Odmowa połączenia przed wysłaniem żądania (`ECONNREFUSED`, DNS, TLS) to `provider_unreachable`: żądanie nie wyszło, wiadomość wraca do kolejki. 502/503 z `Retry-After` nadal traktujemy jako niepewne (zachowawczo, do sprawdzenia na stagingu). Wiersz w `sending` dłużej niż 15 min (awaria procesu) trafia do `delivery_unknown`, jeżeli jego wysyłka się rozpoczęła (albo pochodzi sprzed migracji 0025); jeżeli przebieg nie zdążył go przekazać dostawcy, wraca do `queued` (`lease_expired`), a stary przebieg nie może go już wysłać. Jeżeli do takiego wiersza dotarło już zdarzenie webhooka z `X-Mailin-custom` = id wiersza, `recoverStale` ustawia `sent` (`email.sent_recovered`), a nie `delivery_unknown`. Pozostałe przypadki wymagają ręcznego sprawdzenia w logach Brevo (nagłówki `X-Mailin-custom` = id wiersza, `X-RD-Idempotency-Key`). Brevo nie gwarantuje deduplikacji po swojej stronie; idempotencję zapewnia nasza kolejka.

### Wyłącznik przy awarii Brevo (#180)
- 429 (limit częstotliwości albo wyczerpany limit konta) zatrzymuje przebieg po pierwszej odpowiedzi (`stopped_reason = 'provider_rate_limited'`). Wiadomość wraca do kolejki bez zużycia próby i limitu dnia. Kolejna próba następuje po `Retry-After` albo po 5 min. Reszta partii zostaje w kolejce. `EMAIL_MAX_ATTEMPTS` nie dotyczy tej pauzy, więc dłuższe 429 nie zamienia wiadomości w `failed`.
- Brak połączenia przed wysłaniem żądania: to samo, z `stopped_reason = 'provider_unreachable'`.
- Po `EMAIL_BREAKER_UNCERTAIN` (domyślnie 2) **kolejnych** wynikach niepewnych (5xx, timeout) przebieg się zatrzymuje (`stopped_reason = 'provider_unavailable'`). Te wiadomości mają `delivery_unknown`, reszta partii zostaje w kolejce, a kampania nie przechodzi w `done`. Wynik rozstrzygnięty (przyjęcie, 400) zeruje licznik. 400 nie otwiera wyłącznika.
- Progi wymagają pomiaru na stagingu. Trwały stan pauzy dostawcy (`email_provider_pauses`) i stan kampanii „do przeglądu” przy `delivery_unknown` nie są zaimplementowane.

### Awaria bazy, zatrzymanie procesu, odmowa konta (#172, #209)
- Zapis wyniku jest oddzielony od wywołania dostawcy. Jeśli Brevo przyjęło wiadomość, a zapis `sent` się nie udał, zadanie ponawia zapis (3 razy). Gdy baza nadal nie odpowiada, wiersz zostaje w `sending` z `send_started_at` — stan „wysłano, wynik niezapisany”. Nigdy nie dostaje `failed / transport_error`. Log zadania zawiera wtedy linię `sent_result_unrecorded` z id wiersza i id wiadomości dostawcy (bez adresu). Jeśli baza wróci w tym samym przebiegu, wynik zostaje dopisany. W przeciwnym razie rozstrzyga go `recoverStale`: po webhooku ustawia `sent`, bez webhooka — `delivery_unknown`.
- Przebieg zatrzymuje się po awarii bazy, po sygnale `SIGTERM`/`SIGINT` (redeploy lub zatrzymanie usługi Railway; bieżąca wiadomość jest kończona, następna nie jest zaczynana, `stopped_reason = 'shutdown'`) oraz po odmowie konta przez Brevo. Wiersze przejęte przez przebieg, których wysyłka się nie rozpoczęła, od razu wracają do `queued` bez zużycia próby (`email.requeued`). Jeśli baza jest wtedy niedostępna, zrobi to `recoverStale` po wygaśnięciu dzierżawy (`lease_expired`), a nie `delivery_unknown`.
- 401, 402 i 403 z Brevo (zły lub obrócony klucz, brak kredytów, nieuprawniony nadawca lub IP) dotyczą konta, nie odbiorcy. Przebieg kończy się po pierwszej takiej odpowiedzi z `stopped_reason = 'provider_account_rejected'`. Wiadomość wraca do kolejki bez zużycia próby. Na kampanii powstaje zdarzenie `email.campaign.provider_rejected`. Kampania nie przechodzi w `done`. Każdy kolejny przebieg wykonuje najwyżej jedno takie wywołanie, dopóki konfiguracja nie zostanie poprawiona. Trwała pauza zdejmowana jawnie przez zarząd nie jest jeszcze zaimplementowana. 400 (błędny adres) nadal dotyczy tylko jednej wiadomości.

## Dzienny limit
- Dziennik `email_send_ledger` (dzień UTC, tylko dopisywanie) liczy wiadomości kampanii, które **mogły wyjść** (przyjęte przez dostawcę albo z wynikiem niepewnym), oraz inne wiadomości konta (`source = 'other'`, funkcja `recordOtherSends`). Wpis powstaje razem z wynikiem, nie przy przejęciu. Jawna odmowa dostawcy (np. 400, 401/403), wiersze zwrócone do kolejki i zatrzymany przebieg nie zużywają limitu. Wiadomości w locie (`sending` bez wpisu) są liczone do puli, więc równoległe przebiegi jej nie przekroczą (#172).
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
`POST /api/email/webhooks/brevo`. Brevo nie podpisuje treści HMAC; weryfikacja to wspólny sekret `BREVO_WEBHOOK_SECRET` (min. 32 znaki) przesyłany w nagłówku `Authorization: Bearer <sekret>` (konfiguracja „auth” webhooka Brevo) albo jako hasło Basic Auth. Porównanie w stałym czasie; zły lub brak sekretu → 401, brak konfiguracji → 503. To jedyna trasa API zwolniona z kontroli `Origin`. Zapisujemy tylko zweryfikowane zdarzenia, bez adresu (skrót SHA-256), z deduplikacją. `hard_bounce`, `invalid_email`, `blocked`, `spam`, `unsubscribed` dopisują adres do listy wyłączeń; bounce zmienia stan wiersza na `bounced`.

## Lista wyłączeń: przegląd i zdjęcie blokady (#94)
Blokada (`email_suppressions`) to zdarzenie, nie stan — adres może być zablokowany, odblokowany i ponownie zablokowany; historia jest kompletna i nic nie jest nadpisywane ani usuwane. „Aktywna blokada” dla danego adresu to **wyłącznie** wynik widoku `email_active_suppressions` (ostatnie zdarzenie blokady nowsze niż ostatnie zdjęcie blokady) — migawka kampanii i worker sprawdzają wyłącznie ten widok, nigdy surowej tabeli `email_suppressions`.

- `GET /api/email/suppressions?schoolYearId=…` (board/treasurer, MFA) — lista aktywnych blokad: skrót adresu, powód, data, liczba zdarzeń historii, oraz `guardianId`/`householdId` odzyskane po stronie serwera (skrót bieżącego adresu każdego opiekuna), i adres wyłącznie maskowany (`maskEmail`). Każdy odczyt trafia do dziennika audytu.
- Zdjęcie blokady to **dwa kroki jak przy zatwierdzeniu kampanii** — zgłasza jedna osoba, zatwierdza inna:
  1. `POST /api/email/suppressions/{emailHash}/release-request` (board/treasurer, MFA) — `releaseReason` (`address_corrected`, `provider_unblocked`, `bounce_reviewed`, `parent_request`) i opcjonalny `confirmationNote` (krótki kod, np. `parent_email_reply`, bez treści rozmowy). Blokadę po `complaint`/`unsubscribed` można zgłosić do zdjęcia wyłącznie z powodem `parent_request` — inaczej `409 release_reason_not_allowed`.
  2. `POST /api/email/suppressions/{emailHash}/release` (board/treasurer, MFA, **inna osoba niż zgłaszająca**) z `requestId` — tworzy nowy, niezmienialny zapis w `email_suppression_releases` (`released_by`, `approved_by` — różne osoby, wymuszone też w bazie). Ta sama osoba dostaje `403 self_approval_forbidden`.
- Zmiana adresu opiekuna (`PATCH /api/guardians/:id/contact`) daje nowy skrót — rodzina automatycznie wraca do migawki przy następnym budowaniu listy, bez zdejmowania żadnej blokady starego adresu.
- Ograniczenie tego prototypu: przedstawiciel klasy nie widzi nawet licznika „adresów do sprawdzenia” w swoich klasach (opcja z issue #94 zależna od D-08) — nie jest zaimplementowane.

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
| `EMAIL_MAX_ATTEMPTS` | maks. prób przy odmowie z możliwością ponowienia (domyślnie 5; 429 i brak połączenia nie zużywają próby) |
| `EMAIL_BREAKER_UNCERTAIN` | liczba kolejnych wyników niepewnych (5xx, timeout), po której przebieg się zatrzymuje (domyślnie 2) |
| `BREVO_API_KEY` | sekret usługi zadania; nigdy w repo ani frontendzie |
| `BREVO_FROM_EMAIL`, `BREVO_FROM_NAME` | zweryfikowany nadawca (D-17) |
| `BREVO_WEBHOOK_SECRET` | wspólny sekret webhooka |

## Wdrożenie
Brevo API key w sekrecie serwera, zweryfikowana domena, SPF/DKIM/DMARC, osobny adres nadawcy i uwierzytelniony webhook. Nie wysyłać poczty bezpośrednio z przeglądarki ani nie ujawniać klucza w frontendzie. Najpierw testy na kilku własnych adresach technicznych i potwierdzenie szablonu przez Radę.

Źródło limitu: https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan
