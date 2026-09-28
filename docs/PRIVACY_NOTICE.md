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

## Czego ten PR NIE obejmuje (świadomie, część #145)

Powód: równoległe otwarte PR-y (#303, #306, #309) zmieniają dokładnie
`src/pg/routes/email.js` i `print/core.js` (harmonogram/pauza kampanii,
raport doręczeń, rotacja sekretu webhooka, słownictwo o zadłużeniu PL/FR/NL).
Dodanie tam kolejnej bramki i kolumny `email_campaigns.privacy_notice_id`
groziłoby konfliktem scalania i nadpisaniem `CREATE OR REPLACE FUNCTION
email_campaign_guard()`, którą te PR-y już zmieniają (patrz zasada w
`fix-common.md`: „jeśli redefiniujesz funkcję, wyjdź od jej najnowszej wersji
na origin/main” — tu najbezpieczniej jest w ogóle jej nie dotykać, dopóki
tamte PR-y się nie scalą).

- **Bramka zatwierdzenia kampanii e-mail** (`409 privacy_notice_missing` przy
  `POST /api/email/campaigns/{id}/approve`) i kolumna
  `email_campaigns.privacy_notice_id` — do osobnego PR po scaleniu #303/#306/#309.
- **Stopka wiadomości e-mail** z odnośnikiem do informacji — jw.
- **Bramka i odnośnik na kartce** (`print/core.js`, `src/pg/routes/print.js`)
  — jw. (#303 zmienia dokładnie `print/core.js`).
- **Strona `/site/informacja-o-danych`** — front publiczny nie jest częścią
  tego PR; `GET /api/public/privacy-notice` dostarcza dane, które taka strona
  mogłaby wyświetlić.
- **Zapisywanie `privacy_notice_deliveries`** — tabela istnieje, ale żadna
  trasa (API ani UI) jeszcze do niej nie pisze.
- **Flaga `PRIVACY_NOTICE_REQUIRED`** z propozycji issue — bramka importu jest
  dziś zawsze aktywna (prototyp bez danych rodzin, zgodnie z AGENTS.md); flaga
  do rozważenia razem z bramkami e-mail/kartki, gdy powstaną.

## Zależności od decyzji zarządu/szkoły

D-06 (treść, kto informuje, kiedy), D-01 (w czyim imieniu), D-02 (cele —
treść je wymienia), D-05 (dostawcy wymienieni w treści), D-16/D-17 (stopka i
nadawca — dotyczy przyszłej bramki e-mail).
