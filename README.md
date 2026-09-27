# RD — Rada Rodziców Szkoły Polskiej im. Joachima Lelewela w Brukseli

Panel organizacyjny Rady Rodziców na rok szkolny 2026/2027 i następne. Repozytorium zawiera punkt startowy produktu i reguły implementacji. **Nie zawiera prawdziwych danych uczniów ani kluczy usług.**

## Cel

Jedno miejsce do obsługi rodzin, dobrowolnych składek, wpływów i wydatków, dokumentów źródłowych, wydarzeń, zebrań, uchwał oraz korespondencji z rodzicami. Publiczna część podaje wyłącznie zatwierdzone informacje.

[Prototyp wariantu A w Sites](https://lelewel-panel-rady.espace-de-tr-3339.chatgpt.site) jest poglądowy: przykładowe rekordy, zapis w przeglądarce, brak rzeczywistej autoryzacji i wysyłki.

## Stan prac

To etap przygotowania. Przed importem danych rodzin wymagane są ustalenia z dyrekcją i IOD dotyczące administratora danych, upoważnień, obowiązku informacyjnego, retencji i dostawców. Przed uruchomieniem poczty trzeba skonfigurować domenę nadawcy i konto Brevo.

## Proponowana technologia

- Cloudflare Workers: logika serwera i API.
- D1 (SQLite): rodziny, członkostwa klasowe, wpłaty, księga, wydarzenia, uchwały, dziennik zmian.
- R2: prywatne dokumenty źródłowe i protokoły; dostęp tylko przez API z kontrolą ról.
- Brevo API: pojedyncze wiadomości do rodziców, kolejka do 300 wiadomości dziennie w planie Free.
- Frontend dostępny na telefonie i komputerze; WCAG 2.2 AA jako cel projektowy.

To wybór wstępny. Nie dodawać konta ani poświadczeń dostawcy do repo. Można zamienić stos po udokumentowaniu przyczyn w decyzji architektonicznej.

## Dokumentacja

- [Plan rozwoju](docs/ROADMAP.md)
- [Model funkcjonalny i uprawnienia](docs/PRODUCT.md)
- [Architektura i dane](docs/ARCHITECTURE.md)
- [Przypomnienia e-mail](docs/EMAIL.md)
- [Prywatność i bezpieczeństwo](docs/SECURITY.md)\n- [Uwierzytelnianie i sesje](docs/AUTH.md)\n- [Autoryzacja i zakres ról](docs/AUTHORIZATION.md)\n- [Model rodzin i opiekunów](docs/DATA_MODEL.md)
- [Dobrowolne wpłaty i korekty](docs/PAYMENTS.md)
- [Księga i preliminarz](docs/LEDGER.md)
- [Zasady pracy agentów](AGENTS.md)

## Źródła wymagań

Regulamin Rady Rodziców Szkoły Polskiej im. Joachima Lelewela w Brukseli i Program Wychowawczo-Profilaktyczny 2026/2027 przekazane przez użytkownika. Nie umieszczać tych dokumentów w repo bez decyzji o zasadach dostępu i aktualności wersji.

## Uruchomienie szkieletu

Po utworzeniu bazy D1 wpisz jej identyfikator w `wrangler.jsonc`. Uruchom `npm ci`, a następnie `npm run db:migrate:local` oraz `npm run dev`. Obecnie Worker udostępnia tylko `/health`; interfejs z Sites nie jest jeszcze częścią repo, a produkcyjna autoryzacja i API są zadaniami z planu. Nie wykonuj migracji produkcyjnej bez przeglądu schematu.

## Import CSV/XLSX

Pierwszy etap działa lokalnie: `npm ci`, `npm run dev:import` i `npm test`. [Instrukcja importu](import/README.md). Plik jest odczytywany w przeglądarce, pokazuje mapowanie i raport; nie zapisuje danych w D1.

## Panel wpłat

Chroniony interfejs ewidencji można uruchomić poleceniem `npm run dev:panel`; API działa równolegle przez `npm run dev`. Panel obsługuje listę, rejestrację, korekty i jednokrotne przypisanie wpłaty do rodziny. [Instrukcja panelu](panel/README.md). Nie zawiera danych demonstracyjnych ani obejścia logowania.

## Panel księgi

Chroniony interfejs księgi można uruchomić poleceniem `npm run dev:ledger`; API działa równolegle przez `npm run dev`. Panel pokazuje bilans, preliminarz i wpisy oraz pozwala dodawać wpisy i audytowalne korekty. [Instrukcja panelu](ledger/README.md). Nie zawiera danych demonstracyjnych ani obejścia logowania.

## Start implementacji

1. Uzgodnić zakres i przepływ danych ze szkołą.
2. Spisać decyzję o koncie bankowym, sugerowanej składce, zasadach korekt i zatwierdzania wydatków.
3. Zrealizować fazę 1 z [planu](docs/ROADMAP.md), używając sztucznych danych.
4. Po przeglądzie dostępu i testach uruchomić środowisko produkcyjne i import.

