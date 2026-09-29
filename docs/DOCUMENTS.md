# Prywatne dokumenty w Railway Storage Bucket

Status: prototyp (issue #39, część #8 i #31). **Niewdrożony i niezatwierdzony do pracy na dokumentach rodzin ani prawdziwych dowodach finansowych.** Zastępuje planowany wcześniej Cloudflare R2.

## Zasada

Plik trafia do prywatnego Railway Storage Bucket (API S3) w regionie UE. Metadane, uprawnienia i dziennik są w PostgreSQL. Bucket nigdy nie jest publiczny, a przeglądarka nie dostaje adresu bucketu ani podpisanego linku: serwer Node sprawdza sesję i uprawnienia, zapisuje zdarzenie w dzienniku, pobiera obiekt i dopiero wtedy przekazuje go użytkownikowi (proxy). Podpisane adresy (presigned URL) nie są używane; gdyby kiedyś były potrzebne, ich ważność nie może przekraczać 60 sekund i wymagają osobnego przeglądu.

## Rodzaje dokumentów i dostęp

Macierz jest **założeniem technicznym do zatwierdzenia** przez zarząd i szkołę (D-08, D-09 w [DECISIONS.md](DECISIONS.md)). Odpowiada obecnym uprawnieniom API księgi.

| Rodzaj (`kind`) | Przykład | Odczyt i przesyłanie | MFA |
|---|---|---|---|
| `financial` | faktura, potwierdzenie przelewu, wyciąg | `admin`, `board`, `treasurer` bez ograniczenia do klasy | tak |
| `board` | protokół zarządu, uchwała | `admin`, `board` bez ograniczenia do klasy | nie |
| `class` | materiał jednej klasy | `admin`, `board` oraz `representative` wyłącznie przypisanej klasy | nie |

- Dyrekcja (`principal`) i Komisja Rewizyjna (`audit`) nie mają dostępu do czasu decyzji D-09.
- Przydział ograniczony do klasy nie otwiera dokumentów `financial` ani `board`, także dla roli `board`.
- Przydział z rokiem szkolnym działa tylko dla dokumentów tego roku. Wygasły lub cofnięty przydział traci dostęp od następnego żądania.
- Autoryzacja jest liczona **dla każdego dokumentu** z jego rodzaju, roku i klasy zapisanych w bazie, nie z parametrów żądania.

## API

| Metoda i ścieżka | Opis |
|---|---|
| `POST /api/documents?kind=…&schoolYearId=…[&classId=…][&linkedEntityType=…&linkedEntityId=…]` | Przesłanie pliku. Ciało to surowe bajty pliku; wymagane nagłówki `Content-Type` i `Idempotency-Key` (8–128 znaków). `classId` wyłącznie dla `class`. Powiązanie (`ledger_entry` albo `payment_entry` z tego samego roku) wyłącznie dla `financial`. |
| `GET /api/documents?schoolYearId=…[&kind=…][&classId=…][&status=active|all][&category=…][&q=…][&limit=…][&offset=…]` | Lista metadanych dostępnych użytkownikowi (najwyżej 100 na stronę), z tytułem i kategorią najnowszej wersji opisu. Domyślnie (`status=active`, też brak parametru) pokazuje tylko dokumenty aktywne; `status=all` pokazuje też zastąpione i unieważnione. `q` szuka w tytule i opisie (`ILIKE`, znaki specjalne wzorca uciekane); filtry i paginacja liczą się w SQL przed `LIMIT`. |
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

## Tytuł, kategoria i wyszukiwanie (issue #76)

`documents` pozostaje niezmienne (zasada z issue #39/#8). Osobna, dopisywana tabela `document_descriptions` przechowuje tytuł (3–200 znaków), kategorię z zamkniętej listy (`faktura`, `potwierdzenie_przelewu`, `wyciag`, `protokol`, `uchwala`, `umowa`, `regulamin`, `sprawozdanie_rewizyjne`, `inne` — założenie do zatwierdzenia przez zarząd i skarbnika), opcjonalną datę dokumentu i opcjonalny opis (do 1000 znaków). Zmiana opisu **nie edytuje** poprzedniego wiersza — dodaje kolejną wersję (`revision_no`); poprzednie wersje zostają w historii (`GET /api/documents/{id}`). Obowiązuje najnowsza wersja.

Dokument bez żadnego wpisu opisu (istniejące dokumenty sprzed tej migracji, albo taki, dla którego nikt jeszcze nie dodał tytułu) ma `title: null` — panel pokazuje wtedy „Bez tytułu”, nie błąd.

**Ostrzeżenie dla osoby wypełniającej formularz:** tytuł nie powinien zawierać imion i nazwisk uczniów ani rodziców — trafia do listy widocznej dla każdego z dostępem do danego rodzaju dokumentu (np. „Faktura — wynajem sali, październik”, nie „Faktura za obóz Jasia Kowalskiego”). To nie jest wymuszone technicznie.

Dziennik: `document.described` zapisuje aktora, czas, identyfikator dokumentu, kategorię i numer wersji — **bez tytułu ani opisu** (mogą zawierać treść opisową dokumentu).

Zamrożenie roku (issue #76/#313, `postgres/migrations/0106_document_descriptions_year_freeze.sql`): `document_descriptions` nie ma własnej kolumny `school_year_id` — rok ustala dokument-rodzic (`documents.school_year_id`, `FOR UPDATE` blokuje wiersz `documents` przed zapisem opisu, więc sprawdzenie jest spójne z numerowaniem wersji). Nowy opis dokumentu przypisanego do zamkniętego roku kończy się `409 school_year_closed`; dokumenty bez `school_year_id` (np. przywrócone z D1) nie są objęte — jak przy samym `documents` (`postgres/README.md`, `docs/YEAR_CLOSE.md`).

**Poza zakresem tej wersji:** panel — wybór roku i klasy z listy serwera (dziś pole tekstowe) to osobny zakres.

## Walidacja pliku

- Dozwolone typy: PDF, PNG, JPEG. Typ jest ustalany po sygnaturze pliku (magic bytes) i musi zgadzać się z zadeklarowanym `Content-Type`. Plik HTML, skrypt, dokument biurowy czy CSV z nagłówkiem PDF zostanie odrzucony.
- CSV nie jest dopuszczony: nie ma sygnatury, a zwykle zawiera listy osób. Import rodzin ma osobny przepływ ([import/README.md](../import/README.md)).
- Limit rozmiaru: `DOCUMENT_MAX_BYTES`, domyślnie 10 MiB, najwyżej 25 MiB. Serwer Node podnosi limit ciała żądania wyłącznie dla `POST /api/documents`; wszystkie inne trasy nadal mają 1 MiB. Trasa sama liczy bajty podczas odczytu, niezależnie od `Content-Length`.
- **Sesja przed ciałem** (#185): dla `POST /api/documents` serwer Node NIE buforuje ciała przed wywołaniem trasy — trafia ono do żądania jako strumień, a `readLimited` (`src/documents.js`) czyta go dopiero PO sprawdzeniu sesji, roli i typu. Żądanie bez ważnej sesji z dużym zadeklarowanym `Content-Length` kosztuje pamięci tyle co zwykłe odrzucenie `401`, nie tyle co upload. Połączenie jest wtedy jawnie zamykane (`Connection: close`), żeby nieprzeczytane bajty nie zawisły na współdzielonym gnieździe keep-alive.
- **Limit równoczesnych uploadów na proces**: `DOCUMENT_MAX_CONCURRENT_UPLOADS` (domyślnie 4). Piąty i kolejny równoczesny `POST /api/documents` dostaje `503 upload_busy` z `Retry-After` BEZ odczytu ciała. Limit jest na proces, nie na klaster Railway (kilka instancji ma osobne liczniki) — do rozważenia przy skalowaniu poziomym.
- Skan antywirusowy nie jest jeszcze dostępny (ryzyko opisane niżej).
- **Kontrola struktury (issue #89, heurystyka, NIE zastępuje skanu antywirusowego):** po zgodności sygnatury i typu serwer sprawdza surowe bajty pliku (`src/documents.js#validateStructure`) i odrzuca `415`:
  - `document_active_content` — PDF zawierający (nieskompresowane) słowa kluczowe `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/XFA` albo `/Encrypt` (szyfrowanie uniemożliwia dalszą kontrolę treści, więc traktujemy je tak samo);
  - `document_malformed` — PDF bez `%%EOF` w ostatnim 1 KiB (np. poliglota z dołożonymi danymi po właściwej treści), PNG z uszkodzonym łańcuchem chunków albo danymi po `IEND`, JPEG bez `FF D9` na końcu (po odjęciu dopuszczalnego dopełnienia zerami).
  - **Ograniczenie:** to kontrola surowych bajtów, nie parser PDF. Strumienie PDF bywają skompresowane (`FlateDecode`) — słowo kluczowe wewnątrz skompresowanego strumienia nie zostanie wykryte. Reguła wymaga przeglądu przed włączeniem na prawdziwych, zanonimizowanych plikach z banku (ryzyko fałszywych odrzuceń podpisanych/zaszyfrowanych PDF-ów).
  - Nazwy PDF zapisane szesnastkowo (`/J#61vaScript`) są dekodowane przed porównaniem, żeby nie omijały listy. `/OpenAction` odrzucamy tylko, gdy akcja jest wpisana w miejscu (`/OpenAction << … >>`); cel-strona (`[ … ]`) i odnośnik (`5 0 R`) przechodzą, a odnośnik do akcji ze skryptem wychwytuje słowo kluczowe akcji. Pełne odrzucanie `/OpenAction` dałoby fałszywe odrzucenia PDF z banku.
  - Ta wersja **nie** obejmuje: kolumny `validation_version` w `documents` ani renderowania PDF przez samodzielnie hostowany PDF.js (zależność wymaga decyzji D-05) — to osobny zakres (część issue #89 pozostaje otwarta).

## Podgląd w panelu (issue #89)

`GET /api/documents/{id}/content?disposition=inline` wydaje PDF, PNG albo JPEG do wyświetlenia w panelu bez zapisu na dysku. Wartość `attachment` (i brak parametru) to dotychczasowe pobranie; każda inna wartość daje `400 invalid_disposition`.

- **Autoryzacja przy każdym żądaniu.** Nie ma adresu z tokenem ani podpisanego adresu do bucketu: przeglądarka woła ten sam endpoint serwera z ciasteczkiem sesji, a serwer liczy sesję, rolę, MFA, rok i klasę jak przy pobraniu. Wygaśnięcie sesji lub przydziału odcina podgląd od następnego żądania; skopiowany adres nie działa bez sesji (`401`). Dokument niedostępny dla roli i nieznany dają ten sam `404` (przy istniejącym dokumencie — zapis `document.access_denied`). Bucket pozostaje prywatny, treść przechodzi przez serwer.
- **Nagłówki odpowiedzi podglądu:** `Content-Disposition: inline`, `Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'self'` (bez `allow-scripts` i `allow-same-origin`), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`. Tylko ta odpowiedź dostaje `X-Frame-Options: SAMEORIGIN` (reszta serwera zostaje przy `DENY`), żeby panel mógł osadzić PDF we własnej ramce.
- **Panel:** obraz jako `<img>`, PDF w `<iframe sandbox="">` (pusty atrybut = brak skryptów, formularzy i dostępu do originu panelu). CSP paneli bez zmian (`script-src 'self'`, `img-src 'self' data:`, `default-src 'self'` obejmuje ramkę własnego originu).
- **Dziennik:** podgląd zapisuje `document.viewed` (aktor, czas, identyfikator dokumentu, rodzaj, rok, klasa, sesja) przed wydaniem treści — błąd zapisu blokuje podgląd. Pobranie nadal zapisuje `document.downloaded`.
- **Ograniczenie:** to wbudowany czytnik PDF przeglądarki, nie PDF.js. Niektóre przeglądarki (m.in. Chrome) odmawiają renderowania PDF w ramce z `sandbox`; wtedy panel pokazuje wskazówkę, że należy pobrać plik. Zabezpieczenia (CSP `sandbox` bez skryptów, kontrola struktury) nie zależą od tego, czy podgląd się wyświetli. Wariant z PDF.js (kryterium akceptacji issue #89) czeka na D-05.

## Klucz obiektu i dane osobowe

Klucz w buckecie ma postać `docs/<losowy uuid>`, niezależny od identyfikatora dokumentu w API. Nie zawiera nazwy pliku, roku, klasy, rodziny ani użytkownika; wymusza to ograniczenie w bazie. Oryginalna nazwa pliku **nie jest zapisywana** (często zawiera nazwisko). Plik do pobrania dostaje nazwę technyczną `dokument-<id>`. Dziennik zapisuje wyłącznie identyfikatory, rodzaj, typ, rozmiar i SHA-256 — bez nazwy pliku, treści i danych osobowych.

Bucket nie może zawierać zdjęć archiwalnych ani wizerunku dzieci: publikacja zdjęć wymaga osobnego sprawdzenia praw i zgód (AGENTS.md). Od #96 zdjęcia galerii mają osobny prefiks `photos/<losowy uuid>` w tym samym prywatnym buckecie (moduł `src/pg/news.js`, migracja `postgres/migrations/0084_news_photo_files.sql`) — oddzielny od `docs/` używanego przez ten moduł, żeby dowody finansowe/dokumenty zarządu i zdjęcia galerii się nie mieszały. Trasy dokumentów (`POST /api/documents`, `GET /api/documents/:id/content`) nie przyjmują ani nie wydają obiektów spod `photos/`, i odwrotnie — patrz [NEWS.md](NEWS.md).

## Dane w PostgreSQL

Migracja `postgres/migrations/0006_documents.sql` rozszerza tabelę `documents` (szczegóły skutków: [postgres/README.md](../postgres/README.md)). Wpis dokumentu jest niezmienny: `UPDATE` i `DELETE` zwracają błąd. Pola `retention_policy` i `retain_until` czekają na decyzję D-04; wartość `NULL` znaczy „retencja nieustalona — nie usuwać”. Usuwanie po okresie retencji będzie osobnym, audytowanym mechanizmem z własną migracją.

Zdarzenia w `audit_events`: `document.uploaded` (w tej samej transakcji co wpis), `document.downloaded` (przed wydaniem treści; błąd zapisu blokuje pobranie), `document.viewed` (podgląd inline, przed wydaniem treści), `document.access_denied`.

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
