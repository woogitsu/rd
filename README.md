# RD — Rada Rodziców Szkoły Polskiej im. Joachima Lelewela w Brukseli

Panel organizacyjny Rady Rodziców na rok szkolny 2026/2027 i następne. Repozytorium zawiera punkt startowy produktu i reguły implementacji. **Nie zawiera prawdziwych danych uczniów ani kluczy usług.**

## Cel

Jedno miejsce do obsługi rodzin, dobrowolnych składek, wpływów i wydatków, dokumentów źródłowych, wydarzeń, zebrań, uchwał oraz korespondencji z rodzicami. Publiczna część podaje wyłącznie zatwierdzone informacje.

[Prototyp wariantu A w Sites](https://lelewel-panel-rady.espace-de-tr-3339.chatgpt.site) jest poglądowy: przykładowe rekordy, zapis w przeglądarce, brak rzeczywistej autoryzacji i wysyłki.

## Stan prac

To etap przygotowania. Przed importem danych rodzin wymagane są ustalenia z dyrekcją i IOD dotyczące administratora danych, upoważnień, obowiązku informacyjnego, retencji i dostawców. Przed uruchomieniem poczty trzeba skonfigurować domenę nadawcy i konto Brevo.

## Docelowa technologia

- Railway: jedna usługa Node.js dla API i paneli, prywatny PostgreSQL oraz prywatny Storage Bucket.
- Brevo API: pojedyncze wiadomości do rodziców po zatwierdzeniu kampanii.
- Frontend dostępny na telefonie i komputerze; WCAG 2.2 AA jako cel projektowy.

[Decyzja i etapy migracji](docs/RAILWAY_MIGRATION.md) są zapisane osobno, a [procedury środowisk, backupu, monitoringu i odbioru](docs/RAILWAY_OPERATIONS.md) — w osobnym dokumencie; `railway.json` zawiera wyłącznie konfigurację buildu i startu, bez sekretów. Serwer Node.js (`src/server.js`, [docs/NODE_SERVER.md](docs/NODE_SERVER.md)) i większość API (`src/pg/app.js`, 27 modułów tras) działają dziś wyłącznie na PostgreSQL; oryginalny Cloudflare Worker/D1 (`src/index.js`) ma tylko 5 tras (sesja, przydziały, wpłaty, księga, wylogowanie) i służy jako kontrakt równoważności przy migracji ([docs/EQUIVALENCE.md](docs/EQUIVALENCE.md)), nie jako produkcyjna ścieżka — D1 nigdy nie miało danych szkoły. **To nadal nie jest gotowy deployment Railway** — patrz „Stan prac” wyżej i lista odbioru w [docs/RAILWAY_OPERATIONS.md](docs/RAILWAY_OPERATIONS.md). Nie dodawać poświadczeń dostawców do repo.

## Dokumentacja

- [Plan rozwoju](docs/ROADMAP.md)
- [Macierz testów: moduł × scenariusz](docs/TESTING.md)
- [Model funkcjonalny i uprawnienia](docs/PRODUCT.md)
- [Architektura i dane](docs/ARCHITECTURE.md)
- [Kontrakt list z kursorem](docs/API.md)
- [Migracja na Railway](docs/RAILWAY_MIGRATION.md)
- [Railway: środowiska, backup, monitoring i odbiór](docs/RAILWAY_OPERATIONS.md)
- [Przypomnienia e-mail](docs/EMAIL.md)
- [Prywatność i bezpieczeństwo](docs/SECURITY.md)
- [Uwierzytelnianie i sesje](docs/AUTH.md)
- [Autoryzacja i zakres ról](docs/AUTHORIZATION.md)
- [Model rodzin i opiekunów](docs/DATA_MODEL.md)
- [Dobrowolne wpłaty i korekty](docs/PAYMENTS.md)
- [Księga i preliminarz](docs/LEDGER.md)
- [Uzgodnienie rachunku i raport dla Komisji Rewizyjnej](docs/RECONCILIATION.md)
- [Wydarzenia i publiczny kalendarz](docs/EVENTS.md)
- [Zebrania, protokoły i uchwały](docs/MEETINGS.md)
- [Prywatne dokumenty w Storage Bucket](docs/DOCUMENTS.md)
- [Aktualności i galeria po weryfikacji praw](docs/NEWS.md)
- [Konta, zaproszenia i przydziały ról](docs/ACCOUNTS.md)
- [Eksport roczny, kopie i test odtworzenia](docs/EXPORT.md)
- [Zamknięcie roku i przekazanie kadencji](docs/YEAR_CLOSE.md)
- [Rejestr decyzji zarządu i szkoły](docs/DECISIONS.md)
- [Stan prototypu — zestawienie na spotkanie zarządu](docs/STATUS.md)
- [Scenariusz pokazu prototypu dla zarządu](docs/DEMO.md)
- [Serwer Node.js dla Railway](docs/NODE_SERVER.md)
- [Równoważność starego (Worker/D1) i nowego (PostgreSQL) API](docs/EQUIVALENCE.md)
- [Migracja danych z D1 do PostgreSQL](docs/D1_POSTGRES_MIGRATION.md)
- [Przegląd bezpieczeństwa](docs/SECURITY_REVIEW.md)
- [Zasady projektowe interfejsu](docs/DESIGN.md)
- [Dostępność (WCAG 2.2 AA)](docs/ACCESSIBILITY.md)
- [Zasady pracy agentów](AGENTS.md)

## Źródła wymagań

Regulamin Rady Rodziców Szkoły Polskiej im. Joachima Lelewela w Brukseli i Program Wychowawczo-Profilaktyczny 2026/2027 przekazane przez użytkownika. Nie umieszczać tych dokumentów w repo bez decyzji o zasadach dostępu i aktualności wersji.

## Uruchomienie lokalne

Jedyna droga, która dziś daje działający panel (dane wyłącznie syntetyczne, `@example.invalid`; AGENTS.md):

1. `npm ci && npm run build` — buduje wszystkie 17 paneli Vite (`import`, `panel`, `ledger`, `print`, `events`, `documents`, `site`, `meetings`, `admin`, `families`, `login`, `email`, `reconciliation`, `year-close`, `audit`, `data-export`, `news` — polecenia `build:<panel>` w `package.json`).
2. Lokalny PostgreSQL (albo dowolny serwer zgodny z wersją z `docs/RAILWAY_OPERATIONS.md`) i `DATABASE_URL=postgres://… npm run db:migrate:postgres`.
3. `DATABASE_URL=postgres://… PORT=3000 npm start` — jeden proces Node.js udostępnia API (`src/pg/app.js`) i wszystkie panele pod wspólnym originem (`/panel/`, `/ledger/`, `/admin/`, `/families/`, …, pełna lista w [docs/NODE_SERVER.md](docs/NODE_SERVER.md)).
4. Konta i sesji testowych nie zakłada publiczne API (`docs/ACCOUNTS.md`). Do lokalnego pokazu i prób służy `npm run demo:seed` (konta ról z danymi syntetycznymi `@example.invalid`, hasła i sekrety TOTP wypisywane tylko na konsolę) oraz `npm run demo:start` — patrz sekcja „Pokaz dla zarządu” niżej i [docs/DEMO.md](docs/DEMO.md). Skrypt odmawia działania na `production`, z `BREVO_API_KEY` i z `DATABASE_URL` poza localhostem. Pierwszego administratora na pustej bazie (poza pokazem) zakłada `npm run auth:bootstrap-admin` — [docs/RAILWAY_OPERATIONS.md](docs/RAILWAY_OPERATIONS.md), „Pierwszy administrator (bootstrap)”; użycie w środowisku produkcyjnym wymaga osobnej decyzji szkoły (D-20).

**Polecenia `npm run dev:<panel>` (Vite, np. `npm run dev:panel`) nie łączą się dziś z żadnym API** — repozytorium nie ma `vite.config.*` ani proxy `/api`, więc wywołania trafiają do serwera Vite, a nie do API. Osobne uruchomienie `npm run dev` (emulator starego Workera/D1, `wrangler dev`) obsługuje wyłącznie 6 tras (`/health`, `/api/session`, `/api/access`, `/api/payments*`, `/api/ledger*`, `/api/logout`) i nie ma tras dla pozostałych modułów (dokumenty, rodziny, import, admin, e-mail, zebrania, wydarzenia…) — nawet dla wpłat i księgi wywołanie z Vite pod innym portem jest zapytaniem cross-origin bez ciasteczka sesji. `npm run dev:<panel>` nadaje się dziś wyłącznie do pracy nad samym HTML/CSS/JS panelu bez API. Nie uruchamiać migracji produkcyjnej.

## Import CSV/XLSX

Podgląd samego mapowania kolumn i walidacji działa bez API: `npm ci`, `npm run dev:import` i `npm test`. [Instrukcja importu](import/README.md). Plik jest odczytywany w przeglądarce, pokazuje mapowanie i raport; nie zapisuje danych w bazie. Zapis w PostgreSQL (#36, `src/pg/routes/import.js`) wymaga uruchomienia z „Uruchomienie lokalne” wyżej: przyjmuje z przeglądarki wyłącznie znormalizowane wiersze, pokazuje serwerowy raport konfliktów i zatwierdza import w jednej transakcji; wymaga roli `admin`/`board` z MFA i nie jest przeznaczony do danych rodzin przed decyzjami D-01–D-06.

## Panel wpłat

Chroniony interfejs ewidencji: buduj i uruchamiaj razem z API według „Uruchomienie lokalne” wyżej (`/panel/` pod serwerem Node z `DATABASE_URL`). Panel obsługuje listę, rejestrację, korekty i jednokrotne przypisanie wpłaty do rodziny. [Instrukcja panelu](panel/README.md). Router Workera/D1 (`src/index.js`) ma równoważne trasy `/api/payments*` (kontrakt równoważności, [docs/EQUIVALENCE.md](docs/EQUIVALENCE.md)), ale `npm run dev:panel` + `npm run dev` nie łączy ich dziś ze sobą (brak proxy Vite, patrz wyżej). Nie zawiera danych demonstracyjnych ani obejścia logowania.

## Panel księgi

Chroniony interfejs księgi: buduj i uruchamiaj razem z API według „Uruchomienie lokalne” wyżej (`/ledger/` pod serwerem Node z `DATABASE_URL`). Panel pokazuje bilans, preliminarz i wpisy oraz pozwala dodawać wpisy i audytowalne korekty. [Instrukcja panelu](ledger/README.md). Tak jak w panelu wpłat, `npm run dev:ledger` + `npm run dev` nie są dziś połączone (brak proxy Vite). Nie zawiera danych demonstracyjnych ani obejścia logowania.

## Panel wydarzeń

Wewnętrzny interfejs wydarzeń (#12) buduje polecenie `npm run build:events`; serwer Node.js (`npm start`) udostępnia go pod `/events/` w tym samym originie co API. Obsługuje listę roku z filtrem statusu, szkic i edycję z jawnym wyborem godziny przy zmianie czasu w Brukseli, zgłoszenie, zatwierdzenie, publikację, odwołanie z powodem oraz historię wersji. [Instrukcja panelu](events/README.md). Nie zawiera danych demonstracyjnych ani obejścia logowania.

## Kartki o dobrowolnej składce

Lokalny moduł wydruku: wczytanie pliku CSV/JSON z dysku działa samym `npm run dev:print`, bez API. Przycisk „Wczytaj z serwera” (`/api/print`, `src/pg/routes/print.js`) wymaga uruchomienia z „Uruchomienie lokalne” wyżej — tego samego originu co API. Operator ręcznie wybiera rodziny, sprawdza podgląd i drukuje jedną dyskretną kartkę na rodzinę (PDF przez „Drukuj → Zapisz jako PDF”). Kwota sugerowana i dane rachunku czekają na decyzje D-13, D-14 i D-16. [Instrukcja wydruku](print/README.md).

## Dokumenty prywatne

Chroniony panel dokumentów: buduj i uruchamiaj razem z API według „Uruchomienie lokalne” wyżej (`/documents/`; Worker/D1 **nie ma** tras `/api/documents`, więc `npm run dev` go nie obsługuje). Lista dokumentów dostępnych według roli, metadane, pobranie przez serwer i przesłanie PDF/PNG/JPEG z kluczem idempotencji. Prototyp — nie do pracy na prawdziwych dokumentach przed decyzjami D-04, D-05, D-08 i D-09. [Instrukcja panelu](documents/README.md), [zasady](docs/DOCUMENTS.md).

## Strona publiczna

Prototyp strony tylko do odczytu pod `/site/`: buduj i uruchamiaj razem z API według „Uruchomienie lokalne” wyżej (`npm run dev:site` sam pokaże układ, ale bez działających sekcji — strona woła publiczne GET `/api/public/*`, patrz [Opis strony](site/README.md)). Pokazuje wyłącznie opublikowane wydarzenia (#12), protokoły udostępnione publicznie (#13) i opcjonalnie aktualności. Bez logowania i plików cookie.

## Zebrania Rady

Chroniony panel zebrań (#13): buduj i uruchamiaj razem z API według „Uruchomienie lokalne” wyżej (`PORT=3000 npm start`, ścieżka `/meetings/`); `npm run dev:meetings` samo w sobie pokaże wyłącznie układ, bez API. Porządek obrad, lista obecności z jawnym prawem głosu, ustalenie quorum z ręcznie wpisanej reguły, wersje protokołu z zatwierdzeniem i widocznością oraz uchwały z liczbami głosów wpisanymi przez sekretarza — bez głosowania elektronicznego. Prototyp, bez danych demonstracyjnych ani obejścia logowania. [Instrukcja panelu](meetings/README.md).

## Panel rodzin

Chroniony katalog rodzin, uczniów i opiekunów (`/families/`, API na PostgreSQL, `src/pg/routes/families.js`): odczyt zakresu zależnego od roli (`admin`/`board`/`treasurer` — wszystkie klasy; `representative` — własna klasa), rodzeństwo w wielu klasach, dwoje opiekunów na dziecko, e-mail opiekuna widoczny zgodnie ze zgodą kontaktową poza rolami z szerokim zakresem (`docs/AUTHORIZATION.md`, `docs/PRODUCT.md`). Buduj i uruchamiaj razem z API według „Uruchomienie lokalne” wyżej. [Instrukcja panelu](families/README.md), [model danych](docs/DATA_MODEL.md).

## Panel kont i ról

Interfejs administratora (`/admin/`, API na PostgreSQL): konta, zaproszenia z jednorazowym tokenem, przydziały ról z zakresem roku/klasy, wygaszenie kadencji i dziennik zmian. Wymaga roli administratora z MFA. Buduj i uruchamiaj razem z API według „Uruchomienie lokalne” wyżej; `npm run dev:admin` samo nie łączy się z API. [Instrukcja panelu](admin/README.md), [zasady](docs/ACCOUNTS.md). Reset hasła (kod jednorazowy) i reset MFA są akcjami w panelu (`/api/admin/users/{id}/password-reset`, `/mfa-reset`); wymagają potwierdzenia i zapisują zdarzenie w dzienniku.

## Kampanie e-mail

Chroniony prototyp `/email/` (`src/pg/routes/email.js`): szkic treści, migawka odbiorców z powodami wykluczeń, plan wysyłki względem limitu Brevo i zatwierdzenie przez inną osobę z zarządu. Przycisk nie wysyła niczego sam z siebie; treść i listę odbiorców trzeba zatwierdzić jawnie. Szablon wiadomości, adres nadawcy i domena Brevo czekają na decyzje szkoły (D-16, D-17). [Instrukcja panelu](email/README.md), [zasady](docs/EMAIL.md).

## Uzgodnienie wyciągu i raport Komisji Rewizyjnej

Prototypy `/reconciliation/` (uzgodnienie wyciągu, cofnięcie dopasowania, potwierdzenie przez drugą osobę) i `/audit/` (raport roczny tylko do odczytu, wersja HTML do druku). Rachunek, format wyciągu i osoba uzgadniająca czekają na D-13. [Uzgodnienie](reconciliation/README.md), [raport KR](audit/README.md), [zasady](docs/RECONCILIATION.md).

## Zamknięcie roku

Prototyp `/year-close/`: stan zamknięcia, bilans, lista kontrolna i zestawienie przekazania kadencji. Dostęp do archiwum po zamknięciu jest w wariancie zachowawczym do decyzji D-08/D-09. [Instrukcja panelu](year-close/README.md), [zasady](docs/YEAR_CLOSE.md).

## Eksport danych

Prototyp `/data-export/`: eksport roczny (administrator, zarząd; wymaga świeżego MFA) i lista klasy dla przedstawiciela własnej klasy. Eksport zawiera dane osobowe — czas przechowywania plików i administrator danych czekają na D-01 i D-04. [Instrukcja panelu](data-export/README.md), [zasady](docs/EXPORT.md).

## Aktualności i galeria

Prototyp `/news/`: szkic, zgłoszenie, zatwierdzenie przez drugą osobę, publikacja i wycofanie z powodem; rejestr zdjęć ze zgodami tylko do odczytu (rejestracja i przesyłanie zdjęć — wyłącznie API). Zasady publikacji zdjęć czekają na D-18. [Instrukcja panelu](news/README.md), [zasady](docs/NEWS.md).

## Logowanie

Ekran `/login/` (`/` przekierowuje tutaj, strona publiczna jest pod `/site/`): e-mail i hasło, potem kod z aplikacji uwierzytelniającej (Google Authenticator, Microsoft Authenticator lub inna zgodna z TOTP RFC 6238). Konto powstaje wyłącznie z zaproszenia (`/login/#invite=<token>`); reset hasła tylko tokenem od administratora (`/login/#reset=<token>`), bez wiadomości e-mail. Role `admin`, `board` i `treasurer` muszą skonfigurować aplikację przed użyciem paneli (`MFA_REQUIRED_ROLES`). Buduj i uruchamiaj razem z API według „Uruchomienie lokalne” wyżej; `npm run dev:login` samo w sobie nie tworzy sesji. Metodę wskazał użytkownik 2026-09-27; wymaga formalnego potwierdzenia przez zarząd i IOD (D-10). Prototyp na danych syntetycznych, niewdrożony. [Instrukcja ekranu](login/README.md), [przepływ i parametry](docs/AUTH.md).

## Pokaz dla zarządu (dane demo, wyłącznie lokalnie)

Osobny, mały zestaw danych do pokazania panelu zarządowi — nie do mylenia z `scripts/lib/synthetic-seed.js` (ten służy testom wolumenu/wydajności i zostaje bez zmian). `scripts/demo-seed.js` zakłada bazę od zera (domyślnie PGlite trwałe na dysku w `.demo-data/`, poza repo) i przechodzi przez te same trasy API co prawdziwe panele — konta ról, wpłaty, księgę, wydarzenia, zebranie z protokołem i szkic kampanii e-mail:

```bash
npm ci
npm run build
npm run demo:seed     # tworzy bazę demo i wypisuje na konsoli hasła + sekrety TOTP kont ról
npm run demo:start    # PORT=3000 npm start na tej samej bazie
```

Skrypt **odmawia działania**, gdy `DATABASE_URL` wskazuje poza `localhost`/`127.0.0.1` (bez `DATABASE_URL` używa PGlite), gdy `NODE_ENV`/`APP_ENV` to `production`, albo gdy w środowisku jest ustawiony `BREVO_API_KEY` — worker e-mail (`scripts/email-worker.js`) nigdy nie jest uruchamiany, więc żadna wiadomość demo nie może wyjść. Dane są wyłącznie syntetyczne: adresy `@example.invalid`, jawnie fikcyjne nazwiska („Przykładowy”), bez zdjęć, bez wymyślonych relacji z przeszłych wydarzeń (wydarzenia to zapowiedzi z datą/miejscem/opisem organizacyjnym) i bez automatycznego statusu „dłużnik” (składki są dobrowolne — AGENTS.md). Hasła i sekrety TOTP kont demo (`admin`, dwie osoby `board`, `treasurer`, `representative` klasy 0-A, `audit`) są wypisywane WYŁĄCZNIE na konsolę przy każdym uruchomieniu `npm run demo:seed` i nigdzie nie są zapisywane — nie używać ich poza lokalnym pokazem. Szkic kampanii e-mail zostaje szkicem: nie jest zatwierdzany ani kolejkowany.

## Start implementacji

1. Uzgodnić zakres i przepływ danych ze szkołą.
2. Spisać decyzję o koncie bankowym, sugerowanej składce, zasadach korekt i zatwierdzania wydatków.
3. Zrealizować fazę 1 z [planu](docs/ROADMAP.md), używając sztucznych danych.
4. Po przeglądzie dostępu i testach uruchomić środowisko produkcyjne i import.

