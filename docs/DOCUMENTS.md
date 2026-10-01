# Prywatne dokumenty w Railway Storage Bucket

Status: prototyp na danych syntetycznych (issue #39, część #8 i #31). **Niewdrożony i niezatwierdzony do pracy na dokumentach rodzin ani prawdziwych dowodach finansowych.** Zastępuje planowany wcześniej Cloudflare R2.

## Zasada

Plik trafia do prywatnego Railway Storage Bucket (API S3) w regionie UE. Metadane, uprawnienia i dziennik są w PostgreSQL. Bucket nigdy nie jest publiczny, a przeglądarka nie dostaje adresu bucketu ani podpisanego linku: serwer Node sprawdza sesję i uprawnienia, zapisuje zdarzenie w dzienniku, pobiera obiekt i dopiero wtedy przekazuje go użytkownikowi (proxy). Podpisane adresy (presigned URL) nie są używane; gdyby kiedyś były potrzebne, ich ważność nie może przekraczać 60 sekund i wymagają osobnego przeglądu.

## Rodzaje dokumentów i dostęp

Macierz jest **założeniem technicznym do zatwierdzenia** przez zarząd i szkołę (D-08, D-09 w [DECISIONS.md](DECISIONS.md)). Odpowiada obecnym uprawnieniom API księgi.

| Rodzaj (`kind`) | Przykład | Odczyt i przesyłanie | MFA |
|---|---|---|---|
| `financial` | faktura, potwierdzenie przelewu, wyciąg | `admin`, `board`, `treasurer` bez ograniczenia do klasy | tak |
| `board` | protokół zarządu, uchwała | `admin`, `board` bez ograniczenia do klasy | nie |
| `class` | materiał jednej klasy | `admin`, `board` oraz `representative` wyłącznie przypisanej klasy | nie |
| `council_shared` | regulamin, plan pracy, informacja o składce (#167) | przesyłanie, opis, zastąpienie, unieważnienie: `admin`, `board` bez ograniczenia do klasy; odczyt (lista, metadane, treść) także `representative` z przydziałem klasowym w roku dokumentu | nie |

- Dyrekcja (`principal`) i Komisja Rewizyjna (`audit`) nie mają dostępu do czasu decyzji D-09.
- Przydział ograniczony do klasy nie otwiera dokumentów `financial` ani `board`, także dla roli `board`.
- Przydział z rokiem szkolnym działa tylko dla dokumentów tego roku. Wygasły lub cofnięty przydział traci dostęp od następnego żądania.
- Autoryzacja jest liczona **dla każdego dokumentu** z jego rodzaju, roku i klasy zapisanych w bazie, nie z parametrów żądania.

### Co widzi przedstawiciel klasy (#167)

- Wyłącznie dokumenty `class` przypisanej klasy i roku przydziału (odczyt, przesłanie, opis, zastąpienie/unieważnienie jak w macierzy). Dokumenty `financial` i `board` dają mu `404` (brak wyroczni istnienia), a przesłanie ich — `403 forbidden`.
- Dokumenty `council_shared` (regulamin, plan pracy, informacja o składce, szablon listy obecności; migracja 0167) czyta każdy przedstawiciel z przydziałem klasowym w roku dokumentu — niezależnie od klasy — bez MFA. Tylko odczyt: przesłanie daje mu `403 forbidden`, opis, zastąpienie i unieważnienie — `404`. Przydział z innego roku, przydział zarządu ograniczony do klasy, dyrekcja i Komisja Rewizyjna dostają `404` (brak wyroczni istnienia, SR-07). Dokument tego rodzaju nie może być źródłem zdjęcia galerii publicznej (0143).
- Założenie do zatwierdzenia (D-08): które dokumenty Rady trafiają do `council_shared`, rozstrzyga zarząd; przedstawiciel może przekazać treść rodzicom swojej klasy. Przed wgraniem dokumentu z danymi osobowymi obowiązuje kontrola z #152. Zatwierdzone protokoły udostępnione rodzicom przedstawiciel widzi w panelu `meetings/` (docs/MEETINGS.md, „co widzi przedstawiciel”).

## API

| Metoda i ścieżka | Opis |
|---|---|
| `POST /api/documents?kind=…&schoolYearId=…[&classId=…][&linkedEntityType=…&linkedEntityId=…]` | Przesłanie pliku. Ciało to surowe bajty pliku; wymagane nagłówki `Content-Type` i `Idempotency-Key` (8–128 znaków). `classId` wyłącznie dla `class`. Powiązanie (`ledger_entry` albo `payment_entry` z tego samego roku) wyłącznie dla `financial`. |
| `GET /api/documents?schoolYearId=…[&kind=…][&classId=…][&status=active|all][&category=…][&q=…][&from=YYYY-MM-DD][&to=YYYY-MM-DD][&sort=documentDate|createdAt][&validation=outdated][&limit=…][&offset=…]` | Lista metadanych dostępnych użytkownikowi (najwyżej 100 na stronę), z tytułem i kategorią najnowszej wersji opisu. Domyślnie (`status=active`, też brak parametru) pokazuje tylko dokumenty aktywne; `status=all` pokazuje też zastąpione i unieważnione. `q` szuka w tytule i opisie (`ILIKE`, znaki specjalne wzorca uciekane); `from`/`to` zawężają po dacie dokumentu (najnowsza wersja opisu; dokument bez daty nie spełnia filtra; `from` > `to` → `400 invalid_request`, zła data → `400 invalid_document_date`). `sort=documentDate` sortuje malejąco po dacie dokumentu (bez daty na końcu), domyślnie `createdAt`; inna wartość → `400 invalid_request`. `validation=outdated` (#89, 0161) zawęża listę do dokumentów sprawdzonych przy przesłaniu starszą wersją reguł kontroli struktury albo bez zapisanej wersji (inna wartość → `400 invalid_request`); każdy wiersz ma `validationVersion` (liczba albo `null`) i `validationCurrent`. Filtry i paginacja liczą się w SQL przed `LIMIT`. |
| `GET /api/documents/{id}` | Metadane jednego dokumentu: `status` (`active`/`superseded`/`voided`), `replacementDocumentId` („zastąpiony przez”, dla `superseded`), `supersedes` („zastępuje” — inny dokument, którego zastępstwem jest ten, jeśli istnieje) i pełna historia opisu (`descriptionHistory`, najnowsza wersja pierwsza). |
| `GET /api/documents/{id}/content` | Pobranie pliku po autoryzacji (działa niezależnie od stanu — unieważniony dokument zostaje w archiwum, nie znika). |
| `POST /api/documents/{id}/supersede` | Issue #82: `{ replacementDocumentId, reason }`, JSON, `Idempotency-Key`. Zastępstwo musi mieć ten sam rodzaj, rok szkolny i klasę oraz być aktywne (cykl A→B→A jest przez to niemożliwy). |
| `POST /api/documents/{id}/void` | Issue #82: `{ reason }`, JSON, `Idempotency-Key`. |
| `POST /api/documents/{id}/description` | Nowa wersja opisu (issue #76): `{ title, category, documentDate?, description? }`, JSON, nagłówek `Idempotency-Key`. Uprawnienie takie samo jak do przesłania danego rodzaju dokumentu (patrz macierz wyżej); MFA wymagane dla `financial`. Dopisuje wiersz — nie edytuje poprzedniej wersji. |

Odpowiedzi:

- `401 unauthenticated` bez ważnej sesji.
- `404 not_found` zarówno dla nieistniejącego identyfikatora, jak i dokumentu, do którego użytkownik nie ma dostępu (w tym brak MFA przy `financial`). Odpowiedź jest identyczna, więc nie da się zgadywaniem ustalić, czy dokument istnieje. Odmowa dla istniejącego dokumentu jest zapisywana jako `document.access_denied`.
- `403 forbidden` przy przesyłaniu, gdy rola nie pozwala dodać dokumentu danego rodzaju w danym roku lub klasie; `403 invalid_origin` przy żądaniu z innego origin.
- `413 document_too_large`, `415 unsupported_media_type`, `400` dla błędnych parametrów, `409 idempotency_conflict` gdy ten sam klucz przyszedł z inną treścią.
- `503 storage_unavailable`, gdy bucket nie jest skonfigurowany; `503 service_unavailable` przy błędzie magazynu lub niezgodności sumy kontrolnej.

Ponowienie tego samego żądania (podwójne kliknięcie, ponowiona sieć) z tym samym `Idempotency-Key` zwraca `200` z `replayed: true` i tym samym dokumentem; nie powstaje drugi wpis ani drugi obiekt.

Pobranie ma nagłówki `Content-Disposition: attachment; filename="dokument-<id>.<ext>"`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cross-Origin-Resource-Policy: same-origin` i `Referrer-Policy: no-referrer`. Przed wydaniem pliku serwer porównuje rozmiar i SHA-256 obiektu z bazą; niezgodność blokuje pobranie.

## Wersje i unieważnienie (issue #82)

Dokument w `documents` jest i pozostaje niezmienny — „unieważnienie” albo „zastąpienie” **nie usuwa** pliku ani wpisu; dopisuje tylko zdarzenie stanu w osobnej, dopisywanej tabeli `document_status_events`. UI musi to jasno komunikować: to nie jest „Usuń”, plik zostaje w archiwum i nadal można go pobrać (dla ról z dostępem do danego rodzaju).

**Panel (`documents/`):** stan w liście i szczegółach, filtr „Pokaż też zastąpione i unieważnione” (`status=all`), historia wersji (łańcuch „zastępuje” / „zastąpiony przez”, odczytywany z metadanych sąsiednich dokumentów) oraz akcje „Zastąp innym dokumentem…” i „Unieważnij…” z powodem i oknem potwierdzenia (`shared/confirm-dialog.js`). Przyciski widzą konta z rolą dopuszczoną przez `DOCUMENT_POLICIES` (jak przy przesłaniu; bez rozszerzania uprawnień, D-08/D-09) — to tylko podpowiedź, serwer i tak zwraca 404/403. Kandydaci na zastępstwo pochodzą z wczytanej listy (ten sam rodzaj, rok, klasa, aktualne).

Zasady:
- Dokument ma co najwyżej JEDNO zdarzenie stanu — pierwsza zmiana jest ostateczna. Próba unieważnienia już zastąpionego dokumentu (albo odwrotnie) kończy się `409 document_status_conflict`.
- **Wyjątek — ponowne unieważnienie tym samym działaniem** (np. podwójne kliknięcie „Unieważnij” z innym kluczem idempotencji po błędzie sieci, albo dowolna kolejna próba unieważnienia już unieważnionego dokumentu) zwraca `200` z `replayed: true` i **tym samym** zdarzeniem — nie jest to błąd.
- Zastępstwo musi mieć ten sam `kind`, `schoolYearId` i `classId` co zastępowany dokument oraz musi być samo aktywne (`400 invalid_replacement_document`, `409 document_status_replacement_not_active`). Wymóg aktywności zastępstwa wyklucza cykl A→B→A: gdy A zostaje zastąpiony przez B, A przestaje być aktywny i nie może już posłużyć jako zastępstwo dla B.
- Trasy sprawdzają uprawnienia jak przy przesłaniu danego rodzaju (MFA wymagane dla `financial`); nieznany albo niedostępny dokument daje `404 not_found`, tak jak reszta API dokumentów.
- Dziennik: `document.superseded`, `document.voided` — aktor, czas, identyfikator dokumentu i zastępstwa, **bez powodu** (`reason` jest wewnętrzny, nie trafia do `audit_events`).
- Lista (`GET /api/documents`) domyślnie pokazuje tylko dokumenty `active`; `status=all` pokazuje też zastąpione/unieważnione. Szczegóły (`GET /api/documents/{id}`) zawsze pokazują aktualny stan i pełny łańcuch („zastąpiony przez” / „zastępuje”).
- **Zastąpienie innym dokumentem niż już zapisany to konflikt, nie powtórka** (poprawka 30.09): gdy A jest już zastąpiony przez B, próba zastąpienia A przez C — także równoległa (dwa okna, dwie osoby) — daje `409 document_status_conflict`; `replayed: true` dostaje tylko ta sama zmiana (ten sam dokument zastępujący). Wcześniej przegrany wyścig dostawał `200 replayed` ze zdarzeniem wskazującym cudzą wersję.
- **Rok zamknięty:** nowej wersji nie da się przesłać (`documents` jest zamrożone od 0036) ani wskazać jako zastępstwa dokumentu zamkniętego roku — `POST …/supersede` sprawdza `school_year_assert_open()` w transakcji (blokada `FOR SHARE` wiersza zamknięcia, jak triggery zamrożenia) i zwraca `409 school_year_closed`; zastąpienie zmienia obowiązującą wersję dowodu, a korekta po zamknięciu nie ma ścieżki w aplikacji (`docs/YEAR_CLOSE.md`). **Unieważnienie w zamkniętym roku pozostaje możliwe** — wariant zachowawczy do D-04/D-07: plik wgrany omyłkowo (np. z danymi dziecka) da się zdjąć z domyślnej listy także po zamknięciu; plik i wpis zostają. Sprawdzenie jest w kodzie trasy, bez migracji (zapis bezpośrednio do `document_status_events` z pominięciem API nie jest blokowany — do ewentualnego triggera w osobnej migracji po decyzji Rady).
- **Unieważnienie nie ogranicza dostępu:** osoby z dostępem do rodzaju dokumentu nadal mogą go pobrać i podejrzeć (każdy odczyt treści ma ślad `document.downloaded`/`document.viewed`). Ograniczenie treści unieważnionego dokumentu do `admin`/`board` pozostaje do decyzji (D-08/D-09); okno potwierdzenia w panelu mówi o tym wprost.
- **Dowody księgi (punkt 4 issue):** powiązanie z wpisem (`source_document_id`, `documents.linked_entity_*`) zostaje przy pierwotnym dokumencie — to historia. `GET /api/ledger` zwraca obok `attachmentIds` pole `attachments`: `[{ documentId, status, currentDocumentId }]`, gdzie `currentDocumentId` to koniec łańcucha zastąpień (dokument aktywny) albo `null`, gdy łańcuch kończy się unieważnieniem lub dowód sam jest unieważniony. Panel `ledger/` dopisuje przy „Dowody: N” liczbę zastąpionych, unieważnionych i bez aktualnej wersji. Raport KR („Dowody wydatków”) i ostrzeżenie zamknięcia roku `expenses_without_evidence` stosują tę samą regułę (wspólny moduł `src/pg/document-chain.js`): dowodem jest tylko dokument z aktualną wersją; wydatek, którego wszystkie dowody są unieważnione (lub zastąpione bez aktualnej wersji), jest „bez dowodu” z adnotacją „dowód unieważniony” (docs/RECONCILIATION.md).

## Tytuł, kategoria i wyszukiwanie (issue #76)

`documents` pozostaje niezmienne (zasada z issue #39/#8). Osobna, dopisywana tabela `document_descriptions` przechowuje tytuł (3–200 znaków), kategorię z zamkniętej listy (`faktura`, `potwierdzenie_przelewu`, `wyciag`, `protokol`, `uchwala`, `umowa`, `regulamin`, `sprawozdanie_rewizyjne`, `inne` — założenie do zatwierdzenia przez zarząd i skarbnika), opcjonalną datę dokumentu i opcjonalny opis (do 1000 znaków). Zmiana opisu **nie edytuje** poprzedniego wiersza — dodaje kolejną wersję (`revision_no`); poprzednie wersje zostają w historii (`GET /api/documents/{id}`). Obowiązuje najnowsza wersja.

Dokument bez żadnego wpisu opisu (istniejące dokumenty sprzed tej migracji, albo taki, dla którego nikt jeszcze nie dodał tytułu) ma `title: null` — panel pokazuje wtedy „Bez tytułu”, nie błąd.

**Ostrzeżenie dla osoby wypełniającej formularz:** tytuł nie powinien zawierać imion i nazwisk uczniów ani rodziców — trafia do listy widocznej dla każdego z dostępem do danego rodzaju dokumentu (np. „Faktura — wynajem sali, październik”, nie „Faktura za obóz Jasia Kowalskiego”). To nie jest wymuszone technicznie.

Dziennik: `document.described` zapisuje aktora, czas, identyfikator dokumentu, kategorię i numer wersji — **bez tytułu ani opisu** (mogą zawierać treść opisową dokumentu).

Zamrożenie roku (issue #76/#313, `postgres/migrations/0106_document_descriptions_year_freeze.sql`): `document_descriptions` nie ma własnej kolumny `school_year_id` — rok ustala dokument-rodzic (`documents.school_year_id`, `FOR UPDATE` blokuje wiersz `documents` przed zapisem opisu, więc sprawdzenie jest spójne z numerowaniem wersji). Nowy opis dokumentu przypisanego do zamkniętego roku kończy się `409 school_year_closed`; dokumenty bez `school_year_id` (np. przywrócone z D1) nie są objęte — jak przy samym `documents` (`postgres/README.md`, `docs/YEAR_CLOSE.md`).

Panel (`documents/`) wybiera rok szkolny i klasę z list zwracanych przez serwer (`GET /api/classes` zawęża listę do zakresu roli), a nie z pola tekstowego.

## Walidacja pliku

- Dozwolone typy: PDF, PNG, JPEG. Typ jest ustalany po sygnaturze pliku (magic bytes) i musi zgadzać się z zadeklarowanym `Content-Type`. Plik HTML, skrypt, dokument biurowy czy CSV z nagłówkiem PDF zostanie odrzucony.
- CSV nie jest dopuszczony: nie ma sygnatury, a zwykle zawiera listy osób. Import rodzin ma osobny przepływ ([import/README.md](../import/README.md)).
- Limit rozmiaru: `DOCUMENT_MAX_BYTES`, domyślnie 10 MiB, najwyżej 25 MiB. Serwer Node podnosi limit ciała żądania wyłącznie dla `POST /api/documents` (i dla pliku zdjęcia aktualności, 10 MiB); wszystkie inne trasy — w tym import CSV/XLSX i wyciągi bankowe, wysyłane jako JSON — nadal mają 1 MiB, czytany przed wywołaniem trasy. Trasa sama liczy bajty podczas odczytu, niezależnie od `Content-Length`.
- **Sesja przed ciałem** (#185): dla `POST /api/documents` serwer Node NIE buforuje ciała przed wywołaniem trasy — trafia ono do żądania jako strumień, a `readLimited` (`src/documents.js`) czyta go dopiero PO sprawdzeniu sesji, roli i typu. Żądanie bez ważnej sesji z dużym zadeklarowanym `Content-Length` kosztuje pamięci tyle co zwykłe odrzucenie `401`, nie tyle co upload. Połączenie jest wtedy jawnie zamykane (`Connection: close`), żeby nieprzeczytane bajty nie zawisły na współdzielonym gnieździe keep-alive.
- **Limit równoczesnych uploadów na proces**: `DOCUMENT_MAX_CONCURRENT_UPLOADS` (domyślnie 4). Piąty i kolejny równoczesny `POST /api/documents` dostaje `503 upload_busy` z `Retry-After` BEZ odczytu ciała. Limit jest na proces, nie na klaster Railway (kilka instancji ma osobne liczniki) — do rozważenia przy skalowaniu poziomym.
- **Limit na użytkownika** (#185, wariant zachowawczy): jedno konto ma najwyżej 2 równoczesne uploady (`DEFAULT_MAX_CONCURRENT_UPLOADS_PER_USER` w `src/documents.js`); trzeci dostaje `503 upload_busy` bez odczytu ciała. Jedno konto (albo przejęta sesja) nie zajmie wszystkich miejsc procesu. Panele wysyłają pliki pojedynczo; podwójne kliknięcie mieści się w limicie i rozstrzyga je klucz idempotencji (jeden dokument). Semafor jest wspólny z `POST /api/news-photos/:id/file` ([NEWS.md](NEWS.md)).
- **Zbyt duże ciało bez odczytu** (#185): `Content-Length` ponad limit trasy daje `413 request_too_large` przed wywołaniem trasy, z `Connection: close` — serwer nie dopija reszty ciała. Ciało bez `Content-Length` (chunked) albo z zaniżoną deklaracją jest ucinane po przekroczeniu limitu przez strumień w `src/node-app.js` (druga linia obrony obok `readLimited`). Przerwane przez klienta połączenie kończy odczyt błędem, a miejsce semafora wraca w `finally`.
- Skan antywirusowy nie jest jeszcze dostępny (ryzyko opisane niżej).
- **Kontrola struktury (issue #89, heurystyka, NIE zastępuje skanu antywirusowego):** po zgodności sygnatury i typu serwer sprawdza surowe bajty pliku (`src/documents.js#validateStructure`) i odrzuca `415`:
  - `document_active_content` — PDF zawierający słowa kluczowe `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/XFA`, `/Encrypt` (szyfrowanie uniemożliwia dalszą kontrolę treści, więc traktujemy je tak samo), `/SubmitForm` albo `/ImportData` (akcje formularza wysyłające dane z dokumentu albo wczytujące je z zewnątrz) — w surowych bajtach pliku **albo w rozpakowanym strumieniu obiektów**;
  - `document_malformed` — PDF bez `%%EOF` w ostatnim 1 KiB (np. poliglota z dołożonymi danymi po właściwej treści), PDF ze strumieniem obiektów, którego nie da się sprawdzić (filtr inny niż pojedynczy `FlateDecode`, predyktor, uszkodzone dane, przekroczony limit rozpakowania 8 MiB na strumień / 32 MiB na plik), PNG z uszkodzonym łańcuchem chunków, pierwszym chunkiem innym niż `IHDR`, typem chunku spoza liter ASCII albo danymi po `IEND`, JPEG bez `FF D9` na końcu (po odjęciu dopuszczalnego dopełnienia zerami).
  - **Strumienie obiektów PDF** (`/Type /ObjStm` albo słownik z `/First`, PDF 1.5+): słowniki — w tym akcje `/JavaScript` i `/OpenAction << … >>` — mogą leżeć w skompresowanym strumieniu, niewidoczne w surowych bajtach. Serwer rozpakowuje (`node:zlib`, z limitem) **wyłącznie** takie strumienie i sprawdza je tą samą listą. Strumieni treści stron, czcionek i obrazów nie rozpakowujemy: przypadkowe bajty skompresowanego obrazu czy czcionki dawałyby fałszywe odrzucenia, a słowniki akcji i tak nie mogą się tam znaleźć.
  - **Fałszywe odrzucenia (znane, także przed tą zmianą):** słowa kluczowe szukamy w surowych bajtach CAŁEGO pliku, więc przypadkowy ciąg `/JS` w danych binarnych dużego obrazu osadzonego w PDF może dać `document_active_content` (rząd wielkości: jedno trafienie na ok. 16 MiB losowych danych). Świadomie nie pomijamy danych strumieni: granice strumienia wyznaczone przez naszą heurystykę mogłyby się różnić od tych, które przyjmie czytnik, i ukryć obiekt. Kontrola pliku 20 MiB trwa poniżej 1 s (pomiar lokalny); przeszukiwanie słowników jest liniowe, z łącznym budżetem kroków na plik.
  - **SVG i inne typy** nie mają dozwolonej sygnatury, więc są odrzucane `415 unsupported_media_type` także wtedy, gdy są zadeklarowane jako PNG/JPEG/PDF (test w `tests/documents-structure.test.js` i `tests/pg-documents.test.js`).
  - **Ograniczenie:** to heurystyka na bajtach, nie pełny parser PDF i nie skan antywirusowy. Nie wykrywa np. aktywnej treści w formacie, którego PDF-y banków nie używają, ani złośliwych danych obrazu (błędów dekodera). Reguła wymaga przeglądu przed włączeniem na prawdziwych, zanonimizowanych plikach z banku (ryzyko fałszywych odrzuceń podpisanych/zaszyfrowanych PDF-ów i formularzy z przyciskiem wysyłki).
  - Nazwy PDF zapisane szesnastkowo (`/J#61vaScript`) są dekodowane przed porównaniem, żeby nie omijały listy. `/OpenAction` odrzucamy tylko, gdy akcja jest wpisana w miejscu (`/OpenAction << … >>`); cel-strona (`[ … ]`) i odnośnik (`5 0 R`) przechodzą, a odnośnik do akcji ze skryptem wychwytuje słowo kluczowe akcji. Pełne odrzucanie `/OpenAction` dałoby fałszywe odrzucenia PDF z banku.
  - **Wersja reguł (`documents.validation_version`, migracja 0161):** przy przesłaniu serwer zapisuje stałą `DOCUMENT_VALIDATION_VERSION` z `src/documents.js` (dziś `1`). Istniejące wiersze sprzed migracji mają `NULL` = „wersja nieznana” (sprawdzone samą sygnaturą albo wcześniejszymi regułami) — nic nie jest uzupełniane wstecznie. Wiersz `documents` jest niezmienny, więc wersja nie rośnie po późniejszym sprawdzeniu. Każda zmiana kodu reguł (między znacznikami „reguły kontroli struktury” w `src/documents.js`) wymaga podbicia stałej; pilnuje tego odcisk kodu w `tests/documents-validation-version.test.js` (test pada, dopóki wersja nie zostanie podbita i odcisk dopisany).
  - Lista dokumentów sprawdzonych starszymi regułami: `GET /api/documents?schoolYearId=…&validation=outdated` (w panelu Dokumenty pole „Tylko sprawdzone starszymi regułami kontroli pliku”; w metadanych wiersz „Kontrola struktury”). To tylko zawężenie listy w granicach dotychczasowych uprawnień — przedstawiciel klasy nadal nie widzi dokumentów finansowych ani zarządu. Ponowne sprawdzenie i ewentualne zastąpienie takich plików to decyzja osoby odpowiedzialnej za dokument (zastąpienie — `POST /api/documents/{id}/supersede`); automatycznego ponownego sprawdzania w tle nie ma (osobny zakres).
  - Ta wersja **nie** obejmuje renderowania PDF przez samodzielnie hostowany PDF.js (zależność wymaga decyzji D-05).

## Podgląd w panelu (issue #89)

`GET /api/documents/{id}/content?disposition=inline` wydaje PDF, PNG albo JPEG do wyświetlenia w panelu bez zapisu na dysku. Wartość `attachment` (i brak parametru) to dotychczasowe pobranie; każda inna wartość daje `400 invalid_disposition`.

- **Autoryzacja przy każdym żądaniu.** Nie ma adresu z tokenem ani podpisanego adresu do bucketu: przeglądarka woła ten sam endpoint serwera z ciasteczkiem sesji, a serwer liczy sesję, rolę, MFA, rok i klasę jak przy pobraniu. Wygaśnięcie sesji lub przydziału odcina podgląd od następnego żądania; skopiowany adres nie działa bez sesji (`401`). Dokument niedostępny dla roli i nieznany dają ten sam `404` (przy istniejącym dokumencie — zapis `document.access_denied`). Bucket pozostaje prywatny, treść przechodzi przez serwer.
- **Nagłówki odpowiedzi podglądu:** `Content-Disposition: inline`, `Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'self'` (bez `allow-scripts` i `allow-same-origin`), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`. Tylko ta odpowiedź dostaje `X-Frame-Options: SAMEORIGIN` (reszta serwera zostaje przy `DENY`), żeby panel mógł osadzić PDF we własnej ramce.
- **Ponowna kontrola przy podglądzie:** przed wydaniem treści inline serwer sprawdza bajty z bucketu jeszcze raz — sygnatura musi odpowiadać typowi zapisanemu w bazie, a struktura przejść bieżące `validateStructure`. Plik przyjęty przed wprowadzeniem kontroli struktury (#301) albo przed jej zaostrzeniem nie otworzy się w panelu: `409 document_preview_blocked` i zdarzenie `document.preview_blocked` (aktor, dokument, powód — kod reguły, bez treści). Pobranie jako załącznik zostaje (dowód w archiwum), z tymi samymi nagłówkami co dotąd.
- **Bez zbędnej ponownej kontroli (0161):** plik sprawdzony przy przesłaniu **bieżącą** wersją reguł (`validation_version` = `DOCUMENT_VALIDATION_VERSION`), którego rozmiar i SHA-256 w buckecie zgadzają się z zapisanymi (sprawdzane przy każdym odczycie; niezgodność = `503`, bez treści), nie jest przeszukiwany ponownie — te same bajty i te same reguły dają ten sam wynik, a kontrola dużego PDF to do ok. 1 s CPU na każdy podgląd. Sygnatura jest sprawdzana zawsze. Plik ze starszą wersją albo bez wersji (`NULL`) jest sprawdzany przy każdym podglądzie jak dotąd.
- **Panel:** obraz jako `<img>` (przeglądarka nie wykonuje skryptów z obrazu; SVG nie jest dopuszczony), PDF w `<iframe sandbox="">` (pusty atrybut = brak skryptów, formularzy, wyskakujących okien, nawigacji karty i dostępu do originu panelu — decyzja bezpieczeństwa #89/#466, bez zmian). Obok ramki link „Otwórz podgląd w nowej karcie” (ten sam adres, #539). CSP paneli bez zmian (`script-src 'self'`, `object-src 'none'`, `img-src 'self' data:`, `default-src 'self'` obejmuje ramkę własnego originu).
- **Model zagrożeń podglądu PDF:**
  - Ramka z `sandbox=""` jest najsilniejszą izolacją, jaką daje przeglądarka, ale Chromium (Chrome, Edge) w takiej ramce PDF **nie wyświetla** — pokazuje własny komunikat o blokadzie. Dlatego w Chromium podgląd PDF otwiera się przez link w nowej karcie; w przeglądarkach renderujących PDF w ramce z sandbox ramka działa bez zmian.
  - Nowa karta (`target="_blank" rel="noopener noreferrer"`): ten sam autoryzowany adres, każde otwarcie ma `document.viewed`. Karta nie ma dostępu do panelu (`noopener`), a panel pozostaje w swojej karcie.
  - Plik nigdy nie jest interpretowany jako HTML: typ pochodzi z bazy (ustalony po sygnaturze przy przesłaniu i **ponownie sprawdzony przy podglądzie**), `X-Content-Type-Options: nosniff`; gdyby przeglądarka potraktowała odpowiedź jak dokument, obowiązuje CSP `sandbox; default-src 'none'` (skrypty zablokowane).
  - Aktywna treść PDF (`/JavaScript`, `/Launch`, `/SubmitForm`, `/ImportData`, osadzone pliki, szyfrowanie) jest odrzucana przy przesłaniu i przy każdym podglądzie — także w strumieniach obiektów. Treść renderuje wbudowany czytnik przeglądarki (w Chromium PDFium w procesie rozszerzenia), który nie daje skryptom PDF dostępu do DOM strony.
  - Każda inna odpowiedź serwera ma `X-Frame-Options: DENY` / `frame-ancestors 'none'`; tylko odpowiedź podglądu dopuszcza osadzenie na własnym originie.
- **Obserwacje z przeglądarki (Playwright, Chromium 141 i Chrome for Testing 153, #89 część 2 — do decyzji na przyszłość, bez zmiany w kodzie):**
  - Chromium blokuje PDF w ramce z atrybutem `sandbox` także z dowolnymi tokenami bez skryptów (`allow-popups allow-forms allow-downloads …`).
  - Chromium **nie stosuje** dyrektywy CSP `sandbox` z nagłówka do dokumentu PDF: w nowej karcie dokument PDF ma origin panelu (`self.origin` nie jest `null`). Izolację w nowej karcie dają więc typ + `nosniff`, kontrola struktury i czytnik przeglądarki, nie sam nagłówek `sandbox`.
  - Kliknięcie linku `/URI` w PDF przełącza kartę, w której PDF jest wyświetlony (w nowej karcie — tę kartę, nie panel); `javascript:` przeglądarka blokuje. Linków `/URI` nie odrzucamy (faktury i wyciągi je zawierają).
  - Ramka bez atrybutu `sandbox` wyświetliłaby PDF w Chromium, ale link w PDF przełączyłby wtedy kartę panelu; wariant odrzucony decyzją bezpieczeństwa (ramka zostaje z `sandbox`).
  - **Nie sprawdzono** w Firefoksie i Safari (brak przeglądarek w środowisku testowym).
- **Dziennik:** podgląd zapisuje `document.viewed` (aktor, czas, identyfikator dokumentu, rodzaj, rok, klasa, sesja) przed wydaniem treści — błąd zapisu blokuje podgląd. Pobranie nadal zapisuje `document.downloaded`.
- **Ograniczenie:** to wbudowany czytnik PDF przeglądarki, nie PDF.js — bezpieczeństwo podglądu PDF zależy od izolacji tego czytnika (aktualizacje przeglądarki). Wariant z samodzielnie hostowanym PDF.js (kryterium akceptacji issue #89, w tym `disposition=inline` dla PDF → `400`) czeka na D-05.

## Klucz obiektu i dane osobowe

Klucz w buckecie ma postać `docs/<losowy uuid>`, niezależny od identyfikatora dokumentu w API. Nie zawiera nazwy pliku, roku, klasy, rodziny ani użytkownika; wymusza to ograniczenie w bazie. Oryginalna nazwa pliku **nie jest zapisywana** (często zawiera nazwisko). Plik do pobrania dostaje nazwę technyczną `dokument-<id>`. Dziennik zapisuje wyłącznie identyfikatory, rodzaj, typ, rozmiar i SHA-256 — bez nazwy pliku, treści i danych osobowych.

Bucket nie może zawierać zdjęć archiwalnych ani wizerunku dzieci: publikacja zdjęć wymaga osobnego sprawdzenia praw i zgód (AGENTS.md). Od #96 zdjęcia galerii mają osobny prefiks `photos/<losowy uuid>` w tym samym prywatnym buckecie (moduł `src/pg/news.js`, migracja `postgres/migrations/0084_news_photo_files.sql`) — oddzielny od `docs/` używanego przez ten moduł, żeby dowody finansowe/dokumenty zarządu i zdjęcia galerii się nie mieszały. Trasy dokumentów (`POST /api/documents`, `GET /api/documents/:id/content`) nie przyjmują ani nie wydają obiektów spod `photos/`, i odwrotnie — patrz [NEWS.md](NEWS.md).

## Dane w PostgreSQL

Migracja `postgres/migrations/0006_documents.sql` rozszerza tabelę `documents` (szczegóły skutków: [postgres/README.md](../postgres/README.md)). Wpis dokumentu jest niezmienny: `UPDATE` i `DELETE` zwracają błąd. Pola `retention_policy` i `retain_until` czekają na decyzję D-04; wartość `NULL` znaczy „retencja nieustalona — nie usuwać”. Usuwanie po okresie retencji będzie osobnym, audytowanym mechanizmem z własną migracją.

Zdarzenia w `audit_events`: `document.uploaded` (w tej samej transakcji co wpis), `document.downloaded` (przed wydaniem treści; błąd zapisu blokuje pobranie), `document.viewed` (podgląd inline, przed wydaniem treści), `document.preview_blocked` (podgląd odmówiony, bo plik nie przechodzi bieżącej kontroli struktury — bez wydania treści), `document.access_denied`.

## Konfiguracja

Zmienne ustawiane wyłącznie jako zmienne/secrets usługi Railway (odwołania do zmiennych bucketu), nigdy w repozytorium ani w buildzie frontendu:

| Zmienna | Źródło w Railway | Znaczenie |
|---|---|---|
| `BUCKET_ENDPOINT` | `${{Bucket.ENDPOINT}}` | adres API S3 (tylko `https://`) |
| `BUCKET_REGION` | `${{Bucket.REGION}}` | region podpisu (np. `auto`) |
| `BUCKET_NAME` | `${{Bucket.BUCKET}}` | nazwa bucketu w API S3 |
| `BUCKET_ACCESS_KEY_ID` | `${{Bucket.ACCESS_KEY_ID}}` | identyfikator klucza |
| `BUCKET_SECRET_ACCESS_KEY` | `${{Bucket.SECRET_ACCESS_KEY}}` | klucz tajny |
| `BUCKET_URL_STYLE` | opcjonalnie | `virtual` (domyślnie) albo `path` dla starszych bucketów — zgodnie z zakładką Credentials |
| `DOCUMENT_MAX_BYTES` | opcjonalnie | limit pliku w bajtach |
| `DOCUMENT_MAX_CONCURRENT_UPLOADS` | opcjonalnie | limit równoczesnych uploadów na proces, domyślnie 4 |

Brak wszystkich zmiennych `BUCKET_*` oznacza brak magazynu (trasy dokumentów zwracają 503). Częściowa konfiguracja zatrzymuje start serwera. Każde środowisko Railway ma osobny bucket z osobnymi poświadczeniami. Region bucketu (UE) wybiera się przy tworzeniu i nie da się go zmienić — sprawdzić osobno od regionu aplikacji i bazy. Klient S3 jest zaimplementowany w `src/storage.js` (AWS Signature V4 na `node:crypto` i `fetch`, bez dodatkowych zależności; testy sprawdzają opublikowane wektory AWS).

## Staging na syntetycznym pliku

1. Utworzyć bucket w środowisku staging (region UE) i przekazać zmienne `BUCKET_*` usłudze staging. Nie używać bucketu produkcyjnego.
2. `APP_ENV=staging npm run storage:smoke` — zapisuje wygenerowany syntetyczny PDF pod `smoke/<uuid>`, odczytuje go, porównuje SHA-256 i usuwa. Skrypt odmawia działania przy `APP_ENV=production` oraz przy braku lub nieznanej wartości `APP_ENV` i nie wypisuje adresu, nazwy bucketu ani kluczy.
3. Po migracji `0006` na bazie staging i zalogowaniu syntetycznego skarbnika z MFA: przesłać syntetyczny PDF przez `POST /api/documents`, pobrać go, sprawdzić nagłówki, a następnie potwierdzić `404` dla konta przedstawiciela klasy i dla losowego identyfikatora oraz wpisy w `audit_events`.
4. Nie używać prawdziwych faktur, wyciągów, protokołów ani plików z nazwiskami.

## Kopie zapasowe i odtworzenie

Railway nie wykonuje kopii bucketów; obiekty nie mają wersjonowania ani blokady (object lock). Usunięty bucket można przywrócić tylko przez 52 godziny. Przed produkcją trzeba więc: ustalić z administratorem danych kopię obiektów `docs/` do drugiej, prywatnej lokalizacji w UE (D-05), wykonywać ją razem z backupem PostgreSQL i przeprowadzić próbę odtworzenia bazy i dokumentów, weryfikując SHA-256 z tabeli `documents`. Procedury operacyjne Railway opisuje dokument operacyjny z issue #41 (`docs/RAILWAY_OPERATIONS.md` po jego scaleniu).

## Ryzyka i ograniczenia

- Brak skanu antywirusowego. PDF może zawierać aktywną treść; pobieranie jako załącznik z `sandbox` i `nosniff` ogranicza ryzyko w przeglądarce, ale nie po otwarciu pliku lokalnie.
- Obiekt zapisany w buckecie, dla którego nie powstał wpis w bazie (błąd lub przegrany wyścig), jest usuwany w trybie „best effort”; przy awarii sieci może zostać osierocony obiekt bez danych osobowych w kluczu.
- Plik jest buforowany w pamięci serwera (do limitu rozmiaru); przy wielu równoczesnych przesłaniach trzeba obserwować pamięć usługi.
- Pole `documents.source_document_id` w księdze wskazuje dokument, ale API księgi nie jest jeszcze na PostgreSQL (#38).
- Retencja (D-04), kopie obiektów (D-05) i macierz dostępu (D-08, D-09) wymagają decyzji zarządu i szkoły przed pracą na prawdziwych dokumentach.
