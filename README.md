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

[Decyzja i etapy migracji](docs/RAILWAY_MIGRATION.md) są zapisane osobno, a [procedury środowisk, backupu, monitoringu i odbioru](docs/RAILWAY_OPERATIONS.md) — w osobnym dokumencie; `railway.json` zawiera wyłącznie konfigurację buildu i startu, bez sekretów. Obecny kod serwera i migracje nadal korzystają z Cloudflare Workers/D1; **nie jest to gotowy deployment Railway**. Nie dodawać poświadczeń dostawców do repo.

## Dokumentacja

- [Plan rozwoju](docs/ROADMAP.md)
- [Model funkcjonalny i uprawnienia](docs/PRODUCT.md)
- [Architektura i dane](docs/ARCHITECTURE.md)
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
- [Zasady pracy agentów](AGENTS.md)

## Źródła wymagań

Regulamin Rady Rodziców Szkoły Polskiej im. Joachima Lelewela w Brukseli i Program Wychowawczo-Profilaktyczny 2026/2027 przekazane przez użytkownika. Nie umieszczać tych dokumentów w repo bez decyzji o zasadach dostępu i aktualności wersji.

## Uruchomienie obecnego prototypu lokalnie

Do czasu zakończenia migracji lokalne testy starego API używają `npm ci`, `npm run db:migrate:local` i `npm run dev` z emulatorem Workera. To nie jest instrukcja deploymentu. Nie uruchamiać migracji produkcyjnej; nowy serwer i PostgreSQL będą dostarczane w osobnych PR-ach.

## Import CSV/XLSX

Pierwszy etap działa lokalnie: `npm ci`, `npm run dev:import` i `npm test`. [Instrukcja importu](import/README.md). Plik jest odczytywany w przeglądarce, pokazuje mapowanie i raport; nie zapisuje danych w bazie. Prototyp zapisu w PostgreSQL (#36) przyjmuje z przeglądarki wyłącznie znormalizowane wiersze, pokazuje serwerowy raport konfliktów i zatwierdza import w jednej transakcji; wymaga roli z MFA i nie jest przeznaczony do danych rodzin przed decyzjami D-01–D-06.

## Panel wpłat

Chroniony interfejs ewidencji można uruchomić poleceniem `npm run dev:panel`; API działa równolegle przez `npm run dev`. Panel obsługuje listę, rejestrację, korekty i jednokrotne przypisanie wpłaty do rodziny. [Instrukcja panelu](panel/README.md). Nie zawiera danych demonstracyjnych ani obejścia logowania.

## Panel księgi

Chroniony interfejs księgi można uruchomić poleceniem `npm run dev:ledger`; API działa równolegle przez `npm run dev`. Panel pokazuje bilans, preliminarz i wpisy oraz pozwala dodawać wpisy i audytowalne korekty. [Instrukcja panelu](ledger/README.md). Nie zawiera danych demonstracyjnych ani obejścia logowania.

## Panel wydarzeń

Wewnętrzny interfejs wydarzeń (#12) buduje polecenie `npm run build:events`; serwer Node.js (`npm start`) udostępnia go pod `/events/` w tym samym originie co API. Obsługuje listę roku z filtrem statusu, szkic i edycję z jawnym wyborem godziny przy zmianie czasu w Brukseli, zgłoszenie, zatwierdzenie, publikację, odwołanie z powodem oraz historię wersji. [Instrukcja panelu](events/README.md). Nie zawiera danych demonstracyjnych ani obejścia logowania.

## Kartki o dobrowolnej składce

Lokalny moduł wydruku: `npm run dev:print`. Operator wczytuje plik CSV/JSON w przeglądarce, ręcznie wybiera rodziny, sprawdza podgląd i drukuje jedną dyskretną kartkę na rodzinę (PDF przez „Drukuj → Zapisz jako PDF”). Kwota sugerowana i dane rachunku czekają na decyzje D-13, D-14 i D-16. [Instrukcja wydruku](print/README.md).

## Dokumenty prywatne

Chroniony panel dokumentów: `npm run dev:documents` (API przez `npm run dev` lub serwer Node). Lista dokumentów dostępnych według roli, metadane, pobranie przez serwer i przesłanie PDF/PNG/JPEG z kluczem idempotencji. Prototyp — nie do pracy na prawdziwych dokumentach przed decyzjami D-04, D-05, D-08 i D-09. [Instrukcja panelu](documents/README.md), [zasady](docs/DOCUMENTS.md).

## Strona publiczna

Prototyp strony tylko do odczytu pod `/site/`: `npm run dev:site`. Pokazuje wyłącznie opublikowane wydarzenia (#12), protokoły udostępnione publicznie (#13) i opcjonalnie aktualności. Bez logowania i plików cookie. [Opis strony](site/README.md).

## Zebrania Rady

Chroniony panel zebrań (#13): `npm run build:meetings`, a następnie serwer Node z `DATABASE_URL` (`PORT=3000 npm start`, ścieżka `/meetings/`); podczas pracy nad interfejsem `npm run dev:meetings`. Porządek obrad, lista obecności z jawnym prawem głosu, ustalenie quorum z ręcznie wpisanej reguły, wersje protokołu z zatwierdzeniem i widocznością oraz uchwały z liczbami głosów wpisanymi przez sekretarza — bez głosowania elektronicznego. Prototyp, bez danych demonstracyjnych ani obejścia logowania. [Instrukcja panelu](meetings/README.md).

## Panel kont i ról

Interfejs administratora (`npm run dev:admin`, API na PostgreSQL): konta, zaproszenia z jednorazowym tokenem, przydziały ról z zakresem roku/klasy, wygaszenie kadencji i dziennik zmian. Wymaga roli administratora z MFA. [Instrukcja panelu](admin/README.md), [zasady](docs/ACCOUNTS.md). Tokeny resetu hasła i reset MFA są na razie dostępne przez API (`/api/admin/users/{id}/password-reset`, `/mfa-reset`).

## Logowanie

Ekran `/login/` (`npm run dev:login`; `/` przekierowuje tutaj, strona publiczna jest pod `/site/`): e-mail i hasło, potem kod z aplikacji uwierzytelniającej (Google Authenticator, Microsoft Authenticator lub inna zgodna z TOTP RFC 6238). Konto powstaje wyłącznie z zaproszenia (`/login/#invite=<token>`); reset hasła tylko tokenem od administratora (`/login/#reset=<token>`), bez wiadomości e-mail. Role `admin`, `board` i `treasurer` muszą skonfigurować aplikację przed użyciem paneli (`MFA_REQUIRED_ROLES`). Metodę wskazał użytkownik 2026-09-27; wymaga formalnego potwierdzenia przez zarząd i IOD (D-10). Prototyp na danych syntetycznych, niewdrożony. [Instrukcja ekranu](login/README.md), [przepływ i parametry](docs/AUTH.md).

## Start implementacji

1. Uzgodnić zakres i przepływ danych ze szkołą.
2. Spisać decyzję o koncie bankowym, sugerowanej składce, zasadach korekt i zatwierdzania wydatków.
3. Zrealizować fazę 1 z [planu](docs/ROADMAP.md), używając sztucznych danych.
4. Po przeglądzie dostępu i testach uruchomić środowisko produkcyjne i import.

