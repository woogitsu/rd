# Stan prototypu — zestawienie dla zarządu Rady

Stan na 28.09.2026, gałąź `main` repozytorium `woogitsu/rd`. Dokument opisuje wyłącznie to, co potwierdza kod, scalone PR-y i dokumentacja w `docs/`. Nie zawiera prognoz ani deklaracji gotowości.

## Zastrzeżenia (dotyczą całości poniższego zestawienia)

- **To jest prototyp**, przygotowywany przez jednego rodzica do przedstawienia zarządowi — nie produkt wdrożony ani zamówiony przez Radę.
- **Nie jest wdrożony na Railway.** Kod serwera i migracje bazy działają dziś na Cloudflare Workers/D1 (lokalnie, deweloperski) oraz równolegle na PostgreSQL (`src/pg/`, docelowy silnik). Sam Railway (usługa Node.js, prywatny PostgreSQL, prywatny Storage Bucket) nie został uruchomiony; plan i kolejność kroków opisuje [`docs/RAILWAY_MIGRATION.md`](RAILWAY_MIGRATION.md). Poprzednia wersja (Worker/D1) **nigdy nie była wdrożona produkcyjnie** i nie zawierała danych szkoły.
- **Wszystkie dane w repozytorium, testach i demo są syntetyczne** (adresy `@example.invalid` itp.). W repozytorium nie ma i nie wolno umieszczać prawdziwych danych uczniów, adresów rodziców ani wyciągów bankowych.
- **Niegotowy do pracy na danych rodzin.** Import danych rodzin jest zablokowany do czasu zamknięcia decyzji D‑01–D‑06 (administrator danych, podstawa i cele przetwarzania, zakres importu, retencja, dostawcy, obowiązek informacyjny) — zob. [`docs/DECISIONS.md`](DECISIONS.md).
- Role i zakresy uprawnień wpisane dziś w kodzie (np. kto widzi wpłaty, kto zatwierdza kampanię) są **założeniami technicznymi potrzebnymi, żeby moduły w ogóle działały na danych syntetycznych** — nie są zatwierdzoną przez zarząd macierzą kompetencji (D‑08, D‑09). Pełna tabela ról per moduł jest w DECISIONS.md.
- Metoda logowania (e‑mail + hasło + TOTP) to wskazanie autora z 27.09.2026, **nie decyzja zarządu/IOD** (D‑10).
- Liczba PR wymienionych niżej nie jest wyczerpująca dla każdego modułu — wskazuje reprezentatywne, najważniejsze scalenia; pełna historia jest w `git log` i w zakładce Pull requests repozytorium.

## Skrót stanu modułów

| Moduł | Stan na main | Otwarte PR | Czeka na zarząd |
|---|---|---|---|
| Konta / logowanie / MFA | działa (PostgreSQL) | tak | D‑08, D‑09, D‑10 |
| Rodziny i uczniowie | działa (PostgreSQL) | tak | D‑01–D‑04, D‑11 |
| Import CSV/XLSX | działa, bez zapisu produkcyjnych danych | — | D‑01–D‑03 |
| Wpłaty | działa (ewidencja i korekty) | tak (OGM‑VCS, EPC/QR, eksport CSV) | D‑11–D‑14 |
| Księga | działa (wpisy, korekty, bilans) | tak (preliminarz, dowody, cztery oczy) | D‑15 |
| Uzgodnienia wyciągu | działa + ekran prototypowy | tak (import CODA/CAMT.053) | D‑13 |
| Zamknięcie roku | działa (API) + ekran prototypowy | tak (advisory lock) | — |
| Eksport roczny / kopie | działa | — | D‑04 (retencja kopii) |
| E‑mail | działa jako kolejka/worker + ekran prototypowy | tak (follow‑up UI) | D‑16, D‑17 |
| Zebrania / uchwały | działa | tak (zebranie klasowe) | D‑19, D‑21 |
| Dokumenty | działa | tak (limit uploadów) | D‑04, D‑05, D‑08, D‑09 |
| Wydarzenia / wolontariat | działa | tak (Etap 1 wolontariatu) | — |
| Strona publiczna | działa (odczyt) | tak (galeria, i18n) | D‑18, D‑22 |
| RODO | rejestry i mechanizmy cząstkowe | — | D‑01, D‑02, D‑04, D‑06, D‑07 |

---

## Konta, logowanie, MFA

