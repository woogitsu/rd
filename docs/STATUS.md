# Stan prototypu — zestawienie dla zarządu Rady

Stan na 30.09.2026, gałąź `main` repozytorium `woogitsu/rd` po scaleniu #553 (przegląd #175). Dokument opisuje wyłącznie to, co potwierdza kod, scalone PR-y i dokumentacja w `docs/`. Nie zawiera prognoz ani deklaracji gotowości. Wszystkie PR, które poprzednia wersja (28.09) oznaczała jako „w przygotowaniu (niescalony)”, są już scalone — sprawdzone przez API GitHuba i w kodzie (`tests/helpers/route-matrix.js`, `src/pg/app.js`). W chwili tego przeglądu nie ma otwartych PR z nową funkcją.

## Zastrzeżenia (dotyczą całości poniższego zestawienia)

- **To jest prototyp**, przygotowywany przez jednego rodzica do przedstawienia zarządowi — nie produkt wdrożony ani zamówiony przez Radę.
- **Nie jest wdrożony na Railway.** Prawie cały kod serwera i migracje bazy działają na PostgreSQL (`src/pg/`, `src/server.js`, docelowy silnik); stary Cloudflare Worker/D1 (`src/index.js`, 5 tras) zostaje wyłącznie jako kontrakt równoważności i nigdy nie miał danych szkoły. Sam Railway (usługa Node.js, prywatny PostgreSQL, prywatny Storage Bucket) nie został uruchomiony; plan i kolejność kroków opisuje [`docs/RAILWAY_MIGRATION.md`](RAILWAY_MIGRATION.md). Poprzednia wersja (Worker/D1) **nigdy nie była wdrożona produkcyjnie** i nie zawierała danych szkoły.
- **Wszystkie dane w repozytorium, testach i demo są syntetyczne** (adresy `@example.invalid` itp.). W repozytorium nie ma i nie wolno umieszczać prawdziwych danych uczniów, adresów rodziców ani wyciągów bankowych.
- **Niegotowy do pracy na danych rodzin.** Import danych rodzin jest zablokowany do czasu zamknięcia decyzji D‑01–D‑06 (administrator danych, podstawa i cele przetwarzania, zakres importu, retencja, dostawcy, obowiązek informacyjny) — zob. [`docs/DECISIONS.md`](DECISIONS.md).
- Role i zakresy uprawnień wpisane dziś w kodzie (np. kto widzi wpłaty, kto zatwierdza kampanię) są **założeniami technicznymi potrzebnymi, żeby moduły w ogóle działały na danych syntetycznych** — nie są zatwierdzoną przez zarząd macierzą kompetencji (D‑08, D‑09). Pełna tabela ról per moduł jest w DECISIONS.md.
- Metoda logowania (e‑mail + hasło + TOTP) to wskazanie autora z 27.09.2026, **nie decyzja zarządu/IOD** (D‑10).
- Liczba PR wymienionych niżej nie jest wyczerpująca dla każdego modułu — wskazuje reprezentatywne, najważniejsze scalenia; pełna historia jest w `git log` i w zakładce Pull requests repozytorium.

## Skrót stanu modułów

| Moduł | Stan na main | Otwarte PR | Czeka na zarząd |
|---|---|---|---|
| Konta / logowanie / MFA | działa (PostgreSQL) + panel `admin/` i ekran `login/` | — | D‑08, D‑09, D‑10 |
| Rodziny i uczniowie | działa (PostgreSQL) + panel `families/` | — | D‑01–D‑04, D‑11 |
| Import CSV/XLSX | działa, bez zapisu produkcyjnych danych | — | D‑01–D‑03, D‑06 |
| Wpłaty | działa (ewidencja, korekty, zwroty, podział, OGM‑VCS, dane do wpłaty, eksport CSV) + panel `panel/` | — | D‑11–D‑14 |
| Księga | działa (wpisy, korekty, preliminarz, cztery oczy przy wydatkach, dowody, centra kosztów, sprawozdanie z migawkami) + panel `ledger/` | — | D‑15, D‑21 |
| Uzgodnienia wyciągu | działa (CODA/CAMT.053, porzucenie szkicu, dopasowania wsadowe i zwroty) + panel `reconciliation/` | — | D‑13 |
| Zamknięcie roku | działa (API) + panel `year-close/` | — | pośrednio D‑04, D‑13 |
| Eksport roczny / kopie | działa (+ panel `data-export/`, próba odtworzenia lokalnie) | — | D‑04, D‑21 |
| Raport Komisji Rewizyjnej | działa, tylko odczyt + panel `audit/` | — | D‑09 |
| E‑mail | działa jako kolejka/worker + panel `email/` (bez wysyłki w demie) | — | D‑16, D‑17 |
| Zebrania / uchwały | działa (w tym zebranie klasowe, odwołanie i zmiana terminu) + panel `meetings/` | — | D‑15, D‑19, D‑21 |
| Dokumenty | działa (panel, wersje i unieważnienie, podgląd, limity uploadu) | — | D‑04, D‑05, D‑08, D‑09 |
| Wydarzenia / wolontariat | działa; zadania i zapisy tylko przez API (panel `events/` bez tego widoku) | — | — |
| Strona publiczna i aktualności | działa (odczyt, galeria, kalendarz) + panel `news/` | — | D‑18, D‑22 |
| RODO | rejestry i mechanizmy cząstkowe (retencja, żądania osób, informacja o przetwarzaniu, zgody na wizerunek) | — | D‑01, D‑02, D‑04, D‑06, D‑07 |

