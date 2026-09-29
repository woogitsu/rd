# Panel dokumentów

Interfejs do chronionego API prywatnych dokumentów (`/api/documents`, issue #39, #8). Status: prototyp. Nie zawiera danych demonstracyjnych ani obejścia uwierzytelniania i nie jest zatwierdzony do pracy na dokumentach rodzin (decyzje D-04, D-05, D-08, D-09 w [docs/DECISIONS.md](../docs/DECISIONS.md)).

## Uruchomienie

Worker/D1 (`npm run dev`) **nie ma** tras `/api/documents` — API istnieje wyłącznie na PostgreSQL. Buduj i uruchamiaj razem z API według „Uruchomienie lokalne” w [README głównym](../README.md):

```bash
npm ci && npm run build
DATABASE_URL=postgres://… npm run db:migrate:postgres
DATABASE_URL=postgres://… PORT=3000 npm start
```

`npm run dev:documents` (Vite, bez proxy `/api`) pokazuje sam interfejs, bez API.

Po zbudowaniu serwer Node udostępnia panel pod `/documents/` z tego samego originu co API; żądania używają ciasteczka sesji.

## Zakres

- lista dokumentów widocznych dla użytkownika w danym roku szkolnym, z filtrami rodzaju i klasy — zakres widoczności wylicza serwer z ról i przydziałów,
- widok metadanych (rodzaj, rok, klasa, typ, rozmiar, SHA-256, powiązanie, autor, czas),
- pobranie przez link do `/api/documents/{id}/content` (załącznik z nazwą techniczną, zdarzenie w dzienniku),
- wersje i stan (issue #82): stan dokumentu (aktualny, zastąpiony, unieważniony) w liście i szczegółach, historia wersji (łańcuch „zastępuje” / „zastąpiony przez” z odnośnikami), filtr „Pokaż też zastąpione i unieważnione” (`status=all`), akcje „Zastąp innym dokumentem…” i „Unieważnij…” z powodem (3–500 znaków, wewnętrzny) i oknem potwierdzenia z `shared/confirm-dialog.js`. Plik zostaje w archiwum — żadna z akcji go nie usuwa. Przyciski widzą tylko konta z rolą, którą API już dopuszcza do zapisu danego rodzaju (jak przy przesłaniu, D-08/D-09 bez rozszerzania); rozstrzyga serwer (404 poza zakresem, MFA dla dowodów finansowych),
- przesłanie pliku PDF, PNG lub JPEG z metadanymi: rodzaj, rok szkolny, klasa (tylko materiały klasy), powiązanie z wpisem księgi lub wpłatą (tylko dowody finansowe).

## Zasady

- Kontrola typu (sygnatura pliku) i rozmiaru w przeglądarce służy tylko wygodzie. Serwer ponownie sprawdza typ, rozmiar i uprawnienia i jest rozstrzygający. Przeglądarka zna jedynie domyślny limit 10 MiB; inny `DOCUMENT_MAX_BYTES` ujawni się dopiero odpowiedzią 413.
- Każde przesłanie ma `Idempotency-Key`. Ponowienie po błędzie sieci lub 5xx z tym samym plikiem i danymi używa tego samego klucza, więc podwójne kliknięcie ani ponowienie nie tworzą duplikatu. Zmiana pliku lub metadanych tworzy nową operację.
- Stan przesyłania i błędy są ogłaszane przez `aria-live`. Komunikaty błędów API (401, 403, 404, 409, 413, 415, 503) są po polsku.
- Nazwa pliku nie jest wysyłana ani zapisywana. Nie przesyłaj dokumentów z danymi dzieci bez potrzeby ani zdjęć z wizerunkiem dzieci.
- Czysta logika: `core.js`, testy: `tests/documents-core.test.js`.
