# Rejestr decyzji zarządu i szkoły

Ten dokument zbiera decyzje organizacyjne i prawne, których zespół techniczny nie podejmuje. Wypełniają go zarząd Rady, dyrekcja szkoły i IOD. Opisane warianty pochodzą wyłącznie z istniejącej dokumentacji i issues; nie są rekomendacją prawną. Brak wpisu oznacza, że decyzja nie zapadła.

Do czasu zamknięcia decyzji D-01–D-06 nie importujemy danych rodzin. Prace na danych syntetycznych mogą trwać równolegle (#1).

Stan na 27.09.2026 (uzupełnione 29.09.2026 o pytania zebrane 28–29.09): żadna decyzja nie zapadła; wszystkie pozycje poniżej są otwarte. Portal jest prototypem przygotowywanym przez jednego rodzica do przedstawienia zarządowi. Poprzednia wersja (Cloudflare Worker/D1) nigdy nie była wdrożona ani nie zawierała danych szkoły — zob. [RAILWAY_MIGRATION.md](RAILWAY_MIGRATION.md#stan-wyjściowy-fakt-nie-decyzja). Założenia przyjęte w kodzie do czasu decyzji są opisane w PR i issues jako warianty tymczasowe, nie jako decyzje.

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
| D-04 | Okresy retencji i usuwanie | #1, #2, #8, #9, #36, #39 | otwarta — wskazanie użytkownika 2026-10-02 (zob. „Wskazania użytkownika 2026-10-02”); do formalnego potwierdzenia |
| D-05 | Dostawcy, umowy powierzenia, lokalizacja | #1, #31, #40, #41 | otwarta |
| D-06 | Obowiązek informacyjny wobec rodziców | #1, #2, #10 | otwarta |
| D-07 | Procedura incydentowa, sprostowanie i usuwanie danych | #1, #41 | otwarta — wskazanie użytkownika 2026-10-02 (zob. „Wskazania użytkownika 2026-10-02”); do formalnego potwierdzenia |
| D-08 | Role i macierz kompetencji | #4, #35 | otwarta |
| D-09 | Uprawnienia dyrekcji i Komisji Rewizyjnej | #4, #6, #7, #35 | otwarta — wskazanie użytkownika 2026-10-02 (zob. „Wskazania użytkownika 2026-10-02”); do formalnego potwierdzenia |
| D-10 | Dostawca logowania i przyjmowanie zaproszeń | #3, #35 | otwarta — wskazanie użytkownika 2026-09-27: e-mail + hasło + TOTP; do formalnego potwierdzenia; 2026-10-02: lista słabych haseł offline |
| D-11 | Jednostka ewidencji składki i opieka dzielona | #5, #6, #10, #11 | otwarta |
| D-12 | Zasady korekt wpłat i ich zatwierdzania | #6, #37 | otwarta |
| D-13 | Rachunek bankowy, gotówka i uzgadnianie | #6, #7, #10 | otwarta |
| D-14 | Sugerowana składka na rok | #6, #10, #11 | otwarta |
| D-15 | Zatwierdzanie wydatków powyżej 3000 EUR | #7, #38 | otwarta |
| D-16 | Szablon wiadomości i kartki | #10, #11, #40 | otwarta — wskazanie użytkownika 2026-10-02 (zob. „Wskazania użytkownika 2026-10-02”); do formalnego potwierdzenia |
| D-17 | Adres nadawcy i adresaci wysyłki | #10, #40 | otwarta — wskazanie użytkownika 2026-10-02 (zob. „Wskazania użytkownika 2026-10-02”); do formalnego potwierdzenia |
| D-18 | Zasady publikacji zdjęć | #14 | otwarta |
| D-19 | Głosowanie elektroniczne | #13 | otwarta |
| D-20 | Zgoda na produkcję na Railway | #31, #41, #42 | otwarta |
| D-21 | Aktualny regulamin i dostęp do dokumentów źródłowych | #13, #15 | otwarta — wskazanie użytkownika 2026-10-02 (zob. „Wskazania użytkownika 2026-10-02”); do formalnego potwierdzenia |
| D-22 | Wersje językowe strony publicznej | #129 | otwarta |
| D-23 | Nazwa szkoły i format roku szkolnego | wydruki, strona publiczna | otwarta |

## Wskazania użytkownika 2026-10-02

Wskazania właściciela prototypu, przekazane w sesji roboczej 02.10.2026. To **nie** są decyzje zarządu ani IOD: prototyp realizuje wskazane warianty, aby można je było ocenić na danych syntetycznych. Każde wymaga formalnego potwierdzenia (data, organ, uchwała) w sekcji danej decyzji.

| Temat | Decyzja w rejestrze | Wskazany wariant | Skutek w prototypie |
|---|---|---|---|
| Strefa czasowa dat dziennych | — (nowe, techniczne) | `Europe/Brussels` | Daty dzienne liczone z czasu (np. ostatnie logowanie przedstawiciela, daty w raportach) w strefie szkoły, nie w strefie sesji bazy. |
| Podgląd PDF w panelu dokumentów | D-05 (bez nowego podmiotu — biblioteka dołączona lokalnie) | PDF.js dołączony do repozytorium (bez CDN) | PDF z `disposition=inline` → 400; podgląd renderowany przez PDF.js w izolacji. |
| Pominięcie rodziny z ograniczeniem przetwarzania na kartkach | D-07 | Pokazywać wszystkim drukującym | Wydruk pokazuje „pominięto N rodzin” bez nazw; przedstawiciel klasy dowiaduje się o fakcie ograniczenia. |
| Lista słabych haseł | D-10 | Lista offline w repozytorium (~10 000 wpisów, suma SHA-256) | Bez zapytań do usług zewnętrznych. |
| Zakres roli `audit` (Komisja Rewizyjna) | D-09 | Wariant (b): odczyt i eksport księgi oraz dokumentów finansowych roku | Bez danych rodzin ponad sumy, bez zapisu; za flagą konfiguracji. |
| Retencja dziennika odczytów i historii sprostowań | D-04 | Bez automatycznego usuwania (stan obecny) | Usunięcie wyłącznie przez anonimizację rodziny. |
| Wiadomości poza kampaniami rodzin | D-16, D-17 | Szkice do zatwierdzenia | Kod generuje treść z szablonu opisanego w dokumentacji; wysyłka wymaga jawnego zatwierdzenia; nadawca wyłącznie z konfiguracji, bez domyślnego adresu. |
| Zaproszeni na zebranie zarządu | D-21 | Zarząd, przedstawiciele klas, Komisja Rewizyjna i dyrekcja | Dyrekcja wymaga nowej roli/kont (dziś nie istnieje) — zakres D-08/D-09. |
| Rola „dyrekcja” | D-08, D-09 | Zebrania + raporty zbiorcze | Nowa rola z kontem: zawiadomienia i odczyt zebrań, porządku, protokołów i uchwał oraz raport roczny i zestawienia zbiorcze (sumy); bez księgi szczegółowej, wpłat i danych rodzin. |
| Lista obecności w szczegółach zebrania dla dyrekcji | D-09 | Jak dla Komisji Rewizyjnej | Dyrekcja widzi pseudonimowe identyfikatory uczestników (bez imion i e-maili) i powiązania kampanii, tak jak `audit`; ocena IOD. |
| Zakres roku przydziału dyrekcji | D-08, D-09 | Wymusić rok szkolny | Przydział i zaproszenie `principal` bez roku → `422 school_year_required`; dostęp wygasa z kadencją. |
| Skarbnik wśród zaproszonych na zebranie zarządu | D-21 | Zapraszać skarbnika (`treasurer`); admin techniczny — nie | Kampania `meeting_invitees` obejmuje konta z aktywnym przydziałem `treasurer` w roku (migawka i ponowne sprawdzenie w workerze); konto zarząd + skarbnik = jedna wiadomość. |
| Zarząd z przydziałem klasowym a zaproszenie na zebranie zarządu | D-21, D-08 | Zapraszać jak przedstawiciela | Przydział `board` z klasą w roku zebrania daje zaproszenie (jak przedstawiciel); nie daje prawa do tworzenia zawiadomienia ani do panelu zebrania zarządu. |
| Zawiadomienie nieaktualne po zakolejkowaniu kampanii | D-21, D-08 | Wstrzymać wysyłkę | Zmiana porządku, terminu lub nowa wersja zawiadomienia po zakolejkowaniu: worker pomija kampanię (`meeting_notice_outdated`, wiersze zostają w kolejce), bez automatycznego anulowania; zarząd anuluje i przygotowuje nową kampanię. |
| Weryfikacja nowego adresu e-mail z wniosku rodzica (#140 pkt 5) | D-16, D-17, D-07 | Opcjonalna z ostrzeżeniem | Zarząd może zatwierdzić wniosek z niepotwierdzonym adresem; kolejka wniosków (API i panel `families/`) pokazuje stan `verification` (none, sent, confirmed, expired, failed) z powodem, a zatwierdzenie bez potwierdzenia zapisuje w audycie pole `unverifiedContactChange` (bez adresu). |
| Moment wysłania kodu weryfikacyjnego (#140 pkt 5) | D-16, D-17 | Automatycznie po złożeniu wniosku z nowym e-mailem | Bez kliknięcia zarządu przy każdym wniosku, ale tylko z szablonem treści zatwierdzonym raz przez zarząd (inna osoba niż autor, świeże MFA), za flagą `GUARDIAN_VERIFY_EMAIL_ENABLED` (domyślnie wyłączona), wyłącznie na adres z tego wniosku, jedna wiadomość na wniosek (`verify:{requestId}`), przez kolejkę i worker w limicie Brevo; nadawca wyłącznie z `BREVO_FROM_EMAIL`. Migracja 0184, notatka techniczna w D-16. |

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
- Notatka techniczna (01.10.2026): od migracji 0174 istnieje mechanizm anonimizacji gospodarstwa z zachowaniem księgi i sum wpłat (`POST /api/admin/anonymizations`, [`docs/RETENTION.md`](RETENTION.md)) — uruchamiany wyłącznie ręcznie przez administratora (MFA, podgląd i zatwierdzenie planu), bez zadania okresowego. Tryb „z polityki” odmawia (`retention_policy_missing`), dopóki D-04 nie wpisze zatwierdzonych okresów; tryb „żądanie osoby” (D-07) działa bez polityk. To opis stanu kodu, nie decyzja: okresów, zakresu, kto zatwierdza przebieg (D-01) ani uznania anonimizacji za realizację usunięcia (IOD) kod nie rozstrzyga.
- Notatka techniczna (28.09.2026): w PR #386 (scalony, dokańcza #207 część 2) przyjęto wariant zachowawczy — błąd adresu e-mail jednego opiekuna nie odrzuca już całego wiersza importu, tylko degraduje się do ostrzeżenia „popraw i wczytaj ponownie”; uczeń i ten opiekun trafiają do bazy z `email = NULL`. Odrzucany jest wyłącznie wiersz bez wymaganych pól ucznia/klasy. Skutek: przy niepełnych danych kontaktowych uczeń mimo to trafia do bazy zamiast być pominięty — zasady odrzucania wierszy importu pozostają decyzją zarządu (ta decyzja).
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-04. Okresy retencji i usuwanie

- Pytanie: jak długo przechowujemy: dane ucznia i opiekuna po zakończeniu nauki, historię wpłat i księgę, dokumenty źródłowe, dziennik audytu, kampanie e-mail, kopie zapasowe oraz przesłany plik importu?
- Dlaczego: #2 i #36 wymagają usunięcia pliku źródłowego „zgodnie z retencją”; #8/#39 retencji dokumentów; #9 kopii i eksportu rocznego. Bez tej decyzji nie da się zaprojektować usuwania. #152 proponuje krótszą retencję jawnej referencji wpłaty (`payment_entries.reference`) niż księgi — sama kolumna/hash nie jest wdrożona, czeka na tę decyzję.
- Warianty w dokumentacji: nie wskazano okresów. Dokumenty Rady archiwizować zgodnie z regulaminem i decyzją szkoły (SECURITY.md).
- Mechanizm techniczny (bez wartości): [`docs/RETENTION.md`](RETENTION.md) — rejestr `retention_policies` (#91, migracja 0074), raport kandydatów `GET /api/admin/retention/preview` (wyłącznie liczby). Kod nie zawiera żadnego okresu domyślnego ani automatycznego mechanizmu wykonującego retencję (ręczna anonimizacja — notatka z 01.10.2026 niżej): na `main` (stan 30.09.2026) nic nie usuwa ani nie anonimizuje danych rodzin, dokumentów, dziennika czy kampanii po upływie okresu przechowywania (usuwane są tylko dane techniczne, np. liczniki prób logowania/MFA, i migawka odbiorców kampanii cofniętej do szkicu przed wysyłką) — brak wiersza polityki znaczy „nie usuwaj”, a wpis w rejestrze sam niczego nie usuwa.
- Notatka techniczna (28.09.2026): kilka PR (wszystkie scalone do `main`) wyłączyło zachowawczo nowe tabele z paczki eksportu rocznego (`EXPORT_EXCLUDED_TABLES`, `docs/EXPORT.md`) do czasu tej decyzji — dane nie znikają, tylko nie trafiają do paczki, więc nowa Rada/Komisja Rewizyjna ich stamtąd nie odtworzy: zatwierdzone dane do wpłaty `payment_instructions` w PR #341/#377 (scalone do `main`, #92 — patrz też D-08 niżej, rewizja roli zatwierdzającej), belgijskie referencje płatności OGM-VCS `payment_references`/`payment_reference_revocations` w PR #345 (scalony, #83), wycofania zgód na wizerunek `news_photo_consent_withdrawals` w PR #337 (scalony, #106), pliki wariantów zdjęć `news_photo_files` w PR #351 (scalony, #96), jednorazowy link i wniosek o aktualizację kontaktu opiekuna `guardian_update_links`/`guardian_update_requests` w PR #365 (scalony, #140), rozstrzygnięcia doręczeń kampanii e-mail `email_outbox_resolutions` w PR #309 (scalony, #139).
- Notatka techniczna (30.09.2026): eksport — wariant zachowawczy faktycznie wdrożony w kodzie (opis stanu, nie decyzja):
  - Paczka roczna (`POST /api/exports`) nie jest przechowywana przez serwer. Od #216 powstaje w buforze tymczasowym na dysku kontenera (`src/pg/export-spool.js`): anonimowy plik w katalogu z `mkdtemp` (0700, plik 0600), którego nazwa jest usuwana zaraz po otwarciu, więc dane istnieją tylko pod otwartym uchwytem. Uchwyt zamyka koniec pobierania, przerwanie przez klienta, błąd budowy (także `409` i wycofanie transakcji) albo 5 minut bez odczytu (`SPOOL_IDLE_MS`); po zamknięciu nic nie zostaje pod żadną nazwą, także gdy proces zostanie zabity. Bufor nie ma więc okresu retencji do ustalenia; ryzyko resztkowe (bloki dysku nie są nadpisywane zerami) opisuje [`docs/EXPORT.md`](EXPORT.md) — „Ryzyka i ograniczenia”.
  - Lista klasy (`GET /api/exports/class-roster`) i eksport danych jednej rodziny dla żądania osoby (#100, [`docs/DATA_REQUESTS.md`](DATA_REQUESTS.md)) są budowane w pamięci procesu i wydawane w odpowiedzi; serwer ich nie zapisuje.
  - Trwały ślad eksportu to wyłącznie metadane: dla paczki rocznej i listy klasy wiersz `export_runs` (rok, klasa listy, wersja formatu, kto i kiedy, SHA-256 manifestu, liczności tabel — bez treści paczki; niezmienny od migracji 0016, nieusuwany), zdarzenie audytu `export.created` i wpis `data_access_log`; dla eksportu rodziny wpisy `data_access_log` i zdarzenie `data_subject_request.exported` (`docs/SECURITY.md`). Kategoria `export_package` w raporcie retencji liczy wiersze `export_runs`, nie paczki.
  - Czas przechowywania pobranych paczek i list poza systemem (u osoby, która je pobrała), liczba kopii i miejsce ich przechowywania nie są objęte kodem — czekają na tę decyzję i D-01 (`docs/EXPORT.md`, „Zasady przechowywania”). Do czasu decyzji: eksport wyłącznie na danych syntetycznych i stagingu.
  - Lista tabel wyłączonych z paczki z notatki z 28.09 nie jest już pełna (np. później doszły `email_outbox_resolution_approvals`, 0156, #139, i kolumna `bank_statement_lines.structured_ref_hash` poza paczką, 0158, #83). Źródłem prawdy jest `EXPORT_EXCLUDED_TABLES` w `src/pg/export.js` z uzasadnieniem każdej pozycji, opisane w `docs/EXPORT.md` (pilnuje tego `tests/pg-export-v2.test.js`).
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
- Mechanizm techniczny (bez treści): [`docs/PRIVACY_NOTICE.md`](PRIVACY_NOTICE.md) — wersjonowany rejestr `privacy_notices` (#145), bramka `409 privacy_notice_missing` na commit importu, publiczna trasa `GET /api/public/privacy-notice`. Bramki dla kampanii e-mail i wydruku kartek są świadomie poza zakresem #145 w obecnym PR (kolizja z równoległymi PR-ami na `src/pg/routes/email.js`/`print/core.js`) — patrz dokument.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-07. Procedura incydentowa, sprostowanie i usuwanie danych

- Pytanie: kto przyjmuje zgłoszenie incydentu lub żądanie sprostowania/usunięcia, w jakim czasie i jak jest ono dokumentowane?
- Dlaczego: SECURITY.md wymaga procedury przed importem; odbiór produkcji (#41).
- Warianty w dokumentacji: nie wskazano.
- Notatka techniczna (29.09.2026): rejestr żądań osób (#323, scalony) obsługuje dziś wyłącznie zapis i przebieg żądania; NIE generuje eksportu danych rodziny, nie wykonuje sprostowania ani ograniczenia przetwarzania. Wariant zachowawczy: te czynności wykonuje ręcznie uprawniona osoba poza rejestrem, a rejestr tylko dokumentuje termin i wynik. Pytania do zarządu/IOD: kto realizuje żądanie dostępu (eksport danych rodziny), sprostowania i ograniczenia przetwarzania; w jakim formacie i kanale przekazujemy wynik osobie; czy rejestr ma to wspierać technicznie. Rekomendacja koordynatora (nie rozstrzygnięcie): najpierw przyjąć procedurę i osobę odpowiedzialną, dopiero potem rozbudowywać mechanizm.
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
  | Rodziny | odczyt: `admin, board, treasurer, representative` (representative — własna klasa); edycja: `admin, board`; finanse/e-mail rodziny: `admin, board, treasurer` (e-mail widoczny bez względu na zgodę dla ostatniej trójki) | `src/pg/routes/families.js` (`READ_ROLES`, `EDIT_ROLES`, `FINANCIAL_ROLES`) i `src/pg/scope.js` (`HOUSEHOLD_WIDE_ROLES`) | `tests/pg-families.test.js` |
  | Wpłaty | `admin, board, treasurer` | `src/pg/routes/payments.js` (`FINANCIAL_ROLES`) | `tests/pg-payments-api.test.js` |
  | Księga | `admin, board, treasurer` | `src/pg/routes/ledger.js` (`FINANCIAL_ROLES`) | `tests/pg-ledger-api.test.js` |
  | Kasa (przelewy, bilans otwarcia) | transfer/odczyt: `admin, board, treasurer`; otwarcie: `board` | `src/pg/routes/ledger-cash.js` (`TRANSFER_ROLES`, `READ_ROLES`, `OPENING_ROLES`) | `tests/pg-ledger-cash.test.js` |
  | Korespondencja | edycja/kampanie: `board, treasurer`; zatwierdzenie: `board` | `src/pg/routes/email.js` (`EDITOR_ROLES`, `APPROVER_ROLES`) | `tests/pg-email.test.js` |
  | Import uczniów | `admin, board` (bez `class_id`) | `src/pg/routes/import.js` (`IMPORT_ROLES`) | `tests/pg-import.test.js` |
  | Eksport roczny / archiwum | roczny: `admin, board`; archiwum kadencji: `board` | `src/pg/routes/exports.js` (`YEARLY_EXPORT_ROLES`, `ARCHIVE_EXPORT_ROLES`) | `tests/pg-export-v2.test.js` |
  | Zamknięcie roku | odczyt/checklista: `board, treasurer`; zamknięcie: `board` | `src/pg/routes/year-close.js` (`READ_ROLES`, `CHECKLIST_ROLES`, `CLOSE_ROLES`) | `tests/pg-year-close.test.js` |
  | Kartki (dowody wpłat) | `admin, board, treasurer` + `representative` (własna klasa) | `src/pg/routes/print.js` (`FINANCIAL_ROLES`, `PRINT_ROLES`) | `tests/pg-print.test.js` |
  | Centra kosztów (#117) | `admin, board, treasurer`; przedstawiciel, `audit`, `principal` — brak dostępu | `src/pg/routes/ledger-cost-centers.js` (`FINANCIAL_ROLES`) | `tests/pg-ledger-cost-centers.test.js` |
  | Sprawozdanie roczne i przepływy (#125) | `board, treasurer`; `admin`, `audit`, `principal`, przedstawiciel — brak dostępu | `src/pg/routes/financial-reports.js` (`REPORT_ROLES`) | `tests/pg-annual-report.test.js` |
  | Uzgodnienia bankowe | zapis: `admin, board, treasurer`; raport: `audit, board, treasurer`; raport archiwum: `board, treasurer` | `src/pg/routes/reconciliation.js` (`WRITE_ROLES`, `REPORT_ROLES`, `ARCHIVE_REPORT_ROLES`) | `tests/pg-reconciliation.test.js` |
  | Wydarzenia (#12) | tworzy: `admin, board` + `representative` (własna klasa); zatwierdza/publikuje: wyłącznie `board`, zasada czterech oczu | `src/pg/routes/events.js`, `docs/EVENTS.md` | `tests/pg-events.test.js` |

  Zarząd nie zatwierdził żadnego z powyższych wierszy — kod działa na tych
  założeniach wyłącznie dlatego, że trzeba było wybrać jakąś politykę, żeby
  moduły w ogóle działały na danych syntetycznych. Test `tests/pg-authz-matrix.test.js`
  sprawdza zgodność `tests/helpers/route-matrix.js` z `ROUTES`, ale nie
  porównuje stałych ról z tą tabelą — rozszerzenie do zrobienia osobno.
- Notatka techniczna (28.09.2026): dwa dalsze PR (#341/#377 i #329, wszystkie scalone do `main`) przyjęły warianty zachowawcze w modułach spoza tabeli wyżej. PR #341/#377 (#92, scalone do `main`) ograniczyły zatwierdzanie zatwierdzonych danych do wpłaty (`POST /api/payment-instructions`, IBAN/BIC do kodu QR na kartkach) do ról `admin`/`board`, świadomie bez skarbnika, do czasu tej decyzji; odczyt pozostaje `admin`/`board`/`treasurer` z MFA. PR #329 (#82, scalony) dodał unieważnienie/zastąpienie dokumentu (`POST /api/documents/:id/supersede`, `/void`) z tymi samymi regułami dostępu co odczyt danego dokumentu (`canAccessDocument`) — dla dokumentu finansowego oznacza to, że skarbnik z MFA może unieważnić lub zastąpić dokument finansowy, mimo że moduł dokumentów w ogóle nie był dotąd ujęty w tabeli wyżej. Skutek: zakres ról dla obu modułów (dane do wpłaty, unieważnianie/zastępowanie dokumentów) czeka na potwierdzenie w tej decyzji.
- Założenie techniczne do czasu decyzji (#152, PII_CHECK.md): publikacja publiczna protokołu z wykrytym imieniem/nazwiskiem, e-mailem lub IBAN jest dziś blokowana zawsze (`409`), bez wyjątku dla nazwiska członka Rady pełniącego funkcję — wariant zachowawczy, bo brak decyzji, czy takie nazwisko jest dopuszczalne w publicznym protokole. Nie jest to decyzja.
- Notatka techniczna (29.09.2026), zakres roli `admin` (#474, #163): kod daje administratorowi technicznemu odczyt i edycję rodzin oraz zapis wpłat i księgi (stała `admin, board, treasurer` w tabeli wyżej). Pytanie: czy rozdzielić rolę techniczną od finansowej, tak by `admin` nie miał dostępu do danych rodzin i wpłat (a konta i role prowadził bez wglądu w dane finansowe)? Warianty: A) obecny stan (admin = pełny zakres roboczy); B) admin tylko konta, role i konfiguracja, bez rodzin, wpłat i księgi; C) B, a dostęp do danych na czas prac serwisowych nadawany doraźnie i wpisywany do dziennika. Obecny wariant w kodzie: A, opisany w dokumentacji jako stan faktyczny, niezatwierdzony. Rekomendacja koordynatora (nie rozstrzygnięcie): B lub C, zgodnie z zasadą najmniejszych uprawnień.
- Notatka techniczna (29.09.2026), zebrania (#369, #171): przedstawiciel klasy jako gospodarz zebrania klasowego też musi mieć MFA — bardziej restrykcyjnie niż pierwotny projekt #171. Po scaleniu z #102 ten sam blankietowy wymóg MFA obejmuje także zarządzanie zebraniami, w tym nową trasę `POST /api/meetings/resolutions/:id/execution` (wykonanie uchwały). Pytanie: czy MFA ma być wymagane od każdego gospodarza zebrania klasowego, czy tylko od ról finansowych i zarządu? Obecny wariant zachowawczy: MFA wszędzie. Skutek: rodzic-gospodarz musi mieć skonfigurowany TOTP. Rekomendacja koordynatora (nie rozstrzygnięcie): zostawić MFA dla zarządzania uchwałami i ich wykonaniem, a dla gospodarza klasowego ocenić po pierwszym zebraniu próbnym.
- Notatka techniczna (29.09.2026), dokumenty (#329): unieważnienie lub zastąpienie dokumentu wymaga tylko tego samego uprawnienia, co odczyt (patrz notatka z 28.09.2026 wyżej). Do potwierdzenia zakres: czy skarbnik z MFA może unieważniać dokumenty finansowe, czy tylko zarząd. Rekomendacja koordynatora (nie rozstrzygnięcie): unieważnianie tylko przez `board`, odczyt bez zmian.
- Pytanie z przeglądu demo (29.09.2026): w dzienniku kont i w historii wydarzenia autor zmiany jest pokazywany jako identyfikator (UUID), a typy obiektów i powody jako wartości techniczne. Czy rola, która widzi dziennik, ma widzieć nazwę konta autora (dane osobowe pracowników Rady), czy skrócony identyfikator? Wariant zachowawczy: identyfikator bez nazwy. Rekomendacja koordynatora (nie rozstrzygnięcie): nazwa konta tylko dla `board` i `audit`, dla pozostałych skrócony identyfikator.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-09. Uprawnienia dyrekcji i Komisji Rewizyjnej

- Pytanie: czy i w jakim zakresie dyrekcja oraz Komisja Rewizyjna mają dostęp do wpłat, księgi, dokumentów i eksportu?
- Dlaczego: dostęp ról `principal` i `audit` do wpłat i księgi jest wyłączony do czasu decyzji (PAYMENTS.md, LEDGER.md). Dotyczy #4, #6, #7, #35, #137 (ścieżka kontroli KR: uwagi, odpowiedzi skarbnika, protokół — zablokowana tą samą decyzją).
- Warianty w dokumentacji: PRODUCT.md — Komisja Rewizyjna: odczyt wpłat, odczyt i eksport księgi, minimum danych rodzin; dyrekcja: domyślnie brak dostępu do wpłat, raport zbiorczy księgi.
- Notatka techniczna (28.09.2026): PR #382 (#125, scalony) dodał `GET /api/reports/annual` (projekt sprawozdania rocznego) i `GET /api/reports/cash-flow` (przepływy bank/kasa per miesiąc) z dostępem wyłącznie dla `board`/`treasurer` z MFA w zakresie roku; role `admin`, `audit`, `principal` i przedstawiciel klasy dostają 403 — wariant zachowawczy wprost opisany w PR jako oczekujący na D-08 i tę decyzję. Skutek: Komisja Rewizyjna i dyrekcja nie widzą dziś przez ten endpoint nawet zagregowanego projektu sprawozdania (KR korzysta z osobnego `/api/reports/audit`).
- Notatka techniczna (02.10.2026, wskazanie właściciela, nie zatwierdzona macierz D-09): rola dyrekcji to istniejąca `principal` (bez nowej roli i bez migracji — CHECK w `role_grants`/`invitations` od 0001 ją zawiera). Przydział i zaproszenie wymagają roku szkolnego (`422 school_year_required`, wskazanie 2026-10-02). Zakres tylko odczyt: zebrania, porządek obrad, protokoły, uchwały i rejestr uchwał (jak `audit`, bez MFA), oraz `GET /api/reports/annual` i `GET /api/reports/cash-flow` (sumy, z MFA, przydział ogólnoszkolny w roku). Nadal 403: księga szczegółowa, wpłaty, dokumenty, dane rodzin, migawki sprawozdania, uzgodnienia, eksporty. Nadaje wyłącznie admin (nie sobie; audyt `role_grant.created`). Szkoła nadal zatwierdza zakres (D-09).
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

### D-10. Dostawca logowania i przyjmowanie zaproszeń

- Pytanie: jakim sposobem użytkownicy logują się i przyjmują zaproszenia; kto może zapraszać; czy dostawca logowania jest kolejnym podmiotem przetwarzającym (D-05)?
- Dlaczego: bez tego nie ma drogi utworzenia sesji (AUTH.md). Blokuje #3 i częściowo #35.
- Warianty w dokumentacji: tylko wymagania — konta na zaproszenie, bez publicznej rejestracji, MFA dla dostępu finansowego. Dostawca niewskazany.
- Założenia techniczne do potwierdzenia (29.09.2026; #369, #384): sesja wygasa po 30 minutach bezczynności (`SESSION_IDLE_TIMEOUT_SECONDS`), a „świeże MFA” dla operacji wrażliwych (zamknięcie roku, zatwierdzenie kampanii, reset hasła/MFA, nadanie roli) obowiązuje 15 minut od ostatniego potwierdzenia TOTP (`MFA_STEP_UP_MAX_AGE_SECONDS`). To wartości wybrane technicznie, bez uzgodnienia z zarządem. Warianty: obecne 30/15 min; krócej (np. 15/5 min) kosztem wygody skarbnika; dłużej (np. 60/30 min) kosztem bezpieczeństwa współdzielonego komputera. Rekomendacja koordynatora (nie rozstrzygnięcie): pozostawić 30/15 do czasu prób z zarządem.
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
- Pytanie z badania na danych syntetycznych (29.09.2026; D-09): przelew zbiorczy za kilka rodzin i raport Komisji Rewizyjnej. Wpłata podzielona między rodziny ma zawsze status „nieprzypisana” i nie da się jej ująć w księdze — wpis z powiązaniem kończy się błędem `400 invalid_payment_link`, bo księga wymaga wpłaty przypisanej. Przykład liczbowy: przelew zbiorczy 5000 + zwykła wpłata 3000 → raport KR pokazuje wpływy 3000, kontrola „wpłaty w księdze” jest zielona (obie strony pomijają nieprzypisane), a 5000 nie widać nigdzie w raporcie. Kartki klasowe liczą części podzielonej wpłaty poprawnie.
  - Warianty: A) dopuścić ujęcie w księdze wpłaty podzielonej (zmiana reguł księgi i migracja); B) raport KR wykazuje wpłaty nieprzypisane (liczba, kwota netto, w tym podzielone) tak jak przy zamknięciu roku; C) bez zmian, skarbnik opisuje różnicę w uzgodnieniu.
  - Obecny wariant w kodzie: C (nieprzypisane pomijane po obu stronach kontroli).
  - Rekomendacja koordynatora (nie rozstrzygnięcie): B niezależnie od A, dla przejrzystości wobec KR.
- Notatka techniczna (29.09.2026, #395): porzucenie szkicu uzgodnienia może wykonać sam autor szkicu, bez zasady czterech oczu obowiązującej przy zatwierdzeniu. Przyjęto tak, bo porzucenie niczego nie zatwierdza, a szkic pozostaje w dzienniku jako „porzucony” z powodem. Pytanie: czy porzucenie szkicu też ma wymagać drugiej osoby? Rekomendacja koordynatora (nie rozstrzygnięcie): zostawić bez drugiej osoby, z wpisem w dzienniku i widocznością w raporcie KR.
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
- Notatka techniczna (28.09.2026): PR #384 (#150 część 2, scalony) rozszerzył mechanizm „kroku w górę” (świeże MFA, `403 mfa_stale`, `MFA_STEP_UP_MAX_AGE_SECONDS` = 15 min) na zamknięcie roku, zatwierdzenie kampanii e-mail oraz reset hasła/MFA i nadanie roli — ale świadomie NIE objął nim przyjęcia uchwały powyżej 3000 EUR. PR wprost zostawia to poza zakresem, bo próg i sam wymóg wymagają zatwierdzenia zarządu (tej decyzji); mechanizm jest gotowy do wpięcia w `src/pg/meetings.js` (`createResolution`/`updateResolution` → `adopted`) w kolejnym PR po decyzji.
- Status: otwarta
- Data decyzji:
- Kto zatwierdził:
- Uchwała/dokument:

## Korespondencja

### D-16. Szablon wiadomości i kartki

- Pytanie: jaką treść przypomnienia e-mail i kartki do zeszytu zatwierdza Rada i kto zatwierdza każdą kampanię?
- Dlaczego: bez zatwierdzonego szablonu nie ma wysyłki ani wydruku (#10, #11, #40).
- Warianty w dokumentacji: EMAIL.md — treść neutralna, bez słowa „dług”, bez nazwiska dziecka w temacie, zatwierdzone dane do wpłaty, kontakt i zdanie o pominięciu wiadomości po wpłacie.
- Notatka techniczna (02.10.2026, #140 pkt 5, migracja `0184_guardian_update_verification.sql`; realizacja dwóch wskazań z tabeli „Wskazania użytkownika 2026-10-02” — weryfikacja opcjonalna z ostrzeżeniem i automatyczna wysyłka kodu — nie rozstrzygnięcie tej decyzji): kod weryfikacyjny na NOWY adres z wniosku rodzica o aktualizację kontaktu (docs/EMAIL.md, „Kod weryfikacyjny nowego adresu”). Pogodzenie z AGENTS.md („nie wysyłaj bez jawnego zatwierdzenia treści i listy odbiorców”) i ze wskazaniem „Szkice do zatwierdzenia”: treść zatwierdza zarząd raz jako wersjonowany szablon (`guardian_verify_templates`), a lista odbiorców jest stała z konstrukcji — jedna wiadomość na wniosek, wyłącznie na adres wpisany przez rodzica w tym wniosku; wyzwalaczem jest złożenie wniosku przez rodzica. Ta interpretacja wymaga potwierdzenia przez zarząd razem z D-16/D-17. Założenia wariantem zachowawczym (do potwierdzenia): (1) kod 8 cyfr, ważny 24 h od przejęcia do wysyłki, najwyżej 5 błędnych prób, w bazie wyłącznie skrót SHA-256 z solą wiersza (kod jawny tylko w pamięci workera i w wiadomości); (2) szkic szablonu — admin i zarząd bez przydziału klasowego; zatwierdzenie — wyłącznie zarząd (jak kampanie, nie admin), inna osoba niż autor, świeże MFA; obowiązuje najnowsza zatwierdzona wersja, zapamiętana we wniosku przy złożeniu; wycofanie szablonu bez nowej wersji = wyłączenie flagi; (3) bez opublikowanej informacji o przetwarzaniu danych (D-06) kod nie wychodzi, a wiadomość ma tę samą stopkę z wersją informacji co kampanie; bez stopki wypisania (wiadomość transakcyjna na prośbę rodzica, nie kategoria #110); (4) ograniczenie przetwarzania opiekuna lub jego gospodarstwa (#100) wstrzymuje kod (`none`, powód `processing_restricted`); adres na liście wyłączeń (#94, także globalne wypisanie) — `failed`/`address_suppressed`; wypisanie z kategorii kampanii (#110) kodu nie blokuje; (5) odpowiedź publiczna formularza (`emailVerification: requested` albo `none`) nie zdradza, że adres jest zablokowany; potwierdzenie ma jedną odpowiedź `400 invalid_or_expired_code` dla złego tokenu, złego i wygasłego kodu, limitu prób i rozstrzygniętego wniosku; (6) decyzja zarządu (zatwierdzenie albo odrzucenie) anuluje kod jeszcze niewysłany, a po decyzji kod nie jest przyjmowany; (7) wniosek złożony przy wyłączonej fladze albo bez szablonu nie dostaje kodu wstecznie po włączeniu (wiersz `skipped` z powodem) — potrzebny nowy link; (8) kody zużywają ten sam dzienny limit Brevo (`email_send_ledger`, źródło `verification`, w podglądzie limitu jako „inne”) i są wysyłane przed kampaniami w tym samym przebiegu; wynik niepewny (5xx, timeout) nie jest ponawiany (`failed`/`delivery_unknown`; kod, który mógł dotrzeć, nadal można wpisać w terminie); (9) panel `families/` pokazuje stan weryfikacji w kolejce wniosków i ma widok szablonu (lista wersji, szkic, zatwierdzenie przez inną osobę z zarządu); publiczna strona `/kontakt/#token=…` (formularz wniosku i wpisanie 8-cyfrowego kodu, ta sama treść dla każdej porażki potwierdzenia) powstała dopiero w kolejnym PR, bo wcześniej istniały tylko trasy API — jej adres i brak automatycznego wysyłania linków rodzicom (zarząd przekazuje link poza systemem) to założenie do potwierdzenia, nie decyzja; kolejka kodów jest w monitoringu (`/health/jobs`: `guardian_verify_queue_too_old`, `ops-status`, `worker-status`; próg `GUARDIAN_VERIFY_QUEUE_MAX_AGE_HOURS`, domyślnie 2 h — założenie). Nie jest to gotowy mechanizm do pracy na danych rodzin (prototyp, dane syntetyczne).
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
- #96 (magazyn plików zdjęć galerii) wdrożony na wariancie zachowawczym w braku tej decyzji: serwer NIE przechowuje przesłanego oryginału, tylko przetworzone warianty (`web`/`thumb`) bez EXIF/GPS. Jeśli D-18 rozstrzygnie, że oryginał ma być zachowany jako dowód (np. do sporu o prawa), potrzebna będzie kolejna migracja z osobną, bardziej restrykcyjną polityką dostępu do niego.
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
- Notatka techniczna (28.09.2026, przegląd #42): #42 („usunięcie Workera, D1 i starej konfiguracji") nie ma jeszcze scalonego PR i nie jest realizowany dalej, dopóki ta decyzja jest otwarta — zgodnie z AGENTS.md i opisem issue („nie usuwaj starych ścieżek przed testami równoważności i próbą odtworzenia", „nie wdrażaj produkcyjnie bez osobnej decyzji szkoły"). Stan repo: kod Workera/Cloudflare D1 (`src/index.js` warstwa Workera, `wrangler.jsonc`, `migrations/*.sql` D1) współistnieje nadal z warstwą Node/PostgreSQL (`src/pg/**`, `postgres/migrations/*.sql`); PR #227 ustalił, że stary stos nigdy nie był wdrożony produkcyjnie ani nie zawierał danych szkoły. Osobne, już scalone PR-y (#353 — audyt npm i CI, #367 — SR-06/SR-05 część, oba niezależne od tej decyzji) zamknęły dwie punktowe luki bezpieczeństwa niezwiązane z samym usunięciem starego stosu. Do czasu przyjęcia D-20 żaden agent nie powinien usuwać `wrangler`, kodu Workera ani migracji D1, ani oznaczać prototypu jako gotowego do wdrożenia.

### D-21. Aktualny regulamin i dostęp do dokumentów źródłowych

- Pytanie: która wersja regulaminu Rady i programu jest obowiązująca oraz kto może mieć do nich dostęp w panelu lub repozytorium?
- Dlaczego: README zabrania umieszczania tych dokumentów w repo bez decyzji. Dotyczy #13 i #15.
- Warianty w dokumentacji: nie wskazano.
- Notatka techniczna (28.09.2026): PR #382 (#125, scalony) dostarczył wyłącznie projekt sprawozdania rocznego liczony na żywo z bieżących danych (nagłówek „nie jest wersją zatwierdzoną”). Niezmienne migawki sprawozdania (`financial_report_snapshots`, suma SHA-256, zatwierdzenie przez drugą osobę), wskazanie migawki przy zamknięciu roku i publikacja zatwierdzonej migawki przez aktualności są wprost poza zakresem PR i czekają na tę decyzję oraz na D-04 (schemat i retencja migawki wymagają osobnej migracji).
- Notatka techniczna (30.09.2026, #175): uzupełnienie notatki z 28.09 — od PR #450 (scalony 29.09, migracja `0138_financial_report_snapshots.sql`) niezmienne migawki sprawozdania (`financial_report_snapshots`, SHA-256, zatwierdzenie przez inną osobę z zarządu) i wskazanie migawki przy zamknięciu roku (`reportSnapshotId`, docs/YEAR_CLOSE.md) są w kodzie; publikacji sprawozdania przez aktualności nadal nie ma. Mechanizm nie rozstrzyga tej decyzji ani D-04 — status pozostaje otwarty.
- Notatka techniczna (29.09.2026; D-19, #211, PR #437): w zebraniu ta sama osoba zapisana zarówno jako użytkownik (`user_id`), jak i jako opiekun (`guardian_id`) liczy się do quorum dwa razy. Test „known gap” w `tests/pg-meetings.test.js` utrwala obecne zachowanie (opis: docs/TESTING.md). Naprawa wymaga migracji oraz decyzji, kto głosuje i jest liczony — konto czy opiekun (zależne od regulaminu i D-19). Warianty: A) liczyć konto; B) liczyć opiekuna; C) osoba jedna, łączona po potwierdzeniu przez sekretarza zebrania. Obecny wariant: brak deduplikacji (znana luka, nieoznaczona jako gotowa). Rekomendacja koordynatora (nie rozstrzygnięcie): po ustaleniu regulaminu liczyć osobę raz; do tego czasu quorum stwierdza sekretarz ręcznie.
- Notatka techniczna (02.10.2026, #113 część „odbiorcy-konta”, migracja `0183_email_account_recipients.sql`; realizacja wskazania „Zaproszeni na zebranie zarządu” z tabeli „Wskazania użytkownika 2026-10-02”, nie rozstrzygnięcie tej decyzji): zawiadomienie o zebraniu zarządu idzie jako kampania e-mail do **kont** (`meeting_invitees`). Założenia (część potwierdzona wskazaniami 2026-10-02 w tabeli wyżej — skarbnik, zarząd klasowy, wstrzymanie po zakolejkowaniu; reszta wariant zachowawczy do potwierdzenia): (1) zaproszone konto = aktywny przydział (nie cofnięty, nie wygasły) roli `board`, `treasurer`, `representative`, `audit` lub `principal` obowiązujący w roku zebrania — z tym rokiem **albo bez roku** (przydział bez roku obowiązuje we wszystkich latach, tak liczy go resolver zakresu; `principal` ma dziś wymóg roku przy nadawaniu, więc w praktyce dotyczy to `board`/`audit`); przydział klasowy w roku też się liczy (przedstawiciel; zarząd z przydziałem klasy — zapraszany jak przedstawiciel, wskazanie 2026-10-02, choć nie otworzy zebrania zarządu w panelu); skarbnik (`treasurer`) jest zapraszany (wskazanie 2026-10-02), admin techniczny — nie; (2) konto wyłączone jest pomijane (wykluczenie `account_disabled` w migawce; wyłączenie po zatwierdzeniu — worker nie wysyła), jedno konto = jedna wiadomość, adres = `users.email`; zmiana adresu konta po zatwierdzeniu wstrzymuje wiadomość do tego konta (nowy adres nie był zatwierdzony) — wymaga nowej migawki; (3) kto zatwierdza wysyłkę do kont (D-08): jak każdą kampanię — inna osoba z zarządu niż autor szkicu i migawki, ze świeżym MFA; tworzyć szkic może tylko rola tworząca zawiadomienia zebrań ogólnych (admin, zarząd szkolny z MFA); (4) wymóg opublikowanej informacji o przetwarzaniu danych (D-06, #145) przy zatwierdzeniu zostaje także dla kampanii do kont — bramka modułu e-mail jest globalna, a jej osłabienie wymagałoby zmiany triggera z 0179; członkowie Rady też są osobami, których adres przetwarzamy; (5) szkic treści to szablon roboczy (D-16) — data i godzina w `Europe/Brussels`, miejsce, porządek obrad z wersji zawiadomienia; nadawca wyłącznie z `BREVO_FROM_EMAIL` (D-17); (6) luka znaleziona przy okazji i domknięta dla wszystkich rodzajów zebrań: zatwierdzona kampania z zawiadomienia mogła wyjść po zmianie porządku lub terminu (skrót treści kampanii nie obejmował stanu zebrania) — teraz zatwierdzenie, kolejka i wznowienie dają `409 notice_outdated`, a worker pomija taką kampanię — wstrzymanie, bez automatycznego anulowania (wskazanie 2026-10-02). Poza zakresem: załącznik `.ics`, e-mail weryfikacyjny adresu konta (#140).
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

### D-23. Nazwa szkoły i format roku szkolnego w panelu

- Pytanie: jaka jest oficjalna nazwa szkoły i Rady w nagłówkach, na stronie publicznej i na wydrukach oraz jaki format roku szkolnego obowiązuje?
- Dlaczego: w prototypie występują trzy zapisy nazwy — „Szkoła Polska w Brukseli” (nagłówki paneli), „Szkoła Polska im. Joachima Lelewela” (`/site/`, `/import/`, kartki) i „im. J. Lelewela” (seed wydarzenia demo) — oraz dwa formaty roku: „2026/2027” (Rodziny, Konta, Eksport, raport KR) i „2026-2027” (pola formularzy). Nie chcemy zgadywać nazwy urzędowej; wydruki i strona publiczna są widoczne dla rodziców (przegląd demo z 29.09.2026, pozycja 7).
- Warianty: nazwa — pełna z patronem („Szkoła Polska im. Joachima Lelewela w Brukseli”), krótka („Szkoła Polska w Brukseli”) albo krótka w nagłówku i pełna na wydrukach i stronie publicznej; rok — „2026/2027” albo „2026-2027”; osobno strefa czasu w wyświetlanych godzinach (dziś UTC w Aktualnościach, czas lokalny gdzie indziej): Europe/Brussels wszędzie.
- Obecny wariant w kodzie: bez zmian, niespójny (nic nie ujednolicono, żeby nie wprowadzać nieoficjalnej nazwy). Po decyzji nazwa i format trafią do jednej stałej w `shared/`.
- Rekomendacja koordynatora (nie rozstrzygnięcie): pełna nazwa na stronie publicznej i wydrukach, krótka w nagłówkach paneli; format „2026/2027” (jak w treści kartek); godziny w Europe/Brussels. Ostateczną nazwę potwierdza Rada z dyrekcją szkoły.
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