---

## Konta, logowanie, MFA

**Na main:** konta wyłącznie z zaproszenia, role i przydziały z zakresem rok/klasa, wygaszanie kadencji i audyt (#70); logowanie e‑mail + hasło + TOTP, bramka MFA, ekran `login/` (#238, #3, D‑10); limity prób logowania i cofanie sesji (#233); autoryzacja z zakresem klasowym (SR‑01b), 404 poza zakresem, macierz uprawnień (#235, #4); bootstrap pierwszego administratora na pustej bazie (`npm run auth:bootstrap-admin`, #241); reset hasła i reset MFA jako akcje w panelu admina (#282, #224); administrator nie może nadać roli samemu sobie (#286, #146); link zaproszenia w panelu admina, wymagane powtórzenie hasła (#278, #164); tabela obsady klas i ponowne wysłanie zaproszenia (#293, #108); polityka haseł uwzględniająca polskie znaki diakrytyczne (#299); rotacja `MFA_ENCRYPTION_KEY` z pierścieniem kluczy (#314); dobrowolny zapis MFA i dokładniejsza odmowa 403 (#274, #161); zaproszenie na własny adres e-mail nie może już nadać roli (#402, #146).

**Scalone 28–30.09 (dawniej „w przygotowaniu”):** limit bezczynności sesji, absolutny limit rotacji, MFA na trasach zarządzania, krok w górę dla eksportu (#369, #150, SR‑10); krok w górę (świeże MFA) na zamknięcie roku, zatwierdzenie kampanii e‑mail, nadanie roli i resety hasła/MFA (#384, część 2 #150) — bez przyjęcia uchwały >3000 EUR, które czeka na D‑15; cookie `__Host-rd_session` (#416); blokada logowania na parę e‑mail+IP i ogólny limiter żądań (#423, #533); reset hasła i MFA kont chronionych wymaga drugiej osoby (#435); podgląd zaproszenia (#486); widok „Stan systemu” w `admin/` (#508); polityka haseł z rdzeniami Rady i miesięcy (#550).

Testy odmów MFA generowane z macierzy tras i ścieżka persony od zaproszenia (#553, #161) — same testy, bez nowej funkcji.

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑08 (macierz ról), D‑09 (dostęp dyrekcji i Komisji Rewizyjnej), D‑10 (formalne potwierdzenie metody logowania i towarzyszących parametrów: polityka haseł, limity prób, ważność tokenu resetu, procedura odzyskania dostępu, progi bezczynności/kroku w górę z #369/#384).

## Rodziny i uczniowie

**Na main:** wiele gospodarstw na ucznia, serwerowe API z zakresem klasy (#73, #5); konfiguracja roku szkolnego i klas, zamrożenie `enrollments` (#284, #78); zakończenie przypisania do klasy w trakcie roku — odejście ze szkoły (#285, #86); relacja opiekun–dziecko ze strażnikiem, historią zgody i trasą PATCH zgody (#246, #190); jedna definicja „aktualnej” relacji opiekun–uczeń — widok `student_guardians_current` (#250, #157); kampanie, worker, kartki i import czytają bieżące gospodarstwo ze `student_households`, nie z `students.household_id` (#232, #194); kontakt opiekuna dostępny dla zarządu z przydziałem klasy wyłącznie przez relację z uczniem tej klasy (#230, #200); karta gospodarstwa: przedstawiciel widzi wyłącznie opiekunów swojej klasy, e‑mail widoczny przy obu zgodach (#221, #95); wybór roku/klasy/gospodarstwa z listy zamiast wpisywania identyfikatorów (#275); dziennik odczytu danych rodzin (#320); złożone klucze obce klasa/rok i unikalny e‑mail bez rozróżniania wielkości liter (#347, #198); liczniki pulpitu przedstawiciela wg widoku `enrollments_current` (#368); nagłówek `/families/` ujednolicony z pozostałymi panelami, usunięta plakietka „RR” (#399).

**Scalone 28–30.09 (dawniej „w przygotowaniu”):** wniosek rodzica o aktualizację kontaktu przez jednorazowy link (#365, #140); zmiana opieki w trakcie roku — zakończenie relacji i członkostwa w gospodarstwie przez API, ostrzeżenie w kampaniach (#453, #86); promocja uczniów na nowy rok i kopiowanie klas z podglądem (#462, część #78); cykl roku szkolnego bez SQL (#532, #207).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑01–D‑04 (administrator danych, podstawa i cele, zakres importu, retencja), D‑11 (jednostka ewidencji składki i opieka dzielona).

## Import CSV/XLSX

**Na main:** transakcyjny import CSV/XLSX do PostgreSQL, wymaga roli z MFA (#57, #36); wspólny odczyt CSV — kodowanie UTF‑8/BOM, Windows‑1250, UTF‑16, separator — współdzielony z modułem kartek (#220); zgodność z CSP serwera Node, XLSX bez Workera `blob:` (#245, #188/#223); dwuetapowe dopasowanie opiekuna, przedrostki nazwisk, raport „brak w pliku” (#264); zera wiodące, komórki dat, wybór arkusza, klasa bez rozróżniania wielkości liter (#265); raport importu do pobrania, wykaz pominiętych kolumn, szablon z instrukcją (#267); import.js nie zostawia trybu importu włączonym w środowisku produkcyjnym (#296, #166); błędny e‑mail opiekuna w wierszu importu degraduje się do ostrzeżenia zamiast odrzucać cały wiersz — uczeń i ten opiekun trafiają do bazy z pustym e‑mailem, wiersz jest oznaczony jako wymagający poprawy (#386, scalony, część #207); odrzucany jest wyłącznie wiersz bez wymaganych pól ucznia/klasy. Zakres tego zachowania (czy błędny e‑mail w ogóle powinien wpuszczać wiersz) jest założeniem technicznym, nie decyzją zarządu — zob. sekcję „Założenia techniczne” niżej.

**Scalone 29.09:** powtórka partii tylko przy tym samym kluczu (#417, #2); limit rozpakowania XLSX (#422, #88); zapamiętane mapowanie kolumn i szablon XLSX (#461, #109); sekcja „W bazie, brak w pliku” w panelu (#507).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑01–D‑03 (administrator danych, podstawa przetwarzania, zakres pól importu — projekt listy pól jest w DECISIONS.md, ale nie jest zatwierdzony).

## Wpłaty

**Na main:** ewidencja wpłat i korekt na PostgreSQL (#54, #37); spójność wpłata↔księga — kontrola kwoty, zwroty, ponowne przypisanie (#260, #138); blokada korekty z aktywnym powiązaniem w szkicu uzgodnienia (#259, #165); kartki o dobrowolnej składce z serwera (#74, #11); `/print/` nie pokazuje już błędów walidacji przed interakcją użytkownika (#397).

**Scalone 28–30.09 (dawniej „w przygotowaniu”):** belgijska komunikacja strukturalna OGM‑VCS (#345, #83); zatwierdzone dane do wpłaty i generator EPC/QR (#341, #92) oraz kartki z kodem QR EPC (#377, #92) — w demie bez zatwierdzonych danych, więc kartki są szkicem bez QR; eksport CSV wpisów wpłat i korekt (#340, #141); podział nieprzypisanej wpłaty na gospodarstwa z ekranem w `panel/` (migracja 0104, #537, #127); filtry serwerowe listy wpłat (#541).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑11 (jednostka ewidencji i opieka dzielona), D‑12 (zasady korekt i zatwierdzania), D‑13 (rachunek bankowy i gotówka), D‑14 (sugerowana składka). Przypominamy: żaden automatyczny status „dłużnik” nie jest i nie będzie wdrożony — składki są dobrowolne.

## Księga

**Na main:** księga i preliminarz na PostgreSQL (#59, #38); przeksięgowanie wpisu — storno i wpis zastępczy atomowo (#261, #144); bilans otwarcia z podziałem rachunek/kasa, przenoszenie kasa↔rachunek (#270, #199); eksport CSV z kwotami jako liczby i neutralizacją formuł w polach tekstowych (#206); dowody księgowe — walidacja dokumentu, wszystkie załączniki wpisu, sekcja KR (#328, #87); kategorie księgi przez API zamiast SQL co roku, część 1 (#366, #207); projekt sprawozdania rocznego (bilans, przychody/wydatki wg kategorii z preliminarzem, wynik roku) i przepływy środków bank/kasa per miesiąc, wyłącznie do wewnętrznego podglądu zarządu/skarbnika z MFA, z nagłówkiem „projekt… nie jest wersją zatwierdzoną” (#382, część #125) — nie obejmuje niezmiennych migawek sprawozdań ani publikacji przez aktualności, to czeka na D‑21/D‑04.

**Scalone 28–30.09 (dawniej „w przygotowaniu”):** preliminarz przez API — kategorie, wersje linii, przyjęcie, plan vs wykonanie (#334, #107) i jego ekran w `ledger/` (#478); zasada czterech oczu przy wydatkach i uchwała jako upoważnienie do wydatku (#332, #97, #93) z wyborem uchwały w panelu (#431); centra kosztów i „Wynik wydarzeń” w raporcie KR (#445, #117); przeksięgowanie wpisu powiązanego z wpłatą (#460, #144); niezmienne, zatwierdzane migawki sprawozdania rocznego (#450, część #125, migracja 0138); eksport księgi w XLSX (#471).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑15 (format referencji uchwały i proces zatwierdzenia wydatku powyżej 3000 EUR).

## Uzgodnienia wyciągu bankowego

**Na main:** uzgodnienie rachunku i raport dla Komisji Rewizyjnej na PostgreSQL (#71, #7); wpłata gotówkowa nie jest proponowana ani wiązana z pozycją wyciągu (#219); blokada podwójnego ujęcia wpłaty i ponowna kontrola kwot przy zatwierdzeniu (#228); jedna migawka REPEATABLE READ dla raportu KR i widoku uzgodnienia (#348, #213); jedna migawka i limit propozycji dopasowań w SQL (#349); zbiorczy import pozycji, stronicowanie i pełne podsumowanie karty (#355); ekran prototypowy uzgodnień (część #147, #298) — moduł działa przez interfejs, nie tylko przez wywołania API; import wyciągu CODA i CAMT.053 z identyfikatorem transakcji banku i blokadą podwójnego importu (#344, część #105).

**Scalone 28–30.09 (dawniej „w przygotowaniu”):** porzucenie szkicu uzgodnienia i ponowny import tego samego pliku (#395, część #105) — założenie: porzucenie szkicu może wykonać sam autor, bez zasady czterech oczu, do potwierdzenia w D‑13; wsadowe zatwierdzenie wskazanych par (#516, część #115); wybór pliku CODA / CAMT.053 w panelu (#536); dopasowanie zwrotu wpłaty do ujemnej pozycji wyciągu (#538, część #138).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑13 (rachunek, gotówka, częstotliwość i sposób uzgadniania).

## Zamknięcie roku

**Na main:** zamknięcie roku szkolnego i przekazanie dokumentacji nowej Radzie — API (#75, #15); zamknięcie roku wygasza przydziały klasy bez roku (#229, #201/#198); zamrożenie zamkniętego roku obejmuje uzgodnienia, dokumenty i kampanie e‑mail (#255, #80); zamknięty rok — odczyt zestawienia przekazania, raportu KR i eksportu dla nowej Rady i admina (#247, #195); ekran zamknięcia roku szkolnego (#300, część #147) — moduł ma interfejs, nie tylko API; blokada jednego przebiegu eksportu rocznego na rok (#354, #216); advisory lock szereguje zamknięcia roku przed `LOCK TABLE` (#338, #212).

**Scalone 28–30.09:** wymóg świeżego MFA dla zamknięcia roku (#384, część 2 #150); zamrożenie pozostałych tabel z rokiem (#426, #80); kontrola salda końca roku (#449, #169); ostrzeżenia informacyjne z liczbami (#540); testy równoległego „Zamknij rok” na prawdziwym PostgreSQL (#546, #212).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** brak odrębnej pozycji D‑xx wyłącznie dla tego modułu; zależy pośrednio od D‑04 (retencja) i D‑13 (uzgadnianie rachunku przed zamknięciem).

## Eksport roczny i kopie zapasowe

**Na main:** eksport roczny z manifestem SHA‑256 i testem odtworzenia (#72, #9); eksport roczny v2 — gospodarstwa, uzgodnienia i zamknięcie roku przetrwają odtworzenie (#281); kopia zapasowa PostgreSQL — dziennik przebiegów, szyfrowanie po stronie klienta, próbne odtworzenie (#297, #90); kopia prywatnego bucketu dokumentów — `listObjects` i skrypt weryfikowany SHA‑256 (#302, #103). Tabele wprowadzone przez PR scalone 28.09 (`payment_instructions`, referencje OGM‑VCS, wycofania zgody na wizerunek, pliki zdjęć galerii, żądania aktualizacji danych opiekunów, `email_outbox_resolutions` i inne) są dziś w schemacie `main` i każda jest przypisana w `src/pg/export.js` albo do `EXPORT_TABLES`, albo do `EXPORT_EXCLUDED_TABLES` z uzasadnieniem (lista w `docs/EXPORT.md`; pilnuje tego `tests/pg-export-v2.test.js`). Wyłączenia są zachowawcze do decyzji o zakresie eksportu (D‑04, D‑08). Dodatkowo: ekran `data-export/` z krokiem w górę MFA (#454), eksport w partiach z przyrostowym SHA‑256 (#470), automatyczna próba odtworzenia lokalnie na danych syntetycznych (#517, część #90), weryfikacja kopii dokumentów (#509, część #103).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑04 (okres przechowywania kopii i danych po zakończeniu nauki/kadencji), D‑21 (mechanizm niezmiennych migawek sprawozdania rocznego jest na main od #450, migracja 0138; które sprawozdanie jest wiążące, kto je zatwierdza i czy publikować je w aktualnościach — decyzja otwarta).

## E‑mail

**Na main:** kolejka Brevo, zatwierdzanie kampanii i dzienny limit na Railway/Node (#64, #40); potwierdzenie każdej wiadomości przed wysyłką i token dzierżawy przebiegu (#231, #210/#177); worker e‑mail — zakończenie kampanii i audyt w jednej transakcji (#240, #178); worker e‑mail odporny na awarię bazy, SIGTERM i odmowę konta Brevo (#243, #172/#209); wyłącznik przy awarii Brevo — 429 i brak połączenia nie zużywają limitu ani próby (#251, #180); dzienny limit liczony w strefie czasowej konta Brevo, nie tylko UTC (#295, #84); słownik zakazanych sformułowań o zadłużeniu rozszerzony na FR/NL (#303, #120); wysyłka testowa kampanii wyłącznie na adresy techniczne Rady (#305, #104); harmonogram startu, wstrzymanie/wznowienie kampanii, okno wysyłki (#306, #130); checklista domeny nadawcy, `npm run email:preflight` (#308, #148); ekran kampanii e‑mail (#298, część #147) — moduł ma interfejs; anulowanie kampanii przez wspólne okno potwierdzenia (#372, follow‑up #298); utwardzenie niezmienności — zatwierdzenie kampanii, odwołanie sesji, wstawienie do kolejki, częściowo (#350, #204); poprawka widoczności zamkniętych okien dialogowych w `/email/` i `/year-close/` (#396).

**Scalone 28–30.09 (dawniej „w przygotowaniu”):** kategorie komunikatów i wypisanie jednym kliknięciem (#307, #110; testy #467); raport doręczeń i rozstrzyganie `delivery_unknown` (#309, #139; ekran raportu #463); lista wyłączeń — zdjęcie blokady jako nowy zapis (#326, #94; ekran #512); podgląd harmonogramu w czasie brukselskim (#465, #130).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑16 (szablon wiadomości i kartki), D‑17 (adres nadawcy i liczba adresatów). Przypomnienie z AGENTS.md: żadne zadanie testowe nie wysyła wiadomości do prawdziwego rodzica; wysyłka wymaga jawnego zatwierdzenia treści i listy odbiorców.

## Zebrania i uchwały

**Na main:** zebrania — obecność, quorum, protokoły i uchwały na PostgreSQL (#56, #13); wewnętrzny panel zebrań (#68); zatwierdzenie protokołu wymaga rozstrzygnięcia projektów uchwał, uchwała wymaga aktualnego quorum (#222); rejestr uchwał roku z relacjami „zmienia/uchyla” i śledzeniem wykonania (#283, #102); MFA i zasada czterech oczu przy uchwałach i protokołach, część A (#291, #135, SR‑10); dziennik zdarzeń dla zmiany terminu zebrania (#292, #113); przedstawiciel klasy w `/meetings/` dostaje widok „Protokoły udostępnione” zamiast 403 (#327, #167); zebranie klasowe za flagą `MEETINGS_CLASS_HOST` (#335, #171) — przedstawiciel jako gospodarz zebrania klasowego również musi mieć MFA, bardziej restrykcyjnie niż pierwotny projekt #171.

**Scalone 29–30.09:** odwołanie, zmiana terminu i wersjonowane zawiadomienie zebrania (#459, #113); lista kontrolna przed zatwierdzeniem protokołu (#506, #81); pola podpisu na wydruku protokołu (#491, #151); widok przedstawiciela — przycisk „Pokaż”, wydruk bez listy obecności i podpisów, nazwy klas (#547, #167).

**W przygotowaniu (niescalone):** brak. Krok w górę (świeże MFA) dla przyjęcia uchwały >3000 EUR nie jest objęty żadnym PR — mechanizm istnieje w innych trasach (#384, scalony), ale wpięcie go w przyjęcie uchwały czeka na decyzję D‑15.

**Czeka na zarząd:** D‑15 (format referencji uchwały i próg/proces zatwierdzenia wydatku, warunkuje ewentualny krok w górę przy przyjęciu uchwały), D‑19 (dopuszczalność głosowania elektronicznego), D‑21 (obowiązująca wersja regulaminu i dostęp do dokumentów źródłowych).

## Dokumenty (prywatny Storage Bucket)

**Na main:** panel dokumentów prywatnych (#63, #39/#8); prywatne dokumenty w docelowym Storage Bucket (#58, #39); kontrola struktury pliku PDF/PNG/JPEG przed zapisem do bucketu (#301, #89); poprawka na utraconą potwierdzenie COMMIT przy uploadzie, które nie usuwało osieroconego obiektu z bucketu (#252, #168).

**Na main (dodatkowo):** tytuł, kategoria i wyszukiwanie dokumentów (#313, #76); nagłówek `/documents/` ujednolicony do białego tła jak w pozostałych panelach (#401).

**Scalone 28–30.09 (dawniej „w przygotowaniu”):** wersje dokumentu i unieważnienie bez usuwania historii (#329, #82) z ekranem w `documents/` (#477) — uprawnienie do unieważnienia/zastąpienia jest dziś tożsame z uprawnieniem do odczytu, do potwierdzenia (sekcja „Założenia techniczne”); sesja sprawdzana przed ciałem żądania i limit współbieżnych uploadów (#370, #185), limit na użytkownika i 413 bez dopijania ciała (#549); podgląd PDF/PNG/JPEG w panelu (#466, część #89); filtr daty i sortowanie (#502).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑04 (retencja dokumentów), D‑05 (dostawca bucketu jako podmiot przetwarzający), D‑08/D‑09 (kto z ról widzi i unieważnia które dokumenty).

## Wydarzenia i wolontariat

**Na main:** wydarzenia — szkic, zatwierdzenie i publiczny kalendarz na PostgreSQL (#55, #12); wewnętrzny panel szkiców, zatwierdzania i publikacji (#60, #12); eksport kalendarza iCal (RFC 5545) dla publicznego kanału wydarzeń (#277); pulpit przedstawiciela klasy — klasa, kontakt, wydarzenia (#294, #118).

**Scalone 28–29.09:** zadania i zapisy wolontariuszy wydarzeń, Etap 1 — wyłącznie API i testy (#330, #500, #142); panel `events/` nie ma jeszcze widoku zadań i zapisów (docs/EVENTS.md); czasy iCal w UTC (#434, #122).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** brak dedykowanej pozycji D‑xx; publikacja treści wydarzeń podlega ogólnym zasadom czterech oczu opisanym w PRODUCT.md i EVENTS.md.

## Strona publiczna

**Na main:** strona publiczna tylko do odczytu — wydarzenia, protokoły udostępnione publicznie, aktualności (#67, #12/#14); aktualności i galeria po weryfikacji praw (#69, #14); poprawka pomijania wpisów `news` na stronie publicznej (#263, #237); obowiązkowy tekst alternatywny zdjęć i stabilna nawigacja (#315, #124); `X-Robots-Tag: noindex` dla paneli i `/api/`, `robots.txt` (#331, #116); wpis decyzji D‑22 w `docs/DECISIONS.md` — wyłącznie dokumentacja, bez implementacji wersji językowych (#352, część #129); issue #129 wprost zabrania wdrażania warstwy i18n przed tą decyzją, więc PR nie dodaje ani tabeli tłumaczeń, ani wyboru języka.

**Scalone 28–29.09:** magazyn plików zdjęć galerii, warianty web/thumb bez EXIF/GPS, publiczny odczyt (#351, #96; zdjęcia na stronie tylko przez publiczne API #439); ekran aktualności `news/` — szkic, zatwierdzenie, publikacja, wycofanie (#455); „Dodaj do kalendarza” i subskrypcja webcal (#496); stały adres wpisu i archiwum według roku (#511). Dane demo nie zawierają zdjęć (D‑18).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑18 (zasady publikacji zdjęć, w tym zgody na wizerunek dzieci), D‑22 (czy i jak wprowadzić wersje językowe strony publicznej — treść pytania i warianty już w DECISIONS.md, bez rozstrzygnięcia).

## RODO i prywatność

**Na main:** techniczny inwentarz danych osobowych w schemacie — `docs/PRIVACY_INVENTORY.md` i `scripts/privacy-report.js` (#312); ostrzeżenie o danych osobowych w treści korekty wpłaty i blokada publikacji protokołu z takim ostrzeżeniem (#339, #152); dokumentacja porządkująca: dawny Worker/D1 nigdy nie był wdrożony, wszystkie decyzje zarządu pozostają otwarte (#227).

**Scalone 28–29.09 (dawniej „w przygotowaniu”):** rejestr polityk retencji i raport kandydatów do usunięcia — projekt pod D‑04, bez zatwierdzonych okresów (#318, #91); rejestr żądań osób — wyłącznie rejestr i przejścia stanu, bez eksportu danych rodziny, sprostowania ani ograniczenia przetwarzania, co czeka na D‑07 (#323, #100); wersjonowana informacja o przetwarzaniu danych jako warunek importu — mechanizm pod D‑06 (#333, #145); rejestr zgód na wizerunek — zakres, wygaśnięcie i wycofanie jednej zgody (#337, #106); dziennik odczytu danych rodzin z przeglądem dla admina (#456, #133); bramka danych osobowych w polach wolnego tekstu (#469, #152, #529).

**W przygotowaniu (niescalone):** brak.

**Czeka na zarząd:** D‑01 (administrator danych), D‑02 (podstawa i cele przetwarzania), D‑04 (retencja), D‑06 (obowiązek informacyjny), D‑07 (procedura incydentowa, sprostowanie, usuwanie danych — obejmuje też, czy rejestr żądań #323 ma zyskać funkcje wykonawcze). Zbudowane rejestry (#318, #323, #333, #337 — wszystkie scalone) są pracą techniczną — same nie zastępują żadnej z tych decyzji.

## Założenia techniczne do potwierdzenia przez zarząd

Poniższe to konkretne wybory przyjęte w kodzie na main tam, gdzie regulamin albo decyzja D‑xx jeszcze nie rozstrzyga sprawy. Przyjęto wariant zachowawczy zgodnie z AGENTS.md, ale to nie jest decyzja zarządu — każdy punkt niżej czeka na potwierdzenie lub inną decyzję.

- **Zakres eksportu rocznego.** Część tabel jest zachowawczo wyłączona z paczki eksportu rocznego (`EXPORT_EXCLUDED_TABLES` z uzasadnieniem w `docs/EXPORT.md`), m.in. dane z PR #341/#377, #345, #337, #351, #365 i #309 (wszystkie scalone). Wymaga potwierdzenia w ramach **D‑04** (retencja i zakres kopii) i **D‑08** (macierz ról decydująca, kto w ogóle ma dostęp do tych danych).
- **Import: błędny e-mail opiekuna nie odrzuca wiersza.** PR #386 (scalony) zmienił zachowanie importu tak, że błędny adres e-mail opiekuna degraduje się do ostrzeżenia — wiersz z uczniem i tym opiekunem trafia do bazy z pustym e-mailem, zamiast być odrzucony w całości. Odrzucany jest tylko wiersz bez wymaganych pól ucznia/klasy. Czy to jest pożądane zachowanie (a nie np. zawsze odrzucać wiersz z błędnym adresem) należy do **D‑03** (zakres importu).
- **Dokumenty: kto może unieważnić/zastąpić dokument.** PR #329 (scalony) przyjął założenie, że uprawnienie do unieważnienia/zastąpienia dokumentu jest tożsame z uprawnieniem do jego odczytu (np. skarbnik z MFA mógłby unieważniać dokumenty finansowe). Do potwierdzenia w ramach **D‑08**/**D‑09**.
- **Krok w górę (świeże MFA) dla przyjęcia uchwały powyżej 3000 EUR.** Mechanizm technicznie gotowy (`requireAccess`/`freshMfaForbiddenCode`, wpięty już w zamknięcie roku, zatwierdzenie kampanii e-mail i akcje administracyjne przez scalony PR #384), ale nie wpięty w przyjęcie uchwały — czeka na **D‑15** (czy próg 3000 EUR i sam wymóg są w ogóle pożądane, w jakim formacie ma być referencja uchwały).
- **Migawki sprawozdań rocznych i zatwierdzanie przez drugą osobę.** PR #382 (scalony) daje wewnętrzny *projekt* sprawozdania liczony na bieżąco; PR #450 (scalony, migracja 0138) dodał niezmienne migawki z SHA‑256 (`financial_report_snapshots`) zatwierdzane przez inną osobę z zarządu i wskazywane przy zamknięciu roku. Publikacji sprawozdania przez aktualności nie ma. Czy migawka jest dokumentem wiążącym, kto ją zatwierdza i jak długo ją przechowywać — **D‑21**/**D‑04**.
- **Porzucenie szkicu uzgodnienia bez zasady czterech oczu.** PR #395 (scalony) pozwala autorowi samodzielnie porzucić własny szkic uzgodnienia (bez drugiej osoby), z uzasadnieniem że porzucenie niczego nie zatwierdza jako uzgodnione. Założenie do potwierdzenia w ramach **D‑13** (rachunek, gotówka, sposób uzgadniania).
- **Progi sesji i kroku w górę.** 30 minut bezczynności sesji i 15 minut ważności „świeżego MFA” (PR #369 i rozszerzenie #384, scalone) to wartości domyślne przyjęte przez autora, konfigurowalne w kodzie, ale wymagające potwierdzenia w ramach **D‑10** (dostawca logowania i towarzyszące parametry).
- **MFA dla przedstawiciela-gospodarza zebrania klasowego.** PR #335 (scalony) wymaga MFA także od przedstawiciela prowadzącego zebranie klasowe — to bardziej restrykcyjne niż pierwotny projekt w issue #171. Dotyczy **D‑19** (głosowanie elektroniczne) i pośrednio **D‑21** (obowiązujący regulamin).
- **Rejestr żądań RODO bez działania wykonawczego.** PR #323 (scalony) daje wyłącznie rejestr żądań osób i przejść stanu — nie ma w nim automatycznego eksportu danych rodziny, sprostowania ani ograniczenia przetwarzania. Zakres i procedura wykonania żądania czekają na **D‑07**.

## Poza podziałem na moduły (przekrojowe)

- **Autoryzacja i granice ról:** każda trasa API sprawdza sesję i uprawnienia po stronie serwera (SR‑01b, zakres klasowy, macierz 27 modułów — #235, #4); ukrycie przycisku w interfejsie nigdy nie jest jedyną kontrolą dostępu.
- **Monitoring i CI:** `/health/ready`, logi JSON z redakcją, łagodne zamykanie (#234, #16/#41); testy równoległe z shardingiem i bazą PostgreSQL do testów wyścigów (#249); audyt npm, Dependabot, akcje przypięte do SHA (#353, #153); `/health/ready` ogranicza równoległe zapytania do puli przez single-flight (#388, #244); test wykrywający zduplikowane klucze w literałach źródłowych — `shared/messages.js`, inwentarz prywatności, katalog błędów (#398, #329); pierwsze testy Playwright kluczowych ścieżek w CI (#381); naprawiony wiszący test wyścigów uzgodnienia `pg-reconciliation-race.test.js` (#403).
- **Dostępność:** przegląd WCAG 2.2 AA i widoku mobilnego (#65, #16); rozszerzenie przeglądu na `admin/`, `families/` i test na wszystkie aplikacje (#310, #112); poprawka poziomego scrolla strony na telefonie w nawigacji paneli ze wspólną powłoką (#400, #182).
- **Tryb tylko do odczytu:** `APP_WRITE_MODE=read_only` do bezpiecznych demonstracji bez ryzyka zapisu (#289, #143).
- **Wspólna nawigacja paneli:** `reconciliation/` i `email/` przełączone na wzorzec wspólnej powłoki `shared/shell.js` używany przez pozostałe panele, zamiast osobnego, statycznego paska (#374, follow-up #298); ekran startowy panelu pokazuje stan roli zamiast listy 10 modułów kończących się odmową dla ról bez dostępu (#342, #176).
- **Dokumentacja pokazu:** scenariusz demonstracji prototypu dla zarządu — `docs/DEMO.md` (#406, poprawki z przeglądów #484, #495, #522–#526, #531, #539) i lokalny seed danych demo `npm run demo:seed` (#404).

---

Dokument nie wyczerpuje wszystkich scalonych zmian technicznych (np. poprawek testów, drobnych napraw CI) — pełna historia jest w repozytorium. Każde stwierdzenie powyżej odsyła do konkretnego PR lub pliku w `docs/`; brak odniesienia oznacza, że funkcja nie istnieje w kodzie.
