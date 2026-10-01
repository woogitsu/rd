# Kontrolowane przeniesienie D1 do PostgreSQL

Status: procedura i narzędzie testowane na danych syntetycznych. Nie wykonano
eksportu produkcyjnego ani odtworzenia na Railway. Faktyczną próbę stagingową,
backup i cutover prowadzi issue #41 po zatwierdzeniu administratora danych.

## Zasady bezpieczeństwa

- Eksport i snapshot zawierają dane osobowe. Tworzyć je poza repozytorium na
  szyfrowanym nośniku, z prawami `0600`; nie przesyłać do issue, CI ani logów.
- Na czas ostatecznego eksportu zatrzymać zapisy do D1. Nie prowadzić dwóch
  produkcyjnych źródeł prawdy.
- Import działa tylko do pustych tabel i w jednej transakcji. Pierwszy błąd
  wycofuje całość. Produkcja (a zachowawczo także brak lub nieznana wartość `APP_ENV`) wymaga dodatkowej flagi `--allow-production`. Flaga sprawdza tylko `APP_ENV` z powłoki operatora, nie oznaczenie docelowej bazy — nie jest ochroną przed podaniem `DATABASE_URL` produkcji z `APP_ENV=staging` (znacznik środowiska w bazie: poza zakresem, #166).
- Sesje i niewykorzystane zaproszenia nie są przenoszone. Po cutover wszyscy
  użytkownicy logują się ponownie. Pliki dokumentów wymagają osobnego,
  kontrolowanego transferu do prywatnego Storage Bucket.

## Próba na danych syntetycznych lub stagingu

1. Utworzyć prywatny katalog roboczy poza repozytorium.
2. Wyeksportować D1 do SQL. Dla lokalnej bazy testowej pominąć `--remote`:

   ```sh
   npx wrangler d1 export rd --remote --output /private/path/d1-export.sql
   ```

3. Zamienić eksport na snapshot ze stałą listą dozwolonych tabel i sumą
   SHA-256. Plik docelowy nie może wcześniej istnieć:

   ```sh
   npm run db:snapshot:d1 -- /private/path/d1-export.sql /private/path/rd-snapshot.json
   npm run db:restore:postgres -- /private/path/rd-snapshot.json
   ```

   Drugie polecenie jest wyłącznie kontrolą formatu i sumy; nie łączy się z
   bazą. Jeśli snapshot zawiera wydarzenia z `begins_at` bez strefy, trzeba
   dodać `--event-local-time-zone=Europe/Brussels` albo `--event-time-zone=UTC`
   (zob. „Reguły mapowania”) — także w próbie i przy `--apply`.

4. Utworzyć pustą bazę PostgreSQL, uruchomić `npm run db:migrate:postgres`, a
   następnie jawnie zatwierdzić import:

   ```sh
   DATABASE_URL='...' APP_ENV=staging npm run db:restore:postgres -- \
     /private/path/rd-snapshot.json --apply
   ```

5. Zachować raport bez danych osobowych: liczności wszystkich tabel, sumę
   netto wpłat, sumy przychodów i wydatków oraz odcisk SHA-256 każdej tabeli
   (`fingerprints`). Porównać z zatwierdzonym raportem źródłowym, a następnie sprawdzić reprezentatywne rodziny, wspólną
   opiekę, rodzeństwo, przypisania klas, korekty, bilans i preliminarz.

## Reguły mapowania

- Flagi SQLite `0/1` są zmieniane na PostgreSQL `BOOLEAN`.
- Stare wpłaty i wpisy księgi bez klucza idempotencji otrzymują deterministyczny
  klucz `legacy:<typ>:<id>`; oryginalny identyfikator pozostaje bez zmian.
- Zdarzenie przypisania wpłaty jest odtwarzane przez ten sam chroniony przepływ
  co nowy zapis: najpierw stan `unmatched`, potem niezmienne przypisanie.
- Stara kolumna `ledger_entries.category` jest mapowana na `category_id`.
  Brak odpowiadającej kategorii, niewłaściwy rok/kierunek, uszkodzony łańcuch
  preliminarza lub niespójne przypisanie przerywa całą transakcję. Narzędzie
  nie zgaduje kategorii ani gospodarstwa.
- Dwie reguły czasu (#183). (1) Znaczniki techniczne bez strefy
  (`created_at`, `occurred_at`, `disabled_at`, `expires_at`, `published_at`;
  `CURRENT_TIMESTAMP`) są odczytywane jako UTC niezależnie od strefy sesji
  serwera (`SET LOCAL TIME ZONE 'UTC'` w transakcji importu). (2) `events.begins_at`
  to godzina wpisana przez człowieka (stary Worker nie miał tras wydarzeń), więc
  strefy nie zgadujemy: wartość bez strefy wymaga jawnej decyzji osoby, która
  prowadziła D1 — `--event-local-time-zone=Europe/Brussels` (przeliczenie tą samą
  funkcją `parseBrusselsLocal` co API; godzina z przejścia czasu, nieistniejąca
  lub niejednoznaczna, przerywa import z identyfikatorem wydarzenia) albo
  `--event-time-zone=UTC`. Bez opcji import (także próba bez `--apply`) jest
  odrzucany przed transakcją. Wartości z `Z` lub `±hh:mm` przechodzą bez zmian.
  Raport importu zawiera `eventTimes` (liczba wydarzeń z czasem bez strefy
  i zastosowana reguła).
- Wydarzenie `published` staje się opublikowaną rewizją 1 ze źródłem
  `legacy_d1` (migracja 0008). Nieopublikowane wydarzenie z ustawionym
  `published_at` przerywa import — narzędzie nie zgaduje, czy było publiczne.
- Lista kolumn jest zamknięta (#182). Snapshot zawiera wszystkie kolumny D1
  (`SELECT *`), a import wstawia tylko kolumny z listy mapowania. Niepusta
  wartość w kolumnie spoza listy (np. `ledger_entries.approval_id`) **przerywa**
  import przed transakcją, z nazwą tabeli, kolumny, liczbą wierszy i jednym
  identyfikatorem przykładowym (bez wartości). Kolumna pusta (NULL lub pusty
  tekst) nie niesie danych i przechodzi; `ledger_entries.category` jest
  zużywana przez mapowanie na `category_id`. Przeniesienie albo świadome
  pominięcie takiej kolumny wymaga decyzji o zakresie importu (D-03) i zmiany
  mapowania — narzędzie nie gubi danych finansowych po cichu.
- Uzgodnienie po odtworzeniu (#182) porównuje **snapshot źródłowy** z bazą
  docelową: liczności i sumy liczone z surowego snapshotu oraz odcisk każdego
  wiersza (SHA-256 postaci kanonicznej: daty `YYYY-MM-DD`, czasy ISO UTC, flagi
  boolean, kwoty jako tekst, JSON z posortowanymi kluczami) odczytany z
  PostgreSQL po imporcie, w tej samej transakcji. Oczekiwana postać wiersza to
  wiersz źródłowy po opisanych tu regułach mapowania; stan końcowy wpłaty
  przypisanej jest porównywany ze stanem z D1 (nie z przejściowym `unmatched`).
  Wyjątek: opublikowane wydarzenie bez `published_at` dostaje czas importu
  (migracja 0008) — sprawdzamy tylko, że wartość nie jest pusta. Różnica w
  dowolnej tabeli wycofuje import; błąd wskazuje tabelę i identyfikatory
  wierszy (do 5), bez treści. Nadal brakuje niezależnego raportu źródłowego
  liczonego zapytaniami do D1 oraz sum per rok (#182, część otwarta).
- Zgodność z migracjami 0004, 0008 i 0009 oraz wyniki porównania API opisuje
  [EQUIVALENCE.md](EQUIVALENCE.md).
- Metadane dokumentów mogą zostać przeniesione dopiero razem z uzgodnionym
  transferem obiektów. Sam snapshot nie kopiuje plików.

## Cutover i rollback

Przed cutover wymagane są: zatwierdzony backup D1, backup docelowego
PostgreSQL, próbne odtworzenie, zielone testy API/ról/MFA i podpisany raport
zgodności. Po zatrzymaniu zapisów wykonać świeży eksport, import do pustej bazy,
kontrolę raportu i dopiero wtedy przełączyć aplikację. Jeżeli kontrola nie jest
zgodna, nie uruchamiać nowego API: wycofać pustą bazę docelową i przywrócić
zapisy do niezmienionego D1. Nie próbować scalać rozbieżnych baz.

Źródło techniczne sprawdzone 27.09.2026: [Cloudflare — import i eksport
D1](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
