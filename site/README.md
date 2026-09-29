# Strona publiczna

Strona tylko do odczytu dla rodziców i gości: Rada Rodziców Szkoły Polskiej im. Joachima Lelewela w Brukseli. Prototyp; nie jest to gotowe wdrożenie.

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

Strona nie ma własnego API i nie zmienia danych.

## Zasady

- Żądania z `credentials: "omit"`: brak ciasteczek sesji, brak `localStorage`.
- Dane z API trafiają do DOM wyłącznie przez `textContent` (test w `tests/site-core.test.js`).
- Czas wyświetlany w strefie `Europe/Brussels`; wydarzenia zakończone są ukrywane (bez godziny końca: po zakończeniu dnia).
- Puste stany: „Brak opublikowanych wydarzeń.”, „Brak opublikowanych protokołów.”.
- Wydruk: nawigacja ukryta, treść protokołów rozwinięta.

## Założenia

- Identyfikator roku szkolnego ma postać `2026-2027`, a rok zaczyna się 1 września. Parametr `?rok=` pozwala wskazać inny rok. Do zastąpienia publiczną listą lat szkolnych, gdy API ją udostępni.
- Brak danych kontaktowych i zdjęć do czasu decyzji o treści i zgodach (docs/DESIGN.md).
