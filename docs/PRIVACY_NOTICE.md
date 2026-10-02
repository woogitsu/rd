# Informacja o przetwarzaniu danych (D-06)

> Ten dokument opisuje mechanizm, nie treść informacji. Treść, kto ją
> zatwierdza i kiedy jest przekazywana rodzicom ustala zarząd/szkoła z IOD
> (D-06, patrz [`docs/DECISIONS.md`](DECISIONS.md)). Kod **nie zawiera żadnej
> treści domyślnej** — szkic bez wpisanego `bodyText` nie istnieje.

## Co jest w tym PR

- **`privacy_notices`** (migracja `0075_privacy_notices.sql`) — wersjonowany
  rejestr wersji informacji: `draft → approved → published → superseded`.
  Zatwierdza (`approved_by`) zawsze inna osoba niż autor (`created_by`) —
  wymuszone triggerem bazy i sprawdzeniem w API (403). Publikacja nowej wersji
  automatycznie przenosi poprzednią opublikowaną do `superseded` w tej samej
  transakcji — najwyżej jedna wersja opublikowana naraz.
- **`GET /api/public/privacy-notice`** — bez sesji; wyłącznie opublikowana
  wersja (`bodyText`, `version`, `publishedAt`). Szkic i wersja tylko
  zatwierdzona są niewidoczne (404).
- **`GET/POST /api/admin/privacy-notices`**, **`POST …/{id}/approve`**,
  **`POST …/{id}/publish`** — admin/zarząd + MFA. Publikacja jest idempotentna
  (druga publikacja tej samej wersji zwraca `Idempotency-Replayed: true`).
- **Bramka importu**: `POST /api/import/commit` odrzuca commit
  (`409 privacy_notice_missing`), jeśli nie ma opublikowanej wersji.
  `import_batches.privacy_notice_id` zapisuje, która wersja obowiązywała w
  chwili commitu (migawka — publikacja nowszej wersji tego nie zmienia).
  Sprawdzane dopiero przy commit, nie przy preview (podgląd niczego nie
  zapisuje i nie powinien blokować pracy nad mapowaniem przed publikacją
  informacji).
- **`privacy_notice_deliveries`** (opcjonalna ewidencja przekazania per
  gospodarstwo i kanał: `email`, `card`, `meeting`, `school`) — tabela istnieje
  (append-only), ale **żadna trasa jej jeszcze nie zapisuje** w tym PR (patrz
  „Czego nie obejmuje”).

## Bramki kampanii e-mail i wydruku kartek (migracja 0179, część #145)

- **Zatwierdzenie kampanii** (`POST /api/email/campaigns/{id}/approve`):
  `409 privacy_notice_missing`, jeśli nie ma opublikowanej wersji. Zatwierdzenie
  zapisuje wersję w `email_campaigns.privacy_notice_id` (w widoku API:
  `campaign.privacyNoticeId`) i w zdarzeniu `email.campaign.approved`
  (`privacyNoticeId`, `privacyNoticeVersion`, bez treści). Kolumnę ustawia
  wyłącznie przejście szkic → zatwierdzona, czyści wyłącznie cofnięcie do szkicu
  (zmiana treści/nowa migawka); w innych stanach jest niezmienna (trigger
  `email_campaigns_privacy_notice_guard`). Wzór: `approved_payment_instructions_id` (0162).
- **Stopka wiadomości**: „Informacja o przetwarzaniu danych osobowych (wersja N):
  `{PUBLIC_BASE_URL}/api/public/privacy-notice`” — przed linkiem wypisania; bez
  `PUBLIC_BASE_URL` zostaje numer wersji. Stopkę (numer i adres, nigdy treść)
  dopisuje serwer na podstawie wersji zapamiętanej w kampanii: w podglądzie
  szkicu jest to bieżąca opublikowana wersja (ostrzeżenie `privacy_notice_missing`,
  gdy jej brak), po zatwierdzeniu — wersja zapisana, także w wiadomości testowej
  i w workerze. Stopka NIE jest częścią `content_hash` (zależy od wersji
  informacji, a nie od treści pisanej przez autora); wiązanie z wersją zapewnia
  `privacy_notice_id` zapisane przy zatwierdzeniu, więc publikacja wersji 2 nie
  zmienia zatwierdzonej ani zakolejkowanej kampanii.
- **Kolejka, wznowienie, worker**: kampania zatwierdzona przed 0179
  (`privacy_notice_id IS NULL`) nie wychodzi — `queue`/`resume` zwracają
  `409 privacy_notice_missing`, worker pomija ją (`stopped_reason =
  'privacy_notice_missing'`, wiersze zostają `queued`). Trzeba ją cofnąć do
  szkicu i zatwierdzić ponownie albo anulować i utworzyć nową.
- **Wiadomość testowa** bez opublikowanej informacji: `409 privacy_notice_missing`.
- **Kartki** (`GET /api/print/cards`): po autoryzacji i walidacji zakresu,
  `409 privacy_notice_missing` bez opublikowanej wersji; odpowiedź zawiera
  `privacyNotice: { id, version, url }`, a panel `print/` drukuje na kartce
  ten sam odnośnik. Zdarzenie `print.cards_requested` zapisuje `privacyNoticeId`
  i `privacyNoticeVersion`. Odpowiedź zawiera też `skippedRestricted` (D-07, wskazanie 2026-10-02): liczbę rodzin pominiętych z powodu ograniczenia przetwarzania w zakresie wydruku — wyłącznie liczbę, a zdarzenie zapisuje ją jako `skippedRestrictedCount`. Kartki z pliku CSV/JSON wczytanego lokalnie w panelu
  (bez API) nie mają odnośnika — to nadal otwarte.

## Czego jeszcze brakuje w #145 (świadomie)

- **Strona `/site/informacja-o-danych`** — front publiczny; `GET
  /api/public/privacy-notice` dostarcza dane, a stopki wskazują właśnie tę trasę.
- **Zapisywanie `privacy_notice_deliveries`** — tabela istnieje, ale żadna
  trasa (API ani UI) jeszcze do niej nie pisze (zależy od D-06).
- **Flaga `PRIVACY_NOTICE_REQUIRED`** z propozycji issue — bramki są dziś zawsze
  aktywne (prototyp bez danych rodzin, zgodnie z AGENTS.md).
- Wydruk kartek z danych wczytanych z pliku (poza API) nie jest bramkowany.

## Zależności od decyzji zarządu/szkoły

D-06 (treść, kto informuje, kiedy), D-01 (w czyim imieniu), D-02 (cele —
treść je wymienia), D-05 (dostawcy wymienieni w treści), D-16/D-17 (stopka i
nadawca — dotyczy stopki e-mail).
