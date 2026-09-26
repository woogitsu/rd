# Plan rozwoju

## 0. Uzgodnienia i projekt
- Zatwierdzić zakres danych i role z dyrekcją/inspektorem ochrony danych.
- Uzgodnić jednostkę ewidencji składki (rodzina/dziecko), wysokość sugerowaną na rok, wyjątki, wpłaty gotówkowe i uzgadnianie banku.
- Potwierdzić aktualny regulamin i daty wydarzeń. Rozstrzygnąć zasady publikacji zdjęć.
- Przegląd makiety A na telefonie z reprezentantem klasy, skarbnikiem, sekretarzem i dyrekcją.
**Kryterium wyjścia:** spisane decyzje, bez importu danych.

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

### Kolejność
Fazy 0–3 przed pełnym wdrożeniem; faza 4 może rozwijać publiczny kalendarz wcześniej, jeśli szkoła zatwierdzi treść. Zadania dzielić na małe issues z mierzalnym wynikiem.
