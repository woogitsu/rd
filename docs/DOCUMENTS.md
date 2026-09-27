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
| `GET /api/documents?schoolYearId=…[&kind=…][&classId=…][&limit=…][&offset=…]` | Lista metadanych dostępnych użytkownikowi (najwyżej 100 na stronę). |
| `GET /api/documents/{id}` | Metadane jednego dokumentu. |
| `GET /api/documents/{id}/content` | Pobranie pliku po autoryzacji. |

Odpowiedzi:

- `401 unauthenticated` bez ważnej sesji.
- `404 not_found` zarówno dla nieistniejącego identyfikatora, jak i dokumentu, do którego użytkownik nie ma dostępu (w tym brak MFA przy `financial`). Odpowiedź jest identyczna, więc nie da się zgadywaniem ustalić, czy dokument istnieje. Odmowa dla istniejącego dokumentu jest zapisywana jako `document.access_denied`.
- `403 forbidden` przy przesyłaniu, gdy rola nie pozwala dodać dokumentu danego rodzaju w danym roku lub klasie; `403 invalid_origin` przy żądaniu z innego origin.
- `413 document_too_large`, `415 unsupported_media_type`, `400` dla błędnych parametrów, `409 idempotency_conflict` gdy ten sam klucz przyszedł z inną treścią.
- `503 storage_unavailable`, gdy bucket nie jest skonfigurowany; `503 service_unavailable` przy błędzie magazynu lub niezgodności sumy kontrolnej.

Ponowienie tego samego żądania (podwójne kliknięcie, ponowiona sieć) z tym samym `Idempotency-Key` zwraca `200` z `replayed: true` i tym samym dokumentem; nie powstaje drugi wpis ani drugi obiekt.

Pobranie ma nagłówki `Content-Disposition: attachment; filename="dokument-<id>.<ext>"`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cross-Origin-Resource-Policy: same-origin` i `Referrer-Policy: no-referrer`. Przed wydaniem pliku serwer porównuje rozmiar i SHA-256 obiektu z bazą; niezgodność blokuje pobranie.

## Walidacja pliku

- Dozwolone typy: PDF, PNG, JPEG. Typ jest ustalany po sygnaturze pliku (magic bytes) i musi zgadzać się z zadeklarowanym `Content-Type`. Plik HTML, skrypt, dokument biurowy czy CSV z nagłówkiem PDF zostanie odrzucony.
- CSV nie jest dopuszczony: nie ma sygnatury, a zwykle zawiera listy osób. Import rodzin ma osobny przepływ ([import/README.md](../import/README.md)).
- Limit rozmiaru: `DOCUMENT_MAX_BYTES`, domyślnie 10 MiB, najwyżej 25 MiB. Serwer Node podnosi limit ciała żądania wyłącznie dla `POST /api/documents`; wszystkie inne trasy nadal mają 1 MiB. Trasa sama liczy bajty podczas odczytu, niezależnie od `Content-Length`.
- Skan antywirusowy nie jest jeszcze dostępny (ryzyko opisane niżej).

## Klucz obiektu i dane osobowe

Klucz w buckecie ma postać `docs/<losowy uuid>`, niezależny od identyfikatora dokumentu w API. Nie zawiera nazwy pliku, roku, klasy, rodziny ani użytkownika; wymusza to ograniczenie w bazie. Oryginalna nazwa pliku **nie jest zapisywana** (często zawiera nazwisko). Plik do pobrania dostaje nazwę technyczną `dokument-<id>`. Dziennik zapisuje wyłącznie identyfikatory, rodzaj, typ, rozmiar i SHA-256 — bez nazwy pliku, treści i danych osobowych.

Bucket nie może zawierać zdjęć archiwalnych ani wizerunku dzieci: publikacja zdjęć wymaga osobnego sprawdzenia praw i zgód (AGENTS.md).

## Dane w PostgreSQL

Migracja `postgres/migrations/0006_documents.sql` rozszerza tabelę `documents` (szczegóły skutków: [postgres/README.md](../postgres/README.md)). Wpis dokumentu jest niezmienny: `UPDATE` i `DELETE` zwracają błąd. Pola `retention_policy` i `retain_until` czekają na decyzję D-04; wartość `NULL` znaczy „retencja nieustalona — nie usuwać”. Usuwanie po okresie retencji będzie osobnym, audytowanym mechanizmem z własną migracją.

Zdarzenia w `audit_events`: `document.uploaded` (w tej samej transakcji co wpis), `document.downloaded` (przed wydaniem treści; błąd zapisu blokuje pobranie), `document.access_denied`.

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

Brak wszystkich zmiennych `BUCKET_*` oznacza brak magazynu (trasy dokumentów zwracają 503). Częściowa konfiguracja zatrzymuje start serwera. Każde środowisko Railway ma osobny bucket z osobnymi poświadczeniami. Region bucketu (UE) wybiera się przy tworzeniu i nie da się go zmienić — sprawdzić osobno od regionu aplikacji i bazy. Klient S3 jest zaimplementowany w `src/storage.js` (AWS Signature V4 na `node:crypto` i `fetch`, bez dodatkowych zależności; testy sprawdzają opublikowane wektory AWS).

## Staging na syntetycznym pliku

1. Utworzyć bucket w środowisku staging (region UE) i przekazać zmienne `BUCKET_*` usłudze staging. Nie używać bucketu produkcyjnego.
2. `APP_ENV=staging npm run storage:smoke` — zapisuje wygenerowany syntetyczny PDF pod `smoke/<uuid>`, odczytuje go, porównuje SHA-256 i usuwa. Skrypt odmawia działania przy `APP_ENV=production` i nie wypisuje adresu, nazwy bucketu ani kluczy.
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
