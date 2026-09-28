# Rejestr decyzji zarządu i szkoły

Ten dokument zbiera decyzje organizacyjne i prawne, których zespół techniczny nie podejmuje. Wypełniają go zarząd Rady, dyrekcja szkoły i IOD. Opisane warianty pochodzą wyłącznie z istniejącej dokumentacji i issues; nie są rekomendacją prawną. Brak wpisu oznacza, że decyzja nie zapadła.

Do czasu zamknięcia decyzji D-01–D-06 nie importujemy danych rodzin. Prace na danych syntetycznych mogą trwać równolegle (#1).

Stan na 27.09.2026: żadna decyzja nie zapadła; wszystkie pozycje poniżej są otwarte. Portal jest prototypem przygotowywanym przez jednego rodzica do przedstawienia zarządowi. Poprzednia wersja (Cloudflare Worker/D1) nigdy nie była wdrożona ani nie zawierała danych szkoły — zob. [RAILWAY_MIGRATION.md](RAILWAY_MIGRATION.md#stan-wyjściowy-fakt-nie-decyzja). Założenia przyjęte w kodzie do czasu decyzji są opisane w PR i issues jako warianty tymczasowe, nie jako decyzje.

## Jak wypełniać

- Status: `otwarta` → `przyjęta` albo `odrzucona`. Zmiana przyjętej decyzji to nowy wpis z odwołaniem do poprzedniego, bez usuwania starego.
- Kto zatwierdził: funkcja i organ (np. zarząd, dyrekcja, IOD), bez danych kontaktowych.
- Uchwała/dokument: numer uchwały, protokołu lub pisma. Nie dołączać do repozytorium dokumentów z danymi osobowymi.

## Podsumowanie

| ID | Decyzja | Blokuje | Status |
|---|---|---|---|
| D-01 | Administrator danych | #1, #2, #36, #41 | otwarta |
| D-02 | Podstawa i cele przetwarzania | #1, #2, #36 | otwarta |
| D-03 | Zakres importu i lista pól | #1, #2, #36 | otwarta |
| D-04 | Okresy retencji i usuwanie | #1, #2, #8, #9, #36, #39 | otwarta |
| D-05 | Dostawcy, umowy powierzenia, lokalizacja | #1, #31, #40, #41 | otwarta |
| D-06 | Obowiązek informacyjny wobec rodziców | #1, #2, #10 | otwarta |
| D-07 | Procedura incydentowa, sprostowanie i usuwanie danych | #1, #41 | otwarta |
| D-08 | Role i macierz kompetencji | #4, #35 | otwarta |
| D-09 | Uprawnienia dyrekcji i Komisji Rewizyjnej | #4, #6, #7, #35 | otwarta |
| D-10 | Dostawca logowania i przyjmowanie zaproszeń | #3, #35 | otwarta — wskazanie użytkownika 2026-09-27: e-mail + hasło + TOTP; do formalnego potwierdzenia |
| D-11 | Jednostka ewidencji składki i opieka dzielona | #5, #6, #10, #11 | otwarta |
| D-12 | Zasady korekt wpłat i ich zatwierdzania | #6, #37 | otwarta |
| D-13 | Rachunek bankowy, gotówka i uzgadnianie | #6, #7, #10 | otwarta |
| D-14 | Sugerowana składka na rok | #6, #10, #11 | otwarta |
| D-15 | Zatwierdzanie wydatków powyżej 3000 EUR | #7, #38 | otwarta |
| D-16 | Szablon wiadomości i kartki | #10, #11, #40 | otwarta |
| D-17 | Adres nadawcy i adresaci wysyłki | #10, #40 | otwarta |
| D-18 | Zasady publikacji zdjęć | #14 | otwarta |
| D-19 | Głosowanie elektroniczne | #13 | otwarta |
| D-20 | Zgoda na produkcję na Railway | #31, #41, #42 | otwarta |
| D-21 | Aktualny regulamin i dostęp do dokumentów źródłowych | #13, #15 | otwarta |
| D-22 | Wersje językowe strony publicznej | #129 | otwarta |

## Dane osobowe

### D-01. Administrator danych

- Pytanie: kto jest administratorem danych uczniów i opiekunów przetwarzanych w panelu i kto w jego imieniu upoważnia osoby z Rady do dostępu?
- Dlaczego: od tego zależą upoważnienia, umowy z dostawcami, obowiązek informacyjny i odpowiedzialność za incydenty. Blokuje import (#2, #36) i produkcję (#41).
- Warianty w dokumentacji: nie wskazano. SECURITY.md i README wymagają ustalenia z dyrekcją i IOD. Polski status szkoły nie wyłącza RODO.
- Materiał techniczny: [`docs/PRIVACY_INVENTORY.md`](PRIVACY_INVENTORY.md) (spis kolumn z danymi osobowymi), [`docs/PROCESSORS.md`](PROCESSORS.md) (dostawcy), [`docs/DPIA_CHECKLIST.md`](DPIA_CHECKLIST.md) — projekty, nie rozstrzygnięcia (#123).
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-02. Podstawa i cele przetwarzania

- Pytanie: w jakich celach panel przetwarza dane (ewidencja dobrowolnych wpłat, kontakt z opiekunami, organizacja klas) i na jakiej podstawie; jaki zakres danych szkoła udostępnia Radzie?
- Dlaczego: cel wyznacza dopuszczalne pola (D-03), retencję (D-04) i treść informacji dla rodziców (D-06). Blokuje #2, #36.
- Warianty w dokumentacji: nie wskazano. Cele produktu opisuje PRODUCT.md; nie rozstrzyga podstawy prawnej.
- Materiał techniczny: pole „cel” w [`docs/PRIVACY_INVENTORY.md`](PRIVACY_INVENTORY.md) czeka na wartości z tej decyzji (#123).
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-03. Zakres importu i lista pól

- Pytanie: które pola i z jakiego źródła wolno importować? Czy import obejmuje wszystkie klasy od razu?
- Dlaczego: kryterium #1; parser z #2 i zapis z #36 przyjmą tylko zatwierdzone pola.
- Warianty w dokumentacji: projekt listy w sekcji „Proponowana lista pól” poniżej.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-04. Okresy retencji i usuwanie

- Pytanie: jak długo przechowujemy: dane ucznia i opiekuna po zakończeniu nauki, historię wpłat i księgę, dokumenty źródłowe, dziennik audytu, kampanie e-mail, kopie zapasowe oraz przesłany plik importu?
- Dlaczego: #2 i #36 wymagają usunięcia pliku źródłowego „zgodnie z retencją”; #8/#39 retencji dokumentów; #9 kopii i eksportu rocznego. Bez tej decyzji nie da się zaprojektować usuwania. #152 proponuje krótszą retencję jawnej referencji wpłaty (`payment_entries.reference`) niż księgi — sama kolumna/hash nie jest wdrożona, czeka na tę decyzję.
- Warianty w dokumentacji: nie wskazano okresów. Dokumenty Rady archiwizować zgodnie z regulaminem i decyzją szkoły (SECURITY.md).
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-05. Dostawcy, umowy powierzenia i lokalizacja

- Pytanie: czy administrator akceptuje Railway (aplikacja, PostgreSQL, Storage Bucket) i Brevo (e-mail) jako podmioty przetwarzające; kto zawiera i przechowuje umowy powierzenia; czy wymagany region UE jest wystarczający?
- Dlaczego: warunek produkcji (#31, #41) i wysyłki (#40). Ustawienie regionu nie zastępuje oceny prawnej ani umowy.
- Warianty w dokumentacji: RAILWAY_MIGRATION.md zakłada region UE (Amsterdam), weryfikowany osobno dla aplikacji, bazy i bucketu. EMAIL.md: przed produkcją sprawdzić regulamin Brevo i warunki przetwarzania danych.
- Materiał techniczny: [`docs/PROCESSORS.md`](PROCESSORS.md) (#123) — lista usług, region, odwołanie do DPA, status per dostawca; do weryfikacji i uzupełnienia przez IOD.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-06. Obowiązek informacyjny wobec rodziców

- Pytanie: kto, kiedy i jaką treścią informuje opiekunów o przetwarzaniu ich danych i danych dzieci w panelu?
- Dlaczego: wymagane przed importem (#2) i przed pierwszą wiadomością (#10).
- Warianty w dokumentacji: nie wskazano.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-07. Procedura incydentowa, sprostowanie i usuwanie danych

- Pytanie: kto przyjmuje zgłoszenie incydentu lub żądanie sprostowania/usunięcia, w jakim czasie i jak jest ono dokumentowane?
- Dlaczego: SECURITY.md wymaga procedury przed importem; odbiór produkcji (#41).
- Warianty w dokumentacji: nie wskazano.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

## Dostęp i konta

### D-08. Role i macierz kompetencji

- Pytanie: czy szkoła zatwierdza macierz dostępu z PRODUCT.md (zarząd, skarbnik, przedstawiciel klasy, Komisja Rewizyjna, dyrekcja, admin techniczny) i w jakim zakresie danych rodzin każda rola pracuje?
- Dlaczego: mechanizm autoryzacji (`requireAccess`/`isAuthorized*`, AUTHORIZATION.md) sam nie ustala, które role widzą które dane — to ustalają stałe ról wpisane na stałe w każdym module tras. Te stałe są dziś założeniem prototypu, nie zatwierdzoną kompetencją. Blokuje zamknięcie #4 i pełny zakres #35.
- Warianty w dokumentacji: projekt macierzy w PRODUCT.md, oznaczony „do zatwierdzenia”, z kolumną „stan prototypu w kodzie” (#163). Stałe założenie AGENTS.md: przedstawiciel klasy wyłącznie dla przypisanych klas.
- Założenia techniczne obecne w kodzie (do czasu decyzji; #163 — pełna lista, wcześniej wymienione było tylko #12/EVENTS.md poniżej):

  | Moduł | Role (stałe w kodzie) | Plik | Test |
  |---|---|---|---|
  | Rodziny | odczyt: `admin, board, treasurer, representative` (representative — własna klasa); edycja: `admin, board`; finanse/e-mail rodziny: `admin, board, treasurer` (e-mail widoczny bez względu na zgodę dla ostatniej trójki) | `src/pg/routes/families.js:32-35` | `tests/pg-families.test.js` |
  | Wpłaty | `admin, board, treasurer` | `src/pg/routes/payments.js:26` | `tests/pg-payments-api.test.js` |
  | Księga | `admin, board, treasurer` | `src/pg/routes/ledger.js:31` | `tests/pg-ledger-api.test.js` |
  | Kasa (przelewy, bilans otwarcia) | transfer/odczyt: `admin, board, treasurer`; otwarcie: `board` | `src/pg/routes/ledger-cash.js:34-36` | `tests/pg-ledger-cash.test.js` |
  | Korespondencja | edycja/kampanie: `board, treasurer`; zatwierdzenie: `board` | `src/pg/routes/email.js:35-36` | `tests/pg-email.test.js` |
  | Import uczniów | `admin, board` (bez `class_id`) | `src/pg/routes/import.js:28` | `tests/pg-import.test.js` |
  | Eksport roczny / archiwum | roczny: `admin, board`; archiwum kadencji: `board` | `src/pg/routes/exports.js:25,27` | `tests/pg-export-v2.test.js` |
  | Zamknięcie roku | odczyt/checklista: `board, treasurer`; zamknięcie: `board` | `src/pg/routes/year-close.js:35-37` | `tests/pg-year-close.test.js` |
  | Kartki (dowody wpłat) | `admin, board, treasurer` + `representative` (własna klasa) | `src/pg/routes/print.js:30-31` | `tests/pg-print.test.js` |
  | Uzgodnienia bankowe | zapis: `admin, board, treasurer`; raport: `audit, board, treasurer`; raport archiwum: `board, treasurer` | `src/pg/routes/reconciliation.js:31-34` | `tests/pg-reconciliation.test.js` |
  | Wydarzenia (#12) | tworzy: `admin, board` + `representative` (własna klasa); zatwierdza/publikuje: wyłącznie `board`, zasada czterech oczu | `src/pg/routes/events.js`, `docs/EVENTS.md` | `tests/pg-events.test.js` |

  Zarząd nie zatwierdził żadnego z powyższych wierszy — kod działa na tych
  założeniach wyłącznie dlatego, że trzeba było wybrać jakąś politykę, żeby
  moduły w ogóle działały na danych syntetycznych. Test `tests/pg-authz-matrix.test.js`
  sprawdza zgodność `tests/helpers/route-matrix.js` z `ROUTES`, ale nie
  porównuje stałych ról z tą tabelą — rozszerzenie do zrobienia osobno.
- Założenie techniczne do czasu decyzji (#152, PII_CHECK.md): publikacja publiczna protokołu z wykrytym imieniem/nazwiskiem, e-mailem lub IBAN jest dziś blokowana zawsze (`409`), bez wyjątku dla nazwiska członka Rady pełniącego funkcję — wariant zachowawczy, bo brak decyzji, czy takie nazwisko jest dopuszczalne w publicznym protokole. Nie jest to decyzja.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-09. Uprawnienia dyrekcji i Komisji Rewizyjnej

- Pytanie: czy i w jakim zakresie dyrekcja oraz Komisja Rewizyjna mają dostęp do wpłat, księgi, dokumentów i eksportu?
- Dlaczego: dostęp ról `principal` i `audit` do wpłat i księgi jest wyłączony do czasu decyzji (PAYMENTS.md, LEDGER.md). Dotyczy #4, #6, #7, #35.
- Warianty w dokumentacji: PRODUCT.md — Komisja Rewizyjna: odczyt wpłat, odczyt i eksport księgi, minimum danych rodzin; dyrekcja: domyślnie brak dostępu do wpłat, raport zbiorczy księgi.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-10. Dostawca logowania i przyjmowanie zaproszeń

- Pytanie: jakim sposobem użytkownicy logują się i przyjmują zaproszenia; kto może zapraszać; czy dostawca logowania jest kolejnym podmiotem przetwarzającym (D-05)?
- Dlaczego: bez tego nie ma drogi utworzenia sesji (AUTH.md). Blokuje #3 i częściowo #35.
- Warianty w dokumentacji: tylko wymagania — konta na zaproszenie, bez publicznej rejestracji, MFA dla dostępu finansowego. Dostawca niewskazany.
- Status: wskazanie użytkownika 2026-09-27: e-mail + hasło + TOTP (Google/Microsoft Authenticator); do formalnego potwierdzenia przez zarząd/IOD. To **nie** jest decyzja zarządu — prototyp (docs/AUTH.md) realizuje wskazany wariant, aby można go było ocenić na danych syntetycznych.
- Zakres wskazania: logowanie adresem e-mail i hasłem we własnym systemie (bez zewnętrznego dostawcy tożsamości, więc bez nowego podmiotu przetwarzającego z D-05), drugi składnik z aplikacji uwierzytelniającej zgodnej z TOTP (RFC 6238), konta wyłącznie z zaproszenia, reset hasła tylko przez administratora.
- Do potwierdzenia razem z metodą (założenia prototypu): polityka haseł (12–128 znaków, lista popularnych haseł, bez reguł składu), limity prób (5 na adres i 20 na IP w 15 min, blokada 15 min), role z obowiązkowym MFA (`MFA_REQUIRED_ROLES`, domyślnie admin, zarząd, skarbnik), ważność tokenu resetu (2 h, najwyżej 24 h), procedura odzyskania dostępu po utracie telefonu i kodów (reset MFA przez administratora — kto i na jakiej podstawie potwierdza tożsamość), kto może zapraszać do których ról, retencja skrótów haseł i dziennika logowań (D-04).
- Poza zakresem do czasu D-16/D-17: reset hasła i zaproszenia wysyłane e-mailem.
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

## Składki i finanse

### D-11. Jednostka ewidencji składki i opieka dzielona

- Pytanie: czy dobrowolną składkę ewidencjonujemy na rodzinę (gospodarstwo), czy na dziecko? Jak traktujemy rodzeństwo i dziecko, którego opiekunowie mieszkają w różnych gospodarstwach?
- Dlaczego: `household_id` ucznia nie może samoczynnie wyznaczać adresata ani wysokości składki (DATA_MODEL.md). Blokuje #5, #6 oraz dobór adresatów w #10 i #11.
- Warianty w dokumentacji: rodzina albo dziecko (ROADMAP.md). Model danych obsługuje kilku opiekunów, rodzeństwo i opiekunów z różnych gospodarstw.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-12. Zasady korekt wpłat i ich zatwierdzania

- Pytanie: kto może zapisać korektę wpłaty, czy wymaga ona drugiej osoby i jakie powody są dopuszczalne?
- Dlaczego: warunek produkcyjnego użycia ewidencji (PAYMENTS.md, #6, #37).
- Warianty w dokumentacji: obecnie technicznie role `admin`, `board`, `treasurer` z MFA; korekta jest osobnym zapisem. Zasad zatwierdzania nie ustalono.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-13. Rachunek bankowy, gotówka i uzgadnianie

- Pytanie: na jaki rachunek przyjmowane są wpłaty w danym roku, kto go prowadzi, jak rejestrujemy gotówkę i kto oraz jak często uzgadnia księgę z wyciągiem?
- Dlaczego: dane do wpłaty w wiadomościach pochodzą z konfiguracji zatwierdzonej na rok (EMAIL.md). Blokuje uzgadnianie w #7 i treść w #10.
- Warianty w dokumentacji: przelew i gotówka jako metody (ROADMAP.md, #6). Sposób uzgadniania niewskazany.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-14. Sugerowana składka na rok

- Pytanie: jaka kwota sugerowana obowiązuje w danym roku szkolnym i czy istnieją wyjątki?
- Dlaczego: pojawia się w treści wiadomości i kartek (#10, #11). Nie tworzy należności ani statusu „dłużnik”.
- Warianty w dokumentacji: ustawiana na rok, nie nadpisuje kwot faktycznych (PRODUCT.md). Wysokość niewskazana.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-15. Zatwierdzanie wydatków powyżej 3000 EUR

- Pytanie: jaki jest format referencji uchwały i proces zatwierdzenia wydatku powyżej 3000 EUR?
- Dlaczego: model wymaga tekstowej referencji, ale nie rozstrzyga jej formatu ani procesu (LEDGER.md, #7, #38).
- Warianty w dokumentacji: próg według dostarczonego regulaminu; wydatek dokładnie 3000 EUR nie wymaga referencji.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

## Korespondencja

### D-16. Szablon wiadomości i kartki

- Pytanie: jaką treść przypomnienia e-mail i kartki do zeszytu zatwierdza Rada i kto zatwierdza każdą kampanię?
- Dlaczego: bez zatwierdzonego szablonu nie ma wysyłki ani wydruku (#10, #11, #40).
- Warianty w dokumentacji: EMAIL.md — treść neutralna, bez słowa „dług”, bez nazwiska dziecka w temacie, zatwierdzone dane do wpłaty, kontakt i zdanie o pominięciu wiadomości po wpłacie.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-17. Adres nadawcy i adresaci wysyłki

- Pytanie: z jakiej domeny i adresu wysyłamy; kto zarządza kontem Brevo; czy wiadomość trafia do jednego, czy do wszystkich opiekunów dziecka?
- Dlaczego: konfiguracja SPF/DKIM/DMARC i liczba adresatów zależą od tej decyzji (EMAIL.md, #10, #40).
- Warianty w dokumentacji: jeden lub obaj opiekunowie (EMAIL.md). Osobny adres nadawcy na zweryfikowanej domenie. Limit Brevo Free 300 wiadomości na dobę dla całego konta.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

## Publikacja i zebrania

### D-18. Zasady publikacji zdjęć

- Pytanie: które zdjęcia wolno publikować na stronie Rady, kto sprawdza prawa autorskie i zgody na wizerunek dzieci oraz gdzie są zapisywane?
- Dlaczego: blokuje galerię i sekcję archiwalną (#14).
- Warianty w dokumentacji: SECURITY.md i DESIGN.md — dla każdego zdjęcia autor, źródło, data i prawo do publikacji; publiczna dostępność na stronie szkoły nie daje prawa do kopiowania; bez zbliżeń rozpoznawalnych dzieci bez potwierdzenia zgód.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-19. Głosowanie elektroniczne

- Pytanie: czy regulamin Rady dopuszcza głosowanie elektroniczne, a jeśli tak, w jakich sprawach i z jakim sposobem ustalania quorum?
- Dlaczego: #13 zabrania implementacji bez osobnej analizy zgodności z regulaminem.
- Warianty w dokumentacji: nie wskazano.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

## Uruchomienie i dokumenty źródłowe

### D-20. Zgoda na produkcję na Railway

- Pytanie: kto i na podstawie jakiego odbioru zgadza się na produkcyjne uruchomienie panelu, import danych rodzin i usunięcie starego stosu?
- Dlaczego: kryterium końcowe #31; #41 nie przewiduje deployu bez decyzji szkoły/IOD; #42 zależy od odbioru. Wybór Railway z 27.09.2026 jest decyzją techniczną, nie zgodą na produkcję.
- Warianty w dokumentacji: warunki odbioru w RAILWAY_MIGRATION.md (CI, testy ról i MFA, backup i próbne odtworzenie, plan cutover i rollbacku, limity kosztów, monitoring). Wymaga wcześniejszego zamknięcia D-01–D-07.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-21. Aktualny regulamin i dostęp do dokumentów źródłowych

- Pytanie: która wersja regulaminu Rady i programu jest obowiązująca oraz kto może mieć do nich dostęp w panelu lub repozytorium?
- Dlaczego: README zabrania umieszczania tych dokumentów w repo bez decyzji. Dotyczy #13 i #15.
- Warianty w dokumentacji: nie wskazano.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-22. Wersje językowe strony publicznej

- Pytanie: czy strona publiczna Rady ma mieć wersje językowe poza polską (np. FR/NL/EN dla opiekunów, którzy nie czytają po polsku, pracowników szkoły goszczącej lub sponsorów wydarzeń w Brukseli), w jakich językach, i kto tłumaczy oraz zatwierdza tłumaczenie każdego wpisu?
- Dlaczego: blokuje #129. Bez tej decyzji nie wdrażamy warstwy i18n ani tłumaczenia treści — polska wersja pozostaje jedyną. Ta pozycja jest wprost proponowana w treści #129 („Nowa decyzja zarządu... Bez niej nie implementować”), nie założeniem zespołu technicznego.
- Warianty w dokumentacji: propozycja z #129 — tłumaczenie wiązane z konkretną opublikowaną wersją polską (numer wersji), przechodzące to samo „cztery oczy” co treść polska (autor tłumaczenia ≠ zatwierdzający), automatyczne ukrycie tłumaczenia po zmianie wersji polskiej do czasu ponownego zatwierdzenia, polska wersja pozostaje nadrzędna i wiążąca. Bez tłumaczenia maszynowego publikowanego automatycznie.
- Do ustalenia razem z decyzją: które języki (FR/NL/EN czy inny zestaw), kto ma uprawnienia tłumacza i zatwierdzającego (czy to musi być zarząd, czy może być osoba spoza zarządu ze znajomością języka), czy dotyczy też wydarzeń (tytuł/opis/miejsce) czy tylko aktualności w pierwszym etapie, i czy podpisy licencji/zgód pod zdjęciami (#96, #106) pozostają wyłącznie po polsku.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

## Proponowana lista pól dopuszczonych do importu (projekt do zatwierdzenia)

**Projekt, nie decyzja.** Lista powtarza wyłącznie pola nazwane w #2, DATA_MODEL.md i SECURITY.md. Obowiązuje dopiero po przyjęciu D-03 wraz z D-02. Szkoła może ją zawęzić.

| Pole | Uwagi z dokumentacji | Decyzja |
|---|---|---|
| Uczeń — imię | wymagane do identyfikacji w klasie | do zatwierdzenia |
| Uczeń — nazwisko | nie służy do automatycznego łączenia rodzin | do zatwierdzenia |
| Klasa | jedna klasa na ucznia w danym roku | do zatwierdzenia |
| Rok szkolny | przypisanie klasy z historią lat | do zatwierdzenia |
| Identyfikator źródłowy ucznia | jeśli dostępny w systemie szkoły | do zatwierdzenia |
| Opiekun — imię | kilku opiekunów na dziecko | do zatwierdzenia |
| Opiekun — nazwisko | | do zatwierdzenia |
| Opiekun — e-mail | tylko niezbędny kontakt; nie jest identyfikatorem ucznia ani rodziny | do zatwierdzenia |
| Powiązanie rodzeństwa | opcjonalne | do zatwierdzenia |

Wyłączone z importu według #2 i SECURITY.md: PESEL, dane o zdrowiu, oceny, adresy zamieszkania i inne adresy niepotrzebne do celu. Kolumny spoza zatwierdzonej listy importer powinien pomijać i wykazywać w raporcie.

Do rozstrzygnięcia w D-03: czy import obejmuje zgodę na kontakt i wskazanie kontaktu głównego (pola relacji uczeń–opiekun w DATA_MODEL.md), czy są one ustalane później przez uprawnioną osobę.
