# Serwer Node.js dla Railway

Ten etap dodaje wspólny proces HTTP dla Railway. Serwer nasłuchuje na `0.0.0.0:$PORT`, udostępnia zbudowane aplikacje i przekazuje pozostałe żądania do dotychczasowego routera API.

## Uruchomienie lokalne

```bash
npm ci
npm run build
PORT=3000 npm start
```

Dostępne ścieżki:

- `/import/` — import uczniów i rodzin,
- `/panel/` — panel składek,
- `/ledger/` — księga,
- `/health` — wyłącznie techniczny status procesu (`{"status":"ok"}`), bez danych użytkowników.

Brakujący plik zwraca odpowiedź `404`; serwer nie zastępuje go plikiem `index.html`. Mapy źródłowe (`*.map`), pliki ukryte i ścieżki wychodzące poza `dist/` nie są publikowane. Odpowiedzi HTML i API mają `Cache-Control: no-store`, a statyczne zasoby mają krótki cache wynoszący godzinę.

## Zmienne środowiskowe

| Zmienna | Wymagana | Znaczenie |
|---|---:|---|
| `PORT` | na Railway | Port przydzielony procesowi; lokalnie domyślnie `3000` |
| `PUBLIC_BASE_URL` | opcjonalna | Publiczny adres bazowy używany przy tworzeniu obiektu `Request` |

Sekrety i `DATABASE_URL` nie są potrzebne do testu samego serwera. Będą podłączone do API w kolejnym etapie migracji.

## Granice tego etapu

Serwer statyczny i punkt `/health` są gotowe do testów. Chronione API nadal korzysta z adaptera Worker/D1 i na Railway nie będzie funkcjonalne do czasu realizacji issue #35 (sesje, role i adapter PostgreSQL). Z tego powodu ten etap nie uruchamia wdrożenia produkcyjnego ani nie konfiguruje publicznej domeny.

Testy HTTP sprawdzają przekierowania, pliki statyczne, nagłówki bezpieczeństwa, brak publikacji map źródłowych, odpowiedzi `404`, brak cache API oraz limit ciała żądania 1 MiB.
