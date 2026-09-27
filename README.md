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
- [Wydarzenia i publiczny kalendarz](docs/EVENTS.md)
- [Zebrania, protokoły i uchwały](docs/MEETINGS.md)
- [Rejestr decyzji zarządu i szkoły](docs/DECISIONS.md)
- [Zasady pracy agentów](AGENTS.md)

## Źródła wymagań

Regulamin Rady Rodziców Szkoły Polskiej im. Joachima Lelewela w Brukseli i Program Wychowawczo-Profilaktyczny 2026/2027 przekazane przez użytkownika. Nie umieszczać tych dokumentów w repo bez decyzji o zasadach dostępu i aktualności wersji.

## Uruchomienie obecnego prototypu lokalnie

Do czasu zakończenia migracji lokalne testy starego API używają `npm ci`, `npm run db:migrate:local` i `npm run dev` z emulatorem Workera. To nie jest instrukcja deploymentu. Nie uruchamiać migracji produkcyjnej; nowy serwer i PostgreSQL będą dostarczane w osobnych PR-ach.

## Import CSV/XLSX

Pierwszy etap działa lokalnie: `npm ci`, `npm run dev:import` i `npm test`. [Instrukcja importu](import/README.md). Plik jest odczytywany w przeglądarce, pokazuje mapowanie i raport; nie zapisuje danych w bazie.

## Panel wpłat

Chroniony interfejs ewidencji można uruchomić poleceniem `npm run dev:panel`; API działa równolegle przez `npm run dev`. Panel obsługuje listę, rejestrację, korekty i jednokrotne przypisanie wpłaty do rodziny. [Instrukcja panelu](panel/README.md). Nie zawiera danych demonstracyjnych ani obejścia logowania.

## Panel księgi

Chroniony interfejs księgi można uruchomić poleceniem `npm run dev:ledger`; API działa równolegle przez `npm run dev`. Panel pokazuje bilans, preliminarz i wpisy oraz pozwala dodawać wpisy i audytowalne korekty. [Instrukcja panelu](ledger/README.md). Nie zawiera danych demonstracyjnych ani obejścia logowania.

## Kartki o dobrowolnej składce

Lokalny moduł wydruku: `npm run dev:print`. Operator wczytuje plik CSV/JSON w przeglądarce, ręcznie wybiera rodziny, sprawdza podgląd i drukuje jedną dyskretną kartkę na rodzinę (PDF przez „Drukuj → Zapisz jako PDF”). Kwota sugerowana i dane rachunku czekają na decyzje D-13, D-14 i D-16. [Instrukcja wydruku](print/README.md).

## Start implementacji

1. Uzgodnić zakres i przepływ danych ze szkołą.
2. Spisać decyzję o koncie bankowym, sugerowanej składce, zasadach korekt i zatwierdzania wydatków.
3. Zrealizować fazę 1 z [planu](docs/ROADMAP.md), używając sztucznych danych.
4. Po przeglądzie dostępu i testach uruchomić środowisko produkcyjne i import.

