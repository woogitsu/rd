# Plan rozwoju

## 0. Uzgodnienia i projekt
- Zatwierdzić zakres danych i role z dyrekcją/inspektorem ochrony danych.
- Uzgodnić jednostkę ewidencji składki (rodzina/dziecko), wysokość sugerowaną na rok, wyjątki, wpłaty gotówkowe i uzgadnianie banku.
- Potwierdzić aktualny regulamin i daty wydarzeń. Rozstrzygnąć zasady publikacji zdjęć.
- Przegląd makiety A na telefonie z reprezentantem klasy, skarbnikiem, sekretarzem i dyrekcją.
**Kryterium wyjścia:** spisane decyzje, bez importu danych.

## 0.5. Migracja infrastruktury na Railway
- Zrealizować [plan migracji](RAILWAY_MIGRATION.md) według [issue #31](https://github.com/woogitsu/rd/issues/31) i zadań #32–#42.
- PostgreSQL, serwer Node, prywatny Storage Bucket, staging i próbne odtworzenie; bez produkcyjnych danych.
**Kryterium wyjścia:** testy równoważności API i bezpieczeństwa oraz zatwierdzony plan cutover; brak automatycznego deploymentu produkcyjnego.

## 1. Konta i baza (MVP)
- Konta zapraszane przez admina; uwierzytelnianie wieloskładnikowe dla osób z dostępem finansowym.
- Role, przypisanie klasy, cofnięcie dostępu, automatyczne wygaszenie uprawnień po kadencji.
- Rodziny, uczniowie, opiekunowie, klasy, rok szkolny, import CSV/XLSX z walidacją i podglądem zmian.
- Dziennik dostępu, eksport danych, kopie zapasowe i sprawdzona próba odtworzenia.
**Kryterium wyjścia:** brak odczytu cudzej klasy w testach serwera.

## 2. Składki i księga
- Wpłaty częściowe, anonimowe/nieprzypisane do wyjaśnienia, gotówka i przelew, korekty, historia.
- Przychody/wydatki, kategorie, preliminarz, dokument źródłowy, eksport CSV/PDF.
- Blokada wydatku powyżej 3000 EUR bez osobnej zgody Rady; raport Komisji Rewizyjnej.
- Uzgodnienie rachunku, bilans otwarcia/zamknięcia i przekazanie kadencji.
**Kryterium wyjścia:** saldo zgodne z zapisami i próbką wyciągu, korekta audytowalna.

## 3. Poczta i wydruki
- Brevo API, weryfikacja domeny, szablony, wybór rodzin, ręczny podgląd i zatwierdzenie.
- Kolejka z limitem 300 wiadomości na dobę obejmującym również inne wiadomości z konta.
- Obsługa webhooków dostarczenia, błędów, bounce i ponowień; bez duplikatów.
- Dyskretne, indywidualne kartki do zeszytu, z podglądem PDF.
**Kryterium wyjścia:** test na adresach technicznych, brak podwójnej wysyłki po ponowieniu.

## 4. Kalendarz, zebrania i strona publiczna
- Wydarzenia z roboczą wersją, zatwierdzeniem i publikacją.
- Porządek, obecność, protokół, uchwały, archiwum i eksport roczny.
- Aktualności i zdjęcia z podaniem źródła oraz uprawnienia do publikacji; bez danych uczniów w URL i metadanych.
**Kryterium wyjścia:** publiczny widok ujawnia wyłącznie zatwierdzone wpisy.

## 5. Utrzymanie
- Monitoring błędów i limitów, aktualizacje, przegląd dostępów po wyborach, test odtworzenia, retencja danych.
- Raport roczny i przekazanie dokumentacji zgodnie z regulaminem.

## Stan ekranów modułów (issue #147)
Część modułów ma kompletne trasy API, ale do niedawna żadna aplikacja ich nie wywoływała — administrowanie odbywało się „ręcznie” narzędziami deweloperskimi, co podważa zasadę czterech oczu i czytelność dla osób nietechnicznych (zarząd, KR, przedstawiciele).

| Moduł | Trasy | Ekran |
|---|---|---|
| Kampanie e-mail | `src/pg/routes/email.js` | **prototyp** — `email/` |
| Uzgodnienie wyciągu i raport KR | `src/pg/routes/reconciliation.js` | **prototyp** — `reconciliation/` |
| Zamknięcie roku | `src/pg/routes/year-close.js` | **prototyp** — `year-close/` (stan, bilans, lista kontrolna, zestawienie przekazania; opis w `year-close/README.md`) |
| Raport Komisji Rewizyjnej | `GET /api/reports/audit` (`src/pg/routes/reconciliation.js`) | **prototyp** — `audit/` (tylko odczyt: tabele z raportu JSON, odnośnik do wersji HTML do druku; opis w `audit/README.md`) |
| Aktualności i galeria | `src/pg/routes/news.js` | **prototyp** — `news/` (szkic, zgłoszenie, zatwierdzenie, publikacja, wycofanie z powodem; rejestr zdjęć i status zgód tylko do odczytu). Rejestracja, przesyłanie i weryfikacja zdjęć: **tylko API — do decyzji D-18**; opis w `news/README.md` |
| Eksport roczny i lista klasy | `src/pg/routes/exports.js` | **prototyp** — `data-export/` (uruchomienie z krokiem w górę MFA, pobranie, weryfikacja w przeglądarce, lista klasy; lista dawnych eksportów: **brak trasy listy w API**, ekran pokazuje pliki pobrane w tej karcie; opis w `data-export/README.md`) |
| Preliminarz | `GET /api/ledger/budget` | **prototyp** — widoczny w `ledger/` (plan bieżący, wykonanie, historia wersji); nie oznacza gotowości do pracy na danych rodzin |

„Prototyp” oznacza tu: żaden przycisk nie wysyła poczty ani nie zmienia stanu produkcyjnie sam z siebie — panel tylko woła istniejące, autoryzowane trasy; zasady dostępu i cztery oczy egzekwuje wyłącznie serwer.

### Kolejność
Fazy 0, 0.5 oraz 1–3 przed pełnym wdrożeniem; faza 4 może rozwijać publiczny kalendarz wcześniej, jeśli szkoła zatwierdzi treść. Zadania dzielić na małe issues z mierzalnym wynikiem.
