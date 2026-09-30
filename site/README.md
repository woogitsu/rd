# Strona publiczna

Strona tylko do odczytu dla rodziców i gości: Rada Rodziców Szkoły Polskiej w Brukseli. Prototyp; nie jest to gotowe wdrożenie.

## Uruchomienie

```bash
npm run dev:site      # Vite
npm run build:site    # dist/site, serwowane przez serwer Node pod /site/
```

## Źródła danych

| Sekcja | API | Uwagi |
|---|---|---|
| Najbliższe wydarzenia | `GET /api/public/events?from=RRRR-MM-DD&limit=200` | tylko opublikowane wersje; odwołane oznaczone „odwołane” |
| Protokoły zebrań | `GET /api/meetings/public-minutes?schoolYearId=` | tylko zatwierdzone z widocznością `public` |
| Zawiadomienia o zebraniach | `GET /api/meetings/public-notices?schoolYearId=` | tylko zatwierdzone zawiadomienia zebrań ogólnych (#113); odwołane oznaczone „odwołane”, bez powodu i opisów punktów |
| Aktualności | `GET /api/public/news` | odpowiedź `{ posts: [...] }` (`listPublic`); przy 404 sekcja pozostaje ukryta |
| Wpis pod stałym adresem | `GET /api/public/news/{id}` | adres `/site/aktualnosci/<id>` (strona serwera, #116); dawne `/site/#wpis-<id>` nadal działa; wycofany, nieopublikowany i nieznany: 404 i komunikat bez treści |
| Archiwum aktualności | `GET /api/public/news?schoolYearId=&limit=50&cursor=` | `/site/?rok=RRRR-RRRR#aktualnosci` i „Starsze wpisy” (`?kursor=`, `nextCursor` z API) do najstarszego wpisu |
| Lata w archiwum | `GET /api/public/school-years` | tylko lata z treściami publicznymi; gdy API nie odpowie — bieżący i 5 poprzednich (założenie awaryjne) |
| Zdjęcia w aktualnościach | `GET /api/public/news-photos/{id}/{thumb\|web}` | adres budowany wyłącznie z `id` z `photos[]`; `alt` z bazy (dekoracyjne: `alt=""`), `loading="lazy"`, podpis: autor, źródło, licencja. Zdjęcie bez zgody/weryfikacji nie jest w `photos[]`, a plik daje 404 — figura znika bez komunikatu. |

Strona nie ma własnego API i nie zmienia danych.

## Renderowanie po stronie serwera (#116)

W trybie PostgreSQL serwer Node (`src/pg/public-site.js`, wpięty w `src/server.js` jako `siteHandler`) wydaje:

| Adres | Treść |
|---|---|
| `/site/` | zbudowany `dist/site/index.html` z wypełnionymi sekcjami (aktualności, wydarzenia, zawiadomienia, protokoły), `canonical` i Open Graph; znaczniki podmiany: `INDEX_MARKERS` (test w `tests/public-site.test.js`) |
| `/site/aktualnosci/<id>` | strona wpisu: tytuł, treść, zdjęcia dopuszczone przez `public_news`, `canonical`, `meta description`, Open Graph bez `og:image` |
| `/site/wydarzenia/<id>` | strona wydarzenia z mikrodanymi schema.org/Event |
| `/site/feed.xml` | kanał Atom (20 wpisów, bez zdjęć) |
| `/site/sitemap.xml` | mapa strony (tylko `/site/`) |

Tekst z bazy przechodzi wyłącznie przez szablon `h` z automatycznym escapowaniem; bez wstawianych stylów i skryptów (CSP `script-src 'self'; style-src 'self'` jak dla plików statycznych). Brak szablonu, szablon niezgodny albo błąd bazy na stronie głównej: zwykły plik statyczny, a JavaScript wczytuje dane z API. Tryb Workera/D1 niczego tu nie zmienia (plik statyczny). Kanał Atom sprawdzono walidatorem W3C (`check.cgi`, dane syntetyczne): poprawny.

## Zasady

- Żądania z `credentials: "omit"`: brak ciasteczek sesji, brak `localStorage`.
- Dane z API trafiają do DOM wyłącznie przez `textContent` (test w `tests/site-core.test.js`).
- Kalendarz (#122): przy nieodwołanym wydarzeniu link „Dodaj do kalendarza (.ics)” (`/api/public/events/:id.ics`), nad listą linki „subskrybuj (webcal)” i „pobierz plik .ics” do `/api/public/events.ics` (host z bieżącego adresu; bez `schoolYearId` kanał zawiera opublikowane wydarzenia z wszystkich lat, do 200). Kanał prywatny (klasy, zebrania) poza zakresem (D-08).
- Czas wyświetlany w strefie `Europe/Brussels`; wydarzenia zakończone są ukrywane (bez godziny końca: po zakończeniu dnia).
- Puste stany: „Brak opublikowanych wydarzeń.”, „Brak opublikowanych protokołów.”.
- Wydruk: nawigacja ukryta, treść protokołów rozwinięta.

## Założenia

- Identyfikator roku szkolnego ma postać `2026-2027`, a rok zaczyna się 1 września. Parametr `?rok=` pozwala wskazać inny rok. Domyślny rok protokołów i zawiadomień nadal wynika z daty (lista lat do archiwum aktualności pochodzi z `GET /api/public/school-years`).
- Adresy bezwzględne (`canonical`, `og:url`, kanał, mapa) biorą origin z `PUBLIC_BASE_URL`; bez niej — z nagłówka `Host` (tylko lokalnie).
- Brak danych kontaktowych i zdjęć do czasu decyzji o treści i zgodach (docs/DESIGN.md).