**Na main:** konta wyłącznie z zaproszenia, role i przydziały z zakresem rok/klasa, wygaszanie kadencji i audyt (#70); logowanie e‑mail + hasło + TOTP, bramka MFA, ekran `login/` (#238, #3, D‑10); limity prób logowania i cofanie sesji (#233); autoryzacja z zakresem klasowym (SR‑01b), 404 poza zakresem, macierz uprawnień (#235, #4); bootstrap pierwszego administratora na pustej bazie (`npm run auth:bootstrap-admin`, #241); reset hasła i reset MFA jako akcje w panelu admina (#282, #224); administrator nie może nadać roli samemu sobie (#286, #146); link zaproszenia w panelu admina, wymagane powtórzenie hasła (#278, #164); tabela obsady klas i ponowne wysłanie zaproszenia (#293, #108); polityka haseł uwzględniająca polskie znaki diakrytyczne (#299); rotacja `MFA_ENCRYPTION_KEY` z pierścieniem kluczy (#314); dobrowolny zapis MFA i dokładniejsza odmowa 403 (#274, #161).

**W otwartych PR:** #369 — limit bezczynności sesji, absolutny limit rotacji, MFA na trasach zarządzania, krok w górę dla eksportu (#150, SR‑10).

**Czeka na zarząd:** D‑08 (macierz ról), D‑09 (dostęp dyrekcji i Komisji Rewizyjnej), D‑10 (formalne potwierdzenie metody logowania i towarzyszących parametrów: polityka haseł, limity prób, ważność tokenu resetu, procedura odzyskania dostępu).

## Rodziny i uczniowie

**Na main:** wiele gospodarstw na ucznia, serwerowe API z zakresem klasy (#73, #5); konfiguracja roku szkolnego i klas, zamrożenie `enrollments` (#284, #78); zakończenie przypisania do klasy w trakcie roku — odejście ze szkoły (#285, #86); relacja opiekun–dziecko ze strażnikiem, historią zgody i trasą PATCH zgody (#246, #190); jedna definicja „aktualnej” relacji opiekun–uczeń — widok `student_guardians_current` (#250, #157); kampanie, worker, kartki i import czytają bieżące gospodarstwo ze `student_households`, nie z `students.household_id` (#232, #194); kontakt opiekuna dostępny dla zarządu z przydziałem klasy wyłącznie przez relację z uczniem tej klasy (#230, #200); karta gospodarstwa: przedstawiciel widzi wyłącznie opiekunów swojej klasy, e‑mail widoczny przy obu zgodach (#221, #95); wybór roku/klasy/gospodarstwa z listy zamiast wpisywania identyfikatorów (#275); dziennik odczytu danych rodzin (#320).

**W otwartych PR:** #347 — złożone klucze obce klasa/rok i unikalny e‑mail bez rozróżniania wielkości liter (#198); #365 — wniosek rodzica o aktualizację kontaktu przez jednorazowy link (#140); #368 — liczniki pulpitu przedstawiciela wg `enrollments_current`.

**Czeka na zarząd:** D‑01–D‑04 (administrator danych, podstawa i cele, zakres importu, retencja), D‑11 (jednostka ewidencji składki i opieka dzielona).

## Import CSV/XLSX

**Na main:** transakcyjny import CSV/XLSX do PostgreSQL, wymaga roli z MFA (#57, #36); wspólny odczyt CSV — kodowanie UTF‑8/BOM, Windows‑1250, UTF‑16, separator — współdzielony z modułem kartek (#220); zgodność z CSP serwera Node, XLSX bez Workera `blob:` (#245, #188/#223); dwuetapowe dopasowanie opiekuna, przedrostki nazwisk, raport „brak w pliku” (#264); zera wiodące, komórki dat, wybór arkusza, klasa bez rozróżniania wielkości liter (#265); raport importu do pobrania, wykaz pominiętych kolumn, szablon z instrukcją (#267); import.js nie zostawia trybu importu włączonym w środowisku produkcyjnym (#296, #166).

**W otwartych PR:** brak dedykowanych PR na moduł import w bieżącej kolejce.

**Czeka na zarząd:** D‑01–D‑03 (administrator danych, podstawa przetwarzania, zakres pól importu — projekt listy pól jest w DECISIONS.md, ale nie jest zatwierdzony).

## Wpłaty

**Na main:** ewidencja wpłat i korekt na PostgreSQL (#54, #37); spójność wpłata↔księga — kontrola kwoty, zwroty, ponowne przypisanie (#260, #138); blokada korekty z aktywnym powiązaniem w szkicu uzgodnienia (#259, #165); kartki o dobrowolnej składce z serwera (#74, #11).

**W otwartych PR:** #345 — belgijska komunikacja strukturalna (OGM‑VCS) na wpłatach (#83); #341 — zatwierdzone dane do wpłaty i generator EPC/QR, częściowo (#92); #340 — eksport CSV wpisów wpłat i korekt, częściowo (#141).

**Czeka na zarząd:** D‑11 (jednostka ewidencji i opieka dzielona), D‑12 (zasady korekt i zatwierdzania), D‑13 (rachunek bankowy i gotówka), D‑14 (sugerowana składka). Przypominamy: żaden automatyczny status „dłużnik” nie jest i nie będzie wdrożony — składki są dobrowolne.

## Księga

**Na main:** księga i preliminarz na PostgreSQL (#59, #38); przeksięgowanie wpisu — storno i wpis zastępczy atomowo (#261, #144); bilans otwarcia z podziałem rachunek/kasa, przenoszenie kasa↔rachunek (#270, #199); eksport CSV z kwotami jako liczby i neutralizacją formuł w polach tekstowych (#206).

**W otwartych PR:** #334 — preliminarz przez API: kategorie, wersje linii, przyjęcie przez zebranie, plan vs wykonanie, częściowo (#107); #328 — dowody księgowe: walidacja dokumentu, wszystkie załączniki wpisu, sekcja KR, częściowo (#87); #366 — kategorie księgi przez API zamiast SQL co roku, część 1 (#207); #332 — zasada czterech oczu przy wydatkach i uchwała jako upoważnienie do wydatku, częściowo (#97, #93).

**Czeka na zarząd:** D‑15 (format referencji uchwały i proces zatwierdzenia wydatku powyżej 3000 EUR).

## Uzgodnienia wyciągu bankowego

**Na main:** uzgodnienie rachunku i raport dla Komisji Rewizyjnej na PostgreSQL (#71, #7); wpłata gotówkowa nie jest proponowana ani wiązana z pozycją wyciągu (#219); blokada podwójnego ujęcia wpłaty i ponowna kontrola kwot przy zatwierdzeniu (#228); jedna migawka REPEATABLE READ dla raportu KR i widoku uzgodnienia (#348, #213); jedna migawka i limit propozycji dopasowań w SQL (#349); zbiorczy import pozycji, stronicowanie i pełne podsumowanie karty (#355); ekran prototypowy uzgodnień (część #147, #298) — moduł działa przez interfejs, nie tylko przez wywołania API.

**W otwartych PR:** #344 — import wyciągu CODA i CAMT.053 z identyfikatorem transakcji banku i blokadą podwójnego importu, część (#105).

**Czeka na zarząd:** D‑13 (rachunek, gotówka, częstotliwość i sposób uzgadniania).

## Zamknięcie roku

**Na main:** zamknięcie roku szkolnego i przekazanie dokumentacji nowej Radzie — API (#75, #15); zamknięcie roku wygasza przydziały klasy bez roku (#229, #201/#198); zamrożenie zamkniętego roku obejmuje uzgodnienia, dokumenty i kampanie e‑mail (#255, #80); zamknięty rok — odczyt zestawienia przekazania, raportu KR i eksportu dla nowej Rady i admina (#247, #195); ekran zamknięcia roku szkolnego (#300, część #147) — moduł ma interfejs, nie tylko API; blokada jednego przebiegu eksportu rocznego na rok (#354, #216).

**W otwartych PR:** #338 — advisory lock szereguje zamknięcia roku przed `LOCK TABLE` (#212).

**Czeka na zarząd:** brak odrębnej pozycji D‑xx wyłącznie dla tego modułu; zależy pośrednio od D‑04 (retencja) i D‑13 (uzgadnianie rachunku przed zamknięciem).

## Eksport roczny i kopie zapasowe

**Na main:** eksport roczny z manifestem SHA‑256 i testem odtworzenia (#72, #9); eksport roczny v2 — gospodarstwa, uzgodnienia i zamknięcie roku przetrwają odtworzenie (#281); kopia zapasowa PostgreSQL — dziennik przebiegów, szyfrowanie po stronie klienta, próbne odtworzenie (#297, #90); kopia prywatnego bucketu dokumentów — `listObjects` i skrypt weryfikowany SHA‑256 (#302, #103).

**W otwartych PR:** brak dedykowanych PR w bieżącej kolejce.

**Czeka na zarząd:** D‑04 (okres przechowywania kopii i danych po zakończeniu nauki/kadencji).

## E‑mail

**Na main:** kolejka Brevo, zatwierdzanie kampanii i dzienny limit na Railway/Node (#64, #40); potwierdzenie każdej wiadomości przed wysyłką i token dzierżawy przebiegu (#231, #210/#177); worker e‑mail — zakończenie kampanii i audyt w jednej transakcji (#240, #178); worker e‑mail odporny na awarię bazy, SIGTERM i odmowę konta Brevo (#243, #172/#209); wyłącznik przy awarii Brevo — 429 i brak połączenia nie zużywają limitu ani próby (#251, #180); dzienny limit liczony w strefie czasowej konta Brevo, nie tylko UTC (#295, #84); słownik zakazanych sformułowań o zadłużeniu rozszerzony na FR/NL (#303, #120); wysyłka testowa kampanii wyłącznie na adresy techniczne Rady (#305, #104); harmonogram startu, wstrzymanie/wznowienie kampanii, okno wysyłki (#306, #130); kategorie komunikatów i wypisanie jednym kliknięciem (#307, #110); checklista domeny nadawcy, `npm run email:preflight` (#308, #148); raport doręczeń i rozstrzyganie `delivery_unknown` (#309, #139); lista wyłączeń — przegląd i zdjęcie blokady jako nowy zapis, nie nadpisanie (#326, #94); ekran kampanii e‑mail (#298, część #147) — moduł ma interfejs.

**W otwartych PR:** #372 — anulowanie kampanii przez wspólne okno potwierdzenia, follow‑up (#298); #350 — utwardzenie niezmienności: zatwierdzenie kampanii, odwołanie sesji, wstawienie do kolejki, częściowo (#204).

**Czeka na zarząd:** D‑16 (szablon wiadomości i kartki), D‑17 (adres nadawcy i liczba adresatów). Przypomnienie z AGENTS.md: żadne zadanie testowe nie wysyła wiadomości do prawdziwego rodzica; wysyłka wymaga jawnego zatwierdzenia treści i listy odbiorców.

## Zebrania i uchwały

**Na main:** zebrania — obecność, quorum, protokoły i uchwały na PostgreSQL (#56, #13); wewnętrzny panel zebrań (#68); zatwierdzenie protokołu wymaga rozstrzygnięcia projektów uchwał, uchwała wymaga aktualnego quorum (#222); rejestr uchwał roku z relacjami „zmienia/uchyla” i śledzeniem wykonania (#283, #102); MFA i zasada czterech oczu przy uchwałach i protokołach, część A (#291, #135, SR‑10); dziennik zdarzeń dla zmiany terminu zebrania (#292, #113); przedstawiciel klasy w `/meetings/` dostaje widok „Protokoły udostępnione” zamiast 403 (#327, #167).

**W otwartych PR:** #335 — zebranie klasowe za flagą `MEETINGS_CLASS_HOST` (#171).

**Czeka na zarząd:** D‑19 (dopuszczalność głosowania elektronicznego), D‑21 (obowiązująca wersja regulaminu i dostęp do dokumentów źródłowych).

## Dokumenty (prywatny Storage Bucket)

**Na main:** panel dokumentów prywatnych (#63, #39/#8); prywatne dokumenty w docelowym Storage Bucket (#58, #39); kontrola struktury pliku PDF/PNG/JPEG przed zapisem do bucketu (#301, #89); tytuł, kategoria i wyszukiwanie dokumentów (#313, #76); wersje dokumentu i unieważnienie bez usuwania historii (#329, #82); poprawka na utraconą potwierdzenie COMMIT przy uploadzie, które nie usuwało osieroconego obiektu z bucketu (#252, #168).

**W otwartych PR:** #370 — sesja sprawdzana przed ciałem żądania i limit współbieżnych uploadów (#185).

**Czeka na zarząd:** D‑04 (retencja dokumentów), D‑05 (dostawca bucketu jako podmiot przetwarzający), D‑08/D‑09 (kto z ról widzi które dokumenty).

## Wydarzenia i wolontariat

**Na main:** wydarzenia — szkic, zatwierdzenie i publiczny kalendarz na PostgreSQL (#55, #12); wewnętrzny panel szkiców, zatwierdzania i publikacji (#60, #12); eksport kalendarza iCal (RFC 5545) dla publicznego kanału wydarzeń (#277); pulpit przedstawiciela klasy — klasa, kontakt, wydarzenia (#294, #118).

**W otwartych PR:** #330 — zadania i zapisy wolontariuszy wydarzeń, Etap 1 (#142).

**Czeka na zarząd:** brak dedykowanej pozycji D‑xx; publikacja treści wydarzeń podlega ogólnym zasadom czterech oczu opisanym w PRODUCT.md i EVENTS.md.

## Strona publiczna

**Na main:** strona publiczna tylko do odczytu — wydarzenia, protokoły udostępnione publicznie, aktualności (#67, #12/#14); aktualności i galeria po weryfikacji praw (#69, #14); poprawka pomijania wpisów `news` na stronie publicznej (#263, #237); obowiązkowy tekst alternatywny zdjęć i stabilna nawigacja (#315, #124); `X-Robots-Tag: noindex` dla paneli i `/api/`, `robots.txt` (#331, #116).

**W otwartych PR:** #351 — magazyn plików zdjęć galerii, warianty web/thumb bez EXIF/GPS, publiczny odczyt (#96); #352 — propozycja decyzji D‑22 (wersje językowe strony), bez implementacji (#129).

**Czeka na zarząd:** D‑18 (zasady publikacji zdjęć, w tym zgody na wizerunek dzieci), D‑22 (czy i jak wprowadzić wersje językowe strony publicznej).

## RODO i prywatność

**Na main:** techniczny inwentarz danych osobowych w schemacie — `docs/PRIVACY_INVENTORY.md` i `scripts/privacy-report.js` (#312); rejestr polityk retencji i raport kandydatów do usunięcia — projekt pod D‑04, nie zatwierdzone okresy (#318, #91); rejestr żądań osób (RODO) — wyłącznie rejestr i przejścia stanu, bez automatycznego działania (#323, #100); wersjonowana informacja o przetwarzaniu danych jako warunek importu — mechanizm pod D‑06 (#333, #145); rejestr zgód na wizerunek — zakres, wygaśnięcie, wycofanie jednej zgody (#337, #106); ostrzeżenie o danych osobowych w treści korekty wpłaty i blokada publikacji protokołu z takim ostrzeżeniem (#339, #152); dokumentacja porządkująca: dawny Worker/D1 nigdy nie był wdrożony, wszystkie decyzje zarządu pozostają otwarte (#227).

**W otwartych PR:** brak dedykowanych PR w bieżącej kolejce poza tymi wymienionymi wyżej przy poszczególnych modułach.

**Czeka na zarząd:** D‑01 (administrator danych), D‑02 (podstawa i cele przetwarzania), D‑04 (retencja), D‑06 (obowiązek informacyjny), D‑07 (procedura incydentowa, sprostowanie, usuwanie danych). Zbudowane rejestry i mechanizmy są przygotowaniem technicznym — same nie zastępują żadnej z tych decyzji.

## Poza podziałem na moduły (przekrojowe)

- **Autoryzacja i granice ról:** każda trasa API sprawdza sesję i uprawnienia po stronie serwera (SR‑01b, zakres klasowy, macierz 16 modułów — #235, #4); ukrycie przycisku w interfejsie nigdy nie jest jedyną kontrolą dostępu.
- **Monitoring i CI:** `/health/ready`, logi JSON z redakcją, łagodne zamykanie (#234, #16/#41); testy równoległe z shardingiem i bazą PostgreSQL do testów wyścigów (#249); audyt npm, Dependabot, akcje przypięte do SHA (#353, #153).
- **Dostępność:** przegląd WCAG 2.2 AA i widoku mobilnego (#65, #16); rozszerzenie przeglądu na `admin/`, `families/` i test na wszystkie aplikacje (#310, #112).
- **Tryb tylko do odczytu:** `APP_WRITE_MODE=read_only` do bezpiecznych demonstracji bez ryzyka zapisu (#289, #143).

---

Dokument nie wyczerpuje wszystkich scalonych zmian technicznych (np. poprawek testów, drobnych napraw CI) — pełna historia jest w repozytorium. Każde stwierdzenie powyżej odsyła do konkretnego PR lub pliku w `docs/`; brak odniesienia oznacza, że funkcja nie istnieje w kodzie.
