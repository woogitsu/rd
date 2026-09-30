# Aktualności i galeria po weryfikacji praw (#14)

Status: API na PostgreSQL i panel `news/` — prototyp dla nowego stosu Node.js + PostgreSQL (migracja `0018_news.sql`, moduł `src/pg/news.js`, trasy `src/pg/routes/news.js`). Działa wyłącznie na danych syntetycznych. **Nie jest gotowy do publikowania zdjęć ani treści dotyczących rodzin** — zasady publikacji zdjęć (D-18) i uprawnienia (D-08) nie są jeszcze zatwierdzone.

## Zasady

- Na stronę publiczną trafia tylko opublikowana wersja wpisu, zatwierdzona przez inną osobę niż autor wpisu i autor tej wersji (cztery oczy — w serwisie i w triggerze bazy).
- Zdjęcie może pojawić się w zatwierdzanym lub publikowanym wpisie tylko wtedy, gdy jego prawa zostały zweryfikowane przez inną osobę niż ta, która je zarejestrowała. Trigger bazy blokuje zatwierdzenie i publikację wpisu z niezweryfikowanym lub cofniętym zdjęciem, także przy zapisie z pominięciem API.
- Każde zdjęcie ma autora, źródło, datę wykonania i tekst licencji/zgody na publikację (publiczny podpis). Opcjonalnie: opis źródła i wewnętrzną notatkę o prawach (niepubliczną).
- **Tekst alternatywny jest obowiązkowy** (#124, WCAG 1.1.1): przy rejestracji zdjęcia trzeba podać `altText` (opis sceny, bez imion i nazwisk dzieci) albo jawnie zaznaczyć `decorative = true` (zdjęcie czysto ozdobne — na stronie publicznej dostanie puste `alt=""`, zgodnie ze standardem). Ponieważ metadane są niezmienne, to jedyny moment na tę decyzję — nie da się dodać opisu później inaczej niż nowym rekordem zdjęcia. Ograniczenie bazy `news_photo_alt_text_required` (`0071_news_photo_alt_text_required.sql`) i tak blokuje zapis (w tym weryfikację) bez jednego z nich; zdjęcia sprzed tej migracji zostają bez zmian i widoczne w widoku `news_photos_missing_alt_text` („do uzupełnienia opisu”).
- Zdjęcie z dziećmi (`depictsChildren = true`) nie może zostać zweryfikowane bez co najmniej jednego odwołania do zgody dotyczącej dziecka. Liczba odwołań musi też pokrywać liczbę rozpoznawalnych dzieci (`identifiableChildren`) i dorosłych (`identifiableAdults`).
- Odwołanie do zgody to wyłącznie identyfikator dokumentu zgody (np. `consent-doc-0001`) i rodzaj osoby (`child`/`adult`). **Nie zapisujemy imion, nazwisk ani klas osób na zdjęciu.** Jedna zgoda może obejmować rodzeństwo (dwa numery osoby, ten sam dokument).
- Źródło `public_website_copy` (kopia z publicznej strony, np. galerii szkoły) jest odrzucane, chyba że zapisano wyraźne udzielenie licencji (`explicitLicenseGranted = true`) i odwołanie do dokumentu licencji. Sama publiczna dostępność zdjęcia nie daje prawa do jego skopiowania.
- Metadanych zdjęcia i jego zgód nie można zmienić ani usunąć. Korekta = nowe zdjęcie (nowy rekord). Zgody można dopisywać tylko przed weryfikacją.
- Plik zdjęcia jest w prywatnym magazynie dokumentów (`document_id`). Same metadane zdjęcia nie zawierają pliku. Pliki obrazów galerii (warianty `web` i `thumb`) oraz publiczna ścieżka obrazu tylko dla zdjęć zweryfikowanych w opublikowanych wpisach są już w kodzie — patrz punkt „Plik obrazu galerii (#96)” niżej.
- **Plik obrazu galerii (#96, osobno od `document_id` powyżej).** `POST /api/news-photos/:id/file` przyjmuje surowe bajty PNG/JPEG (admin, zarząd — przydział bez klasy), ponownie koduje je przez `sharp` do JPEG i zapisuje wyłącznie warianty `web` (maks. 1600 px) i `thumb` (maks. 400 px) pod osobnym prefiksem `photos/` w tym samym prywatnym buckecie co dokumenty (`postgres/migrations/0084_news_photo_files.sql`). Ponowne kodowanie odrzuca EXIF/GPS/XMP i honoruje orientację EXIF przed jej usunięciem. **WARIANT ZACHOWAWCZY (brak D-18/D-04/D-05): oryginał nie jest przechowywany** — jeśli zarząd zdecyduje inaczej, potrzebna będzie kolejna migracja i osobna, bardziej restrykcyjna polityka dostępu do oryginału. Jedno zdjęcie = jeden zestaw plików; ponowne przesłanie innego pliku dla zdjęcia, które już ma plik, kończy się `409 photo_file_exists` (korekta = nowe zdjęcie, jak przy metadanych). Serwer Node nie buforuje ciała tej trasy (#185): uprawnienie, magazyn, typ i zadeklarowana długość są sprawdzane przed odczytem, a limit równoczesnych uploadów (na proces i na użytkownika) jest wspólny z `POST /api/documents` (`503 upload_busy` z `Retry-After`). `GET /api/public/news-photos/:id/{web|thumb}` wydaje wariant tylko dla zdjęcia zweryfikowanego i należącego do opublikowanej wersji niewycofanego wpisu — to samo kryterium co `public_news`; nieznane zdjęcie, wariant bez pliku i zdjęcie niepubliczne dają identyczną odpowiedź `404`.

## Przebieg wpisu

Szkic → zgłoszenie → zatwierdzenie → publikacja. Wycofanie jest możliwe na każdym etapie i jest ostateczne.

- Każda zmiana treści (tytuł, treść, lista zdjęć) tworzy nową, niezmienną wersję w `news_post_revisions` i cofa wpis do szkicu. Opublikowana wersja pozostaje publiczna, dopóki nowa nie zostanie zatwierdzona i opublikowana.
- Zmiana i każdy krok wymagają numeru widzianej wersji (`revision`); nieaktualny numer daje `409 revision_conflict`. Ponowienie tego samego kroku zwraca `replayed: true` bez nowego wpisu w dzienniku.
- Wycofanie wymaga powodu (3–500 znaków, widoczny tylko wewnętrznie) i natychmiast usuwa wpis z widoku publicznego. Cofnięcie praw do zdjęcia (np. wycofanie zgody) natychmiast usuwa to zdjęcie z opublikowanych wpisów. Publiczna odpowiedź ma `Cache-Control: public, max-age=60`, więc przeglądarka lub pośrednik może pokazywać starą wersję najwyżej 60 s.
- Wpisów, wersji, zdjęć i zgód nie można usuwać.

## Treść: tekst, nie HTML

Tytuł i treść są przechowywane dosłownie jako tekst (końce linii ujednolicone do `\n`, odrzucane znaki sterujące). API nie interpretuje ani nie czyści HTML — zwraca dokładnie zapisany tekst w JSON z `X-Content-Type-Options: nosniff`. **Interfejs musi wstawiać go jako tekst** (`textContent`, escapowanie w szablonie), nigdy przez `innerHTML`. Formatowanie (np. Markdown) wymagałoby osobnej decyzji i sanitizacji.

## Uprawnienia (założenie do decyzji D-08 i D-18)

| Działanie | Kto |
|---|---|
| Szkic, zmiana, zgłoszenie, podgląd wewnętrzny | admin, zarząd (przydział bez klasy); przedstawiciel klasy tylko dla wpisów własnej klasy i bez zdjęć |
| Zatwierdzenie, publikacja, wycofanie opublikowanego | zarząd |
| Wycofanie nieopublikowanego | jak przy szkicu |
| Rejestracja zdjęcia i odwołań do zgód | admin, zarząd |
| Przesłanie pliku zdjęcia (warianty web/thumb) | admin, zarząd |
| Weryfikacja i cofnięcie praw do zdjęcia | zarząd (inna osoba niż rejestrująca) |
| Publiczny odczyt pliku zdjęcia | wszyscy (tylko zdjęcia zweryfikowane w opublikowanej wersji) |

Przedstawiciel nie widzi wpisów innych klas (404 bez ujawniania istnienia). Skarbnik, Komisja Rewizyjna i dyrekcja nie mają dostępu do czasu decyzji D-08/D-09. Admin techniczny nie zatwierdza, nie publikuje i nie weryfikuje praw (PRODUCT.md). Założenie: kto weryfikuje zgody na wizerunek dzieci (zarząd, dyrekcja czy wyznaczona osoba szkoły) — do rozstrzygnięcia w D-18.

## API

- `GET /api/public/news?schoolYearId=&limit=` — bez logowania; limit do 50. Pola: `id`, `title`, `body`, `publishedAt`, `photos[]` z `id`, `author`, `source`, `license`, `takenOn`, `altText`, `decorative` (`altText` jest pustym tekstem `""`, gdy `decorative = true`). Bez identyfikatorów użytkowników, klas, dokumentów, zgód i notatek wewnętrznych.
- `GET /api/public/news/:postId` (#116) — stały adres jednego wpisu, bez logowania, te same pola i ta sama polityka co lista (`Cache-Control: public, max-age=60`). Szkic, wpis zatwierdzony, ale nieopublikowany, wpis wycofany i nieistniejący dają identyczne `404 post_not_found`. Publicznie widoczna jest wyłącznie opublikowana wersja; nowsza, niezatwierdzona wersja nie jest widoczna. Odpowiedź jak wszystkie trasy `/api/public/` nie ma `X-Robots-Tag: noindex`; panele i reszta `/api/` mają.
- Strona publiczna `site/` (#116): stały link do wpisu to `/site/#wpis-<id>` (fragment, bez nowej trasy HTML); strona pobiera wpis z `GET /api/public/news/:postId` i przy 404 pokazuje komunikat „Ten wpis nie jest dostępny” bez żadnej treści. Archiwum: `/site/?rok=RRRR-RRRR#aktualnosci` (`schoolYearId`, do 50 wpisów na rok); lista lat to ZAŁOŻENIE (bieżący i pięć poprzednich lat szkolnych) do czasu publicznej listy lat (#78). Czytniki i wyszukiwarki mogą zachować kopię wpisu po wycofaniu — poza zakresem tego PR.
- Strona publiczna `site/` (#96) wyświetla zdjęcia wyłącznie z `photos[]` tej odpowiedzi; adres pliku składa z `id` (`/api/public/news-photos/{id}/thumb|web`), `alt` bierze z `altText` (dekoracyjne: `alt=""`, zdjęcie bez opisu i bez `decorative` jest pomijane), używa `loading="lazy"` i podpisu (autor, źródło, licencja). Brak zdjęcia albo zgody = brak figury, bez komunikatu błędu; kontrola praw pozostaje po stronie serwera.
- `GET /api/news?schoolYearId=` — lista wewnętrzna.
- `POST /api/news` — szkic (`schoolYearId`, `classId?`, `title`, `body`, `photoIds?`); wymaga `Idempotency-Key`.
- `GET /api/news/:id` — szczegóły z historią wersji.
- `PATCH /api/news/:id` — nowa wersja; body z `revision`.
- `POST /api/news/:id/submit|approve|publish|withdraw` — body z `revision` (i `reason` przy wycofaniu).
- `GET /api/news-photos?status=pending|verified|revoked`, `GET /api/news-photos/:id` — rejestr zdjęć z odwołaniami do zgód.
- `POST /api/news-photos` — rejestracja metadanych (`documentId`, `author`, `source`, `sourceDetail?`, `takenOn`, `licenseText`, `explicitLicenseGranted?`, `licenseDocumentRef?`, `rightsNote?`, `altText?`, `decorative?`, `depictsChildren`, `identifiableChildren?`, `identifiableAdults?`, `consents?`); wymaga `Idempotency-Key`. `altText` albo `decorative = true` jest **wymagane** — inaczej `422 alt_text_required` (#124).
- `POST /api/news-photos/:id/consents` — `{ subjectNo, subjectKind, consentDocumentRef }`; ten sam wpis ponownie = powtórka, inny pod tym samym numerem = `409 consent_conflict`.
- `POST /api/news-photos/:id/verify` (body `{}`), `POST /api/news-photos/:id/revoke` (`{ reason }`).

Źródła: `own_work`, `school_provided`, `parent_provided`, `licensed_third_party`, `public_website_copy`. Zmiany wymagają nagłówka `Origin` tej samej domeny (inaczej `403 invalid_origin`), `Content-Type: application/json` i body do 64 KiB.

## Dziennik

Każdy krok zapisuje `audit_events` (aktor, czas, `entity_type` `news_post`/`news_photo`, identyfikator) w tej samej transakcji. Metadane zawierają tylko numer wersji, status, liczbę zdjęć, rodzaj źródła i liczby osób — bez tytułów, treści, powodów, autorów zdjęć i odwołań do zgód.

## Skutki migracji dla danych

`0018_news.sql` tylko dodaje tabele `news_photos`, `news_photo_consents`, `news_posts`, `news_post_revisions`, funkcje, triggery i widok `public_news`. Nie zmienia istniejących tabel ani wierszy. Wycofanie na pustej bazie: usunięcie tych obiektów; na bazie z danymi — tylko po kopii zapasowej i decyzji o retencji (D-04), bo zawiera historię zgód.

## Do decyzji

D-18 (zasady publikacji zdjęć, kto weryfikuje zgody i gdzie są przechowywane dokumenty zgód), D-08 (kto tworzy, zatwierdza i publikuje), D-04 (czas przechowywania wersji, zdjęć i odwołań do zgód, także po wycofaniu), D-09 (dostęp dyrekcji i Komisji Rewizyjnej). Zdjęcia archiwalne z nieznaną dokładną datą: założenie — wpisać przybliżoną datę i opisać to w `sourceDetail`.
